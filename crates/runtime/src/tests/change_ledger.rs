use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{
    get_file_change, list_file_changes, record_text_file_change, revert_file_change,
    FileChangeGetInput, FileChangeListInput, FileChangeOperation, FileChangeRevertInput,
    FileChangeStatus, FileMutationContext,
};

struct EnvGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: impl AsRef<OsStr>) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.as_ref() {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

fn temp_path(name: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time should move forward")
        .as_nanos();
    std::env::temp_dir().join(format!("aris-change-ledger-{name}-{unique}"))
}

#[test]
fn records_and_reverts_text_file_changes() {
    let _lock = crate::test_env_lock();
    let root = temp_path("revert");
    std::fs::create_dir_all(&root).expect("create root");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let _session = EnvGuard::set("ARIS_SESSION_ID", "ledger-session");
    let path = root.join("demo.txt");

    crate::write_file(path.to_string_lossy().as_ref(), "one\n").expect("create file");
    let edit =
        crate::edit_file(path.to_string_lossy().as_ref(), "one", "two", false).expect("edit file");
    let change_id = edit.change_id.expect("edit should record a change");

    let fetched = get_file_change(FileChangeGetInput {
        change_id: change_id.clone(),
        session_id: Some("ledger-session".to_string()),
    })
    .expect("get change");
    assert_eq!(fetched.record.change_id, change_id);
    assert_eq!(fetched.record.structured_patch[0].old_start, 1);
    assert_eq!(fetched.record.structured_patch[0].new_start, 1);

    let reverted = revert_file_change(
        FileChangeRevertInput {
            change_id: change_id.clone(),
            session_id: Some("ledger-session".to_string()),
        },
        &FileMutationContext::from_env("change_revert"),
    )
    .expect("revert change");
    assert!(reverted.reverted);
    assert!(reverted.revert_change_id.is_some());
    assert_eq!(
        std::fs::read_to_string(&path).expect("read reverted"),
        "one\n"
    );

    let listed = list_file_changes(FileChangeListInput {
        session_id: Some("ledger-session".to_string()),
        limit: None,
    })
    .expect("list changes");
    let original = listed
        .records
        .iter()
        .find(|record| record.change_id == change_id)
        .expect("original change should remain in ledger");
    assert_eq!(original.status, FileChangeStatus::Reverted);
    assert!(original.reverted_by.is_some());
}

#[test]
fn revert_reports_conflict_when_file_changed_after_recorded_edit() {
    let _lock = crate::test_env_lock();
    let root = temp_path("conflict");
    std::fs::create_dir_all(&root).expect("create root");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let _session = EnvGuard::set("ARIS_SESSION_ID", "conflict-session");
    let path = root.join("demo.txt");

    crate::write_file(path.to_string_lossy().as_ref(), "one\n").expect("create file");
    let edit =
        crate::edit_file(path.to_string_lossy().as_ref(), "one", "two", false).expect("edit file");
    let change_id = edit.change_id.expect("edit should record a change");
    std::fs::write(&path, "three\n").expect("simulate user edit");

    let reverted = revert_file_change(
        FileChangeRevertInput {
            change_id,
            session_id: Some("conflict-session".to_string()),
        },
        &FileMutationContext::from_env("change_revert"),
    )
    .expect("revert should return conflict output");

    assert!(!reverted.reverted);
    assert!(reverted.conflict.is_some());
    assert_eq!(
        std::fs::read_to_string(&path).expect("read file"),
        "three\n"
    );
}

#[test]
fn fills_missing_diff_projections_from_before_and_after_text() {
    let _lock = crate::test_env_lock();
    let root = temp_path("generated-diff");
    std::fs::create_dir_all(&root).expect("create root");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let path = root.join("main.rs");

    let record = record_text_file_change(
        &FileMutationContext {
            tool_name: "vscode-editor".to_string(),
            ..FileMutationContext::default()
        },
        &path,
        FileChangeOperation::Update,
        Some("fn main() {}\n"),
        Some("fn main() { println!(\"hi\"); }\n"),
        Vec::new(),
        String::new(),
        None,
    )
    .expect("record change")
    .expect("contents differ");

    assert!(record.unified_diff.contains("-fn main() {}"));
    assert!(
        record
            .unified_diff
            .contains("+fn main() { println!(\"hi\"); }")
    );
    assert!(!record.structured_patch.is_empty());
}
