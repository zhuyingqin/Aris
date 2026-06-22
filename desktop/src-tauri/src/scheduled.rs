//! ARIS-owned scheduled task registry for the Chat-side page.
//!
//! The on-disk shape intentionally mirrors the Codex automation TOML shape, but
//! lives under ARIS config: `~/.config/aris/automations/<id>/automation.toml`.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::state;

const TASK_KIND: &str = "aris-scheduled-task";
const STATUS_ACTIVE: &str = "ACTIVE";
const STATUS_PAUSED: &str = "PAUSED";

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, alias = "schedule")]
    pub schedule_label: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub rrule: String,
    #[serde(default)]
    pub interval_value: u32,
    #[serde(default)]
    pub interval_unit: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub next_run: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ArisScheduledRecord {
    version: u32,
    id: String,
    kind: String,
    name: String,
    prompt: String,
    status: String,
    rrule: String,
    target_thread_id: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskInput {
    title: String,
    prompt: String,
    session_id: String,
    interval_value: u32,
    interval_unit: String,
    status: Option<String>,
}

struct NormalizedTaskInput {
    title: String,
    prompt: String,
    session_id: String,
    interval_value: u32,
    interval_unit: String,
    status: String,
}

fn legacy_store_path() -> PathBuf {
    state::config_dir().join("scheduled-tasks.json")
}

fn chat_ui_sessions_path() -> PathBuf {
    state::runtime_dir().join("chat-ui-sessions.json")
}

fn aris_automations_dir() -> PathBuf {
    state::config_dir().join("automations")
}

fn task_dir(id: &str) -> Result<PathBuf, String> {
    validate_task_id(id)?;
    Ok(aris_automations_dir().join(id))
}

fn task_path(id: &str) -> Result<PathBuf, String> {
    Ok(task_dir(id)?.join("automation.toml"))
}

fn legacy_scheduled_tasks() -> Vec<ScheduledTask> {
    fs::read_to_string(legacy_store_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<ScheduledTask>>(&text).ok())
        .unwrap_or_default()
}

fn aris_scheduled_tasks() -> Vec<ScheduledTask> {
    let Ok(entries) = fs::read_dir(aris_automations_dir()) else {
        return Vec::new();
    };

    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path().join("automation.toml");
            let record = read_record_from_path(&path).ok()?;
            Some(record.into())
        })
        .collect()
}

fn read_record(id: &str) -> Result<ArisScheduledRecord, String> {
    read_record_from_path(&task_path(id)?)
}

fn read_record_from_path(path: &Path) -> Result<ArisScheduledRecord, String> {
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    toml::from_str::<ArisScheduledRecord>(&text).map_err(|error| error.to_string())
}

fn write_record(record: &ArisScheduledRecord) -> Result<(), String> {
    let dir = task_dir(&record.id)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join("automation.toml");
    let tmp = dir.join("automation.toml.tmp");
    let text = toml::to_string_pretty(record).map_err(|error| error.to_string())?;
    fs::write(&tmp, text).map_err(|error| error.to_string())?;
    // `fs::rename` atomically replaces an existing file on both Unix and Windows
    // (MoveFileExW + MOVEFILE_REPLACE_EXISTING); removing the destination first
    // would open a crash window where neither the old nor the new file exists.
    fs::rename(tmp, path).map_err(|error| error.to_string())
}

fn validate_task_id(id: &str) -> Result<(), String> {
    if is_safe_identifier(id) {
        Ok(())
    } else {
        Err("invalid scheduled task id".to_string())
    }
}

/// A conservative check for filesystem-bound identifiers (task ids and the chat
/// session id a task binds to): non-empty, length-bounded, and restricted to
/// characters that cannot express a path. Rejects separators (`/`, `\`),
/// drive-relative ids (`C:foo`), the `\\?\` prefix, and bare `.` / `..` — which
/// closes the Windows path-bypass on session ids. (Real ids are alphanumeric +
/// `-`/`_`, e.g. `chat-1781326932161-sqk1vz`.)
fn is_safe_identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn normalize_input(
    input: ScheduledTaskInput,
    fallback_status: Option<&str>,
) -> Result<NormalizedTaskInput, String> {
    let title = input.title.trim().to_string();
    let prompt = input.prompt.trim().to_string();
    let session_id = input.session_id.trim().to_string();
    if prompt.is_empty() {
        return Err("scheduled task prompt is required".to_string());
    }
    if !is_safe_identifier(&session_id) {
        return Err("scheduled task must be bound to a valid chat session".to_string());
    }
    if !session_exists(&session_id) {
        return Err("scheduled task must be bound to an existing chat session".to_string());
    }
    if input.interval_value == 0 || input.interval_value > 10_000 {
        return Err("scheduled task interval must be between 1 and 10000".to_string());
    }
    let interval_unit = normalize_interval_unit(&input.interval_unit)?;
    let status = input
        .status
        .as_deref()
        .or(fallback_status)
        .map(normalize_status)
        .transpose()?
        .unwrap_or_else(|| STATUS_ACTIVE.to_string());

    Ok(NormalizedTaskInput {
        title: if title.is_empty() {
            first_prompt_line(&prompt).unwrap_or_else(|| "Scheduled task".to_string())
        } else {
            title
        },
        prompt,
        session_id,
        interval_value: input.interval_value,
        interval_unit,
        status,
    })
}

fn normalize_status(status: &str) -> Result<String, String> {
    match status {
        "active" | "ACTIVE" => Ok(STATUS_ACTIVE.to_string()),
        "paused" | "PAUSED" => Ok(STATUS_PAUSED.to_string()),
        _ => Err("scheduled task status must be active or paused".to_string()),
    }
}

fn normalize_interval_unit(unit: &str) -> Result<String, String> {
    match unit {
        "minutes" | "hours" | "days" => Ok(unit.to_string()),
        _ => Err("scheduled task interval unit must be minutes, hours, or days".to_string()),
    }
}

fn session_exists(session_id: &str) -> bool {
    if state::sessions_dir()
        .join(format!("{session_id}.json"))
        .is_file()
    {
        return true;
    }
    let Ok(text) = fs::read_to_string(chat_ui_sessions_path()) else {
        return false;
    };
    let Ok(Value::Array(sessions)) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    sessions.iter().any(|session| {
        session
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id == session_id)
    })
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

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn new_task_id() -> String {
    format!("task-{}-{}", now_millis(), std::process::id())
}

fn rrule_for_interval(value: u32, unit: &str) -> String {
    let frequency = match unit {
        "minutes" => "MINUTELY",
        "hours" => "HOURLY",
        "days" => "DAILY",
        _ => "MINUTELY",
    };
    format!("FREQ={frequency};INTERVAL={value}")
}

fn interval_from_rrule(rrule: &str) -> (u32, String) {
    let value = rrule_field(rrule, "INTERVAL")
        .and_then(|raw| raw.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1);
    let unit = match rrule_field(rrule, "FREQ").as_deref() {
        Some("HOURLY") => "hours",
        Some("DAILY") => "days",
        _ => "minutes",
    };
    (value, unit.to_string())
}

fn schedule_label_from_rrule(rrule: &str) -> String {
    let (value, unit) = interval_from_rrule(rrule);
    let unit_label = match unit.as_str() {
        "hours" => "小时",
        "days" => "天",
        _ => "分钟",
    };
    format!("每 {value} {unit_label}")
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

impl From<ArisScheduledRecord> for ScheduledTask {
    fn from(record: ArisScheduledRecord) -> Self {
        let (interval_value, interval_unit) = interval_from_rrule(&record.rrule);
        Self {
            id: record.id,
            title: record.name,
            schedule_label: schedule_label_from_rrule(&record.rrule),
            status: if record.status == STATUS_PAUSED {
                "paused".to_string()
            } else {
                "active".to_string()
            },
            session_id: Some(record.target_thread_id),
            prompt: record.prompt,
            rrule: record.rrule,
            interval_value,
            interval_unit,
            created_at: Some(record.created_at.to_string()),
            updated_at: Some(record.updated_at.to_string()),
            next_run: None,
        }
    }
}

/// Every scheduled task currently on disk. Legacy JSON is listed read-only;
/// new ARIS-owned tasks live in TOML files under `~/.config/aris/automations`.
#[tauri::command]
pub fn scheduled_tasks_list() -> Vec<ScheduledTask> {
    let mut tasks = aris_scheduled_tasks();
    let mut seen = tasks
        .iter()
        .map(|task| task.id.clone())
        .collect::<HashSet<_>>();

    for task in legacy_scheduled_tasks() {
        if seen.insert(task.id.clone()) {
            tasks.push(task);
        }
    }

    tasks.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    tasks
}

#[tauri::command]
pub fn scheduled_task_create(input: ScheduledTaskInput) -> Result<ScheduledTask, String> {
    let normalized = normalize_input(input, None)?;
    let now = now_millis();
    let record = ArisScheduledRecord {
        version: 1,
        id: new_task_id(),
        kind: TASK_KIND.to_string(),
        name: normalized.title,
        prompt: normalized.prompt,
        status: normalized.status,
        rrule: rrule_for_interval(normalized.interval_value, &normalized.interval_unit),
        target_thread_id: normalized.session_id,
        created_at: now,
        updated_at: now,
    };
    write_record(&record)?;
    Ok(record.into())
}

#[tauri::command]
pub fn scheduled_task_update(
    id: String,
    input: ScheduledTaskInput,
) -> Result<ScheduledTask, String> {
    validate_task_id(&id)?;
    let existing = read_record(&id)?;
    let normalized = normalize_input(input, Some(&existing.status))?;
    let record = ArisScheduledRecord {
        version: existing.version,
        id,
        kind: TASK_KIND.to_string(),
        name: normalized.title,
        prompt: normalized.prompt,
        status: normalized.status,
        rrule: rrule_for_interval(normalized.interval_value, &normalized.interval_unit),
        target_thread_id: normalized.session_id,
        created_at: existing.created_at,
        updated_at: now_millis(),
    };
    write_record(&record)?;
    Ok(record.into())
}

#[tauri::command]
pub fn scheduled_task_set_status(id: String, status: String) -> Result<ScheduledTask, String> {
    validate_task_id(&id)?;
    let mut record = read_record(&id)?;
    record.status = normalize_status(&status)?;
    record.updated_at = now_millis();
    write_record(&record)?;
    Ok(record.into())
}

#[tauri::command]
pub fn scheduled_task_delete(id: String) -> Result<(), String> {
    let dir = task_dir(&id)?;
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        interval_from_rrule, is_safe_identifier, normalize_status, rrule_for_interval,
        schedule_label_from_rrule, ArisScheduledRecord, ScheduledTask, STATUS_ACTIVE, STATUS_PAUSED,
    };

    #[test]
    fn aris_record_maps_to_scheduled_task() {
        let task = ScheduledTask::from(ArisScheduledRecord {
            version: 1,
            id: "task-1".to_string(),
            kind: "aris-scheduled-task".to_string(),
            name: "Check inbox".to_string(),
            prompt: "Check unread mail".to_string(),
            status: STATUS_PAUSED.to_string(),
            rrule: "FREQ=MINUTELY;INTERVAL=15".to_string(),
            target_thread_id: "chat-1".to_string(),
            created_at: 10,
            updated_at: 20,
        });

        assert_eq!(task.id, "task-1");
        assert_eq!(task.title, "Check inbox");
        assert_eq!(task.schedule_label, "每 15 分钟");
        assert_eq!(task.status, "paused");
        assert_eq!(task.session_id.as_deref(), Some("chat-1"));
        assert_eq!(task.interval_value, 15);
        assert_eq!(task.interval_unit, "minutes");
    }

    #[test]
    fn interval_round_trips_to_rrule() {
        assert_eq!(rrule_for_interval(2, "hours"), "FREQ=HOURLY;INTERVAL=2");
        assert_eq!(
            interval_from_rrule("FREQ=DAILY;INTERVAL=3"),
            (3, "days".to_string())
        );
        assert_eq!(
            schedule_label_from_rrule("FREQ=HOURLY;INTERVAL=6"),
            "每 6 小时"
        );
    }

    #[test]
    fn status_accepts_ui_and_toml_values() {
        assert_eq!(normalize_status("active").unwrap(), STATUS_ACTIVE);
        assert_eq!(normalize_status("PAUSED").unwrap(), STATUS_PAUSED);
        assert!(normalize_status("running").is_err());
    }

    #[test]
    fn safe_identifier_accepts_session_ids_and_rejects_path_chars() {
        assert!(is_safe_identifier("chat-1781326932161-sqk1vz"));
        assert!(is_safe_identifier("task-1_2"));
        assert!(!is_safe_identifier(""));
        assert!(!is_safe_identifier("C:foo")); // drive-relative path
        assert!(!is_safe_identifier("a/b")); // path separators
        assert!(!is_safe_identifier("a\\b"));
        assert!(!is_safe_identifier(".")); // bare dot
        assert!(!is_safe_identifier(&"x".repeat(129))); // length bound
    }
}
