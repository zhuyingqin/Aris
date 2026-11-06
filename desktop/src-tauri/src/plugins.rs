//! Native commands delegate to the same project capability store as chat/CLI.
use std::path::Path;

use runtime::plugins::{
    ActiveUiPanel, InstalledPlugin, PluginPreview, PluginStore, UiAction, UiPanelState,
};
use tauri::State;

use crate::blocking::off_main_thread;
use crate::projects::{current_project_path, ProjectState};

pub(crate) fn bound_store(workspace: &Path, project_path: &str) -> Result<PluginStore, String> {
    let workspace = runtime::canonicalize(workspace).map_err(|e| e.to_string())?;
    let requested = runtime::canonicalize(project_path).map_err(|e| e.to_string())?;
    if workspace != requested {
        return Err("Project changed; reload the plugin panel before continuing".into());
    }
    Ok(PluginStore::for_workspace(workspace))
}

#[tauri::command]
pub async fn plugins_list(
    projects: State<'_, ProjectState>,
    project_path: String,
) -> Result<Vec<InstalledPlugin>, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.list()).await
}

#[tauri::command]
pub async fn plugins_preview(
    projects: State<'_, ProjectState>,
    project_path: String,
    source: String,
) -> Result<PluginPreview, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.preview(source)).await
}

#[tauri::command]
pub async fn plugins_install(
    projects: State<'_, ProjectState>,
    project_path: String,
    source: String,
    expected_digest: String,
) -> Result<InstalledPlugin, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.install(source, &expected_digest)).await
}

#[tauri::command]
pub async fn plugins_set_enabled(
    projects: State<'_, ProjectState>,
    project_path: String,
    name: String,
    enabled: bool,
) -> Result<InstalledPlugin, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.set_enabled(&name, enabled)).await
}

#[tauri::command]
pub async fn plugins_remove(
    projects: State<'_, ProjectState>,
    project_path: String,
    name: String,
) -> Result<(), String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.remove(&name)).await
}

#[tauri::command]
pub async fn plugins_ui_list(
    projects: State<'_, ProjectState>,
    project_path: String,
) -> Result<Vec<ActiveUiPanel>, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.active_ui_panels()).await
}

#[tauri::command]
pub async fn plugins_ui_state_get(
    projects: State<'_, ProjectState>,
    project_path: String,
    name: String,
    panel_id: String,
    session_id: String,
) -> Result<UiPanelState, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.ui_state_get(&name, &panel_id, &session_id)).await
}

#[tauri::command]
pub async fn plugins_ui_state_update(
    projects: State<'_, ProjectState>,
    project_path: String,
    name: String,
    panel_id: String,
    session_id: String,
    expected_revision: u64,
    action: UiAction,
) -> Result<UiPanelState, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || {
        store.ui_state_update(&name, &panel_id, &session_id, expected_revision, action)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_commands_refuse_a_stale_project_binding() {
        let temp = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        assert!(bound_store(temp.path(), other.path().to_str().unwrap()).is_err());
        assert!(bound_store(temp.path(), temp.path().to_str().unwrap()).is_ok());
    }
}
