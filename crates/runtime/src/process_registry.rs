use std::{
    collections::BTreeMap,
    io::{self, Read},
    process::{Command, ExitStatus, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime},
};

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
}

#[derive(Debug, Clone)]
struct ManagedProcessRecord {
    info: ManagedProcessInfo,
    process_group_id: Option<u32>,
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
}

fn registry() -> &'static Mutex<BTreeMap<u32, ManagedProcessRecord>> {
    static REGISTRY: OnceLock<Mutex<BTreeMap<u32, ManagedProcessRecord>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[must_use]
pub fn register_managed_process(
    pid: u32,
    label: impl Into<String>,
    kind: ManagedProcessKind,
) -> ManagedProcessGuard {
    let _ = insert_managed_process(pid, label, kind);
    ManagedProcessGuard { pid }
}

fn insert_managed_process(
    pid: u32,
    label: impl Into<String>,
    kind: ManagedProcessKind,
) -> Option<u32> {
    let process_group_id = managed_process_group_id(pid);
    let info = ManagedProcessInfo {
        pid,
        label: label.into(),
        kind,
        started_at: SystemTime::now(),
    };
    if let Ok(mut processes) = registry().lock() {
        processes.insert(
            pid,
            ManagedProcessRecord {
                info,
                process_group_id,
            },
        );
    }
    process_group_id
}

pub fn unregister_managed_process(pid: u32) {
    if let Ok(mut processes) = registry().lock() {
        processes.remove(&pid);
    }
}

#[must_use]
pub fn managed_processes_snapshot() -> Vec<ManagedProcessInfo> {
    registry()
        .lock()
        .map(|processes| {
            processes
                .values()
                .map(|record| record.info.clone())
                .collect()
        })
        .unwrap_or_default()
}

pub fn terminate_all_managed_processes() {
    let records: Vec<_> = registry()
        .lock()
        .map(|processes| processes.values().cloned().collect())
        .unwrap_or_default();
    for record in &records {
        terminate_managed_process_tree_with_group(record.info.pid, record.process_group_id);
    }
    if let Ok(mut registry) = registry().lock() {
        for record in records {
            registry.remove(&record.info.pid);
        }
    }
}

pub fn terminate_managed_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    terminate_managed_process_tree_with_group(pid, managed_process_group_id(pid));
}

fn terminate_managed_process_tree_with_group(pid: u32, process_group_id: Option<u32>) {
    if pid == 0 {
        return;
    }
    terminate_process_tree(pid, process_group_id);
}

pub fn spawn_managed_background(
    command: &mut Command,
    label: impl Into<String>,
) -> io::Result<u32> {
    configure_managed_command(command);
    let mut child = command.spawn()?;
    let pid = child.id();
    let _ = insert_managed_process(pid, label, ManagedProcessKind::Background);
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
    configure_managed_command(command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let pid = child.id();
    let process_group_id = insert_managed_process(pid, label, ManagedProcessKind::Foreground);
    let _guard = ManagedProcessGuard { pid };
    let stdout_reader = child.stdout.take().map(read_stream_in_thread);
    let stderr_reader = child.stderr.take().map(read_stream_in_thread);
    let started = Instant::now();

    loop {
        if let Some(status) = child.try_wait()? {
            if process_group_id.is_some() {
                terminate_managed_process_tree_with_group(pid, process_group_id);
            }
            return Ok(ManagedCommandOutput {
                stdout: join_reader(stdout_reader),
                stderr: join_reader(stderr_reader),
                status,
                interrupted: false,
                timed_out: false,
            });
        }
        if interruptible && crate::is_interrupted() {
            terminate_managed_process_tree_with_group(pid, process_group_id);
            let status = terminate_child_and_wait(&mut child)?;
            return Ok(ManagedCommandOutput {
                stdout: join_reader(stdout_reader),
                stderr: join_reader(stderr_reader),
                status,
                interrupted: true,
                timed_out: false,
            });
        }
        if timeout.is_some_and(|timeout| started.elapsed() >= timeout) {
            terminate_managed_process_tree_with_group(pid, process_group_id);
            let status = terminate_child_and_wait(&mut child)?;
            return Ok(ManagedCommandOutput {
                stdout: join_reader(stdout_reader),
                stderr: join_reader(stderr_reader),
                status,
                interrupted: true,
                timed_out: true,
            });
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub fn configure_managed_tokio_command(command: &mut tokio::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        command.as_std_mut().process_group(0);
    }

    #[cfg(not(unix))]
    let _ = command;
}

fn configure_managed_command(command: &mut Command) {
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

fn read_stream_in_thread<R>(mut reader: R) -> thread::JoinHandle<Vec<u8>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = reader.read_to_end(&mut buffer);
        buffer
    })
}

fn join_reader(reader: Option<thread::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
}

#[cfg(unix)]
fn managed_process_group_id(pid: u32) -> Option<u32> {
    use nix::unistd::{getpgid, getpgrp, Pid};

    if pid <= 1 {
        return None;
    }
    let raw_pid = i32::try_from(pid).ok()?;
    let process_group = getpgid(Some(Pid::from_raw(raw_pid))).ok()?;
    if process_group == getpgrp() {
        return None;
    }
    let raw_group = process_group.as_raw();
    if raw_group <= 1 {
        return None;
    }
    let group_id = u32::try_from(raw_group).ok()?;
    (group_id == pid).then_some(group_id)
}

#[cfg(not(unix))]
fn managed_process_group_id(_pid: u32) -> Option<u32> {
    None
}

fn terminate_process_tree(pid: u32, process_group_id: Option<u32>) {
    #[cfg(windows)]
    {
        let _ = process_group_id;
        let _ = crate::hidden_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(unix)]
    {
        let target = process_group_id
            .map(|group_id| format!("-{group_id}"))
            .unwrap_or_else(|| pid.to_string());
        let _ = Command::new("kill")
            .args(["-TERM", &target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        thread::sleep(Duration::from_millis(100));
        let _ = Command::new("kill")
            .args(["-KILL", &target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(not(any(windows, unix)))]
    let _ = (pid, process_group_id);
}

impl Drop for ManagedProcessGuard {
    fn drop(&mut self) {
        unregister_managed_process(self.pid);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        managed_processes_snapshot, run_managed_command, spawn_managed_background,
        terminate_all_managed_processes,
    };
    use std::{
        process::Command,
        sync::{Mutex, OnceLock},
        thread,
        time::Duration,
    };

    #[test]
    fn managed_command_unregisters_after_success() {
        let _guard = test_lock();
        let mut command = shell_command("echo managed");
        let output = run_managed_command(
            &mut command,
            "test managed command",
            Some(Duration::from_secs(5)),
            true,
        )
        .expect("managed command should run");

        assert!(output.status.success());
        assert!(managed_processes_snapshot().is_empty());
    }

    #[test]
    fn managed_background_is_registered_and_shutdown() {
        let _guard = test_lock();
        let mut command = long_running_shell_command();
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let pid = spawn_managed_background(&mut command, "test background")
            .expect("background command should start");

        assert!(managed_processes_snapshot()
            .iter()
            .any(|process| process.pid == pid));
        terminate_all_managed_processes();
        thread::sleep(Duration::from_millis(200));
        assert!(!managed_processes_snapshot()
            .iter()
            .any(|process| process.pid == pid));
    }

    #[cfg(windows)]
    fn shell_command(command: &str) -> Command {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", command]);
        cmd
    }

    #[cfg(not(windows))]
    fn shell_command(command: &str) -> Command {
        let mut cmd = Command::new("sh");
        cmd.args(["-lc", command]);
        cmd
    }

    #[cfg(windows)]
    fn long_running_shell_command() -> Command {
        shell_command("ping -n 30 127.0.0.1 >nul")
    }

    #[cfg(not(windows))]
    fn long_running_shell_command() -> Command {
        shell_command("sleep 30")
    }

    fn test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}
