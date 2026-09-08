use std::ffi::OsStr;
use std::process::Command;
use std::time::SystemTime;

use serde::Serialize;

pub fn hidden_command<S>(program: S) -> Command
where
    S: AsRef<OsStr>,
{
    runtime::hidden_command(program)
}

/// One shell process the agent left running, as shown in the project summary.
/// Covers both `run_in_background` commands and services a shell forked with
/// `&` — the latter are adopted into the registry by the job that owns them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundProcessView {
    pub pid: u32,
    pub label: String,
    pub elapsed_ms: u64,
    /// Capture file for the process's stdout/stderr, when it has one. Adopted
    /// `&` survivors do not: nobody redirected them before they started.
    pub log_path: Option<String>,
}

#[tauri::command]
pub fn background_processes_list() -> Vec<BackgroundProcessView> {
    background_process_views(runtime::managed_processes_snapshot(), SystemTime::now())
}

/// Stop one background process and everything it started, then return the
/// refreshed list so the summary updates without waiting for the next poll.
#[tauri::command]
pub fn background_process_stop(pid: u32) -> Vec<BackgroundProcessView> {
    if pid != 0 {
        runtime::terminate_managed_process_tree(pid);
        runtime::unregister_managed_process(pid);
    }
    background_processes_list()
}

fn background_process_views(
    processes: Vec<runtime::ManagedProcessInfo>,
    now: SystemTime,
) -> Vec<BackgroundProcessView> {
    let mut running = processes
        .into_iter()
        .filter(|process| process.kind == runtime::ManagedProcessKind::Background)
        .collect::<Vec<_>>();
    // Oldest first: a service that has been up for an hour is the one worth
    // noticing, and the order stays stable as newer ones come and go.
    running.sort_by_key(|process| (process.started_at, process.pid));
    running
        .into_iter()
        .map(|process| BackgroundProcessView {
            pid: process.pid,
            label: process.label,
            elapsed_ms: now
                .duration_since(process.started_at)
                .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
                .unwrap_or(0),
            log_path: process.log_path,
        })
        .collect()
}

#[cfg(test)]
#[path = "tests/process.rs"]
mod tests;
