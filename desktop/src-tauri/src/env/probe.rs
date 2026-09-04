//! Environment probe logic — moved from commands.rs to keep the module self-contained.
//! Runs subprocess checks for Python, Jupyter, MATLAB, and LaTeX availability.

use super::LocalEnvironmentCheck;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

pub(crate) struct ProbeOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub message: String,
}

fn compact_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(160).collect())
}

pub(crate) fn command_path(program: &str) -> Option<String> {
    if Path::new(program).is_file() {
        return Some(program.to_string());
    }

    // `hidden_command`, not a raw `Command`: this runs while the desktop window
    // is up, and a bare spawn flashes a console on Windows.
    #[cfg(target_os = "windows")]
    let mut locator = crate::process::hidden_command("where.exe");
    #[cfg(target_os = "windows")]
    locator.arg(program);

    #[cfg(not(target_os = "windows"))]
    let mut locator = crate::process::hidden_command("which");
    #[cfg(not(target_os = "windows"))]
    locator.arg(program);

    locator
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|text| compact_line(&text))
}

pub(crate) fn run_probe(program: &str, args: &[&str], timeout: Duration) -> ProbeOutput {
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

pub(crate) fn first_successful_probe(
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

pub(crate) fn latex_check() -> LocalEnvironmentCheck {
    let candidates: Vec<(String, Vec<&'static str>)> = vec![
        ("latexmk".to_string(), vec!["--version"]),
        ("xelatex".to_string(), vec!["--version"]),
        ("pdflatex".to_string(), vec!["--version"]),
        ("lualatex".to_string(), vec!["--version"]),
    ];

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
        "未检测到 TeX Live LaTeX 工具链。请安装 TeX Live，并确保 latexmk/xelatex/pdflatex/lualatex 位于 PATH。",
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

fn python_candidates() -> Vec<(String, Vec<&'static str>)> {
    let mut programs = Vec::new();
    if let Ok(configured) = std::env::var("SOMNIQ_PYTHON") {
        let configured = configured.trim();
        if !configured.is_empty() && Path::new(configured).is_file() {
            programs.push(configured.to_string());
        }
    }
    for program in ["python", "python3", "py"] {
        if !programs.iter().any(|candidate| candidate == program) {
            programs.push(program.to_string());
        }
    }
    programs
        .into_iter()
        .map(|program| (program, vec!["--version"]))
        .collect()
}

pub(crate) fn environment_checks_blocking() -> Vec<LocalEnvironmentCheck> {
    let python_candidates = python_candidates();
    let python_borrowed = python_candidates
        .iter()
        .map(|(program, args)| (program.as_str(), args.as_slice()))
        .collect::<Vec<_>>();
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
            &python_borrowed,
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
