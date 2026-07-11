use super::{format_usd, pricing_for_model, TokenUsage, UsageTracker};
use crate::session::{ContentBlock, ConversationMessage, MessageRole, Session};

fn assert_pricing(model: &str, input: f64, output: f64, cache_create: f64, cache_read: f64) {
    let p = pricing_for_model(model).unwrap_or_else(|| panic!("no pricing for {model}"));
    assert_eq!(p.input_cost_per_million, input, "input for {model}");
    assert_eq!(p.output_cost_per_million, output, "output for {model}");
    assert_eq!(
        p.cache_creation_cost_per_million, cache_create,
        "cache_create for {model}"
    );
    assert_eq!(
        p.cache_read_cost_per_million, cache_read,
        "cache_read for {model}"
    );
}

#[test]
fn tracks_true_cumulative_usage() {
    let mut tracker = UsageTracker::new();
    tracker.record(TokenUsage {
        input_tokens: 10,
        output_tokens: 4,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
    });
    tracker.record(TokenUsage {
        input_tokens: 20,
        output_tokens: 6,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
    });

    assert_eq!(tracker.turns(), 2);
    assert_eq!(tracker.current_turn_usage().input_tokens, 20);
    assert_eq!(tracker.current_turn_usage().output_tokens, 6);
    assert_eq!(tracker.cumulative_usage().output_tokens, 10);
    assert_eq!(tracker.cumulative_usage().input_tokens, 30);
    assert_eq!(tracker.cumulative_usage().total_tokens(), 48);
}

#[test]
fn computes_cost_summary_lines() {
    let usage = TokenUsage {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
        cache_creation_input_tokens: 100_000,
        cache_read_input_tokens: 200_000,
    };

    let cost = usage.estimate_cost_usd();
    assert_eq!(format_usd(cost.input_cost_usd), "$15.0000");
    assert_eq!(format_usd(cost.output_cost_usd), "$37.5000");
    let lines = usage.summary_lines_for_model("usage", Some("claude-sonnet-4-20250514"));
    assert!(lines[0].contains("estimated_cost=$10.9350"));
    assert!(lines[0].contains("model=claude-sonnet-4-20250514"));
    assert!(lines[1].contains("cache_read=$0.0600"));
}

#[test]
fn supports_model_specific_pricing() {
    let usage = TokenUsage {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    };

    let haiku = pricing_for_model("claude-haiku-4-5-20251001").expect("haiku pricing");
    let opus = pricing_for_model("claude-opus-4-7").expect("opus pricing");
    let haiku_cost = usage.estimate_cost_usd_with_pricing(haiku);
    let opus_cost = usage.estimate_cost_usd_with_pricing(opus);
    assert_eq!(format_usd(haiku_cost.total_cost_usd()), "$3.5000");
    assert_eq!(format_usd(opus_cost.total_cost_usd()), "$17.5000");
}

#[test]
fn marks_unknown_model_pricing_as_fallback() {
    let usage = TokenUsage {
        input_tokens: 100,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    };
    let lines = usage.summary_lines_for_model("usage", Some("custom-model"));
    assert!(lines[0].contains("pricing=estimated-default"));
}

#[test]
fn reconstructs_usage_from_session_messages() {
    let session = Session {
        version: 1,
        messages: vec![ConversationMessage {
            role: MessageRole::Assistant,
            blocks: vec![ContentBlock::Text {
                text: "done".to_string(),
            }],
            usage: Some(TokenUsage {
                input_tokens: 5,
                output_tokens: 2,
                cache_creation_input_tokens: 1,
                cache_read_input_tokens: 0,
            }),
        }],
        compactions: Vec::new(),
    };

    let tracker = UsageTracker::from_session(&session);
    assert_eq!(tracker.turns(), 1);
    assert_eq!(tracker.cumulative_usage().total_tokens(), 8);
}

// v0.4.13 regression — v0.4.12 P2 swapped the OSS provider lookup from
// `contains()` to `provider_match()`. That match requires the family
// name to appear at start-of-string OR after a `/`/`:` provider
// separator — never mid-word. This guards against three landmines at
// once:
//   (a) real model names (`kimi-k2.5`, `qwen3.6-plus`, `glm-4-plus`)
//       still resolve, including digit-suffix versions that
//       `has_word` would miss.
//   (b) provider-prefixed names (`openai/kimi-k2.5`) resolve via the
//       slash branch.
//   (c) user-named models with a family substring in the middle
//       (`my-kimi-clone`) do NOT silently route to the wrong tier —
//       they fall through to `None` so callers see the
//       `pricing=estimated-default` marker.
// Note: the start-of-string branch is intentionally permissive, so
// `kimiclone-foo` does match — documented behaviour we want to keep
// pinned so future tightening doesn't accidentally break the real
// `kimi-...` names.
#[test]
fn provider_match_distinguishes_real_vs_userdefined() {
    // Real model names — must resolve to the family tier.
    assert!(
        pricing_for_model("qwen3.6-plus").is_some(),
        "qwen3.6-plus is a real Qwen model and must price"
    );
    assert!(
        pricing_for_model("kimi-k2.5").is_some(),
        "kimi-k2.5 is a real Kimi model and must price"
    );
    assert!(
        pricing_for_model("glm-4-plus").is_some(),
        "glm-4-plus is a real GLM model and must price"
    );

    // Provider-prefixed forms must resolve via the `/` branch.
    assert!(
        pricing_for_model("openai/kimi-k2.5").is_some(),
        "openai/kimi-k2.5 must resolve via provider-prefix branch"
    );

    // Mid-word matches must NOT route — falls through to None so
    // callers see pricing=estimated-default rather than silently
    // billing at the Kimi tier for a user model that happens to
    // contain the substring.
    assert!(
        pricing_for_model("my-kimi-clone").is_none(),
        "my-kimi-clone must NOT match Kimi family (mid-word rejection)"
    );

    // Start-of-string matches stay permissive (documented behaviour).
    assert!(
        pricing_for_model("kimiclone-foo").is_some(),
        "kimiclone-foo starts with `kimi` so the provider_match prefix branch fires"
    );
}

/// Current Opus (4.5–4.8) is $5/$25 — NOT the old $15/$75 deprecated tier.
#[test]
fn price_opus() {
    assert_pricing("claude-opus-4-8", 5.0, 25.0, 6.25, 0.5);
    assert_pricing("claude-opus-4-7", 5.0, 25.0, 6.25, 0.5);
    assert_pricing("claude-opus-4-5", 5.0, 25.0, 6.25, 0.5);
}

/// Deprecated Opus 4.0 / 4.1 keep the legacy $15/$75 tier. Locks the
/// tier split so a current-minor (4.5+) never falls into legacy and a
/// legacy id never falls into current. `has_word` boundary handling means
/// `opus-4-1` matches 4.1 but NOT a future `opus-4-10`.
#[test]
fn price_opus_legacy() {
    assert_pricing("claude-opus-4-1", 15.0, 75.0, 18.75, 1.5);
    assert_pricing("claude-opus-4-20250514", 15.0, 75.0, 18.75, 1.5);
}

/// Sonnet 4.x is $3/$15 — NOT the deprecated $15/$75 Opus tier.
#[test]
fn price_sonnet() {
    assert_pricing("claude-sonnet-4-6", 3.0, 15.0, 3.75, 0.30);
    assert_pricing("claude-sonnet-4-20250514", 3.0, 15.0, 3.75, 0.30);
}
