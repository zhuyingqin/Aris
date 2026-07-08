use std::{env, io, path::PathBuf};

const CONFIG_HOME_DIR: &str = "SomniQ";
const LEGACY_CONFIG_HOME_DIR: &str = "aris";

const DESKTOP_ALLOWED_AGENT_TOOLS: &[&str] = &[
    "read_file",
    "write_file",
    "append_file",
    "edit_file",
    "glob_search",
    "grep_search",
    "WebFetch",
    "WebSearch",
    "LiteratureSearch",
    "LiteratureLibraryUpsert",
    "LiteraturePdfDownload",
    "StudioLibraryUpsert",
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
    std::env::var("ARIS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_workspace_dir())
}

pub fn runtime_dir() -> PathBuf {
    std::env::var("ARIS_RUNTIME_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| config_dir().join("desktop-runtime"))
}

pub fn desktop_runtime_dir() -> PathBuf {
    config_dir().join("desktop-runtime")
}

pub fn config_dir() -> PathBuf {
    std::env::var("ARIS_CONFIG_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let dir = PathBuf::from(runtime::home_dir())
                .join(".config")
                .join(CONFIG_HOME_DIR);
            let legacy = PathBuf::from(runtime::home_dir())
                .join(".config")
                .join(LEGACY_CONFIG_HOME_DIR);
            let _ = migrate_dir(&legacy, &dir);
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
    std::fs::create_dir_all(workspace.join("papers"))?;
    std::fs::create_dir_all(&run_state)?;
    std::fs::create_dir_all(&sessions)?;
    std::fs::create_dir_all(&agent_store)?;
    std::fs::create_dir_all(&workflows)?;
    std::fs::create_dir_all(&user_workflows)?;
    configure_readonly_roots()?;

    std::env::set_var("ARIS_WORKSPACE_ROOT", workspace);
    std::env::set_var("ARIS_RUNTIME_ROOT", &project_runtime);
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

fn configure_readonly_roots() -> io::Result<()> {
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
        env::remove_var("ARIS_READONLY_ROOTS");
        return Ok(());
    }
    let joined = env::join_paths(&roots).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid read-only root path: {error}"),
        )
    })?;
    env::set_var("ARIS_READONLY_ROOTS", joined);
    Ok(())
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
mod tests {
    use super::{desktop_runtime_dir, project_runtime_dir};
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn project_runtime_dir_uses_stable_desktop_base() {
        let _lock = ENV_LOCK.lock().expect("env lock");
        let stale_current_project_runtime = desktop_runtime_dir()
            .join("projects")
            .join("project-aaaaaaaaaaaaaaaa");
        let _guard = EnvGuard::set("ARIS_RUNTIME_ROOT", &stale_current_project_runtime);

        assert_eq!(project_runtime_dir("default"), desktop_runtime_dir());
        assert_eq!(
            project_runtime_dir("project-bbbbbbbbbbbbbbbb"),
            desktop_runtime_dir()
                .join("projects")
                .join("project-bbbbbbbbbbbbbbbb")
        );
    }
}
