use super::{
    add_hot_memory, approve_pending, list_pending, list_pending_for_scope, load_hot_memory,
    new_pending_write, project_scope, reject_pending, remove_hot_memory, stage_memory_write,
    HotMemoryTarget,
};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn targets_parse() {
    assert_eq!(
        "memory".parse::<HotMemoryTarget>().expect("memory target"),
        HotMemoryTarget::Memory
    );
    assert!("other".parse::<HotMemoryTarget>().is_err());
}

#[test]
fn unexpired_task_progress_is_not_hot_memory() {
    let error = super::validate_content("Next step: run the remaining tests.", None)
        .expect_err("task progress should require expiry or session history");
    assert!(error.contains("temporary task progress"));

    assert!(
        super::validate_content("Next step: run the remaining tests.", Some("2099-01-01")).is_ok()
    );
    assert!(super::validate_content("Project uses Rust and React.", None).is_ok());
    assert!(super::validate_content("Module name is todolist_view.", None).is_ok());
}

#[test]
fn project_scope_is_stable() {
    let _guard = crate::test_env_lock();
    let path = std::env::temp_dir().join("aris-hot-memory-scope");
    assert_eq!(project_scope(&path), project_scope(&path));
}

#[test]
fn scopes_expires_and_approves_hot_memory() {
    let _guard = crate::test_env_lock();
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let home = std::env::temp_dir().join(format!("aris-hot-memory-{suffix}"));
    let prior_home = std::env::var("HOME").ok();
    let prior_userprofile = std::env::var("USERPROFILE").ok();
    let prior_project = std::env::var("ARIS_DESKTOP_PROJECT_ID").ok();
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("ARIS_DESKTOP_PROJECT_ID", "project-a");
    let workspace = home.join("workspace");
    fs::create_dir_all(&workspace).expect("workspace");

    add_hot_memory(
        HotMemoryTarget::User,
        "User prefers concise Chinese responses.",
        "test",
        "global",
        None,
    )
    .expect("add global memory");
    add_hot_memory(
        HotMemoryTarget::Memory,
        "Project uses Rust.",
        "test",
        "project:project-a",
        None,
    )
    .expect("add project memory");
    add_hot_memory(
        HotMemoryTarget::Memory,
        "Expired fact.",
        "test",
        "global",
        Some("2000-01-01"),
    )
    .expect("add expired memory");
    add_hot_memory(
        HotMemoryTarget::Memory,
        "Other project only.",
        "test",
        "project:project-b",
        None,
    )
    .expect("add other project memory");
    assert!(remove_hot_memory(
        HotMemoryTarget::Memory,
        "Other project only",
        "project:project-a"
    )
    .is_err());
    remove_hot_memory(
        HotMemoryTarget::Memory,
        "Project uses Rust",
        "project:project-a",
    )
    .expect("remove project memory");

    let pending = new_pending_write(
        "add",
        HotMemoryTarget::Memory,
        Some("Approved fact.".to_string()),
        None,
        "test",
        "global",
        None,
    );
    let pending_id = pending.id.clone();
    stage_memory_write(pending).expect("stage");
    assert_eq!(list_pending().expect("pending").len(), 1);
    approve_pending(&pending_id).expect("approve");
    stage_memory_write(new_pending_write(
        "add",
        HotMemoryTarget::Memory,
        Some("Other project pending.".to_string()),
        None,
        "test",
        "project:project-b",
        None,
    ))
    .expect("stage other project");

    let snapshot = load_hot_memory(&workspace).expect("snapshot");
    assert_eq!(snapshot.user.len(), 1);
    assert_eq!(snapshot.memory.len(), 1);
    assert!(snapshot
        .memory
        .iter()
        .all(|entry| entry.content != "Expired fact."));
    assert_eq!(snapshot.pending_count, 0);
    assert!(list_pending_for_scope("project:project-a")
        .expect("scoped pending")
        .is_empty());
    assert!(approve_pending("../escape").is_err());
    assert!(reject_pending("../escape").is_err());

    fs::remove_dir_all(&home).expect("remove home");
    match prior_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    match prior_userprofile {
        Some(value) => std::env::set_var("USERPROFILE", value),
        None => std::env::remove_var("USERPROFILE"),
    }
    match prior_project {
        Some(value) => std::env::set_var("ARIS_DESKTOP_PROJECT_ID", value),
        None => std::env::remove_var("ARIS_DESKTOP_PROJECT_ID"),
    }
}
