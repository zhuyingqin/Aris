//! OpenAI-compatible executor client for ARIS.
//!
//! Supports providers that implement the OpenAI `/v1/chat/completions` API
//! (Gemini, DeepSeek, GLM, MiniMax, Moonshot, Qwen, Yi, etc.) and routes
//! Responses-capable tool flows through `/v1/responses`, including OpenAI
//! GPT-5/o-series and DeepSeek V4 Pro/Flash on compatible gateways such as
//! NewAPI.

use runtime::{
    ApiClient, ApiRequest, AssistantEvent, ContentBlock, ConversationMessage, MessageRole,
    RuntimeError, TokenUsage,
};
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};

use crate::{
    assistant_events_to_value, interrupted_error, push_text_event, stream_cancel_requested,
    tool_specs_to_value, trace_record, wait_for_stream_cancel, ExecutorToolSpec, ExecutorTraceSink,
    StreamObserver,
};

/// Buffers raw SSE bytes until a complete line is available, then decodes the
/// whole line as strict UTF-8. Decoding each HTTP chunk independently is
/// incorrect: reqwest may split a multibyte character at any byte boundary,
/// and `from_utf8_lossy` would silently turn both halves into U+FFFD inside a
/// tool argument.
#[derive(Debug, Default)]
struct StrictSseLineBuffer {
    bytes: Vec<u8>,
}

impl StrictSseLineBuffer {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, StrictSseUtf8Error> {
        self.bytes.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut consumed = 0usize;
        while let Some(relative_end) = self.bytes[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let end = consumed + relative_end;
            let mut line = &self.bytes[consumed..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len().saturating_sub(1)];
            }
            let decoded = std::str::from_utf8(line).map_err(|error| StrictSseUtf8Error {
                valid_up_to: consumed.saturating_add(error.valid_up_to()),
            })?;
            lines.push(decoded.to_string());
            consumed = end.saturating_add(1);
        }
        if consumed > 0 {
            self.bytes.drain(..consumed);
        }
        Ok(lines)
    }

    fn clear(&mut self) {
        self.bytes.clear();
    }

    fn has_non_whitespace_tail(&self) -> bool {
        self.bytes.iter().any(|byte| !byte.is_ascii_whitespace())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StrictSseUtf8Error {
    valid_up_to: usize,
}

impl std::fmt::Display for StrictSseUtf8Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "invalid UTF-8 in OpenAI-compatible SSE line at buffered byte {}; response rejected without lossy replacement",
            self.valid_up_to
        )
    }
}

const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_RESPONSE_HEADER_TIMEOUT: Duration = Duration::from_secs(120);
const HTTP_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const HTTP_TCP_KEEPALIVE: Duration = Duration::from_secs(30);

#[derive(Debug)]
enum OpenAiSendError {
    Http(reqwest::Error),
    ResponseHeaderTimeout,
}

impl OpenAiSendError {
    fn is_transient(&self) -> bool {
        match self {
            Self::Http(error) => {
                error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
            }
            Self::ResponseHeaderTimeout => true,
        }
    }
}

impl std::fmt::Display for OpenAiSendError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http(error) => write!(formatter, "{error}"),
            Self::ResponseHeaderTimeout => write!(
                formatter,
                "upstream returned no response headers within {} seconds",
                HTTP_RESPONSE_HEADER_TIMEOUT.as_secs()
            ),
        }
    }
}

impl std::error::Error for OpenAiSendError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Http(error) => Some(error),
            Self::ResponseHeaderTimeout => None,
        }
    }
}

async fn send_with_response_header_timeout(
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, OpenAiSendError> {
    match tokio::time::timeout(HTTP_RESPONSE_HEADER_TIMEOUT, request.send()).await {
        Ok(result) => result.map_err(OpenAiSendError::Http),
        Err(_) => Err(OpenAiSendError::ResponseHeaderTimeout),
    }
}

/// Signature scheme for replayed Responses reasoning items. Two encodings
/// coexist so existing session files stay byte-stable (the v0.4.24 prompt-cache
/// contract):
/// - **v2** (current): `{PREFIX}v2:{"model":"<id>","items":[...]}`. The model
///   that produced the encrypted items is embedded so a later turn on a
///   *different* model drops them on decode instead of replaying reasoning the
///   new model cannot decrypt (the Responses API answers 400).
/// - **v1** (legacy): `{PREFIX}[...]`, a bare item array with no model tag.
///   Still replayed as-is — rewriting these blocks would change already-sent
///   historical bytes and invalidate the provider's prefix cache. The runtime
///   reasoning-item self-heal ([`is_reasoning_item_rejected`]) covers any v1
///   cross-model rejection.
const OPENAI_RESPONSES_REASONING_SIGNATURE_PREFIX: &str = "openai-responses-reasoning:";
const OPENAI_RESPONSES_REASONING_V2_TAG: &str = "v2:";

/// Marker signature for a `reasoning_content`-family (Kimi/Moonshot, MiMo,
/// DeepSeek-R1) reasoning block. Unlike the Responses encrypted signature, the
/// text *is* the payload — this prefix only tags a persisted Thinking block as
/// "replay me as `reasoning_content` on the chat transport". An empty signature
/// marks a display-only thinking block that is never replayed on any transport.
const OPENAI_REASONING_CONTENT_SIGNATURE: &str = "openai-reasoning-content:";

/// Per-turn reasoning size cap (chars; rough proxy for tokens ~4:1). Captures
/// up to ~8K tokens of thinking per assistant turn before truncating, so a
/// single runaway reasoning trace cannot bloat the persisted session block. Long
/// reasoning still streams to the UI in real time; only what is *persisted* for
/// replay/display is capped.
const MAX_REASONING_CHARS_PER_TURN: usize = 32_000;

/// Total `reasoning_content` replay budget across all assistant turns in one
/// request (chars). Enforced at request-build time in [`convert_messages_openai`]:
/// oldest turns get `reasoning_content` first and the newest are dropped once the
/// budget is spent. This keeps already-sent historical bytes stable (preserving
/// the provider's automatic prefix cache) while bounding how much reasoning a
/// long session replays every turn. ~32K tokens for ASCII; multi-byte trims
/// faster (a conservative bound for non-ASCII reasoning).
const MAX_REASONING_CONTENT_REPLAY_CHARS: usize = 128_000;

/// Which OpenAI-compatible transport to use for a request.
///
/// v0.4.24: the endpoint is no longer implied by the base URL. Gateways
/// differ per *model* — on one self-hosted new-api deployment `gpt-5.6-*`
/// proxies `/v1/responses` natively while `MiniMax-M3` answers
/// `convert_request_failed` and Kimi/MiMo 404 — so the choice is a
/// per-(server, model) capability, configurable and probed, not a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OpenAiTransport {
    /// Infer from the model: GPT-5/GPT-6/o-series tool flows prefer
    /// `/v1/responses` on official and compatible endpoints; a rejected
    /// Responses request is learned and falls back to Chat Completions.
    #[default]
    Auto,
    ChatCompletions,
    Responses,
}

impl OpenAiTransport {
    /// Parse a Settings/config value. Unknown or empty values fall back to
    /// [`OpenAiTransport::Auto`] so a hand-edited config can never wedge a
    /// provider into an endpoint it does not serve.
    #[must_use]
    pub fn from_config_value(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "responses" => Self::Responses,
            "chat" | "chat_completions" | "chat-completions" => Self::ChatCompletions,
            _ => Self::Auto,
        }
    }

    #[must_use]
    pub fn as_config_value(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::ChatCompletions => "chat_completions",
            Self::Responses => "responses",
        }
    }
}

/// The `Auto` heuristic: known Responses-capable tool flows prefer the native
/// protocol on their compatible gateway. DeepSeek V4 Pro and the paid Flash
/// route serve this endpoint too; the OpenCode-hosted free Flash route is
/// Chat-Completions-only and is handled by [`requires_chat_completions`].
fn requires_chat_completions(model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase();
    model == "deepseek-v4-flash-free"
        || model.ends_with("/deepseek-v4-flash-free")
        || model.ends_with(":deepseek-v4-flash-free")
}

#[must_use]
fn uses_openai_responses_api(_base_url: &str, model: &str, enable_tools: bool) -> bool {
    let m = model.to_ascii_lowercase();
    let openai_responses_model = word_match(&m, "o1")
        || word_match(&m, "o3")
        || word_match(&m, "o4")
        || m.contains("gpt-5")
        || m.contains("gpt-6");
    let deepseek_responses_model = matches!(m.as_str(), "deepseek-v4-pro" | "deepseek-v4-flash");
    enable_tools && (openai_responses_model || deepseek_responses_model)
}

/// Why [`resolve_transport`] chose the endpoint it did. Surfaced in the
/// `llm.request` wire trace so "why did this turn use chat/completions?" is a
/// log lookup instead of a guess — the single most confusing part of the
/// per-(server, model) transport story.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransportReason {
    /// The selected model only accepts Chat Completions. This deliberately
    /// overrides a stale persisted or manually forced Responses preference.
    ModelRequiresChatCompletions,
    /// A prior `/v1/responses` request on this pair was rejected; learned.
    LearnedResponsesUnsupported,
    /// A prior chat request on this pair was told to use `/v1/responses`; learned.
    LearnedRequiresResponses,
    /// Explicit Settings/config preference for `/v1/responses`.
    ConfiguredResponses,
    /// Explicit Settings/config preference for `/v1/chat/completions`.
    ConfiguredChat,
    /// No learned fact or preference — the model+tools `Auto` heuristic decided.
    AutoHeuristic,
}

impl TransportReason {
    #[must_use]
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ModelRequiresChatCompletions => "model_requires_chat_completions",
            Self::LearnedResponsesUnsupported => "learned_responses_unsupported",
            Self::LearnedRequiresResponses => "learned_requires_responses",
            Self::ConfiguredResponses => "configured_responses",
            Self::ConfiguredChat => "configured_chat",
            Self::AutoHeuristic => "auto_heuristic",
        }
    }
}

/// Resolve the transport for one request, honouring (in order): a
/// process-learned "this server/model does not serve /v1/responses" fact, the
/// symmetric "this pair requires /v1/responses" fact, the configured
/// preference, and finally the `Auto` heuristic. Returns the decision plus the
/// reason for it (for the wire trace).
#[must_use]
fn resolve_transport(
    configured: OpenAiTransport,
    base_url: &str,
    model: &str,
    enable_tools: bool,
) -> (bool, TransportReason) {
    // `deepseek-v4-flash-free` is served by OpenCode's OpenAI Chat
    // Completions-compatible endpoint. Routing it through `/v1/responses`
    // makes the gateway translate our local history into its internal
    // `messages` representation, where it rejects history items without its
    // own opaque ids. Do not allow a stale setting or diagnostic override to
    // reintroduce that incompatible translation path.
    if requires_chat_completions(model) {
        return (false, TransportReason::ModelRequiresChatCompletions);
    }
    // Diagnostics and compatibility probes may force one protocol for a
    // process without mutating the persisted Settings selection.
    if let Ok(raw) = std::env::var("ARIS_OPENAI_TRANSPORT") {
        match OpenAiTransport::from_config_value(&raw) {
            OpenAiTransport::ChatCompletions => {
                return (false, TransportReason::ConfiguredChat);
            }
            OpenAiTransport::Responses => {
                return (true, TransportReason::ConfiguredResponses);
            }
            OpenAiTransport::Auto => {}
        }
    }
    if responses_known_unsupported(base_url, model) {
        return (false, TransportReason::LearnedResponsesUnsupported);
    }
    if chat_known_requires_responses(base_url, model) {
        return (true, TransportReason::LearnedRequiresResponses);
    }
    match configured {
        OpenAiTransport::Responses => (true, TransportReason::ConfiguredResponses),
        OpenAiTransport::ChatCompletions => (false, TransportReason::ConfiguredChat),
        OpenAiTransport::Auto => (
            uses_openai_responses_api(base_url, model, enable_tools),
            TransportReason::AutoHeuristic,
        ),
    }
}

fn transport_registry_key(base_url: &str, model: &str) -> String {
    format!(
        "{}|{}",
        base_url.trim().trim_end_matches('/').to_ascii_lowercase(),
        model.to_ascii_lowercase()
    )
}

/// Callback invoked when the runtime *learns* a `(base_url, model)` transport
/// verdict — a `/v1/responses` request fell back to chat/completions, or a chat
/// request was told to use responses. The desktop app registers this to persist
/// the verdict into its verified-executor registry so the Settings badge and the
/// next launch reflect the endpoint actually used, instead of re-probing on the
/// first request of every process. `verdict` is `"responses"` or
/// `"chat_completions"`. CLI leaves it unset (process registry alone suffices).
type TransportVerdictHook = Box<dyn Fn(&str, &str, &str) + Send + Sync>;

fn transport_verdict_hook() -> &'static std::sync::OnceLock<TransportVerdictHook> {
    static HOOK: std::sync::OnceLock<TransportVerdictHook> = std::sync::OnceLock::new();
    &HOOK
}

/// Register the transport-verdict persistence callback. First registration
/// wins; later calls are ignored (idempotent across runtime re-inits).
pub fn set_transport_verdict_hook(hook: TransportVerdictHook) {
    let _ = transport_verdict_hook().set(hook);
}

fn record_transport_verdict(base_url: &str, model: &str, verdict: &str) {
    if let Some(hook) = transport_verdict_hook().get() {
        hook(base_url, model, verdict);
    }
}

/// Process-wide set of `(server, model)` pairs observed to reject
/// `/v1/responses`. Populated by the runtime fallback so a gateway that
/// cannot convert the request is asked exactly once per process instead of
/// once per turn. Deliberately *not* persisted here (the desktop hook handles
/// durable persistence): a gateway upgrade restores the preferred transport on
/// next launch via Settings re-probe rather than a stale process fact.
fn responses_unsupported_registry() -> &'static std::sync::Mutex<std::collections::HashSet<String>>
{
    static REGISTRY: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

fn responses_known_unsupported(base_url: &str, model: &str) -> bool {
    responses_unsupported_registry()
        .lock()
        .is_ok_and(|registry| registry.contains(&transport_registry_key(base_url, model)))
}

fn mark_responses_unsupported(base_url: &str, model: &str) {
    if let Ok(mut registry) = responses_unsupported_registry().lock() {
        registry.insert(transport_registry_key(base_url, model));
    }
    record_transport_verdict(base_url, model, "chat_completions");
}

/// Symmetric to [`responses_unsupported_registry`]: `(server, model)` pairs a
/// chat/completions request was told to serve via `/v1/responses` instead
/// (official OpenAI's gate on gpt-5.5+/o-series tool flows, forwarded by a
/// gateway). Learned once per process so the reverse fallback fires at most one
/// wasted round-trip, then every later turn starts on responses directly.
fn chat_requires_responses_registry() -> &'static std::sync::Mutex<std::collections::HashSet<String>>
{
    static REGISTRY: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

fn chat_known_requires_responses(base_url: &str, model: &str) -> bool {
    chat_requires_responses_registry()
        .lock()
        .is_ok_and(|registry| registry.contains(&transport_registry_key(base_url, model)))
}

fn mark_chat_requires_responses(base_url: &str, model: &str) {
    if let Ok(mut registry) = chat_requires_responses_registry().lock() {
        registry.insert(transport_registry_key(base_url, model));
    }
    record_transport_verdict(base_url, model, "responses");
}

/// Whether a failed `/v1/chat/completions` POST means "this model must use
/// `/v1/responses` instead" — the official OpenAI gate on gpt-5.5+/o-series tool
/// flows, which a gateway may forward verbatim. Symmetric to
/// [`responses_transport_unsupported`]: lets a chat request the backend insists
/// is responses-only retry there rather than hard-failing every turn.
///
/// Narrow: only a 400 that explicitly points at `/v1/responses`, or pairs
/// `reasoning_effort`/`function`+`tools` with a "not supported" verdict, so a
/// generic 400 is never mistaken for a transport problem.
#[must_use]
pub fn chat_requires_responses_transport(status: u16, body: &str) -> bool {
    if status != 400 {
        return false;
    }
    let lower = body.to_ascii_lowercase();
    if lower.contains("/v1/responses") || lower.contains("use responses") {
        return true;
    }
    let not_supported = lower.contains("not supported") || lower.contains("unsupported");
    not_supported
        && lower.contains("responses")
        && (lower.contains("reasoning_effort")
            || lower.contains("reasoning effort")
            || (lower.contains("function") && lower.contains("tool")))
}

/// Whether a failed `/v1/responses` POST means "this endpoint is not served
/// here" (so the request should be retried on `/v1/chat/completions`) rather
/// than a genuine request/auth/quota error.
///
/// Deliberately narrow. Observed gateway shapes:
/// - `404` — the route does not exist, or the upstream 404s the conversion
///   (new-api: `bad_response_status_code`).
/// - `501` — explicit "not implemented".
/// - `500` with `convert_request_failed` / "not implemented" — new-api
///   accepted the route but has no chat→responses converter for this
///   upstream.
///
/// A generic 4xx/5xx with no such marker is NOT treated as a transport
/// problem: falling back on those would silently mask real failures (bad
/// key, quota, malformed tool schema) and hide them behind a second request.
#[must_use]
pub fn responses_transport_unsupported(status: u16, body: &str) -> bool {
    if status == 404 || status == 501 {
        return true;
    }
    let lower = body.to_ascii_lowercase();
    const MARKERS: &[&str] = &[
        "convert_request_failed",
        "not implemented",
        "not_implemented",
        "unsupported endpoint",
        "unknown path",
        "invalid url",
        "no such endpoint",
    ];
    MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Whether a `/v1/responses` 400 blames a *replayed reasoning item* rather than
/// the caller's actual request. Two shapes drive the runtime self-heal (strip
/// reasoning items from `input`, retry once):
/// - **Ordering**: "Item 'rs_…' of type 'reasoning' was provided without its
///   required following item." — the encrypted item's paired output item is not
///   adjacent (a multi-tool turn, or a hand-edited session).
/// - **Cross-model / stale**: `encrypted_content` the current model cannot
///   decrypt (a v1 signature replayed after a model switch — v2 signatures are
///   dropped on decode, so this only reaches the wire for legacy blocks).
///
/// Deliberately strict: the message must mention reasoning/encrypted content
/// AND carry a structural marker, so an unrelated 400 (bad tool schema, quota,
/// context overflow) is never masked behind a second request. Prefers the
/// structured `error.message`; falls back to the raw body only when it will not
/// parse as JSON.
#[must_use]
pub(crate) fn is_reasoning_item_rejected(body: &str) -> bool {
    if body.is_empty() {
        return false;
    }
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|json| {
            json.get("error")
                .and_then(|error| error.get("message"))
                .and_then(|message| message.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.to_string());
    let lower = message.to_ascii_lowercase();
    if !lower.contains("reasoning") && !lower.contains("encrypted") {
        return false;
    }
    const MARKERS: &[&str] = &[
        "required following item",
        "without its required",
        "provided without",
        "must be followed by",
        "following item",
        "decrypt",
        "encrypted_content",
        "reasoning item",
        "reasoning input item",
    ];
    MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Remove every `type == "reasoning"` entry from a `/v1/responses` request
/// body's `input` array. Returns whether anything was removed, so the send loop
/// only retries when the body actually changed (and the retry cannot loop).
fn strip_reasoning_items_from_responses_body(body: &mut Value) -> bool {
    let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) else {
        return false;
    };
    let before = input.len();
    input.retain(|item| item.get("type").and_then(Value::as_str) != Some("reasoning"));
    before != input.len()
}

/// v0.4.12 P1.C — detect a 400 response whose error body actually fingers
/// `stream_options` as an unknown/extra/unsupported field. Used by the
/// streaming chat completion call to decide whether to retry once without
/// the `stream_options.include_usage` opt-in (compat-mode proxies that
/// reject unknown body fields).
///
/// Strict match to avoid swallowing unrelated 400s:
/// 1. Try JSON-parse the body and check `error.param` starts with
///    `stream_options` (covers `stream_options.include_usage` deep path).
/// 2. Otherwise fall back to substring scan requiring **both** the
///    `stream_options` keyword and at least one rejection keyword
///    (`unknown` / `unrecognized` / `extra` / `additional` / `unsupported`)
///    in the same body.
fn is_stream_options_unknown_field_error(body: &str) -> bool {
    if body.is_empty() {
        return false;
    }
    if let Ok(json) = serde_json::from_str::<Value>(body) {
        if let Some(param) = json
            .get("error")
            .and_then(|e| e.get("param"))
            .and_then(|p| p.as_str())
        {
            if param.starts_with("stream_options") {
                return true;
            }
        }
    }
    let lower = body.to_ascii_lowercase();
    if !lower.contains("stream_options") {
        return false;
    }
    const REJECT_KEYWORDS: &[&str] = &[
        "unknown",
        "unrecognized",
        "extra",
        "additional",
        "unsupported",
        "not allowed",
        "invalid field",
    ];
    REJECT_KEYWORDS.iter().any(|kw| lower.contains(kw))
}

/// Detect a 4xx response whose error body indicates the request exceeded the
/// model's context window. Providers phrase this many ways:
/// - OpenAI: `code: "context_length_exceeded"` / "maximum context length …"
/// - Anthropic-style proxies: "prompt is too long"
/// - Chinese providers (GLM/MiniMax/Moonshot/Qwen and gmncode-style proxies):
///   "context window exceeds limit", "上下文长度超过限制", "tokens exceed"
///
/// When matched, the executor tags the error so the conversation loop
/// force-compacts and retries instead of failing the whole turn.
///
/// Strict enough to avoid swallowing unrelated 400s: first try the structured
/// `error.code`, then fall back to a substring scan that requires a
/// context keyword paired with an over-limit keyword.  Generic token wording
/// is deliberately excluded from that fallback: providers also use it for
/// quota and rate-limit errors, where compacting would discard useful context.
pub(crate) fn is_context_window_exceeded_error(body: &str) -> bool {
    if body.is_empty() {
        return false;
    }
    if let Ok(json) = serde_json::from_str::<Value>(body) {
        if let Some(code) = json
            .get("error")
            .and_then(|e| e.get("code"))
            .and_then(|c| c.as_str())
        {
            if code.eq_ignore_ascii_case("context_length_exceeded") {
                return true;
            }
        }
    }
    let lower = body.to_ascii_lowercase();
    // Canonical phrasings that are unambiguous on their own.
    const DIRECT_PHRASES: &[&str] = &[
        "context window exceeds",
        "context length exceeded",
        "context_length_exceeded",
        "maximum context length",
        "exceeds the maximum context",
        "prompt is too long",
        "reduce the length of the messages",
        "number of tokens exceeds the model limit",
        "tokens exceed the model limit",
    ];
    if DIRECT_PHRASES.iter().any(|p| lower.contains(p)) {
        return true;
    }
    // Looser fallback: a context/length subject paired with an
    // over-limit verb in the same body. `上下文` (Chinese "context") is a
    // subject here rather than a standalone phrase — on its own it matches
    // unrelated errors ("上下文加载失败") and would misfire force-compaction; it
    // must co-occur with an over-limit verb (`超过`/`过长`) to count.
    const SUBJECT: &[&str] = &["context window", "context length", "上下文"];
    const OVER_LIMIT: &[&str] = &[
        "exceed",
        "too long",
        "too many",
        "over the limit",
        "超过",
        "过长",
    ];
    SUBJECT.iter().any(|s| lower.contains(s)) && OVER_LIMIT.iter().any(|o| lower.contains(o))
}

/// v0.4.12 P1.B — word-boundary match (treats `-`, `_`, `/`, `:` and start /
/// end of string as boundaries). Mirrors `runtime::usage::has_word` so the
/// executor's capability detection stays consistent with the pricing table.
pub(crate) fn word_match(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let nbytes = needle.as_bytes();
    if nbytes.is_empty() || bytes.len() < nbytes.len() {
        return false;
    }
    let is_boundary = |b: u8| matches!(b, b'-' | b'_' | b'/' | b':');
    let mut i = 0;
    while i + nbytes.len() <= bytes.len() {
        if &bytes[i..i + nbytes.len()] == nbytes {
            let before_ok = i == 0 || is_boundary(bytes[i - 1]);
            let after_idx = i + nbytes.len();
            let after_ok = after_idx == bytes.len() || is_boundary(bytes[after_idx]);
            if before_ok && after_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// Whether this model accepts `reasoning_content` as a *request* field on
/// assistant messages, so reasoning captured from its responses should be
/// cached and replayed on subsequent requests. Limited to the families
/// whose OpenAI-compatible APIs document that convention: Kimi/Moonshot
/// interleaved thinking, Xiaomi MiMo, DeepSeek V4/R1/reasoner, and explicit
/// thinking/reasoner variant aliases.
///
/// v0.4.24 (prompt-cache audit): no longer a superset of
/// [`supports_reasoning_effort`]. OpenAI o-series / gpt-5.x never accept
/// `reasoning_content` as input — on the official endpoint tool flows use
/// the Responses API (whose raw reasoning items are persisted in signed
/// Thinking blocks), and on OpenAI-compatible proxies the
/// attached field is dropped upstream while its appear/disappear churn
/// rewrote historical message bytes and broke provider prefix caching
/// (wire-log data: gpt-5.6 sessions at ~48% cache hit vs 95%+ for
/// non-replay models over the same gateway).
#[must_use]
fn supports_reasoning_content_replay(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.contains("kimi")
        || m.contains("moonshot")
        || m.contains("mimo")
        || m.contains("deepseek-v4")
        || m.contains("deepseek-r1")
        || m.contains("-r1")
        || m.contains("reasoner")
        || m.contains("thinking")
}

/// Reasoning level to send alongside `model`, already clamped to what that
/// model accepts. `None` when the model takes no level at all.
///
/// The configured level is a *wish*: it is global across models, so a level
/// one model has and another doesn't (`max`, `xhigh`, `none`) has to be
/// narrowed per request rather than rejected at the point it was chosen.
#[must_use]
fn reasoning_level_for(model: &str) -> Option<&'static str> {
    crate::reasoning_effort::closest_level(model, &crate::reasoning_effort::configured_level())
}

/// Number of whole-stream restarts to attempt when chunk read fails (or
/// returns a premature EOF) before any event has been emitted. Closes
/// C6 landmine on the OpenAI executor path. Mirrors the same env knob
/// used by the Anthropic api crate. Default 2, clamped 0..=5. Parses
/// as u32 first so `ARIS_STREAM_RETRY=999` doesn't silently fall back
/// to the default (would happen with direct `u8` parse).
fn stream_retry_budget() -> u8 {
    let raw = std::env::var("ARIS_STREAM_RETRY")
        .ok()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(2);
    raw.min(5) as u8
}

/// Whether a reqwest::Error from `response.chunk()` represents a
/// transient mid-body failure that warrants a whole-stream restart.
fn stream_chunk_error_is_retryable(error: &reqwest::Error) -> bool {
    error.is_request()
        || error.is_connect()
        || error.is_timeout()
        || error.is_body()
        || error.is_decode()
}

/// What to do when an OpenAI-compatible stream hits a clean EOF
/// (`response.chunk()` returned `Ok(None)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamEofAction {
    /// A terminal signal arrived — break the loop and let the
    /// `Ensure MessageStop` fallback synthesize the terminal event.
    Complete,
    /// Nothing meaningful was emitted yet and restart budget remains —
    /// re-send the whole request (a proxy likely closed the connection
    /// before producing any output).
    Restart,
    /// Content was already emitted but no terminal signal arrived — the
    /// stream was cut mid-response. Hard error.
    Truncated,
}

/// Decide how to treat a clean stream EOF. Extracted as a pure function
/// so the completion-vs-truncation decision is unit-testable (the live
/// loop needs an HTTP body).
///
/// A response is **complete** when *either* terminal signal arrived:
/// - `observed_done` — the `data: [DONE]` SSE sentinel (OpenAI canonical), or
/// - `observed_finish_reason` — a non-empty `choices[].finish_reason`, which
///   the Chat Completions spec defines as the model's terminal chunk.
///
/// Many OpenAI-compatible providers (MiniMax — issue #249, and others)
/// send `finish_reason: "stop"` but never emit `[DONE]`. Requiring
/// `[DONE]` alone misreported every successful completion as a
/// truncation. We accept either signal; only when NEITHER arrived do we
/// fall back to the emitted-content heuristic (restart if nothing was
/// emitted and budget remains, otherwise treat as a genuine mid-response
/// truncation). Crucially this only relaxes how a *clean* EOF is judged —
/// reads are never stopped early at `finish_reason`, so a trailing
/// usage-only chunk (`stream_options.include_usage`) is still consumed.
fn stream_eof_action(
    observed_done: bool,
    observed_finish_reason: bool,
    nothing_emitted: bool,
    retries_remaining: u8,
) -> StreamEofAction {
    if observed_done || observed_finish_reason {
        return StreamEofAction::Complete;
    }
    if nothing_emitted && retries_remaining > 0 {
        return StreamEofAction::Restart;
    }
    StreamEofAction::Truncated
}

fn token_usage_from_openai_usage(usage: &Value) -> TokenUsage {
    let prompt_tokens = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let output_tokens = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let details = usage
        .get("prompt_tokens_details")
        .or_else(|| usage.get("input_tokens_details"));
    let cached_tokens = details
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    // The Responses API additionally reports how much of the prompt was
    // *written* into the cache this turn (`cache_write_tokens`); chat
    // completions has no equivalent and leaves this 0. It is part of
    // `prompt_tokens` like the cached portion, so it moves out of fresh input
    // into the Anthropic-style cache_creation bucket rather than being added.
    // Clamped to the room left after cache reads. `cached_tokens` and
    // `cache_write_tokens` are meant to be disjoint slices of the prompt, but
    // gateways vary and some report the whole cached prefix in both. Without
    // the clamp an overlap inflates `TokenUsage::prompt_tokens()` (input +
    // creation + read) above the real prompt, and that value drives the
    // auto-compaction budget — an inflated reading silently compacts a session
    // that is only half full.
    let cache_write_tokens = details
        .and_then(|d| d.get("cache_write_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let cache_write_tokens = cache_write_tokens.min(prompt_tokens.saturating_sub(cached_tokens));

    // OpenAI-compatible usage reports `prompt_tokens` as cache-inclusive.
    // ARIS stores provider usage in Anthropic-style normalized form: fresh
    // input is separate from cache reads, so input + cache_read == real prompt
    // occupancy without double-counting cache tokens in cost summaries.
    TokenUsage {
        input_tokens: prompt_tokens
            .saturating_sub(cached_tokens)
            .saturating_sub(cache_write_tokens),
        output_tokens,
        cache_creation_input_tokens: cache_write_tokens,
        cache_read_input_tokens: cached_tokens,
    }
}

/// Detail of a mid-stream error envelope, if a parsed SSE `data:` object
/// carries a non-null top-level `error` (OE4 / #249). Returns `None` for a
/// normal data chunk. Only message + code/type are surfaced — never the
/// whole envelope — so nothing the provider may have reflected leaks into
/// logs. `code` is read as either a string or an integer (providers vary).
fn stream_error_detail(parsed: &Value) -> Option<String> {
    let err = parsed.get("error")?;
    if err.is_null() {
        return None;
    }
    // Some proxies send a bare string `"error": "..."`.
    if let Some(s) = err.as_str() {
        return Some(s.to_string());
    }
    let msg = err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("(no message)");
    let code = err
        .get("code")
        .and_then(|c| {
            c.as_str()
                .map(str::to_string)
                .or_else(|| c.as_i64().map(|n| n.to_string()))
        })
        .or_else(|| err.get("type").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_default();
    if code.is_empty() {
        Some(msg.to_string())
    } else {
        Some(format!("{msg} ({code})"))
    }
}

fn responses_stream_error_detail(parsed: &Value) -> Option<String> {
    if parsed.get("type").and_then(Value::as_str) != Some("response.failed") {
        return None;
    }
    let error = parsed.get("response")?.get("error")?;
    if error.is_null() {
        return Some("Responses API reported a failed response".to_string());
    }
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Responses API reported a failed response");
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| error.get("type").and_then(Value::as_str));
    Some(match code {
        Some(code) => format!("{message} ({code})"),
        None => message.to_string(),
    })
}

fn responses_tool_call_from_output_item(item: &Value) -> Option<(String, String, String)> {
    if item.get("type").and_then(Value::as_str) != Some("function_call") {
        return None;
    }
    let id = item
        .get("call_id")
        .and_then(Value::as_str)
        .or_else(|| item.get("id").and_then(Value::as_str))?
        .to_string();
    let name = item.get("name").and_then(Value::as_str)?.to_string();
    let arguments = item
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}")
        .to_string();
    Some((id, name, arguments))
}

#[derive(Debug)]
struct ResponsesInflightTool {
    item_id: Option<String>,
    output_index: Option<u64>,
    call_id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Default)]
struct ResponsesRecoveredTools {
    calls: Vec<(String, String, String)>,
    invalid_count: usize,
}

/// Compatibility accumulator for Responses gateways that stream function-call
/// arguments but omit `response.function_call_arguments.done` and
/// `response.output_item.done` before `response.completed`.
///
/// Canonical Responses streams are still finalized from `output_item.done`.
/// The accumulator only becomes the source of a tool call at completion when
/// the buffered arguments form valid JSON. Matching prefers stable item/call
/// ids, then falls back to the most recently added item because some gateways
/// incorrectly reuse `output_index: 0` for every tool in a response.
#[derive(Debug, Default)]
struct ResponsesToolAccumulator {
    inflight: Vec<ResponsesInflightTool>,
}

impl ResponsesToolAccumulator {
    fn observe_output_item_added(&mut self, event: &Value) {
        let Some(item) = event.get("item") else {
            return;
        };
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return;
        }
        let Some(call_id) = item
            .get("call_id")
            .and_then(Value::as_str)
            .or_else(|| item.get("id").and_then(Value::as_str))
        else {
            return;
        };
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            return;
        };
        let item_id = item.get("id").and_then(Value::as_str).map(str::to_string);
        let output_index = event.get("output_index").and_then(Value::as_u64);
        let arguments = item
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        if let Some(existing) = self
            .inflight
            .iter_mut()
            .find(|tool| tool.call_id == call_id)
        {
            existing.item_id = item_id;
            existing.output_index = output_index;
            existing.name = name.to_string();
            if !arguments.is_empty() {
                existing.arguments = arguments;
            }
            return;
        }

        self.inflight.push(ResponsesInflightTool {
            item_id,
            output_index,
            call_id: call_id.to_string(),
            name: name.to_string(),
            arguments,
        });
    }

    fn observe_arguments_delta(&mut self, event: &Value) {
        let Some(delta) = event.get("delta").and_then(Value::as_str) else {
            return;
        };
        if let Some(index) = self.matching_index(event, None) {
            self.inflight[index].arguments.push_str(delta);
        }
    }

    fn observe_arguments_done(&mut self, event: &Value) {
        let Some(arguments) = event.get("arguments").and_then(Value::as_str) else {
            return;
        };
        if let Some(index) = self.matching_index(event, None) {
            self.inflight[index].arguments = arguments.to_string();
        }
    }

    fn observe_output_item_done(&mut self, event: &Value) -> Option<(String, String, String)> {
        let item = event.get("item")?;
        let call = responses_tool_call_from_output_item(item)?;
        if let Some(index) = self.matching_index(event, Some(&call.0)) {
            self.inflight.remove(index);
        }
        Some(call)
    }

    fn drain_completed_fallback(&mut self) -> ResponsesRecoveredTools {
        let mut recovered = ResponsesRecoveredTools::default();
        for tool in self.inflight.drain(..) {
            let arguments = tool.arguments;
            if arguments.trim().is_empty() {
                recovered.invalid_count += 1;
                continue;
            }
            if serde_json::from_str::<Value>(&arguments).is_ok() {
                recovered.calls.push((tool.call_id, tool.name, arguments));
            } else {
                recovered.invalid_count += 1;
            }
        }
        recovered
    }

    fn clear(&mut self) {
        self.inflight.clear();
    }

    fn matching_index(&self, event: &Value, call_id: Option<&str>) -> Option<usize> {
        if let Some(call_id) = call_id {
            return self
                .inflight
                .iter()
                .rposition(|tool| tool.call_id == call_id);
        }

        let item_id = event.get("item_id").and_then(Value::as_str).or_else(|| {
            event
                .get("item")
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str)
        });
        if let Some(item_id) = item_id {
            return self.inflight.iter().rposition(|tool| {
                tool.item_id.as_deref() == Some(item_id) || tool.call_id == item_id
            });
        }

        if let Some(output_index) = event.get("output_index").and_then(Value::as_u64) {
            if let Some(index) = self
                .inflight
                .iter()
                .rposition(|tool| tool.output_index == Some(output_index))
            {
                return Some(index);
            }
        }

        self.inflight.len().checked_sub(1)
    }
}

fn push_unique_tool_call(
    pending_tools: &mut Vec<(String, String, String)>,
    tool_call: (String, String, String),
) {
    if let Some(existing) = pending_tools
        .iter_mut()
        .find(|(id, _, _)| id == &tool_call.0)
    {
        *existing = tool_call;
    } else {
        pending_tools.push(tool_call);
    }
}

fn endpoint_for_transport(use_responses_api: bool) -> &'static str {
    if use_responses_api {
        "/responses"
    } else {
        "/chat/completions"
    }
}

fn transport_label(use_responses_api: bool) -> &'static str {
    if use_responses_api {
        "responses"
    } else {
        "chat_completions"
    }
}

/// The `reasoning_effort` value to send on the chat/completions transport,
/// or `None` when it must be omitted.
///
/// OpenAI gate (v0.4.8): when both `tools` and `reasoning_effort` are present,
/// gpt-5.5+ on the official `/v1/chat/completions` returns 400 "Function tools
/// with reasoning_effort are not supported …, please use /v1/responses
/// instead". Third-party proxies without that restriction opt back in with
/// `ARIS_FORCE_REASONING_WITH_TOOLS=1`. On the Responses transport the effort
/// travels in `reasoning.effort` instead, so this is never consulted there.
fn chat_reasoning_effort_for(model: &str, base_url: &str, enable_tools: bool) -> Option<String> {
    let model_lower = model.to_ascii_lowercase();
    let blocked = enable_tools
        && base_url.contains("api.openai.com")
        && (model_lower.contains("gpt-5.5")
            || model_lower.contains("gpt-5.6")
            || model_lower.contains("gpt-6")
            || word_match(&model_lower, "o3")
            || word_match(&model_lower, "o4"));
    let force_with_tools = std::env::var("ARIS_FORCE_REASONING_WITH_TOOLS")
        .ok()
        .as_deref()
        == Some("1");
    if !blocked || force_with_tools {
        if let Some(level) = reasoning_level_for(model) {
            return Some(level.to_string());
        }
    }
    if blocked && !force_with_tools {
        // One-shot warning per process so users understand why their gpt-5.5
        // executor is running at default reasoning. Stderr to avoid polluting
        // stdout JSON parsers.
        static WARNED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        WARNED.get_or_init(|| {
            eprintln!(
                "\x1b[33mwarning:\x1b[0m {model} as executor on OpenAI does not accept \
`reasoning_effort` when tools are enabled (OpenAI /v1/chat/completions returns 400). \
Continuing without reasoning_effort. Set ARIS_FORCE_REASONING_WITH_TOOLS=1 to override \
on a compatible third-party proxy, or select the Responses transport for this model."
            );
        });
    }
    None
}

/// Build a `/v1/chat/completions` request body. Kept a free function so the
/// transport fallback can rebuild it mid-request without re-borrowing the
/// client.
fn build_chat_completions_body(
    model: &str,
    messages: Vec<Value>,
    tool_specs: &[ExecutorToolSpec],
    enable_tools: bool,
    reasoning_effort_value: Option<String>,
) -> Value {
    let mut body = json!({
        "model": model,
        "stream": true,
        // v0.4.10 T35: OpenAI Chat Completions does NOT emit `usage` in
        // streaming chunks by default. Opt in with
        // `stream_options.include_usage = true` so we can read
        // `prompt_tokens_details.cached_tokens` (automatic prefix cache hits)
        // and report token cost accurately.
        "stream_options": { "include_usage": true },
        "messages": messages,
    });
    if enable_tools {
        body["tools"] = json!(tool_specs
            .iter()
            .map(convert_tool_spec_openai)
            .collect::<Vec<_>>());
        body["tool_choice"] = json!("auto");
    }
    if let Some(effort) = reasoning_effort_value {
        body["reasoning_effort"] = json!(effort);
    }
    if let Some(max_tokens) = openai_max_tokens_override() {
        body["max_tokens"] = json!(max_tokens);
    }
    if non_stream_compat_enabled() {
        body["stream"] = Value::Bool(false);
        if let Some(object) = body.as_object_mut() {
            object.remove("stream_options");
        }
    }
    body
}

fn non_stream_compat_enabled() -> bool {
    std::env::var("ARIS_OPENAI_NON_STREAM")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

/// Optional output-token cap for OpenAI-compatible gateways whose default
/// budget is much larger than the task needs. Kept opt-in so normal provider
/// behavior remains unchanged; useful for bounded benchmark runs against
/// proxies that otherwise spend many minutes in reasoning mode.
fn openai_max_tokens_override() -> Option<u32> {
    std::env::var("ARIS_OPENAI_MAX_TOKENS")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
}

fn parse_non_stream_chat_response(
    body: &str,
    model: &str,
    observer: &mut dyn StreamObserver,
) -> Result<Vec<AssistantEvent>, RuntimeError> {
    let parsed = serde_json::from_str::<Value>(body).map_err(|error| {
        RuntimeError::new(format!("OpenAI non-stream response was not JSON: {error}"))
    })?;
    if let Some(error) = parsed.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("OpenAI non-stream response reported an error");
        return Err(RuntimeError::new(message.to_string()));
    }
    let choice = parsed
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| RuntimeError::new("OpenAI non-stream response has no choices"))?;
    let message = choice
        .get("message")
        .ok_or_else(|| RuntimeError::new("OpenAI non-stream response has no message"))?;
    let mut events = Vec::new();
    if let Some(reasoning) = message.get("reasoning_content").and_then(Value::as_str) {
        if !reasoning.is_empty() {
            observer.on_thinking_delta(reasoning)?;
            events.push(AssistantEvent::Thinking {
                thinking: reasoning.to_string(),
                signature: if supports_reasoning_content_replay(model) {
                    OPENAI_REASONING_CONTENT_SIGNATURE.to_string()
                } else {
                    String::new()
                },
            });
        }
    }
    if let Some(content) = message.get("content").and_then(Value::as_str) {
        if !content.is_empty() {
            observer.on_text_delta(content)?;
            events.push(AssistantEvent::TextDelta(content.to_string()));
        }
    }
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for (index, tool_call) in tool_calls.iter().enumerate() {
            let id = tool_call
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("call_aris_{index}"));
            let function = tool_call.get("function").unwrap_or(&Value::Null);
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown_tool")
                .to_string();
            let input = function
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}")
                .to_string();
            observer.on_tool_call(&id, &name, &input)?;
            events.push(AssistantEvent::ToolUse { id, name, input });
        }
    }
    if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
        if !reason.is_empty() {
            events.push(AssistantEvent::StopReason(reason.to_string()));
        }
    }
    if let Some(usage) = parsed.get("usage") {
        events.push(AssistantEvent::Usage(token_usage_from_openai_usage(usage)));
    }
    observer.on_message_stop()?;
    events.push(AssistantEvent::MessageStop);
    Ok(events)
}

/// Build a `/v1/responses` request body.
///
/// `store: false` is deliberate: ARIS owns conversation state locally
/// (compaction, stop+continue, fork/rotate undo and the independent reviewer
/// all rewrite history), so server-side threading via `previous_response_id`
/// would fight the local session. Every request therefore carries the full
/// input, and `reasoning.encrypted_content` is requested so reasoning items
/// can be replayed across turns without server-side storage.
fn build_responses_body(
    model: &str,
    input: Vec<Value>,
    tool_specs: &[ExecutorToolSpec],
    enable_tools: bool,
    system_prompt: Option<&str>,
    prompt_cache_key: &str,
) -> Value {
    let mut body = json!({
        "model": model,
        "stream": true,
        "store": false,
        "include": ["reasoning.encrypted_content"],
        "input": input,
        "prompt_cache_key": prompt_cache_key,
        "reasoning": { "summary": "auto" },
    });
    if let Some(level) = reasoning_level_for(model) {
        body["reasoning"]["effort"] = json!(level);
    }
    if let Some(prompt) = system_prompt {
        body["instructions"] = json!(prompt);
    }
    if enable_tools {
        body["tools"] = json!(tool_specs
            .iter()
            .map(convert_tool_spec_responses)
            .collect::<Vec<_>>());
        body["tool_choice"] = json!("auto");
    }
    body
}

fn encode_responses_reasoning_signature(items: &[Value], model: &str) -> Option<String> {
    if items.is_empty() {
        return None;
    }
    let payload = json!({ "model": model, "items": items });
    serde_json::to_string(&payload).ok().map(|json| {
        format!(
            "{OPENAI_RESPONSES_REASONING_SIGNATURE_PREFIX}{OPENAI_RESPONSES_REASONING_V2_TAG}{json}"
        )
    })
}

fn decode_responses_reasoning_signature(signature: &str, current_model: &str) -> Vec<Value> {
    let Some(body) = signature.strip_prefix(OPENAI_RESPONSES_REASONING_SIGNATURE_PREFIX) else {
        return Vec::new();
    };
    let mut items = if let Some(payload) = body.strip_prefix(OPENAI_RESPONSES_REASONING_V2_TAG) {
        // v2: encrypted reasoning is model-specific. Replaying one model's items
        // onto another makes the Responses API reject the request, and a generic
        // 400 has no transport-fallback marker — so drop them when the producer
        // model differs from the model this request targets.
        let Ok(parsed) = serde_json::from_str::<Value>(payload) else {
            return Vec::new();
        };
        let producer = parsed
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !producer.is_empty() && producer != current_model {
            return Vec::new();
        }
        match parsed.get("items") {
            Some(Value::Array(items)) => items.clone(),
            _ => return Vec::new(),
        }
    } else {
        // v1 legacy: a bare array with no model tag. Replayed regardless of
        // model; the runtime self-heal recovers if the current model rejects it.
        let Ok(items) = serde_json::from_str::<Vec<Value>>(body) else {
            return Vec::new();
        };
        items
    };
    // A session file is local project state and may be edited by hand. Never
    // let a forged signature inject arbitrary Responses input item types.
    items.retain(|item| item.get("type").and_then(Value::as_str) == Some("reasoning"));
    items
}

fn responses_reasoning_items_from_blocks(
    blocks: &[ContentBlock],
    current_model: &str,
) -> Vec<Value> {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Thinking { signature, .. } => Some(signature.as_str()),
            _ => None,
        })
        .flat_map(|signature| decode_responses_reasoning_signature(signature, current_model))
        .collect()
}

/// Stable, opaque bucketing key for provider-side prompt-cache routing.
///
/// The system prompt plus the first user message are stable for an ordinary
/// session and naturally change after a compaction rewrites the prefix. FNV-1a
/// is sufficient here: the key is a routing hint, not a security boundary.
fn responses_prompt_cache_key(
    model: &str,
    system_prompt: Option<&str>,
    messages: &[ConversationMessage],
) -> String {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

    fn update(mut hash: u64, bytes: &[u8]) -> u64 {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        hash
    }

    let mut hash = update(FNV_OFFSET, model.as_bytes());
    if let Some(prompt) = system_prompt {
        hash = update(hash, prompt.as_bytes());
    }
    if let Some(first_user) = messages
        .iter()
        .find(|message| message.role == MessageRole::User)
    {
        for block in &first_user.blocks {
            match block {
                ContentBlock::Text { text } => hash = update(hash, text.as_bytes()),
                ContentBlock::Image { media_type, data } => {
                    hash = update(hash, media_type.as_bytes());
                    hash = update(hash, data.len().to_string().as_bytes());
                }
                ContentBlock::ToolUse { id, name, input } => {
                    hash = update(hash, id.as_bytes());
                    hash = update(hash, name.as_bytes());
                    hash = update(hash, input.as_bytes());
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    tool_name,
                    output,
                    ..
                } => {
                    hash = update(hash, tool_use_id.as_bytes());
                    hash = update(hash, tool_name.as_bytes());
                    hash = update(hash, output.as_bytes());
                }
                ContentBlock::Thinking {
                    thinking,
                    signature,
                } => {
                    hash = update(hash, thinking.as_bytes());
                    hash = update(hash, signature.as_bytes());
                }
            }
        }
    }
    format!("aris-{hash:016x}")
}

/// Cap one turn's reasoning text to [`MAX_REASONING_CHARS_PER_TURN`] before it
/// is persisted as a Thinking block, UTF-8-safe at a char boundary. Truncation
/// happens once, before the block is ever sent, so its stored bytes stay stable
/// afterwards (preserving the provider's automatic prefix cache). Empty in →
/// empty out.
fn truncate_reasoning_per_turn(mut reasoning: String) -> String {
    if reasoning.chars().count() > MAX_REASONING_CHARS_PER_TURN {
        let byte_idx = reasoning
            .char_indices()
            .nth(MAX_REASONING_CHARS_PER_TURN)
            .map(|(i, _)| i)
            .unwrap_or(reasoning.len());
        reasoning.truncate(byte_idx);
    }
    reasoning
}

fn response_request_id(headers: &reqwest::header::HeaderMap) -> Option<String> {
    ["x-request-id", "request-id", "openai-request-id"]
        .iter()
        .find_map(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
}

fn response_header_trace_value(headers: &reqwest::header::HeaderMap) -> Value {
    json!({
        "x-request-id": response_header_value(headers, "x-request-id"),
        "request-id": response_header_value(headers, "request-id"),
        "openai-request-id": response_header_value(headers, "openai-request-id"),
        "retry-after": response_header_value(headers, "retry-after"),
        "content-type": response_header_value(headers, "content-type"),
        "x-ratelimit-remaining-requests": response_header_value(headers, "x-ratelimit-remaining-requests"),
        "x-ratelimit-remaining-tokens": response_header_value(headers, "x-ratelimit-remaining-tokens"),
    })
}

fn response_header_value(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn body_preview_trace(body: &str) -> Value {
    let chars = body.chars().count();
    json!({
        "preview": body.chars().take(4_096).collect::<String>(),
        "chars": chars,
        "truncated": chars > 4_096,
    })
}

/// Whether a mid-stream error envelope (see [`stream_error_detail`]) looks
/// worth restarting rather than failing the turn. Two families qualify:
///
/// 1. **Content-moderation / sensitivity filters** — many providers (GLM,
///    MiniMax, Qwen and similar proxies) run a safety classifier over the
///    *generated* output and abort the stream with codes like
///    `new_sensitive (1027)` / `unprocessable_entity_error`. Because the
///    verdict is keyed on the sampled tokens, a fresh sample (temperature > 0)
///    frequently passes — restarting recovers legitimate content that a
///    false-positive flagged.
/// 2. **Transient provider hiccups** — overload / rate-limit / timeout /
///    internal-error envelopes delivered mid-stream instead of as an HTTP
///    status.
///
/// Permanent failures (auth, quota, bad request) are NOT matched, so they
/// surface immediately without burning the restart budget.
fn stream_error_is_retryable(detail: &str) -> bool {
    const RETRYABLE: &[&str] = &[
        // content moderation / sensitivity (stochastic on sampled output)
        "sensitive",
        "content_filter",
        "content filter",
        "moderation",
        "flagged",
        "unprocessable_entity",
        "敏感",
        "审核",
        "违规",
        // transient provider hiccups
        "rate limit",
        "overload",
        "timeout",
        "timed out",
        "temporar",
        "try again",
        "again later",
        "server error",
        "service unavailable",
        "internal error",
    ];
    let d = detail.to_ascii_lowercase();
    RETRYABLE.iter().any(|k| d.contains(k))
}

/// The non-empty `finish_reason` of a streaming choice, if present. Read
/// independently of `delta` so a terminal choice carrying only
/// `finish_reason` (no `delta`) is still recognized (OE7 / #249).
fn choice_finish_reason(choice: &Value) -> Option<&str> {
    choice
        .get("finish_reason")
        .and_then(|r| r.as_str())
        .filter(|r| !r.is_empty())
}

fn finish_reason_may_have_partial_tool_payload(reason: &str) -> bool {
    matches!(
        reason,
        "length"
            | "max_output"
            | "max_output_tokens"
            | "content_filter"
            | "stream_truncated"
            | "stream_error_after_partial_output"
    )
}

/// Accumulate one streaming `tool_calls[]` delta entry into `pending`
/// (slot index → (id, name, arguments)). Tool-call fields arrive
/// incrementally across chunks: `id` is overwritten whenever the field is
/// present, a non-empty `name` is retained, and `arguments` concatenate.
fn accumulate_tool_call(pending: &mut Vec<(String, String, String)>, tc: &Value) {
    let incoming_id = tc
        .get("id")
        .and_then(|i| i.as_str())
        .filter(|s| !s.is_empty());

    // OE6: when `index` is missing but `id` is present, merge into the slot
    // that already carries that id (covers compat providers that send id-only
    // continuation deltas). Fall back to slot 0 only when neither is present.
    let idx = if let Some(raw_idx) = tc.get("index").and_then(|i| i.as_u64()) {
        raw_idx as usize
    } else if let Some(id) = incoming_id {
        pending
            .iter()
            .position(|(slot_id, _, _)| slot_id == id)
            .unwrap_or(0)
    } else {
        0
    };

    while pending.len() <= idx {
        pending.push((String::new(), String::new(), String::new()));
    }
    // Some OpenAI-compatible gateways omit the tool-call id in the first
    // streaming delta (and occasionally in every delta). The id is required
    // when replaying the assistant/tool pair on the next request, so keep a
    // stable local id until a later delta supplies the provider id.
    if pending[idx].0.is_empty() {
        pending[idx].0 = format!("call_aris_{idx}");
    }
    if let Some(id) = incoming_id {
        pending[idx].0 = id.to_string();
    }
    if let Some(func) = tc.get("function") {
        if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
            if !name.is_empty() {
                pending[idx].1 = name.to_string();
            }
        }
        if let Some(args) = func.get("arguments").and_then(|a| a.as_str()) {
            pending[idx].2.push_str(args);
        }
    }
}

/// Extract the trimmed payload of an SSE `data:` line (OE3 / #249).
/// Tolerates both `data: {...}` (OpenAI canonical, one space) and
/// `data:{...}` (no space — W3C EventSource permits zero or one space
/// after the field colon, and some OpenAI-compatible providers omit it,
/// which the old `strip_prefix("data: ")` silently dropped). Returns
/// `None` for blank lines, comment lines, and non-`data:` field lines
/// (`event:`, `id:`, `retry:`), which the streaming loop skips.
fn sse_data_payload(line: &str) -> Option<&str> {
    line.strip_prefix("data:").map(str::trim)
}

/// Re-send the streaming POST when restarting a broken stream. Bounded
/// inline retry loop covers 429 / 5xx / transient network errors during
/// the restart — without it, a restart triggered by proxy instability
/// would immediately fail again if the proxy returns 429 (which is the
/// most common companion to chunk aborts). 3 attempts max with 1s/2s
/// backoff between attempts 1→2 and 2→3 (no sleep after the final
/// attempt). Mirrors the OpenAI executor's primary send-retry semantics.
async fn stream_restart_send(
    http: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &Value,
    trace_sink: &Option<std::sync::Arc<dyn ExecutorTraceSink>>,
    model: &str,
    reason: &str,
) -> Result<reqwest::Response, RuntimeError> {
    const RESTART_MAX_ATTEMPTS: u32 = 3;
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        if runtime::is_interrupted() {
            runtime::clear_interrupt();
            return Err(RuntimeError::new("interrupted by user"));
        }
        trace_record(
            trace_sink,
            "llm.attempt",
            json!({
                "provider": "openai-compatible",
                "model": model,
                "phase": "stream_restart",
                "reason": reason,
                "attempt": attempt,
                "maxAttempts": RESTART_MAX_ATTEMPTS,
            }),
        );
        let send_result = send_with_response_header_timeout(
            http.post(url)
                .bearer_auth(api_key)
                .header("content-type", "application/json")
                .json(body),
        )
        .await;
        match send_result {
            Ok(resp) => {
                let status = resp.status();
                if resp.status().is_success() {
                    trace_record(
                        trace_sink,
                        "llm.response_start",
                        json!({
                            "provider": "openai-compatible",
                            "model": model,
                            "status": status.as_u16(),
                            "requestId": response_request_id(resp.headers()),
                            "stream": true,
                            "phase": "stream_restart",
                            "reason": reason,
                        }),
                    );
                    return Ok(resp);
                }
                let retryable = status.as_u16() == 429 || status.is_server_error();
                if retryable && attempt < RESTART_MAX_ATTEMPTS {
                    let request_id = response_request_id(resp.headers());
                    let response_headers = response_header_trace_value(resp.headers());
                    let retry_after_secs = resp
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok());
                    let backoff_ms: u64 = (1u64 << (attempt - 1)) * 1000;
                    let body_preview = resp.text().await.unwrap_or_default();
                    trace_record(
                        trace_sink,
                        "llm.retry",
                        json!({
                            "provider": "openai-compatible",
                            "model": model,
                            "phase": "stream_restart",
                            "reason": reason,
                            "attempt": attempt,
                            "maxAttempts": RESTART_MAX_ATTEMPTS,
                            "status": status.as_u16(),
                            "requestId": request_id,
                            "backoffMs": backoff_ms,
                            "retryAfterSeconds": retry_after_secs,
                            "responseHeaders": response_headers,
                            "bodyPreview": body_preview_trace(&body_preview),
                        }),
                    );
                    eprintln!(
                        "\x1b[33m  OpenAI restart {status} (attempt {attempt}/{RESTART_MAX_ATTEMPTS}), retrying in {backoff_ms}ms\x1b[0m"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                    continue;
                }
                let body_preview = resp.text().await.unwrap_or_default();
                return Err(RuntimeError::new(format!(
                    "OpenAI stream restart failed: {status}: {body_preview}"
                )));
            }
            Err(e) => {
                let transient = e.is_transient();
                if transient && attempt < RESTART_MAX_ATTEMPTS {
                    let backoff_ms: u64 = (1u64 << (attempt - 1)) * 1000;
                    trace_record(
                        trace_sink,
                        "llm.retry",
                        json!({
                            "provider": "openai-compatible",
                            "model": model,
                            "phase": "stream_restart",
                            "reason": reason,
                            "attempt": attempt,
                            "maxAttempts": RESTART_MAX_ATTEMPTS,
                            "backoffMs": backoff_ms,
                            "error": e.to_string(),
                        }),
                    );
                    eprintln!(
                        "\x1b[33m  OpenAI restart network error (attempt {attempt}/{RESTART_MAX_ATTEMPTS}), retrying in {backoff_ms}ms: {e}\x1b[0m"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                    continue;
                }
                return Err(RuntimeError::new(format!(
                    "OpenAI stream restart failed: {e}"
                )));
            }
        }
    }
}

/// Resolve executor configuration from environment variables.
///
/// Returns `(api_key, base_url, model)` or `None` if `EXECUTOR_PROVIDER` is not set to `openai`.
pub fn resolve_openai_executor_config() -> Option<OpenAIExecutorConfig> {
    let provider = std::env::var("EXECUTOR_PROVIDER").ok()?;
    if provider != "openai" {
        return None;
    }

    let api_key = std::env::var("EXECUTOR_API_KEY")
        .or_else(|_| std::env::var("OPENAI_API_KEY"))
        .ok()
        .filter(|s| !s.is_empty())?;

    // Treat empty/whitespace-only values the same as unset, and trim otherwise
    // so accidental leading/trailing whitespace doesn't produce a malformed URL.
    let base_url = std::env::var("EXECUTOR_BASE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_OPENAI_BASE_URL.to_string());

    Some(OpenAIExecutorConfig { api_key, base_url })
}

#[derive(Debug, Clone)]
pub struct OpenAIExecutorConfig {
    pub api_key: String,
    pub base_url: String,
}

pub struct OpenAIRuntimeClient {
    runtime: tokio::runtime::Runtime,
    http: reqwest::Client,
    api_key: String,
    base_url: String,
    model: String,
    enable_tools: bool,
    tool_specs: Vec<ExecutorToolSpec>,
    observer: Box<dyn StreamObserver>,
    trace_sink: Option<std::sync::Arc<dyn ExecutorTraceSink>>,
    /// Configured endpoint preference; `Auto` selects by model capability and
    /// learns unsupported gateway/model pairs. See [`OpenAiTransport`].
    transport: OpenAiTransport,
}

impl OpenAIRuntimeClient {
    pub fn new(
        config: OpenAIExecutorConfig,
        model: String,
        enable_tools: bool,
        tool_specs: Vec<ExecutorToolSpec>,
        observer: Box<dyn StreamObserver>,
    ) -> Result<Self, String> {
        Ok(Self {
            runtime: tokio::runtime::Runtime::new().map_err(|error| error.to_string())?,
            http: reqwest::Client::builder()
                .user_agent(concat!("aris/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(HTTP_CONNECT_TIMEOUT)
                // Keep this as an idle read deadline rather than a whole-request
                // timeout: a healthy streaming answer may exceed two minutes.
                .read_timeout(HTTP_RESPONSE_HEADER_TIMEOUT)
                .pool_idle_timeout(HTTP_POOL_IDLE_TIMEOUT)
                .tcp_keepalive(HTTP_TCP_KEEPALIVE)
                .build()
                .map_err(|error| error.to_string())?,
            api_key: config.api_key,
            base_url: config.base_url,
            model,
            enable_tools,
            tool_specs,
            observer,
            trace_sink: None,
            transport: OpenAiTransport::default(),
        })
    }

    #[must_use]
    pub fn with_trace_sink(mut self, trace_sink: std::sync::Arc<dyn ExecutorTraceSink>) -> Self {
        self.trace_sink = Some(trace_sink);
        self
    }

    /// Select the endpoint for this client. Defaults to
    /// [`OpenAiTransport::Auto`]; a `Responses` preference still falls back to
    /// chat/completions at runtime if the gateway rejects the endpoint.
    #[must_use]
    pub fn with_transport(mut self, transport: OpenAiTransport) -> Self {
        self.transport = transport;
        self
    }
}

impl ApiClient for OpenAIRuntimeClient {
    // No `on_session_compacted` override: reasoning is now persisted as session
    // Thinking blocks (not a side cache keyed by message index), so compaction
    // rewrites and drops it along with the messages it removes — no index remap
    // to invalidate. The trait's default no-op is correct.

    #[allow(clippy::too_many_lines)]
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let system_prompt = if request.system_prompt.is_empty() {
            None
        } else {
            Some(request.system_prompt.join("\n\n"))
        };

        // Provider-aware reasoning_content capture. Deliberately decoupled
        // from `supports_reasoning_effort`: Kimi/Moonshot/DeepSeek-R1 emit
        // reasoning_content and accept it back without taking
        // reasoning_effort as a request field, while OpenAI o-series/gpt-5.x
        // take reasoning_effort but never accept reasoning_content as input
        // (replaying it onto them only churned request bytes and broke
        // provider prefix caching).
        let supports_reasoning = supports_reasoning_content_replay(&self.model);
        // Mutable: a `/v1/responses` request that the gateway cannot serve
        // falls back to chat/completions inside the send loop below, and the
        // stream parser must follow the transport it actually reached.
        let (mut use_responses_api, transport_reason) = resolve_transport(
            self.transport,
            &self.base_url,
            &self.model,
            self.enable_tools,
        );

        let mut body = if use_responses_api {
            build_responses_body(
                &self.model,
                convert_messages_responses(&request.messages, &self.model),
                &self.tool_specs,
                self.enable_tools,
                system_prompt.as_deref(),
                &responses_prompt_cache_key(
                    &self.model,
                    system_prompt.as_deref(),
                    &request.messages,
                ),
            )
        } else {
            build_chat_completions_body(
                &self.model,
                convert_messages_openai(&request.messages, system_prompt.as_deref(), &self.model),
                &self.tool_specs,
                self.enable_tools,
                chat_reasoning_effort_for(&self.model, &self.base_url, self.enable_tools),
            )
        };

        let mut endpoint = endpoint_for_transport(use_responses_api);
        let mut transport = transport_label(use_responses_api);
        let mut url = format!("{}{}", self.base_url.trim_end_matches('/'), endpoint);
        trace_record(
            &self.trace_sink,
            "llm.tools_snapshot",
            json!({
                "provider": "openai-compatible",
                "model": &self.model,
                "transport": transport,
                "enabled": self.enable_tools,
                "toolCount": self.tool_specs.len(),
                "tools": tool_specs_to_value(&self.tool_specs),
            }),
        );
        trace_record(
            &self.trace_sink,
            "llm.request",
            json!({
                "provider": "openai-compatible",
                "model": &self.model,
                "baseUrl": &self.base_url,
                "endpoint": endpoint,
                "transport": transport,
                "transportReason": transport_reason.as_str(),
                "stream": true,
                "systemPromptInMessages": system_prompt.is_some(),
                "messageCount": request.messages.len(),
                "request": &body,
            }),
        );
        let trace_sink = self.trace_sink.clone();

        let result = self.runtime.block_on(async {
            const MAX_ATTEMPTS: u32 = 4;
            let mut attempt: u32 = 0;
            // v0.4.12 P1.C — `stream_options.include_usage:true` is sent
            // unconditionally for token-cost accuracy. Major providers
            // (OpenAI, vLLM, SGLang, OpenRouter, Together) accept it,
            // but some compatible-mode proxies reject unknown body
            // fields with 400. When that happens, retry once without
            // `stream_options` (sacrificing prefix-cache token reporting
            // for compatibility). Only fires once per request.
            let mut tried_without_stream_options = false;
            // v0.4.24 — one-shot recovery when a `/v1/responses` request is
            // rejected for a replayed reasoning item (cross-model encrypted
            // content, an ordering violation, or a hand-edited session). Strip
            // the reasoning items and retry once so the turn completes without
            // reasoning replay instead of hard-failing every turn until the
            // session is compacted.
            let mut tried_without_reasoning_items = false;
            let mut response = loop {
                attempt += 1;
                if runtime::is_interrupted() {
                    runtime::clear_interrupt();
                    return Err(RuntimeError::new("interrupted by user"));
                }
                trace_record(
                    &trace_sink,
                    "llm.attempt",
                    json!({
                        "provider": "openai-compatible",
                        "model": &self.model,
                        "phase": "send",
                        "attempt": attempt,
                        "maxAttempts": MAX_ATTEMPTS,
                        "stream": true,
                    }),
                );
                let send_result = send_with_response_header_timeout(
                    self.http
                        .post(&url)
                        .bearer_auth(&self.api_key)
                        .header("content-type", "application/json")
                        .json(&body),
                )
                .await;

                match send_result {
                    Ok(resp) => {
                        let status = resp.status();
                        // Retry on 429 (rate limit) and 5xx (server errors)
                        let retryable = status.as_u16() == 429 || status.is_server_error();
                        if resp.status().is_success() {
                            trace_record(
                                &trace_sink,
                                "llm.response_start",
                                json!({
                                    "provider": "openai-compatible",
                                    "model": &self.model,
                                    "status": status.as_u16(),
                                    "transport": transport,
                                    "requestId": response_request_id(resp.headers()),
                                    "stream": true,
                                }),
                            );
                            break resp;
                        }
                        // Headers must be read before `text()` consumes the
                        // response. Every non-success path below wants the body,
                        // so read it once here.
                        let request_id = response_request_id(resp.headers());
                        let response_headers = response_header_trace_value(resp.headers());
                        let retry_after_secs = resp
                            .headers()
                            .get("retry-after")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|s| s.parse::<u64>().ok());
                        let body_text = resp.text().await.unwrap_or_default();

                        // Transport fallback: this gateway does not serve
                        // `/v1/responses` for this model. Checked *before* the
                        // retry branch — an unsupported endpoint fails
                        // identically on every attempt, so retrying it just
                        // burns the budget and the backoff. Rebuild the request
                        // for chat/completions and re-send immediately.
                        if use_responses_api
                            && responses_transport_unsupported(status.as_u16(), &body_text)
                        {
                            use_responses_api = false;
                            mark_responses_unsupported(&self.base_url, &self.model);
                            endpoint = endpoint_for_transport(false);
                            transport = transport_label(false);
                            url = format!("{}{}", self.base_url.trim_end_matches('/'), endpoint);
                            body = build_chat_completions_body(
                                &self.model,
                                convert_messages_openai(
                                    &request.messages,
                                    system_prompt.as_deref(),
                                    &self.model,
                                ),
                                &self.tool_specs,
                                self.enable_tools,
                                chat_reasoning_effort_for(
                                    &self.model,
                                    &self.base_url,
                                    self.enable_tools,
                                ),
                            );
                            trace_record(
                                &trace_sink,
                                "llm.transport_fallback",
                                json!({
                                    "provider": "openai-compatible",
                                    "model": &self.model,
                                    "baseUrl": &self.base_url,
                                    "from": "responses",
                                    "to": "chat_completions",
                                    "status": status.as_u16(),
                                    "requestId": request_id,
                                    "bodyPreview": body_preview_trace(&body_text),
                                    "request": &body,
                                }),
                            );
                            eprintln!(
                                "\x1b[33m  {} does not serve /v1/responses for {} (HTTP {status}); falling back to /v1/chat/completions for the rest of this process\x1b[0m",
                                self.base_url, self.model
                            );
                            // Not a real retry — the request shape changed.
                            attempt = attempt.saturating_sub(1);
                            continue;
                        }

                        // Reverse transport fallback: a `/v1/chat/completions`
                        // request the backend insists must use `/v1/responses`
                        // (official OpenAI's gate on gpt-5.5+/o-series tool
                        // flows, forwarded by a gateway). Symmetric to the
                        // forward fallback above. Guarded by the responses
                        // registry so it cannot ping-pong: once responses has
                        // been learned unsupported, a chat "use responses" 400
                        // hard-fails rather than flipping back and forth.
                        if !use_responses_api
                            && self.enable_tools
                            && !responses_known_unsupported(&self.base_url, &self.model)
                            && chat_requires_responses_transport(status.as_u16(), &body_text)
                        {
                            use_responses_api = true;
                            mark_chat_requires_responses(&self.base_url, &self.model);
                            endpoint = endpoint_for_transport(true);
                            transport = transport_label(true);
                            url = format!("{}{}", self.base_url.trim_end_matches('/'), endpoint);
                            body = build_responses_body(
                                &self.model,
                                convert_messages_responses(&request.messages, &self.model),
                                &self.tool_specs,
                                self.enable_tools,
                                system_prompt.as_deref(),
                                &responses_prompt_cache_key(
                                    &self.model,
                                    system_prompt.as_deref(),
                                    &request.messages,
                                ),
                            );
                            trace_record(
                                &trace_sink,
                                "llm.transport_fallback",
                                json!({
                                    "provider": "openai-compatible",
                                    "model": &self.model,
                                    "baseUrl": &self.base_url,
                                    "from": "chat_completions",
                                    "to": "responses",
                                    "status": status.as_u16(),
                                    "requestId": request_id,
                                    "bodyPreview": body_preview_trace(&body_text),
                                    "request": &body,
                                }),
                            );
                            eprintln!(
                                "\x1b[33m  {} requires /v1/responses for {} (HTTP {status}); switching to /v1/responses for the rest of this process\x1b[0m",
                                self.base_url, self.model
                            );
                            // Not a real retry — the request shape changed.
                            attempt = attempt.saturating_sub(1);
                            continue;
                        }

                        if retryable && attempt < MAX_ATTEMPTS {
                            let backoff_ms = if let Some(secs) = retry_after_secs {
                                (secs * 1000).min(10_000)
                            } else {
                                (1u64 << (attempt - 1)) * 1000 // 1s, 2s, 4s
                            };
                            let preview: String = body_text.chars().take(160).collect();
                            trace_record(
                                &trace_sink,
                                "llm.retry",
                                json!({
                                    "provider": "openai-compatible",
                                    "model": &self.model,
                                    "phase": "send",
                                    "attempt": attempt,
                                    "maxAttempts": MAX_ATTEMPTS,
                                    "status": status.as_u16(),
                                    "requestId": request_id,
                                    "backoffMs": backoff_ms,
                                    "retryAfterSeconds": retry_after_secs,
                                    "responseHeaders": response_headers,
                                    "bodyPreview": body_preview_trace(&body_text),
                                }),
                            );
                            eprintln!(
                                "\x1b[33m  OpenAI {status} (attempt {attempt}/{MAX_ATTEMPTS}), retrying in {}ms: {preview}\x1b[0m",
                                backoff_ms
                            );
                            let deadline =
                                std::time::Instant::now() + std::time::Duration::from_millis(backoff_ms);
                            while std::time::Instant::now() < deadline {
                                if runtime::is_interrupted() {
                                    return Err(RuntimeError::new("interrupted by user"));
                                }
                                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            }
                            continue;
                        }

                        // Responses reasoning-item rejection: strip the replayed
                        // reasoning items and retry once. Checked before the
                        // stream_options fallback because both are 400
                        // body-shape adjustments, and an unsupported-reasoning
                        // 400 fails identically on every attempt. Guarded so it
                        // fires at most once and only when the body actually
                        // carried reasoning items to remove.
                        if use_responses_api
                            && status.as_u16() == 400
                            && !tried_without_reasoning_items
                            && is_reasoning_item_rejected(&body_text)
                            && strip_reasoning_items_from_responses_body(&mut body)
                        {
                            tried_without_reasoning_items = true;
                            trace_record(
                                &trace_sink,
                                "llm.request_adjusted",
                                json!({
                                    "provider": "openai-compatible",
                                    "model": &self.model,
                                    "reason": "reasoning_items_rejected",
                                    "status": status.as_u16(),
                                    "requestId": request_id,
                                    "bodyPreview": body_preview_trace(&body_text),
                                    "request": &body,
                                }),
                            );
                            eprintln!(
                                "\x1b[33m  {} rejected a replayed reasoning item for {} (HTTP {status}); retrying without reasoning replay this turn\x1b[0m",
                                self.base_url, self.model
                            );
                            // Not a real retry — the request shape changed.
                            attempt = attempt.saturating_sub(1);
                            continue;
                        }

                        // v0.4.12 P1.C — proxy compatibility fallback
                        // for `stream_options`. Only fires on a real 400
                        // whose error body actually fingers
                        // `stream_options` as an unknown / extra field.
                        if status.as_u16() == 400
                            && !tried_without_stream_options
                            && is_stream_options_unknown_field_error(&body_text)
                        {
                            tried_without_stream_options = true;
                            body.as_object_mut()
                                .map(|m| m.remove("stream_options"));
                            trace_record(
                                &trace_sink,
                                "llm.request_adjusted",
                                json!({
                                    "provider": "openai-compatible",
                                    "model": &self.model,
                                    "reason": "stream_options_rejected",
                                    "request": &body,
                                }),
                            );
                            eprintln!(
                                "\x1b[33m  OpenAI proxy rejected `stream_options.include_usage`, retrying without it (cached_tokens reporting will be skipped this turn)\x1b[0m"
                            );
                            // Don't bump attempt — this is a one-shot
                            // body-shape adjustment, not a real retry.
                            attempt = attempt.saturating_sub(1);
                            continue;
                        }

                        // Context-window overflow: tag the error so the
                        // conversation loop force-compacts and retries instead
                        // of failing the whole turn. Most providers report this
                        // as 400, but some use 413 (payload too large), so we
                        // sniff the body regardless of the exact status.
                        if is_context_window_exceeded_error(&body_text) {
                            return Err(RuntimeError::context_overflow(format!(
                                "OpenAI API error {status}: {body_text}"
                            )));
                        }

                        return Err(RuntimeError::new(format!(
                            "OpenAI API error {status}: {body_text}"
                        )));
                    }
                    Err(e) => {
                        let transient = e.is_transient();
                        // Build full error chain for diagnostic visibility
                        let mut chain = vec![e.to_string()];
                        let mut src: Option<&(dyn std::error::Error + 'static)> =
                            std::error::Error::source(&e);
                        let mut depth = 0;
                        while let Some(s) = src {
                            chain.push(format!("  caused by: {s}"));
                            src = s.source();
                            depth += 1;
                            if depth > 6 {
                                break;
                            }
                        }
                        let detail = chain.join("\n");
                        if transient && attempt < MAX_ATTEMPTS {
                            let backoff_ms: u64 = (1u64 << (attempt - 1)) * 1000;
                            trace_record(
                                &trace_sink,
                                "llm.retry",
                                json!({
                                    "provider": "openai-compatible",
                                    "model": &self.model,
                                    "phase": "send",
                                    "attempt": attempt,
                                    "maxAttempts": MAX_ATTEMPTS,
                                    "backoffMs": backoff_ms,
                                    "error": detail,
                                }),
                            );
                            eprintln!(
                                "\x1b[33m  OpenAI network error (attempt {attempt}/{MAX_ATTEMPTS}), retrying in {backoff_ms}ms:\n{detail}\x1b[0m"
                            );
                            let deadline = std::time::Instant::now()
                                + std::time::Duration::from_millis(backoff_ms);
                            while std::time::Instant::now() < deadline {
                                if runtime::is_interrupted() {
                                    runtime::clear_interrupt();
                                    return Err(RuntimeError::new("interrupted by user"));
                                }
                                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            }
                            continue;
                        }
                        return Err(RuntimeError::new(format!("OpenAI request failed: {detail}")));
                    }
                }
            };

            if body.get("stream").and_then(Value::as_bool) == Some(false) {
                let response_body = response.text().await.map_err(|error| {
                    RuntimeError::new(format!("OpenAI non-stream response read failed: {error}"))
                })?;
                return parse_non_stream_chat_response(
                    &response_body,
                    &self.model,
                    &mut *self.observer,
                );
            }

            let mut events: Vec<AssistantEvent> = Vec::new();
            let observer = &mut self.observer;

            // Kimi: accumulate reasoning_content from this turn
            let mut current_reasoning = String::new();
            let mut current_responses_reasoning_items: Vec<Value> = Vec::new();

            // Accumulate tool calls: index → (id, name, arguments_json)
            let mut pending_tools: Vec<(String, String, String)> = Vec::new();
            let mut responses_tools = ResponsesToolAccumulator::default();

            let mut stream_buf = StrictSseLineBuffer::default();
            let mut done = false;
            // C6 v0.4.10: whole-stream restart budget for mid-body aborts
            // or premature EOF before any event has been emitted. See
            // openai_executor.rs::stream_retry_budget docstring.
            let mut stream_retries_remaining: u8 = stream_retry_budget();
            // v0.4.14 C11: per-chunk idle timeout. None = wait forever
            // (legacy behaviour, opt-in via `ARIS_STREAM_IDLE_TIMEOUT_SECS=0`).
            // On elapse the stream walks the same retry path as a
            // mid-body abort.
            let idle_timeout = api::resolve_stream_idle_timeout();
            // "Has the caller seen any meaningful output yet?" If true,
            // we cannot restart — there's no resume primitive in
            // OpenAI's API and re-sending would duplicate output.
            let nothing_emitted_yet = |events: &Vec<AssistantEvent>,
                                       pending_tools: &Vec<(String, String, String)>,
                                       current_reasoning: &String|
             -> bool {
                events.is_empty()
                    && pending_tools.is_empty()
                    && current_reasoning.is_empty()
            };
            // `[DONE]` sentinel — distinguishes "stream completed normally"
            // from "proxy closed connection before sending [DONE]".
            let mut observed_done = false;
            // #249 v0.4.15: a non-empty `choices[].finish_reason` is the
            // Chat Completions spec's terminal-chunk marker and is an
            // equally authoritative completion signal. OpenAI-compatible
            // providers (MiniMax etc.) often send it but never emit
            // `[DONE]`; without this a clean EOF was misreported as a
            // truncation. We still read until EOF (never stop early at
            // finish_reason) so a trailing usage-only chunk isn't lost.
            let mut observed_finish_reason = false;

            loop {
                // Check for Ctrl+C interrupt between chunks
                if stream_cancel_requested(observer.as_ref()) {
                    return Err(interrupted_error());
                }
                // v0.4.14 C11 — wrap chunk read in tokio::time::timeout so
                // a hung upstream proxy can't stall this loop forever.
                // Idle elapse is treated equivalently to a premature
                // EOF / mid-body abort and walks through the same
                // retry path.
                let chunk_future = response.chunk();
                let chunk_result = match idle_timeout {
                    Some(dur) => match tokio::select! {
                        result = tokio::time::timeout(dur, chunk_future) => result,
                        () = wait_for_stream_cancel(observer.as_ref()) => {
                            return Err(interrupted_error());
                        }
                    } {
                        Ok(inner) => inner,
                        Err(_elapsed) => {
                            if nothing_emitted_yet(
                                &events,
                                &pending_tools,
                                &current_reasoning,
                            ) && stream_retries_remaining > 0
                            {
                                stream_retries_remaining -= 1;
                                trace_record(
                                    &trace_sink,
                                    "llm.retry",
                                    json!({
                                        "provider": "openai-compatible",
                                        "model": &self.model,
                                        "phase": "stream",
                                        "reason": "idle_timeout",
                                        "idleTimeoutSeconds": dur.as_secs(),
                                        "retriesRemaining": stream_retries_remaining,
                                    }),
                                );
                                eprintln!(
                                    "\x1b[33m  OpenAI stream restart (idle timeout {}s, {} attempt(s) left)\x1b[0m",
                                    dur.as_secs(),
                                    stream_retries_remaining
                                );
                                response = stream_restart_send(
                                    &self.http,
                                    &url,
                                    &self.api_key,
                                    &body,
                                    &trace_sink,
                                    &self.model,
                                    "idle_timeout",
                                )
                                .await?;
                                stream_buf.clear();
                                current_responses_reasoning_items.clear();
                                responses_tools.clear();
                                done = false;
                                continue;
                            }
                            events.push(AssistantEvent::StopReason(
                                "stream_error_after_partial_output".to_string(),
                            ));
                            break;
                        }
                    },
                    None => tokio::select! {
                        result = chunk_future => result,
                        () = wait_for_stream_cancel(observer.as_ref()) => {
                            return Err(interrupted_error());
                        }
                    },
                };
                let chunk = match chunk_result {
                    Ok(Some(c)) => c,
                    Ok(None) => {
                        // A non-whitespace tail means the provider closed in
                        // the middle of an SSE line (and possibly a UTF-8 code
                        // point). Never treat that as a complete response or
                        // flush a partially accumulated tool call.
                        if stream_buf.has_non_whitespace_tail() {
                            events.push(AssistantEvent::StopReason(
                                "stream_truncated".to_string(),
                            ));
                            break;
                        }
                        // Clean EOF. Decide complete / restart / truncated
                        // via the pure `stream_eof_action` helper. A
                        // response is complete if EITHER `[DONE]` OR a
                        // non-empty `finish_reason` was seen (#249: MiniMax
                        // & other compat providers send finish_reason but
                        // not `[DONE]`); only with neither do we restart
                        // (nothing emitted yet) or hard-error (truncated).
                        match stream_eof_action(
                            observed_done,
                            observed_finish_reason,
                            nothing_emitted_yet(&events, &pending_tools, &current_reasoning),
                            stream_retries_remaining,
                        ) {
                            StreamEofAction::Complete => break,
                            StreamEofAction::Restart => {
                                stream_retries_remaining -= 1;
                                trace_record(
                                    &trace_sink,
                                    "llm.retry",
                                    json!({
                                        "provider": "openai-compatible",
                                        "model": &self.model,
                                        "phase": "stream",
                                        "reason": "premature_eof",
                                        "observedDone": observed_done,
                                        "observedFinishReason": observed_finish_reason,
                                        "retriesRemaining": stream_retries_remaining,
                                    }),
                                );
                                eprintln!(
                                    "\x1b[33m  OpenAI stream restart (premature EOF, {} attempt(s) left)\x1b[0m",
                                    stream_retries_remaining
                                );
                                response = stream_restart_send(
                                    &self.http,
                                    &url,
                                    &self.api_key,
                                    &body,
                                    &trace_sink,
                                    &self.model,
                                    "premature_eof",
                                )
                                .await?;
                                stream_buf.clear();
                                current_responses_reasoning_items.clear();
                                responses_tools.clear();
                                done = false;
                                continue;
                            }
                            StreamEofAction::Truncated => {
                                // Preserve partial progress and let the runtime
                                // request an automatic continuation. Returning
                                // an error here discarded the already-streamed
                                // output and stopped the whole task.
                                events.push(AssistantEvent::StopReason(
                                    "stream_truncated".to_string(),
                                ));
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        if nothing_emitted_yet(&events, &pending_tools, &current_reasoning)
                            && stream_retries_remaining > 0
                            && stream_chunk_error_is_retryable(&error)
                        {
                            stream_retries_remaining -= 1;
                            trace_record(
                                &trace_sink,
                                "llm.retry",
                                json!({
                                    "provider": "openai-compatible",
                                    "model": &self.model,
                                    "phase": "stream",
                                    "reason": "body_abort",
                                    "error": error.to_string(),
                                    "retriesRemaining": stream_retries_remaining,
                                }),
                            );
                            eprintln!(
                                "\x1b[33m  OpenAI stream restart (body abort: {error}, {} attempt(s) left)\x1b[0m",
                                stream_retries_remaining
                            );
                            response = stream_restart_send(
                                &self.http,
                                &url,
                                &self.api_key,
                                &body,
                                &trace_sink,
                                &self.model,
                                "body_abort",
                            )
                            .await?;
                            stream_buf.clear();
                            current_responses_reasoning_items.clear();
                            responses_tools.clear();
                            done = false;
                            continue;
                        }
                        if nothing_emitted_yet(&events, &pending_tools, &current_reasoning) {
                            return Err(RuntimeError::new(error.to_string()));
                        }
                        events.push(AssistantEvent::StopReason(
                            "stream_error_after_partial_output".to_string(),
                        ));
                        break;
                    }
                };
                let lines = match stream_buf.push(&chunk) {
                    Ok(lines) => lines,
                    Err(error)
                        if nothing_emitted_yet(&events, &pending_tools, &current_reasoning) =>
                    {
                        return Err(RuntimeError::new(error.to_string()));
                    }
                    Err(error) => {
                        eprintln!(
                            "\x1b[33m  OpenAI stream UTF-8 error after partial output: {error} — keeping prior output and discarding pending tool calls\x1b[0m"
                        );
                        pending_tools.clear();
                        responses_tools.clear();
                        events.push(AssistantEvent::StopReason(
                            "stream_error_after_partial_output".to_string(),
                        ));
                        done = true;
                        Vec::new()
                    }
                };

                // Process complete, strictly decoded SSE lines.
                for line in lines {

                    if line.is_empty() || line.starts_with(':') {
                        continue;
                    }

                    // OE3 (#249): tolerate `data:{...}` without the space
                    // after the colon (some OpenAI-compatible providers omit
                    // it). Non-`data:` field lines (event:/id:/retry:) → skip.
                    let Some(data) = sse_data_payload(&line) else {
                        continue;
                    };
                    trace_record(
                        &trace_sink,
                        "llm.raw_sse",
                        json!({
                            "provider": "openai-compatible",
                            "model": &self.model,
                            "raw": data,
                        }),
                    );

                    if data == "[DONE]" {
                        observed_done = true;
                        flush_pending_tools(&mut pending_tools, observer, &mut events)?;
                        observer.on_message_stop()?;
                        events.push(AssistantEvent::MessageStop);
                        done = true;
                        break;
                    }

                    let parsed: Value = match serde_json::from_str(data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    trace_record(
                        &trace_sink,
                        "llm.provider_event",
                        json!({
                            "provider": "openai-compatible",
                            "model": &self.model,
                            "event": &parsed,
                        }),
                    );

                    // OE4 (#249): a mid-stream error envelope carries no
                    // `choices`, so it would be silently dropped by the
                    // `choices` guard below. That is doubly dangerous now
                    // that a prior `finish_reason` marks the stream
                    // "complete" on EOF — an error chunk arriving after a
                    // finish_reason would otherwise be misjudged as success.
                    //
                    // Before hard-failing, two recovery paths (mirrors the
                    // premature-EOF / body-abort handling above):
                    //   1. Nothing emitted yet + a retryable envelope
                    //      (content-moderation false positive or transient
                    //      hiccup) + budget remaining → restart the whole
                    //      stream; a fresh sample often clears the filter.
                    //   2. Output already streamed → preserve it instead of
                    //      discarding, mark it truncated so a cut-off tool call
                    //      is never executed, and let the conversation loop
                    //      attempt a bounded continuation.
                    if let Some(detail) = stream_error_detail(&parsed)
                        .or_else(|| responses_stream_error_detail(&parsed))
                    {
                        if nothing_emitted_yet(&events, &pending_tools, &current_reasoning) {
                            // A few compatible gateways accept the HTTP
                            // request and only report an input overflow in
                            // the first SSE envelope. Treat that exactly like
                            // an initial 400 so Conversation force-compacts
                            // the persisted history and retries the turn.
                            if is_context_window_exceeded_error(&detail) {
                                return Err(RuntimeError::context_overflow(format!(
                                    "OpenAI stream returned a context-window error: {detail}"
                                )));
                            }
                            if stream_retries_remaining > 0
                                && stream_error_is_retryable(&detail)
                            {
                                stream_retries_remaining -= 1;
                                trace_record(
                                    &trace_sink,
                                    "llm.retry",
                                    json!({
                                        "provider": "openai-compatible",
                                        "model": &self.model,
                                        "phase": "stream",
                                        "reason": "mid_stream_error",
                                        "error": detail,
                                        "retriesRemaining": stream_retries_remaining,
                                    }),
                                );
                                eprintln!(
                                    "\x1b[33m  OpenAI stream restart (mid-stream error: {detail}, {} attempt(s) left)\x1b[0m",
                                    stream_retries_remaining
                                );
                                response = stream_restart_send(
                                    &self.http,
                                    &url,
                                    &self.api_key,
                                    &body,
                                    &trace_sink,
                                    &self.model,
                                    "mid_stream_error",
                                )
                                .await?;
                                stream_buf.clear();
                                current_responses_reasoning_items.clear();
                                responses_tools.clear();
                                done = false;
                                break;
                            }
                            return Err(RuntimeError::new(format!(
                                "OpenAI stream returned a mid-stream error: {detail}"
                            )));
                        }
                        eprintln!(
                            "\x1b[33m  OpenAI mid-stream error after partial output: {detail} — keeping partial output\x1b[0m"
                        );
                        events.push(AssistantEvent::StopReason(
                            "stream_error_after_partial_output".to_string(),
                        ));
                        done = true;
                        break;
                    }

                    if use_responses_api {
                        match parsed.get("type").and_then(Value::as_str).unwrap_or_default() {
                            "response.output_text.delta" | "response.refusal.delta" => {
                                if let Some(delta) = parsed.get("delta").and_then(Value::as_str) {
                                    if !delta.is_empty() {
                                        observer.on_text_delta(delta)?;
                                        push_text_event(&mut events, delta.to_string());
                                    }
                                }
                            }
                            "response.reasoning_summary_text.delta"
                            | "response.reasoning_text.delta" => {
                                if let Some(delta) = parsed.get("delta").and_then(Value::as_str) {
                                    if !delta.is_empty() {
                                        observer.on_thinking_delta(delta)?;
                                        current_reasoning.push_str(delta);
                                    }
                                }
                            }
                            "response.output_item.added" => {
                                responses_tools.observe_output_item_added(&parsed);
                            }
                            "response.function_call_arguments.delta" => {
                                responses_tools.observe_arguments_delta(&parsed);
                            }
                            "response.function_call_arguments.done" => {
                                responses_tools.observe_arguments_done(&parsed);
                            }
                            "response.output_item.done" => {
                                if let Some(item) = parsed.get("item") {
                                    if item.get("type").and_then(Value::as_str) == Some("reasoning") {
                                        current_responses_reasoning_items.push(item.clone());
                                    } else if let Some(tool_call) =
                                        responses_tools.observe_output_item_done(&parsed)
                                    {
                                        push_unique_tool_call(&mut pending_tools, tool_call);
                                    }
                                }
                            }
                            "response.completed" => {
                                if let Some(usage) = parsed
                                    .get("response")
                                    .and_then(|response| response.get("usage"))
                                {
                                    events.push(AssistantEvent::Usage(
                                        token_usage_from_openai_usage(usage),
                                    ));
                                }
                                let recovered = responses_tools.drain_completed_fallback();
                                if !recovered.calls.is_empty() {
                                    trace_record(
                                        &trace_sink,
                                        "llm.response_compat",
                                        json!({
                                            "provider": "openai-compatible",
                                            "model": &self.model,
                                            "reason": "responses_missing_tool_done",
                                            "recoveredToolCount": recovered.calls.len(),
                                        }),
                                    );
                                }
                                for tool_call in recovered.calls {
                                    push_unique_tool_call(&mut pending_tools, tool_call);
                                }
                                observed_finish_reason = true;
                                if recovered.invalid_count == 0 {
                                    flush_pending_tools(&mut pending_tools, observer, &mut events)?;
                                    events.push(AssistantEvent::StopReason("stop".to_string()));
                                } else {
                                    pending_tools.clear();
                                    events.push(AssistantEvent::StopReason(
                                        "stream_truncated".to_string(),
                                    ));
                                }
                                observer.on_message_stop()?;
                                events.push(AssistantEvent::MessageStop);
                                done = true;
                            }
                            "response.incomplete" => {
                                if let Some(usage) = parsed
                                    .get("response")
                                    .and_then(|response| response.get("usage"))
                                {
                                    events.push(AssistantEvent::Usage(
                                        token_usage_from_openai_usage(usage),
                                    ));
                                }
                                let reason = parsed
                                    .get("response")
                                    .and_then(|response| response.get("incomplete_details"))
                                    .and_then(|details| details.get("reason"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("incomplete");
                                responses_tools.clear();
                                pending_tools.clear();
                                observed_finish_reason = true;
                                events.push(AssistantEvent::StopReason(reason.to_string()));
                                observer.on_message_stop()?;
                                events.push(AssistantEvent::MessageStop);
                                done = true;
                            }
                            _ => {}
                        }
                        if done {
                            break;
                        }
                        continue;
                    }

                    // Extract usage if present (some providers send it).
                    // v0.4.10 T35: read OpenAI's automatic prefix-cache hit
                    // counter from `usage.prompt_tokens_details.cached_tokens`
                    // so /cost and the usage tracker reflect cache savings.
                    // OpenAI's API automatically caches request prefixes
                    // >1024 tokens — the cached portion is billed at a
                    // discount, and previously aris-code threw the number
                    // away (always 0). Anthropic-style cache_creation
                    // doesn't have a direct equivalent on OpenAI; we leave
                    // it 0 (their automatic write-on-first-use is not
                    // reported as a separate quantity).
                    if let Some(usage) = parsed.get("usage") {
                        events.push(AssistantEvent::Usage(token_usage_from_openai_usage(usage)));
                    }

                    let Some(choices) = parsed.get("choices").and_then(|c| c.as_array()) else {
                        continue;
                    };

                    for choice in choices {
                        // OE7 (#249): read finish_reason BEFORE touching
                        // `delta`. Some providers emit a terminal choice
                        // carrying only `finish_reason` and no `delta`; the
                        // old `let Some(delta) = … else continue` skipped
                        // such a choice entirely, so its finish_reason was
                        // never recorded and the EOF completion check below
                        // would not fire. Capture it here, flush after the
                        // delta block (a chunk may carry both tool_calls and
                        // finish_reason — flush last so final args land).
                        let finish_reason = choice_finish_reason(choice);
                        if finish_reason.is_some() {
                            observed_finish_reason = true;
                        }

                        if let Some(delta) = choice.get("delta") {
                            // Display any reasoning_content a compatible provider
                            // emits. Cache/replay remains limited to models known
                            // to accept reasoning_content on subsequent requests.
                            if let Some(rc) =
                                delta.get("reasoning_content").and_then(|r| r.as_str())
                            {
                                if !rc.is_empty() {
                                    observer.on_thinking_delta(rc)?;
                                    current_reasoning.push_str(rc);
                                }
                            }

                            // Text content
                            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                if !content.is_empty() {
                                    observer.on_text_delta(content)?;
                                    push_text_event(&mut events, content.to_string());
                                }
                            }

                            // Tool calls
                            if let Some(tool_calls) =
                                delta.get("tool_calls").and_then(|tc| tc.as_array())
                            {
                                for tc in tool_calls {
                                    accumulate_tool_call(&mut pending_tools, tc);
                                }
                            }
                        }

                        // OE2 (#249): flush on ANY non-empty finish_reason,
                        // not just stop/tool_calls. Non-standard terminal
                        // values (length / content_filter / max_output /
                        // sensitive …) are emitted by some compat providers.
                        // Not logical ToolUse loss-prevention — the
                        // `Ensure MessageStop` fallback below would still
                        // drain leftover pending_tools into events — but
                        // flushing here keeps in-stream ordering AND the
                        // per-tool terminal rendering (`flush_pending_tools`
                        // prints the tool-call start line; the fallback
                        // drain does not).
                        if let Some(reason) = finish_reason {
                            events.push(AssistantEvent::StopReason(reason.to_string()));
                            let partial_tool_payload =
                                finish_reason_may_have_partial_tool_payload(reason);
                            if partial_tool_payload {
                                eprintln!(
                                    "\x1b[33m  OpenAI stream finished with reason='{reason}' — output may be truncated or filtered\x1b[0m"
                                );
                            }
                            if !partial_tool_payload {
                                flush_pending_tools(&mut pending_tools, observer, &mut events)?;
                            }
                        }
                    }
                }

                if done {
                    break;
                }
            }

            // Ensure MessageStop
            if !events
                .iter()
                .any(|e| matches!(e, AssistantEvent::MessageStop))
            {
                let truncated = events.iter().any(|event| {
                    matches!(
                        event,
                        AssistantEvent::StopReason(reason)
                            if finish_reason_may_have_partial_tool_payload(reason.as_str())
                    )
                });
                // Never execute a tool call whose JSON may have been cut off.
                if !truncated {
                    for (id, name, input) in pending_tools.drain(..) {
                        if !name.is_empty() {
                            observer.on_tool_call(&id, &name, &input)?;
                            events.push(AssistantEvent::ToolUse { id, name, input });
                        }
                    }
                }
                observer.on_message_stop()?;
                events.push(AssistantEvent::MessageStop);
            }

            // Kimi-family: save this turn's reasoning_content for replay on
            // later requests. Capped per entry and in total; see
            // `cache_turn_reasoning` for why the total cap refuses new
            // entries instead of evicting already-replayed ones.
            // Persist this turn's reasoning as a session Thinking block so it
            // survives Desktop's per-turn runtime rebuild. The signature decides
            // how (if at all) it is replayed on a later request:
            //   - chat, reasoning_content family (Kimi/MiMo/DeepSeek-R1): tagged
            //     with `OPENAI_REASONING_CONTENT_SIGNATURE` and replayed as the
            //     `reasoning_content` field (B4 — was a per-turn side cache that
            //     never survived the Desktop client rebuild, so replay was dead
            //     there; the block rides the same persisted-signature path the
            //     Responses replay already uses successfully).
            //   - responses with tool calls: the opaque encrypted reasoning
            //     items, replayed as `input` reasoning items across the tool
            //     boundary within the agentic turn.
            //   - everything else (chat non-replay family; a responses no-tool
            //     turn): an empty signature — display-only, never replayed on any
            //     transport (B5 — these turns previously dropped their thinking on
            //     reload while Anthropic turns kept it).
            let has_encrypted_items = !current_responses_reasoning_items.is_empty();
            if !current_reasoning.is_empty() || has_encrypted_items {
                let signature = if use_responses_api {
                    if events
                        .iter()
                        .any(|event| matches!(event, AssistantEvent::ToolUse { .. }))
                    {
                        encode_responses_reasoning_signature(
                            &current_responses_reasoning_items,
                            &self.model,
                        )
                        .unwrap_or_default()
                    } else {
                        String::new()
                    }
                } else if supports_reasoning {
                    OPENAI_REASONING_CONTENT_SIGNATURE.to_string()
                } else {
                    String::new()
                };
                let thinking = truncate_reasoning_per_turn(std::mem::take(&mut current_reasoning));
                // Skip a block that carries neither display text nor a replay
                // payload (nothing to persist).
                if !thinking.is_empty() || !signature.is_empty() {
                    // Insert before the first visible/tool output so reasoning
                    // renders ahead of the answer on reload (matches Anthropic).
                    let insert_at = events
                        .iter()
                        .position(|event| {
                            matches!(
                                event,
                                AssistantEvent::TextDelta(_) | AssistantEvent::ToolUse { .. }
                            )
                        })
                        .unwrap_or(events.len());
                    events.insert(insert_at, AssistantEvent::Thinking { thinking, signature });
                }
            }

            Ok(events)
        });
        match &result {
            Ok(events) => trace_record(
                &self.trace_sink,
                "llm.response",
                json!({
                    "provider": "openai-compatible",
                    "model": &self.model,
                    "eventCount": events.len(),
                    "events": assistant_events_to_value(events),
                }),
            ),
            Err(error) => trace_record(
                &self.trace_sink,
                "llm.error",
                json!({
                    "provider": "openai-compatible",
                    "model": &self.model,
                    "message": error.to_string(),
                    "modelUnavailable": error.is_model_unavailable(),
                    "contextOverflow": error.is_context_overflow(),
                }),
            ),
        }
        result
    }
}

fn flush_pending_tools(
    pending_tools: &mut Vec<(String, String, String)>,
    observer: &mut Box<dyn StreamObserver>,
    events: &mut Vec<AssistantEvent>,
) -> Result<(), RuntimeError> {
    for (id, name, input) in pending_tools.drain(..) {
        if !name.is_empty() {
            observer.on_tool_call(&id, &name, &input)?;
            events.push(AssistantEvent::ToolUse { id, name, input });
        }
    }
    Ok(())
}

// ── Message conversion ──────────────────────────────────────────────────────

#[derive(Debug)]
struct PendingToolCallId {
    source_id: String,
    outbound_id: String,
}

/// Assign request-wide unique tool-call ids without rewriting the local
/// session. Compatible providers occasionally reuse an opaque id in a later
/// turn, and both OpenAI transports reject the replayed history with a
/// `Duplicate 'call_id'` 400. The synthetic sequence is deterministic for a
/// given history, preserving stable prefixes when more turns are appended.
#[derive(Debug, Default)]
struct OutboundToolCallIds {
    used: HashSet<String>,
    next_synthetic: u64,
}

impl OutboundToolCallIds {
    fn allocate(&mut self, source_id: &str) -> String {
        if !source_id.is_empty() && self.used.insert(source_id.to_string()) {
            return source_id.to_string();
        }

        loop {
            self.next_synthetic = self.next_synthetic.saturating_add(1);
            let candidate = format!("call_aris_replay_{:016x}", self.next_synthetic);
            if self.used.insert(candidate.clone()) {
                return candidate;
            }
        }
    }
}

fn convert_messages_openai(
    messages: &[ConversationMessage],
    system_prompt: Option<&str>,
    model: &str,
) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    let mut outbound_tool_call_ids = OutboundToolCallIds::default();
    let mut pending_tool_calls: Vec<PendingToolCallId> = Vec::new();
    let mut orphan_tool_results: Vec<String> = Vec::new();
    // `reasoning_content` replay is only for the families whose chat API accepts
    // it back as input; for everyone else the persisted Thinking block stays
    // display-only. Oldest turns spend the shared budget first, so a long
    // session drops the *newest* reasoning replay while keeping already-sent
    // historical bytes stable (see [`MAX_REASONING_CONTENT_REPLAY_CHARS`]).
    let replay_reasoning_content = supports_reasoning_content_replay(model);
    let mut reasoning_replay_used: usize = 0;

    // System message first
    if let Some(prompt) = system_prompt {
        result.push(json!({
            "role": "system",
            "content": prompt,
        }));
    }

    for message in messages {
        match message.role {
            MessageRole::System => {
                let text = message
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.is_empty() {
                    result.push(json!({
                        "role": "system",
                        "content": text,
                    }));
                }
            }
            MessageRole::User => {
                for block in &message.blocks {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        tool_name,
                        output,
                        ..
                    } = block
                    {
                        push_openai_tool_result_or_recover(
                            &mut result,
                            &mut pending_tool_calls,
                            &mut orphan_tool_results,
                            tool_use_id,
                            tool_name,
                            output,
                        );
                    }
                }
                recover_openai_tool_call_sequence(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut orphan_tool_results,
                );
                let content = openai_user_content(&message.blocks);

                if let Some(content) = content {
                    result.push(json!({
                        "role": "user",
                        "content": content,
                    }));
                }
            }
            MessageRole::Tool => {
                // Tool results
                for block in &message.blocks {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        tool_name,
                        output,
                        ..
                    } = block
                    {
                        push_openai_tool_result_or_recover(
                            &mut result,
                            &mut pending_tool_calls,
                            &mut orphan_tool_results,
                            tool_use_id,
                            tool_name,
                            output,
                        );
                    }
                }
            }
            MessageRole::Assistant => {
                recover_openai_tool_call_sequence(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut orphan_tool_results,
                );
                let mut content_text = String::new();
                let mut tool_calls: Vec<Value> = Vec::new();

                for block in &message.blocks {
                    match block {
                        ContentBlock::Text { text } => {
                            content_text.push_str(text);
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            let outbound_id = outbound_tool_call_ids.allocate(id);
                            pending_tool_calls.push(PendingToolCallId {
                                source_id: id.clone(),
                                outbound_id: outbound_id.clone(),
                            });
                            tool_calls.push(json!({
                                "id": outbound_id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": input,
                                }
                            }));
                        }
                        ContentBlock::ToolResult { .. } => {}
                        ContentBlock::Image { .. } => {}
                        ContentBlock::Thinking { .. } => {}
                    }
                }

                // OpenAI-compatible Chat Completions providers reject an
                // assistant entry without either visible content or function
                // calls. A persisted thinking-only / display-only turn has
                // neither, so replaying it would make every later request for
                // this session fail with HTTP 400. Reasoning that is paired
                // with a text answer or tool call is still replayed below.
                if content_text.is_empty() && tool_calls.is_empty() {
                    continue;
                }

                let mut msg = json!({ "role": "assistant" });
                if !content_text.is_empty() {
                    msg["content"] = json!(content_text);
                }
                if !tool_calls.is_empty() {
                    msg["tool_calls"] = json!(tool_calls);
                }
                // Replay this turn's `reasoning_content` for the families whose
                // chat API accepts it back (Kimi/Moonshot, MiMo, DeepSeek-R1),
                // sourced from the persisted Thinking block tagged with
                // `OPENAI_REASONING_CONTENT_SIGNATURE`. Bounded by the shared
                // budget so a long session does not replay unbounded reasoning.
                if replay_reasoning_content
                    && reasoning_replay_used < MAX_REASONING_CONTENT_REPLAY_CHARS
                {
                    if let Some(reasoning) = message.blocks.iter().find_map(|block| match block {
                        ContentBlock::Thinking {
                            thinking,
                            signature,
                        } if signature.starts_with(OPENAI_REASONING_CONTENT_SIGNATURE)
                            && !thinking.is_empty() =>
                        {
                            Some(thinking.as_str())
                        }
                        _ => None,
                    }) {
                        msg["reasoning_content"] = json!(reasoning);
                        reasoning_replay_used =
                            reasoning_replay_used.saturating_add(reasoning.len());
                    }
                }
                result.push(msg);
            }
        }
    }
    recover_openai_tool_call_sequence(
        &mut result,
        &mut pending_tool_calls,
        &mut orphan_tool_results,
    );

    result
}

fn convert_messages_responses(messages: &[ConversationMessage], model: &str) -> Vec<Value> {
    let mut result = Vec::new();
    let mut outbound_tool_call_ids = OutboundToolCallIds::default();
    let mut pending_tool_calls = Vec::new();
    let mut orphan_tool_results = Vec::new();

    for message in messages {
        match message.role {
            MessageRole::System => {
                let text = message_text(&message.blocks);
                if !text.is_empty() {
                    result.push(json!({ "role": "system", "content": text }));
                }
            }
            MessageRole::User => {
                for block in &message.blocks {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        tool_name,
                        output,
                        ..
                    } = block
                    {
                        push_responses_tool_result_or_recover(
                            &mut result,
                            &mut pending_tool_calls,
                            &mut orphan_tool_results,
                            tool_use_id,
                            tool_name,
                            output,
                        );
                    }
                }
                recover_responses_tool_call_sequence(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut orphan_tool_results,
                );
                if let Some(content) = responses_user_content(&message.blocks) {
                    result.push(json!({ "role": "user", "content": content }));
                }
            }
            MessageRole::Tool => {
                for block in &message.blocks {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        tool_name,
                        output,
                        ..
                    } = block
                    {
                        push_responses_tool_result_or_recover(
                            &mut result,
                            &mut pending_tool_calls,
                            &mut orphan_tool_results,
                            tool_use_id,
                            tool_name,
                            output,
                        );
                    }
                }
            }
            MessageRole::Assistant => {
                recover_responses_tool_call_sequence(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut orphan_tool_results,
                );
                result.extend(responses_reasoning_items_from_blocks(
                    &message.blocks,
                    model,
                ));
                let text = message_text(&message.blocks);
                if !text.is_empty() {
                    result.push(json!({ "role": "assistant", "content": text }));
                }
                for block in &message.blocks {
                    if let ContentBlock::ToolUse { id, name, input } = block {
                        let outbound_id = outbound_tool_call_ids.allocate(id);
                        pending_tool_calls.push(PendingToolCallId {
                            source_id: id.clone(),
                            outbound_id: outbound_id.clone(),
                        });
                        result.push(json!({
                            "type": "function_call",
                            "call_id": outbound_id,
                            "name": name,
                            "arguments": input,
                        }));
                    }
                }
            }
        }
    }
    recover_responses_tool_call_sequence(
        &mut result,
        &mut pending_tool_calls,
        &mut orphan_tool_results,
    );
    result
}

fn message_text(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn responses_user_content(blocks: &[ContentBlock]) -> Option<Value> {
    let has_image = blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::Image { .. }));
    if !has_image {
        let text = message_text(blocks);
        return (!text.is_empty()).then(|| json!(text));
    }
    let content = blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } if !text.is_empty() => Some(json!({
                "type": "input_text",
                "text": text,
            })),
            ContentBlock::Image { media_type, data } => Some(json!({
                "type": "input_image",
                "detail": "auto",
                "image_url": format!("data:{media_type};base64,{data}"),
            })),
            _ => None,
        })
        .collect::<Vec<_>>();
    (!content.is_empty()).then(|| json!(content))
}

fn recover_responses_tool_call_sequence(
    result: &mut Vec<Value>,
    pending_tool_calls: &mut Vec<PendingToolCallId>,
    orphan_tool_results: &mut Vec<String>,
) {
    for pending in pending_tool_calls.drain(..) {
        result.push(json!({
            "type": "function_call_output",
            "call_id": pending.outbound_id,
            "output": "Tool execution stopped before ARIS recorded a result. Treat this as an interrupted or failed tool call and continue from the available context.",
        }));
    }
    for content in orphan_tool_results.drain(..) {
        result.push(json!({ "role": "user", "content": content }));
    }
}

fn push_responses_tool_result_or_recover(
    result: &mut Vec<Value>,
    pending_tool_calls: &mut Vec<PendingToolCallId>,
    orphan_tool_results: &mut Vec<String>,
    tool_use_id: &str,
    tool_name: &str,
    output: &str,
) {
    if let Some(index) = pending_tool_calls
        .iter()
        .position(|pending| pending.source_id == tool_use_id)
    {
        let outbound_id = pending_tool_calls.remove(index).outbound_id;
        result.push(json!({
            "type": "function_call_output",
            "call_id": outbound_id,
            "output": output,
        }));
        return;
    }
    orphan_tool_results.push(format!(
        "[ARIS recovered an orphan tool result not attached to a pending assistant tool call: {tool_name} ({tool_use_id})]\n{output}"
    ));
}

fn recover_openai_tool_call_sequence(
    result: &mut Vec<Value>,
    pending_tool_calls: &mut Vec<PendingToolCallId>,
    orphan_tool_results: &mut Vec<String>,
) {
    for pending in pending_tool_calls.drain(..) {
        let message = json!({
            "role": "tool",
            "tool_call_id": pending.outbound_id,
            "content": "Tool execution stopped before ARIS recorded a result. Treat this as an interrupted or failed tool call and continue from the available context.",
        });
        result.push(message);
    }
    for content in orphan_tool_results.drain(..) {
        result.push(json!({
            "role": "user",
            "content": content,
        }));
    }
}

fn push_openai_tool_result_or_recover(
    result: &mut Vec<Value>,
    pending_tool_calls: &mut Vec<PendingToolCallId>,
    orphan_tool_results: &mut Vec<String>,
    tool_use_id: &str,
    tool_name: &str,
    output: &str,
) {
    if let Some(index) = pending_tool_calls
        .iter()
        .position(|pending| pending.source_id == tool_use_id)
    {
        let outbound_id = pending_tool_calls.remove(index).outbound_id;
        let message = json!({
            "role": "tool",
            "tool_call_id": outbound_id,
            "content": output,
        });
        result.push(message);
        return;
    }

    orphan_tool_results.push(format!(
        "[ARIS recovered an orphan tool result not attached to a pending assistant tool call: {tool_name} ({tool_use_id})]\n{output}"
    ));
}

fn openai_user_content(blocks: &[ContentBlock]) -> Option<Value> {
    let has_image = blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::Image { .. }));
    if !has_image {
        let text = blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        return (!text.is_empty()).then(|| json!(text));
    }

    let content = blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } if !text.is_empty() => Some(json!({
                "type": "text",
                "text": text,
            })),
            ContentBlock::Image { media_type, data } => Some(json!({
                "type": "image_url",
                "image_url": {
                    "url": format!("data:{media_type};base64,{data}"),
                },
            })),
            _ => None,
        })
        .collect::<Vec<_>>();
    (!content.is_empty()).then(|| json!(content))
}

fn convert_tool_spec_openai(spec: &ExecutorToolSpec) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": spec.name,
            "description": spec.description,
            "parameters": spec.input_schema,
        }
    })
}

fn convert_tool_spec_responses(spec: &ExecutorToolSpec) -> Value {
    json!({
        "type": "function",
        "name": spec.name,
        "description": spec.description,
        "parameters": spec.input_schema,
        "strict": false,
    })
}

#[cfg(test)]
#[path = "tests/openai.rs"]
mod tests;
