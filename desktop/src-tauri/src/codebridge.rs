//! Loopback WebSocket bridge to the embedded VS Code workbench.
//!
//! The workbench itself is just an editor in an iframe; everything that makes
//! it *Aris's* editor happens here. The `aris-code-bridge` extension runs in
//! the workbench's Node extension host and connects back to this server, which
//! gives the desktop a way to:
//!
//! * receive "ask Aris about this selection" and turn it into chat context;
//! * record what the user saves in the same change ledger the AI's edit tools
//!   write to, so human and AI edits share one history instead of two;
//! * flush dirty editors before an AI turn and invalidate baselines after it,
//!   which is the only thing standing between an AI write and an unsaved
//!   buffer silently clobbering each other;
//! * push the app's light/dark theme, which cannot be done any other way —
//!   the web workbench keeps user settings in browser storage, so nothing
//!   written to disk is ever read.
//!
//! The desktop is the server and the extension is the client because only the
//! desktop can bootstrap the other side: it spawns the workbench process and
//! passes the address and token in the environment, which the extension host
//! inherits.
//!
//! Loopback is not a trust boundary — every local process can reach it — so
//! the first frame must be a `Hello` carrying the shared token, and anything
//! else closes the connection.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use remote_protocol::{
    truncate_utf8, BridgeToHost, HostToBridge, CODE_BRIDGE_MAX_FRAME_BYTES,
    CODE_BRIDGE_MAX_SELECTION_BYTES, CODE_BRIDGE_PROTOCOL_VERSION,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// Emitted when the user runs "Ask Aris" in the workbench.
const ASK_EVENT: &str = "code-bridge-ask";

/// Emitted when the extension connects or drops, so the UI can stop claiming
/// the editor is wired up when it is not.
const CONNECTION_EVENT: &str = "code-bridge-connection";

/// Emitted when the workbench's active editor changes, so app-side panels can
/// act on the file the user is actually looking at.
const ACTIVE_EDITOR_EVENT: &str = "code-bridge-active-editor";

/// How long the extension has to send its `Hello` before we hang up. Generous
/// because the extension host starts under load, but not unbounded: an
/// unauthenticated socket must not be able to sit there.
const HELLO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Payload of [`ASK_EVENT`], mirrored by `CodeBridgeAsk` in `types.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskPayload {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
    pub language_id: String,
    /// Whether the selection was cut to fit; the prompt says so rather than
    /// presenting a fragment as the whole thing.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionPayload {
    connected: bool,
}

/// Payload of [`ACTIVE_EDITOR_EVENT`], mirrored by `CodeActiveEditor` in
/// `types.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveEditorPayload {
    pub path: Option<String>,
    pub is_notebook: bool,
}

#[derive(Default)]
struct Inner {
    port: Option<u16>,
    token: String,
    /// Sender into the live connection, if the extension is attached.
    outbound: Option<mpsc::UnboundedSender<HostToBridge>>,
}

/// App-managed handle to the bridge listener and the current connection.
#[derive(Clone)]
pub struct CodeBridgeState(Arc<Mutex<Inner>>);

impl Default for CodeBridgeState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Inner::default())))
    }
}

impl CodeBridgeState {
    /// Address and token to hand the workbench process, once the listener is
    /// up. `None` before [`start`] has bound.
    #[must_use]
    pub fn endpoint(&self) -> Option<(String, String)> {
        let guard = self.0.lock().ok()?;
        let port = guard.port?;
        Some((format!("ws://127.0.0.1:{port}"), guard.token.clone()))
    }

    #[must_use]
    pub fn is_connected(&self) -> bool {
        self.0
            .lock()
            .map(|guard| guard.outbound.is_some())
            .unwrap_or(false)
    }

    /// Send a command to the workbench. Silently does nothing when the
    /// extension is not attached — every caller is best-effort, and a missing
    /// editor must never fail an AI turn.
    pub fn send(&self, message: HostToBridge) -> bool {
        if let Ok(guard) = self.0.lock() {
            if let Some(tx) = guard.outbound.as_ref() {
                return tx.send(message).is_ok();
            }
        }
        false
    }
}

/// Bind the bridge on an ephemeral loopback port and serve connections.
///
/// Unlike the workbench itself the port here may drift freely: the extension
/// is told where to connect on every launch, and nothing persists across it.
pub async fn start(app: AppHandle, state: CodeBridgeState) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| format!("bind code bridge: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("code bridge address: {err}"))?
        .port();
    let token = random_token();

    if let Ok(mut guard) = state.0.lock() {
        guard.port = Some(port);
        guard.token = token.clone();
    }

    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((stream, peer)) = listener.accept().await else {
                continue;
            };
            let app = app.clone();
            let state = state.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move {
                serve_connection(app, state, stream, peer, token).await;
            });
        }
    });
    Ok(())
}

fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decide whether a first frame may open the bridge.
///
/// Split out from the socket loop so the rule is testable: the frame must be a
/// `Hello`, the token must match exactly, and the protocol major must be one
/// we understand.
pub fn accept_hello(frame: &str, expected_token: &str) -> Result<(), String> {
    let message: BridgeToHost = serde_json::from_str(frame)
        .map_err(|err| format!("first frame is not a bridge message: {err}"))?;
    let BridgeToHost::Hello {
        token,
        protocol_version,
        ..
    } = message
    else {
        return Err("first frame must be hello".to_string());
    };
    if !constant_time_eq(token.as_bytes(), expected_token.as_bytes()) {
        return Err("bridge token mismatch".to_string());
    }
    if protocol_version != CODE_BRIDGE_PROTOCOL_VERSION {
        return Err(format!(
            "unsupported bridge protocol {protocol_version}, expected {CODE_BRIDGE_PROTOCOL_VERSION}"
        ));
    }
    Ok(())
}

/// Compared without an early return so a local attacker cannot narrow the
/// token by timing repeated connections.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn serve_connection(
    app: AppHandle,
    state: CodeBridgeState,
    stream: TcpStream,
    _peer: SocketAddr,
    token: String,
) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (mut sink, mut source) = ws.split();

    // Authenticate before anything else is read.
    let hello = tokio::time::timeout(HELLO_TIMEOUT, source.next()).await;
    let Ok(Some(Ok(Message::Text(frame)))) = hello else {
        return;
    };
    if frame.len() > CODE_BRIDGE_MAX_FRAME_BYTES || accept_hello(&frame, &token).is_err() {
        return;
    }

    let welcome = HostToBridge::Welcome {
        protocol_version: CODE_BRIDGE_PROTOCOL_VERSION,
    };
    let Ok(welcome_text) = serde_json::to_string(&welcome) else {
        return;
    };
    if sink.send(Message::text(welcome_text)).await.is_err() {
        return;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<HostToBridge>();
    if let Ok(mut guard) = state.0.lock() {
        guard.outbound = Some(tx);
    }
    let _ = app.emit(CONNECTION_EVENT, ConnectionPayload { connected: true });

    // Outbound pump: host commands to the extension.
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(message) = rx.recv().await {
            let Ok(text) = serde_json::to_string(&message) else {
                continue;
            };
            if sink.send(Message::text(text)).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(message)) = source.next().await {
        let Message::Text(frame) = message else {
            continue;
        };
        if frame.len() > CODE_BRIDGE_MAX_FRAME_BYTES {
            break;
        }
        let Ok(parsed) = serde_json::from_str::<BridgeToHost>(&frame) else {
            continue;
        };
        handle_message(&app, parsed);
    }

    writer.abort();
    if let Ok(mut guard) = state.0.lock() {
        guard.outbound = None;
    }
    let _ = app.emit(CONNECTION_EVENT, ConnectionPayload { connected: false });
}

fn handle_message(app: &AppHandle, message: BridgeToHost) {
    match message {
        BridgeToHost::AskAris {
            path,
            start_line,
            end_line,
            text,
            language_id,
        } => {
            let (text, truncated) = truncate_utf8(&text, CODE_BRIDGE_MAX_SELECTION_BYTES);
            let _ = app.emit(
                ASK_EVENT,
                AskPayload {
                    path,
                    start_line,
                    end_line,
                    text: text.to_string(),
                    language_id,
                    truncated,
                },
            );
        }
        BridgeToHost::DocumentSaved {
            path,
            before,
            after,
        } => record_save(&path, before.as_deref(), &after),
        BridgeToHost::ActiveEditorChanged { path, is_notebook } => {
            let _ = app.emit(
                ACTIVE_EDITOR_EVENT,
                ActiveEditorPayload { path, is_notebook },
            );
        }
        // A second `Hello` on an open connection is meaningless; ignore rather
        // than re-authenticating.
        BridgeToHost::Hello { .. } => {}
        // Consumed by whoever issued the `SaveAll`; nothing to do centrally
        // yet. Kept in the protocol so the handshake is complete from day one.
        BridgeToHost::SaveAllDone { .. } => {}
    }
}

/// Record a human edit in the same ledger the AI's edit tools write to.
///
/// The point is one history, not two: a `list_file_changes` that only shows
/// what the model did is a history with the user edited out of it.
fn record_save(path: &str, before: Option<&str>, after: &str) {
    if before == Some(after) {
        return;
    }
    let operation = if before.is_some() {
        runtime::FileChangeOperation::Update
    } else {
        // A document without a disk baseline is a new file from the bridge's
        // point of view. The ledger generates an all-addition diff, which is
        // an honest representation of a file created by the user.
        runtime::FileChangeOperation::Create
    };
    let context = runtime::FileMutationContext {
        session_id: None,
        turn_id: None,
        tool_use_id: None,
        tool_name: "vscode-editor".to_string(),
    };
    let _ = runtime::record_text_file_change(
        &context,
        std::path::Path::new(path),
        operation,
        before,
        Some(after),
        Vec::new(),
        String::new(),
        None,
    );
}

/// Whether the workbench extension is currently attached.
#[tauri::command]
pub fn code_bridge_connected(state: tauri::State<'_, CodeBridgeState>) -> bool {
    state.is_connected()
}

/// Push the app's appearance into the workbench.
///
/// `colors` is resolved from the app's live stylesheet on the frontend rather
/// than rebuilt here, so the palette has exactly one definition.
#[tauri::command]
pub fn code_bridge_set_theme(
    state: tauri::State<'_, CodeBridgeState>,
    dark: bool,
    colors: Option<std::collections::BTreeMap<String, String>>,
) {
    state.send(HostToBridge::SetTheme {
        dark,
        colors: colors.unwrap_or_default(),
    });
}

/// Flush every dirty editor. Called before an AI turn touches the tree.
#[tauri::command]
pub fn code_bridge_save_all(state: tauri::State<'_, CodeBridgeState>) {
    state.send(HostToBridge::SaveAll);
}

/// Tell the workbench that `paths` changed underneath it.
#[tauri::command]
pub fn code_bridge_reload(state: tauri::State<'_, CodeBridgeState>, paths: Vec<String>) {
    state.send(HostToBridge::ReloadFromDisk { paths });
}

/// Open a file in the workbench, for chat's "click a path to open it".
#[tauri::command]
pub fn code_bridge_open_file(state: tauri::State<'_, CodeBridgeState>, path: String) {
    state.send(HostToBridge::OpenFile { path });
}

/// Open the selected Git change in VSCodium's native diff editor.
#[tauri::command]
pub fn code_bridge_open_diff(
    state: tauri::State<'_, CodeBridgeState>,
    path: String,
    staged: bool,
) -> bool {
    state.send(HostToBridge::OpenDiff { path, staged })
}

#[cfg(test)]
#[path = "tests/codebridge.rs"]
mod tests;
