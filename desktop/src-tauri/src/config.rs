//! Read/write `~/.config/SomniQ/config.json` for the Settings page.
//!
//! Operates on the raw JSON object (snake_case keys, matching aris-cli's
//! `ArisConfig`) so unmodelled fields (e.g. `meta_logging`) survive a round trip,
//! and so the schema can't drift. API keys are masked in the normal view; raw
//! values are exposed only through the explicit, allow-listed reveal command.

use api::AuthSource;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::Path;

use crate::{newapi, state};

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

fn read_string_list(obj: &Map<String, Value>, key: &str) -> Vec<String> {
    let mut items = obj
        .get(key)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    items.sort();
    items.dedup();
    items
}

pub(crate) fn managed_model_summaries() -> Vec<String> {
    read_string_list(&load_object(), "managed_models")
}

pub(crate) fn persist_managed_models(models: &[String]) -> Result<(), String> {
    let mut models = models
        .iter()
        .map(|model| model.trim())
        .filter(|model| !model.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();

    let mut obj = load_object();
    obj.insert(
        "managed_models".to_string(),
        Value::Array(models.into_iter().map(Value::String).collect()),
    );
    save_object(&obj)
}

fn normalize_openai_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

fn url_match_key(url: &str) -> String {
    url.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn managed_model_contains(obj: &Map<String, Value>, model: &str) -> bool {
    read_string_list(obj, "managed_models")
        .iter()
        .any(|item| item == model)
}

pub(crate) fn managed_executor_base_url(obj: &Map<String, Value>) -> Option<String> {
    get_non_empty(obj, "newapi_executor_base_url").or_else(|| {
        get_non_empty(obj, "newapi_base_url").map(|base| normalize_openai_base_url(&base))
    })
}

fn key_for_matching_base(
    obj: &Map<String, Value>,
    base_key: &str,
    api_key: &str,
    managed_base: &str,
) -> Option<String> {
    let base = get_non_empty(obj, base_key)?;
    if url_match_key(&base) == url_match_key(managed_base) {
        get_non_empty(obj, api_key)
    } else {
        None
    }
}

pub(crate) fn managed_executor_api_key(obj: &Map<String, Value>) -> Option<String> {
    if let Some(key) = get_non_empty(obj, "newapi_executor_api_key") {
        return Some(key);
    }
    let managed_base = managed_executor_base_url(obj)?;
    if let Some(key) =
        key_for_matching_base(obj, "executor_base_url", "executor_api_key", &managed_base)
    {
        return Some(key);
    }
    if let Some(key) =
        key_for_matching_base(obj, "reviewer_base_url", "reviewer_api_key", &managed_base)
    {
        return Some(key);
    }
    read_verified(obj)
        .into_iter()
        .find(|entry| {
            !entry.api_key.trim().is_empty()
                && !entry.base_url.trim().is_empty()
                && url_match_key(&entry.base_url) == url_match_key(&managed_base)
        })
        .map(|entry| entry.api_key)
}

fn managed_executor_credentials(obj: &Map<String, Value>) -> Option<(String, String)> {
    let base_url = managed_executor_base_url(obj)?;
    let api_key = managed_executor_api_key(obj)?;
    Some((base_url, api_key))
}

fn backfill_managed_executor_credentials(obj: &mut Map<String, Value>) -> bool {
    let Some(base_url) = managed_executor_base_url(obj) else {
        return false;
    };
    let api_key = managed_executor_api_key(obj);
    let mut changed = false;

    if get_non_empty(obj, "newapi_executor_base_url").is_none() {
        obj.insert(
            "newapi_executor_base_url".to_string(),
            Value::String(base_url),
        );
        changed = true;
    }
    if get_non_empty(obj, "newapi_executor_api_key").is_none() {
        if let Some(api_key) = api_key {
            obj.insert(
                "newapi_executor_api_key".to_string(),
                Value::String(api_key),
            );
            changed = true;
        }
    }

    changed
}

pub(crate) fn managed_reviewer_key_for(
    obj: &Map<String, Value>,
    provider: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
) -> Option<String> {
    let provider = provider.unwrap_or_default().trim();
    let is_openai_compat = provider == "custom" || provider == "openai";
    if !is_openai_compat {
        return None;
    }
    let matches_model = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| managed_model_contains(obj, value))
        .unwrap_or(false);
    let matches_base = match (base_url, managed_executor_base_url(obj)) {
        (Some(base_url), Some(managed_base)) => {
            url_match_key(base_url) == url_match_key(&managed_base)
        }
        _ => false,
    };
    if matches_model || matches_base {
        managed_executor_api_key(obj)
    } else {
        None
    }
}

pub(crate) fn managed_config_object() -> Result<Map<String, Value>, String> {
    let mut obj = load_object();
    if normalize_managed_model_slots(&mut obj)? {
        save_object(&obj)?;
    }
    Ok(obj)
}

pub(crate) fn current_executor_object() -> Result<Map<String, Value>, String> {
    managed_config_object()
}

pub(crate) fn persist_newapi_executor_credentials(
    base_url: &str,
    api_key: &str,
    token_id: Option<i64>,
) -> Result<(), String> {
    let mut values: Vec<(&str, Value)> = vec![
        (
            "newapi_executor_base_url",
            Value::String(normalize_openai_base_url(base_url)),
        ),
        (
            "newapi_executor_api_key",
            Value::String(api_key.to_string()),
        ),
    ];
    if let Some(token_id) = token_id {
        values.push(("newapi_token_id", Value::Number(token_id.into())));
    }
    persist_values(&values)
}

/// Return a previously-revealed downstream key if it was fetched for the same
/// gateway base URL and token id. new-api masks keys in its token-list
/// response, so callers must `POST /api/token/{id}/key` to reveal the raw
/// value — an endpoint the gateway rate-limits. Reusing the cached key lets
/// periodic account refreshes (see `App.tsx` polling) skip that call entirely
/// once a token has been revealed once, instead of hitting it every cycle.
pub(crate) fn cached_newapi_token_key(base_url: &str, token_id: i64) -> Option<String> {
    let obj = load_object();
    let cached_base = get_non_empty(&obj, "newapi_executor_base_url")?;
    let cached_id = obj.get("newapi_token_id").and_then(Value::as_i64)?;
    if cached_id != token_id {
        return None;
    }
    if url_match_key(&cached_base) != url_match_key(&normalize_openai_base_url(base_url)) {
        return None;
    }
    get_non_empty(&obj, "newapi_executor_api_key")
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
    /// Probed endpoint capability: `responses` | `chat_completions` | empty
    /// when never probed. Keys are still never surfaced.
    pub transport: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub app_version: String,
    pub config_path: String,
    /// Explicitly trusted local Python/Conda environment root or interpreter.
    /// This is a path only; SomniQ never copies or mutates the environment.
    pub python_environment_path: Option<String>,
    pub executor_provider: Option<String>,
    pub executor_model: Option<String>,
    pub executor_base_url: Option<String>,
    /// Endpoint preference for OpenAI-compatible executors:
    /// `auto` | `chat_completions` | `responses`.
    pub executor_transport: Option<String>,
    /// Model used to summarize context on compaction. Empty/absent means "Auto"
    /// (a per-provider default). See `aris_chat::resolve_summarizer_model`.
    pub summarizer_model: Option<String>,
    /// Model used to generate PDF retrieval cards. Empty/absent follows the
    /// active executor model; non-empty values resolve through the verified
    /// executor registry so credentials are never duplicated.
    pub retrieval_card_model: Option<String>,
    pub summarizer_provider: Option<String>,
    pub summarizer_base_url: Option<String>,
    pub has_summarizer_key: bool,
    pub summarizer_key_masked: Option<String>,
    pub has_executor_key: bool,
    pub executor_key_masked: Option<String>,
    pub reviewer_provider: Option<String>,
    pub reviewer_model: Option<String>,
    pub reviewer_base_url: Option<String>,
    pub review_enabled: bool,
    pub has_reviewer_key: bool,
    pub reviewer_key_masked: Option<String>,
    pub has_scopus_key: bool,
    pub scopus_key_masked: Option<String>,
    pub has_brave_search_key: bool,
    pub brave_search_key_masked: Option<String>,
    pub has_exa_key: bool,
    pub exa_key_masked: Option<String>,
    pub language: Option<String>,
    pub memory_write_approval: bool,
    pub managed_models: Vec<String>,
    /// Providers that passed a connection test — surfaced so the Settings list
    /// can show every configured provider (not just the executor/reviewer
    /// slots). Keys are never included.
    pub verified_executors: Vec<VerifiedSummary>,
}

fn build_view(obj: &Map<String, Value>) -> ConfigView {
    let exec_key = get_str(obj, "executor_api_key").filter(|k| !k.is_empty());
    let rev_key = get_str(obj, "reviewer_api_key").filter(|k| !k.is_empty());
    let summarizer_key = get_str(obj, "summarizer_api_key").filter(|k| !k.is_empty());
    let scopus_key = get_str(obj, "scopus_api_key").filter(|k| !k.is_empty());
    let brave_search_key = get_str(obj, "brave_search_api_key").filter(|k| !k.is_empty());
    let exa_key = get_str(obj, "exa_api_key").filter(|k| !k.is_empty());
    ConfigView {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        config_path: state::config_path().display().to_string(),
        python_environment_path: get_str(obj, "python_environment_path"),
        executor_provider: get_str(obj, "executor_provider"),
        executor_model: get_str(obj, "executor_model"),
        executor_base_url: get_str(obj, "executor_base_url"),
        executor_transport: get_str(obj, "executor_transport"),
        summarizer_model: get_str(obj, "summarizer_model"),
        retrieval_card_model: get_str(obj, "retrieval_card_model"),
        summarizer_provider: get_str(obj, "summarizer_provider"),
        summarizer_base_url: get_str(obj, "summarizer_base_url"),
        has_summarizer_key: summarizer_key.is_some(),
        summarizer_key_masked: summarizer_key.as_deref().map(mask),
        has_executor_key: exec_key.is_some(),
        executor_key_masked: exec_key.as_deref().map(mask),
        reviewer_provider: get_str(obj, "reviewer_provider"),
        reviewer_model: get_str(obj, "reviewer_model"),
        reviewer_base_url: get_str(obj, "reviewer_base_url"),
        review_enabled: review_enabled_from(obj),
        has_reviewer_key: rev_key.is_some(),
        reviewer_key_masked: rev_key.as_deref().map(mask),
        has_scopus_key: scopus_key.is_some(),
        scopus_key_masked: scopus_key.as_deref().map(mask),
        has_brave_search_key: brave_search_key.is_some(),
        brave_search_key_masked: brave_search_key.as_deref().map(mask),
        has_exa_key: exa_key.is_some(),
        exa_key_masked: exa_key.as_deref().map(mask),
        language: get_str(obj, "language"),
        memory_write_approval: obj
            .get("memory_write_approval")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        managed_models: read_string_list(obj, "managed_models"),
        verified_executors: read_verified(obj)
            .into_iter()
            .map(|entry| VerifiedSummary {
                provider: entry.provider,
                model: entry.model,
                base_url: entry.base_url,
                transport: entry.transport,
            })
            .collect(),
    }
}

fn review_enabled_from(obj: &Map<String, Value>) -> bool {
    // Independent review is opt-in: an absent `review_enabled` key means off.
    // Users turn it on in Settings or via the project-brief toggle; disabling it
    // never clears the configured reviewer.
    obj.get("review_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(crate) fn review_enabled() -> bool {
    review_enabled_from(&managed_config_object().unwrap_or_else(|_| load_object()))
}

pub(crate) fn retrieval_card_model() -> Option<String> {
    get_non_empty(
        &managed_config_object().unwrap_or_else(|_| load_object()),
        "retrieval_card_model",
    )
}

#[tauri::command]
pub fn config_get() -> ConfigView {
    build_view(&managed_config_object().unwrap_or_else(|_| load_object()))
}

const ADMIN_API_SETTINGS_MESSAGE: &str =
    "Only administrators can manage executor or reviewer API settings.";

async fn ensure_admin_api_settings_access() -> Result<(), String> {
    match newapi::stored_user_is_admin().await {
        Ok(true) => Ok(()),
        Ok(false) => Err(ADMIN_API_SETTINGS_MESSAGE.to_string()),
        Err(_) => Err(format!(
            "{ADMIN_API_SETTINGS_MESSAGE} Please sign in as an administrator."
        )),
    }
}

#[tauri::command]
pub async fn config_secret_get(kind: String) -> Result<Option<String>, String> {
    let (key, admin_only) = match kind.as_str() {
        "executorApiKey" | "executor_api_key" => ("executor_api_key", true),
        "summarizerApiKey" | "summarizer_api_key" => ("summarizer_api_key", false),
        "reviewerApiKey" | "reviewer_api_key" => ("reviewer_api_key", true),
        "scopusApiKey" | "scopus_api_key" => ("scopus_api_key", false),
        "braveSearchApiKey" | "brave_search_api_key" => ("brave_search_api_key", false),
        "exaApiKey" | "exa_api_key" => ("exa_api_key", false),
        _ => return Err(format!("Unsupported secret field: {kind}")),
    };
    if admin_only {
        ensure_admin_api_settings_access().await?;
    }
    Ok(get_non_empty(&load_object(), key))
}

#[tauri::command]
pub async fn config_secret_clear(kind: String) -> Result<ConfigView, String> {
    let (key, environment_key, admin_only) = match kind.as_str() {
        "scopusApiKey" | "scopus_api_key" => ("scopus_api_key", "SCOPUS_API_KEY", false),
        "braveSearchApiKey" | "brave_search_api_key" => {
            ("brave_search_api_key", "BRAVE_SEARCH_API_KEY", false)
        }
        "exaApiKey" | "exa_api_key" => ("exa_api_key", "EXA_API_KEY", false),
        _ => {
            return Err(format!(
                "Secret clearing is not supported for field: {kind}"
            ))
        }
    };
    if admin_only {
        ensure_admin_api_settings_access().await?;
    }
    let mut obj = load_object();
    obj.remove(key);
    save_object(&obj)?;
    std::env::remove_var(environment_key);
    Ok(build_view(&obj))
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

/// Merge `values` into the saved config and persist. Used by the managed-login
/// flow to stash the new-api session (base URL, user id, access token) so the
/// account bootstrap can refresh later without re-prompting for a password.
pub(crate) fn persist_values(values: &[(&str, Value)]) -> Result<(), String> {
    let mut obj = load_object();
    for (key, value) in values {
        obj.insert((*key).to_string(), value.clone());
    }
    save_object(&obj)
}

fn slot_matches_managed(
    obj: &Map<String, Value>,
    base_key: &str,
    api_key: &str,
    managed_base: Option<&str>,
    managed_key: Option<&str>,
) -> bool {
    let base_matches = managed_base
        .and_then(|base| get_non_empty(obj, base_key).map(|value| url_match_key(&value) == base))
        .unwrap_or(false);
    let key_matches = managed_key
        .and_then(|key| get_non_empty(obj, api_key).map(|value| value == key))
        .unwrap_or(false);
    base_matches || key_matches
}

fn clear_provider_slot(obj: &mut Map<String, Value>, prefix: &str) {
    obj.remove(&format!("{prefix}_provider"));
    obj.remove(&format!("{prefix}_model"));
    obj.remove(&format!("{prefix}_base_url"));
    obj.remove(&format!("{prefix}_api_key"));
}

/// Clear a slot's connection + credentials but keep the non-secret model id.
/// A managed reviewer choice is stored with the gateway base URL and token, so
/// the plain `clear_provider_slot` above would discard the user's model pick on
/// every logout/session-expiry. Keeping `{prefix}_model` lets
/// `normalize_managed_model_slots` rebuild the full slot from managed
/// credentials on the next login, so the reviewer selection survives.
fn clear_provider_credentials_keep_model(obj: &mut Map<String, Value>, prefix: &str) {
    obj.remove(&format!("{prefix}_provider"));
    obj.remove(&format!("{prefix}_base_url"));
    obj.remove(&format!("{prefix}_api_key"));
}

/// Clear only credentials created by the managed New API login flow.
pub(crate) fn clear_newapi_session() -> Result<(), String> {
    let mut obj = load_object();
    let managed_base = managed_executor_base_url(&obj).map(|base| url_match_key(&base));
    let managed_key = managed_executor_api_key(&obj);

    for key in [
        "newapi_base_url",
        "newapi_user_id",
        "newapi_username",
        "newapi_access_token",
        "newapi_executor_base_url",
        "newapi_executor_api_key",
        "newapi_token_id",
        "managed_models",
    ] {
        obj.remove(key);
    }

    if slot_matches_managed(
        &obj,
        "executor_base_url",
        "executor_api_key",
        managed_base.as_deref(),
        managed_key.as_deref(),
    ) {
        clear_provider_slot(&mut obj, "executor");
    }
    if slot_matches_managed(
        &obj,
        "reviewer_base_url",
        "reviewer_api_key",
        managed_base.as_deref(),
        managed_key.as_deref(),
    ) {
        // Keep the reviewer model so the choice survives logout; the gateway
        // key + base URL are re-derived on next login by model normalization.
        clear_provider_credentials_keep_model(&mut obj, "reviewer");
    }
    if slot_matches_managed(
        &obj,
        "summarizer_base_url",
        "summarizer_api_key",
        managed_base.as_deref(),
        managed_key.as_deref(),
    ) {
        clear_provider_slot(&mut obj, "summarizer");
    }

    if obj.get("verified_executors").is_some() {
        let mut verified = read_verified(&obj);
        let before = verified.len();
        verified.retain(|entry| {
            let base_matches = managed_base.as_deref().is_some_and(|base| {
                !entry.base_url.trim().is_empty() && url_match_key(&entry.base_url) == base
            });
            let key_matches = managed_key
                .as_deref()
                .is_some_and(|key| entry.api_key == key);
            !(base_matches || key_matches)
        });
        if verified.len() != before {
            write_verified(&mut obj, &verified);
        }
    }

    save_object(&obj)
}

fn value_is_missing_or_empty(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(value)) => value.trim().is_empty(),
        Some(Value::Array(value)) => value.is_empty(),
        Some(Value::Object(value)) => value.is_empty(),
        Some(_) => false,
    }
}

fn internal_overwrite_enabled(obj: &Map<String, Value>) -> bool {
    obj.get("_internal")
        .and_then(Value::as_object)
        .and_then(|meta| meta.get("overwriteExisting"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Apply an optional bundled internal configuration from the app resources.
///
/// This is used by internal installers to seed `~/.config/SomniQ/config.json` on
/// first launch. By default it only fills missing fields, so installing an
/// internal build does not silently replace a user's existing LLM settings.
pub(crate) fn apply_bundled_internal_config(resource_dir: &Path) -> Result<bool, String> {
    let path = resource_dir.join("internal-config.json");
    if !path.is_file() {
        return Ok(false);
    }

    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let mut bundled = serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("invalid internal config JSON: {error}"))?
        .as_object()
        .cloned()
        .ok_or_else(|| "internal config must be a JSON object".to_string())?;
    let overwrite = internal_overwrite_enabled(&bundled);
    bundled.remove("_internal");

    let mut current = load_object();
    let mut changed = false;
    for (key, value) in bundled {
        if value.is_null() {
            if overwrite && current.remove(&key).is_some() {
                changed = true;
            }
            continue;
        }
        if overwrite || value_is_missing_or_empty(current.get(&key)) {
            if current.get(&key) != Some(&value) {
                current.insert(key, value);
                changed = true;
            }
        }
    }

    if changed {
        save_object(&current)?;
    }
    Ok(changed)
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
    /// Endpoint capability for this specific `(provider, model, base_url)`:
    /// `responses` | `chat_completions` | empty for "auto/unprobed". Stored
    /// per entry because gateways differ per model — on one new-api
    /// deployment `gpt-5.6-*` serves `/v1/responses` natively while
    /// `MiniMax-M3` cannot convert the request at all.
    pub transport: String,
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
        transport: obj
            .get("transport")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
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
            // Omitted when unprobed so existing configs stay byte-identical.
            if !entry.transport.is_empty() {
                item.insert(
                    "transport".to_string(),
                    Value::String(entry.transport.clone()),
                );
            }
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
        // A re-probe may flip capability (gateway upgrade); an unprobed
        // re-verify must not erase a known-good transport.
        if !entry.transport.is_empty() {
            existing.transport = entry.transport;
        }
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
    record_verified_executor_with_transport(provider, model, base_url, api_key, "")
}

/// As [`record_verified_executor`], plus the probed endpoint capability.
/// Pass `""` to leave any previously probed transport untouched.
pub(crate) fn record_verified_executor_with_transport(
    provider: &str,
    model: &str,
    base_url: Option<&str>,
    api_key: &str,
    transport: &str,
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
            transport: transport.trim().to_string(),
        },
    );
    write_verified(&mut obj, &list);
    save_object(&obj)
}

/// Persist a transport verdict the **runtime** learned — a `/v1/responses`
/// request fell back to chat/completions, or a chat request was told to use
/// responses — into the verified-executor registry, and (when it names the
/// active executor) the `executor_transport` projection. Registered as the
/// executor's transport hook at startup ([`crate::install_transport_verdict_hook`])
/// so the Settings badge and the next launch reflect the endpoint actually
/// used, instead of re-probing on the first request of every process.
///
/// Idempotent and change-gated: an unchanged verdict never rewrites the config.
/// Matches verified entries by `(model, normalized base_url)`; a provider-default
/// entry stored with an empty base URL is not matched (those run official OpenAI,
/// where the `Auto` heuristic already resolves the endpoint without learning).
pub(crate) fn record_runtime_transport_verdict(base_url: &str, model: &str, verdict: &str) {
    let model = model.trim();
    let verdict = verdict.trim();
    if model.is_empty() || !matches!(verdict, "responses" | "chat_completions") {
        return;
    }
    let normalize = |url: &str| url.trim().trim_end_matches('/').to_ascii_lowercase();
    let target_base = normalize(base_url);
    if target_base.is_empty() {
        return;
    }

    let mut obj = load_object();
    let mut list = read_verified(&obj);
    let mut changed = false;
    for entry in list.iter_mut() {
        if entry.model == model
            && normalize(&entry.base_url) == target_base
            && entry.transport != verdict
        {
            entry.transport = verdict.to_string();
            changed = true;
        }
    }
    if changed {
        write_verified(&mut obj, &list);
    }
    // Keep the active-executor projection in sync so the running session and the
    // Settings badge agree with the endpoint the runtime just used.
    let active_model = get_non_empty(&obj, "executor_model");
    let active_base = obj
        .get("executor_base_url")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if active_model.as_deref() == Some(model) && normalize(active_base) == target_base {
        let current = obj
            .get("executor_transport")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if current != verdict {
            set_or_clear_executor_transport(&mut obj, verdict);
            changed = true;
        }
    }
    if changed {
        let _ = save_object(&obj);
    }
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
const DEEPSEEK_OPENAI_BASE_URL: &str = "https://api.deepseek.com/v1";

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
        Value::String("openai".to_string()),
    );
    obj.insert(
        "executor_model".to_string(),
        Value::String(DEEPSEEK_EXECUTOR_MODEL.to_string()),
    );
    obj.insert(
        "executor_base_url".to_string(),
        Value::String(DEEPSEEK_OPENAI_BASE_URL.to_string()),
    );
    obj.insert("executor_api_key".to_string(), Value::String(key));
    // DeepSeek V4 Pro supports `/v1/responses`. The executor still retains its
    // runtime fallback to Chat Completions if a compatible gateway rejects it.
    set_or_clear_executor_transport(obj, "responses");
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
    // Transport is a per-model capability: carry this entry's probed value, and
    // clear any stale value from the previously selected model so an unprobed
    // model falls back to `auto` rather than inheriting `responses`.
    set_or_clear_executor_transport(obj, &entry.transport);
}

/// Set `executor_transport` from a per-model capability, removing the key when
/// the model is unprobed (`""`) so it reads as `auto`.
fn set_or_clear_executor_transport(obj: &mut Map<String, Value>, transport: &str) {
    let transport = transport.trim();
    if transport.is_empty() {
        obj.remove("executor_transport");
    } else {
        obj.insert(
            "executor_transport".to_string(),
            Value::String(transport.to_string()),
        );
    }
}

fn apply_managed_executor(obj: &mut Map<String, Value>, model: &str) -> Result<(), String> {
    let Some((base_url, api_key)) = managed_executor_credentials(obj) else {
        return Err(
            "New API account token is not available. Sign in again, then sync models.".to_string(),
        );
    };
    obj.insert(
        "executor_provider".to_string(),
        Value::String("openai".to_string()),
    );
    obj.insert(
        "executor_model".to_string(),
        Value::String(model.to_string()),
    );
    obj.insert("executor_base_url".to_string(), Value::String(base_url));
    obj.insert("executor_api_key".to_string(), Value::String(api_key));
    // Reuse this model's previously probed capability if we have one; otherwise
    // clear so the new model starts at `auto` instead of inheriting the old
    // model's transport.
    let probed = verified_transport_for(obj, "openai", model);
    set_or_clear_executor_transport(obj, &probed);
    Ok(())
}

/// Look up the probed transport recorded for a `(provider, model)` pair.
/// Returns `""` when unprobed.
fn verified_transport_for(obj: &Map<String, Value>, provider: &str, model: &str) -> String {
    read_verified(obj)
        .into_iter()
        .find(|entry| entry.provider == provider && entry.model == model)
        .map(|entry| entry.transport)
        .unwrap_or_default()
}

fn normalize_managed_model_slots(obj: &mut Map<String, Value>) -> Result<bool, String> {
    let before = obj.clone();
    backfill_managed_executor_credentials(obj);
    if let Some(model) = get_non_empty(obj, "executor_model") {
        if managed_model_contains(obj, &model) {
            apply_managed_executor(obj, &model)?;
        }
    }

    if let Some(model) = get_non_empty(obj, "reviewer_model") {
        if managed_model_contains(obj, &model) {
            let Some((base_url, api_key)) = managed_executor_credentials(obj) else {
                return Err(
                    "New API account token is not available. Sign in again, then sync models."
                        .to_string(),
                );
            };
            obj.insert(
                "reviewer_provider".to_string(),
                Value::String("custom".to_string()),
            );
            obj.insert("reviewer_model".to_string(), Value::String(model));
            obj.insert("reviewer_base_url".to_string(), Value::String(base_url));
            obj.insert("reviewer_api_key".to_string(), Value::String(api_key));
        }
    }

    Ok(*obj != before)
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
    if managed_model_contains(&obj, model) {
        apply_managed_executor(&mut obj, model)?;
        return Ok(Some(obj));
    }
    normalize_managed_model_slots(&mut obj)?;
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

pub(crate) fn switch_to_managed_executor(model: &str) -> Result<bool, String> {
    let model = model.trim();
    let mut obj = load_object();
    if !managed_model_contains(&obj, model) {
        return Ok(false);
    }
    apply_managed_executor(&mut obj, model)?;
    save_object(&obj)?;
    Ok(true)
}

/// Built-in executor choices backed by keys already present in config/env.
/// Keys are never returned to the frontend.
pub(crate) fn builtin_executor_summaries() -> Vec<(String, String, String)> {
    let obj = load_object();
    let mut out = Vec::new();
    if deepseek_executor_key(&obj).is_some() {
        out.push((
            "openai".to_string(),
            DEEPSEEK_EXECUTOR_MODEL.to_string(),
            DEEPSEEK_OPENAI_BASE_URL.to_string(),
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
    let _ = record_verified_executor_with_transport(
        "openai",
        DEEPSEEK_EXECUTOR_MODEL,
        Some(DEEPSEEK_OPENAI_BASE_URL),
        &key,
        "responses",
    );
    Ok(true)
}

#[derive(Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPatch {
    pub python_environment_path: Option<String>,
    pub executor_provider: Option<String>,
    pub executor_model: Option<String>,
    pub executor_base_url: Option<String>,
    /// `auto` | `chat_completions` | `responses`. Absent/unknown means `auto`.
    pub executor_transport: Option<String>,
    pub summarizer_provider: Option<String>,
    pub summarizer_model: Option<String>,
    pub retrieval_card_model: Option<String>,
    pub summarizer_base_url: Option<String>,
    pub summarizer_api_key: Option<String>,
    pub executor_api_key: Option<String>,
    pub reviewer_provider: Option<String>,
    pub reviewer_model: Option<String>,
    pub reviewer_base_url: Option<String>,
    pub reviewer_api_key: Option<String>,
    pub review_enabled: Option<bool>,
    pub scopus_api_key: Option<String>,
    pub brave_search_api_key: Option<String>,
    pub exa_api_key: Option<String>,
    pub language: Option<String>,
    pub memory_write_approval: Option<bool>,
}

impl ConfigPatch {
    fn is_managed_executor_update(&self, obj: &Map<String, Value>) -> bool {
        let Some(model) = self.executor_model.as_deref().map(str::trim) else {
            return false;
        };
        if model.is_empty() {
            return false;
        }
        if let Some(provider) = self.executor_provider.as_deref() {
            if provider.trim() != "openai" {
                return false;
            }
        }
        if let Some(base_url) = self.executor_base_url.as_deref() {
            let Some(managed_base) = managed_executor_base_url(obj) else {
                return false;
            };
            if url_match_key(base_url) != url_match_key(&managed_base) {
                return false;
            }
        }
        if let Some(api_key) = self.executor_api_key.as_deref() {
            let Some(managed_key) = managed_executor_api_key(obj) else {
                return false;
            };
            if api_key.trim().is_empty() || api_key != managed_key {
                return false;
            }
        }
        managed_model_contains(obj, model)
            || self.executor_base_url.is_some()
            || self.executor_api_key.is_some()
    }

    fn changes_executor_api_settings(&self, obj: &Map<String, Value>) -> bool {
        let touches_connection = self.executor_provider.is_some()
            || self.executor_base_url.is_some()
            || self.executor_api_key.is_some();
        if touches_connection {
            !self.is_managed_executor_update(obj)
        } else {
            self.executor_model.as_deref().is_some_and(|model| {
                let model = model.trim();
                model.is_empty() || !managed_model_contains(obj, model)
            })
        }
    }

    fn current_reviewer_slot_is_empty(obj: &Map<String, Value>) -> bool {
        [
            "reviewer_provider",
            "reviewer_model",
            "reviewer_base_url",
            "reviewer_api_key",
        ]
        .into_iter()
        .all(|key| get_non_empty(obj, key).is_none())
    }

    fn current_reviewer_slot_matches_managed(obj: &Map<String, Value>) -> bool {
        let managed_base = managed_executor_base_url(obj).map(|base| url_match_key(&base));
        let managed_key = managed_executor_api_key(obj);
        let base_matches = match (
            get_non_empty(obj, "reviewer_base_url"),
            managed_base.as_deref(),
        ) {
            (Some(base_url), Some(managed_base)) => url_match_key(&base_url) == managed_base,
            _ => false,
        };
        let key_matches = match (
            get_non_empty(obj, "reviewer_api_key"),
            managed_key.as_deref(),
        ) {
            (Some(api_key), Some(managed_key)) => api_key == managed_key,
            _ => false,
        };
        base_matches || key_matches
    }

    fn is_managed_reviewer_disable(&self, obj: &Map<String, Value>) -> bool {
        if !self
            .reviewer_provider
            .as_deref()
            .is_some_and(|provider| provider.trim().is_empty())
        {
            return false;
        }
        for value in [
            self.reviewer_model.as_deref(),
            self.reviewer_base_url.as_deref(),
            self.reviewer_api_key.as_deref(),
        ] {
            if value.is_some_and(|value| !value.trim().is_empty()) {
                return false;
            }
        }
        Self::current_reviewer_slot_is_empty(obj)
            || Self::current_reviewer_slot_matches_managed(obj)
    }

    fn is_managed_reviewer_update(&self, obj: &Map<String, Value>) -> bool {
        if self.is_managed_reviewer_disable(obj) {
            return true;
        }
        if self
            .reviewer_provider
            .as_deref()
            .is_some_and(|provider| provider.trim().is_empty())
        {
            return false;
        }
        let Some(model) = self
            .reviewer_model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
        else {
            return false;
        };
        if !managed_model_contains(obj, model) {
            return false;
        }
        if let Some(provider) = self
            .reviewer_provider
            .as_deref()
            .map(str::trim)
            .filter(|provider| !provider.is_empty())
        {
            if provider != "custom" && provider != "openai" {
                return false;
            }
        }
        if let Some(base_url) = self
            .reviewer_base_url
            .as_deref()
            .map(str::trim)
            .filter(|base_url| !base_url.is_empty())
        {
            let Some(managed_base) = managed_executor_base_url(obj) else {
                return false;
            };
            if url_match_key(base_url) != url_match_key(&managed_base) {
                return false;
            }
        }
        if let Some(api_key) = self
            .reviewer_api_key
            .as_deref()
            .map(str::trim)
            .filter(|api_key| !api_key.is_empty())
        {
            let Some(managed_key) = managed_executor_api_key(obj) else {
                return false;
            };
            if api_key != managed_key {
                return false;
            }
        }
        true
    }

    fn changes_reviewer_api_settings(&self, obj: &Map<String, Value>) -> bool {
        let touches_reviewer = self.reviewer_provider.is_some()
            || self.reviewer_model.is_some()
            || self.reviewer_base_url.is_some()
            || self.reviewer_api_key.is_some();
        touches_reviewer && !self.is_managed_reviewer_update(obj)
    }

    fn changes_admin_api_settings(&self, obj: &Map<String, Value>) -> bool {
        self.changes_executor_api_settings(obj) || self.changes_reviewer_api_settings(obj)
    }
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

impl ConfigTestDetail {
    /// Build a detail for a provider-style check where the provider, model and
    /// base URL are all known. Centralizes the otherwise-repeated field wiring.
    fn outcome(
        ok: bool,
        label: &str,
        provider: String,
        model: String,
        base_url: String,
        message: String,
    ) -> Self {
        Self {
            ok,
            label: label.to_string(),
            provider: Some(provider),
            model: Some(model),
            base_url: Some(base_url),
            message,
        }
    }
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

    set_or_clear(
        obj,
        "python_environment_path",
        patch.python_environment_path,
    );
    set_or_clear(obj, "executor_provider", patch.executor_provider);
    set_or_clear(obj, "executor_model", patch.executor_model);
    set_or_clear(obj, "executor_base_url", patch.executor_base_url);
    let transport_stated = patch.executor_transport.is_some();
    set_or_clear(obj, "executor_transport", patch.executor_transport);
    set_or_clear(obj, "summarizer_provider", patch.summarizer_provider);
    set_or_clear(obj, "summarizer_model", patch.summarizer_model);
    set_or_clear(obj, "retrieval_card_model", patch.retrieval_card_model);
    set_or_clear(obj, "summarizer_base_url", patch.summarizer_base_url);
    set_or_clear(obj, "reviewer_provider", patch.reviewer_provider);
    set_or_clear(obj, "reviewer_model", patch.reviewer_model);
    set_or_clear(obj, "reviewer_base_url", patch.reviewer_base_url);
    if let Some(enabled) = patch.review_enabled {
        obj.insert("review_enabled".to_string(), Value::Bool(enabled));
    }
    set_or_clear(obj, "language", patch.language);
    if let Some(enabled) = patch.memory_write_approval {
        obj.insert("memory_write_approval".to_string(), Value::Bool(enabled));
    }

    set_secret(obj, "executor_api_key", patch.executor_api_key);
    set_secret(obj, "summarizer_api_key", patch.summarizer_api_key);
    set_secret(obj, "reviewer_api_key", patch.reviewer_api_key);
    set_secret(obj, "scopus_api_key", patch.scopus_api_key);
    set_secret(obj, "brave_search_api_key", patch.brave_search_api_key);
    set_secret(obj, "exa_api_key", patch.exa_api_key);

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

    // `executor_transport` is a per-model capability, so unless this patch
    // states one explicitly it is re-derived from the probed registry for
    // whichever model the patch just selected. Without this, `set_or_clear`
    // leaves the previous model's value in place (a `None` patch field means
    // "unchanged"), so switching models in the form would carry a stale
    // endpoint onto the new model.
    if !transport_stated {
        let provider = get_str(obj, "executor_provider").unwrap_or_default();
        let model = get_str(obj, "executor_model").unwrap_or_default();
        let probed = verified_transport_for(obj, &provider, &model);
        set_or_clear_executor_transport(obj, &probed);
    }
}

#[tauri::command]
pub async fn config_set(mut patch: ConfigPatch) -> Result<ConfigView, String> {
    let mut obj = load_object();
    if let Some(selected) = patch.python_environment_path.as_mut() {
        *selected = selected.trim().to_string();
    }
    let python_environment_update = patch.python_environment_path.clone();
    if let Some(selected) = python_environment_update.as_deref() {
        crate::validate_python_environment_path(selected)?;
    }
    if patch.changes_admin_api_settings(&obj) {
        ensure_admin_api_settings_access().await?;
    }
    apply_patch(&mut obj, patch);
    normalize_managed_model_slots(&mut obj)?;
    save_object(&obj)?;
    apply_reviewer_environment_from(&obj, true);
    if python_environment_update.is_some() {
        crate::apply_python_environment_path(
            obj.get("python_environment_path").and_then(Value::as_str),
        )?;
    }
    Ok(build_view(&obj))
}

pub(crate) fn apply_reviewer_environment(force: bool) {
    let obj = managed_config_object().unwrap_or_else(|_| load_object());
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
    let model = get_non_empty(obj, "reviewer_model");
    let base_url = get_non_empty(obj, "reviewer_base_url");
    let key = managed_reviewer_key_for(
        obj,
        provider.as_deref(),
        base_url.as_deref(),
        model.as_deref(),
    )
    .or_else(|| get_non_empty(obj, "reviewer_api_key"))
    .or_else(|| get_non_empty(obj, "executor_api_key"));

    if force && provider.is_none() {
        std::env::set_var("ARIS_REVIEWER_PROVIDER", "none");
    }
    set_env_if_allowed("ARIS_REVIEWER_PROVIDER", provider.clone(), force);
    set_env_if_allowed("ARIS_REVIEWER_MODEL", model, force);
    set_env_if_allowed("ARIS_REVIEWER_BASE_URL", base_url, force);
    set_env_if_allowed("ARIS_LANGUAGE", get_non_empty(obj, "language"), force);
    set_env_if_allowed(
        "ARIS_REASONING_EFFORT",
        get_non_empty(obj, "reasoning_effort"),
        force,
    );
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
    // Built-in WebSearch reads optional paid-provider credentials from the
    // process environment on every invocation. Applying them here makes a
    // Settings save effective immediately without exposing keys in tool input.
    set_env_if_allowed(
        "BRAVE_SEARCH_API_KEY",
        get_non_empty(obj, "brave_search_api_key"),
        force,
    );
    set_env_if_allowed("EXA_API_KEY", get_non_empty(obj, "exa_api_key"), force);

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

pub(crate) fn reasoning_effort() -> String {
    get_non_empty(&load_object(), "reasoning_effort").unwrap_or_else(|| "high".to_string())
}

pub(crate) fn set_reasoning_effort(effort: &str) -> Result<(), String> {
    let effort = effort.trim().to_ascii_lowercase();
    if !matches!(
        effort.as_str(),
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
    ) {
        return Err("unsupported reasoning effort".to_string());
    }
    let mut obj = load_object();
    obj.insert(
        "reasoning_effort".to_string(),
        Value::String(effort.clone()),
    );
    save_object(&obj)?;
    std::env::set_var("ARIS_REASONING_EFFORT", effort);
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
            return ConfigTestDetail::outcome(
                false,
                label,
                provider,
                model,
                base_url,
                format!("Could not create HTTP client: {error}"),
            );
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
        Ok(message) => ConfigTestDetail::outcome(true, label, provider, model, base_url, message),
        Err(message) => ConfigTestDetail::outcome(false, label, provider, model, base_url, message),
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
            return ConfigTestDetail::outcome(
                false,
                label,
                provider,
                model,
                base_url,
                format!("Could not create HTTP client: {error}"),
            );
        }
    };
    let request = client.get(models_url(&base_url)).bearer_auth(api_key);
    match check_response(label, request).await {
        Ok(message) => ConfigTestDetail::outcome(true, label, provider, model, base_url, message),
        Err(message) => ConfigTestDetail::outcome(false, label, provider, model, base_url, message),
    }
}

/// Probe whether this endpoint serves `/v1/responses` for `model`.
///
/// Gateways differ per model, not per server: on one self-hosted new-api
/// deployment `gpt-5.6-*` proxies the Responses API natively while
/// `MiniMax-M3` answers `convert_request_failed` and Kimi/MiMo 404. The
/// verdict is stored per verified entry so the executor picks the right
/// endpoint without a failed first request.
///
/// Returns `"responses"`, `"chat_completions"`, or `""` when the probe was
/// inconclusive (auth/quota/network) — the caller then leaves any previously
/// recorded capability untouched rather than downgrading on a transient error.
///
/// Costs one minimal generation (capped at 32 output tokens); a request
/// without `input` is not used because too many gateways answer a generic 400
/// for both the supported and unsupported case.
async fn probe_responses_transport(base_url: &str, model: &str, api_key: &str) -> &'static str {
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
    else {
        return "";
    };
    let url = format!("{}/responses", base_url.trim_end_matches('/'));
    let response = client
        .post(&url)
        .bearer_auth(api_key)
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "input": "ok",
            "max_output_tokens": 32,
            "stream": false,
            "store": false,
        }))
        .send()
        .await;
    let Ok(response) = response else {
        return "";
    };
    let status = response.status();
    if status.is_success() {
        return "responses";
    }
    let body = response.text().await.unwrap_or_default();
    if aris_executor::responses_transport_unsupported(status.as_u16(), &body) {
        return "chat_completions";
    }
    ""
}

async fn test_reviewer(obj: &Map<String, Value>) -> Option<ConfigTestDetail> {
    let provider = get_non_empty(obj, "reviewer_provider")?;
    let model = get_non_empty(obj, "reviewer_model").unwrap_or_else(|| "gpt-5.5".to_string());
    let reviewer_base_url = get_non_empty(obj, "reviewer_base_url");
    let key = match managed_reviewer_key_for(
        obj,
        Some(&provider),
        reviewer_base_url.as_deref(),
        Some(&model),
    )
    .or_else(|| get_non_empty(obj, "reviewer_api_key"))
    .or_else(|| get_non_empty(obj, "executor_api_key"))
    {
        Some(key) => key,
        None => {
            return Some(ConfigTestDetail {
                ok: false,
                label: "Reviewer".to_string(),
                provider: Some(provider),
                model: Some(model),
                base_url: reviewer_base_url,
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
        let base_url = normalized_base_url(reviewer_base_url, default_base);
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

    let base_url = normalized_base_url(reviewer_base_url, openai_default_base(&provider, &model));
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
        managed_executor_base_url(obj),
        managed_executor_api_key(obj),
    ) {
        candidates.push((url, key));
    }
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
    ensure_admin_api_settings_access().await?;
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
pub async fn web_search_provider_test(
    provider: String,
    api_key: Option<String>,
) -> Result<ConfigTestDetail, String> {
    let provider = provider.trim().to_ascii_lowercase();
    let (config_key, base_url) = match provider.as_str() {
        "brave" => ("brave_search_api_key", "https://api.search.brave.com"),
        "exa" => ("exa_api_key", "https://api.exa.ai"),
        _ => return Err(format!("Unsupported web search provider: {provider}")),
    };
    let key = api_key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| get_non_empty(&load_object(), config_key))
        .ok_or_else(|| format!("No {provider} API key is available to test."))?;
    let test_query = format!(
        "SomniQ research workspace connectivity {}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let probe_provider = provider.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        tools::web::probe_web_search_provider(&probe_provider, &key, &test_query)
    })
    .await
    .map_err(|error| error.to_string())?;

    let (ok, message) = match result {
        Ok(attempt) => {
            let attempt_status = attempt["status"].as_str().unwrap_or("unknown");
            let ok = matches!(attempt_status, "completed" | "partial");
            (
                ok,
                if ok {
                    format!(
                        "{} connection succeeded; provider status={attempt_status}.",
                        provider.to_ascii_uppercase()
                    )
                } else {
                    attempt["error"]
                        .as_str()
                        .unwrap_or("Provider connection test failed.")
                        .to_string()
                },
            )
        }
        Err(error) => (false, error),
    };
    Ok(ConfigTestDetail {
        ok,
        label: format!("{} Web Search", provider.to_ascii_uppercase()),
        provider: Some(provider),
        model: None,
        base_url: Some(base_url.to_string()),
        message,
    })
}

#[tauri::command]
pub async fn config_test(patch: ConfigPatch) -> Result<ConfigTestResult, String> {
    let mut obj = load_object();
    if patch.changes_admin_api_settings(&obj) {
        ensure_admin_api_settings_access().await?;
    }
    apply_patch(&mut obj, patch);
    normalize_managed_model_slots(&mut obj)?;

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
            // The connectivity test only proves credentials + model reachability
            // on chat/completions; transport capability is probed separately.
            aris_chat::ChatExecutorConfig::OpenAiCompatible {
                api_key,
                base_url,
                transport: _,
            },
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
                // OpenAI-compatible executors additionally get an endpoint
                // capability probe, so the Chat turn picks `/v1/responses` (or
                // not) without spending a failed request to find out. Anthropic
                // transports have no such choice. An inconclusive probe returns
                // `""`, which preserves any previously recorded verdict.
                let transport = if provider == "anthropic" || provider == "anthropic-compat" {
                    ""
                } else {
                    let probe_base =
                        normalized_base_url(executor.base_url.clone(), "https://api.openai.com/v1");
                    probe_responses_transport(&probe_base, &model, &key).await
                };
                // Only the per-model registry is written here. The live
                // `executor_transport` slot is derived whenever a model is
                // actually selected (`apply_patch` / `apply_verified_executor`
                // / `apply_managed_executor`), because the form being tested
                // may name a different model than the saved config — stamping
                // the probed value onto the live slot here would attribute one
                // model's capability to another.
                let _ = record_verified_executor_with_transport(
                    &provider,
                    &model,
                    executor.base_url.as_deref(),
                    &key,
                    transport,
                );
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
#[path = "tests/config.rs"]
mod tests;
