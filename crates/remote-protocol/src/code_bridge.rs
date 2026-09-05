//! Wire protocol between the embedded VS Code workbench and the desktop app.
//!
//! The Code page runs a real VSCodium workbench in an iframe. Everything Aris
//! adds on top — asking the assistant about a selection, keeping the editor and
//! the AI from writing over each other, recording human edits in the same
//! change ledger the AI's edits go into — travels over one loopback WebSocket
//! between the `aris-code-bridge` extension (running in the workbench's Node
//! extension host) and the desktop process.
//!
//! This is a deliberately small, closed message set. It is defined here rather
//! than hand-written on each side because the desktop audit already records
//! three hand-mirrored wire formats as the project's highest drift risk; a
//! fourth would be a choice, not an accident.
//!
//! Two properties the transport relies on:
//!
//! * **The extension is a client, the desktop is the server.** The desktop
//!   mints the address and token and hands them to the workbench process as
//!   environment variables, which the extension host inherits. The reverse
//!   (extension listens, desktop discovers) has no bootstrap.
//! * **Every message is JSON with a `type` tag** whose values do not overlap
//!   any other protocol in this crate, so a payload from one channel cannot
//!   decode as the other.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Bumped when a field changes meaning. The desktop refuses a bridge whose
/// major version it does not recognise rather than guessing.
pub const CODE_BRIDGE_PROTOCOL_VERSION: u32 = 1;

/// Environment variable carrying `ws://127.0.0.1:<port>` into the extension
/// host. Read by `aris-code-bridge` at activation.
pub const CODE_BRIDGE_URL_ENV: &str = "ARIS_BRIDGE_URL";

/// Environment variable carrying the shared secret. A loopback listener is
/// reachable by every local process, so the socket is authenticated even
/// though it never leaves the machine.
pub const CODE_BRIDGE_TOKEN_ENV: &str = "ARIS_BRIDGE_TOKEN";

/// Upper bound on a single frame. A save event carries file contents, and a
/// runaway generated file should fail loudly rather than pin memory.
pub const CODE_BRIDGE_MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Text longer than this is truncated before it becomes chat context; a whole
/// minified bundle pasted into a prompt helps nobody.
pub const CODE_BRIDGE_MAX_SELECTION_BYTES: usize = 32 * 1024;

/// A message from the extension to the desktop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BridgeToHost {
    /// First frame on every connection. The desktop replies with
    /// [`HostToBridge::Welcome`] or closes.
    Hello {
        token: String,
        protocol_version: u32,
        /// Workbench version, for diagnostics only.
        vscode_version: String,
    },
    /// The user asked the assistant about what they had selected.
    AskAris {
        /// Absolute path of the file the selection came from.
        path: String,
        /// 1-based, inclusive, matching what the editor shows in its gutter.
        start_line: u32,
        end_line: u32,
        /// Already truncated to [`CODE_BRIDGE_MAX_SELECTION_BYTES`].
        text: String,
        language_id: String,
    },
    /// A document was written to disk by the user (not by Aris).
    ///
    /// `before` is `None` when the extension had no cached copy — a new file,
    /// for instance. The desktop records that as a create operation.
    DocumentSaved {
        path: String,
        before: Option<String>,
        after: String,
    },
    /// The user switched editors, or closed the last one.
    ///
    /// The desktop needs this because panels that live *outside* the workbench
    /// — submitting the open notebook to a compute node, for one — otherwise
    /// have no idea what the user is looking at. `path` is `None` when nothing
    /// file-backed is focused.
    ActiveEditorChanged {
        path: Option<String>,
        is_notebook: bool,
    },
    /// Response to [`HostToBridge::SaveAll`], sent once the workbench has
    /// flushed every dirty editor.
    SaveAllDone {
        /// Paths that were dirty and are now written.
        saved: Vec<String>,
        /// Paths that could not be written, with the reason.
        failed: Vec<String>,
    },
}

/// A message from the desktop to the extension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostToBridge {
    /// The handshake was accepted.
    Welcome { protocol_version: u32 },
    /// Flush every dirty editor before Aris touches the working tree.
    ///
    /// Without this an AI edit races the user's unsaved buffer: whichever
    /// writes last wins and the other change is lost with no record.
    SaveAll,
    /// Aris finished writing; refresh cached baselines so the next save diffs
    /// against what is actually on disk rather than a pre-AI copy.
    ReloadFromDisk { paths: Vec<String> },
    /// Follow the app's appearance.
    ///
    /// This is the only way to reach the workbench's configuration: the web
    /// workbench keeps user settings in browser storage, so nothing the
    /// desktop writes to disk is ever read. The extension applies it through
    /// the configuration API from inside the extension host.
    ///
    /// `dark` picks the base theme, which also decides the syntax palette —
    /// SomniQ's code tokens are Dark+/Light+ already, so those are left alone.
    /// `colors` carries the app's own surface palette as VS Code colour IDs,
    /// resolved from the live stylesheet rather than duplicated here, so a
    /// change to the app's tokens reaches the workbench without a second edit.
    /// Sorted, so an unchanged palette serialises identically every time.
    SetTheme {
        dark: bool,
        #[serde(default)]
        colors: BTreeMap<String, String>,
    },
    /// Reveal a file in the workbench.
    ///
    /// Clicking a path in chat has to land somewhere. With the built-in editor
    /// the app opened the tab itself; the workbench owns its own tabs, so the
    /// request has to travel over the bridge or the click silently does
    /// nothing.
    OpenFile { path: String },
    /// Open a Git working-tree or staged diff in the workbench's native diff
    /// editor. The path is an absolute file path owned by the current project.
    OpenDiff { path: String, staged: bool },
    /// Shown in the workbench status bar so the user can see whether the
    /// editor is actually talking to Aris.
    Status { text: String, tooltip: String },
}

/// Cut `text` to at most `max_bytes` without splitting a UTF-8 sequence.
///
/// Returns the text and whether anything was dropped, so the caller can say so
/// rather than silently handing the model a fragment.
#[must_use]
pub fn truncate_utf8(text: &str, max_bytes: usize) -> (&str, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_round_trips() {
        let message = BridgeToHost::Hello {
            token: "secret".into(),
            protocol_version: CODE_BRIDGE_PROTOCOL_VERSION,
            vscode_version: "1.126.0".into(),
        };
        let json = serde_json::to_string(&message).expect("serialize");
        assert!(json.contains("\"type\":\"hello\""), "{json}");
        assert_eq!(
            serde_json::from_str::<BridgeToHost>(&json).expect("deserialize"),
            message
        );
    }

    #[test]
    fn host_messages_round_trip() {
        for message in [
            HostToBridge::Welcome { protocol_version: 1 },
            HostToBridge::SaveAll,
            HostToBridge::ReloadFromDisk {
                paths: vec!["a.rs".into()],
            },
            HostToBridge::SetTheme {
                dark: true,
                colors: BTreeMap::from([("editor.background".into(), "#0e1116".into())]),
            },
            HostToBridge::OpenFile {
                path: "D:/work/a.rs".into(),
            },
            HostToBridge::OpenDiff {
                path: "D:/work/a.rs".into(),
                staged: false,
            },
            HostToBridge::Status {
                text: "Aris".into(),
                tooltip: "connected".into(),
            },
        ] {
            let json = serde_json::to_string(&message).expect("serialize");
            assert_eq!(
                serde_json::from_str::<HostToBridge>(&json).expect("deserialize"),
                message
            );
        }
    }

    /// The two directions must not be confusable: a frame meant for one side
    /// decoding as a valid message on the other would let a compromised
    /// extension replay host commands back at the desktop.
    #[test]
    fn the_two_directions_do_not_share_tags() {
        let save_all = serde_json::to_string(&HostToBridge::SaveAll).expect("serialize");
        assert!(serde_json::from_str::<BridgeToHost>(&save_all).is_err());

        let done = serde_json::to_string(&BridgeToHost::SaveAllDone {
            saved: vec![],
            failed: vec![],
        })
        .expect("serialize");
        assert!(serde_json::from_str::<HostToBridge>(&done).is_err());
    }

    #[test]
    fn an_empty_active_editor_round_trips() {
        let message = BridgeToHost::ActiveEditorChanged {
            path: None,
            is_notebook: false,
        };
        let json = serde_json::to_string(&message).expect("serialize");
        assert!(json.contains("\"type\":\"active-editor-changed\""), "{json}");
        assert_eq!(
            serde_json::from_str::<BridgeToHost>(&json).expect("deserialize"),
            message
        );
    }

    /// The extension shipped with an older app build predates `colors`. It has
    /// to keep applying light/dark rather than failing the whole frame.
    #[test]
    fn a_theme_frame_without_colors_still_decodes() {
        let message: HostToBridge =
            serde_json::from_str(r#"{"type":"set-theme","dark":false}"#).expect("deserialize");
        assert_eq!(
            message,
            HostToBridge::SetTheme {
                dark: false,
                colors: BTreeMap::new(),
            }
        );
    }

    #[test]
    fn truncation_keeps_short_text_untouched() {
        assert_eq!(truncate_utf8("hello", 32), ("hello", false));
    }

    #[test]
    fn truncation_never_splits_a_multibyte_character() {
        // Three bytes each, so a 4-byte budget lands mid-character.
        let (cut, truncated) = truncate_utf8("中文字", 4);
        assert!(truncated);
        assert_eq!(cut, "中");
        assert!(std::str::from_utf8(cut.as_bytes()).is_ok());
    }

    #[test]
    fn truncation_reports_when_it_dropped_something() {
        let (cut, truncated) = truncate_utf8("abcdef", 3);
        assert_eq!(cut, "abc");
        assert!(truncated);
    }
}
