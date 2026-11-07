//! Delivery records: one per occurrence key, bounded, and never fatal.

use super::{append, find, read, DeliveryRecord, DELIVERY_QUEUED, MAX_RECORDS, TRIGGER_SCHEDULE};

fn record(key: &str, at: i64) -> DeliveryRecord {
    DeliveryRecord {
        key: key.to_string(),
        trigger: TRIGGER_SCHEDULE.to_string(),
        occurrence_at: at,
        coalesced: 0,
        first_missed_at: None,
        status: DELIVERY_QUEUED.to_string(),
        recorded_at: at,
        project_id: Some("proj".to_string()),
        work_task_id: Some(format!("card-{at}")),
        target_session_id: None,
        error: None,
        recovered: false,
    }
}

/// A second append for the same occurrence returns the first record and
/// writes nothing: one occurrence has one delivery outcome on file.
#[test]
fn an_occurrence_is_recorded_once() {
    let temp = tempfile::tempdir().expect("tempdir");
    let first = append(temp.path(), record("t:at:1", 1)).expect("append");
    let mut again = record("t:at:1", 1);
    again.work_task_id = Some("a-different-card".to_string());
    let kept = append(temp.path(), again).expect("append duplicate");
    assert_eq!(kept, first);
    assert_eq!(read(temp.path()).records.len(), 1);
    assert_eq!(find(temp.path(), "t:at:1"), Some(first));
    assert_eq!(find(temp.path(), "t:at:2"), None);
}

#[test]
fn history_is_pruned_to_the_newest_records() {
    let temp = tempfile::tempdir().expect("tempdir");
    for at in 0..(MAX_RECORDS as i64 + 5) {
        append(temp.path(), record(&format!("t:at:{at}"), at)).expect("append");
    }
    let file = read(temp.path());
    assert_eq!(file.records.len(), MAX_RECORDS);
    assert!(file.earlier_pruned);
    assert_eq!(file.records.first().map(|item| item.occurrence_at), Some(5));
    assert_eq!(
        file.records.last().map(|item| item.occurrence_at),
        Some(MAX_RECORDS as i64 + 4)
    );
}

/// The receipts are the history view, not the dedupe authority, so a broken
/// file reads as empty instead of stopping the scheduler.
#[test]
fn a_corrupt_history_reads_as_empty() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::write(temp.path().join("deliveries.json"), "{ not json").expect("write");
    assert!(read(temp.path()).records.is_empty());
    append(temp.path(), record("t:at:1", 1)).expect("append over corrupt file");
    assert_eq!(read(temp.path()).records.len(), 1);
}
