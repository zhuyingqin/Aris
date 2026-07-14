use super::{
    apply_bundled_internal_config, apply_reviewer_environment_from, deepseek_executor_key,
    executor_object_for_model, read_verified, upsert_verified, write_verified, VerifiedExecutor,
};
use serde_json::{Map, Value};
use std::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "somniq-desktop-config-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn restore_home(home: Option<String>, userprofile: Option<String>) {
    match home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    match userprofile {
        Some(value) => std::env::set_var("USERPROFILE", value),
        None => std::env::remove_var("USERPROFILE"),
    }
}

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
fn legacy_managed_models_do_not_block_local_model_selection() {
    let _guard = ENV_LOCK.lock().expect("env lock");
    let previous_home = std::env::var("HOME").ok();
    let previous_userprofile = std::env::var("USERPROFILE").ok();
    let home = temp_dir("stale-managed-models");
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);

    let config_path = crate::state::config_path();
    std::fs::create_dir_all(config_path.parent().expect("config parent"))
        .expect("create config parent");
    std::fs::write(
        &config_path,
        serde_json::json!({
            "managed_models": ["MiniMax-M3"],
            "executor_provider": "openai",
            "executor_model": "MiniMax-M3",
            "executor_base_url": "https://api.example.test/v1",
            "executor_api_key": "local-key"
        })
        .to_string(),
    )
    .expect("write config");

    let selected = executor_object_for_model("MiniMax-M3")
        .expect("stale managed config is harmless")
        .expect("current local model remains selectable");
    assert_eq!(selected["executor_base_url"], "https://api.example.test/v1");
    assert_eq!(selected["executor_api_key"], "local-key");

    let _ = std::fs::remove_dir_all(&home);
    restore_home(previous_home, previous_userprofile);
}

#[test]
fn bundled_internal_config_fills_missing_without_overwriting_existing() {
    let _guard = ENV_LOCK.lock().expect("env lock");
    let previous_home = std::env::var("HOME").ok();
    let previous_userprofile = std::env::var("USERPROFILE").ok();
    let home = temp_dir("fills-home");
    let resources = temp_dir("fills-resources");
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);

    let config_path = crate::state::config_path();
    std::fs::create_dir_all(config_path.parent().expect("config parent"))
        .expect("create config parent");
    std::fs::write(
        &config_path,
        serde_json::json!({
            "executor_model": "existing-model",
            "executor_api_key": "existing-key"
        })
        .to_string(),
    )
    .expect("write existing config");
    std::fs::write(
        resources.join("internal-config.json"),
        serde_json::json!({
            "executor_model": "bundled-model",
            "executor_api_key": "bundled-key",
            "executor_provider": "openai"
        })
        .to_string(),
    )
    .expect("write internal config");

    assert!(apply_bundled_internal_config(&resources).expect("apply internal config"));
    let saved = crate::config::load_object();
    assert_eq!(saved["executor_model"], "existing-model");
    assert_eq!(saved["executor_api_key"], "existing-key");
    assert_eq!(saved["executor_provider"], "openai");

    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&resources);
    restore_home(previous_home, previous_userprofile);
}

#[test]
fn bundled_internal_config_can_overwrite_existing() {
    let _guard = ENV_LOCK.lock().expect("env lock");
    let previous_home = std::env::var("HOME").ok();
    let previous_userprofile = std::env::var("USERPROFILE").ok();
    let home = temp_dir("overwrite-home");
    let resources = temp_dir("overwrite-resources");
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);

    let config_path = crate::state::config_path();
    std::fs::create_dir_all(config_path.parent().expect("config parent"))
        .expect("create config parent");
    std::fs::write(
        &config_path,
        serde_json::json!({
            "executor_model": "existing-model",
            "reviewer_provider": "openai"
        })
        .to_string(),
    )
    .expect("write existing config");
    std::fs::write(
        resources.join("internal-config.json"),
        serde_json::json!({
            "_internal": { "overwriteExisting": true },
            "executor_model": "bundled-model",
            "reviewer_provider": null
        })
        .to_string(),
    )
    .expect("write internal config");

    assert!(apply_bundled_internal_config(&resources).expect("apply internal config"));
    let saved = crate::config::load_object();
    assert_eq!(saved["executor_model"], "bundled-model");
    assert!(saved.get("reviewer_provider").is_none());

    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&resources);
    restore_home(previous_home, previous_userprofile);
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
