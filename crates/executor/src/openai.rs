//! OpenAI-compatible executor client for ARIS.
//!
//! Supports any provider that implements the OpenAI `/v1/chat/completions` API:
//! OpenAI, Gemini, DeepSeek, GLM, MiniMax, Moonshot, Qwen, Yi, etc.

use runtime::{
    ApiClient, ApiRequest, AssistantEvent, ContentBlock, ConversationMessage, MessageRole,
    RuntimeError, TokenUsage,
};
use serde_json::{json, Value};

use crate::{
    assistant_events_to_value, interrupted_error, push_text_event, stream_cancel_requested,
    tool_specs_to_value, trace_record, wait_for_stream_cancel, ExecutorToolSpec, ExecutorTraceSink,
    StreamObserver,
};

const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

/// Per-turn reasoning_content size cap (chars; rough proxy for tokens ~4:1).
/// Captures up to ~8K tokens of thinking per assistant turn before truncating.
/// Long reasoning traces still go to the model in real-time; only the cache
/// entry for replay is capped, preventing the request body from ballooning
/// over many turns.
const MAX_REASONING_CHARS_PER_TURN: usize = 32_000;

/// Total reasoning_cache size cap (sum of all turns' cached reasoning,
/// bytes — implementation uses `String::len`). When exceeded, oldest
/// turns are evicted. ~32K tokens for ASCII; multi-byte chars trim
/// faster (acceptable conservative bound for non-ASCII reasoning).
const MAX_REASONING_CACHE_TOTAL_CHARS: usize = 128_000;

/// Whether this model accepts an OpenAI-style `reasoning_effort` request field.
/// Heuristic-only: matches OpenAI reasoning families (o1/o3/o4, gpt-5.5+) and
/// providers that advertise an explicit thinking/reasoner variant.
///
/// v0.4.12 P1.B: uses [`word_match`] so provider-prefixed model names like
/// `openai/o3-mini` or `proxy:o4` are recognised — `starts_with("o3")` was
/// the prior gate and missed those.
#[must_use]
fn supports_reasoning_effort(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    word_match(&m, "o1")
        || word_match(&m, "o3")
        || word_match(&m, "o4")
        || m.contains("gpt-5.5")
        || m.contains("gpt-5.6")
        || m.contains("reasoner")
        || m.contains("thinking")
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
/// context/length/token keyword paired with an over-limit keyword.
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
        "上下文",
    ];
    if DIRECT_PHRASES.iter().any(|p| lower.contains(p)) {
        return true;
    }
    // Looser fallback: a context/length/token subject paired with an
    // over-limit verb in the same body.
    const SUBJECT: &[&str] = &["context window", "context length", "token", "tokens"];
    const OVER_LIMIT: &[&str] = &["exceed", "too long", "too many", "over the limit", "超过"];
    SUBJECT.iter().any(|s| lower.contains(s)) && OVER_LIMIT.iter().any(|o| lower.contains(o))
}

/// v0.4.12 P1.B — word-boundary match (treats `-`, `_`, `/`, `:` and start /
/// end of string as boundaries). Mirrors `runtime::usage::has_word` so the
/// executor's capability detection stays consistent with the pricing table.
fn word_match(haystack: &str, needle: &str) -> bool {
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

/// Whether this model EMITS `reasoning_content` blocks in the response that
/// we should cache and replay on subsequent turns. Superset of
/// [`supports_reasoning_effort`] — Kimi/Moonshot emit reasoning_content
/// without accepting reasoning_effort as a request field (the original
/// reason this cache exists), so we treat the two capabilities separately.
/// v0.4.7's hardcoded `supports_reasoning = true` shipped reasoning to
/// every provider; v0.4.9 gates it.
#[must_use]
fn supports_reasoning_content_replay(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    supports_reasoning_effort(&m)
        || m.contains("kimi")
        || m.contains("moonshot")
        || m.contains("mimo")
        || m.contains("deepseek-r1")
        || m.contains("-r1")
}

/// Effort tier sent alongside reasoning-capable models. Reads
/// `ARIS_REASONING_EFFORT` and falls back to `xhigh`. Valid values per OpenAI
/// reasoning API: `none` / `minimal` / `low` / `medium` / `high` / `xhigh`.
#[must_use]
fn reasoning_effort() -> String {
    std::env::var("ARIS_REASONING_EFFORT")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "xhigh".to_string())
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
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let output_tokens = usage
        .get("completion_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let cached_tokens = usage
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    // OpenAI-compatible usage reports `prompt_tokens` as cache-inclusive.
    // ARIS stores provider usage in Anthropic-style normalized form: fresh
    // input is separate from cache reads, so input + cache_read == real prompt
    // occupancy without double-counting cache tokens in cost summaries.
    TokenUsage {
        input_tokens: prompt_tokens.saturating_sub(cached_tokens),
        output_tokens,
        cache_creation_input_tokens: 0,
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
        let send_result = http
            .post(url)
            .bearer_auth(api_key)
            .header("content-type", "application/json")
            .json(body)
            .send()
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
                let transient = e.is_timeout() || e.is_connect() || e.is_request() || e.is_body();
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
    /// Kimi K2.5: stores reasoning_content per assistant turn for replay.
    /// Key = message index in session, Value = reasoning text.
    kimi_reasoning_cache: std::collections::HashMap<usize, String>,
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
                .build()
                .map_err(|error| error.to_string())?,
            api_key: config.api_key,
            base_url: config.base_url,
            model,
            enable_tools,
            tool_specs,
            observer,
            trace_sink: None,
            kimi_reasoning_cache: std::collections::HashMap::new(),
        })
    }

    #[must_use]
    pub fn with_trace_sink(mut self, trace_sink: std::sync::Arc<dyn ExecutorTraceSink>) -> Self {
        self.trace_sink = Some(trace_sink);
        self
    }
}

impl ApiClient for OpenAIRuntimeClient {
    fn on_session_compacted(&mut self, removed_count: usize) {
        // reasoning_cache is keyed by absolute message index in the session.
        // After auto-compaction the session is replaced with [summary,
        // ...preserved_tail], so every index in the cache now points at the
        // wrong message (or no message at all). Re-populating organically
        // from subsequent assistant turns is cheaper and more correct than
        // attempting an index remap. Clear unconditionally.
        if removed_count > 0 && !self.kimi_reasoning_cache.is_empty() {
            self.kimi_reasoning_cache.clear();
        }
    }

    #[allow(clippy::too_many_lines)]
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let system_prompt = if request.system_prompt.is_empty() {
            None
        } else {
            Some(request.system_prompt.join("\n\n"))
        };

        // Provider-aware reasoning_content capture. v0.4.9 closes Codex
        // v0.4.7 audit L4: was hardcoded `true` for every model. We use the
        // separate `supports_reasoning_content_replay` predicate (superset
        // of reasoning_effort senders) so Kimi/Moonshot/DeepSeek-R1, which
        // emit reasoning_content but don't accept reasoning_effort as a
        // request field, still get cached and replayed.
        let supports_reasoning = supports_reasoning_content_replay(&self.model);
        let messages = convert_messages_openai(
            &request.messages,
            system_prompt.as_deref(),
            &self.kimi_reasoning_cache,
        );

        let tools: Option<Value> = self.enable_tools.then(|| {
            json!(self
                .tool_specs
                .iter()
                .map(convert_tool_spec_openai)
                .collect::<Vec<_>>())
        });

        let mut body = json!({
            "model": self.model,
            "stream": true,
            // v0.4.10 T35: OpenAI Chat Completions API does NOT emit
            // `usage` in streaming chunks by default. Opt in with
            // `stream_options.include_usage = true` so we can read
            // `prompt_tokens_details.cached_tokens` (automatic prefix
            // cache hits) and report token cost accurately.
            "stream_options": { "include_usage": true },
            "messages": messages,
        });

        if let Some(tools) = tools {
            body["tools"] = tools;
            body["tool_choice"] = json!("auto");
        }

        // For reasoning-capable models, attach the effort tier so the server
        // doesn't silently default to medium. Safe for o1/o3/o4/gpt-5.5/
        // thinking variants; older models would reject this field, hence the
        // explicit allow-list.
        //
        // OpenAI gate (v0.4.8): when both `tools` and `reasoning_effort` are
        // present, gpt-5.5 + the OpenAI /v1/chat/completions endpoint returns
        // 400 "Function tools with reasoning_effort are not supported …,
        // please use /v1/responses instead". The CLI executor always sends
        // tools (enable_tools = true for the agent loop), so for OpenAI's own
        // gpt-5.5 we strip reasoning_effort and warn. Third-party providers
        // that ship gpt-5.5-compatible models without this restriction (e.g.
        // some proxies) opt back in by setting ARIS_FORCE_REASONING_WITH_TOOLS=1.
        // Proper fix (Responses API support) is tracked for v0.4.9.
        let on_openai = self.base_url.contains("api.openai.com");
        let model_lower = self.model.to_ascii_lowercase();
        let openai_tool_reasoning_block = self.enable_tools
            && on_openai
            && (model_lower.contains("gpt-5.5")
                || model_lower.contains("gpt-5.6")
                || word_match(&model_lower, "o3")
                || word_match(&model_lower, "o4"));
        let force_with_tools = std::env::var("ARIS_FORCE_REASONING_WITH_TOOLS")
            .ok()
            .as_deref()
            == Some("1");
        if supports_reasoning_effort(&self.model)
            && (!openai_tool_reasoning_block || force_with_tools)
        {
            body["reasoning_effort"] = json!(reasoning_effort());
        } else if openai_tool_reasoning_block && !force_with_tools {
            // One-shot warning per process so users understand why their
            // gpt-5.5 executor is running at default reasoning. Stderr to
            // avoid polluting stdout JSON parsers.
            static WARNED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
            WARNED.get_or_init(|| {
                eprintln!(
                    "\x1b[33mwarning:\x1b[0m {} as executor on OpenAI does not accept \
`reasoning_effort` when tools are enabled (OpenAI /v1/chat/completions returns 400). \
Continuing without reasoning_effort. Set ARIS_FORCE_REASONING_WITH_TOOLS=1 to override \
on a compatible third-party proxy, or use Claude/another provider as executor and keep \
{} as reviewer (LlmReview path is unaffected).",
                    self.model, self.model
                );
            });
        }

        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        trace_record(
            &self.trace_sink,
            "llm.tools_snapshot",
            json!({
                "provider": "openai-compatible",
                "model": &self.model,
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
                "endpoint": "/chat/completions",
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
                let send_result = self
                    .http
                    .post(&url)
                    .bearer_auth(&self.api_key)
                    .header("content-type", "application/json")
                    .json(&body)
                    .send()
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
                                    "requestId": response_request_id(resp.headers()),
                                    "stream": true,
                                }),
                            );
                            break resp;
                        }
                        if retryable && attempt < MAX_ATTEMPTS {
                            let request_id = response_request_id(resp.headers());
                            let response_headers = response_header_trace_value(resp.headers());
                            let retry_after_secs = resp
                                .headers()
                                .get("retry-after")
                                .and_then(|v| v.to_str().ok())
                                .and_then(|s| s.parse::<u64>().ok());
                            let backoff_ms = if let Some(secs) = retry_after_secs {
                                (secs * 1000).min(10_000)
                            } else {
                                (1u64 << (attempt - 1)) * 1000 // 1s, 2s, 4s
                            };
                            let body_preview = resp.text().await.unwrap_or_default();
                            let preview: String = body_preview.chars().take(160).collect();
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
                                    "bodyPreview": body_preview_trace(&body_preview),
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
                        let body_text = resp.text().await.unwrap_or_else(|_| String::new());

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
                        let transient = e.is_timeout() || e.is_connect() || e.is_request() || e.is_body();
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

            let mut events: Vec<AssistantEvent> = Vec::new();
            let observer = &mut self.observer;

            // Kimi: accumulate reasoning_content from this turn
            let mut current_reasoning = String::new();
            let current_msg_index = request.messages.len(); // index of the new assistant msg

            // Accumulate tool calls: index → (id, name, arguments_json)
            let mut pending_tools: Vec<(String, String, String)> = Vec::new();

            let mut stream_buf = String::new();
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
                let text = String::from_utf8_lossy(&chunk);
                stream_buf.push_str(&text);

                // Process complete SSE lines
                while let Some(line_end) = stream_buf.find('\n') {
                    let line = stream_buf[..line_end].trim_end_matches('\r').to_string();
                    stream_buf = stream_buf[line_end + 1..].to_string();

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
                    if let Some(detail) = stream_error_detail(&parsed) {
                        if nothing_emitted_yet(&events, &pending_tools, &current_reasoning) {
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

            // Kimi: save reasoning_content for this turn so we can replay it.
            // v0.4.9 L4: capped at MAX_REASONING_CHARS_PER_TURN per entry +
            // MAX_REASONING_CACHE_TOTAL_CHARS across all entries (oldest
            // evicted first) so the request body doesn't balloon over a
            // long session.
            if supports_reasoning && !current_reasoning.is_empty() {
                if current_reasoning.chars().count() > MAX_REASONING_CHARS_PER_TURN {
                    // UTF-8-safe truncate at char boundary
                    let byte_idx = current_reasoning
                        .char_indices()
                        .nth(MAX_REASONING_CHARS_PER_TURN)
                        .map(|(i, _)| i)
                        .unwrap_or(current_reasoning.len());
                    current_reasoning.truncate(byte_idx);
                }
                self.kimi_reasoning_cache
                    .insert(current_msg_index, current_reasoning);

                // Enforce total-size cap by evicting oldest entries (smallest
                // msg_idx) until we're back under MAX_REASONING_CACHE_TOTAL_CHARS.
                while self
                    .kimi_reasoning_cache
                    .values()
                    .map(String::len)
                    .sum::<usize>()
                    > MAX_REASONING_CACHE_TOTAL_CHARS
                {
                    let Some(oldest_idx) =
                        self.kimi_reasoning_cache.keys().copied().min()
                    else {
                        break;
                    };
                    if oldest_idx == current_msg_index {
                        // Never evict the entry we just inserted; if total cap is
                        // smaller than a single turn, accept the overflow (the
                        // per-turn truncate already bounded it).
                        break;
                    }
                    self.kimi_reasoning_cache.remove(&oldest_idx);
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

fn convert_messages_openai(
    messages: &[ConversationMessage],
    system_prompt: Option<&str>,
    kimi_reasoning_cache: &std::collections::HashMap<usize, String>,
) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    let mut pending_tool_call_ids: Vec<String> = Vec::new();
    let mut orphan_tool_results: Vec<String> = Vec::new();

    // System message first
    if let Some(prompt) = system_prompt {
        result.push(json!({
            "role": "system",
            "content": prompt,
        }));
    }

    for (msg_idx, message) in messages.iter().enumerate() {
        match message.role {
            MessageRole::System => {
                // Already handled above
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
                            &mut pending_tool_call_ids,
                            &mut orphan_tool_results,
                            tool_use_id,
                            tool_name,
                            output,
                        );
                    }
                }
                recover_openai_tool_call_sequence(
                    &mut result,
                    &mut pending_tool_call_ids,
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
                            &mut pending_tool_call_ids,
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
                    &mut pending_tool_call_ids,
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
                            pending_tool_call_ids.push(id.clone());
                            tool_calls.push(json!({
                                "id": id,
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

                let mut msg = json!({ "role": "assistant" });
                if !content_text.is_empty() {
                    msg["content"] = json!(content_text);
                }
                if !tool_calls.is_empty() {
                    msg["tool_calls"] = json!(tool_calls);
                }
                // Attach cached reasoning_content for providers that support
                // thinking mode (Kimi, Xiaomi MiMo, DeepSeek R1, etc.)
                if let Some(reasoning) = kimi_reasoning_cache.get(&msg_idx) {
                    if !reasoning.is_empty() {
                        msg["reasoning_content"] = json!(reasoning);
                    }
                }
                result.push(msg);
            }
        }
    }
    recover_openai_tool_call_sequence(
        &mut result,
        &mut pending_tool_call_ids,
        &mut orphan_tool_results,
    );

    result
}

fn recover_openai_tool_call_sequence(
    result: &mut Vec<Value>,
    pending_tool_call_ids: &mut Vec<String>,
    orphan_tool_results: &mut Vec<String>,
) {
    for tool_call_id in pending_tool_call_ids.drain(..) {
        result.push(json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": "Tool execution stopped before ARIS recorded a result. Treat this as an interrupted or failed tool call and continue from the available context.",
        }));
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
    pending_tool_call_ids: &mut Vec<String>,
    orphan_tool_results: &mut Vec<String>,
    tool_use_id: &str,
    tool_name: &str,
    output: &str,
) {
    if let Some(index) = pending_tool_call_ids
        .iter()
        .position(|pending| pending == tool_use_id)
    {
        pending_tool_call_ids.remove(index);
        result.push(json!({
            "role": "tool",
            "tool_call_id": tool_use_id,
            "content": output,
        }));
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

#[cfg(test)]
#[path = "tests/openai.rs"]
mod tests;
