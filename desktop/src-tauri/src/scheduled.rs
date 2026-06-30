//! ARIS-owned scheduled task registry for the Chat-side page.
//!
//! The on-disk shape intentionally mirrors the Codex automation TOML shape, but
//! lives under ARIS config: `~/.config/aris/automations/<id>/automation.toml`.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::state;

const TASK_KIND: &str = "aris-scheduled-task";
const STATUS_ACTIVE: &str = "ACTIVE";
const STATUS_PAUSED: &str = "PAUSED";
/// Task fires on a time interval (`rrule`). The default for legacy records.
const TRIGGER_INTERVAL: &str = "interval";
/// Task fires when a new mail arrives (optionally filtered by account/keyword).
const TRIGGER_MAIL: &str = "mail";
const RUNNER_TICK_SECS: u64 = 30;
static RUNNER_STARTED: OnceLock<()> = OnceLock::new();

fn default_trigger_kind() -> String {
    TRIGGER_INTERVAL.to_string()
}

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
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub next_run: Option<String>,
    #[serde(default = "default_trigger_kind")]
    pub trigger_kind: String,
    #[serde(default)]
    pub mail_account_id: String,
    #[serde(default)]
    pub mail_keywords: Vec<String>,
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
    #[serde(default)]
    last_run_at: Option<i64>,
    #[serde(default)]
    last_error: Option<String>,
    #[serde(default = "default_trigger_kind")]
    trigger_kind: String,
    #[serde(default)]
    mail_account_id: String,
    #[serde(default)]
    mail_keywords: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskInput {
    title: String,
    prompt: String,
    session_id: String,
    #[serde(default)]
    interval_value: u32,
    #[serde(default)]
    interval_unit: String,
    status: Option<String>,
    #[serde(default)]
    trigger_kind: Option<String>,
    #[serde(default)]
    mail_account_id: Option<String>,
    #[serde(default)]
    mail_keywords: Option<Vec<String>>,
}

struct NormalizedTaskInput {
    title: String,
    prompt: String,
    session_id: String,
    interval_value: u32,
    interval_unit: String,
    status: String,
    trigger_kind: String,
    mail_account_id: String,
    mail_keywords: Vec<String>,
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
    let trigger_kind = normalize_trigger_kind(input.trigger_kind.as_deref())?;
    // Mail-triggered tasks don't run on a clock, so the interval is irrelevant —
    // we keep a placeholder rrule only so the on-disk record stays uniform.
    let (interval_value, interval_unit) = if trigger_kind == TRIGGER_MAIL {
        (1, "minutes".to_string())
    } else {
        if input.interval_value == 0 || input.interval_value > 10_000 {
            return Err("scheduled task interval must be between 1 and 10000".to_string());
        }
        (
            input.interval_value,
            normalize_interval_unit(&input.interval_unit)?,
        )
    };
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
        interval_value,
        interval_unit,
        status,
        mail_account_id: input.mail_account_id.unwrap_or_default().trim().to_string(),
        mail_keywords: clean_keywords(input.mail_keywords.unwrap_or_default()),
        trigger_kind,
    })
}

fn normalize_trigger_kind(kind: Option<&str>) -> Result<String, String> {
    match kind.map(str::trim).unwrap_or(TRIGGER_INTERVAL) {
        "" | TRIGGER_INTERVAL => Ok(TRIGGER_INTERVAL.to_string()),
        TRIGGER_MAIL => Ok(TRIGGER_MAIL.to_string()),
        _ => Err("scheduled task trigger must be interval or mail".to_string()),
    }
}

fn clean_keywords(items: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let value = item.trim();
        if !value.is_empty() && !out.iter().any(|existing| existing == value) {
            out.push(value.to_string());
        }
    }
    out
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
        let is_mail = record.trigger_kind == TRIGGER_MAIL;
        let schedule_label = if is_mail {
            mail_schedule_label(&record.mail_keywords)
        } else {
            schedule_label_from_rrule(&record.rrule)
        };
        // Mail tasks have no clock-based "next run"; they fire on arrival.
        let next_run = if is_mail {
            None
        } else {
            next_run_at(&record).map(|value| value.to_string())
        };
        Self {
            id: record.id,
            title: record.name,
            schedule_label,
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
            last_run_at: record.last_run_at.map(|value| value.to_string()),
            last_error: record.last_error,
            next_run,
            trigger_kind: record.trigger_kind,
            mail_account_id: record.mail_account_id,
            mail_keywords: record.mail_keywords,
        }
    }
}

fn mail_schedule_label(keywords: &[String]) -> String {
    if keywords.is_empty() {
        "收到新邮件时".to_string()
    } else {
        format!("收到含「{}」的新邮件时", keywords.join(" / "))
    }
}

fn interval_millis_from_rrule(rrule: &str) -> i64 {
    let (value, unit) = interval_from_rrule(rrule);
    let unit_ms: i64 = match unit.as_str() {
        "hours" => 60 * 60 * 1000,
        "days" => 24 * 60 * 60 * 1000,
        _ => 60 * 1000,
    };
    i64::from(value).saturating_mul(unit_ms)
}

fn next_run_at(record: &ArisScheduledRecord) -> Option<i64> {
    if record.status == STATUS_PAUSED {
        return None;
    }
    let anchor = record.last_run_at.unwrap_or(record.created_at);
    Some(anchor.saturating_add(interval_millis_from_rrule(&record.rrule)))
}

fn due_records(now: i64) -> Vec<ArisScheduledRecord> {
    let Ok(entries) = fs::read_dir(aris_automations_dir()) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| read_record_from_path(&entry.path().join("automation.toml")).ok())
        .filter(|record| {
            record.kind == TASK_KIND
                && record.status == STATUS_ACTIVE
                && record.trigger_kind != TRIGGER_MAIL
                && !record.prompt.trim().is_empty()
                && next_run_at(record).is_some_and(|next| next <= now)
        })
        .collect()
}

fn update_run_state(id: &str, last_run_at: i64, last_error: Option<String>) -> Result<(), String> {
    let mut record = read_record(id)?;
    record.last_run_at = Some(last_run_at);
    record.last_error = last_error;
    record.updated_at = now_millis();
    write_record(&record)
}

pub fn spawn_runner(app: AppHandle) {
    if RUNNER_STARTED.set(()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let now = now_millis();
            for record in due_records(now) {
                let _ = update_run_state(&record.id, now, None);
                let result = crate::engine::run_background_prompt(
                    app.clone(),
                    record.target_thread_id.clone(),
                    record.prompt.clone(),
                )
                .await;
                if let Err(error) = result {
                    let _ = update_run_state(&record.id, now, Some(error));
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(RUNNER_TICK_SECS)).await;
        }
    });
}

/// Minimal, mail-module-agnostic snapshot of the message that triggered a task.
/// Kept primitive so `scheduled` doesn't depend on `mail`'s internal types.
pub struct MailTriggerContext {
    pub account_id: String,
    pub from: String,
    pub from_name: String,
    pub subject: String,
    pub snippet: String,
    pub message_id: String,
}

/// Fire every active `mail`-trigger task that matches an incoming message. Called
/// from the mail event watcher for each new message. Each match runs its prompt
/// (with the email context appended) in its bound chat session.
pub fn on_new_mail(app: AppHandle, ctx: MailTriggerContext) {
    let matches: Vec<ArisScheduledRecord> = mail_trigger_records()
        .into_iter()
        .filter(|record| mail_trigger_matches(record, &ctx))
        .collect();
    if matches.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        for record in matches {
            let now = now_millis();
            let prompt = build_mail_trigger_prompt(&record.prompt, &ctx);
            let _ = update_run_state(&record.id, now, None);
            let result = crate::engine::run_background_prompt(
                app.clone(),
                record.target_thread_id.clone(),
                prompt,
            )
            .await;
            if let Err(error) = result {
                let _ = update_run_state(&record.id, now, Some(error));
            }
        }
    });
}

fn mail_trigger_records() -> Vec<ArisScheduledRecord> {
    let Ok(entries) = fs::read_dir(aris_automations_dir()) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| read_record_from_path(&entry.path().join("automation.toml")).ok())
        .filter(|record| {
            record.kind == TASK_KIND
                && record.status == STATUS_ACTIVE
                && record.trigger_kind == TRIGGER_MAIL
                && !record.prompt.trim().is_empty()
        })
        .collect()
}

fn mail_trigger_matches(record: &ArisScheduledRecord, ctx: &MailTriggerContext) -> bool {
    let wanted_account = record.mail_account_id.trim();
    if !wanted_account.is_empty() && !wanted_account.eq_ignore_ascii_case(ctx.account_id.trim()) {
        return false;
    }
    if record.mail_keywords.is_empty() {
        return true;
    }
    let haystack =
        format!("{} {} {}", ctx.subject, ctx.snippet, ctx.from_name).to_ascii_lowercase();
    record
        .mail_keywords
        .iter()
        .map(|keyword| keyword.trim().to_ascii_lowercase())
        .any(|keyword| !keyword.is_empty() && haystack.contains(&keyword))
}

fn build_mail_trigger_prompt(prompt: &str, ctx: &MailTriggerContext) -> String {
    format!(
        "{prompt}\n\n---\n[触发] 收到一封新邮件，请据此处理：\n- 账户ID: {}\n- 邮件ID: {}\n- 发件人: {} <{}>\n- 主题: {}\n- 摘要: {}",
        ctx.account_id, ctx.message_id, ctx.from_name, ctx.from, ctx.subject, ctx.snippet
    )
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
        last_run_at: None,
        last_error: None,
        trigger_kind: normalized.trigger_kind,
        mail_account_id: normalized.mail_account_id,
        mail_keywords: normalized.mail_keywords,
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
        last_run_at: existing.last_run_at,
        last_error: existing.last_error,
        trigger_kind: normalized.trigger_kind,
        mail_account_id: normalized.mail_account_id,
        mail_keywords: normalized.mail_keywords,
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
        interval_from_rrule, is_safe_identifier, mail_trigger_matches, normalize_status,
        normalize_trigger_kind, rrule_for_interval, schedule_label_from_rrule, ArisScheduledRecord,
        MailTriggerContext, ScheduledTask, STATUS_ACTIVE, STATUS_PAUSED, TRIGGER_MAIL,
    };

    fn mail_record(account: &str, keywords: &[&str]) -> ArisScheduledRecord {
        ArisScheduledRecord {
            version: 1,
            id: "task-mail".to_string(),
            kind: "aris-scheduled-task".to_string(),
            name: "Mail trigger".to_string(),
            prompt: "handle it".to_string(),
            status: STATUS_ACTIVE.to_string(),
            rrule: "FREQ=MINUTELY;INTERVAL=1".to_string(),
            target_thread_id: "chat-1".to_string(),
            created_at: 0,
            updated_at: 0,
            last_run_at: None,
            last_error: None,
            trigger_kind: TRIGGER_MAIL.to_string(),
            mail_account_id: account.to_string(),
            mail_keywords: keywords.iter().map(|k| k.to_string()).collect(),
        }
    }

    fn mail_ctx(account: &str, subject: &str) -> MailTriggerContext {
        MailTriggerContext {
            account_id: account.to_string(),
            from: "client@example.com".to_string(),
            from_name: "Client".to_string(),
            subject: subject.to_string(),
            snippet: String::new(),
            message_id: "m1".to_string(),
        }
    }

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
            last_run_at: None,
            last_error: None,
            trigger_kind: "interval".to_string(),
            mail_account_id: String::new(),
            mail_keywords: Vec::new(),
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
    fn mail_task_reports_event_schedule_and_no_next_run() {
        let task = ScheduledTask::from(mail_record("acct-1", &["文献求助"]));
        assert_eq!(task.trigger_kind, "mail");
        assert_eq!(task.schedule_label, "收到含「文献求助」的新邮件时");
        assert_eq!(task.next_run, None);
    }

    #[test]
    fn mail_trigger_filters_by_account_and_keyword() {
        let record = mail_record("acct-1", &["文献求助"]);
        // Wrong account is skipped.
        assert!(!mail_trigger_matches(
            &record,
            &mail_ctx("acct-2", "文献求助")
        ));
        // Right account, keyword present.
        assert!(mail_trigger_matches(
            &record,
            &mail_ctx("acct-1", "请帮忙 文献求助")
        ));
        // Right account, keyword absent.
        assert!(!mail_trigger_matches(
            &record,
            &mail_ctx("acct-1", "周会改期")
        ));
        // No account filter + no keywords = any new mail on any account.
        let open = mail_record("", &[]);
        assert!(mail_trigger_matches(&open, &mail_ctx("acct-9", "anything")));
    }

    #[test]
    fn trigger_kind_normalizes_or_rejects() {
        assert_eq!(normalize_trigger_kind(None).unwrap(), "interval");
        assert_eq!(normalize_trigger_kind(Some("")).unwrap(), "interval");
        assert_eq!(normalize_trigger_kind(Some("mail")).unwrap(), "mail");
        assert!(normalize_trigger_kind(Some("webhook")).is_err());
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
