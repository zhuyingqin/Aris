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

/// Why [`output_bounded`] stopped a process before it finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoundedStop {
    TimedOut,
    Canceled,
}

/// Run `command` to completion like `Command::output`, but give up after
/// `timeout` or as soon as `cancel` is raised: the child is killed and waited
/// for, so no OCR or PDF tool outlives the request that started it. Output is
/// drained on its own threads so a chatty child cannot block on a full pipe.
pub fn output_bounded(
    command: &mut Command,
    timeout: std::time::Duration,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<std::process::Output, BoundedOutputError> {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::atomic::Ordering;

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(BoundedOutputError::Spawn)?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = drain(child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BoundedOutputError::Wait(error));
            }
        }
        let stop = if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            Some(BoundedStop::Canceled)
        } else if std::time::Instant::now() >= deadline {
            Some(BoundedStop::TimedOut)
        } else {
            None
        };
        if let Some(stop) = stop {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout.join();
            let _ = stderr.join();
            return Err(BoundedOutputError::Stopped(stop));
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    Ok(std::process::Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

#[derive(Debug)]
pub enum BoundedOutputError {
    Spawn(std::io::Error),
    Wait(std::io::Error),
    Stopped(BoundedStop),
}

impl BoundedOutputError {
    /// A message naming the tool, in the shape the callers already used.
    pub fn describe(&self, tool: &str, timeout: std::time::Duration) -> String {
        match self {
            Self::Spawn(error) => format!("{tool} is unavailable: {error}"),
            Self::Wait(error) => format!("{tool} could not be waited for: {error}"),
            Self::Stopped(BoundedStop::TimedOut) => {
                format!("{tool} took longer than {}s and was stopped", timeout.as_secs())
            }
            Self::Stopped(BoundedStop::Canceled) => format!("{tool} was canceled"),
        }
    }

}
