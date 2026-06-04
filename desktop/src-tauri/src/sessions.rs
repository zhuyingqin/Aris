//! List managed sessions and read a session transcript for the Sessions page.
//! Reuses `runtime::Session` directly (the same on-disk format aris-cli writes).

use serde::Serialize;
use serde_json::{json, Value};
use std::time::UNIX_EPOCH;

use runtime::{ContentBlock, MessageRole, Session};

use crate::state;

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
