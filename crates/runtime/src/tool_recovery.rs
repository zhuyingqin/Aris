//! Recovery for deterministic editing/command mistakes. Preserve diagnostics,
//! recommend an actionable alternative immediately, and bound unchanged retries.

use std::collections::HashMap;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_UNCHANGED_FAILURES: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum FailureKind {
    RegexEscape,
    Quoting,
    MissingPath,
    StaleAnchor,
    ScriptType,
}

impl FailureKind {
    fn name(self) -> &'static str {
        match self {
            Self::RegexEscape => "regex_escape",
            Self::Quoting => "quoting",
            Self::MissingPath => "missing_path",
            Self::StaleAnchor => "stale_edit_anchor",
            Self::ScriptType => "script_type_error",
        }
    }

    fn hint(self) -> &'static str {
        match self {
            Self::RegexEscape => "The regex/escape mechanism failed. For existing-file edits, read the exact source window and use edit_file or multi_edit with literal old_string/new_string and the returned revision. Do not try another nested shell/Python regex rewrite of LaTeX backslashes. If a script is essential, write a standalone script with write_file, pass data as arguments, and use literal replacement or re.escape for literal patterns.",
            Self::Quoting => "The command's quoting or string syntax failed. Avoid nested shell/Python/LaTeX escaping: use edit_file or multi_edit for a source change, or write a standalone script with write_file and run that file with separate arguments. Preserve literal backslashes and actual newlines; do not build another inline one-liner.",
            Self::MissingPath => "The requested path was not found. Use the returned path suggestions or glob/read_file to locate the existing source, then reuse its exact path and revision. Check the working directory before another command; do not guess sibling paths or create a replacement artifact.",
            Self::StaleAnchor => "The edit anchor did not match the current source. The failed structured edit left the file unchanged. Read the relevant source window again, copy an exact unique anchor and its revision, then submit the known replacements together with multi_edit. Do not fall back to an unchecked whole-file shell rewrite.",
            Self::ScriptType => "The editing script raised a type error. For source edits, read_file plus edit_file/multi_edit avoids ad-hoc decoding and regex code. If computation is needed, inspect the actual value/type in a standalone script and correct the smallest step before rerunning.",
        }
    }
}

#[derive(Debug, Clone)]
struct RequestFailure {
    kind: FailureKind,
    count: usize,
}

#[derive(Debug, Default)]
pub(crate) struct ToolRecoveryState {
    requests: HashMap<String, RequestFailure>,
    families: HashMap<(String, FailureKind), usize>,
}

impl ToolRecoveryState {
    /// A new human turn authorizes a fresh attempt. State is otherwise retained
    /// through context compaction instead of repeatedly forgiving the same call.
    pub(crate) fn reset(&mut self) {
        self.requests.clear();
        self.families.clear();
    }

    pub(crate) fn before_tool(&self, tool_name: &str, input: &str) -> Option<String> {
        let failure = self.requests.get(&request_key(tool_name, input))?;
        if failure.count < MAX_UNCHANGED_FAILURES {
            return None;
        }
        Some(json!({
            "status": "blocked",
            "reason": "repeated_failed_tool_request",
            "failureKind": failure.kind.name(),
            "failedAttempts": failure.count,
            "changeMechanismRequired": true,
            "recoveryHint": failure.kind.hint(),
            "message": "This unchanged request has already failed twice. Continue with a corrected request or a different editing mechanism; read, discovery and repair tools remain available. Changing only the description or timeout is not a correction."
        }).to_string())
    }

    pub(crate) fn observe(
        &mut self,
        tool_name: &str,
        input: &str,
        output: String,
        is_error: bool,
    ) -> String {
        let key = request_key(tool_name, input);
        if !is_error {
            self.requests.remove(&key);
            // An actual source/script correction can make an old command valid.
            // Merely reading a file does not erase its unresolved failures.
            if matches!(
                tool_name,
                "edit_file" | "multi_edit" | "edit_docx" | "write_file" | "write_files" | "WriteFileCommit"
            ) {
                self.reset();
            }
            return output;
        }
        let Some(kind) = failure_kind(tool_name, &output) else {
            return output;
        };
        let failure = self
            .requests
            .entry(key)
            .or_insert(RequestFailure { kind, count: 0 });
        if failure.kind != kind {
            failure.kind = kind;
            failure.count = 0;
        }
        failure.count += 1;
        let request_failures = failure.count;
        let mechanism = if matches!(tool_name, "bash" | "PowerShell") {
            "shell"
        } else {
            tool_name
        };
        let family_failures = self
            .families
            .entry((mechanism.to_string(), kind))
            .or_default();
        *family_failures += 1;
        let advice = json!({
            "failureKind": kind.name(),
            "failedAttempts": request_failures,
            "sameMechanismFailures": *family_failures,
            "changeMechanismRequired": *family_failures >= MAX_UNCHANGED_FAILURES,
            "recoveryHint": kind.hint()
        });
        match serde_json::from_str::<Value>(&output) {
            Ok(Value::Object(mut value)) => {
                value.insert(
                    "recoveryHint".to_string(),
                    Value::String(kind.hint().to_string()),
                );
                value.insert("toolRecovery".to_string(), advice);
                Value::Object(value).to_string()
            }
            _ => format!("{output}\n\nTool recovery: {advice}"),
        }
    }
}

fn request_key(tool_name: &str, input: &str) -> String {
    let mut value =
        serde_json::from_str::<Value>(input).unwrap_or(Value::String(input.to_string()));
    if let Value::Object(object) = &mut value {
        for key in ["description", "timeout", "timeout_ms", "run_in_background"] {
            object.remove(key);
        }
    }
    let mut hash = Sha256::new();
    hash.update(tool_name.as_bytes());
    hash.update([0]);
    hash.update(value.to_string().as_bytes());
    format!("{:x}", hash.finalize())
}

fn failure_kind(tool_name: &str, output: &str) -> Option<FailureKind> {
    // Never infer execution errors from a successful file read or search hit.
    let shell = matches!(tool_name, "bash" | "PowerShell");
    let editing = matches!(tool_name, "edit_file" | "multi_edit");
    let reading = matches!(tool_name, "read_file" | "read_files");
    if !shell && !editing && !reading {
        return None;
    }
    let detail = match serde_json::from_str::<Value>(output) {
        Ok(value @ Value::Object(_)) => diagnostic_text(&value),
        _ => output.to_string(),
    }
    .to_ascii_lowercase();
    if shell
        && (detail.contains("bad escape")
            || detail.contains("invalid group reference")
            || detail.contains("unterminated character set"))
    {
        return Some(FailureKind::RegexEscape);
    }
    if shell
        && (detail.contains("unterminated string")
            || detail.contains("eol while scanning string")
            || detail.contains("unexpected eof while looking for matching")
            || detail.contains("string is missing the terminator"))
    {
        return Some(FailureKind::Quoting);
    }
    if editing && detail.contains("old_string_not_found") {
        return Some(FailureKind::StaleAnchor);
    }
    if editing
        && detail.contains("old_string")
        && (detail.contains("not found")
            || detail.contains("does not match")
            || detail.contains("no match")
            || detail.contains("matches 0"))
    {
        return Some(FailureKind::StaleAnchor);
    }
    if detail.contains("filenotfounderror")
        || detail.contains("no such file or directory")
        || detail.contains("path_not_found")
        || detail.contains("file_not_found")
        || detail.contains("cannot find path")
        || detail.contains("系统找不到指定的文件")
    {
        return Some(FailureKind::MissingPath);
    }
    if shell && (detail.contains("typeerror:") || detail.contains("attributeerror:")) {
        return Some(FailureKind::ScriptType);
    }
    None
}

fn diagnostic_text(value: &Value) -> String {
    let Some(object) = value.as_object() else {
        return String::new();
    };
    let mut details = ["stderr", "error", "message", "stdout", "code"]
        .iter()
        .filter_map(|key| object.get(*key).and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(issues) = object.get("issues").and_then(Value::as_array) {
        details.extend(issues.iter().map(diagnostic_text));
    }
    if let Some(results) = object.get("results").and_then(Value::as_array) {
        details.extend(
            results
                .iter()
                .filter(|result| result.get("ok") == Some(&Value::Bool(false)))
                .map(diagnostic_text),
        );
    }
    details.join("\n")
}

#[cfg(test)]
#[path = "tests/tool_recovery.rs"]
mod tests;
