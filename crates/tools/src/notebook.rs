//! LLM-facing notebook execution tools, backed by the `notebook` crate's native
//! Jupyter kernel. These complement the built-in `NotebookEdit` (which edits
//! `.ipynb` cells but cannot run them): `NotebookExecute` runs a cell/snippet
//! against a session-persistent kernel and writes outputs back into the file,
//! and `NotebookKernel` manages kernel lifecycle. The notebook path is the
//! session key, so repeated executes share one long-lived kernel + its state.

use std::path::{Path, PathBuf};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use notebook::{CellOutput, ExecStatus, KernelManager, NotebookDoc, RunOptions};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::layout;
use crate::runs::{self, RunRecord};

const DEFAULT_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Deserialize)]
pub struct NotebookExecuteInput {
    /// Path to the `.ipynb`. Identifies both the kernel session and (for
    /// `cell_index`) the document whose cell is run / written back.
    pub notebook_path: String,
    /// Run the source of this 0-based cell and write its outputs back.
    #[serde(default)]
    pub cell_index: Option<usize>,
    /// Run this code directly (REPL-style) instead of a cell's source.
    #[serde(default)]
    pub code: Option<String>,
    /// Kernelspec name (e.g. "python3"). Defaults to auto-picking Python.
    #[serde(default)]
    pub kernel: Option<String>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// When running a `cell_index`, persist outputs into the file (default true).
    #[serde(default)]
    pub write_back: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct NotebookKernelInput {
    /// One of: status | list | start | restart | shutdown | interrupt.
    pub action: String,
    #[serde(default)]
    pub notebook_path: Option<String>,
    #[serde(default)]
    pub kernel: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NotebookRunInput {
    /// Path to the `.ipynb` to run end to end.
    pub notebook_path: String,
    /// papermill-style parameter overrides injected before the first cell runs.
    #[serde(default)]
    pub parameters: Option<Map<String, Value>>,
    /// Stop at the first failing cell (default true).
    #[serde(default)]
    pub stop_on_error: Option<bool>,
    /// Per-cell timeout.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Kernelspec name (defaults to auto-picking Python).
    #[serde(default)]
    pub kernel: Option<String>,
}

pub fn run_notebook_execute(input: NotebookExecuteInput) -> Result<String, String> {
    let notebook_path = resolve_path(&input.notebook_path);
    let session_id = session_id_for(&notebook_path);
    let workdir = workdir_for(&notebook_path);

    KernelManager::start(&session_id, input.kernel.as_deref(), &workdir).map_err(stringify)?;
    let timeout = Duration::from_secs(input.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS));

    // Resolve the code to run + the cell to write back to.
    let (code, cell_index) = match (input.cell_index, input.code) {
        (Some(index), None) => {
            let doc = NotebookDoc::load(&notebook_path).map_err(stringify)?;
            (doc.cell_source(index).map_err(stringify)?, Some(index))
        }
        (None, Some(code)) => (code, None),
        // Explicit code wins, but still write back to the named cell.
        (Some(index), Some(code)) => (code, Some(index)),
        (None, None) => return Err("provide either `cell_index` or `code`".to_string()),
    };

    let outcome = KernelManager::execute(&session_id, &code, timeout).map_err(stringify)?;

    let mut wrote_back = false;
    if let Some(index) = cell_index {
        if input.write_back.unwrap_or(true) {
            let mut doc = NotebookDoc::load(&notebook_path).map_err(stringify)?;
            doc.set_outputs(index, &outcome.outputs, outcome.execution_count)
                .map_err(stringify)?;
            doc.save(&notebook_path).map_err(stringify)?;
            wrote_back = true;
        }
    }

    let text = render_text(&outcome.outputs);
    let status = outcome.status;
    let execution_count = outcome.execution_count;
    let result = json!({
        "status": status,
        "executionCount": execution_count,
        "cellIndex": cell_index,
        "wroteBack": wrote_back,
        "notebookPath": notebook_path.to_string_lossy(),
        "text": text,
        "outputs": outcome.outputs,
    });
    serde_json::to_string_pretty(&result).map_err(stringify)
}

pub fn run_notebook_run(input: NotebookRunInput) -> Result<String, String> {
    let notebook_path = resolve_path(&input.notebook_path);
    let session_id = session_id_for(&notebook_path);
    let base = workspace_root();
    let has_parameters = input
        .parameters
        .as_ref()
        .is_some_and(|params| !params.is_empty());
    let (write_to, run_record) = if has_parameters {
        let mut rec = RunRecord::new_local(&rel_to(&base, &notebook_path));
        rec.params = Value::Object(input.parameters.clone().unwrap_or_default());
        rec.status = "running".to_string();
        rec.started_at = Some(now_secs());
        let artifacts = runs::run_artifacts_dir_at(&base, &rec.id);
        std::fs::create_dir_all(&artifacts).map_err(stringify)?;
        let executed = artifacts.join("executed.ipynb");
        rec.executed_path = Some(rel_to(&base, &executed));
        rec.outputs_dir = Some(rel_to(&base, &artifacts));
        runs::runs_upsert_at(&base, &rec.to_value())?;
        (Some(executed), Some(rec))
    } else {
        (None, None)
    };
    let opts = RunOptions {
        stop_on_error: input.stop_on_error.unwrap_or(true),
        timeout: Duration::from_secs(input.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS)),
        kernel: input.kernel,
        parameters: input.parameters,
        write_to,
    };
    let result = notebook::run_all(&session_id, &notebook_path, &opts);
    let (report, run_value) = match (result, run_record) {
        (Ok(report), Some(mut rec)) => {
            rec.status = status_str(report.status);
            rec.finished_at = Some(now_secs());
            let value = runs::runs_upsert_at(&base, &rec.to_value())?;
            (report, Some(value))
        }
        (Err(error), Some(mut rec)) => {
            rec.status = "error".to_string();
            rec.finished_at = Some(now_secs());
            let mut value = rec.to_value();
            value["error"] = json!(error.to_string());
            let _ = runs::runs_upsert_at(&base, &value);
            return Err(error.to_string());
        }
        (Ok(report), None) => (report, None),
        (Err(error), None) => return Err(error.to_string()),
    };
    to_pretty(&json!({
        "status": report.status,
        "ran": report.ran,
        "cells": report.cells,
        "executedPath": report.executed_path,
        "notebookPath": notebook_path.to_string_lossy(),
        "run": run_value,
    }))
}

pub fn run_notebook_kernel(input: NotebookKernelInput) -> Result<String, String> {
    match input.action.as_str() {
        "list" => to_pretty(&json!({ "kernels": KernelManager::list() })),
        "status" => {
            let path = resolve_path(&require_path(input.notebook_path.as_deref())?);
            let id = session_id_for(&path);
            let info = KernelManager::list().into_iter().find(|k| k.id == id);
            to_pretty(&json!({ "running": info.is_some(), "id": id, "kernel": info }))
        }
        "start" => {
            let path = resolve_path(&require_path(input.notebook_path.as_deref())?);
            let id = session_id_for(&path);
            let info = KernelManager::start(&id, input.kernel.as_deref(), &workdir_for(&path))
                .map_err(stringify)?;
            to_pretty(&json!({ "started": true, "kernel": info }))
        }
        "restart" => {
            let path = resolve_path(&require_path(input.notebook_path.as_deref())?);
            let id = session_id_for(&path);
            let _ = KernelManager::shutdown(&id);
            let info = KernelManager::start(&id, input.kernel.as_deref(), &workdir_for(&path))
                .map_err(stringify)?;
            to_pretty(&json!({ "restarted": true, "kernel": info }))
        }
        "shutdown" => {
            let path = resolve_path(&require_path(input.notebook_path.as_deref())?);
            let id = session_id_for(&path);
            KernelManager::shutdown(&id).map_err(stringify)?;
            to_pretty(&json!({ "shutdown": true, "id": id }))
        }
        "interrupt" => {
            let path = resolve_path(&require_path(input.notebook_path.as_deref())?);
            let id = session_id_for(&path);
            KernelManager::interrupt(&id).map_err(stringify)?;
            to_pretty(&json!({ "interrupted": true, "id": id }))
        }
        other => Err(format!(
            "unknown action '{other}' (use status | list | start | restart | shutdown | interrupt)"
        )),
    }
}

fn require_path(path: Option<&str>) -> Result<String, String> {
    path.map(str::to_string)
        .ok_or_else(|| "this action requires `notebook_path`".to_string())
}

/// Concatenate outputs into a quick human/LLM-readable transcript.
fn render_text(outputs: &[CellOutput]) -> String {
    let mut out = String::new();
    for output in outputs {
        match output {
            CellOutput::Stream { text, .. } => out.push_str(text),
            CellOutput::ExecuteResult { data, .. } | CellOutput::DisplayData { data } => {
                if let Some(text) = data.get("text/plain").and_then(Value::as_str) {
                    out.push_str(text);
                    out.push('\n');
                }
            }
            CellOutput::Error {
                ename,
                evalue,
                traceback,
            } => {
                if traceback.is_empty() {
                    out.push_str(&format!("{ename}: {evalue}\n"));
                } else {
                    out.push_str(&strip_ansi(&traceback.join("\n")));
                    out.push('\n');
                }
            }
            // Streaming-only signal, never stored in a cell's outputs.
            CellOutput::Clear { .. } => {}
        }
    }
    out
}

/// Strip ANSI escape sequences (ipython tracebacks are colorized).
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // Skip until the final byte of the CSI sequence (a letter).
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// The kernel session key for a notebook (its normalized absolute path).
fn session_id_for(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// Kernel working directory = the notebook's folder, so relative paths in the
/// notebook resolve next to the file.
fn workdir_for(path: &Path) -> PathBuf {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// Resolve a possibly-relative path against the workspace root, matching the
/// other workspace tools.
fn resolve_path(path: &str) -> PathBuf {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        return candidate;
    }
    let base = workspace_root();
    let direct = base.join(&candidate);
    if direct.exists() || layout::has_path_separator(path) {
        direct
    } else {
        base.join(layout::canonical_notebook_path(path))
    }
}

fn workspace_root() -> PathBuf {
    std::env::var("ARIS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .or_else(|_| std::env::current_dir())
        .unwrap_or_else(|_| PathBuf::from("."))
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

fn status_str(status: ExecStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "error".to_string())
}

fn to_pretty(value: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(stringify)
}

fn stringify<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "tests/notebook.rs"]
mod tests;
