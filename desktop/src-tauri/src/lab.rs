//! Desktop commands for the Lab (Jupyter) tab — thin wrappers over the native
//! `notebook` crate. The UI, the LLM tools (`tools::notebook`), and the CLI all
//! drive the SAME kernel sessions: every layer keys a session by the notebook's
//! absolute path, so a kernel the user starts in the Lab is the same one the
//! agent executes against, sharing live state.
//!
//! Execution is blocking (the kernel actor returns a full outcome), so the
//! async commands hop onto `spawn_blocking`. Streaming per-output events is a
//! deliberate follow-up; v1 returns the completed cell result + refreshed outline.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notebook::{CellOutput, ExecStatus, KernelManager, NotebookDoc};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, State};

use crate::projects::{self, ProjectState};

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const VAR_INSPECT_TIMEOUT_SECS: u64 = 5;
const VAR_INSPECT_SENTINEL: &str = "__ARIS_VARS_JSON__";
const LAB_CELL_OUTPUT_EVENT: &str = "lab-cell-output";
const LAB_FILE_OUTPUT_EVENT: &str = "lab-file-output";
const MAX_WALK_DEPTH: usize = 12;
const VAR_INSPECT_CODE: &str = r#"
def __aris_variable_snapshot_20260620():
    import json
    import math
    import types

    def short_repr(value):
        try:
            text = repr(value)
        except Exception as exc:
            text = "<repr error: {}: {}>".format(type(exc).__name__, exc)
        return text if len(text) <= 240 else text[:237] + "..."

    def dim(value):
        try:
            return int(value)
        except Exception:
            return str(value)

    def shape_of(value):
        try:
            shape = getattr(value, "shape", None)
            if shape is not None:
                return [dim(x) for x in shape]
        except Exception:
            return None
        try:
            return [len(value)]
        except Exception:
            return None

    def json_value(value):
        if value is None or isinstance(value, (str, bool, int)):
            return value
        if isinstance(value, float):
            return value if math.isfinite(value) else None
        return None

    variables = []
    for name, value in sorted(globals().items()):
        if name.startswith("_"):
            continue
        if name in ("In", "Out", "exit", "get_ipython", "quit"):
            continue
        if isinstance(value, types.ModuleType) or callable(value):
            continue
        variables.append({
            "name": name,
            "type": type(value).__name__,
            "repr": short_repr(value),
            "shape": shape_of(value),
            "value": json_value(value),
        })
    return json.dumps(variables, ensure_ascii=False)

print("__ARIS_VARS_JSON__" + __aris_variable_snapshot_20260620())
del __aris_variable_snapshot_20260620
"#;

fn resolve(projects_state: &ProjectState, notebook_path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(notebook_path);
    if candidate.is_absolute() {
        return Ok(candidate);
    }
    let base = projects::current_project_path(projects_state)?;
    let direct = base.join(&candidate);
    if direct.exists() || tools::layout::has_path_separator(notebook_path) {
        Ok(direct)
    } else {
        Ok(base.join(tools::layout::canonical_notebook_path(notebook_path)))
    }
}

fn resolve_file(projects_state: &ProjectState, file_path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(file_path);
    if candidate.is_absolute() {
        return Ok(candidate);
    }
    Ok(projects::current_project_path(projects_state)?.join(candidate))
}

fn session_id(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn file_session_id(path: &Path) -> String {
    format!("file:{}", session_id(path))
}

fn workdir(path: &Path) -> PathBuf {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn ensure_python_file(path: &Path) -> Result<(), String> {
    let is_python = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "py" | "pyw"));
    if is_python {
        Ok(())
    } else {
        Err("Lab can run Python files with .py or .pyw extensions.".to_string())
    }
}

/// The standard payload the UI renders: raw notebook JSON + a compact outline +
/// whether a kernel is live.
fn notebook_view(path: &Path) -> Result<Value, String> {
    let doc = NotebookDoc::load_or_empty(path).map_err(|e| e.to_string())?;
    let id = session_id(path);
    let kernel_name = KernelManager::list()
        .into_iter()
        .find(|k| k.id == id)
        .map(|k| k.kernel_name);
    Ok(json!({
        "notebookPath": path.to_string_lossy(),
        "notebook": doc.as_json(),
        "outline": doc.outline(),
        "running": kernel_name.is_some(),
        "kernelName": kernel_name,
    }))
}

#[tauri::command]
pub fn lab_list_kernels() -> Result<Value, String> {
    serde_json::to_value(KernelManager::list()).map_err(|e| e.to_string())
}

/// All kernels the user can pick: installed Jupyter kernelspecs plus the native
/// MATLAB backend when a MATLAB install is detected. Reads kernelspec dirs, so it
/// runs on a blocking thread.
#[tauri::command]
pub async fn lab_list_kernelspecs() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        serde_json::to_value(KernelManager::available_kernels()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lab_list_notebooks(projects_state: State<'_, ProjectState>) -> Result<Value, String> {
    let base = projects::current_project_path(&projects_state)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok::<Value, String>(json!({ "notebooks": list_notebooks_at(&base) }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn lab_load_notebook(
    projects_state: State<ProjectState>,
    notebook_path: String,
) -> Result<Value, String> {
    notebook_view(&resolve(&projects_state, &notebook_path)?)
}

#[tauri::command]
pub fn lab_create_notebook(
    projects_state: State<ProjectState>,
    notebook_path: String,
) -> Result<Value, String> {
    let path = resolve(
        &projects_state,
        &tools::layout::canonical_notebook_path(&notebook_path),
    )?;
    if !path.exists() {
        NotebookDoc::new_empty()
            .save(&path)
            .map_err(|e| e.to_string())?;
    }
    notebook_view(&path)
}

/// Overwrite the whole notebook with `notebook` (a full nbformat JSON object),
/// validating structure before saving. Powers the "revert AI changes" review
/// action: restore the pre-edit baseline in one shot instead of replaying edits.
#[tauri::command]
pub fn lab_save_notebook(
    projects_state: State<ProjectState>,
    notebook_path: String,
    notebook: Value,
) -> Result<Value, String> {
    let path = resolve(&projects_state, &notebook_path)?;
    let text = serde_json::to_string(&notebook).map_err(|e| e.to_string())?;
    // from_json_str runs nbformat validation, so a malformed baseline can never
    // clobber the on-disk notebook.
    let doc = NotebookDoc::from_json_str(&text).map_err(|e| e.to_string())?;
    doc.save(&path).map_err(|e| e.to_string())?;
    notebook_view(&path)
}

#[tauri::command]
pub fn lab_edit_cell(
    projects_state: State<ProjectState>,
    notebook_path: String,
    action: String,
    cell_index: Option<usize>,
    cell_type: Option<String>,
    source: Option<String>,
    to_index: Option<usize>,
) -> Result<Value, String> {
    let path = resolve(&projects_state, &notebook_path)?;
    let mut doc = NotebookDoc::load_or_empty(&path).map_err(|e| e.to_string())?;
    match action.as_str() {
        "insert" => {
            let at = cell_index.unwrap_or_else(|| doc.len());
            doc.insert(
                at,
                cell_type.as_deref().unwrap_or("code"),
                source.as_deref().unwrap_or(""),
            )
            .map_err(|e| e.to_string())?;
        }
        "replace" => {
            let index = cell_index.ok_or("replace requires cell_index")?;
            doc.replace_source(index, source.as_deref().unwrap_or(""))
                .map_err(|e| e.to_string())?;
        }
        "delete" => {
            let index = cell_index.ok_or("delete requires cell_index")?;
            doc.delete(index).map_err(|e| e.to_string())?;
        }
        "move" => {
            let index = cell_index.ok_or("move requires cell_index")?;
            let to = to_index.ok_or("move requires to_index")?;
            doc.move_cell(index, to).map_err(|e| e.to_string())?;
        }
        other => {
            return Err(format!(
                "unknown action '{other}' (use insert | replace | delete | move)"
            ))
        }
    }
    doc.save(&path).map_err(|e| e.to_string())?;
    notebook_view(&path)
}

/// Persist the user's kernel choice into the notebook's `metadata.kernelspec`
/// (nbformat standard) so it is restored on reopen. Returns the refreshed view.
#[tauri::command]
pub fn lab_set_kernelspec(
    projects_state: State<ProjectState>,
    notebook_path: String,
    name: String,
    display_name: Option<String>,
    language: Option<String>,
) -> Result<Value, String> {
    let path = resolve(&projects_state, &notebook_path)?;
    let mut doc = NotebookDoc::load_or_empty(&path).map_err(|e| e.to_string())?;
    doc.set_kernelspec(
        &name,
        display_name.as_deref().unwrap_or(&name),
        language.as_deref().unwrap_or(""),
    );
    doc.save(&path).map_err(|e| e.to_string())?;
    notebook_view(&path)
}

#[tauri::command]
pub async fn lab_start_kernel(
    projects_state: State<'_, ProjectState>,
    notebook_path: String,
    kernel: Option<String>,
) -> Result<Value, String> {
    let path = resolve(&projects_state, &notebook_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let info = KernelManager::start(&session_id(&path), kernel.as_deref(), &workdir(&path))
            .map_err(|e| e.to_string())?;
        serde_json::to_value(info).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lab_execute_cell(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    notebook_path: String,
    cell_index: Option<usize>,
    code: Option<String>,
    timeout_secs: Option<u64>,
    kernel: Option<String>,
) -> Result<Value, String> {
    let path = resolve(&projects_state, &notebook_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let event_notebook_path = notebook_path.clone();
        let event_cell_index = cell_index;
        let on_output = move |output: CellOutput| {
            let _ = app.emit(
                LAB_CELL_OUTPUT_EVENT,
                json!({
                    "notebookPath": event_notebook_path,
                    "cellIndex": event_cell_index,
                    "output": output,
                }),
            );
        };
        execute_blocking(
            &path,
            cell_index,
            code.as_deref(),
            timeout_secs,
            kernel.as_deref(),
            Some(on_output),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lab_shutdown_kernel(
    projects_state: State<'_, ProjectState>,
    notebook_path: String,
) -> Result<(), String> {
    let path = resolve(&projects_state, &notebook_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        KernelManager::shutdown(&session_id(&path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Raise `KeyboardInterrupt` in the running cell without losing kernel state.
#[tauri::command]
pub async fn lab_interrupt_kernel(
    projects_state: State<'_, ProjectState>,
    notebook_path: String,
) -> Result<(), String> {
    let path = resolve(&projects_state, &notebook_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        KernelManager::interrupt(&session_id(&path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lab_start_file_kernel(
    projects_state: State<'_, ProjectState>,
    file_path: String,
    kernel: Option<String>,
) -> Result<Value, String> {
    let path = resolve_file(&projects_state, &file_path)?;
    ensure_python_file(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let info =
            KernelManager::start(&file_session_id(&path), kernel.as_deref(), &workdir(&path))
                .map_err(|e| e.to_string())?;
        serde_json::to_value(info).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lab_execute_file(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    file_path: String,
    code: Option<String>,
    timeout_secs: Option<u64>,
    kernel: Option<String>,
) -> Result<Value, String> {
    let path = resolve_file(&projects_state, &file_path)?;
    ensure_python_file(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let event_file_path = file_path.clone();
        let on_output = move |output: CellOutput| {
            let _ = app.emit(
                LAB_FILE_OUTPUT_EVENT,
                json!({
                    "filePath": event_file_path,
                    "output": output,
                }),
            );
        };
        execute_file_blocking(
            &path,
            code.as_deref(),
            timeout_secs,
            kernel.as_deref(),
            Some(on_output),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lab_interrupt_file_kernel(
    projects_state: State<'_, ProjectState>,
    file_path: String,
) -> Result<(), String> {
    let path = resolve_file(&projects_state, &file_path)?;
    ensure_python_file(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        KernelManager::interrupt(&file_session_id(&path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lab_shutdown_file_kernel(
    projects_state: State<'_, ProjectState>,
    file_path: String,
) -> Result<(), String> {
    let path = resolve_file(&projects_state, &file_path)?;
    ensure_python_file(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        KernelManager::shutdown(&file_session_id(&path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lab_inspect_file_vars(
    projects_state: State<'_, ProjectState>,
    file_path: String,
    kernel: Option<String>,
) -> Result<Value, String> {
    let path = resolve_file(&projects_state, &file_path)?;
    ensure_python_file(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let id = file_session_id(&path);
        KernelManager::start(&id, kernel.as_deref(), &workdir(&path)).map_err(|e| e.to_string())?;
        let snippet = match KernelManager::language(&id).as_deref() {
            Some("python") => Some(VAR_INSPECT_CODE),
            _ => None,
        };
        let Some(snippet) = snippet else {
            return Ok(json!({ "status": "ok", "variables": [] }));
        };
        let outcome =
            KernelManager::execute(&id, snippet, Duration::from_secs(VAR_INSPECT_TIMEOUT_SECS))
                .map_err(|e| e.to_string())?;
        let variables = extract_var_payload(&outcome.outputs)?;
        Ok(json!({
            "status": outcome.status,
            "variables": variables,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Inspect live kernel variables. The inspection snippet is language-specific:
/// Python kernels run `VAR_INSPECT_CODE`, the native MATLAB backend runs its
/// `whos`-based analogue; both emit the same `__ARIS_VARS_JSON__` sentinel that
/// `extract_var_payload` scans for. Other languages report no variables.
#[tauri::command]
pub async fn lab_inspect_vars(
    projects_state: State<'_, ProjectState>,
    notebook_path: String,
    kernel: Option<String>,
) -> Result<Value, String> {
    let path = resolve(&projects_state, &notebook_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let id = session_id(&path);
        KernelManager::start(&id, kernel.as_deref(), &workdir(&path)).map_err(|e| e.to_string())?;
        let snippet = match KernelManager::language(&id).as_deref() {
            Some("matlab") => Some(notebook::MATLAB_VAR_INSPECT_CODE),
            Some("python") => Some(VAR_INSPECT_CODE),
            _ => None,
        };
        let Some(snippet) = snippet else {
            return Ok(json!({ "status": "ok", "variables": [] }));
        };
        let outcome =
            KernelManager::execute(&id, snippet, Duration::from_secs(VAR_INSPECT_TIMEOUT_SECS))
                .map_err(|e| e.to_string())?;
        let variables = extract_var_payload(&outcome.outputs)?;
        Ok(json!({
            "status": outcome.status,
            "variables": variables,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run every code cell end to end (optionally with injected parameters), writing
/// outputs back. Returns the per-cell report + refreshed outline.
#[tauri::command]
pub async fn lab_run_all(
    projects_state: State<'_, ProjectState>,
    notebook_path: String,
    parameters: Option<Map<String, Value>>,
    stop_on_error: Option<bool>,
    timeout_secs: Option<u64>,
    kernel: Option<String>,
) -> Result<Value, String> {
    let path = resolve(&projects_state, &notebook_path)?;
    let base = projects::current_project_path(&projects_state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (write_to, run_record) = parameter_run_artifact(&base, &path, &parameters)?;
        let opts = notebook::RunOptions {
            stop_on_error: stop_on_error.unwrap_or(true),
            timeout: Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS)),
            kernel,
            parameters,
            write_to,
        };
        let result = notebook::run_all(&session_id(&path), &path, &opts);
        let (report, run_value) = match (result, run_record) {
            (Ok(report), Some(mut rec)) => {
                rec.status = status_str(report.status);
                rec.finished_at = Some(now_secs());
                let value = tools::runs::runs_upsert_at(&base, &rec.to_value())?;
                (report, Some(value))
            }
            (Err(error), Some(mut rec)) => {
                rec.status = "error".to_string();
                rec.finished_at = Some(now_secs());
                let mut value = rec.to_value();
                value["error"] = json!(error.to_string());
                let _ = tools::runs::runs_upsert_at(&base, &value);
                return Err(error.to_string());
            }
            (Ok(report), None) => (report, None),
            (Err(error), None) => return Err(error.to_string()),
        };
        let doc = NotebookDoc::load_or_empty(&path).map_err(|e| e.to_string())?;
        Ok(json!({
            "status": report.status,
            "ran": report.ran,
            "cells": report.cells,
            "executedPath": report.executed_path,
            "run": run_value,
            "outline": doc.outline(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Experiment runs library + sweeps ────────────────────────────────────────

/// Load the project's `experiments/runs.json` ledger.
#[tauri::command]
pub fn runs_load(projects_state: State<ProjectState>) -> Result<Value, String> {
    tools::runs::runs_load_at(&projects::current_project_path(&projects_state)?)
}

/// Persist the runs ledger (used by UI edits like deleting a run).
#[tauri::command]
pub fn runs_save(projects_state: State<ProjectState>, runs: Value) -> Result<(), String> {
    tools::runs::runs_save_at(&projects::current_project_path(&projects_state)?, &runs)
}

/// Run a parameter sweep locally (sequential), recording each run in the ledger.
#[tauri::command]
pub async fn lab_run_sweep(
    projects_state: State<'_, ProjectState>,
    spec: Value,
) -> Result<Value, String> {
    let base = projects::current_project_path(&projects_state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let spec: tools::sweep::SweepSpec =
            serde_json::from_value(spec).map_err(|e| e.to_string())?;
        let notebook_abs = if Path::new(&spec.notebook).is_absolute() {
            PathBuf::from(&spec.notebook)
        } else {
            base.join(&spec.notebook)
        };
        tools::sweep::run_sweep_local(&base, &notebook_abs, &spec)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Render a sweep as an `experiment-queue` YAML manifest for GPU hand-off.
#[tauri::command]
pub fn lab_export_sweep_manifest(spec: Value) -> Result<String, String> {
    let spec: tools::sweep::SweepSpec = serde_json::from_value(spec).map_err(|e| e.to_string())?;
    tools::sweep::export_manifest(&spec)
}

fn execute_blocking<F>(
    path: &Path,
    cell_index: Option<usize>,
    code: Option<&str>,
    timeout_secs: Option<u64>,
    kernel: Option<&str>,
    on_output: Option<F>,
) -> Result<Value, String>
where
    F: Fn(CellOutput) + Send + 'static,
{
    KernelManager::start(&session_id(path), kernel, &workdir(path)).map_err(|e| e.to_string())?;
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS));

    let run_code = match (cell_index, code) {
        (_, Some(code)) => code.to_string(),
        (Some(index), None) => NotebookDoc::load(path)
            .map_err(|e| e.to_string())?
            .cell_source(index)
            .map_err(|e| e.to_string())?,
        (None, None) => return Err("provide cell_index or code".to_string()),
    };

    let outcome = match on_output {
        Some(on_output) => {
            KernelManager::execute_streaming(&session_id(path), &run_code, timeout, on_output)
        }
        None => KernelManager::execute(&session_id(path), &run_code, timeout),
    }
    .map_err(|e| e.to_string())?;

    if let Some(index) = cell_index {
        let mut doc = NotebookDoc::load(path).map_err(|e| e.to_string())?;
        doc.set_outputs(index, &outcome.outputs, outcome.execution_count)
            .map_err(|e| e.to_string())?;
        doc.save(path).map_err(|e| e.to_string())?;
    }

    let doc = NotebookDoc::load_or_empty(path).map_err(|e| e.to_string())?;
    Ok(json!({
        "status": outcome.status,
        "executionCount": outcome.execution_count,
        "outputs": outcome.outputs,
        "cellIndex": cell_index,
        "outline": doc.outline(),
    }))
}

fn execute_file_blocking<F>(
    path: &Path,
    code: Option<&str>,
    timeout_secs: Option<u64>,
    kernel: Option<&str>,
    on_output: Option<F>,
) -> Result<Value, String>
where
    F: Fn(CellOutput) + Send + 'static,
{
    let id = file_session_id(path);
    let info = KernelManager::start(&id, kernel, &workdir(path)).map_err(|e| e.to_string())?;
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS));
    let run_code = match code {
        Some(code) => code.to_string(),
        None => std::fs::read_to_string(path).map_err(|e| e.to_string())?,
    };

    let outcome = match on_output {
        Some(on_output) => KernelManager::execute_streaming(&id, &run_code, timeout, on_output),
        None => KernelManager::execute(&id, &run_code, timeout),
    }
    .map_err(|e| e.to_string())?;

    Ok(json!({
        "filePath": path.to_string_lossy(),
        "status": outcome.status,
        "executionCount": outcome.execution_count,
        "outputs": outcome.outputs,
        "kernelName": info.kernel_name,
    }))
}

fn extract_var_payload(outputs: &[CellOutput]) -> Result<Value, String> {
    for output in outputs {
        let CellOutput::Stream { name, text } = output else {
            continue;
        };
        if name != "stdout" {
            continue;
        }
        for line in text.lines() {
            if let Some(payload) = line.trim_start().strip_prefix(VAR_INSPECT_SENTINEL) {
                return serde_json::from_str(payload.trim()).map_err(|e| e.to_string());
            }
        }
    }
    Err("variable inspector did not return a JSON payload".to_string())
}

fn parameter_run_artifact(
    base: &Path,
    source: &Path,
    parameters: &Option<Map<String, Value>>,
) -> Result<(Option<PathBuf>, Option<tools::runs::RunRecord>), String> {
    let Some(parameters) = parameters.as_ref().filter(|params| !params.is_empty()) else {
        return Ok((None, None));
    };
    let mut rec = tools::runs::RunRecord::new_local(&rel_to(base, source));
    rec.params = Value::Object(parameters.clone());
    rec.status = "running".to_string();
    rec.started_at = Some(now_secs());
    let artifacts = tools::runs::run_artifacts_dir_at(base, &rec.id);
    std::fs::create_dir_all(&artifacts).map_err(|e| e.to_string())?;
    let executed = artifacts.join("executed.ipynb");
    rec.executed_path = Some(rel_to(base, &executed));
    rec.outputs_dir = Some(rel_to(base, &artifacts));
    tools::runs::runs_upsert_at(base, &rec.to_value())?;
    Ok((Some(executed), Some(rec)))
}

fn status_str(status: ExecStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "error".to_string())
}

fn rel_to(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

fn list_notebooks_at(base: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    collect_direct_notebooks(base, base, &mut found, &mut seen);
    for dir in [
        tools::layout::notebooks_dir_at(base),
        tools::layout::experiments_dir_at(base),
    ] {
        if dir.is_dir() {
            collect_notebooks(base, &dir, 0, &mut found, &mut seen);
        }
    }
    found.sort();
    found
}

fn push_notebook(base: &Path, path: &Path, out: &mut Vec<String>, seen: &mut HashSet<String>) {
    if !path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ipynb"))
    {
        return;
    }
    if let Ok(rel) = path.strip_prefix(base) {
        let rel = rel.to_string_lossy().replace('\\', "/");
        if seen.insert(rel.clone()) {
            out.push(rel);
        }
    }
}

fn collect_direct_notebooks(
    base: &Path,
    dir: &Path,
    out: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            push_notebook(base, &path, out, seen);
        }
    }
}

/// Recursively collect `.ipynb` paths from canonical notebook roots
/// (project-relative, forward-slashed), skipping noisy directories.
fn collect_notebooks(
    base: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    if depth > MAX_WALK_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if tools::layout::is_noisy_walk_dir(&name)
                || (name == tools::layout::RUNS_SUBDIR
                    && dir.file_name().and_then(|item| item.to_str())
                        == Some(tools::layout::EXPERIMENTS_DIR))
            {
                continue;
            }
            collect_notebooks(base, &path, depth + 1, out, seen);
        } else {
            push_notebook(base, &path, out, seen);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::list_notebooks_at;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_base(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let base =
            std::env::temp_dir().join(format!("aris-lab-{name}-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&base).expect("create temp lab dir");
        base
    }

    #[test]
    fn list_notebooks_finds_canonical_nested_ipynb_files_case_insensitively() {
        let base = temp_base("notebooks");
        let nested = base.join("notebooks/a/b/c/d/e/f/g");
        std::fs::create_dir_all(&nested).expect("create nested notebook dir");
        std::fs::write(nested.join("deep.IPYNB"), "{}").expect("write notebook");

        let runs = base.join("experiments/runs/run-1");
        std::fs::create_dir_all(&runs).expect("create runs dir");
        std::fs::write(runs.join("ignored.ipynb"), "{}").expect("write ignored notebook");

        let found = list_notebooks_at(&base);

        assert_eq!(found, vec!["notebooks/a/b/c/d/e/f/g/deep.IPYNB"]);
        let _ = std::fs::remove_dir_all(base);
    }
}
