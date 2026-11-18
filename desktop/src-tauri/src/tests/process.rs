use super::background_process_views;
use runtime::{ManagedProcessInfo, ManagedProcessKind};
use std::time::{Duration, SystemTime};

fn process(
    pid: u32,
    label: &str,
    kind: ManagedProcessKind,
    started_ago: Duration,
    now: SystemTime,
) -> ManagedProcessInfo {
    ManagedProcessInfo {
        pid,
        label: label.to_string(),
        kind,
        started_at: now - started_ago,
        log_path: None,
    }
}

#[test]
fn lists_only_background_shell_processes_oldest_first() {
    let now = SystemTime::now();
    let views = background_process_views(
        vec![
            process(
                20,
                "bash background: npm run dev",
                ManagedProcessKind::Background,
                Duration::from_secs(5),
                now,
            ),
            process(
                30,
                "bash: cargo test",
                ManagedProcessKind::Foreground,
                Duration::from_secs(60),
                now,
            ),
            process(
                40,
                "mcp stdio: codex",
                ManagedProcessKind::Mcp,
                Duration::from_secs(600),
                now,
            ),
            process(
                10,
                "PowerShell background: python -m http.server",
                ManagedProcessKind::Background,
                Duration::from_secs(90),
                now,
            ),
        ],
        now,
    );

    let labels = views
        .iter()
        .map(|view| view.label.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        labels,
        vec![
            "PowerShell background: python -m http.server",
            "bash background: npm run dev",
        ],
        "foreground commands and MCP servers are not background services"
    );
    assert_eq!(views[0].pid, 10);
    assert!(views[0].elapsed_ms >= 90_000);
    assert!(views[1].elapsed_ms >= 5_000 && views[1].elapsed_ms < 90_000);
}

#[test]
fn reports_zero_elapsed_when_the_clock_moved_backwards() {
    let now = SystemTime::now();
    let views = background_process_views(
        vec![process(
            7,
            "bash background: serve",
            ManagedProcessKind::Background,
            Duration::ZERO,
            now + Duration::from_secs(120),
        )],
        now,
    );

    assert_eq!(views.len(), 1);
    assert_eq!(views[0].elapsed_ms, 0);
}

#[test]
fn returns_nothing_when_no_background_process_is_running() {
    assert!(background_process_views(Vec::new(), SystemTime::now()).is_empty());
}

#[test]
fn carries_the_capture_file_through_to_the_summary() {
    let now = SystemTime::now();
    let mut running = process(
        11,
        "bash background: npm run dev",
        ManagedProcessKind::Background,
        Duration::from_secs(1),
        now,
    );
    running.log_path = Some(".somniq/tmp/background/1-npm-run-dev.log".to_string());
    let adopted = process(
        12,
        "bash: npm run dev & [left running by the shell]",
        ManagedProcessKind::Background,
        Duration::ZERO,
        now,
    );

    let views = background_process_views(vec![running, adopted], now);

    assert_eq!(
        views[0].log_path.as_deref(),
        Some(".somniq/tmp/background/1-npm-run-dev.log")
    );
    assert_eq!(
        views[1].log_path, None,
        "a service the shell forked was never redirected, so it has no log"
    );
}

/// A command that keeps running for `seconds`, on every platform the app builds for.
fn sleeper(seconds: u32) -> std::process::Command {
    if cfg!(windows) {
        let mut command = super::hidden_command("powershell");
        command.args(["-NoProfile", "-NonInteractive", "-Command", &format!("Start-Sleep -Seconds {seconds}")]);
        command
    } else {
        let mut command = super::hidden_command("sleep");
        command.arg(seconds.to_string());
        command
    }
}

#[test]
fn a_bounded_process_is_killed_when_it_runs_past_its_timeout() {
    let started = std::time::Instant::now();
    let result = super::output_bounded(&mut sleeper(30), std::time::Duration::from_millis(800), None);
    assert!(matches!(result, Err(super::BoundedOutputError::Stopped(super::BoundedStop::TimedOut))));
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "returned only after the child exited");
    let message = result.unwrap_err().describe("Tesseract OCR", std::time::Duration::from_secs(120));
    assert!(message.contains("120s"), "{message}");
}

#[test]
fn a_bounded_process_stops_as_soon_as_it_is_canceled() {
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let raise = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        raise.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let started = std::time::Instant::now();
    let result = super::output_bounded(&mut sleeper(30), std::time::Duration::from_secs(60), Some(&cancel));
    assert!(matches!(result, Err(super::BoundedOutputError::Stopped(super::BoundedStop::Canceled))));
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
}

#[test]
fn a_bounded_process_that_finishes_returns_its_output() {
    let mut command = if cfg!(windows) {
        let mut command = super::hidden_command("cmd");
        command.args(["/C", "echo bounded"]);
        command
    } else {
        let mut command = super::hidden_command("echo");
        command.arg("bounded");
        command
    };
    let output = super::output_bounded(&mut command, std::time::Duration::from_secs(30), None).expect("ran");
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("bounded"));
    // A missing tool is reported as unavailable, as before.
    let missing = super::output_bounded(&mut super::hidden_command("somniq-no-such-tool"), std::time::Duration::from_secs(5), None);
    assert!(missing.unwrap_err().describe("pdftoppm", std::time::Duration::from_secs(5)).contains("unavailable"));
}
