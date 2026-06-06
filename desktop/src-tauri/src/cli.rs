use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::state;

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRunRequest {
    pub args: Vec<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRunOutput {
    pub command: String,
    pub executable: String,
    pub cwd: String,
    pub code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
    pub elapsed_ms: u128,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
pub fn cli_run(app: tauri::AppHandle, req: CliRunRequest) -> Result<CliRunOutput, String> {
    let args = sanitize_args(req.args)?;
    let executable = resolve_aris_binary(&app)?;
    let cwd = state::workspace_dir();
    std::fs::create_dir_all(&cwd).map_err(|err| format!("create workspace: {err}"))?;
    let timeout = Duration::from_millis(
        req.timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS),
    );

    let mut command = Command::new(&executable);
    command
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let start = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|err| format!("start `{}`: {err}", display_executable(&executable)))?;

    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(err) => return Err(format!("wait for CLI process: {err}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|err| format!("collect CLI output: {err}"))?;
    let elapsed_ms = start.elapsed().as_millis();
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let code = output.status.code();
    let success = output.status.success() && !timed_out;

    Ok(CliRunOutput {
        command: format_command(&args),
        executable: display_executable(&executable),
        cwd: cwd.display().to_string(),
        code,
        success,
        timed_out,
        elapsed_ms,
        stdout,
        stderr,
    })
}

fn sanitize_args(args: Vec<String>) -> Result<Vec<String>, String> {
    let mut out = args
        .into_iter()
        .map(|arg| arg.trim().to_string())
        .filter(|arg| !arg.is_empty())
        .collect::<Vec<_>>();

    if out
        .first()
        .is_some_and(|arg| arg.eq_ignore_ascii_case("aris") || arg.eq_ignore_ascii_case("aris.exe"))
    {
        out.remove(0);
    }

    if out.is_empty() {
        return Err("empty CLI command would start the interactive REPL; use Chat in the desktop app instead".to_string());
    }

    Ok(out)
}

fn resolve_aris_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("ARIS_CLI_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        for name in resource_names() {
            let candidate = resource_dir.join("bin").join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    for candidate in dev_candidates() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Ok(PathBuf::from(binary_name()))
}

fn dev_candidates() -> Vec<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut candidates = Vec::new();
    for profile in ["release", "debug"] {
        for name in resource_names() {
            candidates.push(root.join("target").join(profile).join(name));
        }
    }
    candidates
}

#[cfg(windows)]
fn binary_name() -> &'static str {
    "aris.exe"
}

#[cfg(not(windows))]
fn binary_name() -> &'static str {
    "aris"
}

#[cfg(windows)]
fn resource_names() -> &'static [&'static str] {
    &["aris.exe", "aris"]
}

#[cfg(not(windows))]
fn resource_names() -> &'static [&'static str] {
    &["aris"]
}

fn format_command(args: &[String]) -> String {
    let mut parts = vec!["aris".to_string()];
    parts.extend(args.iter().map(|arg| quote_arg(arg)));
    parts.join(" ")
}

fn quote_arg(arg: &str) -> String {
    if arg
        .chars()
        .all(|ch| !ch.is_whitespace() && ch != '"' && ch != '\'')
    {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('\\', "\\\\").replace('"', "\\\""))
}

fn display_executable(path: &Path) -> String {
    path.display().to_string()
}
