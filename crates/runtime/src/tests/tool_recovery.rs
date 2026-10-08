use super::*;

fn regex_error(escape: &str) -> String {
    json!({"stderr": format!("Traceback (most recent call last):\nre.error: bad escape {escape} at position 7"), "returnCodeInterpretation": "exit_code:1"}).to_string()
}

#[test]
fn first_regex_failure_preserves_diagnostics_and_names_a_stable_edit_route() {
    let mut state = ToolRecoveryState::default();
    let input = r#"{"command":"python -c 'replace LaTeX'"}"#;
    let output = state.observe("bash", input, regex_error("\\e"), true);
    let value: Value = serde_json::from_str(&output).expect("JSON");
    assert!(value["stderr"].as_str().unwrap().contains("bad escape \\e"));
    assert!(value["recoveryHint"]
        .as_str()
        .unwrap()
        .contains("multi_edit"));
    assert_eq!(value["toolRecovery"]["failedAttempts"], 1);
    assert_eq!(value["toolRecovery"]["changeMechanismRequired"], false);
    assert!(state.before_tool("bash", input).is_none());
}

#[test]
fn second_failure_requires_a_mechanism_change_across_small_command_variations() {
    let mut state = ToolRecoveryState::default();
    state.observe(
        "bash",
        r#"{"command":"python attempt1"}"#,
        regex_error("\\e"),
        true,
    );
    let output = state.observe(
        "bash",
        r#"{"command":"python attempt2"}"#,
        regex_error("\\q"),
        true,
    );
    let value: Value = serde_json::from_str(&output).expect("JSON");
    assert_eq!(value["toolRecovery"]["sameMechanismFailures"], 2);
    assert_eq!(value["toolRecovery"]["changeMechanismRequired"], true);
}

#[test]
fn unchanged_failed_command_is_bounded_even_if_description_or_timeout_changes() {
    let mut state = ToolRecoveryState::default();
    let input = r#"{"command":"broken regex","description":"first","timeout":1000}"#;
    for _ in 0..2 {
        state.observe("bash", input, regex_error("\\e"), true);
    }
    let changed_metadata = r#"{"timeout":9999,"description":"retry","command":"broken regex"}"#;
    let blocked: Value = serde_json::from_str(
        &state
            .before_tool("bash", changed_metadata)
            .expect("bounded retry"),
    )
    .unwrap();
    assert_eq!(blocked["reason"], "repeated_failed_tool_request");
    assert_eq!(blocked["failedAttempts"], 2);
    assert!(state
        .before_tool("bash", r#"{"command":"python saved_script.py"}"#)
        .is_none());
    assert!(state
        .before_tool("read_file", r#"{"path":"main.tex"}"#)
        .is_none());
    state.observe("read_file", "{}", "current source".to_string(), false);
    assert!(state.before_tool("bash", input).is_some());
    state.observe("multi_edit", "{}", "source corrected".to_string(), false);
    assert!(state.before_tool("bash", input).is_none());
}

#[test]
fn missing_path_stale_anchor_quoting_and_type_errors_have_specific_recovery() {
    for (tool, error, kind, hint) in [
        (
            "bash",
            "FileNotFoundError: no such file or directory: main.tex",
            "missing_path",
            "glob/read_file",
        ),
        (
            "multi_edit",
            "old_string was not found in the current file",
            "stale_edit_anchor",
            "exact unique anchor",
        ),
        (
            "bash",
            "SyntaxError: unterminated string literal",
            "quoting",
            "standalone script",
        ),
        (
            "PowerShell",
            "AttributeError: 'str' object has no attribute 'decode'",
            "script_type_error",
            "actual value/type",
        ),
    ] {
        let mut state = ToolRecoveryState::default();
        let output = state.observe(tool, "{}", error.to_string(), true);
        assert!(output.contains(kind), "{output}");
        assert!(output.contains(hint), "{output}");
        assert!(output.contains(error), "diagnostics lost: {output}");
    }
}

#[test]
fn multi_edit_nested_validation_issues_keep_their_recovery_class() {
    let mut state = ToolRecoveryState::default();
    let error = json!({
        "ok": false, "atomic": true, "applied": 0,
        "code": "multi_edit_validation_failed", "message": "Correct the reported fields",
        "issues": [{"code":"old_string_not_found", "message":"old_string was not found"}]
    });
    let output = state.observe("multi_edit", "{}", error.to_string(), true);
    let value: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["toolRecovery"]["failureKind"], "stale_edit_anchor");
    assert_eq!(value["issues"], error["issues"]);
    assert_eq!(value["applied"], 0);
}

#[test]
fn successful_source_reads_and_transient_errors_do_not_create_retry_blocks() {
    let mut state = ToolRecoveryState::default();
    let text = "re.error: bad escape \\e is a string in this file";
    assert_eq!(
        state.observe("read_file", "{}", text.to_string(), false),
        text
    );
    let timeout = json!({"returnCodeInterpretation":"timeout", "stderr":"temporarily unavailable"})
        .to_string();
    for _ in 0..4 {
        assert_eq!(state.observe("bash", "{}", timeout.clone(), true), timeout);
    }
    assert!(state.before_tool("bash", "{}").is_none());
    state.observe("bash", "{}", regex_error("\\e"), true);
    state.observe("bash", "{}", regex_error("\\e"), true);
    state.reset();
    assert!(state.before_tool("bash", "{}").is_none());
}
