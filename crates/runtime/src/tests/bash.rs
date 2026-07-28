use super::{execute_bash, set_test_foreground_shell_timeout_ms, BashCommandInput};
use crate::sandbox::{FilesystemIsolationMode, SandboxStatus};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn executes_simple_command() {
    let _guard = crate::test_env_lock();
    let output = execute_bash(BashCommandInput {
        command: String::from("printf 'hello'"),
        // Git Bash startup on Windows can consume most of a one-second test
        // budget before the shell reaches the command. This verifies shell
        // availability rather than launcher latency.
        timeout: Some(5_000),
        description: None,
        run_in_background: Some(false),
        dangerously_disable_sandbox: Some(false),
        namespace_restrictions: Some(false),
        isolate_network: Some(false),
        filesystem_mode: Some(FilesystemIsolationMode::WorkspaceOnly),
        allowed_mounts: None,
    })
    .expect("bash command should execute");

    assert_eq!(output.stdout, "hello");
    assert!(!output.interrupted);
    assert!(output.sandbox_status.is_some());
}

#[test]
fn executes_standard_posix_utilities() {
    let _guard = crate::test_env_lock();
    let output = execute_bash(BashCommandInput {
        command: String::from("printf 'alpha\\nbeta\\n' | tail -n 1"),
        // Git Bash startup on Windows can consume most of a one-second test
        // budget before the shell reaches the pipeline. This verifies POSIX
        // utility availability rather than shell launch latency.
        timeout: Some(5_000),
        description: None,
        run_in_background: Some(false),
        dangerously_disable_sandbox: Some(false),
        namespace_restrictions: Some(false),
        isolate_network: Some(false),
        filesystem_mode: Some(FilesystemIsolationMode::WorkspaceOnly),
        allowed_mounts: None,
    })
    .expect("bash command should execute standard POSIX utilities");

    assert_eq!(output.stdout, "beta\n");
    assert_eq!(output.return_code_interpretation, None);
}

#[cfg(windows)]
#[test]
fn finds_git_bash_next_to_git_cmd_path_entry() {
    let candidates = super::git_bash_candidates_from_paths(vec![std::path::PathBuf::from(
        r"E:\Program Files\Git\cmd",
    )]);

    assert_eq!(candidates, vec![r"E:\Program Files\Git\bin\bash.exe"]);
}

#[cfg(windows)]
#[test]
fn disabled_sandbox_preserves_user_home_for_posix_shell() {
    if !super::windows_shell_launcher().posix {
        return;
    }
    let status = SandboxStatus::default();
    let command = super::prepare_command("printf ok", std::path::Path::new("."), &status, false);

    assert!(
        command
            .get_envs()
            .all(|(name, _)| name.to_string_lossy() != "HOME"),
        "a disabled filesystem sandbox must inherit the user's HOME"
    );
}

#[cfg(windows)]
#[test]
fn active_filesystem_sandbox_redirects_posix_home() {
    if !super::windows_shell_launcher().posix {
        return;
    }
    let status = SandboxStatus {
        enabled: true,
        filesystem_active: true,
        filesystem_mode: FilesystemIsolationMode::WorkspaceOnly,
        ..SandboxStatus::default()
    };
    let command = super::prepare_command("printf ok", std::path::Path::new("."), &status, false);

    assert!(command
        .get_envs()
        .any(|(name, value)| { name.to_string_lossy() == "HOME" && value.is_some() }));
}

#[test]
fn default_timeout_prevents_foreground_hangs() {
    let _guard = crate::test_env_lock();
    set_test_foreground_shell_timeout_ms(10);
    let output = execute_bash(BashCommandInput {
        command: String::from("sleep 1"),
        timeout: None,
        description: None,
        run_in_background: Some(false),
        dangerously_disable_sandbox: Some(false),
        namespace_restrictions: Some(false),
        isolate_network: Some(false),
        filesystem_mode: Some(FilesystemIsolationMode::WorkspaceOnly),
        allowed_mounts: None,
    })
    .expect("bash command should return a timeout result");
    set_test_foreground_shell_timeout_ms(0);

    assert!(output.interrupted);
    assert_eq!(
        output.return_code_interpretation.as_deref(),
        Some("timeout")
    );
    assert!(output.stderr.contains("Command exceeded timeout of 10 ms"));
}

#[test]
fn disables_sandbox_when_requested() {
    let _guard = crate::test_env_lock();
    let output = execute_bash(BashCommandInput {
        command: String::from("printf 'hello'"),
        timeout: Some(5_000),
        description: None,
        run_in_background: Some(false),
        dangerously_disable_sandbox: Some(true),
        namespace_restrictions: None,
        isolate_network: None,
        filesystem_mode: None,
        allowed_mounts: None,
    })
    .expect("bash command should execute");

    assert!(!output.sandbox_status.expect("sandbox status").enabled);
}

#[test]
fn unavailable_filesystem_sandbox_does_not_redirect_home_or_create_placeholder_dirs() {
    let _guard = crate::test_env_lock();
    let previous = std::env::current_dir().expect("current dir");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("somniq-bash-sandbox-{nanos}"));
    fs::create_dir_all(&root).expect("create temp workspace");
    std::env::set_current_dir(&root).expect("enter temp workspace");

    let output = execute_bash(BashCommandInput {
        command: String::from("printf 'hello'"),
        timeout: Some(1_000),
        description: None,
        run_in_background: Some(false),
        dangerously_disable_sandbox: Some(false),
        namespace_restrictions: Some(false),
        isolate_network: Some(false),
        filesystem_mode: Some(FilesystemIsolationMode::WorkspaceOnly),
        allowed_mounts: None,
    })
    .expect("bash command should execute");

    assert_eq!(output.stdout, "hello");
    let status = output.sandbox_status.expect("sandbox status");
    assert!(!status.filesystem_active);
    assert!(status
        .fallback_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("filesystem isolation unavailable")));
    assert!(!root
        .join(".somniq")
        .join("tmp")
        .join("sandbox")
        .join("home")
        .is_dir());
    assert!(!root
        .join(".somniq")
        .join("tmp")
        .join("sandbox")
        .join("tmp")
        .is_dir());
    assert!(!root.join(".sandbox-home").exists());
    assert!(!root.join(".sandbox-tmp").exists());

    std::env::set_current_dir(previous).expect("restore cwd");
    fs::remove_dir_all(root).expect("cleanup temp workspace");
}
