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
        model: String::new(),
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
        model: "gpt-5.5".to_string(),
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
    assert_eq!(task.model, "gpt-5.5");
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
