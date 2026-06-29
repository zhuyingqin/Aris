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
const TOKEN_NAME: &str = "aris-desktop";
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
    /// new-api user group — surfaced as the "plan / 套餐" in Settings.
    pub group: String,
    /// Human description of the current group (套餐说明), from `/user/self/groups`.
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

/// Fetch the user's usable groups (套餐) with their ratio + description. Best
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

/// Project the signed-in user's account state (entitlements) from new-api — the
/// server-truth backing the Settings "account" view. Reads the session stashed
/// at login and refreshes via the management API; the frontend caches the result
/// for fast/offline display.
#[tauri::command]
pub async fn newapi_bootstrap() -> Result<AccountState, String> {
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

    let data = user_self(&client, &base, &session).await?;
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
    let _ = refresh_downstream_token(&client, &base, &session, &model).await?;
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

    Ok(AccountState {
        username: string_field("username"),
        display_name: string_field("display_name"),
        group,
        group_desc,
        group_ratio,
        quota: data.get("quota").and_then(value_as_i64).unwrap_or(0),
        used_quota: data.get("used_quota").and_then(value_as_i64).unwrap_or(0),
        models,
        model,
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
        api_key = refresh_downstream_token(&client, &base, &session, &model).await?;
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
