//! Shared utilities for OpenAI-compatible provider integration.
//!
//! Provides URL normalization, dynamic `/models` endpoint discovery,
//! and model selection helpers used by both the executor and reviewer
//! configuration paths. Designed to be mockable for offline CI testing
//! (no real `api.openai.com` calls in tests).

use std::collections::HashSet;

use reqwest::Client;
use serde_json::Value;

use crate::input::SelectItem;

const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAIModelInfo {
    pub id: String,
    pub owned_by: Option<String>,
}

/// Returns `true` if the given provider string routes through the
/// OpenAI-compatible executor/reviewer path.
#[allow(dead_code)] // used in PR C (shared routing)
pub fn is_openai_compat_provider(provider: &str) -> bool {
    matches!(provider, "openai" | "custom")
}

/// Normalize a base URL to a clean `/v1`-style root suitable for appending
/// `/chat/completions` or `/models`. Strips known suffixes and trailing
/// slashes so callers can safely `format!("{base}/models")`.
pub fn normalize_openai_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return DEFAULT_OPENAI_BASE_URL.to_string();
    }

    let without_chat = trimmed.strip_suffix("/chat/completions").unwrap_or(trimmed);
    let without_models = without_chat.strip_suffix("/models").unwrap_or(without_chat);
    without_models.trim_end_matches('/').to_string()
}

pub fn models_url(base_url: &str) -> String {
    format!("{}/models", normalize_openai_base_url(base_url))
}

/// Derive a human-readable provider label from the provider string and base
/// URL. Used in the startup banner and status displays for custom providers.
#[allow(dead_code)] // used in PR C (shared routing)
pub fn openai_provider_label(provider: Option<&str>, base_url: &str) -> &'static str {
    if provider == Some("custom") {
        return "Custom OpenAI-compatible";
    }

    let normalized = normalize_openai_base_url(base_url);
    if normalized.contains("deepseek") {
        "DeepSeek"
    } else if normalized.contains("bigmodel") {
        "GLM"
    } else if normalized.contains("minimax") {
        "MiniMax"
    } else if normalized.contains("moonshot") {
        "Moonshot"
    } else if normalized.contains("dashscope") || normalized.contains("qwen") {
        "Qwen"
    } else if normalized.contains("generativelanguage.googleapis") {
        "Gemini"
    } else {
        "OpenAI"
    }
}

/// Convert a list of `OpenAIModelInfo` into `SelectItem`s for the REPL
/// interactive selection menu. Marks the entry matching `current_model`.
pub fn model_select_items(models: &[OpenAIModelInfo], current_model: &str) -> Vec<SelectItem> {
    models
        .iter()
        .map(|model| SelectItem {
            label: model.id.clone(),
            description: model.owned_by.clone().unwrap_or_default(),
            is_current: model.id == current_model,
        })
        .collect()
}

/// Fetch the list of available models from an OpenAI-compatible `/models`
/// endpoint. Uses a one-shot tokio runtime so this can be called from
/// synchronous setup/REPL code.
///
/// Returns a deduplicated list of model IDs sorted by the server's order.
/// Errors are returned as human-readable strings for display in the setup
/// wizard.
pub fn fetch_openai_models(base_url: &str, api_key: &str) -> Result<Vec<OpenAIModelInfo>, String> {
    let base_url = normalize_openai_base_url(base_url);
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API key is required".to_string());
    }

    let runtime = tokio::runtime::Runtime::new()
        .map_err(|error| format!("Failed to start async runtime: {error}"))?;
    runtime.block_on(async move {
        // Bounded timeouts so a bad base URL / TLS stall / half-open connection
        // doesn't hang `/setup` or `/model` indefinitely. 10s connect + 20s
        // total covers slow Chinese proxies without making the interactive
        // wizard feel frozen.
        let client = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|error| format!("Failed to build HTTP client: {error}"))?;
        let response = client
            .get(models_url(&base_url))
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|error| format!("Failed to fetch /models: {error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("Failed to fetch /models ({status}): {body}"));
        }

        let payload = response
            .json::<Value>()
            .await
            .map_err(|error| format!("Failed to parse /models response: {error}"))?;
        parse_openai_models(payload)
    })
}

fn parse_openai_models(payload: Value) -> Result<Vec<OpenAIModelInfo>, String> {
    let items = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Unexpected /models response: {payload}"))?;

    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        let owned_by = item
            .get("owned_by")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        models.push(OpenAIModelInfo {
            id: id.to_string(),
            owned_by,
        });
    }

    if models.is_empty() {
        return Err("The /models endpoint returned no usable model ids".to_string());
    }

    Ok(models)
}

#[cfg(test)]
#[path = "tests/openai_compat.rs"]
mod tests;
