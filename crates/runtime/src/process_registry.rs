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

fn registry() -> &'static Mutex<BTreeMap<u32, ManagedProcessInfo>> {
    static REGISTRY: OnceLock<Mutex<BTreeMap<u32, ManagedProcessInfo>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[must_use]
pub fn register_managed_process(
    pid: u32,
    label: impl Into<String>,
    kind: ManagedProcessKind,
) -> ManagedProcessGuard {
    insert_managed_process(pid, label, kind);
    ManagedProcessGuard { pid }
}

fn insert_managed_process(pid: u32, label: impl Into<String>, kind: ManagedProcessKind) {
    let info = ManagedProcessInfo {
        pid,
        label: label.into(),
        kind,
        started_at: SystemTime::now(),
    };
    if let Ok(mut processes) = registry().lock() {
        processes.insert(pid, info);
    }
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
    terminate_process_tree(pid);
}

pub fn spawn_managed_background(
    command: &mut Command,
    label: impl Into<String>,
) -> io::Result<u32> {
    configure_managed_command(command);
    let mut child = command.spawn()?;
    let pid = child.id();
    insert_managed_process(pid, label, ManagedProcessKind::Background);
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
    insert_managed_process(pid, label, ManagedProcessKind::Foreground);
    let _guard = ManagedProcessGuard { pid };
    let stdout_reader = child.stdout.take().map(read_stream_in_thread);
    let stderr_reader = child.stderr.take().map(read_stream_in_thread);
    let started = Instant::now();

    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(ManagedCommandOutput {
                stdout: join_reader(stdout_reader),
                stderr: join_reader(stderr_reader),
                status,
                interrupted: false,
                timed_out: false,
            });
        }
        if interruptible && crate::is_interrupted() {
            terminate_managed_process_tree(pid);
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
            terminate_managed_process_tree(pid);
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
