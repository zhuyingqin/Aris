use super::ManagedJob;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// A shell that detaches a long-running child and exits — the shape that used
/// to escape both `taskkill /T` and a `pgrep -P` walk.
fn shell_that_leaves_a_survivor() -> Command {
    #[cfg(windows)]
    {
        let mut command = Command::new("cmd");
        command.args(["/C", "start /b ping -n 60 127.0.0.1 >nul"]);
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new("sh");
        command.args(["-lc", "sleep 60 &"]);
        command
    }
}

fn spawn_with_group() -> std::process::Child {
    let mut command = shell_that_leaves_a_survivor();
    command.stdout(Stdio::null()).stderr(Stdio::null());
    crate::process_registry::configure_managed_command_for_test(&mut command);
    command.spawn().expect("shell should start")
}

fn wait_for<F: Fn() -> bool>(condition: F, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    condition()
}

#[test]
fn sees_a_process_the_shell_detached_from_the_tree() {
    let mut child = spawn_with_group();
    let job = ManagedJob::adopt(&child).expect("job should be created");
    let _ = child.wait();

    assert!(
        wait_for(|| !job.live_pids().is_empty(), Duration::from_secs(5)),
        "the detached survivor must still be visible through the job"
    );

    job.terminate();
    assert!(
        wait_for(|| job.live_pids().is_empty(), Duration::from_secs(10)),
        "terminating the job must kill the survivor the shell detached"
    );
}

#[test]
fn excludes_the_direct_child_from_the_survivor_list() {
    let mut command = Command::new(if cfg!(windows) { "cmd" } else { "sh" });
    if cfg!(windows) {
        command.args(["/C", "ping -n 30 127.0.0.1"]);
    } else {
        command.args(["-lc", "sleep 30"]);
    }
    command.stdout(Stdio::null()).stderr(Stdio::null());
    crate::process_registry::configure_managed_command_for_test(&mut command);
    let mut child = command.spawn().expect("shell should start");

    let job = ManagedJob::adopt(&child).expect("job should be created");
    assert!(
        !job.live_pids().contains(&child.id()),
        "the leader is reported separately from what it left behind"
    );

    job.terminate();
    let _ = child.wait();
}
