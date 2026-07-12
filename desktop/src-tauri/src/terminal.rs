//! Integrated terminal for the Code page: one PTY-backed shell per terminal id.
//!
//! `portable-pty` gives us a real pseudo-terminal (ConPTY on Windows), so full
//! curses/REPL programs work. Each open terminal owns a reader thread that
//! streams output to the UI as base64 `terminal-output` events; the UI writes
//! keystrokes back through `terminal_write`. The session (master + writer +
//! child) lives in `TerminalState` so resize/write/close can reach it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

const TERMINAL_OUTPUT_EVENT: &str = "terminal-output";
const TERMINAL_EXIT_EVENT: &str = "terminal-exit";
const READ_BUF_BYTES: usize = 8192;

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// App-managed registry of live terminals, keyed by the UI's terminal id.
#[derive(Default)]
pub struct TerminalState(Mutex<HashMap<String, TerminalSession>>);

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        // Guard against a zero size from an unmeasured xterm (would error on some
        // platforms); fall back to a sane 80x24.
        rows: if rows == 0 { 24 } else { rows },
        cols: if cols == 0 { 80 } else { cols },
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// The shell to launch: `SOMNIQ_TERMINAL_SHELL` overrides; otherwise PowerShell
/// on Windows and `$SHELL` (or `/bin/bash`) elsewhere.
fn shell_command() -> CommandBuilder {
    let shell = std::env::var("SOMNIQ_TERMINAL_SHELL").unwrap_or_else(|_| {
        if cfg!(windows) {
            "powershell.exe".to_string()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
        }
    });
    CommandBuilder::new(shell)
}

/// Open a PTY-backed shell for `id`. Idempotent per id: a second open for a live
/// id is a no-op so a re-render never spawns a duplicate shell.
#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<TerminalState>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if state.0.lock().unwrap().contains_key(&id) {
        return Ok(());
    }

    let pair = native_pty_system()
        .openpty(pty_size(cols, rows))
        .map_err(|e| e.to_string())?;

    let mut cmd = shell_command();
    cmd.env("TERM", "xterm-256color");
    if let Some(dir) = cwd.filter(|c| !c.is_empty()) {
        cmd.cwd(dir);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave handle is only needed to spawn; dropping it lets the child own
    // the terminal so EOF is reported cleanly when the shell exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let emit_app = app.clone();
    let emit_id = id.clone();
    std::thread::Builder::new()
        .name(format!("somniq-term-{id}"))
        .spawn(move || {
            let mut buf = [0u8; READ_BUF_BYTES];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = emit_app
                            .emit(TERMINAL_OUTPUT_EVENT, json!({ "id": emit_id, "data": data }));
                    }
                }
            }
            let _ = emit_app.emit(TERMINAL_EXIT_EVENT, json!({ "id": emit_id }));
        })
        .map_err(|e| e.to_string())?;

    state.0.lock().unwrap().insert(
        id,
        TerminalSession {
            master: pair.master,
            writer,
            child,
        },
    );
    Ok(())
}

/// Forward user keystrokes (UTF-8) to the shell's stdin.
#[tauri::command]
pub fn terminal_write(state: State<TerminalState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    let session = map.get_mut(&id).ok_or("terminal is not open")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

/// Resize the PTY when the xterm viewport changes.
#[tauri::command]
pub fn terminal_resize(
    state: State<TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.0.lock().unwrap();
    let session = map.get(&id).ok_or("terminal is not open")?;
    session
        .master
        .resize(pty_size(cols, rows))
        .map_err(|e| e.to_string())
}

/// Kill the shell and forget the terminal. No-op if already gone.
#[tauri::command]
pub fn terminal_close(state: State<TerminalState>, id: String) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().unwrap().remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}
