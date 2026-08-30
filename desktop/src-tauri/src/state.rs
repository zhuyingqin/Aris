use std::{env, io, path::PathBuf};

const CONFIG_HOME_DIR: &str = "SomniQ";
const LEGACY_CONFIG_HOME_DIR: &str = "aris";

const DESKTOP_ALLOWED_AGENT_TOOLS: &[&str] = &[
    "read_file",
    "write_file",
    "append_file",
    "edit_file",
    "multi_edit",
    "glob_search",
    "grep_search",
    "WebFetch",
    "WebSearch",
    "LiteratureSearch",
    "LiteratureCitations",
    "RetrievalPlan",
    "RetrievalEvidence",
    "RetrievalLedger",
    "LiteratureSearchProtocolCreate",
    "LiteratureSearchPreview",
    "LiteratureSearchExecute",
    "LiteratureLibraryUpsert",
    "LiteraturePdfDownload",
    "LaTeXCompile",
    "TodoWrite",
    "memory",
    "session_search",
    "LlmReview",
    "Skill",
    "ToolSearch",
    "Sleep",
    "SendUserMessage",
    "StructuredOutput",
];

pub fn default_workspace_dir() -> PathBuf {
    config_dir().join("desktop-workspace")
}

pub fn workspace_dir() -> PathBuf {
    runtime::execution_env_var_os("ARIS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(default_workspace_dir)
}

pub fn runtime_dir() -> PathBuf {
    runtime::execution_env_var_os("ARIS_RUNTIME_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| config_dir().join("desktop-runtime"))
}

pub fn desktop_runtime_dir() -> PathBuf {
    config_dir().join("desktop-runtime")
}

/// Return the pre-SomniQ configuration directory when the user has not
/// explicitly selected a custom config root.
pub(crate) fn legacy_config_dir() -> Option<PathBuf> {
    if std::env::var_os("ARIS_CONFIG_ROOT").is_some() {
        return None;
    }
    Some(
        PathBuf::from(runtime::home_dir())
            .join(".config")
            .join(LEGACY_CONFIG_HOME_DIR),
    )
}

pub fn config_dir() -> PathBuf {
    std::env::var("ARIS_CONFIG_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let dir = PathBuf::from(runtime::home_dir())
                .join(".config")
                .join(CONFIG_HOME_DIR);
            if let Some(legacy) = legacy_config_dir() {
                let _ = migrate_dir(&legacy, &dir);
            }
            dir
        })
}

pub fn skills_dir() -> PathBuf {
    config_dir().join("skills")
}

pub fn mail_dir() -> PathBuf {
    let dir = config_dir().join("mail");
    let legacy = PathBuf::from(runtime::home_dir())
        .join(".aris")
        .join("mail");
    let _ = migrate_dir(&legacy, &dir);
    dir
}

pub fn apply_bundle_cache_environment() {
    let report = runtime::extract_bundle();
    if let Some(dir) = &report.used_dir {
        let dir_str = dir.display().to_string().replace('\\', "/");
        env::set_var("ARIS_CACHE_DIR", dir_str);
    } else {
        env::remove_var("ARIS_CACHE_DIR");
    }
}

pub fn project_runtime_dir(project_id: &str) -> PathBuf {
    if project_id == "default" {
        desktop_runtime_dir()
    } else {
        desktop_runtime_dir().join("projects").join(project_id)
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
    project_execution_context(workspace, project_id)?.apply_to_current_process()
}

/// Prepare the immutable environment inherited by one project-bound Chat
/// turn. Unlike [`apply_project_environment`], this does not change the
/// Desktop process's active project or working directory.
pub(crate) fn project_execution_context(
    workspace: &PathBuf,
    project_id: &str,
) -> io::Result<runtime::ProjectExecutionContext> {
    let project_runtime = project_runtime_dir(project_id);
    let run_state = project_runtime.join("run-state");
    let sessions = project_runtime.join("sessions");
    let agent_store = project_runtime.join("agents");

    if project_id == "default" {
        migrate_legacy_desktop_dirs(workspace, &project_runtime)?;
    }
    std::fs::create_dir_all(workspace)?;
    std::fs::create_dir_all(tools::layout::project_data_dir_at(workspace))?;
    std::fs::create_dir_all(&run_state)?;
    std::fs::create_dir_all(&sessions)?;
    std::fs::create_dir_all(&agent_store)?;

    let mut context = runtime::ProjectExecutionContext::new(workspace)
        .with_env("ARIS_WORKSPACE_ROOT", workspace.as_os_str())
        .with_env("ARIS_RUNTIME_ROOT", project_runtime.as_os_str())
        .with_env("ARIS_DESKTOP_PROJECT_ID", project_id)
        .with_env("ARIS_RUN_STATE_DIR", run_state.as_os_str())
        .with_env("ARIS_SESSIONS_DIR", sessions.as_os_str())
        .with_env("ARIS_AGENT_STORE_DIR", agent_store.as_os_str())
        .with_env("CLAWD_AGENT_STORE", agent_store.as_os_str())
        .with_env(
            "CLAWD_TODO_STORE",
            project_runtime.join("tasks.json").into_os_string(),
        )
        .with_env("ARIS_ALLOWED_TOOLS", DESKTOP_ALLOWED_AGENT_TOOLS.join(","));
    context = match readonly_roots_value()? {
        Some(value) => context.with_env("ARIS_READONLY_ROOTS", value),
        None => context.without_env("ARIS_READONLY_ROOTS"),
    };
    Ok(context)
}

fn readonly_roots_value() -> io::Result<Option<std::ffi::OsString>> {
    let user_skills = skills_dir();
    std::fs::create_dir_all(&user_skills)?;
    let mut roots = vec![user_skills];
    if let Some(cache_dir) =
        runtime::extraction_report().and_then(|report| report.used_dir.as_ref())
    {
        roots.push(cache_dir.join("skills"));
    }
    roots.retain(|path| path.exists());
    if roots.is_empty() {
        return Ok(None);
    }
    let joined = env::join_paths(&roots).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid read-only root path: {error}"),
        )
    })?;
    Ok(Some(joined))
}

fn migrate_legacy_desktop_dirs(workspace: &PathBuf, runtime: &PathBuf) -> io::Result<()> {
    let legacy_claude = workspace.join(".claude");
    migrate_dir(&legacy_claude.join("run-state"), &runtime.join("run-state"))?;
    migrate_dir(&legacy_claude.join("sessions"), &runtime.join("sessions"))?;
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
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        // `rename` cannot move across volumes/drives (Windows
        // ERROR_NOT_SAME_DEVICE = 17, Unix EXDEV = 18). The runtime dir and the
        // legacy workspace may live on different drives, so fall back to a
        // recursive copy followed by removal of the source.
        Err(error) if is_cross_device(&error) => {
            copy_dir_recursive(from, to)?;
            std::fs::remove_dir_all(from)
        }
        Err(error) => Err(error),
    }
}

fn is_cross_device(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(17) | Some(18))
}

fn copy_dir_recursive(from: &PathBuf, to: &PathBuf) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
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

/// `~/.config/SomniQ/config.json` — mirror of `ArisConfig::config_path()`.
pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

#[cfg(test)]
#[path = "tests/state.rs"]
mod tests;
