//! Headless "run the whole notebook" execution, the primitive sweeps build on.
//!
//! Runs every non-empty code cell in order against a session kernel, writing
//! outputs back after each cell (so a crash leaves a partial-but-valid record).
//! With parameters it first injects a papermill-style override cell; with
//! `write_to` it runs a copy and leaves the source untouched.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::{ExecStatus, KernelManager, NotebookDoc, NotebookError};

#[derive(Debug, Clone)]
pub struct RunOptions {
    /// Stop at the first cell that errors / times out (default true).
    pub stop_on_error: bool,
    /// Per-cell execution timeout.
    pub timeout: Duration,
    /// Kernelspec name; `None` auto-picks Python.
    pub kernel: Option<String>,
    /// papermill-style parameter overrides injected before the first cell runs.
    pub parameters: Option<Map<String, Value>>,
    /// Run + write outputs to this path instead of in place (source untouched).
    pub write_to: Option<PathBuf>,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            stop_on_error: true,
            timeout: Duration::from_secs(120),
            kernel: None,
            parameters: None,
            write_to: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellRun {
    pub index: usize,
    pub status: ExecStatus,
    pub execution_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    /// Worst status across executed cells (Ok unless a cell failed).
    pub status: ExecStatus,
    pub cells: Vec<CellRun>,
    /// Where the executed notebook was written.
    pub executed_path: String,
    /// Number of code cells actually executed.
    pub ran: usize,
}

/// Execute all code cells of `source` against the kernel keyed by `session_id`.
pub fn run_all(
    session_id: &str,
    source: &Path,
    opts: &RunOptions,
) -> Result<RunReport, NotebookError> {
    let mut doc = NotebookDoc::load(source)?;
    if let Some(params) = &opts.parameters {
        doc.inject_parameters(params)?;
    }
    let target = opts
        .write_to
        .clone()
        .unwrap_or_else(|| source.to_path_buf());

    let workdir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf);
    KernelManager::start(session_id, opts.kernel.as_deref(), &workdir)?;

    // Persist the (possibly injected) notebook before running so the executed
    // artifact exists even if the first cell fails.
    doc.save(&target)?;

    let mut cells = Vec::new();
    let mut worst = ExecStatus::Ok;
    // Snapshot the cell list once; indices are stable for this run.
    let plan: Vec<(usize, String)> = doc
        .outline()
        .into_iter()
        .filter(|c| c.cell_type == "code" && !c.source.trim().is_empty())
        .map(|c| (c.index, c.source))
        .collect();

    for (index, code) in plan {
        let outcome = KernelManager::execute(session_id, &code, opts.timeout)?;
        doc.set_outputs(index, &outcome.outputs, outcome.execution_count)?;
        doc.save(&target)?; // checkpoint after each cell
        if rank(outcome.status) > rank(worst) {
            worst = outcome.status;
        }
        let stop = outcome.status != ExecStatus::Ok && opts.stop_on_error;
        cells.push(CellRun {
            index,
            status: outcome.status,
            execution_count: outcome.execution_count,
        });
        if stop {
            break;
        }
    }

    Ok(RunReport {
        status: worst,
        ran: cells.len(),
        cells,
        executed_path: target.to_string_lossy().to_string(),
    })
}

/// Severity ordering so the report surfaces the worst cell status.
fn rank(status: ExecStatus) -> u8 {
    match status {
        ExecStatus::Ok => 0,
        ExecStatus::Error => 1,
        ExecStatus::Timeout => 2,
    }
}
