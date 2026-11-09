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

use crate::config;
pub(crate) mod payments;
pub(crate) mod pricing;
mod refresh_store;
use rand::{distributions::Alphanumeric, Rng};
use reqwest::header::{HeaderMap, HeaderValue, COOKIE, ORIGIN, SET_COOKIE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Token name we create/look for under the user's account.
const TOKEN_NAME: &str = "somniq-desktop";
/// Release builds use the shared candidate endpoint. A build-time override is
/// accepted only when it is HTTPS (or a loopback HTTP development server).
const MANAGED_NEWAPI_CONFIG: &str = include_str!("../../managed-newapi.json");
/// Default executor model when the caller doesn't pin one. Must match a model
/// the new-api MiniMax channel exposes.
const DEFAULT_MODEL: &str = "MiniMax-M3";
#[cfg(not(test))]
pub(crate) const NEWAPI_REFRESH_KEYRING_SERVICE: &str = "SomniQ Studio New API Sessions";
/// Routing group written onto the managed token. Empty means "the account's
/// group", which new-api resolves on every request: membership tiers are user
/// groups that subscriptions switch, so an upgrade or an expiry applies to the
/// very next call. A token pinned to a named group would keep routing through
/// it until the desktop happened to refresh, and is refused outright once that
/// group stops being usable.
const MANAGED_TOKEN_GROUP: &str = "";
/// Group pick persisted by releases that let Settings choose a routing group.
/// Only read to delete it: the tier now decides the group.
const LEGACY_SELECTED_GROUP_KEY: &str = "newapi_group";
/// Account group the last bootstrap reported. Membership tiers are groups, and
/// the features this desktop gates itself (see `membership`) read it offline.
const ACCOUNT_GROUP_KEY: &str = "newapi_account_group";
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

struct CachedRefreshSession {
    session: NewApiRefreshSession,
    persist_retry_at: Option<Instant>,
}

static ACCESS_TOKEN_CACHE: OnceLock<Mutex<HashMap<String, CachedAccessToken>>> = OnceLock::new();
/// The refresh cookie is loaded from the OS credential store once per app
/// process and then reused.  The frontend performs an auth check and an
/// account projection during startup; without this cache both paths would
/// independently ask macOS to authorize the same Keychain item.
static REFRESH_SESSION_CACHE: OnceLock<Mutex<HashMap<String, CachedRefreshSession>>> =
    OnceLock::new();
/// A rotated refresh cookie is single-use on current new-api gateways. The
/// Settings screen can ask for the account, groups, and models concurrently on
/// startup, so serialize the cache-miss → refresh → persist sequence rather
/// than letting sibling calls invalidate each other's cookie.
static ACCESS_TOKEN_REFRESH_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// The key itself is deliberately absent: it stays in the backend (see
/// `managed_key`) and never passes through the webview.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiLogin {
    /// OpenAI-compatible base URL for the executor (`<base>/v1`).
    pub base_url: String,
    pub model: String,
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

fn secure_base(base: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(base.trim())
        .map_err(|_| "请配置有效的 HTTPS 账号服务器地址".to_string())?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("账号服务器必须使用 HTTPS（本机回环地址除外）".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

pub(crate) fn configured_managed_base() -> Result<String, String> {
    let fallback: Value = serde_json::from_str(MANAGED_NEWAPI_CONFIG)
        .map_err(|_| "托管账号服务器构建配置无效".to_string())?;
    let candidate = option_env!("VITE_MANAGED_NEWAPI_URL")
        .or_else(|| fallback.get("baseUrl").and_then(Value::as_str))
        .ok_or_else(|| "托管账号服务器未配置".to_string())?;
    let base = secure_base(candidate)?;
    if !cfg!(debug_assertions) && !base.starts_with("https://") {
        return Err("发布版托管账号服务器必须使用 HTTPS".to_string());
    }
    Ok(base)
}

fn approved_managed_base(base: &str) -> Result<String, String> {
    let base = if base.trim().is_empty() {
        configured_managed_base()
    } else {
        secure_base(base)
    }?;
    let official = configured_managed_base()?;
    let loopback = reqwest::Url::parse(&base)
        .ok()
        .and_then(|url| url.host_str().map(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]")))
        .unwrap_or(false);
    if base == official || (cfg!(debug_assertions) && loopback) {
        Ok(base)
    } else {
        Err("托管账号只能连接此构建指定的官方 HTTPS 服务器".to_string())
    }
}

pub(crate) fn is_approved_managed_base(base: &str) -> bool {
    approved_managed_base(base).is_ok()
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

/// Account calls identify the release: New API records the User-Agent on the
/// login session and its audit log, and the edge can refuse an outdated client.
fn account_http_client_builder(timeout: Duration) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(runtime::client_user_agent())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
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
    if let Some(error) =
        runtime::client_outdated_error(status.as_u16(), &String::from_utf8_lossy(&bytes))
    {
        return Err(error);
    }

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

#[derive(Clone)]
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

fn refresh_session_cache() -> &'static Mutex<HashMap<String, CachedRefreshSession>> {
    REFRESH_SESSION_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_refresh_session(base: &str) -> Option<NewApiRefreshSession> {
    refresh_session_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(base).map(|entry| entry.session.clone()))
}

fn remember_refresh_session(base: &str, session: &NewApiRefreshSession) {
    if let Ok(mut cache) = refresh_session_cache().lock() {
        cache.insert(
            base.to_string(),
            CachedRefreshSession {
                session: session.clone(),
                persist_retry_at: None,
            },
        );
    }
}

/// Rotation has already happened on the gateway. Retain its newest cookie even
/// if the OS store is temporarily unavailable, and retry persistence later.
fn persist_rotated_refresh_session(base: &str, session: &NewApiRefreshSession) {
    remember_refresh_session(base, session);
    if let Err(error) = save_refresh_session(base, session) {
        if let Ok(mut cache) = refresh_session_cache().lock() {
            if let Some(entry) = cache.get_mut(base) {
                entry.persist_retry_at = Some(Instant::now() + Duration::from_secs(60));
            }
        }
        eprintln!("SomniQ kept the renewed login in memory and will retry saving it: {error}");
    }
}

/// Called only under the refresh lock so an older write cannot overwrite a
/// concurrently rotated cookie. Failed writes are throttled to once a minute.
fn retry_refresh_session_persistence(base: &str) {
    let pending = refresh_session_cache().lock().ok().and_then(|cache| {
        let entry = cache.get(base)?;
        entry.persist_retry_at.filter(|at| *at <= Instant::now())?;
        Some(entry.session.clone())
    });
    if let Some(session) = pending {
        persist_rotated_refresh_session(base, &session);
    }
}

fn forget_refresh_session(base: &str) {
    if let Ok(mut cache) = refresh_session_cache().lock() {
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

fn save_refresh_session(base: &str, refresh_session: &NewApiRefreshSession) -> Result<(), String> {
    let bytes = serde_json::to_vec(refresh_session)
        .map_err(|error| format!("无法编码登录续期凭据: {error}"))?;
    refresh_store::write(&newapi_refresh_secret_account(base), &bytes)?;
    remember_refresh_session(base, refresh_session);
    Ok(())
}

fn load_refresh_session(base: &str) -> Result<Option<NewApiRefreshSession>, String> {
    if let Some(refresh_session) = cached_refresh_session(base) {
        return Ok(Some(refresh_session));
    }
    let Some(secret) = refresh_store::read(&newapi_refresh_secret_account(base))? else {
        return Ok(None);
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
    remember_refresh_session(base, &refresh_session);
    Ok(Some(refresh_session))
}

fn delete_refresh_session(base: &str) -> Result<(), String> {
    forget_refresh_session(base);
    refresh_store::delete(&newapi_refresh_secret_account(base))
}

/// One-time retirement of the previous public HTTP managed gateway. The
/// refresh cookie is origin-bound and must never be copied to a new hostname.
pub(crate) fn retire_legacy_managed_session() -> Result<bool, String> {
    let retired = config::retire_legacy_managed_http()?;
    if retired {
        forget_access_token(config::LEGACY_MANAGED_NEWAPI_BASE_URL);
        let _ = delete_refresh_session(config::LEGACY_MANAGED_NEWAPI_BASE_URL);
    }
    Ok(retired)
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

const SESSION_EXPIRED_MESSAGE: &str = "Login expired. Please sign in again.";
const MODEL_REQUEST_ERROR_PREFIX: &str = "Model connection failed: ";

fn is_invalid_session_error(message: &str) -> bool {
    if message.starts_with(MODEL_REQUEST_ERROR_PREFIX) {
        return false;
    }
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
        .is_some_and(is_approved_managed_base);
    let has_user = obj.get("newapi_user_id").and_then(value_as_i64).is_some();
    has_base && has_user
}

/// Group of the signed-in managed account as of the last bootstrap: `None` when
/// this desktop has no managed account, `Some("")` until a bootstrap reports one.
pub(crate) fn managed_account_group() -> Option<String> {
    has_stored_session().then(|| get_config_string(ACCOUNT_GROUP_KEY).unwrap_or_default())
}

/// Sign in and return the authenticated user/session values needed by new-api.
async fn login(
    client: &reqwest::Client,
    base: &str,
    username: &str,
    password: &str,
    two_factor_code: Option<&str>,
) -> Result<NewApiSession, String> {
    let response = client
        .post(format!("{base}/api/user/login"))
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|error| format!("无法连接服务器: {error}"))?;
    let mut refresh_cookies = refresh_cookies_from_headers(response.headers());
    let mut body = parse_json(response, "登录").await?;
    if !api_ok(&body) {
        let message = api_message(&body);
        return Err(if message.is_empty() {
            "账号或密码错误".to_string()
        } else {
            message
        });
    }
    let data = body.get("data").ok_or_else(|| "登录成功但未返回用户信息".to_string())?;
    let requires_verification = ["require_2fa", "require2fa", "require_verification"]
        .iter().any(|key| status_bool(data, key, false));
    if requires_verification {
        let code = two_factor_code.map(str::trim).filter(|code| !code.is_empty())
            .ok_or_else(|| "AUTH_TWO_FACTOR_REQUIRED".to_string())?;
        let mut payload = serde_json::json!({ "code": code });
        if let Some(flow_token) = data.get("flow_token").and_then(Value::as_str) {
            payload["flow_token"] = Value::String(flow_token.to_string());
            payload["method"] = Value::String("2fa".to_string());
        }
        // Reuse the password request's cookie jar for legacy 2FA gateways.
        // Modern gateways bind this request through the returned flow token.
        let mut request = client.post(format!("{base}/api/user/login/2fa")).json(&payload);
        if let Some(origin) = request_origin(base) {
            request = request.header(ORIGIN, origin);
        }
        let response = request.send().await
            .map_err(|error| format!("两步验证失败: {error}"))?;
        refresh_cookies = refresh_cookies_from_headers(response.headers());
        body = parse_json(response, "两步验证").await?;
        if !api_ok(&body) {
            return Err(session_api_error(&body, "两步验证码错误或已过期"));
        }
    }
    let data = body.get("data").ok_or_else(|| "登录成功但未返回用户信息".to_string())?;
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
) -> Result<Option<TokenCandidate>, String> {
    let generated_key = generate_token_key();
    let response = with_session(client.post(format!("{base}/api/token/")), session)
        .json(&managed_token_create_payload(&generated_key))
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
            group: None,
        });
    if candidate.key.is_none() {
        candidate.key = normalize_downstream_key(&generated_key);
    }
    Ok(Some(candidate))
}

fn managed_token_create_payload(key: &str) -> Value {
    serde_json::json!({
        "name": TOKEN_NAME,
        "key": key,
        "amount": 0,
        "expire_time": 0,
        "expired_time": -1,            // never expires
        "remain_quota": 0,
        "unlimited_quota": true,       // bounded by the user's own quota
        "model_limits_enabled": false,
        "model_limits": "",
        "group": MANAGED_TOKEN_GROUP,
    })
}

/// A managed token created by an older release carries the group it was pinned
/// to; it must be cleared so routing follows the account's membership tier.
/// `None` is either an already-unpinned token or a bare id whose group the
/// gateway did not report, and neither warrants a write.
fn token_needs_unpinning(token: &TokenCandidate) -> bool {
    token.group.is_some()
}

/// Drop the Settings group pick older releases stored; nothing reads it now.
fn forget_legacy_group_pick() {
    if get_config_string(LEGACY_SELECTED_GROUP_KEY).is_some() {
        let _ = config::remove_values(&[LEGACY_SELECTED_GROUP_KEY]);
    }
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
        return Err(session_api_error(&body, "Failed to read managed token."));
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
        return Err(session_api_error(&body, "Failed to update managed token group."));
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
            if !model.is_empty() && !is_tool_service_model(model) {
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
                    if !model.is_empty() && !is_tool_service_model(model) {
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

fn is_tool_service_model(model: &str) -> bool {
    matches!(model, "deepseek-search" | "deepseek-fetch" | "scopus-search")
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
    let executor_base = format!("{}/v1", base.trim_end_matches('/'));
    let mut token = token.to_string();
    let mut recovered = false;
    loop {
        let response = client
            .get(format!("{executor_base}/models"))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|error| format!("{MODEL_REQUEST_ERROR_PREFIX}{error}"))?;
        let status = response.status();
        let body = parse_json(response, "reachable model list").await;
        if status == reqwest::StatusCode::UNAUTHORIZED && !recovered {
            recovered = true;
            if let Some(replacement) =
                replace_rejected_model_key(executor_base.clone(), token.clone()).await
            {
                token = replacement;
                continue;
            }
        }
        let body = body.map_err(|error| format!("{MODEL_REQUEST_ERROR_PREFIX}{error}"))?;
        if !status.is_success()
            || body.get("error").is_some()
            || body.get("success").and_then(Value::as_bool) == Some(false)
        {
            let message = api_message(&body);
            return Err(format!(
                "{MODEL_REQUEST_ERROR_PREFIX}{}",
                if message.is_empty() {
                    "Failed to fetch reachable models."
                } else {
                    &message
                }
            ));
        }
        let mut models = Vec::new();
        if let Some(data) = body.get("data") {
            collect_model_ids(data, &mut models);
        }
        models.sort();
        models.dedup();
        return Ok(models);
    }
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

/// `reuse_stored_key` is false only when the gateway has just rejected the
/// stored key, so the reveal below must ask the gateway again.
async fn get_or_create_token(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
    reuse_stored_key: bool,
) -> Result<(String, Option<i64>), String> {
    let token = match find_token(client, base, session).await? {
        Some(token) => {
            if token_needs_unpinning(&token) {
                let token_id = token.id.ok_or_else(|| {
                    "Managed token has no id, so its group cannot be synchronized.".to_string()
                })?;
                update_token_group(client, base, session, token_id, MANAGED_TOKEN_GROUP).await?;
            }
            token
        }
        None => match create_token(client, base, session).await? {
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
    if let Some(cached) = reuse_stored_key
        .then(|| config::cached_newapi_token_key(base, token_id))
        .flatten()
    {
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
    let base = approved_managed_base(&base)?;
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
        // Only a rejection of the long-lived refresh credential confirms that
        // sign-in has ended. An ordinary access-token rejection can be renewed.
        return clear_session_if_invalid(Err(session_api_error(&body, "登录续期失败")));
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
    persist_rotated_refresh_session(base, refresh_session);
    remember_access_token(base, &access_token, access_expires_at);
    session.user_token = Some(access_token);
    session.access_expires_at = access_expires_at;
    Ok(())
}

/// What the remote gateway needs to verify which account owns this desktop.
///
/// Deliberately narrow: the caller receives the two values the gateway checks
/// against new-api's `/v1/user/self` and never the rotating refresh cookie,
/// which must not leave the OS credential store.
pub(crate) struct AccountOwnershipCredential {
    /// The account service that issued `access_token`.
    pub(crate) base_url: String,
    pub(crate) user_id: i64,
    pub(crate) access_token: String,
}

/// Returns a currently valid account credential, refreshing it if needed.
///
/// `Ok(None)` means this desktop simply is not signed in — an ordinary state
/// that callers should treat as "nothing to announce", not as a failure.
pub(crate) async fn account_ownership_credential(
) -> Result<Option<AccountOwnershipCredential>, String> {
    if stored_session().is_err() {
        return Ok(None);
    }
    let client = account_http_client_builder(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    let (base_url, session) = authenticated_stored_session(&client).await?;
    let access_token = session
        .user_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| SESSION_EXPIRED_MESSAGE.to_string())?;
    Ok(Some(AccountOwnershipCredential {
        base_url,
        user_id: session.user_id,
        access_token,
    }))
}

/// Base URL of the signed-in account, from config alone: no keychain read and
/// no network. A session that can no longer be renewed surfaces when it is used.
pub(crate) fn signed_in_base_url() -> Option<String> {
    let obj = config::load_object();
    obj.get("newapi_user_id").and_then(value_as_i64)?;
    let base = obj
        .get("newapi_base_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    approved_managed_base(base).ok()
}

/// The signed-in account as literature adapters see it: the research gateway's
/// school Scopus route identifies the caller with it.
pub(crate) struct ResearchAccount;

fn research_api_credential(
    base: &str,
    obj: &serde_json::Map<String, Value>,
) -> Option<tools::research_account::ResearchApiCredential> {
    let executor_base = config::managed_executor_base_url(obj)?;
    let expected = format!("{}/v1", base.trim_end_matches('/'));
    if executor_base.trim_end_matches('/') != expected {
        return None;
    }
    Some(tools::research_account::ResearchApiCredential {
        issuer: base.to_string(),
        api_key: config::managed_executor_api_key(obj)?,
    })
}

impl tools::research_account::ResearchAccountProvider for ResearchAccount {
    fn session_issuer(&self) -> Option<String> {
        signed_in_base_url()
    }

    fn api_credential(
        &self,
    ) -> Result<Option<tools::research_account::ResearchApiCredential>, String> {
        let Some(base) = signed_in_base_url() else {
            return Ok(None);
        };
        // load_object overlays the OS-held downstream API key. The dashboard
        // access token and refresh cookie are never used by paid tool routes.
        Ok(research_api_credential(&base, &config::load_object()))
    }

    fn credential(
        &self,
    ) -> Result<Option<tools::research_account::ResearchAccountCredential>, String> {
        // Adapters block, on a runtime's blocking pool or a plain thread, while
        // renewal is async. A private current-thread runtime on its own thread
        // serves both without ever nesting one `block_on` inside another.
        let credential = std::thread::spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| format!("账号凭证查询失败: {error}"))?
                .block_on(account_ownership_credential())
        })
        .join()
        .map_err(|_| "账号凭证查询失败".to_string())??;
        Ok(credential.map(|credential| tools::research_account::ResearchAccountCredential {
            issuer: credential.base_url,
            user_id: credential.user_id,
            access_token: credential.access_token,
        }))
    }
}

async fn authenticated_stored_session(
    client: &reqwest::Client,
) -> Result<(String, NewApiSession), String> {
    let _refresh_guard = access_token_refresh_lock().lock().await;
    // Load after taking the lock: a sibling may have rotated the single-use
    // cookie, or the user may have signed out while this request was waiting.
    let (base, mut session) = stored_session()?;
    retry_refresh_session_persistence(&base);
    if session.refresh_session.is_some() {
        if let Some(token) = cached_access_token(&base) {
            session.user_token = Some(token);
        } else {
            refresh_browser_session(client, &base, &mut session).await?;
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

async fn renew_rejected_session(
    client: &reqwest::Client,
    base: &str,
    rejected: &NewApiSession,
) -> Result<NewApiSession, String> {
    let _refresh_guard = access_token_refresh_lock().lock().await;
    let (current_base, mut current) = stored_session()?;
    if current_base != base
        || current.user_id != rejected.user_id
        || current.refresh_session.is_none()
    {
        return Err("Account sign-in changed; retry the request.".to_string());
    }
    retry_refresh_session_persistence(base);
    if let Some(token) = cached_access_token(base) {
        if Some(token.as_str()) != rejected.user_token.as_deref() {
            current.user_token = Some(token);
            return Ok(current);
        }
    }
    forget_access_token(base);
    refresh_browser_session(client, base, &mut current).await?;
    Ok(current)
}

/// Retry an account operation once after renewing its short-lived access
/// token. A failure of that operation alone never revokes a modern login.
/// Legacy gateways have no refresh credential and retain their prior behavior.
async fn with_authenticated_session<T, F, Fut>(
    client: &reqwest::Client,
    mut request: F,
) -> Result<T, String>
where
    F: FnMut(reqwest::Client, String, NewApiSession) -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let (base, session) = authenticated_stored_session(client).await?;
    let result = request(client.clone(), base.clone(), session.clone()).await;
    match result {
        Err(error) if session.refresh_session.is_some() && is_invalid_session_error(&error) => {
            let renewed = renew_rejected_session(client, &base, &session).await?;
            request(client.clone(), base, renewed).await
        }
        other if session.refresh_session.is_none() => clear_session_if_invalid(other),
        other => other,
    }
}

async fn refresh_downstream_token(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
    model: &str,
) -> Result<String, String> {
    forget_legacy_group_pick();
    let (token, token_id) = get_or_create_token(client, base, session, true).await?;
    let executor_base_url = format!("{base}/v1");
    config::persist_newapi_executor_credentials(base, &token, token_id)?;
    let model = model.trim();
    if !model.is_empty() {
        let _ = config::record_verified_executor("openai", model, Some(&executor_base_url), &token);
    }
    let _ = config::managed_config_object()?;
    Ok(token)
}

/// A failed re-fetch is not retried sooner than this, so a broken session cannot
/// turn every rejected request into another call to the rate-limited reveal.
const MODEL_KEY_RECOVERY_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Default)]
struct ModelKeyRecovery {
    last_failure: Option<std::time::Instant>,
    /// Keys this process has already replaced; a request still carrying one
    /// takes the current key without asking the gateway again.
    replaced: Vec<String>,
}

fn model_key_recovery() -> &'static tokio::sync::Mutex<ModelKeyRecovery> {
    static RECOVERY: OnceLock<tokio::sync::Mutex<ModelKeyRecovery>> = OnceLock::new();
    RECOVERY.get_or_init(|| tokio::sync::Mutex::new(ModelKeyRecovery::default()))
}

/// Replace the account model key after the gateway answered 401 for it
/// (registered as the executor's credential-recovery hook). Like Codex's
/// unauthorized recovery: take a key another request already replaced it with,
/// else re-fetch it once with the signed-in session; otherwise give up and let
/// the 401 surface. Keys that are not the account key are never touched.
pub(crate) async fn replace_rejected_model_key(base_url: String, rejected_key: String) -> Option<String> {
    let obj = config::load_object();
    let managed_base = config::managed_executor_base_url(&obj)?;
    let same_endpoint = |url: &str| url.trim().trim_end_matches('/').to_ascii_lowercase();
    if same_endpoint(&managed_base) != same_endpoint(&base_url) {
        return None;
    }
    let mut recovery = model_key_recovery().lock().await;
    let current = config::managed_executor_api_key(&config::load_object())?;
    if current != rejected_key {
        return recovery.replaced.contains(&rejected_key).then_some(current);
    }
    if recovery
        .last_failure
        .is_some_and(|at| at.elapsed() < MODEL_KEY_RECOVERY_BACKOFF)
    {
        return None;
    }
    let fetched = async {
        let client = account_http_client_builder(Duration::from_secs(20))
            .build()
            .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
        with_authenticated_session(&client, |client, base, session| async move {
            let (key, token_id) = get_or_create_token(&client, &base, &session, false).await?;
            config::persist_newapi_executor_credentials(&base, &key, token_id)?;
            Ok(key)
        })
        .await
    }
    .await;
    match fetched {
        Ok(key) if key != rejected_key => {
            recovery.last_failure = None;
            recovery.replaced.push(rejected_key);
            Some(key)
        }
        Ok(_) => {
            recovery.last_failure = Some(std::time::Instant::now());
            None
        }
        Err(error) => {
            eprintln!("SomniQ could not replace the rejected account model key: {error}");
            recovery.last_failure = Some(std::time::Instant::now());
            None
        }
    }
}

#[tauri::command]
pub async fn newapi_auth_status(base_url: String) -> Result<NewApiAuthStatus, String> {
    let base = approved_managed_base(&base_url)?;
    let client = account_http_client_builder(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    fetch_auth_status(&client, &base).await
}

#[tauri::command]
pub async fn newapi_logout() -> Result<(), String> {
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
            if let Ok(client) = account_http_client_builder(Duration::from_secs(20))
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
    Ok(())
}

/// Authenticate against new-api and return the executor endpoint and model for
/// the signed-in user. The frontend persists these into the executor settings
/// so Chat routes through new-api; the downstream key is stored here.
#[tauri::command]
pub async fn newapi_login(
    base_url: String,
    model: String,
    username: String,
    password: String,
    two_factor_code: Option<String>,
) -> Result<NewApiLogin, String> {
    let base = approved_managed_base(&base_url)?;
    let username = username.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err("请输入账号和密码".to_string());
    }
    let client = account_http_client_builder(Duration::from_secs(30))
        .cookie_store(true)
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;

    let session = login(&client, &base, &username, &password, two_factor_code.as_deref()).await?;
    // Save the long-lived session before minting or persisting downstream
    // executor credentials. If the OS credential store is unavailable, this
    // avoids leaving an executor key without a recoverable sign-in session.
    {
        let _refresh_guard = access_token_refresh_lock().lock().await;
        if let Err(error) = persist_session(&base, &username, &session) {
            forget_access_token(&base);
            return Err(error);
        }
    }
    let entitled_models = user_models(&client, &base, &session)
        .await
        .unwrap_or_default();
    let requested_model = resolve_model_from_list(&entitled_models, &model);
    let executor_base_url = format!("{base}/v1");
    let models = with_authenticated_session(&client, |client, base, session| {
        let model = requested_model.clone();
        async move {
            let token = refresh_downstream_token(&client, &base, &session, &model).await?;
            downstream_models(&client, &base, &token).await
        }
    })
    .await?;
    config::persist_managed_models(&models)?;
    let model = resolve_model_from_list(&models, &requested_model);

    Ok(NewApiLogin {
        base_url: executor_base_url,
        model,
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
    let base = approved_managed_base(&input.base_url)?;
    let email = input.email.trim().to_string();
    if email.is_empty() {
        return Err("请先输入邮箱".to_string());
    }
    let turnstile = optional_payload_value(input.turnstile).unwrap_or_default();
    let client = account_http_client_builder(Duration::from_secs(30))
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
    let base = approved_managed_base(&input.base_url)?;
    let username = input.username.trim().to_string();
    let password = input.password;
    if username.is_empty() || password.is_empty() {
        return Err("请输入账号和密码".to_string());
    }
    let password_len = password.chars().count();
    if !(8..=20).contains(&password_len) {
        return Err("密码长度需要为 8-20 位".to_string());
    }

    let client = account_http_client_builder(Duration::from_secs(30))
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
        if let Some(token) = session.user_token.as_deref() {
            remember_access_token(base, token, session.access_expires_at);
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
    let client = account_http_client_builder(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    with_authenticated_session(&client, bootstrap_account).await
}

async fn bootstrap_account(
    client: reqwest::Client,
    base: String,
    session: NewApiSession,
) -> Result<AccountState, String> {
    let data = user_self(&client, &base, &session).await?;
    let string_field = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    // The managed token follows the account group, so the account group is
    // exactly what every request routes through.
    let group = account_group(&data)?;
    if get_config_string(ACCOUNT_GROUP_KEY).as_deref() != Some(group.as_str()) {
        let _ = config::persist_values(&[(ACCOUNT_GROUP_KEY, Value::String(group.clone()))]);
    }
    let groups = user_groups(&client, &base, &session).await;
    let entitled_models = user_models(&client, &base, &session)
        .await
        .unwrap_or_default();
    let requested_model = resolve_model_from_list(
        &entitled_models,
        &get_config_string("executor_model").unwrap_or_default(),
    );
    let token = refresh_downstream_token(&client, &base, &session, &requested_model).await?;
    let models = downstream_models(&client, &base, &token).await?;
    config::persist_managed_models(&models)?;
    let model = resolve_model_from_list(&models, &requested_model);
    let group_desc = groups
        .get(group.as_str())
        .and_then(|entry| entry.get("desc"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
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
    let client = account_http_client_builder(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端初始化失败: {error}"))?;
    with_authenticated_session(&client, |client, base, session| async move {
        fetch_usage_logs(&client, &base, &session, page, page_size).await
    })
    .await
    .map_err(normalize_usage_log_error)
}

async fn fetch_usage_logs(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
    page: u32,
    page_size: u32,
) -> Result<NewApiUsageLogPage, String> {
    let request = client.get(format!("{base}/api/log/self")).query(&[
        ("p", page.to_string()),
        ("page_size", page_size.to_string()),
        ("type", "2".to_string()),
    ]);
    let response = with_session(request, session)
        .send()
        .await
        .map_err(|error| format!("获取调用明细失败: {error}"))?;
    let body = parse_usage_log_json(response).await?;
    if !api_ok(&body) {
        return Err(session_api_error(&body, "获取调用明细失败"));
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
    if !has_stored_session() {
        return Err("尚未登录 New API，无法获取模型列表".to_string());
    }
    let client = account_http_client_builder(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    with_authenticated_session(&client, account_models).await
}

async fn account_models(
    client: reqwest::Client,
    base: String,
    session: NewApiSession,
) -> Result<Vec<String>, String> {
    let model = get_config_string("executor_model").unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let api_key = refresh_downstream_token(&client, &base, &session, &model).await?;
    let models = downstream_models(&client, &base, &api_key).await?;
    config::persist_managed_models(&models)?;
    Ok(models)
}

#[cfg(test)]
#[path = "tests/newapi_session.rs"]
mod session_tests;

#[cfg(test)]
mod tests {
    use super::{
        account_group, account_http_client_builder, approved_managed_base, fetch_auth_status, is_invalid_session_error, login, managed_token_create_payload,
        newapi_login,
        parse_json_bytes, parse_refresh_cookie, persisted_user_token, refresh_cookie_header,
        response_preview, secure_base, session_api_error, token_candidate, token_group_update_payload,
        token_needs_unpinning, with_session, NewApiRefreshCookie, NewApiRefreshSession,
        NewApiSession, MANAGED_TOKEN_GROUP, NEWAPI_REFRESH_COOKIE_NAME,
    };
    use serde_json::json;
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn paid_search_uses_the_account_api_key_and_rejects_a_different_model_origin() {
        let base = "https://somni.ensuanx.com";
        let mut obj = json!({
            "newapi_base_url": base,
            "newapi_executor_base_url": format!("{base}/v1"),
            "newapi_executor_api_key": "sk-account-api-sentinel",
            "newapi_user_token": "dashboard-jwt-sentinel",
        }).as_object().unwrap().clone();
        let credential = super::research_api_credential(base, &obj).unwrap();
        assert_eq!(credential.api_key, "sk-account-api-sentinel");
        assert_eq!(credential.issuer, base);
        assert!(!format!("{credential:?}").contains("sk-account-api-sentinel"));
        obj.insert("newapi_executor_base_url".into(), json!("https://other.example/v1"));
        assert!(super::research_api_credential(base, &obj).is_none());
        obj.insert("newapi_executor_base_url".into(), json!(format!("{base}/v1")));
        obj.remove("newapi_executor_api_key");
        assert!(super::research_api_credential(base, &obj).is_none());
    }

    #[test]
    fn tool_billing_models_are_not_offered_as_chat_models() {
        let mut models = Vec::new();
        super::collect_model_ids(&json!([
            { "id": "deepseek-search" }, { "id": "scopus-search" },
            "deepseek-fetch", "deepseek-v4.1-flash", { "id": "MiniMax-M3" }
        ]), &mut models);
        assert_eq!(models, vec!["deepseek-v4.1-flash", "MiniMax-M3"]);
    }

    #[test]
    fn managed_account_endpoint_requires_https_or_loopback() {
        assert_eq!(
            secure_base("https://somni.ensuanx.com/").unwrap(),
            "https://somni.ensuanx.com"
        );
        assert_eq!(
            secure_base("http://127.0.0.1:18080").unwrap(),
            "http://127.0.0.1:18080"
        );
        assert!(secure_base("http://106.53.28.124:18080").is_err());
        assert!(secure_base("http://public.example").is_err());
        assert!(secure_base("https://user:secret@somni.ensuanx.com").is_err());
        assert!(secure_base("https://somni.ensuanx.com/api").is_err());
        assert!(approved_managed_base("https://other.example").is_err());
    }

    #[test]
    fn managed_login_does_not_follow_a_redirect_to_another_origin() {
        let destination = TcpListener::bind("127.0.0.1:0").expect("bind redirect destination");
        let destination_addr = destination.local_addr().expect("destination address");
        destination
            .set_nonblocking(true)
            .expect("set destination nonblocking");
        let capture = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                match destination.accept() {
                    Ok((mut stream, _)) => {
                        let request = read_request(&mut stream);
                        write_json_response(
                            &mut stream,
                            r#"{"success":false,"message":"redirect followed"}"#,
                            false,
                        );
                        return Some(request);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() >= deadline {
                            return None;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("accept redirect destination: {error}"),
                }
            }
        });

        let gateway = TcpListener::bind("127.0.0.1:0").expect("bind mock gateway");
        let gateway_addr = gateway.local_addr().expect("gateway address");
        let original = thread::spawn(move || {
            let (mut stream, _) = gateway.accept().expect("accept login");
            let request = read_request(&mut stream);
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{destination_addr}/capture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream
                .write_all(response.as_bytes())
                .expect("write redirect response");
            request
        });

        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        let result = runtime.block_on(newapi_login(
            format!("http://{gateway_addr}"),
            "MiniMax-M3".to_string(),
            "test-user".to_string(),
            "test-password".to_string(),
            None,
        ));

        assert!(result.is_err(), "a redirect cannot complete managed login");
        assert!(original
            .join()
            .expect("mock gateway finishes")
            .starts_with("POST /api/user/login HTTP/1.1"));
        assert!(
            capture.join().expect("redirect destination finishes").is_none(),
            "managed login followed the 302 to another origin"
        );
    }

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
    fn login_two_factor_challenge_requires_code() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&mut stream);
            write_json_response(&mut stream, r#"{"success":true,"data":{"require_2fa":true}}"#, true);
        });
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(login(&reqwest::Client::new(), &format!("http://{address}"), "alice", "password", None));
        assert_eq!(result.err().unwrap(), "AUTH_TWO_FACTOR_REQUIRED");
        server.join().unwrap();
    }

    #[test]
    fn login_two_factor_verifies_cookie_flow_token_and_errors() {
        for modern in [false, true] {
            for valid in [false, true] {
                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                let address = listener.local_addr().unwrap();
                let server = thread::spawn(move || {
                    let (mut stream, _) = listener.accept().unwrap();
                    read_request(&mut stream);
                    let challenge = if modern {
                        r#"{"success":true,"data":{"require_verification":true,"flow_token":"flow-test"}}"#
                    } else {
                        r#"{"success":true,"data":{"require_2fa":true}}"#
                    };
                    write_json_response(&mut stream, challenge, true);
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut request = read_request(&mut stream);
                    let length: usize = request.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse().unwrap())).unwrap();
                    let start = request.find("\r\n\r\n").unwrap() + 4;
                    while request.len() < start + length {
                        let mut bytes = [0; 1024];
                        let count = stream.read(&mut bytes).unwrap();
                        assert!(count > 0);
                        request.push_str(std::str::from_utf8(&bytes[..count]).unwrap());
                    }
                    if valid {
                        let body = r#"{"success":true,"data":{"id":17,"access_token":"verified-access","session":{"sid":"verified-session"}}}"#;
                        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nSet-Cookie: new_api_refresh=verified-refresh; Path=/; HttpOnly\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    } else {
                        write_json_response(&mut stream, r#"{"success":false,"message":"Invalid verification code"}"#, false);
                    }
                    request
                });
                let client = reqwest::Client::builder().cookie_store(true).timeout(Duration::from_secs(5)).build().unwrap();
                let runtime = tokio::runtime::Runtime::new().unwrap();
                let result = runtime.block_on(login(&client, &format!("http://{address}"), "alice", "password", Some(" backup-code ")));
                let request = server.join().unwrap();
                assert!(request.starts_with("POST /api/user/login/2fa "));
                assert!(request.to_ascii_lowercase().contains("cookie: somniq-login=test-cookie"));
                let payload: serde_json::Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
                assert_eq!(payload["code"], "backup-code");
                assert!(payload.get("password").is_none());
                if modern {
                    assert_eq!(payload["flow_token"], "flow-test");
                    assert_eq!(payload["method"], "2fa");
                } else {
                    assert!(payload.get("flow_token").is_none());
                }
                if valid {
                    let session = result.ok().expect("verified login");
                    assert_eq!(session.user_token.as_deref(), Some("verified-access"));
                    assert_eq!(session.refresh_session.unwrap().cookies[0].value, "verified-refresh");
                } else {
                    assert_eq!(result.err().unwrap(), "Invalid verification code");
                }
            }
        }
    }

    #[test]
    fn account_calls_identify_the_release_and_surface_an_outdated_refusal() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock new-api");
        let address = listener.local_addr().expect("mock address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept status");
            let request = read_request(&mut stream);
            let body = r#"{"success":false,"error":{"message":"请升级到 9.9.9 或更高版本","type":"client_outdated","code":"client_outdated"}}"#;
            let response = format!(
                "HTTP/1.1 426 Upgrade Required\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
            request
        });

        let client = account_http_client_builder(Duration::from_secs(5))
            .build()
            .expect("build client");
        let executor = tokio::runtime::Runtime::new().expect("create runtime");
        let Err(error) =
            executor.block_on(fetch_auth_status(&client, &format!("http://{address}")))
        else {
            panic!("an outdated release is refused");
        };

        assert_eq!(error, "请升级到 9.9.9 或更高版本 (client_outdated)");
        let request = server.join().expect("mock server finishes").to_ascii_lowercase();
        let expected = format!("user-agent: {}", runtime::client_user_agent()).to_ascii_lowercase();
        assert!(request.contains(&expected), "{request}");
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
                None,
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
                None,
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
                None,
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
    fn new_managed_tokens_follow_the_account_group() {
        // An empty group is resolved by new-api per request, so a membership
        // upgrade or expiry reaches the very next call.
        let payload = managed_token_create_payload("sk-test");

        assert_eq!(MANAGED_TOKEN_GROUP, "");
        assert_eq!(payload["group"], "");
        assert_eq!(payload["name"], "somniq-desktop");
        assert_eq!(payload["unlimited_quota"], true);
        assert_eq!(payload["model_limits_enabled"], false);
    }

    #[test]
    fn tokens_pinned_by_older_releases_are_unpinned() {
        let pinned = token_candidate(&json!({ "id": 9, "group": "千研" })).expect("pinned");
        let following = token_candidate(&json!({ "id": 9, "group": "" })).expect("following");
        let bare_id = token_candidate(&json!(9)).expect("bare id");

        assert!(token_needs_unpinning(&pinned));
        assert!(!token_needs_unpinning(&following));
        // A bare id says nothing about its group; writing it blindly would
        // cost a management call on every refresh.
        assert!(!token_needs_unpinning(&bare_id));
    }

    #[test]
    fn unpinning_keeps_every_other_token_setting() {
        let payload = token_group_update_payload(
            &json!({
                "id": 9,
                "name": "somniq-desktop",
                "remain_quota": 50,
                "unlimited_quota": false,
                "group": "千研",
            }),
            MANAGED_TOKEN_GROUP,
        )
        .expect("payload");

        assert_eq!(payload["group"], "");
        assert_eq!(payload["remain_quota"], 50);
        assert_eq!(payload["unlimited_quota"], false);
    }

    #[test]
    fn a_rejected_account_key_is_fetched_again_once_and_shared() {
        let _guard = crate::test_env_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous_home = std::env::var("HOME").ok();
        let previous_userprofile = std::env::var("USERPROFILE").ok();
        let home = std::env::temp_dir().join(format!(
            "somniq-newapi-key-recovery-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock new-api");
        let base = format!("http://{}", listener.local_addr().expect("mock address"));
        let server = thread::spawn(move || {
            let (mut list_stream, _) = listener.accept().expect("accept token list");
            let list_request = read_request(&mut list_stream);
            write_json_response(
                &mut list_stream,
                r#"{"success":true,"data":{"items":[{"id":5,"name":"somniq-desktop","status":1,"key":"abcd**********wxyz","group":""}]}}"#,
                false,
            );
            let (mut key_stream, _) = listener.accept().expect("accept key reveal");
            let key_request = read_request(&mut key_stream);
            write_json_response(&mut key_stream, r#"{"success":true,"data":{"key":"fresh"}}"#, false);
            (list_request, key_request)
        });

        // A legacy-gateway session: the management token sits in config.json,
        // so no OS credential store is involved in this test.
        let config_path = crate::state::config_path();
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("config dir");
        std::fs::write(
            &config_path,
            json!({
                "newapi_base_url": base,
                "newapi_user_id": 17,
                "newapi_access_token": "management-token",
                "newapi_executor_base_url": format!("{base}/v1"),
            })
            .to_string(),
        )
        .expect("write config");
        crate::config::persist_newapi_executor_credentials(&base, "sk-rejected", Some(5))
            .expect("store rejected key");

        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        let replaced = runtime.block_on(super::replace_rejected_model_key(
            format!("{base}/v1"),
            "sk-rejected".to_string(),
        ));
        let (list_request, key_request) = server.join().expect("mock server finishes");

        assert_eq!(replaced.as_deref(), Some("sk-fresh"));
        assert!(list_request.starts_with("GET /api/token/ HTTP/1.1"));
        assert!(key_request.starts_with("POST /api/token/5/key HTTP/1.1"));
        assert!(!std::fs::read_to_string(&config_path)
            .expect("read config")
            .contains("sk-fresh"));
        // A second request that still carries the rejected key takes the
        // replacement without asking the gateway again (the mock is gone).
        assert_eq!(
            runtime
                .block_on(super::replace_rejected_model_key(
                    format!("{base}/v1"),
                    "sk-rejected".to_string(),
                ))
                .as_deref(),
            Some("sk-fresh")
        );
        // A key this account never issued is left alone.
        assert!(runtime
            .block_on(super::replace_rejected_model_key(
                format!("{base}/v1"),
                "sk-somebody-elses".to_string(),
            ))
            .is_none());
        // So is any other endpoint.
        assert!(runtime
            .block_on(super::replace_rejected_model_key(
                "https://api.openai.com/v1".to_string(),
                "sk-fresh".to_string(),
            ))
            .is_none());

        crate::config::clear_newapi_session().expect("logout");
        let _ = std::fs::remove_dir_all(&home);
        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        match previous_userprofile {
            Some(value) => std::env::set_var("USERPROFILE", value),
            None => std::env::remove_var("USERPROFILE"),
        }
    }
}
