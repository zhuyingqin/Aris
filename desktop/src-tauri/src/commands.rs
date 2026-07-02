//! Small Tauri command surface for app-level metadata.

use crate::state;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[tauri::command]
pub fn skills_list() -> Vec<tools::SkillMeta> {
    tools::discover_skills()
}

#[tauri::command]
pub fn skill_view(name: String) -> Result<String, String> {
    tools::skill_markdown(&name).ok_or_else(|| format!("skill not found: {name}"))
}

#[tauri::command]
pub fn state_dir() -> String {
    state::state_root().display().to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEnvironmentCheck {
    pub id: String,
    pub label: String,
    pub category: String,
    pub status: String,
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub message: String,
    pub detail: Option<String>,
}

struct ProbeOutput {
    ok: bool,
    stdout: String,
    stderr: String,
    message: String,
}

fn compact_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(160).collect())
}

fn command_path(program: &str) -> Option<String> {
    if Path::new(program).is_file() {
        return Some(program.to_string());
    }

    #[cfg(target_os = "windows")]
    let mut locator = Command::new("where.exe");
    #[cfg(target_os = "windows")]
    locator.arg(program);

    #[cfg(not(target_os = "windows"))]
    let mut locator = Command::new("which");
    #[cfg(not(target_os = "windows"))]
    locator.arg(program);

    locator
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|text| compact_line(&text))
}

fn run_probe(program: &str, args: &[&str], timeout: Duration) -> ProbeOutput {
    let mut child = match crate::process::hidden_command(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return ProbeOutput {
                ok: false,
                stdout: String::new(),
                stderr: String::new(),
                message: error.to_string(),
            };
        }
    };

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                return ProbeOutput {
                    ok: status.success(),
                    stdout,
                    stderr,
                    message: status.to_string(),
                };
            }
            Ok(None) if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return ProbeOutput {
                    ok: false,
                    stdout: String::new(),
                    stderr: String::new(),
                    message: "version check timed out".to_string(),
                };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                return ProbeOutput {
                    ok: false,
                    stdout: String::new(),
                    stderr: String::new(),
                    message: error.to_string(),
                };
            }
        }
    }
}

fn first_successful_probe(
    id: &str,
    label: &str,
    category: &str,
    candidates: &[(&str, &[&str])],
    timeout: Duration,
    missing_message: &str,
) -> LocalEnvironmentCheck {
    let mut last_message = String::new();
    for (program, args) in candidates {
        let output = run_probe(program, args, timeout);
        let version = compact_line(&output.stdout).or_else(|| compact_line(&output.stderr));
        let path = command_path(program);
        if output.ok || version.is_some() {
            return LocalEnvironmentCheck {
                id: id.to_string(),
                label: label.to_string(),
                category: category.to_string(),
                status: "ready".to_string(),
                available: true,
                version,
                path,
                message: "已检测到可用环境".to_string(),
                detail: Some(program.to_string()),
            };
        }
        if path.is_some() {
            return LocalEnvironmentCheck {
                id: id.to_string(),
                label: label.to_string(),
                category: category.to_string(),
                status: "warning".to_string(),
                available: true,
                version,
                path,
                message: "已找到可执行文件，但版本查询未完成".to_string(),
                detail: Some(output.message),
            };
        }
        last_message = output.message;
    }

    LocalEnvironmentCheck {
        id: id.to_string(),
        label: label.to_string(),
        category: category.to_string(),
        status: "missing".to_string(),
        available: false,
        version: None,
        path: None,
        message: missing_message.to_string(),
        detail: if last_message.is_empty() {
            None
        } else {
            Some(last_message)
        },
    }
}

fn latex_check() -> LocalEnvironmentCheck {
    let mut candidates: Vec<(String, Vec<&'static str>)> = Vec::new();
    let configured_tectonic =
        std::env::var("SOMNIQ_TECTONIC").or_else(|_| std::env::var("ARIS_TECTONIC"));
    if let Ok(tectonic) = configured_tectonic {
        if !tectonic.trim().is_empty() {
            candidates.push((tectonic, vec!["--version"]));
        }
    }
    candidates.extend([
        ("tectonic".to_string(), vec!["--version"]),
        ("latexmk".to_string(), vec!["--version"]),
        ("xelatex".to_string(), vec!["--version"]),
        ("pdflatex".to_string(), vec!["--version"]),
    ]);

    let borrowed = candidates
        .iter()
        .map(|(program, args)| (program.as_str(), args.as_slice()))
        .collect::<Vec<_>>();
    first_successful_probe(
        "latex",
        "LaTeX",
        "论文排版",
        &borrowed,
        Duration::from_secs(3),
        "未检测到 LaTeX/Tectonic，可安装 TeX Live、MiKTeX 或使用内置 Tectonic。",
    )
}

fn push_candidate_path(candidates: &mut Vec<String>, path: PathBuf) {
    if path.is_file() {
        let value = path.display().to_string();
        if !candidates.iter().any(|candidate| candidate == &value) {
            candidates.push(value);
        }
    }
}

fn scan_matlab_roots(candidates: &mut Vec<String>, roots: &[PathBuf]) {
    let mut discovered = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if name.starts_with('R') {
                discovered.push(path);
            }
        }
    }
    discovered.sort();
    discovered.reverse();
    for root in discovered {
        push_candidate_path(candidates, root.join("bin").join(matlab_binary_name()));
    }
}

fn matlab_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "matlab.exe"
    } else {
        "matlab"
    }
}

#[cfg(target_os = "windows")]
fn push_matlab_registry_roots(programs: &mut Vec<String>) {
    for root in [
        r"HKLM\SOFTWARE\MathWorks\MATLAB",
        r"HKLM\SOFTWARE\WOW6432Node\MathWorks\MATLAB",
        r"HKCU\SOFTWARE\MathWorks\MATLAB",
    ] {
        let output = crate::process::hidden_command("reg.exe")
            .args(["query", root, "/s", "/v", "MATLABROOT"])
            .output();
        let Ok(output) = output else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with("MATLABROOT") {
                continue;
            }
            let Some((_, value)) = trimmed.split_once("REG_SZ") else {
                continue;
            };
            let root = value.trim();
            if !root.is_empty() {
                push_candidate_path(
                    programs,
                    PathBuf::from(root).join("bin").join(matlab_binary_name()),
                );
            }
        }
    }
}

fn matlab_candidates() -> Vec<(String, Vec<&'static str>)> {
    let mut programs = Vec::new();
    for key in [
        "SOMNIQ_MATLAB",
        "ARIS_MATLAB",
        "MATLAB",
        "MATLABROOT",
        "MATLAB_ROOT",
    ] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                continue;
            }
            let path = PathBuf::from(trimmed);
            if path.is_file() {
                push_candidate_path(&mut programs, path);
            } else {
                push_candidate_path(&mut programs, path.join("bin").join(matlab_binary_name()));
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        push_matlab_registry_roots(&mut programs);
        let mut roots = vec![PathBuf::from(r"C:\Program Files\MATLAB")];
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            roots.push(PathBuf::from(program_files).join("MATLAB"));
        }
        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            roots.push(PathBuf::from(program_files_x86).join("MATLAB"));
        }
        scan_matlab_roots(&mut programs, &roots);
    }

    #[cfg(target_os = "macos")]
    {
        let mut app_bins = Vec::new();
        if let Ok(entries) = std::fs::read_dir("/Applications") {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if name.starts_with("MATLAB_R") && name.ends_with(".app") {
                    app_bins.push(path.join("bin").join("matlab"));
                }
            }
        }
        app_bins.sort();
        app_bins.reverse();
        for path in app_bins {
            push_candidate_path(&mut programs, path);
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        scan_matlab_roots(&mut programs, &[PathBuf::from("/usr/local/MATLAB")]);
    }

    programs.push("matlab".to_string());
    programs
        .into_iter()
        .map(|program| (program, vec!["-batch", "disp(version)"]))
        .collect()
}

fn environment_checks_blocking() -> Vec<LocalEnvironmentCheck> {
    let matlab_candidates = matlab_candidates();
    let matlab_borrowed = matlab_candidates
        .iter()
        .map(|(program, args)| (program.as_str(), args.as_slice()))
        .collect::<Vec<_>>();
    vec![
        first_successful_probe(
            "python",
            "Python",
            "运行环境",
            &[
                ("python", &["--version"]),
                ("python3", &["--version"]),
                ("py", &["--version"]),
            ],
            Duration::from_secs(2),
            "未检测到 Python，可安装 Python 3 并加入 PATH。",
        ),
        first_successful_probe(
            "jupyter",
            "Jupyter",
            "Notebook",
            &[("jupyter", &["--version"]), ("jupyter-lab", &["--version"])],
            Duration::from_secs(3),
            "未检测到 Jupyter，Python Notebook 功能可能无法启动内核。",
        ),
        first_successful_probe(
            "matlab",
            "MATLAB",
            "数值计算",
            &matlab_borrowed,
            Duration::from_secs(30),
            "未检测到 MATLAB，可安装 MATLAB 并加入 PATH。",
        ),
        latex_check(),
    ]
}

#[tauri::command]
pub async fn local_environment_checks() -> Result<Vec<LocalEnvironmentCheck>, String> {
    tauri::async_runtime::spawn_blocking(environment_checks_blocking)
        .await
        .map_err(|error| error.to_string())
}

fn allowed_external_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return false;
    }
    let Some((scheme, _)) = trimmed.split_once(':') else {
        return false;
    };
    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "mailto" | "tel"
    )
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !allowed_external_url(trimmed) {
        return Err("unsupported external URL scheme".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut command = crate::process::hidden_command("rundll32");
    #[cfg(target_os = "windows")]
    command.args(["url.dll,FileProtocolHandler", trimmed]);

    #[cfg(target_os = "macos")]
    let mut command = crate::process::hidden_command("open");
    #[cfg(target_os = "macos")]
    command.arg(trimmed);

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = crate::process::hidden_command("xdg-open");
    #[cfg(all(unix, not(target_os = "macos")))]
    command.arg(trimmed);

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::allowed_external_url;

    #[test]
    fn external_url_scheme_filter_allows_browser_links() {
        assert!(allowed_external_url("https://example.com/path"));
        assert!(allowed_external_url("http://example.com"));
        assert!(allowed_external_url("mailto:hello@example.com"));
        assert!(allowed_external_url("tel:+15551234567"));
    }

    #[test]
    fn external_url_scheme_filter_blocks_unsafe_links() {
        assert!(!allowed_external_url("javascript:alert(1)"));
        assert!(!allowed_external_url("data:text/html,<script></script>"));
        assert!(!allowed_external_url("/relative/path"));
        assert!(!allowed_external_url("https://example.com/\nnext"));
    }
}
