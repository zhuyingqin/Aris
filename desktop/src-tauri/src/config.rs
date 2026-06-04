//! Read/write `~/.config/aris/config.json` for the Settings page.
//!
//! Operates on the raw JSON object (snake_case keys, matching aris-cli's
//! `ArisConfig`) so unmodelled fields (e.g. `meta_logging`) survive a round trip,
//! and so the schema can't drift. API keys are never returned to the frontend —
//! only a masked preview + a "has key" flag.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::state;

fn load_object() -> Map<String, Value> {
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

#[tauri::command]
pub fn config_set(patch: ConfigPatch) -> Result<ConfigView, String> {
    let mut obj = load_object();

    let reviewer_disabled = patch.reviewer_provider.as_deref() == Some("");

    set_or_clear(&mut obj, "executor_provider", patch.executor_provider);
    set_or_clear(&mut obj, "executor_model", patch.executor_model);
    set_or_clear(&mut obj, "executor_base_url", patch.executor_base_url);
    set_or_clear(&mut obj, "reviewer_provider", patch.reviewer_provider);
    set_or_clear(&mut obj, "reviewer_model", patch.reviewer_model);
    set_or_clear(&mut obj, "reviewer_base_url", patch.reviewer_base_url);
    set_or_clear(&mut obj, "language", patch.language);

    set_secret(&mut obj, "executor_api_key", patch.executor_api_key);
    set_secret(&mut obj, "reviewer_api_key", patch.reviewer_api_key);

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

    let path = state::config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json =
        serde_json::to_string_pretty(&Value::Object(obj.clone())).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(build_view(&obj))
}
