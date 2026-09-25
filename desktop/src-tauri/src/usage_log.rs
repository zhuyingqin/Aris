use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use runtime::TokenUsage;
use serde::{Deserialize, Serialize};

use crate::state;

static USAGE_LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLogEntry {
    pub created_at: u64,
    pub session_id: String,
    #[serde(default = "default_usage_role")]
    pub role: String,
    #[serde(default)]
    pub server: String,
    pub model: String,
    pub provider: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_creation_input_tokens: u32,
    pub cache_read_input_tokens: u32,
    /// Wall-clock duration of **this request** in milliseconds — request sent
    /// to response complete, retries included. `0` when the timing was not
    /// captured (legacy rows, non-executor entries, or a turn whose request
    /// count did not line up with its usage rows).
    ///
    /// It used to hold the whole *turn's* duration, stamped identically onto
    /// every request row of that turn. Anything summing the column then counted
    /// the same interval once per request: one 3.2-hour session reported 27
    /// hours. Per-request is also the number worth having — a turn total says
    /// nothing about which call was slow.
    #[serde(default)]
    pub duration_ms: u64,
    /// Reasoning effort applied for this turn (empty when not applicable or on
    /// legacy rows).
    #[serde(default)]
    pub reasoning_effort: String,
    /// Which turn these rows belong to.
    ///
    /// Turn-level aggregates used to group by `(sessionId, createdAt)`, which
    /// only held because every row of a turn was written with an identical
    /// timestamp. Rows now carry their own request time, so the grouping has to
    /// be named rather than inferred. Empty on legacy rows, where consumers
    /// fall back to the old timestamp grouping.
    #[serde(default)]
    pub turn_id: String,
}

/// When and how long one model request took, captured from the wire trace.
#[derive(Debug, Clone, Copy, Default)]
pub struct ModelRequestTiming {
    pub finished_at_secs: u64,
    pub duration_ms: u64,
}

/// The rows a turn contributes to the log. Split out from the append so the
/// attribution rules are testable without touching the real log file.
#[allow(clippy::too_many_arguments)]
fn build_usage_rows(
    session_id: &str,
    turn_id: &str,
    role: &str,
    model: &str,
    provider: &str,
    server: &str,
    usages: &[TokenUsage],
    timings: &[ModelRequestTiming],
    turn_duration_ms: u64,
    reasoning_effort: &str,
    now_secs: u64,
) -> Vec<UsageLogEntry> {
    let aligned = timings.len() == usages.len();
    let mut entries = usages
        .iter()
        .copied()
        .enumerate()
        .filter(|(_, usage)| has_billable_tokens(usage))
        .map(|(index, usage)| {
            let timing = if aligned {
                timings[index]
            } else {
                ModelRequestTiming::default()
            };
            UsageLogEntry {
                created_at: if timing.finished_at_secs > 0 {
                    timing.finished_at_secs
                } else {
                    now_secs
                },
                session_id: session_id.to_string(),
                role: role.to_string(),
                server: server.to_string(),
                model: model.to_string(),
                provider: provider.to_string(),
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                duration_ms: timing.duration_ms,
                reasoning_effort: reasoning_effort.to_string(),
                turn_id: turn_id.to_string(),
            }
        })
        .collect::<Vec<_>>();
    if !aligned {
        // One row carries the turn so the column still sums to real elapsed
        // time; stamping all of them (the old behaviour) counted the same
        // interval once per request.
        if let Some(last) = entries.last_mut() {
            last.duration_ms = turn_duration_ms;
        }
    }
    entries
}

/// Append one row per billable request of a turn.
///
/// `timings` must be positionally aligned with `usages` — the *n*-th request's
/// timing against the *n*-th request's usage. A length mismatch means the
/// alignment cannot be trusted (an interleaved reviewer run, a request that
/// returned no usage), and rather than mislabel every row the whole turn falls
/// back to `turn_duration_ms` on its last row and zero on the rest. That keeps
/// `sum(duration_ms)` equal to real elapsed time either way, which is the
/// property every aggregate over this log depends on.
pub fn append_turn_usage(
    session_id: &str,
    turn_id: &str,
    role: &str,
    model: &str,
    provider: &str,
    server: &str,
    usages: &[TokenUsage],
    timings: &[ModelRequestTiming],
    turn_duration_ms: u64,
    reasoning_effort: &str,
) -> Result<(), String> {
    let entries = build_usage_rows(
        session_id,
        turn_id,
        role,
        model,
        provider,
        server,
        usages,
        timings,
        turn_duration_ms,
        reasoning_effort,
        now_epoch_secs(),
    );
    if entries.is_empty() {
        return Ok(());
    }

    let _guard = USAGE_LOG_LOCK
        .lock()
        .map_err(|_| "usage log lock poisoned".to_string())?;
    let path = usage_log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    for entry in entries {
        let line = serde_json::to_string(&entry).map_err(|error| error.to_string())?;
        writeln!(file, "{line}").map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn usage_log_path() -> PathBuf {
    state::state_root().join("usage-log.jsonl")
}

/// Return only the usage entries belonging to one chat session. Debug exports
/// must never attach the process-wide usage ledger because it can contain
/// metadata from unrelated conversations.
pub(crate) fn session_usage_log(session_id: &str) -> Result<String, String> {
    let content = match fs::read_to_string(usage_log_path()) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error.to_string()),
    };
    Ok(filter_usage_log_for_session(&content, session_id))
}

fn filter_usage_log_for_session(content: &str, session_id: &str) -> String {
    let mut filtered = String::new();
    for line in content.lines() {
        let Ok(entry) = serde_json::from_str::<UsageLogEntry>(line) else {
            continue;
        };
        if entry.session_id == session_id {
            filtered.push_str(line);
            filtered.push('\n');
        }
    }
    filtered
}

fn has_billable_tokens(usage: &TokenUsage) -> bool {
    usage.input_tokens > 0
        || usage.output_tokens > 0
        || usage.cache_creation_input_tokens > 0
        || usage.cache_read_input_tokens > 0
}

fn default_usage_role() -> String {
    "executor".to_string()
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "tests/usage_log.rs"]
mod tests;
