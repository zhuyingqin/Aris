use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use runtime::{pricing_for_model, ModelPricing, TokenUsage};
use serde::{Deserialize, Serialize};

use crate::state;

static USAGE_LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLogEntry {
    pub created_at: u64,
    pub session_id: String,
    #[serde(default)]
    pub server: String,
    pub model: String,
    pub provider: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_creation_input_tokens: u32,
    pub cache_read_input_tokens: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucketView {
    pub server: String,
    pub model: String,
    pub provider: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub prompt_tokens: u64,
    pub total_tokens: u64,
    pub estimated_cost_usd: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageServerBucketView {
    pub server: String,
    pub provider: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub prompt_tokens: u64,
    pub total_tokens: u64,
    pub estimated_cost_usd: f64,
    pub by_model: Vec<UsageBucketView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLogView {
    pub created_at: u64,
    pub session_id: String,
    pub server: String,
    pub model: String,
    pub provider: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_creation_input_tokens: u32,
    pub cache_read_input_tokens: u32,
    pub prompt_tokens: u32,
    pub total_tokens: u32,
    pub estimated_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryView {
    pub log_path: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub prompt_tokens: u64,
    pub total_tokens: u64,
    pub estimated_cost_usd: f64,
    pub unpriced_requests: u64,
    pub by_server: Vec<UsageServerBucketView>,
    pub by_model: Vec<UsageBucketView>,
    pub recent: Vec<UsageLogView>,
}

impl Default for UsageSummaryView {
    fn default() -> Self {
        Self {
            log_path: usage_log_path().display().to_string(),
            requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            prompt_tokens: 0,
            total_tokens: 0,
            estimated_cost_usd: 0.0,
            unpriced_requests: 0,
            by_server: Vec::new(),
            by_model: Vec::new(),
            recent: Vec::new(),
        }
    }
}

pub fn append_turn_usage(
    session_id: &str,
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

#[tauri::command]
pub fn chat_usage_summary() -> Result<UsageSummaryView, String> {
    summarize_usage_log(&usage_log_path(), 500)
}

fn usage_log_path() -> PathBuf {
    state::state_root().join("usage-log.jsonl")
}

fn summarize_usage_log(path: &Path, recent_limit: usize) -> Result<UsageSummaryView, String> {
    let mut summary = UsageSummaryView {
        log_path: path.display().to_string(),
        ..UsageSummaryView::default()
    };
    let Ok(content) = fs::read_to_string(path) else {
        return Ok(summary);
    };
    let entries = content
        .lines()
        .filter_map(|line| serde_json::from_str::<UsageLogEntry>(line).ok())
        .map(|mut entry| {
            entry.server = normalize_server_label(&entry.server, &entry.provider);
            entry
        })
        .collect::<Vec<_>>();
    let mut buckets: BTreeMap<(String, String, String), UsageBucketView> = BTreeMap::new();
    let mut server_buckets: BTreeMap<(String, String), UsageServerBucketView> = BTreeMap::new();
    let mut recent = Vec::new();

    for entry in &entries {
        let usage = entry.usage();
        let priced = pricing_for_model(&entry.model);
        if priced.is_none() {
            summary.unpriced_requests += 1;
        }
        let estimated_cost_usd = usage
            .estimate_cost_usd_with_pricing(
                priced.unwrap_or_else(ModelPricing::default_sonnet_tier),
            )
            .total_cost_usd();
        let prompt_tokens = u64::from(usage.prompt_tokens());
        let total_tokens = u64::from(usage.total_tokens());

        summary.requests += 1;
        summary.input_tokens += u64::from(entry.input_tokens);
        summary.output_tokens += u64::from(entry.output_tokens);
        summary.cache_creation_input_tokens += u64::from(entry.cache_creation_input_tokens);
        summary.cache_read_input_tokens += u64::from(entry.cache_read_input_tokens);
        summary.prompt_tokens += prompt_tokens;
        summary.total_tokens += total_tokens;
        summary.estimated_cost_usd += estimated_cost_usd;

        let bucket = buckets
            .entry((
                entry.server.clone(),
                entry.model.clone(),
                entry.provider.clone(),
            ))
            .or_insert_with(|| UsageBucketView {
                server: entry.server.clone(),
                model: entry.model.clone(),
                provider: entry.provider.clone(),
                ..UsageBucketView::default()
            });
        bucket.requests += 1;
        bucket.input_tokens += u64::from(entry.input_tokens);
        bucket.output_tokens += u64::from(entry.output_tokens);
        bucket.cache_creation_input_tokens += u64::from(entry.cache_creation_input_tokens);
        bucket.cache_read_input_tokens += u64::from(entry.cache_read_input_tokens);
        bucket.prompt_tokens += prompt_tokens;
        bucket.total_tokens += total_tokens;
        bucket.estimated_cost_usd += estimated_cost_usd;

        let server_bucket = server_buckets
            .entry((entry.server.clone(), entry.provider.clone()))
            .or_insert_with(|| UsageServerBucketView {
                server: entry.server.clone(),
                provider: entry.provider.clone(),
                ..UsageServerBucketView::default()
            });
        server_bucket.requests += 1;
        server_bucket.input_tokens += u64::from(entry.input_tokens);
        server_bucket.output_tokens += u64::from(entry.output_tokens);
        server_bucket.cache_creation_input_tokens += u64::from(entry.cache_creation_input_tokens);
        server_bucket.cache_read_input_tokens += u64::from(entry.cache_read_input_tokens);
        server_bucket.prompt_tokens += prompt_tokens;
        server_bucket.total_tokens += total_tokens;
        server_bucket.estimated_cost_usd += estimated_cost_usd;
    }

    for entry in entries.iter().rev().take(recent_limit) {
        let usage = entry.usage();
        let pricing =
            pricing_for_model(&entry.model).unwrap_or_else(ModelPricing::default_sonnet_tier);
        recent.push(UsageLogView {
            created_at: entry.created_at,
            session_id: entry.session_id.clone(),
            server: entry.server.clone(),
            model: entry.model.clone(),
            provider: entry.provider.clone(),
            input_tokens: entry.input_tokens,
            output_tokens: entry.output_tokens,
            cache_creation_input_tokens: entry.cache_creation_input_tokens,
            cache_read_input_tokens: entry.cache_read_input_tokens,
            prompt_tokens: usage.prompt_tokens(),
            total_tokens: usage.total_tokens(),
            estimated_cost_usd: usage
                .estimate_cost_usd_with_pricing(pricing)
                .total_cost_usd(),
        });
    }
    summary.by_model = buckets.into_values().collect();
    summary
        .by_model
        .sort_by(|left, right| right.total_tokens.cmp(&left.total_tokens));
    let models_by_server = summary.by_model.clone();
    summary.by_server = server_buckets
        .into_values()
        .map(|mut bucket| {
            bucket.by_model = models_by_server
                .iter()
                .filter(|model| model.server == bucket.server && model.provider == bucket.provider)
                .cloned()
                .collect();
            bucket
                .by_model
                .sort_by(|left, right| right.total_tokens.cmp(&left.total_tokens));
            bucket
        })
        .collect();
    summary
        .by_server
        .sort_by(|left, right| right.total_tokens.cmp(&left.total_tokens));
    summary.recent = recent;
    Ok(summary)
}

fn normalize_server_label(server: &str, provider: &str) -> String {
    let server = server.trim().trim_end_matches('/');
    if !server.is_empty() {
        return server.to_string();
    }
    match provider.trim() {
        "anthropic" => "https://api.anthropic.com".to_string(),
        "anthropic-compat" => "Anthropic-compatible".to_string(),
        "openai" => "OpenAI-compatible".to_string(),
        other if !other.is_empty() => other.to_string(),
        _ => "unknown".to_string(),
    }
}

fn has_billable_tokens(usage: &TokenUsage) -> bool {
    usage.input_tokens > 0
        || usage.output_tokens > 0
        || usage.cache_creation_input_tokens > 0
        || usage.cache_read_input_tokens > 0
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

impl UsageLogEntry {
    fn usage(&self) -> TokenUsage {
        TokenUsage {
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_creation_input_tokens: self.cache_creation_input_tokens,
            cache_read_input_tokens: self.cache_read_input_tokens,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_aggregates_usage_by_model() {
        let path = temp_usage_path("aggregate");
        let entries = vec![
            UsageLogEntry {
                created_at: 1,
                session_id: "s1".to_string(),
                server: "https://api.openai.com/v1".to_string(),
                model: "gpt-5.5".to_string(),
                provider: "openai".to_string(),
                input_tokens: 400,
                output_tokens: 80,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 600,
            },
            UsageLogEntry {
                created_at: 2,
                session_id: "s2".to_string(),
                server: "https://api.openai.com/v1".to_string(),
                model: "gpt-5.5".to_string(),
                provider: "openai".to_string(),
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        ];
        write_entries(&path, &entries);

        let summary = summarize_usage_log(&path, 10).expect("summary");

        assert_eq!(summary.requests, 2);
        assert_eq!(summary.prompt_tokens, 1100);
        assert_eq!(summary.total_tokens, 1200);
        assert_eq!(summary.by_model.len(), 1);
        assert_eq!(summary.by_server.len(), 1);
        assert_eq!(summary.by_server[0].server, "https://api.openai.com/v1");
        assert_eq!(summary.by_model[0].cache_read_input_tokens, 600);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn append_skips_empty_usage() {
        let usage = TokenUsage::default();
        assert!(!has_billable_tokens(&usage));
    }

    fn write_entries(path: &Path, entries: &[UsageLogEntry]) {
        let mut content = String::new();
        for entry in entries {
            content.push_str(&serde_json::to_string(entry).expect("json"));
            content.push('\n');
        }
        fs::write(path, content).expect("write usage log");
    }

    fn temp_usage_path(name: &str) -> PathBuf {
        let suffix = now_epoch_secs();
        std::env::temp_dir().join(format!(
            "aris-usage-log-{name}-{}-{suffix}.jsonl",
            std::process::id()
        ))
    }
}
