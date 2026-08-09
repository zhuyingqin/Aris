use std::{
    collections::BTreeMap,
    io::{self, Read},
    process::{Command, ExitStatus, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime},
};

use crate::managed_job::ManagedJob;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedProcessKind {
    Foreground,
    Background,
    Mcp,
}

#[derive(Debug, Clone)]
pub struct ManagedProcessInfo {
    pub pid: u32,
    pub label: String,
    pub kind: ManagedProcessKind,
    pub started_at: SystemTime,
    /// Where a background process's stdout/stderr is being written, so the user
    /// (and the model) can read a service that prints only to its own console.
    pub log_path: Option<String>,
}

#[derive(Debug)]
pub struct ManagedProcessGuard {
    pid: u32,
}

#[derive(Debug)]
pub struct ManagedCommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub status: ExitStatus,
    pub interrupted: bool,
    pub timed_out: bool,
    /// `true` when the command finished but something it spawned still holds our
    /// stdout/stderr pipe, so the captured output was drained on a deadline and
    /// may be incomplete. See [`READER_DRAIN_GRACE`].
    pub output_pipe_held: bool,
    /// Set when the command left a service running and the registry adopted it,
    /// so callers can tell the user (and the model) where it went.
    pub adopted_background_pid: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct ManagedCommandProgress {
    pub pid: u32,
    pub elapsed_ms: u64,
    pub timeout_ms: Option<u64>,
    pub stdout_tail: String,
    pub stderr_tail: String,
}

struct ManagedStreamReader {
    handle: thread::JoinHandle<()>,
    buffer: Arc<Mutex<Vec<u8>>>,
}

/// How long a finished command's pipes are drained before we give up on them.
///
/// A shell that backgrounds a service (`npm run dev &`, `start /b ...`) hands
/// our stdout/stderr write handles to a process that outlives it, so the pipes
/// never reach EOF even though the shell itself exited seconds ago. Waiting for
/// the reader threads unconditionally hung the whole tool call forever — past
/// the foreground timeout and past every cancel check, because those only run
/// while the direct child is alive. Draining on a deadline instead returns the
/// output collected so far and lets the call finish.
const READER_DRAIN_GRACE: Duration = Duration::from_secs(2);

/// How often an adopted survivor group is re-checked for liveness.
const SURVIVOR_POLL_INTERVAL: Duration = Duration::from_secs(2);

fn registry() -> &'static Mutex<BTreeMap<u32, ManagedProcessInfo>> {
    static REGISTRY: OnceLock<Mutex<BTreeMap<u32, ManagedProcessInfo>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Jobs owning each registered process and everything it spawned. Kept apart
/// from [`ManagedProcessInfo`] so that stays a plain, cloneable data record.
/// A job lives exactly as long as its registry entry: dropping it closes the
/// last handle, which on Windows kills the whole tree.
fn jobs() -> &'static Mutex<BTreeMap<u32, Arc<ManagedJob>>> {
    static JOBS: OnceLock<Mutex<BTreeMap<u32, Arc<ManagedJob>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[must_use]
pub fn register_managed_process(
    pid: u32,
    label: impl Into<String>,
    kind: ManagedProcessKind,
) -> ManagedProcessGuard {
    insert_managed_process(pid, label, kind, None);
    ManagedProcessGuard { pid }
}

fn insert_managed_process(
    pid: u32,
    label: impl Into<String>,
    kind: ManagedProcessKind,
    log_path: Option<String>,
) {
    let info = ManagedProcessInfo {
        pid,
        label: label.into(),
        kind,
        started_at: SystemTime::now(),
        log_path,
    };
    if let Ok(mut processes) = registry().lock() {
        processes.insert(pid, info);
    }
}

fn attach_job(pid: u32, job: Arc<ManagedJob>) {
    if let Ok(mut jobs) = jobs().lock() {
        jobs.insert(pid, job);
    }
}

fn take_job(pid: u32) -> Option<Arc<ManagedJob>> {
    jobs().lock().ok()?.remove(&pid)
}

fn job_for(pid: u32) -> Option<Arc<ManagedJob>> {
    jobs().lock().ok()?.get(&pid).cloned()
}

pub fn unregister_managed_process(pid: u32) {
    if let Ok(mut processes) = registry().lock() {
        processes.remove(&pid);
    }
    // Dropping the job closes our last handle to it, which is what kills any
    // descendant the process left behind.
    drop(take_job(pid));
}

#[must_use]
pub fn managed_processes_snapshot() -> Vec<ManagedProcessInfo> {
    registry()
        .lock()
        .map(|processes| processes.values().cloned().collect())
        .unwrap_or_default()
}

pub fn terminate_all_managed_processes() {
    let processes = managed_processes_snapshot();
    for process in &processes {
        terminate_managed_process_tree(process.pid);
    }
    if let Ok(mut registry) = registry().lock() {
        for process in processes {
            registry.remove(&process.pid);
        }
    }
}

pub fn terminate_managed_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    // The job knows every descendant, including ones a shell detached from the
    // tree; the walk below is the fallback when no job could be created.
    if let Some(job) = job_for(pid) {
        job.terminate();
    }
    terminate_process_tree(pid);
}

pub fn spawn_managed_background(
    command: &mut Command,
    label: impl Into<String>,
    log_path: Option<String>,
) -> io::Result<u32> {
    configure_managed_command(command);
    let mut child = command.spawn()?;
    let pid = child.id();
    insert_managed_process(pid, label, ManagedProcessKind::Background, log_path);
    if let Some(job) = ManagedJob::adopt(&child) {
        attach_job(pid, Arc::new(job));
    }
    thread::Builder::new()
        .name(format!("aris-managed-process-{pid}"))
        .spawn(move || {
            let _ = child.wait();
            unregister_managed_process(pid);
        })
        .map_err(io::Error::other)?;
    Ok(pid)
}

pub fn run_managed_command(
    command: &mut Command,
    label: impl Into<String>,
    timeout: Option<Duration>,
    interruptible: bool,
) -> io::Result<ManagedCommandOutput> {
    run_managed_command_with_cancel(command, label, timeout, interruptible, || false)
}

pub fn run_managed_command_with_cancel(
    command: &mut Command,
    label: impl Into<String>,
    timeout: Option<Duration>,
    interruptible: bool,
    should_cancel: impl Fn() -> bool,
) -> io::Result<ManagedCommandOutput> {
    run_managed_command_with_cancel_and_progress(
        command,
        label,
        timeout,
        interruptible,
        should_cancel,
        |_| {},
    )
}

pub fn run_managed_command_with_cancel_and_progress(
    command: &mut Command,
    label: impl Into<String>,
    timeout: Option<Duration>,
    interruptible: bool,
    should_cancel: impl Fn() -> bool,
    mut on_progress: impl FnMut(ManagedCommandProgress),
) -> io::Result<ManagedCommandOutput> {
    configure_managed_command(command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let pid = child.id();
    let label = label.into();
    insert_managed_process(pid, label.clone(), ManagedProcessKind::Foreground, None);
    let _guard = ManagedProcessGuard { pid };
    let job = ManagedJob::adopt(&child).map(Arc::new);
    if let Some(job) = job.clone() {
        attach_job(pid, job);
    }
    let stdout_reader = child.stdout.take().map(read_stream_in_thread);
    let stderr_reader = child.stderr.take().map(read_stream_in_thread);
    let started = Instant::now();
    let timeout_ms = timeout.map(duration_millis_u64);
    let mut last_progress = None::<Instant>;

    loop {
        if last_progress.is_none_or(|last| last.elapsed() >= Duration::from_millis(1_000)) {
            emit_progress(
                pid,
                started,
                timeout_ms,
                stdout_reader.as_ref(),
                stderr_reader.as_ref(),
                &mut on_progress,
            );
            last_progress = Some(Instant::now());
        }
        if let Some(status) = child.try_wait()? {
            let mut output =
                finish_managed_output(stdout_reader, stderr_reader, status, false, false);
            // Drain first: a survivor is only worth adopting once the grace
            // period has passed, so short-lived grandchildren are not mistaken
            // for a service.
            output.adopted_background_pid = adopt_survivors(pid, &label, job);
            return Ok(output);
        }
        if interruptible && (crate::is_interrupted() || should_cancel()) {
            terminate_managed_process_tree(pid);
            let status = terminate_child_and_wait(&mut child)?;
            return Ok(finish_managed_output(
                stdout_reader,
                stderr_reader,
                status,
                true,
                false,
            ));
        }
        if timeout.is_some_and(|timeout| started.elapsed() >= timeout) {
            terminate_managed_process_tree(pid);
            let status = terminate_child_and_wait(&mut child)?;
            return Ok(finish_managed_output(
                stdout_reader,
                stderr_reader,
                status,
                true,
                true,
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub fn configure_managed_tokio_command(command: &mut tokio::process::Command) {
    crate::hide_window(command.as_std_mut());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        command.as_std_mut().process_group(0);
    }

    #[cfg(not(unix))]
    let _ = command;
}

/// Lets `managed_job`'s tests spawn a child the same way the registry does,
/// which on Unix is what puts it in its own process group.
#[cfg(test)]
pub(crate) fn configure_managed_command_for_test(command: &mut Command) {
    configure_managed_command(command);
}

fn configure_managed_command(command: &mut Command) {
    crate::hide_window(command);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        command.process_group(0);
    }

    #[cfg(not(unix))]
    let _ = command;
}

fn terminate_child_and_wait(child: &mut std::process::Child) -> io::Result<ExitStatus> {
    if child.try_wait()?.is_none() {
        let _ = child.kill();
    }
    child.wait()
}

fn read_stream_in_thread<R>(mut reader: R) -> ManagedStreamReader
where
    R: Read + Send + 'static,
{
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let worker_buffer = Arc::clone(&buffer);
    let handle = thread::spawn(move || {
        let mut chunk = [0_u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(size) => {
                    if let Ok(mut buffer) = worker_buffer.lock() {
                        buffer.extend_from_slice(&chunk[..size]);
                    }
                }
                Err(_) => break,
            }
        }
    });
    ManagedStreamReader { handle, buffer }
}

fn finish_managed_output(
    stdout_reader: Option<ManagedStreamReader>,
    stderr_reader: Option<ManagedStreamReader>,
    status: ExitStatus,
    interrupted: bool,
    timed_out: bool,
) -> ManagedCommandOutput {
    // One deadline for both streams: a survivor normally holds both, and two
    // sequential grace periods would double the wait for no extra output.
    let deadline = Instant::now() + READER_DRAIN_GRACE;
    let (stdout, stdout_held) = drain_reader(stdout_reader, deadline);
    let (stderr, stderr_held) = drain_reader(stderr_reader, deadline);
    ManagedCommandOutput {
        stdout,
        stderr,
        status,
        interrupted,
        timed_out,
        output_pipe_held: stdout_held || stderr_held,
        adopted_background_pid: None,
    }
}

/// Take ownership of a service the shell left running: re-register the job
/// under a surviving pid so it shows up in the project summary, can be stopped
/// from there, and still dies with the app. Without this the process is both
/// invisible and immortal — nothing knows its pid once the shell is gone.
fn adopt_survivors(leader: u32, label: &str, job: Option<Arc<ManagedJob>>) -> Option<u32> {
    let job = job?;
    let anchor = *job.live_pids().first()?;
    // Move the job off the finished command before its guard drops (which would
    // close the job and kill exactly the processes we are adopting).
    drop(take_job(leader));
    insert_managed_process(
        anchor,
        format!("{label} [left running by the shell]"),
        ManagedProcessKind::Background,
        None,
    );
    attach_job(anchor, Arc::clone(&job));
    watch_survivors(anchor, job);
    Some(anchor)
}

/// Drop the adopted entry once the group is gone. A survivor has no `Child`
/// handle to wait on, so liveness is polled.
fn watch_survivors(anchor: u32, job: Arc<ManagedJob>) {
    let _ = thread::Builder::new()
        .name(format!("aris-survivor-watch-{anchor}"))
        .spawn(move || loop {
            thread::sleep(SURVIVOR_POLL_INTERVAL);
            let still_registered = registry()
                .lock()
                .is_ok_and(|processes| processes.contains_key(&anchor));
            if !still_registered {
                return;
            }
            if job.live_pids().is_empty() {
                unregister_managed_process(anchor);
                return;
            }
        });
}

/// Collect a stream's bytes, waiting for EOF only until `deadline`. Returns the
/// bytes read so far and whether the reader was still blocked on the pipe.
fn drain_reader(reader: Option<ManagedStreamReader>, deadline: Instant) -> (Vec<u8>, bool) {
    let Some(reader) = reader else {
        return (Vec::new(), false);
    };
    while !reader.handle.is_finished() {
        if Instant::now() >= deadline {
            // Abandon the reader thread rather than block the caller forever.
            // It stays parked on a pipe another process holds open and ends
            // when that process does.
            return (snapshot_buffer(&reader.buffer), true);
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = reader.handle.join();
    (snapshot_buffer(&reader.buffer), false)
}

fn snapshot_buffer(buffer: &Arc<Mutex<Vec<u8>>>) -> Vec<u8> {
    buffer
        .lock()
        .map(|buffer| buffer.clone())
        .unwrap_or_default()
}

fn emit_progress(
    pid: u32,
    started: Instant,
    timeout_ms: Option<u64>,
    stdout_reader: Option<&ManagedStreamReader>,
    stderr_reader: Option<&ManagedStreamReader>,
    on_progress: &mut impl FnMut(ManagedCommandProgress),
) {
    on_progress(ManagedCommandProgress {
        pid,
        elapsed_ms: duration_millis_u64(started.elapsed()),
        timeout_ms,
        stdout_tail: stream_tail(stdout_reader),
        stderr_tail: stream_tail(stderr_reader),
    });
}

fn stream_tail(reader: Option<&ManagedStreamReader>) -> String {
    const TAIL_BYTES: usize = 4_000;
    let Some(reader) = reader else {
        return String::new();
    };
    let Ok(buffer) = reader.buffer.lock() else {
        return String::new();
    };
    let start = buffer.len().saturating_sub(TAIL_BYTES);
    String::from_utf8_lossy(&buffer[start..]).into_owned()
}

fn duration_millis_u64(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn terminate_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = crate::hidden_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(unix)]
    {
        let targets = collect_unix_process_tree(pid);
        for target in &targets {
            send_unix_signal("-TERM", *target);
        }
        thread::sleep(Duration::from_millis(100));
        for target in targets {
            send_unix_signal("-KILL", target);
        }
    }

    #[cfg(not(any(windows, unix)))]
    let _ = pid;
}

#[cfg(unix)]
fn collect_unix_process_tree(pid: u32) -> Vec<u32> {
    fn collect(pid: u32, targets: &mut Vec<u32>) {
        if pid <= 1 || targets.contains(&pid) {
            return;
        }
        for child in unix_child_pids(pid) {
            collect(child, targets);
        }
        targets.push(pid);
    }

    let mut targets = Vec::new();
    collect(pid, &mut targets);
    targets
}

#[cfg(unix)]
fn unix_child_pids(pid: u32) -> Vec<u32> {
    let Ok(output) = Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .filter(|child| *child > 1)
        .collect()
}

#[cfg(unix)]
fn send_unix_signal(signal: &str, pid: u32) {
    if pid <= 1 {
        return;
    }
    let _ = Command::new("kill")
        .args([signal, &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

impl Drop for ManagedProcessGuard {
    fn drop(&mut self) {
        unregister_managed_process(self.pid);
    }
}

#[cfg(test)]
#[path = "tests/process_registry.rs"]
mod tests;
