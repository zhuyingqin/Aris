use super::{
    inherited_upstream_proxy_env, no_proxy_list, read_token, upstream_proxy_ws_url,
    RemoteSessionContext, UpstreamProxyBootstrap,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time should be after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("runtime-remote-{nanos}"))
}

#[test]
fn remote_context_reads_env_state() {
    let env = BTreeMap::from([
        ("CLAUDE_CODE_REMOTE".to_string(), "true".to_string()),
        (
            "CLAUDE_CODE_REMOTE_SESSION_ID".to_string(),
            "session-123".to_string(),
        ),
        (
            "ANTHROPIC_BASE_URL".to_string(),
            "https://remote.test".to_string(),
        ),
    ]);
    let context = RemoteSessionContext::from_env_map(&env);
    assert!(context.enabled);
    assert_eq!(context.session_id.as_deref(), Some("session-123"));
    assert_eq!(context.base_url, "https://remote.test");
}

#[test]
fn bootstrap_fails_open_when_token_or_session_is_missing() {
    let env = BTreeMap::from([
        ("CLAUDE_CODE_REMOTE".to_string(), "1".to_string()),
        ("CCR_UPSTREAM_PROXY_ENABLED".to_string(), "true".to_string()),
    ]);
    let bootstrap = UpstreamProxyBootstrap::from_env_map(&env);
    assert!(!bootstrap.should_enable());
    assert!(!bootstrap.state_for_port(8080).enabled);
}

#[test]
fn bootstrap_derives_proxy_state_and_env() {
    let root = temp_dir();
    let token_path = root.join("session_token");
    fs::create_dir_all(&root).expect("temp dir");
    fs::write(&token_path, "secret-token\n").expect("write token");

    let env = BTreeMap::from([
        ("CLAUDE_CODE_REMOTE".to_string(), "1".to_string()),
        ("CCR_UPSTREAM_PROXY_ENABLED".to_string(), "true".to_string()),
        (
            "CLAUDE_CODE_REMOTE_SESSION_ID".to_string(),
            "session-123".to_string(),
        ),
        (
            "ANTHROPIC_BASE_URL".to_string(),
            "https://remote.test".to_string(),
        ),
        (
            "CCR_SESSION_TOKEN_PATH".to_string(),
            token_path.to_string_lossy().into_owned(),
        ),
        (
            "CCR_CA_BUNDLE_PATH".to_string(),
            root.join("ca-bundle.crt").to_string_lossy().into_owned(),
        ),
    ]);

    let bootstrap = UpstreamProxyBootstrap::from_env_map(&env);
    assert!(bootstrap.should_enable());
    assert_eq!(bootstrap.token.as_deref(), Some("secret-token"));
    assert_eq!(
        bootstrap.ws_url(),
        "wss://remote.test/v1/code/upstreamproxy/ws"
    );

    let state = bootstrap.state_for_port(9443);
    assert!(state.enabled);
    let env = state.subprocess_env();
    assert_eq!(
        env.get("HTTPS_PROXY").map(String::as_str),
        Some("http://127.0.0.1:9443")
    );
    assert_eq!(
        env.get("SSL_CERT_FILE").map(String::as_str),
        Some(root.join("ca-bundle.crt").to_string_lossy().as_ref())
    );

    fs::remove_dir_all(root).expect("cleanup temp dir");
}

#[test]
fn token_reader_trims_and_handles_missing_files() {
    let root = temp_dir();
    fs::create_dir_all(&root).expect("temp dir");
    let token_path = root.join("session_token");
    fs::write(&token_path, " abc123 \n").expect("write token");
    assert_eq!(
        read_token(&token_path).expect("read token").as_deref(),
        Some("abc123")
    );
    assert_eq!(
        read_token(&root.join("missing")).expect("missing token"),
        None
    );
    fs::remove_dir_all(root).expect("cleanup temp dir");
}

#[test]
fn inherited_proxy_env_requires_proxy_and_ca() {
    let env = BTreeMap::from([
        (
            "HTTPS_PROXY".to_string(),
            "http://127.0.0.1:8888".to_string(),
        ),
        (
            "SSL_CERT_FILE".to_string(),
            "/tmp/ca-bundle.crt".to_string(),
        ),
        ("NO_PROXY".to_string(), "localhost".to_string()),
    ]);
    let inherited = inherited_upstream_proxy_env(&env);
    assert_eq!(inherited.len(), 3);
    assert_eq!(
        inherited.get("NO_PROXY").map(String::as_str),
        Some("localhost")
    );
    assert!(inherited_upstream_proxy_env(&BTreeMap::new()).is_empty());
}

#[test]
fn helper_outputs_match_expected_shapes() {
    assert_eq!(
        upstream_proxy_ws_url("http://localhost:3000/"),
        "ws://localhost:3000/v1/code/upstreamproxy/ws"
    );
    assert!(no_proxy_list().contains("anthropic.com"));
    assert!(no_proxy_list().contains("github.com"));
}
