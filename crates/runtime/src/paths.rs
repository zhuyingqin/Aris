use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

pub const ARIS_RUNTIME_ROOT_ENV: &str = "ARIS_RUNTIME_ROOT";
pub const ARIS_WORKSPACE_ROOT_ENV: &str = "ARIS_WORKSPACE_ROOT";
pub const ARIS_RUN_STATE_DIR_ENV: &str = "ARIS_RUN_STATE_DIR";
pub const ARIS_SESSIONS_DIR_ENV: &str = "ARIS_SESSIONS_DIR";
pub const ARIS_AGENT_STORE_DIR_ENV: &str = "ARIS_AGENT_STORE_DIR";
pub const ARIS_WORKFLOWS_DIR_ENV: &str = "ARIS_WORKFLOWS_DIR";
pub const ARIS_USER_WORKFLOWS_DIR_ENV: &str = "ARIS_USER_WORKFLOWS_DIR";
pub const CLAWD_AGENT_STORE_ENV: &str = "CLAWD_AGENT_STORE";

pub const SOMNIQ_RUNTIME_DIR_NAME: &str = "runtime";
pub const RUN_STATE_DIR_NAME: &str = "run-state";
pub const SESSIONS_DIR_NAME: &str = "sessions";
pub const AGENTS_DIR_NAME: &str = "agents";
pub const WORKFLOWS_DIR_NAME: &str = "workflows";
pub const USER_WORKFLOWS_DIR_NAME: &str = "user-workflows";
pub const LEGACY_CLAUDE_DIR_NAME: &str = ".claude";
pub const LEGACY_CLAWD_AGENTS_DIR_NAME: &str = ".clawd-agents";

#[must_use]
pub fn workspace_root_from_env() -> PathBuf {
    env::var_os(ARIS_WORKSPACE_ROOT_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

#[must_use]
pub fn somniq_config_dir_from_env() -> PathBuf {
    env::var_os("ARIS_CONFIG_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(crate::home_dir())
                .join(".config")
                .join("SomniQ")
        })
}

#[must_use]
pub fn project_runtime_dir_for(workspace: impl AsRef<Path>) -> PathBuf {
    env::var_os(ARIS_RUNTIME_ROOT_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::somniq_project_dir(workspace).join(SOMNIQ_RUNTIME_DIR_NAME))
}

#[must_use]
pub fn project_runtime_dir_from_env() -> PathBuf {
    project_runtime_dir_for(workspace_root_from_env())
}

#[must_use]
pub fn project_run_state_dir_from_env() -> PathBuf {
    project_run_state_dir_for(workspace_root_from_env())
}

#[must_use]
pub fn project_run_state_dir_for(workspace: impl AsRef<Path>) -> PathBuf {
    env::var_os(ARIS_RUN_STATE_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| project_runtime_dir_for(workspace).join(RUN_STATE_DIR_NAME))
}

#[must_use]
pub fn project_sessions_dir_from_env() -> PathBuf {
    project_sessions_dir_for(workspace_root_from_env())
}

#[must_use]
pub fn project_sessions_dir_for(workspace: impl AsRef<Path>) -> PathBuf {
    env::var_os(ARIS_SESSIONS_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| project_runtime_dir_for(workspace).join(SESSIONS_DIR_NAME))
}

#[must_use]
pub fn project_agent_store_dir_from_env() -> PathBuf {
    project_agent_store_dir_for(workspace_root_from_env())
}

#[must_use]
pub fn project_agent_store_dir_for(workspace: impl AsRef<Path>) -> PathBuf {
    env::var_os(ARIS_AGENT_STORE_DIR_ENV)
        .or_else(|| env::var_os(CLAWD_AGENT_STORE_ENV))
        .map(PathBuf::from)
        .unwrap_or_else(|| project_runtime_dir_for(workspace).join(AGENTS_DIR_NAME))
}

#[must_use]
pub fn project_workflows_dir_from_env() -> PathBuf {
    project_workflows_dir_for(workspace_root_from_env())
}

#[must_use]
pub fn project_workflows_dir_for(workspace: impl AsRef<Path>) -> PathBuf {
    env::var_os(ARIS_WORKFLOWS_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| project_runtime_dir_for(workspace).join(WORKFLOWS_DIR_NAME))
}

#[must_use]
pub fn user_workflows_dir_from_env() -> PathBuf {
    env::var_os(ARIS_USER_WORKFLOWS_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| somniq_config_dir_from_env().join(USER_WORKFLOWS_DIR_NAME))
}

pub fn migrate_legacy_project_runtime_dirs(workspace: impl AsRef<Path>) -> io::Result<()> {
    let workspace = workspace.as_ref();
    let legacy_claude = workspace.join(LEGACY_CLAUDE_DIR_NAME);
    migrate_dir_contents(
        &legacy_claude.join(RUN_STATE_DIR_NAME),
        &project_run_state_dir_for(workspace),
    )?;
    migrate_dir_contents(
        &legacy_claude.join(SESSIONS_DIR_NAME),
        &project_sessions_dir_for(workspace),
    )?;
    migrate_dir_contents(
        &legacy_claude.join(WORKFLOWS_DIR_NAME),
        &project_workflows_dir_for(workspace),
    )?;
    migrate_dir_contents(
        &workspace.join(LEGACY_CLAWD_AGENTS_DIR_NAME),
        &project_agent_store_dir_for(workspace),
    )?;
    let _ = fs::remove_dir(&legacy_claude);
    Ok(())
}

fn migrate_dir_contents(from: &Path, to: &Path) -> io::Result<()> {
    if !from.exists() || same_path(from, to) {
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if dst.exists() {
            if entry.file_type()?.is_dir() && dst.is_dir() {
                migrate_dir_contents(&src, &dst)?;
            }
            continue;
        }
        move_path(&src, &dst)?;
    }
    let _ = fs::remove_dir(from);
    Ok(())
}

fn move_path(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) if is_cross_device(&error) => {
            if from.is_dir() {
                copy_dir_recursive(from, to)?;
                fs::remove_dir_all(from)
            } else {
                fs::copy(from, to)?;
                fs::remove_file(from)
            }
        }
        Err(error) => Err(error),
    }
}

fn copy_dir_recursive(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn is_cross_device(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(17) | Some(18))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvGuard {
        name: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn unset(name: &'static str) -> Self {
            let previous = env::var_os(name);
            env::remove_var(name);
            Self { name, previous }
        }

        fn set(name: &'static str, value: &Path) -> Self {
            let previous = env::var_os(name);
            env::set_var(name, value);
            Self { name, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => env::set_var(self.name, value),
                None => env::remove_var(self.name),
            }
        }
    }

    #[test]
    fn project_runtime_defaults_to_somniq_runtime() {
        let _lock = crate::test_env_lock();
        let _runtime = EnvGuard::unset(ARIS_RUNTIME_ROOT_ENV);
        let root = tempfile::tempdir().expect("tempdir");

        assert_eq!(
            project_runtime_dir_for(root.path()),
            root.path()
                .join(crate::SOMNIQ_PROJECT_DIR_NAME)
                .join(SOMNIQ_RUNTIME_DIR_NAME)
        );
    }

    #[test]
    fn legacy_project_runtime_dirs_migrate_to_runtime_root() {
        let _lock = crate::test_env_lock();
        let root = tempfile::tempdir().expect("tempdir");
        let runtime_root = root.path().join("runtime-root");
        let _workspace = EnvGuard::set(ARIS_WORKSPACE_ROOT_ENV, root.path());
        let _runtime = EnvGuard::set(ARIS_RUNTIME_ROOT_ENV, &runtime_root);
        let _run_state = EnvGuard::unset(ARIS_RUN_STATE_DIR_ENV);
        let _sessions = EnvGuard::unset(ARIS_SESSIONS_DIR_ENV);
        let _agents = EnvGuard::unset(ARIS_AGENT_STORE_DIR_ENV);
        let _clawd_agents = EnvGuard::unset(CLAWD_AGENT_STORE_ENV);
        let _workflows = EnvGuard::unset(ARIS_WORKFLOWS_DIR_ENV);

        fs::create_dir_all(root.path().join(".claude").join("sessions")).expect("sessions");
        fs::write(
            root.path()
                .join(".claude")
                .join("sessions")
                .join("session-a.json"),
            "{}",
        )
        .expect("session");
        fs::create_dir_all(root.path().join(".clawd-agents")).expect("agents");
        fs::write(root.path().join(".clawd-agents").join("agent-a.json"), "{}").expect("agent");

        migrate_legacy_project_runtime_dirs(root.path()).expect("migrate");

        assert!(runtime_root
            .join(SESSIONS_DIR_NAME)
            .join("session-a.json")
            .is_file());
        assert!(runtime_root
            .join(AGENTS_DIR_NAME)
            .join("agent-a.json")
            .is_file());
        assert!(!root.path().join(".claude").join("sessions").exists());
        assert!(!root.path().join(".clawd-agents").exists());
    }
}
