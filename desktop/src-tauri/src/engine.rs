//! In-app chat engine (P2).
//!
//! The provider executor lives in `aris-executor`; this module only adapts it
//! to Tauri events and UI-facing commands.
//! Streaming surface (Tauri events): `chat-delta`, `chat-thinking-delta`,
//! `chat-tool`, `chat-tool-result`, `chat-done`.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use aris_commands::{
    plan_team_command, plan_workflows_command, render_slash_command_help, slash_command_specs,
    SlashCommand, TeamCommandPlan, WorkflowCommandPlan,
};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use runtime::{
    CompactionConfig, ConfigLoader, ConfigSource, ContentBlock, ConversationMessage, MessageRole,
    PermissionMode, ProjectContext, ResolvedPermissionMode, RuntimeError, Session, TokenUsage,
    ToolError, ToolExecutor, UsageTracker,
};

/// Per-app chat sessions, keyed by the UI session id.
pub struct ChatState {
    sessions: Mutex<HashMap<String, Session>>,
    permission_modes: Mutex<HashMap<String, PermissionMode>>,
    running_turns: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

const MAX_CACHED_CHAT_SESSIONS: usize = 4;

impl Default for ChatState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            permission_modes: Mutex::new(HashMap::new()),
            running_turns: Mutex::new(HashMap::new()),
        }
    }
}

impl ChatState {
    pub fn is_busy(&self) -> bool {
        self.running_turns
            .lock()
            .map(|running| !running.is_empty())
            .unwrap_or(true)
    }

    pub fn clear(&self) -> Result<(), String> {
        self.sessions
            .lock()
            .map_err(|_| "chat state poisoned".to_string())?
            .clear();
        self.permission_modes
            .lock()
            .map_err(|_| "chat state poisoned".to_string())?
            .clear();
        Ok(())
    }
}

struct ChatBusyGuard<'a> {
    running_turns: &'a Mutex<HashMap<String, Arc<AtomicBool>>>,
    session_id: String,
}

impl Drop for ChatBusyGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut running) = self.running_turns.lock() {
            running.remove(&self.session_id);
        }
    }
}

// ── Tool executor ─────────────────────────────────────────────────────────────

// Desktop Chat exposes the complete tool registry. Permission modes decide
// what can run, matching Claude Code's plan / acceptEdits / dontAsk model.
const DESKTOP_CHAT_BLOCKED_TOOLS: &[&str] = &[];

// Literature agent sessions allow bash so /research-lit can run Python fetchers
// (arxiv_fetch.py, openalex_fetch.py, etc.). Multi-agent and worktree tools
// remain blocked — only the shell execution lane is opened.
const LITERATURE_AGENT_BLOCKED_TOOLS: &[&str] = &[
    "NotebookEdit",
    "Config",
    "Agent",
    "AgentSupervisor",
    "SpawnTeammate",
    "SendMessage",
    "ClaimTask",
    "CompleteTask",
    "WaitForTeammates",
    "VerifyDeliverable",
    "TeamControl",
    "Workflow",
    "EnterWorktree",
];

fn denied_tool_message(tool_name: &str) -> String {
    format!(
        "tool `{tool_name}` is disabled in desktop Chat because it can escape the isolated ARIS workspace"
    )
}

struct KernelToolExecutor {
    blocked_tools: &'static [&'static str],
}

impl ToolExecutor for KernelToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        self.execute_with_id("", tool_name, input)
    }

    fn execute_with_id(
        &mut self,
        _tool_use_id: &str,
        tool_name: &str,
        input: &str,
    ) -> Result<String, ToolError> {
        if self.blocked_tools.contains(&tool_name) {
            return Err(ToolError::new(denied_tool_message(tool_name)));
        }
        let value: Value = serde_json::from_str(input).unwrap_or(Value::Null);
        tools::execute_tool(tool_name, &value).map_err(ToolError::new)
    }
}

struct DesktopToolExecutor<T> {
    app: AppHandle,
    session_id: String,
    cancelled: Arc<AtomicBool>,
    inner: T,
}

impl<T> ToolExecutor for DesktopToolExecutor<T>
where
    T: ToolExecutor,
{
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        self.execute_with_id("", tool_name, input)
    }

    fn execute_with_id(
        &mut self,
        tool_use_id: &str,
        tool_name: &str,
        input: &str,
    ) -> Result<String, ToolError> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(ToolError::new("interrupted by user"));
        }
        match self.inner.execute_with_id(tool_use_id, tool_name, input) {
            Ok(output) => {
                let context_output = compact_tool_output_for_context(tool_name, output);
                let _ = self.app.emit(
                    "chat-tool-result",
                    json!({ "sessionId": self.session_id, "id": tool_use_id, "name": tool_name, "output": truncate(&context_output, 4000), "isError": false }),
                );
                Ok(context_output)
            }
            Err(err) => {
                let _ = self.app.emit(
                    "chat-tool-result",
                    json!({ "sessionId": self.session_id, "id": tool_use_id, "name": tool_name, "output": truncate(&err.to_string(), 4000), "isError": true }),
                );
                Err(err)
            }
        }
    }
}

struct DesktopStreamObserver {
    app: AppHandle,
    session_id: String,
    cancelled: Arc<AtomicBool>,
}

impl aris_executor::StreamObserver for DesktopStreamObserver {
    fn on_text_delta(&mut self, text: &str) -> Result<(), RuntimeError> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(RuntimeError::new("interrupted by user"));
        }
        let _ = self.app.emit(
            "chat-delta",
            json!({ "sessionId": self.session_id, "text": text }),
        );
        Ok(())
    }

    fn on_thinking_delta(&mut self, thinking: &str) -> Result<(), RuntimeError> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(RuntimeError::new("interrupted by user"));
        }
        let _ = self.app.emit(
            "chat-thinking-delta",
            json!({ "sessionId": self.session_id, "thinking": thinking }),
        );
        Ok(())
    }

    fn on_tool_call(&mut self, id: &str, name: &str, input: &str) -> Result<(), RuntimeError> {
        let _ = self.app.emit(
            "chat-tool",
            json!({ "sessionId": self.session_id, "id": id, "name": name, "input": input }),
        );
        Ok(())
    }
}

struct SilentStreamObserver;

impl aris_executor::StreamObserver for SilentStreamObserver {
    fn on_text_delta(&mut self, _text: &str) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn on_thinking_delta(&mut self, _thinking: &str) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn on_tool_call(&mut self, _id: &str, _name: &str, _input: &str) -> Result<(), RuntimeError> {
        Ok(())
    }
}

struct NoToolsExecutor;

impl ToolExecutor for NoToolsExecutor {
    fn execute(&mut self, tool_name: &str, _input: &str) -> Result<String, ToolError> {
        Err(ToolError::new(format!(
            "tool `{tool_name}` is not available while generating chat titles"
        )))
    }
}

fn tool_specs_for(blocked: &'static [&'static str]) -> Vec<tools::ToolSpec> {
    tools::mvp_tool_specs()
        .into_iter()
        .filter(|spec| !blocked.contains(&spec.name))
        .collect()
}

fn mcp_runtime_status_prompt(
    configured_servers: usize,
    tool_specs: &[aris_chat::ChatToolSpec],
    warnings: &[String],
) -> Option<String> {
    if configured_servers == 0 {
        return None;
    }
    let tools = tool_specs
        .iter()
        .filter(|spec| spec.name.starts_with("mcp__"))
        .map(|spec| spec.name.as_str())
        .collect::<Vec<_>>();
    let mut lines = vec![
        "MCP runtime status for this Chat turn".to_string(),
        format!("Configured servers: {configured_servers}"),
        format!("Loaded MCP tools: {}", tools.len()),
    ];
    if tools.is_empty() {
        lines.push("No MCP tools were loaded for this turn.".to_string());
    } else {
        lines.push(format!("Available MCP tools: {}", tools.join(", ")));
        lines.push("ToolSearch includes these dynamic MCP tools.".to_string());
    }
    if !warnings.is_empty() {
        lines.push("MCP startup warnings:".to_string());
        lines.extend(warnings.iter().map(|warning| format!("- {warning}")));
    }
    Some(lines.join("\n"))
}

#[cfg(test)]
fn desktop_permission_policy(
    tool_specs: &[tools::ToolSpec],
    active_mode: PermissionMode,
) -> runtime::PermissionPolicy {
    aris_chat::permission_policy_for_tools(
        aris_chat::chat_tool_specs(tool_specs.to_vec()),
        active_mode,
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

/// Compact a tool's raw output before it enters the LLM context so the
/// conversation history doesn't overflow the model's context window.
///
/// - `Skill` — not touched: the LLM needs the full SKILL.md to execute correctly.
/// - `LiteratureSearch` — abstracts trimmed to 250 chars, papers capped at 15.
/// - Everything else — hard cap at 12,000 chars with a note if trimmed.
fn compact_tool_output_for_context(tool_name: &str, output: String) -> String {
    match tool_name {
        "Skill" => output,
        "LiteratureSearch" => compact_literature_search_output(output),
        _ => {
            const MAX: usize = 12_000;
            if output.len() <= MAX {
                output
            } else {
                let head: String = output.chars().take(MAX).collect();
                format!(
                    "{head}\n[…output truncated: {} chars total, first {} shown]",
                    output.len(),
                    MAX
                )
            }
        }
    }
}

fn compact_literature_search_output(output: String) -> String {
    const MAX_ABSTRACT: usize = 250;
    const MAX_PAPERS: usize = 15;

    let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&output) else {
        return output;
    };
    let Some(papers) = root["papers"].as_array_mut() else {
        return output;
    };

    let total = papers.len();
    papers.truncate(MAX_PAPERS);
    for paper in papers.iter_mut() {
        if let Some(abs) = paper["abstract"].as_str() {
            if abs.len() > MAX_ABSTRACT {
                let short: String = abs.chars().take(MAX_ABSTRACT).collect();
                paper["abstract"] = serde_json::Value::String(format!("{short}…"));
            }
        }
    }
    if total > MAX_PAPERS {
        root["_note"] = serde_json::Value::String(format!(
            "{} papers returned; showing first {} with abstracts trimmed to {} chars",
            total, MAX_PAPERS, MAX_ABSTRACT
        ));
    }
    serde_json::to_string_pretty(&root).unwrap_or(output)
}

fn build_system_prompt_inner(model: &str, full_tool_registry: bool) -> Vec<String> {
    let workspace = std::env::var("ARIS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .or_else(|_| std::env::current_dir())
        .unwrap_or_else(|_| crate::state::workspace_dir());
    let access = if full_tool_registry {
        format!(
            "Desktop Chat runs in the ARIS workspace at `{}`. The complete tool registry, including shell and agent tools, is available when the active permission mode allows it. Respect the selected permission mode and keep generated project artifacts in this workspace unless the user explicitly requests another location.",
            workspace.display()
        )
    } else {
        format!(
            "Desktop Chat runs in the ARIS workspace at `{}`. Some tools are unavailable on this surface; use the available tools and respect the selected permission mode.",
            workspace.display()
        )
    };
    let file_links = "When you create or modify files, include Markdown links to the relevant file paths in the final response so the desktop UI can open them directly.".to_string();
    runtime::migrate_legacy_knowledge_memory();
    let hot_memory = runtime::render_hot_memory_prompt(&workspace).unwrap_or_default();
    let knowledge_memory = runtime::render_knowledge_memory_prompt();
    aris_chat::build_common_system_prompt(aris_chat::CommonSystemPromptOptions {
        workspace,
        current_date: runtime::today_iso(),
        os_name: std::env::consts::OS.to_string(),
        os_version: "unknown".to_string(),
        model_id: Some(model.to_string()),
        product_surface: "desktop research automation app".to_string(),
        language: std::env::var("ARIS_LANGUAGE").unwrap_or_else(|_| "cn".to_string()),
        include_language_preference: true,
        include_team_orchestration: false,
        extra_sections: vec![access.clone(), file_links, hot_memory, knowledge_memory],
    })
    .unwrap_or_else(|_| vec![access])
}

/// Read config.json and validate the executor is configured. Returns
/// `(model, provider, executor_config)` or a user-facing error string.
fn resolve_executor() -> Result<(String, String, aris_chat::ChatExecutorConfig), String> {
    aris_chat::resolve_settings_executor_config(&crate::config::load_object())
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return Err("invalid chat session id".to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionModeView {
    mode: String,
    label: String,
    description: String,
}

fn permission_mode_view(mode: PermissionMode) -> PermissionModeView {
    let (label, description) = match mode {
        PermissionMode::ReadOnly => ("Plan", "Inspect and search only"),
        PermissionMode::WorkspaceWrite => ("Accept edits", "Read and edit workspace files"),
        PermissionMode::DangerFullAccess => (
            "Don't ask",
            "Allow shell, agents, workflows, MCP, and all tools",
        ),
        PermissionMode::Prompt => ("Ask", "Ask before elevated tool calls"),
        PermissionMode::Allow => ("Allow", "Allow the current tool call"),
    };
    PermissionModeView {
        mode: mode.as_str().to_string(),
        label: label.to_string(),
        description: description.to_string(),
    }
}

fn project_permission_path() -> Result<PathBuf, String> {
    std::env::current_dir()
        .map(|cwd| cwd.join(".claude").join("settings.local.json"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn chat_permission_get(
    state: State<ChatState>,
    session_id: String,
) -> Result<PermissionModeView, String> {
    validate_session_id(&session_id)?;
    permission_mode_for(&state, &session_id).map(permission_mode_view)
}

#[tauri::command]
pub fn chat_permission_set(
    state: State<ChatState>,
    session_id: String,
    mode: String,
) -> Result<PermissionModeView, String> {
    validate_session_id(&session_id)?;
    let mode = normalize_permission_mode(&mode)
        .ok_or_else(|| format!("unsupported permission mode `{mode}`"))?;
    set_permission_mode_for(&state, session_id, mode)?;
    Ok(permission_mode_view(mode))
}

#[tauri::command]
pub fn project_permission_get() -> PermissionModeView {
    permission_mode_view(configured_default_permission_mode())
}

#[tauri::command]
pub fn project_permission_set(mode: String) -> Result<PermissionModeView, String> {
    let mode = normalize_permission_mode(&mode)
        .ok_or_else(|| format!("unsupported permission mode `{mode}`"))?;
    let path = project_permission_path()?;
    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let permissions = root
        .entry("permissions".to_string())
        .or_insert_with(|| json!({}));
    let object = permissions
        .as_object_mut()
        .ok_or_else(|| format!("{}: permissions must be an object", path.display()))?;
    let label = match mode {
        PermissionMode::ReadOnly => "plan",
        PermissionMode::WorkspaceWrite => "acceptEdits",
        PermissionMode::DangerFullAccess => "dontAsk",
        PermissionMode::Prompt | PermissionMode::Allow => "default",
    };
    object.insert("defaultMode".to_string(), Value::String(label.to_string()));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content =
        serde_json::to_string_pretty(&Value::Object(root)).map_err(|error| error.to_string())?;
    std::fs::write(&path, format!("{content}\n")).map_err(|error| error.to_string())?;
    Ok(permission_mode_view(mode))
}

fn chat_session_path(session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(crate::state::sessions_dir().join(format!("{session_id}.json")))
}

fn load_chat_session(session_id: &str) -> Result<Session, String> {
    let path = chat_session_path(session_id)?;
    if path.exists() {
        Session::load_from_path(path).map_err(|e| e.to_string())
    } else {
        Ok(Session::new())
    }
}

fn save_chat_session(session_id: &str, session: &Session) -> Result<(), String> {
    session
        .save_to_path(chat_session_path(session_id)?)
        .map_err(|e| e.to_string())
}

const MAX_CHAT_IMAGE_BASE64_CHARS: usize = 12 * 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatImageInput {
    name: Option<String>,
    mime_type: String,
    data: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendRequest {
    text: String,
    #[serde(default)]
    images: Vec<ChatImageInput>,
}

fn split_data_url(value: &str) -> Option<(&str, &str)> {
    let rest = value.strip_prefix("data:")?;
    let (metadata, data) = rest.split_once(',')?;
    if !metadata
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return None;
    }
    let media_type = metadata.split(';').next().unwrap_or_default();
    Some((media_type, data))
}

fn image_block_from_input(input: ChatImageInput) -> Result<ContentBlock, String> {
    let declared_media_type = input.mime_type.trim();
    let (media_type, data) = match split_data_url(input.data.trim()) {
        Some((url_media_type, data)) => {
            let media_type = if declared_media_type.is_empty() {
                url_media_type
            } else {
                declared_media_type
            };
            (media_type, data.trim())
        }
        None => (declared_media_type, input.data.trim()),
    };

    if !media_type.starts_with("image/") {
        return Err(format!(
            "attached image {} has unsupported media type `{}`",
            input.name.unwrap_or_else(|| "<unnamed>".to_string()),
            media_type
        ));
    }
    if data.is_empty() {
        return Err("attached image data is empty".to_string());
    }
    if data.len() > MAX_CHAT_IMAGE_BASE64_CHARS {
        return Err(format!(
            "attached image is too large for model input ({} MB base64 limit)",
            MAX_CHAT_IMAGE_BASE64_CHARS / 1024 / 1024
        ));
    }

    Ok(ContentBlock::Image {
        media_type: media_type.to_string(),
        data: data.to_string(),
    })
}

fn user_message_from_request(request: ChatSendRequest) -> Result<ConversationMessage, String> {
    let mut blocks = Vec::new();
    let text = request.text.trim();
    if !text.is_empty() {
        blocks.push(ContentBlock::Text {
            text: text.to_string(),
        });
    }
    for image in request.images {
        blocks.push(image_block_from_input(image)?);
    }
    if blocks.is_empty() {
        blocks.push(ContentBlock::Text {
            text: "Attached context".to_string(),
        });
    }
    Ok(ConversationMessage::user_blocks(blocks))
}

fn get_cached_or_disk_session(state: &ChatState, session_id: &str) -> Result<Session, String> {
    let cached = state
        .sessions
        .lock()
        .map_err(|_| "chat state poisoned".to_string())?
        .get(session_id)
        .cloned();
    cached
        .map(Ok)
        .unwrap_or_else(|| load_chat_session(session_id))
}

fn store_chat_session(
    state: &ChatState,
    session_id: String,
    session: Session,
) -> Result<(), String> {
    save_chat_session(&session_id, &session)?;
    cache_chat_session(state, session_id, session)
}

fn cache_chat_session(
    state: &ChatState,
    session_id: String,
    session: Session,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "chat state poisoned".to_string())?;
    sessions.insert(session_id.clone(), session);
    while sessions.len() > MAX_CACHED_CHAT_SESSIONS {
        let Some(evict) = sessions.keys().find(|key| *key != &session_id).cloned() else {
            break;
        };
        sessions.remove(&evict);
    }
    Ok(())
}

fn permission_mode_for(state: &ChatState, session_id: &str) -> Result<PermissionMode, String> {
    Ok(state
        .permission_modes
        .lock()
        .map_err(|_| "chat state poisoned".to_string())?
        .get(session_id)
        .copied()
        .unwrap_or_else(configured_default_permission_mode))
}

fn configured_default_permission_mode() -> PermissionMode {
    let configured = std::env::current_dir()
        .ok()
        .and_then(|cwd| ConfigLoader::default_for(&cwd).load().ok())
        .and_then(|config| config.permission_mode());
    match configured {
        Some(ResolvedPermissionMode::ReadOnly) => PermissionMode::ReadOnly,
        Some(ResolvedPermissionMode::WorkspaceWrite) | None => PermissionMode::WorkspaceWrite,
        Some(ResolvedPermissionMode::DangerFullAccess) => PermissionMode::DangerFullAccess,
    }
}

fn set_permission_mode_for(
    state: &ChatState,
    session_id: String,
    mode: PermissionMode,
) -> Result<(), String> {
    state
        .permission_modes
        .lock()
        .map_err(|_| "chat state poisoned".to_string())?
        .insert(session_id, mode);
    Ok(())
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStatus {
    ready: bool,
    model: Option<String>,
    provider: Option<String>,
    message: Option<String>,
    context_window: Option<u64>,
    memory_files: Option<usize>,
}

fn context_window_for_model(model: &str) -> u64 {
    if model.starts_with("claude") {
        if model.contains("haiku") {
            return 200_000;
        }
        return 1_000_000;
    }
    if model.starts_with("MiniMax") || model.starts_with("minimax") {
        return 1_000_000;
    }
    if model.starts_with("gemini-") {
        return 1_000_000;
    }
    if model.starts_with("deepseek") {
        return 64_000;
    }
    128_000
}

#[tauri::command]
pub fn chat_status() -> ChatStatus {
    let memory_files = status_context(None).ok().map(|ctx| ctx.memory_file_count);
    match resolve_executor() {
        Ok((model, provider, _)) => {
            let cw = context_window_for_model(&model);
            ChatStatus {
                ready: true,
                model: Some(model),
                provider: Some(provider),
                message: None,
                context_window: Some(cw),
                memory_files,
            }
        }
        Err(message) => ChatStatus {
            ready: false,
            model: None,
            provider: None,
            message: Some(message),
            context_window: None,
            memory_files,
        },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandSpec {
    name: String,
    description: String,
    argument_hint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandSelectionItem {
    value: String,
    label: String,
    description: Option<String>,
    is_current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandSelection {
    command: String,
    title: String,
    subtitle: Option<String>,
    current: Option<String>,
    items: Vec<ChatCommandSelectionItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandResult {
    handled: bool,
    message: Option<String>,
    prompt: Option<String>,
    selection: Option<ChatCommandSelection>,
    replace_turns: bool,
    open_settings: bool,
    refresh_status: bool,
}

impl ChatCommandResult {
    fn unhandled() -> Self {
        Self {
            handled: false,
            message: None,
            prompt: None,
            selection: None,
            replace_turns: false,
            open_settings: false,
            refresh_status: false,
        }
    }

    fn message(message: impl Into<String>) -> Self {
        Self {
            handled: true,
            message: Some(message.into()),
            prompt: None,
            selection: None,
            replace_turns: false,
            open_settings: false,
            refresh_status: false,
        }
    }

    fn prompt(prompt: impl Into<String>) -> Self {
        Self {
            handled: true,
            message: None,
            prompt: Some(prompt.into()),
            selection: None,
            replace_turns: false,
            open_settings: false,
            refresh_status: false,
        }
    }

    fn selection(selection: ChatCommandSelection) -> Self {
        Self {
            handled: true,
            message: None,
            prompt: None,
            selection: Some(selection),
            replace_turns: false,
            open_settings: false,
            refresh_status: false,
        }
    }

    fn replace(message: impl Into<String>) -> Self {
        Self {
            replace_turns: true,
            ..Self::message(message)
        }
    }

    fn settings(message: impl Into<String>) -> Self {
        Self {
            open_settings: true,
            ..Self::message(message)
        }
    }

    fn refresh(message: impl Into<String>) -> Self {
        Self {
            refresh_status: true,
            ..Self::message(message)
        }
    }
}

#[tauri::command]
pub fn chat_command_specs() -> Vec<ChatCommandSpec> {
    slash_command_specs()
        .iter()
        .map(|spec| ChatCommandSpec {
            name: spec.name.to_string(),
            description: spec.summary.to_string(),
            argument_hint: spec.argument_hint.map(ToOwned::to_owned),
        })
        .collect()
}

#[allow(clippy::too_many_lines)]
#[tauri::command]
pub fn chat_run_command(
    state: State<ChatState>,
    session_id: String,
    input: String,
) -> Result<ChatCommandResult, String> {
    validate_session_id(&session_id)?;
    let trimmed = input.trim();
    if !trimmed.starts_with('/') {
        return Ok(ChatCommandResult::unhandled());
    }
    if matches!(trimmed, "/exit" | "/quit") {
        return Ok(ChatCommandResult::message(
            "Desktop Chat does not have a REPL process to exit. Close the window or start a new chat.",
        ));
    }

    let Some(command) = SlashCommand::parse(trimmed) else {
        return Ok(ChatCommandResult::unhandled());
    };
    let session = get_cached_or_disk_session(&state, &session_id)?;

    match command {
        SlashCommand::Help => Ok(ChatCommandResult::message(render_desktop_repl_help())),
        SlashCommand::Status => {
            let model = chat_status_model_label();
            let tracker = UsageTracker::from_session(&session);
            let permission_mode = permission_mode_for(&state, &session_id)?;
            Ok(ChatCommandResult::message(format_status_report(
                &model,
                StatusUsage {
                    message_count: session.messages.len(),
                    turns: tracker.turns(),
                    latest: tracker.current_turn_usage(),
                    cumulative: tracker.cumulative_usage(),
                    estimated_tokens: 0,
                },
                permission_mode.as_str(),
                &status_context(Some(&chat_session_path(&session_id)?))?,
            )))
        }
        SlashCommand::Compact => {
            let result = runtime::compact_session(&session, CompactionConfig::default());
            let removed = result.removed_message_count;
            let kept = result.compacted_session.messages.len();
            store_chat_session(&state, session_id, result.compacted_session)?;
            Ok(ChatCommandResult::message(format_compact_report(
                removed,
                kept,
                removed == 0,
            )))
        }
        SlashCommand::Model { model } => handle_model_command(model),
        SlashCommand::Reviewer { model } => handle_reviewer_command(model),
        SlashCommand::Setup => Ok(ChatCommandResult::settings(
            "Open Settings to configure API keys, providers, and models.",
        )),
        SlashCommand::Plan { task } => handle_plan_command(task.as_deref()),
        SlashCommand::Tasks { action } => handle_tasks_command(action.as_deref()),
        SlashCommand::Skills { action, target } => {
            handle_skills_command(action.as_deref(), target.as_deref())
        }
        SlashCommand::Permissions { mode } => {
            handle_permissions_command(&state, session_id, mode.as_deref())
        }
        SlashCommand::Clear { confirm } => {
            if !confirm {
                return Ok(ChatCommandResult::message(
                    "clear: confirmation required; run /clear --confirm to start a fresh desktop chat session.",
                ));
            }
            store_chat_session(&state, session_id, Session::new())?;
            Ok(ChatCommandResult::replace(
                "Session cleared\n  Mode             fresh desktop chat session",
            ))
        }
        SlashCommand::Cost => {
            let usage = UsageTracker::from_session(&session).cumulative_usage();
            Ok(ChatCommandResult::message(format_cost_report(usage)))
        }
        SlashCommand::Resume { session_path } => {
            handle_resume_command(&state, session_id, session_path.as_deref())
        }
        SlashCommand::Config { section } => Ok(ChatCommandResult::message(render_config_report(
            section.as_deref(),
        )?)),
        SlashCommand::Memory { action, target } => Ok(ChatCommandResult::message(
            handle_memory_command(action.as_deref(), target.as_deref())?,
        )),
        SlashCommand::Init => Ok(ChatCommandResult::message(init_desktop_repo()?)),
        SlashCommand::Diff => Ok(ChatCommandResult::message(render_diff_report()?)),
        SlashCommand::Version => Ok(ChatCommandResult::message(render_version_report())),
        SlashCommand::Export { path } => handle_export_command(&session, path.as_deref()),
        SlashCommand::Session { action, target } => {
            handle_session_command(&session_id, action.as_deref(), target.as_deref())
        }
        SlashCommand::Team { action, target } => {
            handle_team_command(action.as_deref(), target.as_deref())
        }
        SlashCommand::Workflows { action, target } => {
            handle_workflows_command(&state, session_id, action.as_deref(), target.as_deref())
        }
        SlashCommand::Bughunter { scope } => Ok(ChatCommandResult::prompt(bughunter_prompt(
            scope.as_deref(),
        ))),
        SlashCommand::Ultraplan { task } => {
            Ok(ChatCommandResult::prompt(ultraplan_prompt(task.as_deref())))
        }
        SlashCommand::Teleport { target } => {
            let Some(target) = target
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                return Ok(ChatCommandResult::message(
                    "Usage: /teleport <symbol-or-path>",
                ));
            };
            Ok(ChatCommandResult::message(render_teleport_report(target)?))
        }
        SlashCommand::DebugToolCall => Ok(ChatCommandResult::message(
            render_last_tool_debug_report(&session)?,
        )),
        SlashCommand::Commit => handle_commit_command(&session),
        SlashCommand::Pr { context } => Ok(ChatCommandResult::prompt(pr_draft_prompt(
            &session,
            context.as_deref(),
        )?)),
        SlashCommand::Issue { context } => Ok(ChatCommandResult::prompt(issue_draft_prompt(
            &session,
            context.as_deref(),
        ))),
        SlashCommand::MetaOptimize { action, target } => {
            let args = [action, target]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            Ok(ChatCommandResult::prompt(skill_prompt(
                "meta-optimize",
                &args,
            )))
        }
        SlashCommand::Unknown { name, args } => {
            if tools::skill_markdown(&name).is_some() {
                Ok(ChatCommandResult::prompt(skill_prompt(
                    &name,
                    args.as_deref().unwrap_or(""),
                )))
            } else {
                Ok(ChatCommandResult::message(format!(
                    "unknown slash command: /{name}\n\n{}",
                    render_slash_command_help()
                )))
            }
        }
    }
}

#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    state: State<'_, ChatState>,
    session_id: String,
    message: String,
) -> Result<String, String> {
    let user_message = ConversationMessage::user_text(message);
    run_chat_turn(app, &state, session_id, user_message).await
}

#[tauri::command]
pub async fn chat_send_rich(
    app: AppHandle,
    state: State<'_, ChatState>,
    session_id: String,
    request: ChatSendRequest,
) -> Result<String, String> {
    let user_message = user_message_from_request(request)?;
    run_chat_turn(app, &state, session_id, user_message).await
}

/// Variant of `chat_send_rich` used by Literature agent searches.
/// Bash is allowed so `/research-lit` can run Python paper-fetching helpers;
/// multi-agent and worktree tools remain blocked.
#[tauri::command]
pub async fn literature_agent_send_rich(
    app: AppHandle,
    state: State<'_, ChatState>,
    session_id: String,
    request: ChatSendRequest,
) -> Result<String, String> {
    let user_message = user_message_from_request(request)?;
    run_literature_chat_turn(app, &state, session_id, user_message).await
}

#[tauri::command]
pub async fn chat_suggest_title(user: String, assistant: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || suggest_chat_title(&user, &assistant))
        .await
        .map_err(|e| e.to_string())?
}

fn suggest_chat_title(user: &str, assistant: &str) -> Result<String, String> {
    crate::config::apply_reviewer_environment(true);
    let (model, _provider, executor_config) = resolve_executor()?;
    runtime::clear_interrupt();
    let system = "Generate a concise title for a chat conversation. Output only the title. Use the conversation language. Keep it short: ideally 4 to 12 Chinese characters or 2 to 6 English words. Do not use quotes, labels, punctuation, or markdown.";
    let prompt = format!(
        "User message:\n{}\n\nAssistant reply:\n{}\n\nTitle:",
        truncate_for_prompt(user, 1200),
        truncate_for_prompt(assistant, 1200)
    );
    let observer: Box<dyn aris_executor::StreamObserver> = Box::new(SilentStreamObserver);
    let mut runtime = aris_chat::build_conversation_runtime(
        Session::new(),
        executor_config,
        model,
        false,
        Vec::new(),
        observer,
        NoToolsExecutor,
        aris_chat::permission_policy_for_tools(Vec::new(), PermissionMode::ReadOnly),
        vec![system.to_string()],
        runtime::RuntimeFeatureConfig::default(),
    )?;
    let summary = runtime
        .run_turn_message(ConversationMessage::user_text(prompt), None)
        .map_err(|e| e.to_string())?;
    let title = clean_generated_title(&aris_chat::final_assistant_text(&summary));
    if title.is_empty() {
        return Err("empty generated title".to_string());
    }
    Ok(title)
}

fn clean_generated_title(raw: &str) -> String {
    let mut title = raw
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string();
    for prefix in ["Title:", "title:", "TITLE:", "标题:", "标题："] {
        if let Some(rest) = title.strip_prefix(prefix) {
            title = rest.trim().to_string();
            break;
        }
    }
    title = title
        .trim_matches(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '"' | '\''
                        | '`'
                        | '*'
                        | '#'
                        | '['
                        | ']'
                        | '('
                        | ')'
                        | ':'
                        | ';'
                        | '.'
                        | ','
                        | '!'
                        | '?'
                        | '-'
                        | '_'
                        | ' '
                        | '「'
                        | '」'
                        | '“'
                        | '”'
                        | '《'
                        | '》'
                        | '。'
                        | '，'
                        | '！'
                        | '？'
                        | '：'
                        | '；'
                )
        })
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    title.chars().take(48).collect()
}

async fn run_chat_turn(
    app: AppHandle,
    state: &ChatState,
    session_id: String,
    user_message: ConversationMessage,
) -> Result<String, String> {
    run_chat_turn_with_context(
        app,
        state,
        session_id,
        user_message,
        DESKTOP_CHAT_BLOCKED_TOOLS,
        true,
    )
    .await
}

async fn run_literature_chat_turn(
    app: AppHandle,
    state: &ChatState,
    session_id: String,
    user_message: ConversationMessage,
) -> Result<String, String> {
    run_chat_turn_with_context(
        app,
        state,
        session_id,
        user_message,
        LITERATURE_AGENT_BLOCKED_TOOLS,
        false,
    )
    .await
}

async fn run_chat_turn_with_context(
    app: AppHandle,
    state: &ChatState,
    session_id: String,
    user_message: ConversationMessage,
    blocked_tools: &'static [&'static str],
    full_tool_registry: bool,
) -> Result<String, String> {
    validate_session_id(&session_id)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut running = state
            .running_turns
            .lock()
            .map_err(|_| "chat state poisoned".to_string())?;
        if running.contains_key(&session_id) {
            return Err("this chat already has a running turn".to_string());
        }
        running.insert(session_id.clone(), cancelled.clone());
    }
    let _busy = ChatBusyGuard {
        running_turns: &state.running_turns,
        session_id: session_id.clone(),
    };
    crate::config::apply_reviewer_environment(true);
    let (model, _provider, executor_config) = resolve_executor()?;
    let session = get_cached_or_disk_session(&state, &session_id)?;
    let permission_mode = permission_mode_for(&state, &session_id)?;

    let worker_app = app.clone();
    let worker_session_id = session_id.clone();
    let worker_cancelled = cancelled.clone();
    let (text, updated): (String, Session) = tauri::async_runtime::spawn_blocking(move || {
        let feature_config = match std::env::current_dir()
            .map_err(|error| error.to_string())
            .and_then(|cwd| {
                ConfigLoader::default_for(cwd)
                    .load()
                    .map_err(|error| error.to_string())
            }) {
            Ok(config) => config.feature_config().clone(),
            Err(error) => {
                eprintln!("aris desktop: could not load settings: {error}");
                runtime::RuntimeFeatureConfig::default()
            }
        };
        let tool_specs = aris_chat::chat_tool_specs(tool_specs_for(blocked_tools));
        let mcp_bundle = aris_chat::attach_mcp_tools(
            KernelToolExecutor { blocked_tools },
            tool_specs,
            &feature_config,
            None,
        );
        for warning in &mcp_bundle.warnings {
            eprintln!("aris desktop: {warning}");
        }
        let permission_policy =
            aris_chat::permission_policy_for_tools(mcp_bundle.tool_specs.clone(), permission_mode);
        let observer: Box<dyn aris_executor::StreamObserver> = Box::new(DesktopStreamObserver {
            app: worker_app.clone(),
            session_id: worker_session_id.clone(),
            cancelled: worker_cancelled.clone(),
        });
        let executor = DesktopToolExecutor {
            app: worker_app,
            session_id: worker_session_id,
            cancelled: worker_cancelled,
            inner: mcp_bundle.executor,
        };
        let mut system_prompt = build_system_prompt_inner(&model, full_tool_registry);
        if let Some(status) = mcp_runtime_status_prompt(
            feature_config.mcp().servers().len(),
            &mcp_bundle.tool_specs,
            &mcp_bundle.warnings,
        ) {
            system_prompt.push(status);
        }
        let mut runtime = aris_chat::build_conversation_runtime(
            session,
            executor_config,
            model,
            true,
            mcp_bundle.tool_specs,
            observer,
            executor,
            permission_policy,
            system_prompt,
            feature_config,
        )?;
        let summary = runtime
            .run_turn_message(user_message, None)
            .map_err(|e| e.to_string())?;
        let text = aris_chat::final_assistant_text(&summary);
        Ok::<(String, Session), String>((text, runtime.into_session()))
    })
    .await
    .map_err(|e| e.to_string())??;

    store_chat_session(state, session_id.clone(), updated)?;
    let _ = app.emit(
        "chat-done",
        json!({ "sessionId": session_id, "text": &text }),
    );
    Ok(text)
}

#[tauri::command]
pub fn chat_reset(state: State<ChatState>, session_id: String) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let fresh = Session::new();
    store_chat_session(&state, session_id, fresh)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContextMessage {
    role: String,
    text: String,
    #[serde(default)]
    images: Vec<ChatImageInput>,
}

#[tauri::command]
pub fn chat_set_context(
    state: State<ChatState>,
    session_id: String,
    messages: Vec<ChatContextMessage>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let mut session = Session::new();
    for message in messages {
        match message.role.as_str() {
            "user" => session
                .messages
                .push(user_message_from_request(ChatSendRequest {
                    text: message.text,
                    images: message.images,
                })?),
            "assistant" => {
                session
                    .messages
                    .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                        text: message.text,
                    }]))
            }
            _ => return Err("chat context only supports user and assistant messages".to_string()),
        }
    }
    store_chat_session(&state, session_id, session)
}

#[tauri::command]
pub fn chat_delete(
    state: State<ChatState>,
    session_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    state
        .sessions
        .lock()
        .map_err(|_| "chat state poisoned".to_string())?
        .remove(&session_id);
    state
        .permission_modes
        .lock()
        .map_err(|_| "chat state poisoned".to_string())?
        .remove(&session_id);
    let path = match project_id {
        Some(project_id) => {
            if !crate::state::valid_project_id(&project_id) {
                return Err("invalid project id".to_string());
            }
            crate::state::sessions_dir_for_project(&project_id).join(format!("{session_id}.json"))
        }
        None => chat_session_path(&session_id)?,
    };
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Request the in-flight chat turn to stop. Sets the runtime interrupt flag,
/// which both streaming loops and `run_turn`'s iteration boundary check, so a
/// long single response or a multi-step tool loop both unwind to an error.
#[tauri::command]
pub fn chat_cancel(state: State<ChatState>, session_id: String) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let running = state
        .running_turns
        .lock()
        .map_err(|_| "chat state poisoned".to_string())?;
    if let Some(cancelled) = running.get(&session_id) {
        cancelled.store(true, Ordering::SeqCst);
    }
    Ok(())
}

// ---- Desktop slash command helpers ---------------------------------------

#[derive(Debug, Clone)]
struct StatusContext {
    cwd: PathBuf,
    session_path: Option<PathBuf>,
    loaded_config_files: usize,
    discovered_config_files: usize,
    memory_file_count: usize,
    project_root: Option<PathBuf>,
    git_branch: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct StatusUsage {
    message_count: usize,
    turns: u32,
    latest: TokenUsage,
    cumulative: TokenUsage,
    estimated_tokens: usize,
}

fn chat_status_model_label() -> String {
    resolve_executor()
        .map(|(model, provider, _)| format!("{model} ({provider})"))
        .unwrap_or_else(|_| {
            crate::config::load_object()
                .get("executor_model")
                .and_then(Value::as_str)
                .unwrap_or("not configured")
                .to_string()
        })
}

fn config_string(key: &str) -> Option<String> {
    crate::config::load_object()
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
}

fn save_config_object(obj: &serde_json::Map<String, Value>) -> Result<(), String> {
    let path = crate::state::config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body =
        serde_json::to_string_pretty(&Value::Object(obj.clone())).map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| e.to_string())
}

fn set_config_string(key: &str, value: String) -> Result<(), String> {
    let mut obj = crate::config::load_object();
    obj.insert(key.to_string(), Value::String(value));
    save_config_object(&obj)
}

fn resolve_desktop_model_alias(model: &str, provider: Option<&str>) -> String {
    if provider == Some("openai") {
        return model.to_string();
    }
    match model {
        "opus" => "claude-opus-4-7",
        "sonnet" => "claude-sonnet-4-6",
        "haiku" => "claude-haiku-4-5-20251001",
        _ => model,
    }
    .to_string()
}

fn selection_item(
    value: &str,
    label: &str,
    description: &str,
    current: &str,
) -> ChatCommandSelectionItem {
    ChatCommandSelectionItem {
        value: value.to_string(),
        label: label.to_string(),
        description: Some(description.to_string()),
        is_current: value == current,
    }
}

fn model_selection_items(
    current: &str,
    choices: &[(&str, &str, &str)],
) -> Vec<ChatCommandSelectionItem> {
    let mut items = choices
        .iter()
        .map(|(value, label, description)| selection_item(value, label, description, current))
        .collect::<Vec<_>>();
    if !current.trim().is_empty()
        && current != "not configured"
        && !items.iter().any(|item| item.value == current)
    {
        items.insert(
            0,
            ChatCommandSelectionItem {
                value: current.to_string(),
                label: current.to_string(),
                description: Some("Current configured model".to_string()),
                is_current: true,
            },
        );
    }
    items
}

fn executor_model_selection(provider: &str, current: &str) -> ChatCommandSelection {
    let anthropic_choices = [
        (
            "claude-opus-4-7",
            "claude-opus-4-7",
            "Opus 4.7 - most capable for complex work",
        ),
        (
            "claude-sonnet-4-6",
            "claude-sonnet-4-6",
            "Sonnet 4.6 - best for everyday tasks",
        ),
        (
            "claude-haiku-4-5-20251001",
            "claude-haiku-4-5-20251001",
            "Haiku 4.5 - fastest for quick answers",
        ),
    ];
    let openai_compat_choices = [
        ("gpt-5.5", "gpt-5.5", "OpenAI - best intelligence at scale"),
        ("gpt-5.4", "gpt-5.4", "OpenAI - previous flagship"),
        ("gpt-5.4-mini", "gpt-5.4-mini", "OpenAI - strong mini model"),
        (
            "gpt-5.4-nano",
            "gpt-5.4-nano",
            "OpenAI - cheapest high-volume model",
        ),
        (
            "gemini-2.5-pro",
            "gemini-2.5-pro",
            "Google - most capable Gemini",
        ),
        (
            "gemini-2.5-flash",
            "gemini-2.5-flash",
            "Google - fast Gemini",
        ),
        ("GLM-5", "GLM-5", "Zhipu - GLM 5 latest"),
        ("MiniMax-M3", "MiniMax-M3", "MiniMax - M3"),
        ("MiniMax-M2.7", "MiniMax-M2.7", "MiniMax - M2.7 latest"),
        ("kimi-k2.5", "kimi-k2.5", "Kimi - K2.5 reasoning"),
        ("deepseek-v4-pro", "deepseek-v4-pro", "DeepSeek - V4 Pro"),
        ("mimo-v2.5-pro", "mimo-v2.5-pro", "Xiaomi - MiMo v2.5 Pro"),
        ("mimo-v2.5", "mimo-v2.5", "Xiaomi - MiMo v2.5"),
        ("qwen3.6-plus", "qwen3.6-plus", "Alibaba - Qwen 3.6 Plus"),
        ("qwen3.6-flash", "qwen3.6-flash", "Alibaba - Qwen 3.6 Flash"),
        (
            "qwen3.6-max-preview",
            "qwen3.6-max-preview",
            "Alibaba - Qwen 3.6 Max Preview",
        ),
        (
            "doubao-pro-4k",
            "doubao-pro-4k",
            "ByteDance - Doubao Pro 4K",
        ),
        (
            "doubao-lite-4k",
            "doubao-lite-4k",
            "ByteDance - Doubao Lite 4K",
        ),
    ];
    let choices = if provider == "anthropic" {
        &anthropic_choices[..]
    } else {
        &openai_compat_choices[..]
    };
    ChatCommandSelection {
        command: "model".to_string(),
        title: "Select executor model".to_string(),
        subtitle: Some(format!(
            "Provider: {provider}. You can still type /model <model-id>."
        )),
        current: Some(current.to_string()),
        items: model_selection_items(current, choices),
    }
}

fn reviewer_model_selection(provider: &str, current: &str) -> ChatCommandSelection {
    let reviewer_choices = [
        (
            "gpt-5.5",
            "gpt-5.5",
            "OpenAI - best intelligence for reviews",
        ),
        ("gpt-5.4", "gpt-5.4", "OpenAI - previous flagship"),
        (
            "gpt-5.4-mini",
            "gpt-5.4-mini",
            "OpenAI - strong and affordable",
        ),
        (
            "gpt-5.4-nano",
            "gpt-5.4-nano",
            "OpenAI - cheapest high-volume model",
        ),
        ("gpt-4o", "gpt-4o", "OpenAI - older stable model"),
        (
            "gemini-2.5-pro",
            "gemini-2.5-pro",
            "Google - deep reasoning",
        ),
        (
            "gemini-2.5-flash",
            "gemini-2.5-flash",
            "Google - fast and efficient",
        ),
        ("GLM-5", "GLM-5", "Zhipu - most capable"),
        ("GLM-5-Turbo", "GLM-5-Turbo", "Zhipu - fast"),
        ("MiniMax-M3", "MiniMax-M3", "MiniMax - M3"),
        ("MiniMax-M2.7", "MiniMax-M2.7", "MiniMax - latest"),
        (
            "MiniMax-M2.7-highspeed",
            "MiniMax-M2.7-highspeed",
            "MiniMax - fast inference",
        ),
        ("kimi-k2.5", "kimi-k2.5", "Kimi - K2.5 reasoning"),
        (
            "claude-sonnet-4-6",
            "claude-sonnet-4-6",
            "Anthropic - balanced reviewer",
        ),
    ];
    ChatCommandSelection {
        command: "reviewer".to_string(),
        title: "Select reviewer model".to_string(),
        subtitle: Some(format!(
            "Provider: {provider}. Used by future LlmReview tool calls."
        )),
        current: Some(current.to_string()),
        items: model_selection_items(current, &reviewer_choices),
    }
}

fn permissions_selection(current: &str) -> ChatCommandSelection {
    ChatCommandSelection {
        command: "permissions".to_string(),
        title: "Select permission mode".to_string(),
        subtitle: Some(
            "Claude Code-style levels control the complete desktop Chat tool registry.".to_string(),
        ),
        current: Some(current.to_string()),
        items: vec![
            selection_item(
                "read-only",
                "Plan / read-only",
                "Inspect and search without changing files",
                current,
            ),
            selection_item(
                "workspace-write",
                "Accept edits",
                "Read and edit workspace files; higher-risk tools stay gated",
                current,
            ),
            selection_item(
                "danger-full-access",
                "Don't ask",
                "Allow shell, agents, workflows, and all other tools",
                current,
            ),
        ],
    }
}

fn handle_model_command(model: Option<String>) -> Result<ChatCommandResult, String> {
    let provider = config_string("executor_provider").unwrap_or_else(|| "anthropic".to_string());
    let previous =
        config_string("executor_model").unwrap_or_else(|| aris_chat::DEFAULT_MODEL.to_string());
    let Some(requested) = model else {
        return Ok(ChatCommandResult::selection(executor_model_selection(
            &provider, &previous,
        )));
    };

    let next = resolve_desktop_model_alias(&requested, Some(&provider));
    if next == previous {
        return Ok(ChatCommandResult::message(format!(
            "Model\n  Current model    {previous}\n  Provider         {provider}"
        )));
    }
    set_config_string("executor_model", next.clone())?;
    Ok(ChatCommandResult::refresh(format!(
        "Model updated\n  Previous         {previous}\n  Current          {next}\n  Applies to       subsequent desktop chat turns"
    )))
}

fn handle_reviewer_command(model: Option<String>) -> Result<ChatCommandResult, String> {
    let previous = config_string("reviewer_model").unwrap_or_else(|| "not configured".to_string());
    let provider =
        config_string("reviewer_provider").unwrap_or_else(|| "not configured".to_string());
    let Some(next) = model else {
        return Ok(ChatCommandResult::selection(reviewer_model_selection(
            &provider, &previous,
        )));
    };
    set_config_string("reviewer_model", next.clone())?;
    Ok(ChatCommandResult::message(format!(
        "Reviewer model updated\n  Previous         {previous}\n  Current          {next}\n  Applies to       future LlmReview tool calls"
    )))
}

fn normalize_permission_mode(mode: &str) -> Option<PermissionMode> {
    match mode.trim() {
        "default" | "plan" | "read-only" => Some(PermissionMode::ReadOnly),
        "acceptEdits" | "auto" | "workspace-write" => Some(PermissionMode::WorkspaceWrite),
        "dontAsk" | "bypassPermissions" | "danger-full-access" => {
            Some(PermissionMode::DangerFullAccess)
        }
        _ => None,
    }
}

fn handle_permissions_command(
    state: &ChatState,
    session_id: String,
    mode: Option<&str>,
) -> Result<ChatCommandResult, String> {
    let current = permission_mode_for(state, &session_id)?;
    let Some(mode) = mode else {
        return Ok(ChatCommandResult::selection(permissions_selection(
            current.as_str(),
        )));
    };
    let next = normalize_permission_mode(mode).ok_or_else(|| {
        format!(
            "unsupported permission mode '{mode}'. Use plan/read-only, acceptEdits/workspace-write, or dontAsk/danger-full-access."
        )
    })?;
    if next == current {
        return Ok(ChatCommandResult::message(format_permissions_report(
            current.as_str(),
        )));
    }
    set_permission_mode_for(state, session_id, next)?;
    Ok(ChatCommandResult::message(format!(
        "Permissions updated\n  Previous mode    {}\n  Active mode      {}\n  Applies to       subsequent desktop chat tool calls\n  Note             higher modes unlock shell, agents, workflows, and other tools",
        current.as_str(),
        next.as_str()
    )))
}

fn format_permissions_report(mode: &str) -> String {
    format!(
        "Permissions\n  Active mode      {mode}\n  Surface          desktop Chat\n\nModes\n  plan / read-only              Inspect and search only\n  acceptEdits / workspace-write Read and edit workspace files\n  dontAsk / danger-full-access  Allow shell, agents, workflows, and all tools\n\nUsage\n  Inspect current mode with /permissions\n  Switch modes with /permissions <mode>\n  Project settings permissions.defaultMode supplies the session default"
    )
}

fn handle_plan_command(task: Option<&str>) -> Result<ChatCommandResult, String> {
    match task.map(str::trim) {
        Some("exit") => Ok(ChatCommandResult::message(
            "Plan mode is transient in desktop Chat. There is no active mode to exit.",
        )),
        Some(arg) if arg.starts_with("execute") => {
            let extra = arg.strip_prefix("execute").unwrap_or("").trim();
            let prompt = if extra.is_empty() {
                "Execute the plan you proposed. Proceed step by step.".to_string()
            } else {
                format!("Execute the plan you proposed. Additional instructions: {extra}")
            };
            Ok(ChatCommandResult::prompt(prompt))
        }
        _ => Ok(ChatCommandResult::prompt(plan_prompt(task))),
    }
}

fn plan_prompt(task: Option<&str>) -> String {
    let task_desc = task.unwrap_or("the user's request");
    format!(
        "You are in PLAN MODE for desktop Chat. Analyze the codebase and create a detailed step-by-step plan for: {task_desc}\n\nFor each step include files to inspect or change, the specific changes needed, risks, and verification steps. Do not edit files in this turn; only produce the plan."
    )
}

fn bughunter_prompt(scope: Option<&str>) -> String {
    let scope = scope.unwrap_or("the current repository");
    format!(
        "You are /bughunter. Inspect {scope} and identify the most likely bugs or correctness issues. Prioritize concrete findings with file paths, severity, and suggested fixes. Use tools if needed."
    )
}

fn ultraplan_prompt(task: Option<&str>) -> String {
    let task = task.unwrap_or("the current repo work");
    format!(
        "You are /ultraplan. Produce a deep multi-step execution plan for {task}. Include goals, risks, implementation sequence, verification steps, and rollback considerations. Use tools if needed."
    )
}

fn skill_prompt(name: &str, args: &str) -> String {
    if args.trim().is_empty() {
        format!(
            "Use the Skill tool to invoke the skill named \"{name}\". Follow the skill instructions precisely."
        )
    } else {
        format!(
            "Use the Skill tool to invoke the skill named \"{name}\" with arguments: {}. Follow the skill instructions precisely.",
            args.trim()
        )
    }
}

fn aris_tasks_path() -> PathBuf {
    std::env::var("CLAWD_TODO_STORE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(runtime::home_dir())
                .join(".config")
                .join("aris")
                .join("tasks.json")
        })
}

fn handle_tasks_command(action: Option<&str>) -> Result<ChatCommandResult, String> {
    let path = aris_tasks_path();
    if action == Some("clear") {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
            return Ok(ChatCommandResult::message("Tasks cleared."));
        }
        return Ok(ChatCommandResult::message("No tasks file to clear."));
    }

    if !path.exists() {
        return Ok(ChatCommandResult::message(
            "No tasks yet. The model manages tasks automatically via TodoWrite.",
        ));
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let todos: Result<Vec<Value>, _> = serde_json::from_str(&content);
    let Ok(todos) = todos else {
        return Ok(ChatCommandResult::message(content));
    };
    if todos.is_empty() {
        return Ok(ChatCommandResult::message(
            "No tasks yet. The model manages tasks automatically via TodoWrite.",
        ));
    }
    let mut lines = vec!["Tasks".to_string(), String::new()];
    for todo in todos {
        let status = todo
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending");
        let content = todo.get("content").and_then(Value::as_str).unwrap_or("?");
        lines.push(format!("  [{status}] {content}"));
    }
    Ok(ChatCommandResult::message(lines.join("\n")))
}

fn handle_skills_command(
    action: Option<&str>,
    target: Option<&str>,
) -> Result<ChatCommandResult, String> {
    match action {
        None | Some("list") => {
            let skills = tools::discover_skills();
            if skills.is_empty() {
                return Ok(ChatCommandResult::message("No skills found."));
            }
            let mut lines = vec!["Available skills".to_string(), String::new()];
            for skill in skills {
                let description = skill.description.unwrap_or_default();
                lines.push(format!("  /{:<28} {}", skill.name, description));
            }
            Ok(ChatCommandResult::message(lines.join("\n")))
        }
        Some("show") => {
            let Some(name) = target else {
                return Ok(ChatCommandResult::message("Usage: /skills show <name>"));
            };
            match tools::skill_markdown(name) {
                Some(content) => Ok(ChatCommandResult::message(format!("/{name}\n\n{content}"))),
                None => Ok(ChatCommandResult::message(format!(
                    "Skill '{name}' not found."
                ))),
            }
        }
        Some("export") => {
            let Some(name) = target else {
                return Ok(ChatCommandResult::message("Usage: /skills export <name>"));
            };
            export_skill(name).map(ChatCommandResult::message)
        }
        Some(other) => Ok(ChatCommandResult::message(format!(
            "Unknown action '{other}'. Use: /skills [list|show <name>|export <name>]"
        ))),
    }
}

fn export_skill(name: &str) -> Result<String, String> {
    let content =
        tools::skill_markdown(name).ok_or_else(|| format!("Skill '{name}' not found."))?;
    let clean_name = name.trim().trim_start_matches('/').trim_start_matches('$');
    if clean_name.is_empty()
        || clean_name.contains('/')
        || clean_name.contains('\\')
        || clean_name.contains("..")
    {
        return Err("invalid skill name".to_string());
    }
    let target_dir = PathBuf::from(runtime::home_dir())
        .join(".config")
        .join("aris")
        .join("skills")
        .join(clean_name);
    let target_file = target_dir.join("SKILL.md");
    if target_file.exists() {
        return Ok(format!(
            "Already exists: {}\nEdit it directly to customize.",
            target_file.display()
        ));
    }
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    fs::write(&target_file, content).map_err(|e| e.to_string())?;
    Ok(format!(
        "Exported skill\n  Skill            {clean_name}\n  File             {}",
        target_file.display()
    ))
}

fn handle_resume_command(
    state: &ChatState,
    current_session_id: String,
    session_ref: Option<&str>,
) -> Result<ChatCommandResult, String> {
    let Some(session_ref) = session_ref else {
        return Ok(ChatCommandResult::message(
            "Usage: /resume <session-path-or-id>",
        ));
    };
    let (id, path) = resolve_session_reference(session_ref)?;
    let session = Session::load_from_path(&path).map_err(|e| e.to_string())?;
    let message_count = session.messages.len();
    store_chat_session(state, current_session_id, session)?;
    Ok(ChatCommandResult::replace(format!(
        "Session resumed\n  Source session   {id}\n  File             {}\n  Messages         {}\n  Note             loaded into the current desktop chat slot",
        path.display(),
        message_count
    )))
}

fn handle_export_command(
    session: &Session,
    requested_path: Option<&str>,
) -> Result<ChatCommandResult, String> {
    let export_path = resolve_export_path(requested_path, session)?;
    fs::write(&export_path, render_export_text(session)).map_err(|e| e.to_string())?;
    Ok(ChatCommandResult::message(format!(
        "Export\n  Result           wrote transcript\n  File             {}\n  Messages         {}",
        export_path.display(),
        session.messages.len()
    )))
}

fn handle_session_command(
    active_session_id: &str,
    action: Option<&str>,
    target: Option<&str>,
) -> Result<ChatCommandResult, String> {
    match action {
        None | Some("list") => Ok(ChatCommandResult::message(render_session_list(active_session_id)?)),
        Some("switch") => {
            let Some(target) = target else {
                return Ok(ChatCommandResult::message("Usage: /session switch <session-id>"));
            };
            let (id, path) = resolve_session_reference(target)?;
            let session = Session::load_from_path(&path).map_err(|e| e.to_string())?;
            Ok(ChatCommandResult::replace(format!(
                "Session switch requested\n  Target session   {id}\n  File             {}\n  Messages         {}\n\nUse /resume {id} to load it into the current desktop chat slot.",
                path.display(),
                session.messages.len()
            )))
        }
        Some("timeline") => {
            let (id, path) = if let Some(target) = target {
                resolve_session_reference(target)?
            } else {
                (active_session_id.to_string(), chat_session_path(active_session_id)?)
            };
            let session = Session::load_from_path(&path).map_err(|e| e.to_string())?;
            Ok(ChatCommandResult::message(render_simple_timeline(&id, &path, &session)))
        }
        Some("search") => Ok(ChatCommandResult::message(
            serde_json::to_string_pretty(&runtime::search_sessions(
                &crate::state::sessions_dir(),
                target,
                None,
                5,
                5,
            )?)
            .map_err(|error| error.to_string())?,
        )),
        Some(other) => Ok(ChatCommandResult::message(format!(
            "Unknown /session action '{other}'. Use /session list, /session search <query>, /session switch <session-id>, or /session timeline [session-id]."
        ))),
    }
}

fn handle_team_command(
    action: Option<&str>,
    target: Option<&str>,
) -> Result<ChatCommandResult, String> {
    match plan_team_command(action, target) {
        TeamCommandPlan::RenderTeamView { team_id } => {
            tools::render_team_view(team_id.as_deref()).map(ChatCommandResult::message)
        }
        TeamCommandPlan::Tool { name, input } => {
            tools::execute_tool(name, &input).map(ChatCommandResult::message)
        }
        TeamCommandPlan::Message(message) => Ok(ChatCommandResult::message(message)),
    }
}

fn handle_workflows_command(
    state: &ChatState,
    session_id: String,
    action: Option<&str>,
    target: Option<&str>,
) -> Result<ChatCommandResult, String> {
    match plan_workflows_command(action, target) {
        WorkflowCommandPlan::Tool { input } => {
            tools::execute_tool("Workflow", &input).map(ChatCommandResult::message)
        }
        WorkflowCommandPlan::Inject { run_id } => {
            let output =
                tools::execute_tool("Workflow", &json!({ "action": "inspect", "runId": run_id }))?;
            let value: Value = serde_json::from_str(&output).map_err(|e| e.to_string())?;
            let result = value
                .get("run")
                .and_then(|run| run.get("result"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("workflow {run_id} has no completed result to inject"))?;
            let text = format!(
                "# Workflow Result\n\nRun `{run_id}` completed in the background.\n\n{result}"
            );
            let mut session = get_cached_or_disk_session(state, &session_id)?;
            session
                .messages
                .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                    text,
                }]));
            store_chat_session(state, session_id, session)?;
            Ok(ChatCommandResult::message(format!(
                "Workflow\n  Result           injected\n  Run              {run_id}"
            )))
        }
        WorkflowCommandPlan::Message(message) => Ok(ChatCommandResult::message(message)),
    }
}

fn handle_commit_command(session: &Session) -> Result<ChatCommandResult, String> {
    let status = git_output(&["status", "--short"])?;
    if status.trim().is_empty() {
        return Ok(ChatCommandResult::message(
            "Commit\n  Result           skipped\n  Reason           no workspace changes",
        ));
    }
    Ok(ChatCommandResult::prompt(commit_draft_prompt(
        session, &status,
    )?))
}

fn commit_draft_prompt(session: &Session, status: &str) -> Result<String, String> {
    let stat = git_output(&["diff", "--stat"]).unwrap_or_default();
    Ok(format!(
        "Generate a git commit message in plain text only. Do not run git commit. Base it on this workspace status and diff summary:\n\nStatus:\n{}\n\nDiff summary:\n{}\n\nRecent conversation context:\n{}",
        truncate_for_prompt(status, 4_000),
        truncate_for_prompt(&stat, 8_000),
        recent_user_context(session, 6)
    ))
}

fn pr_draft_prompt(session: &Session, context: Option<&str>) -> Result<String, String> {
    let staged = git_output(&["diff", "--stat"]).unwrap_or_default();
    Ok(format!(
        "Generate a pull request title and body from this conversation and diff summary. Output plain text in this format exactly:\nTITLE: <title>\nBODY:\n<body markdown>\n\nContext hint: {}\n\nDiff summary:\n{}\n\nRecent conversation context:\n{}",
        context.unwrap_or("none"),
        truncate_for_prompt(&staged, 10_000),
        recent_user_context(session, 8)
    ))
}

fn issue_draft_prompt(session: &Session, context: Option<&str>) -> String {
    format!(
        "Generate a GitHub issue title and body from this conversation. Output plain text in this format exactly:\nTITLE: <title>\nBODY:\n<body markdown>\n\nContext hint: {}\n\nConversation context:\n{}",
        context.unwrap_or("none"),
        truncate_for_prompt(&recent_user_context(session, 10), 10_000)
    )
}

fn render_desktop_repl_help() -> String {
    [
        "Desktop Chat commands".to_string(),
        "  Type slash commands in the chat input. Commands are executed by the desktop app, not by the CLI binary.".to_string(),
        String::new(),
        render_slash_command_help(),
    ]
    .join("\n")
}

fn status_context(session_path: Option<&Path>) -> Result<StatusContext, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let loader = ConfigLoader::default_for(&cwd);
    let discovered_config_files = loader.discover().len();
    let runtime_config = loader.load().map_err(|e| e.to_string())?;
    let project_context = ProjectContext::discover_with_git(&cwd, &runtime::today_iso())
        .map_err(|e| e.to_string())?;
    let hot_memory_count = runtime::load_hot_memory(&cwd)
        .map(|memory| memory.memory.len() + memory.user.len())
        .unwrap_or_default();
    let knowledge_memory_count = runtime::load_knowledge_memory_catalog().len();
    let (project_root, git_branch) =
        parse_git_status_metadata(project_context.git_status.as_deref());
    Ok(StatusContext {
        cwd,
        session_path: session_path.map(Path::to_path_buf),
        loaded_config_files: runtime_config.loaded_entries().len(),
        discovered_config_files,
        memory_file_count: hot_memory_count + knowledge_memory_count,
        project_root,
        git_branch,
    })
}

fn parse_git_status_metadata(status: Option<&str>) -> (Option<PathBuf>, Option<String>) {
    let branch = status.and_then(|status| {
        status.lines().next().and_then(|line| {
            line.strip_prefix("## ")
                .map(|line| {
                    line.split(['.', ' '])
                        .next()
                        .unwrap_or_default()
                        .to_string()
                })
                .filter(|value| !value.is_empty())
        })
    });
    let project_root = find_git_root().ok();
    (project_root, branch)
}

fn find_git_root() -> Result<PathBuf, String> {
    let output = crate::process::hidden_command("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(std::env::current_dir().map_err(|e| e.to_string())?)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("not a git repository".to_string());
    }
    let path = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    Ok(PathBuf::from(path.trim()))
}

fn format_status_report(
    model: &str,
    usage: StatusUsage,
    permission_mode: &str,
    context: &StatusContext,
) -> String {
    [
        format!(
            "Status\n  Model            {model}\n  Permission mode  {permission_mode}\n  Messages         {}\n  Turns            {}\n  Estimated tokens {}",
            usage.message_count, usage.turns, usage.estimated_tokens
        ),
        format!(
            "Usage\n  Latest total     {}\n  Cumulative input {}\n  Cumulative output {}\n  Cumulative total {}",
            usage.latest.total_tokens(),
            usage.cumulative.input_tokens,
            usage.cumulative.output_tokens,
            usage.cumulative.total_tokens()
        ),
        format!(
            "Workspace\n  Cwd              {}\n  Project root     {}\n  Git branch       {}\n  Session          {}\n  Config files     loaded {}/{}\n  Memory files     {}",
            context.cwd.display(),
            context
                .project_root
                .as_ref()
                .map_or_else(|| "unknown".to_string(), |path| path.display().to_string()),
            context.git_branch.as_deref().unwrap_or("unknown"),
            context.session_path.as_ref().map_or_else(
                || "desktop-chat".to_string(),
                |path| path.display().to_string()
            ),
            context.loaded_config_files,
            context.discovered_config_files,
            context.memory_file_count
        ),
    ]
    .join("\n\n")
}

fn format_cost_report(usage: TokenUsage) -> String {
    format!(
        "Cost\n  Input tokens     {}\n  Output tokens    {}\n  Cache create     {}\n  Cache read       {}\n  Total tokens     {}",
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens,
        usage.total_tokens()
    )
}

fn format_compact_report(removed: usize, resulting_messages: usize, skipped: bool) -> String {
    if skipped {
        format!(
            "Compact\n  Result           skipped\n  Reason           session below compaction threshold\n  Messages kept    {resulting_messages}"
        )
    } else {
        format!(
            "Compact\n  Result           compacted\n  Messages removed {removed}\n  Messages kept    {resulting_messages}"
        )
    }
}

fn render_config_report(section: Option<&str>) -> Result<String, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let loader = ConfigLoader::default_for(&cwd);
    let discovered = loader.discover();
    let runtime_config = loader.load().map_err(|e| e.to_string())?;

    let mut lines = vec![
        format!(
            "Config\n  Working directory {}\n  Loaded files      {}\n  Merged keys       {}",
            cwd.display(),
            runtime_config.loaded_entries().len(),
            runtime_config.merged().len()
        ),
        "Discovered files".to_string(),
    ];
    for entry in discovered {
        let source = match entry.source {
            ConfigSource::User => "user",
            ConfigSource::Project => "project",
            ConfigSource::Local => "local",
        };
        let status = if runtime_config
            .loaded_entries()
            .iter()
            .any(|loaded_entry| loaded_entry.path == entry.path)
        {
            "loaded"
        } else {
            "missing"
        };
        lines.push(format!(
            "  {source:<7} {status:<7} {}",
            entry.path.display()
        ));
    }

    if let Some(section) = section {
        lines.push(format!("Merged section: {section}"));
        let value = match section {
            "env" => runtime_config.get("env"),
            "hooks" => runtime_config.get("hooks"),
            "model" => runtime_config.get("model"),
            other => {
                lines.push(format!(
                    "  Unsupported config section '{other}'. Use env, hooks, or model."
                ));
                return Ok(lines.join("\n"));
            }
        };
        lines.push(format!(
            "  {}",
            value.map_or_else(|| "<unset>".to_string(), |value| value.render())
        ));
        return Ok(lines.join("\n"));
    }

    lines.push("Merged JSON".to_string());
    lines.push(format!("  {}", runtime_config.as_json().render()));
    Ok(lines.join("\n"))
}

fn render_memory_report() -> Result<String, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let hot = runtime::load_hot_memory(&cwd)?;
    let knowledge = runtime::load_knowledge_memory_catalog();
    let mut lines = vec![
        "Memory".to_string(),
        format!("  Working directory {}", cwd.display()),
        format!("  Project scope     {}", hot.project_scope),
        format!(
            "  Hot memory        memory={}/{} chars, user={}/{} chars",
            hot.memory_chars, hot.memory_limit, hot.user_chars, hot.user_limit
        ),
        format!("  Pending writes    {}", hot.pending_count),
        format!(
            "  Write approval    {}",
            runtime::memory_write_approval_enabled()
        ),
        format!("  Knowledge files   {}", knowledge.len()),
        "Hot entries".to_string(),
    ];
    for entry in hot.user.iter().chain(hot.memory.iter()) {
        lines.push(format!(
            "  [{}] {} scope={} source={} expires={}",
            entry.id,
            entry.content,
            entry.scope,
            entry.source,
            entry.expires_at.as_deref().unwrap_or("never")
        ));
    }
    if hot.user.is_empty() && hot.memory.is_empty() {
        lines.push("  No active hot-memory entries.".to_string());
    }
    lines.push("Knowledge catalog".to_string());
    for entry in knowledge {
        lines.push(format!(
            "  {} - {} ({})",
            entry.name,
            entry.description,
            entry.path.display()
        ));
    }
    Ok(lines.join("\n"))
}

fn handle_memory_command(action: Option<&str>, target: Option<&str>) -> Result<String, String> {
    match action {
        None | Some("show") => render_memory_report(),
        Some("pending") => {
            let scope = runtime::project_scope(
                &std::env::current_dir().map_err(|error| error.to_string())?,
            );
            serde_json::to_string_pretty(&runtime::list_pending_for_scope(&scope)?)
                .map_err(|error| error.to_string())
        }
        Some("approve") => {
            let id = target.ok_or_else(|| "Usage: /memory approve <id>".to_string())?;
            serde_json::to_string_pretty(&runtime::approve_pending(id)?)
                .map_err(|error| error.to_string())
        }
        Some("reject") => {
            let id = target.ok_or_else(|| "Usage: /memory reject <id>".to_string())?;
            runtime::reject_pending(id)?;
            Ok(format!("Rejected pending memory write {id}."))
        }
        Some("approval") => {
            let enabled = match target {
                Some("on") => true,
                Some("off") => false,
                _ => return Err("Usage: /memory approval on|off".to_string()),
            };
            crate::config::set_memory_write_approval(enabled)?;
            Ok(format!(
                "Memory write approval is now {}.",
                if enabled { "on" } else { "off" }
            ))
        }
        Some(other) => Err(format!(
            "Unknown /memory action `{other}`. Use show, pending, approve, reject, or approval."
        )),
    }
}

fn init_desktop_repo() -> Result<String, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let claude_dir = cwd.join(".claude");
    let claude_json = cwd.join(".claude.json");
    let gitignore = cwd.join(".gitignore");
    let claude_md = cwd.join("CLAUDE.md");
    let mut lines = vec![
        "Init".to_string(),
        format!("  Project          {}", cwd.display()),
    ];

    lines.push(format!("  {:<16} {}", ".claude/", ensure_dir(&claude_dir)?));
    lines.push(format!(
        "  {:<16} {}",
        ".claude.json",
        write_file_if_missing(
            &claude_json,
            "{\n  \"permissions\": {\n    \"defaultMode\": \"dontAsk\"\n  }\n}\n",
        )?
    ));
    lines.push(format!(
        "  {:<16} {}",
        ".gitignore",
        ensure_gitignore_entries(&gitignore)?
    ));
    lines.push(format!(
        "  {:<16} {}",
        "CLAUDE.md",
        write_file_if_missing(&claude_md, &render_desktop_claude_md(&cwd))?
    ));
    lines.push("  Next step        Review and tailor the generated guidance".to_string());
    Ok(lines.join("\n"))
}

fn ensure_dir(path: &Path) -> Result<&'static str, String> {
    if path.is_dir() {
        return Ok("skipped (already exists)");
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    Ok("created")
}

fn write_file_if_missing(path: &Path, content: &str) -> Result<&'static str, String> {
    if path.exists() {
        return Ok("skipped (already exists)");
    }
    fs::write(path, content).map_err(|e| e.to_string())?;
    Ok("created")
}

fn ensure_gitignore_entries(path: &Path) -> Result<&'static str, String> {
    const COMMENT: &str = "# ARIS-Code local artifacts";
    const ENTRIES: [&str; 2] = [".claude/settings.local.json", ".claude/sessions/"];
    if !path.exists() {
        let mut lines = vec![COMMENT.to_string()];
        lines.extend(ENTRIES.iter().map(|entry| (*entry).to_string()));
        fs::write(path, format!("{}\n", lines.join("\n"))).map_err(|e| e.to_string())?;
        return Ok("created");
    }
    let existing = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut lines = existing.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
    let mut changed = false;
    if !lines.iter().any(|line| line == COMMENT) {
        lines.push(COMMENT.to_string());
        changed = true;
    }
    for entry in ENTRIES {
        if !lines.iter().any(|line| line == entry) {
            lines.push(entry.to_string());
            changed = true;
        }
    }
    if !changed {
        return Ok("skipped (already exists)");
    }
    fs::write(path, format!("{}\n", lines.join("\n"))).map_err(|e| e.to_string())?;
    Ok("updated")
}

fn render_desktop_claude_md(cwd: &Path) -> String {
    let lines = vec![
        "# CLAUDE.md".to_string(),
        String::new(),
        "This file provides guidance to ARIS desktop Chat when working in this isolated workspace.".to_string(),
        String::new(),
        "## Workspace".to_string(),
        format!("- Desktop workspace: `{}`.", cwd.display()),
        "- Keep generated files and research artifacts inside this workspace unless the user explicitly attaches or references external context.".to_string(),
        String::new(),
        "## Verification".to_string(),
        "- Record the commands or checks used to validate substantial changes.".to_string(),
        "- Prefer focused tests or small reproducible checks before finalizing code edits.".to_string(),
        String::new(),
        "## Working agreement".to_string(),
        "- Prefer small, reviewable changes and explain meaningful tradeoffs.".to_string(),
        "- Do not overwrite existing guidance automatically; update it intentionally when workflows change.".to_string(),
        String::new(),
    ];
    lines.join("\n")
}

fn render_diff_report() -> Result<String, String> {
    let diff = git_output(&["diff", "--", ":(exclude).omx"])?;
    if diff.trim().is_empty() {
        return Ok(
            "Diff\n  Result           clean working tree\n  Detail           no current changes"
                .to_string(),
        );
    }
    Ok(format!("Diff\n\n{}", diff.trim_end()))
}

fn render_teleport_report(target: &str) -> Result<String, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let file_matches = crate::process::hidden_command("rg")
        .args(["--files"])
        .current_dir(&cwd)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|text| {
            text.lines()
                .filter(|line| line.contains(target))
                .take(10)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let content_matches = crate::process::hidden_command("rg")
        .args(["-n", "-S", "--color", "never", target, "."])
        .current_dir(&cwd)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .unwrap_or_default();

    let mut lines = vec![format!("Teleport\n  Target           {target}")];
    if !file_matches.is_empty() {
        lines.push(String::new());
        lines.push("File matches".to_string());
        lines.extend(file_matches.into_iter().map(|path| format!("  {path}")));
    }
    if !content_matches.trim().is_empty() {
        lines.push(String::new());
        lines.push("Content matches".to_string());
        lines.push(truncate_for_prompt(&content_matches, 4_000));
    }
    if lines.len() == 1 {
        lines.push("  Result           no matches found".to_string());
    }
    Ok(lines.join("\n"))
}

fn render_last_tool_debug_report(session: &Session) -> Result<String, String> {
    let last_tool_use = session
        .messages
        .iter()
        .rev()
        .find_map(|message| {
            message.blocks.iter().rev().find_map(|block| match block {
                ContentBlock::ToolUse { id, name, input } => {
                    Some((id.clone(), name.clone(), input.clone()))
                }
                _ => None,
            })
        })
        .ok_or_else(|| "no prior tool call found in session".to_string())?;

    let tool_result = session.messages.iter().rev().find_map(|message| {
        message.blocks.iter().rev().find_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id,
                tool_name,
                output,
                is_error,
            } if tool_use_id == &last_tool_use.0 => {
                Some((tool_name.clone(), output.clone(), *is_error))
            }
            _ => None,
        })
    });

    let mut lines = vec![
        "Debug tool call".to_string(),
        format!("  Tool id          {}", last_tool_use.0),
        format!("  Tool name        {}", last_tool_use.1),
        "  Input".to_string(),
        indent_block(&last_tool_use.2, 4),
    ];
    match tool_result {
        Some((tool_name, output, is_error)) => {
            lines.push("  Result".to_string());
            lines.push(format!("    name           {tool_name}"));
            lines.push(format!(
                "    status         {}",
                if is_error { "error" } else { "ok" }
            ));
            lines.push(indent_block(&output, 4));
        }
        None => lines.push("  Result           missing tool result".to_string()),
    }
    Ok(lines.join("\n"))
}

fn render_version_report() -> String {
    format!(
        "ARIS Desktop\n  Version          {}\n  Target           {}\n  Build date       {}",
        env!("CARGO_PKG_VERSION"),
        option_env!("TARGET").unwrap_or("unknown"),
        option_env!("ARIS_BUILD_DATE").unwrap_or("unknown")
    )
}

fn resolve_session_reference(reference: &str) -> Result<(String, PathBuf), String> {
    let direct = PathBuf::from(reference);
    let path = if direct.exists() {
        direct
    } else {
        crate::state::sessions_dir().join(format!("{reference}.json"))
    };
    if !path.exists() {
        return Err(format!("session not found: {reference}"));
    }
    let id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(reference)
        .to_string();
    Ok((id, path))
}

fn render_session_list(active_session_id: &str) -> Result<String, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(crate::state::sessions_dir()).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.ends_with(".json")
            || name.ends_with(".timeline.json")
            || name.ends_with(".json.tmp")
            || name == "chat-ui-sessions.json"
        {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or_default();
        let message_count = Session::load_from_path(&path)
            .map(|session| session.messages.len())
            .unwrap_or_default();
        let id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("session")
            .to_string();
        entries.push((modified, id, path, message_count));
    }
    entries.sort_by(|left, right| right.0.cmp(&left.0));
    let mut lines = vec![
        "Sessions".to_string(),
        format!(
            "  Directory         {}",
            crate::state::sessions_dir().display()
        ),
    ];
    if entries.is_empty() {
        lines.push("  No managed sessions saved yet.".to_string());
        return Ok(lines.join("\n"));
    }
    for (modified, id, path, message_count) in entries {
        let marker = if id == active_session_id {
            "current"
        } else {
            "saved"
        };
        lines.push(format!(
            "  {id:<28} {marker:<8} msgs={message_count:<4} modified={modified} path={}",
            path.display()
        ));
    }
    Ok(lines.join("\n"))
}

fn render_simple_timeline(id: &str, path: &Path, session: &Session) -> String {
    let mut lines = vec![
        "Session timeline".to_string(),
        format!("  Session          {id}"),
        format!("  File             {}", path.display()),
        format!("  Messages         {}", session.messages.len()),
        String::new(),
    ];
    for (index, message) in session.messages.iter().enumerate().rev().take(24).rev() {
        let role = match message.role {
            MessageRole::System => "system",
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
        };
        let preview = message
            .blocks
            .iter()
            .find_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                ContentBlock::Image { media_type, .. } => Some(media_type.as_str()),
                ContentBlock::ToolUse { name, .. } => Some(name.as_str()),
                ContentBlock::ToolResult { tool_name, .. } => Some(tool_name.as_str()),
                ContentBlock::Thinking { thinking, .. } => Some(thinking.as_str()),
            })
            .unwrap_or("");
        lines.push(format!(
            "  {:>3}. {:<9} {}",
            index + 1,
            role,
            truncate_for_prompt(preview, 120).replace('\n', " ")
        ));
    }
    lines.join("\n")
}

fn resolve_export_path(requested_path: Option<&str>, session: &Session) -> Result<PathBuf, String> {
    if let Some(path) = requested_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        return Ok(PathBuf::from(path));
    }
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    Ok(crate::state::runtime_dir().join(format!(
        "conversation-export-{}-{millis}.md",
        session.messages.len()
    )))
}

fn render_export_text(session: &Session) -> String {
    let mut lines = vec!["# Conversation Export".to_string(), String::new()];
    for (index, message) in session.messages.iter().enumerate() {
        let role = match message.role {
            MessageRole::System => "system",
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
        };
        lines.push(format!("## {}. {role}", index + 1));
        for block in &message.blocks {
            match block {
                ContentBlock::Text { text } => lines.push(text.clone()),
                ContentBlock::Image { media_type, data } => {
                    lines.push(format!(
                        "[image media_type={media_type} bytes={}]",
                        data.len()
                    ));
                }
                ContentBlock::ToolUse { id, name, input } => {
                    lines.push(format!("[tool_use id={id} name={name}] {input}"));
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    tool_name,
                    output,
                    is_error,
                } => lines.push(format!(
                    "[tool_result id={tool_use_id} name={tool_name} error={is_error}] {output}"
                )),
                ContentBlock::Thinking { thinking, .. } => {
                    lines.push(format!("[thinking] {thinking}"));
                }
            }
        }
        lines.push(String::new());
    }
    lines.join("\n")
}

fn git_output(args: &[&str]) -> Result<String, String> {
    let output = crate::process::hidden_command("git")
        .args(args)
        .current_dir(std::env::current_dir().map_err(|e| e.to_string())?)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git {} failed: {stderr}", args.join(" ")));
    }
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

fn recent_user_context(session: &Session, limit: usize) -> String {
    let requests = session
        .messages
        .iter()
        .filter(|message| message.role == MessageRole::User)
        .filter_map(|message| {
            message.blocks.iter().find_map(|block| match block {
                ContentBlock::Text { text } => Some(text.trim().to_string()),
                _ => None,
            })
        })
        .rev()
        .take(limit)
        .collect::<Vec<_>>();

    if requests.is_empty() {
        "<no prior user messages>".to_string()
    } else {
        requests
            .into_iter()
            .rev()
            .enumerate()
            .map(|(index, text)| format!("{}. {}", index + 1, text))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn truncate_for_prompt(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        value.trim().to_string()
    } else {
        let truncated = value.chars().take(limit).collect::<String>();
        format!("{}\n...[truncated]", truncated.trim_end())
    }
}

fn indent_block(value: &str, spaces: usize) -> String {
    let indent = " ".repeat(spaces);
    value
        .lines()
        .map(|line| format!("{indent}{line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rich_chat_request_maps_data_url_to_image_block() {
        let message = user_message_from_request(ChatSendRequest {
            text: "look".to_string(),
            images: vec![ChatImageInput {
                name: Some("shot.png".to_string()),
                mime_type: "image/png".to_string(),
                data: "data:image/png;base64,ZmFrZQ==".to_string(),
            }],
        })
        .expect("rich request should parse");

        assert!(matches!(
            &message.blocks[0],
            ContentBlock::Text { text } if text == "look"
        ));
        assert!(matches!(
            &message.blocks[1],
            ContentBlock::Image { media_type, data }
                if media_type == "image/png" && data == "ZmFrZQ=="
        ));
    }

    #[test]
    fn rich_chat_request_rejects_non_image_media_type() {
        let error = user_message_from_request(ChatSendRequest {
            text: String::new(),
            images: vec![ChatImageInput {
                name: Some("note.txt".to_string()),
                mime_type: "text/plain".to_string(),
                data: "ZmFrZQ==".to_string(),
            }],
        })
        .expect_err("non-image upload should be rejected");

        assert!(error.contains("unsupported media type"));
    }

    #[test]
    fn skill_prompt_routes_named_skill_to_skill_tool() {
        let prompt = skill_prompt("research-lit", "reservoir computing");

        assert!(prompt.contains("Use the Skill tool"));
        assert!(prompt.contains("\"research-lit\""));
        assert!(prompt.contains("reservoir computing"));
    }

    #[test]
    fn skills_command_lists_bundled_skills() {
        let result = handle_skills_command(Some("list"), None).expect("skills list");

        assert!(result.handled);
        let message = result.message.expect("message");
        assert!(message.contains("Available skills"));
        assert!(message.contains("/research-lit"));
    }

    #[test]
    fn skills_command_shows_bundled_skill_markdown() {
        let result =
            handle_skills_command(Some("show"), Some("research-lit")).expect("skills show");

        assert!(result.handled);
        let message = result.message.expect("message");
        assert!(message.contains("/research-lit"));
        assert!(message.contains("# Research Literature Review"));
    }

    #[test]
    fn generated_chat_title_is_cleaned_for_sidebar() {
        let title = clean_generated_title("标题：\"贝叶斯估计写作计划。\"\n\nextra");

        assert_eq!(title, "贝叶斯估计写作计划");
    }

    #[test]
    fn desktop_chat_exposes_tools_and_lets_permission_mode_gate_them() {
        let specs = tool_specs_for(DESKTOP_CHAT_BLOCKED_TOOLS);
        assert!(specs.iter().any(|spec| spec.name == "bash"));
        assert!(specs.iter().any(|spec| spec.name == "Agent"));
        assert!(specs.iter().any(|spec| spec.name == "Workflow"));

        let workspace = desktop_permission_policy(&specs, PermissionMode::WorkspaceWrite);
        assert!(matches!(
            workspace.authorize("bash", r#"{"command":"echo hi"}"#, None),
            runtime::PermissionOutcome::Deny { .. }
        ));

        let unrestricted = desktop_permission_policy(&specs, PermissionMode::DangerFullAccess);
        assert_eq!(
            unrestricted.authorize("bash", r#"{"command":"echo hi"}"#, None),
            runtime::PermissionOutcome::Allow
        );
    }

    #[test]
    fn desktop_permission_aliases_match_claude_code_settings() {
        assert_eq!(
            normalize_permission_mode("plan"),
            Some(PermissionMode::ReadOnly)
        );
        assert_eq!(
            normalize_permission_mode("acceptEdits"),
            Some(PermissionMode::WorkspaceWrite)
        );
        assert_eq!(
            normalize_permission_mode("dontAsk"),
            Some(PermissionMode::DangerFullAccess)
        );
    }

    #[test]
    fn desktop_prompt_requests_links_for_generated_files() {
        let prompt = build_system_prompt_inner("test-model", true).join("\n");

        assert!(prompt.contains("complete tool registry"));
        assert!(prompt.contains("include Markdown links"));
    }

    #[test]
    fn desktop_prompt_reports_loaded_mcp_tools_and_failures() {
        let tools = vec![aris_chat::ChatToolSpec {
            name: "mcp__playwright__browser_navigate".to_string(),
            description: "navigate".to_string(),
            input_schema: serde_json::json!({"type": "object"}),
            required_permission: PermissionMode::DangerFullAccess,
        }];
        let loaded = mcp_runtime_status_prompt(1, &tools, &[]).expect("status");
        assert!(loaded.contains("mcp__playwright__browser_navigate"));
        assert!(loaded.contains("ToolSearch includes"));

        let failed = mcp_runtime_status_prompt(
            1,
            &[],
            &["could not discover MCP server `playwright`: failed".to_string()],
        )
        .expect("failure status");
        assert!(failed.contains("No MCP tools were loaded"));
        assert!(failed.contains("could not discover MCP server `playwright`"));
    }

    #[test]
    fn chat_session_cache_stays_bounded() {
        let state = ChatState::default();
        for index in 0..20 {
            cache_chat_session(&state, format!("session-{index}"), Session::new())
                .expect("cache session");
        }
        let sessions = state.sessions.lock().expect("chat state");
        assert_eq!(sessions.len(), MAX_CACHED_CHAT_SESSIONS);
        assert!(sessions.contains_key("session-19"));
    }
}
