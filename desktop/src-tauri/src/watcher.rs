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

use notify::{ErrorKind, Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::{files, projects, state};

const WORKSPACE_FILE_CHANGED_EVENT: &str = "workspace-file-changed";
const WATCH_REBIND_INTERVAL: Duration = Duration::from_millis(500);
const DUPLICATE_EVENT_WINDOW: Duration = Duration::from_millis(80);
const INITIAL_WATCH_RETRY: Duration = Duration::from_secs(1);
const MAX_WATCH_RETRY: Duration = Duration::from_secs(60);

#[derive(Default)]
struct WorkspaceWatchBinding {
    watched_root: Option<PathBuf>,
    requested: Option<(PathBuf, u64)>,
    retry_at: Option<Instant>,
    retry_delay: Duration,
}

impl WorkspaceWatchBinding {
    fn bind(
        &mut self,
        watcher: &mut impl Watcher,
        next_root: PathBuf,
        generation: u64,
        now: Instant,
    ) -> Result<(), notify::Error> {
        let requested = (next_root.clone(), generation);
        if self.requested.as_ref() != Some(&requested) {
            self.requested = Some(requested);
            self.retry_at = Some(now);
            self.retry_delay = INITIAL_WATCH_RETRY;
        }
        if self.watched_root.as_ref() == Some(&next_root)
            || !self.retry_at.is_some_and(|retry_at| now >= retry_at)
        {
            return Ok(());
        }
        if let Some(previous) = self.watched_root.take() {
            let _ = watcher.unwatch(&previous);
        }
        match watcher.watch(&next_root, RecursiveMode::Recursive) {
            Ok(()) => {
                self.watched_root = Some(next_root);
                self.retry_at = None;
                Ok(())
            }
            Err(error) => {
                // Files and Folders denial is a user decision. Retrying every
                // 500ms cannot grant access and can keep macOS asking. Other
                // errors (e.g. an offline volume) recover with bounded backoff.
                self.retry_at = if matches!(
                    &error.kind,
                    ErrorKind::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied
                ) {
                    None
                } else {
                    Some(now + self.retry_delay)
                };
                self.retry_delay = (self.retry_delay * 2).min(MAX_WATCH_RETRY);
                Err(error)
            }
        }
    }
}

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
        let mut binding = WorkspaceWatchBinding::default();
        let mut recent = HashMap::new();
        loop {
            if let Ok((root, generation)) = projects::current_project_watch_binding(
                app.state::<projects::ProjectState>().inner(),
            ) {
                if let Err(error) = binding.bind(&mut watcher, root, generation, Instant::now()) {
                    eprintln!("SomniQ could not watch the current workspace: {error}");
                }
            }
            match receiver.recv_timeout(WATCH_REBIND_INTERVAL) {
                Ok(Ok(event)) => {
                    if let Some(root) = binding.watched_root.as_deref() {
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
    use super::*;

    #[derive(Default)]
    struct RecordingWatcher {
        calls: Vec<PathBuf>,
        unwatched: Vec<PathBuf>,
        failure: Option<std::io::ErrorKind>,
    }

    impl Watcher for RecordingWatcher {
        fn new<F: notify::EventHandler>(_: F, _: notify::Config) -> notify::Result<Self> {
            Ok(Self::default())
        }

        fn watch(&mut self, path: &Path, _: RecursiveMode) -> notify::Result<()> {
            self.calls.push(path.to_path_buf());
            match self.failure {
                Some(kind) => Err(notify::Error::io(std::io::Error::from(kind))),
                None => Ok(()),
            }
        }

        fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
            self.unwatched.push(path.to_path_buf());
            Ok(())
        }

        fn kind() -> notify::WatcherKind {
            notify::WatcherKind::PollWatcher
        }
    }

    #[test]
    fn an_authorized_workspace_is_watched_once_across_poll_ticks() {
        let mut watcher = RecordingWatcher::default();
        let mut binding = WorkspaceWatchBinding::default();
        let now = Instant::now();
        for tick in 0..1_000 {
            binding
                .bind(
                    &mut watcher,
                    "paper".into(),
                    1,
                    now + WATCH_REBIND_INTERVAL * tick,
                )
                .unwrap();
        }
        assert_eq!(watcher.calls, vec![PathBuf::from("paper")]);
        assert_eq!(binding.watched_root, Some("paper".into()));
    }

    #[test]
    fn a_denied_workspace_waits_for_explicit_reactivation() {
        let mut watcher = RecordingWatcher {
            failure: Some(std::io::ErrorKind::PermissionDenied),
            ..Default::default()
        };
        let mut binding = WorkspaceWatchBinding::default();
        let now = Instant::now();
        assert!(binding.bind(&mut watcher, "paper".into(), 1, now).is_err());
        for tick in 1..1_000 {
            binding
                .bind(
                    &mut watcher,
                    "paper".into(),
                    1,
                    now + Duration::from_secs(tick),
                )
                .unwrap();
        }
        assert_eq!(watcher.calls.len(), 1);
        assert!(binding.watched_root.is_none());
        watcher.failure = None;
        binding.bind(&mut watcher, "paper".into(), 2, now).unwrap();
        assert_eq!(watcher.calls.len(), 2);
        assert_eq!(binding.watched_root, Some("paper".into()));
    }

    #[test]
    fn transient_failures_back_off_and_recover_without_reopening() {
        let mut watcher = RecordingWatcher {
            failure: Some(std::io::ErrorKind::NotFound),
            ..Default::default()
        };
        let mut binding = WorkspaceWatchBinding::default();
        let now = Instant::now();
        assert!(binding.bind(&mut watcher, "paper".into(), 1, now).is_err());
        let mut elapsed = Duration::ZERO;
        for (attempt, delay) in [1, 2, 4, 8, 16, 32, 60, 60].into_iter().enumerate() {
            elapsed += Duration::from_secs(delay);
            binding
                .bind(
                    &mut watcher,
                    "paper".into(),
                    1,
                    now + elapsed - WATCH_REBIND_INTERVAL,
                )
                .unwrap();
            assert_eq!(watcher.calls.len(), attempt + 1);
            assert!(binding
                .bind(&mut watcher, "paper".into(), 1, now + elapsed)
                .is_err());
            assert_eq!(watcher.calls.len(), attempt + 2);
        }
        watcher.failure = None;
        binding
            .bind(
                &mut watcher,
                "paper".into(),
                1,
                now + elapsed + MAX_WATCH_RETRY,
            )
            .unwrap();
        assert_eq!(binding.watched_root, Some("paper".into()));
    }

    #[test]
    fn switching_projects_releases_the_old_watch_and_resets_a_denial() {
        let mut watcher = RecordingWatcher::default();
        let mut binding = WorkspaceWatchBinding::default();
        let now = Instant::now();
        binding.bind(&mut watcher, "first".into(), 1, now).unwrap();
        watcher.failure = Some(std::io::ErrorKind::PermissionDenied);
        assert!(binding.bind(&mut watcher, "second".into(), 2, now).is_err());
        assert_eq!(watcher.unwatched, vec![PathBuf::from("first")]);
        assert!(binding.watched_root.is_none());
        watcher.failure = None;
        binding.bind(&mut watcher, "first".into(), 3, now).unwrap();
        assert_eq!(watcher.calls.len(), 3);
        assert_eq!(binding.watched_root, Some("first".into()));
    }

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
