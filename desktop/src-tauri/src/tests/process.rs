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
