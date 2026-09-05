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

/// Stable id for a workspace path.  Also used by the devserver so a run it
/// drives lands in the same per-project session directory the app would use.
pub(crate) fn project_id(path: &Path) -> String {
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

fn read_registry(path: &Path) -> Option<ProjectRegistry> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<ProjectRegistry>(&raw).ok()
}

fn legacy_registry_path() -> Option<PathBuf> {
    state::legacy_config_dir().map(|path| path.join("desktop-runtime").join(PROJECTS_FILE))
}

fn project_scoped_registry_paths() -> Vec<PathBuf> {
    let root = state::desktop_runtime_dir().join("projects");
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            let project_id = entry.file_name();
            let project_id = project_id.to_str()?;
            if project_id == "default" || !state::valid_project_id(project_id) {
                return None;
            }
            let path = entry.path().join(PROJECTS_FILE);
            path.is_file().then_some(path)
        })
        .collect()
}

fn usable_project_record(project: &DesktopProject) -> bool {
    !project.path.trim().is_empty()
        && state::valid_project_id(&project.id)
        && (project.id == "default" || project.id == project_id(Path::new(&project.path)))
}

fn import_registry_projects(registry: &mut ProjectRegistry, source: &ProjectRegistry) -> bool {
    let mut known_ids: HashSet<String> = registry
        .projects
        .iter()
        .map(|project| project.id.clone())
        .collect();
    let mut known_paths: HashSet<String> = registry
        .projects
        .iter()
        .map(|project| normalize_path(Path::new(&project.path)))
        .collect();
    let mut imported = false;

    for project in &source.projects {
        if project.id == "default"
            || !usable_project_record(project)
            || !known_ids.insert(project.id.clone())
            || !known_paths.insert(normalize_path(Path::new(&project.path)))
        {
            continue;
        }
        registry.projects.push(project.clone());
        imported = true;
    }

    imported
}

/// Recover named projects when a config-root rename left the new registry
/// with only its default entry. The old registry is treated as a source of
/// metadata only: paths are revalidated against the stable ID before they are
/// imported, and the old default entry never replaces the new default.
fn merge_legacy_projects(registry: &mut ProjectRegistry, legacy: &ProjectRegistry) -> bool {
    if registry
        .projects
        .iter()
        .any(|project| project.id != "default")
    {
        return false;
    }

    let imported = import_registry_projects(registry, legacy);

    if imported
        && legacy.current_project_id != "default"
        && registry
            .projects
            .iter()
            .any(|project| project.id == legacy.current_project_id)
    {
        registry.current_project_id = legacy.current_project_id.clone();
    }
    imported
}

fn fallback_missing_current_project(registry: &mut ProjectRegistry) {
    let current_project_is_missing = registry
        .projects
        .iter()
        .find(|project| project.id == registry.current_project_id)
        .is_some_and(|project| project.id != "default" && !Path::new(&project.path).is_dir());
    if current_project_is_missing {
        registry.current_project_id = "default".to_string();
    }
}

fn load_registry() -> ProjectRegistry {
    let mut registry = read_registry(&registry_path()).unwrap_or_else(default_registry);
    if registry
        .projects
        .iter()
        .all(|project| project.id == "default")
    {
        if let Some(legacy_path) = legacy_registry_path() {
            if let Some(legacy) = read_registry(&legacy_path) {
                merge_legacy_projects(&mut registry, &legacy);
            }
        }
        for path in project_scoped_registry_paths() {
            if let Some(source) = read_registry(&path) {
                import_registry_projects(&mut registry, &source);
            }
        }
    }
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
        // actually hashes from its stored path. Keep a missing directory in
        // the registry so a temporary offline drive does not silently turn a
        // project into "project not found"; activation reports the real path
        // error instead.
        usable_project_record(project) && seen.insert(normalize_path(Path::new(&project.path)))
    });
    // Keep an offline project in the registry for when its drive returns, but
    // do not make application startup depend on that drive being mounted.
    fallback_missing_current_project(&mut registry);
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
    // A unit test that reaches this function writes the developer's *real*
    // registry, which is how a fixture registry once replaced a live project
    // list. Tests must repoint the config root first; fail loudly instead.
    #[cfg(test)]
    assert!(
        std::env::var_os("ARIS_CONFIG_ROOT").is_some(),
        "a test tried to write the real project registry: set ARIS_CONFIG_ROOT \
         to a temporary directory, or keep the code under test free of \
         persistence side effects",
    );
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

fn activate_with_environment_lock(registry: &mut ProjectRegistry, id: &str) -> Result<(), String> {
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
    state::apply_project_environment(&path, &project_id).map_err(|error| error.to_string())?;
    aris_chat::clear_mcp_discovery_cache();
    registry.current_project_id = project_id.clone();
    save_registry(registry)?;
    spawn_session_index_repair(&project_id);
    Ok(())
}

/// Projects whose projection repair is already in flight. A status surface that
/// polls while a rebuild runs must not queue a second pass over the same
/// SQLite file, and the runtime's own progress slot only fills once the thread
/// has actually started.
static REPAIRING_PROJECTS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Reconcile a project's Session projection off the UI thread. This is the only
/// place a full rebuild is started: read paths report a stale projection rather
/// than paying for the rebuild themselves.
pub(crate) fn spawn_session_index_repair(project_id: &str) {
    match REPAIRING_PROJECTS.lock() {
        Ok(mut repairing) => {
            if !repairing
                .get_or_insert_with(HashSet::new)
                .insert(project_id.to_string())
            {
                return;
            }
        }
        Err(_) => return,
    }
    let sessions_dir = state::sessions_dir_for_project(project_id);
    let owned_project_id = project_id.to_string();
    let spawned = std::thread::Builder::new()
        .name("somniq-session-index-repair".to_string())
        .spawn(move || {
            if let Err(error) = runtime::sync_sessions_dir(&sessions_dir) {
                eprintln!("SomniQ background Session index repair skipped: {error}");
            }
            release_session_index_repair(&owned_project_id);
        });
    if let Err(error) = spawned {
        eprintln!("SomniQ background Session index repair could not start: {error}");
        release_session_index_repair(project_id);
    }
}

fn release_session_index_repair(project_id: &str) {
    if let Ok(mut repairing) = REPAIRING_PROJECTS.lock() {
        if let Some(repairing) = repairing.as_mut() {
            repairing.remove(project_id);
        }
    }
}

fn activate(registry: &mut ProjectRegistry, id: &str) -> Result<(), String> {
    let _env_guard = crate::engine::project_env_lock()
        .lock()
        .map_err(|_| "project environment lock poisoned".to_string())?;
    activate_with_environment_lock(registry, id)
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

/// Absolute path of the active project — the root the literature library
/// (`papers/`) lives under.
pub fn current_project_path(projects: &ProjectState) -> Result<PathBuf, String> {
    let registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    current_project(&registry).map(|project| PathBuf::from(project.path))
}

/// Resolve a registered project's workspace without changing the active
/// project. Long-running chat turns use this immutable binding so they can
/// continue safely after the user changes the project shown in the desktop.
pub(crate) fn project_path_for_id(projects: &ProjectState, id: &str) -> Result<PathBuf, String> {
    let registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    registry
        .projects
        .iter()
        .find(|project| project.id == id)
        .map(|project| PathBuf::from(&project.path))
        .ok_or_else(|| "project not found".to_string())
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
pub(crate) async fn switch_registered_project(
    projects: &ProjectState,
    id: &str,
    chat_state: &crate::engine::ChatState,
) -> Result<DesktopProject, String> {
    let _switch_permit = crate::engine::begin_project_switch(chat_state).await?;
    crate::engine::with_project_switch_guard(chat_state, || {
        let mut registry = projects
            .registry
            .lock()
            .map_err(|_| "project state poisoned".to_string())?;
        activate_with_environment_lock(&mut registry, id)?;
        current_project(&registry)
    })
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
pub fn projects_get(projects: State<'_, ProjectState>) -> Result<ProjectView, String> {
    let registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    view(&registry)
}

#[tauri::command]
pub async fn project_add(
    projects: State<'_, ProjectState>,
    chat_state: State<'_, crate::engine::ChatState>,
    path: String,
) -> Result<ProjectView, String> {
    let canonical = clean_canonical_path(
        std::fs::canonicalize(path.trim()).map_err(|error| error.to_string())?,
    );
    if !canonical.is_dir() {
        return Err("project path must be a directory".to_string());
    }
    let normalized = normalize_path(&canonical);
    let _switch_permit = crate::engine::begin_project_switch(chat_state.inner()).await?;
    crate::engine::with_project_switch_guard(chat_state.inner(), || {
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
        activate_with_environment_lock(&mut registry, &id)?;
        view(&registry)
    })
}

#[tauri::command]
pub async fn project_set_current(
    app: AppHandle,
    projects: State<'_, ProjectState>,
    chat_state: State<'_, crate::engine::ChatState>,
    id: String,
) -> Result<ProjectView, String> {
    let _switch_permit = crate::engine::begin_project_switch(chat_state.inner()).await?;
    let result = crate::engine::with_project_switch_guard(chat_state.inner(), || {
        let mut registry = projects
            .registry
            .lock()
            .map_err(|_| "project state poisoned".to_string())?;
        activate_with_environment_lock(&mut registry, &id)?;
        view(&registry)
    })?;
    notify_project_changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn projects_reorder(
    projects: State<'_, ProjectState>,
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

/// Drop a project from the registry.
///
/// `activate_default` re-points the process at the default workspace when the
/// removed project is the active one. It is injected rather than called
/// directly because that activation persists the registry: a test exercising
/// the removal rules would otherwise overwrite the real `projects.json` with
/// its fixture and destroy the developer's project list.
fn remove_from_registry(
    registry: &mut ProjectRegistry,
    id: &str,
    activate_default: impl FnOnce(&mut ProjectRegistry) -> Result<(), String>,
) -> Result<(), String> {
    if id == "default" {
        return Err("cannot remove the default project".to_string());
    }
    if !registry.projects.iter().any(|project| project.id == id) {
        return Err("project not found".to_string());
    }
    if registry.current_project_id == id {
        activate_default(registry)?;
    }
    registry.projects.retain(|project| project.id != id);
    Ok(())
}

#[tauri::command]
pub async fn project_remove(
    app: AppHandle,
    projects: State<'_, ProjectState>,
    chat_state: State<'_, crate::engine::ChatState>,
    id: String,
) -> Result<ProjectView, String> {
    if id == "default" {
        return Err("cannot remove the default project".to_string());
    }
    let _switch_permit = crate::engine::begin_project_switch(chat_state.inner()).await?;
    let result = crate::engine::with_project_switch_guard(chat_state.inner(), || {
        let mut registry = projects
            .registry
            .lock()
            .map_err(|_| "project state poisoned".to_string())?;
        remove_from_registry(&mut registry, &id, |registry| {
            activate_with_environment_lock(registry, "default")
        })?;
        save_registry(&registry)?;
        view(&registry)
    })?;
    notify_project_changed(&app);
    Ok(result)
}

#[cfg(test)]
#[path = "tests/projects.rs"]
mod tests;
