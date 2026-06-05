//! In-app chat engine (P2).
//!
//! Two streaming clients are implemented here:
//!  - `DesktopAnthropicClient` – Anthropic native SSE (provider = "anthropic" / "anthropic-compat")
//!  - `DesktopOpenAiClient`    – OpenAI-compatible SSE (provider = "openai" / "minimax" / "custom")
//!
//! Both implement `ApiClient` from the `runtime` crate, and are dispatched via
//! the `AnyClient` enum so the `ConversationRuntime` doesn't need dynamic dispatch.
//!
//! Streaming surface (Tauri events): `chat-delta`, `chat-tool`, `chat-tool-result`, `chat-done`.

use std::sync::Mutex;

use futures_util::StreamExt as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use api::{
    AnthropicClient, ContentBlockDelta, InputContentBlock, InputMessage, MessageRequest,
    OutputContentBlock, StreamEvent, ToolChoice, ToolDefinition, ToolResultContentBlock, Usage,
};
use runtime::{
    load_system_prompt, ApiClient, ApiRequest, AssistantEvent, ContentBlock, ConversationMessage,
    ConversationRuntime, MessageRole, PermissionMode, PermissionPolicy, RuntimeError, Session,
    TokenUsage, ToolError, ToolExecutor, TurnSummary,
};
use tools::mvp_tool_specs;

/// Per-app chat session.
pub struct ChatState(pub Mutex<Session>);

impl Default for ChatState {
    fn default() -> Self {
        Self(Mutex::new(Session::new()))
    }
}

// ── Tool executor ─────────────────────────────────────────────────────────────

struct KernelToolExecutor {
    app: AppHandle,
}

impl ToolExecutor for KernelToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        let value: Value = serde_json::from_str(input).unwrap_or(Value::Null);
        match tools::execute_tool(tool_name, &value) {
            Ok(output) => {
                let _ = self.app.emit(
                    "chat-tool-result",
                    json!({ "name": tool_name, "output": truncate(&output, 4000), "isError": false }),
                );
                Ok(output)
            }
            Err(err) => {
                let _ = self.app.emit(
                    "chat-tool-result",
                    json!({ "name": tool_name, "output": truncate(&err, 4000), "isError": true }),
                );
                Err(ToolError::new(err))
            }
        }
    }
}

// ── Anthropic streaming client ────────────────────────────────────────────────

struct DesktopAnthropicClient {
    runtime: tokio::runtime::Runtime,
    client: AnthropicClient,
    model: String,
    app: AppHandle,
}

impl DesktopAnthropicClient {
    fn new(app: AppHandle, model: String) -> Result<Self, String> {
        let auth = api::resolve_startup_auth_source(|| Ok(None)).map_err(|e| e.to_string())?;
        Ok(Self {
            runtime: tokio::runtime::Runtime::new().map_err(|e| e.to_string())?,
            client: AnthropicClient::from_auth(auth)
                .with_base_url(api::read_base_url())
                .with_send_betas(api::read_send_betas()),
            model,
            app,
        })
    }
}

fn handle_start_block(
    block: OutputContentBlock,
    app: &AppHandle,
    events: &mut Vec<AssistantEvent>,
    pending_tool: &mut Option<(String, String, String)>,
    pending_thinking: &mut Option<(String, String)>,
) {
    match block {
        OutputContentBlock::Text { text } => {
            if !text.is_empty() {
                let _ = app.emit("chat-delta", &text);
                events.push(AssistantEvent::TextDelta(text));
            }
        }
        OutputContentBlock::ToolUse { id, name, input } => {
            let seed = if input.is_null() || input == json!({}) {
                String::new()
            } else {
                input.to_string()
            };
            *pending_tool = Some((id, name, seed));
        }
        OutputContentBlock::Thinking {
            thinking,
            signature,
        } => {
            *pending_thinking = Some((thinking, signature));
        }
    }
}

impl ApiClient for DesktopAnthropicClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let is_oauth = self.client.auth_source().bearer_token().is_some()
            && self.client.auth_source().api_key().is_none();
        let system = if request.system_prompt.is_empty() {
            None
        } else {
            let prompt = request.system_prompt.join("\n\n");
            let cache_control = if is_oauth {
                json!({ "type": "ephemeral", "ttl": "1h" })
            } else {
                json!({ "type": "ephemeral" })
            };
            Some(json!([{ "type": "text", "text": prompt, "cache_control": cache_control }]))
        };
        let tools: Vec<ToolDefinition> = mvp_tool_specs()
            .into_iter()
            .map(|spec| ToolDefinition {
                name: spec.name.to_string(),
                description: Some(spec.description.to_string()),
                input_schema: spec.input_schema,
            })
            .collect();
        let message_request = MessageRequest {
            model: self.model.clone(),
            max_tokens: max_tokens_for_model(&self.model),
            messages: convert_anthropic_messages(&request.messages),
            system,
            tools: Some(tools),
            tool_choice: Some(ToolChoice::Auto),
            stream: true,
        };

        let app = self.app.clone();
        let client = &self.client;
        self.runtime.block_on(async move {
            let mut stream = client
                .stream_message(&message_request)
                .await
                .map_err(|e| RuntimeError::new(e.to_string()))?;
            let mut events: Vec<AssistantEvent> = Vec::new();
            let mut pending_tool: Option<(String, String, String)> = None;
            let mut pending_thinking: Option<(String, String)> = None;
            let mut start_usage: Option<Usage> = None;
            let mut saw_stop = false;

            while let Some(event) = stream
                .next_event()
                .await
                .map_err(|e| RuntimeError::new(e.to_string()))?
            {
                match event {
                    StreamEvent::MessageStart(start) => {
                        start_usage = Some(start.message.usage.clone());
                        for block in start.message.content {
                            handle_start_block(
                                block,
                                &app,
                                &mut events,
                                &mut pending_tool,
                                &mut pending_thinking,
                            );
                        }
                    }
                    StreamEvent::ContentBlockStart(start) => {
                        handle_start_block(
                            start.content_block,
                            &app,
                            &mut events,
                            &mut pending_tool,
                            &mut pending_thinking,
                        );
                    }
                    StreamEvent::ContentBlockDelta(delta) => match delta.delta {
                        ContentBlockDelta::TextDelta { text } => {
                            if !text.is_empty() {
                                let _ = app.emit("chat-delta", &text);
                                events.push(AssistantEvent::TextDelta(text));
                            }
                        }
                        ContentBlockDelta::InputJsonDelta { partial_json } => {
                            if let Some((_, _, input)) = &mut pending_tool {
                                input.push_str(&partial_json);
                            }
                        }
                        ContentBlockDelta::ThinkingDelta { thinking } => {
                            if let Some((t, _)) = &mut pending_thinking {
                                t.push_str(&thinking);
                            }
                        }
                        ContentBlockDelta::SignatureDelta { signature } => {
                            if let Some((_, s)) = &mut pending_thinking {
                                *s = signature;
                            }
                        }
                    },
                    StreamEvent::ContentBlockStop(_) => {
                        if let Some((id, name, input)) = pending_tool.take() {
                            let _ = app.emit(
                                "chat-tool",
                                json!({ "id": id, "name": name, "input": input }),
                            );
                            events.push(AssistantEvent::ToolUse { id, name, input });
                        }
                        if let Some((thinking, signature)) = pending_thinking.take() {
                            events.push(AssistantEvent::Thinking {
                                thinking,
                                signature,
                            });
                        }
                    }
                    StreamEvent::MessageDelta(delta) => {
                        let start = start_usage.as_ref();
                        events.push(AssistantEvent::Usage(TokenUsage {
                            input_tokens: start
                                .map_or(delta.usage.input_tokens, |u| u.input_tokens),
                            output_tokens: delta.usage.output_tokens,
                            cache_creation_input_tokens: start.map_or(
                                delta.usage.cache_creation_input_tokens,
                                |u| u.cache_creation_input_tokens,
                            ),
                            cache_read_input_tokens: start.map_or(
                                delta.usage.cache_read_input_tokens,
                                |u| u.cache_read_input_tokens,
                            ),
                        }));
                    }
                    StreamEvent::MessageStop(_) => {
                        saw_stop = true;
                        events.push(AssistantEvent::MessageStop);
                    }
                    StreamEvent::Error(err) => {
                        let msg = err
                            .error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("stream error")
                            .to_string();
                        return Err(RuntimeError::new(msg));
                    }
                }
            }

            if !saw_stop
                && events.iter().any(|event| {
                    matches!(event, AssistantEvent::TextDelta(text) if !text.is_empty())
                        || matches!(event, AssistantEvent::ToolUse { .. })
                })
            {
                events.push(AssistantEvent::MessageStop);
            }
            Ok(events)
        })
    }
}

// ── OpenAI-compatible streaming client ───────────────────────────────────────

struct DesktopOpenAiClient {
    runtime: tokio::runtime::Runtime,
    base_url: String,
    api_key: String,
    model: String,
    app: AppHandle,
}

impl DesktopOpenAiClient {
    fn new(
        app: AppHandle,
        model: String,
        api_key: String,
        base_url: String,
    ) -> Result<Self, String> {
        Ok(Self {
            runtime: tokio::runtime::Runtime::new().map_err(|e| e.to_string())?,
            base_url,
            api_key,
            model,
            app,
        })
    }
}

impl ApiClient for DesktopOpenAiClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let messages = build_openai_messages(&request);
        let tools: Vec<Value> = mvp_tool_specs()
            .into_iter()
            .map(|spec| {
                json!({
                    "type": "function",
                    "function": {
                        "name": spec.name,
                        "description": spec.description,
                        "parameters": spec.input_schema
                    }
                })
            })
            .collect();

        let body = json!({
            "model": self.model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "stream": true,
        });

        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let api_key = self.api_key.clone();
        let app = self.app.clone();
        let body_str = serde_json::to_string(&body)
            .map_err(|e| RuntimeError::new(e.to_string()))?;

        self.runtime.block_on(async move {
            // Build client inside block_on so it runs in this runtime's context.
            let http = reqwest::Client::builder()
                .build()
                .map_err(|e| RuntimeError::new(e.to_string()))?;

            let resp = http
                .post(&url)
                .header("Authorization", format!("Bearer {api_key}"))
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .body(body_str)
                .send()
                .await
                .map_err(|e| RuntimeError::new(e.to_string()))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(RuntimeError::new(format!("HTTP {status}: {text}")));
            }

            let mut stream = resp.bytes_stream();
            let mut events: Vec<AssistantEvent> = Vec::new();
            // pending_tools[index] = (id, name, accumulated_arguments)
            let mut pending_tools: Vec<(String, String, String)> = Vec::new();
            let mut buf = String::new();
            let mut got_stop = false;

            'outer: while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| RuntimeError::new(e.to_string()))?;
                buf.push_str(&String::from_utf8_lossy(&chunk));

                loop {
                    let Some(nl) = buf.find('\n') else { break };
                    let line = buf[..nl].trim_end_matches('\r').to_string();
                    buf = buf[nl + 1..].to_string();

                    if line.is_empty() || line.starts_with(':') {
                        continue;
                    }
                    let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                        continue;
                    };
                    if data == "[DONE]" {
                        flush_pending_tools(&mut pending_tools, &mut events, &app);
                        events.push(AssistantEvent::MessageStop);
                        got_stop = true;
                        break 'outer;
                    }

                    let Ok(chunk_val) = serde_json::from_str::<Value>(data) else {
                        continue;
                    };

                    if let Some(err) = chunk_val.get("error") {
                        let msg = err["message"].as_str().unwrap_or("stream error").to_string();
                        return Err(RuntimeError::new(msg));
                    }

                    let Some(choices) = chunk_val["choices"].as_array() else {
                        continue;
                    };

                    for choice in choices {
                        let delta = &choice["delta"];

                        if let Some(content) = delta["content"].as_str() {
                            if !content.is_empty() {
                                let _ = app.emit("chat-delta", content);
                                events.push(AssistantEvent::TextDelta(content.to_string()));
                            }
                        }

                        if let Some(tcs) = delta["tool_calls"].as_array() {
                            for tc in tcs {
                                let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                                while pending_tools.len() <= idx {
                                    pending_tools.push((String::new(), String::new(), String::new()));
                                }
                                if let Some(id) = tc["id"].as_str() {
                                    pending_tools[idx].0 = id.to_string();
                                }
                                if let Some(name) = tc["function"]["name"].as_str() {
                                    pending_tools[idx].1 = name.to_string();
                                }
                                if let Some(args) = tc["function"]["arguments"].as_str() {
                                    pending_tools[idx].2.push_str(args);
                                }
                            }
                        }

                        if let Some(finish) = choice["finish_reason"].as_str() {
                            if finish == "tool_calls" || finish == "stop" {
                                flush_pending_tools(&mut pending_tools, &mut events, &app);
                            }
                        }
                    }
                }
            }

            // Safety net: if stream closed without [DONE], synthesise MessageStop
            // so ConversationRuntime doesn't error with "no message stop event".
            if !got_stop {
                flush_pending_tools(&mut pending_tools, &mut events, &app);
                events.push(AssistantEvent::MessageStop);
            }

            Ok(events)
        })
    }
}

fn flush_pending_tools(
    pending: &mut Vec<(String, String, String)>,
    events: &mut Vec<AssistantEvent>,
    app: &AppHandle,
) {
    for (id, name, args) in pending.drain(..) {
        if !name.is_empty() {
            let _ = app.emit("chat-tool", json!({ "id": id, "name": name, "input": args }));
            events.push(AssistantEvent::ToolUse { id, name, input: args });
        }
    }
}

/// Convert a `ConversationRuntime` `ApiRequest` into the OpenAI messages array.
fn build_openai_messages(request: &ApiRequest) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();

    if !request.system_prompt.is_empty() {
        result.push(json!({
            "role": "system",
            "content": request.system_prompt.join("\n\n")
        }));
    }

    for msg in &request.messages {
        match msg.role {
            MessageRole::System | MessageRole::User | MessageRole::Tool => {
                let mut user_text = String::new();

                for block in &msg.blocks {
                    match block {
                        ContentBlock::Text { text } => {
                            if !user_text.is_empty() {
                                user_text.push('\n');
                            }
                            user_text.push_str(text);
                        }
                        ContentBlock::ToolResult {
                            tool_use_id,
                            output,
                            is_error,
                            ..
                        } => {
                            // Flush any accumulated text first
                            if !user_text.is_empty() {
                                result.push(json!({ "role": "user", "content": user_text }));
                                user_text.clear();
                            }
                            let content = if *is_error {
                                format!("ERROR: {output}")
                            } else {
                                output.clone()
                            };
                            result.push(json!({
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": content
                            }));
                        }
                        _ => {}
                    }
                }
                if !user_text.is_empty() {
                    result.push(json!({ "role": "user", "content": user_text }));
                }
            }
            MessageRole::Assistant => {
                let mut text = String::new();
                let mut tool_calls: Vec<Value> = Vec::new();

                for block in &msg.blocks {
                    match block {
                        ContentBlock::Text { text: t } => text.push_str(t),
                        ContentBlock::ToolUse { id, name, input } => {
                            tool_calls.push(json!({
                                "id": id,
                                "type": "function",
                                "function": { "name": name, "arguments": input }
                            }));
                        }
                        _ => {}
                    }
                }

                let mut obj = serde_json::Map::new();
                obj.insert("role".into(), json!("assistant"));
                obj.insert(
                    "content".into(),
                    if text.is_empty() { Value::Null } else { json!(text) },
                );
                if !tool_calls.is_empty() {
                    obj.insert("tool_calls".into(), json!(tool_calls));
                }
                result.push(Value::Object(obj));
            }
        }
    }

    result
}

// ── Dispatch enum ─────────────────────────────────────────────────────────────

enum AnyClient {
    Anthropic(DesktopAnthropicClient),
    OpenAi(DesktopOpenAiClient),
}

impl ApiClient for AnyClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        match self {
            Self::Anthropic(c) => c.stream(request),
            Self::OpenAi(c) => c.stream(request),
        }
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let head: String = text.chars().take(max).collect();
        format!("{head}… (+{} more chars)", text.chars().count() - max)
    }
}

fn max_tokens_for_model(model: &str) -> u32 {
    if model.contains("opus") {
        32_000
    } else {
        64_000
    }
}

fn build_system_prompt(model: &str) -> Vec<String> {
    load_system_prompt(
        std::env::current_dir().unwrap_or_default(),
        runtime::today_iso(),
        std::env::consts::OS,
        "unknown",
        Some(model),
    )
    .unwrap_or_default()
}

fn convert_anthropic_messages(messages: &[ConversationMessage]) -> Vec<InputMessage> {
    messages
        .iter()
        .filter_map(|message| {
            let role = match message.role {
                MessageRole::System | MessageRole::User | MessageRole::Tool => "user",
                MessageRole::Assistant => "assistant",
            };
            let content: Vec<InputContentBlock> = message
                .blocks
                .iter()
                .map(|block| match block {
                    ContentBlock::Text { text } => InputContentBlock::Text { text: text.clone() },
                    ContentBlock::ToolUse { id, name, input } => InputContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: serde_json::from_str(input)
                            .unwrap_or_else(|_| json!({ "raw": input })),
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
                    ContentBlock::Thinking {
                        thinking,
                        signature,
                    } => InputContentBlock::Thinking {
                        thinking: thinking.clone(),
                        signature: signature.clone(),
                    },
                })
                .collect();
            (!content.is_empty()).then(|| InputMessage {
                role: role.to_string(),
                content,
            })
        })
        .collect()
}

fn final_assistant_text(summary: &TurnSummary) -> String {
    summary
        .assistant_messages
        .last()
        .map(|message| {
            message
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// Read config.json and validate the executor is configured. Returns
/// `(model, provider, api_key, base_url)` or a user-facing error string.
fn resolve_executor() -> Result<(String, String, String, String), String> {
    let obj = crate::config::load_object();
    let get = |key: &str| {
        obj.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
    };

    let provider = get("executor_provider").unwrap_or_else(|| "anthropic".to_string());
    let model = get("executor_model").unwrap_or_else(|| "claude-opus-4-7".to_string());

    match provider.as_str() {
        "anthropic" | "anthropic-compat" => {
            if let Some(key) = get("executor_api_key") {
                if provider == "anthropic-compat" {
                    std::env::set_var("ANTHROPIC_AUTH_TOKEN", &key);
                } else {
                    std::env::set_var("ANTHROPIC_API_KEY", &key);
                }
            }
            if let Some(base) = get("executor_base_url") {
                std::env::set_var("ANTHROPIC_BASE_URL", &base);
                std::env::set_var("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1");
            }
            let has_auth = std::env::var("ANTHROPIC_API_KEY").is_ok_and(|v| !v.is_empty())
                || std::env::var("ANTHROPIC_AUTH_TOKEN").is_ok_and(|v| !v.is_empty());
            if !has_auth {
                return Err(
                    "No Anthropic API key configured. Add it on the Settings page.".to_string(),
                );
            }
            Ok((model, provider, String::new(), String::new()))
        }
        // OpenAI-compatible: "openai", "minimax", "custom", or any unknown value
        _ => {
            let api_key = get("executor_api_key").ok_or_else(|| {
                format!("No API key configured for provider '{provider}'. Add it on the Settings page.")
            })?;
            let base_url = get("executor_base_url").unwrap_or_else(|| {
                "https://api.openai.com/v1".to_string()
            });
            Ok((model, provider, api_key, base_url))
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStatus {
    ready: bool,
    model: Option<String>,
    provider: Option<String>,
    message: Option<String>,
}

#[tauri::command]
pub fn chat_status() -> ChatStatus {
    match resolve_executor() {
        Ok((model, provider, _, _)) => ChatStatus {
            ready: true,
            model: Some(model),
            provider: Some(provider),
            message: None,
        },
        Err(message) => ChatStatus {
            ready: false,
            model: None,
            provider: None,
            message: Some(message),
        },
    }
}

#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    state: State<'_, ChatState>,
    message: String,
) -> Result<String, String> {
    let (model, provider, api_key, base_url) = resolve_executor()?;
    let session = state
        .0
        .lock()
        .map_err(|_| "chat state poisoned".to_string())?
        .clone();

    let worker_app = app.clone();
    let (text, updated): (String, Session) = tauri::async_runtime::spawn_blocking(move || {
        let client: AnyClient = match provider.as_str() {
            "anthropic" | "anthropic-compat" => {
                AnyClient::Anthropic(DesktopAnthropicClient::new(worker_app.clone(), model.clone())?)
            }
            _ => AnyClient::OpenAi(DesktopOpenAiClient::new(
                worker_app.clone(),
                model.clone(),
                api_key,
                base_url,
            )?),
        };
        let executor = KernelToolExecutor { app: worker_app };
        let system_prompt = build_system_prompt(&model);
        let mut runtime = ConversationRuntime::new(
            session,
            client,
            executor,
            PermissionPolicy::new(PermissionMode::DangerFullAccess),
            system_prompt,
        );
        let summary = runtime.run_turn(message, None).map_err(|e| e.to_string())?;
        let text = final_assistant_text(&summary);
        Ok::<(String, Session), String>((text, runtime.into_session()))
    })
    .await
    .map_err(|e| e.to_string())??;

    *state
        .0
        .lock()
        .map_err(|_| "chat state poisoned".to_string())? = updated;
    let _ = app.emit("chat-done", &text);
    Ok(text)
}

#[tauri::command]
pub fn chat_reset(state: State<ChatState>) -> Result<(), String> {
    *state
        .0
        .lock()
        .map_err(|_| "chat state poisoned".to_string())? = Session::new();
    Ok(())
}
