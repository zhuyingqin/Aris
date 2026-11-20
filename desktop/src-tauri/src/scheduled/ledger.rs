//! Delivery records for scheduled tasks.
//!
//! A delivery record says what the scheduler did with one occurrence: handed
//! it to the work-task queue, dropped it under the skip-missed policy, or
//! failed to hand it over. It deliberately says nothing about how the run went
//! — that is the work task's own state (status, independent review verdict,
//! summary), joined in at read time. Keeping the two apart is the point: a
//! receipt proves the run was *queued*, and only the work task can prove it
//! *finished*. Folding the outcome into the receipt would freeze it at
//! whatever the run looked like when the receipt was written.
//!
//! One file per automation, `automations/<id>/deliveries.json`, rewritten
//! atomically and pruned to the newest [`MAX_RECORDS`] on append.
//!
//! Records are keyed by occurrence. The key is what makes dispatch
//! idempotent across restarts; see `scheduled.rs` for the full protocol.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Handed to the work-task queue (a card exists, or existed, for it).
pub(crate) const DELIVERY_QUEUED: &str = "queued";
/// Not run, on purpose: the skip-missed policy dropped a late occurrence.
pub(crate) const DELIVERY_MISSED: &str = "missed";
/// Not run, on purpose: an event-triggered firing arrived while the previous
/// run was still in flight, and an event has no later occurrence to defer to.
pub(crate) const DELIVERY_SKIPPED: &str = "skipped";
/// Could not be handed over (no repository, project gone, store write failed).
pub(crate) const DELIVERY_FAILED: &str = "failed";

pub(crate) const TRIGGER_SCHEDULE: &str = "schedule";
pub(crate) const TRIGGER_MANUAL: &str = "manual";
pub(crate) const TRIGGER_MAIL: &str = "mail";

/// Newest records kept per automation. Pruning only ever drops occurrences the
/// committed next occurrence has already moved past, so it cannot reopen one
/// for dispatch; the work-task store still holds the key of every card.
pub(crate) const MAX_RECORDS: usize = 200;

const FILE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeliveryRecord {
    /// Occurrence identity, e.g. `task-1:at:1762400000000`. Unique per file.
    pub key: String,
    pub trigger: String,
    /// The occurrence this record is about: the scheduled instant for a rule,
    /// the request time for a manual run or a mail event.
    pub occurrence_at: i64,
    /// Earlier occurrences folded into this one by the missed-run policy.
    #[serde(default)]
    pub coalesced: u32,
    /// The earliest of those folded occurrences.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_missed_at: Option<i64>,
    pub status: String,
    pub recorded_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Written after a restart for a card that was already queued — the
    /// queue write landed and the receipt did not. Proof the dedupe held.
    #[serde(default)]
    pub recovered: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeliveryFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub records: Vec<DeliveryRecord>,
    /// Older records were dropped by retention.
    #[serde(default)]
    pub earlier_pruned: bool,
}

pub(crate) fn path(task_dir: &Path) -> PathBuf {
    task_dir.join("deliveries.json")
}

/// The file as it is on disk. Missing or unreadable reads as empty: the
/// receipts are the history view, not the dedupe authority (the work-task
/// store's occurrence keys are), so losing them must not block dispatch.
pub(crate) fn read(task_dir: &Path) -> DeliveryFile {
    std::fs::read_to_string(path(task_dir))
        .ok()
        .and_then(|raw| serde_json::from_str::<DeliveryFile>(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn find(task_dir: &Path, key: &str) -> Option<DeliveryRecord> {
    read(task_dir)
        .records
        .into_iter()
        .find(|record| record.key == key)
}

/// Append a record unless one with the same key is already there, and prune.
/// Returns the record now on file for that key — the existing one when the
/// append was a duplicate, so callers can never write two outcomes for one
/// occurrence.
pub(crate) fn append(task_dir: &Path, record: DeliveryRecord) -> Result<DeliveryRecord, String> {
    let mut file = read(task_dir);
    if let Some(existing) = file.records.iter().find(|item| item.key == record.key) {
        return Ok(existing.clone());
    }
    file.version = FILE_VERSION;
    file.records.push(record.clone());
    file.records.sort_by(|left, right| {
        left.recorded_at
            .cmp(&right.recorded_at)
            .then_with(|| left.occurrence_at.cmp(&right.occurrence_at))
    });
    if file.records.len() > MAX_RECORDS {
        let excess = file.records.len() - MAX_RECORDS;
        file.records.drain(..excess);
        file.earlier_pruned = true;
    }
    std::fs::create_dir_all(task_dir).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(&file).map_err(|error| error.to_string())?;
    runtime::write_file_atomically(&path(task_dir), bytes).map_err(|error| error.to_string())?;
    Ok(record)
}

#[cfg(test)]
#[path = "../tests/scheduled/ledger.rs"]
mod tests;
