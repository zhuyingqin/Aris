//! Tool-result shaping: what the model sees, what the UI shows, and what spills
//! to disk.
//!
//! A raw tool result is not what belongs in the transcript. It may be megabytes,
//! it may be a JSON envelope whose interesting part is three lines deep, and when
//! the work failed it needs a recovery hint the model can act on. This module
//! owns those three transformations — compact for context, compact for the UI,
//! persist the full text as an artifact when it is too large for either.
//!
//! It is deliberately free of session, app-handle, and event plumbing: every
//! entry point is a pure function of `(tool_name, output)` plus an optional
//! artifact. That is what makes it testable without a running app, and keeping
//! it that way is the point of it being its own module.

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

/// Tuning for the three transformations. Context and UI budgets are separate
/// because the model and the reader tolerate different shapes of truncation.
pub(crate) const MAX_CONTEXT_TOOL_OUTPUT_CHARS: usize = 64_000;
const MAX_PLAYWRIGHT_SNAPSHOT_CONTEXT_CHARS: usize = 8_000;
const MAX_UI_TOOL_OUTPUT_CHARS: usize = 64_000;
const TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARS: usize = 64_000;
const SHELL_STREAM_CONTEXT_CHARS: usize = 12_000;
const LATEX_STREAM_CONTEXT_CHARS: usize = 4_000;
pub(crate) const MAX_LATEX_CONTEXT_OUTPUT_CHARS: usize = 12_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ToolOutputArtifact {
    path: String,
    bytes: u64,
}

pub(crate) fn compact_tool_output_for_context(
    tool_name: &str,
    output: String,
    artifact: Option<&ToolOutputArtifact>,
) -> String {
    for compactor in output_compactors() {
        if compactor.can_handle(tool_name) {
            return compactor.compact(output, artifact, MAX_CONTEXT_TOOL_OUTPUT_CHARS);
        }
    }
    output
}

pub(crate) fn tool_output_for_ui(output: &str, artifact: Option<&ToolOutputArtifact>) -> String {
    compact_text_output_for_limit(
        output.to_string(),
        artifact,
        MAX_UI_TOOL_OUTPUT_CHARS,
        "tool output preview",
    )
}

trait OutputCompactor: Sync {
    fn can_handle(&self, tool_name: &str) -> bool;

    fn compact(
        &self,
        output: String,
        artifact: Option<&ToolOutputArtifact>,
        max_chars: usize,
    ) -> String;
}

struct SkillOutputCompactor;
struct LiteratureSearchOutputCompactor;
struct LatexCompileOutputCompactor;
struct ShellOutputCompactor;
struct PlaywrightSnapshotOutputCompactor;
struct DefaultOutputCompactor;

static SKILL_OUTPUT_COMPACTOR: SkillOutputCompactor = SkillOutputCompactor;
static LITERATURE_SEARCH_OUTPUT_COMPACTOR: LiteratureSearchOutputCompactor =
    LiteratureSearchOutputCompactor;
static LATEX_COMPILE_OUTPUT_COMPACTOR: LatexCompileOutputCompactor = LatexCompileOutputCompactor;
static SHELL_OUTPUT_COMPACTOR: ShellOutputCompactor = ShellOutputCompactor;
static PLAYWRIGHT_SNAPSHOT_OUTPUT_COMPACTOR: PlaywrightSnapshotOutputCompactor =
    PlaywrightSnapshotOutputCompactor;
static DEFAULT_OUTPUT_COMPACTOR: DefaultOutputCompactor = DefaultOutputCompactor;

fn output_compactors() -> [&'static dyn OutputCompactor; 6] {
    [
        &SKILL_OUTPUT_COMPACTOR,
        &LITERATURE_SEARCH_OUTPUT_COMPACTOR,
        &LATEX_COMPILE_OUTPUT_COMPACTOR,
        &SHELL_OUTPUT_COMPACTOR,
        &PLAYWRIGHT_SNAPSHOT_OUTPUT_COMPACTOR,
        &DEFAULT_OUTPUT_COMPACTOR,
    ]
}

impl OutputCompactor for SkillOutputCompactor {
    fn can_handle(&self, tool_name: &str) -> bool {
        tool_name == "Skill"
    }

    fn compact(
        &self,
        output: String,
        _artifact: Option<&ToolOutputArtifact>,
        _max_chars: usize,
    ) -> String {
        output
    }
}

impl OutputCompactor for LiteratureSearchOutputCompactor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(tool_name, "LiteratureSearch" | "LiteratureCitations")
    }

    fn compact(
        &self,
        output: String,
        artifact: Option<&ToolOutputArtifact>,
        max_chars: usize,
    ) -> String {
        compact_text_output_for_limit(
            compact_literature_search_output(output),
            artifact,
            max_chars,
            "tool output",
        )
    }
}

impl OutputCompactor for LatexCompileOutputCompactor {
    fn can_handle(&self, tool_name: &str) -> bool {
        tool_name == "LaTeXCompile"
    }

    fn compact(
        &self,
        output: String,
        artifact: Option<&ToolOutputArtifact>,
        _max_chars: usize,
    ) -> String {
        let Some(mut value) = serde_json::from_str::<serde_json::Value>(&output).ok() else {
            return compact_text_output_for_limit(
                output,
                artifact,
                MAX_LATEX_CONTEXT_OUTPUT_CHARS,
                "LaTeX compiler output",
            );
        };
        insert_output_artifact_fields(&mut value, artifact);
        let truncated =
            compact_shell_stream_fields(&mut value, LATEX_STREAM_CONTEXT_CHARS, artifact);
        if truncated {
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "truncatedForContext".to_string(),
                    serde_json::Value::Bool(true),
                );
            }
        }
        let rendered = serde_json::to_string_pretty(&value).unwrap_or(output);
        compact_text_output_for_limit(
            rendered,
            artifact,
            MAX_LATEX_CONTEXT_OUTPUT_CHARS,
            "LaTeX compiler output",
        )
    }
}

impl OutputCompactor for ShellOutputCompactor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(tool_name, "bash" | "PowerShell")
    }

    fn compact(
        &self,
        output: String,
        artifact: Option<&ToolOutputArtifact>,
        max_chars: usize,
    ) -> String {
        if output.chars().count() <= max_chars && artifact.is_none() {
            return output;
        }
        compact_shell_json_tool_output(&output, artifact).unwrap_or_else(|| {
            compact_text_output_for_limit(output, artifact, max_chars, "tool output")
        })
    }
}

impl OutputCompactor for PlaywrightSnapshotOutputCompactor {
    fn can_handle(&self, tool_name: &str) -> bool {
        tool_name == "mcp__playwright__browser_snapshot"
    }

    fn compact(
        &self,
        output: String,
        artifact: Option<&ToolOutputArtifact>,
        _max_chars: usize,
    ) -> String {
        compact_playwright_snapshot_output(output, artifact)
    }
}

impl OutputCompactor for DefaultOutputCompactor {
    fn can_handle(&self, _tool_name: &str) -> bool {
        true
    }

    fn compact(
        &self,
        output: String,
        artifact: Option<&ToolOutputArtifact>,
        max_chars: usize,
    ) -> String {
        compact_text_output_for_limit(output, artifact, max_chars, "tool output")
    }
}

/// Whether a tool that returned `Ok` actually reported a failure in its
/// payload. Delegates to the shared classifier so the CLI, sub-agents, and
/// desktop Chat all agree about what counts as a failed run — a second copy of
/// the allow-list here would drift, and a tool missing from one of them is
/// invisible to that surface's repeat counter.
pub(crate) fn tool_output_indicates_error(tool_name: &str, output: &str) -> bool {
    runtime::tool_output_reports_failure(tool_name, output)
}

pub(crate) fn attach_recovery_hint(tool_name: &str, output: &str) -> String {
    let Some(hint) = tool_recovery_hint(tool_name, output) else {
        return output.to_string();
    };
    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(output) {
        if let Some(object) = value.as_object_mut() {
            object.insert("recoveryHint".to_string(), serde_json::Value::String(hint));
            return serde_json::to_string_pretty(&value).unwrap_or_else(|_| output.to_string());
        }
    }
    format!("{output}\n\nRecovery hint: {hint}")
}

pub(crate) fn attach_latex_repair_guard(output: String, message: &str) -> String {
    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&output) {
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "repairGuard".to_string(),
                serde_json::Value::String(message.to_string()),
            );
            return serde_json::to_string_pretty(&value).unwrap_or(output);
        }
    }
    format!("{output}\n\n{message}")
}

pub(crate) fn format_tool_error_with_recovery(tool_name: &str, error: &str) -> String {
    let hint = tool_recovery_hint(tool_name, error)
        .unwrap_or_else(|| "Use the error message to adjust the next step; if the operation is optional, explain the fallback and continue.".to_string());
    format!("{error}\n\nRecovery hint: {hint}")
}

fn tool_recovery_hint(tool_name: &str, output: &str) -> Option<String> {
    let lower = output.to_ascii_lowercase();
    if tool_name == "LaTeXCompile" {
        if let Some(hint) = latex_primary_diagnostic_hint(output) {
            return Some(hint);
        }
        if lower.contains("not found") || lower.contains("failed to start") {
            return Some("LaTeX is unavailable. Install TeX Live or ensure latexmk/xelatex/pdflatex/lualatex are on PATH.".to_string());
        }
        if lower.contains("exit_code:") || lower.contains("error:") {
            return Some("LaTeX compilation failed. Inspect the diagnostics, edit the referenced .tex source, then rerun LaTeXCompile on the same root file.".to_string());
        }
    }
    if matches!(tool_name, "bash" | "PowerShell") {
        if lower.contains("timeout") || lower.contains("exceeded timeout") {
            return Some("The shell command timed out. Retry with a narrower command, add pagination/filters, or use run_in_background for a genuine long-running service. Only increase timeout when the long run is intentional.".to_string());
        }
        if lower.contains("permission denied") || lower.contains("access is denied") {
            return Some("The command hit a permission boundary. Prefer workspace-scoped tools or ask the user before requiring elevated access.".to_string());
        }
        if lower.contains("not recognized")
            || lower.contains("command not found")
            || lower.contains("executable not found")
        {
            return Some("The command or executable is unavailable. Check the local toolchain first, then choose an installed alternative or explain the missing dependency.".to_string());
        }
        if lower.contains("exit_code:") {
            return Some("The command exited non-zero. Inspect stderr/stdout, fix the command or underlying issue, then retry only the smallest necessary step.".to_string());
        }
    }
    if matches!(
        tool_name,
        "NotebookExecute" | "NotebookRun" | "NotebookSweep" | "REPL"
    ) {
        if lower.contains("\"timeout\"") || lower.contains("timed out") {
            return Some("The cell exceeded its timeout. Shrink the workload (fewer steps/epochs, smaller input) or raise timeout_secs deliberately; do not rerun the same cell unchanged.".to_string());
        }
        return Some("The code raised an error, so this run produced no valid result. Read the traceback, fix the cause, and rerun. If the same error has now appeared several times, stop and report what was tried instead of trying another variation.".to_string());
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return Some("The operation timed out. Retry once with a smaller request or a more specific query; avoid repeating the same broad call.".to_string());
    }
    if lower.contains("network")
        || lower.contains("connection")
        || lower.contains("temporarily unavailable")
        || lower.contains("rate limit")
        || lower.contains("429")
        || lower.contains("503")
    {
        return Some("This looks transient. Retry once if useful; if it fails again, proceed with cached/local context and mention the degraded source.".to_string());
    }
    None
}

fn latex_primary_diagnostic_hint(output: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(output).ok()?;
    let diagnostic = value.get("diagnostics")?.as_array()?.first()?.as_object()?;
    let message = diagnostic.get("message")?.as_str()?.trim();
    if message.is_empty() {
        return None;
    }
    let file = diagnostic
        .get("filePath")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let line = diagnostic.get("line").and_then(serde_json::Value::as_u64);
    let location = match (file, line) {
        (Some(file), Some(line)) => format!(" at {file}:{line}"),
        (Some(file), None) => format!(" in {file}"),
        (None, Some(line)) => format!(" near source line {line}"),
        (None, None) => String::new(),
    };
    Some(format!(
        "Fix only the primary LaTeX diagnostic{location}: {message}. Make the smallest source edit, then rerun LaTeXCompile; do not compile through REPL or batch speculative rewrites."
    ))
}

pub(crate) fn persist_tool_output_if_large(
    tool_use_id: &str,
    tool_name: &str,
    output: &str,
) -> Option<ToolOutputArtifact> {
    let persist_latex_failure =
        tool_name == "LaTeXCompile" && runtime::shell_output_reports_failure(output);
    if output.chars().count() <= TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARS && !persist_latex_failure {
        return None;
    }
    let dir = runtime::somniq_project_tmp_dir(crate::state::workspace_dir()).join("tool-output");
    if let Err(error) = fs::create_dir_all(&dir) {
        eprintln!("SomniQ desktop: could not create tool-output dir: {error}");
        return None;
    }
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let name = sanitize_output_file_component(tool_name);
    let id = if tool_use_id.trim().is_empty() {
        "tool".to_string()
    } else {
        sanitize_output_file_component(tool_use_id)
    };
    let path = dir.join(format!("{millis}-{name}-{id}.txt"));
    if let Err(error) = fs::write(&path, output.as_bytes()) {
        eprintln!("SomniQ desktop: could not persist tool output: {error}");
        return None;
    }
    Some(ToolOutputArtifact {
        path: path.display().to_string(),
        bytes: output.len() as u64,
    })
}

pub(crate) fn sanitize_output_file_component(value: &str) -> String {
    let mut out = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    while out.contains("__") {
        out = out.replace("__", "_");
    }
    let trimmed = out.trim_matches('_');
    let compact = if trimmed.is_empty() { "tool" } else { trimmed };
    compact.chars().take(48).collect()
}

fn compact_shell_json_tool_output(
    output: &str,
    artifact: Option<&ToolOutputArtifact>,
) -> Option<String> {
    let mut base = serde_json::from_str::<serde_json::Value>(output).ok()?;
    insert_output_artifact_fields(&mut base, artifact);

    for stream_limit in [SHELL_STREAM_CONTEXT_CHARS, 8_000, 4_000] {
        let mut candidate = base.clone();
        let truncated = compact_shell_stream_fields(&mut candidate, stream_limit, artifact);
        if truncated {
            if let Some(object) = candidate.as_object_mut() {
                object.insert(
                    "truncatedForContext".to_string(),
                    serde_json::Value::Bool(true),
                );
            }
        }
        let rendered = serde_json::to_string_pretty(&candidate).ok()?;
        if rendered.chars().count() <= MAX_CONTEXT_TOOL_OUTPUT_CHARS {
            return Some(rendered);
        }
    }
    None
}

fn insert_output_artifact_fields(
    value: &mut serde_json::Value,
    artifact: Option<&ToolOutputArtifact>,
) {
    let Some(artifact) = artifact else {
        return;
    };
    let Some(object) = value.as_object_mut() else {
        return;
    };
    object.insert(
        "persistedOutputPath".to_string(),
        serde_json::Value::String(artifact.path.clone()),
    );
    object.insert("persistedOutputSize".to_string(), json!(artifact.bytes));
    if !object
        .get("rawOutputPath")
        .is_some_and(|value| !value.is_null())
    {
        object.insert(
            "rawOutputPath".to_string(),
            serde_json::Value::String(artifact.path.clone()),
        );
    }
}

fn compact_shell_stream_fields(
    value: &mut serde_json::Value,
    max_stream_chars: usize,
    artifact: Option<&ToolOutputArtifact>,
) -> bool {
    let mut truncated = false;
    for key in ["stdout", "stderr"] {
        truncated |= compact_json_string_field(value, key, max_stream_chars, artifact);
    }
    truncated
}

fn compact_json_string_field(
    value: &mut serde_json::Value,
    key: &str,
    max_chars: usize,
    artifact: Option<&ToolOutputArtifact>,
) -> bool {
    let Some(object) = value.as_object_mut() else {
        return false;
    };
    let Some(current) = object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return false;
    };
    let (next, truncated) = compact_stream_text(&current, max_chars, key, artifact);
    if truncated {
        object.insert(key.to_string(), serde_json::Value::String(next));
    }
    truncated
}

pub(crate) fn compact_stream_text(
    value: &str,
    max_chars: usize,
    stream_name: &str,
    artifact: Option<&ToolOutputArtifact>,
) -> (String, bool) {
    let total = value.chars().count();
    if total <= max_chars {
        return (value.to_string(), false);
    }
    let marker = format!(
        "\n\n[SomniQ truncated {stream_name}: {total} chars total. {}]\n\n",
        full_output_note(artifact)
    );
    (compact_edges(value, max_chars, &marker), true)
}

fn compact_text_output_for_limit(
    output: String,
    artifact: Option<&ToolOutputArtifact>,
    max_chars: usize,
    label: &str,
) -> String {
    let total = output.chars().count();
    if total <= max_chars {
        return output;
    }
    let marker = format!(
        "\n\n[SomniQ truncated this {label}: {total} chars total. {}]\n\n",
        full_output_note(artifact)
    );
    compact_edges(&output, max_chars, &marker)
}

pub(crate) fn compact_edges(value: &str, max_chars: usize, marker: &str) -> String {
    let marker_chars = marker.chars().count();
    let available = max_chars.saturating_sub(marker_chars);
    if available == 0 {
        return marker.to_string();
    }
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

fn full_output_note(artifact: Option<&ToolOutputArtifact>) -> String {
    artifact.map_or_else(
        || {
            "Use a narrower command, pagination, or redirect output to a file to inspect omitted content."
                .to_string()
        },
        |artifact| {
            format!(
                "Full output saved to {} ({} bytes).",
                artifact.path, artifact.bytes
            )
        },
    )
}

fn compact_playwright_snapshot_output(
    output: String,
    artifact: Option<&ToolOutputArtifact>,
) -> String {
    let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&output) else {
        return compact_text_output_for_limit(
            output,
            artifact,
            MAX_PLAYWRIGHT_SNAPSHOT_CONTEXT_CHARS,
            "Playwright page snapshot",
        );
    };
    let Some(text) = root
        .get("content")
        .and_then(serde_json::Value::as_array)
        .and_then(|content| content.iter().find_map(|item| item.get("text")?.as_str()))
        .map(ToOwned::to_owned)
    else {
        return compact_text_output_for_limit(
            output,
            artifact,
            MAX_PLAYWRIGHT_SNAPSHOT_CONTEXT_CHARS,
            "Playwright page snapshot",
        );
    };
    if text.chars().count() <= MAX_PLAYWRIGHT_SNAPSHOT_CONTEXT_CHARS {
        return output;
    }

    let (page, snapshot) = text.split_once("### Snapshot").unwrap_or((&text, ""));
    let mut selected = Vec::<String>::new();
    for needle in [
        "download", "pdf", "accept", "cookie", "consent", "sign in", "login",
    ] {
        for line in snapshot.lines() {
            if line.to_ascii_lowercase().contains(needle) {
                let line = line.trim();
                if !line.is_empty() && !selected.iter().any(|entry| entry == line) {
                    selected.push(line.to_string());
                }
            }
            if selected.len() >= 64 {
                break;
            }
        }
        if selected.len() >= 64 {
            break;
        }
    }
    if selected.is_empty() {
        selected.extend(
            snapshot
                .lines()
                .filter_map(|line| {
                    let line = line.trim();
                    (line.contains("button") || line.contains("link") || line.contains("textbox"))
                        .then(|| line.to_string())
                })
                .take(32),
        );
    }
    let compact = format!(
        "{}\n\n### Snapshot (compacted)\n{}\n\n[SomniQ omitted the full DOM snapshot. {}]",
        compact_text_output_for_limit(
            page.trim().to_string(),
            None,
            1_800,
            "Playwright page metadata"
        ),
        selected.join("\n"),
        full_output_note(artifact)
    );
    let compact = compact_text_output_for_limit(
        compact,
        artifact,
        MAX_PLAYWRIGHT_SNAPSHOT_CONTEXT_CHARS,
        "Playwright page snapshot",
    );
    if let Some(content) = root
        .get_mut("content")
        .and_then(serde_json::Value::as_array_mut)
    {
        if let Some(item) = content.iter_mut().find(|item| {
            item.get("text")
                .and_then(serde_json::Value::as_str)
                .is_some()
        }) {
            item["text"] = serde_json::Value::String(compact);
        }
    }
    insert_output_artifact_fields(&mut root, artifact);
    if let Some(object) = root.as_object_mut() {
        object.insert(
            "truncatedForContext".to_string(),
            serde_json::Value::Bool(true),
        );
    }
    serde_json::to_string_pretty(&root).unwrap_or(output)
}

fn compact_literature_search_output(output: String) -> String {
    const MAX_ABSTRACT: usize = 250;
    // LiteratureSearch persists its full bounded result set before this
    // presentation compaction. Keep enough samples for Chat reasoning while
    // trimming abstracts only affects the transcript, never the SearchRun or
    // canonical library projection.
    const MAX_PAPERS: usize = 30;

    let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&output) else {
        return output;
    };
    let Some(papers) = root["papers"].as_array_mut() else {
        return output;
    };

    let total = papers.len();
    papers.truncate(MAX_PAPERS);
    for paper in papers.iter_mut() {
        if let Some(abs) = paper["abstract"].as_str() {
            // Count characters, not bytes: a CJK abstract is ~3 bytes per
            // character, so a byte-length test would truncate a 100-character
            // abstract to 250 characters — appending an ellipsis to text that
            // was never shortened.
            if abs.chars().count() > MAX_ABSTRACT {
                let short: String = abs.chars().take(MAX_ABSTRACT).collect();
                paper["abstract"] = serde_json::Value::String(format!("{short}…"));
            }
        }
    }
    if total > MAX_PAPERS {
        root["_note"] = serde_json::Value::String(format!(
            "{} papers returned; showing first {} with abstracts trimmed to {} chars",
            total, MAX_PAPERS, MAX_ABSTRACT
        ));
    }
    serde_json::to_string_pretty(&root).unwrap_or(output)
}

#[cfg(test)]
#[path = "tests/tool_output.rs"]
mod tests;
