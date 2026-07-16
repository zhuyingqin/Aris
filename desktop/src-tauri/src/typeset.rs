use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
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
    partial_output: bool,
    pdf_state: tools::LatexPdfState,
    root_source_hash: String,
    pdf_hash: Option<String>,
    compiled_at_unix_ms: u128,
    diagnostics: Vec<tools::LatexDiagnostic>,
}

static LATEX_COMPILATION_CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    OnceLock::new();

fn latex_compilation_cancellations() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    LATEX_COMPILATION_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn latex_compile(
    app: AppHandle,
    input_path: String,
    output_path: Option<String>,
    clean_cache: Option<bool>,
    run_id: Option<String>,
    continue_on_error: Option<bool>,
) -> Result<LatexCompileResult, String> {
    let cancellation = Arc::new(AtomicBool::new(false));
    if let Some(run_id) = run_id.as_ref() {
        latex_compilation_cancellations()
            .lock()
            .map_err(|_| "LaTeX compilation cancellation registry is unavailable".to_string())?
            .insert(run_id.clone(), Arc::clone(&cancellation));
    }
    let cleanup_run_id = run_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        latex_compile_blocking(
            input_path,
            output_path,
            clean_cache.unwrap_or(false),
            continue_on_error.unwrap_or(false),
            LatexProgressReporter::new(app, run_id),
            cancellation,
        )
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    if let Some(run_id) = cleanup_run_id {
        if let Ok(mut cancellations) = latex_compilation_cancellations().lock() {
            cancellations.remove(&run_id);
        }
    }
    result
}

#[tauri::command]
pub fn latex_compile_cancel(run_id: String) -> Result<(), String> {
    if let Ok(cancellations) = latex_compilation_cancellations().lock() {
        if let Some(cancellation) = cancellations.get(&run_id) {
            cancellation.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

fn latex_compile_blocking(
    input_path: String,
    output_path: Option<String>,
    clean_cache: bool,
    continue_on_error: bool,
    progress: LatexProgressReporter,
    cancellation: Arc<AtomicBool>,
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
    let mut report_progress = |update| progress.emit(update);
    let output = tools::compile_latex_document(
        tools::LatexCompileRequest {
            input_path: compile_input_path.clone(),
            output_path: output_path.clone(),
            compiler: None,
            timeout_ms: None,
            clean_cache,
            continue_on_error,
        },
        &workspace,
        &|| cancellation.load(Ordering::SeqCst),
        &mut report_progress,
    )?;

    Ok(LatexCompileResult {
        success: output.success,
        input_path: crate::files::display_workspace_path(&compile_input_path, &workspace),
        output_path: crate::files::display_workspace_path(&output_path, &workspace),
        engine: output.engine,
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code: output.exit_code,
        interrupted: output.interrupted,
        timed_out: output.timed_out,
        duration_ms: output.duration_ms,
        return_code_interpretation: output.return_code_interpretation,
        partial_output: output.pdf_state == tools::LatexPdfState::Partial,
        pdf_state: output.pdf_state,
        root_source_hash: output.root_source_hash,
        pdf_hash: output.pdf_hash,
        compiled_at_unix_ms: output.compiled_at_unix_ms,
        diagnostics: output.diagnostics,
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

    fn emit(&self, progress: tools::ToolProgress) {
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

fn tex_input_name(input_path: &Path) -> &std::ffi::OsStr {
    input_path
        .file_name()
        .unwrap_or_else(|| input_path.as_os_str())
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
    fn cancel_marks_the_registered_compile_run() {
        let run_id = "typeset-test-cancel".to_string();
        let cancellation = Arc::new(AtomicBool::new(false));
        latex_compilation_cancellations()
            .lock()
            .unwrap()
            .insert(run_id.clone(), Arc::clone(&cancellation));

        latex_compile_cancel(run_id.clone()).unwrap();

        assert!(cancellation.load(Ordering::SeqCst));
        latex_compilation_cancellations()
            .lock()
            .unwrap()
            .remove(&run_id);
    }
}
