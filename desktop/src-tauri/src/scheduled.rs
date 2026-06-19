//! Read-only listing of scheduled ("定时任务") tasks for the Chat-side page.
//!
//! Tasks live in `~/.config/aris/scheduled-tasks.json` as a JSON array. The
//! store is intentionally simple and tolerant: unknown fields are ignored and
//! missing ones fall back to defaults, so a hand-written file (or a future
//! "create via chat" path) can populate it without a schema migration. Reading
//! is the only operation exposed today — the page only displays what exists.

use serde::{Deserialize, Serialize};

use crate::state;

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// Human-readable cadence, e.g. "心跳" (heartbeat), "每天 09:00", a cron expr.
    #[serde(default, alias = "schedule")]
    pub schedule_label: String,
    /// "active" | "paused" — anything other than "paused" is treated as active.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub next_run: Option<String>,
}

fn store_path() -> std::path::PathBuf {
    state::config_dir().join("scheduled-tasks.json")
}

/// Every scheduled task currently on disk. A missing or malformed file yields an
/// empty list rather than an error, so the page always renders.
#[tauri::command]
pub fn scheduled_tasks_list() -> Vec<ScheduledTask> {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<ScheduledTask>>(&text).ok())
        .unwrap_or_default()
}
