//! Read-only listing of scheduled tasks for the Chat-side page.
//!
//! ARIS-local tasks live in `~/.config/aris/scheduled-tasks.json`, while tasks
//! created through the surrounding Codex app live under
//! `~/.codex/automations/*/automation.toml`. The page should show both so a
//! successfully-created automation is not invisible in the ARIS UI.

use std::collections::HashSet;
use std::path::PathBuf;

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

#[derive(Deserialize)]
struct CodexAutomation {
    id: String,
    kind: Option<String>,
    name: Option<String>,
    prompt: Option<String>,
    status: Option<String>,
    rrule: Option<String>,
    target_thread_id: Option<String>,
    created_at: Option<i64>,
}

fn store_path() -> std::path::PathBuf {
    state::config_dir().join("scheduled-tasks.json")
}

fn codex_automations_dir() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(runtime::home_dir()).join(".codex"))
        .join("automations")
}

fn local_scheduled_tasks() -> Vec<ScheduledTask> {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<ScheduledTask>>(&text).ok())
        .unwrap_or_default()
}

fn codex_scheduled_tasks() -> Vec<ScheduledTask> {
    let Ok(entries) = std::fs::read_dir(codex_automations_dir()) else {
        return Vec::new();
    };

    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path().join("automation.toml");
            let text = std::fs::read_to_string(path).ok()?;
            let automation = toml::from_str::<CodexAutomation>(&text).ok()?;
            Some(automation.into())
        })
        .collect()
}

impl From<CodexAutomation> for ScheduledTask {
    fn from(automation: CodexAutomation) -> Self {
        let CodexAutomation {
            id,
            kind,
            name,
            prompt,
            status,
            rrule,
            target_thread_id,
            created_at,
        } = automation;

        let kind = kind.unwrap_or_else(|| "automation".to_string());
        let schedule_label = rrule
            .as_deref()
            .map(schedule_label_from_rrule)
            .unwrap_or_else(|| kind.clone());
        let title = name
            .or_else(|| prompt.and_then(|text| first_prompt_line(&text)))
            .unwrap_or_else(|| id.clone());

        Self {
            id,
            title,
            schedule_label: format!("{kind}: {schedule_label}"),
            status: if status.as_deref() == Some("PAUSED") {
                "paused".to_string()
            } else {
                "active".to_string()
            },
            session_id: target_thread_id,
            created_at: created_at.map(|value| value.to_string()),
            next_run: None,
        }
    }
}

fn first_prompt_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| {
            let mut chars = line.chars();
            let preview = chars.by_ref().take(80).collect::<String>();
            if chars.next().is_some() {
                format!("{preview}...")
            } else {
                preview
            }
        })
}

fn schedule_label_from_rrule(rrule: &str) -> String {
    let frequency = rrule_field(rrule, "FREQ");
    let interval = rrule_field(rrule, "INTERVAL").and_then(|value| value.parse::<u64>().ok());

    match (frequency.as_deref(), interval) {
        (Some("MINUTELY"), Some(1) | None) => "every minute".to_string(),
        (Some("MINUTELY"), Some(minutes)) => format!("every {minutes} minutes"),
        (Some("HOURLY"), Some(1) | None) => "hourly".to_string(),
        (Some("HOURLY"), Some(hours)) => format!("every {hours} hours"),
        (Some("DAILY"), Some(1) | None) => "daily".to_string(),
        (Some("DAILY"), Some(days)) => format!("every {days} days"),
        (Some("WEEKLY"), Some(1) | None) => "weekly".to_string(),
        (Some("WEEKLY"), Some(weeks)) => format!("every {weeks} weeks"),
        _ => rrule.to_string(),
    }
}

fn rrule_field(rrule: &str, key: &str) -> Option<String> {
    rrule.split(';').find_map(|part| {
        let (field, value) = part.split_once('=')?;
        if field == key {
            Some(value.to_string())
        } else {
            None
        }
    })
}

/// Every scheduled task currently on disk. A missing or malformed source yields
/// an empty contribution rather than an error, so the page always renders.
#[tauri::command]
pub fn scheduled_tasks_list() -> Vec<ScheduledTask> {
    let mut tasks = local_scheduled_tasks();
    let mut seen = tasks
        .iter()
        .map(|task| task.id.clone())
        .collect::<HashSet<_>>();

    for task in codex_scheduled_tasks() {
        if seen.insert(task.id.clone()) {
            tasks.push(task);
        }
    }

    tasks
}

#[cfg(test)]
mod tests {
    use super::{schedule_label_from_rrule, CodexAutomation, ScheduledTask};

    #[test]
    fn codex_automation_maps_to_scheduled_task() {
        let task = ScheduledTask::from(CodexAutomation {
            id: "check-thing".to_string(),
            kind: Some("heartbeat".to_string()),
            name: Some("Check thing".to_string()),
            prompt: None,
            status: Some("PAUSED".to_string()),
            rrule: Some("FREQ=MINUTELY;INTERVAL=15".to_string()),
            target_thread_id: Some("thread-1".to_string()),
            created_at: Some(1234),
        });

        assert_eq!(task.id, "check-thing");
        assert_eq!(task.title, "Check thing");
        assert_eq!(task.schedule_label, "heartbeat: every 15 minutes");
        assert_eq!(task.status, "paused");
        assert_eq!(task.session_id.as_deref(), Some("thread-1"));
        assert_eq!(task.created_at.as_deref(), Some("1234"));
    }

    #[test]
    fn schedule_label_keeps_unknown_rrules_readable() {
        assert_eq!(
            schedule_label_from_rrule("FREQ=MONTHLY;INTERVAL=2"),
            "FREQ=MONTHLY;INTERVAL=2"
        );
    }
}
