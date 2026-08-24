use super::*;

#[test]
fn exposes_mvp_tools() {
    let names = mvp_tool_specs()
        .into_iter()
        .map(|spec| spec.name)
        .collect::<Vec<_>>();
    assert!(names.contains(&"bash"));
    assert!(names.contains(&"read_file"));
    assert!(names.contains(&"multi_edit"));
    assert!(names.contains(&"WebFetch"));
    assert!(names.contains(&"WebSearch"));
    assert!(names.contains(&"RetrievalPlan"));
    assert!(names.contains(&"RetrievalCorpusSeal"));
    assert!(names.contains(&"RetrievalEvidence"));
    assert!(names.contains(&"RetrievalLedger"));
    assert!(names.contains(&"LiteratureSearchProtocolCreate"));
    assert!(names.contains(&"LiteratureSearchPreview"));
    assert!(names.contains(&"LiteratureSearchExecute"));
    assert!(names.contains(&"TodoWrite"));
    assert!(names.contains(&"memory"));
    assert!(names.contains(&"session_search"));
    assert!(names.contains(&"Skill"));
    assert!(names.contains(&"Agent"));
    assert!(names.contains(&"ToolSearch"));
    assert!(names.contains(&"NotebookEdit"));
    assert!(names.contains(&"Sleep"));
    assert!(names.contains(&"SendUserMessage"));
    assert!(names.contains(&"Config"));
    assert!(names.contains(&"StructuredOutput"));
    assert!(names.contains(&"REPL"));
    assert!(names.contains(&"PowerShell"));
    assert!(names.contains(&"LaTeXCompile"));
    assert!(names.contains(&"LaTeXRender"));
}

#[test]
fn general_web_is_default_while_paper_search_keeps_scholarly_guidance() {
    let specs = mvp_tool_specs();
    let literature_index = specs
        .iter()
        .position(|spec| spec.name == "LiteratureSearch")
        .expect("LiteratureSearch spec");
    let web_index = specs
        .iter()
        .position(|spec| spec.name == "WebSearch")
        .expect("WebSearch spec");
    assert!(web_index < literature_index);

    let literature = &specs[literature_index].description;
    let web = &specs[web_index].description;
    assert!(literature.contains("Preferred first discovery tool"));
    assert!(web.contains("call LiteratureSearch before WebSearch"));
    assert!(web.contains("explicitly requests web/search-engine/site search"));
}

#[test]
fn only_known_read_only_tools_opt_into_parallel_execution() {
    for name in ["read_file", "grep_search", "glob_search", "WebFetch"] {
        assert_eq!(tool_execution(name), ToolExecution::Parallel, "{name}");
    }
    for name in [
        "bash",
        "PowerShell",
        "write_file",
        "edit_file",
        "multi_edit",
        "NotebookEdit",
        "LaTeXCompile",
        "RetrievalPlan",
        "RetrievalCorpusSeal",
        "RetrievalEvidence",
        "RetrievalLedger",
        "unknown_plugin_tool",
    ] {
        assert_eq!(tool_execution(name), ToolExecution::Serial, "{name}");
    }
}

#[test]
fn retrieval_evidence_is_a_serial_ephemeral_ledger_update() {
    let input = json!({
        "candidateId": "arxiv:2405.02984",
        "clueId": "clue:0123456789ab",
        "verdict": "supports",
        "directness": "explicit",
        "evidenceId": "evidence:0123456789abcdef",
        "quote": "The observed window states the matching frame rate.",
        "note": "The observed window states the matching frame rate."
    });
    let output = execute_tool("RetrievalEvidence", &input).expect("ledger echo");
    let output: serde_json::Value = serde_json::from_str(&output).expect("ledger JSON");
    assert_eq!(output["status"], "pending_runtime_record");
    assert_eq!(tool_execution("RetrievalEvidence"), ToolExecution::Serial);

    for (name, input) in [
        (
            "RetrievalPlan",
            json!({
                "clues": [
                    {"clue": "candidate provenance", "required": true},
                    {"clue": "dataset construction", "required": true},
                    {"clue": "text preprocessing", "required": true},
                    {"clue": "recording exclusion", "required": true}
                ]
            }),
        ),
        (
            "RetrievalCorpusSeal",
            json!({"coverageNote":"searched broad title, method, and clue variants"}),
        ),
        ("RetrievalLedger", json!({})),
    ] {
        let output = execute_tool(name, &input).expect("ephemeral retrieval tool");
        let output: serde_json::Value = serde_json::from_str(&output).expect("tool JSON");
        assert!(output["status"]
            .as_str()
            .is_some_and(|status| status.starts_with("pending_runtime_")));
        assert_eq!(tool_execution(name), ToolExecution::Serial);
    }
}

#[test]
fn memory_and_session_search_tools_round_trip() {
    let _lock = env_lock().lock().expect("env lock");
    let root = temp_path("memory-tools");
    let workspace = root.join("workspace");
    let sessions = root.join("sessions");
    fs::create_dir_all(&workspace).expect("workspace");
    fs::create_dir_all(&sessions).expect("sessions");
    let _home = EnvGuard::set("HOME", &root);
    let _profile = EnvGuard::set("USERPROFILE", &root);
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &workspace);
    let _sessions = EnvGuard::set("ARIS_SESSIONS_DIR", &sessions);
    let _project = EnvGuard::set("ARIS_DESKTOP_PROJECT_ID", "project-test");
    let _approval = EnvGuard::set("ARIS_MEMORY_WRITE_APPROVAL", "false");

    execute_tool(
        "memory",
        &json!({
            "action": "add",
            "target": "user",
            "content": "User prefers focused answers.",
            "scope": "global",
            "source": "test"
        }),
    )
    .expect("memory add");
    let listed = execute_tool("memory", &json!({ "action": "list" })).expect("memory list");
    assert!(listed.contains("User prefers focused answers."));

    std::env::set_var("ARIS_MEMORY_WRITE_APPROVAL", "true");
    let staged = execute_tool(
        "memory",
        &json!({
            "action": "add",
            "content": "This write requires user approval."
        }),
    )
    .expect("stage memory write");
    assert!(staged.contains("This write requires user approval."));
    let listed = execute_tool("memory", &json!({ "action": "list" })).expect("memory list");
    assert!(!listed.contains("This write requires user approval."));
    assert!(execute_tool("memory", &json!({ "action": "approve" })).is_err());

    let mut session = Session::new();
    session
        .messages
        .push(runtime::ConversationMessage::user_text(
            "Decision: use FTS5 indexing.",
        ));
    session
        .save_to_path(sessions.join("tool-session.json"))
        .expect("save session");
    let search = execute_tool(
        "session_search",
        &json!({ "query": "FTS5 indexing", "limit": 3 }),
    )
    .expect("session search");
    assert!(search.contains("tool-session"));
    assert!(search.contains("FTS5 indexing"));
    let invalid_date = execute_tool(
        "session_search",
        &json!({ "query": "FTS5", "time_start": "2026/99/99" }),
    )
    .expect_err("invalid date must be rejected before search");
    assert!(invalid_date.contains("YYYY-MM-DD"));

    fs::remove_dir_all(root).expect("remove root");
}

#[test]
fn rejects_unknown_tool_names() {
    let error = execute_tool("nope", &json!({})).expect_err("tool should be rejected");
    assert!(error.contains("unsupported tool"));
}

#[test]
fn todo_write_persists_and_returns_previous_state() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = temp_path("todos.json");
    std::env::set_var("CLAWD_TODO_STORE", &path);

    let first = execute_tool(
        "TodoWrite",
        &json!({
            "todos": [
                {"content": "Add tool", "activeForm": "Adding tool", "status": "in_progress"},
                {"content": "Run tests", "activeForm": "Running tests", "status": "pending"}
            ]
        }),
    )
    .expect("TodoWrite should succeed");
    let first_output: serde_json::Value = serde_json::from_str(&first).expect("valid json");
    assert_eq!(first_output["oldTodos"].as_array().expect("array").len(), 0);

    let second = execute_tool(
        "TodoWrite",
        &json!({
            "todos": [
                {"content": "Add tool", "activeForm": "Adding tool", "status": "completed"},
                {"content": "Run tests", "activeForm": "Running tests", "status": "completed"},
                {"content": "Verify", "activeForm": "Verifying", "status": "completed"}
            ]
        }),
    )
    .expect("TodoWrite should succeed");
    std::env::remove_var("CLAWD_TODO_STORE");
    let _ = std::fs::remove_file(path);

    let second_output: serde_json::Value = serde_json::from_str(&second).expect("valid json");
    assert_eq!(
        second_output["oldTodos"].as_array().expect("array").len(),
        2
    );
    assert_eq!(
        second_output["newTodos"].as_array().expect("array").len(),
        3
    );
    assert!(second_output["verificationNudgeNeeded"].is_null());
}

#[test]
fn todo_write_scopes_snapshots_by_session_and_keeps_completed_state() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("session-todos");
    let base = root.join("tasks.json");
    std::env::set_var("CLAWD_TODO_STORE", &base);
    let context = |session_id: &str| ToolRunContext {
        session_id: Some(session_id.to_string()),
        ..ToolRunContext::default()
    };

    execute_tool_with_context(
        "TodoWrite",
        &json!({
            "todos": [
                {"content": "Finish review", "activeForm": "Finishing review", "status": "completed"}
            ]
        }),
        context("session-a"),
    )
    .expect("write session a");
    execute_tool_with_context(
        "TodoWrite",
        &json!({
            "todos": [
                {"content": "Run tests", "activeForm": "Running tests", "status": "in_progress"}
            ]
        }),
        context("session-b"),
    )
    .expect("write session b");

    let session_a =
        fs::read_to_string(root.join("tasks").join("session-a.json")).expect("read session a");
    let session_b =
        fs::read_to_string(root.join("tasks").join("session-b.json")).expect("read session b");
    assert!(session_a.contains("\"status\": \"completed\""));
    assert!(session_b.contains("\"status\": \"in_progress\""));
    assert_ne!(session_a, session_b);

    std::env::remove_var("CLAWD_TODO_STORE");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn todo_write_rejects_invalid_payloads_and_sets_verification_nudge() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = temp_path("todos-errors.json");
    std::env::set_var("CLAWD_TODO_STORE", &path);

    let empty =
        execute_tool("TodoWrite", &json!({ "todos": [] })).expect_err("empty todos should fail");
    assert!(empty.contains("todos must not be empty"));

    // Multiple in_progress items are now allowed for parallel workflows
    let _multi_active = execute_tool(
        "TodoWrite",
        &json!({
            "todos": [
                {"content": "One", "activeForm": "Doing one", "status": "in_progress"},
                {"content": "Two", "activeForm": "Doing two", "status": "in_progress"}
            ]
        }),
    )
    .expect("multiple in-progress todos should succeed");

    let blank_content = execute_tool(
        "TodoWrite",
        &json!({
            "todos": [
                {"content": "   ", "activeForm": "Doing it", "status": "pending"}
            ]
        }),
    )
    .expect_err("blank content should fail");
    assert!(blank_content.contains("todo content must not be empty"));

    let nudge = execute_tool(
        "TodoWrite",
        &json!({
            "todos": [
                {"content": "Write tests", "activeForm": "Writing tests", "status": "completed"},
                {"content": "Fix errors", "activeForm": "Fixing errors", "status": "completed"},
                {"content": "Ship branch", "activeForm": "Shipping branch", "status": "completed"}
            ]
        }),
    )
    .expect("completed todos should succeed");
    std::env::remove_var("CLAWD_TODO_STORE");
    let _ = fs::remove_file(path);

    let output: serde_json::Value = serde_json::from_str(&nudge).expect("valid json");
    assert_eq!(output["verificationNudgeNeeded"], true);
}

#[test]
fn bash_tool_reports_success_exit_failure_timeout_and_background() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let success =
        execute_tool("bash", &json!({ "command": "printf 'hello'" })).expect("bash should succeed");
    let success_output: serde_json::Value = serde_json::from_str(&success).expect("json");
    assert_eq!(success_output["stdout"], "hello");
    assert_eq!(success_output["interrupted"], false);

    let failure = execute_tool("bash", &json!({ "command": "printf 'oops' >&2; exit 7" }))
        .expect("bash failure should still return structured output");
    let failure_output: serde_json::Value = serde_json::from_str(&failure).expect("json");
    assert_eq!(failure_output["returnCodeInterpretation"], "exit_code:7");
    assert!(failure_output["stderr"]
        .as_str()
        .expect("stderr")
        .contains("oops"));

    let timeout = execute_tool("bash", &json!({ "command": "sleep 1", "timeout": 10 }))
        .expect("bash timeout should return output");
    let timeout_output: serde_json::Value = serde_json::from_str(&timeout).expect("json");
    assert_eq!(timeout_output["interrupted"], true);
    assert_eq!(timeout_output["returnCodeInterpretation"], "timeout");
    assert!(timeout_output["stderr"]
        .as_str()
        .expect("stderr")
        .contains("Command exceeded timeout"));

    let background = execute_tool(
        "bash",
        &json!({ "command": "sleep 1", "run_in_background": true }),
    )
    .expect("bash background should succeed");
    let background_output: serde_json::Value = serde_json::from_str(&background).expect("json");
    assert!(background_output["backgroundTaskId"].as_str().is_some());
    assert_eq!(background_output["noOutputExpected"], true);
}

#[test]
fn sleep_waits_and_reports_duration() {
    let started = std::time::Instant::now();
    let result = execute_tool("Sleep", &json!({"duration_ms": 20})).expect("Sleep should succeed");
    let elapsed = started.elapsed();
    let output: serde_json::Value = serde_json::from_str(&result).expect("json");
    assert_eq!(output["duration_ms"], 20);
    assert!(output["message"]
        .as_str()
        .expect("message")
        .contains("Slept for 20ms"));
    assert!(elapsed >= Duration::from_millis(15));
}

#[test]
fn sleep_respects_cancel_check() {
    let started = std::time::Instant::now();
    let error = execute_tool_with_cancel("Sleep", &json!({"duration_ms": 5_000}), &|| true)
        .expect_err("cancelled Sleep should fail");

    assert_eq!(error, "interrupted by user");
    assert!(started.elapsed() < Duration::from_millis(500));
}

#[test]
fn literature_pdf_download_respects_cancel_check_before_network_io() {
    let started = std::time::Instant::now();
    let error = execute_tool_with_cancel(
        "LiteraturePdfDownload",
        &json!({
            "url": "https://example.invalid/paper.pdf",
            "fileName": "cancelled.pdf",
        }),
        &|| true,
    )
    .expect_err("cancelled PDF download should fail");

    assert_eq!(error, "interrupted by user");
    assert!(started.elapsed() < Duration::from_millis(500));
}

#[test]
fn brief_returns_sent_message_and_attachment_metadata() {
    let attachment = std::env::temp_dir().join(format!(
        "clawd-brief-{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    std::fs::write(&attachment, b"png-data").expect("write attachment");

    let result = execute_tool(
        "SendUserMessage",
        &json!({
            "message": "hello user",
            "attachments": [attachment.display().to_string()],
            "status": "normal"
        }),
    )
    .expect("SendUserMessage should succeed");

    let output: serde_json::Value = serde_json::from_str(&result).expect("json");
    assert_eq!(output["message"], "hello user");
    assert!(output["sentAt"].as_str().is_some());
    assert_eq!(output["attachments"][0]["isImage"], true);
    let _ = std::fs::remove_file(attachment);
}

#[test]
fn config_reads_and_writes_supported_values() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = std::env::temp_dir().join(format!(
        "clawd-config-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    let home = root.join("home");
    let cwd = root.join("cwd");
    std::fs::create_dir_all(home.join(".claude")).expect("home dir");
    std::fs::create_dir_all(cwd.join(".claude")).expect("cwd dir");
    std::fs::write(
        home.join(".claude").join("settings.json"),
        r#"{"verbose":false}"#,
    )
    .expect("write global settings");

    let original_home = std::env::var("HOME").ok();
    let original_claude_home = std::env::var("CLAUDE_CONFIG_HOME").ok();
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_var("HOME", &home);
    std::env::remove_var("CLAUDE_CONFIG_HOME");
    std::env::set_current_dir(&cwd).expect("set cwd");

    let get = execute_tool("Config", &json!({"setting": "verbose"})).expect("get config");
    let get_output: serde_json::Value = serde_json::from_str(&get).expect("json");
    assert_eq!(get_output["value"], false);

    let set = execute_tool(
        "Config",
        &json!({"setting": "permissions.defaultMode", "value": "plan"}),
    )
    .expect("set config");
    let set_output: serde_json::Value = serde_json::from_str(&set).expect("json");
    assert_eq!(set_output["operation"], "set");
    assert_eq!(set_output["newValue"], "plan");

    let invalid = execute_tool(
        "Config",
        &json!({"setting": "permissions.defaultMode", "value": "bogus"}),
    )
    .expect_err("invalid config value should error");
    assert!(invalid.contains("Invalid value"));

    let unknown =
        execute_tool("Config", &json!({"setting": "nope"})).expect("unknown setting result");
    let unknown_output: serde_json::Value = serde_json::from_str(&unknown).expect("json");
    assert_eq!(unknown_output["success"], false);

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    match original_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    match original_claude_home {
        Some(value) => std::env::set_var("CLAUDE_CONFIG_HOME", value),
        None => std::env::remove_var("CLAUDE_CONFIG_HOME"),
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn structured_output_echoes_input_payload() {
    let result = execute_tool("StructuredOutput", &json!({"ok": true, "items": [1, 2, 3]}))
        .expect("StructuredOutput should succeed");
    let output: serde_json::Value = serde_json::from_str(&result).expect("json");
    assert_eq!(output["data"], "Structured output provided successfully");
    assert_eq!(output["structured_output"]["ok"], true);
    assert_eq!(output["structured_output"]["items"][1], 2);
}

/// Every tool in the inventory must have been through the failure-classification
/// decision in `runtime::tool_outcome`.
///
/// That allow-list is a hand-kept registry, and a registry nobody is forced to
/// update is one a new tool silently falls out of: `WebSearch` sat outside it
/// for its whole life, so a search where every provider refused looked like a
/// clean call to the repeat counter, to compaction's dead-end pinning, and to
/// the desktop's error badge at once. Adding a tool now fails this test until
/// its payload is either classified or listed here as not needing it.
#[test]
fn every_tool_has_a_failure_classification_decision() {
    // Reviewed and judged not to need payload classification: these either
    // report failure as `Err` (the call itself fails, which every consumer
    // already sees) or only read and write local state.
    const NO_PAYLOAD_FAILURE: &[&str] = &[
        "Agent",
        "Config",
        "KnowledgeSearch",
        "KnowledgeUpsert",
        "LaTeXRender",
        "LibraryRetrieve",
        "LiteratureBrowserDownloadTask",
        "LiteratureLibraryUpsert",
        "LiteraturePdfDownload",
        "LiteratureSearchPreview",
        "LiteratureSearchProtocolCreate",
        "LlmReview",
        "NotebookEdit",
        "NotebookKernel",
        "RetrievalCorpusSeal",
        "RetrievalEvidence",
        "RetrievalLedger",
        "RetrievalPlan",
        "SendUserMessage",
        "Skill",
        "Sleep",
        "StructuredOutput",
        "TodoWrite",
        "ToolSearch",
        "WebFetch",
        "WorkspaceLayout",
        "memory",
        // File and search operations: a missing path, an edit whose anchor does
        // not match, an unreadable file all fail the call itself. A search that
        // matches nothing is a successful search.
        "append_file",
        "change_get",
        "change_list",
        "change_revert",
        "edit_file",
        "glob_search",
        "grep_search",
        "multi_edit",
        "read_file",
        "session_search",
        "write_file",
    ];

    let inventory: BTreeSet<String> = mvp_tool_specs()
        .into_iter()
        .map(|spec| spec.name.to_string())
        .collect();

    let undecided: Vec<&String> = inventory
        .iter()
        .filter(|name| {
            !runtime::classifies_failures(name) && !NO_PAYLOAD_FAILURE.contains(&name.as_str())
        })
        .collect();
    assert!(
        undecided.is_empty(),
        "these tools have no failure-classification decision: {undecided:?}.          Classify the payload in runtime::tool_outcome, or add the tool to          NO_PAYLOAD_FAILURE with the reason it cannot report failed work in a          successful call."
    );

    // The exemption list must not outlive the tools it names, or it silently
    // stops meaning anything.
    let stale: Vec<&&str> = NO_PAYLOAD_FAILURE
        .iter()
        .filter(|name| !inventory.contains(**name))
        .collect();
    assert!(stale.is_empty(), "exempted tools that no longer exist: {stale:?}");
}
