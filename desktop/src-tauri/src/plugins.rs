//! Native commands delegate to the same project capability store as chat/CLI.
use std::path::Path;

use runtime::plugins::{
    ActiveUiPanel, InstalledPlugin, PluginImportPreview, PluginStore, UiAction, UiPanelState,
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

/// The package at `source`, and the upgrade it would be when its name is
/// already installed here.
#[tauri::command]
pub async fn plugins_preview(
    projects: State<'_, ProjectState>,
    project_path: String,
    source: String,
) -> Result<PluginImportPreview, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.preview_import(source)).await
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

/// Replace the installed version with the previewed one, as one transaction.
#[tauri::command]
pub async fn plugins_upgrade(
    projects: State<'_, ProjectState>,
    project_path: String,
    source: String,
    expected_digest: String,
    expected_current_digest: String,
    approve: bool,
) -> Result<InstalledPlugin, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || {
        store.upgrade(source, &expected_digest, &expected_current_digest, approve)
    })
    .await
}

/// Connect to an approved package's MCP servers now, the same discovery a
/// Chat turn runs, so its card shows their real health.
#[tauri::command]
pub async fn plugins_check_mcp(
    projects: State<'_, ProjectState>,
    project_path: String,
    name: String,
) -> Result<InstalledPlugin, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    check_mcp(store, name).await
}

/// Shared by the Tauri command and the devserver route.
pub(crate) async fn check_mcp(store: PluginStore, name: String) -> Result<InstalledPlugin, String> {
    let store = std::sync::Arc::new(store);
    let servers = {
        let (store, name) = (store.clone(), name.clone());
        off_main_thread(move || store.package_mcp_servers(&name)).await?
    };
    if servers.is_empty() {
        return Err("This package has no approved MCP servers to check; enable it first".into());
    }
    let mut manager = runtime::McpServerManager::from_servers(&servers);
    // The manager records each server's outcome for the plugin page.
    let _ = manager
        .discover_tools_resilient_with_timeout(std::time::Duration::from_secs(45))
        .await;
    let _ = manager.shutdown().await;
    // A cached failure from an earlier turn would otherwise outlive the fix.
    aris_chat::clear_mcp_discovery_cache();
    off_main_thread(move || {
        store
            .list()?
            .into_iter()
            .find(|plugin| plugin.package.name == name)
            .ok_or_else(|| "Plugin is not installed".to_string())
    })
    .await
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
