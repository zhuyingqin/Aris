use super::*;
use serde_json::json;

#[test]
fn ui_keeps_moderate_tool_output_intact() {
    let output = "x".repeat(10_000);
    let rendered = tool_output_for_ui(&output, None);

    assert_eq!(rendered, output);
    assert!(!rendered.contains("SomniQ truncated"));
}

#[test]
fn shell_output_under_context_limit_stays_intact() {
    let raw = serde_json::to_string_pretty(&json!({
        "stdout": "x".repeat(20_000),
        "stderr": "",
        "rawOutputPath": null,
        "interrupted": false
    }))
    .expect("json");

    let compacted = compact_tool_output_for_context("bash", raw.clone(), None);
    let parsed: serde_json::Value =
        serde_json::from_str(&compacted).expect("tool result remains json");

    assert_eq!(compacted, raw);
    assert_eq!(parsed["stdout"].as_str().unwrap().chars().count(), 20_000);
    assert!(!compacted.contains("SomniQ truncated"));
}

#[test]
fn huge_shell_output_preserves_json_and_full_output_path() {
    let stdout = format!("start{}end", "x".repeat(90_000));
    let raw = serde_json::to_string_pretty(&json!({
        "stdout": stdout,
        "stderr": "",
        "rawOutputPath": null,
        "interrupted": false
    }))
    .expect("json");
    let artifact = ToolOutputArtifact {
        path: "C:\\tmp\\somniq-output.txt".to_string(),
        bytes: raw.len() as u64,
    };

    let compacted = compact_tool_output_for_context("bash", raw, Some(&artifact));
    let parsed: serde_json::Value =
        serde_json::from_str(&compacted).expect("compacted tool result remains json");
    let compacted_stdout = parsed["stdout"].as_str().expect("stdout string");

    assert!(compacted.chars().count() <= MAX_CONTEXT_TOOL_OUTPUT_CHARS);
    assert!(compacted_stdout.starts_with("start"));
    assert!(compacted_stdout.ends_with("end"));
    assert!(compacted_stdout.contains("SomniQ truncated stdout"));
    assert!(compacted_stdout.chars().count() <= SHELL_STREAM_CONTEXT_CHARS);
    assert_eq!(parsed["persistedOutputPath"], artifact.path);
    assert_eq!(parsed["rawOutputPath"], artifact.path);
    assert_eq!(parsed["persistedOutputSize"], artifact.bytes);
    assert_eq!(parsed["truncatedForContext"], true);
}

#[test]
fn playwright_snapshot_keeps_actions_without_filling_the_context() {
    let snapshot = format!(
        "### Page\n- Page URL: https://www.mdpi.com/example\n- Page Title: Example\n### Snapshot\n{}\n  - text: Download PDF\n  - button \"Accept All\"\n  - link \"PDF\" [cursor=pointer]",
        "  - generic [ref=e1]\n".repeat(20_000),
    );
    let raw = serde_json::to_string(&json!({
        "content": [{ "type": "text", "text": snapshot }],
        "structuredContent": null,
        "isError": null
    }))
    .expect("json");
    let artifact = ToolOutputArtifact {
        path: "C:\\tmp\\snapshot.txt".to_string(),
        bytes: raw.len() as u64,
    };

    let compacted =
        compact_tool_output_for_context("mcp__playwright__browser_snapshot", raw, Some(&artifact));
    let parsed: serde_json::Value = serde_json::from_str(&compacted).expect("json output");
    let text = parsed["content"][0]["text"]
        .as_str()
        .expect("snapshot text");

    assert!(compacted.chars().count() <= MAX_PLAYWRIGHT_SNAPSHOT_CONTEXT_CHARS + 600);
    assert!(text.contains("https://www.mdpi.com/example"));
    assert!(text.contains("Download PDF"));
    assert!(text.contains("Accept All"));
    assert_eq!(parsed["persistedOutputPath"], artifact.path);
    assert_eq!(parsed["truncatedForContext"], true);
}

#[test]
fn latex_compile_context_keeps_primary_diagnostic_and_bounds_raw_logs() {
    let raw = serde_json::to_string_pretty(&json!({
        "success": false,
        "inputPath": "papers/report.tex",
        "outputPath": "papers/report.pdf",
        "engine": "latexmk -xelatex",
        "stdout": "x".repeat(12_000),
        "stderr": "! Extra alignment tab has been changed to \\cr.\nl.70 table row",
        "returnCodeInterpretation": "exit_code:1",
        "diagnostics": [{
            "severity": "error",
            "code": "table_alignment",
            "message": "Extra alignment tab has been changed to \\cr.",
            "filePath": "papers/report.tex",
            "line": 70
        }]
    }))
    .expect("json");
    let artifact = ToolOutputArtifact {
        path: "C:\\tmp\\latex-output.txt".to_string(),
        bytes: raw.len() as u64,
    };

    let compacted = compact_tool_output_for_context("LaTeXCompile", raw, Some(&artifact));
    let parsed: serde_json::Value = serde_json::from_str(&compacted).expect("json output");

    assert!(compacted.chars().count() <= MAX_LATEX_CONTEXT_OUTPUT_CHARS);
    assert_eq!(parsed["diagnostics"][0]["line"], 70);
    assert!(parsed["stdout"]
        .as_str()
        .unwrap()
        .contains("SomniQ truncated stdout"));
    assert_eq!(parsed["persistedOutputPath"], artifact.path);
    let hint = tool_recovery_hint("LaTeXCompile", &compacted).expect("targeted hint");
    assert!(hint.contains("papers/report.tex:70"));
    assert!(hint.contains("do not compile through REPL"));
}

#[test]
fn shell_status_metadata_marks_tool_output_as_error() {
    let ok = serde_json::to_string(&json!({
        "stdout": "ok",
        "stderr": "",
        "interrupted": false,
        "returnCodeInterpretation": null
    }))
    .expect("json");
    assert!(!tool_output_indicates_error("PowerShell", &ok));

    let failed = serde_json::to_string(&json!({
        "stdout": "",
        "stderr": "bad",
        "interrupted": false,
        "returnCodeInterpretation": "exit_code:7"
    }))
    .expect("json");
    assert!(tool_output_indicates_error("PowerShell", &failed));

    let interrupted = serde_json::to_string(&json!({
        "stdout": "",
        "stderr": "Command interrupted by user",
        "interrupted": true,
        "returnCodeInterpretation": "interrupted"
    }))
    .expect("json");
    assert!(tool_output_indicates_error("bash", &interrupted));
}

/// A raised cell is a successful tool call reporting failed work. The
/// classification itself is the shared runtime one (covered by its own tests);
/// what matters here is that desktop Chat routes execution tools through it
/// rather than keeping a second allow-list that can drift.
#[test]
fn execution_tool_failures_reach_the_desktop_through_the_shared_classifier() {
    for (tool, payload) in [
        (
            "NotebookExecute",
            json!({ "status": "error", "outputs": [{ "type": "error", "ename": "RuntimeError", "evalue": "CUDA out of memory" }] }),
        ),
        (
            "NotebookSweep",
            json!({ "runs": [{ "id": "b", "status": "error" }] }),
        ),
        ("REPL", json!({ "language": "python", "exitCode": 1 })),
    ] {
        let output = serde_json::to_string(&payload).expect("json");
        assert!(tool_output_indicates_error(tool, &output), "{tool}");
        // A failure must also carry a hint the model can act on.
        assert!(tool_recovery_hint(tool, &output).is_some(), "{tool}");
    }

    let clean = serde_json::to_string(&json!({ "status": "ok" })).expect("json");
    assert!(!tool_output_indicates_error("NotebookExecute", &clean));
}

#[test]
fn literature_abstract_trimming_counts_characters_not_bytes() {
    // A 300-character CJK abstract is ~900 bytes. A byte-length test would
    // "truncate" it to 300 characters — longer than the original — and append
    // an ellipsis to untouched text.
    let short_cjk = "文".repeat(120);
    let long_cjk = "献".repeat(300);
    let long_ascii = "a".repeat(400);
    let output = serde_json::to_string(&json!({
        "papers": [
            { "abstract": short_cjk },
            { "abstract": long_cjk },
            { "abstract": long_ascii },
        ]
    }))
    .expect("json");

    let compacted: serde_json::Value =
        serde_json::from_str(&compact_literature_search_output(output)).expect("json");
    let papers = compacted["papers"].as_array().expect("papers");

    // Under the character budget: returned verbatim, no ellipsis.
    assert_eq!(papers[0]["abstract"].as_str().expect("abstract"), short_cjk);
    for index in [1, 2] {
        let trimmed = papers[index]["abstract"].as_str().expect("abstract");
        assert!(trimmed.ends_with('…'), "paper {index} should be trimmed");
        // 250 kept characters plus the ellipsis.
        assert_eq!(trimmed.chars().count(), 251, "paper {index}");
    }
}

#[test]
fn literature_compaction_caps_the_paper_sample_and_records_the_total() {
    let papers = (0..45)
        .map(|index| json!({ "id": format!("doi:{index}"), "abstract": "short" }))
        .collect::<Vec<_>>();
    let output = serde_json::to_string(&json!({ "papers": papers })).expect("json");

    let compacted: serde_json::Value =
        serde_json::from_str(&compact_literature_search_output(output)).expect("json");

    assert_eq!(compacted["papers"].as_array().expect("papers").len(), 30);
    assert!(compacted["_note"]
        .as_str()
        .expect("note")
        .contains("45 papers returned"));
}

/// `LaTeXCompile` only ever drives TeX Live — its `compiler` enum rejects
/// anything else — so "engine not found" is exactly the case the desktop's
/// bundled Tectonic exists for. The hint used to send the user off to install
/// TeX Live without mentioning it, stranding a compiler the installer had
/// already shipped.
#[test]
fn a_missing_texlive_hint_routes_to_the_bundled_tectonic_when_there_is_one() {
    let _guard = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let previous_somniq = std::env::var_os("SOMNIQ_TECTONIC");
    let previous_aris = std::env::var_os("ARIS_TECTONIC");

    let dir =
        std::env::temp_dir().join(format!("somniq-latex-hint-tectonic-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let tectonic = dir.join("tectonic-marker.exe");
    std::fs::write(&tectonic, b"tectonic").expect("write tectonic marker");

    let output = serde_json::to_string(&json!({
        "stderr": "latexmk not found",
        "returnCodeInterpretation": "exit_code:127"
    }))
    .expect("json");

    std::env::set_var("ARIS_TECTONIC", &tectonic);
    std::env::remove_var("SOMNIQ_TECTONIC");
    let with_tectonic = tool_recovery_hint("LaTeXCompile", &output).expect("hint");
    assert!(with_tectonic.contains("tectonic-marker.exe"));
    assert!(with_tectonic.contains("Only if Tectonic also fails"));
    assert!(!with_tectonic.starts_with("LaTeX is unavailable"));

    // With no bundled Tectonic there is genuinely nothing to fall back to, so
    // asking the user to install TeX Live is the correct answer.
    std::env::remove_var("ARIS_TECTONIC");
    std::env::remove_var("SOMNIQ_TECTONIC");
    let without_tectonic = tool_recovery_hint("LaTeXCompile", &output).expect("hint");
    assert!(without_tectonic.contains("Install TeX Live"));
    assert!(!without_tectonic.contains("Tectonic"));

    let _ = std::fs::remove_dir_all(dir);
    match previous_somniq {
        Some(value) => std::env::set_var("SOMNIQ_TECTONIC", value),
        None => std::env::remove_var("SOMNIQ_TECTONIC"),
    }
    match previous_aris {
        Some(value) => std::env::set_var("ARIS_TECTONIC", value),
        None => std::env::remove_var("ARIS_TECTONIC"),
    }
}
