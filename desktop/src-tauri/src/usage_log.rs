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
}

pub fn append_turn_usage(
    session_id: &str,
    role: &str,
    model: &str,
    provider: &str,
    server: &str,
    usages: &[TokenUsage],
) -> Result<(), String> {
    let entries = usages
        .iter()
        .copied()
        .filter(has_billable_tokens)
        .map(|usage| UsageLogEntry {
            created_at: now_epoch_secs(),
            session_id: session_id.to_string(),
            role: role.to_string(),
            server: server.to_string(),
            model: model.to_string(),
            provider: provider.to_string(),
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
        })
        .collect::<Vec<_>>();
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
