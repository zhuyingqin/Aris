use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use runtime::{
    load_oauth_credentials, save_oauth_credentials, OAuthConfig, OAuthRefreshRequest,
    OAuthTokenExchangeRequest,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::sse::{ParsedSseEvent, SseParser};
use crate::types::{
    ContentBlockDelta, MessageRequest, MessageResponse, OutputContentBlock, StreamEvent,
};

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const REQUEST_ID_HEADER: &str = "request-id";
const ALT_REQUEST_ID_HEADER: &str = "x-request-id";
const DEFAULT_INITIAL_BACKOFF: Duration = Duration::from_millis(200);
const DEFAULT_MAX_BACKOFF: Duration = Duration::from_secs(2);
const DEFAULT_MAX_RETRIES: u32 = 2;

pub trait ApiTraceSink: Send + Sync {
    fn record(&self, kind: &str, payload: Value);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthSource {
    None,
    ApiKey(String),
    BearerToken(String),
    ApiKeyAndBearer {
        api_key: String,
        bearer_token: String,
    },
}

impl AuthSource {
    pub fn from_env() -> Result<Self, ApiError> {
        let api_key = read_env_non_empty("ANTHROPIC_API_KEY")?;
        let auth_token = read_env_non_empty("ANTHROPIC_AUTH_TOKEN")?;
        match (api_key, auth_token) {
            (Some(api_key), Some(bearer_token)) => Ok(Self::ApiKeyAndBearer {
                api_key,
                bearer_token,
            }),
            (Some(api_key), None) => Ok(Self::ApiKey(api_key)),
            (None, Some(bearer_token)) => Ok(Self::BearerToken(bearer_token)),
            (None, None) => Err(ApiError::MissingApiKey),
        }
    }

    #[must_use]
    pub fn api_key(&self) -> Option<&str> {
        match self {
            Self::ApiKey(api_key) | Self::ApiKeyAndBearer { api_key, .. } => Some(api_key),
            Self::None | Self::BearerToken(_) => None,
        }
    }

    #[must_use]
    pub fn bearer_token(&self) -> Option<&str> {
        match self {
            Self::BearerToken(token)
            | Self::ApiKeyAndBearer {
                bearer_token: token,
                ..
            } => Some(token),
            Self::None | Self::ApiKey(_) => None,
        }
    }

    #[must_use]
    pub fn masked_authorization_header(&self) -> &'static str {
        if self.bearer_token().is_some() {
            "Bearer [REDACTED]"
        } else {
            "<absent>"
        }
    }

    pub fn apply(&self, mut request_builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(api_key) = self.api_key() {
            request_builder = request_builder.header("x-api-key", api_key);
        }
        if let Some(token) = self.bearer_token() {
            request_builder = request_builder.bearer_auth(token);
        }
        request_builder
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct OAuthTokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub scopes: Vec<String>,
}

impl From<OAuthTokenSet> for AuthSource {
    fn from(value: OAuthTokenSet) -> Self {
        Self::BearerToken(value.access_token)
    }
}

#[derive(Clone)]
pub struct AnthropicClient {
    http: reqwest::Client,
    auth: AuthSource,
    base_url: String,
    max_retries: u32,
    initial_backoff: Duration,
    max_backoff: Duration,
    send_betas: bool,
    trace_sink: Option<Arc<dyn ApiTraceSink>>,
}

impl std::fmt::Debug for AnthropicClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AnthropicClient")
            .field("base_url", &self.base_url)
            .field("max_retries", &self.max_retries)
            .field("initial_backoff", &self.initial_backoff)
            .field("max_backoff", &self.max_backoff)
            .field("send_betas", &self.send_betas)
            .field("trace_enabled", &self.trace_sink.is_some())
            .finish_non_exhaustive()
    }
}

impl AnthropicClient {
    #[must_use]
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            auth: AuthSource::ApiKey(api_key.into()),
            base_url: DEFAULT_BASE_URL.to_string(),
            max_retries: DEFAULT_MAX_RETRIES,
            initial_backoff: DEFAULT_INITIAL_BACKOFF,
            max_backoff: DEFAULT_MAX_BACKOFF,
            send_betas: true,
            trace_sink: None,
        }
    }

    #[must_use]
    pub fn from_auth(auth: AuthSource) -> Self {
        Self {
            http: reqwest::Client::new(),
            auth,
            base_url: DEFAULT_BASE_URL.to_string(),
            max_retries: DEFAULT_MAX_RETRIES,
            initial_backoff: DEFAULT_INITIAL_BACKOFF,
            max_backoff: DEFAULT_MAX_BACKOFF,
            send_betas: true,
            trace_sink: None,
        }
    }

    pub fn from_env() -> Result<Self, ApiError> {
        Ok(Self::from_auth(AuthSource::from_env_or_saved()?)
            .with_base_url(read_base_url())
            .with_send_betas(read_send_betas()))
    }

    #[must_use]
    pub fn with_auth_source(mut self, auth: AuthSource) -> Self {
        self.auth = auth;
        self
    }

    #[must_use]
    pub fn with_auth_token(mut self, auth_token: Option<String>) -> Self {
        match (
            self.auth.api_key().map(ToOwned::to_owned),
            auth_token.filter(|token| !token.is_empty()),
        ) {
            (Some(api_key), Some(bearer_token)) => {
                self.auth = AuthSource::ApiKeyAndBearer {
                    api_key,
                    bearer_token,
                };
            }
            (Some(api_key), None) => {
                self.auth = AuthSource::ApiKey(api_key);
            }
            (None, Some(bearer_token)) => {
                self.auth = AuthSource::BearerToken(bearer_token);
            }
            (None, None) => {
                self.auth = AuthSource::None;
            }
        }
        self
    }

    #[must_use]
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    #[must_use]
    pub fn with_send_betas(mut self, send_betas: bool) -> Self {
        self.send_betas = send_betas;
        self
    }

    #[must_use]
    pub fn with_retry_policy(
        mut self,
        max_retries: u32,
        initial_backoff: Duration,
        max_backoff: Duration,
    ) -> Self {
        self.max_retries = max_retries;
        self.initial_backoff = initial_backoff;
        self.max_backoff = max_backoff;
        self
    }

    #[must_use]
    pub fn with_trace_sink(mut self, trace_sink: Arc<dyn ApiTraceSink>) -> Self {
        self.trace_sink = Some(trace_sink);
        self
    }

    #[must_use]
    pub fn auth_source(&self) -> &AuthSource {
        &self.auth
    }

    pub async fn send_message(
        &self,
        request: &MessageRequest,
    ) -> Result<MessageResponse, ApiError> {
        let request = MessageRequest {
            stream: false,
            ..request.clone()
        };
        let response = self.send_with_retry(&request).await?;
        let request_id = request_id_from_headers(response.headers());
        let mut response = response
            .json::<MessageResponse>()
            .await
            .map_err(ApiError::from)?;
        if response.request_id.is_none() {
            response.request_id = request_id;
        }
        Ok(response)
    }

    pub async fn stream_message(
        &self,
        request: &MessageRequest,
    ) -> Result<MessageStream, ApiError> {
        let streaming_request = request.clone().with_streaming();
        let response = self.send_with_retry(&streaming_request).await?;
        Ok(MessageStream {
            inner: self.clone(),
            request: streaming_request,
            request_id: request_id_from_headers(response.headers()),
            response,
            parser: SseParser::new(),
            pending: VecDeque::new(),
            events_emitted: 0,
            has_emitted_meaningful_content: false,
            stream_retries_remaining: read_stream_retry_budget(),
            observed_terminal: false,
            idle_timeout: resolve_stream_idle_timeout(),
            done: false,
        })
    }

    pub async fn exchange_oauth_code(
        &self,
        config: &OAuthConfig,
        request: &OAuthTokenExchangeRequest,
    ) -> Result<OAuthTokenSet, ApiError> {
        let response = self
            .http
            .post(&config.token_url)
            .header("content-type", "application/x-www-form-urlencoded")
            .form(&request.form_params())
            .send()
            .await
            .map_err(ApiError::from)?;
        let response = expect_success(response).await?;
        response
            .json::<OAuthTokenSet>()
            .await
            .map_err(ApiError::from)
    }

    pub async fn refresh_oauth_token(
        &self,
        config: &OAuthConfig,
        request: &OAuthRefreshRequest,
    ) -> Result<OAuthTokenSet, ApiError> {
        let response = self
            .http
            .post(&config.token_url)
            .header("content-type", "application/x-www-form-urlencoded")
            .form(&request.form_params())
            .send()
            .await
            .map_err(ApiError::from)?;
        let response = expect_success(response).await?;
        response
            .json::<OAuthTokenSet>()
            .await
            .map_err(ApiError::from)
    }

    async fn send_with_retry(
        &self,
        request: &MessageRequest,
    ) -> Result<reqwest::Response, ApiError> {
        let mut attempts = 0;
        let mut last_error: Option<ApiError>;

        loop {
            attempts += 1;
            self.record_trace(
                "llm.attempt",
                json!({
                    "provider": "anthropic",
                    "model": &request.model,
                    "phase": "send",
                    "attempt": attempts,
                    "maxAttempts": self.max_retries + 1,
                    "stream": request.stream,
                }),
            );
            match self.send_raw_request(request).await {
                Ok(response) => {
                    let response_trace = response_trace_value(response.headers());
                    match expect_success(response).await {
                        Ok(response) => return Ok(response),
                        Err(error) if error.is_retryable() && attempts <= self.max_retries + 1 => {
                            self.record_trace(
                                "llm.retry",
                                json!({
                                    "provider": "anthropic",
                                    "model": &request.model,
                                    "phase": "send",
                                    "attempt": attempts,
                                    "maxAttempts": self.max_retries + 1,
                                    "reason": error.to_string(),
                                    "error": api_error_trace_value(&error),
                                    "response": response_trace,
                                }),
                            );
                            last_error = Some(error);
                        }
                        Err(error) => return Err(error),
                    }
                }
                Err(error) if error.is_retryable() && attempts <= self.max_retries + 1 => {
                    self.record_trace(
                        "llm.retry",
                        json!({
                            "provider": "anthropic",
                            "model": &request.model,
                            "phase": "send",
                            "attempt": attempts,
                            "maxAttempts": self.max_retries + 1,
                            "reason": error.to_string(),
                            "error": api_error_trace_value(&error),
                        }),
                    );
                    last_error = Some(error);
                }
                Err(error) => return Err(error),
            }

            if attempts > self.max_retries {
                break;
            }

            tokio::time::sleep(self.backoff_for_attempt(attempts)?).await;
        }

        Err(ApiError::RetriesExhausted {
            attempts,
            last_error: Box::new(last_error.expect("retry loop must capture an error")),
        })
    }

    async fn send_raw_request(
        &self,
        request: &MessageRequest,
    ) -> Result<reqwest::Response, ApiError> {
        let is_oauth = self.auth.bearer_token().is_some() && self.auth.api_key().is_none();
        let request_url = format!("{}/v1/messages", self.base_url.trim_end_matches('/'));
        let mut request_builder = self
            .http
            .post(&request_url)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json");
        if is_oauth && self.send_betas {
            let model = &request.model;
            let is_haiku = model.contains("haiku");
            let mut betas = vec!["oauth-2025-04-20"];
            if !is_haiku {
                betas.push("claude-code-20250219");
                betas.push("interleaved-thinking-2025-05-14");
            }
            if model.contains("opus") {
                betas.push("context-1m-2025-08-07");
            }
            request_builder = request_builder.header("anthropic-beta", betas.join(","));
        }
        request_builder = self.auth.apply(request_builder);

        request_builder = request_builder.json(request);
        request_builder.send().await.map_err(ApiError::from)
    }

    fn backoff_for_attempt(&self, attempt: u32) -> Result<Duration, ApiError> {
        let Some(multiplier) = 1_u32.checked_shl(attempt.saturating_sub(1)) else {
            return Err(ApiError::BackoffOverflow {
                attempt,
                base_delay: self.initial_backoff,
            });
        };
        Ok(self
            .initial_backoff
            .checked_mul(multiplier)
            .map_or(self.max_backoff, |delay| delay.min(self.max_backoff)))
    }

    fn record_trace(&self, kind: &str, payload: Value) {
        if let Some(trace_sink) = &self.trace_sink {
            trace_sink.record(kind, payload);
        }
    }
}

impl AuthSource {
    pub fn from_env_or_saved() -> Result<Self, ApiError> {
        if let Some(api_key) = read_env_non_empty("ANTHROPIC_API_KEY")? {
            return match read_env_non_empty("ANTHROPIC_AUTH_TOKEN")? {
                Some(bearer_token) => Ok(Self::ApiKeyAndBearer {
                    api_key,
                    bearer_token,
                }),
                None => Ok(Self::ApiKey(api_key)),
            };
        }
        if let Some(bearer_token) = read_env_non_empty("ANTHROPIC_AUTH_TOKEN")? {
            return Ok(Self::BearerToken(bearer_token));
        }
        // Try claw-code's own credentials.json
        match load_saved_oauth_token() {
            Ok(Some(token_set)) if !oauth_token_is_expired(&token_set) => {
                return Ok(Self::BearerToken(token_set.access_token));
            }
            _ => {}
        }
        // Fallback: try reading from macOS Keychain (Claude Code's stored OAuth token)
        if let Some(token_set) = load_keychain_oauth_token() {
            if !oauth_token_is_expired(&token_set) {
                return Ok(Self::BearerToken(token_set.access_token));
            }
        }
        Err(ApiError::MissingApiKey)
    }
}

/// Try to load OAuth token set from macOS Keychain (where official Claude Code stores it).
fn load_keychain_oauth_token() -> Option<OAuthTokenSet> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let raw = String::from_utf8(output.stdout).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
        let oauth = parsed.get("claudeAiOauth")?;
        let access_token = oauth.get("accessToken")?.as_str()?.to_string();
        if access_token.is_empty() {
            return None;
        }
        let refresh_token = oauth
            .get("refreshToken")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned);
        // Claude Code stores expiresAt as milliseconds since epoch; convert to seconds
        let expires_at = oauth.get("expiresAt").and_then(|v| v.as_u64()).map(|ms| {
            if ms > 1_000_000_000_000 {
                ms / 1000
            } else {
                ms
            }
        });
        Some(OAuthTokenSet {
            access_token,
            refresh_token,
            expires_at,
            scopes: Vec::new(),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[must_use]
pub fn oauth_token_is_expired(token_set: &OAuthTokenSet) -> bool {
    token_set
        .expires_at
        .is_some_and(|expires_at| expires_at <= now_unix_timestamp())
}

pub fn resolve_saved_oauth_token(config: &OAuthConfig) -> Result<Option<OAuthTokenSet>, ApiError> {
    let Some(token_set) = load_saved_oauth_token()? else {
        return Ok(None);
    };
    resolve_saved_oauth_token_set(config, token_set).map(Some)
}

pub fn resolve_startup_auth_source<F>(load_oauth_config: F) -> Result<AuthSource, ApiError>
where
    F: FnOnce() -> Result<Option<OAuthConfig>, ApiError>,
{
    if let Some(api_key) = read_env_non_empty("ANTHROPIC_API_KEY")? {
        return match read_env_non_empty("ANTHROPIC_AUTH_TOKEN")? {
            Some(bearer_token) => Ok(AuthSource::ApiKeyAndBearer {
                api_key,
                bearer_token,
            }),
            None => Ok(AuthSource::ApiKey(api_key)),
        };
    }
    if let Some(bearer_token) = read_env_non_empty("ANTHROPIC_AUTH_TOKEN")? {
        return Ok(AuthSource::BearerToken(bearer_token));
    }

    let Some(token_set) = load_saved_oauth_token()? else {
        // Fallback: try macOS Keychain (official Claude Code's stored OAuth token)
        if let Some(keychain_set) = load_keychain_oauth_token() {
            if !oauth_token_is_expired(&keychain_set) {
                return Ok(AuthSource::BearerToken(keychain_set.access_token));
            }
            // Token expired: no refresh config available here, fall through to error
        }
        return Err(ApiError::MissingApiKey);
    };
    if !oauth_token_is_expired(&token_set) {
        return Ok(AuthSource::BearerToken(token_set.access_token));
    }
    if token_set.refresh_token.is_none() {
        return Err(ApiError::ExpiredOAuthToken);
    }

    let Some(config) = load_oauth_config()? else {
        return Err(ApiError::Auth(
            "saved OAuth token is expired; runtime OAuth config is missing".to_string(),
        ));
    };
    Ok(AuthSource::from(resolve_saved_oauth_token_set(
        &config, token_set,
    )?))
}

fn resolve_saved_oauth_token_set(
    config: &OAuthConfig,
    token_set: OAuthTokenSet,
) -> Result<OAuthTokenSet, ApiError> {
    if !oauth_token_is_expired(&token_set) {
        return Ok(token_set);
    }
    let Some(refresh_token) = token_set.refresh_token.clone() else {
        return Err(ApiError::ExpiredOAuthToken);
    };
    let client = AnthropicClient::from_auth(AuthSource::None).with_base_url(read_base_url());
    let refreshed = client_runtime_block_on(async {
        client
            .refresh_oauth_token(
                config,
                &OAuthRefreshRequest::from_config(
                    config,
                    refresh_token,
                    Some(token_set.scopes.clone()),
                ),
            )
            .await
    })?;
    let resolved = OAuthTokenSet {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token.or(token_set.refresh_token),
        expires_at: refreshed.expires_at,
        scopes: refreshed.scopes,
    };
    save_oauth_credentials(&runtime::OAuthTokenSet {
        access_token: resolved.access_token.clone(),
        refresh_token: resolved.refresh_token.clone(),
        expires_at: resolved.expires_at,
        scopes: resolved.scopes.clone(),
    })
    .map_err(ApiError::from)?;
    Ok(resolved)
}

fn client_runtime_block_on<F, T>(future: F) -> Result<T, ApiError>
where
    F: std::future::Future<Output = Result<T, ApiError>>,
{
    tokio::runtime::Runtime::new()
        .map_err(ApiError::from)?
        .block_on(future)
}

fn load_saved_oauth_token() -> Result<Option<OAuthTokenSet>, ApiError> {
    let token_set = load_oauth_credentials().map_err(ApiError::from)?;
    Ok(token_set.map(|token_set| OAuthTokenSet {
        access_token: token_set.access_token,
        refresh_token: token_set.refresh_token,
        expires_at: token_set.expires_at,
        scopes: token_set.scopes,
    }))
}

fn now_unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn read_env_non_empty(key: &str) -> Result<Option<String>, ApiError> {
    match std::env::var(key) {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) | Err(std::env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(ApiError::from(error)),
    }
}

#[cfg(test)]
fn read_api_key() -> Result<String, ApiError> {
    let auth = AuthSource::from_env_or_saved()?;
    auth.api_key()
        .or_else(|| auth.bearer_token())
        .map(ToOwned::to_owned)
        .ok_or(ApiError::MissingApiKey)
}

#[cfg(test)]
fn read_auth_token() -> Option<String> {
    read_env_non_empty("ANTHROPIC_AUTH_TOKEN")
        .ok()
        .and_then(std::convert::identity)
}

#[must_use]
pub fn read_base_url() -> String {
    std::env::var("ANTHROPIC_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
}

/// Returns `false` when `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is set to a truthy value,
/// indicating that Anthropic-specific beta headers should not be sent. This is needed for
/// third-party API providers (e.g. AWS Bedrock proxies) that reject unknown beta flags.
#[must_use]
pub fn read_send_betas() -> bool {
    !std::env::var("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

/// Number of additional whole-stream restarts the SSE reader will attempt
/// when the body abort or premature EOF occurs before any event was
/// emitted. v0.4.10 closes the C6 landmine documented in the v0.4.7
/// audit: stream chunk read failures used to surface directly as
/// `http error: error decoding response body`, with no retry, even
/// though the wider request-level retry wrapper (`send_with_retry`)
/// already exists. Default 2 (clamped 0..=5). Parsed as u32 first so
/// `ARIS_STREAM_RETRY=999` clamps to 5 instead of silently falling
/// back to default (would happen with direct u8 parse).
fn read_stream_retry_budget() -> u8 {
    let raw = std::env::var("ARIS_STREAM_RETRY")
        .ok()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(2);
    raw.min(5) as u8
}

/// Backoff between stream restarts. Small fixed delay to avoid hammering
/// a flaky proxy. Independent of the existing send_with_retry backoff,
/// which already handles the request-send phase.
const STREAM_RETRY_BACKOFF: Duration = Duration::from_millis(500);

/// Default chunk-idle timeout when `ARIS_STREAM_IDLE_TIMEOUT_SECS` is unset
/// or unparseable: 120s.
const STREAM_IDLE_TIMEOUT_DEFAULT_SECS: i64 = 120;
/// Lower clamp for the chunk-idle timeout (10s). Smaller values would
/// race normal long-thinking turns.
const STREAM_IDLE_TIMEOUT_MIN_SECS: i64 = 10;
/// Upper clamp for the chunk-idle timeout (30min). Larger values are
/// equivalent to "no timeout" — use `0` / negative to opt out explicitly.
const STREAM_IDLE_TIMEOUT_MAX_SECS: i64 = 1800;

/// v0.4.14 C11 — pure helper for parsing the chunk-idle timeout string.
/// Returns `None` when the parsed value is `<= 0` (caller treats as
/// "indefinite chunk wait"), otherwise clamps into `[10, 1800]` seconds.
/// Unparseable / missing / blank → default 120s. Pure so it's testable
/// without `std::env::set_var` racing the cargo test harness.
#[must_use]
pub(crate) fn parse_stream_idle_timeout_secs(raw: Option<&str>) -> Option<Duration> {
    let secs = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(STREAM_IDLE_TIMEOUT_DEFAULT_SECS);
    if secs <= 0 {
        return None;
    }
    let clamped = secs.clamp(STREAM_IDLE_TIMEOUT_MIN_SECS, STREAM_IDLE_TIMEOUT_MAX_SECS) as u64;
    Some(Duration::from_secs(clamped))
}

/// Resolve the chunk-idle timeout for streaming reads from the
/// `ARIS_STREAM_IDLE_TIMEOUT_SECS` env var. Default 120s, clamp
/// `[10, 1800]`, `0` / negative disables. Returning `None` means
/// "do not wrap chunk().await in tokio::time::timeout" — chunks may
/// block indefinitely if the upstream proxy stops sending keepalives.
///
/// v0.4.14 C11 (codex audit P2): prevents stuck-forever symptoms on
/// long-lived HTTPS streams when the upstream silently hangs without
/// sending TCP RST or HTTP body.
#[must_use]
pub fn resolve_stream_idle_timeout() -> Option<Duration> {
    parse_stream_idle_timeout_secs(
        std::env::var("ARIS_STREAM_IDLE_TIMEOUT_SECS")
            .ok()
            .as_deref(),
    )
}

/// Whether a reqwest::Error represents a transient stream-body failure
/// that warrants a whole-stream restart (mid-body abort, decode/framing
/// interrupted, timeout, connect reset). Excludes HTTP status errors
/// (those are caught earlier by send_with_retry's expect_success).
fn stream_chunk_error_is_retryable(error: &reqwest::Error) -> bool {
    error.is_request()
        || error.is_connect()
        || error.is_timeout()
        || error.is_body()
        || error.is_decode()
}

fn request_id_from_headers(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(REQUEST_ID_HEADER)
        .or_else(|| headers.get(ALT_REQUEST_ID_HEADER))
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

fn response_trace_value(headers: &reqwest::header::HeaderMap) -> Value {
    json!({
        "requestId": request_id_from_headers(headers),
        "headers": response_header_trace_value(headers),
    })
}

fn response_header_trace_value(headers: &reqwest::header::HeaderMap) -> Value {
    json!({
        "request-id": header_value(headers, REQUEST_ID_HEADER),
        "x-request-id": header_value(headers, ALT_REQUEST_ID_HEADER),
        "retry-after": header_value(headers, "retry-after"),
        "content-type": header_value(headers, "content-type"),
        "anthropic-ratelimit-requests-remaining": header_value(headers, "anthropic-ratelimit-requests-remaining"),
        "anthropic-ratelimit-tokens-remaining": header_value(headers, "anthropic-ratelimit-tokens-remaining"),
    })
}

fn header_value(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn api_error_trace_value(error: &ApiError) -> Value {
    match error {
        ApiError::Api {
            status,
            error_type,
            message,
            body,
            retryable,
        } => {
            let chars = body.chars().count();
            json!({
                "kind": "api",
                "status": status.as_u16(),
                "errorType": error_type,
                "message": message,
                "retryable": retryable,
                "bodyPreview": body.chars().take(4_096).collect::<String>(),
                "bodyChars": chars,
                "bodyTruncated": chars > 4_096,
            })
        }
        ApiError::Http(error) => json!({
            "kind": "http",
            "message": error.to_string(),
            "timeout": error.is_timeout(),
            "connect": error.is_connect(),
            "request": error.is_request(),
            "body": error.is_body(),
            "decode": error.is_decode(),
        }),
        ApiError::RetriesExhausted {
            attempts,
            last_error,
        } => json!({
            "kind": "retries_exhausted",
            "attempts": attempts,
            "lastError": api_error_trace_value(last_error),
        }),
        ApiError::BackoffOverflow {
            attempt,
            base_delay,
        } => json!({
            "kind": "backoff_overflow",
            "attempt": attempt,
            "baseDelay": format!("{base_delay:?}"),
        }),
        other => json!({
            "kind": format!("{other:?}"),
            "message": other.to_string(),
        }),
    }
}

#[derive(Debug)]
pub struct MessageStream {
    /// AnthropicClient handle, cloned at stream creation. Used by
    /// [`try_refresh_stream`](Self::try_refresh_stream) when a chunk
    /// read aborts before any event has been emitted. reqwest::Client
    /// is Arc-wrapped internally so the clone is cheap.
    inner: AnthropicClient,
    /// Request body as sent (already had `.with_streaming()` applied).
    /// Stored verbatim so retries re-send the same payload.
    request: MessageRequest,
    request_id: Option<String>,
    response: reqwest::Response,
    parser: SseParser,
    pending: VecDeque<ParsedSseEvent>,
    /// Number of events the caller has already observed via
    /// [`next_event`](Self::next_event). Retained from v0.4.10 for
    /// session-level stats / debugging — covers any yielded protocol
    /// event including `MessageStart`, empty `text_delta`, etc.
    events_emitted: usize,
    /// `true` once we've yielded at least one event the caller can
    /// actually use (non-empty text/thinking delta, accumulating
    /// tool_use input, or ContentBlockStop). v0.4.12 retry-eligibility
    /// gate (codex P1.A): `MessageStart` alone or a stream that only
    /// sent `MessageStart` then EOF can still be safely retried because
    /// nothing observable was committed. Aligns with OpenAI executor's
    /// `nothing_emitted_yet()` predicate.
    has_emitted_meaningful_content: bool,
    /// Remaining whole-stream restart budget. Initialised from
    /// `ARIS_STREAM_RETRY` (default 2, clamped 0..=5).
    stream_retries_remaining: u8,
    /// `true` once we see Anthropic's `MessageStop` (the protocol's
    /// terminal event). Combined with
    /// `has_emitted_meaningful_content == false` to distinguish
    /// "proxy aborted before sending anything" from "complete short
    /// response".
    observed_terminal: bool,
    /// v0.4.14 C11 — per-chunk idle timeout wrapped around
    /// `response.chunk().await`. `None` means "wait indefinitely"
    /// (legacy behaviour, opt-in via `ARIS_STREAM_IDLE_TIMEOUT_SECS=0`).
    /// On elapse the stream goes through the existing mid-body abort
    /// retry path (same gates as a transient reqwest::Error).
    idle_timeout: Option<Duration>,
    done: bool,
}

/// v0.4.12 P1.A — classify whether yielding this event commits visible
/// state to the caller (so a whole-stream restart afterwards would
/// break output continuity). Aligns with OpenAI executor's
/// `nothing_emitted_yet()` definition: non-empty text/thinking, any
/// accumulating tool_use input, or a finished content block all count
/// as meaningful.
///
/// `ContentBlockStart::ToolUse` is **also** meaningful (codex round-3
/// finding #1): callers write `pending_tool` state when they see a
/// `ToolUse` start, so if the stream then aborts and we transparently
/// retry with a new request, the new stream might come back with text
/// and we'd risk emitting a stale `pending_tool` at the next
/// `ContentBlockStop`. Being conservative here closes that window —
/// the price is a marginally larger pool of unretryable streams.
///
/// `MessageStart` / `MessageDelta` / `MessageStop` and `ContentBlockStart`
/// with empty `Text` / `Thinking` content are still safe to discard
/// and so are NOT meaningful.
fn event_is_meaningful_content(event: &StreamEvent) -> bool {
    match event {
        StreamEvent::ContentBlockDelta(e) => match &e.delta {
            ContentBlockDelta::TextDelta { text } => !text.is_empty(),
            ContentBlockDelta::ThinkingDelta { thinking } => !thinking.is_empty(),
            ContentBlockDelta::InputJsonDelta { .. } => true,
            ContentBlockDelta::SignatureDelta { .. } => false,
        },
        StreamEvent::ContentBlockStop(_) => true,
        StreamEvent::ContentBlockStart(e) => match &e.content_block {
            OutputContentBlock::Text { text } => !text.is_empty(),
            OutputContentBlock::Thinking { thinking, .. } => !thinking.is_empty(),
            // ToolUse start commits caller pending_tool state — see doc above.
            OutputContentBlock::ToolUse { .. } => true,
        },
        // MessageStart / MessageDelta / MessageStop / Error — protocol-only,
        // no caller-visible content commitment.
        _ => false,
    }
}

/// CL2 — a stream is "terminal" when either:
///   - a `MessageStop` event arrives (normal Anthropic), or
///   - a `MessageDelta` carries a non-empty `stop_reason` (some
///     Anthropic-compat proxies send stop_reason on MessageDelta and then
///     close the connection without emitting MessageStop; without this
///     check their clean EOF looks like a premature abort and triggers an
///     unnecessary retry).
fn event_signals_terminal(event: &StreamEvent) -> bool {
    match event {
        StreamEvent::MessageStop(_) => true,
        StreamEvent::MessageDelta(e) => e
            .delta
            .stop_reason
            .as_deref()
            .is_some_and(|s| !s.is_empty()),
        _ => false,
    }
}

/// v0.4.13 codex round-1 #3 — extracted retry-trigger truth table so it
/// can be unit-tested in isolation without mocking a `reqwest::Response`.
///
/// Returns `true` exactly when the premature-EOF retry path in
/// `MessageStream::next_event` should fire:
/// - no meaningful content yet (`MessageStart`-only stream is OK to discard)
/// - never saw `MessageStop` (would be a complete short response, not abort)
/// - parser surfaced an error OR finished with zero leftover events
/// - retry budget remains
///
/// Together these guarantee a retry is safe (no user-visible state to
/// preserve) and useful (something actually went wrong).
fn should_retry_on_premature_eof(
    has_emitted_meaningful_content: bool,
    observed_terminal: bool,
    parser_errored: bool,
    leftover_empty: bool,
    stream_retries_remaining: u8,
) -> bool {
    !has_emitted_meaningful_content
        && !observed_terminal
        && (parser_errored || leftover_empty)
        && stream_retries_remaining > 0
}

impl MessageStream {
    #[must_use]
    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }

    pub async fn next_event(&mut self) -> Result<Option<StreamEvent>, ApiError> {
        Ok(self.next_event_with_raw().await?.map(|event| event.event))
    }

    pub async fn next_event_with_raw(&mut self) -> Result<Option<ParsedSseEvent>, ApiError> {
        loop {
            if let Some(parsed_event) = self.pending.pop_front() {
                let event = &parsed_event.event;
                // Convert in-stream error events to ApiError
                if let StreamEvent::Error(e) = event {
                    let msg = e
                        .error
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("stream error")
                        .to_string();
                    return Err(ApiError::Api {
                        status: reqwest::StatusCode::OK,
                        error_type: e
                            .error
                            .get("type")
                            .and_then(|v| v.as_str())
                            .map(ToOwned::to_owned),
                        message: Some(msg.clone()),
                        body: msg,
                        retryable: false,
                    });
                }
                // Track terminal signal + meaningful-content flag + counter.
                // CL2: MessageStop OR a MessageDelta with non-empty stop_reason
                // both mark the stream as terminal. Anthropic-compat proxies
                // sometimes send stop_reason on a MessageDelta without a
                // following MessageStop; without this, clean EOF is misclassified
                // as premature and triggers an unnecessary retry.
                if event_signals_terminal(event) {
                    self.observed_terminal = true;
                }
                if event_is_meaningful_content(event) {
                    self.has_emitted_meaningful_content = true;
                }
                self.events_emitted = self.events_emitted.saturating_add(1);
                return Ok(Some(parsed_event));
            }

            if self.done {
                // Premature EOF retry path: if the server closed the
                // stream cleanly (no reqwest error) but no meaningful
                // content reached the caller AND we never saw
                // MessageStop, the proxy probably aborted upstream.
                // Try a whole-stream restart before surfacing the
                // parser error or empty result. v0.4.12 P1.A (codex
                // round-2 finding #3): gate retry on
                // `!has_emitted_meaningful_content` not `events_emitted == 0`,
                // so a stream that only sent `MessageStart` then died
                // is still retry-eligible.
                let finish_result = self.parser.finish_with_raw();
                let parser_errored = finish_result.is_err();
                let leftover_empty = finish_result.as_ref().map(Vec::is_empty).unwrap_or(false);
                if should_retry_on_premature_eof(
                    self.has_emitted_meaningful_content,
                    self.observed_terminal,
                    parser_errored,
                    leftover_empty,
                    self.stream_retries_remaining,
                ) {
                    self.stream_retries_remaining -= 1;
                    eprintln!(
                        "stream restart (premature EOF, {} attempt(s) left)",
                        self.stream_retries_remaining
                    );
                    self.record_stream_retry("premature_eof", None);
                    self.try_refresh_stream().await?;
                    continue;
                }
                let remaining = finish_result?;
                self.pending.extend(remaining);
                if let Some(parsed_event) = self.pending.pop_front() {
                    let event = &parsed_event.event;
                    if event_signals_terminal(event) {
                        self.observed_terminal = true;
                    }
                    if event_is_meaningful_content(event) {
                        self.has_emitted_meaningful_content = true;
                    }
                    self.events_emitted = self.events_emitted.saturating_add(1);
                    return Ok(Some(parsed_event));
                }
                return Ok(None);
            }

            // v0.4.14 C11 — wrap chunk read in tokio::time::timeout so
            // a hung upstream (proxy holding the connection without
            // sending keepalives) can't stall this loop forever. Idle
            // elapse is treated equivalently to a mid-body abort and
            // walks through the same restart gate.
            let chunk_future = self.response.chunk();
            let chunk_result = match self.idle_timeout {
                Some(dur) => match tokio::time::timeout(dur, chunk_future).await {
                    Ok(inner) => inner,
                    Err(_elapsed) => {
                        if !self.has_emitted_meaningful_content && self.stream_retries_remaining > 0
                        {
                            self.stream_retries_remaining -= 1;
                            eprintln!(
                                "stream restart (idle timeout {}s, {} attempt(s) left)",
                                dur.as_secs(),
                                self.stream_retries_remaining
                            );
                            self.record_stream_retry(
                                "idle_timeout",
                                Some(json!({ "idleTimeoutSeconds": dur.as_secs() })),
                            );
                            self.try_refresh_stream().await?;
                            continue;
                        }
                        return Err(ApiError::Api {
                            status: reqwest::StatusCode::REQUEST_TIMEOUT,
                            error_type: Some("stream_idle_timeout".to_string()),
                            message: Some(format!(
                                "Anthropic stream idle timeout ({}s, retries exhausted or partial output already emitted)",
                                dur.as_secs()
                            )),
                            body: format!(
                                "Anthropic stream idle timeout after {}s with no chunk; retries exhausted or partial output already emitted",
                                dur.as_secs()
                            ),
                            retryable: false,
                        });
                    }
                },
                None => chunk_future.await,
            };
            match chunk_result {
                Ok(Some(chunk)) => {
                    self.pending.extend(self.parser.push_with_raw(&chunk)?);
                }
                Ok(None) => {
                    self.done = true;
                }
                Err(error) => {
                    // Mid-body abort. Retry the whole request if we
                    // haven't surfaced any meaningful content to the
                    // caller yet — there's no resume primitive in
                    // either upstream API. v0.4.12 P1.A: gate on
                    // `!has_emitted_meaningful_content` not raw
                    // `events_emitted`, so a stream that only sent
                    // `MessageStart` before aborting is still safe
                    // to restart.
                    if !self.has_emitted_meaningful_content
                        && self.stream_retries_remaining > 0
                        && stream_chunk_error_is_retryable(&error)
                    {
                        self.stream_retries_remaining -= 1;
                        eprintln!(
                            "stream restart (body abort: {}, {} attempt(s) left)",
                            error, self.stream_retries_remaining
                        );
                        self.record_stream_retry(
                            "body_abort",
                            Some(json!({ "error": error.to_string() })),
                        );
                        self.try_refresh_stream().await?;
                        continue;
                    }
                    return Err(ApiError::from(error));
                }
            }
        }
    }

    /// Re-sends the original request and rebinds the parser/response
    /// state. Used only when `next_event` decides the prior stream
    /// died before any event reached the caller.
    async fn try_refresh_stream(&mut self) -> Result<(), ApiError> {
        tokio::time::sleep(STREAM_RETRY_BACKOFF).await;
        let response = self.inner.send_with_retry(&self.request).await?;
        self.request_id = request_id_from_headers(response.headers());
        self.response = response;
        self.parser = SseParser::new();
        self.pending.clear();
        self.done = false;
        // Defensive reset — restart only fires while these are already
        // in their "nothing committed" state, but resetting explicitly
        // keeps the invariant obvious to future readers.
        self.events_emitted = 0;
        self.has_emitted_meaningful_content = false;
        self.observed_terminal = false;
        Ok(())
    }

    fn record_stream_retry(&self, reason: &str, detail: Option<Value>) {
        self.inner.record_trace(
            "llm.retry",
            json!({
                "provider": "anthropic",
                "model": &self.request.model,
                "phase": "stream",
                "reason": reason,
                "retriesRemaining": self.stream_retries_remaining,
                "requestId": self.request_id.as_deref(),
                "detail": detail,
            }),
        );
    }
}

async fn expect_success(response: reqwest::Response) -> Result<reqwest::Response, ApiError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let body = response.text().await.unwrap_or_else(|_| String::new());
    let parsed_error = serde_json::from_str::<AnthropicErrorEnvelope>(&body).ok();
    let retryable = is_retryable_status(status);

    Err(ApiError::Api {
        status,
        error_type: parsed_error
            .as_ref()
            .map(|error| error.error.error_type.clone()),
        message: parsed_error
            .as_ref()
            .map(|error| error.error.message.clone()),
        body,
        retryable,
    })
}

const fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 409 | 429 | 500 | 502 | 503 | 504)
}

#[derive(Debug, Deserialize)]
struct AnthropicErrorEnvelope {
    error: AnthropicErrorBody,
}

#[derive(Debug, Deserialize)]
struct AnthropicErrorBody {
    #[serde(rename = "type")]
    error_type: String,
    message: String,
}

#[cfg(test)]
#[path = "tests/client.rs"]
mod tests;
