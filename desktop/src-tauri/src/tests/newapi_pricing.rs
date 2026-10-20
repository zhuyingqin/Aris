use super::*;
use serde_json::json;

/// Explicit opt-in contract check against the signed-in account. Never prints credentials.
#[tokio::test]
#[ignore = "uses the local signed-in account and the live gateway"]
async fn live_account_price_catalog() {
    let client = account_http_client_builder(Duration::from_secs(20))
        .build()
        .unwrap();
    // A failed diagnostic must not clear the user's session.
    let (base, session) = authenticated_stored_session(&client).await.unwrap();
    let (account, prices) = tokio::try_join!(
        user_self(&client, &base, &session),
        fetch_pricing(&client, &base, &session)
    )
    .unwrap();
    let fetched_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let catalog = parse_catalog(&prices, &account, fetched_at).unwrap();
    if let Ok(directory) = std::env::var("SOMNIQ_PRICING_PROBE_DIR") {
        let directory = std::path::Path::new(&directory);
        std::fs::write(
            directory.join("live-catalog.json"),
            serde_json::to_vec_pretty(&catalog).unwrap(),
        )
        .unwrap();
        let fields = [
            "model_name",
            "quota_type",
            "model_ratio",
            "completion_ratio",
            "cache_ratio",
            "create_cache_ratio",
            "enable_groups",
            "billing_mode",
            "billing_expr",
        ];
        let models: Vec<Value> = prices
            .get("data")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .map(|item| {
                Value::Object(
                    fields
                        .iter()
                        .filter_map(|key| {
                            item.get(*key)
                                .map(|value| ((*key).to_string(), value.clone()))
                        })
                        .collect(),
                )
            })
            .collect();
        let evidence = json!({ "group": catalog.group, "keys": prices.as_object().unwrap().keys().collect::<Vec<_>>(), "group_ratio": prices.get("group_ratio"), "models": models });
        std::fs::write(
            directory.join("live-price-fields.json"),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
    }
    let baseline = catalog
        .models
        .iter()
        .find(|price| price.model == "deepseek-v4.1-flash")
        .expect("DeepSeek baseline is missing");
    assert_eq!(baseline.billing, "tokens");
    assert!(baseline.input_rate.unwrap() + baseline.output_rate.unwrap() > 0.0);
    let peak = catalog
        .peak_baseline
        .as_ref()
        .expect("DeepSeek peak reference is missing");
    assert_eq!(peak.model, BASELINE_MODEL);
    assert_eq!(peak.tier.as_deref(), Some("peak"));
    assert!(peak.input_rate.unwrap() + peak.output_rate.unwrap() > 0.0);
    println!(
        "Verified {} account model prices against the live gateway",
        catalog.models.len()
    );
}

fn catalog(items: Value) -> ModelPricingCatalog {
    parse_catalog(
        &json!({ "data": items, "group_ratio": { "go": 1.5, "other": 0.2 } }),
        &json!({ "username": "researcher", "group": "go" }),
        123,
    )
    .unwrap()
}

#[test]
fn prices_use_current_group_and_separate_output_and_cache_weights() {
    let parsed = catalog(json!([{
        "model_name": "deepseek-v4.1-flash", "quota_type": 0,
        "model_ratio": 0.1, "completion_ratio": 4, "cache_ratio": 0.1,
        "create_cache_ratio": 1.25, "enable_groups": ["go", "other"],
        "description": "private upstream metadata is not forwarded"
    }]));
    let price = &parsed.models[0];
    assert_eq!(price.billing, "tokens");
    assert!((price.input_rate.unwrap() - 0.3).abs() < 1e-12);
    assert!((price.output_rate.unwrap() - 1.2).abs() < 1e-12);
    assert!((price.cache_read_rate.unwrap() - 0.03).abs() < 1e-12);
    assert!((price.cache_creation_rate.unwrap() - 0.375).abs() < 1e-12);
    assert!(!serde_json::to_string(&parsed)
        .unwrap()
        .contains("private upstream"));
}

#[test]
fn unknown_missing_and_other_group_rates_never_become_free() {
    for fields in [
        json!({ "completion_ratio": 4, "enable_groups": ["go"] }),
        json!({ "model_ratio": 0.1, "enable_groups": ["go"] }),
        json!({ "model_ratio": -1, "completion_ratio": 4, "enable_groups": ["go"] }),
        json!({ "model_ratio": 0.1, "completion_ratio": 4, "enable_groups": ["other"] }),
        json!({ "model_ratio": "NaN", "completion_ratio": 4, "enable_groups": ["all"] }),
    ] {
        let mut item = fields;
        item["model_name"] = json!("model");
        item["quota_type"] = json!(0);
        let parsed = catalog(json!([item]));
        assert_eq!(parsed.models[0].billing, "unknown");
        assert_eq!(parsed.models[0].input_rate, None);
    }
    let no_group = parse_catalog(
        &json!({ "data": [{ "model_name": "model", "quota_type": 0,
        "model_ratio": 1, "completion_ratio": 4, "enable_groups": ["all"] }] }),
        &json!({ "username": "researcher", "group": "go" }),
        123,
    )
    .unwrap();
    assert_eq!(no_group.models[0].billing, "unknown");
}

#[test]
fn distinct_billing_types_and_confirmed_free_rates_survive_normalization() {
    let parsed = catalog(json!([
        { "model_name": "image", "quota_type": 1, "model_price": 0.2, "enable_groups": ["all"] },
        { "model_name": "tiered", "quota_type": 0, "model_ratio": 1, "completion_ratio": 4,
          "billing_mode": "tiered_expr", "billing_expr": "a + b", "enable_groups": ["go"] },
        { "model_name": "plugin", "quota_type": 0, "model_ratio": 1, "completion_ratio": 4,
          "billing_plugin_variants": [{}], "enable_groups": ["go"] },
        { "model_name": "free", "quota_type": 0, "model_ratio": 0, "completion_ratio": 4, "enable_groups": ["go"] },
        { "model_name": "deepseek-search", "quota_type": 1, "enable_groups": ["go"] }
    ]));
    let find = |name: &str| {
        parsed
            .models
            .iter()
            .find(|price| price.model == name)
            .unwrap()
    };
    assert_eq!(find("image").billing, "per_request");
    assert_eq!(find("tiered").billing, "tiered");
    assert_eq!(find("plugin").billing, "tiered");
    assert_eq!(find("free").input_rate, Some(0.0));
    assert_eq!(find("free").output_rate, Some(0.0));
    assert_eq!(parsed.models.len(), 4);
}

#[test]
fn conflicting_prices_and_invalid_shapes_fail_closed() {
    let parsed = catalog(json!([
        { "model_name": "model", "quota_type": 0, "model_ratio": 1, "completion_ratio": 4, "enable_groups": ["go"] },
        { "model_name": "model", "quota_type": 0, "model_ratio": 2, "completion_ratio": 4, "enable_groups": ["go"] }
    ]));
    assert_eq!(parsed.models[0].billing, "unknown");
    assert!(parse_catalog(
        &json!({ "data": {} }),
        &json!({ "username": "x", "group": "go" }),
        0
    )
    .is_err());
    assert!(parse_catalog(&json!({ "data": [] }), &json!({ "group": "go" }), 0).is_err());
}

const TIMED_DEEPSEEK: &str = r#"weekday("Asia/Shanghai") >= 1 && weekday("Asia/Shanghai") <= 5
&& ((hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 12)
|| (hour("Asia/Shanghai") >= 14 && hour("Asia/Shanghai") < 18))
? tier("peak", p * 2 + cr * 0.04 + c * 8)
: tier("off_peak", p * 1 + cr * 0.02 + c * 4)"#;

#[test]
fn observed_time_pricing_uses_china_weekdays_and_refreshes_at_the_minute_boundary() {
    for (date, input, tier) in [
        ("2026-10-20T00:59:59Z", 1.0, "off_peak"),
        ("2026-10-20T01:00:00Z", 2.0, "peak"),
        ("2026-10-20T04:00:00Z", 1.0, "off_peak"),
        ("2026-10-20T06:00:00Z", 2.0, "peak"),
        ("2026-10-20T10:00:00Z", 1.0, "off_peak"),
        ("2026-10-24T01:00:00Z", 1.0, "off_peak"),
    ] {
        let timestamp = chrono::DateTime::parse_from_rfc3339(date)
            .unwrap()
            .timestamp_millis() as u64;
        let prices = json!({ "group_ratio": { "go": 1.5 }, "data": [{ "model_name": "deepseek-v4.1-flash",
            "quota_type": 0, "billing_mode": "tiered_expr", "billing_expr": TIMED_DEEPSEEK, "enable_groups": ["go"] }] });
        let catalog = parse_catalog(
            &prices,
            &json!({ "username": "researcher", "group": "go" }),
            timestamp,
        )
        .unwrap();
        let price = &catalog.models[0];
        assert_eq!(price.billing, "tokens");
        assert_eq!(price.input_rate, Some(input * 1.5));
        assert_eq!(price.tier.as_deref(), Some(tier));
        assert_eq!(price.cache_creation_rate, price.input_rate);
        let peak = catalog.peak_baseline.as_ref().unwrap();
        assert_eq!(peak.input_rate, Some(3.0));
        assert_eq!(peak.output_rate, Some(12.0));
        assert_eq!(peak.cache_read_rate, Some(0.06));
        assert_eq!(peak.tier.as_deref(), Some("peak"));
        assert_eq!(catalog.valid_until, (timestamp / 60_000 + 1) * 60_000);
    }
}

#[test]
fn peak_reference_uses_the_same_context_and_rejects_missing_or_conflicting_peak_prices() {
    let timestamp = chrono::DateTime::parse_from_rfc3339("2026-10-24T04:00:00Z")
        .unwrap()
        .timestamp_millis() as u64;
    let item = |source: &str| {
        json!({ "model_name": BASELINE_MODEL, "billing_mode": "tiered_expr",
        "billing_expr": source, "enable_groups": ["go"] })
    };
    let prices = |items| {
        parse_catalog(
            &json!({ "data": items, "group_ratio": { "go": 1 } }),
            &json!({ "username": "researcher", "group": "go" }),
            timestamp,
        )
        .unwrap()
    };
    let context = format!("len <= 272000 ? ({TIMED_DEEPSEEK}) : tier(\"peak\", p * 100 + c * 200)");
    let parsed = prices(json!([item(&context)]));
    assert_eq!(parsed.models[0].tier.as_deref(), Some("off_peak"));
    assert_eq!(parsed.peak_baseline.unwrap().input_rate, Some(2.0));
    let renamed = TIMED_DEEPSEEK.replace("\"peak\"", "\"busy\"");
    assert!(prices(json!([item(&renamed)])).peak_baseline.is_none());
    let different_peak = TIMED_DEEPSEEK.replace("p * 2", "p * 3");
    let conflict = prices(json!([item(TIMED_DEEPSEEK), item(&different_peak)]));
    assert_eq!(conflict.models[0].billing, "tokens");
    assert!(conflict.peak_baseline.is_none());
}

#[test]
fn context_tiers_mixed_price_units_and_fixed_requests_have_distinct_meanings() {
    let source = r#"len <= 272000 ? tier("short", p * 2 + c * 10 + cr * 0.2 + cc * 2.5) : tier("long", p * 4 + c * 15 + cr * 0.4 + cc * 5)"#;
    let short = expression::evaluate(source, 123, 272000).unwrap().0;
    let long = expression::evaluate(source, 123, 272001).unwrap().0;
    assert_eq!(short.rates, [2.0, 10.0, 0.2, 2.5]);
    assert_eq!(long.rates, [4.0, 15.0, 0.4, 5.0]);
    let parsed = catalog(json!([
        { "model_name": "old", "quota_type": 0, "model_ratio": 0.5, "completion_ratio": 4, "enable_groups": ["go"] },
        { "model_name": "new", "quota_type": 0, "billing_mode": "tiered_expr", "billing_expr": "tier(\"standard\", p * 1 + c * 4)", "enable_groups": ["go"] },
        { "model_name": "named-free-but-paid-per-request", "quota_type": 0, "billing_mode": "tiered_expr", "billing_expr": "tier(\"base\", fixed(0.001))", "enable_groups": ["go"] }
    ]));
    let find = |name: &str| {
        parsed
            .models
            .iter()
            .find(|price| price.model == name)
            .unwrap()
    };
    assert_eq!(find("old").input_rate, find("new").input_rate);
    assert_eq!(find("old").output_rate, find("new").output_rate);
    assert_eq!(
        find("named-free-but-paid-per-request").billing,
        "per_request"
    );
}

#[test]
fn unsupported_nonlinear_or_unbounded_expressions_have_no_numeric_price() {
    for source in [
        "tier(\"nonlinear\", p * c)",
        "tier(\"negative\", p * -1)",
        "tier(\"overflow\", p * 1e308 * 1e308)",
        "tier(\"request-dependent\", p * header(\"price\"))",
        "tier(\"division\", p / 0)",
        "tier(\"unknown\", hour(\"Unknown/Timezone\") * p)",
    ] {
        assert!(
            expression::evaluate(source, 123, 1000).is_none(),
            "{source}"
        );
    }
    assert!(expression::evaluate(&"(".repeat(100), 123, 1000).is_none());
    assert!(expression::evaluate(&"p".repeat(20_000), 123, 1000).is_none());
}
