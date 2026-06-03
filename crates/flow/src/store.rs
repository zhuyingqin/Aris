//! Content-addressed step store: the mechanism behind cache-on-resume and fork.
//!
//! A step's [`StepKey`] is `sha256(step.id ⊕ canonical(kind) ⊕ resolved_inputs ⊕ model)`.
//! Because the model and every resolved input feed the key, changing any of them
//! changes the key, which transparently invalidates that step *and everything
//! downstream* (downstream inputs include this step's output). No manual busting.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::def::{RoleRef, Step};
use crate::error::{FlowError, Result};

/// A content address for a step's result (hex sha256).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct StepKey(pub String);

impl StepKey {
    /// The short prefix used in logs/UX.
    #[must_use]
    pub fn short(&self) -> &str {
        &self.0[..self.0.len().min(12)]
    }
}

impl std::fmt::Display for StepKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The persisted result of a completed step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    /// The content address this result is stored under.
    pub key: StepKey,
    /// The step id that produced it.
    pub step: String,
    /// The model that produced it.
    pub model: String,
    /// The step's text output.
    pub output: String,
    /// Unix-epoch milliseconds when the result was produced.
    pub created_at_ms: u128,
    /// Optional provider usage payload (tokens, etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
}

/// Compute the content address for a step given its resolved inputs and model.
///
/// `resolved_inputs` is the binding-name → resolved-string map. A [`BTreeMap`]
/// keeps the hash input canonical (sorted keys), so the key is stable across runs.
#[must_use]
pub fn compute_key(
    step: &Step,
    role: &RoleRef,
    resolved_inputs: &BTreeMap<String, String>,
) -> StepKey {
    // Build a canonical JSON document. serde_json::Map (without the preserve_order
    // feature) is BTreeMap-backed, so object keys serialize in sorted order.
    let canonical = serde_json::json!({
        "step_id": step.id,
        "kind": step.kind,
        "model": role.model,
        "inputs": resolved_inputs,
    });
    // to_string on a Value is deterministic given sorted keys.
    let bytes = serde_json::to_vec(&canonical).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    StepKey(hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Per-run store rooted at `.clawd-flows/<run_id>/store/`.
#[derive(Debug, Clone)]
pub struct StepStore {
    dir: PathBuf,
}

impl StepStore {
    /// Open (creating if needed) the store directory for a run.
    ///
    /// # Errors
    /// Returns [`FlowError::Io`] if the directory cannot be created.
    pub fn open(run_dir: &Path) -> Result<Self> {
        let dir = run_dir.join("store");
        std::fs::create_dir_all(&dir).map_err(|e| FlowError::io(dir.display().to_string(), e))?;
        Ok(Self { dir })
    }

    fn path_for(&self, key: &StepKey) -> PathBuf {
        self.dir.join(format!("{}.json", key.0))
    }

    /// Look up a cached result by key.
    ///
    /// # Errors
    /// Returns [`FlowError::Io`] / [`FlowError::Serde`] on a corrupt entry.
    pub fn get(&self, key: &StepKey) -> Result<Option<StepResult>> {
        let path = self.path_for(key);
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(FlowError::io(path.display().to_string(), e)),
        }
    }

    /// Persist a step result under its content address.
    ///
    /// # Errors
    /// Returns [`FlowError::Io`] / [`FlowError::Serde`] on failure.
    pub fn put(&self, result: &StepResult) -> Result<()> {
        let path = self.path_for(&result.key);
        let bytes = serde_json::to_vec_pretty(result)?;
        std::fs::write(&path, bytes).map_err(|e| FlowError::io(path.display().to_string(), e))
    }

    /// Copy an entry (if present) from another store into this one — used by `fork`
    /// to seed the new run with the parent's still-valid upstream results.
    ///
    /// # Errors
    /// Propagates read/write failures.
    pub fn import_from(&self, src: &StepStore, key: &StepKey) -> Result<bool> {
        match src.get(key)? {
            Some(result) => {
                self.put(&result)?;
                Ok(true)
            }
            None => Ok(false),
        }
    }
}

/// Resolve the `.clawd-flows` root: the workspace root if we can find a `Cargo.toml`
/// containing `[workspace]` by walking up from the cwd, else the cwd. Mirrors the
/// convention of `agent_store_dir` in the `tools` crate (`.clawd-agents`).
#[must_use]
pub fn flows_root() -> PathBuf {
    // Explicit override (used for test isolation and to relocate flow storage).
    if let Some(dir) = std::env::var_os("ARIS_FLOW_HOME") {
        return PathBuf::from(dir);
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut cur = cwd.as_path();
    loop {
        let manifest = cur.join("Cargo.toml");
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            if text.contains("[workspace]") {
                return cur.join(".clawd-flows");
            }
        }
        match cur.parent() {
            Some(parent) => cur = parent,
            None => break,
        }
    }
    cwd.join(".clawd-flows")
}

/// The directory for a specific run.
#[must_use]
pub fn run_dir(run_id: &str) -> PathBuf {
    flows_root().join(run_id)
}
