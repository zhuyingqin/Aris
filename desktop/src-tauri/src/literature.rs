//! Desktop commands for the literature library — thin wrappers over the
//! shared kernel implementation in `tools::literature`, so the desktop UI,
//! CLI agents, and the literature skills (`/arxiv`, `/research-lit`) all
//! operate on the same `papers/library.json` contract.
//!
//! `literature_llm` is the one exception: a one-shot, tool-free completion on
//! the user's configured chat executor, so screening and Brief generation can
//! use a real model instead of the offline keyword heuristic.

use serde_json::{json, Value};
use tauri::State;

use runtime::{
    ConversationMessage, PermissionMode, RuntimeError, RuntimeFeatureConfig, Session, ToolError,
    ToolExecutor,
};

use crate::projects::{self, ProjectState};

fn project_base(projects_state: &ProjectState) -> Result<std::path::PathBuf, String> {
    projects::current_project_path(projects_state)
}

const MAX_PDF_TEXT_CHARS: usize = 16_000;

/// One-shot LLM completion on the configured executor — no tools, no
/// streaming, no session persistence. Returns the assistant's text (callers
/// ask for JSON and parse it). Errors when no executor is configured, which
/// the frontend treats as "fall back to the heuristic".
#[tauri::command]
pub async fn literature_llm(system: String, prompt: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_oneshot(&system, prompt))
        .await
        .map_err(|e| e.to_string())?
}

struct SilentObserver;
impl aris_executor::StreamObserver for SilentObserver {
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

struct NoTools;
impl ToolExecutor for NoTools {
    fn execute(&mut self, tool_name: &str, _input: &str) -> Result<String, ToolError> {
        Err(ToolError::new(format!(
            "tool `{tool_name}` is not available during literature LLM calls"
        )))
    }
}

fn run_oneshot(system: &str, prompt: String) -> Result<String, String> {
    let config = crate::config::load_object();
    let (model, _provider, executor_config) =
        aris_chat::resolve_settings_executor_config(&config)?;
    runtime::clear_interrupt();
    let observer: Box<dyn aris_executor::StreamObserver> = Box::new(SilentObserver);
    let mut conversation = aris_chat::build_conversation_runtime(
        Session::new(),
        executor_config,
        model,
        false,
        Vec::new(),
        observer,
        NoTools,
        aris_chat::permission_policy_for_tools(Vec::new(), PermissionMode::ReadOnly),
        vec![system.to_string()],
        RuntimeFeatureConfig::default(),
    )?;
    let summary = conversation
        .run_turn_message(ConversationMessage::user_text(prompt), None)
        .map_err(|e| e.to_string())?;
    Ok(aris_chat::final_assistant_text(&summary))
}

/// Extract readable text from a downloaded PDF so the Brief can read the full
/// paper, not just the abstract. Path is project-relative (e.g.
/// `papers/2602.01491.pdf`); output is capped so prompts stay bounded.
#[tauri::command]
pub fn literature_pdf_text(
    projects_state: State<ProjectState>,
    relative_path: String,
) -> Result<String, String> {
    if relative_path.contains("..") {
        return Err("invalid pdf path".to_string());
    }
    let base = project_base(&projects_state)?;
    let path = base.join(&relative_path);
    let raw = tools::execute_tool(
        "read_file",
        &json!({ "path": path.to_string_lossy(), "limit": 600 }),
    )?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let text = value["file"]["content"].as_str().unwrap_or("").trim();
    if text.is_empty() {
        return Err("no extractable text in the PDF".to_string());
    }
    Ok(text.chars().take(MAX_PDF_TEXT_CHARS).collect())
}

#[tauri::command]
pub fn literature_load(projects_state: State<ProjectState>) -> Result<Value, String> {
    tools::literature::library_load_at(&project_base(&projects_state)?)
}

#[tauri::command]
pub fn literature_save(projects_state: State<ProjectState>, library: Value) -> Result<(), String> {
    tools::literature::library_save_at(&project_base(&projects_state)?, &library)
}

#[tauri::command]
pub async fn literature_search(
    query: String,
    sources: Vec<String>,
    max_results: Option<usize>,
) -> Result<Value, String> {
    let limit = max_results.unwrap_or(20).clamp(1, 50);
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = tools::literature::search_remote(&query, &sources, limit)?;
        Ok(json!({
            "papers": outcome.papers,
            "warnings": outcome.warnings,
            "sourceCounts": outcome.source_counts,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn literature_download_pdf(
    projects_state: State<'_, ProjectState>,
    url: String,
    file_name: String,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    tauri::async_runtime::spawn_blocking(move || {
        tools::literature::download_pdf_at(&base, &url, &file_name, None)
    })
    .await
    .map_err(|e| e.to_string())?
}
