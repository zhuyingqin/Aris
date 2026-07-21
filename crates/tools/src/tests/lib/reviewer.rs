use super::*;

// ─── LlmReview routing + fallback tests ──────────────────────────────
//
// These tests serialize around ENV_LOCK_REVIEWER because resolve_reviewer_model
// reads real env vars (to check whether the requested model's key is set).

fn env_lock_reviewer() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

const REVIEWER_KEY_ENVS: &[&str] = &[
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GLM_API_KEY",
    "MINIMAX_API_KEY",
    "ARIS_MINIMAX_BASE_URL",
    "MINIMAX_BASE_URL",
    "KIMI_API_KEY",
];

struct ReviewerEnvSnapshot {
    vars: Vec<(&'static str, Option<String>)>,
}

impl ReviewerEnvSnapshot {
    fn capture_and_clear() -> Self {
        let vars = REVIEWER_KEY_ENVS
            .iter()
            .map(|n| (*n, std::env::var(n).ok()))
            .collect();
        for n in REVIEWER_KEY_ENVS {
            std::env::remove_var(n);
        }
        Self { vars }
    }
}

impl Drop for ReviewerEnvSnapshot {
    fn drop(&mut self) {
        for (name, prior) in &self.vars {
            match prior {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
    }
}

#[test]
fn route_openai_compat_model_picks_provider_from_name() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();

    assert_eq!(route_openai_compat_model("gpt-5.5").0, "OPENAI_API_KEY");
    assert_eq!(
        route_openai_compat_model("gemini-2.5-pro").0,
        "GEMINI_API_KEY"
    );
    assert_eq!(route_openai_compat_model("GLM-5").0, "GLM_API_KEY");
    assert_eq!(
        route_openai_compat_model("MiniMax-M2.7").0,
        "MINIMAX_API_KEY"
    );
    assert_eq!(
        route_openai_compat_model("MiniMax-M2.7").1,
        "https://api.minimaxi.com/v1/chat/completions"
    );
    std::env::set_var(
        "ARIS_MINIMAX_BASE_URL",
        "https://minimax-proxy.example.com/openai",
    );
    assert_eq!(
        route_openai_compat_model("MiniMax-M2.7").1,
        "https://minimax-proxy.example.com/openai/v1/chat/completions"
    );
    assert_eq!(route_openai_compat_model("kimi-k2.5").0, "KIMI_API_KEY");
    assert_eq!(route_openai_compat_model("moonshot-v1").0, "KIMI_API_KEY");
    // DeepSeek models route to their own API key.
    assert_eq!(
        route_openai_compat_model("deepseek-chat").0,
        "DEEPSEEK_API_KEY"
    );
}

#[test]
fn resolve_reviewer_model_returns_configured_when_input_absent() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();

    let model = resolve_reviewer_model(None, "kimi-k2.5");
    assert_eq!(model, "kimi-k2.5");
}

#[test]
fn resolve_reviewer_model_returns_configured_when_input_empty_string() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();

    let model = resolve_reviewer_model(Some(""), "kimi-k2.5");
    assert_eq!(model, "kimi-k2.5");
}

#[test]
fn resolve_reviewer_model_falls_back_when_requested_key_missing() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();
    std::env::set_var("KIMI_API_KEY", "sk-kimi");
    // Executor requested gpt-4o but only KIMI_API_KEY is set — fall back.
    let model = resolve_reviewer_model(Some("gpt-4o"), "kimi-k2.5");
    assert_eq!(model, "kimi-k2.5");
}

#[test]
fn resolve_reviewer_model_falls_back_on_provider_mismatch() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();
    // Both keys set, but configured reviewer is MiniMax — executor asking
    // for gpt-4o must NOT silently route to the stray OPENAI_API_KEY.
    std::env::set_var("MINIMAX_API_KEY", "mx-token");
    std::env::set_var("OPENAI_API_KEY", "sk-openai");
    let model = resolve_reviewer_model(Some("gpt-4o"), "MiniMax-M2.7");
    assert_eq!(
        model, "MiniMax-M2.7",
        "configured reviewer should win over coincidentally-present OpenAI key"
    );
}

#[test]
fn resolve_reviewer_model_honors_matching_override() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();
    // Configured reviewer is OpenAI (gpt-5.5); executor asks for gpt-5.5-mini.
    std::env::set_var("OPENAI_API_KEY", "sk-openai");
    let model = resolve_reviewer_model(Some("gpt-5.5-mini"), "gpt-5.5");
    assert_eq!(
        model, "gpt-5.5-mini",
        "same-provider override should be honored when the key is set"
    );
}

#[test]
fn resolve_anthropic_compat_reviewer_model_keeps_deepseek_configured() {
    let model = resolve_anthropic_compat_reviewer_model(
        Some("gpt-5.5"),
        "deepseek-v4-pro",
        Some("deepseek"),
    );
    assert_eq!(
        model, "deepseek-v4-pro",
        "skill-level GPT overrides must not replace a configured DeepSeek reviewer"
    );
}

#[test]
fn resolve_anthropic_compat_reviewer_model_honors_deepseek_override() {
    let model = resolve_anthropic_compat_reviewer_model(
        Some("deepseek-chat"),
        "deepseek-v4-pro",
        Some("deepseek"),
    );
    assert_eq!(model, "deepseek-chat");
}

#[test]
fn llm_review_disabled_reviewer_does_not_fall_back_to_gpt() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();
    std::env::set_var("ARIS_REVIEWER_PROVIDER", "none");

    let error = run_llm_review(LlmReviewInput {
        prompt: "ping".to_string(),
        model: None,
    })
    .expect_err("disabled reviewer should stop before default model routing");

    assert!(error.contains("reviewer is disabled"));
    assert!(!error.contains("gpt-5.5"));
}

#[test]
fn reviewer_stream_observer_tracks_desktop_cancellation() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let observer = reviewer_stream_observer(Some(cancelled.clone()));
    assert!(!observer.is_cancelled());

    cancelled.store(true, Ordering::SeqCst);
    assert!(observer.is_cancelled());
}

#[test]
fn resolve_reviewer_model_after_slash_reviewer_switch() {
    // Regression test: `/setup` Gemini → `/reviewer gpt-5.5` updates
    // ARIS_REVIEWER_MODEL but leaves ARIS_REVIEWER_PROVIDER stale as "gemini".
    // Executor now asks for gpt-5.5-mini — this MUST be honored since the
    // user's real intent (per ARIS_REVIEWER_MODEL) is OpenAI.
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();
    std::env::set_var("OPENAI_API_KEY", "sk-openai");
    // Stale provider env var from earlier /setup — deliberately wrong.
    std::env::set_var("ARIS_REVIEWER_PROVIDER", "gemini");

    let model = resolve_reviewer_model(Some("gpt-5.5-mini"), "gpt-5.5");
    assert_eq!(
        model, "gpt-5.5-mini",
        "provider consistency must come from configured_model, not stale ARIS_REVIEWER_PROVIDER"
    );

    std::env::remove_var("ARIS_REVIEWER_PROVIDER");
}

#[test]
fn llm_review_openai_urls_are_normalized_for_shared_executor() {
    assert_eq!(
        crate::openai_executor_base_url("https://api.openai.com/v1/chat/completions"),
        "https://api.openai.com/v1"
    );
    assert_eq!(
        crate::openai_executor_base_url("https://proxy.example.com/openai"),
        "https://proxy.example.com/openai"
    );
    assert_eq!(
        crate::openai_executor_base_url("https://proxy.example.com"),
        "https://proxy.example.com/v1"
    );
}

#[test]
fn llm_review_anthropic_urls_are_normalized_for_shared_executor() {
    assert_eq!(
        crate::anthropic_executor_base_url("https://api.anthropic.com/v1/messages"),
        "https://api.anthropic.com"
    );
    assert_eq!(
        crate::anthropic_executor_base_url("https://api.anthropic.com/v1"),
        "https://api.anthropic.com"
    );
    assert_eq!(
        crate::anthropic_executor_base_url("https://api.deepseek.com/anthropic"),
        "https://api.deepseek.com/anthropic"
    );
}
