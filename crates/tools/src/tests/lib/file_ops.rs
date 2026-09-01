use super::*;
use crate::{read_file_cache_get, read_file_cache_put, ReadFileCacheKey, READ_FILE_CACHE};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::SystemTime;

fn execute_file_tool(name: &str, input: &serde_json::Value) -> Result<String, String> {
    let mut input = input.clone();
    if matches!(
        name,
        "write_file" | "append_file" | "edit_file" | "multi_edit"
    ) && input.get("expected_revision").is_none()
    {
        let path = input["path"]
            .as_str()
            .expect("file mutation test input has a path");
        let revision = match runtime::file_revision(path) {
            Ok(revision) => revision,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => "absent".to_string(),
            Err(error) => return Err(error.to_string()),
        };
        input["expected_revision"] = json!(revision);
    }
    let execute = execute_tool;
    execute(name, &input)
}

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

    let write_create = execute_file_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\nalpha\n" }),
    )
    .expect("write create should succeed");
    let write_create_output: serde_json::Value = serde_json::from_str(&write_create).expect("json");
    assert_eq!(write_create_output["type"], "create");
    assert!(write_create_output["filePath"].is_string());
    assert!(write_create_output["revision"]
        .as_str()
        .is_some_and(|revision| revision.starts_with("sha256:")));
    assert!(write_create_output.get("content").is_none());
    assert!(write_create_output.get("originalFile").is_none());
    assert!(write_create_output.get("changes").is_none());
    assert!(root.join("nested/demo.txt").exists());

    let write_update = execute_file_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\ngamma\n" }),
    )
    .expect("write update should succeed");
    let write_update_output: serde_json::Value = serde_json::from_str(&write_update).expect("json");
    assert_eq!(write_update_output["type"], "update");
    assert_eq!(write_update_output["diff_summary"]["addedLines"], 1);
    assert_eq!(write_update_output["diff_summary"]["removedLines"], 1);
    assert!(write_update_output.get("originalFile").is_none());
    assert!(write_update_output.get("changes").is_none());

    let read_full = execute_file_tool("read_file", &json!({ "path": "nested/demo.txt" }))
        .expect("read full should succeed");
    let read_full_output: serde_json::Value = serde_json::from_str(&read_full).expect("json");
    assert_eq!(read_full_output["file"]["content"], "alpha\nbeta\ngamma");
    assert_eq!(read_full_output["file"]["startLine"], 1);

    let read_slice = execute_file_tool(
        "read_file",
        &json!({ "path": "nested/demo.txt", "offset": 1, "limit": 1 }),
    )
    .expect("read slice should succeed");
    let read_slice_output: serde_json::Value = serde_json::from_str(&read_slice).expect("json");
    assert_eq!(read_slice_output["file"]["content"], "beta");
    assert_eq!(read_slice_output["file"]["startLine"], 2);

    let read_past_end = execute_file_tool(
        "read_file",
        &json!({ "path": "nested/demo.txt", "offset": 50 }),
    )
    .expect("read past EOF should succeed");
    let read_past_end_output: serde_json::Value =
        serde_json::from_str(&read_past_end).expect("json");
    assert_eq!(read_past_end_output["file"]["content"], "");
    assert_eq!(read_past_end_output["file"]["startLine"], 4);

    let read_error = execute_file_tool("read_file", &json!({ "path": "missing.txt" }))
        .expect_err("missing file should fail");
    assert!(!read_error.is_empty());

    let long_write = execute_file_tool(
            "write_file",
            &json!({ "path": "nested/too-long.txt", "content": "x".repeat(MAX_FILE_TOOL_PAYLOAD_BYTES + 1) }),
        )
        .expect_err("oversized single-call writes should fail explicitly");
    assert!(long_write.contains("byte per-call safety limit"));
    assert!(long_write.contains("begin_large_write"));
    assert!(!root.join("nested/too-long.txt").exists());

    let append_output = execute_file_tool(
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

    let long_append = execute_file_tool(
            "append_file",
            &json!({ "path": "nested/demo.txt", "content": "x".repeat(MAX_FILE_TOOL_PAYLOAD_BYTES + 1) }),
        )
        .expect_err("oversized append writes should fail explicitly");
    assert!(long_append.contains("byte per-call safety limit"));

    execute_file_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\ngamma\n" }),
    )
    .expect("reset appended file before edit checks");

    let edit_once = execute_file_tool(
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

    execute_file_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\nalpha\n" }),
    )
    .expect("reset file");
    let edit_all = execute_file_tool(
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

    let edit_with_content = execute_file_tool(
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

    let edit_same = execute_file_tool(
        "edit_file",
        &json!({ "path": "nested/demo.txt", "old_string": "omega", "new_string": "omega" }),
    )
    .expect_err("identical old/new should fail");
    assert!(edit_same.contains("must differ"));

    let edit_missing = execute_file_tool(
        "edit_file",
        &json!({ "path": "nested/demo.txt", "old_string": "missing", "new_string": "omega" }),
    )
    .expect_err("missing substring should fail");
    assert!(edit_missing.contains("old_string not found"));

    execute_file_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\ngamma\n" }),
    )
    .expect("reset file before multi edit");
    let multi = execute_file_tool(
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
    let multi_error = execute_file_tool(
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

    let lossy_error = execute_file_tool(
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
        revision: "sha256:first".to_string(),
        offset: None,
        limit: None,
    };
    let window = ReadFileCacheKey {
        path,
        modified,
        len: 12,
        revision: "sha256:first".to_string(),
        offset: Some(2),
        limit: Some(3),
    };

    read_file_cache_put(first.clone(), "full".to_string());
    read_file_cache_put(window.clone(), "window".to_string());
    assert_eq!(read_file_cache_get(&first).as_deref(), Some("full"));
    assert_eq!(read_file_cache_get(&window).as_deref(), Some("window"));

    let changed_file = ReadFileCacheKey {
        modified: modified + std::time::Duration::from_secs(1),
        revision: "sha256:changed".to_string(),
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
        &json!({ "path": "tracked.txt", "content": "hello\n", "expected_revision": "absent" }),
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

    let listed = execute_file_tool(
        "change_list",
        &json!({ "session_id": "tool-ledger-session" }),
    )
    .expect("list changes");
    let listed: serde_json::Value = serde_json::from_str(&listed).expect("json");
    let records = listed["records"].as_array().expect("records");
    assert!(records.iter().any(|record| {
        record["changeId"] == change_id && record["toolUseId"] == "toolu-ledger-1"
    }));

    let reverted = execute_file_tool(
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
                &json!({ "path": "result.txt", "content": content, "expected_revision": "absent" }),
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
            "expected_revision": runtime::file_revision("tracked.txt").expect("revision"),
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

    let listed = execute_file_tool(
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

    execute_file_tool(
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

    let reverted = execute_file_tool(
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
        let output = execute_file_tool("read_file", &json!({ "path": "book/chapter7.md" }))
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

    let window = execute_file_tool(
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

    let missing = execute_file_tool("read_file", &json!({ "path": "book/missing.md" }))
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

    let globbed = execute_file_tool("glob_search", &json!({ "pattern": "nested/*.rs" }))
        .expect("glob should succeed");
    let globbed_output: serde_json::Value = serde_json::from_str(&globbed).expect("json");
    assert_eq!(globbed_output["numFiles"], 1);
    assert!(globbed_output["filenames"][0]
        .as_str()
        .expect("filename")
        .ends_with("nested/lib.rs"));

    let glob_error = execute_file_tool("glob_search", &json!({ "pattern": "[" }))
        .expect_err("invalid glob should fail");
    assert!(!glob_error.is_empty());

    let grep_content = execute_file_tool(
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

    let grep_count = execute_file_tool(
        "grep_search",
        &json!({ "pattern": "alpha", "path": "nested", "output_mode": "count" }),
    )
    .expect("grep count should succeed");
    let grep_count_output: serde_json::Value = serde_json::from_str(&grep_count).expect("json");
    assert_eq!(grep_count_output["numMatches"], 3);

    let grep_error = execute_file_tool(
        "grep_search",
        &json!({ "pattern": "(alpha", "path": "nested" }),
    )
    .expect_err("invalid regex should fail");
    assert!(!grep_error.is_empty());

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn oversized_write_recommends_atomic_staging_for_every_file_kind() {
    let oversized = "x".repeat(MAX_FILE_TOOL_PAYLOAD_BYTES + 1);
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("oversized-remedy");
    fs::create_dir_all(&root).expect("create root");
    let _workspace_root = EnvGuard::set(ARIS_WORKSPACE_ROOT_ENV, &root);
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("set cwd");

    for path in ["src/generated.rs", "papers/chapter.tex"] {
        let error = execute_file_tool("write_file", &json!({ "path": path, "content": oversized }))
            .expect_err("oversized direct writes should fail safely");
        assert!(error.contains("byte per-call safety limit"));
        assert!(error.contains("begin_large_write"));
        assert!(error.contains("append_write_chunk"));
        assert!(error.contains("commit_large_write"));
        assert!(!root.join(path).exists());
    }

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

    execute_file_tool(
        "write_file",
        &json!({ "path": "src/components/Panel.tsx", "content": "export function Panel() {}\n" }),
    )
    .expect("scaffold the real target");

    // The typo: `component` instead of `components`.
    let typo = execute_file_tool(
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
    execute_file_tool(
        "append_file",
        &json!({ "path": "src/components/Panel.tsx", "content": "// chunk 2\n" }),
    )
    .expect("appending to the existing scaffold should succeed");
    assert_eq!(
        fs::read_to_string(root.join("src/components/Panel.tsx")).expect("read back"),
        "export function Panel() {}\n// chunk 2\n"
    );

    // Creating on append stays available, but only when asked for explicitly.
    let opted_in = execute_file_tool(
        "append_file",
        &json!({ "path": "logs/run.log", "content": "started\n", "create_if_missing": true }),
    )
    .expect("explicit create_if_missing should still work");
    let opted_in: serde_json::Value = serde_json::from_str(&opted_in).expect("json");
    assert_eq!(opted_in["created"], true);

    std::env::set_current_dir(original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn complete_valid_cjk_payload_above_the_old_token_cap_succeeds_compactly() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("complete-cjk-payload");
    fs::create_dir_all(&root).expect("create root");
    let _workspace_root = EnvGuard::set(ARIS_WORKSPACE_ROOT_ENV, &root);
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("set cwd");

    // This reproduces the reported ~23 KB Chinese LaTeX call: its JSON is
    // complete and well inside the filesystem byte guard, so a guessed model
    // token cap must not reject it after the call already arrived intact.
    let chinese = "研究方法、证据约束与动态增强。\n".repeat(850);
    assert!(chinese.len() > 23_196);
    assert!(runtime::estimate_text_tokens(&chinese) > 9_000);
    let output = execute_file_tool(
        "write_file",
        &json!({
            "path": ".somniq/papers/third-paper-chapter2-revised.tex",
            "content": chinese,
            "expected_revision": "absent"
        }),
    )
    .expect("complete valid CJK payload should be written");
    let parsed: serde_json::Value = serde_json::from_str(&output).expect("compact json");
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["bytes"], chinese.len());
    assert!(parsed.get("content").is_none());
    assert!(parsed.get("originalFile").is_none());
    assert!(parsed.get("changes").is_none());
    assert!(
        output.len() < 2_000,
        "tool result must not echo the large file"
    );
    assert_eq!(
        fs::read_to_string(root.join(".somniq/papers/third-paper-chapter2-revised.tex"))
            .expect("read generated paper"),
        chinese
    );

    std::env::set_current_dir(original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn staged_write_tools_publish_once_and_keep_tool_results_compact() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("staged-write-tools");
    fs::create_dir_all(&root).expect("create root");
    let _workspace_root = EnvGuard::set(ARIS_WORKSPACE_ROOT_ENV, &root);
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("set cwd");

    let begun = execute_file_tool(
        "begin_large_write",
        &json!({ "path": ".somniq/papers/chapter.tex", "expected_revision": "absent" }),
    )
    .expect("begin staged write");
    let begun: serde_json::Value = serde_json::from_str(&begun).expect("begin json");
    let write_id = begun["writeId"].as_str().expect("write id").to_string();
    assert!(!root.join(".somniq/papers/chapter.tex").exists());

    let chunk = "研究方法与实验结果。\n".repeat(1_000);
    let first = execute_file_tool(
        "append_write_chunk",
        &json!({ "write_id": write_id, "sequence": 0, "content": chunk }),
    )
    .expect("append staged chunk");
    let first: serde_json::Value = serde_json::from_str(&first).expect("chunk json");
    assert_eq!(first["nextSequence"], 1);
    assert!(!root.join(".somniq/papers/chapter.tex").exists());

    let committed = execute_file_tool("commit_large_write", &json!({ "write_id": write_id }))
        .expect("commit staged write");
    let committed: serde_json::Value = serde_json::from_str(&committed).expect("commit json");
    assert_eq!(committed["ok"], true);
    assert_eq!(committed["staged"], true);
    assert_eq!(committed["type"], "create");
    assert!(committed.get("content").is_none());
    assert!(committed.get("changes").is_none());
    assert_eq!(
        fs::read_to_string(root.join(".somniq/papers/chapter.tex")).expect("read committed"),
        chunk
    );

    std::env::set_current_dir(original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn file_mutation_schemas_require_a_revision_token() {
    let specs = mvp_tool_specs();
    for tool_name in ["write_file", "append_file", "edit_file", "multi_edit"] {
        let schema = specs
            .iter()
            .find(|spec| spec.name == tool_name)
            .expect("file tool spec")
            .input_schema
            .clone();
        let required = schema["required"].as_array().expect("required fields");
        assert!(
            required.iter().any(|field| field == "expected_revision"),
            "{tool_name} must require expected_revision"
        );
    }
}

#[test]
fn file_mutations_reject_missing_revisions_even_without_schema_validation() {
    let inputs = [
        ("write_file", json!({ "path": "new.txt", "content": "new" })),
        (
            "append_file",
            json!({ "path": "existing.txt", "content": "append" }),
        ),
        (
            "edit_file",
            json!({ "path": "existing.txt", "old_string": "old", "new_string": "new" }),
        ),
        (
            "multi_edit",
            json!({ "path": "existing.txt", "edits": [{ "old_string": "old", "new_string": "new" }] }),
        ),
    ];

    let execute = execute_tool;
    for (name, input) in inputs {
        let error = execute(name, &input).expect_err("missing revision must be rejected");
        assert!(
            error.contains("missing field `expected_revision`"),
            "{name}: {error}"
        );
    }
}
