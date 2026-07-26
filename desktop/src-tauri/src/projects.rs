use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::state;

const PROJECTS_FILE: &str = "projects.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub added_at: u64,
    pub last_opened_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRegistry {
    projects: Vec<DesktopProject>,
    current_project_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    projects: Vec<DesktopProject>,
    current_project: DesktopProject,
}

pub struct ProjectState {
    registry: Mutex<ProjectRegistry>,
}

impl Default for ProjectState {
    fn default() -> Self {
        Self {
            registry: Mutex::new(default_registry()),
        }
    }
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn default_project() -> DesktopProject {
    let path = state::default_workspace_dir();
    DesktopProject {
        id: "default".to_string(),
        name: "SomniQ Desktop Workspace".to_string(),
        path: path.to_string_lossy().into_owned(),
        added_at: 0,
        last_opened_at: 0,
    }
}

fn default_registry() -> ProjectRegistry {
    ProjectRegistry {
        projects: vec![default_project()],
        current_project_id: "default".to_string(),
    }
}

fn registry_path() -> PathBuf {
    state::desktop_runtime_dir().join(PROJECTS_FILE)
}

fn normalize_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn clean_canonical_path(path: PathBuf) -> PathBuf {
    if !cfg!(windows) {
        return path;
    }
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    // Volume-GUID paths (`\\?\Volume{guid}\...`) are only valid *with* the
    // extended-length prefix; stripping it yields an unusable path, so keep them
    // intact rather than mangling them.
    if value.starts_with(r"\\?\Volume{") {
        return path;
    }
    value
        .strip_prefix(r"\\?\")
        .map(PathBuf::from)
        .unwrap_or(path)
}

fn project_id(path: &Path) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in normalize_path(path).bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("project-{hash:016x}")
}

fn project_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Project")
        .to_string()
}

fn load_registry() -> ProjectRegistry {
    let Ok(raw) = std::fs::read_to_string(registry_path()) else {
        return default_registry();
    };
    let Ok(mut registry) = serde_json::from_str::<ProjectRegistry>(&raw) else {
        return default_registry();
    };
    let default = default_project();
    if !registry
        .projects
        .iter()
        .any(|project| project.id == default.id)
    {
        registry.projects.push(default);
    }
    let mut seen = HashSet::new();
    registry.projects.retain(|project| {
        // Beyond the id *format* check, require that a non-default project's id
        // actually hashes from its stored path. This drops hand-forged entries
        // (e.g. a manually written `project-aabbccddeeff0011`) that would
        // otherwise alias another project's runtime directory.
        state::valid_project_id(&project.id)
            && (project.id == "default"
                || (Path::new(&project.path).is_dir()
                    && project.id == project_id(Path::new(&project.path))))
            && seen.insert(normalize_path(Path::new(&project.path)))
    });
    if !registry
        .projects
        .iter()
        .any(|project| project.id == registry.current_project_id)
    {
        registry.current_project_id = "default".to_string();
    }
    registry
}

fn save_registry(registry: &ProjectRegistry) -> Result<(), String> {
    let path = registry_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let data = serde_json::to_vec_pretty(registry).map_err(|error| error.to_string())?;
    runtime::write_file_atomically(&path, data).map_err(|error| error.to_string())
}

fn current_project(registry: &ProjectRegistry) -> Result<DesktopProject, String> {
    registry
        .projects
        .iter()
        .find(|project| project.id == registry.current_project_id)
        .cloned()
        .ok_or_else(|| "current desktop project is missing".to_string())
}

fn view(registry: &ProjectRegistry) -> Result<ProjectView, String> {
    Ok(ProjectView {
        projects: registry.projects.clone(),
        current_project: current_project(registry)?,
    })
}

fn activate(registry: &mut ProjectRegistry, id: &str) -> Result<(), String> {
    let (project_id, path) = {
        let project = registry
            .projects
            .iter()
            .find(|project| project.id == id)
            .ok_or_else(|| "project not found".to_string())?;
        (project.id.clone(), PathBuf::from(&project.path))
    };
    // The default workspace is created on first launch by apply_project_environment.
    // User-added projects must already exist — if they've been deleted, return an error.
    if project_id != "default" && !path.is_dir() {
        return Err(format!(
            "project directory does not exist: {}",
            path.display()
        ));
    }
    let _env_guard = crate::engine::project_env_lock()
        .lock()
        .map_err(|_| "project environment lock poisoned".to_string())?;
    state::apply_project_environment(&path, &project_id).map_err(|error| error.to_string())?;
    aris_chat::clear_mcp_discovery_cache();
    registry.current_project_id = project_id;
    save_registry(registry)
}

fn reorder_registry(registry: &mut ProjectRegistry, project_ids: &[String]) -> Result<(), String> {
    if project_ids.len() != registry.projects.len() {
        return Err("project reorder must include every project exactly once".to_string());
    }

    let known: HashSet<&str> = registry
        .projects
        .iter()
        .map(|project| project.id.as_str())
        .collect();
    let mut seen = HashSet::new();
    for id in project_ids {
        if !known.contains(id.as_str()) {
            return Err(format!("unknown project id: {id}"));
        }
        if !seen.insert(id.as_str()) {
            return Err(format!("duplicate project id: {id}"));
        }
    }

    let mut by_id: HashMap<String, DesktopProject> = registry
        .projects
        .drain(..)
        .map(|project| (project.id.clone(), project))
        .collect();
    registry.projects = project_ids
        .iter()
        .map(|id| {
            by_id
                .remove(id)
                .expect("project ids were validated before reorder")
        })
        .collect();
    Ok(())
}

fn ensure_switch_allowed(chat_state: &crate::engine::ChatState) -> Result<(), String> {
    let _env_guard = crate::engine::project_env_lock()
        .lock()
        .map_err(|_| "project environment lock poisoned".to_string())?;
    if crate::engine::remote_chat_has_running_turns(chat_state)? {
        return Err("stop or finish the active chat turn before switching projects".to_string());
    }
    Ok(())
}

/// Absolute path of the active project — the root the literature library
/// (`papers/`) lives under.
pub fn current_project_path(projects: &ProjectState) -> Result<PathBuf, String> {
    let registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    current_project(&registry).map(|project| PathBuf::from(project.path))
}

/// Stable identifier of the currently active project.
///
/// Desktop remote control is intentionally limited to this project.  Keeping
/// the lookup here avoids exposing the full registry internals to another
/// module and lets the remote layer reject a stale request after a project
/// switch.
pub(crate) fn active_project_id(projects: &ProjectState) -> Result<String, String> {
    let registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    current_project(&registry).map(|project| project.id)
}

/// Return the desktop-owned project registry without exposing it to a remote
/// client directly. The remote boundary converts this to a path-free summary.
pub(crate) fn registered_projects(
    projects: &ProjectState,
) -> Result<(Vec<DesktopProject>, String), String> {
    let registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    Ok((
        registry.projects.clone(),
        registry.current_project_id.clone(),
    ))
}

/// Switch an already registered project for the constrained remote boundary.
/// Paths are never accepted from the phone, and the normal active-workflow
/// guard remains in effect.
pub(crate) fn switch_registered_project(
    projects: &ProjectState,
    id: &str,
    chat_state: &crate::engine::ChatState,
) -> Result<DesktopProject, String> {
    ensure_switch_allowed(chat_state)?;
    let mut registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    activate(&mut registry, id)?;
    current_project(&registry)
}

fn notify_project_changed(app: &AppHandle) {
    if let Err(error) = app.emit("project-changed", ()) {
        eprintln!("SomniQ desktop: could not notify project change: {error}");
    }
}

pub fn init(projects: &ProjectState) -> Result<(), String> {
    let mut registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    *registry = load_registry();
    let current_id = registry.current_project_id.clone();
    activate(&mut registry, &current_id)
}

#[tauri::command]
pub fn projects_get(projects: State<ProjectState>) -> Result<ProjectView, String> {
    let registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    view(&registry)
}

#[tauri::command]
pub fn project_add(
    projects: State<ProjectState>,
    chat_state: State<crate::engine::ChatState>,
    path: String,
) -> Result<ProjectView, String> {
    ensure_switch_allowed(chat_state.inner())?;
    let canonical = clean_canonical_path(
        std::fs::canonicalize(path.trim()).map_err(|error| error.to_string())?,
    );
    if !canonical.is_dir() {
        return Err("project path must be a directory".to_string());
    }
    let normalized = normalize_path(&canonical);
    let mut registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    let id = if let Some(existing) = registry
        .projects
        .iter()
        .find(|project| normalize_path(Path::new(&project.path)) == normalized)
    {
        existing.id.clone()
    } else {
        let id = project_id(&canonical);
        registry.projects.push(DesktopProject {
            id: id.clone(),
            name: project_name(&canonical),
            path: canonical.to_string_lossy().into_owned(),
            added_at: now_epoch_secs(),
            last_opened_at: 0,
        });
        id
    };
    activate(&mut registry, &id)?;
    view(&registry)
}

#[tauri::command]
pub fn project_set_current(
    app: AppHandle,
    projects: State<ProjectState>,
    chat_state: State<crate::engine::ChatState>,
    id: String,
) -> Result<ProjectView, String> {
    ensure_switch_allowed(chat_state.inner())?;
    let mut registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    activate(&mut registry, &id)?;
    let result = view(&registry)?;
    notify_project_changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn projects_reorder(
    projects: State<ProjectState>,
    project_ids: Vec<String>,
) -> Result<ProjectView, String> {
    let mut registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    reorder_registry(&mut registry, &project_ids)?;
    save_registry(&registry)?;
    view(&registry)
}

#[cfg(test)]
#[path = "tests/projects.rs"]
mod tests;
