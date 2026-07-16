use encoding_rs::{GB18030, GBK};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::ExitStatus,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

const LATEX_COMPILE_PROGRESS_EVENT: &str = "latex-compile-progress";

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
    app: AppHandle,
    input_path: String,
    output_path: Option<String>,
    clean_cache: Option<bool>,
    run_id: Option<String>,
) -> Result<LatexCompileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        latex_compile_blocking(
            input_path,
            output_path,
            clean_cache.unwrap_or(false),
            LatexProgressReporter::new(app, run_id),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn latex_compile_blocking(
    input_path: String,
    output_path: Option<String>,
    clean_cache: bool,
    progress: LatexProgressReporter,
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
    let cache_cleanup_note = clean_cache
        .then(|| {
            clean_latex_cache(
                &compile_input_path,
                source_dir,
                &output_dir,
                timeout_ms,
                &progress,
            )
        })
        .transpose()?;
    let (engine, output) = run_texlive_compile(
        &compile_input_path,
        source_dir,
        &output_dir,
        timeout_ms,
        &progress,
    )?;
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

    let stdout = match cache_cleanup_note {
        Some(note) => join_process_text(note, output.stdout),
        None => output.stdout,
    };
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
        stdout,
        stderr,
        exit_code: output.status.code(),
        interrupted: output.interrupted,
        timed_out: output.timed_out,
        duration_ms: started.elapsed().as_millis(),
        return_code_interpretation,
    })
}

#[derive(Clone)]
struct LatexProgressReporter {
    app: AppHandle,
    run_id: Option<String>,
}

impl LatexProgressReporter {
    fn new(app: AppHandle, run_id: Option<String>) -> Self {
        Self { app, run_id }
    }

    fn emit(&self, progress: runtime::ManagedCommandProgress) {
        let Some(run_id) = self.run_id.as_deref() else {
            return;
        };
        let _ = self.app.emit(
            LATEX_COMPILE_PROGRESS_EVENT,
            serde_json::json!({
                "runId": run_id,
                "stdout": progress.stdout_tail,
                "stderr": progress.stderr_tail,
                "elapsedMs": progress.elapsed_ms,
            }),
        );
    }
}

fn clean_latex_cache(
    input_path: &Path,
    source_dir: &Path,
    output_dir: &Path,
    timeout_ms: u64,
    progress: &LatexProgressReporter,
) -> Result<String, String> {
    let mut command = runtime::hidden_command("latexmk");
    let source_dir = tex_tool_path(source_dir);
    let output_dir = tex_tool_path(output_dir);
    command.arg("-c");
    if tex_command_needs_output_directory(&source_dir, &output_dir) {
        command.arg(format!("-outdir={}", output_dir.display()));
    }
    command
        .arg(tex_input_name(input_path))
        .current_dir(source_dir);

    match run_latex_process(command, timeout_ms, progress) {
        Ok(output) if output.status.success() && !output.interrupted && !output.timed_out => {
            let removed = remove_known_latex_cache_files(input_path, output_dir.as_path())?;
            Ok(format!(
                "LaTeX cache cleared ({removed} remaining auxiliary file(s) removed) before recompiling."
            ))
        }
        Ok(output) => {
            let detail = join_process_text(output.stderr, output.stdout);
            Err(if detail.trim().is_empty() {
                "latexmk failed while clearing the LaTeX cache".to_string()
            } else {
                format!("latexmk failed while clearing the LaTeX cache:\n{detail}")
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let removed = remove_known_latex_cache_files(input_path, output_dir.as_path())?;
            Ok(format!(
                "latexmk was unavailable; cleared {removed} known LaTeX cache file(s) before recompiling."
            ))
        }
        Err(error) => Err(format!("Failed to start LaTeX cache cleanup: {error}")),
    }
}

fn known_latex_cache_paths(input_path: &Path, output_dir: &Path) -> Vec<PathBuf> {
    let stem = input_path
        .file_stem()
        .unwrap_or_else(|| input_path.as_os_str())
        .to_string_lossy();
    [
        "aux",
        "bbl",
        "bcf",
        "blg",
        "fdb_latexmk",
        "fls",
        "lof",
        "log",
        "lot",
        "nav",
        "out",
        "run.xml",
        "snm",
        "synctex.gz",
        "toc",
        "vrb",
        "xdv",
    ]
    .into_iter()
    .map(|suffix| output_dir.join(format!("{stem}.{suffix}")))
    .collect()
}

fn remove_known_latex_cache_files(input_path: &Path, output_dir: &Path) -> Result<usize, String> {
    let mut removed = 0;
    for path in known_latex_cache_paths(input_path, output_dir) {
        if !path.is_file() {
            continue;
        }
        std::fs::remove_file(&path)
            .map_err(|error| format!("Failed to remove {}: {error}", path.display()))?;
        removed += 1;
    }
    Ok(removed)
}

/// A single SyncTeX match: `pointX`/`pointY` is the exact synchronized point
/// (for centering the viewport), `box*` is the enclosing typeset box (for
/// drawing a highlight rectangle) — see `synctex help view`, which documents
/// these as two related but distinct readings. Both are in PDF points,
/// origin at the page's top-left corner, same convention `pdfjs-dist`
/// viewports use, so the frontend only has to multiply by its current zoom.
#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct SyncTexLocation {
    page: u32,
    point_x: f64,
    point_y: f64,
    box_left: f64,
    box_top: f64,
    box_width: f64,
    box_height: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSearchResult {
    found: bool,
    locations: Vec<SyncTexLocation>,
    stderr: String,
}

#[tauri::command]
pub async fn latex_forward_search(
    source_path: String,
    pdf_path: String,
    line: u32,
    column: Option<u32>,
) -> Result<ForwardSearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        latex_forward_search_blocking(source_path, pdf_path, line, column)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn latex_forward_search_blocking(
    source_path: String,
    pdf_path: String,
    line: u32,
    column: Option<u32>,
) -> Result<ForwardSearchResult, String> {
    let (_root, source_path) = crate::files::resolve_workspace_file(&source_path)?;
    let (_root, pdf_path) = crate::files::resolve_workspace_file(&pdf_path)?;
    ensure_extension(
        &source_path,
        "tex",
        "latex_forward_search sourcePath must point to a .tex file",
    )?;
    ensure_extension(
        &pdf_path,
        "pdf",
        "latex_forward_search pdfPath must point to a .pdf file",
    )?;
    if !pdf_path.is_file() {
        return Err("Compiled PDF not found. Recompile before jumping to the PDF.".to_string());
    }
    let pdf_dir = pdf_path
        .parent()
        .ok_or_else(|| "pdfPath must include a file name".to_string())?;
    let target = format!(
        "{line}:{}:{}",
        column.unwrap_or(0),
        tex_input_target(&source_path, pdf_dir)
    );
    eprintln!(
        "[forward-search-diag] source_path={source_path:?} pdf_path={pdf_path:?} pdf_dir={pdf_dir:?} target={target:?}"
    );

    let mut command = runtime::hidden_command("synctex");
    command
        .arg("view")
        .arg("-i")
        .arg(&target)
        .arg("-o")
        .arg(tex_tool_path(&pdf_path))
        .current_dir(tex_tool_path(pdf_dir));
    let output = command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "synctex executable not found. It ships with the same TeX Live install as \
             latexmk/xelatex — make sure it's on PATH."
                .to_string()
        } else {
            format!("Failed to run synctex: {error}")
        }
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    eprintln!(
        "[forward-search-diag] exit={:?} stdout={stdout:?} stderr={stderr:?}",
        output.status.code()
    );
    let locations = parse_synctex_view_output(&stdout);
    Ok(ForwardSearchResult {
        found: !locations.is_empty(),
        locations,
        stderr,
    })
}

/// Parses `synctex view` stdout, e.g.:
/// ```text
/// SyncTeX result begin
/// Output:main.pdf
/// Page:1
/// x:95.089378
/// y:263.465210
/// h:62.362118
/// v:266.192474
/// W:470.551361
/// H:11.718735
/// before:
/// offset:-1
/// middle:
/// after:
/// SyncTeX result end
/// ```
/// A query can return several result blocks (one per typeset box touching the
/// line); the first is documented as "in general ... the most accurate" so we
/// keep them all but the caller picks `locations[0]`.
fn parse_synctex_view_output(stdout: &str) -> Vec<SyncTexLocation> {
    let mut locations = Vec::new();
    let mut page: Option<u32> = None;
    let mut x: Option<f64> = None;
    let mut y: Option<f64> = None;
    let mut h: Option<f64> = None;
    let mut v: Option<f64> = None;
    let mut w: Option<f64> = None;
    let mut tall: Option<f64> = None;

    for raw_line in stdout.lines() {
        let line = raw_line.trim();
        if line == "SyncTeX result begin" {
            page = None;
            x = None;
            y = None;
            h = None;
            v = None;
            w = None;
            tall = None;
            continue;
        }
        if line == "SyncTeX result end" {
            if let (Some(page), Some(x), Some(y)) = (page, x, y) {
                let box_width = w.unwrap_or(0.0);
                let box_height = tall.unwrap_or(0.0);
                locations.push(SyncTexLocation {
                    page,
                    point_x: x,
                    point_y: y,
                    box_left: h.unwrap_or(x),
                    box_top: v.unwrap_or(y) - box_height,
                    box_width,
                    box_height,
                });
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("Page:") {
            page = value.trim().parse().ok();
        } else if let Some(value) = line.strip_prefix("x:") {
            x = value.trim().parse().ok();
        } else if let Some(value) = line.strip_prefix("y:") {
            y = value.trim().parse().ok();
        } else if let Some(value) = line.strip_prefix("h:") {
            h = value.trim().parse().ok();
        } else if let Some(value) = line.strip_prefix("v:") {
            v = value.trim().parse().ok();
        } else if let Some(value) = line.strip_prefix("W:") {
            w = value.trim().parse().ok();
        } else if let Some(value) = line.strip_prefix("H:") {
            tall = value.trim().parse().ok();
        }
    }
    locations
}

fn run_texlive_compile(
    input_path: &Path,
    source_dir: &Path,
    output_dir: &Path,
    timeout_ms: u64,
    progress: &LatexProgressReporter,
) -> Result<(String, LatexRunOutput), String> {
    let mut not_found = Vec::new();
    let preferred_engine = preferred_latex_engine(input_path);

    match run_latexmk(
        preferred_engine,
        input_path,
        source_dir,
        output_dir,
        timeout_ms,
        progress,
    ) {
        Ok(output) => {
            if preferred_engine == LatexEnginePreference::PdfLatex
                && latex_output_needs_unicode_engine(&output)
            {
                let retry_engine = LatexEnginePreference::XeLatex;
                if let Ok(output) = run_latexmk(
                    retry_engine,
                    input_path,
                    source_dir,
                    output_dir,
                    timeout_ms,
                    progress,
                ) {
                    return Ok((retry_engine.latexmk_label().to_string(), output));
                }
            }
            if latexmk_output_reports_stale_failure(&output.stdout, &output.stderr) {
                let cleanup_note =
                    clean_latex_cache(input_path, source_dir, output_dir, timeout_ms, progress)?;
                let retry = run_latexmk(
                    preferred_engine,
                    input_path,
                    source_dir,
                    output_dir,
                    timeout_ms,
                    progress,
                )
                .map_err(|error| format!("TeX Live retry failed to start: {error}"))?;
                return Ok((
                    preferred_engine.latexmk_label().to_string(),
                    stale_cache_retry_output(output, cleanup_note, retry),
                ));
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
        let run = run_latex_engine(
            engine, input_path, source_dir, output_dir, timeout_ms, progress,
        );
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
    progress: &LatexProgressReporter,
) -> std::io::Result<LatexRunOutput> {
    let mut command = runtime::hidden_command("latexmk");
    let source_dir = tex_tool_path(source_dir);
    let output_dir = tex_tool_path(output_dir);
    command
        .arg(engine.latexmk_arg())
        .arg("-interaction=nonstopmode")
        .arg("-halt-on-error")
        .arg("-file-line-error")
        .arg("-synctex=1");
    if tex_command_needs_output_directory(&source_dir, &output_dir) {
        command.arg(format!("-outdir={}", output_dir.display()));
    }
    command
        .arg(tex_input_name(input_path))
        .current_dir(source_dir);
    run_latex_process(command, timeout_ms, progress)
}

fn run_latex_engine(
    engine: &str,
    input_path: &Path,
    source_dir: &Path,
    output_dir: &Path,
    timeout_ms: u64,
    progress: &LatexProgressReporter,
) -> std::io::Result<LatexRunOutput> {
    let first = run_single_latex_engine(
        engine, input_path, source_dir, output_dir, timeout_ms, progress,
    )?;
    if !first.status.success() || first.interrupted || first.timed_out {
        return Ok(first);
    }
    let second = run_single_latex_engine(
        engine, input_path, source_dir, output_dir, timeout_ms, progress,
    )?;
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
    progress: &LatexProgressReporter,
) -> std::io::Result<LatexRunOutput> {
    let mut command = runtime::hidden_command(engine);
    let source_dir = tex_tool_path(source_dir);
    let output_dir = tex_tool_path(output_dir);
    command
        .arg("-interaction=nonstopmode")
        .arg("-halt-on-error")
        .arg("-file-line-error")
        .arg("-synctex=1");
    if tex_command_needs_output_directory(&source_dir, &output_dir) {
        command.arg(format!("-output-directory={}", output_dir.display()));
    }
    command
        .arg(tex_input_name(input_path))
        .current_dir(source_dir);
    run_latex_process(command, timeout_ms, progress)
}

fn run_latex_process(
    mut command: std::process::Command,
    timeout_ms: u64,
    progress: &LatexProgressReporter,
) -> std::io::Result<LatexRunOutput> {
    let output = runtime::run_managed_command_with_cancel_and_progress(
        &mut command,
        "TeX Live compile",
        Some(Duration::from_millis(timeout_ms)),
        true,
        || false,
        |update| progress.emit(update),
    )?;
    Ok(LatexRunOutput {
        stdout: decode_tex_output(&output.stdout),
        stderr: decode_tex_output(&output.stderr),
        status: output.status,
        interrupted: output.interrupted,
        timed_out: output.timed_out,
    })
}

fn tex_command_needs_output_directory(source_dir: &Path, output_dir: &Path) -> bool {
    source_dir != output_dir
}

fn latexmk_output_reports_stale_failure(stdout: &str, stderr: &str) -> bool {
    let output = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    output.contains("gave an error in previous invocation of latexmk")
}

fn stale_cache_retry_output(
    _previous: LatexRunOutput,
    cleanup_note: String,
    retry: LatexRunOutput,
) -> LatexRunOutput {
    LatexRunOutput {
        stdout: join_process_text(
            format!(
                "{cleanup_note}\nLaTeXmk found a stale failed-build marker and retried from a clean cache."
            ),
            retry.stdout,
        ),
        stderr: retry.stderr,
        status: retry.status,
        interrupted: retry.interrupted,
        timed_out: retry.timed_out,
    }
}

fn decode_tex_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    for encoding in [GB18030, GBK] {
        let (text, _, had_errors) = encoding.decode(bytes);
        if !had_errors {
            return text.into_owned();
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
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

/// The name SyncTeX recorded for `source_path`, for use as `synctex view -i`'s
/// `input` argument. TeX resolves `\input`/`\include`/`\subfile` relative to
/// its working directory (the compile root's directory, which is `pdf_dir` —
/// see `latex_compile_blocking`'s `source_dir`/output-path pairing), so a
/// bare file name only matches when the edited file *is* the compile root.
/// For anything pulled in from a subdirectory, SyncTeX needs that relative
/// path (with `/` separators, matching what TeX itself records) or its
/// suffix match fails with "No tag for <name>" and forward search silently
/// returns zero results.
fn tex_input_target(source_path: &Path, pdf_dir: &Path) -> String {
    if let Ok(relative) = source_path.strip_prefix(pdf_dir) {
        let joined = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if !joined.is_empty() {
            return joined;
        }
    }
    tex_input_name(source_path).to_string_lossy().into_owned()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tex_input_target_uses_bare_name_for_the_compile_root() {
        let pdf_dir = Path::new("/project");
        let source_path = Path::new("/project/main.tex");
        assert_eq!(tex_input_target(source_path, pdf_dir), "main.tex");
    }

    #[test]
    fn tex_input_target_uses_relative_path_for_included_subfiles() {
        // Reproduces the reported bug: double-click forward search failed
        // with "SyncTeX Warning: No tag for intro.tex" whenever the edited
        // file was \input from a subdirectory, because only the bare file
        // name (matching the compile root case below) was ever sent.
        let pdf_dir = Path::new("/project");
        let source_path = Path::new("/project/chapters/intro.tex");
        assert_eq!(tex_input_target(source_path, pdf_dir), "chapters/intro.tex");
    }

    #[test]
    fn tex_input_target_normalizes_windows_separators_to_forward_slashes() {
        let pdf_dir = Path::new(r"C:\project");
        let source_path = Path::new(r"C:\project\chapters\intro.tex");
        assert_eq!(tex_input_target(source_path, pdf_dir), "chapters/intro.tex");
    }

    #[test]
    fn tex_input_target_falls_back_to_bare_name_outside_pdf_dir() {
        let pdf_dir = Path::new("/project/build");
        let source_path = Path::new("/elsewhere/main.tex");
        assert_eq!(tex_input_target(source_path, pdf_dir), "main.tex");
    }

    #[test]
    fn known_cache_paths_include_auxiliary_files_but_preserve_the_pdf() {
        let paths = known_latex_cache_paths(Path::new("/project/root.tex"), Path::new("/project"));
        assert!(paths.contains(&PathBuf::from("/project/root.aux")));
        assert!(paths.contains(&PathBuf::from("/project/root.fdb_latexmk")));
        assert!(paths.contains(&PathBuf::from("/project/root.synctex.gz")));
        assert!(!paths.contains(&PathBuf::from("/project/root.pdf")));
    }

    #[test]
    fn decodes_tex_live_cp936_output_without_corrupting_chinese_paths() {
        let expected = "Latexmk: F:\\F-CESN会议";
        let (bytes, _, had_errors) = GBK.encode(expected);
        assert!(!had_errors);
        assert_eq!(decode_tex_output(&bytes), expected);
    }

    #[test]
    fn detects_latexmk_stale_failed_build_marker() {
        assert!(latexmk_output_reports_stale_failure(
            "Collected error summary: pdflatex: gave an error in previous invocation of latexmk.",
            ""
        ));
        assert!(!latexmk_output_reports_stale_failure(
            "! Undefined control sequence.",
            ""
        ));
    }

    #[test]
    fn omits_output_directory_flag_when_latex_writes_beside_its_source() {
        assert!(!tex_command_needs_output_directory(
            Path::new(r"F:\F-CESN会议"),
            Path::new(r"F:\F-CESN会议"),
        ));
        assert!(tex_command_needs_output_directory(
            Path::new(r"F:\F-CESN会议"),
            Path::new(r"F:\F-CESN会议\build"),
        ));
    }
}
