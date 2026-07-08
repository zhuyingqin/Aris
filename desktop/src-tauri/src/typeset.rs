use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::ExitStatus,
    time::{Duration, Instant},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexCompileResult {
    success: bool,
    input_path: String,
    output_path: String,
    engine: String,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    interrupted: bool,
    timed_out: bool,
    duration_ms: u128,
    return_code_interpretation: Option<String>,
}

struct LatexRunOutput {
    stdout: String,
    stderr: String,
    status: ExitStatus,
    interrupted: bool,
    timed_out: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LatexEnginePreference {
    PdfLatex,
    XeLatex,
    LuaLatex,
}

impl LatexEnginePreference {
    fn latexmk_arg(self) -> &'static str {
        match self {
            Self::PdfLatex => "-pdf",
            Self::XeLatex => "-xelatex",
            Self::LuaLatex => "-lualatex",
        }
    }

    fn latexmk_label(self) -> &'static str {
        match self {
            Self::PdfLatex => "latexmk -pdf",
            Self::XeLatex => "latexmk -xelatex",
            Self::LuaLatex => "latexmk -lualatex",
        }
    }

    fn fallback_engines(self) -> &'static [&'static str] {
        match self {
            Self::PdfLatex => &["pdflatex", "xelatex", "lualatex"],
            Self::XeLatex => &["xelatex", "lualatex", "pdflatex"],
            Self::LuaLatex => &["lualatex", "xelatex", "pdflatex"],
        }
    }
}

#[tauri::command]
pub async fn latex_compile(
    input_path: String,
    output_path: Option<String>,
) -> Result<LatexCompileResult, String> {
    tauri::async_runtime::spawn_blocking(move || latex_compile_blocking(input_path, output_path))
        .await
        .map_err(|error| error.to_string())?
}

fn latex_compile_blocking(
    input_path: String,
    output_path: Option<String>,
) -> Result<LatexCompileResult, String> {
    let workspace = crate::state::workspace_dir()
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let (_root, input_path) = crate::files::resolve_workspace_file(&input_path)?;
    ensure_extension(
        &input_path,
        "tex",
        "latex_compile inputPath must point to a .tex file",
    )?;
    let compile_input_path = resolve_compile_root(&input_path)?;
    let output_path = match output_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        Some(path) => crate::files::resolve_workspace_output_file(path)?.1,
        None => compile_input_path.with_extension("pdf"),
    };
    let default_fragment_output = input_path.with_extension("pdf");
    let output_path = if compile_input_path != input_path && output_path == default_fragment_output
    {
        compile_input_path.with_extension("pdf")
    } else {
        output_path
    };
    ensure_extension(
        &output_path,
        "pdf",
        "latex_compile outputPath must end with .pdf",
    )?;
    let output_dir = output_path
        .parent()
        .ok_or_else(|| "outputPath must include a file name".to_string())?
        .to_path_buf();
    std::fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
    let source_dir = compile_input_path
        .parent()
        .ok_or_else(|| "inputPath must include a file name".to_string())?;

    let started = Instant::now();
    let timeout_ms = runtime::resolve_foreground_shell_timeout_ms(None);
    let (engine, output) =
        run_texlive_compile(&compile_input_path, source_dir, &output_dir, timeout_ms)?;
    let expected_pdf = output_dir
        .join(
            compile_input_path
                .file_stem()
                .ok_or_else(|| "inputPath must include a file name".to_string())?,
        )
        .with_extension("pdf");
    if expected_pdf.is_file() && expected_pdf != output_path {
        std::fs::copy(&expected_pdf, &output_path).map_err(|error| error.to_string())?;
    }

    let mut stderr = output.stderr;
    let mut return_code_interpretation = None;
    if output.timed_out {
        stderr = append_status_message(
            stderr,
            &format!("latex_compile exceeded timeout of {timeout_ms} ms"),
        );
        return_code_interpretation = Some("timeout".to_string());
    } else if output.interrupted {
        stderr = append_status_message(stderr, "latex_compile interrupted");
        return_code_interpretation = Some("interrupted".to_string());
    } else if let Some(code) = output.status.code().filter(|code| *code != 0) {
        return_code_interpretation = Some(format!("exit_code:{code}"));
    }

    let mut success = output.status.success() && output_path.is_file();
    if output.status.success() && !output_path.is_file() {
        success = false;
        stderr = append_status_message(stderr, "TeX Live did not produce the requested PDF");
        return_code_interpretation = Some("missing_output".to_string());
    }

    Ok(LatexCompileResult {
        success,
        input_path: crate::files::display_workspace_path(&compile_input_path, &workspace),
        output_path: crate::files::display_workspace_path(&output_path, &workspace),
        engine,
        stdout: output.stdout,
        stderr,
        exit_code: output.status.code(),
        interrupted: output.interrupted,
        timed_out: output.timed_out,
        duration_ms: started.elapsed().as_millis(),
        return_code_interpretation,
    })
}

fn run_texlive_compile(
    input_path: &Path,
    source_dir: &Path,
    output_dir: &Path,
    timeout_ms: u64,
) -> Result<(String, LatexRunOutput), String> {
    let mut not_found = Vec::new();
    let preferred_engine = preferred_latex_engine(input_path);

    match run_latexmk(
        preferred_engine,
        input_path,
        source_dir,
        output_dir,
        timeout_ms,
    ) {
        Ok(output) => {
            if preferred_engine == LatexEnginePreference::PdfLatex
                && latex_output_needs_unicode_engine(&output)
            {
                let retry_engine = LatexEnginePreference::XeLatex;
                if let Ok(output) =
                    run_latexmk(retry_engine, input_path, source_dir, output_dir, timeout_ms)
                {
                    return Ok((retry_engine.latexmk_label().to_string(), output));
                }
            }
            return Ok((preferred_engine.latexmk_label().to_string(), output));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            not_found.push("latexmk".to_string());
        }
        Err(error) => {
            return Err(format!(
                "TeX Live command `latexmk` failed to start: {error}"
            ));
        }
    }

    for engine in preferred_engine.fallback_engines() {
        let run = run_latex_engine(engine, input_path, source_dir, output_dir, timeout_ms);
        match run {
            Ok(output) => return Ok((engine.to_string(), output)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                not_found.push(engine.to_string());
            }
            Err(error) => {
                return Err(format!(
                    "TeX Live command `{engine}` failed to start: {error}"
                ));
            }
        }
    }
    Err(format!(
        "TeX Live command not found. Tried: {}. Install TeX Live and ensure latexmk/xelatex/pdflatex/lualatex are on PATH.",
        not_found.join(", ")
    ))
}

fn resolve_compile_root(input_path: &Path) -> Result<PathBuf, String> {
    if tex_file_is_standalone(input_path) {
        return Ok(input_path.to_path_buf());
    }
    let Some(parent) = input_path.parent() else {
        return Ok(input_path.to_path_buf());
    };
    let Some(file_name) = input_path.file_name().and_then(|value| value.to_str()) else {
        return Ok(input_path.to_path_buf());
    };
    let Some(stem) = input_path.file_stem().and_then(|value| value.to_str()) else {
        return Ok(input_path.to_path_buf());
    };
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path == input_path || !has_extension(&path, "tex") {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(&path) else {
            continue;
        };
        if tex_source_is_standalone(&source) && tex_source_inputs_file(&source, stem, file_name) {
            candidates.push(path);
        }
    }
    candidates.sort_by(|left, right| {
        let score = |path: &Path| {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_lowercase();
            match name.as_str() {
                "main.tex" => 0,
                "report.tex" => 1,
                _ => 2,
            }
        };
        score(left).cmp(&score(right)).then_with(|| left.cmp(right))
    });
    Ok(candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| input_path.to_path_buf()))
}

fn run_latexmk(
    engine: LatexEnginePreference,
    input_path: &Path,
    source_dir: &Path,
    output_dir: &Path,
    timeout_ms: u64,
) -> std::io::Result<LatexRunOutput> {
    let mut command = runtime::hidden_command("latexmk");
    let source_dir = tex_tool_path(source_dir);
    let output_dir = tex_tool_path(output_dir);
    command
        .arg(engine.latexmk_arg())
        .arg("-interaction=nonstopmode")
        .arg("-halt-on-error")
        .arg("-file-line-error")
        .arg(format!("-outdir={}", output_dir.display()))
        .arg(tex_input_name(input_path))
        .current_dir(source_dir);
    run_latex_process(command, timeout_ms)
}

fn run_latex_engine(
    engine: &str,
    input_path: &Path,
    source_dir: &Path,
    output_dir: &Path,
    timeout_ms: u64,
) -> std::io::Result<LatexRunOutput> {
    let first = run_single_latex_engine(engine, input_path, source_dir, output_dir, timeout_ms)?;
    if !first.status.success() || first.interrupted || first.timed_out {
        return Ok(first);
    }
    let second = run_single_latex_engine(engine, input_path, source_dir, output_dir, timeout_ms)?;
    Ok(LatexRunOutput {
        stdout: join_process_text(first.stdout, second.stdout),
        stderr: join_process_text(first.stderr, second.stderr),
        status: second.status,
        interrupted: second.interrupted,
        timed_out: second.timed_out,
    })
}

fn run_single_latex_engine(
    engine: &str,
    input_path: &Path,
    source_dir: &Path,
    output_dir: &Path,
    timeout_ms: u64,
) -> std::io::Result<LatexRunOutput> {
    let mut command = runtime::hidden_command(engine);
    let source_dir = tex_tool_path(source_dir);
    let output_dir = tex_tool_path(output_dir);
    command
        .arg("-interaction=nonstopmode")
        .arg("-halt-on-error")
        .arg("-file-line-error")
        .arg(format!("-output-directory={}", output_dir.display()))
        .arg(tex_input_name(input_path))
        .current_dir(source_dir);
    run_latex_process(command, timeout_ms)
}

fn run_latex_process(
    mut command: std::process::Command,
    timeout_ms: u64,
) -> std::io::Result<LatexRunOutput> {
    let output = runtime::run_managed_command_with_cancel_and_progress(
        &mut command,
        "TeX Live compile",
        Some(Duration::from_millis(timeout_ms)),
        true,
        || false,
        |_| {},
    )?;
    Ok(LatexRunOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        status: output.status,
        interrupted: output.interrupted,
        timed_out: output.timed_out,
    })
}

fn ensure_extension(path: &Path, extension: &str, message: &str) -> Result<(), String> {
    has_extension(path, extension)
        .then_some(())
        .ok_or_else(|| message.to_string())
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(extension))
}

fn tex_file_is_standalone(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|source| tex_source_is_standalone(&source))
        .unwrap_or(false)
}

fn tex_source_is_standalone(source: &str) -> bool {
    source.contains("\\documentclass") || source.contains("\\begin{document}")
}

fn tex_source_inputs_file(source: &str, stem: &str, file_name: &str) -> bool {
    source.lines().map(latex_line_without_comment).any(|line| {
        ["input", "include", "subfile"].iter().any(|command| {
            latex_command_arguments(line, command)
                .any(|argument| tex_argument_matches(argument, stem, file_name))
        })
    })
}

fn latex_line_without_comment(line: &str) -> &str {
    let mut previous_backslash = false;
    for (index, character) in line.char_indices() {
        if character == '%' && !previous_backslash {
            return &line[..index];
        }
        previous_backslash = character == '\\' && !previous_backslash;
        if character != '\\' {
            previous_backslash = false;
        }
    }
    line
}

fn latex_command_arguments<'a>(line: &'a str, command: &str) -> impl Iterator<Item = &'a str> + 'a {
    let needle = format!("\\{command}");
    let mut rest = line;
    std::iter::from_fn(move || loop {
        let index = rest.find(&needle)?;
        rest = &rest[index + needle.len()..];
        let mut trimmed = rest.trim_start();
        while let Some(optional_argument) = trimmed.strip_prefix('[') {
            let end = optional_argument.find(']')?;
            trimmed = optional_argument[end + 1..].trim_start();
        }
        if let Some(argument_start) = trimmed.strip_prefix('{') {
            let end = argument_start.find('}')?;
            rest = &argument_start[end + 1..];
            return Some(argument_start[..end].trim());
        }
    })
}

fn tex_argument_matches(argument: &str, stem: &str, file_name: &str) -> bool {
    let normalized = argument.trim().replace('\\', "/");
    let normalized = normalized.trim_end_matches(".tex");
    let file_stem = file_name.trim_end_matches(".tex");
    normalized == stem
        || normalized == file_stem
        || normalized.ends_with(&format!("/{stem}"))
        || normalized.ends_with(&format!("/{file_stem}"))
}

fn preferred_latex_engine(input_path: &Path) -> LatexEnginePreference {
    let Ok(source) = std::fs::read_to_string(input_path) else {
        return LatexEnginePreference::PdfLatex;
    };
    if let Some(engine) = latex_magic_comment_engine(&source) {
        return engine;
    }
    if latex_source_uses_luatex(&source) {
        return LatexEnginePreference::LuaLatex;
    }
    if latex_source_uses_unicode_engine(&source) {
        return LatexEnginePreference::XeLatex;
    }
    LatexEnginePreference::PdfLatex
}

fn latex_magic_comment_engine(source: &str) -> Option<LatexEnginePreference> {
    source.lines().take(40).find_map(|line| {
        let lower = line.to_ascii_lowercase();
        let is_tex_directive = lower.contains("tex") && lower.contains("program");
        if !is_tex_directive {
            return None;
        }
        if lower.contains("lualatex") || lower.contains("luatex") {
            Some(LatexEnginePreference::LuaLatex)
        } else if lower.contains("xelatex") || lower.contains("xetex") {
            Some(LatexEnginePreference::XeLatex)
        } else if lower.contains("pdflatex") || lower.contains("pdftex") {
            Some(LatexEnginePreference::PdfLatex)
        } else {
            None
        }
    })
}

fn latex_source_uses_luatex(source: &str) -> bool {
    latex_source_uses_any_package(source, &["luacode", "luatexja", "luaotfload"])
        || latex_source_contains_any_command(source, &["directlua"])
}

fn latex_source_uses_unicode_engine(source: &str) -> bool {
    latex_source_uses_any_package(
        source,
        &[
            "fontspec",
            "xeCJK",
            "ctex",
            "unicode-math",
            "polyglossia",
            "mathspec",
            "xltxtra",
            "xunicode",
        ],
    ) || latex_source_uses_any_documentclass(
        source,
        &["ctexart", "ctexbook", "ctexrep", "ctexbeamer"],
    ) || latex_source_contains_any_command(
        source,
        &[
            "setmainfont",
            "setsansfont",
            "setmonofont",
            "setCJKmainfont",
            "setCJKsansfont",
            "setCJKmonofont",
            "CJKfontspec",
        ],
    )
}

fn latex_source_uses_any_package(source: &str, package_names: &[&str]) -> bool {
    source.lines().map(latex_line_without_comment).any(|line| {
        ["usepackage", "RequirePackage"].iter().any(|command| {
            latex_command_arguments(line, command).any(|argument| {
                argument.split(',').any(|package| {
                    package_names
                        .iter()
                        .any(|name| package.trim().eq_ignore_ascii_case(name))
                })
            })
        })
    })
}

fn latex_source_uses_any_documentclass(source: &str, class_names: &[&str]) -> bool {
    source.lines().map(latex_line_without_comment).any(|line| {
        latex_command_arguments(line, "documentclass").any(|argument| {
            class_names
                .iter()
                .any(|name| argument.trim().eq_ignore_ascii_case(name))
        })
    })
}

fn latex_source_contains_any_command(source: &str, commands: &[&str]) -> bool {
    source.lines().map(latex_line_without_comment).any(|line| {
        let lower = line.to_ascii_lowercase();
        commands
            .iter()
            .any(|command| lower.contains(&format!("\\{}", command.to_ascii_lowercase())))
    })
}

fn latex_output_needs_unicode_engine(output: &LatexRunOutput) -> bool {
    let combined = format!("{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    combined.contains("fontspec") && combined.contains("requires either xetex or luatex")
}

fn append_status_message(stderr: String, message: &str) -> String {
    if stderr.trim().is_empty() {
        message.to_string()
    } else {
        format!("{}\n{message}", stderr.trim_end())
    }
}

fn join_process_text(first: String, second: String) -> String {
    match (first.trim().is_empty(), second.trim().is_empty()) {
        (true, true) => String::new(),
        (true, false) => second,
        (false, true) => first,
        (false, false) => format!("{}\n{}", first.trim_end(), second),
    }
}

fn tex_input_name(input_path: &Path) -> &std::ffi::OsStr {
    input_path
        .file_name()
        .unwrap_or_else(|| input_path.as_os_str())
}

#[cfg(target_os = "windows")]
fn tex_tool_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if value.starts_with(r"\\?\Volume{") {
        return path.to_path_buf();
    }
    value
        .strip_prefix(r"\\?\")
        .map(PathBuf::from)
        .unwrap_or_else(|| path.to_path_buf())
}

#[cfg(not(target_os = "windows"))]
fn tex_tool_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}
