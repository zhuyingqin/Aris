use super::{
    decode_shell_output, execute_bash, set_test_foreground_shell_timeout_ms, BashCommandInput,
};
use crate::sandbox::{FilesystemIsolationMode, SandboxStatus};
use encoding_rs::GBK;
use std::fs;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[test]
fn decodes_cp936_shell_output_without_corrupting_chinese_paths() {
    let expected = "F:\\论文\\基准\\outputs\\fig_concept.png";
    let (bytes, _, had_errors) = GBK.encode(expected);
    assert!(!had_errors);

    assert_eq!(decode_shell_output(&bytes), expected);
}

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
fn shell_backgrounded_service_returns_with_a_hint_instead_of_hanging() {
    let _guard = crate::test_env_lock();
    #[cfg(windows)]
    if !super::windows_shell_launcher().posix {
        return;
    }
    let started = Instant::now();
    let output = execute_bash(BashCommandInput {
        // The shell exits at once, but the backgrounded job inherits the
        // command's stdout pipe — the shape of every `npm run dev &`.
        command: String::from("sleep 20 & printf 'server started'"),
        timeout: Some(60_000),
        description: None,
        run_in_background: Some(false),
        dangerously_disable_sandbox: Some(false),
        namespace_restrictions: Some(false),
        isolate_network: Some(false),
        filesystem_mode: Some(FilesystemIsolationMode::WorkspaceOnly),
        allowed_mounts: None,
    })
    .expect("bash command should return");

    assert!(
        started.elapsed() < Duration::from_secs(30),
        "a backgrounded service must not hold the shell tool open"
    );
    assert!(!output.interrupted);
    assert!(output.stdout.contains("server started"));
    assert!(output
        .stderr
        .contains("still holds this command's output pipe"));
}

#[test]
fn background_commands_capture_their_output_to_a_readable_log() {
    let _guard = crate::test_env_lock();
    let previous = std::env::current_dir().expect("current dir");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("somniq-bash-background-{nanos}"));
    fs::create_dir_all(&root).expect("create temp workspace");
    std::env::set_current_dir(&root).expect("enter temp workspace");

    let output = execute_bash(BashCommandInput {
        command: String::from("printf 'listening on 5173'"),
        timeout: None,
        description: None,
        run_in_background: Some(true),
        dangerously_disable_sandbox: Some(false),
        namespace_restrictions: Some(false),
        isolate_network: Some(false),
        filesystem_mode: Some(FilesystemIsolationMode::WorkspaceOnly),
        allowed_mounts: None,
    })
    .expect("background command should start");

    std::env::set_current_dir(previous).expect("restore cwd");

    assert!(output.background_task_id.is_some(), "a pid is returned");
    let log = output
        .persisted_output_path
        .clone()
        .expect("a background command should report where its output goes");
    assert_eq!(output.raw_output_path.as_deref(), Some(log.as_str()));

    // The process is detached, so the banner shows up shortly after the call.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut captured = String::new();
    while Instant::now() < deadline {
        captured = fs::read_to_string(&log).unwrap_or_default();
        if captured.contains("listening on 5173") {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        captured.contains("listening on 5173"),
        "the service's own output must be readable while it runs: {captured:?}"
    );

    fs::remove_dir_all(root).expect("cleanup temp workspace");
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
