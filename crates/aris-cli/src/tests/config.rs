use super::*;
use std::sync::Mutex;

// Env mutation must be serialized across tests in this module — they all
// read/write the same process-global env vars.
static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvSnapshot {
    vars: Vec<(&'static str, Option<String>)>,
}

impl EnvSnapshot {
    fn capture(names: &[&'static str]) -> Self {
        let vars = names.iter().map(|n| (*n, std::env::var(n).ok())).collect();
        // Clear them so the test starts from a known state.
        for n in names {
            std::env::remove_var(n);
        }
        Self { vars }
    }
}

impl Drop for EnvSnapshot {
    fn drop(&mut self) {
        for (name, prior) in &self.vars {
            match prior {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
    }
}

const EXECUTOR_ENV_VARS: &[&str] = &[
    "EXECUTOR_PROVIDER",
    "EXECUTOR_API_KEY",
    "EXECUTOR_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
];

#[test]
fn anthropic_with_custom_base_url_sets_base_url_and_disables_betas() {
    let _g = ENV_LOCK.lock().unwrap();
    let _snap = EnvSnapshot::capture(EXECUTOR_ENV_VARS);

    let config = ArisConfig {
        executor_provider: Some("anthropic".into()),
        executor_api_key: Some("sk-ant-test".into()),
        executor_base_url: Some("https://bedrock-proxy.example.com".into()),
        ..Default::default()
    };
    config.force_apply_to_env();

    assert_eq!(
        std::env::var("ANTHROPIC_API_KEY").ok().as_deref(),
        Some("sk-ant-test")
    );
    assert_eq!(
        std::env::var("ANTHROPIC_BASE_URL").ok().as_deref(),
        Some("https://bedrock-proxy.example.com")
    );
    assert_eq!(
        std::env::var("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")
            .ok()
            .as_deref(),
        Some("1")
    );
}

#[test]
fn anthropic_without_custom_base_url_leaves_betas_enabled() {
    let _g = ENV_LOCK.lock().unwrap();
    let _snap = EnvSnapshot::capture(EXECUTOR_ENV_VARS);

    let config = ArisConfig {
        executor_provider: Some("anthropic".into()),
        executor_api_key: Some("sk-ant-test".into()),
        executor_base_url: None,
        ..Default::default()
    };
    config.force_apply_to_env();

    // Official api.anthropic.com path: no base URL override, betas stay on.
    assert!(std::env::var("ANTHROPIC_BASE_URL").is_err());
    assert!(std::env::var("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS").is_err());
}

#[test]
fn anthropic_compat_with_base_url_sets_auth_token_base_url_and_disables_betas() {
    let _g = ENV_LOCK.lock().unwrap();
    let _snap = EnvSnapshot::capture(EXECUTOR_ENV_VARS);

    let config = ArisConfig {
        executor_provider: Some("anthropic-compat".into()),
        executor_api_key: Some("mx-token".into()),
        executor_base_url: Some("https://minimax.example.com/anthropic".into()),
        ..Default::default()
    };
    config.force_apply_to_env();

    assert_eq!(
        std::env::var("ANTHROPIC_AUTH_TOKEN").ok().as_deref(),
        Some("mx-token")
    );
    assert_eq!(
        std::env::var("ANTHROPIC_BASE_URL").ok().as_deref(),
        Some("https://minimax.example.com/anthropic")
    );
    assert_eq!(
        std::env::var("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")
            .ok()
            .as_deref(),
        Some("1")
    );
}

#[test]
fn force_apply_executor_env_clears_stale_beta_disable_flag() {
    let _g = ENV_LOCK.lock().unwrap();
    let _snap = EnvSnapshot::capture(EXECUTOR_ENV_VARS);

    // Simulate a prior run that had a custom base URL and thus set the flag.
    std::env::set_var("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1");
    std::env::set_var("ANTHROPIC_BASE_URL", "https://old-proxy.example.com");

    // User then reconfigured to official api.anthropic.com (no base URL).
    let config = ArisConfig {
        executor_provider: Some("anthropic".into()),
        executor_api_key: Some("sk-ant-test".into()),
        executor_base_url: None,
        ..Default::default()
    };
    config.force_apply_executor_env();

    // Stale flags from the prior custom-URL run must be gone, otherwise
    // the Anthropic client would keep stripping beta headers against the
    // official API and we'd lose OAuth/long-context/interleaved-thinking.
    assert!(
        std::env::var("ANTHROPIC_BASE_URL").is_err(),
        "expected ANTHROPIC_BASE_URL to be cleared by force_apply_executor_env"
    );
    assert!(
        std::env::var("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS").is_err(),
        "expected CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS to be cleared too"
    );
}
