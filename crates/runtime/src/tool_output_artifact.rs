//! Project-local persistence and compact references for large tool results.
//!
//! The transcript is a working projection, not the only copy of evidence.
//! Outputs above the threshold are kept under `.somniq/tmp/tool-output`; the
//! model receives a bounded preview plus an address it can read selectively.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

pub const TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARS: usize = 32_000;
pub(crate) const MIN_TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARS: usize = 8_000;
const TOOL_OUTPUT_REFERENCE_PREVIEW_CHARS: usize = 12_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutputArtifact {
    pub path: String,
    pub bytes: u64,
    pub chars: usize,
    pub sha256: Option<String>,
}

#[must_use]
pub(crate) fn ensure_tool_output_artifact(
    tool_use_id: &str,
    tool_name: &str,
    pristine_output: &str,
    rendered_output: &str,
    threshold_chars: usize,
) -> Option<ToolOutputArtifact> {
    if pristine_output.chars().count() <= threshold_chars
        && rendered_output.chars().count() <= threshold_chars
    {
        return None;
    }
    let digest = format!("{:x}", Sha256::digest(pristine_output.as_bytes()));
    let current_dir = crate::execution_current_dir().ok()?;
    let directory = crate::somniq_project_tmp_dir(current_dir).join("tool-output");
    if let Some(existing) = existing_artifact(rendered_output, pristine_output, &directory) {
        return Some(existing);
    }
    let file_name = format!(
        "{}-{}-{}.txt",
        &digest[..16],
        safe_component(tool_name),
        safe_component(tool_use_id)
    );
    let path = directory.join(file_name);
    if !path.is_file()
        && crate::atomic_file::write_replace(&path, pristine_output.as_bytes()).is_err()
    {
        return None;
    }
    Some(ToolOutputArtifact {
        path: absolute_display_path(&path),
        bytes: pristine_output.len().try_into().unwrap_or(u64::MAX),
        chars: pristine_output.chars().count(),
        sha256: Some(digest),
    })
}

#[must_use]
pub(crate) fn project_tool_output(
    output: String,
    artifact: &ToolOutputArtifact,
    artifact_threshold_chars: usize,
) -> String {
    let budget = TOOL_OUTPUT_REFERENCE_PREVIEW_CHARS.min(artifact_threshold_chars);
    let preview =
        field_aware_preview(&output, budget).unwrap_or_else(|| compact_edges(&output, budget));
    serde_json::to_string_pretty(&serde_json::json!({
        "status": "referenced",
        "preview": preview,
        "persistedOutputPath": artifact.path,
        "persistedOutputSize": artifact.bytes,
        "originalChars": artifact.chars,
        "sha256": artifact.sha256,
        "retrievalHint": "Use read_file on persistedOutputPath with a narrow line range or grep_search for a specific pattern; do not reload the whole artifact unless necessary."
    }))
    .unwrap_or(output)
}

fn existing_artifact(
    output: &str,
    pristine_output: &str,
    artifact_root: &Path,
) -> Option<ToolOutputArtifact> {
    let value = serde_json::from_str::<Value>(output).ok()?;
    let path = find_string_field(&value, &["persistedOutputPath", "rawOutputPath"])?;
    let path_buf = PathBuf::from(path);
    let canonical_path = crate::canonicalize(&path_buf).ok()?;
    let canonical_root = crate::canonicalize(artifact_root).ok()?;
    if !canonical_path.is_file() || !canonical_path.starts_with(canonical_root) {
        return None;
    }
    let metadata = fs::metadata(&canonical_path).ok();
    let bytes = find_u64_field(&value, "persistedOutputSize")
        .or_else(|| metadata.as_ref().map(std::fs::Metadata::len))
        .unwrap_or_default();
    Some(ToolOutputArtifact {
        path: absolute_display_path(&canonical_path),
        bytes,
        chars: pristine_output.chars().count(),
        sha256: Some(format!("{:x}", Sha256::digest(pristine_output.as_bytes()))),
    })
}

fn find_string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    match value {
        Value::Object(object) => {
            for key in keys {
                if let Some(value) = object.get(*key).and_then(Value::as_str) {
                    if !value.trim().is_empty() {
                        return Some(value);
                    }
                }
            }
            object
                .values()
                .find_map(|value| find_string_field(value, keys))
        }
        Value::Array(values) => values
            .iter()
            .find_map(|value| find_string_field(value, keys)),
        _ => None,
    }
}

fn find_u64_field(value: &Value, key: &str) -> Option<u64> {
    match value {
        Value::Object(object) => object
            .get(key)
            .and_then(Value::as_u64)
            .or_else(|| object.values().find_map(|value| find_u64_field(value, key))),
        Value::Array(values) => values.iter().find_map(|value| find_u64_field(value, key)),
        _ => None,
    }
}

/// Fields carrying the result the model actually asked for. They are budgeted
/// first, because losing them is losing the answer.
const PREVIEW_PRIORITY_FIELDS: &[&str] = &["stdout", "stderr", "content", "results"];
/// Percentage of the preview budget reserved for those fields.
const PREVIEW_PRIORITY_PERCENT: usize = 80;

/// A preview that spends its budget per field instead of on the envelope as an
/// opaque run of characters.
///
/// Head-and-tail trimming of the whole serialized envelope is blind to what it
/// is cutting, and JSON objects serialize in key order: on every measured
/// artifact the alphabetically-early `changes` diff consumed ~88% of the
/// preview and `stdout` — the thing the call was made for — was left with about
/// 165 characters. Diffs are also the most recoverable part of the envelope,
/// since the full artifact is on disk and the workspace holds the result.
///
/// Returns `None` for anything that is not a JSON object with fields worth
/// ranking, so plain text keeps the old whole-string behaviour exactly.
fn field_aware_preview(output: &str, budget: usize) -> Option<String> {
    let Value::Object(fields) = serde_json::from_str::<Value>(output).ok()? else {
        return None;
    };
    let priority_count = fields
        .keys()
        .filter(|key| PREVIEW_PRIORITY_FIELDS.contains(&key.as_str()))
        .count();
    if priority_count == 0 && !fields.contains_key("changes") {
        return None;
    }

    let priority_total = budget.saturating_mul(PREVIEW_PRIORITY_PERCENT) / 100;
    let priority_each = priority_total.checked_div(priority_count).unwrap_or(0);
    let other_count = fields
        .keys()
        .filter(|key| !PREVIEW_PRIORITY_FIELDS.contains(&key.as_str()) && *key != "changes")
        .count();
    let other_each = budget
        .saturating_sub(priority_total)
        .checked_div(other_count)
        .unwrap_or(0);

    let reduced = fields
        .iter()
        .map(|(key, value)| {
            let projected = if PREVIEW_PRIORITY_FIELDS.contains(&key.as_str()) {
                trim_value(value, priority_each)
            } else if key == "changes" {
                summarize_changes(value)
            } else {
                trim_value(value, other_each)
            };
            (key.clone(), projected)
        })
        .collect::<serde_json::Map<_, _>>();

    let rendered = serde_json::to_string_pretty(&Value::Object(reduced)).ok()?;
    // Per-field budgets bound the sum, but pretty-printing and key names are not
    // in any of them, so the whole thing is still clamped.
    Some(compact_edges(&rendered, budget))
}

/// Keep a value whole when it already fits, and fall back to edge-trimming its
/// serialized form when it does not. Small scalars and short objects keep their
/// JSON type rather than being flattened into a quoted string.
fn trim_value(value: &Value, budget: usize) -> Value {
    match value {
        Value::String(text) if text.chars().count() > budget => {
            Value::String(compact_edges(text, budget))
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => value.clone(),
        Value::Array(_) | Value::Object(_) => {
            let rendered = serde_json::to_string(value).unwrap_or_default();
            if rendered.chars().count() <= budget {
                value.clone()
            } else {
                Value::String(compact_edges(&rendered, budget))
            }
        }
    }
}

/// Replace each change's body with its shape: what happened to the file and how
/// much of it moved. `changeId` and `revision` are kept in full — they are
/// short, and the revision is what the next edit to that path has to present.
fn summarize_changes(changes: &Value) -> Value {
    let Some(entries) = changes.as_object() else {
        return changes.clone();
    };
    entries
        .iter()
        .map(|(path, change)| {
            let mut summary = serde_json::Map::new();
            for field in ["type", "changeId", "revision"] {
                if let Some(value) = change.get(field) {
                    summary.insert(field.to_string(), value.clone());
                }
            }
            summary.insert(
                "lines".to_string(),
                Value::String(change_line_delta(change)),
            );
            (path.clone(), Value::Object(summary))
        })
        .collect::<serde_json::Map<_, _>>()
        .into()
}

/// `+added/-removed` for one change, counted from whichever body it carries.
fn change_line_delta(change: &Value) -> String {
    if let Some(diff) = change.get("unified_diff").and_then(Value::as_str) {
        let added = diff
            .lines()
            .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
            .count();
        let removed = diff
            .lines()
            .filter(|line| line.starts_with('-') && !line.starts_with("---"))
            .count();
        return format!("+{added}/-{removed}");
    }
    let lines = change
        .get("content")
        .and_then(Value::as_str)
        .map_or(0, |content| content.lines().count());
    match change.get("type").and_then(Value::as_str) {
        Some("delete") => format!("+0/-{lines}"),
        _ => format!("+{lines}/-0"),
    }
}

fn compact_edges(value: &str, max_chars: usize) -> String {
    let total = value.chars().count();
    if total <= max_chars {
        return value.to_string();
    }
    let marker = format!(
        "\n\n[SomniQ omitted the middle of this artifact-backed preview: {total} characters in the rendered result.]\n\n"
    );
    let available = max_chars.saturating_sub(marker.chars().count());
    let head_chars = available.saturating_mul(3) / 4;
    let tail_chars = available.saturating_sub(head_chars);
    let head = value.chars().take(head_chars).collect::<String>();
    let tail = value
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}{marker}{tail}")
}

fn safe_component(value: &str) -> String {
    let value = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(48)
        .collect::<String>();
    if value.trim_matches('_').is_empty() {
        "tool".to_string()
    } else {
        value
    }
}

fn absolute_display_path(path: &Path) -> String {
    crate::canonicalize(path)
        .unwrap_or_else(|_| crate::plain_path(path))
        .display()
        .to_string()
}

#[cfg(test)]
#[path = "tests/tool_output_artifact.rs"]
mod tests;
