//! List managed sessions and read a session transcript for the Sessions page.
//! Reuses `runtime::Session` directly (the same on-disk format aris-cli writes).

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use runtime::{ContentBlock, MessageRole, Session};

use crate::state;

const CHAT_UI_SESSIONS_FILE: &str = "chat-ui-sessions.json";

/// Per-write counter so concurrent saves never share a temp file name.
static SESSIONS_TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub message_count: usize,
    pub modified_epoch_secs: u64,
}

#[tauri::command]
pub fn sessions_list() -> Vec<SessionSummary> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(state::sessions_dir()) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        // skip timeline artifacts and temp files; only top-level session JSON
        if !name.ends_with(".json")
            || name.ends_with(".timeline.json")
            || name.ends_with(".json.tmp")
            || name == CHAT_UI_SESSIONS_FILE
        {
            continue;
        }
        let modified_epoch_secs = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or_default();
        let message_count = Session::load_from_path(&path)
            .map(|s| s.messages.len())
            .unwrap_or_default();
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("session")
            .to_string();
        out.push(SessionSummary {
            id,
            message_count,
            modified_epoch_secs,
        });
    }
    out.sort_by(|a, b| b.modified_epoch_secs.cmp(&a.modified_epoch_secs));
    out
}

fn block_to_json(block: &ContentBlock) -> Value {
    match block {
        ContentBlock::Text { text } => json!({ "kind": "text", "text": text }),
        ContentBlock::Image { media_type, data } => json!({
            "kind": "image",
            "mediaType": media_type,
            "bytes": data.len(),
        }),
        ContentBlock::ToolUse { name, input, .. } => {
            json!({ "kind": "toolUse", "name": name, "input": input })
        }
        ContentBlock::ToolResult {
            tool_name,
            output,
            is_error,
            ..
        } => json!({
            "kind": "toolResult",
            "toolName": tool_name,
            "output": output,
            "isError": is_error,
        }),
        ContentBlock::Thinking { thinking, .. } => {
            json!({ "kind": "thinking", "thinking": thinking })
        }
    }
}

#[tauri::command]
pub fn session_get(id: String) -> Result<Value, String> {
    // Defensive: ids come from sessions_list, but never let one walk the FS.
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("invalid session id".to_string());
    }
    let path = state::sessions_dir().join(format!("{id}.json"));
    let session = Session::load_from_path(&path).map_err(|e| e.to_string())?;
    let messages: Vec<Value> = session
        .messages
        .iter()
        .map(|message| {
            let role = match message.role {
                MessageRole::System => "system",
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
                MessageRole::Tool => "tool",
            };
            let blocks: Vec<Value> = message.blocks.iter().map(block_to_json).collect();
            json!({ "role": role, "blocks": blocks })
        })
        .collect();
    Ok(json!({ "id": id, "messages": messages }))
}

#[tauri::command]
pub fn chat_ui_sessions_load() -> Result<Value, String> {
    let path = state::runtime_dir().join(CHAT_UI_SESSIONS_FILE);
    if !path.exists() {
        return Ok(Value::Array(Vec::new()));
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if !value.is_array() {
        return Err("chat UI session store must be an array".to_string());
    }
    Ok(value)
}

#[tauri::command]
pub fn chat_ui_sessions_save(sessions: Value) -> Result<(), String> {
    if !sessions.is_array() {
        return Err("chat UI session store must be an array".to_string());
    }
    let path = state::runtime_dir().join(CHAT_UI_SESSIONS_FILE);
    let data = serde_json::to_vec_pretty(&sessions).map_err(|e| e.to_string())?;
    // Unique temp name (pid + counter) so two concurrent saves don't write to a
    // shared `.tmp` and clobber each other.
    let counter = SESSIONS_TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("{}.{counter}.tmp", std::process::id()));
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    // `fs::rename` replaces an existing file atomically on both Unix and Windows;
    // removing the destination first would open a crash window where neither the
    // old nor the new file exists.
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}
