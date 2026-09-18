use super::{
    decode_shell_output, execute_bash, set_test_foreground_shell_timeout_ms, BashCommandInput,
};
use crate::{
    managed_processes_snapshot,
    sandbox::FilesystemIsolationMode,
};
#[cfg(windows)]
use crate::sandbox::SandboxStatus;
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
    // The envelope reports the sandbox only when the sandbox constrained this
    // call. An "everything is unavailable on this platform" status is a
    // ~600-character constant that the model would otherwise be charged for on
    // every shell call of the session.
    assert!(
        output.sandbox_status.as_ref().is_none_or(sandbox_constrained),
        "{:?}",
        output.sandbox_status
    );
}

/// The contract [`super::reportable_sandbox_status`] enforces, written so the
/// assertions hold on a Linux host with a working `unshare` as well as on
/// Windows, where no backend exists at all.
fn sandbox_constrained(status: &crate::sandbox::SandboxStatus) -> bool {
    status.active || status.namespace_active || status.network_active || status.filesystem_active
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
        // This test verifies the foreground timeout and process cleanup. Keep
        // the Linux `unshare` launcher out of it: a PID namespace can retain
        // the output pipe after the shell is terminated, making CI wait for
        // the full default timeout instead of exercising the assertion.
        dangerously_disable_sandbox: Some(true),
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

    let pid = output
        .background_task_id
        .as_deref()
        .expect("a pid is returned")
        .parse::<u32>()
        .expect("background task id is numeric");
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

    // Registry removal is deliberately delayed until the reaper has dropped
    // its `Child` handle. That makes it safe to clean up a finished task's
    // workspace on Windows, where inherited log handles prevent deletion.
    let finished_by = Instant::now() + Duration::from_secs(5);
    while Instant::now() < finished_by
        && managed_processes_snapshot()
            .iter()
            .any(|process| process.pid == pid)
    {
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        managed_processes_snapshot()
            .iter()
            .all(|process| process.pid != pid),
        "finished background task {pid} should release its workspace handles"
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

    // A sandbox the caller turned off constrains nothing, so there is nothing
    // to report. The resolution itself (`enabled == false`) is asserted where
    // it is decided, in the sandbox module's own tests.
    assert!(
        output.sandbox_status.is_none(),
        "{:?}",
        output.sandbox_status
    );
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
    // Filesystem isolation has no enforcing backend on any platform, so a
    // request for it constrains nothing and is not reported on the envelope.
    // That the resolution still records `filesystem_active == false` with the
    // "filesystem isolation unavailable" fallback reason is asserted in the
    // sandbox module's own tests; what matters here is that HOME was not
    // redirected and no placeholder directories were created.
    assert!(
        output.sandbox_status.as_ref().is_none_or(sandbox_constrained),
        "{:?}",
        output.sandbox_status
    );
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

/// The model is charged for this envelope on every shell call, so a field with
/// nothing to say must not appear at all. Before this, a plain successful
/// command serialized eleven `null`s and a ~600-character sandbox status
/// describing the platform rather than the command.
#[test]
fn a_plain_result_envelope_carries_no_empty_fields() {
    let _guard = crate::test_env_lock();
    let output = execute_bash(BashCommandInput {
        command: String::from("printf 'hello'"),
        timeout: Some(5_000),
        description: None,
        run_in_background: Some(false),
        dangerously_disable_sandbox: None,
        namespace_restrictions: None,
        isolate_network: None,
        filesystem_mode: None,
        allowed_mounts: None,
    })
    .expect("bash command should execute");

    let value = serde_json::to_value(&output).expect("serialize envelope");
    let object = value.as_object().expect("envelope is an object");
    assert!(
        object.values().all(|field| !field.is_null()),
        "no field may serialize as null: {object:?}"
    );
    // The two always-present fields stay present even when empty: absence of
    // `stdout` would be read as "no output was captured" rather than "the
    // command printed nothing".
    assert!(object.contains_key("stdout"), "{object:?}");
    assert!(object.contains_key("interrupted"), "{object:?}");
    assert!(!object.contains_key("rawOutputPath"), "{object:?}");
    assert!(!object.contains_key("backgroundTaskId"), "{object:?}");
    assert!(!object.contains_key("structuredContent"), "{object:?}");
}

/// Older persisted envelopes were written with explicit nulls, and a session
/// log full of them still has to load.
#[test]
fn an_envelope_written_with_explicit_nulls_still_deserializes() {
    let legacy = serde_json::json!({
        "stdout": "hello",
        "stderr": "",
        "rawOutputPath": null,
        "interrupted": false,
        "isImage": null,
        "backgroundTaskId": null,
        "backgroundedByUser": null,
        "assistantAutoBackgrounded": null,
        "dangerouslyDisableSandbox": null,
        "returnCodeInterpretation": null,
        "noOutputExpected": null,
        "structuredContent": null,
        "persistedOutputPath": null,
        "persistedOutputSize": null,
        "sandboxStatus": null
    });

    let parsed: super::BashCommandOutput =
        serde_json::from_value(legacy).expect("legacy envelope must still load");
    assert_eq!(parsed.stdout, "hello");
    assert!(parsed.sandbox_status.is_none());

    // And so does one written after the change, with the keys simply absent.
    let slim = serde_json::json!({ "stdout": "hello", "stderr": "", "interrupted": false });
    let parsed: super::BashCommandOutput =
        serde_json::from_value(slim).expect("slim envelope must load");
    assert_eq!(parsed.stdout, "hello");
    assert!(parsed.raw_output_path.is_none());
}
