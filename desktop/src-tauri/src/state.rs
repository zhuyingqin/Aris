use std::{io, path::PathBuf};

const DESKTOP_ALLOWED_AGENT_TOOLS: &[&str] = &[
    "read_file",
    "write_file",
    "edit_file",
    "glob_search",
    "grep_search",
    "WebFetch",
    "WebSearch",
    "LiteratureSearch",
    "LiteratureLibraryUpsert",
    "LiteraturePdfDownload",
    "TodoWrite",
    "LlmReview",
    "Skill",
    "ToolSearch",
    "Sleep",
    "SendUserMessage",
    "StructuredOutput",
    "SendMessage",
    "ClaimTask",
    "CompleteTask",
    "ListTeam",
    "WaitForTeammates",
    "VerifyDeliverable",
];

pub fn default_workspace_dir() -> PathBuf {
    PathBuf::from(runtime::home_dir())
        .join(".config")
        .join("aris")
        .join("desktop-workspace")
}

pub fn workspace_dir() -> PathBuf {
    std::env::var("ARIS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_workspace_dir())
}

pub fn runtime_dir() -> PathBuf {
    PathBuf::from(runtime::home_dir())
        .join(".config")
        .join("aris")
        .join("desktop-runtime")
}

pub fn project_runtime_dir(project_id: &str) -> PathBuf {
    if project_id == "default" {
        runtime_dir()
    } else {
        runtime_dir().join("projects").join(project_id)
    }
}

pub fn valid_project_id(project_id: &str) -> bool {
    project_id == "default"
        || project_id.strip_prefix("project-").is_some_and(|suffix| {
            suffix.len() == 16 && suffix.chars().all(|ch| ch.is_ascii_hexdigit())
        })
}

pub fn sessions_dir_for_project(project_id: &str) -> PathBuf {
    project_runtime_dir(project_id).join("sessions")
}

pub fn apply_project_environment(workspace: &PathBuf, project_id: &str) -> io::Result<()> {
    let project_runtime = project_runtime_dir(project_id);
    let run_state = project_runtime.join("run-state");
    let sessions = project_runtime.join("sessions");
    let agent_store = project_runtime.join("agents");
    let workflows = project_runtime.join("workflows");
    let user_workflows = project_runtime.join("user-workflows");

    if project_id == "default" {
        migrate_legacy_desktop_dirs(workspace, &project_runtime)?;
    }
    std::fs::create_dir_all(workspace)?;
    std::fs::create_dir_all(&run_state)?;
    std::fs::create_dir_all(&sessions)?;
    std::fs::create_dir_all(&agent_store)?;
    std::fs::create_dir_all(&workflows)?;
    std::fs::create_dir_all(&user_workflows)?;

    std::env::set_var("ARIS_WORKSPACE_ROOT", workspace);
    std::env::set_var("ARIS_DESKTOP_PROJECT_ID", project_id);
    std::env::set_var("ARIS_RUN_STATE_DIR", &run_state);
    std::env::set_var("ARIS_SESSIONS_DIR", &sessions);
    std::env::set_var("ARIS_AGENT_STORE_DIR", &agent_store);
    std::env::set_var("ARIS_WORKFLOWS_DIR", &workflows);
    std::env::set_var("ARIS_USER_WORKFLOWS_DIR", &user_workflows);
    std::env::set_var("CLAWD_AGENT_STORE", &agent_store);
    std::env::set_var("CLAWD_TODO_STORE", project_runtime.join("tasks.json"));
    std::env::set_var("ARIS_ALLOWED_TOOLS", DESKTOP_ALLOWED_AGENT_TOOLS.join(","));
    std::env::set_current_dir(workspace)
}

fn migrate_legacy_desktop_dirs(workspace: &PathBuf, runtime: &PathBuf) -> io::Result<()> {
    let legacy_claude = workspace.join(".claude");
    migrate_dir(&legacy_claude.join("run-state"), &runtime.join("run-state"))?;
    migrate_dir(&legacy_claude.join("sessions"), &runtime.join("sessions"))?;
    migrate_dir(&legacy_claude.join("workflows"), &runtime.join("workflows"))?;
    migrate_dir(&workspace.join(".clawd-agents"), &runtime.join("agents"))?;
    let _ = std::fs::remove_dir(&legacy_claude);
    Ok(())
}

fn migrate_dir(from: &PathBuf, to: &PathBuf) -> io::Result<()> {
    if !from.exists() || to.exists() {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(from, to)
}

pub fn state_root() -> PathBuf {
    if let Ok(path) = std::env::var("ARIS_RUN_STATE_DIR") {
        return PathBuf::from(path);
    }
    runtime_dir().join("run-state")
}

pub fn events_path() -> PathBuf {
    state_root().join("events.jsonl")
}

pub fn sessions_dir() -> PathBuf {
    if let Ok(path) = std::env::var("ARIS_SESSIONS_DIR") {
        return PathBuf::from(path);
    }
    runtime_dir().join("sessions")
}

/// `~/.config/aris/config.json` — mirror of `ArisConfig::config_path()`.
pub fn config_path() -> PathBuf {
    PathBuf::from(runtime::home_dir())
        .join(".config")
        .join("aris")
        .join("config.json")
}
