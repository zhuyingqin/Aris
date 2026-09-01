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
    assert!(record
        .unified_diff
        .contains("+fn main() { println!(\"hi\"); }"));
    assert!(!record.structured_patch.is_empty());
}

#[test]
fn a_large_created_file_is_revertible_without_storing_an_after_blob() {
    let _lock = crate::test_env_lock();
    let root = temp_path("large-create-revert");
    std::fs::create_dir_all(&root).expect("create root");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let _session = EnvGuard::set("ARIS_SESSION_ID", "large-create-session");
    let path = root.join("large.txt");
    let content = "x".repeat(super::MAX_REVERT_BLOB_BYTES + 1_024);

    let output =
        crate::write_file(path.to_string_lossy().as_ref(), &content).expect("create large file");
    let change_id = output.change_id.expect("change id");
    let record = get_file_change(FileChangeGetInput {
        change_id: change_id.clone(),
        session_id: Some("large-create-session".to_string()),
    })
    .expect("get change")
    .record;
    assert!(record.reversible);
    assert!(record.after.blob_ref.is_none());

    let reverted = revert_file_change(
        FileChangeRevertInput {
            change_id,
            session_id: Some("large-create-session".to_string()),
        },
        &FileMutationContext::from_env("change_revert"),
    )
    .expect("revert large create");
    assert!(reverted.reverted);
    assert!(!path.exists());
}

#[test]
fn a_large_append_reverts_by_verified_utf8_byte_length() {
    let _lock = crate::test_env_lock();
    let root = temp_path("large-append-revert");
    std::fs::create_dir_all(&root).expect("create root");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let _session = EnvGuard::set("ARIS_SESSION_ID", "large-append-session");
    let path = root.join("large.txt");
    let base = format!("{}中文边界\n", "a".repeat(super::MAX_REVERT_BLOB_BYTES));
    std::fs::write(&path, &base).expect("write large base outside ledger");

    let output = crate::append_file(path.to_string_lossy().as_ref(), "追加段落\n", false)
        .expect("append large file");
    let change_id = output.change_id.expect("change id");
    let record = get_file_change(FileChangeGetInput {
        change_id: change_id.clone(),
        session_id: Some("large-append-session".to_string()),
    })
    .expect("get append")
    .record;
    assert!(record.reversible);
    assert!(record.before.blob_ref.is_none());
    assert!(record.after.blob_ref.is_none());

    let reverted = revert_file_change(
        FileChangeRevertInput {
            change_id,
            session_id: Some("large-append-session".to_string()),
        },
        &FileMutationContext::from_env("change_revert"),
    )
    .expect("revert append");
    assert!(reverted.reverted);
    assert_eq!(std::fs::read_to_string(&path).expect("read reverted"), base);
}

#[test]
fn large_audit_diffs_are_bounded_but_keep_exact_hashes() {
    let _lock = crate::test_env_lock();
    let root = temp_path("bounded-ledger-diff");
    std::fs::create_dir_all(&root).expect("create root");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let path = root.join("many-lines.txt");
    let before = (0..2_000)
        .map(|index| format!("before-{index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let after = (0..2_000)
        .map(|index| format!("after-{index}"))
        .collect::<Vec<_>>()
        .join("\n");

    let record = record_text_file_change(
        &FileMutationContext {
            tool_name: "large-audit-test".to_string(),
            ..FileMutationContext::default()
        },
        &path,
        FileChangeOperation::Update,
        Some(&before),
        Some(&after),
        Vec::new(),
        String::new(),
        None,
    )
    .expect("record")
    .expect("changed");
    assert!(record.before.content_hash.is_some());
    assert!(record.after.content_hash.is_some());
    assert!(record.structured_patch[0].lines.len() <= super::MAX_LEDGER_PATCH_LINES + 1);
    assert!(record.unified_diff.chars().count() <= super::MAX_LEDGER_DIFF_CHARS);
    assert!(
        record.unified_diff.contains("SomniQ omitted")
            || record.unified_diff.contains("SomniQ bounded")
    );
}
