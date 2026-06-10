//! Desktop commands for the literature library — thin wrappers over the
//! shared kernel implementation in `tools::literature`, so the desktop UI,
//! CLI agents, and the literature skills (`/arxiv`, `/research-lit`) all
//! operate on the same `papers/library.json` contract.

use serde_json::{json, Value};
use tauri::State;

use crate::projects::{self, ProjectState};

fn project_base(projects_state: &ProjectState) -> Result<std::path::PathBuf, String> {
    projects::current_project_path(projects_state)
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
