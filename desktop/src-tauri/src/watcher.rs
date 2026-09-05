//! Live runtime and workspace event bridges.
//!
//! Polls `events.jsonl` every 500ms and emits each newly-appended line to the
//! frontend as a `run-event`. Workspace files use the operating system's native
//! watcher and are normalized into a separate `workspace-file-changed` event.
//!
//! On first tick the whole file is replayed so the timeline starts populated.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::{files, projects, state};

const WORKSPACE_FILE_CHANGED_EVENT: &str = "workspace-file-changed";
const WATCH_REBIND_INTERVAL: Duration = Duration::from_millis(500);
const DUPLICATE_EVENT_WINDOW: Duration = Duration::from_millis(80);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileChanged {
    path: String,
    kind: &'static str,
    occurred_at_ms: u128,
}

fn workspace_event_kind(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        EventKind::Access(_) => "access",
        EventKind::Other | EventKind::Any => "other",
    }
}

fn ignored_workspace_path(path: &str) -> bool {
    path.split('/').any(|part| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            ".git" | ".somniq" | "node_modules" | "target"
        ) || files::is_transient_temp_file(part)
    })
}

fn workspace_relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    let value = relative.to_string_lossy().replace('\\', "/");
    (!ignored_workspace_path(&value)).then_some(value)
}

fn emit_workspace_event(
    app: &AppHandle,
    root: &Path,
    event: Event,
    recent: &mut HashMap<(String, &'static str), Instant>,
) {
    // Access events are reads, not document changes. Some backends emit them for
    // every compiler input and would otherwise flood the editor.
    if matches!(event.kind, EventKind::Access(_)) {
        return;
    }
    let kind = workspace_event_kind(&event.kind);
    let now = Instant::now();
    recent.retain(|_, seen| now.duration_since(*seen) <= DUPLICATE_EVENT_WINDOW * 4);
    for path in event.paths {
        let Some(path) = workspace_relative_path(root, &path) else {
            continue;
        };
        let key = (path.clone(), kind);
        if recent
            .get(&key)
            .is_some_and(|seen| now.duration_since(*seen) <= DUPLICATE_EVENT_WINDOW)
        {
            continue;
        }
        recent.insert(key, now);
        let payload = WorkspaceFileChanged {
            path,
            kind,
            occurred_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default(),
        };
        if let Err(error) = app.emit(WORKSPACE_FILE_CHANGED_EVENT, payload) {
            eprintln!("SomniQ workspace watcher could not emit an event: {error}");
        }
    }
}

fn bind_workspace_watcher(
    watcher: &mut RecommendedWatcher,
    watched_root: &mut Option<PathBuf>,
    next_root: PathBuf,
) -> Result<(), notify::Error> {
    if watched_root.as_ref() == Some(&next_root) {
        return Ok(());
    }
    if let Some(previous) = watched_root.take() {
        let _ = watcher.unwatch(&previous);
    }
    watcher.watch(&next_root, RecursiveMode::Recursive)?;
    *watched_root = Some(next_root);
    Ok(())
}

pub fn spawn_workspace_file_watcher(app: AppHandle) {
    thread::spawn(move || {
        let (sender, receiver) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = match notify::recommended_watcher(sender) {
            Ok(watcher) => watcher,
            Err(error) => {
                eprintln!("SomniQ workspace watcher unavailable: {error}");
                return;
            }
        };
        let mut watched_root: Option<PathBuf> = None;
        let mut recent = HashMap::new();
        loop {
            if let Ok(root) =
                projects::current_project_path(app.state::<projects::ProjectState>().inner())
            {
                if root.is_dir() {
                    if let Err(error) =
                        bind_workspace_watcher(&mut watcher, &mut watched_root, root)
                    {
                        eprintln!("SomniQ could not watch the current workspace: {error}");
                    }
                }
            }
            match receiver.recv_timeout(WATCH_REBIND_INTERVAL) {
                Ok(Ok(event)) => {
                    if let Some(root) = watched_root.as_deref() {
                        emit_workspace_event(&app, root, event, &mut recent);
                    }
                }
                Ok(Err(error)) => eprintln!("SomniQ workspace watch error: {error}"),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}

pub fn spawn_event_watcher(app: AppHandle) {
    thread::spawn(move || {
        let mut active_path = state::events_path();
        let mut offset: u64 = 0;
        loop {
            let path = state::events_path();
            if path != active_path {
                active_path = path.clone();
                offset = 0;
            }
            if let Ok(mut file) = File::open(&path) {
                let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
                if len < offset {
                    // file truncated or rotated — replay from the start
                    offset = 0;
                }
                if len > offset && file.seek(SeekFrom::Start(offset)).is_ok() {
                    let mut buf = String::new();
                    if file.read_to_string(&mut buf).is_ok() {
                        // Only consume through the final newline so a half-written
                        // trailing line is picked up on the next tick instead.
                        if let Some(last_newline) = buf.rfind('\n') {
                            let consumed = &buf[..=last_newline];
                            offset += consumed.len() as u64;
                            for line in consumed.lines() {
                                let line = line.trim();
                                if line.is_empty() {
                                    continue;
                                }
                                if let Ok(value) = serde_json::from_str::<Value>(line) {
                                    let _ = app.emit("run-event", value);
                                }
                            }
                        }
                    }
                }
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{ignored_workspace_path, workspace_relative_path};
    use std::path::Path;

    #[test]
    fn workspace_events_are_relative_and_normalized() {
        let root = Path::new("research/paper");
        let path = Path::new("research/paper/chapters/intro.tex");
        assert_eq!(
            workspace_relative_path(root, path).as_deref(),
            Some("chapters/intro.tex")
        );
    }

    #[test]
    fn internal_and_build_trees_are_not_broadcast() {
        for path in [
            ".somniq/recovery/a.json",
            ".git/index",
            "desktop/node_modules/pkg/index.js",
            "target/debug/app.exe",
        ] {
            assert!(ignored_workspace_path(path), "{path}");
        }
        assert!(!ignored_workspace_path("chapters/intro.tex"));
    }

    #[test]
    fn atomic_write_scratch_siblings_are_not_broadcast() {
        assert!(ignored_workspace_path(".tmpI7Xp4h"));
        assert!(ignored_workspace_path("chapters/.tmpA1b2C3d4"));
        // Only the exact scratch shape: real project files keep their events.
        assert!(!ignored_workspace_path(".tmpfile.tex"));
        assert!(!ignored_workspace_path("chapters/.tmp"));
    }
}
