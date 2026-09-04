//! Local multi-run sweeps: expand a parameter grid into N runs, execute each
//! against its own kernel session, persist the executed notebook under
//! `experiments/runs/<id>/`, and record every run in `experiments/runs.json`.
//!
//! Local sweeps run **sequentially** (one kernel at a time) to stay light on
//! Windows kernels; large grids are meant to hand off to the GPU skills via
//! [`export_manifest`].

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notebook::{run_all, ExecStatus, KernelManager, RunOptions};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::layout;
use crate::runs::{self, RunRecord};

const DEFAULT_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Clone, Deserialize)]
pub struct SweepSpec {
    /// Project-relative (or absolute) path to the base notebook.
    pub notebook: String,
    /// Seeds to sweep; each injected as `seed`. Empty → a single unseeded run.
    #[serde(default)]
    pub seeds: Vec<i64>,
    /// Other parameters: name → array of values (full cartesian product).
    #[serde(default)]
    pub params: Map<String, Value>,
    #[serde(default)]
    pub stop_on_error: Option<bool>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub kernel: Option<String>,
}

/// One concrete grid point: the scalar parameters for a single run.
#[derive(Debug, Clone)]
pub struct RunPoint {
    pub seed: Option<i64>,
    pub params: Map<String, Value>,
}

/// Expand `seeds × (cartesian product of param value-lists)` into concrete points.
pub fn expand_grid(spec: &SweepSpec) -> Result<Vec<RunPoint>, String> {
    // Cartesian product of the param axes (deterministic key order).
    let mut combos: Vec<Map<String, Value>> = vec![Map::new()];
    for (key, value) in &spec.params {
        let values = value
            .as_array()
            .ok_or_else(|| format!("params.{key} must be an array of values"))?;
        if values.is_empty() {
            return Err(format!("params.{key} must list at least one value"));
        }
        let mut next = Vec::with_capacity(combos.len() * values.len());
        for combo in &combos {
            for v in values {
                let mut c = combo.clone();
                c.insert(key.clone(), v.clone());
                next.push(c);
            }
        }
        combos = next;
    }

    let seeds: Vec<Option<i64>> = if spec.seeds.is_empty() {
        vec![None]
    } else {
        spec.seeds.iter().map(|s| Some(*s)).collect()
    };

    let mut points = Vec::with_capacity(seeds.len() * combos.len());
    for seed in &seeds {
        for combo in &combos {
            let mut params = combo.clone();
            if let Some(s) = seed {
                params.insert("seed".to_string(), json!(s));
            }
            points.push(RunPoint {
                seed: *seed,
                params,
            });
        }
    }
    Ok(points)
}

/// Run the sweep locally + sequentially, recording each run in `runs.json`.
/// `notebook_abs` is the already-resolved absolute base-notebook path; `base`
/// is the project root the run ledger + artifacts live under.
pub fn run_sweep_local(
    base: &Path,
    notebook_abs: &Path,
    spec: &SweepSpec,
) -> Result<Value, String> {
    let points = expand_grid(spec)?;
    let sweep_id = format!("sweep-{:x}", now_millis());
    let mut summaries = Vec::with_capacity(points.len());

    for point in &points {
        let mut rec = RunRecord::new_local(&spec.notebook);
        rec.sweep_id = Some(sweep_id.clone());
        rec.seed = point.seed;
        rec.params = Value::Object(point.params.clone());
        rec.status = "running".to_string();
        rec.started_at = Some(now_secs());

        let artifacts = runs::run_artifacts_dir_at(base, &rec.id);
        std::fs::create_dir_all(&artifacts).map_err(|e| e.to_string())?;
        let executed = artifacts.join("executed.ipynb");
        rec.executed_path = Some(rel_to(base, &executed));
        rec.outputs_dir = Some(rel_to(base, &artifacts));
        runs::runs_upsert_at(base, &rec.to_value())?;

        let opts = RunOptions {
            stop_on_error: spec.stop_on_error.unwrap_or(true),
            timeout: Duration::from_secs(spec.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS)),
            kernel: spec.kernel.clone(),
            parameters: Some(point.params.clone()),
            write_to: Some(executed.clone()),
        };
        // Each run is isolated in its own kernel session (keyed by the executed
        // path) and torn down afterwards so a long sweep doesn't pile up kernels.
        let session_id = executed.to_string_lossy().to_string();
        let result = run_all(&session_id, notebook_abs, &opts);
        let _ = KernelManager::shutdown(&session_id);

        let (status, error) = match &result {
            Ok(report) => (status_str(report.status), None),
            Err(e) => ("error".to_string(), Some(e.to_string())),
        };
        rec.status = status.clone();
        rec.finished_at = Some(now_secs());
        let mut update = rec.to_value();
        if let Some(err) = error {
            update["error"] = json!(err);
        }
        runs::runs_upsert_at(base, &update)?;
        summaries.push(json!({ "id": rec.id, "seed": point.seed, "status": status }));
    }

    Ok(json!({ "sweepId": sweep_id, "total": points.len(), "runs": summaries }))
}

/// LLM-tool entry: resolve paths against the workspace root, then run locally.
pub fn run_notebook_sweep(spec: SweepSpec) -> Result<String, String> {
    let base = workspace_root();
    let notebook_abs = resolve_against(&base, &spec.notebook);
    let result = run_sweep_local(&base, &notebook_abs, &spec)?;
    serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
}

fn workspace_root() -> PathBuf {
    runtime::workspace_root_from_env()
}

fn resolve_against(base: &Path, path: &str) -> PathBuf {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        candidate
    } else {
        base.join(candidate)
    }
}

/// Render the sweep as an `experiment-queue` YAML manifest for GPU hand-off.
/// Heavy grids belong on the GPU box; this produces a ready-to-edit manifest
/// (one papermill job per grid point) that `/experiment-queue` consumes.
pub fn export_manifest(spec: &SweepSpec) -> Result<String, String> {
    let points = expand_grid(spec)?;
    let mut out = String::new();
    out.push_str(&format!("project: {}\n", manifest_project(&spec.notebook)));
    out.push_str("cwd: .\n");
    out.push_str("conda: base\n");
    out.push_str("ssh: gpu-server\n");
    out.push_str(
        "# Generated by Aris from a notebook sweep — set ssh/conda/cwd for your GPU box.\n",
    );
    out.push_str("jobs:\n");
    for (i, point) in points.iter().enumerate() {
        let params_json = serde_json::to_string(&Value::Object(point.params.clone()))
            .map_err(|e| e.to_string())?;
        out.push_str(&format!("  - name: run-{i:03}\n"));
        out.push_str(&format!(
            "    cmd: papermill {} {}/{}/{}/gpu-out-{i:03}.ipynb -y '{}'\n",
            spec.notebook,
            layout::PROJECT_DATA_DIR,
            layout::EXPERIMENTS_DIR,
            layout::RUNS_SUBDIR,
            params_json
        ));
    }
    Ok(out)
}

fn manifest_project(notebook: &str) -> String {
    Path::new(notebook)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("notebook-sweep")
        .to_string()
}

/// Map an `ExecStatus` to the run-ledger status vocabulary (ok | error | timeout).
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

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "tests/sweep.rs"]
mod tests;
