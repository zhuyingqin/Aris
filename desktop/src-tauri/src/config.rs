//! Read/write `~/.config/aris/config.json` for the Settings page.
//!
//! Operates on the raw JSON object (snake_case keys, matching aris-cli's
//! `ArisConfig`) so unmodelled fields (e.g. `meta_logging`) survive a round trip,
//! and so the schema can't drift. API keys are masked in the normal view; raw
//! values are exposed only through the explicit, allow-listed reveal command.

use api::AuthSource;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::state;

pub(crate) fn load_object() -> Map<String, Value> {
    std::fs::read_to_string(state::config_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn get_str(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn mask(key: &str) -> String {
    let chars: Vec<char> = key.trim().chars().collect();
    if chars.len() > 8 {
        let head: String = chars[..4].iter().collect();
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("{head}…{tail}")
    } else if chars.is_empty() {
        String::new()
    } else {
        "••••".to_string()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedSummary {
    pub provider: String,
    pub model: String,
    pub base_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub app_version: String,
    pub config_path: String,
    pub executor_provider: Option<String>,
    pub executor_model: Option<String>,
    pub executor_base_url: Option<String>,
    pub has_executor_key: bool,
    pub executor_key_masked: Option<String>,
    pub reviewer_provider: Option<String>,
    pub reviewer_model: Option<String>,
    pub reviewer_base_url: Option<String>,
    pub has_reviewer_key: bool,
    pub reviewer_key_masked: Option<String>,
    pub has_scopus_key: bool,
    pub scopus_key_masked: Option<String>,
    pub language: Option<String>,
    pub memory_write_approval: bool,
    /// Providers that passed a connection test — surfaced so the Settings list
    /// can show every configured provider (not just the executor/reviewer
    /// slots). Keys are never included.
    pub verified_executors: Vec<VerifiedSummary>,
}

fn build_view(obj: &Map<String, Value>) -> ConfigView {
    let exec_key = get_str(obj, "executor_api_key").filter(|k| !k.is_empty());
    let rev_key = get_str(obj, "reviewer_api_key").filter(|k| !k.is_empty());
    let scopus_key = get_str(obj, "scopus_api_key").filter(|k| !k.is_empty());
    ConfigView {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        config_path: state::config_path().display().to_string(),
        executor_provider: get_str(obj, "executor_provider"),
        executor_model: get_str(obj, "executor_model"),
        executor_base_url: get_str(obj, "executor_base_url"),
        has_executor_key: exec_key.is_some(),
        executor_key_masked: exec_key.as_deref().map(mask),
        reviewer_provider: get_str(obj, "reviewer_provider"),
        reviewer_model: get_str(obj, "reviewer_model"),
        reviewer_base_url: get_str(obj, "reviewer_base_url"),
        has_reviewer_key: rev_key.is_some(),
        reviewer_key_masked: rev_key.as_deref().map(mask),
        has_scopus_key: scopus_key.is_some(),
        scopus_key_masked: scopus_key.as_deref().map(mask),
        language: get_str(obj, "language"),
        memory_write_approval: obj
            .get("memory_write_approval")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        verified_executors: read_verified(obj)
            .into_iter()
            .map(|entry| VerifiedSummary {
                provider: entry.provider,
                model: entry.model,
                base_url: entry.base_url,
            })
            .collect(),
    }
}

#[tauri::command]
pub fn config_get() -> ConfigView {
    build_view(&load_object())
}

#[tauri::command]
pub fn config_secret_get(kind: String) -> Result<Option<String>, String> {
    let key = match kind.as_str() {
        "executorApiKey" | "executor_api_key" => "executor_api_key",
        "reviewerApiKey" | "reviewer_api_key" => "reviewer_api_key",
        "scopusApiKey" | "scopus_api_key" => "scopus_api_key",
        _ => return Err(format!("Unsupported secret field: {kind}")),
    };
    Ok(get_non_empty(&load_object(), key))
}

fn save_object(obj: &Map<String, Value>) -> Result<(), String> {
    let path = state::config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json =
        serde_json::to_string_pretty(&Value::Object(obj.clone())).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

// ── Verified executor registry ──────────────────────────────────────────────
//
// Every executor config that passes the Settings "Test" is recorded here so the
// Chat header dropdown can offer only models known to actually work. An entry
// carries everything needed to *use* that model — provider, model id, base URL
// and the key that passed — because verified models can live on different
// endpoints with different keys, and switching must restore the full config.

#[derive(Clone)]
pub(crate) struct VerifiedExecutor {
    pub provider: String,
    pub model: String,
    /// Empty string means "provider default endpoint".
    pub base_url: String,
    pub api_key: String,
}

fn parse_verified(value: &Value) -> Option<VerifiedExecutor> {
    let obj = value.as_object()?;
    let model = obj.get("model").and_then(Value::as_str)?.trim().to_string();
    if model.is_empty() {
        return None;
    }
    Some(VerifiedExecutor {
        provider: obj
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        model,
        base_url: obj
            .get("base_url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        api_key: obj
            .get("api_key")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

fn read_verified(obj: &Map<String, Value>) -> Vec<VerifiedExecutor> {
    obj.get("verified_executors")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_verified).collect())
        .unwrap_or_default()
}

fn write_verified(obj: &mut Map<String, Value>, list: &[VerifiedExecutor]) {
    let arr = list
        .iter()
        .map(|entry| {
            let mut item = Map::new();
            item.insert(
                "provider".to_string(),
                Value::String(entry.provider.clone()),
            );
            item.insert("model".to_string(), Value::String(entry.model.clone()));
            item.insert(
                "base_url".to_string(),
                Value::String(entry.base_url.clone()),
            );
            item.insert("api_key".to_string(), Value::String(entry.api_key.clone()));
            Value::Object(item)
        })
        .collect();
    obj.insert("verified_executors".to_string(), Value::Array(arr));
}

/// Insert or update by `(provider, model, base_url)`; re-verifying refreshes the
/// stored key without creating a duplicate entry.
fn upsert_verified(list: &mut Vec<VerifiedExecutor>, entry: VerifiedExecutor) {
    if let Some(existing) = list.iter_mut().find(|item| {
        item.provider == entry.provider
            && item.model == entry.model
            && item.base_url == entry.base_url
    }) {
        existing.api_key = entry.api_key;
    } else {
        list.push(entry);
    }
}

/// Record a verified executor after a successful Settings test. No-op if the
/// model id or key is empty (an entry without a key could not be switched to).
pub(crate) fn record_verified_executor(
    provider: &str,
    model: &str,
    base_url: Option<&str>,
    api_key: &str,
) -> Result<(), String> {
    let model = model.trim();
    let api_key = api_key.trim();
    if model.is_empty() || api_key.is_empty() {
        return Ok(());
    }
    let mut obj = load_object();
    let mut list = read_verified(&obj);
    upsert_verified(
        &mut list,
        VerifiedExecutor {
            provider: provider.trim().to_string(),
            model: model.to_string(),
            base_url: base_url.unwrap_or("").trim().to_string(),
            api_key: api_key.to_string(),
        },
    );
    write_verified(&mut obj, &list);
    save_object(&obj)
}

/// `(provider, model, base_url)` for each verified executor — keys are never
/// returned to the frontend.
pub(crate) fn verified_executor_summaries() -> Vec<(String, String, String)> {
    read_verified(&load_object())
        .into_iter()
        .map(|entry| (entry.provider, entry.model, entry.base_url))
        .collect()
}

const DEEPSEEK_EXECUTOR_MODEL: &str = "deepseek-v4-pro";
const DEEPSEEK_ANTHROPIC_BASE_URL: &str = "https://api.deepseek.com/anthropic";

fn value_contains(obj: &Map<String, Value>, key: &str, needle: &str) -> bool {
    obj.get(key)
        .and_then(Value::as_str)
        .map(|value| value.to_ascii_lowercase().contains(needle))
        .unwrap_or(false)
}

fn config_has_deepseek_executor(obj: &Map<String, Value>) -> bool {
    value_contains(obj, "executor_provider", "deepseek")
        || value_contains(obj, "executor_model", "deepseek")
        || value_contains(obj, "executor_base_url", "deepseek")
}

fn config_has_deepseek_reviewer(obj: &Map<String, Value>) -> bool {
    value_contains(obj, "reviewer_provider", "deepseek")
        || value_contains(obj, "reviewer_model", "deepseek")
        || value_contains(obj, "reviewer_base_url", "deepseek")
}

fn deepseek_executor_key(obj: &Map<String, Value>) -> Option<String> {
    if config_has_deepseek_executor(obj) {
        if let Some(key) = get_non_empty(obj, "executor_api_key") {
            return Some(key);
        }
    }
    if config_has_deepseek_reviewer(obj) {
        if let Some(key) = get_non_empty(obj, "reviewer_api_key") {
            return Some(key);
        }
    }
    std::env::var("DEEPSEEK_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
}

fn apply_deepseek_executor(obj: &mut Map<String, Value>, key: String) {
    obj.insert(
        "executor_provider".to_string(),
        Value::String("anthropic-compat".to_string()),
    );
    obj.insert(
        "executor_model".to_string(),
        Value::String(DEEPSEEK_EXECUTOR_MODEL.to_string()),
    );
    obj.insert(
        "executor_base_url".to_string(),
        Value::String(DEEPSEEK_ANTHROPIC_BASE_URL.to_string()),
    );
    obj.insert("executor_api_key".to_string(), Value::String(key));
}

fn apply_verified_executor(obj: &mut Map<String, Value>, entry: VerifiedExecutor) {
    obj.insert(
        "executor_provider".to_string(),
        Value::String(entry.provider),
    );
    obj.insert("executor_model".to_string(), Value::String(entry.model));
    if entry.base_url.is_empty() {
        obj.remove("executor_base_url");
    } else {
        obj.insert(
            "executor_base_url".to_string(),
            Value::String(entry.base_url),
        );
    }
    obj.insert("executor_api_key".to_string(), Value::String(entry.api_key));
}

/// Return a config object with `model` selected as executor, without saving it.
/// The model must be the current executor, a verified executor, or a built-in
/// preset backed by an already configured key.
pub(crate) fn executor_object_for_model(model: &str) -> Result<Option<Map<String, Value>>, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("model id must not be empty".to_string());
    }
    let mut obj = load_object();
    if get_non_empty(&obj, "executor_model").as_deref() == Some(model) {
        return Ok(Some(obj));
    }
    if let Some(entry) = read_verified(&obj)
        .into_iter()
        .find(|item| item.model == model)
    {
        apply_verified_executor(&mut obj, entry);
        return Ok(Some(obj));
    }
    if model == DEEPSEEK_EXECUTOR_MODEL {
        let Some(key) = deepseek_executor_key(&obj) else {
            return Err(
                "DeepSeek API key is not configured. Add DeepSeek in Settings first.".to_string(),
            );
        };
        apply_deepseek_executor(&mut obj, key);
        return Ok(Some(obj));
    }
    Ok(None)
}

/// Built-in executor choices backed by keys already present in config/env.
/// Keys are never returned to the frontend.
pub(crate) fn builtin_executor_summaries() -> Vec<(String, String, String)> {
    let obj = load_object();
    let mut out = Vec::new();
    if deepseek_executor_key(&obj).is_some() {
        out.push((
            "anthropic-compat".to_string(),
            DEEPSEEK_EXECUTOR_MODEL.to_string(),
            DEEPSEEK_ANTHROPIC_BASE_URL.to_string(),
        ));
    }
    out
}

/// Restore the full executor config of a verified model. Returns `Ok(false)`
/// when no verified entry matches the model id (caller decides how to react).
pub(crate) fn switch_to_verified_executor(model: &str) -> Result<bool, String> {
    let model = model.trim();
    let mut obj = load_object();
    let Some(entry) = read_verified(&obj)
        .into_iter()
        .find(|item| item.model == model)
    else {
        return Ok(false);
    };
    apply_verified_executor(&mut obj, entry);
    save_object(&obj)?;
    Ok(true)
}

/// Switch to a built-in executor preset when a usable key already exists.
pub(crate) fn switch_to_builtin_executor(model: &str) -> Result<bool, String> {
    let model = model.trim();
    if model != DEEPSEEK_EXECUTOR_MODEL {
        return Ok(false);
    }
    let mut obj = load_object();
    let Some(key) = deepseek_executor_key(&obj) else {
        return Err(
            "DeepSeek API key is not configured. Add DeepSeek in Settings first.".to_string(),
        );
    };
    apply_deepseek_executor(&mut obj, key.clone());
    save_object(&obj)?;
    let _ = record_verified_executor(
        "anthropic-compat",
        DEEPSEEK_EXECUTOR_MODEL,
        Some(DEEPSEEK_ANTHROPIC_BASE_URL),
        &key,
    );
    Ok(true)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPatch {
    pub executor_provider: Option<String>,
    pub executor_model: Option<String>,
    pub executor_base_url: Option<String>,
    pub executor_api_key: Option<String>,
    pub reviewer_provider: Option<String>,
    pub reviewer_model: Option<String>,
    pub reviewer_base_url: Option<String>,
    pub reviewer_api_key: Option<String>,
    pub scopus_api_key: Option<String>,
    pub language: Option<String>,
    pub memory_write_approval: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigTestDetail {
    pub ok: bool,
    pub label: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigTestResult {
    pub ok: bool,
    pub message: String,
    pub executor: ConfigTestDetail,
    pub reviewer: Option<ConfigTestDetail>,
}

/// `Some(non-empty)` sets the key, `Some("")` clears it, `None` leaves it.
fn set_or_clear(obj: &mut Map<String, Value>, key: &str, value: Option<String>) {
    match value {
        Some(v) if v.is_empty() => {
            obj.remove(key);
        }
        Some(v) => {
            obj.insert(key.to_string(), Value::String(v));
        }
        None => {}
    }
}

/// Secrets are never wiped by a blank field — only a non-empty value replaces.
fn set_secret(obj: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(v) = value {
        if !v.is_empty() {
            obj.insert(key.to_string(), Value::String(v));
        }
    }
}

fn apply_patch(obj: &mut Map<String, Value>, patch: ConfigPatch) {
    let reviewer_disabled = patch.reviewer_provider.as_deref() == Some("");

    set_or_clear(obj, "executor_provider", patch.executor_provider);
    set_or_clear(obj, "executor_model", patch.executor_model);
    set_or_clear(obj, "executor_base_url", patch.executor_base_url);
    set_or_clear(obj, "reviewer_provider", patch.reviewer_provider);
    set_or_clear(obj, "reviewer_model", patch.reviewer_model);
    set_or_clear(obj, "reviewer_base_url", patch.reviewer_base_url);
    set_or_clear(obj, "language", patch.language);
    if let Some(enabled) = patch.memory_write_approval {
        obj.insert("memory_write_approval".to_string(), Value::Bool(enabled));
    }

    set_secret(obj, "executor_api_key", patch.executor_api_key);
    set_secret(obj, "reviewer_api_key", patch.reviewer_api_key);
    set_secret(obj, "scopus_api_key", patch.scopus_api_key);

    if reviewer_disabled {
        for key in [
            "reviewer_provider",
            "reviewer_model",
            "reviewer_base_url",
            "reviewer_api_key",
        ] {
            obj.remove(key);
        }
    }
}

#[tauri::command]
pub fn config_set(patch: ConfigPatch) -> Result<ConfigView, String> {
    let mut obj = load_object();
    apply_patch(&mut obj, patch);
    save_object(&obj)?;
    apply_reviewer_environment_from(&obj, true);
    Ok(build_view(&obj))
}

pub(crate) fn apply_reviewer_environment(force: bool) {
    let obj = load_object();
    apply_reviewer_environment_from(&obj, force);
}

fn set_env_if_allowed(key: &str, value: Option<String>, force: bool) {
    let Some(value) = value.filter(|item| !item.trim().is_empty()) else {
        return;
    };
    if force || std::env::var(key).is_err() {
        std::env::set_var(key, value);
    }
}

fn clear_forced_reviewer_environment(force: bool) {
    if !force {
        return;
    }
    for key in [
        "ARIS_REVIEWER_PROVIDER",
        "ARIS_REVIEWER_MODEL",
        "ARIS_REVIEWER_BASE_URL",
        "ARIS_REVIEWER_AUTH_TOKEN",
    ] {
        std::env::remove_var(key);
    }
}

fn apply_reviewer_environment_from(obj: &Map<String, Value>, force: bool) {
    clear_forced_reviewer_environment(force);
    let provider = get_non_empty(obj, "reviewer_provider");
    let key = get_non_empty(obj, "reviewer_api_key");

    if force && provider.is_none() {
        std::env::set_var("ARIS_REVIEWER_PROVIDER", "none");
    }
    set_env_if_allowed("ARIS_REVIEWER_PROVIDER", provider.clone(), force);
    set_env_if_allowed(
        "ARIS_REVIEWER_MODEL",
        get_non_empty(obj, "reviewer_model"),
        force,
    );
    set_env_if_allowed(
        "ARIS_REVIEWER_BASE_URL",
        get_non_empty(obj, "reviewer_base_url"),
        force,
    );
    set_env_if_allowed("ARIS_LANGUAGE", get_non_empty(obj, "language"), force);
    if force || std::env::var("ARIS_MEMORY_WRITE_APPROVAL").is_err() {
        let enabled = obj
            .get("memory_write_approval")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        std::env::set_var(
            "ARIS_MEMORY_WRITE_APPROVAL",
            if enabled { "true" } else { "false" },
        );
    }
    // Literature kernel tools (Scopus engine) read this from the environment.
    set_env_if_allowed(
        "SCOPUS_API_KEY",
        get_non_empty(obj, "scopus_api_key"),
        force,
    );

    match provider.as_deref() {
        Some("gemini") => set_env_if_allowed("GEMINI_API_KEY", key, force),
        Some("openai") => set_env_if_allowed("OPENAI_API_KEY", key, force),
        Some("glm") => set_env_if_allowed("GLM_API_KEY", key, force),
        Some("minimax") => set_env_if_allowed("MINIMAX_API_KEY", key, force),
        Some("kimi") => set_env_if_allowed("KIMI_API_KEY", key, force),
        Some("deepseek") => {
            set_env_if_allowed("DEEPSEEK_API_KEY", key.clone(), force);
            set_env_if_allowed("ARIS_REVIEWER_AUTH_TOKEN", key, force);
        }
        Some("anthropic-compat" | "custom") => {
            set_env_if_allowed("ARIS_REVIEWER_AUTH_TOKEN", key, force);
        }
        _ => {}
    }
}

pub(crate) fn set_memory_write_approval(enabled: bool) -> Result<(), String> {
    let mut obj = load_object();
    obj.insert("memory_write_approval".to_string(), Value::Bool(enabled));
    let path = state::config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(
        path,
        serde_json::to_string_pretty(&Value::Object(obj)).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    std::env::set_var(
        "ARIS_MEMORY_WRITE_APPROVAL",
        if enabled { "true" } else { "false" },
    );
    Ok(())
}

fn normalized_base_url(value: Option<String>, default_value: &str) -> String {
    let trimmed = value
        .as_deref()
        .unwrap_or(default_value)
        .trim()
        .trim_end_matches('/');
    let trimmed = trimmed
        .strip_suffix("/chat/completions")
        .unwrap_or(trimmed)
        .strip_suffix("/messages")
        .unwrap_or(trimmed)
        .strip_suffix("/models")
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    if trimmed.is_empty() {
        default_value.to_string()
    } else {
        trimmed.to_string()
    }
}

fn openai_default_base(provider: &str, model: &str) -> &'static str {
    match provider {
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai",
        "glm" => "https://open.bigmodel.cn/api/paas/v4",
        "minimax" => "https://api.minimaxi.com/v1",
        "kimi" => "https://api.moonshot.cn/v1",
        "deepseek" => "https://api.deepseek.com/v1",
        _ if model.contains("gemini") => "https://generativelanguage.googleapis.com/v1beta/openai",
        _ if model.contains("glm") || model.contains("GLM") => {
            "https://open.bigmodel.cn/api/paas/v4"
        }
        _ if model.starts_with("MiniMax") || model.starts_with("minimax") => {
            "https://api.minimaxi.com/v1"
        }
        _ if model.contains("kimi") || model.contains("moonshot") => "https://api.moonshot.cn/v1",
        _ if model.contains("deepseek") => "https://api.deepseek.com/v1",
        _ => "https://api.openai.com/v1",
    }
}

fn models_url(base_url: &str) -> String {
    format!("{}/models", base_url.trim_end_matches('/'))
}

fn anthropic_messages_url(base_url: &str) -> String {
    let base_url = base_url.trim_end_matches('/');
    if base_url.ends_with("/v1") {
        format!("{base_url}/messages")
    } else {
        format!("{base_url}/v1/messages")
    }
}

fn get_non_empty(obj: &Map<String, Value>, key: &str) -> Option<String> {
    get_str(obj, key).filter(|value| !value.trim().is_empty())
}

async fn check_response(label: &str, request: reqwest::RequestBuilder) -> Result<String, String> {
    let response = request
        .send()
        .await
        .map_err(|error| format!("{label}: request failed: {error}"))?;
    let status = response.status();
    if status.is_success() {
        return Ok(format!("{label}: connection OK ({status})"));
    }
    let body = response.text().await.unwrap_or_default();
    let body = body.trim();
    if body.is_empty() {
        Err(format!("{label}: endpoint returned {status}"))
    } else {
        let snippet: String = body.chars().take(220).collect();
        Err(format!("{label}: endpoint returned {status}: {snippet}"))
    }
}

async fn test_anthropic(
    label: &str,
    provider: String,
    model: String,
    base_url: String,
    auth: AuthSource,
) -> ConfigTestDetail {
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return ConfigTestDetail {
                ok: false,
                label: label.to_string(),
                provider: Some(provider),
                model: Some(model),
                base_url: Some(base_url),
                message: format!("Could not create HTTP client: {error}"),
            };
        }
    };
    let request = auth
        .apply(client.post(anthropic_messages_url(&base_url)))
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "max_tokens": 1,
            "messages": [
                {
                    "role": "user",
                    "content": "ping"
                }
            ]
        }));
    match check_response(label, request).await {
        Ok(message) => ConfigTestDetail {
            ok: true,
            label: label.to_string(),
            provider: Some(provider),
            model: Some(model),
            base_url: Some(base_url),
            message,
        },
        Err(message) => ConfigTestDetail {
            ok: false,
            label: label.to_string(),
            provider: Some(provider),
            model: Some(model),
            base_url: Some(base_url),
            message,
        },
    }
}

async fn test_openai_compat(
    label: &str,
    provider: String,
    model: String,
    base_url: String,
    api_key: String,
) -> ConfigTestDetail {
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return ConfigTestDetail {
                ok: false,
                label: label.to_string(),
                provider: Some(provider),
                model: Some(model),
                base_url: Some(base_url),
                message: format!("Could not create HTTP client: {error}"),
            };
        }
    };
    let request = client.get(models_url(&base_url)).bearer_auth(api_key);
    match check_response(label, request).await {
        Ok(message) => ConfigTestDetail {
            ok: true,
            label: label.to_string(),
            provider: Some(provider),
            model: Some(model),
            base_url: Some(base_url),
            message,
        },
        Err(message) => ConfigTestDetail {
            ok: false,
            label: label.to_string(),
            provider: Some(provider),
            model: Some(model),
            base_url: Some(base_url),
            message,
        },
    }
}

async fn test_reviewer(obj: &Map<String, Value>) -> Option<ConfigTestDetail> {
    let provider = get_non_empty(obj, "reviewer_provider")?;
    let model = get_non_empty(obj, "reviewer_model").unwrap_or_else(|| "gpt-5.5".to_string());
    let key = match get_non_empty(obj, "reviewer_api_key") {
        Some(key) => key,
        None => {
            return Some(ConfigTestDetail {
                ok: false,
                label: "Reviewer".to_string(),
                provider: Some(provider),
                model: Some(model),
                base_url: get_non_empty(obj, "reviewer_base_url"),
                message: "Reviewer API key is missing.".to_string(),
            })
        }
    };
    if provider == "anthropic-compat" || provider == "deepseek" {
        let default_base = if provider == "deepseek" {
            "https://api.deepseek.com/anthropic"
        } else {
            "https://api.anthropic.com"
        };
        let base_url = normalized_base_url(get_non_empty(obj, "reviewer_base_url"), default_base);
        return Some(
            test_anthropic(
                "Reviewer",
                provider,
                model,
                base_url,
                AuthSource::BearerToken(key),
            )
            .await,
        );
    }

    let base_url = normalized_base_url(
        get_non_empty(obj, "reviewer_base_url"),
        openai_default_base(&provider, &model),
    );
    Some(test_openai_compat("Reviewer", provider, model, base_url, key).await)
}

/// Per-provider connection test for the Settings provider cards. The API key is
/// optional: when omitted (the common case — saved keys are never sent to the
/// frontend) it is resolved from the saved config by matching the base URL
/// against the executor / reviewer slots and the verified-executor registry.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestInput {
    pub base_url: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
}

fn norm_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn url_host(url: &str) -> String {
    let lower = url.trim().to_ascii_lowercase();
    let after_scheme = lower.split("://").last().unwrap_or(&lower);
    after_scheme.split('/').next().unwrap_or("").to_string()
}

/// Find a usable key for `base_url`: exact base-URL match first, then a
/// host-level fallback (keys are vendor-wide, so a host match is safe enough).
fn resolve_saved_key(obj: &Map<String, Value>, base_url: &str) -> Option<String> {
    let target = norm_url(base_url);
    let target_host = url_host(base_url);
    let mut candidates: Vec<(String, String)> = Vec::new();
    if let (Some(url), Some(key)) = (
        get_non_empty(obj, "executor_base_url"),
        get_non_empty(obj, "executor_api_key"),
    ) {
        candidates.push((url, key));
    }
    if let (Some(url), Some(key)) = (
        get_non_empty(obj, "reviewer_base_url"),
        get_non_empty(obj, "reviewer_api_key"),
    ) {
        candidates.push((url, key));
    }
    for entry in read_verified(obj) {
        if !entry.base_url.is_empty() {
            candidates.push((entry.base_url, entry.api_key));
        }
    }
    if let Some((_, key)) = candidates.iter().find(|(url, _)| norm_url(url) == target) {
        return Some(key.clone());
    }
    if !target_host.is_empty() {
        if let Some((_, key)) = candidates
            .iter()
            .find(|(url, _)| url_host(url) == target_host)
        {
            return Some(key.clone());
        }
    }
    None
}

fn is_anthropic_url(base_url: &str) -> bool {
    let lower = base_url.to_ascii_lowercase();
    lower.contains("anthropic") || lower.contains("newcli.com") || lower.contains("modelscope.cn")
}

#[tauri::command]
pub async fn provider_test(input: ProviderTestInput) -> Result<ConfigTestDetail, String> {
    let base_url = input.base_url.trim().to_string();
    if base_url.is_empty() {
        return Err("Base URL is required to test this provider.".to_string());
    }
    let obj = load_object();
    let key = input
        .api_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .or_else(|| resolve_saved_key(&obj, &base_url));
    let Some(key) = key else {
        return Err(
            "No API key found for this provider. Open it to paste a key, or set it as executor / reviewer first."
                .to_string(),
        );
    };
    let model = input
        .model
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| "gpt-5.5".to_string());

    if is_anthropic_url(&base_url) {
        let normalized = normalized_base_url(Some(base_url), "https://api.anthropic.com");
        let auth = if normalized
            .to_ascii_lowercase()
            .contains("api.anthropic.com")
        {
            AuthSource::ApiKey(key)
        } else {
            AuthSource::BearerToken(key)
        };
        Ok(test_anthropic("Provider", "anthropic".to_string(), model, normalized, auth).await)
    } else {
        let normalized = normalized_base_url(Some(base_url), "https://api.openai.com/v1");
        Ok(test_openai_compat("Provider", "openai".to_string(), model, normalized, key).await)
    }
}

#[tauri::command]
pub async fn config_test(patch: ConfigPatch) -> Result<ConfigTestResult, String> {
    let mut obj = load_object();
    apply_patch(&mut obj, patch);

    let executor = match aris_chat::resolve_settings_executor_config(&obj) {
        Ok((model, provider, aris_chat::ChatExecutorConfig::Anthropic { auth, base_url, .. })) => {
            test_anthropic(
                "Executor",
                provider,
                model,
                normalized_base_url(Some(base_url), "https://api.anthropic.com"),
                auth,
            )
            .await
        }
        Ok((
            model,
            provider,
            aris_chat::ChatExecutorConfig::OpenAiCompatible { api_key, base_url },
        )) => {
            test_openai_compat(
                "Executor",
                provider,
                model,
                normalized_base_url(Some(base_url), "https://api.openai.com/v1"),
                api_key,
            )
            .await
        }
        Err(message) => ConfigTestDetail {
            ok: false,
            label: "Executor".to_string(),
            provider: get_non_empty(&obj, "executor_provider"),
            model: get_non_empty(&obj, "executor_model"),
            base_url: get_non_empty(&obj, "executor_base_url"),
            message,
        },
    };

    // Record any executor that passes so the Chat header dropdown can offer it.
    // Persists into the saved config without committing the rest of the unsaved
    // form — only the verified registry is touched.
    if executor.ok {
        if let (Some(provider), Some(model)) = (executor.provider.clone(), executor.model.clone()) {
            if let Some(key) = get_non_empty(&obj, "executor_api_key") {
                let _ =
                    record_verified_executor(&provider, &model, executor.base_url.as_deref(), &key);
            }
        }
    }

    let reviewer = test_reviewer(&obj).await;
    let reviewer_ok = reviewer.as_ref().map(|detail| detail.ok).unwrap_or(true);
    let ok = executor.ok && reviewer_ok;
    let message = if ok {
        "Connection test passed.".to_string()
    } else {
        "Connection test failed. Check the details below.".to_string()
    };
    Ok(ConfigTestResult {
        ok,
        message,
        executor,
        reviewer,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        apply_reviewer_environment_from, deepseek_executor_key, read_verified, upsert_verified,
        write_verified, VerifiedExecutor,
    };
    use serde_json::{Map, Value};
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn entry(provider: &str, model: &str, base_url: &str, key: &str) -> VerifiedExecutor {
        VerifiedExecutor {
            provider: provider.to_string(),
            model: model.to_string(),
            base_url: base_url.to_string(),
            api_key: key.to_string(),
        }
    }

    #[test]
    fn upsert_refreshes_key_without_duplicating_same_endpoint() {
        let mut list = vec![entry(
            "openai",
            "MiniMax-M3",
            "https://api.minimaxi.com/v1",
            "k1",
        )];
        // Same (provider, model, base_url) → update key in place.
        upsert_verified(
            &mut list,
            entry("openai", "MiniMax-M3", "https://api.minimaxi.com/v1", "k2"),
        );
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].api_key, "k2");

        // Same model id, different endpoint → distinct entry.
        upsert_verified(
            &mut list,
            entry("openai", "MiniMax-M3", "https://other.example/v1", "k3"),
        );
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn verified_registry_round_trips_through_json() {
        let mut obj = Map::new();
        let list = vec![
            entry("anthropic", "claude-opus-4-7", "", "ka"),
            entry("openai", "gpt-5.5", "https://api.openai.com/v1", "kb"),
        ];
        write_verified(&mut obj, &list);
        let parsed = read_verified(&obj);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].model, "claude-opus-4-7");
        assert_eq!(parsed[0].base_url, "");
        assert_eq!(parsed[1].api_key, "kb");
    }

    #[test]
    fn read_verified_skips_entries_without_a_model() {
        let mut obj = Map::new();
        obj.insert(
            "verified_executors".to_string(),
            Value::Array(vec![
                serde_json::json!({ "provider": "openai", "base_url": "x", "api_key": "k" }),
                serde_json::json!({ "provider": "openai", "model": "gpt-5.5", "api_key": "k" }),
            ]),
        );
        let parsed = read_verified(&obj);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].model, "gpt-5.5");
    }

    #[test]
    fn deepseek_executor_key_can_reuse_reviewer_key() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var("DEEPSEEK_API_KEY");

        let mut obj = Map::new();
        obj.insert(
            "reviewer_provider".to_string(),
            Value::String("deepseek".to_string()),
        );
        obj.insert(
            "reviewer_model".to_string(),
            Value::String("deepseek-v4-pro".to_string()),
        );
        obj.insert(
            "reviewer_api_key".to_string(),
            Value::String("reviewer-token".to_string()),
        );

        assert_eq!(
            deepseek_executor_key(&obj).as_deref(),
            Some("reviewer-token")
        );
    }

    #[test]
    fn forced_reviewer_environment_marks_reviewer_disabled_after_clearing() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::set_var("ARIS_REVIEWER_PROVIDER", "openai");
        std::env::set_var("ARIS_REVIEWER_MODEL", "gpt-5.5");
        std::env::set_var("ARIS_REVIEWER_BASE_URL", "https://old.example/v1");
        std::env::set_var("ARIS_REVIEWER_AUTH_TOKEN", "old-token");

        apply_reviewer_environment_from(&Map::new(), true);

        assert_eq!(
            std::env::var("ARIS_REVIEWER_PROVIDER").as_deref(),
            Ok("none")
        );
        assert!(std::env::var("ARIS_REVIEWER_MODEL").is_err());
        assert!(std::env::var("ARIS_REVIEWER_BASE_URL").is_err());
        assert!(std::env::var("ARIS_REVIEWER_AUTH_TOKEN").is_err());
        std::env::remove_var("ARIS_REVIEWER_PROVIDER");
    }

    #[test]
    fn forced_reviewer_environment_sets_current_values_after_clearing() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::set_var("ARIS_REVIEWER_PROVIDER", "openai");
        std::env::set_var("ARIS_REVIEWER_MODEL", "gpt-5.5");
        std::env::set_var("ARIS_REVIEWER_AUTH_TOKEN", "old-token");

        let mut obj = Map::new();
        obj.insert(
            "reviewer_provider".to_string(),
            Value::String("deepseek".to_string()),
        );
        obj.insert(
            "reviewer_model".to_string(),
            Value::String("deepseek-v4-pro".to_string()),
        );
        obj.insert(
            "reviewer_base_url".to_string(),
            Value::String("https://api.deepseek.com/anthropic".to_string()),
        );
        obj.insert(
            "reviewer_api_key".to_string(),
            Value::String("new-token".to_string()),
        );

        apply_reviewer_environment_from(&obj, true);

        assert_eq!(
            std::env::var("ARIS_REVIEWER_PROVIDER").as_deref(),
            Ok("deepseek")
        );
        assert_eq!(
            std::env::var("ARIS_REVIEWER_MODEL").as_deref(),
            Ok("deepseek-v4-pro")
        );
        assert_eq!(
            std::env::var("ARIS_REVIEWER_BASE_URL").as_deref(),
            Ok("https://api.deepseek.com/anthropic")
        );
        assert_eq!(
            std::env::var("ARIS_REVIEWER_AUTH_TOKEN").as_deref(),
            Ok("new-token")
        );

        for key in [
            "ARIS_REVIEWER_PROVIDER",
            "ARIS_REVIEWER_MODEL",
            "ARIS_REVIEWER_BASE_URL",
            "ARIS_REVIEWER_AUTH_TOKEN",
            "DEEPSEEK_API_KEY",
        ] {
            std::env::remove_var(key);
        }
    }
}
