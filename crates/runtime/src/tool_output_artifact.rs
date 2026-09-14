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
    let preview = compact_edges(
        &output,
        TOOL_OUTPUT_REFERENCE_PREVIEW_CHARS.min(artifact_threshold_chars),
    );
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
    let canonical_path = path_buf.canonicalize().ok()?;
    let canonical_root = artifact_root.canonicalize().ok()?;
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
        sha256: Some(format!(
            "{:x}",
            Sha256::digest(pristine_output.as_bytes())
        )),
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
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

#[cfg(test)]
#[path = "tests/tool_output_artifact.rs"]
mod tests;
