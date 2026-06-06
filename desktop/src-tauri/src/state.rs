use std::{io, path::PathBuf};

const DESKTOP_ALLOWED_AGENT_TOOLS: &[&str] = &[
    "read_file",
    "write_file",
    "edit_file",
    "glob_search",
    "grep_search",
    "WebFetch",
    "WebSearch",
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

pub fn workspace_dir() -> PathBuf {
    PathBuf::from(runtime::home_dir())
        .join(".config")
        .join("aris")
        .join("desktop-workspace")
}

pub fn runtime_dir() -> PathBuf {
    PathBuf::from(runtime::home_dir())
        .join(".config")
        .join("aris")
        .join("desktop-runtime")
}

pub fn init_workspace_environment() -> io::Result<PathBuf> {
    let workspace = workspace_dir();
    let runtime = runtime_dir();
    let run_state = runtime.join("run-state");
    let sessions = runtime.join("sessions");
    let agent_store = runtime.join("agents");
    let workflows = runtime.join("workflows");
    let user_workflows = runtime.join("user-workflows");

    migrate_legacy_desktop_dirs(&workspace, &runtime)?;
    std::fs::create_dir_all(&run_state)?;
    std::fs::create_dir_all(&sessions)?;
    std::fs::create_dir_all(&agent_store)?;
    std::fs::create_dir_all(&workflows)?;
    std::fs::create_dir_all(&user_workflows)?;

    std::env::set_var("ARIS_WORKSPACE_ROOT", &workspace);
    std::env::set_var("ARIS_RUN_STATE_DIR", &run_state);
    std::env::set_var("ARIS_SESSIONS_DIR", &sessions);
    std::env::set_var("ARIS_AGENT_STORE_DIR", &agent_store);
    std::env::set_var("ARIS_WORKFLOWS_DIR", &workflows);
    std::env::set_var("ARIS_USER_WORKFLOWS_DIR", &user_workflows);
    std::env::set_var("CLAWD_AGENT_STORE", &agent_store);
    std::env::set_var(
        "CLAWD_TODO_STORE",
        PathBuf::from(runtime::home_dir())
            .join(".config")
            .join("aris")
            .join("tasks.json"),
    );
    std::env::set_var("ARIS_ALLOWED_TOOLS", DESKTOP_ALLOWED_AGENT_TOOLS.join(","));
    std::env::set_current_dir(&workspace)?;

    Ok(workspace)
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
