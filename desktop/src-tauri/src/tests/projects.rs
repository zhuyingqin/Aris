use super::{
    clean_canonical_path, fallback_missing_current_project, import_registry_projects,
    merge_legacy_projects, normalize_path, project_id, project_path_for_id, remove_from_registry,
    reorder_registry, view, DesktopProject, ProjectRegistry, ProjectState,
};
use crate::state::valid_project_id;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

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

/// Stand-in for the production activation, which creates directories, repoints
/// the process working directory and saves the registry to the real config
/// root. Removal rules are registry logic and are tested as such.
fn activate_default_in_memory(registry: &mut ProjectRegistry) -> Result<(), String> {
    registry.current_project_id = "default".to_string();
    Ok(())
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
fn volume_guid_paths_are_preserved() {
    // The `\\?\Volume{...}` prefix must survive — stripping it produces an
    // unusable path. (No-op early return on non-Windows keeps this valid.)
    let path = PathBuf::from(r"\\?\Volume{12345678-1234-1234-1234-1234567890ab}\data");
    assert_eq!(clean_canonical_path(path.clone()), path);
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
fn imports_named_projects_from_a_legacy_registry_when_the_new_one_is_empty() {
    let temp = tempfile::tempdir().expect("temporary project root");
    let workspace = temp.path().join("legacy-project");
    std::fs::create_dir_all(&workspace).expect("create temporary project");
    let workspace_id = project_id(&workspace);
    let mut registry = ProjectRegistry {
        projects: vec![test_project("default", "SomniQ Desktop Workspace", 0)],
        current_project_id: "default".to_string(),
    };
    let legacy = ProjectRegistry {
        projects: vec![DesktopProject {
            id: workspace_id.clone(),
            name: "Legacy project".to_string(),
            path: workspace.to_string_lossy().into_owned(),
            added_at: 1,
            last_opened_at: 2,
        }],
        current_project_id: workspace_id.clone(),
    };

    assert!(merge_legacy_projects(&mut registry, &legacy));
    assert_eq!(registry.current_project_id, workspace_id);
    assert_eq!(registry.projects.len(), 2);
}

#[test]
fn does_not_reimport_legacy_projects_after_the_new_registry_has_named_entries() {
    let temp = tempfile::tempdir().expect("temporary project root");
    let workspace = temp.path().join("legacy-project");
    std::fs::create_dir_all(&workspace).expect("create temporary project");
    let workspace_id = project_id(&workspace);
    let mut registry = ProjectRegistry {
        projects: vec![
            test_project("default", "SomniQ Desktop Workspace", 0),
            DesktopProject {
                id: workspace_id.clone(),
                name: "Already imported".to_string(),
                path: workspace.to_string_lossy().into_owned(),
                added_at: 1,
                last_opened_at: 2,
            },
        ],
        current_project_id: "default".to_string(),
    };
    let legacy = ProjectRegistry {
        projects: vec![DesktopProject {
            id: workspace_id,
            name: "Legacy project".to_string(),
            path: workspace.to_string_lossy().into_owned(),
            added_at: 1,
            last_opened_at: 2,
        }],
        current_project_id: "default".to_string(),
    };

    assert!(!merge_legacy_projects(&mut registry, &legacy));
    assert_eq!(registry.projects.len(), 2);
}

#[test]
fn imports_additional_projects_from_a_project_scoped_registry_snapshot() {
    let temp = tempfile::tempdir().expect("temporary project root");
    let workspace = temp.path().join("scoped-project");
    std::fs::create_dir_all(&workspace).expect("create temporary project");
    let workspace_id = project_id(&workspace);
    let mut registry = ProjectRegistry {
        projects: vec![test_project("default", "SomniQ Desktop Workspace", 0)],
        current_project_id: "default".to_string(),
    };
    let source = ProjectRegistry {
        projects: vec![DesktopProject {
            id: workspace_id,
            name: "Scoped project".to_string(),
            path: workspace.to_string_lossy().into_owned(),
            added_at: 1,
            last_opened_at: 2,
        }],
        current_project_id: "default".to_string(),
    };

    assert!(import_registry_projects(&mut registry, &source));
    assert_eq!(registry.projects.len(), 2);
}

#[test]
fn keeps_an_offline_project_record_but_falls_back_to_default_for_startup() {
    let temp = tempfile::tempdir().expect("temporary project root");
    let workspace = temp.path().join("offline-project");
    std::fs::create_dir_all(&workspace).expect("create temporary project");
    let workspace_id = project_id(&workspace);
    std::fs::remove_dir_all(&workspace).expect("make project temporarily unavailable");
    let mut registry = ProjectRegistry {
        projects: vec![
            test_project("default", "SomniQ Desktop Workspace", 0),
            DesktopProject {
                id: workspace_id.clone(),
                name: "Offline project".to_string(),
                path: workspace.to_string_lossy().into_owned(),
                added_at: 1,
                last_opened_at: 2,
            },
        ],
        current_project_id: workspace_id,
    };

    fallback_missing_current_project(&mut registry);

    assert_eq!(registry.current_project_id, "default");
    assert_eq!(registry.projects.len(), 2);
}

#[test]
fn resolves_a_registered_project_path_without_changing_the_active_project() {
    let state = ProjectState {
        registry: Mutex::new(ProjectRegistry {
            projects: vec![
                test_project("project-a", "Alpha", 1),
                test_project("project-b", "Beta", 2),
            ],
            current_project_id: "project-a".to_string(),
        }),
    };

    assert_eq!(
        project_path_for_id(&state, "project-b").expect("registered project path"),
        PathBuf::from("C:/Beta"),
    );
    assert_eq!(
        state
            .registry
            .lock()
            .expect("project state")
            .current_project_id,
        "project-a",
    );
    assert_eq!(
        project_path_for_id(&state, "project-missing"),
        Err("project not found".to_string()),
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

#[test]
fn remove_from_registry_removes_project_and_rejects_default() {
    let mut registry = ProjectRegistry {
        projects: vec![
            test_project("default", "SomniQ Desktop Workspace", 0),
            test_project("project-a", "Alpha", 1),
            test_project("project-b", "Beta", 2),
        ],
        current_project_id: "project-b".to_string(),
    };

    assert!(remove_from_registry(&mut registry, "default", activate_default_in_memory).is_err());
    assert!(
        remove_from_registry(&mut registry, "non-existent", activate_default_in_memory).is_err()
    );

    remove_from_registry(&mut registry, "project-a", activate_default_in_memory)
        .expect("removing registered project should succeed");
    assert_eq!(registry.projects.len(), 2);
    assert!(!registry.projects.iter().any(|p| p.id == "project-a"));
    assert_eq!(registry.current_project_id, "project-b");
}

#[test]
fn remove_from_registry_resets_current_to_default_when_active_project_is_removed() {
    let mut registry = ProjectRegistry {
        projects: vec![
            test_project("default", "SomniQ Desktop Workspace", 0),
            test_project("project-a", "Alpha", 1),
        ],
        current_project_id: "project-a".to_string(),
    };

    remove_from_registry(&mut registry, "project-a", activate_default_in_memory)
        .expect("removing active project should succeed");
    assert_eq!(registry.projects.len(), 1);
    assert_eq!(registry.current_project_id, "default");
}
