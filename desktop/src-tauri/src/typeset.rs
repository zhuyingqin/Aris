use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
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

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LatexDocumentContext {
    source_path: String,
    root_path: String,
    output_path: String,
}

static LATEX_COMPILATION_CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    OnceLock::new();

fn latex_compilation_cancellations() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    LATEX_COMPILATION_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn request_latex_compile_cancellation(
    cancellations: &Mutex<HashMap<String, Arc<AtomicBool>>>,
    run_id: &str,
) {
    let cancellations = cancellations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(cancellation) = cancellations.get(run_id) {
        cancellation.store(true, Ordering::SeqCst);
    }
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
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
        latex_compilation_cancellations()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&run_id);
    }
    result
}

#[tauri::command]
pub fn latex_compile_cancel(run_id: String) -> Result<(), String> {
    request_latex_compile_cancellation(latex_compilation_cancellations(), &run_id);
    Ok(())
}

#[tauri::command]
pub async fn latex_document_context(source_path: String) -> Result<LatexDocumentContext, String> {
    tauri::async_runtime::spawn_blocking(move || latex_document_context_blocking(source_path))
        .await
        .map_err(|error| error.to_string())?
}

fn latex_document_context_blocking(source_path: String) -> Result<LatexDocumentContext, String> {
    let (workspace, source_path) = crate::files::resolve_workspace_file(&source_path)?;
    latex_document_context_for_path(&source_path, &workspace)
}

fn latex_document_context_for_path(
    source_path: &Path,
    workspace: &Path,
) -> Result<LatexDocumentContext, String> {
    ensure_extension(
        source_path,
        "tex",
        "latex_document_context sourcePath must point to a .tex file",
    )?;
    if !source_path.is_file() {
        return Err("LaTeX source file not found".to_string());
    }
    let root_path = resolve_compile_root(source_path, workspace)?;
    let output_path = root_path.with_extension("pdf");
    Ok(LatexDocumentContext {
        source_path: crate::files::display_workspace_path(source_path, workspace),
        root_path: crate::files::display_workspace_path(&root_path, workspace),
        output_path: crate::files::display_workspace_path(&output_path, workspace),
    })
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
    let compile_input_path = resolve_compile_root(&input_path, &workspace)?;
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

/// A reverse SyncTeX match. Paths are returned relative to the active
/// workspace so the frontend can pass them straight back to the file API.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncTexSourceLocation {
    source_path: String,
    line: u32,
    column: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InverseSearchResult {
    found: bool,
    locations: Vec<SyncTexSourceLocation>,
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
    ensure_synctex_success("forward search", &output.status, &stdout, &stderr)?;
    let locations = parse_synctex_view_output(&stdout);
    Ok(ForwardSearchResult {
        found: !locations.is_empty(),
        locations,
        stderr,
    })
}

#[tauri::command]
pub async fn latex_inverse_search(
    pdf_path: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<InverseSearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        latex_inverse_search_blocking(pdf_path, page, x, y)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn latex_inverse_search_blocking(
    pdf_path: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<InverseSearchResult, String> {
    let (workspace, pdf_path) = crate::files::resolve_workspace_file(&pdf_path)?;
    ensure_extension(
        &pdf_path,
        "pdf",
        "latex_inverse_search pdfPath must point to a .pdf file",
    )?;
    if !pdf_path.is_file() {
        return Err("Compiled PDF not found. Recompile before jumping to the source.".to_string());
    }
    if page == 0 || !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err(
            "latex_inverse_search requires a 1-based page and finite non-negative coordinates"
                .to_string(),
        );
    }
    let pdf_dir = pdf_path
        .parent()
        .ok_or_else(|| "pdfPath must include a file name".to_string())?;
    let target = format!(
        "{page}:{x:.6}:{y:.6}:{}",
        tex_tool_path(&pdf_path).to_string_lossy()
    );
    let mut command = runtime::hidden_command("synctex");
    command
        .arg("edit")
        .arg("-o")
        .arg(&target)
        .current_dir(tex_tool_path(pdf_dir));
    let output = command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "synctex executable not found. It ships with the same TeX Live install as latexmk/xelatex — make sure it's on PATH."
                .to_string()
        } else {
            format!("Failed to run synctex: {error}")
        }
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    ensure_synctex_success("inverse search", &output.status, &stdout, &stderr)?;
    let locations = parse_synctex_edit_output(&stdout)
        .into_iter()
        .filter_map(|location| {
            let source_path = synctex_source_path(&location.input, pdf_dir, &workspace)?;
            Some(SyncTexSourceLocation {
                source_path: crate::files::display_workspace_path(&source_path, &workspace),
                line: location.line.max(1),
                // SyncTeX reports columns as zero-based (`synctex help edit`).
                column: location.column,
            })
        })
        .collect::<Vec<_>>();
    Ok(InverseSearchResult {
        found: !locations.is_empty(),
        locations,
        stderr,
    })
}

fn ensure_synctex_success(
    operation: &str,
    status: &std::process::ExitStatus,
    stdout: &str,
    stderr: &str,
) -> Result<(), String> {
    if status.success() {
        return Ok(());
    }
    let detail = [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or("no diagnostic output");
    let detail = if detail.chars().count() > 1200 {
        format!("{}…", detail.chars().take(1200).collect::<String>())
    } else {
        detail.to_string()
    };
    Err(format!(
        "SyncTeX {operation} failed (exit code {}): {detail}",
        status
            .code()
            .map_or_else(|| "unknown".to_string(), |code| code.to_string())
    ))
}

#[derive(Debug, PartialEq, Eq)]
struct RawSyncTexSourceLocation {
    input: String,
    line: u32,
    column: Option<u32>,
}

fn parse_synctex_edit_output(stdout: &str) -> Vec<RawSyncTexSourceLocation> {
    let mut locations = Vec::new();
    let mut input: Option<String> = None;
    let mut line: Option<u32> = None;
    let mut column: Option<u32> = None;

    let push_location = |locations: &mut Vec<RawSyncTexSourceLocation>,
                         input: &mut Option<String>,
                         line: &mut Option<u32>,
                         column: &mut Option<u32>| {
        if let (Some(input), Some(line)) = (input.take(), line.take()) {
            locations.push(RawSyncTexSourceLocation {
                input,
                line,
                column: column.take(),
            });
        } else {
            *input = None;
            *line = None;
            *column = None;
        }
    };

    for raw_line in stdout.lines() {
        let value = raw_line.trim();
        if value == "SyncTeX result begin" {
            push_location(&mut locations, &mut input, &mut line, &mut column);
        } else if value == "SyncTeX result end" {
            push_location(&mut locations, &mut input, &mut line, &mut column);
        } else if let Some(value) = value.strip_prefix("Input:") {
            // A new Input also separates results in SyncTeX builds that emit a
            // single begin/end pair for multiple matches.
            if input.is_some() {
                push_location(&mut locations, &mut input, &mut line, &mut column);
            }
            input = Some(value.trim().to_string());
        } else if let Some(value) = value.strip_prefix("Line:") {
            line = value.trim().parse().ok();
        } else if let Some(value) = value.strip_prefix("Column:") {
            column = value
                .trim()
                .parse::<i64>()
                .ok()
                .filter(|value| *value >= 0)
                .and_then(|value| u32::try_from(value).ok());
        }
    }
    push_location(&mut locations, &mut input, &mut line, &mut column);
    locations
}

/// Resolve the `Input:` name a `synctex edit` result carries.
///
/// TeX records these relative to its own working directory — the directory of
/// the compile root. That is normally where the PDF lands too, but a build
/// directed at a separate output directory (`latex_compile` accepts any
/// `outputPath`) leaves the two apart, and resolving against the PDF alone
/// would then drop every hit. Falling back to the workspace root recovers those
/// without ever escaping the workspace, which the final check still enforces.
fn synctex_source_path(input: &str, pdf_dir: &Path, workspace: &Path) -> Option<PathBuf> {
    let input_path = Path::new(input.trim().trim_matches(['\'', '"']));
    let candidates: Vec<PathBuf> = if input_path.is_absolute() {
        vec![input_path.to_path_buf()]
    } else {
        vec![pdf_dir.join(input_path), workspace.join(input_path)]
    };
    candidates.into_iter().find_map(|candidate| {
        let canonical = candidate.canonicalize().ok()?;
        (canonical.starts_with(workspace) && has_extension(&canonical, "tex")).then_some(canonical)
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
    std::fs::read(path)
        .map(|source| tex_source_is_standalone(&String::from_utf8_lossy(&source)))
        .unwrap_or(false)
}

fn tex_source_is_standalone(source: &str) -> bool {
    source
        .lines()
        .map(latex_line_without_comment)
        .any(|line| line.contains("\\documentclass") || line.contains("\\begin{document}"))
}

fn tex_magic_root(source: &str) -> Option<String> {
    source.lines().take(50).find_map(|line| {
        let directive = line.trim_start().strip_prefix('%')?.trim_start();
        let directive = directive.strip_prefix('!')?.trim_start();
        let (key, value) = directive.split_once('=')?;
        let normalized_key = key
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        if normalized_key != "tex root" {
            return None;
        }
        let value = value.trim().trim_matches(['\'', '"']);
        (!value.is_empty()).then(|| value.to_string())
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

fn latex_command_argument_pairs<'a>(line: &'a str, command: &str) -> Vec<(&'a str, &'a str)> {
    let needle = format!("\\{command}");
    let mut rest = line;
    let mut pairs = Vec::new();
    while let Some(index) = rest.find(&needle) {
        rest = &rest[index + needle.len()..];
        let mut trimmed = rest.trim_start();
        while let Some(optional_argument) = trimmed.strip_prefix('[') {
            let Some(end) = optional_argument.find(']') else {
                break;
            };
            trimmed = optional_argument[end + 1..].trim_start();
        }
        let Some(first_start) = trimmed.strip_prefix('{') else {
            continue;
        };
        let Some(first_end) = first_start.find('}') else {
            continue;
        };
        let first = first_start[..first_end].trim();
        let after_first = first_start[first_end + 1..].trim_start();
        let Some(second_start) = after_first.strip_prefix('{') else {
            rest = after_first;
            continue;
        };
        let Some(second_end) = second_start.find('}') else {
            rest = second_start;
            continue;
        };
        pairs.push((first, second_start[..second_end].trim()));
        rest = &second_start[second_end + 1..];
    }
    pairs
}

fn tex_path_with_default_extension(base: &Path, value: &str) -> PathBuf {
    let normalized = value.trim().replace('\\', "/");
    let mut path = base.join(normalized);
    if path.extension().is_none() {
        path.set_extension("tex");
    }
    path
}

fn tex_source_dependencies(source_path: &Path, compile_root_dir: &Path) -> Vec<PathBuf> {
    let Ok(source) = std::fs::read(source_path) else {
        return Vec::new();
    };
    let source = String::from_utf8_lossy(&source);
    let source_dir = source_path.parent().unwrap_or(compile_root_dir);
    let mut dependencies = Vec::new();
    for line in source.lines().map(latex_line_without_comment) {
        for command in ["input", "include", "subfile", "subfileinclude"] {
            for argument in latex_command_arguments(line, command) {
                dependencies.push(tex_path_with_default_extension(compile_root_dir, argument));
                if source_dir != compile_root_dir {
                    dependencies.push(tex_path_with_default_extension(source_dir, argument));
                }
            }
        }
        for command in ["import", "subimport"] {
            for (directory, file) in latex_command_argument_pairs(line, command) {
                let imported = Path::new(directory).join(file);
                let imported = imported.to_string_lossy();
                dependencies.push(tex_path_with_default_extension(source_dir, &imported));
                if source_dir != compile_root_dir {
                    dependencies.push(tex_path_with_default_extension(compile_root_dir, &imported));
                }
            }
        }
    }
    dependencies
}

fn tex_root_reaches_file(root: &Path, target: &Path, workspace: &Path) -> bool {
    let Ok(target) = target.canonicalize() else {
        return false;
    };
    let Some(root_dir) = root.parent() else {
        return false;
    };
    let mut pending = vec![root.to_path_buf()];
    let mut visited = HashSet::new();
    while let Some(source_path) = pending.pop() {
        let Ok(source_path) = source_path.canonicalize() else {
            continue;
        };
        if source_path == target {
            return true;
        }
        if !source_path.starts_with(workspace) || !visited.insert(source_path.clone()) {
            continue;
        }
        for dependency in tex_source_dependencies(&source_path, root_dir) {
            let Ok(dependency) = dependency.canonicalize() else {
                continue;
            };
            if dependency == target {
                return true;
            }
            if dependency.starts_with(workspace) && has_extension(&dependency, "tex") {
                pending.push(dependency);
            }
        }
    }
    false
}

fn tex_input_name(input_path: &Path) -> &std::ffi::OsStr {
    input_path
        .file_name()
        .unwrap_or_else(|| input_path.as_os_str())
}

fn resolve_compile_root(input_path: &Path, workspace: &Path) -> Result<PathBuf, String> {
    let input_bytes = std::fs::read(input_path).map_err(|error| error.to_string())?;
    let input_source = String::from_utf8_lossy(&input_bytes);
    if let Some(configured_root) = tex_magic_root(&input_source) {
        let Some(parent) = input_path.parent() else {
            return Err(format!(
                "cannot resolve % !TeX root for {}",
                input_path.display()
            ));
        };
        let configured_path = Path::new(&configured_root);
        let configured_path = if configured_path.is_absolute() {
            configured_path.to_path_buf()
        } else {
            parent.join(configured_path)
        };
        let configured_path = configured_path.canonicalize().map_err(|error| {
            format!(
                "% !TeX root from {} does not resolve to a file: {error}",
                input_path.display()
            )
        })?;
        if !configured_path.starts_with(workspace) {
            return Err("% !TeX root must stay inside the current workspace".to_string());
        }
        ensure_extension(
            &configured_path,
            "tex",
            "% !TeX root must point to a .tex file",
        )?;
        if !tex_file_is_standalone(&configured_path) {
            return Err(format!(
                "% !TeX root is not a compilable root document: {}",
                configured_path.display()
            ));
        }
        return Ok(configured_path);
    }
    if tex_file_is_standalone(input_path) {
        return Ok(input_path.to_path_buf());
    }
    let Some(parent) = input_path.parent() else {
        return Ok(input_path.to_path_buf());
    };
    let mut candidates = Vec::new();
    let mut search_dir = parent;
    loop {
        for entry in std::fs::read_dir(search_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path == input_path || !has_extension(&path, "tex") {
                continue;
            }
            let Ok(source) = std::fs::read(&path) else {
                continue;
            };
            let source = String::from_utf8_lossy(&source);
            if tex_source_is_standalone(&source)
                && tex_root_reaches_file(&path, input_path, workspace)
            {
                candidates.push(path);
            }
        }
        if search_dir == workspace {
            break;
        }
        let Some(next) = search_dir
            .parent()
            .filter(|next| next.starts_with(workspace))
        else {
            break;
        };
        search_dir = next;
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
    if candidates.len() > 1 {
        let roots = candidates
            .iter()
            .filter_map(|path| path.strip_prefix(workspace).ok())
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "multiple LaTeX roots include {} ({roots}); add `% !TeX root = ../main.tex` to select one",
            input_path.display()
        ));
    }
    Ok(candidates.pop().unwrap_or_else(|| input_path.to_path_buf()))
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

    fn temporary_tex_project(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "somniq-typeset-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(root.join("chapters")).expect("create temporary project");
        root
    }

    #[test]
    fn parses_synctex_reverse_search_locations() {
        let output = r#"SyncTeX result begin
Output:main.pdf
Input:chapters/intro.tex
Line:42
Column:7
Offset:123
Context:chapter text
SyncTeX result end
"#;
        assert_eq!(
            parse_synctex_edit_output(output),
            vec![RawSyncTexSourceLocation {
                input: "chapters/intro.tex".to_string(),
                line: 42,
                column: Some(7),
            }]
        );
    }

    #[test]
    fn reverse_search_source_paths_stay_inside_workspace() {
        let root = temporary_tex_project("inverse-path");
        let chapter = root.join("chapters/intro.tex");
        std::fs::write(&chapter, "Chapter text").expect("write chapter");
        let workspace = root.canonicalize().expect("canonical workspace");
        let resolved = synctex_source_path("chapters/intro.tex", &workspace, &workspace)
            .expect("resolve source");
        assert_eq!(resolved, chapter.canonicalize().expect("canonical chapter"));
        assert!(synctex_source_path("../outside.tex", &workspace, &workspace).is_none());
        std::fs::remove_dir_all(root).expect("remove temporary project");
    }

    #[test]
    fn reverse_search_resolves_sources_for_a_separate_output_directory() {
        // A build directed at `build/` puts the PDF (and its SyncTeX file) there
        // while TeX still records inputs relative to the compile root.
        let root = temporary_tex_project("inverse-outdir");
        let chapter = root.join("chapters/intro.tex");
        std::fs::write(&chapter, "Chapter text").expect("write chapter");
        let build_dir = root.join("build");
        std::fs::create_dir_all(&build_dir).expect("create build dir");
        let workspace = root.canonicalize().expect("canonical workspace");
        let pdf_dir = build_dir.canonicalize().expect("canonical build dir");
        let resolved = synctex_source_path("chapters/intro.tex", &pdf_dir, &workspace)
            .expect("resolve source");
        assert_eq!(resolved, chapter.canonicalize().expect("canonical chapter"));
        assert!(synctex_source_path("chapters/missing.tex", &pdf_dir, &workspace).is_none());
        std::fs::remove_dir_all(root).expect("remove temporary project");
    }

    #[test]
    fn document_context_resolves_a_child_to_its_root_and_pdf() {
        let root = temporary_tex_project("document-context");
        let main = root.join("main.tex");
        let chapter = root.join("chapters/intro.tex");
        std::fs::write(
            &main,
            "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}",
        )
        .expect("write root");
        std::fs::write(&chapter, "Child source").expect("write child");
        let workspace = root.canonicalize().expect("canonical workspace");
        let chapter = chapter.canonicalize().expect("canonical child");

        let context = latex_document_context_for_path(&chapter, &workspace)
            .expect("resolve document context");

        assert_eq!(context.source_path, "chapters/intro.tex");
        assert_eq!(context.root_path, "main.tex");
        assert_eq!(context.output_path, "main.pdf");
        std::fs::remove_dir_all(root).expect("remove temporary project");
    }

    #[test]
    fn real_synctex_round_trip_when_tex_tools_are_available() {
        if runtime::hidden_command("pdflatex")
            .arg("--version")
            .output()
            .is_err()
            || runtime::hidden_command("synctex")
                .arg("help")
                .output()
                .is_err()
        {
            eprintln!("skipping real SyncTeX test because TeX tools are unavailable");
            return;
        }

        let root = temporary_tex_project("real-synctex");
        let source = root.join("main.tex");
        std::fs::write(
            &source,
            "\\documentclass{article}\n\\begin{document}\nHello SyncTeX round trip.\n\\end{document}\n",
        )
        .expect("write SyncTeX fixture");
        let compile = runtime::hidden_command("pdflatex")
            .arg("-synctex=1")
            .arg("-interaction=nonstopmode")
            .arg("-halt-on-error")
            .arg("main.tex")
            .current_dir(tex_tool_path(&root))
            .output()
            .expect("run pdflatex");
        assert!(
            compile.status.success(),
            "pdflatex failed: {}",
            String::from_utf8_lossy(&compile.stderr)
        );

        let forward = runtime::hidden_command("synctex")
            .arg("view")
            .arg("-i")
            .arg("3:1:main.tex")
            .arg("-o")
            .arg("main.pdf")
            .current_dir(tex_tool_path(&root))
            .output()
            .expect("run SyncTeX forward search");
        let forward_stdout = String::from_utf8_lossy(&forward.stdout).into_owned();
        let forward_stderr = String::from_utf8_lossy(&forward.stderr).into_owned();
        ensure_synctex_success(
            "test forward search",
            &forward.status,
            &forward_stdout,
            &forward_stderr,
        )
        .expect("forward search succeeds");
        let point = parse_synctex_view_output(&forward_stdout)
            .into_iter()
            .next()
            .expect("forward search location");

        let target = format!(
            "{}:{:.6}:{:.6}:main.pdf",
            point.page, point.point_x, point.point_y
        );
        let inverse = runtime::hidden_command("synctex")
            .arg("edit")
            .arg("-o")
            .arg(target)
            .current_dir(tex_tool_path(&root))
            .output()
            .expect("run SyncTeX inverse search");
        let inverse_stdout = String::from_utf8_lossy(&inverse.stdout).into_owned();
        let inverse_stderr = String::from_utf8_lossy(&inverse.stderr).into_owned();
        ensure_synctex_success(
            "test inverse search",
            &inverse.status,
            &inverse_stdout,
            &inverse_stderr,
        )
        .expect("inverse search succeeds");
        let locations = parse_synctex_edit_output(&inverse_stdout);
        assert!(
            locations.iter().any(|location| {
                location.input.replace('\\', "/").ends_with("main.tex") && location.line == 3
            }),
            "inverse search did not return main.tex line 3: {inverse_stdout}"
        );
        let workspace = root.canonicalize().expect("canonical workspace");
        assert!(locations.iter().any(|location| {
            synctex_source_path(&location.input, &workspace, &workspace)
                .is_some_and(|path| path == source.canonicalize().expect("canonical source"))
        }));
        std::fs::remove_dir_all(root).expect("remove temporary project");
    }

    #[test]
    fn resolve_compile_root_honors_magic_root_from_nested_chapter() {
        let root = temporary_tex_project("magic-root");
        let main = root.join("main.tex");
        let chapter = root.join("chapters/intro.tex");
        std::fs::write(
            &main,
            "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}",
        )
        .expect("write root");
        std::fs::write(&chapter, "% !TeX root = ../main.tex\nChapter text").expect("write chapter");
        let workspace = root.canonicalize().expect("canonical workspace");
        let chapter = chapter.canonicalize().expect("canonical chapter");
        let resolved = resolve_compile_root(&chapter, &workspace).expect("resolve root");
        assert_eq!(resolved, main.canonicalize().expect("canonical root"));
        std::fs::remove_dir_all(root).expect("remove temporary project");
    }

    #[test]
    fn resolve_compile_root_searches_ancestor_directories() {
        let root = temporary_tex_project("ancestor-root");
        let main = root.join("main.tex");
        let chapter = root.join("chapters/intro.tex");
        std::fs::write(
            &main,
            "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}",
        )
        .expect("write root");
        std::fs::write(&chapter, "Nested chapter").expect("write chapter");
        let workspace = root.canonicalize().expect("canonical workspace");
        let chapter = chapter.canonicalize().expect("canonical chapter");
        let resolved = resolve_compile_root(&chapter, &workspace).expect("resolve root");
        assert_eq!(resolved, main.canonicalize().expect("canonical root"));
        std::fs::remove_dir_all(root).expect("remove temporary project");
    }

    #[test]
    fn resolve_compile_root_follows_transitive_inputs() {
        let root = temporary_tex_project("transitive-root");
        std::fs::create_dir_all(root.join("parts")).expect("create parts");
        let main = root.join("main.tex");
        let chapter = root.join("chapters/intro.tex");
        std::fs::write(
            &main,
            "\\documentclass{article}\n\\begin{document}\n\\input{parts/body}\n\\end{document}",
        )
        .expect("write root");
        std::fs::write(root.join("parts/body.tex"), "\\input{chapters/intro}")
            .expect("write intermediate input");
        std::fs::write(&chapter, "Nested chapter").expect("write chapter");
        let workspace = root.canonicalize().expect("canonical workspace");
        let chapter = chapter.canonicalize().expect("canonical chapter");
        let resolved = resolve_compile_root(&chapter, &workspace).expect("resolve root");
        assert_eq!(resolved, main.canonicalize().expect("canonical root"));
        std::fs::remove_dir_all(root).expect("remove temporary project");
    }

    #[test]
    fn resolve_compile_root_follows_import_paths() {
        let root = temporary_tex_project("import-root");
        let main = root.join("main.tex");
        let chapter = root.join("chapters/intro.tex");
        std::fs::write(
            &main,
            "\\documentclass{article}\n\\begin{document}\n\\import{chapters/}{intro}\n\\end{document}",
        )
        .expect("write root");
        std::fs::write(&chapter, "Imported chapter").expect("write chapter");
        let workspace = root.canonicalize().expect("canonical workspace");
        let chapter = chapter.canonicalize().expect("canonical chapter");
        let resolved = resolve_compile_root(&chapter, &workspace).expect("resolve root");
        assert_eq!(resolved, main.canonicalize().expect("canonical root"));
        std::fs::remove_dir_all(root).expect("remove temporary project");
    }

    #[test]
    fn resolve_compile_root_reports_ambiguous_multi_root_projects() {
        let root = temporary_tex_project("ambiguous-root");
        let chapter = root.join("chapters/intro.tex");
        let root_source =
            "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}";
        std::fs::write(root.join("main.tex"), root_source).expect("write first root");
        std::fs::write(root.join("report.tex"), root_source).expect("write second root");
        std::fs::write(&chapter, "Nested chapter").expect("write chapter");
        let workspace = root.canonicalize().expect("canonical workspace");
        let chapter = chapter.canonicalize().expect("canonical chapter");
        let error = resolve_compile_root(&chapter, &workspace).expect_err("ambiguous root");
        assert!(error.contains("multiple LaTeX roots"));
        assert!(error.contains("% !TeX root"));
        std::fs::remove_dir_all(root).expect("remove temporary project");
    }

    #[test]
    fn standalone_detection_ignores_commented_document_commands() {
        assert!(!tex_source_is_standalone(
            "% \\documentclass{article}\n% \\begin{document}\nChapter text"
        ));
    }

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
        let registry = Mutex::new(HashMap::from([(run_id.clone(), Arc::clone(&cancellation))]));
        request_latex_compile_cancellation(&registry, &run_id);

        assert!(cancellation.load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_recovers_after_cancellation_registry_poisoning() {
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let poisoned_registry = Arc::clone(&registry);
        let _ = std::thread::spawn(move || {
            let _guard = poisoned_registry
                .lock()
                .expect("lock cancellation registry");
            panic!("intentionally poison cancellation registry");
        })
        .join();

        let run_id = "typeset-test-poisoned-cancel".to_string();
        let cancellation = Arc::new(AtomicBool::new(false));
        registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(run_id.clone(), Arc::clone(&cancellation));

        request_latex_compile_cancellation(&registry, &run_id);

        assert!(cancellation.load(Ordering::SeqCst));
    }
}
