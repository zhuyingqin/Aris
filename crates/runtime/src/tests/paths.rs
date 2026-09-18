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

#[cfg(windows)]
#[test]
fn plain_path_removes_the_prefix_a_posix_shell_cannot_quote() {
    // The bug this guards: `"\\?\F:\...\latexmk"` reaches `exec` as
    // `\?\F:\...\latexmk`, because a double-quoted `\\` collapses to `\`.
    assert_eq!(
        plain_path(Path::new(r"\\?\F:\Agent\Aris\resources\bin\latexmk")),
        PathBuf::from(r"F:\Agent\Aris\resources\bin\latexmk")
    );
    assert_eq!(
        plain_path(Path::new(r"\\?\UNC\server\share\paper.tex")),
        PathBuf::from(r"\\server\share\paper.tex")
    );
}

#[cfg(windows)]
#[test]
fn plain_path_leaves_ordinary_and_unrepresentable_paths_untouched() {
    for path in [
        r"F:\Agent\Aris",
        r"\\server\share",
        r"relative\path",
        // No drive-letter spelling exists for a volume GUID.
        r"\\?\Volume{d2b3f1a0-0000-0000-0000-100000000000}\data",
    ] {
        assert_eq!(plain_path(Path::new(path)), PathBuf::from(path), "{path}");
    }
}

#[cfg(windows)]
#[test]
fn plain_path_keeps_the_prefix_where_win32_would_resolve_a_different_file() {
    let long = format!(r"\\?\F:\{}", "segment\\".repeat(40));
    for path in [
        long.as_str(),
        r"\\?\F:\work\CON",
        r"\\?\F:\work\LPT1.txt",
        r"\\?\F:\work\trailing.",
        r"\\?\F:\work\trailing ",
    ] {
        assert_eq!(plain_path(Path::new(path)), PathBuf::from(path), "{path}");
    }
    // `COM0` is not a reserved device, so it is safe to normalize.
    assert_eq!(
        plain_path(Path::new(r"\\?\F:\work\COM0")),
        PathBuf::from(r"F:\work\COM0")
    );
}

#[test]
fn canonicalize_never_returns_a_verbatim_path() {
    let root = tempfile::tempdir().expect("tempdir");
    let file = root.path().join("paper.tex");
    fs::write(&file, "x").expect("write");

    let canonical = canonicalize(&file).expect("canonicalize");
    assert!(
        !canonical.to_string_lossy().starts_with(r"\\?\"),
        "canonicalize leaked a verbatim path: {}",
        canonical.display()
    );
    assert!(canonical.ends_with("paper.tex"));
    // Roots and children stay in the same form, so `starts_with` still holds.
    let canonical_root = canonicalize(root.path()).expect("canonicalize root");
    assert!(canonical.starts_with(&canonical_root));
}
