//! Live event tailer.
//!
//! Polls `events.jsonl` every 500ms and emits each newly-appended line to the
//! frontend as a `run-event`. Polling (rather than filesystem-notify) keeps the
//! dependency surface minimal and behaves identically across platforms; the
//! event volume in run-state is small enough that this is effectively free.
//!
//! On first tick the whole file is replayed so the timeline starts populated.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::state;

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
