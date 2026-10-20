use super::*;

const REAL_DOCX: &[u8] =
    include_bytes!("../../../../runtime/src/tests/fixtures/docx-native-math.docx");

fn in_workspace(action: impl FnOnce(&std::path::Path)) {
    let root = temp_path("docx-tools");
    fs::create_dir_all(&root).unwrap();
    let context =
        runtime::ProjectExecutionContext::new(&root).with_env(ARIS_WORKSPACE_ROOT_ENV, &root);
    runtime::with_project_execution_context(&context, || action(&root));
    fs::remove_dir_all(&root).unwrap();
}

fn run(name: &str, input: serde_json::Value) -> serde_json::Value {
    serde_json::from_str(&execute_tool(name, &input).unwrap()).unwrap()
}

#[test]
fn docx_tools_read_edit_audit_and_revert_an_actual_native_math_document() {
    in_workspace(|root| {
        fs::write(root.join("sample.docx"), REAL_DOCX).unwrap();
        let read = run("read_file", json!({"path": "sample.docx", "limit": 100}));
        assert_eq!(read["nativeEquationCount"], 9);
        assert!(read["revision"].as_str().unwrap().starts_with("sha256:"));
        let direct = run("read_docx", json!({"path": "sample.docx", "limit": 100}));
        assert_eq!(direct["paragraphs"], read["paragraphs"]);
        let paragraph = read["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["text"].as_str().unwrap().starts_with("跨格式文本"))
            .unwrap();
        let edited = run(
            "edit_docx",
            json!({
                "path": "sample.docx", "expected_revision": read["revision"],
                "edits": [{"paragraph_id": paragraph["id"], "old_string": "跨格式文本", "new_string": "准确修改"}]
            }),
        );
        assert_eq!(edited["preservedNativeEquations"], 9);
        assert_eq!(edited["appliedEdits"], 1);
        let reread = run("read_file", json!({"path": "sample.docx", "limit": 100}));
        assert_ne!(reread["revision"], read["revision"]);
        assert_eq!(reread["revision"], edited["revision"]);
        assert!(reread["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["text"].as_str().unwrap().starts_with("准确修改")));
        let record = run("change_get", json!({"change_id": edited["changeId"]}));
        assert_eq!(record["record"]["before"]["contentKind"], "binary");
        assert_eq!(record["record"]["reversible"], true);
        let reverted = run("change_revert", json!({"change_id": edited["changeId"]}));
        assert_eq!(reverted["reverted"], true);
        assert_eq!(fs::read(root.join("sample.docx")).unwrap(), REAL_DOCX);
    });
}

#[test]
fn docx_tool_contract_rejects_missing_versions_bad_batches_and_plain_text_writes() {
    in_workspace(|root| {
        fs::write(root.join("sample.docx"), REAL_DOCX).unwrap();
        let read = run("read_docx", json!({"path": "sample.docx"}));
        let id = read["paragraphs"][0]["id"].clone();
        assert!(execute_tool("edit_docx", &json!({"path":"sample.docx","edits":[]})).is_err());
        for revision in [json!("stale"), read["revision"].clone()] {
            assert!(execute_tool("edit_docx", &json!({
                "path": "sample.docx", "expected_revision": revision,
                "edits": [
                    {"paragraph_id": id, "old_string": "DOCX accuracy fixture", "new_string": "changed"},
                    {"paragraph_id": id, "old_string": "missing", "new_string": "bad"}
                ]
            })).is_err());
            assert_eq!(fs::read(root.join("sample.docx")).unwrap(), REAL_DOCX);
        }
        assert!(execute_tool(
            "write_file",
            &json!({
                "path":"sample.docx","expected_revision":read["revision"],"content":"flattened text"
            })
        )
        .unwrap_err()
        .contains("binary packages"));
        assert_eq!(fs::read(root.join("sample.docx")).unwrap(), REAL_DOCX);
        let batch = run(
            "read_files",
            json!({"requests":[
            {"path":"sample.docx","limit":1}, {"path":"missing.docx"}]}),
        );
        assert_eq!(batch["succeeded"], 1);
        assert_eq!(batch["results"][0]["result"]["nativeEquationCount"], 9);
        assert_eq!(
            batch["results"][0]["result"]["paragraphs"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    });
}

#[test]
fn docx_tools_have_distinct_permissions_and_reviewers_can_read() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _allowed = EnvGuard::unset("ARIS_ALLOWED_TOOLS");
    let specs = mvp_tool_specs();
    assert_eq!(specs.iter().filter(|s| s.name == "read_docx").count(), 1);
    assert_eq!(specs.iter().filter(|s| s.name == "edit_docx").count(), 1);
    assert_eq!(
        specs
            .iter()
            .find(|s| s.name == "read_docx")
            .unwrap()
            .required_permission,
        runtime::PermissionMode::ReadOnly
    );
    assert_eq!(
        specs
            .iter()
            .find(|s| s.name == "edit_docx")
            .unwrap()
            .required_permission,
        runtime::PermissionMode::WorkspaceWrite
    );
    assert_eq!(tool_execution("read_docx"), ToolExecution::Parallel);
    assert_eq!(tool_execution("edit_docx"), ToolExecution::Serial);
    // Child permissions are bound by the session host, which intersects these
    // schema permissions with its read-only allowlist. No legacy role bypass.
}

#[cfg(windows)]
#[test]
fn docx_chat_reads_work_while_an_editor_keeps_the_file_open() {
    use std::os::windows::fs::OpenOptionsExt;
    in_workspace(|root| {
        let path = root.join("open.docx");
        fs::write(&path, REAL_DOCX).unwrap();
        let editor = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        let single = run("read_file", json!({"path":"open.docx"}));
        let direct = run("read_docx", json!({"path":"open.docx"}));
        let batch = run("read_files", json!({"requests":[{"path":"open.docx"}]}));
        assert_eq!(single["revision"], direct["revision"]);
        assert_eq!(
            single["revision"],
            batch["results"][0]["result"]["revision"]
        );
        assert_eq!(batch["succeeded"], 1);
        assert_eq!(editor.metadata().unwrap().len(), REAL_DOCX.len() as u64);
        assert!(
            fs::rename(&path, root.join("renamed.docx")).is_err(),
            "editor's sharing lock must remain held"
        );
        assert_eq!(fs::read(&path).unwrap(), REAL_DOCX);
        drop(editor);
    });
}

#[cfg(windows)]
#[test]
fn exclusive_editor_locks_return_safe_read_errors_and_leave_the_lock_intact() {
    use std::os::windows::fs::OpenOptionsExt;
    in_workspace(|root| {
        let path = root.join("locked.docx");
        fs::write(&path, REAL_DOCX).unwrap();
        let editor = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        for name in ["read_file", "read_docx"] {
            let error = execute_tool(name, &json!({"path":"locked.docx"})).unwrap_err();
            assert!(error.contains("document_read_unavailable"), "{error}");
            assert!(error.contains("keeping the editor open"));
        }
        let batch = run("read_files", json!({"requests":[{"path":"locked.docx"}]}));
        assert_eq!(batch["failed"], 1);
        assert!(batch["results"][0]["error"]
            .as_str()
            .unwrap()
            .contains("saved copy"));
        assert!(
            fs::File::open(&path).is_err(),
            "editor's exclusive lock must remain held"
        );
        drop(editor);
        assert_eq!(fs::read(&path).unwrap(), REAL_DOCX);
    });
}
