//! ARIS-owned scheduled task registry for the Chat-side page.
//!
//! The on-disk shape intentionally mirrors the Codex automation TOML shape, but
//! lives under SomniQ config: `~/.config/SomniQ/automations/<id>/automation.toml`,
//! with the task's delivery records beside it in `deliveries.json`.
//!
//! Semantics are written up in
//! `docs/development-logic/scheduled-task-semantics.md`. In short:
//!
//! - **Rules** ([`rules`]): one-shot, interval, Cron and RRULE, each in an
//!   explicit IANA zone, with one DST rule for wall-clock times.
//! - **Committed occurrence**: every active clock task stores the next
//!   occurrence it owes (`next_occurrence_at`). The runner fires when that is
//!   due and then advances it; edits that do not touch the rule keep it.
//! - **Missed runs**: occurrences that fell due while SomniQ was closed (or
//!   while the previous run held the task) are coalesced into the latest one.
//!   The default policy runs that one late; `skip` drops it unless it is
//!   still within a short grace window. Either way the delivery record says
//!   how many were folded.
//! - **Idempotent dispatch**: every occurrence has a key, the work-task card
//!   carries it, and the card store refuses a second card for a key under its
//!   lock. A restart or a double tick re-derives the same key and finds the
//!   card instead of queuing a twin.
//! - **Delivery vs outcome** ([`ledger`]): the receipt proves the occurrence
//!   was queued; the work task's status and independent review say whether it
//!   finished. The history view joins the two at read time.
//! - **Targets**: a fixed existing conversation, one conversation reserved on
//!   creation and reused, or a new conversation per delivery. All three go
//!   through `queue_scheduled_run` → the work-task engine → independent review.

mod ledger;
mod rules;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::state;
use crate::work_task::commands::{ScheduledRunOutcome, ScheduledRunRequest};
use ledger::DeliveryRecord;
use rules::{IntervalUnit, Schedule};

const TASK_KIND: &str = "aris-scheduled-task";
/// v2 adds explicit rules, zones, the committed occurrence, missed-run policy
/// and target modes. v1 records read as interval tasks in the system zone.
const RECORD_VERSION: u32 = 2;
const STATUS_ACTIVE: &str = "ACTIVE";
const STATUS_PAUSED: &str = "PAUSED";
/// A rule with no occurrence left (a one-shot that fired, an RRULE past its
/// COUNT or UNTIL). Kept, so its history stays readable.
const STATUS_ENDED: &str = "ENDED";
/// Task fires on its calendar rule.
const TRIGGER_SCHEDULE: &str = "schedule";
/// v1 spelling of [`TRIGGER_SCHEDULE`], from when the only rule was an
/// interval. Accepted on input and read from disk.
const TRIGGER_INTERVAL_LEGACY: &str = "interval";
/// Task fires when a new mail arrives (optionally filtered by account/keyword).
const TRIGGER_MAIL: &str = "mail";

/// Run the latest of the occurrences that fell due, once, even if late.
const MISSED_RUN_LATEST: &str = "run_latest";
/// Drop an occurrence that is more than [`SKIP_GRACE_MS`] late.
const MISSED_SKIP: &str = "skip";
/// How late an occurrence may be and still count as on time under `skip`.
/// Several runner ticks, so ordinary tick latency and a busy pump never turn
/// an on-time run into a "missed" one.
const SKIP_GRACE_MS: i64 = 2 * 60_000;
/// A one-shot time up to this far in the past is accepted on save and runs
/// immediately: a minute-granularity picker cannot name "now" any closer.
const ONCE_SAVE_GRACE_MS: i64 = 60_000;

/// Deliver into one existing conversation every time.
const TARGET_SESSION: &str = "session";
/// Reserve a conversation when the task is created; the first delivery
/// creates it and later ones continue it.
const TARGET_NEW_ONCE: &str = "new_once";
/// A fresh conversation for every delivery.
const TARGET_NEW: &str = "new";

const RUNNER_TICK_SECS: u64 = 30;
const UPCOMING_PREVIEW: usize = 5;
const HISTORY_DEFAULT_LIMIT: usize = 50;
static RUNNER_STARTED: OnceLock<()> = OnceLock::new();

/// Serializes every read-modify-write of a task record: the runner advancing
/// an occurrence and the user saving an edit would otherwise each write back
/// the version they read, and one of the two changes would vanish.
static SCHEDULE_LOCK: Mutex<()> = Mutex::new(());

fn schedule_lock() -> MutexGuard<'static, ()> {
    SCHEDULE_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

fn default_trigger_kind() -> String {
    TRIGGER_SCHEDULE.to_string()
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
    /// `active`, `paused`, or `ended`.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub model: String,
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
    /// `once`, `interval`, `cron`, or `rrule`.
    #[serde(default)]
    pub schedule_kind: String,
    #[serde(default)]
    pub time_zone: String,
    /// Wall-clock start in `time_zone` (`YYYY-MM-DDTHH:MM`): the one-shot
    /// time, the first interval run, or the RRULE's DTSTART.
    #[serde(default)]
    pub start_local: Option<String>,
    #[serde(default)]
    pub cron: String,
    /// Normalised `DTSTART…\nRRULE:…`.
    #[serde(default)]
    pub recurrence: String,
    /// Just the RRULE body, for the editor.
    #[serde(default)]
    pub rrule_rule: String,
    /// Upcoming occurrences (epoch ms as strings), committed one first.
    #[serde(default)]
    pub next_occurrences: Vec<String>,
    #[serde(default)]
    pub missed_policy: String,
    #[serde(default)]
    pub target_mode: String,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Why a due occurrence is being held (the previous run is still going).
    #[serde(default)]
    pub waiting_reason: Option<String>,
    /// The rule on disk does not compile (a hand edit, a zone this build
    /// lacks). The task cannot fire until it is saved again.
    #[serde(default)]
    pub schedule_error: Option<String>,
    #[serde(default)]
    pub last_delivery: Option<DeliveryRecord>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct ArisScheduledRecord {
    version: u32,
    id: String,
    kind: String,
    name: String,
    prompt: String,
    status: String,
    /// The v1 interval encoding (`FREQ=MINUTELY;INTERVAL=15`). Written only
    /// for interval rules and mail tasks, which a pre-v2 build reads
    /// correctly. Left out for once/Cron/RRULE on purpose: v1 requires this
    /// field, so a pre-v2 build fails to parse those records and ignores them
    /// — rather than reading a missing interval as "every minute".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    rrule: String,
    /// The `session` target's conversation, or the `new_once` reservation.
    #[serde(default)]
    target_thread_id: String,
    #[serde(default)]
    model: String,
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
    // ── v2 ───────────────────────────────────────────────────────────────
    /// Empty on v1 records, which are interval rules.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    schedule_kind: String,
    /// Empty on v1 records, which are read in the system zone.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    time_zone: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    start_local: String,
    /// Instant of the first occurrence (one-shot time, interval grid origin).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    anchor_at: Option<i64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    cron: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    recurrence: String,
    /// The occurrence this task owes next. Advanced only when an occurrence is
    /// delivered, skipped or recorded as failed — never by a busy deferral.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next_occurrence_at: Option<i64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    missed_policy: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    target_mode: String,
    /// Where `new_once` / `new` targets run. A `session` target follows its
    /// conversation's project and uses this only as a fallback.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    waiting_reason: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskInput {
    #[serde(default)]
    title: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    interval_value: u32,
    #[serde(default)]
    interval_unit: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    trigger_kind: Option<String>,
    #[serde(default)]
    mail_account_id: Option<String>,
    #[serde(default)]
    mail_keywords: Option<Vec<String>>,
    #[serde(default)]
    schedule_kind: Option<String>,
    #[serde(default)]
    time_zone: Option<String>,
    #[serde(default)]
    start_local: Option<String>,
    #[serde(default)]
    cron: Option<String>,
    #[serde(default)]
    rrule: Option<String>,
    #[serde(default)]
    missed_policy: Option<String>,
    #[serde(default)]
    target_mode: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
}

/// The rule half of a task, normalised. Two of these being equal is what
/// "the edit did not touch the schedule" means.
#[derive(Clone, PartialEq, Eq, Debug)]
struct NormalizedTiming {
    schedule_kind: String,
    time_zone: String,
    start_local: String,
    anchor_at: Option<i64>,
    rrule: String,
    cron: String,
    recurrence: String,
}

struct NormalizedTaskInput {
    title: String,
    prompt: String,
    model: String,
    status: String,
    trigger_kind: String,
    mail_account_id: String,
    mail_keywords: Vec<String>,
    timing: NormalizedTiming,
    missed_policy: String,
    target_mode: String,
    target_thread_id: String,
    project_id: String,
}

fn legacy_store_path() -> PathBuf {
    state::config_dir().join("scheduled-tasks.json")
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

fn all_records() -> Vec<ArisScheduledRecord> {
    let Ok(entries) = fs::read_dir(aris_automations_dir()) else {
        return Vec::new();
    };
    let mut records = entries
        .filter_map(Result::ok)
        .filter_map(|entry| read_record_from_path(&entry.path().join("automation.toml")).ok())
        .filter(|record| record.kind == TASK_KIND && validate_task_id(&record.id).is_ok())
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.id.cmp(&right.id));
    records
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
    let text = toml::to_string_pretty(record).map_err(|error| error.to_string())?;
    runtime::write_file_atomically(&path, text.as_bytes()).map_err(|error| error.to_string())
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

// ── Rules on records ─────────────────────────────────────────────────────────

fn is_mail(record: &ArisScheduledRecord) -> bool {
    record.trigger_kind == TRIGGER_MAIL
}

fn rule_kind(record: &ArisScheduledRecord) -> &str {
    if record.schedule_kind.is_empty() {
        rules::RULE_INTERVAL
    } else {
        &record.schedule_kind
    }
}

fn record_zone(record: &ArisScheduledRecord) -> chrono_tz::Tz {
    rules::parse_time_zone(&record.time_zone).unwrap_or_else(|_| rules::system_time_zone())
}

fn interval_step_ms(value: u32, unit: &str) -> i64 {
    let unit_ms: i64 = match unit {
        "hours" => 60 * 60 * 1000,
        "days" => 24 * 60 * 60 * 1000,
        _ => 60 * 1000,
    };
    i64::from(value.max(1)).saturating_mul(unit_ms)
}

/// Where a v1 record's interval grid starts: one step after its last run (or
/// creation), which is exactly when v1 would have fired it next.
fn legacy_anchor(record: &ArisScheduledRecord) -> i64 {
    let (value, unit) = interval_from_rrule(&record.rrule);
    record
        .last_run_at
        .unwrap_or(record.created_at)
        .saturating_add(interval_step_ms(value, &unit))
}

fn record_schedule(record: &ArisScheduledRecord) -> Result<Schedule, String> {
    let tz = record_zone(record);
    let start_local = if record.start_local.is_empty() {
        None
    } else {
        Some(rules::parse_local(&record.start_local)?)
    };
    match rule_kind(record) {
        rules::RULE_ONCE => {
            let at = match (record.anchor_at, start_local) {
                (Some(at), _) => at,
                (None, Some(local)) => rules::resolve_local(tz, local).timestamp_millis(),
                (None, None) => return Err("this one-shot task has no time".to_string()),
            };
            Ok(Schedule::once(tz, at))
        }
        rules::RULE_INTERVAL => {
            let (value, unit) = interval_from_rrule(&record.rrule);
            let anchor = record.anchor_at.unwrap_or_else(|| legacy_anchor(record));
            Schedule::interval(tz, value, IntervalUnit::parse(&unit)?, anchor, start_local)
        }
        rules::RULE_CRON => Schedule::cron(tz, &record.cron),
        rules::RULE_RRULE => {
            let start = start_local.unwrap_or_else(|| rules::local_at(tz, record.created_at));
            Schedule::rrule(tz, &record.recurrence, start).map(|(schedule, _)| schedule)
        }
        other => Err(format!("unknown schedule kind '{other}'")),
    }
}

/// The occurrence a v1 record (no committed occurrence yet) owes: what v1
/// would have fired next.
fn uncommitted_next(record: &ArisScheduledRecord, schedule: &Schedule) -> Option<i64> {
    if record.schedule_kind.is_empty() {
        schedule.next_after(legacy_anchor(record).saturating_sub(1))
    } else {
        schedule.next_after(record.last_run_at.unwrap_or(record.created_at))
    }
}

/// Identity of one occurrence of one task. Stable across restarts because
/// it is derived from the rule, not from when the runner noticed it.
fn occurrence_key(task_id: &str, occurrence_at: i64) -> String {
    format!("{task_id}:at:{occurrence_at}")
}

/// A `new` target's conversation for one delivery. Derived from the
/// occurrence key, so a delivery retried after a crash lands in the same
/// conversation instead of opening a second one.
fn per_delivery_session_id(task_id: &str, key: &str) -> String {
    format!("sched-{task_id}-{:016x}", fnv1a64(key.as_bytes()))
}

/// A `new_once` target's reserved conversation.
fn reserved_session_id(task_id: &str) -> String {
    format!("sched-{task_id}")
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

// ── Input normalisation ──────────────────────────────────────────────────────

fn normalize_input(
    input: ScheduledTaskInput,
    existing: Option<&ArisScheduledRecord>,
    task_id: &str,
    now: i64,
    host: &HostLookups<'_>,
) -> Result<NormalizedTaskInput, String> {
    let title = input.title.trim().to_string();
    let prompt = input.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("scheduled task prompt is required".to_string());
    }
    let model = input.model.clone().unwrap_or_default().trim().to_string();
    if !model.is_empty() && crate::config::executor_object_for_model(&model)?.is_none() {
        return Err(
            "scheduled task model must be current, managed, built-in, or verified in Settings"
                .to_string(),
        );
    }
    let trigger_kind = normalize_trigger_kind(input.trigger_kind.as_deref())?;
    let timing = normalize_timing(&input, &trigger_kind, now)?;
    // An ended task saved without a status asks for its rule to run again;
    // `ENDED` itself is never an input.
    let fallback_status = existing.map(|record| {
        if record.status == STATUS_ENDED {
            STATUS_ACTIVE
        } else {
            record.status.as_str()
        }
    });
    let status = input
        .status
        .as_deref()
        .or(fallback_status)
        .map(normalize_status)
        .transpose()?
        .unwrap_or_else(|| STATUS_ACTIVE.to_string());
    let missed_policy = normalize_missed_policy(input.missed_policy.as_deref())?;
    let (target_mode, target_thread_id, project_id) =
        normalize_target(&input, task_id, host)?;

    Ok(NormalizedTaskInput {
        title: if title.is_empty() {
            first_prompt_line(&prompt).unwrap_or_else(|| "Scheduled task".to_string())
        } else {
            title
        },
        prompt,
        model,
        status,
        mail_account_id: input.mail_account_id.unwrap_or_default().trim().to_string(),
        mail_keywords: clean_keywords(input.mail_keywords.unwrap_or_default()),
        trigger_kind,
        timing,
        missed_policy,
        target_mode,
        target_thread_id,
        project_id,
    })
}

/// Normalise the rule half of an input and compile it once to prove it works.
fn normalize_timing(
    input: &ScheduledTaskInput,
    trigger_kind: &str,
    now: i64,
) -> Result<NormalizedTiming, String> {
    let tz = match input.time_zone.as_deref().map(str::trim) {
        Some(zone) if !zone.is_empty() => rules::parse_time_zone(zone)?,
        _ => rules::system_time_zone(),
    };
    let start_local = input
        .start_local
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(rules::parse_local)
        .transpose()?;
    let mut timing = NormalizedTiming {
        schedule_kind: String::new(),
        time_zone: tz.name().to_string(),
        start_local: String::new(),
        anchor_at: None,
        rrule: String::new(),
        cron: String::new(),
        recurrence: String::new(),
    };
    if trigger_kind == TRIGGER_MAIL {
        // Mail tasks don't run on a clock; the placeholder keeps the record
        // readable by a v1 build, which requires the field.
        timing.rrule = rrule_for_interval(1, "minutes");
        return Ok(timing);
    }
    let kind = input
        .schedule_kind
        .as_deref()
        .map(str::trim)
        .filter(|kind| !kind.is_empty())
        .unwrap_or(rules::RULE_INTERVAL);
    match kind {
        rules::RULE_ONCE => {
            let local = start_local
                .ok_or_else(|| "a one-shot task needs a date and time".to_string())?;
            timing.schedule_kind = rules::RULE_ONCE.to_string();
            timing.start_local = rules::format_local(local);
            timing.anchor_at = Some(rules::resolve_local(tz, local).timestamp_millis());
        }
        rules::RULE_INTERVAL => {
            if input.interval_value == 0 || input.interval_value > 10_000 {
                return Err("scheduled task interval must be between 1 and 10000".to_string());
            }
            let unit = IntervalUnit::parse(&input.interval_unit)?;
            // Without a start, the first run is one interval from now — what
            // the interval-only editor always did. The derived start is
            // stored, so later edits keep the same grid.
            let local = start_local.unwrap_or_else(|| {
                rules::local_at(
                    tz,
                    now.saturating_add(interval_step_ms(input.interval_value, unit.as_str())),
                )
            });
            let schedule = Schedule::interval(
                tz,
                input.interval_value,
                unit,
                rules::resolve_local(tz, local).timestamp_millis(),
                Some(local),
            )?;
            timing.schedule_kind = rules::RULE_INTERVAL.to_string();
            timing.start_local = rules::format_local(local);
            timing.anchor_at = schedule.next_after(i64::MIN / 2);
            timing.rrule = rrule_for_interval(input.interval_value, unit.as_str());
        }
        rules::RULE_CRON => {
            let expression = input.cron.as_deref().unwrap_or_default().trim().to_string();
            Schedule::cron(tz, &expression)?;
            timing.schedule_kind = rules::RULE_CRON.to_string();
            timing.cron = expression.split_whitespace().collect::<Vec<_>>().join(" ");
        }
        rules::RULE_RRULE => {
            let start = start_local.unwrap_or_else(|| rules::local_at(tz, now));
            let (schedule, normalized) =
                Schedule::rrule(tz, input.rrule.as_deref().unwrap_or_default(), start)?;
            // A DTSTART with its own TZID wins: the zone is part of the rule.
            timing.time_zone = schedule.time_zone().name().to_string();
            timing.schedule_kind = rules::RULE_RRULE.to_string();
            timing.start_local = dtstart_local(&normalized).unwrap_or_else(|| rules::format_local(start));
            timing.recurrence = normalized;
        }
        other => {
            return Err(format!(
                "scheduled task rule must be once, interval, cron, or rrule (got '{other}')"
            ))
        }
    }
    Ok(timing)
}

/// The wall-clock DTSTART of normalised RRULE text, as `YYYY-MM-DDTHH:MM`.
fn dtstart_local(normalized: &str) -> Option<String> {
    let first = normalized.lines().next()?;
    let (_, value) = first.split_once(':')?;
    let value = value.trim().trim_end_matches(['Z', 'z']);
    chrono::NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S")
        .ok()
        .map(rules::format_local)
}

fn timing_of(record: &ArisScheduledRecord) -> NormalizedTiming {
    NormalizedTiming {
        schedule_kind: record.schedule_kind.clone(),
        time_zone: record.time_zone.clone(),
        start_local: record.start_local.clone(),
        anchor_at: record.anchor_at,
        rrule: record.rrule.clone(),
        cron: record.cron.clone(),
        recurrence: record.recurrence.clone(),
    }
}

fn apply_timing(record: &mut ArisScheduledRecord, timing: NormalizedTiming) {
    record.schedule_kind = timing.schedule_kind;
    record.time_zone = timing.time_zone;
    record.start_local = timing.start_local;
    record.anchor_at = timing.anchor_at;
    record.rrule = timing.rrule;
    record.cron = timing.cron;
    record.recurrence = timing.recurrence;
}

/// Lookups the target rules need, separated so tests can stand in for the
/// project registry and the Chat UI index.
struct HostLookups<'a> {
    project_path: &'a dyn Fn(&str) -> Option<PathBuf>,
    session_project: &'a dyn Fn(&str) -> Option<String>,
}

fn registered_project_path(project_id: &str) -> Option<PathBuf> {
    crate::projects::project_path_for_registered_id(project_id)
}

fn chat_session_project(session_id: &str) -> Option<String> {
    crate::sessions::chat_ui_session_project(session_id)
}

fn host_lookups() -> HostLookups<'static> {
    HostLookups {
        project_path: &registered_project_path,
        session_project: &chat_session_project,
    }
}

fn normalize_target(
    input: &ScheduledTaskInput,
    task_id: &str,
    host: &HostLookups<'_>,
) -> Result<(String, String, String), String> {
    let session_id = input.session_id.trim().to_string();
    let requested_project = input
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let mode = match input.target_mode.as_deref().map(str::trim) {
        Some("") | None if !session_id.is_empty() => TARGET_SESSION,
        Some("") | None => TARGET_NEW_ONCE,
        Some(TARGET_SESSION) => TARGET_SESSION,
        Some(TARGET_NEW_ONCE) => TARGET_NEW_ONCE,
        Some(TARGET_NEW) => TARGET_NEW,
        Some(other) => {
            return Err(format!(
                "scheduled task target must be session, new_once, or new (got '{other}')"
            ))
        }
    };
    if mode == TARGET_SESSION {
        if !is_safe_identifier(&session_id) {
            return Err("scheduled task must be bound to a valid chat session".to_string());
        }
        let project = (host.session_project)(&session_id);
        if project.is_none() && !runtime_session_exists(&session_id) {
            return Err("scheduled task must be bound to an existing chat session".to_string());
        }
        let project_id = project
            .or(requested_project)
            .unwrap_or_else(|| "default".to_string());
        return Ok((mode.to_string(), session_id, project_id));
    }
    let project_id = requested_project.ok_or_else(|| {
        "a scheduled task that opens its own conversation needs a project".to_string()
    })?;
    if !state::valid_project_id(&project_id) || (host.project_path)(&project_id).is_none() {
        return Err(format!(
            "project '{project_id}' is not in SomniQ's project list, so there is nowhere to run this task"
        ));
    }
    let target_thread_id = if mode == TARGET_NEW_ONCE {
        reserved_session_id(task_id)
    } else {
        String::new()
    };
    Ok((mode.to_string(), target_thread_id, project_id))
}

/// A runtime (model-side) session file for this id in any project, for chats
/// that never got a Chat UI projection.
fn runtime_session_exists(session_id: &str) -> bool {
    state::sessions_dir()
        .join(format!("{session_id}.json"))
        .is_file()
}

fn normalize_trigger_kind(kind: Option<&str>) -> Result<String, String> {
    match kind.map(str::trim).unwrap_or(TRIGGER_SCHEDULE) {
        "" | TRIGGER_SCHEDULE | TRIGGER_INTERVAL_LEGACY => Ok(TRIGGER_SCHEDULE.to_string()),
        TRIGGER_MAIL => Ok(TRIGGER_MAIL.to_string()),
        _ => Err("scheduled task trigger must be schedule or mail".to_string()),
    }
}

fn normalize_missed_policy(policy: Option<&str>) -> Result<String, String> {
    match policy.map(str::trim).unwrap_or("") {
        "" | MISSED_RUN_LATEST => Ok(MISSED_RUN_LATEST.to_string()),
        MISSED_SKIP => Ok(MISSED_SKIP.to_string()),
        other => Err(format!(
            "missed-run policy must be run_latest or skip (got '{other}')"
        )),
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
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    if seq == 0 {
        format!("task-{}-{}", now_millis(), std::process::id())
    } else {
        format!("task-{}-{}-{seq}", now_millis(), std::process::id())
    }
}

fn non_empty_model(model: &str) -> Option<String> {
    let value = model.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
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

// ── Views ────────────────────────────────────────────────────────────────────

fn schedule_label(record: &ArisScheduledRecord) -> String {
    if is_mail(record) {
        return mail_schedule_label(&record.mail_keywords);
    }
    let zone = record_zone(record).name().to_string();
    match rule_kind(record) {
        rules::RULE_ONCE => format!("一次 · {} · {zone}", record.start_local.replace('T', " ")),
        rules::RULE_CRON => format!("Cron {} · {zone}", record.cron),
        rules::RULE_RRULE => format!("RRULE {} · {zone}", rrule_body(&record.recurrence)),
        _ => schedule_label_from_rrule(&record.rrule),
    }
}

fn rrule_body(recurrence: &str) -> String {
    recurrence
        .lines()
        .find_map(|line| line.strip_prefix("RRULE:"))
        .unwrap_or_default()
        .to_string()
}

fn status_view(status: &str) -> &'static str {
    match status {
        STATUS_PAUSED => "paused",
        STATUS_ENDED => "ended",
        _ => "active",
    }
}

/// The task as the page shows it, at `now`.
fn task_view(record: ArisScheduledRecord, now: i64) -> ScheduledTask {
    let mail = is_mail(&record);
    let kind = rule_kind(&record).to_string();
    let zone = record_zone(&record);
    let (interval_value, interval_unit) = if kind == rules::RULE_INTERVAL && !mail {
        interval_from_rrule(&record.rrule)
    } else {
        (15, "minutes".to_string())
    };
    let compiled = if mail { None } else { Some(record_schedule(&record)) };
    let mut next_occurrences = Vec::new();
    let mut schedule_error = None;
    let mut start_local = (!record.start_local.is_empty()).then(|| record.start_local.clone());
    if let Some(compiled) = compiled {
        match compiled {
            Ok(schedule) => {
                if start_local.is_none() {
                    // v1 interval: show where its grid starts.
                    start_local = Some(rules::format_local(rules::local_at(
                        zone,
                        legacy_anchor(&record),
                    )));
                }
                let first = match record.status.as_str() {
                    STATUS_ACTIVE => record
                        .next_occurrence_at
                        .or_else(|| uncommitted_next(&record, &schedule)),
                    // What a resume would pick: the next future occurrence.
                    STATUS_PAUSED => schedule.next_after(now),
                    _ => None,
                };
                if let Some(first) = first {
                    next_occurrences.push(first.to_string());
                    next_occurrences.extend(
                        schedule
                            .upcoming(first, UPCOMING_PREVIEW - 1)
                            .into_iter()
                            .map(|at| at.to_string()),
                    );
                }
            }
            Err(error) => schedule_error = Some(error),
        }
    }
    let next_run = if record.status == STATUS_ACTIVE {
        next_occurrences.first().cloned()
    } else {
        None
    };
    let schedule_label = schedule_label(&record);
    let target_mode = if record.target_mode.is_empty() {
        TARGET_SESSION.to_string()
    } else {
        record.target_mode.clone()
    };
    let session_id = (!record.target_thread_id.is_empty()).then(|| record.target_thread_id.clone());
    ScheduledTask {
        schedule_label,
        status: status_view(&record.status).to_string(),
        session_id,
        model: record.model,
        prompt: record.prompt,
        rrule: if kind == rules::RULE_RRULE {
            record.recurrence.clone()
        } else {
            record.rrule
        },
        interval_value,
        interval_unit,
        created_at: Some(record.created_at.to_string()),
        updated_at: Some(record.updated_at.to_string()),
        last_run_at: record.last_run_at.map(|value| value.to_string()),
        last_error: record.last_error,
        next_run,
        trigger_kind: if mail {
            TRIGGER_MAIL.to_string()
        } else {
            TRIGGER_SCHEDULE.to_string()
        },
        mail_account_id: record.mail_account_id,
        mail_keywords: record.mail_keywords,
        schedule_kind: kind,
        time_zone: zone.name().to_string(),
        start_local,
        cron: record.cron,
        rrule_rule: rrule_body(&record.recurrence),
        recurrence: record.recurrence,
        next_occurrences,
        missed_policy: if record.missed_policy.is_empty() {
            MISSED_RUN_LATEST.to_string()
        } else {
            record.missed_policy
        },
        target_mode,
        project_id: (!record.project_id.is_empty()).then_some(record.project_id),
        waiting_reason: record.waiting_reason,
        schedule_error,
        last_delivery: None,
        id: record.id,
        title: record.name,
    }
}

impl From<ArisScheduledRecord> for ScheduledTask {
    fn from(record: ArisScheduledRecord) -> Self {
        task_view(record, now_millis())
    }
}

fn task_view_with_delivery(record: ArisScheduledRecord, now: i64) -> ScheduledTask {
    let last = task_dir(&record.id)
        .ok()
        .and_then(|dir| ledger::read(&dir).records.into_iter().last());
    let mut view = task_view(record, now);
    view.last_delivery = last;
    view
}

fn mail_schedule_label(keywords: &[String]) -> String {
    if keywords.is_empty() {
        "收到新邮件时".to_string()
    } else {
        format!("收到含「{}」的新邮件时", keywords.join(" / "))
    }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/// One occurrence about to be handed over.
struct Occurrence {
    key: String,
    trigger: &'static str,
    at: i64,
    coalesced: u32,
    first_missed_at: Option<i64>,
    prompt: String,
}

/// What [`deliver`] did.
enum Delivery {
    /// The ledger already has this occurrence; nothing was queued.
    AlreadyRecorded,
    /// Queued (or found queued). The project's engine wants a pump.
    Queued {
        project_id: String,
        project_path: PathBuf,
    },
    /// The previous run still holds the task or its conversation.
    Busy(String),
    /// Could not be handed over; a failed receipt was written.
    Failed(DeliveryRecord),
}

/// The project a task runs in: its conversation's for a `session` target, its
/// own for the others.
fn resolve_project_id(record: &ArisScheduledRecord, host: &HostLookups<'_>) -> String {
    let own = (!record.project_id.trim().is_empty()).then(|| record.project_id.trim().to_string());
    if record.target_mode.is_empty() || record.target_mode == TARGET_SESSION {
        (host.session_project)(&record.target_thread_id)
            .or(own)
            .unwrap_or_else(|| "default".to_string())
    } else {
        own.unwrap_or_else(|| "default".to_string())
    }
}

fn target_session_for(record: &ArisScheduledRecord, key: &str) -> Option<String> {
    match record.target_mode.as_str() {
        TARGET_NEW => Some(per_delivery_session_id(&record.id, key)),
        TARGET_NEW_ONCE => Some(if record.target_thread_id.is_empty() {
            reserved_session_id(&record.id)
        } else {
            record.target_thread_id.clone()
        }),
        _ => (!record.target_thread_id.is_empty()).then(|| record.target_thread_id.clone()),
    }
}

/// Hand one occurrence to the work-task queue and record what happened.
///
/// The order of the writes is the idempotency protocol:
///
/// 1. The ledger is checked: a receipt for this key means it was handled.
/// 2. The card is inserted *with the key*, atomically with the lookup that
///    refuses a second card for the same key.
/// 3. The receipt is appended.
/// 4. (caller) The committed occurrence is advanced.
///
/// A crash after 2 leaves a card and no receipt: the retry finds the card
/// (`AlreadyQueued`) and writes the receipt, marked `recovered`. A crash after
/// 3 leaves a receipt and an un-advanced occurrence: the retry stops at 1.
/// Either way one occurrence produces at most one card.
fn deliver(
    host: &HostLookups<'_>,
    record: &ArisScheduledRecord,
    occurrence: Occurrence,
    now: i64,
) -> Result<Delivery, String> {
    let dir = task_dir(&record.id)?;
    if ledger::find(&dir, &occurrence.key).is_some() {
        return Ok(Delivery::AlreadyRecorded);
    }
    let project_id = resolve_project_id(record, host);
    let target_session_id = target_session_for(record, &occurrence.key);
    let receipt = |status: &str, work_task_id: Option<String>, error: Option<String>| {
        DeliveryRecord {
            key: occurrence.key.clone(),
            trigger: occurrence.trigger.to_string(),
            occurrence_at: occurrence.at,
            coalesced: occurrence.coalesced,
            first_missed_at: occurrence.first_missed_at,
            status: status.to_string(),
            recorded_at: now,
            project_id: Some(project_id.clone()),
            work_task_id,
            target_session_id: target_session_id.clone(),
            error,
            recovered: false,
        }
    };
    let Some(project_path) = (host.project_path)(&project_id) else {
        let error = format!(
            "this automation runs in project '{project_id}', which is not in SomniQ's project \
             list any more, so there is nowhere to run it"
        );
        let failed = ledger::append(&dir, receipt(ledger::DELIVERY_FAILED, None, Some(error)))?;
        return Ok(Delivery::Failed(failed));
    };
    let title = if record.name.trim().is_empty() {
        "Scheduled task".to_string()
    } else {
        record.name.trim().to_string()
    };
    let outcome = crate::work_task::commands::queue_scheduled_run(
        &project_id,
        &project_path,
        ScheduledRunRequest {
            scheduled_task_id: record.id.clone(),
            occurrence_key: occurrence.key.clone(),
            title,
            prompt: occurrence.prompt.clone(),
            model: non_empty_model(&record.model),
            target_session_id: target_session_id.clone(),
        },
    );
    match outcome {
        Ok(ScheduledRunOutcome::Queued(task)) => {
            ledger::append(&dir, receipt(ledger::DELIVERY_QUEUED, Some(task.id), None))?;
            Ok(Delivery::Queued {
                project_id,
                project_path,
            })
        }
        Ok(ScheduledRunOutcome::AlreadyQueued(task)) => {
            let mut recovered = receipt(ledger::DELIVERY_QUEUED, Some(task.id), None);
            recovered.recovered = true;
            ledger::append(&dir, recovered)?;
            Ok(Delivery::Queued {
                project_id,
                project_path,
            })
        }
        Ok(ScheduledRunOutcome::Busy { task_id, status }) => Ok(Delivery::Busy(format!(
            "waiting for work task {task_id} ({}) to finish before the next run",
            status.as_str()
        ))),
        Err(error) => {
            let failed =
                ledger::append(&dir, receipt(ledger::DELIVERY_FAILED, None, Some(error)))?;
            Ok(Delivery::Failed(failed))
        }
    }
}

/// Move the committed occurrence past `latest`; end the task when the rule
/// has nothing after it.
fn advance(record: &mut ArisScheduledRecord, schedule: &Schedule, latest: i64, now: i64) {
    let next = schedule
        .next_after(latest)
        .filter(|next| *next > now)
        .or_else(|| schedule.next_after(now));
    match next {
        Some(next) => record.next_occurrence_at = Some(next),
        None => {
            record.next_occurrence_at = None;
            record.status = STATUS_ENDED.to_string();
        }
    }
    record.waiting_reason = None;
    record.updated_at = now;
}

/// Handle one clock task at `now`. Returns the project to pump when a card
/// was queued.
fn process_due(
    host: &HostLookups<'_>,
    id: &str,
    now: i64,
) -> Result<Option<(String, PathBuf)>, String> {
    let _guard = schedule_lock();
    let mut record = read_record(id)?;
    if record.kind != TASK_KIND
        || record.status != STATUS_ACTIVE
        || is_mail(&record)
        || record.prompt.trim().is_empty()
    {
        return Ok(None);
    }
    let schedule = match record_schedule(&record) {
        Ok(schedule) => schedule,
        Err(error) => {
            if record.last_error.as_deref() != Some(error.as_str()) {
                record.last_error = Some(error);
                write_record(&record)?;
            }
            return Ok(None);
        }
    };
    let next = match record.next_occurrence_at {
        Some(next) => next,
        None => match uncommitted_next(&record, &schedule) {
            Some(next) => {
                record.next_occurrence_at = Some(next);
                write_record(&record)?;
                next
            }
            None => {
                record.status = STATUS_ENDED.to_string();
                record.updated_at = now;
                write_record(&record)?;
                return Ok(None);
            }
        },
    };
    if next > now {
        return Ok(None);
    }
    let Some(window) = schedule.due_window(next, now) else {
        // The committed occurrence is not one the rule produces any more (a
        // hand edit). Re-commit from now rather than firing something the
        // rule never asked for.
        advance(&mut record, &schedule, now, now);
        write_record(&record)?;
        return Ok(None);
    };
    let coalesced = window.count.saturating_sub(1);
    let first_missed_at = (coalesced > 0).then_some(window.earliest);
    let key = occurrence_key(&record.id, window.latest);
    let skip = record.missed_policy == MISSED_SKIP && now - window.latest > SKIP_GRACE_MS;
    if skip {
        let dir = task_dir(&record.id)?;
        ledger::append(
            &dir,
            DeliveryRecord {
                key,
                trigger: ledger::TRIGGER_SCHEDULE.to_string(),
                occurrence_at: window.latest,
                coalesced,
                first_missed_at,
                status: ledger::DELIVERY_MISSED.to_string(),
                recorded_at: now,
                project_id: None,
                work_task_id: None,
                target_session_id: None,
                error: Some(format!(
                    "{} occurrence(s) were missed while SomniQ was not running; the skip-missed \
                     policy drops late runs",
                    window.count
                )),
                recovered: false,
            },
        )?;
        advance(&mut record, &schedule, window.latest, now);
        write_record(&record)?;
        return Ok(None);
    }
    let occurrence = Occurrence {
        key,
        trigger: ledger::TRIGGER_SCHEDULE,
        at: window.latest,
        coalesced,
        first_missed_at,
        prompt: record.prompt.clone(),
    };
    match deliver(host, &record, occurrence, now)? {
        Delivery::Busy(reason) => {
            // Not consumed: the occurrence stays owed and is re-evaluated on
            // the next tick, folding in whatever falls due meanwhile.
            if record.waiting_reason.as_deref() != Some(reason.as_str()) {
                record.waiting_reason = Some(reason);
                write_record(&record)?;
            }
            Ok(None)
        }
        Delivery::AlreadyRecorded => {
            advance(&mut record, &schedule, window.latest, now);
            write_record(&record)?;
            Ok(None)
        }
        Delivery::Queued {
            project_id,
            project_path,
        } => {
            record.last_run_at = Some(now);
            record.last_error = None;
            advance(&mut record, &schedule, window.latest, now);
            write_record(&record)?;
            Ok(Some((project_id, project_path)))
        }
        Delivery::Failed(receipt) => {
            // Consumed, with the reason on record: retrying a missing project
            // every tick would bury the history in identical failures.
            record.last_error = receipt.error;
            advance(&mut record, &schedule, window.latest, now);
            write_record(&record)?;
            Ok(None)
        }
    }
}

/// One runner pass over every clock task. Returns the projects whose engine
/// should be pumped, and the soonest occurrence still owed (for the sleep).
fn run_due(host: &HostLookups<'_>, now: i64) -> (Vec<(String, PathBuf)>, Option<i64>) {
    let mut pumps: Vec<(String, PathBuf)> = Vec::new();
    for record in all_records() {
        match process_due(host, &record.id, now) {
            Ok(Some(project)) => {
                if !pumps.iter().any(|(id, _)| *id == project.0) {
                    pumps.push(project);
                }
            }
            Ok(None) => {}
            Err(error) => {
                eprintln!("scheduled task {}: {error}", record.id);
            }
        }
    }
    // Only future occurrences can shorten the sleep. One that is due and was
    // not advanced (held, unreadable rule, a write that failed) is retried on
    // the ordinary tick rather than spinning the loop once a second.
    let soonest = all_records()
        .into_iter()
        .filter(|record| record.status == STATUS_ACTIVE && !is_mail(record))
        .filter_map(|record| record.next_occurrence_at)
        .filter(|at| *at > now)
        .min();
    (pumps, soonest)
}

async fn pump_projects(app: &AppHandle, projects: Vec<(String, PathBuf)>) {
    for (project_id, project_path) in projects {
        // Straight to the pump so a task due now starts now rather than at
        // the work-task engine's own next sweep, up to a tick away.
        crate::work_task::engine::pump(app.clone(), project_id.clone(), project_path).await;
        crate::work_task::engine::emit_changed(app, &project_id);
    }
}

fn emit_tasks_changed(app: &AppHandle) {
    let _ = app.emit("scheduled-tasks-changed", ());
}

pub fn spawn_runner(app: AppHandle) {
    if RUNNER_STARTED.set(()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let now = now_millis();
            let (pumps, soonest) = run_due(&host_lookups(), now);
            if !pumps.is_empty() {
                pump_projects(&app, pumps).await;
                emit_tasks_changed(&app);
            }
            // Wake for the next owed occurrence when it is sooner than a
            // tick, so a 09:00 rule fires at 09:00 and not up to 30 s later.
            let tick_ms = (RUNNER_TICK_SECS * 1000) as i64;
            let wait_ms = soonest
                .map(|at| (at - now_millis()).clamp(1_000, tick_ms))
                .unwrap_or(tick_ms);
            tokio::time::sleep(std::time::Duration::from_millis(wait_ms as u64)).await;
        }
    });
}

// ── Mail trigger ─────────────────────────────────────────────────────────────

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
/// from the mail event watcher for each new message. Each match goes through
/// the same dispatch as a clock occurrence, keyed by the message, so the same
/// mail announced twice (a watcher restart) queues one run.
pub fn on_new_mail(app: AppHandle, ctx: MailTriggerContext) {
    let matches: Vec<ArisScheduledRecord> = all_records()
        .into_iter()
        .filter(|record| {
            record.status == STATUS_ACTIVE && is_mail(record) && !record.prompt.trim().is_empty()
        })
        .filter(|record| mail_trigger_matches(record, &ctx))
        .collect();
    if matches.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut pumps = Vec::new();
        for record in matches {
            if let Ok(Some(project)) = deliver_mail(&host_lookups(), &record.id, &ctx, now_millis())
            {
                pumps.push(project);
            }
        }
        pump_projects(&app, pumps).await;
        emit_tasks_changed(&app);
    });
}

fn mail_occurrence_key(task_id: &str, ctx: &MailTriggerContext) -> String {
    let identity = format!("{}\u{1f}{}", ctx.account_id.trim(), ctx.message_id.trim());
    format!("{task_id}:mail:{:016x}", fnv1a64(identity.as_bytes()))
}

fn deliver_mail(
    host: &HostLookups<'_>,
    id: &str,
    ctx: &MailTriggerContext,
    now: i64,
) -> Result<Option<(String, PathBuf)>, String> {
    let _guard = schedule_lock();
    let mut record = read_record(id)?;
    let occurrence = Occurrence {
        key: mail_occurrence_key(id, ctx),
        trigger: ledger::TRIGGER_MAIL,
        at: now,
        coalesced: 0,
        first_missed_at: None,
        prompt: build_mail_trigger_prompt(&record.prompt, ctx),
    };
    let key = occurrence.key.clone();
    match deliver(host, &record, occurrence, now)? {
        Delivery::AlreadyRecorded => Ok(None),
        Delivery::Queued {
            project_id,
            project_path,
        } => {
            record.last_run_at = Some(now);
            record.last_error = None;
            record.updated_at = now;
            write_record(&record)?;
            Ok(Some((project_id, project_path)))
        }
        Delivery::Busy(reason) => {
            // An event has no later occurrence to defer to: record it as
            // skipped so the mail is visibly not handled, not silently lost.
            ledger::append(
                &task_dir(id)?,
                DeliveryRecord {
                    key,
                    trigger: ledger::TRIGGER_MAIL.to_string(),
                    occurrence_at: now,
                    coalesced: 0,
                    first_missed_at: None,
                    status: ledger::DELIVERY_SKIPPED.to_string(),
                    recorded_at: now,
                    project_id: None,
                    work_task_id: None,
                    target_session_id: None,
                    error: Some(reason),
                    recovered: false,
                },
            )?;
            Ok(None)
        }
        Delivery::Failed(receipt) => {
            record.last_error = receipt.error;
            record.updated_at = now;
            write_record(&record)?;
            Ok(None)
        }
    }
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

// ── Commands ─────────────────────────────────────────────────────────────────

/// Every scheduled task currently on disk. Legacy JSON is listed read-only;
/// new SomniQ-owned tasks live in TOML files under `~/.config/SomniQ/automations`.
#[tauri::command]
pub fn scheduled_tasks_list() -> Vec<ScheduledTask> {
    let now = now_millis();
    let mut tasks = all_records()
        .into_iter()
        .map(|record| task_view_with_delivery(record, now))
        .collect::<Vec<_>>();
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

/// The first occurrence a newly saved rule owes.
fn first_occurrence(timing: &NormalizedTiming, schedule: &Schedule, now: i64) -> Option<i64> {
    if timing.schedule_kind == rules::RULE_ONCE {
        schedule.next_after(now - ONCE_SAVE_GRACE_MS)
    } else {
        schedule.next_after(now)
    }
}

fn compiled_timing(timing: &NormalizedTiming, created_at: i64) -> Result<Schedule, String> {
    let probe = ArisScheduledRecord {
        created_at,
        ..ArisScheduledRecord::default()
    };
    let mut probe = probe;
    apply_timing(&mut probe, timing.clone());
    record_schedule(&probe)
}

#[tauri::command]
pub fn scheduled_task_create(input: ScheduledTaskInput) -> Result<ScheduledTask, String> {
    create_core(input, now_millis(), &host_lookups())
}

fn create_core(
    input: ScheduledTaskInput,
    now: i64,
    host: &HostLookups<'_>,
) -> Result<ScheduledTask, String> {
    let _guard = schedule_lock();
    let id = new_task_id();
    let normalized = normalize_input(input, None, &id, now, host)?;
    let mut record = ArisScheduledRecord {
        version: RECORD_VERSION,
        id,
        kind: TASK_KIND.to_string(),
        name: normalized.title,
        prompt: normalized.prompt,
        status: normalized.status,
        target_thread_id: normalized.target_thread_id,
        model: normalized.model,
        created_at: now,
        updated_at: now,
        trigger_kind: normalized.trigger_kind,
        mail_account_id: normalized.mail_account_id,
        mail_keywords: normalized.mail_keywords,
        missed_policy: normalized.missed_policy,
        target_mode: normalized.target_mode,
        project_id: normalized.project_id,
        ..ArisScheduledRecord::default()
    };
    let timing = normalized.timing;
    apply_timing(&mut record, timing.clone());
    if !is_mail(&record) {
        let schedule = compiled_timing(&timing, now)?;
        record.next_occurrence_at = Some(
            first_occurrence(&timing, &schedule, now)
                .ok_or_else(|| "this schedule has no future occurrences".to_string())?,
        );
    }
    write_record(&record)?;
    Ok(task_view(record, now))
}

#[tauri::command]
pub fn scheduled_task_update(
    id: String,
    input: ScheduledTaskInput,
) -> Result<ScheduledTask, String> {
    update_core(&id, input, now_millis(), &host_lookups())
}

fn update_core(
    id: &str,
    input: ScheduledTaskInput,
    now: i64,
    host: &HostLookups<'_>,
) -> Result<ScheduledTask, String> {
    validate_task_id(id)?;
    let _guard = schedule_lock();
    let existing = read_record(id)?;
    let normalized = normalize_input(input, Some(&existing), id, now, host)?;
    let mut record = existing.clone();
    record.version = RECORD_VERSION;
    record.kind = TASK_KIND.to_string();
    record.name = normalized.title;
    record.prompt = normalized.prompt;
    record.model = normalized.model;
    record.trigger_kind = normalized.trigger_kind;
    record.mail_account_id = normalized.mail_account_id;
    record.mail_keywords = normalized.mail_keywords;
    record.missed_policy = normalized.missed_policy;
    record.target_mode = normalized.target_mode;
    record.target_thread_id = normalized.target_thread_id;
    record.project_id = normalized.project_id;
    record.updated_at = now;
    let rule_unchanged = timing_of(&existing) == normalized.timing && !is_mail(&existing);
    apply_timing(&mut record, normalized.timing.clone());
    let desired = normalized.status;
    if is_mail(&record) {
        record.status = desired;
        record.next_occurrence_at = None;
    } else if rule_unchanged && existing.status == STATUS_ENDED {
        // Nothing left to fire, and nothing about the rule changed.
    } else if rule_unchanged && existing.status == desired {
        // An edit that leaves the rule alone keeps the committed occurrence:
        // renaming a task must not move, skip or re-fire its next run.
    } else {
        let schedule = compiled_timing(&normalized.timing, record.created_at)?;
        let first = if rule_unchanged {
            // Resuming: the next future occurrence, no catch-up for the pause.
            schedule.next_after(now)
        } else {
            first_occurrence(&normalized.timing, &schedule, now)
        };
        record.next_occurrence_at =
            Some(first.ok_or_else(|| "this schedule has no future occurrences".to_string())?);
        record.status = desired;
        record.waiting_reason = None;
    }
    write_record(&record)?;
    Ok(task_view_with_delivery(record, now))
}

#[tauri::command]
pub fn scheduled_task_set_status(id: String, status: String) -> Result<ScheduledTask, String> {
    set_status_core(&id, &status, now_millis())
}

fn set_status_core(id: &str, status: &str, now: i64) -> Result<ScheduledTask, String> {
    validate_task_id(id)?;
    let _guard = schedule_lock();
    let mut record = read_record(id)?;
    let desired = normalize_status(status)?;
    if desired == STATUS_ACTIVE && record.status != STATUS_ACTIVE && !is_mail(&record) {
        // Resume computes the next future occurrence: a pause is not a stretch
        // of missed runs to catch up on.
        let schedule = record_schedule(&record)?;
        record.next_occurrence_at = Some(
            schedule
                .next_after(now)
                .ok_or_else(|| "this schedule has no future occurrences".to_string())?,
        );
        record.waiting_reason = None;
    }
    record.status = desired;
    record.updated_at = now;
    write_record(&record)?;
    Ok(task_view_with_delivery(record, now))
}

#[tauri::command]
pub fn scheduled_task_delete(id: String) -> Result<(), String> {
    let _guard = schedule_lock();
    let dir = task_dir(&id)?;
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// What a rule would do, without saving it: the editor's live preview.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePreview {
    time_zone: String,
    /// Epoch ms as strings, committed-first order.
    occurrences: Vec<String>,
    /// Normalised DTSTART/RRULE text when the rule is an RRULE.
    recurrence: Option<String>,
    start_local: Option<String>,
}

#[tauri::command]
pub fn scheduled_task_preview(input: ScheduledTaskInput) -> Result<SchedulePreview, String> {
    let now = now_millis();
    let trigger_kind = normalize_trigger_kind(input.trigger_kind.as_deref())?;
    let timing = normalize_timing(&input, &trigger_kind, now)?;
    if trigger_kind == TRIGGER_MAIL {
        return Ok(SchedulePreview {
            time_zone: timing.time_zone,
            occurrences: Vec::new(),
            recurrence: None,
            start_local: None,
        });
    }
    let schedule = compiled_timing(&timing, now)?;
    let mut occurrences = Vec::new();
    if let Some(first) = first_occurrence(&timing, &schedule, now) {
        occurrences.push(first);
        occurrences.extend(schedule.upcoming(first, UPCOMING_PREVIEW - 1));
    }
    Ok(SchedulePreview {
        time_zone: timing.time_zone,
        occurrences: occurrences.into_iter().map(|at| at.to_string()).collect(),
        recurrence: (!timing.recurrence.is_empty()).then_some(timing.recurrence),
        start_local: (!timing.start_local.is_empty()).then_some(timing.start_local),
    })
}

/// How a delivered occurrence's work task went, read from the card itself.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryOutcome {
    /// The card's status, or `missing` when the card was deleted.
    status: String,
    review_verdict: Option<String>,
    review_exhausted: bool,
    summary: Option<String>,
    error: Option<String>,
    session_id: Option<String>,
    updated_at: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryView {
    #[serde(flatten)]
    delivery: DeliveryRecord,
    /// `None` for an occurrence that never produced a card (missed, failed,
    /// skipped).
    outcome: Option<DeliveryOutcome>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryHistory {
    deliveries: Vec<DeliveryView>,
    earlier_pruned: bool,
}

fn outcome_of(task: &crate::work_task::model::WorkTask) -> DeliveryOutcome {
    DeliveryOutcome {
        status: task.status.as_str().to_string(),
        // The wire spelling (`pass`, `needs_user`, …), same as the board's.
        review_verdict: task.review_state.as_ref().and_then(|review| {
            serde_json::to_value(review.verdict)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
        }),
        review_exhausted: task.review_state.as_ref().is_some_and(|review| review.exhausted),
        summary: task.result_summary.clone(),
        error: task.last_error.clone(),
        session_id: task.session_id.clone().or_else(|| task.target_session_id.clone()),
        updated_at: Some(task.updated_at),
    }
}

/// Join delivery records to the cards they produced, newest first.
fn history_for(id: &str, limit: usize) -> Result<DeliveryHistory, String> {
    let file = ledger::read(&task_dir(id)?);
    let mut cards: BTreeMap<String, Vec<crate::work_task::model::WorkTask>> = BTreeMap::new();
    for record in &file.records {
        if let Some(project_id) = record.project_id.as_ref() {
            if record.work_task_id.is_some() && !cards.contains_key(project_id) {
                cards.insert(
                    project_id.clone(),
                    crate::work_task::store::list(project_id),
                );
            }
        }
    }
    let deliveries = file
        .records
        .iter()
        .rev()
        .take(limit)
        .map(|record| {
            let outcome = record.work_task_id.as_ref().map(|task_id| {
                record
                    .project_id
                    .as_ref()
                    .and_then(|project_id| cards.get(project_id))
                    .and_then(|tasks| tasks.iter().find(|task| &task.id == task_id))
                    .map(outcome_of)
                    .unwrap_or(DeliveryOutcome {
                        status: "missing".to_string(),
                        review_verdict: None,
                        review_exhausted: false,
                        summary: None,
                        error: None,
                        session_id: record.target_session_id.clone(),
                        updated_at: None,
                    })
            });
            DeliveryView {
                delivery: record.clone(),
                outcome,
            }
        })
        .collect();
    Ok(DeliveryHistory {
        deliveries,
        earlier_pruned: file.earlier_pruned,
    })
}

#[tauri::command]
pub async fn scheduled_task_history(
    id: String,
    limit: Option<usize>,
) -> Result<DeliveryHistory, String> {
    let limit = limit.unwrap_or(HISTORY_DEFAULT_LIMIT).clamp(1, ledger::MAX_RECORDS);
    crate::blocking::off_main_thread(move || history_for(&id, limit)).await
}

/// Queue one run now, outside the rule. Does not move the committed next
/// occurrence (the same as upstream Schedule's "Run now"), and goes through
/// the same dispatch — so it is refused, not stacked, while a run is going.
#[tauri::command]
pub async fn scheduled_task_run_now(app: AppHandle, id: String) -> Result<ScheduledTask, String> {
    validate_task_id(&id)?;
    let (view, pump) = crate::blocking::off_main_thread(move || run_now_core(&host_lookups(), &id, now_millis()))
        .await?;
    if let Some(project) = pump {
        pump_projects(&app, vec![project]).await;
    }
    emit_tasks_changed(&app);
    Ok(view)
}

fn run_now_core(
    host: &HostLookups<'_>,
    id: &str,
    now: i64,
) -> Result<(ScheduledTask, Option<(String, PathBuf)>), String> {
    let _guard = schedule_lock();
    let mut record = read_record(id)?;
    if record.prompt.trim().is_empty() {
        return Err("scheduled task prompt is required".to_string());
    }
    let occurrence = Occurrence {
        key: format!("{id}:manual:{now}"),
        trigger: ledger::TRIGGER_MANUAL,
        at: now,
        coalesced: 0,
        first_missed_at: None,
        prompt: record.prompt.clone(),
    };
    let pump = match deliver(host, &record, occurrence, now)? {
        Delivery::AlreadyRecorded => None,
        Delivery::Queued {
            project_id,
            project_path,
        } => {
            record.last_run_at = Some(now);
            record.last_error = None;
            record.updated_at = now;
            write_record(&record)?;
            Some((project_id, project_path))
        }
        Delivery::Busy(reason) => return Err(reason),
        Delivery::Failed(receipt) => {
            return Err(receipt
                .error
                .unwrap_or_else(|| "the run could not be queued".to_string()))
        }
    };
    Ok((task_view_with_delivery(record, now), pump))
}

#[cfg(test)]
#[path = "tests/scheduled.rs"]
mod tests;
