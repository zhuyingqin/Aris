//! Read/write `~/.config/aris/config.json` for the Settings page.
//!
//! Operates on the raw JSON object (snake_case keys, matching aris-cli's
//! `ArisConfig`) so unmodelled fields (e.g. `meta_logging`) survive a round trip,
//! and so the schema can't drift. API keys are never returned to the frontend —
//! only a masked preview + a "has key" flag.

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
pub struct ConfigView {
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
    pub language: Option<String>,
}

fn build_view(obj: &Map<String, Value>) -> ConfigView {
    let exec_key = get_str(obj, "executor_api_key").filter(|k| !k.is_empty());
    let rev_key = get_str(obj, "reviewer_api_key").filter(|k| !k.is_empty());
    ConfigView {
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
        language: get_str(obj, "language"),
    }
}

#[tauri::command]
pub fn config_get() -> ConfigView {
    build_view(&load_object())
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
    pub language: Option<String>,
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

    set_secret(obj, "executor_api_key", patch.executor_api_key);
    set_secret(obj, "reviewer_api_key", patch.reviewer_api_key);

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

    let path = state::config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json =
        serde_json::to_string_pretty(&Value::Object(obj.clone())).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
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

    set_env_if_allowed("ARIS_REVIEWER_PROVIDER", provider.clone(), force);
    set_env_if_allowed("ARIS_REVIEWER_MODEL", get_non_empty(obj, "reviewer_model"), force);
    set_env_if_allowed(
        "ARIS_REVIEWER_BASE_URL",
        get_non_empty(obj, "reviewer_base_url"),
        force,
    );
    set_env_if_allowed("ARIS_LANGUAGE", get_non_empty(obj, "language"), force);

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
    use super::apply_reviewer_environment_from;
    use serde_json::{Map, Value};
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn forced_reviewer_environment_clears_stale_aris_values() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::set_var("ARIS_REVIEWER_PROVIDER", "openai");
        std::env::set_var("ARIS_REVIEWER_MODEL", "gpt-5.5");
        std::env::set_var("ARIS_REVIEWER_BASE_URL", "https://old.example/v1");
        std::env::set_var("ARIS_REVIEWER_AUTH_TOKEN", "old-token");

        apply_reviewer_environment_from(&Map::new(), true);

        assert!(std::env::var("ARIS_REVIEWER_PROVIDER").is_err());
        assert!(std::env::var("ARIS_REVIEWER_MODEL").is_err());
        assert!(std::env::var("ARIS_REVIEWER_BASE_URL").is_err());
        assert!(std::env::var("ARIS_REVIEWER_AUTH_TOKEN").is_err());
    }

    #[test]
    fn forced_reviewer_environment_sets_current_values_after_clearing() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::set_var("ARIS_REVIEWER_PROVIDER", "openai");
        std::env::set_var("ARIS_REVIEWER_MODEL", "gpt-5.5");
        std::env::set_var("ARIS_REVIEWER_AUTH_TOKEN", "old-token");

        let mut obj = Map::new();
        obj.insert("reviewer_provider".to_string(), Value::String("deepseek".to_string()));
        obj.insert(
            "reviewer_model".to_string(),
            Value::String("deepseek-v4-pro".to_string()),
        );
        obj.insert(
            "reviewer_base_url".to_string(),
            Value::String("https://api.deepseek.com/anthropic".to_string()),
        );
        obj.insert("reviewer_api_key".to_string(), Value::String("new-token".to_string()));

        apply_reviewer_environment_from(&obj, true);

        assert_eq!(std::env::var("ARIS_REVIEWER_PROVIDER").as_deref(), Ok("deepseek"));
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
