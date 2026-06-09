use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use crate::{engine::ChatState, state};

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
        name: "ARIS Desktop Workspace".to_string(),
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
    state::runtime_dir().join(PROJECTS_FILE)
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
        state::valid_project_id(&project.id)
            && (project.id == "default" || Path::new(&project.path).is_dir())
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
    let temp = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(registry).map_err(|error| error.to_string())?;
    std::fs::write(&temp, data).map_err(|error| error.to_string())?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    std::fs::rename(temp, path).map_err(|error| error.to_string())
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
    if !path.is_dir() {
        return Err(format!(
            "project directory does not exist: {}",
            path.display()
        ));
    }
    state::apply_project_environment(&path, &project_id).map_err(|error| error.to_string())?;
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

fn ensure_switch_allowed(chat: &ChatState) -> Result<(), String> {
    if chat.is_busy() {
        return Err(
            "wait for the active chat turn to finish before switching projects".to_string(),
        );
    }
    let output = tools::execute_tool("Workflow", &json!({ "action": "list" }))?;
    let value: serde_json::Value =
        serde_json::from_str(&output).map_err(|error| error.to_string())?;
    let has_running_workflow = value["runs"].as_array().is_some_and(|runs| {
        runs.iter()
            .any(|run| run["status"].as_str() == Some("running"))
    });
    if has_running_workflow {
        return Err("stop or finish the active workflow before switching projects".to_string());
    }
    Ok(())
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
    chat: State<ChatState>,
    path: String,
) -> Result<ProjectView, String> {
    ensure_switch_allowed(&chat)?;
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
    chat.clear()?;
    view(&registry)
}

#[tauri::command]
pub fn project_set_current(
    projects: State<ProjectState>,
    chat: State<ChatState>,
    id: String,
) -> Result<ProjectView, String> {
    ensure_switch_allowed(&chat)?;
    let mut registry = projects
        .registry
        .lock()
        .map_err(|_| "project state poisoned".to_string())?;
    activate(&mut registry, &id)?;
    chat.clear()?;
    view(&registry)
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
mod tests {
    use super::{
        clean_canonical_path, normalize_path, project_id, reorder_registry, view, DesktopProject,
        ProjectRegistry,
    };
    use crate::state::valid_project_id;
    use std::path::{Path, PathBuf};

    fn test_project(id: &str, name: &str, last_opened_at: u64) -> DesktopProject {
        DesktopProject {
            id: id.to_string(),
            name: name.to_string(),
            path: format!("C:/{name}"),
            added_at: 1,
            last_opened_at,
        }
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn project_ids_are_stable_for_the_same_path() {
        let path = Path::new("C:/workspace/example");
        assert_eq!(project_id(path), project_id(path));
    }

    #[test]
    fn normalized_paths_use_forward_slashes() {
        assert!(!normalize_path(Path::new(r"C:\workspace\example")).contains('\\'));
    }

    #[test]
    fn canonical_paths_remain_usable() {
        let path = PathBuf::from(r"C:\workspace\example");
        assert!(!clean_canonical_path(path).as_os_str().is_empty());
    }

    #[test]
    fn rejects_project_ids_that_can_escape_the_runtime_directory() {
        assert!(valid_project_id("default"));
        assert!(valid_project_id("project-0123456789abcdef"));
        assert!(!valid_project_id("../project"));
        assert!(!valid_project_id("project-not-hexadecimal"));
    }

    #[test]
    fn project_view_preserves_registry_order() {
        let registry = ProjectRegistry {
            projects: vec![
                test_project("project-b", "Beta", 20),
                test_project("project-a", "Alpha", 90),
            ],
            current_project_id: "project-a".to_string(),
        };

        let view = view(&registry).expect("project view should build");

        assert_eq!(
            view.projects
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>(),
            vec!["project-b", "project-a"]
        );
    }

    #[test]
    fn reorder_registry_requires_the_same_project_set() {
        let registry = ProjectRegistry {
            projects: vec![
                test_project("project-a", "Alpha", 1),
                test_project("project-b", "Beta", 2),
            ],
            current_project_id: "project-a".to_string(),
        };

        let mut missing = registry.clone();
        assert!(reorder_registry(&mut missing, &ids(&["project-a"])).is_err());

        let mut unknown = registry.clone();
        assert!(reorder_registry(&mut unknown, &ids(&["project-a", "project-c"])).is_err());

        let mut duplicate = registry.clone();
        assert!(reorder_registry(&mut duplicate, &ids(&["project-a", "project-a"])).is_err());
    }

    #[test]
    fn reorder_registry_updates_order_without_touching_metadata() {
        let mut registry = ProjectRegistry {
            projects: vec![
                test_project("project-a", "Alpha", 1),
                test_project("project-b", "Beta", 2),
            ],
            current_project_id: "project-a".to_string(),
        };

        reorder_registry(&mut registry, &ids(&["project-b", "project-a"]))
            .expect("valid reorder should succeed");

        assert_eq!(
            registry
                .projects
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>(),
            vec!["project-b", "project-a"]
        );
        assert_eq!(registry.projects[0].last_opened_at, 2);
        assert_eq!(registry.current_project_id, "project-a");
    }
}
