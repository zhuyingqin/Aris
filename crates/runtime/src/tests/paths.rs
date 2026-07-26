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

#[test]
fn command_lookup_uses_platform_executable_rules() {
    let root = tempfile::tempdir().expect("tempdir");
    #[cfg(windows)]
    let executable = root.path().join("somniq-test-command.EXE");
    #[cfg(not(windows))]
    let executable = root.path().join("somniq-test-command");
    fs::write(&executable, "test").expect("write executable");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&executable).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).expect("set executable permissions");
    }

    assert!(command_exists_in_paths(
        "somniq-test-command",
        vec![root.path().to_path_buf()],
    ));
    assert!(!command_exists_in_paths(
        "somniq-missing-command",
        vec![root.path().to_path_buf()],
    ));
}
