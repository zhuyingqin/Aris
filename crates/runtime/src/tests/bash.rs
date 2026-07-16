use super::{execute_bash, set_test_foreground_shell_timeout_ms, BashCommandInput};
use crate::sandbox::FilesystemIsolationMode;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn executes_simple_command() {
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
    assert!(!output.interrupted);
    assert!(output.sandbox_status.is_some());
}

#[test]
fn executes_standard_posix_utilities() {
    let output = execute_bash(BashCommandInput {
        command: String::from("printf 'alpha\\nbeta\\n' | tail -n 1"),
        timeout: Some(1_000),
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
    let output = execute_bash(BashCommandInput {
        command: String::from("printf 'hello'"),
        timeout: Some(1_000),
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
fn sandbox_dirs_are_under_somniq_tmp() {
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
    assert!(root
        .join(".somniq")
        .join("tmp")
        .join("sandbox")
        .join("home")
        .is_dir());
    assert!(root
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
