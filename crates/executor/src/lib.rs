//! Shared executor layer for ARIS.
//!
//! This crate owns provider request/stream parsing. UI surfaces pass in a
//! [`StreamObserver`] for rendering or event emission; the executor itself only
//! returns normalized [`runtime::AssistantEvent`] values.

use api::{
    AnthropicClient, AuthSource, ContentBlockDelta, ImageSource, InputContentBlock, InputMessage,
    MessageRequest, MessageResponse, OutputContentBlock, StreamEvent as ApiStreamEvent,
    ThinkingConfig, ToolChoice, ToolDefinition, ToolResultContentBlock,
};
use runtime::{
    ApiClient, ApiRequest, AssistantEvent, ContentBlock, ConversationMessage, MessageRole,
    RuntimeError, TokenUsage,
};
use serde_json::{json, Value};
use std::sync::Arc;

mod openai;

pub use openai::{
    chat_requires_responses_transport, resolve_openai_executor_config,
    responses_transport_unsupported, set_transport_verdict_hook, OpenAIExecutorConfig,
    OpenAIRuntimeClient, OpenAiTransport,
};

#[derive(Debug, Clone)]
pub struct ExecutorToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

impl ExecutorToolSpec {
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        input_schema: serde_json::Value,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema,
        }
    }
}

pub trait StreamObserver: Send {
    fn on_text_delta(&mut self, _text: &str) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn on_thinking_delta(&mut self, _thinking: &str) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn on_tool_call(&mut self, _id: &str, _name: &str, _input: &str) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn on_message_stop(&mut self) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn is_cancelled(&self) -> bool {
        false
    }
}

pub struct NoopStreamObserver;

impl StreamObserver for NoopStreamObserver {}

pub trait ExecutorTraceSink: Send + Sync {
    fn record(&self, kind: &str, payload: Value);

    /// A narrow lifecycle signal that must remain available to interactive
    /// surfaces even when verbose wire tracing is disabled. Implementations
    /// must not assume `payload` is safe to persist or render verbatim.
    fn record_retry_lifecycle(&self, _kind: &str, _payload: Value) {}
}

fn trace_record(trace_sink: &Option<Arc<dyn ExecutorTraceSink>>, kind: &str, payload: Value) {
    // Retry state is also a live UI lifecycle signal.  Keep emitting that
    // narrow, sanitized category even when verbose wire diagnostics are off;
    // otherwise the desktop can appear frozen during a bounded backoff.
    let retry_lifecycle_event = matches!(kind, "llm.retry" | "llm.request_adjusted");
    if let Some(sink) = trace_sink {
        let payload = govern_trace_payload(payload);
        if wire_trace_enabled() {
            sink.record(kind, payload);
        } else if retry_lifecycle_event {
            sink.record_retry_lifecycle(kind, payload);
        }
    }
}

struct ApiTraceSinkAdapter {
    inner: Arc<dyn ExecutorTraceSink>,
}

impl api::ApiTraceSink for ApiTraceSinkAdapter {
    fn record(&self, kind: &str, payload: Value) {
        let retry_lifecycle_event = matches!(kind, "llm.retry" | "llm.request_adjusted");
        if wire_trace_enabled() {
            self.inner.record(kind, govern_trace_payload(payload));
        } else if retry_lifecycle_event {
            self.inner
                .record_retry_lifecycle(kind, govern_trace_payload(payload));
        }
    }
}

fn api_trace_sink_adapter(
    trace_sink: &Option<Arc<dyn ExecutorTraceSink>>,
) -> Option<Arc<dyn api::ApiTraceSink>> {
    trace_sink.as_ref().map(|sink| {
        Arc::new(ApiTraceSinkAdapter {
            inner: sink.clone(),
        }) as Arc<dyn api::ApiTraceSink>
    })
}

fn wire_trace_enabled() -> bool {
    std::env::var("ARIS_WIRE_TRACE")
        .ok()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            !matches!(normalized.as_str(), "0" | "false" | "off" | "no")
        })
        .unwrap_or(true)
}

fn trace_max_string_chars() -> usize {
    std::env::var("ARIS_WIRE_TRACE_MAX_STRING_CHARS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(64_000)
}

fn govern_trace_payload(payload: Value) -> Value {
    govern_trace_value(payload, None, trace_max_string_chars())
}

fn govern_trace_value(value: Value, key: Option<&str>, max_string_chars: usize) -> Value {
    if key.is_some_and(is_sensitive_trace_key) {
        return Value::String("<redacted>".to_string());
    }
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    let governed = govern_trace_value(value, Some(&key), max_string_chars);
                    (key, governed)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| govern_trace_value(item, key, max_string_chars))
                .collect(),
        ),
        Value::String(text) => govern_trace_string(key, text, max_string_chars),
        other => other,
    }
}

fn govern_trace_string(key: Option<&str>, text: String, max_string_chars: usize) -> Value {
    if key.is_some_and(is_binary_trace_key) && text.chars().count() > 256 {
        return json!({
            "redacted": true,
            "reason": "binary_or_base64_payload",
            "chars": text.chars().count(),
        });
    }
    if looks_like_secret_bearing_string(&text) {
        return Value::String("<redacted>".to_string());
    }
    truncate_trace_string(text, max_string_chars)
}

fn truncate_trace_string(text: String, max_string_chars: usize) -> Value {
    let char_count = text.chars().count();
    if char_count <= max_string_chars {
        return Value::String(text);
    }
    let preview: String = text.chars().take(max_string_chars).collect();
    json!({
        "truncated": true,
        "chars": char_count,
        "preview": preview,
    })
}

fn is_sensitive_trace_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("authorization")
        || lower.contains("password")
        || lower.contains("secret")
        || lower.contains("token")
        || lower.ends_with("_key")
        || lower.ends_with("_secret")
        || lower.ends_with("_token")
}

fn is_binary_trace_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "data" | "image" | "bytes" | "base64" | "content_bytes"
    )
}

fn looks_like_secret_bearing_string(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("bearer ")
        || lower.contains("authorization:")
        || lower.contains("api_key=")
        || lower.contains("apikey=")
        || lower.contains("access_token=")
        || lower.contains("refresh_token=")
        || lower.contains("token=")
        || lower.contains("sk-")
}

fn token_usage_to_value(usage: &TokenUsage) -> Value {
    json!({
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "cacheCreationInputTokens": usage.cache_creation_input_tokens,
        "cacheReadInputTokens": usage.cache_read_input_tokens,
        "promptTokens": usage.prompt_tokens(),
        "totalTokens": usage.total_tokens(),
    })
}

fn assistant_event_to_value(event: &AssistantEvent) -> Value {
    match event {
        AssistantEvent::TextDelta(text) => json!({
            "type": "text_delta",
            "text": text,
        }),
        AssistantEvent::ToolUse { id, name, input } => json!({
            "type": "tool_use",
            "id": id,
            "name": name,
            "input": input,
        }),
        AssistantEvent::Thinking {
            thinking,
            signature,
        } => json!({
            "type": "thinking",
            "thinking": thinking,
            "signature": signature,
        }),
        AssistantEvent::Usage(usage) => json!({
            "type": "usage",
            "usage": token_usage_to_value(usage),
        }),
        AssistantEvent::StopReason(reason) => json!({
            "type": "stop_reason",
            "reason": reason,
        }),
        AssistantEvent::MessageStop => json!({
            "type": "message_stop",
        }),
    }
}

fn assistant_events_to_value(events: &[AssistantEvent]) -> Value {
    Value::Array(events.iter().map(assistant_event_to_value).collect())
}

fn tool_specs_to_value(tool_specs: &[ExecutorToolSpec]) -> Value {
    Value::Array(
        tool_specs
            .iter()
            .map(|spec| {
                json!({
                    "name": &spec.name,
                    "description": &spec.description,
                    "inputSchema": &spec.input_schema,
                })
            })
            .collect(),
    )
}

pub(crate) fn stream_cancel_requested(observer: &dyn StreamObserver) -> bool {
    runtime::is_interrupted() || observer.is_cancelled()
}

pub(crate) fn interrupted_error() -> RuntimeError {
    if runtime::is_interrupted() {
        runtime::clear_interrupt();
    }
    RuntimeError::new("interrupted by user")
}

pub(crate) async fn wait_for_stream_cancel(observer: &dyn StreamObserver) {
    loop {
        if stream_cancel_requested(observer) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

fn merge_anthropic_stream_usage(
    start: Option<&api::Usage>,
    delta: &api::Usage,
    input_from_delta: &mut bool,
) -> TokenUsage {
    let mut usage = TokenUsage {
        input_tokens: start.map_or(delta.input_tokens, |usage| usage.input_tokens),
        output_tokens: delta.output_tokens,
        cache_creation_input_tokens: start.map_or(delta.cache_creation_input_tokens, |usage| {
            usage.cache_creation_input_tokens
        }),
        cache_read_input_tokens: start.map_or(delta.cache_read_input_tokens, |usage| {
            usage.cache_read_input_tokens
        }),
    };

    // Some Anthropic-compatible SSE providers report the full context in
    // `message_start`, then the corrected fresh-input count in `message_delta`.
    // Prefer the smaller positive delta input and copy cache counters from the
    // same block when present; otherwise keep start values as best-effort
    // fallback.
    let should_use_delta_input = delta.input_tokens > 0
        && (usage.input_tokens == 0
            || delta.input_tokens < usage.input_tokens
            || (*input_from_delta && delta.input_tokens <= usage.input_tokens));

    if should_use_delta_input {
        usage.input_tokens = delta.input_tokens;
        *input_from_delta = true;
        if delta.cache_creation_input_tokens > 0 {
            usage.cache_creation_input_tokens = delta.cache_creation_input_tokens;
        }
        if delta.cache_read_input_tokens > 0 {
            usage.cache_read_input_tokens = delta.cache_read_input_tokens;
        }
    } else {
        if usage.cache_creation_input_tokens == 0 {
            usage.cache_creation_input_tokens = delta.cache_creation_input_tokens;
        }
        if usage.cache_read_input_tokens == 0 {
            usage.cache_read_input_tokens = delta.cache_read_input_tokens;
        }
    }

    usage
}

fn push_text_event(events: &mut Vec<AssistantEvent>, text: String) {
    if text.is_empty() {
        return;
    }
    if let Some(AssistantEvent::TextDelta(existing)) = events.last_mut() {
        existing.push_str(&text);
    } else {
        events.push(AssistantEvent::TextDelta(text));
    }
}

pub enum ExecutorClient {
    Anthropic(AnthropicRuntimeClient),
    OpenAI(OpenAIRuntimeClient),
}

impl ApiClient for ExecutorClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        match self {
            Self::Anthropic(client) => client.stream(request),
            Self::OpenAI(client) => client.stream(request),
        }
    }

    fn on_session_compacted(&mut self, removed_count: usize) {
        match self {
            Self::Anthropic(_) => {}
            Self::OpenAI(client) => client.on_session_compacted(removed_count),
        }
    }
}

pub struct AnthropicRuntimeClient {
    runtime: tokio::runtime::Runtime,
    client: AnthropicClient,
    model: String,
    enable_tools: bool,
    tool_specs: Vec<ExecutorToolSpec>,
    max_tokens: u32,
    observer: Box<dyn StreamObserver>,
    base_url: String,
    send_betas: bool,
    trace_sink: Option<Arc<dyn ExecutorTraceSink>>,
}

impl AnthropicRuntimeClient {
    pub fn new(
        auth: AuthSource,
        base_url: String,
        send_betas: bool,
        model: String,
        enable_tools: bool,
        tool_specs: Vec<ExecutorToolSpec>,
        max_tokens: u32,
        observer: Box<dyn StreamObserver>,
    ) -> Result<Self, String> {
        Ok(Self {
            runtime: tokio::runtime::Runtime::new().map_err(|error| error.to_string())?,
            client: AnthropicClient::from_auth(auth)
                .with_base_url(base_url.clone())
                .with_send_betas(send_betas),
            model,
            enable_tools,
            tool_specs,
            max_tokens,
            observer,
            base_url,
            send_betas,
            trace_sink: None,
        })
    }

    #[must_use]
    pub fn with_trace_sink(mut self, trace_sink: Arc<dyn ExecutorTraceSink>) -> Self {
        if let Some(api_trace_sink) = api_trace_sink_adapter(&Some(trace_sink.clone())) {
            self.client = self.client.clone().with_trace_sink(api_trace_sink);
        }
        self.trace_sink = Some(trace_sink);
        self
    }
}

fn anthropic_thinking_config(model: &str, max_tokens: u32) -> Option<ThinkingConfig> {
    if !model.to_ascii_lowercase().contains("claude") {
        return None;
    }
    let effort = std::env::var("ARIS_REASONING_EFFORT")
        .ok()
        .unwrap_or_else(|| "high".to_string())
        .trim()
        .to_ascii_lowercase();
    let requested = match effort.as_str() {
        "none" | "minimal" => return None,
        "low" => 1_024,
        "medium" => 4_096,
        "high" => 8_192,
        "xhigh" => 16_384,
        _ => 8_192,
    };
    // Anthropic requires the thinking budget to fit below max_tokens. Keep a
    // small visible-output allowance and omit thinking when the model's turn
    // budget is too small to satisfy the protocol minimum.
    let budget_tokens = requested.min(max_tokens.saturating_sub(1_024));
    (budget_tokens >= 1_024).then_some(ThinkingConfig {
        kind: "enabled".to_string(),
        budget_tokens,
    })
}

impl ApiClient for AnthropicRuntimeClient {
    #[allow(clippy::too_many_lines)]
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let message_request = MessageRequest {
            model: self.model.clone(),
            max_tokens: self.max_tokens,
            messages: convert_messages(&request.messages),
            system: if request.system_prompt.is_empty() {
                None
            } else {
                let prompt = request.system_prompt.join("\n\n");
                let is_oauth = self.client.auth_source().bearer_token().is_some()
                    && self.client.auth_source().api_key().is_none();
                let cache_control = if is_oauth {
                    json!({ "type": "ephemeral", "ttl": "1h" })
                } else {
                    json!({ "type": "ephemeral" })
                };
                Some(json!([{
                    "type": "text",
                    "text": prompt,
                    "cache_control": cache_control
                }]))
            },
            tools: self.enable_tools.then(|| {
                self.tool_specs
                    .iter()
                    .map(|spec| ToolDefinition {
                        name: spec.name.clone(),
                        description: Some(spec.description.clone()),
                        input_schema: spec.input_schema.clone(),
                    })
                    .collect()
            }),
            tool_choice: self.enable_tools.then_some(ToolChoice::Auto),
            thinking: anthropic_thinking_config(&self.model, self.max_tokens),
            stream: true,
        };

        trace_record(
            &self.trace_sink,
            "llm.tools_snapshot",
            json!({
                "provider": "anthropic",
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
                "provider": "anthropic",
                "model": &self.model,
                "baseUrl": &self.base_url,
                "endpoint": "/v1/messages",
                "stream": true,
                "sendBetas": self.send_betas,
                "systemPromptPartCount": request.system_prompt.len(),
                "messageCount": request.messages.len(),
                "request": serde_json::to_value(&message_request).unwrap_or(Value::Null),
            }),
        );

        let client = &self.client;
        let observer = &mut self.observer;
        let trace_sink = self.trace_sink.clone();
        let trace_model = self.model.clone();
        let result = self.runtime.block_on(async {
            // Tag a "model unavailable on this account" failure (404
            // not_found_error from the initial POST) so the CLI can fall back
            // from the default Opus 4.8 to 4.7.
            let mut stream = tokio::select! {
                result = client.stream_message(&message_request) => {
                    result.map_err(|error| {
                    if error.is_model_unavailable() {
                        RuntimeError::model_unavailable(error.to_string())
                    } else if openai::is_context_window_exceeded_error(&error.to_string()) {
                        // Anthropic 400 "prompt is too long: N tokens > M
                        // maximum" — tag so the conversation loop force-compacts
                        // and retries instead of failing the turn.
                        RuntimeError::context_overflow(error.to_string())
                    } else {
                        RuntimeError::new(error.to_string())
                    }
                    })?
                }
                () = wait_for_stream_cancel(observer.as_ref()) => {
                    return Err(interrupted_error());
                }
            };
            trace_record(
                &trace_sink,
                "llm.response_start",
                json!({
                    "provider": "anthropic",
                    "model": &trace_model,
                    "requestId": stream.request_id(),
                    "stream": true,
                }),
            );
            let mut events = Vec::new();
            let mut pending_tool: Option<(String, String, String)> = None;
            let mut pending_thinking: Option<(String, String)> = None;
            let mut saw_stop = false;
            let mut stop_reason: Option<String> = None;
            let mut start_usage: Option<api::Usage> = None;
            let mut input_from_delta = false;

            loop {
                let next_event = tokio::select! {
                    result = stream.next_event_with_raw() => result,
                    () = wait_for_stream_cancel(observer.as_ref()) => {
                        return Err(interrupted_error());
                    }
                };
                let parsed_event = match next_event {
                    Ok(Some(event)) => event,
                    Ok(None) => break,
                    Err(_error)
                        if !events.is_empty()
                            || pending_tool.is_some()
                            || pending_thinking.is_some() =>
                    {
                        stop_reason = Some("stream_error_after_partial_output".to_string());
                        break;
                    }
                    Err(error) => return Err(RuntimeError::new(error.to_string())),
                };
                if stream_cancel_requested(observer.as_ref()) {
                    return Err(interrupted_error());
                }
                trace_record(
                    &trace_sink,
                    "llm.raw_sse",
                    json!({
                        "provider": "anthropic",
                        "model": &trace_model,
                        "requestId": stream.request_id(),
                        "raw": &parsed_event.raw_data,
                    }),
                );
                trace_record(
                    &trace_sink,
                    "llm.provider_event",
                    json!({
                        "provider": "anthropic",
                        "model": &trace_model,
                        "requestId": stream.request_id(),
                        "event": serde_json::to_value(&parsed_event.event).unwrap_or(Value::Null),
                    }),
                );
                let event = parsed_event.event;
                match event {
                    ApiStreamEvent::MessageStart(start) => {
                        start_usage = Some(start.message.usage.clone());
                        for block in start.message.content {
                            push_output_block(block, observer, &mut events, &mut pending_tool)?;
                        }
                    }
                    ApiStreamEvent::ContentBlockStart(start) => {
                        if let OutputContentBlock::Thinking {
                            thinking,
                            signature,
                        } = &start.content_block
                        {
                            if !thinking.is_empty() {
                                observer.on_thinking_delta(thinking)?;
                            }
                            pending_thinking = Some((thinking.clone(), signature.clone()));
                        } else {
                            push_output_block(
                                start.content_block,
                                observer,
                                &mut events,
                                &mut pending_tool,
                            )?;
                        }
                    }
                    ApiStreamEvent::ContentBlockDelta(delta) => match delta.delta {
                        ContentBlockDelta::TextDelta { text } => {
                            if !text.is_empty() {
                                observer.on_text_delta(&text)?;
                                push_text_event(&mut events, text);
                            }
                        }
                        ContentBlockDelta::InputJsonDelta { partial_json } => {
                            if let Some((_, _, input)) = &mut pending_tool {
                                input.push_str(&partial_json);
                            }
                        }
                        ContentBlockDelta::ThinkingDelta { thinking } => {
                            if let Some((text, _)) = &mut pending_thinking {
                                text.push_str(&thinking);
                            }
                            if !thinking.is_empty() {
                                observer.on_thinking_delta(&thinking)?;
                            }
                        }
                        ContentBlockDelta::SignatureDelta { signature } => {
                            if let Some((_, sig)) = &mut pending_thinking {
                                *sig = signature;
                            }
                        }
                    },
                    ApiStreamEvent::ContentBlockStop(_) => {
                        if let Some((id, name, input)) = pending_tool.take() {
                            observer.on_tool_call(&id, &name, &input)?;
                            events.push(AssistantEvent::ToolUse { id, name, input });
                        }
                        if let Some((thinking, signature)) = pending_thinking.take() {
                            events.push(AssistantEvent::Thinking {
                                thinking,
                                signature,
                            });
                        }
                    }
                    ApiStreamEvent::MessageDelta(delta) => {
                        if let Some(reason) =
                            delta.delta.stop_reason.filter(|value| !value.is_empty())
                        {
                            stop_reason = Some(reason);
                        }
                        events.push(AssistantEvent::Usage(merge_anthropic_stream_usage(
                            start_usage.as_ref(),
                            &delta.usage,
                            &mut input_from_delta,
                        )));
                    }
                    ApiStreamEvent::MessageStop(_) => {
                        saw_stop = true;
                        observer.on_message_stop()?;
                        events.push(AssistantEvent::MessageStop);
                    }
                    ApiStreamEvent::Error(error) => {
                        let msg = error
                            .error
                            .get("message")
                            .and_then(|value| value.as_str())
                            .unwrap_or("stream error")
                            .to_string();
                        return Err(RuntimeError::new(msg));
                    }
                }
            }

            let has_partial_output = events.iter().any(|event| {
                matches!(event, AssistantEvent::TextDelta(text) if !text.is_empty())
                    || matches!(event, AssistantEvent::ToolUse { .. })
            }) || pending_tool.is_some()
                || pending_thinking.is_some();
            if !saw_stop && has_partial_output {
                // MessageStop was never received: the stream was cut short regardless
                // of any stop_reason already recorded from a MessageDelta event.
                // Always mark as truncated so the conversation loop sends a
                // continuation prompt instead of silently returning partial output.
                stop_reason = Some("stream_truncated".to_string());
                observer.on_message_stop()?;
                events.push(AssistantEvent::MessageStop);
            }
            if let Some(reason) = stop_reason {
                let insert_at = events
                    .iter()
                    .position(|event| matches!(event, AssistantEvent::MessageStop))
                    .unwrap_or(events.len());
                events.insert(insert_at, AssistantEvent::StopReason(reason));
            }

            if events
                .iter()
                .any(|event| matches!(event, AssistantEvent::MessageStop))
            {
                return Ok(events);
            }

            let fallback_request = MessageRequest {
                stream: false,
                ..message_request.clone()
            };
            let response = tokio::select! {
                result = client.send_message(&fallback_request) => {
                    result.map_err(|error| RuntimeError::new(error.to_string()))?
                }
                () = wait_for_stream_cancel(observer.as_ref()) => {
                    return Err(interrupted_error());
                }
            };
            trace_record(
                &trace_sink,
                "llm.response_start",
                json!({
                    "provider": "anthropic",
                    "model": &trace_model,
                    "requestId": response.request_id.as_deref(),
                    "stream": false,
                    "responseId": &response.id,
                    "stopReason": response.stop_reason.as_deref(),
                }),
            );
            response_to_events(response, observer)
        });
        match &result {
            Ok(events) => trace_record(
                &self.trace_sink,
                "llm.response",
                json!({
                    "provider": "anthropic",
                    "model": &self.model,
                    "eventCount": events.len(),
                    "events": assistant_events_to_value(events),
                }),
            ),
            Err(error) => trace_record(
                &self.trace_sink,
                "llm.error",
                json!({
                    "provider": "anthropic",
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

fn push_output_block(
    block: OutputContentBlock,
    observer: &mut Box<dyn StreamObserver>,
    events: &mut Vec<AssistantEvent>,
    pending_tool: &mut Option<(String, String, String)>,
) -> Result<(), RuntimeError> {
    match block {
        OutputContentBlock::Text { text } => {
            if !text.is_empty() {
                observer.on_text_delta(&text)?;
                push_text_event(events, text);
            }
        }
        OutputContentBlock::ToolUse { id, name, input } => {
            let input_json = if input.is_null() || input == json!({}) {
                String::new()
            } else {
                input.to_string()
            };
            *pending_tool = Some((id, name, input_json));
        }
        OutputContentBlock::Thinking {
            thinking,
            signature,
        } => {
            if !thinking.is_empty() {
                observer.on_thinking_delta(&thinking)?;
            }
            events.push(AssistantEvent::Thinking {
                thinking,
                signature,
            });
        }
    }
    Ok(())
}

fn response_to_events(
    response: MessageResponse,
    observer: &mut Box<dyn StreamObserver>,
) -> Result<Vec<AssistantEvent>, RuntimeError> {
    let mut events = Vec::new();
    for block in response.content {
        match block {
            OutputContentBlock::Text { text } => {
                if !text.is_empty() {
                    observer.on_text_delta(&text)?;
                    push_text_event(&mut events, text);
                }
            }
            OutputContentBlock::ToolUse { id, name, input } => {
                let input_json = if input.is_null() || input == json!({}) {
                    String::new()
                } else {
                    input.to_string()
                };
                observer.on_tool_call(&id, &name, &input_json)?;
                events.push(AssistantEvent::ToolUse {
                    id,
                    name,
                    input: input_json,
                });
            }
            OutputContentBlock::Thinking {
                thinking,
                signature,
            } => {
                if !thinking.is_empty() {
                    observer.on_thinking_delta(&thinking)?;
                }
                events.push(AssistantEvent::Thinking {
                    thinking,
                    signature,
                });
            }
        }
    }
    observer.on_message_stop()?;
    if let Some(reason) = response.stop_reason.filter(|value| !value.is_empty()) {
        events.push(AssistantEvent::StopReason(reason));
    }
    events.push(AssistantEvent::MessageStop);
    Ok(events)
}

fn convert_messages(messages: &[ConversationMessage]) -> Vec<InputMessage> {
    messages
        .iter()
        .filter_map(|message| {
            let role = match message.role {
                MessageRole::System | MessageRole::User | MessageRole::Tool => "user",
                MessageRole::Assistant => "assistant",
            };
            let content = message
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Thinking { .. } => None,
                    block => Some(match block {
                        ContentBlock::Text { text } => {
                            InputContentBlock::Text { text: text.clone() }
                        }
                        ContentBlock::Image { media_type, data } => InputContentBlock::Image {
                            source: ImageSource::base64(media_type.clone(), data.clone()),
                        },
                        ContentBlock::ToolUse { id, name, input } => InputContentBlock::ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            input: serde_json::from_str(input).unwrap_or_else(|_| json!({})),
                        },
                        ContentBlock::ToolResult {
                            tool_use_id,
                            output,
                            is_error,
                            ..
                        } => InputContentBlock::ToolResult {
                            tool_use_id: tool_use_id.clone(),
                            content: vec![ToolResultContentBlock::Text {
                                text: output.clone(),
                            }],
                            is_error: *is_error,
                        },
                        // This request does not enable Anthropic extended
                        // thinking. Replaying a thinking block (especially one
                        // injected by an OpenAI-compatible upstream) with its
                        // signature can make the next request fail validation.
                        // Visible text and tool exchanges remain authoritative.
                        ContentBlock::Thinking { .. } => unreachable!("thinking filtered above"),
                    }),
                })
                .collect::<Vec<_>>();
            (!content.is_empty()).then(|| InputMessage {
                role: role.to_string(),
                content,
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "tests/lib.rs"]
mod tests;
