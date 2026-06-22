//! `serde_json`-backed `.ipynb` document with structured cell edits.
//!
//! The on-disk format is JSON, so the in-memory model is [`serde_json::Value`].
//! `nbformat::parse_notebook` validates v4 structure on load (and accepts/repairs
//! legacy + v4.x quirks); all mutations then happen on the JSON tree, which keeps
//! us off `nbformat`'s private cell/output constructors and matches exactly what
//! `JupyterLab` writes back to disk.

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use crate::kernel::CellOutput;
use crate::NotebookError;

/// A compact, LLM/UI-friendly view of a single cell.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellSummary {
    pub index: usize,
    pub cell_type: String,
    pub source: String,
    pub execution_count: Option<i64>,
    pub output_count: usize,
    pub has_error: bool,
}

/// An in-memory `.ipynb` notebook.
#[derive(Debug, Clone)]
pub struct NotebookDoc {
    root: Value,
}

impl NotebookDoc {
    /// Load and validate a notebook from disk.
    pub fn load(path: &Path) -> Result<Self, NotebookError> {
        let text = std::fs::read_to_string(path)?;
        Self::from_json_str(&text)
    }

    /// Load from disk, or return a fresh empty notebook if the file is absent.
    pub fn load_or_empty(path: &Path) -> Result<Self, NotebookError> {
        if path.exists() {
            Self::load(path)
        } else {
            Ok(Self::new_empty())
        }
    }

    /// Parse + validate a notebook from a JSON string.
    pub fn from_json_str(text: &str) -> Result<Self, NotebookError> {
        // Validate structure (this is the guard that catches corruption early).
        nbformat::parse_notebook(text).map_err(|e| NotebookError::Format(e.to_string()))?;
        let root: Value = serde_json::from_str(text)?;
        Ok(Self { root })
    }

    /// A new, empty nbformat v4.5 notebook.
    pub fn new_empty() -> Self {
        Self {
            root: json!({
                "cells": [],
                "metadata": {},
                "nbformat": 4,
                "nbformat_minor": 5
            }),
        }
    }

    /// Serialize back to disk (pretty-printed, like `JupyterLab`).
    pub fn save(&self, path: &Path) -> Result<(), NotebookError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(path, serde_json::to_string_pretty(&self.root)?)?;
        Ok(())
    }

    /// The raw notebook JSON (for the UI / Tauri layer).
    pub fn as_json(&self) -> &Value {
        &self.root
    }

    pub fn len(&self) -> usize {
        self.cells().len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells().is_empty()
    }

    fn cells(&self) -> &[Value] {
        match self.root.get("cells").and_then(Value::as_array) {
            Some(cells) => cells,
            None => &[],
        }
    }

    fn cells_mut(&mut self) -> &mut Vec<Value> {
        if !self.root.get("cells").is_some_and(Value::is_array) {
            self.root["cells"] = json!([]);
        }
        self.root
            .get_mut("cells")
            .and_then(Value::as_array_mut)
            .expect("cells initialized above")
    }

    fn check(&self, index: usize) -> Result<(), NotebookError> {
        let len = self.len();
        if index >= len {
            return Err(NotebookError::CellIndex { index, len });
        }
        Ok(())
    }

    /// One [`CellSummary`] per cell, in order.
    pub fn outline(&self) -> Vec<CellSummary> {
        self.cells()
            .iter()
            .enumerate()
            .map(|(index, cell)| {
                let outputs = cell.get("outputs").and_then(Value::as_array);
                CellSummary {
                    index,
                    cell_type: cell
                        .get("cell_type")
                        .and_then(Value::as_str)
                        .unwrap_or("code")
                        .to_string(),
                    source: join_source(cell.get("source")),
                    execution_count: cell.get("execution_count").and_then(Value::as_i64),
                    output_count: outputs.map_or(0, std::vec::Vec::len),
                    has_error: outputs.is_some_and(|outs| {
                        outs.iter()
                            .any(|o| o.get("output_type").and_then(Value::as_str) == Some("error"))
                    }),
                }
            })
            .collect()
    }

    /// The full source text of one cell.
    pub fn cell_source(&self, index: usize) -> Result<String, NotebookError> {
        self.check(index)?;
        Ok(join_source(self.cells()[index].get("source")))
    }

    /// Insert a new cell at `index` (clamped to the end). Returns the final index.
    pub fn insert(
        &mut self,
        index: usize,
        cell_type: &str,
        source: &str,
    ) -> Result<usize, NotebookError> {
        let at = index.min(self.len());
        let cell = new_cell(cell_type, source)?;
        self.cells_mut().insert(at, cell);
        Ok(at)
    }

    /// Append a new cell at the end. Returns its index.
    pub fn append(&mut self, cell_type: &str, source: &str) -> Result<usize, NotebookError> {
        let at = self.len();
        self.insert(at, cell_type, source)
    }

    /// Replace a cell's source. For code cells this also clears stale
    /// outputs + execution count (they no longer describe the new source).
    pub fn replace_source(&mut self, index: usize, source: &str) -> Result<(), NotebookError> {
        self.check(index)?;
        let cells = self.cells_mut();
        let is_code = cells[index].get("cell_type").and_then(Value::as_str) == Some("code");
        cells[index]["source"] = Value::String(source.to_string());
        if is_code {
            cells[index]["outputs"] = json!([]);
            cells[index]["execution_count"] = Value::Null;
        }
        Ok(())
    }

    /// Delete the cell at `index`.
    pub fn delete(&mut self, index: usize) -> Result<(), NotebookError> {
        self.check(index)?;
        self.cells_mut().remove(index);
        Ok(())
    }

    /// Move the cell at `from` to `to` (clamped to the last index), carrying its
    /// source, outputs, and execution count with it. Unlike a delete+insert this
    /// preserves the cell verbatim, so reordering in the UI never drops results.
    pub fn move_cell(&mut self, from: usize, to: usize) -> Result<(), NotebookError> {
        self.check(from)?;
        let cells = self.cells_mut();
        let to = to.min(cells.len().saturating_sub(1));
        if from == to {
            return Ok(());
        }
        let cell = cells.remove(from);
        cells.insert(to, cell);
        Ok(())
    }

    /// Write execution results back into a code cell.
    pub fn set_outputs(
        &mut self,
        index: usize,
        outputs: &[CellOutput],
        execution_count: Option<i64>,
    ) -> Result<(), NotebookError> {
        self.check(index)?;
        let nb_outputs: Vec<Value> = outputs.iter().map(CellOutput::to_nbformat_json).collect();
        let cells = self.cells_mut();
        cells[index]["outputs"] = Value::Array(nb_outputs);
        cells[index]["execution_count"] = execution_count.map_or(Value::Null, |c| json!(c));
        Ok(())
    }

    /// The kernel recorded in `metadata.kernelspec.name`, if any. Callers use this
    /// to start the notebook's declared kernel when none is given explicitly.
    pub fn kernelspec_name(&self) -> Option<String> {
        self.kernelspec_field("name")
    }

    /// The language recorded in `metadata.kernelspec.language` (e.g. `"matlab"`),
    /// which decides how injected-parameter cells are rendered.
    pub fn notebook_language(&self) -> Option<String> {
        self.kernelspec_field("language")
    }

    fn kernelspec_field(&self, field: &str) -> Option<String> {
        self.root
            .get("metadata")
            .and_then(|m| m.get("kernelspec"))
            .and_then(|k| k.get(field))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }

    /// Record the selected kernel under the standard nbformat
    /// `metadata.kernelspec` field, so reopening the notebook restores the choice.
    pub fn set_kernelspec(&mut self, name: &str, display_name: &str, language: &str) {
        if !self.root.get("metadata").is_some_and(Value::is_object) {
            self.root["metadata"] = json!({});
        }
        self.root["metadata"]["kernelspec"] = json!({
            "name": name,
            "display_name": display_name,
            "language": language,
        });
    }

    /// Index of the first code cell tagged `parameters` (the papermill convention
    /// for "this cell declares the notebook's default parameters").
    pub fn find_parameters_cell(&self) -> Option<usize> {
        self.cells()
            .iter()
            .position(|c| cell_has_tag(c, PARAMETERS_TAG))
    }

    /// Inject parameter overrides as a new code cell (tagged `injected-parameters`)
    /// placed right after the `parameters` cell — or at the top if there isn't one.
    /// This is papermill's mechanism: the override cell re-binds the names *after*
    /// the defaults run. Returns the injected cell's index. No-op for empty params.
    pub fn inject_parameters(
        &mut self,
        params: &serde_json::Map<String, Value>,
    ) -> Result<Option<usize>, NotebookError> {
        if params.is_empty() {
            return Ok(None);
        }
        // Render assignments in the notebook's own language so a MATLAB sweep
        // injects MATLAB (`x = 7;`), not Python — the previous Python-only path
        // silently corrupted MATLAB notebooks.
        let matlab = self
            .notebook_language()
            .is_some_and(|lang| lang.eq_ignore_ascii_case("matlab"));
        let mut source = String::from(if matlab {
            "% Parameters injected by Aris\n"
        } else {
            "# Parameters injected by Aris\n"
        });
        for (key, value) in params {
            if matlab {
                source.push_str(&format!("{key} = {};\n", mat_literal(value)));
            } else {
                source.push_str(&format!("{key} = {}\n", py_literal(value)));
            }
        }
        let at = self.find_parameters_cell().map_or(0, |i| i + 1);
        let cell = new_tagged_code_cell(&source, INJECTED_TAG)?;
        self.cells_mut().insert(at, cell);
        Ok(Some(at))
    }
}

/// Papermill cell tags.
const PARAMETERS_TAG: &str = "parameters";
const INJECTED_TAG: &str = "injected-parameters";

/// Whether a cell's `metadata.tags` array contains `tag`.
fn cell_has_tag(cell: &Value, tag: &str) -> bool {
    cell.get("metadata")
        .and_then(|m| m.get("tags"))
        .and_then(Value::as_array)
        .is_some_and(|tags| tags.iter().any(|t| t.as_str() == Some(tag)))
}

/// Render a JSON value as an equivalent Python literal (papermill-style), so an
/// injected `name = <literal>` assignment is valid Python. Recurses for
/// lists/dicts; JSON string escapes are also valid Python string escapes.
fn py_literal(value: &Value) -> String {
    match value {
        Value::Null => "None".to_string(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(_) => value.to_string(),
        Value::Array(items) => {
            let inner: Vec<String> = items.iter().map(py_literal).collect();
            format!("[{}]", inner.join(", "))
        }
        Value::Object(map) => {
            let inner: Vec<String> = map
                .iter()
                .map(|(k, v)| format!("{}: {}", Value::String(k.clone()), py_literal(v)))
                .collect();
            format!("{{{}}}", inner.join(", "))
        }
    }
}

/// Render a JSON value as an equivalent MATLAB literal, so an injected
/// `name = <literal>;` assignment is valid MATLAB. Numeric arrays become row
/// vectors `[..]`, mixed arrays become cell arrays `{..}`, objects become
/// `struct('k', v, ...)`, and strings use single quotes (doubling embedded `'`).
fn mat_literal(value: &Value) -> String {
    match value {
        Value::Null => "[]".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        Value::Array(items) => {
            let inner: Vec<String> = items.iter().map(mat_literal).collect();
            if items.iter().all(Value::is_number) {
                format!("[{}]", inner.join(", "))
            } else {
                format!("{{{}}}", inner.join(", "))
            }
        }
        Value::Object(map) => {
            let inner: Vec<String> = map
                .iter()
                .map(|(k, v)| format!("'{}', {}", k.replace('\'', "''"), mat_literal(v)))
                .collect();
            format!("struct({})", inner.join(", "))
        }
    }
}

/// A code cell carrying a single metadata tag.
fn new_tagged_code_cell(source: &str, tag: &str) -> Result<Value, NotebookError> {
    let mut cell = new_cell("code", source)?;
    cell["metadata"]["tags"] = json!([tag]);
    Ok(cell)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_parameters_lands_after_the_parameters_cell() {
        let mut doc = NotebookDoc::new_empty();
        // A tagged `parameters` cell with defaults, then a body cell.
        let cell = new_tagged_code_cell("seed = 0\nlr = 0.1", PARAMETERS_TAG).unwrap();
        doc.cells_mut().push(cell);
        doc.append("code", "print(seed)").unwrap();
        assert_eq!(doc.find_parameters_cell(), Some(0));

        let mut params = serde_json::Map::new();
        params.insert("seed".into(), json!(7));
        params.insert("name".into(), json!("run-a"));
        params.insert("flag".into(), json!(true));
        let at = doc.inject_parameters(&params).unwrap();
        assert_eq!(at, Some(1), "injected cell goes right after parameters");
        assert_eq!(doc.len(), 3);

        let injected = doc.cell_source(1).unwrap();
        assert!(injected.contains("seed = 7"), "got: {injected}");
        assert!(injected.contains("name = \"run-a\""), "got: {injected}");
        assert!(injected.contains("flag = True"), "got: {injected}");
        assert!(cell_has_tag(doc.cells().get(1).unwrap(), INJECTED_TAG));
    }

    #[test]
    fn inject_parameters_renders_matlab_for_matlab_notebooks() {
        let mut doc = NotebookDoc::new_empty();
        doc.set_kernelspec("matlab", "MATLAB", "matlab");
        doc.append("code", "disp(seed)").unwrap();
        assert_eq!(doc.kernelspec_name().as_deref(), Some("matlab"));

        let mut params = serde_json::Map::new();
        params.insert("seed".into(), json!(7));
        params.insert("name".into(), json!("run-a"));
        params.insert("flag".into(), json!(true));
        params.insert("lrs".into(), json!([0.1, 0.01]));
        let at = doc.inject_parameters(&params).unwrap();
        assert_eq!(at, Some(0));

        let injected = doc.cell_source(0).unwrap();
        assert!(injected.contains("% Parameters injected by Aris"), "got: {injected}");
        assert!(injected.contains("seed = 7;"), "got: {injected}");
        assert!(injected.contains("name = 'run-a';"), "got: {injected}");
        assert!(injected.contains("flag = true;"), "got: {injected}");
        assert!(injected.contains("lrs = [0.1, 0.01];"), "got: {injected}");
        // No Python literals leaked in.
        assert!(!injected.contains("True"), "got: {injected}");
    }

    #[test]
    fn inject_parameters_without_tag_goes_to_top_and_empty_is_noop() {
        let mut doc = NotebookDoc::new_empty();
        doc.append("code", "x = 1").unwrap();
        let mut params = serde_json::Map::new();
        params.insert("x".into(), json!(99));
        assert_eq!(doc.inject_parameters(&params).unwrap(), Some(0));
        assert!(doc.cell_source(0).unwrap().contains("x = 99"));

        // Empty params injects nothing.
        let mut doc2 = NotebookDoc::new_empty();
        doc2.append("code", "pass").unwrap();
        assert_eq!(
            doc2.inject_parameters(&serde_json::Map::new()).unwrap(),
            None
        );
        assert_eq!(doc2.len(), 1);
    }
}

/// nbformat allows `source` to be a string or an array of lines; normalize to a string.
fn join_source(source: Option<&Value>) -> String {
    match source {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(lines)) => lines.iter().filter_map(Value::as_str).collect(),
        _ => String::new(),
    }
}

fn new_cell(cell_type: &str, source: &str) -> Result<Value, NotebookError> {
    let id = uuid::Uuid::new_v4().to_string();
    let cell = match cell_type {
        "code" => json!({
            "cell_type": "code",
            "id": id,
            "metadata": {},
            "source": source,
            "outputs": [],
            "execution_count": null
        }),
        "markdown" => json!({
            "cell_type": "markdown",
            "id": id,
            "metadata": {},
            "source": source
        }),
        "raw" => json!({
            "cell_type": "raw",
            "id": id,
            "metadata": {},
            "source": source
        }),
        other => {
            return Err(NotebookError::Format(format!(
                "unknown cell_type '{other}' (expected code | markdown | raw)"
            )))
        }
    };
    Ok(cell)
}
