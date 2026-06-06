//! In-app chat engine (P2).
//!
//! The provider executor lives in `aris-executor`; this module only adapts it
//! to Tauri events and UI-facing commands.
//! Streaming surface (Tauri events): `chat-delta`, `chat-thinking-delta`,
//! `chat-tool`, `chat-tool-result`, `chat-done`.

use std::{path::PathBuf, sync::Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use runtime::{PermissionMode, RuntimeError, Session, ToolError, ToolExecutor};

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

    fn on_thinking_delta(&mut self, thinking: &str) -> Result<(), RuntimeError> {
        let _ = self.app.emit("chat-thinking-delta", thinking);
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

fn desktop_tool_specs() -> Vec<tools::ToolSpec> {
    tools::mvp_tool_specs()
        .into_iter()
        .filter(|spec| desktop_chat_tool_allowed(spec.name))
        .collect()
}

fn desktop_permission_policy(tool_specs: &[tools::ToolSpec]) -> runtime::PermissionPolicy {
    aris_chat::permission_policy_for_tools_with(
        tool_specs.to_vec(),
        PermissionMode::WorkspaceWrite,
        |spec| {
            if spec.name == "SpawnTeammate" {
                PermissionMode::WorkspaceWrite
            } else {
                spec.required_permission
            }
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

fn build_system_prompt(model: &str) -> Vec<String> {
    let workspace = std::env::var("ARIS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .or_else(|_| std::env::current_dir())
        .unwrap_or_else(|_| crate::state::workspace_dir());
    let isolation = format!(
        "Desktop isolation: this chat runs inside the ARIS desktop workspace at `{}`. Treat that directory as the only workspace. Do not request, infer, read, write, or search files outside it. Absolute paths outside this root are blocked by the runtime, and shell/REPL/notebook tools are unavailable in desktop Chat.",
        workspace.display()
    );
    aris_chat::build_common_system_prompt(aris_chat::CommonSystemPromptOptions {
        workspace,
        current_date: runtime::today_iso(),
        os_name: std::env::consts::OS.to_string(),
        os_version: "unknown".to_string(),
        model_id: Some(model.to_string()),
        product_surface: "desktop research automation app".to_string(),
        language: std::env::var("ARIS_LANGUAGE").unwrap_or_else(|_| "cn".to_string()),
        include_language_preference: true,
        include_team_orchestration: true,
        extra_sections: vec![isolation.clone()],
    })
    .unwrap_or_else(|_| vec![isolation])
}

/// Read config.json and validate the executor is configured. Returns
/// `(model, provider, executor_config)` or a user-facing error string.
fn resolve_executor() -> Result<(String, String, aris_chat::ChatExecutorConfig), String> {
    aris_chat::resolve_settings_executor_config(&crate::config::load_object())
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
        Ok((model, provider, _)) => ChatStatus {
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
    let (model, _provider, executor_config) = resolve_executor()?;
    let session = state
        .0
        .lock()
        .map_err(|_| "chat state poisoned".to_string())?
        .clone();

    let worker_app = app.clone();
    let (text, updated): (String, Session) = tauri::async_runtime::spawn_blocking(move || {
        // Clear any stale interrupt from a previous Stop so this turn starts clean.
        runtime::clear_interrupt();
        let tool_specs = desktop_tool_specs();
        let permission_policy = desktop_permission_policy(&tool_specs);
        let observer: Box<dyn aris_executor::StreamObserver> = Box::new(DesktopStreamObserver {
            app: worker_app.clone(),
        });
        let executor = KernelToolExecutor { app: worker_app };
        let system_prompt = build_system_prompt(&model);
        let mut runtime = aris_chat::build_conversation_runtime(
            session,
            executor_config,
            model,
            true,
            tool_specs,
            observer,
            executor,
            permission_policy,
            system_prompt,
            runtime::RuntimeFeatureConfig::default(),
        )?;
        let summary = runtime.run_turn(message, None).map_err(|e| e.to_string())?;
        let text = aris_chat::final_assistant_text(&summary);
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
