//! Scheduled-task records and dispatch.
//!
//! The dispatch tests run the real path — record on disk, work-task store,
//! delivery ledger, a real git repository to queue against — under an
//! isolated `ARIS_CONFIG_ROOT`, holding `crate::test_env_lock()` for their
//! whole body. Only the project registry and the Chat UI index are stood in
//! for, through `HostLookups`.
//!
//! A "restart" here is what it is in production: every in-memory structure
//! gone, the files left exactly as the crash left them. The scheduler keeps
//! no state outside those files, so re-running `process_due` against
//! rewound files *is* a restart.

use std::path::{Path, PathBuf};

use super::{
    interval_from_rrule, is_safe_identifier, ledger, mail_trigger_matches, normalize_status,
    normalize_timing, normalize_trigger_kind, occurrence_key, process_due, read_record,
    rrule_for_interval, schedule_label_from_rrule, task_dir, task_view, update_core, write_record,
    ArisScheduledRecord, HostLookups, MailTriggerContext, ScheduledTask, ScheduledTaskInput,
    STATUS_ACTIVE, STATUS_ENDED, STATUS_PAUSED, TARGET_NEW, TARGET_NEW_ONCE, TRIGGER_MAIL,
};
use crate::work_task::model::{WorkTask, WorkTaskStatus};
use crate::work_task::store;

const MINUTE: i64 = 60_000;
/// 2026-06-01T00:00:00Z — an arbitrary, DST-free instant to anchor grids on.
const T0: i64 = 1_780_272_000_000;

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
        trigger_kind: TRIGGER_MAIL.to_string(),
        mail_account_id: account.to_string(),
        mail_keywords: keywords.iter().map(|k| k.to_string()).collect(),
        ..ArisScheduledRecord::default()
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
        model: "gpt-5.5".to_string(),
        created_at: 10,
        updated_at: 20,
        trigger_kind: "interval".to_string(),
        ..ArisScheduledRecord::default()
    });

    assert_eq!(task.id, "task-1");
    assert_eq!(task.title, "Check inbox");
    assert_eq!(task.schedule_label, "每 15 分钟");
    assert_eq!(task.status, "paused");
    assert_eq!(task.session_id.as_deref(), Some("chat-1"));
    assert_eq!(task.model, "gpt-5.5");
    assert_eq!(task.interval_value, 15);
    assert_eq!(task.interval_unit, "minutes");
    // A v1 record is an interval task bound to its chat.
    assert_eq!(task.schedule_kind, "interval");
    assert_eq!(task.target_mode, "session");
    assert_eq!(task.trigger_kind, "schedule");
    assert!(!task.time_zone.is_empty(), "v1 records are read in an explicit zone");
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
    assert!(task.next_occurrences.is_empty());
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
    assert_eq!(normalize_trigger_kind(None).unwrap(), "schedule");
    assert_eq!(normalize_trigger_kind(Some("")).unwrap(), "schedule");
    // The v1 spelling still means "on a clock".
    assert_eq!(normalize_trigger_kind(Some("interval")).unwrap(), "schedule");
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

/// A pre-v2 build requires `rrule` and reads it as an interval. A Cron or
/// RRULE record must therefore fail to parse there — skipped — rather than
/// parse as "every minute".
#[test]
fn records_a_v1_build_would_misread_are_unreadable_to_it() {
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct V1Record {
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
    let base = ArisScheduledRecord {
        version: 2,
        id: "task-v2".to_string(),
        kind: "aris-scheduled-task".to_string(),
        name: "x".to_string(),
        prompt: "y".to_string(),
        status: STATUS_ACTIVE.to_string(),
        target_thread_id: "chat-1".to_string(),
        time_zone: "Asia/Shanghai".to_string(),
        ..ArisScheduledRecord::default()
    };
    let cron = ArisScheduledRecord {
        schedule_kind: "cron".to_string(),
        cron: "0 9 * * 1-5".to_string(),
        ..base.clone()
    };
    let interval = ArisScheduledRecord {
        schedule_kind: "interval".to_string(),
        rrule: "FREQ=HOURLY;INTERVAL=2".to_string(),
        ..base
    };
    let cron_text = toml::to_string_pretty(&cron).expect("serialize");
    let interval_text = toml::to_string_pretty(&interval).expect("serialize");
    assert!(toml::from_str::<V1Record>(&cron_text).is_err());
    assert!(toml::from_str::<V1Record>(&interval_text).is_ok());
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

struct EnvGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(previous) => std::env::set_var(self.key, previous),
            None => std::env::remove_var(self.key),
        }
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    _config: EnvGuard,
    _serial: std::sync::MutexGuard<'static, ()>,
    project_path: PathBuf,
    project_id: String,
}

fn fixture(name: &str) -> Fixture {
    let serial = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let temp = tempfile::tempdir().expect("tempdir");
    let config = EnvGuard::set("ARIS_CONFIG_ROOT", temp.path().join("config"));
    let project_path = temp.path().join("repo");
    init_repo(&project_path);
    Fixture {
        _temp: temp,
        _config: config,
        _serial: serial,
        project_path,
        project_id: format!("proj-{name}"),
    }
}

fn git(root: &Path, args: &[&str]) {
    let output = crate::process::hidden_command("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo(root: &Path) {
    std::fs::create_dir_all(root).expect("repo dir");
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.email", "task@example.com"]);
    git(root, &["config", "user.name", "Task Runner"]);
    std::fs::write(root.join("README.md"), "seed\n").expect("seed");
    git(root, &["add", "-A"]);
    git(root, &["commit", "-m", "seed"]);
}

/// Run `body` with lookups that know exactly one project, and map every chat
/// to it.
fn with_host<R>(fixture: &Fixture, body: impl FnOnce(&HostLookups<'_>) -> R) -> R {
    let project_id = fixture.project_id.clone();
    let project_path = fixture.project_path.clone();
    let known = project_id.clone();
    let resolve = move |id: &str| (id == known).then(|| project_path.clone());
    let session = move |_: &str| Some(project_id.clone());
    body(&HostLookups {
        project_path: &resolve,
        session_project: &session,
    })
}

/// An every-15-minutes task in Shanghai whose first occurrence is `T0`,
/// reserving its own conversation in the fixture's project.
fn interval_task(fixture: &Fixture, id: &str) -> ArisScheduledRecord {
    let record = ArisScheduledRecord {
        version: 2,
        id: id.to_string(),
        kind: "aris-scheduled-task".to_string(),
        name: "Literature sweep".to_string(),
        prompt: "Update the library.".to_string(),
        status: STATUS_ACTIVE.to_string(),
        rrule: "FREQ=MINUTELY;INTERVAL=15".to_string(),
        target_thread_id: format!("sched-{id}"),
        created_at: T0 - 15 * MINUTE,
        updated_at: T0 - 15 * MINUTE,
        trigger_kind: "schedule".to_string(),
        schedule_kind: "interval".to_string(),
        time_zone: "Asia/Shanghai".to_string(),
        start_local: "2026-06-01T08:00".to_string(),
        anchor_at: Some(T0),
        next_occurrence_at: Some(T0),
        missed_policy: "run_latest".to_string(),
        target_mode: TARGET_NEW_ONCE.to_string(),
        project_id: fixture.project_id.clone(),
        ..ArisScheduledRecord::default()
    };
    write_record(&record).expect("write record");
    record
}

fn cards_for(fixture: &Fixture, id: &str) -> Vec<WorkTask> {
    store::list(&fixture.project_id)
        .into_iter()
        .filter(|task| task.scheduled_task_id.as_deref() == Some(id))
        .collect()
}

fn deliveries(id: &str) -> Vec<ledger::DeliveryRecord> {
    ledger::read(&task_dir(id).expect("dir")).records
}

fn settle(fixture: &Fixture, card: &WorkTask) {
    store::update(&fixture.project_id, &card.id, |task| {
        task.status = WorkTaskStatus::Review;
        Ok(())
    })
    .expect("settle");
}

/// Missed-run policy `run_latest`: three hours offline under a 15-minute rule
/// is one late run of the latest occurrence, with the twelve before it
/// recorded as folded into it — not thirteen runs, and not none.
#[test]
fn missed_occurrences_coalesce_into_one_run_of_the_latest() {
    let fixture = fixture("coalesce");
    interval_task(&fixture, "task-coalesce");
    let now = T0 + 181 * MINUTE;

    let pumped = with_host(&fixture, |host| process_due(host, "task-coalesce", now)).expect("tick");
    assert_eq!(pumped.map(|(id, _)| id), Some(fixture.project_id.clone()));

    let cards = cards_for(&fixture, "task-coalesce");
    assert_eq!(cards.len(), 1, "one run for the whole outage");
    let latest = T0 + 180 * MINUTE;
    assert_eq!(
        cards[0].scheduled_occurrence_key.as_deref(),
        Some(occurrence_key("task-coalesce", latest).as_str())
    );
    assert_eq!(cards[0].status, WorkTaskStatus::Queued);
    // `new_once`: the reserved conversation, not one minted per run.
    assert_eq!(cards[0].target_session_id.as_deref(), Some("sched-task-coalesce"));

    let receipts = deliveries("task-coalesce");
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].status, ledger::DELIVERY_QUEUED);
    assert_eq!(receipts[0].occurrence_at, latest);
    assert_eq!(receipts[0].coalesced, 12);
    assert_eq!(receipts[0].first_missed_at, Some(T0));
    assert_eq!(receipts[0].work_task_id.as_deref(), Some(cards[0].id.as_str()));
    assert!(!receipts[0].recovered);

    let record = read_record("task-coalesce").expect("record");
    assert_eq!(record.next_occurrence_at, Some(T0 + 195 * MINUTE));
    assert_eq!(record.last_run_at, Some(now));
}

/// Missed-run policy `skip`: a late occurrence is recorded as missed and not
/// run; the next one on time runs normally.
#[test]
fn the_skip_policy_drops_late_occurrences_and_runs_on_time_ones() {
    let fixture = fixture("skip");
    let mut record = interval_task(&fixture, "task-skip");
    record.missed_policy = "skip".to_string();
    write_record(&record).expect("write");

    let late = T0 + 190 * MINUTE;
    with_host(&fixture, |host| process_due(host, "task-skip", late)).expect("tick");
    assert!(cards_for(&fixture, "task-skip").is_empty(), "a late run was not dropped");
    let receipts = deliveries("task-skip");
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].status, ledger::DELIVERY_MISSED);
    assert_eq!(receipts[0].occurrence_at, T0 + 180 * MINUTE);
    assert_eq!(receipts[0].coalesced, 12);
    assert_eq!(
        read_record("task-skip").expect("record").next_occurrence_at,
        Some(T0 + 195 * MINUTE)
    );

    // On time (within the grace window) is not "missed".
    let on_time = T0 + 195 * MINUTE + 30_000;
    with_host(&fixture, |host| process_due(host, "task-skip", on_time)).expect("tick");
    assert_eq!(cards_for(&fixture, "task-skip").len(), 1);
    assert_eq!(deliveries("task-skip").len(), 2);
}

/// The crash the protocol exists for: the card was queued, then SomniQ died
/// before the receipt and the advanced occurrence reached disk. After the
/// restart the same occurrence is due again — and finds its card.
#[test]
fn a_restart_between_queuing_and_the_receipt_does_not_queue_twice() {
    let fixture = fixture("restart");
    interval_task(&fixture, "task-restart");
    let record_path = task_dir("task-restart").expect("dir").join("automation.toml");
    let before_tick = std::fs::read(&record_path).expect("record bytes");

    let now = T0 + 30_000;
    with_host(&fixture, |host| process_due(host, "task-restart", now)).expect("tick");
    assert_eq!(cards_for(&fixture, "task-restart").len(), 1);

    // Rewind to the crash point: card on disk, no receipt, no advance.
    std::fs::write(&record_path, &before_tick).expect("rewind record");
    std::fs::remove_file(ledger::path(&task_dir("task-restart").expect("dir")))
        .expect("drop receipts");

    with_host(&fixture, |host| process_due(host, "task-restart", now + 5_000))
        .expect("tick after restart");
    let cards = cards_for(&fixture, "task-restart");
    assert_eq!(cards.len(), 1, "the restart queued the same occurrence twice");
    let receipts = deliveries("task-restart");
    assert_eq!(receipts.len(), 1);
    assert!(receipts[0].recovered, "the receipt should say it was recovered");
    assert_eq!(receipts[0].work_task_id.as_deref(), Some(cards[0].id.as_str()));
    assert_eq!(
        read_record("task-restart").expect("record").next_occurrence_at,
        Some(T0 + 15 * MINUTE)
    );

    // And a double tick at the same instant is a no-op.
    with_host(&fixture, |host| process_due(host, "task-restart", now + 5_000)).expect("tick");
    assert_eq!(cards_for(&fixture, "task-restart").len(), 1);
    assert_eq!(deliveries("task-restart").len(), 1);
}

/// The other crash point: the receipt landed, the advance did not. The
/// restart finds the receipt and only advances.
#[test]
fn a_restart_after_the_receipt_only_advances() {
    let fixture = fixture("restart-receipt");
    interval_task(&fixture, "task-receipt");
    let record_path = task_dir("task-receipt").expect("dir").join("automation.toml");
    let before_tick = std::fs::read(&record_path).expect("record bytes");

    let now = T0 + 30_000;
    with_host(&fixture, |host| process_due(host, "task-receipt", now)).expect("tick");
    std::fs::write(&record_path, &before_tick).expect("rewind record only");
    // The card the first attempt queued has since been settled and even
    // deleted by the user; the receipt alone must stop a re-run.
    for card in cards_for(&fixture, "task-receipt") {
        store::remove(&fixture.project_id, &card.id).expect("remove");
    }

    with_host(&fixture, |host| process_due(host, "task-receipt", now + 5_000)).expect("tick");
    assert!(cards_for(&fixture, "task-receipt").is_empty());
    assert_eq!(deliveries("task-receipt").len(), 1);
    assert_eq!(
        read_record("task-receipt").expect("record").next_occurrence_at,
        Some(T0 + 15 * MINUTE)
    );
}

/// While the previous run still holds the task, a due occurrence is owed,
/// not consumed: nothing is queued, the committed occurrence stays put, and
/// once the run settles the latest due occurrence runs, with the ones it
/// waited through folded in.
#[test]
fn a_busy_task_defers_without_consuming_the_occurrence() {
    let fixture = fixture("busy");
    interval_task(&fixture, "task-busy");
    with_host(&fixture, |host| process_due(host, "task-busy", T0 + 1_000)).expect("tick");
    let first = cards_for(&fixture, "task-busy").remove(0);
    store::update(&fixture.project_id, &first.id, |task| {
        task.status = WorkTaskStatus::Running;
        Ok(())
    })
    .expect("running");

    for now in [T0 + 15 * MINUTE + 1_000, T0 + 40 * MINUTE] {
        with_host(&fixture, |host| process_due(host, "task-busy", now)).expect("tick");
        assert_eq!(cards_for(&fixture, "task-busy").len(), 1);
        let record = read_record("task-busy").expect("record");
        assert_eq!(record.next_occurrence_at, Some(T0 + 15 * MINUTE));
        assert!(record.waiting_reason.is_some(), "the hold should be visible");
    }
    assert_eq!(deliveries("task-busy").len(), 1, "a hold writes no receipt");

    settle(&fixture, &first);
    with_host(&fixture, |host| process_due(host, "task-busy", T0 + 41 * MINUTE)).expect("tick");
    let cards = cards_for(&fixture, "task-busy");
    assert_eq!(cards.len(), 2);
    let receipts = deliveries("task-busy");
    let last = receipts.last().expect("receipt");
    assert_eq!(last.occurrence_at, T0 + 30 * MINUTE);
    assert_eq!(last.coalesced, 1);
    let record = read_record("task-busy").expect("record");
    assert_eq!(record.next_occurrence_at, Some(T0 + 45 * MINUTE));
    assert!(record.waiting_reason.is_none());
}

#[test]
fn a_one_shot_ends_after_its_delivery() {
    let fixture = fixture("once");
    let mut record = interval_task(&fixture, "task-once");
    record.schedule_kind = "once".to_string();
    record.rrule = String::new();
    record.target_mode = TARGET_NEW.to_string();
    record.target_thread_id = String::new();
    write_record(&record).expect("write");

    with_host(&fixture, |host| process_due(host, "task-once", T0 + 1_000)).expect("tick");
    let cards = cards_for(&fixture, "task-once");
    assert_eq!(cards.len(), 1);
    // `new`: a conversation of its own, derived from the occurrence.
    let session = cards[0].target_session_id.clone().expect("per-delivery session");
    assert!(session.starts_with("sched-task-once-"), "{session}");
    let record = read_record("task-once").expect("record");
    assert_eq!(record.status, STATUS_ENDED);
    assert_eq!(record.next_occurrence_at, None);

    with_host(&fixture, |host| process_due(host, "task-once", T0 + 60 * MINUTE)).expect("tick");
    assert_eq!(cards_for(&fixture, "task-once").len(), 1);
    assert_eq!(task_view(record, T0).status, "ended");
}

/// A record written before v2 — no zone, no committed occurrence, a bound
/// chat — keeps v1's cadence: one interval after its last run.
#[test]
fn a_v1_record_keeps_its_cadence() {
    let fixture = fixture("v1");
    let record = ArisScheduledRecord {
        version: 1,
        id: "task-v1".to_string(),
        kind: "aris-scheduled-task".to_string(),
        name: "Old task".to_string(),
        prompt: "Do the old thing.".to_string(),
        status: STATUS_ACTIVE.to_string(),
        rrule: "FREQ=HOURLY;INTERVAL=2".to_string(),
        target_thread_id: "chat-1".to_string(),
        created_at: T0,
        updated_at: T0,
        trigger_kind: "interval".to_string(),
        ..ArisScheduledRecord::default()
    };
    write_record(&record).expect("write");
    let view = task_view(record, T0 + MINUTE);
    assert_eq!(view.next_run, Some((T0 + 120 * MINUTE).to_string()));
    assert_eq!(view.next_occurrences.len(), 5);

    with_host(&fixture, |host| process_due(host, "task-v1", T0 + 60 * MINUTE)).expect("tick");
    assert!(cards_for(&fixture, "task-v1").is_empty(), "not due yet");
    with_host(&fixture, |host| process_due(host, "task-v1", T0 + 121 * MINUTE)).expect("tick");
    let cards = cards_for(&fixture, "task-v1");
    assert_eq!(cards.len(), 1);
    // `session` target: the run continues the bound chat.
    assert_eq!(cards[0].target_session_id.as_deref(), Some("chat-1"));
    assert_eq!(
        read_record("task-v1").expect("record").next_occurrence_at,
        Some(T0 + 240 * MINUTE)
    );
}

fn edit_input(title: &str) -> ScheduledTaskInput {
    ScheduledTaskInput {
        title: title.to_string(),
        prompt: "Update the library.".to_string(),
        session_id: "chat-1".to_string(),
        interval_value: 15,
        interval_unit: "minutes".to_string(),
        status: Some("active".to_string()),
        schedule_kind: Some("interval".to_string()),
        time_zone: Some("Asia/Shanghai".to_string()),
        start_local: Some("2026-06-01T08:00".to_string()),
        target_mode: Some("session".to_string()),
        ..ScheduledTaskInput::default()
    }
}

/// Renaming a task must not move, skip or re-fire its next run; changing the
/// rule must re-commit it from now.
#[test]
fn an_edit_keeps_the_committed_occurrence_unless_the_rule_changes() {
    let fixture = fixture("edit");
    let mut record = interval_task(&fixture, "task-edit");
    record.target_mode = "session".to_string();
    record.target_thread_id = "chat-1".to_string();
    write_record(&record).expect("write");
    let now = T0 + 7 * MINUTE;

    let renamed = with_host(&fixture, |host| {
        update_core("task-edit", edit_input("Renamed"), now, host)
    })
    .expect("rename");
    assert_eq!(renamed.title, "Renamed");
    assert_eq!(
        read_record("task-edit").expect("record").next_occurrence_at,
        Some(T0),
        "a rename moved the owed occurrence"
    );

    let mut hourly = edit_input("Renamed");
    hourly.interval_unit = "hours".to_string();
    hourly.interval_value = 1;
    with_host(&fixture, |host| update_core("task-edit", hourly, now, host)).expect("re-time");
    assert_eq!(
        read_record("task-edit").expect("record").next_occurrence_at,
        Some(T0 + 60 * MINUTE)
    );
}

/// The same timing input normalises to the same thing whenever it is saved,
/// which is what lets an edit recognise "rule unchanged".
#[test]
fn timing_normalises_the_same_way_at_any_time() {
    let input = edit_input("x");
    let earlier = normalize_timing(&input, "schedule", T0).expect("timing");
    let later = normalize_timing(&input, "schedule", T0 + 999 * MINUTE).expect("timing");
    assert_eq!(earlier, later);
    assert_eq!(earlier.anchor_at, Some(T0));

    let rrule = ScheduledTaskInput {
        schedule_kind: Some("rrule".to_string()),
        rrule: Some("FREQ=WEEKLY;BYDAY=MO".to_string()),
        ..edit_input("x")
    };
    let timing = normalize_timing(&rrule, "schedule", T0).expect("rrule timing");
    assert_eq!(
        timing.recurrence,
        "DTSTART;TZID=Asia/Shanghai:20260601T080000\nRRULE:FREQ=WEEKLY;BYDAY=MO"
    );
    assert_eq!(timing.start_local, "2026-06-01T08:00");

    let bad_zone = ScheduledTaskInput {
        time_zone: Some("Not/AZone".to_string()),
        ..edit_input("x")
    };
    assert!(normalize_timing(&bad_zone, "schedule", T0).is_err());
}
