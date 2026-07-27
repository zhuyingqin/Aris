//! Experiment run library: one `.somniq/experiments/runs.json` per project.
//!
//! Mirrors the literature `.somniq/papers/library.json` contract (atomic write +
//! `.bak` recovery + id-keyed upsert). A *run* is one execution of a notebook,
//! optionally parameterized; its executed copy + outputs live under
//! `.somniq/experiments/runs/<id>/`. Local-kernel runs and GPU hand-offs (`backend:
//! "gpu"`) are recorded in the same ledger so the UI shows one unified list.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::layout;

const RUNS_FILE: &str = "runs.json";

/// `<project>/.somniq/experiments`.
pub fn experiments_dir_at(base: &Path) -> PathBuf {
    layout::experiments_dir_at(base)
}

/// `<project>/.somniq/experiments/runs.json`.
pub fn runs_path_at(base: &Path) -> PathBuf {
    experiments_dir_at(base).join(RUNS_FILE)
}

/// `<project>/experiments/runs/<id>` — where a run's executed notebook + outputs live.
pub fn run_artifacts_dir_at(base: &Path, id: &str) -> PathBuf {
    layout::runs_dir_at(base).join(id)
}

pub fn empty_runs() -> Value {
    json!({ "version": 1, "runs": [] })
}

/// One experiment run. Camel-cased to match the desktop/UI convention; unknown
/// fields on disk are preserved by going through `Value` in the merge path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub source_notebook: String,
    /// queued | running | ok | error | timeout
    pub status: String,
    /// local | gpu
    pub backend: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub params: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executed_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outputs_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sweep_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub metrics: Value,
}

impl RunRecord {
    /// A fresh `queued` local run with a generated id.
    pub fn new_local(source_notebook: &str) -> Self {
        Self {
            id: new_run_id(),
            source_notebook: source_notebook.to_string(),
            status: "queued".to_string(),
            backend: "local".to_string(),
            params: Value::Null,
            seed: None,
            executed_path: None,
            outputs_dir: None,
            sweep_id: None,
            started_at: None,
            finished_at: None,
            metrics: Value::Null,
        }
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

pub fn new_run_id() -> String {
    format!("run-{:x}", epoch_millis())
}

pub fn runs_load_at(base: &Path) -> Result<Value, String> {
    let path = runs_path_at(base);
    let backup = path.with_extension("json.bak");
    if !path.exists() {
        return if backup.exists() {
            read_runs_json(&backup)
        } else {
            Ok(empty_runs())
        };
    }
    match read_runs_json(&path) {
        Ok(runs) => Ok(runs),
        Err(primary_error) if backup.exists() => read_runs_json(&backup).map_err(|backup_error| {
            format!("{primary_error}; backup recovery failed: {backup_error}")
        }),
        Err(error) => Err(error),
    }
}

fn read_runs_json(path: &Path) -> Result<Value, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))
}

pub fn runs_save_at(base: &Path, runs: &Value) -> Result<(), String> {
    if !runs.is_object() {
        return Err("runs library must be a JSON object".to_string());
    }
    let path = runs_path_at(base);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let data = serde_json::to_vec_pretty(runs).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    let had_existing = path.exists();
    if had_existing {
        std::fs::copy(&path, &backup).map_err(|e| e.to_string())?;
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    if let Err(error) = std::fs::rename(&tmp, &path) {
        if had_existing {
            let _ = std::fs::copy(&backup, &path);
        }
        return Err(format!("failed to replace runs.json: {error}"));
    }
    Ok(())
}

/// Merge one run record into the library by `id`: field-level merge onto an
/// existing run (so partial status/metric updates don't clobber other fields),
/// or insert at the front for a new id. Returns the merged run.
pub fn runs_upsert_at(base: &Path, record: &Value) -> Result<Value, String> {
    let id = record
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("run record must have a non-empty `id`")?
        .to_string();

    let mut library = runs_load_at(base)?;
    if !library.is_object() {
        library = empty_runs();
    }
    let merged;
    {
        let runs = library
            .as_object_mut()
            .expect("library is an object")
            .entry("runs")
            .or_insert_with(|| Value::Array(Vec::new()));
        let Value::Array(runs) = runs else {
            return Err("runs.runs must be an array".to_string());
        };
        if let Some(existing) = runs
            .iter_mut()
            .find(|r| r.get("id").and_then(Value::as_str) == Some(id.as_str()))
        {
            merge_object(existing, record);
            merged = existing.clone();
        } else {
            runs.insert(0, record.clone());
            merged = record.clone();
        }
    }
    runs_save_at(base, &library)?;
    Ok(merged)
}

/// Shallow-merge the keys of `src` onto `dst` (both expected to be objects).
fn merge_object(dst: &mut Value, src: &Value) {
    if let (Some(dst), Some(src)) = (dst.as_object_mut(), src.as_object()) {
        for (key, value) in src {
            dst.insert(key.clone(), value.clone());
        }
    }
}

fn epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "tests/runs.rs"]
mod tests;
