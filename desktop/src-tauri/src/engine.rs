//! In-app chat engine (P2).
//!
//! The provider executor lives in `aris-executor`; this module only adapts it
//! to Tauri events and UI-facing commands.
//! Streaming surface (Tauri events): `chat-delta`, `chat-tool`, `chat-tool-result`, `chat-done`.

use std::{path::PathBuf, sync::Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use runtime::{
    load_system_prompt, team_orchestration_section, ContentBlock, ConversationRuntime,
    PermissionMode, PermissionPolicy, RuntimeError, Session, ToolError, ToolExecutor, TurnSummary,
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

const DESKTOP_CHAT_BLOCKED_TOOLS: &[&str] = &[
    "bash",
    "PowerShell",
    "REPL",
    "NotebookEdit",
    "Config",
    "Agent",
    "AgentSupervisor",
    "Workflow",
    "EnterWorktree",
];

fn desktop_chat_tool_allowed(tool_name: &str) -> bool {
    !DESKTOP_CHAT_BLOCKED_TOOLS.contains(&tool_name)
}

fn denied_tool_message(tool_name: &str) -> String {
    format!(
        "tool `{tool_name}` is disabled in desktop Chat because it can escape the isolated ARIS workspace"
    )
}

struct KernelToolExecutor {
    app: AppHandle,
}

impl ToolExecutor for KernelToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        if !desktop_chat_tool_allowed(tool_name) {
            let err = denied_tool_message(tool_name);
            let _ = self.app.emit(
                "chat-tool-result",
                json!({ "name": tool_name, "output": err, "isError": true }),
            );
            return Err(ToolError::new(denied_tool_message(tool_name)));
        }
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

struct DesktopStreamObserver {
    app: AppHandle,
}

impl aris_executor::StreamObserver for DesktopStreamObserver {
    fn on_text_delta(&mut self, text: &str) -> Result<(), RuntimeError> {
        let _ = self.app.emit("chat-delta", text);
        Ok(())
    }

    fn on_tool_call(&mut self, id: &str, name: &str, input: &str) -> Result<(), RuntimeError> {
        let _ = self.app.emit(
            "chat-tool",
            json!({ "id": id, "name": name, "input": input }),
        );
        Ok(())
    }
}

fn executor_tool_specs() -> Vec<aris_executor::ExecutorToolSpec> {
    mvp_tool_specs()
        .into_iter()
        .filter(|spec| desktop_chat_tool_allowed(spec.name))
        .map(|spec| {
            aris_executor::ExecutorToolSpec::new(spec.name, spec.description, spec.input_schema)
        })
        .collect()
}

fn desktop_permission_policy() -> PermissionPolicy {
    mvp_tool_specs().into_iter().fold(
        PermissionPolicy::new(PermissionMode::WorkspaceWrite),
        |policy, spec| {
            if !desktop_chat_tool_allowed(spec.name) {
                return policy;
            }
            let required = if spec.name == "SpawnTeammate" {
                PermissionMode::WorkspaceWrite
            } else {
                spec.required_permission
            };
            policy.with_tool_requirement(spec.name, required)
        },
    )
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
    let workspace = std::env::var("ARIS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .or_else(|_| std::env::current_dir())
        .unwrap_or_else(|_| crate::state::workspace_dir());
    let mut prompt = load_system_prompt(
        workspace.clone(),
        runtime::today_iso(),
        std::env::consts::OS,
        "unknown",
        Some(model),
    )
    .unwrap_or_default();
    prompt.push(format!(
        "Desktop isolation: this chat runs inside the ARIS desktop workspace at `{}`. Treat that directory as the only workspace. Do not request, infer, read, write, or search files outside it. Absolute paths outside this root are blocked by the runtime, and shell/REPL/notebook tools are unavailable in desktop Chat.",
        workspace.display()
    ));
    // Give the desktop chat lead the same Agent Team orchestration playbook the
    // CLI lead gets, so it can actually form and drive teams (SpawnTeammate,
    // WaitForTeammates, VerifyDeliverable) instead of merely holding the tools.
    prompt.push(team_orchestration_section());
    prompt
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
                format!(
                    "No API key configured for provider '{provider}'. Add it on the Settings page."
                )
            })?;
            let base_url =
                get("executor_base_url").unwrap_or_else(|| "https://api.openai.com/v1".to_string());
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
        // Clear any stale interrupt from a previous Stop so this turn starts clean.
        runtime::clear_interrupt();
        let tool_specs = executor_tool_specs();
        let observer: Box<dyn aris_executor::StreamObserver> = Box::new(DesktopStreamObserver {
            app: worker_app.clone(),
        });
        let client: aris_executor::ExecutorClient = match provider.as_str() {
            "anthropic" | "anthropic-compat" => {
                let auth = api::resolve_startup_auth_source(|| Ok(None))
                    .map_err(|error| error.to_string())?;
                aris_executor::ExecutorClient::Anthropic(
                    aris_executor::AnthropicRuntimeClient::new(
                        auth,
                        api::read_base_url(),
                        api::read_send_betas(),
                        model.clone(),
                        true,
                        tool_specs,
                        max_tokens_for_model(&model),
                        observer,
                    )?,
                )
            }
            _ => aris_executor::ExecutorClient::OpenAI(aris_executor::OpenAIRuntimeClient::new(
                aris_executor::OpenAIExecutorConfig { api_key, base_url },
                model.clone(),
                true,
                tool_specs,
                observer,
            )?),
        };
        let executor = KernelToolExecutor { app: worker_app };
        let system_prompt = build_system_prompt(&model);
        let mut runtime = ConversationRuntime::new(
            session,
            client,
            executor,
            desktop_permission_policy(),
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

/// Request the in-flight chat turn to stop. Sets the runtime interrupt flag,
/// which both streaming loops and `run_turn`'s iteration boundary check, so a
/// long single response or a multi-step tool loop both unwind to an error.
#[tauri::command]
pub fn chat_cancel() {
    runtime::set_interrupt();
}
