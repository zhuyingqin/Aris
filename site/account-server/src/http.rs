use crate::{
    crypto::{hash, random},
    newapi, now, oidc,
    store::{Flow, User},
    App,
};
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

type Result<T> = std::result::Result<T, Error>;
pub struct Error(pub(crate) StatusCode, pub(crate) &'static str);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":{"code":self.1}}))).into_response()
    }
}
impl From<String> for Error {
    fn from(reason: String) -> Self {
        tracing::warn!(%reason,"account operation failed");
        Self(StatusCode::BAD_GATEWAY, "service_unavailable")
    }
}
fn unauthorized() -> Error {
    Error(StatusCode::UNAUTHORIZED, "sign_in_required")
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .merge(crate::membership_http::routes())
        .route("/healthz", get(|| async { Json(json!({"status":"ok"})) }))
        .route(
            "/account/",
            get(|| async { Html(include_str!("../web/index.html")) }),
        )
        .route(
            "/account/app.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../web/app.js"),
                )
            }),
        )
        .route("/v2/account/login", get(login))
        .route("/v2/account/callback", get(callback))
        .route("/v2/account/me", get(me))
        .route("/v2/account/logout", post(logout))
        .route("/v2/account/agreement", get(agreement))
        .route("/v2/account/consent", post(consent))
        .route("/v2/account/compute/connect", post(connect))
        .route("/oauth/oidc", get(compute_callback))
        .route("/v2/account/compute", get(compute))
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat))
        .route("/v1/responses", post(responses))
        .route("/v1/messages", post(messages))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn(headers))
        .with_state(app)
}

async fn headers(request: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    for (key,value) in [("cache-control","no-store"),("x-content-type-options","nosniff"),("referrer-policy","no-referrer"),("content-security-policy","default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")] {
        response.headers_mut().insert(key,HeaderValue::from_static(value));
    }
    response
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<_> = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(';'))
        .filter_map(|s| s.trim().split_once('='))
        .filter(|(n, _)| *n == name)
        .map(|(_, v)| v.to_string())
        .collect();
    if values.len() == 1
        && values[0].len() == 43
        && values[0]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        values.into_iter().next()
    } else {
        None
    }
}
fn set_cookie(app: &App, name: &str, value: &str, max_age: i64) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
        if app.config.secure { "; Secure" } else { "" }
    ))
    .unwrap()
}
pub(crate) fn user(app: &App, headers: &HeaderMap) -> Result<(User, String)> {
    let token = cookie(headers, app.config.session_cookie()).ok_or_else(unauthorized)?;
    let user = app.store.session(&token, now())?.ok_or_else(unauthorized)?;
    Ok((user, token))
}
pub(crate) fn origin(app: &App, headers: &HeaderMap) -> Result<()> {
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        != Some(app.config.origin().as_str())
    {
        return Err(Error(StatusCode::FORBIDDEN, "origin_rejected"));
    }
    Ok(())
}
pub(crate) fn consented(app: &App, user: &User) -> Result<()> {
    if !app.store.has_consent(
        &user.id,
        &app.config.agreement_version,
        &app.config.agreement_text,
    )? {
        return Err(Error(StatusCode::FORBIDDEN, "agreement_required"));
    }
    Ok(())
}

async fn login(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Response> {
    let (url, state, flow) = oidc::start(&app).await?;
    let browser = cookie(&headers, app.config.flow_cookie()).unwrap_or_else(random);
    app.store.save_flow(&state, &browser, &flow, now())?;
    let mut response = Redirect::to(&url).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(&app, app.config.flow_cookie(), &browser, 600),
    );
    Ok(response)
}
#[derive(Deserialize)]
struct Callback {
    code: Option<String>,
    state: String,
}
fn consume(app: &App, headers: &HeaderMap, state: &str) -> Result<Flow> {
    if state.is_empty() || state.len() > 512 {
        return Err(Error(StatusCode::BAD_REQUEST, "invalid_flow"));
    }
    let browser = cookie(headers, app.config.flow_cookie())
        .ok_or(Error(StatusCode::BAD_REQUEST, "invalid_flow"))?;
    app.store
        .consume_flow(state, &browser, now())?
        .ok_or(Error(StatusCode::BAD_REQUEST, "invalid_flow"))
}
async fn callback(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Query(q): Query<Callback>,
) -> Result<Response> {
    let flow = consume(&app, &headers, &q.state)?;
    if flow.kind != "oidc" {
        return Err(Error(StatusCode::BAD_REQUEST, "invalid_flow"));
    }
    let (_, token) = {
        let (subject, email, name) = oidc::finish(
            &app,
            q.code
                .ok_or(Error(StatusCode::BAD_REQUEST, "authorization_cancelled"))?,
            flow,
        )
        .await?;
        app.store
            .login(app.config.issuer.as_str(), &subject, &email, &name, now())?
    };
    if let Some(old) = cookie(&headers, app.config.session_cookie()) {
        app.store.logout(&old)?;
    }
    let mut response = Redirect::to(&app.config.home_path).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(&app, app.config.session_cookie(), &token, 86400),
    );
    Ok(response)
}
async fn me(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Json<Value>> {
    let (user, _) = user(&app, &headers)?;
    let accepted = app.store.has_consent(
        &user.id,
        &app.config.agreement_version,
        &app.config.agreement_text,
    )?;
    let connected = app
        .store
        .compute(&user.id, &app.config.newapi_instance)?
        .is_some();
    Ok(Json(
        json!({"user":{"id":user.id,"email":user.email,"display_name":user.display_name},"agreement_required":!accepted,"compute_connected":connected,
            "is_admin":crate::membership_http::is_admin(&app,&user)}),
    ))
}
async fn agreement(State(app): State<Arc<App>>) -> Json<Value> {
    Json(
        json!({"version":app.config.agreement_version,"text":app.config.agreement_text,"content_hash":hash(&app.config.agreement_text)}),
    )
}
#[derive(Deserialize)]
struct Consent {
    version: String,
    content_hash: String,
    accepted: bool,
}
async fn consent(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(body): Json<Consent>,
) -> Result<StatusCode> {
    origin(&app, &headers)?;
    let (user, _) = user(&app, &headers)?;
    if !body.accepted
        || body.version != app.config.agreement_version
        || body.content_hash != hash(&app.config.agreement_text)
    {
        return Err(Error(StatusCode::BAD_REQUEST, "invalid_agreement"));
    }
    app.store
        .consent(&user.id, &body.version, &app.config.agreement_text, now())?;
    Ok(StatusCode::NO_CONTENT)
}
async fn logout(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Response> {
    origin(&app, &headers)?;
    if let Some(token) = cookie(&headers, app.config.session_cookie()) {
        app.store.logout(&token)?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(&app, app.config.session_cookie(), "", 0),
    );
    Ok(response)
}
async fn connect(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Response> {
    origin(&app, &headers)?;
    let (user, session) = user(&app, &headers)?;
    consented(&app, &user)?;
    let metadata = oidc::metadata(&app).await?;
    let flow_token = newapi::start(&app).await?;
    let browser = cookie(&headers, app.config.flow_cookie()).unwrap_or_else(random);
    app.store.save_flow(
        &flow_token,
        &browser,
        &Flow {
            kind: "newapi".into(),
            verifier: String::new(),
            nonce: String::new(),
            session_hash: Some(hash(&session)),
        },
        now(),
    )?;
    let mut url = metadata.authorization_endpoint().url().clone();
    url.query_pairs_mut()
        .append_pair("client_id", &app.config.newapi_client_id)
        .append_pair("response_type", "code")
        .append_pair(
            "redirect_uri",
            app.config.public_url.join("oauth/oidc").unwrap().as_str(),
        )
        .append_pair("scope", "openid email profile")
        .append_pair("state", &flow_token);
    let mut response = Json(json!({"authorization_url":url.as_str()})).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(&app, app.config.flow_cookie(), &browser, 600),
    );
    Ok(response)
}
async fn compute_callback(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Query(q): Query<Callback>,
) -> Result<Redirect> {
    let (user, session) = user(&app, &headers)?;
    consented(&app, &user)?;
    let flow = consume(&app, &headers, &q.state)?;
    if flow.kind != "newapi" || flow.session_hash != Some(hash(&session)) {
        return Err(Error(StatusCode::BAD_REQUEST, "invalid_flow"));
    }
    newapi::finish(
        &app,
        &q.code
            .ok_or(Error(StatusCode::BAD_REQUEST, "authorization_cancelled"))?,
        &q.state,
        &user,
    )
    .await?;
    Ok(Redirect::to(&app.config.home_path))
}
async fn compute(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Json<Value>> {
    let (user, _) = user(&app, &headers)?;
    consented(&app, &user)?;
    let account = newapi::session(&app, &user).await?;
    let data = newapi::data(
        app.client
            .get(newapi::endpoint(&app, "api/user/self"))
            .bearer_auth(&account.access_token)
            .send()
            .await
            .map_err(|_| "compute service unavailable".to_string())?,
    )
    .await?;
    if data["id"].as_i64() != Some(account.user_id) {
        return Err(Error(StatusCode::BAD_GATEWAY, "compute_identity_mismatch"));
    }
    Ok(Json(
        json!({"quota":data["quota"],"used_quota":data["used_quota"],"request_count":data["request_count"],"unit":"newapi_quota"}),
    ))
}
async fn models(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Response> {
    proxy(app, headers, "v1/models", None).await
}
async fn chat(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    proxy(app, headers, "v1/chat/completions", Some(body)).await
}
async fn responses(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    proxy(app, headers, "v1/responses", Some(body)).await
}
async fn messages(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    proxy(app, headers, "v1/messages", Some(body)).await
}

// Parse once and forward the validated representation. Duplicate root fields
// could otherwise authorize one model while the upstream parser selects another.
struct CheckedBody(Value);
impl<'de> Deserialize<'de> for CheckedBody {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = CheckedBody;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a model request object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<CheckedBody, A::Error> {
                let mut fields = serde_json::Map::new();
                while let Some((key, value)) = map.next_entry::<String, Value>()? {
                    if fields.insert(key, value).is_some() {
                        return Err(serde::de::Error::custom("duplicate request field"));
                    }
                }
                Ok(CheckedBody(Value::Object(fields)))
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}
async fn proxy(
    app: Arc<App>,
    headers: HeaderMap,
    path: &str,
    body: Option<Bytes>,
) -> Result<Response> {
    if body.is_some() {
        origin(&app, &headers)?;
    }
    let (user, _) = user(&app, &headers)?;
    consented(&app, &user)?;
    let _policy_guard = app.policy_lock.read().await;
    let policy = app.store.entitlements(&user.id, now())?;
    let request_body = body
        .map(|bytes| -> Result<Value> {
            let value = serde_json::from_slice::<CheckedBody>(&bytes)
                .map_err(|_| Error(StatusCode::BAD_REQUEST, "invalid_model_request"))?
                .0;
            let model = value["model"]
                .as_str()
                .filter(|m| crate::membership::valid_model(m))
                .ok_or(Error(StatusCode::BAD_REQUEST, "invalid_model"))?;
            if !policy.models.iter().any(|m| m == model) {
                return Err(Error(StatusCode::FORBIDDEN, "model_not_allowed"));
            }
            if ["group", "channel_id"]
                .iter()
                .any(|key| value.get(key).is_some())
                || value["background"].as_bool() == Some(true)
            {
                return Err(Error(StatusCode::BAD_REQUEST, "unsupported_routing_option"));
            }
            Ok(value)
        })
        .transpose()?;
    if request_body.is_none() && policy.models.is_empty() {
        return Ok(Json(json!({"object":"list","data":[]})).into_response());
    }
    let account = newapi::model_account(&app, &user, false).await?;
    // Expiry may have passed while synchronizing an upstream token.
    if app.store.entitlements(&user.id, now())?.fingerprint() != policy.fingerprint() {
        return Err(Error(StatusCode::FORBIDDEN, "membership_changed"));
    }
    let key = account
        .model_key
        .ok_or(Error(StatusCode::CONFLICT, "compute_not_ready"))?;
    let method = if request_body.is_some() {
        reqwest::Method::POST
    } else {
        reqwest::Method::GET
    };
    let mut request = app
        .client
        .request(method, newapi::endpoint(&app, path))
        .bearer_auth(key)
        .timeout(std::time::Duration::from_secs(300));
    if path == "v1/messages" {
        request = request.header("anthropic-version", "2023-06-01");
    }
    if let Some(value) = &request_body {
        request = request.json(value);
    }
    let upstream = tokio::time::timeout(std::time::Duration::from_secs(30), request.send())
        .await
        .map_err(|_| "model service timed out".to_string())?
        .map_err(|_| "model service unavailable".to_string())?;
    if request_body.is_none() {
        if !upstream.status().is_success() {
            return Err(Error(StatusCode::BAD_GATEWAY, "model_catalog_unavailable"));
        }
        let mut value: Value = upstream
            .json()
            .await
            .map_err(|_| "invalid upstream model list".to_string())?;
        let data = value["data"]
            .as_array_mut()
            .ok_or(Error(StatusCode::BAD_GATEWAY, "invalid_model_catalog"))?;
        data.retain(|item| {
            item["id"]
                .as_str()
                .is_some_and(|id| policy.models.iter().any(|m| m == id))
        });
        return Ok(Json(json!({"object":"list","data":data})).into_response());
    }
    let status = upstream.status();
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    if let Some(value) = content_type {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}
