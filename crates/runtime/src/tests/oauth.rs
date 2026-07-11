use std::time::{SystemTime, UNIX_EPOCH};

use super::{
    clear_oauth_credentials, code_challenge_s256, credentials_path, generate_pkce_pair,
    generate_state, load_oauth_credentials, loopback_redirect_uri, parse_oauth_callback_query,
    parse_oauth_callback_request_target, save_oauth_credentials, OAuthAuthorizationRequest,
    OAuthConfig, OAuthRefreshRequest, OAuthTokenExchangeRequest, OAuthTokenSet,
};

fn sample_config() -> OAuthConfig {
    OAuthConfig {
        client_id: "runtime-client".to_string(),
        authorize_url: "https://console.test/oauth/authorize".to_string(),
        token_url: "https://console.test/oauth/token".to_string(),
        callback_port: Some(4545),
        manual_redirect_url: Some("https://console.test/oauth/callback".to_string()),
        scopes: vec!["org:read".to_string(), "user:write".to_string()],
    }
}

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::test_env_lock()
}

fn temp_config_home() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "runtime-oauth-test-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ))
}

#[test]
fn s256_challenge_matches_expected_vector() {
    assert_eq!(
        code_challenge_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn generates_pkce_pair_and_state() {
    let pair = generate_pkce_pair().expect("pkce pair");
    let state = generate_state().expect("state");
    assert!(!pair.verifier.is_empty());
    assert!(!pair.challenge.is_empty());
    assert!(!state.is_empty());
}

#[test]
fn builds_authorize_url_and_form_requests() {
    let config = sample_config();
    let pair = generate_pkce_pair().expect("pkce");
    let url = OAuthAuthorizationRequest::from_config(
        &config,
        loopback_redirect_uri(4545),
        "state-123",
        &pair,
    )
    .with_extra_param("login_hint", "user@example.com")
    .build_url();
    assert!(url.starts_with("https://console.test/oauth/authorize?"));
    assert!(url.contains("response_type=code"));
    assert!(url.contains("client_id=runtime-client"));
    assert!(url.contains("scope=org%3Aread%20user%3Awrite"));
    assert!(url.contains("login_hint=user%40example.com"));

    let exchange = OAuthTokenExchangeRequest::from_config(
        &config,
        "auth-code",
        "state-123",
        pair.verifier,
        loopback_redirect_uri(4545),
    );
    assert_eq!(
        exchange.form_params().get("grant_type").map(String::as_str),
        Some("authorization_code")
    );

    let refresh = OAuthRefreshRequest::from_config(&config, "refresh-token", None);
    assert_eq!(
        refresh.form_params().get("scope").map(String::as_str),
        Some("org:read user:write")
    );
}

#[test]
fn oauth_credentials_round_trip_and_clear_preserves_other_fields() {
    let _guard = env_lock();
    let config_home = temp_config_home();
    std::env::set_var("CLAUDE_CONFIG_HOME", &config_home);
    let path = credentials_path().expect("credentials path");
    std::fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    std::fs::write(&path, "{\"other\":\"value\"}\n").expect("seed credentials");

    let token_set = OAuthTokenSet {
        access_token: "access-token".to_string(),
        refresh_token: Some("refresh-token".to_string()),
        expires_at: Some(123),
        scopes: vec!["scope:a".to_string()],
    };
    save_oauth_credentials(&token_set).expect("save credentials");
    assert_eq!(
        load_oauth_credentials().expect("load credentials"),
        Some(token_set)
    );
    let saved = std::fs::read_to_string(&path).expect("read saved file");
    assert!(saved.contains("\"other\": \"value\""));
    assert!(saved.contains("\"oauth\""));

    clear_oauth_credentials().expect("clear credentials");
    assert_eq!(load_oauth_credentials().expect("load cleared"), None);
    let cleared = std::fs::read_to_string(&path).expect("read cleared file");
    assert!(cleared.contains("\"other\": \"value\""));
    assert!(!cleared.contains("\"oauth\""));

    std::env::remove_var("CLAUDE_CONFIG_HOME");
    std::fs::remove_dir_all(config_home).expect("cleanup temp dir");
}

#[test]
fn parses_callback_query_and_target() {
    let params =
        parse_oauth_callback_query("code=abc123&state=state-1&error_description=needs%20login")
            .expect("parse query");
    assert_eq!(params.code.as_deref(), Some("abc123"));
    assert_eq!(params.state.as_deref(), Some("state-1"));
    assert_eq!(params.error_description.as_deref(), Some("needs login"));

    let params = parse_oauth_callback_request_target("/callback?code=abc&state=xyz")
        .expect("parse callback target");
    assert_eq!(params.code.as_deref(), Some("abc"));
    assert_eq!(params.state.as_deref(), Some("xyz"));
    assert!(parse_oauth_callback_request_target("/wrong?code=abc").is_err());
}
