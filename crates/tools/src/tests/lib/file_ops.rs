use super::*;

#[test]
fn file_tools_cover_read_write_and_edit_behaviors() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("fs-suite");
    fs::create_dir_all(&root).expect("create root");
    // Resolve relative artifact paths against this isolated test workspace,
    // not the SomniQ process workspace that may be injected by the session.
    let _workspace_root = EnvGuard::set(ARIS_WORKSPACE_ROOT_ENV, &root);
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("set cwd");

    let write_create = execute_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\nalpha\n" }),
    )
    .expect("write create should succeed");
    let write_create_output: serde_json::Value = serde_json::from_str(&write_create).expect("json");
    assert_eq!(write_create_output["type"], "create");
    let write_create_path = write_create_output["filePath"].as_str().expect("file path");
    assert_eq!(
        write_create_output["changes"][write_create_path]["type"],
        "add"
    );
    assert!(root.join("nested/demo.txt").exists());

    let write_update = execute_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\ngamma\n" }),
    )
    .expect("write update should succeed");
    let write_update_output: serde_json::Value = serde_json::from_str(&write_update).expect("json");
    assert_eq!(write_update_output["type"], "update");
    assert_eq!(write_update_output["originalFile"], "alpha\nbeta\nalpha\n");
    let write_update_path = write_update_output["filePath"].as_str().expect("file path");
    assert_eq!(
        write_update_output["changes"][write_update_path]["type"],
        "update"
    );
    assert!(
        write_update_output["changes"][write_update_path]["unified_diff"]
            .as_str()
            .expect("unified diff")
            .contains("+gamma")
    );

    let read_full = execute_tool("read_file", &json!({ "path": "nested/demo.txt" }))
        .expect("read full should succeed");
    let read_full_output: serde_json::Value = serde_json::from_str(&read_full).expect("json");
    assert_eq!(read_full_output["file"]["content"], "alpha\nbeta\ngamma");
    assert_eq!(read_full_output["file"]["startLine"], 1);

    let read_slice = execute_tool(
        "read_file",
        &json!({ "path": "nested/demo.txt", "offset": 1, "limit": 1 }),
    )
    .expect("read slice should succeed");
    let read_slice_output: serde_json::Value = serde_json::from_str(&read_slice).expect("json");
    assert_eq!(read_slice_output["file"]["content"], "beta");
    assert_eq!(read_slice_output["file"]["startLine"], 2);

    let read_past_end = execute_tool(
        "read_file",
        &json!({ "path": "nested/demo.txt", "offset": 50 }),
    )
    .expect("read past EOF should succeed");
    let read_past_end_output: serde_json::Value =
        serde_json::from_str(&read_past_end).expect("json");
    assert_eq!(read_past_end_output["file"]["content"], "");
    assert_eq!(read_past_end_output["file"]["startLine"], 4);

    let read_error = execute_tool("read_file", &json!({ "path": "missing.txt" }))
        .expect_err("missing file should fail");
    assert!(!read_error.is_empty());

    let long_write = execute_tool(
            "write_file",
            &json!({ "path": "nested/too-long.txt", "content": "x".repeat(MAX_WRITE_FILE_CONTENT_CHARS + 1) }),
        )
        .expect_err("oversized single-call writes should fail explicitly");
    assert!(long_write.contains("single-call limit"));
    assert!(!root.join("nested/too-long.txt").exists());

    let append_output = execute_tool(
        "append_file",
        &json!({ "path": "nested/demo.txt", "content": "delta\n", "create_if_missing": false }),
    )
    .expect("append should succeed");
    let append_output: serde_json::Value = serde_json::from_str(&append_output).expect("json");
    assert_eq!(append_output["type"], "append");
    assert_eq!(append_output["created"], false);
    assert_eq!(append_output["appendedChars"], 6);
    assert!(append_output.get("content").is_none());
    assert_eq!(
        fs::read_to_string(root.join("nested/demo.txt")).expect("read file"),
        "alpha\nbeta\ngamma\ndelta\n"
    );

    let long_append = execute_tool(
            "append_file",
            &json!({ "path": "nested/demo.txt", "content": "x".repeat(MAX_WRITE_FILE_CONTENT_CHARS + 1) }),
        )
        .expect_err("oversized append writes should fail explicitly");
    assert!(long_append.contains("single-call limit"));

    execute_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\ngamma\n" }),
    )
    .expect("reset appended file before edit checks");

    let edit_once = execute_tool(
        "edit_file",
        &json!({ "path": "nested/demo.txt", "old_string": "alpha", "new_string": "omega" }),
    )
    .expect("single edit should succeed");
    let edit_once_output: serde_json::Value = serde_json::from_str(&edit_once).expect("json");
    assert_eq!(edit_once_output["replaceAll"], false);
    let edit_once_path = edit_once_output["filePath"].as_str().expect("file path");
    assert_eq!(
        edit_once_output["changes"][edit_once_path]["type"],
        "update"
    );
    assert_eq!(
        fs::read_to_string(root.join("nested/demo.txt")).expect("read file"),
        "omega\nbeta\ngamma\n"
    );

    execute_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\nalpha\n" }),
    )
    .expect("reset file");
    let edit_all = execute_tool(
        "edit_file",
        &json!({
            "path": "nested/demo.txt",
            "old_string": "alpha",
            "new_string": "omega",
            "replace_all": true
        }),
    )
    .expect("replace all should succeed");
    let edit_all_output: serde_json::Value = serde_json::from_str(&edit_all).expect("json");
    assert_eq!(edit_all_output["replaceAll"], true);
    assert_eq!(
        fs::read_to_string(root.join("nested/demo.txt")).expect("read file"),
        "omega\nbeta\nomega\n"
    );

    let edit_same = execute_tool(
        "edit_file",
        &json!({ "path": "nested/demo.txt", "old_string": "omega", "new_string": "omega" }),
    )
    .expect_err("identical old/new should fail");
    assert!(edit_same.contains("must differ"));

    let edit_missing = execute_tool(
        "edit_file",
        &json!({ "path": "nested/demo.txt", "old_string": "missing", "new_string": "omega" }),
    )
    .expect_err("missing substring should fail");
    assert!(edit_missing.contains("old_string not found"));

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn change_tools_list_and_revert_audited_file_writes() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("change-tools");
    fs::create_dir_all(&root).expect("create root");
    let original_dir = std::env::current_dir().expect("cwd");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let _session = EnvGuard::set("ARIS_SESSION_ID", "tool-ledger-session");
    std::env::set_current_dir(&root).expect("set cwd");

    let output = execute_tool_with_context(
        "write_file",
        &json!({ "path": "tracked.txt", "content": "hello\n" }),
        ToolRunContext {
            tool_use_id: Some("toolu-ledger-1".to_string()),
            session_id: None,
            turn_id: None,
        },
    )
    .expect("write should succeed");
    let output: serde_json::Value = serde_json::from_str(&output).expect("json");
    let change_id = output["changeId"].as_str().expect("change id").to_string();

    let listed = execute_tool(
        "change_list",
        &json!({ "session_id": "tool-ledger-session" }),
    )
    .expect("list changes");
    let listed: serde_json::Value = serde_json::from_str(&listed).expect("json");
    let records = listed["records"].as_array().expect("records");
    assert!(records.iter().any(|record| {
        record["changeId"] == change_id && record["toolUseId"] == "toolu-ledger-1"
    }));

    let reverted = execute_tool(
        "change_revert",
        &json!({ "change_id": change_id, "session_id": "tool-ledger-session" }),
    )
    .expect("revert change");
    let reverted: serde_json::Value = serde_json::from_str(&reverted).expect("json");
    assert_eq!(reverted["reverted"], true);
    assert!(!root.join("tracked.txt").exists());

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn repl_file_writes_are_audited_and_revertible() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("repl-change-audit");
    fs::create_dir_all(&root).expect("create root");
    let original_dir = std::env::current_dir().expect("cwd");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let _session = EnvGuard::set("ARIS_SESSION_ID", "tool-repl-session");
    std::env::set_current_dir(&root).expect("set cwd");
    fs::write(root.join("tracked.txt"), "before\n").expect("write initial file");

    let file_literal =
        serde_json::to_string(&root.join("tracked.txt").display().to_string()).expect("path json");
    let output = execute_tool_with_context(
        "REPL",
        &json!({
            "language": "python",
            "code": format!(
                "from pathlib import Path\nPath({file_literal}).write_text('after\\n', encoding='utf-8')\n"
            )
        }),
        ToolRunContext {
            tool_use_id: Some("toolu-repl-1".to_string()),
            session_id: Some("tool-repl-session".to_string()),
            turn_id: None,
        },
    );
    let output = match output {
        Ok(output) => output,
        Err(error) if error.contains("python runtime not found") => {
            std::env::set_current_dir(&original_dir).expect("restore cwd");
            let _ = fs::remove_dir_all(root);
            return;
        }
        Err(error) => panic!("REPL write should succeed: {error}"),
    };
    let output: serde_json::Value = serde_json::from_str(&output).expect("json");
    let change_id = output["changeId"].as_str().expect("change id").to_string();
    let changes = output["changes"].as_object().expect("changes");
    assert_eq!(changes.len(), 1);
    assert_eq!(
        fs::read_to_string(root.join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "after\n"
    );

    let reverted = execute_tool(
        "change_revert",
        &json!({ "change_id": change_id, "session_id": "tool-repl-session" }),
    )
    .expect("revert change");
    let reverted: serde_json::Value = serde_json::from_str(&reverted).expect("json");
    assert_eq!(reverted["reverted"], true);
    assert_eq!(
        fs::read_to_string(root.join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "before\n"
    );

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn read_file_tool_repeatedly_returns_long_text_preview_without_error() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("repeat-read-tool-suite");
    fs::create_dir_all(root.join("book")).expect("create root");
    let _workspace_root = EnvGuard::set(ARIS_WORKSPACE_ROOT_ENV, &root);
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("set cwd");

    let mut lines = vec!["# Chapter 7".to_string()];
    for index in 1..=1_800 {
        if index % 450 == 0 {
            lines.push(format!("## Section {}", index / 450));
        } else {
            lines.push(format!("line {index} {}", "x".repeat(100)));
        }
    }
    fs::write(root.join("book/chapter7.md"), lines.join("\n")).expect("write long chapter");

    let mut previous: Option<serde_json::Value> = None;
    for attempt in 1..=3 {
        let output = execute_tool("read_file", &json!({ "path": "book/chapter7.md" }))
            .unwrap_or_else(|error| panic!("read attempt {attempt} should not fail: {error}"));
        let output: serde_json::Value = serde_json::from_str(&output).expect("json");
        assert_eq!(output["file"]["truncated"], true);
        assert_eq!(output["file"]["totalLines"], 1_801);
        let content = output["file"]["content"].as_str().expect("content");
        assert!(content.contains("[read_file long-file preview:"));
        assert!(content.contains("L1: # Chapter 7"));
        assert!(content.contains("L451: ## Section 1"));
        assert!(!content.contains("L200: line 200"));
        assert!(
            content.chars().count() <= 64_000,
            "attempt {attempt} returned an oversized preview"
        );

        if let Some(previous) = previous.as_ref() {
            assert_eq!(previous, &output, "attempt {attempt} should be stable");
        }
        previous = Some(output);
    }

    let window = execute_tool(
        "read_file",
        &json!({ "path": "book/chapter7.md", "offset": 449, "limit": 4 }),
    )
    .expect("explicit line window should succeed after repeated previews");
    let window: serde_json::Value = serde_json::from_str(&window).expect("json");
    assert_eq!(window["file"]["startLine"], 450);
    assert_eq!(window["file"]["truncated"], false);
    assert!(window["file"]["content"]
        .as_str()
        .expect("window content")
        .contains("## Section 1"));

    let missing = execute_tool("read_file", &json!({ "path": "book/missing.md" }))
        .expect_err("missing file should still produce a visible tool error");
    assert!(
        missing.contains("missing.md") || missing.contains("No such file"),
        "missing read should include a useful error message: {missing}"
    );

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn glob_and_grep_tools_cover_success_and_errors() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("search-suite");
    fs::create_dir_all(root.join("nested")).expect("create root");
    let _workspace_root = EnvGuard::set(ARIS_WORKSPACE_ROOT_ENV, &root);
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("set cwd");

    fs::write(
        root.join("nested/lib.rs"),
        "fn main() {}\nlet alpha = 1;\nlet alpha = 2;\n",
    )
    .expect("write rust file");
    fs::write(root.join("nested/notes.txt"), "alpha\nbeta\n").expect("write txt file");

    let globbed = execute_tool("glob_search", &json!({ "pattern": "nested/*.rs" }))
        .expect("glob should succeed");
    let globbed_output: serde_json::Value = serde_json::from_str(&globbed).expect("json");
    assert_eq!(globbed_output["numFiles"], 1);
    assert!(globbed_output["filenames"][0]
        .as_str()
        .expect("filename")
        .ends_with("nested/lib.rs"));

    let glob_error = execute_tool("glob_search", &json!({ "pattern": "[" }))
        .expect_err("invalid glob should fail");
    assert!(!glob_error.is_empty());

    let grep_content = execute_tool(
        "grep_search",
        &json!({
            "pattern": "alpha",
            "path": "nested",
            "glob": "*.rs",
            "output_mode": "content",
            "-n": true,
            "head_limit": 1,
            "offset": 1
        }),
    )
    .expect("grep content should succeed");
    let grep_content_output: serde_json::Value = serde_json::from_str(&grep_content).expect("json");
    assert_eq!(grep_content_output["numFiles"], 0);
    assert!(grep_content_output["appliedLimit"].is_null());
    assert_eq!(grep_content_output["appliedOffset"], 1);
    assert!(grep_content_output["content"]
        .as_str()
        .expect("content")
        .contains("let alpha = 2;"));

    let grep_count = execute_tool(
        "grep_search",
        &json!({ "pattern": "alpha", "path": "nested", "output_mode": "count" }),
    )
    .expect("grep count should succeed");
    let grep_count_output: serde_json::Value = serde_json::from_str(&grep_count).expect("json");
    assert_eq!(grep_count_output["numMatches"], 3);

    let grep_error = execute_tool(
        "grep_search",
        &json!({ "pattern": "(alpha", "path": "nested" }),
    )
    .expect_err("invalid regex should fail");
    assert!(!grep_error.is_empty());

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(root);
}

