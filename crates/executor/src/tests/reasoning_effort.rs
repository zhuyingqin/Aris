use super::{closest_level, levels_for_model, model_has_levels, ALL_LEVELS, DEFAULT_LEVEL};

/// The published per-model tables (OpenAI model pages, read 2026-09-02). These
/// are the assertions that would have caught the shipped bug: the composer
/// offered `minimal`, which none of the current high-end GPT families accept,
/// and hid `none` and `max`, which they do.
#[test]
fn gpt_families_get_their_published_levels() {
    assert_eq!(
        levels_for_model("gpt-5.6-sol"),
        ["none", "low", "medium", "high", "xhigh", "max"],
        "gpt-5.6 is the first family with `max`"
    );
    assert_eq!(
        levels_for_model("gpt-6-astra"),
        ["none", "low", "medium", "high", "xhigh", "max"],
        "gpt-6-astra follows the current GPT high-end reasoning ladder"
    );
    assert_eq!(
        levels_for_model("gpt-5.5"),
        ["none", "low", "medium", "high", "xhigh"]
    );
    assert_eq!(
        levels_for_model("gpt-5.4"),
        ["none", "low", "medium", "high", "xhigh"]
    );
    assert_eq!(
        levels_for_model("gpt-5.1"),
        ["none", "low", "medium", "high"],
        "xhigh had not shipped for the 5.1 family"
    );
    assert_eq!(
        levels_for_model("gpt-5-mini"),
        ["minimal", "low", "medium", "high"],
        "the original GPT-5 is the only family with `minimal`"
    );

    for model in [
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.1",
    ] {
        assert!(
            !levels_for_model(model).contains(&"minimal"),
            "{model} rejects `minimal`; offering it would 400 the turn"
        );
    }
}

#[test]
fn o_series_and_unknown_reasoners_keep_the_three_universal_levels() {
    // Provider-prefixed names must still be recognised (v0.4.12 P1.B).
    for model in ["o3-mini", "openai/o3", "proxy:o4", "o1"] {
        assert_eq!(
            levels_for_model(model),
            ["low", "medium", "high"],
            "{model}"
        );
    }
    // No published table for these, so nothing beyond the safe three.
    assert_eq!(
        levels_for_model("deepseek-v4-flash-free"),
        ["low", "medium", "high"]
    );
    assert_eq!(
        levels_for_model("glm-4.6-thinking"),
        ["low", "medium", "high"]
    );
}

#[test]
fn models_without_levels_take_no_field_at_all() {
    for model in ["MiniMax-M3", "gpt-4o", "kimi-k3"] {
        assert!(levels_for_model(model).is_empty(), "{model}");
        assert!(!model_has_levels(model), "{model}");
        assert_eq!(closest_level(model, "high"), None, "{model}");
    }
}

/// Claude never sees the word — `anthropic_thinking_config` turns it into a
/// budget — so every rung is meaningful, except `minimal` which would just be a
/// second name for `none`.
#[test]
fn claude_gets_the_budget_ladder() {
    assert_eq!(
        levels_for_model("claude-opus-4-7"),
        ["none", "low", "medium", "high", "xhigh", "max"]
    );
    assert!(!levels_for_model("claude-opus-4-7").contains(&"minimal"));
}

#[test]
fn a_level_the_model_lacks_narrows_to_the_nearest_one_it_has() {
    // The two that used to hard-fail a turn.
    assert_eq!(closest_level("gpt-5.5", "max"), Some("xhigh"));
    assert_eq!(closest_level("gpt-5.5", "minimal"), Some("low"));
    // Ties break upward: `minimal` sits one step from both `none` and `low`,
    // and quietly turning thinking off is the worse surprise.
    assert_eq!(closest_level("gpt-5.1", "xhigh"), Some("high"));
    assert_eq!(closest_level("o3-mini", "none"), Some("low"));
    assert_eq!(closest_level("o3-mini", "max"), Some("high"));
    // Supported levels pass through untouched.
    assert_eq!(closest_level("gpt-5.6-sol", "max"), Some("max"));
    assert_eq!(closest_level("gpt-6-astra", "max"), Some("max"));
    assert_eq!(closest_level("gpt-5.5", "none"), Some("none"));
}

#[test]
fn an_unknown_level_falls_back_to_the_app_default() {
    // Hand-edited config, or a rung some future model adds.
    assert_eq!(closest_level("gpt-5.5", "turbo"), Some(DEFAULT_LEVEL));
    assert_eq!(closest_level("o3-mini", ""), Some(DEFAULT_LEVEL));
    // Whitespace and casing are the caller's mistake, not a new level.
    assert_eq!(closest_level("gpt-5.6-sol", "  MAX  "), Some("max"));
}

/// Every per-model subset has to be a subset of the full ladder, in the same
/// weakest → strongest order — `closest_level` measures distance along it.
#[test]
fn every_subset_stays_ordered_along_the_full_ladder() {
    let rank = |level: &str| ALL_LEVELS.iter().position(|known| *known == level);
    for model in [
        "gpt-5.6-sol",
        "gpt-6-astra",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.1",
        "gpt-5-mini",
        "o3-mini",
        "claude-opus-4-7",
    ] {
        let ranks: Vec<_> = levels_for_model(model)
            .iter()
            .map(|level| rank(level).unwrap_or_else(|| panic!("{model}: unknown level {level}")))
            .collect();
        let mut sorted = ranks.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(ranks, sorted, "{model}: levels must ascend without repeats");
    }
    assert!(rank(DEFAULT_LEVEL).is_some());
}
