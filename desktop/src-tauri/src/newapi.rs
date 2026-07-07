//! Login bridge to a self-hosted new-api gateway.
//!
//! The desktop app no longer asks end users for an upstream API key. Instead a
//! user signs in with their new-api account; we authenticate against new-api's
//! user API, then fetch (or lazily create) one downstream token under that
//! account and hand its key back. The frontend writes that key + the new-api
//! base URL into the executor config, so Chat talks to models *through* new-api.
//! The real upstream (e.g. MiniMax) key never leaves the new-api server.
//!
//! new-api's management API authenticates via a session cookie *and* requires a
//! matching `New-Api-User: <id>` header on every call (see its `UserAuth`
//! middleware), so we keep a cookie store and echo the logged-in user id.

use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

use crate::config;

/// Token name we create/look for under the user's account.
const TOKEN_NAME: &str = "somniq-desktop";
/// Managed New API gateway used by Aris internal builds.
const DEFAULT_BASE_URL: &str = "http://106.53.28.124:18080";
/// Default executor model when the caller doesn't pin one. Must match a model
/// the new-api MiniMax channel exposes.
const DEFAULT_MODEL: &str = "MiniMax-M3";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiLogin {
    /// OpenAI-compatible base URL for the executor (`<base>/v1`).
    pub base_url: String,
    pub model: String,
    /// Usable downstream key (`sk-…`) for the executor.
    pub token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiAuthStatus {
    pub register_enabled: bool,
    pub password_register_enabled: bool,
    pub password_login_enabled: bool,
    pub email_verification: bool,
    pub turnstile_check: bool,
    pub turnstile_site_key: String,
    pub user_agreement_enabled: bool,
    pub privacy_policy_enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiGroupOption {
    pub name: String,
    pub desc: String,
    pub ratio: String,
}

fn trim_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        DEFAULT_BASE_URL.to_string()
    } else {
        trimmed.to_string()
    }
}

fn api_ok(body: &Value) -> bool {
    body.get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn api_message(body: &Value) -> String {
    body.get("message")
        .or_else(|| body.get("error").and_then(|error| error.get("message")))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn value_as_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Number(value) => value.as_i64().map(|value| value != 0),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Some(true),
            "false" | "0" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn status_bool(data: &Value, key: &str, default: bool) -> bool {
    data.get(key).and_then(value_as_bool).unwrap_or(default)
}

fn status_string(data: &Value, key: &str) -> String {
    data.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

async fn fetch_auth_status(
    client: &reqwest::Client,
    base: &str,
) -> Result<NewApiAuthStatus, String> {
    let response = client
        .get(format!("{base}/api/status"))
        .send()
        .await
        .map_err(|error| format!("无法读取注册配置: {error}"))?;
    let body = parse_json(response, "注册配置").await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "无法读取注册配置".to_string()
        } else {
            message
        });
    }
    let data = body.get("data").unwrap_or(&body);
    Ok(NewApiAuthStatus {
        register_enabled: status_bool(data, "register_enabled", false),
        password_register_enabled: status_bool(data, "password_register_enabled", false),
        password_login_enabled: status_bool(data, "password_login_enabled", true),
        email_verification: status_bool(data, "email_verification", false),
        turnstile_check: status_bool(data, "turnstile_check", false),
        turnstile_site_key: status_string(data, "turnstile_site_key"),
        user_agreement_enabled: status_bool(data, "user_agreement_enabled", false),
        privacy_policy_enabled: status_bool(data, "privacy_policy_enabled", false),
    })
}

/// Apply the `New-Api-User` header required by new-api's `UserAuth` middleware.
fn with_session(
    builder: reqwest::RequestBuilder,
    session: &NewApiSession,
) -> reqwest::RequestBuilder {
    let builder = builder.header("New-Api-User", session.user_id.to_string());
    match session
        .user_token
        .as_deref()
        .filter(|token| !token.is_empty())
    {
        Some(token) => builder.bearer_auth(token),
        None => builder,
    }
}

async fn parse_json(response: reqwest::Response, label: &str) -> Result<Value, String> {
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("{label}响应解析失败: {error}"))
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
}

fn value_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.trim().to_string()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
    .filter(|value| !value.is_empty())
}

fn has_admin_marker(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "admin" | "administrator" | "root" | "superuser" | "super-admin" | "owner"
    ) || value.contains("管理员")
        || value.contains("管理員")
}

pub(crate) fn user_is_admin_marker(
    role: i64,
    role_text: Option<String>,
    group: &str,
    group_desc: &str,
) -> bool {
    role >= 10
        || role_text.as_deref().is_some_and(has_admin_marker)
        || has_admin_marker(group)
        || has_admin_marker(group_desc)
}

fn data_user_id(data: &Value) -> Option<i64> {
    data.get("id")
        .and_then(value_as_i64)
        .or_else(|| data.get("user")?.get("id").and_then(value_as_i64))
}

fn data_user_token(data: &Value) -> Option<String> {
    raw_token_from_value(data)
}

fn raw_token_from_value(value: &Value) -> Option<String> {
    if let Some(token) = value
        .as_str()
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        return Some(token.to_string());
    }
    let obj = value.as_object()?;
    ["token", "access_token", "accessToken", "user_token", "key"]
        .into_iter()
        .filter_map(|key| obj.get(key).and_then(Value::as_str))
        .map(str::trim)
        .find(|token| !token.is_empty())
        .map(ToString::to_string)
        .or_else(|| obj.get("data").and_then(raw_token_from_value))
}

fn generate_token_key() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

struct NewApiSession {
    user_id: i64,
    user_token: Option<String>,
}

struct TokenCandidate {
    id: Option<i64>,
    key: Option<String>,
}

fn normalize_downstream_key(key: &str) -> Option<String> {
    let key = key.trim();
    if key.is_empty() || key.contains('*') || key.contains('…') {
        return None;
    }
    Some(if key.starts_with("sk-") {
        key.to_string()
    } else {
        format!("sk-{key}")
    })
}

fn token_candidate(item: &Value) -> Option<TokenCandidate> {
    if let Some(id) = value_as_i64(item) {
        return Some(TokenCandidate {
            id: Some(id),
            key: None,
        });
    }
    let id = item.get("id").and_then(value_as_i64);
    let key = ["key", "token", "value"]
        .into_iter()
        .filter_map(|field| item.get(field).and_then(Value::as_str))
        .find_map(normalize_downstream_key);
    if id.is_none() && key.is_none() {
        None
    } else {
        Some(TokenCandidate { id, key })
    }
}

fn token_is_enabled(item: &Value) -> bool {
    match item.get("status") {
        Some(Value::Bool(enabled)) => *enabled,
        Some(value) => value.as_i64().unwrap_or(1) == 1,
        None => true,
    }
}

fn token_name(item: &Value) -> &str {
    item.get("name").and_then(Value::as_str).unwrap_or("")
}

fn get_config_string(key: &str) -> Option<String> {
    config::load_object()
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn managed_base_url() -> String {
    get_config_string("newapi_executor_base_url")
        .or_else(|| get_config_string("executor_base_url"))
        .unwrap_or_else(|| format!("{DEFAULT_BASE_URL}/v1"))
}

const SESSION_EXPIRED_MESSAGE: &str = "Login expired. Please sign in again.";

fn is_invalid_session_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("invalid access token")
        || lower.contains("invalid token")
        || lower.contains("401 unauthorized")
        || (lower.contains("unauthorized") && lower.contains("token"))
}

fn clear_session_if_invalid<T>(result: Result<T, String>) -> Result<T, String> {
    match result {
        Err(message) if is_invalid_session_error(&message) => {
            let _ = config::clear_newapi_session();
            Err(SESSION_EXPIRED_MESSAGE.to_string())
        }
        other => other,
    }
}

fn has_stored_session() -> bool {
    let obj = config::load_object();
    let has_base = obj
        .get("newapi_base_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let has_user = obj.get("newapi_user_id").and_then(value_as_i64).is_some();
    has_base && has_user
}

pub(crate) async fn stored_user_is_admin() -> Result<bool, String> {
    let (base, session) = stored_session().map_err(|_| SESSION_EXPIRED_MESSAGE.to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP client creation failed: {error}"))?;
    let data = clear_session_if_invalid(user_self(&client, &base, &session).await)?;
    let string_field = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let group = string_field("group");
    let groups = user_groups(&client, &base, &session).await;
    let group_desc = groups
        .get(group.as_str())
        .and_then(|entry| entry.get("desc"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let role = data
        .get("role")
        .or_else(|| data.get("user_role"))
        .or_else(|| data.get("userRole"))
        .and_then(value_as_i64)
        .unwrap_or(0);
    let role_text = ["role", "role_name", "roleName", "status"]
        .into_iter()
        .filter_map(|key| data.get(key).and_then(value_as_string))
        .find(|value| has_admin_marker(value));
    Ok(user_is_admin_marker(role, role_text, &group, &group_desc))
}

/// Sign in and return the authenticated user/session values needed by new-api.
async fn login(
    client: &reqwest::Client,
    base: &str,
    username: &str,
    password: &str,
) -> Result<NewApiSession, String> {
    let response = client
        .post(format!("{base}/api/user/login"))
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|error| format!("无法连接服务器: {error}"))?;
    let body = parse_json(response, "登录").await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "账号或密码错误".to_string()
        } else {
            message
        });
    }
    let data = body
        .get("data")
        .ok_or_else(|| "登录成功但未返回用户信息".to_string())?;
    if data
        .get("require_2fa")
        .or_else(|| data.get("require2fa"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("该账号开启了两步验证，当前桌面端暂不支持 2FA 登录".to_string());
    }
    let user_id = data_user_id(data).ok_or_else(|| "登录成功但未返回用户信息".to_string())?;
    Ok(NewApiSession {
        user_id,
        user_token: data_user_token(data),
    })
}

/// Return the Aris-managed token under the account, if any.
async fn find_token(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
) -> Result<Option<TokenCandidate>, String> {
    let response = with_session(client.get(format!("{base}/api/token/")), session)
        .send()
        .await
        .map_err(|error| format!("获取令牌列表失败: {error}"))?;
    let body = parse_json(response, "令牌列表").await?;
    if !api_ok(&body) {
        return Ok(None);
    }
    // `data` is a paged object (`{ items: [...] }`) on current builds, but older
    // ones returned a bare array — accept either.
    let data = body.get("data");
    let items = data
        .and_then(|d| d.get("items"))
        .or(data)
        .and_then(Value::as_array);
    let Some(items) = items else {
        return Ok(None);
    };
    Ok(items
        .iter()
        .filter(|item| token_is_enabled(item) && token_name(item) == TOKEN_NAME)
        .find_map(token_candidate))
}

/// Create one unlimited-quota token (drawing from the user's account quota).
async fn create_token(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
) -> Result<Option<TokenCandidate>, String> {
    let generated_key = generate_token_key();
    let response = with_session(client.post(format!("{base}/api/token/")), session)
        .json(&serde_json::json!({
            "name": TOKEN_NAME,
            "key": generated_key.clone(),
            "amount": 0,
            "expire_time": 0,
            "expired_time": -1,            // never expires
            "remain_quota": 0,
            "unlimited_quota": true,       // bounded by the user's own quota
            "model_limits_enabled": false,
            "model_limits": "",
            "group": "",
        }))
        .send()
        .await
        .map_err(|error| format!("创建令牌失败: {error}"))?;
    let body = parse_json(response, "创建令牌").await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "创建令牌失败".to_string()
        } else {
            message
        });
    }
    let mut candidate = body
        .get("data")
        .and_then(token_candidate)
        .unwrap_or(TokenCandidate {
            id: None,
            key: None,
        });
    if candidate.key.is_none() {
        candidate.key = normalize_downstream_key(&generated_key);
    }
    Ok(Some(candidate))
}

fn token_key_from_body(body: &Value) -> Option<String> {
    let data = body.get("data").unwrap_or(body);
    ["key", "token", "value"]
        .into_iter()
        .filter_map(|field| data.get(field).and_then(Value::as_str))
        .find_map(normalize_downstream_key)
}

/// Fetch the full (unmasked) key for a token id; list responses are masked.
async fn fetch_token_key(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
    token_id: i64,
) -> Result<String, String> {
    let response = with_session(
        client.post(format!("{base}/api/token/{token_id}/key")),
        session,
    )
    .send()
    .await
    .map_err(|error| format!("获取令牌密钥失败: {error}"))?;
    let body = parse_json(response, "令牌密钥").await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "获取令牌密钥失败".to_string()
        } else {
            message
        });
    }
    token_key_from_body(&body).ok_or_else(|| "令牌密钥为空".to_string())
}

fn collect_model_ids(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(model) => {
            let model = model.trim();
            if !model.is_empty() {
                out.push(model.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_model_ids(item, out);
            }
        }
        Value::Object(obj) => {
            for key in ["id", "model", "name"] {
                if let Some(model) = obj.get(key).and_then(Value::as_str) {
                    let model = model.trim();
                    if !model.is_empty() {
                        out.push(model.to_string());
                    }
                }
            }
            for key in ["models", "items", "data"] {
                if let Some(child) = obj.get(key) {
                    collect_model_ids(child, out);
                }
            }
        }
        _ => {}
    }
}

async fn user_models(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
) -> Result<Vec<String>, String> {
    let response = with_session(client.get(format!("{base}/api/user/models")), session)
        .send()
        .await
        .map_err(|error| format!("获取模型列表失败: {error}"))?;
    let body = parse_json(response, "模型列表").await?;
    if !api_ok(&body) {
        return Ok(Vec::new());
    }
    let mut models = Vec::new();
    if let Some(data) = body.get("data") {
        collect_model_ids(data, &mut models);
    }
    models.sort();
    models.dedup();
    Ok(models)
}

async fn fetch_user_token(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
) -> Result<Option<String>, String> {
    let response = with_session(client.get(format!("{base}/api/user/token")), session)
        .send()
        .await
        .map_err(|error| format!("获取用户访问令牌失败: {error}"))?;
    let body = parse_json(response, "用户访问令牌").await?;
    if !api_ok(&body) {
        return Ok(None);
    }
    Ok(raw_token_from_value(&body))
}

fn resolve_model_from_list(models: &[String], requested_model: &str) -> String {
    let requested = requested_model.trim();
    let fallback = if requested.is_empty() {
        DEFAULT_MODEL
    } else {
        requested
    };
    if models.is_empty() || models.iter().any(|model| model == fallback) {
        return fallback.to_string();
    }
    if models.iter().any(|model| model == DEFAULT_MODEL) {
        return DEFAULT_MODEL.to_string();
    }
    models
        .first()
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
}

async fn get_or_create_token(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
) -> Result<String, String> {
    let token = match find_token(client, base, session).await? {
        Some(token) => token,
        None => match create_token(client, base, session).await? {
            Some(token) => token,
            None => find_token(client, base, session)
                .await?
                .ok_or_else(|| "令牌创建后仍未找到".to_string())?,
        },
    };
    if let Some(key) = token.key {
        return Ok(key);
    }
    let token_id = token.id.ok_or_else(|| "令牌未返回可用 ID".to_string())?;
    fetch_token_key(client, base, session, token_id).await
}

fn stored_session() -> Result<(String, NewApiSession), String> {
    let obj = config::load_object();
    let base = obj
        .get("newapi_base_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "尚未登录 New API".to_string())?;
    let user_id = obj
        .get("newapi_user_id")
        .and_then(value_as_i64)
        .ok_or_else(|| "尚未登录 New API".to_string())?;
    let user_token = obj
        .get("newapi_access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    Ok((
        base,
        NewApiSession {
            user_id,
            user_token,
        },
    ))
}

async fn refresh_downstream_token(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
    model: &str,
) -> Result<String, String> {
    let token = get_or_create_token(client, base, session).await?;
    let executor_base_url = format!("{base}/v1");
    config::persist_newapi_executor_credentials(&executor_base_url, &token)?;
    let model = model.trim();
    if !model.is_empty() {
        let _ = config::record_verified_executor("openai", model, Some(&executor_base_url), &token);
    }
    let _ = config::managed_config_object()?;
    Ok(token)
}

#[tauri::command]
pub async fn newapi_auth_status(base_url: String) -> Result<NewApiAuthStatus, String> {
    let base = trim_base(&base_url);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    fetch_auth_status(&client, &base).await
}

#[tauri::command]
pub fn newapi_logout() -> Result<(), String> {
    config::clear_newapi_session()
}

/// Authenticate against new-api and return an executor config (base URL, model,
/// downstream token) for the signed-in user. The frontend persists these into
/// the executor settings so Chat routes through new-api.
#[tauri::command]
pub async fn newapi_login(
    base_url: String,
    model: String,
    username: String,
    password: String,
) -> Result<NewApiLogin, String> {
    let base = trim_base(&base_url);
    if base.is_empty() {
        return Err("服务器地址不能为空".to_string());
    }
    let username = username.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err("请输入账号和密码".to_string());
    }
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;

    let mut session = login(&client, &base, &username, &password).await?;
    if session.user_token.is_none() {
        session.user_token = fetch_user_token(&client, &base, &session)
            .await
            .ok()
            .flatten();
    }
    let models = user_models(&client, &base, &session)
        .await
        .unwrap_or_default();
    if !models.is_empty() {
        let _ = config::persist_managed_models(&models);
    }
    let model = resolve_model_from_list(&models, &model);
    let executor_base_url = format!("{base}/v1");
    let token = refresh_downstream_token(&client, &base, &session, &model).await?;
    persist_session(&base, &username, &session);

    Ok(NewApiLogin {
        base_url: executor_base_url,
        model,
        token,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiRegisterInput {
    pub base_url: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub verification_code: Option<String>,
    #[serde(default)]
    pub aff_code: Option<String>,
    #[serde(default)]
    pub turnstile: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiVerificationInput {
    pub base_url: String,
    pub email: String,
    #[serde(default)]
    pub turnstile: Option<String>,
}

fn optional_payload_value(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn insert_optional_payload_field(
    payload: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<String>,
) {
    if let Some(value) = optional_payload_value(value) {
        payload.insert(key.to_string(), Value::String(value));
    }
}

#[tauri::command]
pub async fn newapi_send_verification(input: NewApiVerificationInput) -> Result<(), String> {
    let base = trim_base(&input.base_url);
    let email = input.email.trim().to_string();
    if email.is_empty() {
        return Err("请先输入邮箱".to_string());
    }
    let turnstile = optional_payload_value(input.turnstile).unwrap_or_default();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    let response = client
        .get(format!("{base}/api/verification"))
        .query(&[("email", email.as_str()), ("turnstile", turnstile.as_str())])
        .send()
        .await
        .map_err(|error| format!("无法连接服务器: {error}"))?;
    let body = parse_json(response, "邮箱验证码").await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "验证码发送失败".to_string()
        } else {
            message
        });
    }
    Ok(())
}

/// Register a new new-api account using the same rules as the web `/sign-up`
/// page. This intentionally does not sign in after success; new-api sends
/// users back to the sign-in flow after account creation.
#[tauri::command]
pub async fn newapi_register(input: NewApiRegisterInput) -> Result<(), String> {
    let base = trim_base(&input.base_url);
    let username = input.username.trim().to_string();
    let password = input.password;
    if username.is_empty() || password.is_empty() {
        return Err("请输入账号和密码".to_string());
    }
    let password_len = password.chars().count();
    if !(8..=20).contains(&password_len) {
        return Err("密码长度需要为 8-20 位".to_string());
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    let status = fetch_auth_status(&client, &base).await?;
    if !status.register_enabled {
        return Err("当前服务器未开放注册".to_string());
    }
    if !status.password_register_enabled {
        return Err("当前服务器未开放账号密码注册".to_string());
    }
    let email = optional_payload_value(input.email);
    let verification_code = optional_payload_value(input.verification_code);
    let aff_code = optional_payload_value(input.aff_code);
    let turnstile = optional_payload_value(input.turnstile);
    if status.email_verification && (email.is_none() || verification_code.is_none()) {
        return Err("当前服务器注册需要邮箱和验证码".to_string());
    }
    if status.turnstile_check && turnstile.is_none() {
        return Err("当前服务器注册需要人机验证，请先在网页端完成注册".to_string());
    }

    let mut payload = serde_json::Map::new();
    payload.insert("username".to_string(), Value::String(username.clone()));
    payload.insert("password".to_string(), Value::String(password.clone()));
    insert_optional_payload_field(&mut payload, "email", email);
    insert_optional_payload_field(&mut payload, "verification_code", verification_code);
    insert_optional_payload_field(&mut payload, "aff_code", aff_code);
    insert_optional_payload_field(&mut payload, "turnstile", turnstile.clone());
    let turnstile_query = turnstile.unwrap_or_default();

    let response = client
        .post(format!("{base}/api/user/register"))
        .query(&[("turnstile", turnstile_query.as_str())])
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("无法连接服务器: {error}"))?;
    let body = parse_json(response, "注册").await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "注册失败".to_string()
        } else {
            message
        });
    }

    Ok(())
}

/// Stash the gateway session so `newapi_bootstrap` can refresh account state
/// later without a password. The access token is the new-api personal token
/// used for management-API calls; omitting it just means a stale projection.
fn persist_session(base: &str, username: &str, session: &NewApiSession) {
    let mut values: Vec<(&str, Value)> = vec![
        ("newapi_base_url", Value::String(base.to_string())),
        ("newapi_user_id", Value::Number(session.user_id.into())),
        ("newapi_username", Value::String(username.to_string())),
    ];
    if let Some(token) = session
        .user_token
        .as_deref()
        .filter(|token| !token.is_empty())
    {
        values.push(("newapi_access_token", Value::String(token.to_string())));
    }
    let _ = config::persist_values(&values);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    pub username: String,
    pub display_name: String,
    pub role: i64,
    pub is_admin: bool,
    /// Active subscription plan name from `/api/subscription/self` + `/api/subscription/plans`.
    pub subscription_name: String,
    /// Active subscription plan subtitle/description.
    pub subscription_desc: String,
    /// Remaining active subscription quota, in new-api credit units.
    pub subscription_quota: i64,
    /// Active subscription quota consumed so far, in new-api credit units.
    pub subscription_used_quota: i64,
    /// new-api user group.
    pub group: String,
    /// Human description of the current group, from `/user/self/groups`.
    pub group_desc: String,
    /// Price multiplier of the current group, formatted for display ("1.5", "自动").
    pub group_ratio: String,
    /// Remaining quota balance, in new-api credit units.
    pub quota: i64,
    /// Quota consumed so far, in new-api credit units.
    pub used_quota: i64,
    pub models: Vec<String>,
    /// Currently selected executor model (from saved config).
    pub model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiUsageLogPage {
    pub items: Vec<NewApiUsageLogEntry>,
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiUsageLogEntry {
    pub id: String,
    pub created_at: i64,
    pub model: String,
    pub token_name: String,
    pub channel: String,
    pub request_id: String,
    pub upstream_request_id: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub quota: i64,
    pub status: String,
    pub type_label: String,
}

fn field_i64(item: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(value_as_i64))
}

fn field_string(item: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(value_as_string))
}

fn usage_log_items(data: &Value) -> Option<&Vec<Value>> {
    data.as_array().or_else(|| {
        ["items", "logs", "rows", "list", "records", "data"]
            .into_iter()
            .find_map(|key| data.get(key).and_then(Value::as_array))
    })
}

fn usage_log_total(
    body: &Value,
    data: &Value,
    item_count: usize,
    page: u32,
    page_size: u32,
) -> i64 {
    field_i64(data, &["total", "count", "totalCount", "total_count"])
        .or_else(|| field_i64(body, &["total", "count", "totalCount", "total_count"]))
        .unwrap_or_else(|| {
            let offset = page.saturating_sub(1).saturating_mul(page_size);
            let has_next_page_hint = i64::from(u8::from(item_count as u32 == page_size));
            i64::from(offset) + item_count as i64 + has_next_page_hint
        })
}

fn usage_type_label(item: &Value) -> String {
    if let Some(label) = field_string(item, &["type_label", "typeLabel", "type_name", "typeName"]) {
        return label;
    }
    match field_i64(item, &["type"]).unwrap_or_default() {
        1 => "Top-up",
        2 => "Consume",
        3 => "Manage",
        4 => "System",
        5 => "Error",
        6 => "Refund",
        7 => "Login",
        _ => "Unknown",
    }
    .to_string()
}

fn usage_log_entry(item: &Value, index: usize) -> NewApiUsageLogEntry {
    let created_at = field_i64(
        item,
        &[
            "created_at",
            "createdAt",
            "created_time",
            "createdTime",
            "created_time_unix",
            "time",
            "timestamp",
        ],
    )
    .unwrap_or_default();
    let request_id =
        field_string(item, &["request_id", "requestId", "requestID"]).unwrap_or_default();
    let upstream_request_id = field_string(
        item,
        &[
            "upstream_request_id",
            "upstreamRequestId",
            "upstreamRequestID",
        ],
    )
    .unwrap_or_default();
    let prompt_tokens = field_i64(
        item,
        &[
            "prompt_tokens",
            "promptTokens",
            "input_tokens",
            "inputTokens",
        ],
    )
    .unwrap_or_default();
    let completion_tokens = field_i64(
        item,
        &[
            "completion_tokens",
            "completionTokens",
            "output_tokens",
            "outputTokens",
        ],
    )
    .unwrap_or_default();
    let total_tokens = field_i64(item, &["total_tokens", "totalTokens"])
        .unwrap_or_else(|| prompt_tokens.saturating_add(completion_tokens));
    let id = field_string(item, &["id", "log_id", "logId"])
        .or_else(|| (!request_id.is_empty()).then(|| request_id.clone()))
        .or_else(|| (!upstream_request_id.is_empty()).then(|| upstream_request_id.clone()))
        .unwrap_or_else(|| format!("{created_at}-{index}"));

    NewApiUsageLogEntry {
        id,
        created_at,
        model: field_string(
            item,
            &["model_name", "modelName", "model", "model_id", "modelId"],
        )
        .unwrap_or_default(),
        token_name: field_string(item, &["token_name", "tokenName", "token"]).unwrap_or_default(),
        channel: field_string(
            item,
            &[
                "channel",
                "channel_name",
                "channelName",
                "channel_id",
                "channelId",
            ],
        )
        .unwrap_or_default(),
        request_id,
        upstream_request_id,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        quota: field_i64(item, &["quota", "used_quota", "usedQuota", "amount"]).unwrap_or_default(),
        status: field_string(item, &["status", "status_text", "statusText"]).unwrap_or_default(),
        type_label: usage_type_label(item),
    }
}

async fn user_self(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
) -> Result<Value, String> {
    let response = with_session(client.get(format!("{base}/api/user/self")), session)
        .send()
        .await
        .map_err(|error| format!("获取账户信息失败: {error}"))?;
    let body = parse_json(response, "账户信息").await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "获取账户信息失败".to_string()
        } else {
            message
        });
    }
    body.get("data")
        .cloned()
        .ok_or_else(|| "账户信息为空".to_string())
}

fn ratio_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

fn group_options_from_user_groups(groups: &Value) -> Vec<NewApiGroupOption> {
    let Some(object) = groups.as_object() else {
        return Vec::new();
    };
    let mut options = object
        .iter()
        .map(|(name, detail)| NewApiGroupOption {
            name: name.trim().to_string(),
            desc: detail
                .get("desc")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            ratio: detail.get("ratio").map(ratio_to_string).unwrap_or_default(),
        })
        .filter(|option| !option.name.is_empty())
        .collect::<Vec<_>>();
    options.sort_by(|left, right| left.name.cmp(&right.name));
    options
}

fn group_options_from_admin_groups(groups: &Value, user_groups: &Value) -> Vec<NewApiGroupOption> {
    let user_options = group_options_from_user_groups(user_groups);
    let detail_for = |name: &str| {
        user_options
            .iter()
            .find(|option| option.name == name)
            .map(|option| (option.desc.clone(), option.ratio.clone()))
            .unwrap_or_default()
    };
    let mut options = groups
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(value_as_string)
                .map(|name| {
                    let (desc, ratio) = detail_for(&name);
                    NewApiGroupOption { name, desc, ratio }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    options.sort_by(|left, right| left.name.cmp(&right.name));
    options.dedup_by(|left, right| left.name == right.name);
    options
}

async fn admin_groups(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
) -> Result<Value, String> {
    let response = with_session(client.get(format!("{base}/api/group/")), session)
        .send()
        .await
        .map_err(|error| format!("鑾峰彇鍚庡彴鍒嗙粍澶辫触: {error}"))?;
    let body = parse_json(response, "鍚庡彴鍒嗙粍").await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "鑾峰彇鍚庡彴鍒嗙粍澶辫触".to_string()
        } else {
            message
        });
    }
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

/// Fetch the user's usable groups with their ratio + description. Best
/// effort: any failure yields `Null` so bootstrap still returns core account
/// state.
async fn user_groups(client: &reqwest::Client, base: &str, session: &NewApiSession) -> Value {
    let Ok(response) = with_session(client.get(format!("{base}/api/user/self/groups")), session)
        .send()
        .await
    else {
        return Value::Null;
    };
    let Ok(body) = response.json::<Value>().await else {
        return Value::Null;
    };
    if !api_ok(&body) {
        return Value::Null;
    }
    body.get("data").cloned().unwrap_or(Value::Null)
}

async fn user_subscription_self(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
) -> Value {
    let Ok(response) = with_session(client.get(format!("{base}/api/subscription/self")), session)
        .send()
        .await
    else {
        return Value::Null;
    };
    let Ok(body) = response.json::<Value>().await else {
        return Value::Null;
    };
    if !api_ok(&body) {
        return Value::Null;
    }
    body.get("data").cloned().unwrap_or(Value::Null)
}

async fn subscription_plans(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
) -> Value {
    let Ok(response) = with_session(
        client.get(format!("{base}/api/subscription/plans")),
        session,
    )
    .send()
    .await
    else {
        return Value::Null;
    };
    let Ok(body) = response.json::<Value>().await else {
        return Value::Null;
    };
    if !api_ok(&body) {
        return Value::Null;
    }
    body.get("data").cloned().unwrap_or(Value::Null)
}

fn first_active_subscription(data: &Value) -> Option<&Value> {
    data.get("subscriptions")?
        .as_array()?
        .iter()
        .filter_map(|entry| entry.get("subscription").or(Some(entry)))
        .find(|subscription| {
            subscription
                .get("status")
                .and_then(Value::as_str)
                .map(|status| status.eq_ignore_ascii_case("active"))
                .unwrap_or(true)
        })
}

fn plan_for_subscription<'a>(plans: &'a Value, plan_id: i64) -> Option<&'a Value> {
    plans.as_array()?.iter().find_map(|entry| {
        let plan = entry.get("plan").unwrap_or(entry);
        (plan.get("id").and_then(value_as_i64) == Some(plan_id)).then_some(plan)
    })
}

fn subscription_projection(
    subscription_data: &Value,
    plan_data: &Value,
) -> (String, String, i64, i64) {
    let Some(subscription) = first_active_subscription(subscription_data) else {
        return (String::new(), String::new(), 0, 0);
    };
    let plan_id = subscription
        .get("plan_id")
        .or_else(|| subscription.get("planId"))
        .and_then(value_as_i64);
    let plan = plan_id.and_then(|id| plan_for_subscription(plan_data, id));
    let title = plan
        .and_then(|plan| plan.get("title"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let subtitle = plan
        .and_then(|plan| plan.get("subtitle"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let total = subscription
        .get("amount_total")
        .or_else(|| subscription.get("amountTotal"))
        .and_then(value_as_i64)
        .unwrap_or_else(|| {
            plan.and_then(|plan| plan.get("total_amount"))
                .and_then(value_as_i64)
                .unwrap_or(0)
        });
    let used = subscription
        .get("amount_used")
        .or_else(|| subscription.get("amountUsed"))
        .and_then(value_as_i64)
        .unwrap_or(0);
    (title, subtitle, total.saturating_sub(used), used)
}

/// Project the signed-in user's account state (entitlements) from new-api — the
/// server-truth backing the Settings "account" view. Reads the session stashed
/// at login and refreshes via the management API; the frontend caches the result
/// for fast/offline display.
#[tauri::command]
pub async fn newapi_bootstrap() -> Result<AccountState, String> {
    if !has_stored_session() {
        return Err(SESSION_EXPIRED_MESSAGE.to_string());
    }
    let obj = config::load_object();
    let base = obj
        .get("newapi_base_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "尚未登录 New API".to_string())?;
    let user_id = obj
        .get("newapi_user_id")
        .and_then(value_as_i64)
        .ok_or_else(|| "尚未登录 New API".to_string())?;
    let user_token = obj
        .get("newapi_access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let session = NewApiSession {
        user_id,
        user_token,
    };

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;

    let data = clear_session_if_invalid(user_self(&client, &base, &session).await)?;
    let string_field = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let models = user_models(&client, &base, &session)
        .await
        .unwrap_or_default();
    if !models.is_empty() {
        let _ = config::persist_managed_models(&models);
    }
    let model = resolve_model_from_list(
        &models,
        &get_config_string("executor_model").unwrap_or_default(),
    );
    let _ =
        clear_session_if_invalid(refresh_downstream_token(&client, &base, &session, &model).await)?;
    let group = string_field("group");
    let groups = user_groups(&client, &base, &session).await;
    let group_detail = groups.get(group.as_str());
    let group_desc = group_detail
        .and_then(|entry| entry.get("desc"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let group_ratio = group_detail
        .and_then(|entry| entry.get("ratio"))
        .map(ratio_to_string)
        .unwrap_or_default();
    let role = data
        .get("role")
        .or_else(|| data.get("user_role"))
        .or_else(|| data.get("userRole"))
        .and_then(value_as_i64)
        .unwrap_or(0);
    let role_text = ["role", "role_name", "roleName", "status"]
        .into_iter()
        .filter_map(|key| data.get(key).and_then(value_as_string))
        .find(|value| has_admin_marker(value));
    let is_admin = user_is_admin_marker(role, role_text, &group, &group_desc);
    let subscription_data = user_subscription_self(&client, &base, &session).await;
    let plan_data = subscription_plans(&client, &base, &session).await;
    let (subscription_name, subscription_desc, subscription_quota, subscription_used_quota) =
        subscription_projection(&subscription_data, &plan_data);

    Ok(AccountState {
        username: string_field("username"),
        display_name: string_field("display_name"),
        role,
        is_admin,
        subscription_name,
        subscription_desc,
        subscription_quota,
        subscription_used_quota,
        group,
        group_desc,
        group_ratio,
        quota: data.get("quota").and_then(value_as_i64).unwrap_or(0),
        used_quota: data.get("used_quota").and_then(value_as_i64).unwrap_or(0),
        models,
        model,
    })
}

#[tauri::command]
pub async fn newapi_groups() -> Result<Vec<NewApiGroupOption>, String> {
    let (base, session) = stored_session().map_err(|_| SESSION_EXPIRED_MESSAGE.to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    let user_group_data = user_groups(&client, &base, &session).await;
    let mut options = match admin_groups(&client, &base, &session).await {
        Ok(admin_group_data) => {
            group_options_from_admin_groups(&admin_group_data, &user_group_data)
        }
        Err(_) => group_options_from_user_groups(&user_group_data),
    };
    if options.is_empty() {
        let account = clear_session_if_invalid(user_self(&client, &base, &session).await)?;
        if let Some(group) = account
            .get("group")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            options.push(NewApiGroupOption {
                name: group.to_string(),
                desc: String::new(),
                ratio: String::new(),
            });
        }
    }
    Ok(options)
}

#[tauri::command]
pub async fn newapi_update_group(group: String) -> Result<AccountState, String> {
    let group = group.trim().to_string();
    if group.is_empty() {
        return Err("分组不能为空".to_string());
    }
    let (base, session) = stored_session().map_err(|_| SESSION_EXPIRED_MESSAGE.to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端初始化失败: {error}"))?;
    let account = clear_session_if_invalid(user_self(&client, &base, &session).await)?;
    let current_group = account
        .get("group")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if current_group == group {
        return newapi_bootstrap().await;
    }
    let field = |key: &str| {
        account
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let payload = serde_json::json!({
        "id": session.user_id,
        "username": field("username"),
        "display_name": field("display_name"),
        "group": group,
        "role": account
            .get("role")
            .or_else(|| account.get("user_role"))
            .or_else(|| account.get("userRole"))
            .and_then(value_as_i64)
            .unwrap_or_default(),
        "remark": field("remark"),
    });
    let response = with_session(client.put(format!("{base}/api/user/")), &session)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("更新后台分组失败: {error}"))?;
    let body = parse_json(response, "后台分组更新").await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "更新后台分组失败".to_string()
        } else {
            message
        });
    }
    newapi_bootstrap().await
}

async fn parse_usage_log_json(response: reqwest::Response) -> Result<Value, String> {
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("调用明细响应解析失败: {error}"))
}

fn normalize_usage_log_error(error: String) -> String {
    if error == SESSION_EXPIRED_MESSAGE {
        return error;
    }
    let cause = error
        .split_once(": ")
        .map(|(_, cause)| cause)
        .unwrap_or(error.as_str());
    format!("获取调用明细失败: {cause}")
}

#[tauri::command]
pub async fn newapi_usage_logs(page: u32, page_size: u32) -> Result<NewApiUsageLogPage, String> {
    let (base, session) = stored_session().map_err(|_| SESSION_EXPIRED_MESSAGE.to_string())?;
    let page = page.max(1);
    let page_size = page_size.clamp(1, 100);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端初始化失败: {error}"))?;
    let request = client.get(format!("{base}/api/log/self")).query(&[
        ("p", page.to_string()),
        ("page_size", page_size.to_string()),
        ("type", "2".to_string()),
    ]);
    let response = with_session(request, &session)
        .send()
        .await
        .map_err(|error| format!("获取调用明细失败: {error}"));
    let response = clear_session_if_invalid(response).map_err(normalize_usage_log_error)?;
    let body = parse_usage_log_json(response).await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return clear_session_if_invalid(Err(if message.is_empty() {
            "获取调用明细失败".to_string()
        } else {
            message
        }));
    }

    let data = body.get("data").unwrap_or(&body);
    let items = usage_log_items(data)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, item)| usage_log_entry(item, index))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let total = usage_log_total(&body, data, items.len(), page, page_size);
    Ok(NewApiUsageLogPage {
        items,
        total,
        page,
        page_size,
    })
}

/// Fetch the model list through the stored managed gateway token. This command
/// intentionally returns only model ids so Settings never has to reveal the
/// gateway base URL or API key.
#[tauri::command]
pub async fn newapi_models() -> Result<Vec<String>, String> {
    let mut api_key = get_config_string("newapi_executor_api_key")
        .or_else(|| get_config_string("executor_api_key"))
        .ok_or_else(|| "尚未登录 New API，无法获取模型列表".to_string())?;
    let base_url = managed_base_url();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    if let Ok((base, session)) = stored_session() {
        let model =
            get_config_string("executor_model").unwrap_or_else(|| DEFAULT_MODEL.to_string());
        api_key = clear_session_if_invalid(
            refresh_downstream_token(&client, &base, &session, &model).await,
        )?;
    }
    let response = client
        .get(format!("{}/models", base_url.trim_end_matches('/')))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|_| "获取模型列表失败，请稍后重试".to_string())?;
    let body = parse_json(response, "模型列表").await?;
    if body.get("error").is_some() || body.get("success").and_then(Value::as_bool) == Some(false) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "获取模型列表失败".to_string()
        } else {
            message
        });
    }
    let mut models = Vec::new();
    if let Some(data) = body.get("data") {
        collect_model_ids(data, &mut models);
    }
    models.sort();
    models.dedup();
    if !models.is_empty() {
        let _ = config::persist_managed_models(&models);
    }
    Ok(models)
}
