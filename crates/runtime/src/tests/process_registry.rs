use super::{
    managed_processes_snapshot, run_managed_command, run_managed_command_with_cancel,
    spawn_managed_background, terminate_managed_process_tree,
};
use std::{
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
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
    let pid = spawn_managed_background(&mut command, "test background")
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
