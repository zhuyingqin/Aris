use super::{
    drain_reader, managed_processes_snapshot, read_stream_in_thread, run_managed_command,
    run_managed_command_with_cancel, spawn_managed_background, terminate_managed_process_tree,
    unregister_managed_process, RollingLog,
};

#[test]
fn rolling_log_rotates_during_writes_and_keeps_requested_history() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("sidecar.log");
    let mut log = RollingLog::open(path.clone(), 8, 2).expect("rolling log");

    log.append(b"first\n").expect("first write");
    log.append(b"second\n").expect("second write");
    log.append(b"third\n").expect("third write");

    assert_eq!(std::fs::read_to_string(&path).unwrap(), "third\n");
    assert_eq!(
        std::fs::read_to_string(format!("{}.1", path.display())).unwrap(),
        "second\n"
    );
    assert_eq!(
        std::fs::read_to_string(format!("{}.2", path.display())).unwrap(),
        "first\n"
    );
}
use std::{
    io::{self, Read},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[test]
fn managed_command_unregisters_after_success() {
    const LABEL: &str = "test managed command";
    let mut command = shell_command("echo managed");
    let output = run_managed_command(&mut command, LABEL, Some(Duration::from_secs(5)), true)
        .expect("managed command should run");

    assert!(output.status.success());
    assert!(
        managed_processes_snapshot()
            .iter()
            .all(|process| process.label != LABEL),
        "the completed command should have been removed from the registry"
    );
}

#[test]
fn managed_command_stops_when_cancel_check_fires() {
    const LABEL: &str = "test cancellable command";
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_worker = cancel.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(100));
        cancel_worker.store(true, Ordering::SeqCst);
    });

    let mut command = long_running_shell_command();
    let output = run_managed_command_with_cancel(
        &mut command,
        LABEL,
        Some(Duration::from_secs(10)),
        true,
        || cancel.load(Ordering::SeqCst),
    )
    .expect("managed command should be cancelled");

    assert!(output.interrupted);
    assert!(!output.timed_out);
    assert!(
        managed_processes_snapshot()
            .iter()
            .all(|process| process.label != LABEL),
        "the cancelled command should have been removed from the registry"
    );
}

#[test]
fn managed_background_is_registered_and_shutdown() {
    let mut command = long_running_shell_command();
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let pid = spawn_managed_background(&mut command, "test background", None)
        .expect("background command should start");

    assert!(managed_processes_snapshot()
        .iter()
        .any(|process| process.pid == pid));
    terminate_managed_process_tree(pid);
    thread::sleep(Duration::from_millis(200));
    assert!(!managed_processes_snapshot()
        .iter()
        .any(|process| process.pid == pid));
}

/// A stream that yields one chunk and then never reaches EOF, standing in for a
/// pipe whose write end a backgrounded process still holds.
struct PartialThenParked {
    sent: bool,
}

impl Read for PartialThenParked {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if !self.sent {
            self.sent = true;
            let chunk = b"partial";
            buffer[..chunk.len()].copy_from_slice(chunk);
            return Ok(chunk.len());
        }
        thread::sleep(Duration::from_secs(90));
        Ok(0)
    }
}

#[test]
fn drain_reader_returns_partial_output_instead_of_waiting_for_eof() {
    let reader = read_stream_in_thread(PartialThenParked { sent: false });
    let started = Instant::now();

    let (bytes, held) = drain_reader(Some(reader), Instant::now() + Duration::from_millis(400));

    assert!(held, "a pipe with no EOF must be reported as still held");
    assert_eq!(bytes, b"partial");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "draining must respect the deadline instead of blocking on the reader"
    );
}

#[test]
fn command_that_backgrounds_a_survivor_still_returns() {
    // The shell exits immediately but hands our stdout pipe to a process that
    // outlives it. Before the bounded drain this blocked the caller forever:
    // the poll loop (and with it every timeout and cancel check) had already
    // exited by the time the reader was joined.
    let mut command = shell_command_leaking_the_output_pipe();
    let started = Instant::now();

    let output = run_managed_command(
        &mut command,
        "test leaked output pipe",
        Some(Duration::from_secs(45)),
        true,
    )
    .expect("managed command should return");

    assert!(
        started.elapsed() < Duration::from_secs(30),
        "the command must not wait on a pipe the survivor keeps open"
    );
    assert!(output.output_pipe_held);
    assert!(!output.timed_out);
    assert!(String::from_utf8_lossy(&output.stdout).contains("started"));

    // The service the shell left behind is adopted rather than abandoned:
    // listed as a background process, and killable through the registry.
    let adopted = output
        .adopted_background_pid
        .expect("the surviving service should have been adopted");
    let entry = managed_processes_snapshot()
        .into_iter()
        .find(|process| process.pid == adopted)
        .expect("the adopted service should be in the registry");
    assert_eq!(entry.kind, super::ManagedProcessKind::Background);
    assert!(entry.label.contains("left running by the shell"));

    terminate_managed_process_tree(adopted);
    unregister_managed_process(adopted);
    assert!(!managed_processes_snapshot()
        .iter()
        .any(|process| process.pid == adopted));
}

#[cfg(windows)]
fn shell_command_leaking_the_output_pipe() -> Command {
    shell_command("echo started& start /b ping -n 20 127.0.0.1 >nul")
}

#[cfg(not(windows))]
fn shell_command_leaking_the_output_pipe() -> Command {
    shell_command("echo started; sleep 20 &")
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
