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

use keyring::{Entry as KeyringEntry, Error as KeyringError};
use rand::{distributions::Alphanumeric, Rng};
use reqwest::header::{HeaderMap, HeaderValue, COOKIE, ORIGIN, SET_COOKIE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

use crate::config;

/// Token name we create/look for under the user's account.
const TOKEN_NAME: &str = "somniq-desktop";
/// Managed New API gateway used by Aris internal builds.
const DEFAULT_BASE_URL: &str = "http://106.53.28.124:18080";
/// Default executor model when the caller doesn't pin one. Must match a model
/// the new-api MiniMax channel exposes.
const DEFAULT_MODEL: &str = "MiniMax-M3";
const NEWAPI_REFRESH_KEYRING_SERVICE: &str = "SomniQ Studio New API Sessions";
/// Locally stored routing group pick. new-api keeps `user.group` admin-owned,
/// so the desktop's group switch lives on the managed token instead and this
/// key is the only record of what the user chose.
const SELECTED_GROUP_KEY: &str = "newapi_group";
/// Current new-api browser-session contract. Only this HttpOnly cookie is a
/// refresh credential; other cookies can be issued by legacy gateways,
/// reverse proxies, or unrelated middleware.
const NEWAPI_REFRESH_COOKIE_NAME: &str = "new_api_refresh";
const MAX_REFRESH_COOKIES: usize = 4;
const MAX_REFRESH_COOKIE_VALUE_LEN: usize = 8 * 1024;
const ACCESS_TOKEN_RENEWAL_SKEW: Duration = Duration::from_secs(60);
const FALLBACK_ACCESS_TOKEN_LIFETIME: Duration = Duration::from_secs(14 * 60);

struct CachedAccessToken {
    token: String,
    expires_at: SystemTime,
}

static ACCESS_TOKEN_CACHE: OnceLock<Mutex<HashMap<String, CachedAccessToken>>> = OnceLock::new();
/// A rotated refresh cookie is single-use on current new-api gateways. The
/// Settings screen can ask for the account, groups, and models concurrently on
/// startup, so serialize the cache-miss → refresh → persist sequence rather
/// than letting sibling calls invalidate each other's cookie.
static ACCESS_TOKEN_REFRESH_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

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

fn api_error_code(body: &Value) -> Option<&str> {
    body.get("code")
        .and_then(Value::as_str)
        .or_else(|| {
            body.get("error")
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|code| !code.is_empty())
}

fn is_invalid_session_code(code: &str) -> bool {
    matches!(
        code.trim().to_ascii_uppercase().as_str(),
        "AUTH_TOKEN_EXPIRED" | "AUTH_SESSION_REVOKED" | "AUTH_UNAUTHORIZED"
    )
}

/// Preserve server-provided details for ordinary failures, while making the
/// refreshable session failures recognizable by `clear_session_if_invalid`.
/// Codes are retained for non-session auth failures such as
/// `AUTH_ORIGIN_FORBIDDEN`, which must not log a user out.
fn session_api_error(body: &Value, fallback: &str) -> String {
    if let Some(code) = api_error_code(body) {
        if is_invalid_session_code(code) {
            return code.to_string();
        }
        let message = api_message(body);
        return if message.is_empty() {
            code.to_string()
        } else {
            format!("{message} ({code})")
        };
    }
    let message = api_message(body);
    if message.is_empty() {
        fallback.to_string()
    } else {
        message
    }
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

/// Apply the `New-Api-User` header required by new-api's `UserAuth`
/// middleware. Modern gateways accept it alongside the refreshed access
/// token, while older gateways still require it.
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
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("{label}响应读取失败: {error}"))?;

    parse_json_bytes(&bytes).map_err(|error| {
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return format!("{label}请求过于频繁，请稍后重试 (HTTP 429)");
        }
        if !status.is_success() && bytes.is_empty() {
            return format!("{label}请求失败: HTTP {status}，请稍后重试");
        }
        let preview = response_preview(&bytes);
        format!(
            "{label}响应解析失败: HTTP {status}, Content-Type {content_type}: {error}; 响应内容: {preview}"
        )
    })
}

fn parse_json_bytes(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    // Some reverse proxies prepend a UTF-8 BOM even though JSON responses
    // should not contain one. Strip it before handing the body to serde_json.
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    serde_json::from_slice(bytes)
}

fn response_preview(bytes: &[u8]) -> String {
    const MAX_RESPONSE_PREVIEW_CHARS: usize = 300;
    let mut preview = String::from_utf8_lossy(bytes).trim().to_string();
    if preview.chars().count() > MAX_RESPONSE_PREVIEW_CHARS {
        preview = preview
            .chars()
            .take(MAX_RESPONSE_PREVIEW_CHARS)
            .collect::<String>();
        preview.push('…');
    }
    if preview.is_empty() {
        "<empty>".to_string()
    } else {
        preview
    }
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

fn data_access_expires_at(data: &Value) -> Option<i64> {
    ["access_expires_at", "accessExpiresAt", "expires_at"]
        .into_iter()
        .find_map(|key| data.get(key).and_then(value_as_i64))
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
    /// Short-lived browser access JWT. It deliberately never goes into
    /// config.json when the gateway supports the refresh-session protocol.
    user_token: Option<String>,
    /// Unix seconds reported by the gateway for `user_token`, when available.
    access_expires_at: Option<i64>,
    /// The long-lived, rotating refresh-cookie bundle. It is stored only in
    /// the operating-system credential store and loaded only to call refresh
    /// or logout.
    refresh_session: Option<NewApiRefreshSession>,
}

fn access_token_cache() -> &'static Mutex<HashMap<String, CachedAccessToken>> {
    ACCESS_TOKEN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn access_token_refresh_lock() -> &'static tokio::sync::Mutex<()> {
    ACCESS_TOKEN_REFRESH_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn access_token_expiry(expires_at: Option<i64>) -> SystemTime {
    expires_at
        .and_then(|seconds| u64::try_from(seconds).ok())
        .and_then(|seconds| UNIX_EPOCH.checked_add(Duration::from_secs(seconds)))
        .filter(|expiry| *expiry > SystemTime::now())
        .unwrap_or_else(|| SystemTime::now() + FALLBACK_ACCESS_TOKEN_LIFETIME)
}

fn remember_access_token(base: &str, token: &str, expires_at: Option<i64>) {
    if let Ok(mut cache) = access_token_cache().lock() {
        cache.insert(
            base.to_string(),
            CachedAccessToken {
                token: token.to_string(),
                expires_at: access_token_expiry(expires_at),
            },
        );
    }
}

fn cached_access_token(base: &str) -> Option<String> {
    let mut cache = access_token_cache().lock().ok()?;
    let expires_before = SystemTime::now() + ACCESS_TOKEN_RENEWAL_SKEW;
    let entry = cache.get(base)?;
    if entry.expires_at > expires_before {
        return Some(entry.token.clone());
    }
    cache.remove(base);
    None
}

fn forget_access_token(base: &str) {
    if let Ok(mut cache) = access_token_cache().lock() {
        cache.remove(base);
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct NewApiRefreshSession {
    cookies: Vec<NewApiRefreshCookie>,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct NewApiRefreshCookie {
    name: String,
    value: String,
}

fn data_session_id(data: &Value) -> Option<String> {
    data.get("session")
        .and_then(|session| session.get("sid"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|sid| !sid.is_empty())
        .map(ToString::to_string)
}

fn valid_cookie_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn valid_cookie_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REFRESH_COOKIE_VALUE_LEN
        && !value
            .bytes()
            .any(|byte| byte.is_ascii_control() || matches!(byte, b';' | b',' | b' ' | b'\t'))
}

/// Keep only the documented HttpOnly refresh cookie from the new browser
/// session protocol. Treating every HttpOnly cookie as a refresh credential
/// breaks legacy deployments that use a regular dashboard/proxy cookie.
fn parse_refresh_cookie(set_cookie: &str) -> Option<NewApiRefreshCookie> {
    let mut segments = set_cookie.split(';');
    let (name, value) = segments.next()?.trim().split_once('=')?;
    let name = name.trim();
    let value = value.trim();
    if name != NEWAPI_REFRESH_COOKIE_NAME || !valid_cookie_name(name) || !valid_cookie_value(value)
    {
        return None;
    }
    let is_http_only = segments.any(|attribute| attribute.trim().eq_ignore_ascii_case("httponly"));
    is_http_only.then(|| NewApiRefreshCookie {
        name: name.to_string(),
        value: value.to_string(),
    })
}

fn refresh_cookies_from_headers(headers: &HeaderMap) -> Vec<NewApiRefreshCookie> {
    let mut cookies: Vec<NewApiRefreshCookie> = Vec::new();
    for value in headers.get_all(SET_COOKIE) {
        let Some(cookie) = value.to_str().ok().and_then(parse_refresh_cookie) else {
            continue;
        };
        if let Some(existing) = cookies
            .iter_mut()
            .find(|existing| existing.name == cookie.name)
        {
            *existing = cookie;
        } else if cookies.len() < MAX_REFRESH_COOKIES {
            cookies.push(cookie);
        }
    }
    cookies
}

fn refresh_cookie_header(cookies: &[NewApiRefreshCookie]) -> Result<HeaderValue, String> {
    if cookies.len() != 1 {
        return Err("登录续期凭据无效，请重新登录".to_string());
    }
    let value = cookies
        .iter()
        .map(|cookie| {
            if cookie.name != NEWAPI_REFRESH_COOKIE_NAME
                || !valid_cookie_name(&cookie.name)
                || !valid_cookie_value(&cookie.value)
            {
                return Err("登录续期凭据无效，请重新登录".to_string());
            }
            Ok(format!("{}={}", cookie.name, cookie.value))
        })
        .collect::<Result<Vec<_>, String>>()?
        .join("; ");
    HeaderValue::from_str(&value).map_err(|_| "登录续期凭据无效，请重新登录".to_string())
}

fn newapi_refresh_secret_account(base: &str) -> String {
    let digest = Sha256::digest(base.as_bytes());
    let fingerprint = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("refresh-{fingerprint}")
}

fn newapi_refresh_keyring_entry(base: &str) -> Result<KeyringEntry, String> {
    KeyringEntry::new(
        NEWAPI_REFRESH_KEYRING_SERVICE,
        &newapi_refresh_secret_account(base),
    )
    .map_err(|error| format!("无法访问系统登录凭据存储: {error}"))
}

fn save_refresh_session(base: &str, refresh_session: &NewApiRefreshSession) -> Result<(), String> {
    let bytes = serde_json::to_vec(refresh_session)
        .map_err(|error| format!("无法编码登录续期凭据: {error}"))?;
    newapi_refresh_keyring_entry(base)?
        .set_secret(&bytes)
        .map_err(|error| format!("无法保存系统登录凭据: {error}"))
}

fn load_refresh_session(base: &str) -> Result<Option<NewApiRefreshSession>, String> {
    let secret = match newapi_refresh_keyring_entry(base)?.get_secret() {
        Ok(secret) => secret,
        Err(KeyringError::NoEntry) => return Ok(None),
        Err(error) => return Err(format!("无法读取系统登录凭据: {error}")),
    };
    let refresh_session = serde_json::from_slice::<NewApiRefreshSession>(&secret)
        .map_err(|_| "保存的登录续期凭据无效，请重新登录".to_string())?;
    refresh_cookie_header(&refresh_session.cookies)?;
    if refresh_session
        .session_id
        .as_deref()
        .map(str::trim)
        .is_none_or(str::is_empty)
    {
        return Err("保存的登录续期凭据无效，请重新登录".to_string());
    }
    Ok(Some(refresh_session))
}

fn delete_refresh_session(base: &str) -> Result<(), String> {
    match newapi_refresh_keyring_entry(base)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法删除系统登录凭据: {error}")),
    }
}

fn request_origin(base: &str) -> Option<String> {
    reqwest::Url::parse(base)
        .ok()
        .map(|url| url.origin().ascii_serialization())
        .filter(|origin| origin != "null")
}

struct TokenCandidate {
    id: Option<i64>,
    key: Option<String>,
    group: Option<String>,
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
            group: None,
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
        Some(TokenCandidate {
            id,
            key,
            group: item
                .get("group")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|group| !group.is_empty())
                .map(ToString::to_string),
        })
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
    lower == SESSION_EXPIRED_MESSAGE.to_ascii_lowercase()
        || lower.contains("auth_token_expired")
        || lower.contains("auth_session_revoked")
        || lower.contains("auth_unauthorized")
        || lower.contains("invalid access token")
        || lower.contains("invalid token")
        || lower.contains("access token expired")
        || lower.contains("refresh token expired")
        || lower.contains("invalid refresh token")
        || lower.contains("auth_session_mismatch")
        || lower.contains("401 unauthorized")
        || lower.trim() == "unauthorized"
        || (lower.contains("unauthorized") && lower.contains("token"))
}

fn clear_local_session() {
    if let Some(base) = get_config_string("newapi_base_url") {
        forget_access_token(&base);
        let _ = delete_refresh_session(&base);
    }
    let _ = config::clear_newapi_session();
}

fn clear_session_if_invalid<T>(result: Result<T, String>) -> Result<T, String> {
    match result {
        Err(message) if is_invalid_session_error(&message) => {
            clear_local_session();
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

/// Returns a fresh, in-memory bearer for a service that must verify the
/// current NewAPI account. Callers must use it only over HTTPS and never
/// persist or log the returned token.
pub(crate) async fn image_assist_identity() -> Result<(String, i64, String), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP client creation failed: {error}"))?;
    let (base, session) = clear_session_if_invalid(authenticated_stored_session(&client).await)?;
    let token = session
        .user_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| SESSION_EXPIRED_MESSAGE.to_string())?;
    Ok((base, session.user_id, token))
}

pub(crate) async fn stored_user_is_admin() -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP client creation failed: {error}"))?;
    let (base, session) = clear_session_if_invalid(authenticated_stored_session(&client).await)?;
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
    let refresh_cookies = refresh_cookies_from_headers(response.headers());
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
    let refresh_session = data_session_id(data).and_then(|session_id| {
        (refresh_cookies.len() == 1).then_some(NewApiRefreshSession {
            cookies: refresh_cookies,
            session_id: Some(session_id),
        })
    });
    let mut session = NewApiSession {
        user_id,
        user_token: data_user_token(data),
        access_expires_at: data_access_expires_at(data),
        refresh_session,
    };
    if session.refresh_session.is_none() {
        // Compatibility for pre-refresh-session gateways. The modern path
        // above never persists this short-lived browser token to config.json.
        let login_response_token = session.user_token.clone();
        let management_token = fetch_user_token(client, base, &session)
            .await
            .ok()
            .flatten();
        session.user_token = persisted_user_token(login_response_token, management_token);
    }
    if let Some(token) = session.user_token.as_deref() {
        if session.refresh_session.is_some() {
            remember_access_token(base, token, session.access_expires_at);
        }
    }
    Ok(session)
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
        let message = session_api_error(&body, "获取令牌列表失败");
        if is_invalid_session_error(&message) {
            return Err(message);
        }
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
    group: &str,
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
            // A token's group, not the account's UI selection, controls actual
            // channel routing. Never let the gateway infer a stale distributor
            // group here: bind it to the account's current group explicitly.
            "group": group,
        }))
        .send()
        .await
        .map_err(|error| format!("创建令牌失败: {error}"))?;
    let body = parse_json(response, "创建令牌").await?;
    if !api_ok(&body) {
        return Err(session_api_error(&body, "创建令牌失败"));
    }
    let mut candidate = body
        .get("data")
        .and_then(token_candidate)
        .unwrap_or(TokenCandidate {
            id: None,
            key: None,
            group: Some(group.to_string()),
        });
    if candidate.key.is_none() {
        candidate.key = normalize_downstream_key(&generated_key);
    }
    Ok(Some(candidate))
}

fn account_group(data: &Value) -> Result<String, String> {
    data.get("group")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|group| !group.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| {
            "Current New API account group is missing. Choose a group and try again.".to_string()
        })
}

fn group_is_usable(usable: &Value, group: &str) -> bool {
    usable
        .as_object()
        .is_some_and(|groups| groups.contains_key(group))
}

/// Whether the managed token may route through `selected`, given the account's
/// usable groups.
///
/// `None` means the gateway did answer and does not list the group, so the
/// token would be rejected at request time with "无权访问 X 分组". An
/// empty/absent list means the best-effort lookup failed, which is not evidence
/// of anything: the group is treated as routable so a transient outage neither
/// blocks a switch nor silently undoes an earlier one.
fn resolve_routing_group(selected: &str, usable: &Value) -> Option<String> {
    if group_is_usable(usable, selected) {
        return Some(selected.to_string());
    }
    match usable.as_object() {
        Some(groups) if !groups.is_empty() => None,
        _ => Some(selected.to_string()),
    }
}

/// The group the managed token should route through, given already-fetched
/// usable groups. Falls back to the account group whenever there is no local
/// pick, or the pick has been revoked.
fn apply_group_preference(account_group: String, usable: &Value) -> String {
    let Some(selected) = get_config_string(SELECTED_GROUP_KEY) else {
        return account_group;
    };
    if selected == account_group {
        return account_group;
    }
    match resolve_routing_group(&selected, usable) {
        Some(group) => group,
        None => {
            let _ = config::remove_values(&[SELECTED_GROUP_KEY]);
            account_group
        }
    }
}

/// Same as [`apply_group_preference`], but fetches the usable groups only when
/// a local pick actually exists, so the common case costs no extra request.
async fn routing_group(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
    account: &Value,
) -> Result<String, String> {
    let account_group = account_group(account)?;
    match get_config_string(SELECTED_GROUP_KEY) {
        Some(selected) if selected != account_group => {
            let usable = user_groups(client, base, session).await;
            Ok(apply_group_preference(account_group, &usable))
        }
        _ => Ok(account_group),
    }
}

/// Build the complete update payload required by new-api's PUT /api/token/
/// endpoint while changing only the routing group. That endpoint treats its
/// body as a full replacement for mutable fields, so a minimal `{ id, group }`
/// payload would silently clear the token's quota and expiration settings.
fn token_group_update_payload(token: &Value, group: &str) -> Result<Value, String> {
    let id = token
        .get("id")
        .and_then(value_as_i64)
        .ok_or_else(|| "Managed token is missing its id.".to_string())?;
    let name = token
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Managed token is missing its name.".to_string())?;

    let field_or = |name: &str, default: Value| token.get(name).cloned().unwrap_or(default);
    Ok(serde_json::json!({
        "id": id,
        "name": name,
        "status": field_or("status", serde_json::json!(1)),
        "expired_time": field_or("expired_time", serde_json::json!(-1)),
        "remain_quota": field_or("remain_quota", serde_json::json!(0)),
        "unlimited_quota": field_or("unlimited_quota", serde_json::json!(true)),
        "model_limits_enabled": field_or("model_limits_enabled", serde_json::json!(false)),
        "model_limits": field_or("model_limits", serde_json::json!("")),
        "allow_ips": field_or("allow_ips", serde_json::json!("")),
        "group": group,
        "cross_group_retry": field_or("cross_group_retry", serde_json::json!(false)),
    }))
}

async fn update_token_group(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
    token_id: i64,
    group: &str,
) -> Result<(), String> {
    let response = with_session(client.get(format!("{base}/api/token/{token_id}")), session)
        .send()
        .await
        .map_err(|error| format!("Failed to read managed token: {error}"))?;
    let body = parse_json(response, "managed token").await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "Failed to read managed token.".to_string()
        } else {
            message
        });
    }
    let token = body
        .get("data")
        .ok_or_else(|| "Managed token response is empty.".to_string())?;
    let payload = token_group_update_payload(token, group)?;
    let response = with_session(client.put(format!("{base}/api/token/")), session)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Failed to update managed token group: {error}"))?;
    let body = parse_json(response, "managed token group update").await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "Failed to update managed token group.".to_string()
        } else {
            message
        });
    }
    Ok(())
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
        return Err(session_api_error(&body, "获取令牌密钥失败"));
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
        let message = session_api_error(&body, "获取模型列表失败");
        if is_invalid_session_error(&message) {
            return Err(message);
        }
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

/// Fetch the models actually reachable by the managed downstream token. The
/// management API's `/api/user/models` is only an entitlement list; it can lag
/// behind channel changes and must never be used as the chat model registry.
async fn downstream_models(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> Result<Vec<String>, String> {
    let response = client
        .get(format!("{}/v1/models", base.trim_end_matches('/')))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch reachable models: {error}"))?;
    let body = parse_json(response, "reachable model list").await?;
    if body.get("error").is_some() || body.get("success").and_then(Value::as_bool) == Some(false) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "Failed to fetch reachable models.".to_string()
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

/// Prefer the management token fetched while the fresh login cookie is still
/// available. Some new-api deployments put a short-lived dashboard JWT in the
/// login response; persisting that value makes the next account or key check
/// look like a logout once the JWT expires.
fn persisted_user_token(
    login_response_token: Option<String>,
    management_token: Option<String>,
) -> Option<String> {
    management_token.or(login_response_token)
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
    group: &str,
) -> Result<(String, Option<i64>), String> {
    let token = match find_token(client, base, session).await? {
        Some(token) => {
            if token.group.as_deref() != Some(group) {
                let token_id = token.id.ok_or_else(|| {
                    "Managed token has no id, so its group cannot be synchronized.".to_string()
                })?;
                update_token_group(client, base, session, token_id, group).await?;
            }
            token
        }
        None => match create_token(client, base, session, group).await? {
            Some(token) => token,
            None => find_token(client, base, session)
                .await?
                .ok_or_else(|| "令牌创建后仍未找到".to_string())?,
        },
    };
    if let Some(key) = token.key {
        return Ok((key, token.id));
    }
    let token_id = token.id.ok_or_else(|| "令牌未返回可用 ID".to_string())?;
    // The list response only ever returns a masked key, so a fresh reveal call
    // is otherwise required on *every* refresh. Reuse a previously-revealed
    // key for the same token id to avoid tripping the gateway's rate limit on
    // that endpoint (see `config::cached_newapi_token_key`).
    if let Some(cached) = config::cached_newapi_token_key(base, token_id) {
        return Ok((cached, Some(token_id)));
    }
    let key = fetch_token_key(client, base, session, token_id).await?;
    Ok((key, Some(token_id)))
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
    // A persisted legacy management token always wins over any stale keyring
    // entry. This lets legacy gateways continue working on systems where a
    // best-effort deletion of an older modern refresh credential is denied.
    let refresh_session = if user_token.is_none() {
        load_refresh_session(&base)?
    } else {
        None
    };
    Ok((
        base,
        NewApiSession {
            user_id,
            user_token,
            access_expires_at: None,
            refresh_session,
        },
    ))
}

async fn refresh_browser_session(
    client: &reqwest::Client,
    base: &str,
    session: &mut NewApiSession,
) -> Result<(), String> {
    let refresh_session = session
        .refresh_session
        .as_ref()
        .ok_or_else(|| SESSION_EXPIRED_MESSAGE.to_string())?;
    let cookie = refresh_cookie_header(&refresh_session.cookies)?;
    let mut request = client
        .post(format!("{base}/api/user/auth/refresh"))
        .header(COOKIE, cookie);
    if let Some(origin) = request_origin(base) {
        request = request.header(ORIGIN, origin);
    }
    if let Some(session_id) = refresh_session.session_id.as_deref() {
        request = request.header("X-Auth-Session", session_id);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("登录续期失败: {error}"))?;
    let rotated_cookies = refresh_cookies_from_headers(response.headers());
    let body = parse_json(response, "登录续期").await?;
    if !api_ok(&body) {
        return Err(session_api_error(&body, "登录续期失败"));
    }
    let data = body.get("data").unwrap_or(&body);
    let access_token =
        data_user_token(data).ok_or_else(|| "登录续期成功但未返回访问令牌".to_string())?;
    let access_expires_at = data_access_expires_at(data);
    let refresh_session = session
        .refresh_session
        .as_mut()
        .ok_or_else(|| SESSION_EXPIRED_MESSAGE.to_string())?;
    if rotated_cookies.len() == 1 {
        refresh_session.cookies = rotated_cookies;
    }
    if let Some(session_id) = data_session_id(data) {
        refresh_session.session_id = Some(session_id);
    }
    if save_refresh_session(base, refresh_session).is_err() {
        // The gateway has already rotated the cookie. Keeping the old
        // keychain value would make every subsequent check fail, so leave no
        // half-authenticated local session behind.
        clear_local_session();
        return Err(SESSION_EXPIRED_MESSAGE.to_string());
    }
    remember_access_token(base, &access_token, access_expires_at);
    session.user_token = Some(access_token);
    session.access_expires_at = access_expires_at;
    Ok(())
}

async fn authenticated_stored_session(
    client: &reqwest::Client,
) -> Result<(String, NewApiSession), String> {
    let (base, mut session) = stored_session()?;
    if session.refresh_session.is_some() {
        if let Some(token) = cached_access_token(&base) {
            session.user_token = Some(token);
        } else {
            let _refresh_guard = access_token_refresh_lock().lock().await;
            // Another Settings request may have refreshed and persisted the
            // rotating cookie while this request waited for the lock.
            if let Some(token) = cached_access_token(&base) {
                session.user_token = Some(token);
            } else {
                refresh_browser_session(client, &base, &mut session).await?;
            }
        }
    }
    if session
        .user_token
        .as_deref()
        .is_none_or(|token| token.is_empty())
    {
        return Err(SESSION_EXPIRED_MESSAGE.to_string());
    }
    Ok((base, session))
}

async fn refresh_downstream_token(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
    group: &str,
    model: &str,
) -> Result<String, String> {
    let (token, token_id) = get_or_create_token(client, base, session, group).await?;
    let executor_base_url = format!("{base}/v1");
    config::persist_newapi_executor_credentials(&executor_base_url, &token, token_id)?;
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
pub async fn newapi_logout(app: tauri::AppHandle) -> Result<(), String> {
    // Best-effort server-side revocation. Local credentials are removed even
    // when the gateway is temporarily unreachable, matching a user's explicit
    // logout request.
    let revoke = {
        // Do not let an in-flight cache miss rotate the cookie between the
        // snapshot and local cleanup. The browser call below is deliberately
        // outside this lock so logout remains responsive.
        let _refresh_guard = access_token_refresh_lock().lock().await;
        let revoke = stored_session()
            .ok()
            .and_then(|(base, session)| session.refresh_session.map(|refresh| (base, refresh)));
        clear_local_session();
        revoke
    };
    if let Some((base, refresh_session)) = revoke {
        if let Ok(cookie) = refresh_cookie_header(&refresh_session.cookies) {
            if let Ok(client) = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(20))
                .build()
            {
                let mut request = client
                    .post(format!("{base}/api/user/auth/logout"))
                    .header(COOKIE, cookie);
                if let Some(origin) = request_origin(&base) {
                    request = request.header(ORIGIN, origin);
                }
                if let Some(session_id) = refresh_session.session_id.as_deref() {
                    request = request.header("X-Auth-Session", session_id);
                }
                let _ = request.send().await;
            }
        }
    }
    let _ = crate::remote::unbind_image_assist_account(
        app.state::<crate::remote::RemoteAgentState>().inner(),
    )
    .await;
    Ok(())
}

/// Authenticate against new-api and return an executor config (base URL, model,
/// downstream token) for the signed-in user. The frontend persists these into
/// the executor settings so Chat routes through new-api.
#[tauri::command]
pub async fn newapi_login(
    app: tauri::AppHandle,
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

    let session = login(&client, &base, &username, &password).await?;
    // Save the long-lived session before minting or persisting downstream
    // executor credentials. If the OS credential store is unavailable, this
    // avoids leaving an executor key without a recoverable sign-in session.
    if let Err(error) = persist_session(&base, &username, &session) {
        forget_access_token(&base);
        return Err(error);
    }
    let account = clear_session_if_invalid(user_self(&client, &base, &session).await)?;
    let group = routing_group(&client, &base, &session, &account).await?;
    let entitled_models = user_models(&client, &base, &session)
        .await
        .unwrap_or_default();
    let requested_model = resolve_model_from_list(&entitled_models, &model);
    let executor_base_url = format!("{base}/v1");
    let token = clear_session_if_invalid(
        refresh_downstream_token(&client, &base, &session, &group, &requested_model).await,
    )?;
    let models = downstream_models(&client, &base, &token).await?;
    config::persist_managed_models(&models)?;
    let model = resolve_model_from_list(&models, &requested_model);

    // A successful managed login is also the explicit identity proof used by
    // Image Assist. Failure here does not invalidate normal model access; the
    // gateway will simply keep Image Assist unavailable until a retry works.
    let _ = crate::remote::bind_image_assist_account(
        app.state::<crate::remote::RemoteAgentState>().inner(),
    )
    .await;
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

/// Stash only non-secret account metadata in config.json. A modern gateway's
/// rotating refresh cookie is kept in the operating-system credential store;
/// the 15-minute access JWT remains in memory.
fn persist_session(base: &str, username: &str, session: &NewApiSession) -> Result<(), String> {
    let values: Vec<(&str, Value)> = vec![
        ("newapi_base_url", Value::String(base.to_string())),
        ("newapi_user_id", Value::Number(session.user_id.into())),
        ("newapi_username", Value::String(username.to_string())),
    ];
    if let Some(refresh_session) = &session.refresh_session {
        save_refresh_session(base, refresh_session)?;
        if let Err(error) = config::persist_newapi_session_metadata(&values) {
            // Avoid retaining an orphaned refresh secret when the matching
            // non-secret account metadata could not be committed.
            let _ = delete_refresh_session(base);
            return Err(error);
        }
        return Ok(());
    }
    // Legacy gateways do not issue a refresh session. Keep their established
    // token flow so existing self-hosted deployments retain compatibility.
    // A prior modern login to the same gateway may have left a credential in
    // the OS store. Removal is best-effort: legacy sessions do not depend on
    // the credential store, and `stored_session` prioritizes their durable
    // management token even when an OS policy denies deletion.
    let _ = delete_refresh_session(base);
    let mut legacy_values = values;
    if let Some(token) = session
        .user_token
        .as_deref()
        .filter(|token| !token.is_empty())
    {
        legacy_values.push(("newapi_access_token", Value::String(token.to_string())));
    }
    config::persist_values(&legacy_values)
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
        return Err(session_api_error(&body, "获取账户信息失败"));
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
        .map_err(|error| format!("获取后台分组失败: {error}"))?;
    let body = parse_json(response, "后台分组").await?;
    if !api_ok(&body) {
        return Err(session_api_error(&body, "获取后台分组失败"));
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
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    let (base, session) = clear_session_if_invalid(authenticated_stored_session(&client).await)?;

    let data = clear_session_if_invalid(user_self(&client, &base, &session).await)?;
    let string_field = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let account_group = account_group(&data)?;
    let groups = user_groups(&client, &base, &session).await;
    // What the token routes through, which is the account group only when the
    // user has not picked something else in Settings.
    let group = apply_group_preference(account_group.clone(), &groups);
    let entitled_models = user_models(&client, &base, &session)
        .await
        .unwrap_or_default();
    let requested_model = resolve_model_from_list(
        &entitled_models,
        &get_config_string("executor_model").unwrap_or_default(),
    );
    let token = clear_session_if_invalid(
        refresh_downstream_token(&client, &base, &session, &group, &requested_model).await,
    )?;
    let models = downstream_models(&client, &base, &token).await?;
    config::persist_managed_models(&models)?;
    let model = resolve_model_from_list(&models, &requested_model);
    let group_desc_of = |name: &str| {
        groups
            .get(name)
            .and_then(|entry| entry.get("desc"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let group_desc = group_desc_of(&group);
    let group_ratio = groups
        .get(group.as_str())
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
    // Privilege is a property of the account group a gateway assigned, never of
    // the routing group the user picked for themselves.
    let is_admin = user_is_admin_marker(
        role,
        role_text,
        &account_group,
        &group_desc_of(&account_group),
    );
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
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    let (base, session) = clear_session_if_invalid(authenticated_stored_session(&client).await)?;
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

/// Switch the group every managed request is routed through.
///
/// new-api gates `PUT /api/user/` behind `AdminAuth`, and even an admin cannot
/// edit a row whose role is not below their own, so an ordinary account can
/// never change its own `user.group` — that field is admin-assigned. What a
/// user *can* change is their token's group, which overrides the account group
/// for every request as long as it stays inside the account's usable groups.
/// So the pick is stored locally and pushed onto the managed token, and the
/// admin-only account update is attempted only for a group the token override
/// cannot reach.
#[tauri::command]
pub async fn newapi_update_group(group: String) -> Result<AccountState, String> {
    let group = group.trim().to_string();
    if group.is_empty() {
        return Err("分组不能为空".to_string());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端初始化失败: {error}"))?;
    let (base, session) = clear_session_if_invalid(authenticated_stored_session(&client).await)?;
    let account = clear_session_if_invalid(user_self(&client, &base, &session).await)?;
    let current_group = account
        .get("group")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if current_group == group {
        // The account group is the fallback new-api uses for a group-less
        // token, so returning to it means dropping the override entirely.
        config::remove_values(&[SELECTED_GROUP_KEY])?;
        return newapi_bootstrap().await;
    }
    let usable = user_groups(&client, &base, &session).await;
    if resolve_routing_group(&group, &usable).is_some() {
        config::persist_values(&[(SELECTED_GROUP_KEY, Value::String(group))])?;
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
    // Only reachable for a group outside the account's usable set, which a
    // token override cannot route to: the gateway rejects such a token at
    // request time. Changing the account group itself is the sole remaining
    // path, and new-api grants it to admins over lower-role accounts only.
    let response = with_session(client.put(format!("{base}/api/user/")), &session)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("更新后台分组失败: {error}"))?;
    let body = parse_json(response, "后台分组更新").await?;
    if !api_ok(&body) {
        let detail = session_api_error(&body, "更新后台分组失败");
        if is_invalid_session_error(&detail) {
            return Err(detail);
        }
        return Err(format!(
            "无法切换到分组「{group}」：当前账号没有该分组的使用权限，需要由管理员分配。({detail})"
        ));
    }
    config::remove_values(&[SELECTED_GROUP_KEY])?;
    newapi_bootstrap().await
}

async fn parse_usage_log_json(response: reqwest::Response) -> Result<Value, String> {
    parse_json(response, "调用明细").await
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
    let page = page.max(1);
    let page_size = page_size.clamp(1, 100);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端初始化失败: {error}"))?;
    let (base, session) = clear_session_if_invalid(authenticated_stored_session(&client).await)?;
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
        return clear_session_if_invalid(Err(session_api_error(&body, "获取调用明细失败")));
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
    if has_stored_session() {
        let (base, session) =
            clear_session_if_invalid(authenticated_stored_session(&client).await)?;
        let account = clear_session_if_invalid(user_self(&client, &base, &session).await)?;
        let group = routing_group(&client, &base, &session, &account).await?;
        let model =
            get_config_string("executor_model").unwrap_or_else(|| DEFAULT_MODEL.to_string());
        api_key = clear_session_if_invalid(
            refresh_downstream_token(&client, &base, &session, &group, &model).await,
        )?;
        let models = downstream_models(&client, &base, &api_key).await?;
        config::persist_managed_models(&models)?;
        return Ok(models);
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
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::{
        account_group, group_is_usable, is_invalid_session_error, login, parse_json_bytes,
        parse_refresh_cookie, persisted_user_token, refresh_cookie_header, resolve_routing_group,
        response_preview, session_api_error, token_candidate, token_group_update_payload,
        with_session, NewApiRefreshCookie, NewApiRefreshSession, NewApiSession,
        NEWAPI_REFRESH_COOKIE_NAME,
    };
    use serde_json::json;
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        thread,
        time::Duration,
    };

    fn read_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .expect("set request timeout");
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 1024];
        while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut chunk).expect("read request");
            assert!(read > 0, "request ended before headers");
            bytes.extend_from_slice(&chunk[..read]);
        }
        String::from_utf8(bytes).expect("UTF-8 request")
    }

    fn write_json_response(stream: &mut TcpStream, body: &str, set_cookie: bool) {
        let cookie = if set_cookie {
            "Set-Cookie: somniq-login=test-cookie; Path=/\r\n"
        } else {
            ""
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{cookie}Connection: close\r\n\r\n{body}",
            body.len(),
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
    }

    #[test]
    fn parses_json_with_utf8_bom() {
        let value = parse_json_bytes(b"\xef\xbb\xbf{\"success\":true}").expect("valid JSON");
        assert_eq!(value["success"], true);
    }

    #[test]
    fn previews_empty_and_truncates_large_bodies() {
        assert_eq!(response_preview(b"  \n\t"), "<empty>");

        let preview = response_preview("x".repeat(301).as_bytes());
        assert_eq!(preview.chars().count(), 301);
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn persists_management_token_over_short_lived_login_jwt() {
        assert_eq!(
            persisted_user_token(
                Some("short-lived-dashboard-jwt".to_string()),
                Some("long-lived-management-token".to_string()),
            ),
            Some("long-lived-management-token".to_string())
        );
    }

    #[test]
    fn keeps_login_token_when_management_token_cannot_be_fetched() {
        assert_eq!(
            persisted_user_token(Some("login-token".to_string()), None),
            Some("login-token".to_string())
        );
    }

    #[test]
    fn preserves_only_expected_http_only_refresh_cookie() {
        let cookie = parse_refresh_cookie(
            "new_api_refresh=opaque_value-123; Path=/; HttpOnly; Secure; SameSite=Strict",
        )
        .expect("HttpOnly cookie is a refresh credential");
        assert_eq!(cookie.name, NEWAPI_REFRESH_COOKIE_NAME);
        assert_eq!(cookie.value, "opaque_value-123");
        assert!(parse_refresh_cookie("theme=dark; Path=/; Secure").is_none());
        assert!(parse_refresh_cookie("legacy-session=opaque; Path=/; HttpOnly").is_none());
        assert!(parse_refresh_cookie("bad name=value; HttpOnly").is_none());

        let header = refresh_cookie_header(&[cookie]).expect("valid cookie header");
        assert_eq!(
            header.to_str().expect("header is valid"),
            "new_api_refresh=opaque_value-123"
        );
    }

    #[test]
    fn session_auth_codes_expire_a_session_but_origin_errors_do_not() {
        let expired = session_api_error(
            &json!({
                "success": false,
                "code": "AUTH_SESSION_REVOKED",
                "message": "Unauthorized"
            }),
            "账户请求失败",
        );
        assert_eq!(expired, "AUTH_SESSION_REVOKED");
        assert!(is_invalid_session_error(&expired));

        let origin_error = session_api_error(
            &json!({
                "success": false,
                "code": "AUTH_ORIGIN_FORBIDDEN",
                "message": "Unauthorized"
            }),
            "账户请求失败",
        );
        assert!(!is_invalid_session_error(&origin_error));
    }

    #[test]
    fn modern_sessions_keep_the_newapi_user_header() {
        let session = NewApiSession {
            user_id: 17,
            user_token: Some("short-lived-access".to_string()),
            access_expires_at: None,
            refresh_session: Some(NewApiRefreshSession {
                cookies: vec![NewApiRefreshCookie {
                    name: NEWAPI_REFRESH_COOKIE_NAME.to_string(),
                    value: "opaque-refresh".to_string(),
                }],
                session_id: Some("session-123".to_string()),
            }),
        };
        let request = with_session(
            reqwest::Client::new().get("https://gateway.example.test/api/user/self"),
            &session,
        )
        .build()
        .expect("build request");
        assert_eq!(
            request.headers()["New-Api-User"]
                .to_str()
                .expect("header is valid"),
            "17"
        );
        assert_eq!(
            request.headers()["Authorization"]
                .to_str()
                .expect("header is valid"),
            "Bearer short-lived-access"
        );
    }

    #[test]
    fn login_keeps_a_modern_refresh_session_out_of_the_legacy_token_flow() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock new-api");
        let address = listener.local_addr().expect("mock address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept login");
            let request = read_request(&mut stream);
            let body = r#"{"success":true,"data":{"id":17,"token":"short-lived-access","access_expires_at":2000000000,"session":{"sid":"session-123"}}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nSet-Cookie: new_api_refresh=opaque-refresh; Path=/; HttpOnly; Secure; SameSite=Strict\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
            request
        });

        let client = reqwest::Client::builder()
            .cookie_store(true)
            .build()
            .expect("build client");
        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        let session = runtime
            .block_on(login(
                &client,
                &format!("http://{address}"),
                "alice",
                "password",
            ))
            .expect("login succeeds");

        assert!(server
            .join()
            .expect("mock server finishes")
            .starts_with("POST /api/user/login"));
        let refresh = session.refresh_session.expect("refresh session retained");
        assert_eq!(refresh.cookies[0].name, NEWAPI_REFRESH_COOKIE_NAME);
        assert_eq!(refresh.session_id.as_deref(), Some("session-123"));
        assert_eq!(session.user_token.as_deref(), Some("short-lived-access"));
    }

    #[test]
    fn login_replaces_a_dashboard_jwt_with_the_management_token() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock new-api");
        let address = listener.local_addr().expect("mock address");
        let server = thread::spawn(move || {
            let (mut login_stream, _) = listener.accept().expect("accept login");
            let login_request = read_request(&mut login_stream);
            write_json_response(
                &mut login_stream,
                r#"{"success":true,"data":{"id":17,"token":"short-lived-dashboard-jwt"}}"#,
                true,
            );

            let (mut token_stream, _) = listener.accept().expect("accept management token");
            let token_request = read_request(&mut token_stream);
            write_json_response(
                &mut token_stream,
                r#"{"success":true,"data":{"token":"long-lived-management-token"}}"#,
                false,
            );
            (login_request, token_request)
        });

        let client = reqwest::Client::builder()
            .cookie_store(true)
            .build()
            .expect("build client");
        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        let session = runtime
            .block_on(login(
                &client,
                &format!("http://{address}"),
                "alice",
                "password",
            ))
            .expect("login succeeds");
        let (login_request, token_request) = server.join().expect("mock server finishes");

        assert!(login_request.starts_with("POST /api/user/login HTTP/1.1"));
        let token_request = token_request.to_ascii_lowercase();
        assert!(token_request.starts_with("get /api/user/token http/1.1"));
        assert!(token_request.contains("new-api-user: 17"));
        assert!(token_request.contains("authorization: bearer short-lived-dashboard-jwt"));
        assert!(token_request.contains("cookie: somniq-login=test-cookie"));
        assert_eq!(
            session.user_token.as_deref(),
            Some("long-lived-management-token")
        );
    }

    #[test]
    fn login_uses_legacy_flow_for_an_unrelated_http_only_cookie() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock new-api");
        let address = listener.local_addr().expect("mock address");
        let server = thread::spawn(move || {
            let (mut login_stream, _) = listener.accept().expect("accept login");
            let login_request = read_request(&mut login_stream);
            let body = r#"{"success":true,"data":{"id":17,"token":"short-lived-dashboard-jwt","session":{"sid":"session-123"}}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nSet-Cookie: legacy-dashboard=opaque; Path=/; HttpOnly\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            );
            login_stream
                .write_all(response.as_bytes())
                .expect("write login response");

            let (mut token_stream, _) = listener.accept().expect("accept management token");
            let token_request = read_request(&mut token_stream);
            write_json_response(
                &mut token_stream,
                r#"{"success":true,"data":{"token":"long-lived-management-token"}}"#,
                false,
            );
            (login_request, token_request)
        });

        let client = reqwest::Client::builder()
            .cookie_store(true)
            .build()
            .expect("build client");
        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        let session = runtime
            .block_on(login(
                &client,
                &format!("http://{address}"),
                "alice",
                "password",
            ))
            .expect("login succeeds");
        let (login_request, token_request) = server.join().expect("mock server finishes");

        assert!(login_request.starts_with("POST /api/user/login HTTP/1.1"));
        assert!(token_request.starts_with("GET /api/user/token HTTP/1.1"));
        assert!(session.refresh_session.is_none());
        assert_eq!(
            session.user_token.as_deref(),
            Some("long-lived-management-token")
        );
    }

    #[test]
    fn managed_token_group_is_read_from_the_gateway_listing() {
        let candidate = token_candidate(&json!({
            "id": 9,
            "name": "somniq-desktop",
            "group": "default",
        }))
        .expect("token candidate");

        assert_eq!(candidate.id, Some(9));
        assert_eq!(candidate.group.as_deref(), Some("default"));
    }

    #[test]
    fn token_group_update_preserves_every_mutable_token_field() {
        let payload = token_group_update_payload(
            &json!({
                "id": 9,
                "name": "somniq-desktop",
                "status": 1,
                "expired_time": -1,
                "remain_quota": 1234,
                "unlimited_quota": true,
                "model_limits_enabled": false,
                "model_limits": "",
                "allow_ips": "10.0.0.0/8",
                "group": "千研",
                "cross_group_retry": true,
            }),
            "default",
        )
        .expect("payload");

        assert_eq!(payload["group"], "default");
        assert_eq!(payload["name"], "somniq-desktop");
        assert_eq!(payload["remain_quota"], 1234);
        assert_eq!(payload["allow_ips"], "10.0.0.0/8");
        assert_eq!(payload["cross_group_retry"], true);
    }

    #[test]
    fn account_group_rejects_empty_values() {
        assert_eq!(
            account_group(&json!({ "group": " default " })).as_deref(),
            Ok("default")
        );
        assert!(account_group(&json!({ "group": " " })).is_err());
    }

    #[test]
    fn routing_group_keeps_a_pick_the_account_can_still_use() {
        let usable = json!({
            "default": { "ratio": 1, "desc": "标准" },
            "千研": { "ratio": 1.5, "desc": "高速" },
        });

        assert!(group_is_usable(&usable, "千研"));
        assert_eq!(
            resolve_routing_group("千研", &usable).as_deref(),
            Some("千研")
        );
    }

    #[test]
    fn routing_group_drops_a_pick_the_gateway_no_longer_grants() {
        // Losing access upstream must fall back to the account group instead of
        // failing every later request with "无权访问 X 分组".
        let usable = json!({ "default": { "ratio": 1, "desc": "标准" } });

        assert!(!group_is_usable(&usable, "千研"));
        assert_eq!(resolve_routing_group("千研", &usable), None);
    }

    #[test]
    fn routing_group_survives_an_unanswered_group_lookup() {
        // `user_groups` is best-effort; a transient failure must not silently
        // reset the user's routing choice.
        assert_eq!(
            resolve_routing_group("千研", &json!(null)).as_deref(),
            Some("千研")
        );
        assert_eq!(
            resolve_routing_group("千研", &json!({})).as_deref(),
            Some("千研")
        );
    }
}
