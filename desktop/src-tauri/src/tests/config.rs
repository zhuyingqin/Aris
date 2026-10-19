use super::{
    apply_bundled_internal_config, apply_patch,
    apply_reviewer_environment_from, build_view, clear_newapi_session,
    normalize_managed_model_slots, normalize_web_proxy_patch, read_verified, review_enabled_from,
    review_mode_from, sanitize_legacy_managed_http,
    upsert_verified, write_verified, ConfigPatch, ReviewMode, VerifiedExecutor,
};
use serde_json::{Map, Value};
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
        transport: String::new(),
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
fn retired_builtin_presets_do_not_offer_third_party_keys() {
    assert!(super::builtin_executor_summaries().is_empty());
    assert!(!super::switch_to_builtin_executor("deepseek-v4-pro").unwrap());
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
fn managed_executor_update_does_not_require_admin_api_access() {
    let obj = serde_json::json!({
        "newapi_base_url": "http://gateway.example",
        "newapi_executor_base_url": "http://gateway.example/v1",
        "newapi_executor_api_key": "gateway-token",
        "managed_models": ["MiniMax-M3"]
    })
    .as_object()
    .expect("object")
    .clone();
    let patch = ConfigPatch {
        executor_provider: Some("openai".to_string()),
        executor_model: Some("MiniMax-M3".to_string()),
        executor_base_url: Some("http://gateway.example/v1".to_string()),
        executor_api_key: Some("gateway-token".to_string()),
        ..Default::default()
    };

    assert!(!patch.changes_external_api_settings(&obj));
}

#[test]
fn manual_executor_update_is_an_external_api_change() {
    let obj = serde_json::json!({
        "newapi_base_url": "http://gateway.example",
        "newapi_executor_base_url": "http://gateway.example/v1",
        "newapi_executor_api_key": "gateway-token",
        "managed_models": ["MiniMax-M3"]
    })
    .as_object()
    .expect("object")
    .clone();
    let patch = ConfigPatch {
        executor_provider: Some("openai".to_string()),
        executor_model: Some("gpt-5.5".to_string()),
        executor_base_url: Some("https://api.openai.com/v1".to_string()),
        executor_api_key: Some("manual-token".to_string()),
        ..Default::default()
    };

    assert!(patch.changes_external_api_settings(&obj));
}

#[test]
fn managed_reviewer_update_does_not_require_admin_api_access() {
    let obj = serde_json::json!({
        "newapi_base_url": "http://gateway.example",
        "newapi_executor_base_url": "http://gateway.example/v1",
        "newapi_executor_api_key": "gateway-token",
        "managed_models": ["MiniMax-M3", "gpt-5.5"]
    })
    .as_object()
    .expect("object")
    .clone();
    let patch = ConfigPatch {
        reviewer_model: Some("gpt-5.5".to_string()),
        ..Default::default()
    };

    assert!(!patch.changes_external_api_settings(&obj));
}

#[test]
fn managed_reviewer_disable_does_not_require_admin_api_access() {
    let obj = serde_json::json!({
        "newapi_base_url": "http://gateway.example",
        "newapi_executor_base_url": "http://gateway.example/v1",
        "newapi_executor_api_key": "gateway-token",
        "managed_models": ["MiniMax-M3"]
    })
    .as_object()
    .expect("object")
    .clone();
    let patch = ConfigPatch {
        reviewer_provider: Some(String::new()),
        reviewer_model: Some(String::new()),
        reviewer_base_url: Some(String::new()),
        ..Default::default()
    };

    assert!(!patch.changes_external_api_settings(&obj));
}

#[test]
fn automatic_review_defaults_off_and_can_be_enabled_without_clearing_reviewer() {
    let mut obj = serde_json::json!({
        "reviewer_provider": "openai",
        "reviewer_model": "gpt-5.5",
        "reviewer_api_key": "reviewer-token"
    })
    .as_object()
    .expect("object")
    .clone();

    // Independent review is opt-in: an absent `review_enabled` key means off,
    // even when a reviewer is fully configured.
    assert!(!review_enabled_from(&obj));
    assert!(!build_view(&obj).review_enabled);

    apply_patch(
        &mut obj,
        ConfigPatch {
            review_enabled: Some(true),
            ..Default::default()
        },
    );

    assert!(review_enabled_from(&obj));
    assert!(build_view(&obj).review_enabled);
    assert_eq!(obj["reviewer_provider"], "openai");
    assert_eq!(obj["reviewer_model"], "gpt-5.5");
    assert_eq!(obj["reviewer_api_key"], "reviewer-token");
}

#[test]
fn review_mode_defaults_to_the_thread_and_only_an_explicit_oneshot_goes_back() {
    let mut obj = Map::new();
    assert_eq!(review_mode_from(&obj), ReviewMode::Thread);
    assert_eq!(build_view(&obj).review_mode, "thread");

    for (stored, expected) in [
        ("oneshot", ReviewMode::Oneshot),
        ("  OneShot ", ReviewMode::Oneshot),
        ("thread", ReviewMode::Thread),
        // A typo must not quietly pick the old path.
        ("one-shot", ReviewMode::Thread),
        ("", ReviewMode::Thread),
    ] {
        obj.insert("review_mode".to_string(), Value::String(stored.to_string()));
        assert_eq!(review_mode_from(&obj), expected, "{stored:?}");
    }

    apply_patch(
        &mut obj,
        ConfigPatch {
            review_mode: Some("Oneshot".to_string()),
            ..Default::default()
        },
    );
    assert_eq!(obj["review_mode"], "oneshot");
    assert_eq!(build_view(&obj).review_mode, "oneshot");
    // Other settings leave it alone.
    apply_patch(
        &mut obj,
        ConfigPatch {
            review_enabled: Some(true),
            ..Default::default()
        },
    );
    assert_eq!(obj["review_mode"], "oneshot");
    // A blank or unknown value is "no preference": the key goes, the default returns.
    for blank in ["", "  ", "sideways"] {
        apply_patch(
            &mut obj,
            ConfigPatch {
                review_mode: Some("oneshot".to_string()),
                ..Default::default()
            },
        );
        apply_patch(
            &mut obj,
            ConfigPatch {
                review_mode: Some(blank.to_string()),
                ..Default::default()
            },
        );
        assert!(!obj.contains_key("review_mode"), "{blank:?}");
        assert_eq!(review_mode_from(&obj), ReviewMode::Thread);
    }
}

#[test]
fn retrieval_card_model_round_trips_without_changing_executor_credentials() {
    let mut obj = serde_json::json!({
        "executor_provider": "openai",
        "executor_model": "MiniMax-M3",
        "executor_api_key": "executor-token"
    })
    .as_object()
    .expect("object")
    .clone();

    apply_patch(
        &mut obj,
        ConfigPatch {
            retrieval_card_model: Some("gpt-5.5".to_string()),
            ..Default::default()
        },
    );

    assert_eq!(
        build_view(&obj).retrieval_card_model.as_deref(),
        Some("gpt-5.5")
    );
    assert_eq!(obj["executor_model"], "MiniMax-M3");
    assert_eq!(obj["executor_api_key"], "executor-token");

    apply_patch(
        &mut obj,
        ConfigPatch {
            retrieval_card_model: Some(String::new()),
            ..Default::default()
        },
    );
    assert!(build_view(&obj).retrieval_card_model.is_none());
}

#[test]
fn python_environment_path_round_trips_and_can_be_cleared() {
    let mut obj = Map::new();
    apply_patch(
        &mut obj,
        ConfigPatch {
            python_environment_path: Some(r"C:\Users\research\anaconda3".to_string()),
            ..Default::default()
        },
    );

    assert_eq!(
        build_view(&obj).python_environment_path.as_deref(),
        Some(r"C:\Users\research\anaconda3")
    );

    apply_patch(
        &mut obj,
        ConfigPatch {
            python_environment_path: Some(String::new()),
            ..Default::default()
        },
    );
    assert!(build_view(&obj).python_environment_path.is_none());
}

#[test]
fn retired_api_keys_are_rejected_before_saving_or_testing() {
    with_temp_home("retired-api-patches", |config_path| {
        let initial = serde_json::json!({"language":"cn", "memory_write_approval":true}).to_string();
        std::fs::write(config_path, &initial).unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        for field in ["executorApiKey", "reviewerApiKey", "summarizerApiKey",
            "scopusApiKey", "openalexApiKey", "bochaApiKey", "braveSearchApiKey",
            "exaApiKey", "zhihuAccessSecret"] {
            let value = Value::Object(Map::from_iter([(field.to_string(), Value::String("retired-secret".into()))]));
            let patch: ConfigPatch = serde_json::from_value(value.clone()).unwrap();
            let error = runtime.block_on(super::config_set(patch)).err().expect("retired key rejected");
            assert!(error.contains("removed"));
            assert!(!error.contains("retired-secret"));
            let patch = serde_json::from_value(value).unwrap();
            assert!(runtime.block_on(super::config_test(patch)).is_err());
            assert_eq!(std::fs::read_to_string(config_path).unwrap(), initial);
        }
    });
}

#[test]
fn web_proxy_round_trips_exports_and_blank_restores_direct_access() {
    let _guard = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    std::env::remove_var("ARIS_WEB_PROXY_URL");

    let mut patch = ConfigPatch {
        web_proxy_url: Some(" http://127.0.0.1:10808/ ".to_string()),
        ..Default::default()
    };
    normalize_web_proxy_patch(&mut patch).expect("valid HTTP proxy");
    let mut obj = Map::new();
    apply_patch(&mut obj, patch);

    assert_eq!(
        build_view(&obj).web_proxy_url.as_deref(),
        Some("http://127.0.0.1:10808")
    );
    apply_reviewer_environment_from(&obj, true);
    assert_eq!(
        std::env::var("ARIS_WEB_PROXY_URL").as_deref(),
        Ok("http://127.0.0.1:10808")
    );

    let mut clear = ConfigPatch {
        web_proxy_url: Some(String::new()),
        ..Default::default()
    };
    normalize_web_proxy_patch(&mut clear).expect("blank means direct");
    apply_patch(&mut obj, clear);
    assert!(build_view(&obj).web_proxy_url.is_none());
    apply_reviewer_environment_from(&obj, true);
    assert!(std::env::var("ARIS_WEB_PROXY_URL").is_err());
}

#[test]
fn web_proxy_rejects_credentials_and_non_http_schemes() {
    for value in [
        "socks5://127.0.0.1:1080",
        "http://user:secret@127.0.0.1:10808",
    ] {
        let mut patch = ConfigPatch {
            web_proxy_url: Some(value.to_string()),
            ..Default::default()
        };
        assert!(normalize_web_proxy_patch(&mut patch).is_err(), "{value}");
    }
}

#[test]
fn manual_reviewer_update_is_an_external_api_change() {
    let obj = Map::new();
    let patch = ConfigPatch {
        reviewer_provider: Some("openai".to_string()),
        reviewer_model: Some("gpt-5.5".to_string()),
        reviewer_base_url: Some("https://api.openai.com/v1".to_string()),
        reviewer_api_key: Some("reviewer-token".to_string()),
        ..Default::default()
    };

    assert!(patch.changes_external_api_settings(&obj));
}

#[test]
fn bundled_internal_config_fills_missing_without_overwriting_existing() {
    let _guard = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
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
    assert!(saved.get("executor_api_key").is_none());
    assert!(saved.get("executor_provider").is_none());

    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&resources);
    restore_home(previous_home, previous_userprofile);
}

#[test]
fn bundled_internal_config_can_overwrite_existing() {
    let _guard = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
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
fn managed_slots_backfill_gateway_key_from_matching_executor() {
    let mut obj = serde_json::json!({
        "newapi_base_url": "http://gateway.example",
        "managed_models": ["MiniMax-M3"],
        "executor_provider": "openai",
        "executor_model": "MiniMax-M3",
        "executor_base_url": "http://gateway.example/v1",
        "executor_api_key": "gateway-token"
    })
    .as_object()
    .expect("object")
    .clone();

    assert!(normalize_managed_model_slots(&mut obj).expect("normalize"));
    assert_eq!(obj["newapi_executor_base_url"], "http://gateway.example/v1");
    assert_eq!(obj["newapi_executor_api_key"], "gateway-token");
    assert_eq!(obj["executor_provider"], "openai");
    assert_eq!(obj["executor_base_url"], "http://gateway.example/v1");
    assert_eq!(obj["executor_api_key"], "gateway-token");
}

#[test]
fn managed_reviewer_replaces_stale_key_with_gateway_key() {
    let mut obj = serde_json::json!({
        "newapi_base_url": "http://gateway.example",
        "managed_models": ["deepseek-v4-pro"],
        "executor_provider": "openai",
        "executor_model": "MiniMax-M3",
        "executor_base_url": "http://gateway.example/v1",
        "executor_api_key": "gateway-token",
        "reviewer_provider": "deepseek",
        "reviewer_model": "deepseek-v4-pro",
        "reviewer_base_url": "https://api.deepseek.com/anthropic",
        "reviewer_api_key": "stale-deepseek-token"
    })
    .as_object()
    .expect("object")
    .clone();

    assert!(normalize_managed_model_slots(&mut obj).expect("normalize"));
    assert_eq!(obj["newapi_executor_api_key"], "gateway-token");
    assert_eq!(obj["reviewer_provider"], "custom");
    assert_eq!(obj["reviewer_model"], "deepseek-v4-pro");
    assert_eq!(obj["reviewer_base_url"], "http://gateway.example/v1");
    assert_eq!(obj["reviewer_api_key"], "gateway-token");
}

#[test]
fn retired_http_gateway_is_removed_without_touching_other_providers() {
    let mut obj = serde_json::json!({
        "newapi_base_url": "http://106.53.28.124:18080",
        "newapi_user_id": 7,
        "newapi_access_token": "old-access",
        "newapi_executor_base_url": "http://106.53.28.124:18080/v1",
        "newapi_executor_api_key": "old-model-key",
        "managed_models": ["MiniMax-M3"],
        "executor_provider": "openai",
        "executor_model": "MiniMax-M3",
        "executor_base_url": "http://106.53.28.124:18080/v1",
        "executor_api_key": "old-model-key",
        "reviewer_model": "gpt-5.5",
        "reviewer_base_url": "http://106.53.28.124:18080/v1",
        "reviewer_api_key": "old-model-key",
        "summarizer_base_url": "https://api.example.com/v1",
        "summarizer_api_key": "other-key",
        "verified_executors": [
            { "provider": "openai", "model": "MiniMax-M3", "base_url": "http://106.53.28.124:18080/v1", "api_key": "old-model-key" },
            { "provider": "openai", "model": "other", "base_url": "https://api.example.com/v1", "api_key": "other-key" }
        ]
    })
    .as_object()
    .unwrap()
    .clone();

    assert!(sanitize_legacy_managed_http(&mut obj));
    for key in ["newapi_base_url", "newapi_access_token", "newapi_executor_api_key", "managed_models", "executor_base_url", "executor_api_key", "reviewer_base_url", "reviewer_api_key"] {
        assert!(obj.get(key).is_none(), "{key} was retained");
    }
    assert_eq!(obj["reviewer_model"], "gpt-5.5");
    assert_eq!(obj["summarizer_api_key"], "other-key");
    let verified = read_verified(&obj);
    assert_eq!(verified.len(), 1);
    assert_eq!(verified[0].api_key, "other-key");
    assert!(!sanitize_legacy_managed_http(&mut obj));
}

#[test]
fn model_sync_preserves_explicit_opencode_connection_identity() {
    let mut obj = serde_json::json!({
        "managed_models": ["same-model"],
        "executor_provider": "opencode", "executor_model": "same-model",
        "executor_base_url": "https://fixed-channel.test/v1", "executor_api_key": "own-key",
        "reviewer_provider": "opencode", "reviewer_model": "same-model",
        "reviewer_base_url": "https://review-channel.test/v1", "reviewer_api_key": "review-key"
    }).as_object().unwrap().clone();
    let before = obj.clone();
    normalize_managed_model_slots(&mut obj).unwrap();
    for key in ["executor_provider", "executor_base_url", "executor_api_key", "reviewer_provider", "reviewer_base_url", "reviewer_api_key"] {
        assert_eq!(obj.get(key), before.get(key), "model sync changed {key}");
    }
}

#[test]
fn managed_key_cannot_follow_a_tampered_executor_or_verified_url() {
    let official = crate::newapi::configured_managed_base().expect("build endpoint");
    let mut obj = serde_json::json!({
        "newapi_base_url": official,
        "newapi_user_id": 7,
        "newapi_executor_base_url": format!("{official}/v1"),
        "newapi_executor_api_key": "managed-key",
        "managed_models": ["MiniMax-M3"],
        "executor_provider": "openai",
        "executor_model": "MiniMax-M3",
        "executor_base_url": "https://attacker.example/v1",
        "executor_api_key": "managed-key",
        "reviewer_provider": "custom",
        "reviewer_model": "own-model",
        "reviewer_base_url": "https://byok.example/v1",
        "reviewer_api_key": "own-key",
        "verified_executors": [
            { "provider": "openai", "model": "MiniMax-M3", "base_url": "https://attacker.example/v1", "api_key": "managed-key" },
            { "provider": "openai", "model": "own-model", "base_url": "https://byok.example/v1", "api_key": "own-key" }
        ]
    })
    .as_object()
    .unwrap()
    .clone();

    assert!(sanitize_legacy_managed_http(&mut obj));
    assert!(obj.get("executor_api_key").is_none());
    assert!(obj.get("executor_base_url").is_none());
    assert_eq!(obj["reviewer_base_url"], "https://byok.example/v1");
    assert_eq!(obj["reviewer_api_key"], "own-key");
    assert_eq!(read_verified(&obj).len(), 1);

    normalize_managed_model_slots(&mut obj).expect("normalize safe config");
    assert!(obj.get("executor_base_url").is_none());
    assert!(obj.get("executor_api_key").is_none());
    assert_eq!(obj["newapi_executor_base_url"], format!("{official}/v1"));
    assert_eq!(obj["newapi_executor_api_key"], "managed-key");
}

#[test]
fn orphaned_managed_key_is_not_treated_as_a_byok_credential() {
    let official = crate::newapi::configured_managed_base().expect("build endpoint");
    let mut obj = serde_json::json!({
        "newapi_executor_base_url": format!("{official}/v1"),
        "newapi_executor_api_key": "orphaned-managed-key",
        "managed_models": ["MiniMax-M3"],
        "executor_provider": "openai",
        "executor_model": "MiniMax-M3",
        "executor_base_url": "https://byok.example/v1",
        "executor_api_key": "orphaned-managed-key",
        "verified_executors": [
            { "provider": "openai", "model": "MiniMax-M3", "base_url": "https://byok.example/v1", "api_key": "orphaned-managed-key" }
        ]
    })
    .as_object()
    .unwrap()
    .clone();

    assert!(sanitize_legacy_managed_http(&mut obj));
    assert!(obj.get("newapi_executor_api_key").is_none());
    assert!(obj.get("newapi_executor_base_url").is_none());
    assert!(obj.get("managed_models").is_none());
    assert!(obj.get("executor_api_key").is_none());
    assert!(obj.get("executor_base_url").is_none());
    assert!(read_verified(&obj).is_empty());
}

#[test]
fn clear_newapi_session_also_discards_retired_third_party_keys() {
    let _guard = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let previous_home = std::env::var("HOME").ok();
    let previous_userprofile = std::env::var("USERPROFILE").ok();
    let home = temp_dir("clear-newapi");
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);

    let config_path = crate::state::config_path();
    std::fs::create_dir_all(config_path.parent().expect("config parent"))
        .expect("create config parent");
    std::fs::write(
        &config_path,
        serde_json::json!({
            "newapi_base_url": "http://gateway.example",
            "newapi_user_id": 7,
            "newapi_username": "user",
            "newapi_access_token": "access-token",
            "newapi_executor_base_url": "http://gateway.example/v1",
            "newapi_executor_api_key": "gateway-token",
            "managed_models": ["MiniMax-M3"],
            "executor_provider": "openai",
            "executor_model": "MiniMax-M3",
            "executor_base_url": "http://gateway.example/v1",
            "executor_api_key": "gateway-token",
            "reviewer_provider": "custom",
            "reviewer_model": "deepseek-v4-pro",
            "reviewer_base_url": "http://gateway.example/v1",
            "reviewer_api_key": "gateway-token",
            "summarizer_provider": "openai",
            "summarizer_model": "MiniMax-M2.7",
            "summarizer_base_url": "https://api.minimaxi.com/v1",
            "summarizer_api_key": "summarizer-token",
            "verified_executors": [
                {
                    "provider": "openai",
                    "model": "MiniMax-M3",
                    "base_url": "http://gateway.example/v1",
                    "api_key": "gateway-token"
                },
                {
                    "provider": "openai",
                    "model": "gpt-5.5",
                    "base_url": "https://api.openai.com/v1",
                    "api_key": "openai-token"
                }
            ]
        })
        .to_string(),
    )
    .expect("write config");

    clear_newapi_session().expect("clear newapi");
    let saved = crate::config::load_object();
    assert!(saved.get("newapi_access_token").is_none());
    assert!(saved.get("newapi_executor_api_key").is_none());
    assert!(saved.get("executor_api_key").is_none());
    assert!(saved.get("reviewer_api_key").is_none());
    assert!(saved.get("summarizer_api_key").is_none());

    let verified = read_verified(&saved);
    assert!(verified.is_empty());

    let _ = std::fs::remove_dir_all(&home);
    restore_home(previous_home, previous_userprofile);
}

#[test]
fn clear_newapi_session_keeps_managed_reviewer_model() {
    let _guard = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let previous_home = std::env::var("HOME").ok();
    let previous_userprofile = std::env::var("USERPROFILE").ok();
    let home = temp_dir("clear-newapi-reviewer");
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);

    let config_path = crate::state::config_path();
    std::fs::create_dir_all(config_path.parent().expect("config parent"))
        .expect("create config parent");
    std::fs::write(
        &config_path,
        serde_json::json!({
            "newapi_base_url": "http://gateway.example",
            "newapi_executor_base_url": "http://gateway.example/v1",
            "newapi_executor_api_key": "gateway-token",
            "managed_models": ["MiniMax-M3", "deepseek-v4-pro"],
            "executor_provider": "openai",
            "executor_model": "MiniMax-M3",
            "executor_base_url": "http://gateway.example/v1",
            "executor_api_key": "gateway-token",
            "reviewer_provider": "custom",
            "reviewer_model": "deepseek-v4-pro",
            "reviewer_base_url": "http://gateway.example/v1",
            "reviewer_api_key": "gateway-token"
        })
        .to_string(),
    )
    .expect("write config");

    clear_newapi_session().expect("clear newapi");
    let saved = crate::config::load_object();
    // The managed credentials are gone…
    assert!(saved.get("reviewer_api_key").is_none());
    assert!(saved.get("reviewer_base_url").is_none());
    assert!(saved.get("reviewer_provider").is_none());
    // …but the model choice survives so the next login can restore it.
    assert_eq!(saved["reviewer_model"], "deepseek-v4-pro");

    // Simulate the next login re-populating managed creds + model list, then
    // normalizing: the reviewer slot is rebuilt from the preserved model id.
    let mut obj = saved;
    obj.insert(
        "managed_models".to_string(),
        serde_json::json!(["MiniMax-M3", "deepseek-v4-pro"]),
    );
    obj.insert(
        "newapi_executor_base_url".to_string(),
        Value::String("http://gateway.example/v1".to_string()),
    );
    obj.insert(
        "newapi_executor_api_key".to_string(),
        Value::String("gateway-token".to_string()),
    );
    normalize_managed_model_slots(&mut obj).expect("normalize");
    assert_eq!(obj["reviewer_provider"], "custom");
    assert_eq!(obj["reviewer_model"], "deepseek-v4-pro");
    assert_eq!(obj["reviewer_base_url"], "http://gateway.example/v1");
    assert_eq!(obj["reviewer_api_key"], "gateway-token");

    let _ = std::fs::remove_dir_all(&home);
    restore_home(previous_home, previous_userprofile);
}



#[test]
fn forced_reviewer_environment_marks_reviewer_disabled_after_clearing() {
    let _guard = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    std::env::set_var("ARIS_REVIEWER_PROVIDER", "openai");
    std::env::set_var("ARIS_REVIEWER_MODEL", "gpt-5.5");
    std::env::set_var("ARIS_REVIEWER_BASE_URL", "https://old.example/v1");
    std::env::set_var("ARIS_REVIEWER_AUTH_TOKEN", "old-token");
    std::env::set_var("ARIS_REVIEWER_ROUTING_SESSION_BASE_URL", "https://old.example/v1");

    apply_reviewer_environment_from(&Map::new(), true);

    assert_eq!(
        std::env::var("ARIS_REVIEWER_PROVIDER").as_deref(),
        Ok("none")
    );
    assert!(std::env::var("ARIS_REVIEWER_MODEL").is_err());
    assert!(std::env::var("ARIS_REVIEWER_BASE_URL").is_err());
    assert!(std::env::var("ARIS_REVIEWER_AUTH_TOKEN").is_err());
    assert!(std::env::var("ARIS_REVIEWER_ROUTING_SESSION_BASE_URL").is_err());
    std::env::remove_var("ARIS_REVIEWER_PROVIDER");
}

#[test]
fn account_reviewer_exports_gateway_session_metadata_and_clears_it_on_switch() {
    let _guard = crate::test_env_lock().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let keys = ["ARIS_REVIEWER_PROVIDER", "ARIS_REVIEWER_MODEL", "ARIS_REVIEWER_BASE_URL", "ARIS_REVIEWER_AUTH_TOKEN", "ARIS_REVIEWER_ROUTING_SESSION_BASE_URL"];
    let prior: Vec<_> = keys.iter().map(|key| (*key, std::env::var(key).ok())).collect();
    let mut obj = serde_json::json!({
        "reviewer_provider": "custom", "reviewer_model": "MiniMax-M3",
        "reviewer_base_url": "https://gateway.test/v1",
        "newapi_executor_base_url": "https://gateway.test/v1",
        "newapi_executor_api_key": "gateway-token",
    }).as_object().unwrap().clone();
    apply_reviewer_environment_from(&obj, true);
    assert_eq!(std::env::var("ARIS_REVIEWER_ROUTING_SESSION_BASE_URL").as_deref(), Ok("https://gateway.test/v1"));
    // The account key reaches the Reviewer in-process, never via the
    // environment every Agent command inherits.
    assert!(std::env::var("ARIS_REVIEWER_AUTH_TOKEN").is_err());
    assert_eq!(tools::process_secrets::secret_var("ARIS_REVIEWER_AUTH_TOKEN").as_deref(), Some("gateway-token"));
    assert_eq!(tools::prepare_llm_review(None).unwrap().figure_identity().model, "MiniMax-M3");
    obj.remove("newapi_executor_base_url");
    obj.remove("newapi_executor_api_key");
    obj.insert("reviewer_api_key".into(), Value::String("own-token".into()));
    apply_reviewer_environment_from(&obj, true);
    assert!(std::env::var("ARIS_REVIEWER_ROUTING_SESSION_BASE_URL").is_err());
    // A retired key cannot replace the account's in-process credential.
    assert!(std::env::var("ARIS_REVIEWER_AUTH_TOKEN").is_err());
    assert!(tools::process_secrets::secret_var("ARIS_REVIEWER_AUTH_TOKEN").is_none());
    for (key, value) in prior {
        match value { Some(value) => std::env::set_var(key, value), None => std::env::remove_var(key) }
    }
}

#[test]
fn forced_reviewer_environment_sets_account_values_without_exporting_key() {
    let _guard = crate::test_env_lock().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    std::env::set_var("ARIS_REVIEWER_PROVIDER", "openai");
    std::env::set_var("ARIS_REVIEWER_MODEL", "old-model");
    std::env::set_var("ARIS_REVIEWER_AUTH_TOKEN", "old-token");
    let obj = serde_json::json!({
        "reviewer_provider": "custom", "reviewer_model": "gpt-5.5",
        "reviewer_base_url": "https://gateway.test/v1",
        "newapi_executor_base_url": "https://gateway.test/v1",
        "newapi_executor_api_key": "new-token"
    }).as_object().unwrap().clone();
    apply_reviewer_environment_from(&obj, true);
    assert_eq!(std::env::var("ARIS_REVIEWER_PROVIDER").as_deref(), Ok("custom"));
    assert_eq!(std::env::var("ARIS_REVIEWER_MODEL").as_deref(), Ok("gpt-5.5"));
    assert_eq!(std::env::var("ARIS_REVIEWER_BASE_URL").as_deref(), Ok("https://gateway.test/v1"));
    assert!(std::env::var("ARIS_REVIEWER_AUTH_TOKEN").is_err());
    assert_eq!(tools::process_secrets::secret_var("ARIS_REVIEWER_AUTH_TOKEN").as_deref(), Some("new-token"));
    apply_reviewer_environment_from(&Map::new(), true);
}

/// Point `config.json` at a fresh temp HOME for one test.
fn with_temp_home(name: &str, body: impl FnOnce(&std::path::Path)) {
    let _guard = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let previous_home = std::env::var("HOME").ok();
    let previous_userprofile = std::env::var("USERPROFILE").ok();
    let home = temp_dir(name);
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    let config_path = crate::state::config_path();
    std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("config dir");
    body(&config_path);
    let _ = std::fs::remove_dir_all(&home);
    restore_home(previous_home, previous_userprofile);
}

fn signed_in_config(official: &str) -> Value {
    serde_json::json!({
        "newapi_base_url": official,
        "newapi_user_id": 7,
        "newapi_executor_base_url": format!("{official}/v1"),
        "managed_models": ["MiniMax-M3"],
        "executor_provider": "openai",
        "executor_model": "MiniMax-M3",
        "executor_base_url": format!("{official}/v1"),
        "reviewer_provider": "custom",
        "reviewer_model": "MiniMax-M3",
        "reviewer_base_url": format!("{official}/v1"),
        "verified_executors": [
            { "provider": "openai", "model": "MiniMax-M3", "base_url": format!("{official}/v1"), "api_key": "" },
            { "provider": "openai", "model": "gpt-5.5", "base_url": "https://api.openai.com/v1", "api_key": "own-key" }
        ]
    })
}

#[test]
fn account_model_key_stays_out_of_config_json_but_reaches_every_reader() {
    let official = crate::newapi::configured_managed_base().expect("build endpoint");
    with_temp_home("managed-key-overlay", |config_path| {
        std::fs::write(config_path, signed_in_config(&official).to_string()).expect("write config");

        crate::config::persist_newapi_executor_credentials(&official, "sk-account", Some(5))
            .expect("persist credentials");

        let on_disk = std::fs::read_to_string(config_path).expect("read config");
        assert!(!on_disk.contains("sk-account"), "key written to config.json: {on_disk}");
        let stored = crate::managed_key::stored_for_tests(&official).expect("credential stored");
        assert_eq!(stored.key, "sk-account");
        assert_eq!(stored.token_id, Some(5));

        // A fresh process reads it back from the credential store.
        crate::managed_key::forget_cache_for_tests();
        let obj = crate::config::load_object();
        assert_eq!(obj["newapi_executor_api_key"], "sk-account");
        assert_eq!(obj["executor_api_key"], "sk-account");
        assert_eq!(obj["reviewer_api_key"], "sk-account");
        let verified = read_verified(&obj);
        assert_eq!(verified[0].api_key, "sk-account");
        assert_eq!(verified.len(), 1);
        assert_eq!(
            crate::config::cached_newapi_token_key(&official, 5).as_deref(),
            Some("sk-account")
        );
        assert!(crate::config::cached_newapi_token_key(&official, 6).is_none());

        // Saving a read config never restores retired third-party keys.
        crate::config::save_object(&obj).expect("save");
        let on_disk = std::fs::read_to_string(config_path).expect("read config");
        assert!(!on_disk.contains("sk-account"), "key written back on save: {on_disk}");
        assert!(!on_disk.contains("own-key"));

        clear_newapi_session().expect("logout");
        crate::managed_key::forget_cache_for_tests();
        assert!(crate::managed_key::stored_for_tests(&official).is_none());
        let obj = crate::config::load_object();
        assert!(obj.get("newapi_executor_api_key").is_none());
        assert!(obj.get("executor_api_key").is_none());
    });
}

#[test]
fn startup_moves_a_plaintext_account_key_into_the_credential_store() {
    let official = crate::newapi::configured_managed_base().expect("build endpoint");
    with_temp_home("managed-key-migration", |config_path| {
        let mut legacy = signed_in_config(&official);
        legacy["newapi_executor_api_key"] = Value::String("sk-legacy".into());
        legacy["newapi_token_id"] = Value::from(9);
        legacy["executor_api_key"] = Value::String("sk-legacy".into());
        legacy["reviewer_api_key"] = Value::String("sk-legacy".into());
        legacy["verified_executors"][0]["api_key"] = Value::String("sk-legacy".into());
        std::fs::write(config_path, legacy.to_string()).expect("write config");

        assert!(crate::config::move_managed_key_to_credential_store().expect("migrate"));

        let on_disk = std::fs::read_to_string(config_path).expect("read config");
        assert!(!on_disk.contains("sk-legacy"), "plaintext left behind: {on_disk}");
        let stored = crate::managed_key::stored_for_tests(&official).expect("credential stored");
        assert_eq!(stored.key, "sk-legacy");
        assert_eq!(stored.token_id, Some(9));
        assert_eq!(crate::config::load_object()["executor_api_key"], "sk-legacy");
        assert!(!crate::config::move_managed_key_to_credential_store().expect("second run"));
        clear_newapi_session().expect("logout");
    });
}

#[test]
fn account_key_is_not_laid_over_a_model_endpoint_on_another_host() {
    let official = crate::newapi::configured_managed_base().expect("build endpoint");
    with_temp_home("managed-key-other-host", |config_path| {
        std::fs::write(config_path, signed_in_config(&official).to_string()).expect("write config");
        crate::config::persist_newapi_executor_credentials(&official, "sk-account", Some(5))
            .expect("persist credentials");
        let mut tampered = serde_json::from_str::<Value>(
            &std::fs::read_to_string(config_path).expect("read config"),
        )
        .expect("config JSON");
        tampered["newapi_executor_base_url"] = Value::String("https://attacker.example/v1".into());
        tampered["executor_base_url"] = Value::String("https://attacker.example/v1".into());
        std::fs::write(config_path, tampered.to_string()).expect("write tampered config");

        let obj = crate::config::load_object();
        assert!(obj.get("newapi_executor_api_key").is_none());
        assert!(obj.get("executor_api_key").is_none());
        clear_newapi_session().expect("logout");
    });
}

#[test]
fn a_replaced_account_key_reaches_in_process_readers() {
    let official = crate::newapi::configured_managed_base().expect("build endpoint");
    with_temp_home("managed-key-rotation", |config_path| {
        std::fs::write(config_path, signed_in_config(&official).to_string()).expect("write config");
        crate::config::persist_newapi_executor_credentials(&official, "sk-old", Some(5))
            .expect("persist old key");
        apply_reviewer_environment_from(&crate::config::load_object(), true);
        assert_eq!(
            tools::process_secrets::secret_var("ARIS_REVIEWER_AUTH_TOKEN").as_deref(),
            Some("sk-old")
        );

        crate::config::persist_newapi_executor_credentials(&official, "sk-new", Some(6))
            .expect("persist new key");

        assert_eq!(
            tools::process_secrets::secret_var("ARIS_REVIEWER_AUTH_TOKEN").as_deref(),
            Some("sk-new")
        );
        assert!(std::env::var("ARIS_REVIEWER_AUTH_TOKEN").is_err());
        clear_newapi_session().expect("logout");
        apply_reviewer_environment_from(&Map::new(), true);
        for key in [
            "ARIS_REVIEWER_PROVIDER",
            "ARIS_REVIEWER_MODEL",
            "ARIS_REVIEWER_BASE_URL",
            "ARIS_REVIEWER_ROUTING_SESSION_BASE_URL",
        ] {
            std::env::remove_var(key);
        }
    });
}

#[test]
fn startup_cleans_legacy_keys_and_keeps_account_executor_and_reviewer() {
    let official = crate::newapi::configured_managed_base().unwrap();
    with_temp_home("retired-api-migration", |config_path| {
        let mut legacy = signed_in_config(&official);
        legacy["managed_models"] = serde_json::json!(["MiniMax-M3", "gpt-5.5"]);
        legacy["reviewer_model"] = Value::String("gpt-5.5".into());
        legacy["newapi_executor_api_key"] = Value::String("sk-account".into());
        legacy["executor_api_key"] = Value::String("sk-account".into());
        legacy["reviewer_api_key"] = Value::String("sk-account".into());
        for field in ["summarizer_api_key", "scopus_api_key", "openalex_api_key",
            "bocha_api_key", "brave_search_api_key", "exa_api_key", "zhihu_access_secret"] {
            legacy[field] = Value::String("old-third-party".into());
        }
        legacy["summarizer_provider"] = Value::String("anthropic".into());
        legacy["summarizer_base_url"] = Value::String("https://third-party.example".into());
        std::fs::write(config_path, legacy.to_string()).unwrap();
        super::move_managed_key_to_credential_store().unwrap();
        super::retire_third_party_api_settings().unwrap();
        let saved = std::fs::read_to_string(config_path).unwrap();
        for secret in ["old-third-party", "own-key", "sk-account"] {
            assert!(!saved.contains(secret));
        }
        let loaded = super::managed_config_object().unwrap();
        assert_eq!(loaded["executor_api_key"], "sk-account");
        assert_eq!(loaded["reviewer_api_key"], "sk-account");
        assert_eq!(loaded["executor_model"], "MiniMax-M3");
        assert_eq!(loaded["reviewer_model"], "gpt-5.5");
        assert!(loaded.get("summarizer_provider").is_none());
        assert!(loaded.get("scopus_api_key").is_none());
        assert_eq!(read_verified(&loaded).len(), 1);
        assert!(!super::retire_third_party_api_settings().unwrap());
        clear_newapi_session().unwrap();
    });
}

#[test]
fn legacy_keys_are_ignored_before_cleanup_without_changing_preferences() {
    with_temp_home("retired-api-read", |config_path| {
        let legacy = serde_json::json!({
            "executor_provider":"openai", "executor_model":"own-model",
            "executor_base_url":"https://third-party.example/v1",
            "executor_api_key":"old-third-party", "scopus_api_key":"old-third-party",
            "language":"en", "memory_write_approval":true,
            "verified_executors":[{"provider":"openai","model":"own-model",
                "base_url":"https://third-party.example/v1","api_key":"old-third-party"}]
        }).to_string();
        std::fs::write(config_path, &legacy).unwrap();
        let loaded = super::load_object();
        assert!(loaded.get("executor_api_key").is_none());
        assert!(loaded.get("executor_base_url").is_none());
        assert!(loaded.get("scopus_api_key").is_none());
        assert!(read_verified(&loaded).is_empty());
        assert_eq!(std::fs::read_to_string(config_path).unwrap(), legacy);
        assert!(super::retire_third_party_api_settings().unwrap());
        let saved = std::fs::read_to_string(config_path).unwrap();
        assert!(!saved.contains("old-third-party"));
        let saved: Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(saved["language"], "en");
        assert_eq!(saved["memory_write_approval"], true);
    });
}

#[test]
fn manual_connections_are_rejected_and_account_choices_remain_available() {
    let official = crate::newapi::configured_managed_base().unwrap();
    let mut obj = signed_in_config(&official).as_object().unwrap().clone();
    obj.insert("managed_models".into(), serde_json::json!(["MiniMax-M3", "gpt-5.5"]));
    for value in [
        serde_json::json!({"executorProvider":"openai","executorBaseUrl":"https://third-party.example/v1","executorModel":"own"}),
        serde_json::json!({"reviewerProvider":"custom","reviewerModel":"own"}),
        serde_json::json!({"summarizerProvider":"openai","summarizerBaseUrl":"https://third-party.example/v1"})
    ] {
        let patch: ConfigPatch = serde_json::from_value(value).unwrap();
        assert!(patch.validate_account_settings(&obj).is_err());
    }
    for value in [
        serde_json::json!({"executorProvider":"openai","executorModel":"MiniMax-M3"}),
        serde_json::json!({"reviewerProvider":"custom","reviewerModel":"gpt-5.5"}),
        serde_json::json!({"summarizerModel":"gpt-5.5"}),
        serde_json::json!({"reviewerProvider":"","reviewerModel":"","reviewerBaseUrl":""})
    ] {
        let patch: ConfigPatch = serde_json::from_value(value).unwrap();
        assert!(patch.validate_account_settings(&obj).is_ok());
    }
}
