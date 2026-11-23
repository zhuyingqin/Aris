//! One-shot model calls for the memory-L1 evaluation harness.
//!
//! Compiled only under the `memory-eval` feature, for the
//! `memory_eval_bridge` example; the shipped app never contains it. It reads
//! the configured executor the same way the app does — `config::load_object`
//! lays the account key from the credential store over `config.json` — so the
//! harness can call the user's own model without the key ever leaving this
//! process.
//!
//! A request is JSON: `{"id", "system": [..], "messages": [..], "tools": [..],
//! "max_tokens", "model"?}`. Messages use the session log's shape
//! (`role` + `blocks` with `text` / `tool_use` / `tool_result`). The reply
//! carries the text, every tool call the model asked for (never executed),
//! the provider stop reason, usage, and any error.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use aris_chat::ChatExecutorConfig;
use aris_executor::{
    AnthropicRuntimeClient, ExecutorClient, ExecutorToolSpec, OpenAIExecutorConfig,
    OpenAIRuntimeClient, StreamObserver,
};
use runtime::{
    ApiClient, ApiRequest, AssistantEvent, ContentBlock, ConversationMessage, MessageRole,
    RuntimeError,
};
use serde_json::{json, Value};

struct Collector {
    text: Arc<Mutex<String>>,
}

impl StreamObserver for Collector {
    fn on_text_delta(&mut self, value: &str) -> Result<(), RuntimeError> {
        self.text.lock().unwrap_or_else(|e| e.into_inner()).push_str(value);
        Ok(())
    }
}

/// The executor the app would use right now: `(model, provider, config)`.
pub fn configured_executor() -> Result<(String, String, ChatExecutorConfig), String> {
    let obj = crate::config::load_object();
    aris_chat::resolve_settings_executor_config(&obj)
}

/// Model and provider only, for reports. Never includes credentials.
#[must_use]
pub fn describe() -> Value {
    match configured_executor() {
        Ok((model, provider, _)) => json!({"model": model, "provider": provider}),
        Err(error) => json!({"error": error}),
    }
}

fn block_from(value: &Value) -> Option<ContentBlock> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    match value.get("type").and_then(Value::as_str)? {
        "text" => Some(ContentBlock::Text { text: text("text") }),
        "tool_use" => Some(ContentBlock::ToolUse { id: text("id"), name: text("name"), input: text("input") }),
        "tool_result" => Some(ContentBlock::ToolResult {
            tool_use_id: text("tool_use_id"),
            tool_name: text("tool_name"),
            output: text("output"),
            is_error: value.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        }),
        _ => None,
    }
}

fn message_from(value: &Value) -> Option<ConversationMessage> {
    let role = match value.get("role").and_then(Value::as_str)? {
        "user" => MessageRole::User,
        "assistant" => MessageRole::Assistant,
        "tool" => MessageRole::Tool,
        "system" => MessageRole::System,
        _ => return None,
    };
    let blocks = value.get("blocks")?.as_array()?.iter().filter_map(block_from).collect::<Vec<_>>();
    if blocks.is_empty() {
        return None;
    }
    Some(ConversationMessage { role, blocks, usage: None })
}

fn tool_specs(request: &Value) -> Vec<ExecutorToolSpec> {
    request
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| {
                    Some(ExecutorToolSpec {
                        name: tool.get("name")?.as_str()?.to_string(),
                        description: tool.get("description").and_then(Value::as_str).unwrap_or_default().to_string(),
                        input_schema: tool.get("input_schema").cloned().unwrap_or_else(|| json!({"type": "object"})),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn build_client(
    config: ChatExecutorConfig,
    model: String,
    specs: Vec<ExecutorToolSpec>,
    max_tokens: u32,
    observer: Box<dyn StreamObserver>,
) -> Result<ExecutorClient, String> {
    let enable_tools = !specs.is_empty();
    match config {
        ChatExecutorConfig::Anthropic { auth, base_url, send_betas } => {
            let client = AnthropicRuntimeClient::new(auth, base_url, send_betas, model, enable_tools, specs, max_tokens, observer)?
                .with_single_request(max_tokens);
            Ok(ExecutorClient::Anthropic(client))
        }
        ChatExecutorConfig::OpenAiCompatible { api_key, base_url, send_routing_session_header, transport, .. } => {
            let client = OpenAIRuntimeClient::new(OpenAIExecutorConfig { api_key, base_url }, model, enable_tools, specs, observer)?
                .with_transport(transport)
                .with_routing_session_header(send_routing_session_header)
                .with_single_request_limit(Some(max_tokens));
            Ok(ExecutorClient::OpenAI(client))
        }
    }
}

/// The shared tool registry exactly as the product declares it.
#[must_use]
pub fn tool_specs_json() -> Value {
    Value::Array(
        tools::mvp_tool_specs()
            .into_iter()
            .map(|spec| json!({"name": spec.name, "description": spec.description, "input_schema": spec.input_schema}))
            .collect(),
    )
}

/// The Chat system prompt the product would build for `workspace`, without the
/// builtin research-memory recall block (the experiment controls memory).
fn product_system_prompt(workspace: &str, model: &str) -> Vec<String> {
    // Single-threaded example process: the prompt builder reads the
    // workspace from the environment, as it does inside the app.
    std::env::set_var("ARIS_WORKSPACE_ROOT", workspace);
    crate::system_prompt::build_system_prompt_inner_with_memory(model, true, false)
}

/// Replaying an old session: the "# Project continuity" section is built from
/// TODAY's intent/activity/goal files, so it can carry what was decided after
/// that session. Experiments that control memory drop it.
fn without_project_continuity(sections: Vec<String>) -> Vec<String> {
    sections
        .into_iter()
        .filter(|section| !section.trim_start().starts_with("# Project continuity"))
        .collect()
}

/// The assembled system prompt for `workspace`, for checking what a request sees.
#[must_use]
pub fn product_prompt_sections(workspace: &str, strip_continuity: bool) -> Value {
    let model = configured_executor().map(|(model, _, _)| model).unwrap_or_default();
    let mut sections = product_system_prompt(workspace, &model);
    if strip_continuity {
        sections = without_project_continuity(sections);
    }
    json!(sections)
}

/// Send one request and report what came back. Tool calls are returned, not run.
#[must_use]
pub fn complete(request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let started = Instant::now();
    let (configured_model, _provider, config) = match configured_executor() {
        Ok(found) => found,
        Err(error) => return json!({"id": id, "error": error}),
    };
    let model = request.get("model").and_then(Value::as_str).map(str::to_string).unwrap_or(configured_model);
    let mut system = request
        .get("system")
        .and_then(Value::as_array)
        .map(|parts| parts.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_default();
    if let Some(workspace) = request.get("product_system_prompt_for").and_then(Value::as_str) {
        let mut product = product_system_prompt(workspace, &model);
        if request.get("strip_project_continuity").and_then(Value::as_bool).unwrap_or(false) {
            product = without_project_continuity(product);
        }
        product.append(&mut system);
        system = product;
    }
    let messages = request
        .get("messages")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(message_from).collect::<Vec<_>>())
        .unwrap_or_default();
    let max_tokens = request.get("max_tokens").and_then(Value::as_u64).unwrap_or(4096) as u32;
    let text = Arc::new(Mutex::new(String::new()));
    let observer = Box::new(Collector { text: text.clone() });
    let mut client = match build_client(config, model.clone(), tool_specs(request), max_tokens, observer) {
        Ok(client) => client,
        Err(error) => return json!({"id": id, "model": model, "error": error}),
    };
    client.set_session_id(&format!("memory-eval-{}", id.as_str().unwrap_or("x")));
    let outcome = client.stream(ApiRequest { system_prompt: system, messages });
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(events) => {
            let (mut reply, mut tool_uses, mut stop_reason, mut usage) = (String::new(), Vec::new(), Value::Null, Value::Null);
            for event in events {
                match event {
                    AssistantEvent::TextDelta(delta) => reply.push_str(&delta),
                    AssistantEvent::ToolUse { id, name, input } => tool_uses.push(json!({"id": id, "name": name, "input": input})),
                    AssistantEvent::StopReason(reason) => stop_reason = json!(reason),
                    AssistantEvent::Usage(found) => {
                        usage = json!({
                            "input_tokens": found.input_tokens,
                            "output_tokens": found.output_tokens,
                            "cache_read_input_tokens": found.cache_read_input_tokens,
                            "cache_creation_input_tokens": found.cache_creation_input_tokens,
                        });
                    }
                    _ => {}
                }
            }
            json!({"id": id, "model": model, "text": reply, "tool_uses": tool_uses,
                   "stop_reason": stop_reason, "usage": usage, "elapsed_ms": elapsed_ms})
        }
        Err(error) => json!({"id": id, "model": model, "error": error.to_string(),
                             "partial_text": text.lock().unwrap_or_else(|e| e.into_inner()).clone(),
                             "elapsed_ms": elapsed_ms}),
    }
}
