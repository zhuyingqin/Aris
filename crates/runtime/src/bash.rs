use std::env;
use std::io;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

use crate::sandbox::{
    build_linux_sandbox_command, resolve_sandbox_status_for_request, FilesystemIsolationMode,
    SandboxConfig, SandboxStatus,
};
use crate::{hidden_command, ConfigLoader};
use serde::{Deserialize, Serialize};

const DEFAULT_FOREGROUND_SHELL_TIMEOUT_MS: u64 = 120_000;
const SHELL_DEFAULT_TIMEOUT_ENV: &str = "ARIS_SHELL_DEFAULT_TIMEOUT_MS";

#[cfg(test)]
static TEST_FOREGROUND_SHELL_TIMEOUT_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BashCommandInput {
    pub command: String,
    pub timeout: Option<u64>,
    pub description: Option<String>,
    #[serde(rename = "run_in_background")]
    pub run_in_background: Option<bool>,
    #[serde(rename = "dangerouslyDisableSandbox")]
    pub dangerously_disable_sandbox: Option<bool>,
    #[serde(rename = "namespaceRestrictions")]
    pub namespace_restrictions: Option<bool>,
    #[serde(rename = "isolateNetwork")]
    pub isolate_network: Option<bool>,
    #[serde(rename = "filesystemMode")]
    pub filesystem_mode: Option<FilesystemIsolationMode>,
    #[serde(rename = "allowedMounts")]
    pub allowed_mounts: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BashCommandOutput {
    pub stdout: String,
    pub stderr: String,
    #[serde(rename = "rawOutputPath")]
    pub raw_output_path: Option<String>,
    pub interrupted: bool,
    #[serde(rename = "isImage")]
    pub is_image: Option<bool>,
    #[serde(rename = "backgroundTaskId")]
    pub background_task_id: Option<String>,
    #[serde(rename = "backgroundedByUser")]
    pub backgrounded_by_user: Option<bool>,
    #[serde(rename = "assistantAutoBackgrounded")]
    pub assistant_auto_backgrounded: Option<bool>,
    #[serde(rename = "dangerouslyDisableSandbox")]
    pub dangerously_disable_sandbox: Option<bool>,
    #[serde(rename = "returnCodeInterpretation")]
    pub return_code_interpretation: Option<String>,
    #[serde(rename = "noOutputExpected")]
    pub no_output_expected: Option<bool>,
    #[serde(rename = "structuredContent")]
    pub structured_content: Option<Vec<serde_json::Value>>,
    #[serde(rename = "persistedOutputPath")]
    pub persisted_output_path: Option<String>,
    #[serde(rename = "persistedOutputSize")]
    pub persisted_output_size: Option<u64>,
    #[serde(rename = "sandboxStatus")]
    pub sandbox_status: Option<SandboxStatus>,
}

pub fn execute_bash(input: BashCommandInput) -> io::Result<BashCommandOutput> {
    execute_bash_with_cancel(input, || false)
}

pub fn execute_bash_with_cancel(
    input: BashCommandInput,
    should_cancel: impl Fn() -> bool,
) -> io::Result<BashCommandOutput> {
    execute_bash_with_cancel_and_progress(input, should_cancel, |_| {})
}

pub fn execute_bash_with_cancel_and_progress(
    input: BashCommandInput,
    should_cancel: impl Fn() -> bool,
    on_progress: impl FnMut(crate::ManagedCommandProgress),
) -> io::Result<BashCommandOutput> {
    // Pre-execution safety check
    if let Some(rejection) = check_dangerous_command(&input.command) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, rejection));
    }
    let cwd = env::current_dir()?;
    let sandbox_status = sandbox_status_for_input(&input, &cwd);
    if should_cancel() {
        return Ok(interrupted_output(
            String::new(),
            String::from("Command interrupted by user"),
            Some(String::from("interrupted")),
            input.dangerously_disable_sandbox,
            sandbox_status,
        ));
    }

    if input.run_in_background.unwrap_or(false) {
        let mut child = prepare_command(&input.command, &cwd, &sandbox_status, false);
        child
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let pid = crate::spawn_managed_background(
            &mut child,
            format!("bash background: {}", truncate_label(&input.command)),
        )?;

        return Ok(BashCommandOutput {
            stdout: String::new(),
            stderr: String::new(),
            raw_output_path: None,
            interrupted: false,
            is_image: None,
            background_task_id: Some(pid.to_string()),
            backgrounded_by_user: Some(false),
            assistant_auto_backgrounded: Some(false),
            dangerously_disable_sandbox: input.dangerously_disable_sandbox,
            return_code_interpretation: None,
            no_output_expected: Some(true),
            structured_content: None,
            persisted_output_path: None,
            persisted_output_size: None,
            sandbox_status: Some(sandbox_status),
        });
    }

    execute_bash_blocking(input, sandbox_status, cwd, should_cancel, on_progress)
}

fn execute_bash_blocking(
    input: BashCommandInput,
    sandbox_status: SandboxStatus,
    cwd: std::path::PathBuf,
    should_cancel: impl Fn() -> bool,
    on_progress: impl FnMut(crate::ManagedCommandProgress),
) -> io::Result<BashCommandOutput> {
    let mut command = prepare_command(&input.command, &cwd, &sandbox_status, true);
    let timeout_ms = resolve_foreground_shell_timeout_ms(input.timeout);
    let result = crate::run_managed_command_with_cancel_and_progress(
        &mut command,
        format!("bash: {}", truncate_label(&input.command)),
        Some(Duration::from_millis(timeout_ms)),
        true,
        should_cancel,
        on_progress,
    )?;

    if result.timed_out {
        return Ok(interrupted_output(
            String::from_utf8_lossy(&result.stdout).into_owned(),
            append_status_message(
                String::from_utf8_lossy(&result.stderr).into_owned(),
                format!("Command exceeded timeout of {timeout_ms} ms"),
            ),
            Some(String::from("timeout")),
            input.dangerously_disable_sandbox,
            sandbox_status,
        ));
    }
    if result.interrupted {
        return Ok(interrupted_output(
            String::from_utf8_lossy(&result.stdout).into_owned(),
            append_status_message(
                String::from_utf8_lossy(&result.stderr).into_owned(),
                String::from("Command interrupted by user"),
            ),
            Some(String::from("interrupted")),
            input.dangerously_disable_sandbox,
            sandbox_status,
        ));
    }

    let stdout = String::from_utf8_lossy(&result.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&result.stderr).into_owned();
    let no_output_expected = Some(stdout.trim().is_empty() && stderr.trim().is_empty());
    let return_code_interpretation = result.status.code().and_then(|code| {
        if code == 0 {
            None
        } else {
            Some(format!("exit_code:{code}"))
        }
    });

    Ok(BashCommandOutput {
        stdout,
        stderr,
        raw_output_path: None,
        interrupted: false,
        is_image: None,
        background_task_id: None,
        backgrounded_by_user: None,
        assistant_auto_backgrounded: None,
        dangerously_disable_sandbox: input.dangerously_disable_sandbox,
        return_code_interpretation,
        no_output_expected,
        structured_content: None,
        persisted_output_path: None,
        persisted_output_size: None,
        sandbox_status: Some(sandbox_status),
    })
}

fn append_status_message(stderr: String, message: String) -> String {
    if stderr.trim().is_empty() {
        message
    } else {
        format!("{}\n{message}", stderr.trim_end())
    }
}

fn truncate_label(value: &str) -> String {
    const MAX: usize = 120;
    if value.chars().count() <= MAX {
        value.to_string()
    } else {
        let head = value.chars().take(MAX).collect::<String>();
        format!("{head}...")
    }
}

fn interrupted_output(
    stdout: String,
    stderr: String,
    return_code_interpretation: Option<String>,
    dangerously_disable_sandbox: Option<bool>,
    sandbox_status: SandboxStatus,
) -> BashCommandOutput {
    BashCommandOutput {
        stdout,
        stderr,
        raw_output_path: None,
        interrupted: true,
        is_image: None,
        background_task_id: None,
        backgrounded_by_user: None,
        assistant_auto_backgrounded: None,
        dangerously_disable_sandbox,
        return_code_interpretation,
        no_output_expected: Some(true),
        structured_content: None,
        persisted_output_path: None,
        persisted_output_size: None,
        sandbox_status: Some(sandbox_status),
    }
}

fn sandbox_status_for_input(input: &BashCommandInput, cwd: &std::path::Path) -> SandboxStatus {
    let config = ConfigLoader::default_for(cwd).load().map_or_else(
        |_| SandboxConfig::default(),
        |runtime_config| runtime_config.sandbox().clone(),
    );

    // v0.4.12 #238 — when the user has set `sandbox.strictMode: true` in
    // their config and the LLM tool call nonetheless requests
    // `dangerouslyDisableSandbox: true` (or any other override that
    // contradicts strict policy), emit a one-shot per-process warning
    // so the user can see their config is being honoured. The actual
    // request is resolved below by SandboxConfig::resolve_request which
    // already drops all LLM overrides in strict mode.
    if config.is_strict() && input_attempts_to_relax_sandbox(input) {
        warn_strict_sandbox_override();
    }

    let request = config.resolve_request(
        input.dangerously_disable_sandbox.map(|disabled| !disabled),
        input.namespace_restrictions,
        input.isolate_network,
        input.filesystem_mode,
        input.allowed_mounts.clone(),
    );
    resolve_sandbox_status_for_request(&request, cwd)
}

/// v0.4.12 #238 — `true` when the bash tool call carries any sandbox
/// override the LLM might use to relax policy. Used to gate the
/// strictMode warning so we only complain when there's an actual
/// conflict to flag.
fn input_attempts_to_relax_sandbox(input: &BashCommandInput) -> bool {
    input.dangerously_disable_sandbox == Some(true)
        || input.namespace_restrictions == Some(false)
        || input.isolate_network == Some(false)
        || input.filesystem_mode.is_some()
        || input.allowed_mounts.is_some()
}

/// v0.4.12 #238 — one-shot per-process stderr warning when strict
/// sandbox policy silently overrides a LLM tool-call override. Per-process
/// not per-session so a long-running REPL doesn't spam the user.
fn warn_strict_sandbox_override() {
    static WARNED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    WARNED.get_or_init(|| {
        eprintln!(
            "\x1b[33mwarning:\x1b[0m sandbox.strictMode is enabled; \
             LLM-requested sandbox override (e.g. `dangerouslyDisableSandbox: true`) \
             is being ignored. Set `sandbox.strictMode: false` (or remove the field) \
             in your config to allow LLM overrides."
        );
    });
}

#[must_use]
pub fn resolve_foreground_shell_timeout_ms(timeout: Option<u64>) -> u64 {
    timeout.unwrap_or_else(default_foreground_shell_timeout_ms)
}

fn default_foreground_shell_timeout_ms() -> u64 {
    #[cfg(test)]
    {
        let override_ms =
            TEST_FOREGROUND_SHELL_TIMEOUT_MS.load(std::sync::atomic::Ordering::SeqCst);
        if override_ms > 0 {
            return override_ms;
        }
    }

    env::var(SHELL_DEFAULT_TIMEOUT_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_FOREGROUND_SHELL_TIMEOUT_MS)
}

#[cfg(test)]
fn set_test_foreground_shell_timeout_ms(timeout_ms: u64) {
    TEST_FOREGROUND_SHELL_TIMEOUT_MS.store(timeout_ms, std::sync::atomic::Ordering::SeqCst);
}

fn prepare_command(
    command: &str,
    cwd: &std::path::Path,
    sandbox_status: &SandboxStatus,
    create_dirs: bool,
) -> Command {
    if create_dirs {
        prepare_sandbox_dirs(cwd);
    }

    if let Some(launcher) = build_linux_sandbox_command(command, cwd, sandbox_status) {
        let mut prepared = hidden_command(launcher.program);
        prepared.args(launcher.args);
        prepared.current_dir(cwd);
        prepared.envs(launcher.env);
        return prepared;
    }

    if cfg!(windows) {
        let launcher = windows_shell_launcher();
        if launcher.posix {
            prepare_sandbox_dirs(cwd);
        }
        let mut prepared = hidden_command(&launcher.program);
        prepared.args(launcher.args).arg(command).current_dir(cwd);
        if launcher.posix {
            prepared.env("HOME", crate::somniq_sandbox_home_dir(cwd));
            prepared.env("TMPDIR", crate::somniq_sandbox_tmp_dir(cwd));
        }
        return prepared;
    }

    let mut prepared = hidden_command("sh");
    prepared.arg("-lc").arg(command).current_dir(cwd);
    if sandbox_status.filesystem_active {
        prepared.env("HOME", crate::somniq_sandbox_home_dir(cwd));
        prepared.env("TMPDIR", crate::somniq_sandbox_tmp_dir(cwd));
    }
    prepared
}

fn prepare_sandbox_dirs(cwd: &std::path::Path) {
    let _ = std::fs::create_dir_all(crate::somniq_sandbox_home_dir(cwd));
    let _ = std::fs::create_dir_all(crate::somniq_sandbox_tmp_dir(cwd));
}

#[derive(Clone)]
struct WindowsShellLauncher {
    program: String,
    args: &'static [&'static str],
    posix: bool,
}

fn windows_shell_launcher() -> WindowsShellLauncher {
    if let Some(program) = detect_windows_posix_shell() {
        WindowsShellLauncher {
            program,
            args: &["-c"],
            posix: true,
        }
    } else {
        WindowsShellLauncher {
            program: String::from("cmd"),
            args: &["/C"],
            posix: false,
        }
    }
}

fn detect_windows_posix_shell() -> Option<String> {
    static DETECTED: OnceLock<Option<String>> = OnceLock::new();
    DETECTED
        .get_or_init(|| {
            let candidates = [
                String::from("bash"),
                String::from("sh"),
                String::from(r"C:\Program Files\Git\bin\bash.exe"),
                String::from(r"C:\Program Files\Git\usr\bin\bash.exe"),
                String::from(r"C:\msys64\usr\bin\bash.exe"),
                String::from(r"C:\cygwin64\bin\bash.exe"),
            ];
            candidates
                .into_iter()
                .find(|candidate| usable_posix_shell(candidate))
        })
        .clone()
}

fn usable_posix_shell(candidate: &str) -> bool {
    const MARKER: &str = "__aris_posix_shell__";
    let Ok(output) = hidden_command(candidate)
        .arg("-c")
        .arg(format!("printf {MARKER}"))
        .env("HOME", env::temp_dir())
        .output()
    else {
        return false;
    };
    output.status.success() && String::from_utf8_lossy(&output.stdout) == MARKER
}

/// Check for dangerous bash command patterns. Returns rejection reason or None.
fn check_dangerous_command(command: &str) -> Option<String> {
    let normalized = command.to_ascii_lowercase();
    let tokens: Vec<&str> = normalized.split_whitespace().collect();

    // Patterns that are always dangerous
    const DANGEROUS_PATTERNS: &[(&str, &str)] = &[
        ("rm -rf /", "recursive deletion of root filesystem"),
        ("rm -rf /*", "recursive deletion of root filesystem"),
        ("rm -rf ~", "recursive deletion of home directory"),
        ("mkfs", "filesystem formatting"),
        ("dd if=/dev/zero", "disk overwrite"),
        ("dd if=/dev/random", "disk overwrite"),
        (":(){:|:&};:", "fork bomb"),
        ("chmod -r 777 /", "recursive permission change on root"),
        ("chown -r", "recursive ownership change"),
    ];

    for (pattern, reason) in DANGEROUS_PATTERNS {
        if normalized.contains(pattern) {
            return Some(format!(
                "Blocked: command matches dangerous pattern ({reason}): {pattern}"
            ));
        }
    }

    // Check for sudo + destructive commands
    if tokens.first() == Some(&"sudo") || normalized.contains("| sudo") {
        let after_sudo = if tokens.first() == Some(&"sudo") {
            tokens.get(1).copied().unwrap_or("")
        } else {
            // Find command after "| sudo"
            normalized
                .split("| sudo")
                .nth(1)
                .and_then(|s| s.split_whitespace().next())
                .unwrap_or("")
        };
        const SUDO_BLOCKED: &[&str] = &["rm", "mkfs", "dd", "chmod", "chown", "fdisk", "parted"];
        if SUDO_BLOCKED.iter().any(|cmd| after_sudo == *cmd) {
            return Some(format!(
                "Blocked: sudo with destructive command '{after_sudo}'"
            ));
        }
    }

    None
}

#[cfg(test)]
#[path = "tests/bash.rs"]
mod tests;
