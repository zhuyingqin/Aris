use super::*;
use crate::{
    path_is_build_parsed_source, read_file_cache_get, read_file_cache_put, ReadFileCacheKey,
    READ_FILE_CACHE,
};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::SystemTime;

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
    assert_eq!(edit_once_output["ok"], true);
    assert_eq!(edit_once_output["diff_summary"]["replaceAll"], false);
    assert_eq!(edit_once_output["diff_summary"]["replacements"], 1);
    assert_eq!(edit_once_output["diff_summary"]["hunks"], 1);
    assert!(edit_once_output.get("originalFile").is_none());
    assert!(edit_once_output.get("oldString").is_none());
    assert!(edit_once_output.get("newString").is_none());
    assert!(edit_once_output.get("changes").is_none());
    assert!(edit_once_output.get("context").is_none());
    assert!(edit_once_output.get("content").is_none());
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
    assert_eq!(edit_all_output["diff_summary"]["replaceAll"], true);
    assert_eq!(
        fs::read_to_string(root.join("nested/demo.txt")).expect("read file"),
        "omega\nbeta\nomega\n"
    );

    let edit_with_content = execute_tool(
        "edit_file",
        &json!({
            "path": "nested/demo.txt",
            "old_string": "beta",
            "new_string": "BETA",
            "include_content": true
        }),
    )
    .expect("explicit full-content edit should succeed");
    let edit_with_content: serde_json::Value =
        serde_json::from_str(&edit_with_content).expect("json");
    assert_eq!(
        edit_with_content["content"], "omega\nBETA\nomega\n",
        "full updated content is returned only after explicit opt-in"
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

    execute_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\ngamma\n" }),
    )
    .expect("reset file before multi edit");
    let multi = execute_tool(
        "multi_edit",
        &json!({
            "path": "nested/demo.txt",
            "edits": [
                { "old_string": "alpha", "new_string": "one" },
                { "old_string": "beta", "new_string": "two" },
                { "old_string": "one", "new_string": "ONE" }
            ]
        }),
    )
    .expect("multi edit should succeed");
    let multi: serde_json::Value = serde_json::from_str(&multi).expect("json");
    assert_eq!(multi["editsApplied"], 3);
    assert_eq!(multi["replacements"], 3);
    assert!(multi.get("structuredPatch").is_none());
    assert_eq!(
        fs::read_to_string(root.join("nested/demo.txt")).expect("read file"),
        "ONE\ntwo\ngamma\n"
    );

    let before_failed_batch =
        fs::read_to_string(root.join("nested/demo.txt")).expect("read before failure");
    let multi_error = execute_tool(
        "multi_edit",
        &json!({
            "path": "nested/demo.txt",
            "edits": [
                { "old_string": "ONE", "new_string": "changed" },
                { "old_string": "missing", "new_string": "never written" }
            ]
        }),
    )
    .expect_err("failed batch should not partially write");
    assert!(multi_error.contains("edit 2"));
    assert_eq!(
        fs::read_to_string(root.join("nested/demo.txt")).expect("read after failure"),
        before_failed_batch
    );

    let lossy_error = execute_tool(
        "multi_edit",
        &json!({
            "path": "nested/demo.txt",
            "edits": [
                { "old_string": "ONE���", "new_string": "clean" }
            ]
        }),
    )
    .expect_err("lossy Unicode should produce an actionable tool error");
    assert!(lossy_error.contains("edit 1"));
    assert!(lossy_error.contains("U+FFFD"));
    assert!(lossy_error.contains("No changes were written"));
    assert_eq!(
        fs::read_to_string(root.join("nested/demo.txt")).expect("read after lossy input"),
        before_failed_batch
    );

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn read_file_cache_is_lru_and_keys_distinct_read_windows() {
    let mut cache = READ_FILE_CACHE
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.clear();
    drop(cache);

    let path = PathBuf::from("cache-unit.txt");
    let modified = SystemTime::UNIX_EPOCH;
    let first = ReadFileCacheKey {
        path: path.clone(),
        modified,
        len: 12,
        offset: None,
        limit: None,
    };
    let window = ReadFileCacheKey {
        path,
        modified,
        len: 12,
        offset: Some(2),
        limit: Some(3),
    };

    read_file_cache_put(first.clone(), "full".to_string());
    read_file_cache_put(window.clone(), "window".to_string());
    assert_eq!(read_file_cache_get(&first).as_deref(), Some("full"));
    assert_eq!(read_file_cache_get(&window).as_deref(), Some("window"));

    let changed_file = ReadFileCacheKey {
        modified: modified + std::time::Duration::from_secs(1),
        ..first
    };
    assert!(
        read_file_cache_get(&changed_file).is_none(),
        "a changed mtime must invalidate the cached read"
    );
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
            max_output_tokens: None,
            project_execution_context: None,
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
fn parallel_project_contexts_keep_tool_writes_in_their_own_workspaces() {
    let root_a = temp_path("parallel-project-a");
    let root_b = temp_path("parallel-project-b");
    fs::create_dir_all(&root_a).expect("project a");
    fs::create_dir_all(&root_b).expect("project b");
    let barrier = Arc::new(std::sync::Barrier::new(3));

    let run = |root: PathBuf, content: &'static str, barrier: Arc<std::sync::Barrier>| {
        std::thread::spawn(move || {
            let project_context = runtime::ProjectExecutionContext::new(&root)
                .with_env("ARIS_WORKSPACE_ROOT", root.as_os_str())
                .with_env("ARIS_DESKTOP_PROJECT_ID", content);
            barrier.wait();
            execute_tool_with_context(
                "write_file",
                &json!({ "path": "result.txt", "content": content }),
                ToolRunContext {
                    session_id: Some(format!("session-{content}")),
                    project_execution_context: Some(project_context),
                    ..ToolRunContext::default()
                },
            )
            .expect("project-scoped write");
        })
    };

    let worker_a = run(root_a.clone(), "project-a", Arc::clone(&barrier));
    let worker_b = run(root_b.clone(), "project-b", Arc::clone(&barrier));
    barrier.wait();
    worker_a.join().expect("project a worker");
    worker_b.join().expect("project b worker");

    assert_eq!(
        fs::read_to_string(root_a.join("result.txt")).expect("project a result"),
        "project-a"
    );
    assert_eq!(
        fs::read_to_string(root_b.join("result.txt")).expect("project b result"),
        "project-b"
    );
    let _ = fs::remove_dir_all(root_a);
    let _ = fs::remove_dir_all(root_b);
}

#[test]
fn multi_edit_creates_one_revertible_audit_record() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("multi-edit-ledger");
    fs::create_dir_all(&root).expect("create root");
    let original_dir = std::env::current_dir().expect("cwd");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let _session = EnvGuard::set("ARIS_SESSION_ID", "multi-edit-ledger-session");
    std::env::set_current_dir(&root).expect("set cwd");
    fs::write(root.join("tracked.txt"), "alpha\nbeta\n").expect("write initial file");

    let output = execute_tool_with_context(
        "multi_edit",
        &json!({
            "path": "tracked.txt",
            "edits": [
                { "old_string": "alpha", "new_string": "one" },
                { "old_string": "beta", "new_string": "two" }
            ]
        }),
        ToolRunContext {
            tool_use_id: Some("toolu-multi-edit-1".to_string()),
            session_id: None,
            turn_id: None,
            max_output_tokens: None,
            project_execution_context: None,
        },
    )
    .expect("multi edit should succeed");
    let output: serde_json::Value = serde_json::from_str(&output).expect("json");
    let change_id = output["changeId"].as_str().expect("change id").to_string();

    let listed = execute_tool(
        "change_list",
        &json!({ "session_id": "multi-edit-ledger-session" }),
    )
    .expect("list changes");
    let listed: serde_json::Value = serde_json::from_str(&listed).expect("json");
    let records = listed["records"].as_array().expect("records");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["changeId"], change_id);
    assert_eq!(records[0]["toolUseId"], "toolu-multi-edit-1");
    assert_eq!(records[0]["toolName"], "multi_edit");

    execute_tool(
        "change_revert",
        &json!({
            "change_id": change_id,
            "session_id": "multi-edit-ledger-session"
        }),
    )
    .expect("revert batch");
    assert_eq!(
        fs::read_to_string(root.join("tracked.txt")).expect("read reverted file"),
        "alpha\nbeta\n"
    );

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
            max_output_tokens: None,
            project_execution_context: None,
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

/// The over-limit error is where the model actually decides how to write a long
/// file, so the advice there has to distinguish the two cases. Chunk-appending
/// a prose artifact is fine — every intermediate state is a readable document.
/// Chunk-appending a module is not: it does not parse until the last chunk, so
/// there is nothing to verify along the way, and an interrupted turn leaves a
/// truncated file at the exact path the build reads.
#[test]
fn the_oversized_write_remedy_depends_on_whether_a_build_parses_the_file() {
    let oversized = "x".repeat(MAX_WRITE_FILE_CONTENT_CHARS + 1);

    for source in [
        "src/main.rs",
        "desktop/src/App.tsx",
        "scripts/build.py",
        "package.json",
        "styles/theme.css",
    ] {
        assert!(
            path_is_build_parsed_source(source),
            "{source} should be treated as build-parsed source"
        );
    }
    for artifact in [
        "papers/chapter.tex",
        "notes/outline.md",
        "nested/too-long.txt",
        "data/export",
    ] {
        assert!(
            !path_is_build_parsed_source(artifact),
            "{artifact} should keep the chunked-append advice"
        );
    }

    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("oversized-remedy");
    fs::create_dir_all(&root).expect("create root");
    let _workspace_root = EnvGuard::set(ARIS_WORKSPACE_ROOT_ENV, &root);
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("set cwd");

    let source = execute_tool(
        "write_file",
        &json!({ "path": "src/generated.rs", "content": oversized }),
    )
    .expect_err("oversized source writes should fail");
    assert!(source.contains("single-call limit"));
    assert!(source.contains("Do not chunk-append a source file"));
    assert!(source.contains("real module boundaries"));
    assert!(source.contains(".somniq/tmp/"));

    let artifact = execute_tool(
        "write_file",
        &json!({ "path": "papers/chapter.tex", "content": oversized }),
    )
    .expect_err("oversized artifact writes should fail");
    assert!(artifact.contains("single-call limit"));
    assert!(artifact.contains("smaller append_file chunks"));
    assert!(!artifact.contains("Do not chunk-append a source file"));

    std::env::set_current_dir(original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(&root);
}

/// A mistyped append path must fail, not quietly become a second file.
///
/// The old default was `create_if_missing: true`, so `src/component/Panel.tsx`
/// instead of `src/components/Panel.tsx` returned success with `created: true`
/// — a field nothing forces the caller to read. In the scaffold-then-append
/// flow that produced two half-written files, both reported successful, with
/// the real target untouched. The scaffold guarantees the target exists, so
/// creating on append was never the wanted behavior there.
#[test]
fn appending_to_a_missing_path_fails_instead_of_creating_a_second_file() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("append-missing");
    fs::create_dir_all(&root).expect("create root");
    let _workspace_root = EnvGuard::set(ARIS_WORKSPACE_ROOT_ENV, &root);
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("set cwd");

    execute_tool(
        "write_file",
        &json!({ "path": "src/components/Panel.tsx", "content": "export function Panel() {}\n" }),
    )
    .expect("scaffold the real target");

    // The typo: `component` instead of `components`.
    let typo = execute_tool(
        "append_file",
        &json!({ "path": "src/component/Panel.tsx", "content": "// chunk 2\n" }),
    )
    .expect_err("appending to a mistyped path must fail");
    assert!(typo.contains("does not exist"));
    assert!(typo.contains("Check the path for a typo"));
    // The resolved absolute path is what makes the typo visible.
    assert!(typo.contains("component"));
    assert!(
        !root.join("src/component/Panel.tsx").exists(),
        "the mistyped path must not have been created"
    );

    // The real target still appends normally, without needing the flag.
    execute_tool(
        "append_file",
        &json!({ "path": "src/components/Panel.tsx", "content": "// chunk 2\n" }),
    )
    .expect("appending to the existing scaffold should succeed");
    assert_eq!(
        fs::read_to_string(root.join("src/components/Panel.tsx")).expect("read back"),
        "export function Panel() {}\n// chunk 2\n"
    );

    // Creating on append stays available, but only when asked for explicitly.
    let opted_in = execute_tool(
        "append_file",
        &json!({ "path": "logs/run.log", "content": "started\n", "create_if_missing": true }),
    )
    .expect("explicit create_if_missing should still work");
    let opted_in: serde_json::Value = serde_json::from_str(&opted_in).expect("json");
    assert_eq!(opted_in["created"], true);

    std::env::set_current_dir(original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(&root);
}

/// The single-call cap is a token budget, and counting characters got it
/// backwards for the product's main output.
///
/// A tool call's arguments are emitted by the model, so `content` is spent
/// against `max_tokens_for_model` — 16,384 on the GPT family. The old
/// 24,000-*character* cap let 24,000 CJK characters through at roughly 24,000
/// tokens, 146% of that budget, which truncates the tool-call JSON mid-string
/// and arrives as a malformed call. The same cap rejected 24,001 characters of
/// ASCII at only ~6,858 tokens, 41% of the budget.
///
/// So the fix has to move in both directions at once: Chinese text that used to
/// be accepted is now refused well below the old character cap, and code that
/// used to be refused now fits.
#[test]
fn the_single_call_cap_is_a_token_budget_not_a_character_count() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("token-budget");
    fs::create_dir_all(&root).expect("create root");
    let _workspace_root = EnvGuard::set(ARIS_WORKSPACE_ROOT_ENV, &root);
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("set cwd");

    // 12,000 CJK characters: half the old character cap, but ~12,000 tokens —
    // over budget, and previously accepted.
    let chinese = "研究方法与实验结果分析".repeat(1_100);
    assert!(chinese.chars().count() < 24_000, "stays under the old cap");
    let rejected = execute_tool(
        "write_file",
        &json!({ "path": "papers/report.md", "content": chinese }),
    )
    .expect_err("CJK content over the token budget must be refused");
    assert!(rejected.contains("single-call limit"));
    assert!(rejected.contains("tokens"));
    // The message has to explain the conversion, or a character count that
    // looks comfortably inside the cap reads as an arbitrary refusal.
    assert!(rejected.contains("one token per character"));

    // The same character count of ASCII is only ~1/3.5 the tokens, so it lands.
    let code = "let value = compute(input);\n".repeat(430);
    assert!(code.chars().count() > 11_000, "comparable character count");
    execute_tool(
        "write_file",
        &json!({ "path": "src/generated.rs", "content": code }),
    )
    .expect("ASCII source of the same size is well inside the token budget");

    // And code beyond the old 24,000-character cap now fits, which is the
    // over-restriction half of the same miscalibration.
    let longer_code = "let value = compute(input);\n".repeat(1_000);
    assert!(longer_code.chars().count() > 24_000, "over the old cap");
    execute_tool(
        "write_file",
        &json!({ "path": "src/longer.rs", "content": longer_code }),
    )
    .expect("28k characters of ASCII is ~8k tokens and must be allowed");

    std::env::set_current_dir(original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(&root);
}
