use super::*;
use serde_json::json;
use std::{
    ffi::OsString,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, MutexGuard,
    },
    thread,
};

struct Reply {
    status: u16,
    body: Value,
    cookie: Option<String>,
}

impl Reply {
    fn ok(data: Value) -> Self {
        Self {
            status: 200,
            body: json!({ "success": true, "data": data }),
            cookie: None,
        }
    }

    fn error(status: u16, code: &str) -> Self {
        Self {
            status,
            body: json!({ "success": false, "code": code, "message": code }),
            cookie: None,
        }
    }

    fn refresh(number: usize) -> Self {
        let expires = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 900;
        let mut reply = Self::ok(json!({
            "token": format!("access-{number}"), "access_expires_at": expires,
            "session": { "sid": "session-17" },
        }));
        reply.cookie = Some(format!(
            "new_api_refresh=refresh-{number}; Path=/; HttpOnly"
        ));
        reply
    }
}

struct Gateway {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Gateway {
    fn new(mut respond: impl FnMut(&str) -> Reply + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stopped = Arc::new(AtomicBool::new(false));
        let log = requests.clone();
        let stop = stopped.clone();
        let worker = thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("mock accept: {error}"),
                };
                stream.set_nonblocking(false).unwrap();
                let request = read_request(&mut stream);
                log.lock().unwrap().push(request.clone());
                let reply = respond(&request);
                let body = reply.body.to_string();
                let cookie = reply
                    .cookie
                    .map(|value| format!("Set-Cookie: {value}\r\n"))
                    .unwrap_or_default();
                let response = format!(
                    "HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{cookie}Connection: close\r\n\r\n{body}",
                    reply.status, body.len(),
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            base,
            requests,
            stopped,
            worker: Some(worker),
        }
    }

    fn count(&self, route: &str) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.starts_with(route))
            .count()
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 2048];
    while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
        let size = stream.read(&mut chunk).unwrap();
        assert!(size > 0);
        bytes.extend_from_slice(&chunk[..size]);
    }
    String::from_utf8(bytes).unwrap()
}

struct AccountFixture {
    _guard: MutexGuard<'static, ()>,
    _directory: tempfile::TempDir,
    previous_root: Option<OsString>,
    base: String,
}

impl AccountFixture {
    fn new(base: &str) -> Self {
        let guard = crate::test_env_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let directory = tempfile::tempdir().unwrap();
        let previous_root = std::env::var_os("ARIS_CONFIG_ROOT");
        std::env::set_var("ARIS_CONFIG_ROOT", directory.path());
        std::fs::write(
            crate::state::config_path(),
            json!({
                "newapi_base_url": base, "newapi_user_id": 17, "newapi_username": "researcher",
                "newapi_executor_base_url": format!("{base}/v1"),
                "executor_provider": "openai", "executor_model": "MiniMax-M3",
                "managed_models": ["MiniMax-M3"],
            })
            .to_string(),
        )
        .unwrap();
        save_refresh_session(
            base,
            &NewApiRefreshSession {
                cookies: vec![NewApiRefreshCookie {
                    name: NEWAPI_REFRESH_COOKIE_NAME.to_string(),
                    value: "refresh-0".to_string(),
                }],
                session_id: Some("session-17".to_string()),
            },
        )
        .unwrap();
        let expires = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 900;
        remember_access_token(base, "access-0", Some(expires));
        config::persist_newapi_executor_credentials(base, "sk-old", Some(5)).unwrap();
        Self {
            _guard: guard,
            _directory: directory,
            previous_root,
            base: base.to_string(),
        }
    }

    fn expire_access(&self) {
        access_token_cache()
            .lock()
            .unwrap()
            .get_mut(&self.base)
            .unwrap()
            .expires_at = UNIX_EPOCH;
    }
}

impl Drop for AccountFixture {
    fn drop(&mut self) {
        forget_access_token(&self.base);
        let _ = delete_refresh_session(&self.base);
        crate::managed_key::clear(&self.base);
        match self.previous_root.take() {
            Some(value) => std::env::set_var("ARIS_CONFIG_ROOT", value),
            None => std::env::remove_var("ARIS_CONFIG_ROOT"),
        }
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Runtime::new().unwrap()
}

#[test]
fn two_refresh_cycles_use_the_latest_cookie_and_keep_the_account() {
    let mut cycle = 0;
    let gateway = Gateway::new(move |request| {
        assert!(request.starts_with("POST /api/user/auth/refresh "));
        assert!(request.contains(&format!("new_api_refresh=refresh-{cycle}")));
        cycle += 1;
        Reply::refresh(cycle)
    });
    let account = AccountFixture::new(&gateway.base);
    let runtime = runtime();
    let client = account_http_client_builder(Duration::from_secs(3))
        .build()
        .unwrap();
    for cycle in 1..=2 {
        account.expire_access();
        let (_, session) = runtime
            .block_on(authenticated_stored_session(&client))
            .unwrap();
        assert_eq!(
            session.user_token.as_deref(),
            Some(format!("access-{cycle}").as_str())
        );
        assert!(has_stored_session());
    }
    assert_eq!(gateway.count("POST /api/user/auth/refresh "), 2);
}

#[test]
fn access_rejected_by_the_server_is_refreshed_before_retrying_usage_logs() {
    let gateway = Gateway::new(|request| {
        if request.starts_with("POST /api/user/auth/refresh ") {
            return Reply::refresh(1);
        }
        assert!(request.starts_with("GET /api/log/self?"));
        if request
            .to_ascii_lowercase()
            .contains("authorization: bearer access-0")
        {
            Reply::error(401, "AUTH_TOKEN_EXPIRED")
        } else {
            Reply::ok(json!({ "items": [], "total": 0 }))
        }
    });
    let _account = AccountFixture::new(&gateway.base);
    let result = runtime().block_on(newapi_usage_logs(1, 20));
    assert!(
        result.is_ok(),
        "temporary access expiry must renew: {:?}",
        result.err()
    );
    assert!(has_stored_session());
    assert_eq!(gateway.count("POST /api/user/auth/refresh "), 1);
    assert_eq!(gateway.count("GET /api/log/self?"), 2);
}

#[test]
fn concurrent_rejected_requests_share_one_refresh() {
    let gateway = Gateway::new(|request| {
        if request.starts_with("POST /api/user/auth/refresh ") {
            return Reply::refresh(1);
        }
        if request
            .to_ascii_lowercase()
            .contains("authorization: bearer access-0")
        {
            Reply::error(401, "AUTH_TOKEN_EXPIRED")
        } else {
            Reply::ok(json!({ "items": [], "total": 0 }))
        }
    });
    let _account = AccountFixture::new(&gateway.base);
    let (first, second) = runtime()
        .block_on(async { tokio::join!(newapi_usage_logs(1, 20), newapi_usage_logs(2, 20)) });
    assert!(first.is_ok() && second.is_ok());
    assert!(has_stored_session());
    assert_eq!(gateway.count("POST /api/user/auth/refresh "), 1);
}

#[test]
fn rotated_cookie_survives_a_credential_store_write_failure() {
    let gateway = Gateway::new(|request| {
        assert!(request.contains("new_api_refresh=refresh-0"));
        Reply::refresh(1)
    });
    let account = AccountFixture::new(&gateway.base);
    account.expire_access();
    refresh_store::deny_writes(&newapi_refresh_secret_account(&gateway.base), true);
    let client = account_http_client_builder(Duration::from_secs(3))
        .build()
        .unwrap();
    let result = runtime().block_on(authenticated_stored_session(&client));
    assert!(
        result.is_ok(),
        "a completed renewal must survive storage failure"
    );
    assert_eq!(
        cached_refresh_session(&gateway.base).unwrap().cookies[0].value,
        "refresh-1"
    );
    assert_eq!(
        cached_access_token(&gateway.base).as_deref(),
        Some("access-1")
    );
    assert!(has_stored_session());
}

#[test]
fn a_revoked_refresh_session_really_does_sign_out() {
    let gateway = Gateway::new(|_| Reply::error(401, "AUTH_SESSION_REVOKED"));
    let account = AccountFixture::new(&gateway.base);
    account.expire_access();
    let result = runtime().block_on(newapi_usage_logs(1, 20));
    assert_eq!(result.err().as_deref(), Some(SESSION_EXPIRED_MESSAGE));
    assert!(!has_stored_session());
    assert!(cached_refresh_session(&gateway.base).is_none());
}

#[test]
fn unavailable_refresh_service_keeps_the_account_and_refresh_cookie() {
    let gateway = Gateway::new(|_| Reply::error(503, "SERVICE_UNAVAILABLE"));
    let account = AccountFixture::new(&gateway.base);
    account.expire_access();
    let result = runtime().block_on(newapi_usage_logs(1, 20));
    assert!(result.is_err());
    assert_ne!(result.err().as_deref(), Some(SESSION_EXPIRED_MESSAGE));
    assert!(has_stored_session());
    assert_eq!(
        cached_refresh_session(&gateway.base).unwrap().cookies[0].value,
        "refresh-0"
    );
}

#[test]
fn model_listing_recovers_a_rotated_key_without_signing_out() {
    let gateway = Gateway::new(|request| {
        if request.starts_with("GET /api/token/ ") {
            return Reply::ok(
                json!({ "items": [{ "id": 5, "name": TOKEN_NAME, "status": 1, "key": "old********key", "group": "" }] }),
            );
        }
        if request.starts_with("POST /api/token/5/key ") {
            return Reply::ok(json!({ "key": "new" }));
        }
        assert!(request.starts_with("GET /v1/models "));
        if request
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-old")
        {
            Reply {
                status: 401,
                body: json!({ "error": { "message": "Invalid token", "type": "authentication_error" } }),
                cookie: None,
            }
        } else {
            Reply::ok(json!([{ "id": "MiniMax-M3" }]))
        }
    });
    let _account = AccountFixture::new(&gateway.base);
    let result = runtime().block_on(newapi_models());
    assert_eq!(
        result.as_ref().ok(),
        Some(&vec!["MiniMax-M3".to_string()]),
        "{result:?}"
    );
    assert!(has_stored_session());
    assert_eq!(
        config::managed_executor_api_key(&config::load_object()).as_deref(),
        Some("sk-new")
    );
    assert_eq!(gateway.count("POST /api/token/5/key "), 1);
}

#[test]
fn an_already_expired_access_token_does_not_gain_a_fourteen_minute_lifetime() {
    assert!(access_token_expiry(Some(1)) <= SystemTime::now());
}

#[test]
fn the_latest_rotated_cookie_is_saved_when_the_credential_store_recovers() {
    let gateway = Gateway::new(|_| Reply::refresh(1));
    let account = AccountFixture::new(&gateway.base);
    account.expire_access();
    let store_account = newapi_refresh_secret_account(&gateway.base);
    refresh_store::deny_writes(&store_account, true);
    let client = account_http_client_builder(Duration::from_secs(3))
        .build()
        .unwrap();
    let runtime = runtime();
    runtime
        .block_on(authenticated_stored_session(&client))
        .unwrap();
    let stored: NewApiRefreshSession =
        serde_json::from_slice(&refresh_store::read(&store_account).unwrap().unwrap()).unwrap();
    assert_eq!(stored.cookies[0].value, "refresh-0");

    refresh_store::deny_writes(&store_account, false);
    refresh_session_cache()
        .lock()
        .unwrap()
        .get_mut(&gateway.base)
        .unwrap()
        .persist_retry_at = Some(Instant::now());
    runtime
        .block_on(authenticated_stored_session(&client))
        .unwrap();
    let stored: NewApiRefreshSession =
        serde_json::from_slice(&refresh_store::read(&store_account).unwrap().unwrap()).unwrap();
    assert_eq!(stored.cookies[0].value, "refresh-1");
    assert!(has_stored_session());
    assert_eq!(gateway.count("POST /api/user/auth/refresh "), 1);
}

#[test]
fn a_second_access_rejection_does_not_revoke_a_valid_refresh_session() {
    let gateway = Gateway::new(|request| {
        if request.starts_with("POST /api/user/auth/refresh ") {
            Reply::refresh(1)
        } else {
            Reply::error(401, "AUTH_TOKEN_EXPIRED")
        }
    });
    let _account = AccountFixture::new(&gateway.base);
    let result = runtime().block_on(newapi_usage_logs(1, 20));
    assert!(result.is_err());
    assert_ne!(result.err().as_deref(), Some(SESSION_EXPIRED_MESSAGE));
    assert!(has_stored_session());
    assert_eq!(gateway.count("POST /api/user/auth/refresh "), 1);
    assert_eq!(gateway.count("GET /api/log/self?"), 2);
}

#[test]
fn account_bootstrap_renews_an_access_token_rejected_by_user_self() {
    let gateway = Gateway::new(|request| {
        if request.starts_with("POST /api/user/auth/refresh ") {
            return Reply::refresh(1);
        }
        if request
            .to_ascii_lowercase()
            .contains("authorization: bearer access-0")
        {
            return Reply::error(401, "AUTH_TOKEN_EXPIRED");
        }
        if request.starts_with("GET /api/user/self ") {
            return Reply::ok(
                json!({ "id": 17, "username": "researcher", "group": "go", "quota": 100 }),
            );
        }
        if request.starts_with("GET /api/user/self/groups ") {
            return Reply::ok(json!({}));
        }
        if request.starts_with("GET /api/user/models ") {
            return Reply::ok(json!(["MiniMax-M3"]));
        }
        if request.starts_with("GET /api/token/ ") {
            return Reply::ok(
                json!({ "items": [{ "id": 5, "name": TOKEN_NAME, "status": 1, "key": "old********key", "group": "" }] }),
            );
        }
        if request.starts_with("GET /v1/models ") {
            return Reply::ok(json!([{ "id": "MiniMax-M3" }]));
        }
        Reply::ok(json!([]))
    });
    let _account = AccountFixture::new(&gateway.base);
    let result = runtime().block_on(newapi_bootstrap());
    assert!(result.is_ok(), "bootstrap must recover: {:?}", result.err());
    assert!(has_stored_session());
    assert_eq!(gateway.count("POST /api/user/auth/refresh "), 1);
    assert_eq!(gateway.count("GET /api/user/self "), 2);
}

#[test]
fn a_queued_refresh_reads_the_cookie_after_taking_the_lock() {
    let gateway = Gateway::new(|request| {
        assert!(request.contains("new_api_refresh=refresh-1"));
        Reply::refresh(2)
    });
    let account = AccountFixture::new(&gateway.base);
    account.expire_access();
    let client = account_http_client_builder(Duration::from_secs(3))
        .build()
        .unwrap();
    runtime().block_on(async {
        let guard = access_token_refresh_lock().lock().await;
        let queued = tokio::spawn(async move { authenticated_stored_session(&client).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let mut latest = cached_refresh_session(&gateway.base).unwrap();
        latest.cookies[0].value = "refresh-1".to_string();
        save_refresh_session(&gateway.base, &latest).unwrap();
        drop(guard);
        let (_, session) = queued.await.unwrap().unwrap();
        assert_eq!(session.user_token.as_deref(), Some("access-2"));
    });
    assert!(has_stored_session());
}

#[test]
fn a_rejected_legacy_session_without_a_refresh_credential_requires_login() {
    let gateway = Gateway::new(|_| Reply::error(401, "AUTH_UNAUTHORIZED"));
    let _account = AccountFixture::new(&gateway.base);
    delete_refresh_session(&gateway.base).unwrap();
    config::persist_values(&[("newapi_access_token", json!("legacy-management-token"))]).unwrap();
    let result = runtime().block_on(newapi_usage_logs(1, 20));
    assert_eq!(result.err().as_deref(), Some(SESSION_EXPIRED_MESSAGE));
    assert!(!has_stored_session());
    assert_eq!(gateway.count("POST /api/user/auth/refresh "), 0);
}
