//! In-app chat engine (P2).
//!
//! Reuses the *exact* reusable agent loop from `runtime::ConversationRuntime`
//! plus the `api` streaming client and `tools::execute_tool`. The only thing
//! built here is a thin `ApiClient` impl that emits Tauri events instead of
//! writing to a terminal, and a `ToolExecutor` that forwards to the kernel.
//!
//! Scope (first cut): the **Anthropic executor** path. OpenAI-compatible
//! executors still go through the `aris` CLI. The CLI is untouched — all of
//! this lives in the desktop crate so nothing existing can break.
//!
//! Streaming surface (Tauri events): `chat-delta` (assistant text chunk),
//! `chat-tool` (model requested a tool), `chat-tool-result` (kernel ran it),
//! `chat-done` (final assistant text).

use std::sync::Mutex;

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

/// Per-app chat session. Stored instead of the whole `ConversationRuntime`
/// because the latter holds a non-`Send` `Box<dyn EventSink>`; we rebuild the
/// (cheap) client + runtime per turn and persist only the accumulating session.
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

// ── Anthropic streaming client (emits Tauri events) ───────────────────────────

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
            messages: convert_messages(&request.messages),
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

fn convert_messages(messages: &[ConversationMessage]) -> Vec<InputMessage> {
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

/// Read config.json, validate the executor is Anthropic, push the API key into
/// the env where `resolve_startup_auth_source` will find it. Returns
/// `(model, provider)` or a user-facing error.
fn resolve_executor() -> Result<(String, String), String> {
    let obj = crate::config::load_object();
    let get = |key: &str| {
        obj.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
    };
    let provider = get("executor_provider").unwrap_or_else(|| "anthropic".to_string());
    if provider != "anthropic" && provider != "anthropic-compat" {
        return Err(format!(
            "In-app chat currently supports the Anthropic executor only (provider is '{provider}'). Set the executor provider to 'anthropic' in Settings, or use the aris CLI for other providers."
        ));
    }
    let model = get("executor_model").unwrap_or_else(|| "claude-opus-4-7".to_string());

    if let Some(key) = get("executor_api_key") {
        if provider == "anthropic-compat" {
            std::env::set_var("ANTHROPIC_AUTH_TOKEN", key);
        } else {
            std::env::set_var("ANTHROPIC_API_KEY", key);
        }
    }
    if let Some(base) = get("executor_base_url") {
        std::env::set_var("ANTHROPIC_BASE_URL", base);
        std::env::set_var("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1");
    }

    let has_auth = std::env::var("ANTHROPIC_API_KEY").is_ok_and(|v| !v.is_empty())
        || std::env::var("ANTHROPIC_AUTH_TOKEN").is_ok_and(|v| !v.is_empty());
    if !has_auth {
        return Err("No Anthropic API key configured. Add it on the Settings page.".to_string());
    }
    Ok((model, provider))
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
        Ok((model, provider)) => ChatStatus {
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
    let (model, _provider) = resolve_executor()?;
    // Snapshot the session, then run the (blocking) turn off the async runtime
    // so the client's own tokio runtime `block_on` never nests inside Tauri's.
    let session = state
        .0
        .lock()
        .map_err(|_| "chat state poisoned".to_string())?
        .clone();

    let worker_app = app.clone();
    let (text, updated): (String, Session) = tauri::async_runtime::spawn_blocking(move || {
        let client = DesktopAnthropicClient::new(worker_app.clone(), model.clone())?;
        let executor = KernelToolExecutor {
            app: worker_app.clone(),
        };
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
