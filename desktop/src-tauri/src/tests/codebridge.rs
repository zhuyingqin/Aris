use super::{accept_hello, constant_time_eq, record_save, CodeBridgeState};
use remote_protocol::{BridgeToHost, HostToBridge, CODE_BRIDGE_PROTOCOL_VERSION};

fn hello(token: &str, version: u32) -> String {
    serde_json::to_string(&BridgeToHost::Hello {
        token: token.to_string(),
        protocol_version: version,
        vscode_version: "1.126.0".into(),
    })
    .expect("serialize hello")
}

#[test]
fn a_matching_hello_is_accepted() {
    let frame = hello("s3cret", CODE_BRIDGE_PROTOCOL_VERSION);
    assert!(accept_hello(&frame, "s3cret").is_ok());
}

/// Loopback is reachable by every local process, so the token is the only
/// thing separating the bridge from any other program on the machine.
#[test]
fn a_wrong_token_is_rejected() {
    let frame = hello("guessed", CODE_BRIDGE_PROTOCOL_VERSION);
    let error = accept_hello(&frame, "s3cret").expect_err("must reject");
    assert!(error.contains("token"), "{error}");
}

#[test]
fn a_token_of_a_different_length_is_rejected() {
    let frame = hello("s3", CODE_BRIDGE_PROTOCOL_VERSION);
    assert!(accept_hello(&frame, "s3cret").is_err());
}

/// A version we do not understand must fail loudly rather than be interpreted
/// under the current schema.
#[test]
fn an_unknown_protocol_version_is_rejected() {
    let frame = hello("s3cret", CODE_BRIDGE_PROTOCOL_VERSION + 1);
    let error = accept_hello(&frame, "s3cret").expect_err("must reject");
    assert!(error.contains("protocol"), "{error}");
}

/// Anything that is not a handshake must not open the connection, even when it
/// is a valid message of another kind.
#[test]
fn a_non_hello_first_frame_is_rejected() {
    let frame = serde_json::to_string(&BridgeToHost::AskAris {
        path: "a.rs".into(),
        start_line: 1,
        end_line: 2,
        text: "fn main() {}".into(),
        language_id: "rust".into(),
    })
    .expect("serialize");
    assert!(accept_hello(&frame, "s3cret").is_err());
}

#[test]
fn garbage_is_rejected_without_panicking() {
    assert!(accept_hello("", "s3cret").is_err());
    assert!(accept_hello("{", "s3cret").is_err());
    assert!(accept_hello("[]", "s3cret").is_err());
}

#[test]
fn token_comparison_is_length_safe() {
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(!constant_time_eq(b"abc", b"abd"));
    assert!(!constant_time_eq(b"abc", b"ab"));
    assert!(constant_time_eq(b"", b""));
}

/// Nothing may be sent while the extension is detached, and asking must not
/// fail — every caller is best-effort, and a missing editor must never break
/// an AI turn.
#[test]
fn sending_without_a_connection_is_a_no_op() {
    let state = CodeBridgeState::default();
    assert!(!state.is_connected());
    state.send(HostToBridge::SaveAll);
    state.send(HostToBridge::SetTheme {
        dark: true,
        colors: Default::default(),
    });
    assert!(state.endpoint().is_none(), "no endpoint before start()");
}

fn temp_workspace(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("somniq-codebridge-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create workspace");
    dir
}

/// Concatenate every `ledger.jsonl` under the change-ledger root; entries are
/// filed per session directory, so the test must not assume one location.
fn ledger_entries(root: &std::path::Path) -> String {
    let mut text = String::new();
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        if entry.file_name() == "ledger.jsonl" {
            text.push_str(&std::fs::read_to_string(entry.path()).unwrap_or_default());
        }
    }
    text
}

/// A human edit has to land in the same ledger the AI's edit tools write to.
/// A history that only shows what the model did is a history with the user
/// edited out of it.
#[test]
fn a_saved_document_is_recorded_in_the_change_ledger() {
    let _lock = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let workspace = temp_workspace("record");
    let previous = std::env::var_os("ARIS_WORKSPACE_ROOT");
    std::env::set_var("ARIS_WORKSPACE_ROOT", &workspace);

    let file = workspace.join("main.rs");
    std::fs::write(&file, "fn main() {}\n").expect("seed file");
    record_save(
        &file.to_string_lossy(),
        Some("fn main() {}\n"),
        "fn main() { println!(\"hi\"); }\n",
    );

    let entries = ledger_entries(&runtime::change_ledger_root_for_path(&file));
    match previous {
        Some(value) => std::env::set_var("ARIS_WORKSPACE_ROOT", value),
        None => std::env::remove_var("ARIS_WORKSPACE_ROOT"),
    }

    assert!(entries.contains("vscode-editor"), "ledger: {entries}");
    let _ = std::fs::remove_dir_all(&workspace);
}

#[test]
fn a_save_without_a_baseline_is_recorded_as_a_new_file() {
    let _lock = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let workspace = temp_workspace("no-baseline");
    let previous = std::env::var_os("ARIS_WORKSPACE_ROOT");
    std::env::set_var("ARIS_WORKSPACE_ROOT", &workspace);

    let file = workspace.join("new.rs");
    record_save(&file.to_string_lossy(), None, "fn main() {}\n");
    let entries = ledger_entries(&runtime::change_ledger_root_for_path(&file));

    match previous {
        Some(value) => std::env::set_var("ARIS_WORKSPACE_ROOT", value),
        None => std::env::remove_var("ARIS_WORKSPACE_ROOT"),
    }
    assert!(entries.contains("vscode-editor"), "ledger: {entries}");
    assert!(
        entries.contains("\"operation\":\"create\""),
        "ledger: {entries}"
    );
    assert!(entries.contains("+fn main() {}"), "ledger: {entries}");
    let _ = std::fs::remove_dir_all(&workspace);
}

/// Saving an unchanged buffer is common (Ctrl+S reflex) and must not fill the
/// history with empty entries.
#[test]
fn saving_an_unchanged_document_records_nothing() {
    let _lock = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let workspace = temp_workspace("unchanged");
    let previous = std::env::var_os("ARIS_WORKSPACE_ROOT");
    std::env::set_var("ARIS_WORKSPACE_ROOT", &workspace);

    let file = workspace.join("same.rs");
    std::fs::write(&file, "same\n").expect("seed file");
    record_save(&file.to_string_lossy(), Some("same\n"), "same\n");
    let entries = ledger_entries(&runtime::change_ledger_root_for_path(&file));

    match previous {
        Some(value) => std::env::set_var("ARIS_WORKSPACE_ROOT", value),
        None => std::env::remove_var("ARIS_WORKSPACE_ROOT"),
    }
    assert!(entries.is_empty(), "ledger: {entries}");
    let _ = std::fs::remove_dir_all(&workspace);
}
