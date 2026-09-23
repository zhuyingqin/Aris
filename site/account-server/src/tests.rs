use super::*;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rsa::{
    pkcs1v15::SigningKey,
    signature::{SignatureEncoding, Signer},
    traits::PublicKeyParts,
    RsaPrivateKey,
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
use tower::ServiceExt;

fn config(path: &std::path::Path, upstream: &str) -> Config {
    Config {
        bind: "127.0.0.1:0".into(),
        public_url: "http://127.0.0.1:8800".parse().unwrap(),
        issuer: upstream.parse().unwrap(),
        client_id: "somniq-web".into(),
        client_secret: "test-client-secret".into(),
        newapi_url: upstream.parse().unwrap(),
        newapi_client_id: "newapi".into(),
        newapi_instance: "test-instance".into(),
        database: path.into(),
        vault_key: crypto::random(),
        agreement_version: "test-v1".into(),
        agreement_text: "Test agreement snapshot".into(),
        secure: false,
        home_path: "/account/".into(),
    }
}

fn app() -> (tempfile::TempDir, Arc<App>) {
    let dir = tempfile::tempdir().unwrap();
    let app = App::new(config(
        &dir.path().join("db.sqlite3"),
        "http://127.0.0.1:9/",
    ))
    .unwrap();
    (dir, app)
}
fn signed_in(app: &App, subject: &str) -> (store::User, String) {
    app.store
        .login(
            app.config.issuer.as_str(),
            subject,
            "test@example.invalid",
            "Tester",
            now(),
        )
        .unwrap()
}
fn accept(app: &App, user: &store::User) {
    app.store
        .consent(
            &user.id,
            &app.config.agreement_version,
            &app.config.agreement_text,
            now(),
        )
        .unwrap();
}
fn compute_account(id: i64, subject: &str) -> store::ComputeAccount {
    store::ComputeAccount {
        user_id: id,
        oidc_id: subject.into(),
        access_token: "upstream-private-session".into(),
        refresh_cookie: "new_api_refresh=private-cookie".into(),
        session_id: "sid".into(),
        expires_at: now() + 900,
        model_key: Some("sk-private-model-key".into()),
    }
}

#[test]
fn identity_uses_issuer_and_subject_and_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(&dir.path().join("db.sqlite3"), "http://127.0.0.1:9/");
    let app = App::new(cfg.clone()).unwrap();
    let (a, token) = signed_in(&app, "alice");
    let (renamed, _) = app
        .store
        .login(
            app.config.issuer.as_str(),
            "alice",
            "new@example.invalid",
            "Renamed",
            now(),
        )
        .unwrap();
    assert_eq!(a.id, renamed.id);
    let (other, _) = app
        .store
        .login(
            "https://different.invalid",
            "alice",
            "new@example.invalid",
            "Other",
            now(),
        )
        .unwrap();
    assert_ne!(a.id, other.id);
    drop(app);
    let mut wrong_key = cfg.clone();
    wrong_key.vault_key = crypto::random();
    assert!(App::new(wrong_key).is_err());
    let app = App::new(cfg).unwrap();
    assert_eq!(app.store.session(&token, now()).unwrap().unwrap().id, a.id);
    app.store.logout(&token).unwrap();
    assert!(app.store.session(&token, now()).unwrap().is_none());
}

#[test]
fn flows_are_bound_expiring_encrypted_and_single_use() {
    let (_dir, app) = app();
    let flow = store::Flow {
        kind: "oidc".into(),
        verifier: "secret-verifier".into(),
        nonce: "secret-nonce".into(),
        session_hash: None,
    };
    app.store
        .save_flow("state", "browser-a", &flow, 100)
        .unwrap();
    assert!(app
        .store
        .consume_flow("state", "browser-b", 101)
        .unwrap()
        .is_none());
    assert_eq!(
        app.store
            .consume_flow("state", "browser-a", 101)
            .unwrap()
            .unwrap()
            .verifier,
        "secret-verifier"
    );
    assert!(app
        .store
        .consume_flow("state", "browser-a", 102)
        .unwrap()
        .is_none());
    app.store
        .save_flow("expired", "browser-a", &flow, 100)
        .unwrap();
    assert!(app
        .store
        .consume_flow("expired", "browser-a", 700)
        .unwrap()
        .is_none());
}

#[test]
fn vault_rejects_tampering_wrong_key_and_cross_user_copy() {
    let vault = crypto::Vault::new(&crypto::random()).unwrap();
    let sealed = vault.seal("user-a", "private-credential").unwrap();
    assert_eq!(vault.open("user-a", &sealed).unwrap(), "private-credential");
    assert!(vault.open("user-b", &sealed).is_err());
    assert!(crypto::Vault::new(&crypto::random())
        .unwrap()
        .open("user-a", &sealed)
        .is_err());
    let mut bytes = URL_SAFE_NO_PAD.decode(&sealed).unwrap();
    bytes[13] ^= 1;
    assert!(vault
        .open("user-a", &URL_SAFE_NO_PAD.encode(bytes))
        .is_err());
}

#[test]
fn compute_mapping_is_unique_and_credentials_are_not_plaintext() {
    let (_dir, app) = app();
    let (a, _) = signed_in(&app, "a");
    let (b, _) = signed_in(&app, "b");
    app.store
        .save_compute(&a.id, "one", &compute_account(17, "a"))
        .unwrap();
    assert!(app
        .store
        .save_compute(&b.id, "one", &compute_account(17, "b"))
        .is_err());
    assert!(app
        .store
        .save_compute(&a.id, "one", &compute_account(18, "a"))
        .is_err());
    let db = rusqlite::Connection::open(&app.config.database).unwrap();
    let sealed: String = db
        .query_row("SELECT sealed FROM compute_accounts", [], |r| r.get(0))
        .unwrap();
    assert!(!sealed.contains("private"));
    assert_eq!(
        app.store
            .compute(&a.id, "one")
            .unwrap()
            .unwrap()
            .model_key
            .unwrap(),
        "sk-private-model-key"
    );
}

#[tokio::test]
async fn account_works_during_compute_outage_and_never_exposes_upstream_secrets() {
    let (_dir, app) = app();
    let (user, token) = signed_in(&app, "a");
    app.store
        .save_compute(
            &user.id,
            &app.config.newapi_instance,
            &compute_account(1, "a"),
        )
        .unwrap();
    let response = router(app.clone())
        .oneshot(
            Request::builder()
                .uri("/v2/account/me")
                .header("cookie", format!("somniq_session={token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let text = String::from_utf8(
        to_bytes(response.into_body(), 10000)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(text.contains(&user.id));
    assert!(!text.contains("private"));
    assert!(!text.contains("oidc_id"));
    for value in [
        format!("somniq_session={token}; somniq_session={token}"),
        format!("somniq_session=malformed; somniq_session={token}"),
    ] {
        assert_eq!(
            router(app.clone())
                .oneshot(
                    Request::builder()
                        .uri("/v2/account/me")
                        .header("cookie", value)
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn consent_requires_session_origin_current_snapshot_and_active_acceptance() {
    let (_dir, app) = app();
    let (user, token) = signed_in(&app, "a");
    for (origin, accepted, version, expected) in [
        ("https://evil.invalid", true, "test-v1", 403),
        ("http://127.0.0.1:8800", false, "test-v1", 400),
        ("http://127.0.0.1:8800", true, "old", 400),
        ("http://127.0.0.1:8800", true, "test-v1", 204),
    ] {
        let response=router(app.clone()).oneshot(Request::builder().method("POST").uri("/v2/account/consent").header("origin",origin).header("cookie",format!("somniq_session={token}")).header("content-type","application/json")
            .body(Body::from(json!({"version":version,"content_hash":crypto::hash(&app.config.agreement_text),"accepted":accepted}).to_string())).unwrap()).await.unwrap();
        assert_eq!(response.status().as_u16(), expected);
    }
    assert!(app
        .store
        .has_consent(&user.id, "test-v1", &app.config.agreement_text)
        .unwrap());
    assert!(!app
        .store
        .has_consent(&user.id, "test-v1", "changed text")
        .unwrap());
}

#[tokio::test]
async fn unconsented_or_disabled_users_cannot_call_models() {
    let (_dir, app) = app();
    let (user, token) = signed_in(&app, "a");
    let request = || {
        Request::builder()
            .uri("/v1/models")
            .header("cookie", format!("somniq_session={token}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        router(app.clone())
            .oneshot(request())
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    accept(&app, &user);
    rusqlite::Connection::open(&app.config.database)
        .unwrap()
        .execute("UPDATE users SET active=0 WHERE id=?1", [&user.id])
        .unwrap();
    assert_eq!(
        router(app).oneshot(request()).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}

async fn serve(routes: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, routes).await.unwrap();
    });
    (url, task)
}

#[tokio::test]
async fn upstream_account_switch_is_rejected_before_persisting() {
    let response = || async {
        (
            [(
                "set-cookie",
                "new_api_refresh=secret; HttpOnly; Path=/api/user/auth",
            )],
            Json(
                json!({"success":true,"data":{"access_token":"access","access_expires_at":now()+900,"session":{"sid":"new-sid"},"user":{"id":22,"oidc_id":"other-person"}}}),
            ),
        )
    };
    let (url, server) = serve(Router::new().route("/api/oauth/oidc", get(response))).await;
    let dir = tempfile::tempdir().unwrap();
    let app = App::new(config(&dir.path().join("db"), &url)).unwrap();
    let (user, _) = signed_in(&app, "a");
    assert!(newapi::finish(&app, "code", "state", &user).await.is_err());
    assert!(app
        .store
        .compute(&user.id, &app.config.newapi_instance)
        .unwrap()
        .is_none());
    server.abort();
}

#[tokio::test]
async fn concurrent_refresh_happens_once_and_preserves_user() {
    let refreshes = Arc::new(AtomicUsize::new(0));
    let count = refreshes.clone();
    let (url,server)=serve(Router::new().route("/api/user/auth/refresh",post(move || {let count=count.clone();async move {
        count.fetch_add(1,Ordering::SeqCst);tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        ([("set-cookie","new_api_refresh=rotated; Path=/api/user/auth; HttpOnly")],Json(json!({"success":true,"data":{"access_token":"rotated-access","access_expires_at":now()+900,"session":{"sid":"sid"},"user":{"id":17,"oidc_id":"a"}}})))
    }}))).await;
    let dir = tempfile::tempdir().unwrap();
    let app = App::new(config(&dir.path().join("db"), &url)).unwrap();
    let (user, _) = signed_in(&app, "a");
    let mut account = compute_account(17, "a");
    account.expires_at = now() - 1;
    app.store
        .save_compute(&user.id, &app.config.newapi_instance, &account)
        .unwrap();
    let (one, two) = tokio::join!(newapi::session(&app, &user), newapi::session(&app, &user));
    assert_eq!(one.unwrap().access_token, "rotated-access");
    assert!(two.is_ok());
    assert_eq!(refreshes.load(Ordering::SeqCst), 1);
    server.abort();
}

#[tokio::test]
async fn proxy_uses_mapped_key_and_streams_without_forwarding_client_credentials() {
    let (url, server) = serve(Router::new().route(
        "/v1/chat/completions",
        post(|headers: axum::http::HeaderMap| async move {
            assert_eq!(
                headers.get("authorization").unwrap(),
                "Bearer sk-private-model-key"
            );
            assert!(!headers.contains_key("cookie"));
            assert!(!headers.contains_key("x-forwarded-host"));
            (
                [("content-type", "text/event-stream")],
                "data: {\"text\":\"hello\"}\n\ndata: [DONE]\n\n",
            )
        }),
    ))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let app = App::new(config(&dir.path().join("db"), &url)).unwrap();
    let (user, token) = signed_in(&app, "a");
    accept(&app, &user);
    app.store
        .save_compute(
            &user.id,
            &app.config.newapi_instance,
            &compute_account(17, "a"),
        )
        .unwrap();
    let response = router(app)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/chat/completions")
                .header("origin", "http://127.0.0.1:8800")
                .header("cookie", format!("somniq_session={token}"))
                .header("authorization", "Bearer malicious-other-key")
                .header("x-forwarded-host", "evil.invalid")
                .body(Body::from("{\"stream\":true}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    assert!(String::from_utf8(
        to_bytes(response.into_body(), 10000)
            .await
            .unwrap()
            .to_vec()
    )
    .unwrap()
    .contains("[DONE]"));
    server.abort();
}

// Real RSA signatures and discovery exercise the OIDC library, not a stubbed
// successful authentication callback. The provider also enforces PKCE.
#[tokio::test]
async fn oidc_code_flow_verifies_nonce_audience_pkce_and_rejects_replay() {
    let key = RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
    let jwk = json!({"kty":"RSA","kid":"test-key","use":"sig","alg":"RS256","n":URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()),"e":URL_SAFE_NO_PAD.encode(key.e().to_bytes_be())});
    let signing = Arc::new(SigningKey::<sha2::Sha256>::new(key));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}/", listener.local_addr().unwrap());
    let metadata = json!({"issuer":issuer,"authorization_endpoint":format!("{issuer}authorize"),"token_endpoint":format!("{issuer}token"),"jwks_uri":format!("{issuer}jwks"),"response_types_supported":["code"],"subject_types_supported":["public"],"id_token_signing_alg_values_supported":["RS256"],"token_endpoint_auth_methods_supported":["client_secret_basic"]});
    let challenge = Arc::new(Mutex::new((String::new(), String::new(), String::new())));
    let expected = challenge.clone();
    let token_issuer = issuer.clone();
    let routes=Router::new().route("/.well-known/openid-configuration",get(move || {let value=metadata.clone();async move{Json(value)}}))
        .route("/jwks",get(move || {let value=jwk.clone();async move{Json(json!({"keys":[value]}))}}))
        .route("/token",post(move |axum::Form(form):axum::Form<std::collections::HashMap<String,String>>| {let signing=signing.clone();let expected=expected.clone();let issuer=token_issuer.clone();async move {
            let (nonce,pkce,failure)=expected.lock().unwrap().clone();
            assert_eq!(crypto::hash(form.get("code_verifier").unwrap()),pkce);
            let header=URL_SAFE_NO_PAD.encode(json!({"alg":"RS256","kid":"test-key"}).to_string());
            let claims=URL_SAFE_NO_PAD.encode(json!({"iss":if failure == "issuer" { "https://wrong.invalid/" } else { &issuer },"aud":if failure == "audience" { "wrong-client" } else { "somniq-web" },"sub":"subject-a","email":"a@example.invalid","email_verified":failure != "unverified_email","preferred_username":"Alice","exp":if failure == "expired" { now()-3600 } else { now()+300 },"iat":now(),"nonce":if failure == "nonce" {"wrong-nonce".to_string()}else{nonce}}).to_string());
            let signing_input=format!("{header}.{claims}");let signature=signing.sign(signing_input.as_bytes());
            Json(json!({"access_token":"idp-access","token_type":"Bearer","expires_in":300,"id_token":format!("{signing_input}.{}",URL_SAFE_NO_PAD.encode(signature.to_bytes()))}))
        }}));
    let server = tokio::spawn(async move { axum::serve(listener, routes).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let app = App::new(config(&dir.path().join("db"), &issuer)).unwrap();
    for failure in [
        "nonce",
        "audience",
        "issuer",
        "expired",
        "unverified_email",
        "none",
    ] {
        let response = router(app.clone())
            .oneshot(
                Request::builder()
                    .uri("/v2/account/login")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let flow_cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        let location = url::Url::parse(response.headers()["location"].to_str().unwrap()).unwrap();
        let query: std::collections::HashMap<_, _> = location
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        *challenge.lock().unwrap() = (
            query["nonce"].clone(),
            query["code_challenge"].clone(),
            failure.to_string(),
        );
        let callback = format!(
            "/v2/account/callback?code=test-code&state={}",
            query["state"]
        );
        let request = || {
            Request::builder()
                .uri(&callback)
                .header("cookie", &flow_cookie)
                .body(Body::empty())
                .unwrap()
        };
        let response = router(app.clone()).oneshot(request()).await.unwrap();
        assert_eq!(
            response.status(),
            if failure != "none" {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::SEE_OTHER
            }
        );
        if failure == "none" {
            assert!(response.headers()["set-cookie"]
                .to_str()
                .unwrap()
                .contains("HttpOnly"));
        }
        assert_eq!(
            router(app.clone())
                .oneshot(request())
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    server.abort();
}
