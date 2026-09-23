use super::*;
use crate::membership::{GrantUpdate, PlanUpdate};
use axum::extract::State;
use serde_json::Value;
use std::sync::atomic::AtomicBool;

fn plan_update(models: &[&str], revision: i64) -> PlanUpdate {
    PlanUpdate {
        models: models.iter().map(|s| s.to_string()).collect(),
        default_executor: models.first().map(|s| s.to_string()),
        default_reviewer: models.last().map(|s| s.to_string()),
        enabled: !models.is_empty(),
        expected_revision: revision,
    }
}
fn grant(app: &App, user: &store::User, plan: Option<&str>, expiry: i64) {
    let revision = app
        .store
        .entitlements(&user.id, now())
        .unwrap()
        .membership_revision;
    app.store
        .grant_membership(
            &user.id,
            &user.id,
            GrantUpdate {
                plan_id: plan.map(str::to_string),
                expires_at: plan.map(|_| expiry),
                expected_revision: revision,
                reason: "Membership test".into(),
            },
            now(),
        )
        .unwrap();
}
async fn call(
    app: &Arc<App>,
    token: &str,
    method: &str,
    path: &str,
    body: Value,
    origin: bool,
) -> (StatusCode, Value) {
    raw_call(app, token, method, path, body.to_string(), origin).await
}
async fn raw_call(
    app: &Arc<App>,
    token: &str,
    method: &str,
    path: &str,
    body: String,
    origin: bool,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("cookie", format!("somniq_session={token}"));
    if origin {
        req = req.header("origin", app.config.origin());
    }
    let res = router(app.clone())
        .oneshot(req.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1_000_000).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
    )
}

#[tokio::test]
async fn administrator_requires_configured_issuer_subject_and_csrf() {
    let (_dir, app) = app();
    let (admin, admin_cookie) = signed_in(&app, "admin");
    let (_, member_cookie) = signed_in(&app, "ordinary");
    let (_, impostor_cookie) = app
        .store
        .login(
            "https://different.invalid/",
            "admin",
            "test@example.invalid",
            "Impostor",
            now(),
        )
        .unwrap();
    accept(&app, &admin);
    for cookie in [member_cookie, impostor_cookie] {
        for (method, path) in [
            ("GET", "/v2/admin/plans"),
            ("GET", "/v2/admin/models"),
            ("GET", "/v2/admin/users"),
            ("GET", "/v2/admin/audit"),
            ("PUT", "/v2/admin/plans/go"),
            ("PUT", "/v2/admin/users/unknown/membership"),
            ("POST", "/v2/admin/users/unknown/sync"),
        ] {
            let payload = if path == "/v2/admin/plans/go" {
                json!({"models":["basic"],"default_executor":"basic","default_reviewer":"basic","enabled":true,"expected_revision":1})
            } else {
                json!({"plan_id":"go","expires_at":now()+1000,"expected_revision":0,"reason":"forged"})
            };
            assert_eq!(
                call(&app, &cookie, method, path, payload, true).await.0,
                StatusCode::FORBIDDEN
            );
        }
    }
    let payload = json!({"models":["basic"],"default_executor":"basic","default_reviewer":"basic","enabled":true,"expected_revision":1});
    assert_eq!(
        call(
            &app,
            &admin_cookie,
            "PUT",
            "/v2/admin/plans/go",
            payload.clone(),
            false
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            &admin_cookie,
            "PUT",
            "/v2/admin/plans/go",
            payload.clone(),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            &admin_cookie,
            "PUT",
            "/v2/admin/plans/go",
            payload,
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(app.store.membership_audit().unwrap().len(), 1);
    let catalog = call(&app, "", "GET", "/v2/catalog/plans", Value::Null, false)
        .await
        .1;
    assert_eq!(
        catalog["plans"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["amount_fen"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![2900, 4900, 9900]
    );
    assert_eq!(catalog["checkout_available"], false);
}

#[test]
fn plans_validate_exact_models_and_grants_expire_without_a_timer() {
    let (dir, app) = app();
    let (user, _) = signed_in(&app, "member");
    assert!(app
        .store
        .entitlements(&user.id, now())
        .unwrap()
        .models
        .is_empty());
    assert!(app
        .store
        .update_plan(&user.id, "go", plan_update(&["gpt-*"], 1), now())
        .is_err());
    let mut invalid = plan_update(&["basic"], 1);
    invalid.default_reviewer = Some("premium".into());
    assert!(app
        .store
        .update_plan(&user.id, "go", invalid, now())
        .is_err());
    app.store
        .update_plan(&user.id, "go", plan_update(&["basic"], 1), now())
        .unwrap();
    grant(&app, &user, Some("go"), now() + 100);
    assert_eq!(
        app.store.entitlements(&user.id, now()).unwrap().models,
        vec!["basic"]
    );
    assert!(app
        .store
        .entitlements(&user.id, now() + 100)
        .unwrap()
        .models
        .is_empty());
    let cfg = app.config.clone();
    drop(app);
    let app = App::new(cfg).unwrap();
    assert_eq!(
        app.store.entitlements(&user.id, now()).unwrap().models,
        vec!["basic"]
    );
    grant(&app, &user, None, 0);
    assert!(app
        .store
        .entitlements(&user.id, now())
        .unwrap()
        .models
        .is_empty());
    assert_eq!(app.store.membership_audit().unwrap().len(), 3);
    drop(dir);
}

struct FakeCompute {
    token: Mutex<Value>,
    calls: AtomicUsize,
    updates: AtomicUsize,
    reject: AtomicBool,
}

#[test]
fn sync_jobs_survive_restart_and_remain_scoped_to_the_compute_instance() {
    let (_dir, app) = app();
    let (user, _) = signed_in(&app, "member");
    app.store
        .save_compute(
            &user.id,
            &app.config.newapi_instance,
            &compute_account(17, "member"),
        )
        .unwrap();
    assert_eq!(
        app.store
            .pending_sync(&app.config.newapi_instance, now())
            .unwrap()
            .len(),
        1
    );
    assert!(app
        .store
        .pending_sync("other-instance", now())
        .unwrap()
        .is_empty());
    app.store
        .finish_sync(&user.id, now() + 100, Some("upstream_sync_failed"))
        .unwrap();
    let cfg = app.config.clone();
    drop(app);
    let app = App::new(cfg).unwrap();
    assert!(app
        .store
        .pending_sync(&app.config.newapi_instance, now())
        .unwrap()
        .is_empty());
    assert_eq!(
        app.store.member_users(&user.id, 0, now()).unwrap()[0]["sync_error"],
        "upstream_sync_failed"
    );
    app.store
        .update_plan(&user.id, "go", plan_update(&["basic"], 1), now())
        .unwrap();
    grant(&app, &user, Some("go"), now() + 1000);
    assert_eq!(
        app.store
            .pending_sync(&app.config.newapi_instance, now())
            .unwrap()
            .len(),
        1
    );
}
async fn fake_token(State(state): State<Arc<FakeCompute>>) -> Json<Value> {
    Json(json!({"success":true,"data":state.token.lock().unwrap().clone()}))
}
async fn fake_update(
    State(state): State<Arc<FakeCompute>>,
    Json(value): Json<Value>,
) -> Json<Value> {
    if state.reject.load(Ordering::SeqCst) {
        return Json(json!({"success":false}));
    }
    let mut token = state.token.lock().unwrap();
    for (key, value) in value.as_object().unwrap() {
        token[key] = value.clone();
    }
    state.updates.fetch_add(1, Ordering::SeqCst);
    Json(json!({"success":true,"data":token.clone()}))
}
async fn fake_inference(
    State(state): State<Arc<FakeCompute>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    assert_eq!(headers["authorization"], "Bearer sk-private-model-key");
    assert!(!headers.contains_key("cookie"));
    state.calls.fetch_add(1, Ordering::SeqCst);
    Json(json!({"model":body["model"],"ok":true}))
}
async fn fixture() -> (
    tempfile::TempDir,
    Arc<App>,
    store::User,
    String,
    Arc<FakeCompute>,
    tokio::task::JoinHandle<()>,
) {
    let state = Arc::new(FakeCompute {
        token: Mutex::new(
            json!({"id":1,"user_id":17,"name":"somniq-account-service","status":1,"expired_time":-1,
            "unlimited_quota":true,"remain_quota":0,"model_limits_enabled":false,"model_limits":"",
            "allow_ips":null,"group":"","cross_group_retry":false}),
        ),
        calls: AtomicUsize::new(0),
        updates: AtomicUsize::new(0),
        reject: AtomicBool::new(false),
    });
    let routes=Router::new().route("/api/token/1",get(fake_token)).route("/api/token/",axum::routing::put(fake_update))
        .route("/api/token/1/key",post(|| async {Json(json!({"success":true,"data":{"key":"private-model-key"}}))}))
        .route("/v1/models",get(|| async {Json(json!({"object":"list","data":[{"id":"basic"},{"id":"advanced"},{"id":"premium"},{"id":"unlisted"}]}))}))
        .route("/v1/chat/completions",post(fake_inference)).route("/v1/responses",post(fake_inference)).route("/v1/messages",post(fake_inference)).with_state(state.clone());
    let (url, server) = serve(routes).await;
    let dir = tempfile::tempdir().unwrap();
    let app = App::new(config(&dir.path().join("db"), &url)).unwrap();
    let (user, cookie) = signed_in(&app, "member");
    accept(&app, &user);
    app.store
        .save_compute(
            &user.id,
            &app.config.newapi_instance,
            &compute_account(17, "member"),
        )
        .unwrap();
    for (plan, models) in [
        ("go", vec!["basic"]),
        ("plus", vec!["advanced", "basic"]),
        ("pro", vec!["advanced", "basic", "premium"]),
    ] {
        app.store
            .update_plan(&user.id, plan, plan_update(&models, 1), now())
            .unwrap();
    }
    (dir, app, user, cookie, state, server)
}

#[tokio::test]
async fn every_tier_is_enforced_for_models_and_all_three_transports() {
    let (_dir, app, user, cookie, state, server) = fixture().await;
    for (plan, allowed) in [
        ("go", vec!["basic"]),
        ("plus", vec!["advanced", "basic"]),
        ("pro", vec!["advanced", "basic", "premium"]),
    ] {
        grant(&app, &user, Some(plan), now() + 3600);
        let (status, models) = call(&app, &cookie, "GET", "/v1/models", Value::Null, false).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(models["data"].as_array().unwrap().len(), allowed.len());
        assert!(models["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| allowed.contains(&m["id"].as_str().unwrap())));
        for path in ["/v1/chat/completions", "/v1/responses", "/v1/messages"] {
            for model in ["basic", "advanced", "premium", "unlisted"] {
                let before = state.calls.load(Ordering::SeqCst);
                let status = call(
                    &app,
                    &cookie,
                    "POST",
                    path,
                    json!({"model":model,"messages":[]}),
                    true,
                )
                .await
                .0;
                if allowed.contains(&model) {
                    assert_eq!(status, StatusCode::OK);
                } else {
                    assert_eq!(status, StatusCode::FORBIDDEN);
                    assert_eq!(state.calls.load(Ordering::SeqCst), before);
                }
            }
        }
        assert_eq!(state.token.lock().unwrap()["model_limits_enabled"], true);
    }
    grant(&app, &user, Some("go"), now() + 3600);
    assert_eq!(
        call(
            &app,
            &cookie,
            "POST",
            "/v1/responses",
            json!({"model":"premium"}),
            true
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            &cookie,
            "POST",
            "/v1/responses",
            json!({"model":"basic"}),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(state.token.lock().unwrap()["model_limits"], "basic");
    grant(&app, &user, None, 0);
    assert_eq!(
        call(
            &app,
            &cookie,
            "POST",
            "/v1/messages",
            json!({"model":"basic"}),
            true
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    newapi::model_account(&app, &user, true).await.unwrap();
    assert_eq!(state.token.lock().unwrap()["model_limits"], "");
    assert_eq!(state.token.lock().unwrap()["model_limits_enabled"], true);
    server.abort();
}

#[tokio::test]
async fn stale_sync_and_malformed_requests_cannot_authorize_calls() {
    let (_dir, app, user, cookie, state, server) = fixture().await;
    grant(&app, &user, Some("go"), now() + 3600);
    for raw in [
        r#"{"model":"basic","model":"premium"}"#,
        r#"{"model":"basic","\u006dodel":"premium"}"#,
        r#"{"model":42}"#,
        r#"{"model":"basic","group":"vip"}"#,
        r#"{"model":"basic","channel_id":1}"#,
        r#"{"model":"basic","background":true}"#,
    ] {
        assert_eq!(
            raw_call(
                &app,
                &cookie,
                "POST",
                "/v1/chat/completions",
                raw.into(),
                true
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    for model in ["BASIC", "basic*", "basic:other", "premium"] {
        let status = call(
            &app,
            &cookie,
            "POST",
            "/v1/chat/completions",
            json!({"model":model}),
            true,
        )
        .await
        .0;
        assert!(status == StatusCode::BAD_REQUEST || status == StatusCode::FORBIDDEN);
    }
    assert_eq!(state.calls.load(Ordering::SeqCst), 0);
    state.reject.store(true, Ordering::SeqCst);
    assert_eq!(
        call(
            &app,
            &cookie,
            "POST",
            "/v1/chat/completions",
            json!({"model":"basic"}),
            true
        )
        .await
        .0,
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(state.calls.load(Ordering::SeqCst), 0);
    state.reject.store(false, Ordering::SeqCst);
    assert_eq!(
        call(
            &app,
            &cookie,
            "POST",
            "/v1/chat/completions",
            json!({"model":"basic"}),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    // A removed model is rejected before contacting New API, even while the
    // old key is cached and the upstream update service is failing.
    app.store
        .update_plan(&user.id, "go", plan_update(&["replacement"], 2), now())
        .unwrap();
    state.reject.store(true, Ordering::SeqCst);
    assert_eq!(
        call(
            &app,
            &cookie,
            "POST",
            "/v1/chat/completions",
            json!({"model":"basic"}),
            true
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(state.calls.load(Ordering::SeqCst), 1);
    server.abort();
}

#[tokio::test]
async fn key_reconciliation_does_not_overwrite_a_finite_budget_or_reenable_a_disabled_key() {
    let (_dir, app, user, cookie, state, server) = fixture().await;
    grant(&app, &user, Some("go"), now() + 3600);
    {
        let mut token = state.token.lock().unwrap();
        token["unlimited_quota"] = json!(false);
        token["remain_quota"] = json!(123);
    }
    assert_eq!(
        call(
            &app,
            &cookie,
            "POST",
            "/v1/responses",
            json!({"model":"basic"}),
            true
        )
        .await
        .0,
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(state.token.lock().unwrap()["remain_quota"], 123);
    assert_eq!(state.updates.load(Ordering::SeqCst), 0);
    {
        let mut token = state.token.lock().unwrap();
        token["unlimited_quota"] = json!(true);
        token["status"] = json!(2);
    }
    assert_eq!(
        call(
            &app,
            &cookie,
            "POST",
            "/v1/responses",
            json!({"model":"basic"}),
            true
        )
        .await
        .0,
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(state.updates.load(Ordering::SeqCst), 0);
    assert_eq!(state.calls.load(Ordering::SeqCst), 0);
    server.abort();
}
