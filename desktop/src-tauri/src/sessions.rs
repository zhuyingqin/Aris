//! List managed sessions and read a session transcript for the Sessions page.
//! Reuses `runtime::Session` directly (the same on-disk format aris-cli writes).

use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::ErrorKind,
    path::PathBuf,
    time::UNIX_EPOCH,
};

use runtime::{ContentBlock, MessageRole, Session};

use crate::state;

/// Legacy monolithic store. Every session lived in this one array, so opening
/// or saving any conversation had to parse the whole file. Kept only so we can
/// migrate it to the per-session layout below, then rename it to `.bak`.
const CHAT_UI_SESSIONS_FILE: &str = "chat-ui-sessions.json";
/// Per-session files (`<id>.json`) — one conversation per file, like Kimi Code.
const CHAT_UI_SESSIONS_DIR: &str = "chat-ui-sessions";
const CHAT_UI_PREVIEWS_DIR: &str = "chat-ui-session-previews";
/// Lightweight summary index that drives the sidebar list without reading turns.
const CHAT_UI_INDEX_FILE: &str = "chat-ui-index.json";
const CHAT_UI_SESSION_PREVIEW_MAX_TURNS: usize = 12;
const CHAT_UI_SESSION_PREVIEW_MAX_BYTES: usize = 180_000;
const CHAT_UI_TEXT_BLOCK_MAX_CHARS: usize = 8_000;
const CHAT_UI_THINKING_BLOCK_MAX_CHARS: usize = 6_000;
const CHAT_UI_TOOL_INPUT_MAX_CHARS: usize = 4_000;
const CHAT_UI_TOOL_OUTPUT_MAX_CHARS: usize = 8_000;
const CHAT_UI_RAW_TURN_PARSE_MAX_BYTES: usize = 256_000;

fn legacy_chat_ui_sessions_path() -> PathBuf {
    state::desktop_runtime_dir().join(CHAT_UI_SESSIONS_FILE)
}

fn chat_ui_sessions_dir() -> PathBuf {
    state::desktop_runtime_dir().join(CHAT_UI_SESSIONS_DIR)
}

fn chat_ui_previews_dir() -> PathBuf {
    state::desktop_runtime_dir().join(CHAT_UI_PREVIEWS_DIR)
}

fn chat_ui_index_path() -> PathBuf {
    state::desktop_runtime_dir().join(CHAT_UI_INDEX_FILE)
}

fn chat_ui_session_file_path(id: &str) -> PathBuf {
    chat_ui_sessions_dir().join(format!("{id}.json"))
}

fn chat_ui_preview_file_path(id: &str) -> PathBuf {
    chat_ui_previews_dir().join(format!("{id}.json"))
}

fn validate_chat_ui_session_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("invalid chat UI session id".to_string());
    }
    Ok(())
}

fn read_json_array(path: &PathBuf) -> Result<Vec<Value>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    match serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())? {
        Value::Array(entries) => Ok(entries),
        _ => Err("chat UI session store must be an array".to_string()),
    }
}

fn remove_client_chat_ui_fields(session: &mut Value) {
    if let Value::Object(object) = session {
        object.remove("turnsLoaded");
        object.remove("turnCount");
        object.remove("turnsPartial");
        object.remove("partialBaseTurnIds");
    }
}

/// Read the summary index that backs the sidebar list. One entry per started
/// session, without any turn bodies, so listing never touches conversation data.
fn read_chat_ui_index() -> Result<Vec<Value>, String> {
    ensure_chat_ui_migrated()?;
    read_json_array(&chat_ui_index_path())
}

fn write_chat_ui_index(index: Vec<Value>) -> Result<(), String> {
    let data = serde_json::to_vec(&Value::Array(index)).map_err(|e| e.to_string())?;
    runtime::write_file_atomically(&chat_ui_index_path(), data).map_err(|e| e.to_string())
}

/// Upsert a single session's summary into the index (or remove it when `entry`
/// is `None`, e.g. an empty session that should not appear in the list).
fn upsert_chat_ui_index(id: &str, entry: Option<Value>) -> Result<(), String> {
    let mut index = read_json_array(&chat_ui_index_path())?;
    index.retain(|item| chat_ui_session_id(item) != Some(id));
    if let Some(entry) = entry {
        index.push(entry);
    }
    write_chat_ui_index(index)
}

/// Read one conversation's full turns from its own file. `None` when absent.
fn read_chat_ui_session_file(id: &str) -> Result<Option<Value>, String> {
    match fs::read_to_string(chat_ui_session_file_path(id)) {
        Ok(raw) => serde_json::from_str::<Value>(&raw)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn read_chat_ui_preview_file(id: &str) -> Result<Option<Value>, String> {
    match fs::read_to_string(chat_ui_preview_file_path(id)) {
        Ok(raw) => serde_json::from_str::<Value>(&raw)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_chat_ui_preview_file(id: &str, session: &Value) -> Result<(), String> {
    let Some(turns) = session.get("turns").and_then(Value::as_array) else {
        return Ok(());
    };
    let preview = chat_ui_preview_session(session.clone(), turns, turns.len());
    fs::create_dir_all(chat_ui_previews_dir()).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec(&preview).map_err(|e| e.to_string())?;
    runtime::write_file_atomically(&chat_ui_preview_file_path(id), data).map_err(|e| e.to_string())
}

/// Persist one conversation to `<id>.json` and refresh its index summary.
/// Only this session's file is rewritten — cost is independent of history size.
fn write_chat_ui_session_file(id: &str, mut session: Value) -> Result<(), String> {
    let entry = summarize_chat_ui_session(&session);
    write_chat_ui_preview_file(id, &session)?;
    remove_client_chat_ui_fields(&mut session);
    let data = serde_json::to_vec(&session).map_err(|e| e.to_string())?;
    runtime::write_file_atomically(&chat_ui_session_file_path(id), data)
        .map_err(|e| e.to_string())?;
    upsert_chat_ui_index(id, entry)
}

/// One-time migration from the legacy monolithic file to per-session files plus
/// an index. Idempotent: the legacy file is renamed to `.bak` when done, so this
/// is a no-op on every subsequent call. The backup guarantees no data is lost.
fn ensure_chat_ui_migrated() -> Result<(), String> {
    let legacy = legacy_chat_ui_sessions_path();
    if !legacy.exists() {
        return Ok(());
    }
    let sessions = read_json_array(&legacy)?;
    fs::create_dir_all(chat_ui_sessions_dir()).map_err(|e| e.to_string())?;
    let mut index = Vec::new();
    for mut session in sessions {
        remove_client_chat_ui_fields(&mut session);
        let Some(id) = chat_ui_session_id(&session).map(str::to_string) else {
            continue;
        };
        if validate_chat_ui_session_id(&id).is_err() {
            continue;
        }
        if let Some(entry) = summarize_chat_ui_session(&session) {
            write_chat_ui_preview_file(&id, &session)?;
            let data = serde_json::to_vec(&session).map_err(|e| e.to_string())?;
            runtime::write_file_atomically(&chat_ui_session_file_path(&id), data)
                .map_err(|e| e.to_string())?;
            index.push(entry);
        }
    }
    write_chat_ui_index(index)?;
    // Rename rather than delete so a surprised user can always recover the old
    // store; the `.exists()` guard above then skips migration on future calls.
    let _ = fs::rename(&legacy, legacy.with_extension("json.bak"));
    Ok(())
}

fn chat_ui_session_id(session: &Value) -> Option<&str> {
    session.get("id").and_then(Value::as_str)
}

fn chat_ui_turn_count(session: &Value) -> usize {
    session
        .get("turns")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default()
}

fn chat_ui_turn_id(turn: &Value) -> Option<&str> {
    turn.get("id").and_then(Value::as_str)
}

fn truncate_for_chat_ui_preview(text: &str, max_chars: usize) -> (String, bool) {
    let mut iter = text.char_indices();
    let Some((cutoff, _)) = iter.nth(max_chars) else {
        return (text.to_string(), false);
    };
    let mut output = text[..cutoff].to_string();
    output.push_str("\n\n[Preview truncated. The full content remains saved on disk.]");
    (output, true)
}

fn truncate_chat_ui_turn_for_preview(turn: &Value) -> (Value, bool) {
    let mut next = turn.clone();
    let mut truncated = false;
    let Some(blocks) = next.get_mut("blocks").and_then(Value::as_array_mut) else {
        return (next, false);
    };
    for block in blocks {
        let Some(object) = block.as_object_mut() else {
            continue;
        };
        match object.get("kind").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = object.get("text").and_then(Value::as_str) {
                    let (value, was_truncated) =
                        truncate_for_chat_ui_preview(text, CHAT_UI_TEXT_BLOCK_MAX_CHARS);
                    if was_truncated {
                        object.insert("text".to_string(), Value::String(value));
                        truncated = true;
                    }
                }
            }
            Some("thinking") => {
                if let Some(text) = object.get("thinking").and_then(Value::as_str) {
                    let (value, was_truncated) =
                        truncate_for_chat_ui_preview(text, CHAT_UI_THINKING_BLOCK_MAX_CHARS);
                    if was_truncated {
                        object.insert("thinking".to_string(), Value::String(value));
                        truncated = true;
                    }
                }
            }
            Some("tool") => {
                if let Some(text) = object.get("input").and_then(Value::as_str) {
                    let (value, was_truncated) =
                        truncate_for_chat_ui_preview(text, CHAT_UI_TOOL_INPUT_MAX_CHARS);
                    if was_truncated {
                        object.insert("input".to_string(), Value::String(value));
                        truncated = true;
                    }
                }
                if let Some(text) = object.get("output").and_then(Value::as_str) {
                    let (value, was_truncated) =
                        truncate_for_chat_ui_preview(text, CHAT_UI_TOOL_OUTPUT_MAX_CHARS);
                    if was_truncated {
                        object.insert("output".to_string(), Value::String(value));
                        truncated = true;
                    }
                }
            }
            Some("notice") => {
                if let Some(text) = object.get("message").and_then(Value::as_str) {
                    let (value, was_truncated) =
                        truncate_for_chat_ui_preview(text, CHAT_UI_TEXT_BLOCK_MAX_CHARS);
                    if was_truncated {
                        object.insert("message".to_string(), Value::String(value));
                        truncated = true;
                    }
                }
            }
            _ => {}
        }
    }
    (next, truncated)
}

fn chat_ui_preview_turns(turns: &[Value]) -> (Vec<Value>, bool, Vec<String>) {
    let mut selected = Vec::new();
    let mut selected_bytes = 2;
    let mut partial = turns.len() > CHAT_UI_SESSION_PREVIEW_MAX_TURNS;
    for turn in turns.iter().rev().take(CHAT_UI_SESSION_PREVIEW_MAX_TURNS) {
        let (preview_turn, was_truncated) = truncate_chat_ui_turn_for_preview(turn);
        partial |= was_truncated;
        let turn_bytes = serde_json::to_vec(&preview_turn)
            .map(|data| data.len())
            .unwrap_or(usize::MAX / 2);
        if !selected.is_empty() && selected_bytes + turn_bytes > CHAT_UI_SESSION_PREVIEW_MAX_BYTES {
            partial = true;
            break;
        }
        selected_bytes = selected_bytes.saturating_add(turn_bytes);
        selected.push(preview_turn);
    }
    selected.reverse();
    let base_ids = selected
        .iter()
        .filter_map(chat_ui_turn_id)
        .map(str::to_string)
        .collect();
    partial |= selected.len() < turns.len();
    (selected, partial, base_ids)
}

fn chat_ui_preview_session(mut session: Value, turns: &[Value], turn_count: usize) -> Value {
    let (preview_turns, turns_partial, partial_base_turn_ids) = chat_ui_preview_turns(turns);
    if let Value::Object(object) = &mut session {
        object.insert("turns".to_string(), Value::Array(preview_turns));
        object.insert("turnsLoaded".to_string(), Value::Bool(true));
        object.insert("turnCount".to_string(), json!(turn_count));
        object.insert("turnsPartial".to_string(), Value::Bool(turns_partial));
        object.insert(
            "partialBaseTurnIds".to_string(),
            json!(partial_base_turn_ids),
        );
    }
    session
}

fn chat_ui_index_entry(id: &str) -> Result<Option<Value>, String> {
    Ok(read_json_array(&chat_ui_index_path())?
        .into_iter()
        .find(|item| chat_ui_session_id(item) == Some(id)))
}

fn large_turn_placeholder(id: &str, index: usize, bytes: usize) -> Value {
    json!({
        "id": format!("{id}-large-turn-{index}"),
        "role": "assistant",
        "blocks": [{
            "kind": "notice",
            "message": format!(
                "A large saved turn ({} KB) was omitted from the quick preview. The full content remains saved on disk.",
                bytes / 1024
            )
        }],
        "streaming": false
    })
}

fn find_turns_array_bounds(raw: &str) -> Option<(usize, usize)> {
    let bytes = raw.as_bytes();
    let mut index = 0;
    let mut object_depth = 0usize;
    let mut array_depth = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                let (value, end) = parse_json_string(raw, index)?;
                index = end;
                if object_depth == 1 && array_depth == 0 && value == "turns" {
                    let colon = skip_ws(bytes, index)?;
                    if bytes.get(colon) != Some(&b':') {
                        continue;
                    }
                    let start = skip_ws(bytes, colon + 1)?;
                    if bytes.get(start) != Some(&b'[') {
                        continue;
                    }
                    return matching_array_end(raw, start).map(|end| (start, end));
                }
            }
            b'{' => object_depth = object_depth.saturating_add(1),
            b'}' => object_depth = object_depth.saturating_sub(1),
            b'[' => array_depth = array_depth.saturating_add(1),
            b']' => array_depth = array_depth.saturating_sub(1),
            _ => {}
        }
        index += 1;
    }
    None
}

fn parse_json_string(raw: &str, start: usize) -> Option<(String, usize)> {
    let bytes = raw.as_bytes();
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    let mut index = start + 1;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'"' {
            let slice = &raw[start..=index];
            let value = serde_json::from_str::<String>(slice).ok()?;
            return Some((value, index + 1));
        }
        index += 1;
    }
    None
}

fn skip_ws(bytes: &[u8], mut index: usize) -> Option<usize> {
    while matches!(bytes.get(index), Some(b' ' | b'\n' | b'\r' | b'\t')) {
        index += 1;
    }
    (index < bytes.len()).then_some(index)
}

fn matching_array_end(raw: &str, start: usize) -> Option<usize> {
    let bytes = raw.as_bytes();
    let mut index = start;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
        } else {
            match byte {
                b'"' => in_string = true,
                b'[' => depth = depth.saturating_add(1),
                b']' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return Some(index);
                    }
                }
                _ => {}
            }
        }
        index += 1;
    }
    None
}

fn tail_turns_from_array(
    raw: &str,
    array_start: usize,
    array_end: usize,
    id: &str,
) -> (usize, Vec<Value>) {
    let bytes = raw.as_bytes();
    let mut index = array_start + 1;
    let mut object_depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut turn_start = None;
    let mut turn_count = 0usize;
    let mut tail: VecDeque<Value> = VecDeque::new();

    while index < array_end {
        let byte = bytes[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }

        match byte {
            b'"' => in_string = true,
            b'{' => {
                if object_depth == 0 {
                    turn_start = Some(index);
                }
                object_depth = object_depth.saturating_add(1);
            }
            b'}' => {
                object_depth = object_depth.saturating_sub(1);
                if object_depth == 0 {
                    if let Some(start) = turn_start.take() {
                        let end = index + 1;
                        let bytes = end.saturating_sub(start);
                        let value = if bytes > CHAT_UI_RAW_TURN_PARSE_MAX_BYTES {
                            large_turn_placeholder(id, turn_count, bytes)
                        } else {
                            serde_json::from_str::<Value>(&raw[start..end])
                                .unwrap_or_else(|_| large_turn_placeholder(id, turn_count, bytes))
                        };
                        turn_count += 1;
                        tail.push_back(value);
                        while tail.len() > CHAT_UI_SESSION_PREVIEW_MAX_TURNS {
                            tail.pop_front();
                        }
                    }
                }
            }
            _ => {}
        }
        index += 1;
    }

    (turn_count, tail.into_iter().collect())
}

fn read_chat_ui_session_fast_preview(id: &str) -> Result<Option<Value>, String> {
    let raw = match fs::read_to_string(chat_ui_session_file_path(id)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let Some((array_start, array_end)) = find_turns_array_bounds(&raw) else {
        return Ok(None);
    };
    let (turn_count, tail_turns) = tail_turns_from_array(&raw, array_start, array_end, id);
    let Some(base) = chat_ui_index_entry(id)? else {
        return Ok(None);
    };
    let preview = chat_ui_preview_session(base, &tail_turns, turn_count);
    fs::create_dir_all(chat_ui_previews_dir()).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec(&preview).map_err(|e| e.to_string())?;
    runtime::write_file_atomically(&chat_ui_preview_file_path(id), data)
        .map_err(|e| e.to_string())?;
    Ok(Some(preview))
}

fn merge_partial_chat_ui_turns(next: &mut Value, stored: &Value) {
    let Some(existing_turns) = stored.get("turns").and_then(Value::as_array) else {
        return;
    };
    let incoming_turns = next
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let base_ids: HashSet<String> = next
        .get("partialBaseTurnIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let mut merged = existing_turns.clone();
    for incoming in incoming_turns {
        let Some(id) = chat_ui_turn_id(&incoming).map(str::to_string) else {
            continue;
        };
        if base_ids.contains(&id) {
            continue;
        }
        if let Some(existing) = merged
            .iter_mut()
            .find(|turn| chat_ui_turn_id(turn) == Some(id.as_str()))
        {
            *existing = incoming;
        } else {
            merged.push(incoming);
        }
    }
    if let Value::Object(object) = next {
        object.insert("turns".to_string(), Value::Array(merged));
    }
}

fn object_value_or(object: &serde_json::Map<String, Value>, key: &str, fallback: Value) -> Value {
    object.get(key).cloned().unwrap_or(fallback)
}

fn summarize_chat_ui_session(session: &Value) -> Option<Value> {
    let object = session.as_object()?;
    let id = object.get("id")?.as_str()?;
    validate_chat_ui_session_id(id).ok()?;
    let turn_count = chat_ui_turn_count(session);
    if turn_count == 0 {
        return None;
    }
    Some(json!({
        "id": id,
        "projectId": object_value_or(object, "projectId", json!("default")),
        "title": object_value_or(object, "title", json!("New chat")),
        "model": object_value_or(object, "model", Value::Null),
        "turns": [],
        "turnsLoaded": false,
        "turnCount": turn_count,
        "draft": object_value_or(object, "draft", json!("")),
        "draftAttachments": object_value_or(object, "draftAttachments", json!([])),
        "pinned": object_value_or(object, "pinned", json!(false)),
        "createdAt": object_value_or(object, "createdAt", json!(0)),
        "updatedAt": object_value_or(object, "updatedAt", json!(0)),
    }))
}

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
    // Full export path (backup/tests): reassemble every conversation from its
    // own file. Not on the hot path — the UI uses the index + lazy load instead.
    read_chat_ui_index()?;
    let mut sessions = Vec::new();
    if let Ok(entries) = fs::read_dir(chat_ui_sessions_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if let Some(session) = read_chat_ui_session_file(id)? {
                sessions.push(session);
            }
        }
    }
    Ok(Value::Array(sessions))
}

#[tauri::command]
pub fn chat_ui_sessions_list() -> Result<Value, String> {
    // Reads only the summary index — no turn bodies are touched, so the sidebar
    // list stays fast regardless of how large the conversation history grows.
    Ok(Value::Array(read_chat_ui_index()?))
}

#[tauri::command]
pub fn chat_ui_session_load(id: String) -> Result<Value, String> {
    validate_chat_ui_session_id(&id)?;
    ensure_chat_ui_migrated()?;
    if let Some(preview) = read_chat_ui_preview_file(&id)? {
        return Ok(preview);
    }
    if let Some(preview) = read_chat_ui_session_fast_preview(&id)? {
        return Ok(preview);
    }
    let session =
        read_chat_ui_session_file(&id)?.ok_or_else(|| "chat UI session not found".to_string())?;
    let Some(turns) = session.get("turns").and_then(Value::as_array) else {
        return Ok(session);
    };
    let preview = chat_ui_preview_session(session.clone(), turns, turns.len());
    fs::create_dir_all(chat_ui_previews_dir()).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec(&preview).map_err(|e| e.to_string())?;
    runtime::write_file_atomically(&chat_ui_preview_file_path(&id), data)
        .map_err(|e| e.to_string())?;
    Ok(preview)
}

#[tauri::command]
pub fn chat_ui_session_save(session: Value) -> Result<(), String> {
    let id = chat_ui_session_id(&session)
        .ok_or_else(|| "chat UI session must include an id".to_string())?
        .to_string();
    validate_chat_ui_session_id(&id)?;
    if !session.is_object() {
        return Err("chat UI session must be an object".to_string());
    }
    ensure_chat_ui_migrated()?;

    let incoming_is_loaded = session
        .get("turnsLoaded")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let incoming_is_partial = session
        .get("turnsPartial")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let incoming_turns_empty = session
        .get("turns")
        .and_then(Value::as_array)
        .map(Vec::is_empty)
        .unwrap_or(true);
    let mut next = session;

    // Merge against only this session's stored turns — the summary-only save
    // (turnsLoaded=false) preserves the full transcript, and a partial save
    // (recent turns only) merges into the existing tail.
    if let Some(stored) = read_chat_ui_session_file(&id)? {
        if !incoming_is_loaded && incoming_turns_empty {
            if let (Value::Object(next_object), Some(turns)) =
                (&mut next, stored.get("turns").cloned())
            {
                next_object.insert("turns".to_string(), turns);
            }
        } else if incoming_is_partial {
            merge_partial_chat_ui_turns(&mut next, &stored);
        }
    }

    write_chat_ui_session_file(&id, next)
}

#[tauri::command]
pub fn chat_ui_session_delete(id: String) -> Result<(), String> {
    validate_chat_ui_session_id(&id)?;
    ensure_chat_ui_migrated()?;
    match fs::remove_file(chat_ui_session_file_path(&id)) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    match fs::remove_file(chat_ui_preview_file_path(&id)) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    upsert_chat_ui_index(&id, None)
}

#[tauri::command]
pub fn chat_ui_sessions_save(sessions: Value) -> Result<(), String> {
    // Bulk replace of the whole store (localStorage → disk migration path).
    // Rewrite every session file and rebuild the index from scratch.
    let Value::Array(entries) = sessions else {
        return Err("chat UI session store must be an array".to_string());
    };
    ensure_chat_ui_migrated()?;
    fs::create_dir_all(chat_ui_sessions_dir()).map_err(|e| e.to_string())?;

    let mut keep: HashSet<String> = HashSet::new();
    let mut index = Vec::new();
    for mut session in entries {
        let Some(id) = chat_ui_session_id(&session).map(str::to_string) else {
            continue;
        };
        if validate_chat_ui_session_id(&id).is_err() {
            continue;
        }
        let entry = summarize_chat_ui_session(&session);
        write_chat_ui_preview_file(&id, &session)?;
        remove_client_chat_ui_fields(&mut session);
        let data = serde_json::to_vec(&session).map_err(|e| e.to_string())?;
        runtime::write_file_atomically(&chat_ui_session_file_path(&id), data)
            .map_err(|e| e.to_string())?;
        keep.insert(id);
        if let Some(entry) = entry {
            index.push(entry);
        }
    }

    // Drop any stale per-session files no longer present in the incoming set.
    if let Ok(existing) = fs::read_dir(chat_ui_sessions_dir()) {
        for entry in existing.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if !keep.contains(stem) {
                    let _ = fs::remove_file(&path);
                    let _ = fs::remove_file(chat_ui_preview_file_path(stem));
                }
            }
        }
    }

    write_chat_ui_index(index)
}

#[cfg(test)]
mod tests {
    use super::{
        chat_ui_preview_turns, find_turns_array_bounds, tail_turns_from_array,
        CHAT_UI_RAW_TURN_PARSE_MAX_BYTES, CHAT_UI_SESSION_PREVIEW_MAX_BYTES,
        CHAT_UI_SESSION_PREVIEW_MAX_TURNS,
    };
    use serde_json::{json, Value};

    fn text_turn(index: usize, text: impl Into<String>) -> Value {
        json!({
            "id": format!("turn-{index}"),
            "role": if index % 2 == 0 { "user" } else { "assistant" },
            "blocks": [{ "kind": "text", "text": text.into() }],
        })
    }

    #[test]
    fn chat_ui_preview_limits_tail_turns_and_bytes() {
        let turns = (0..40)
            .map(|index| text_turn(index, "x".repeat(30_000)))
            .collect::<Vec<_>>();
        let (preview, partial, base_ids) = chat_ui_preview_turns(&turns);

        assert!(partial);
        assert!(preview.len() <= CHAT_UI_SESSION_PREVIEW_MAX_TURNS);
        assert!(serde_json::to_vec(&preview).unwrap().len() <= CHAT_UI_SESSION_PREVIEW_MAX_BYTES);
        assert_eq!(base_ids.last().map(String::as_str), Some("turn-39"));
        assert!(!base_ids.iter().any(|id| id == "turn-0"));
    }

    #[test]
    fn fast_tail_loader_omits_single_huge_turn_payload() {
        let huge = "x".repeat(CHAT_UI_RAW_TURN_PARSE_MAX_BYTES + 16_000);
        let raw = serde_json::to_string(&json!({
            "id": "chat-large",
            "turns": [
                text_turn(0, "small"),
                text_turn(1, huge),
            ],
        }))
        .unwrap();
        let (start, end) = find_turns_array_bounds(&raw).expect("turns array");
        let (count, tail) = tail_turns_from_array(&raw, start, end, "chat-large");

        assert_eq!(count, 2);
        assert_eq!(tail.len(), 2);
        let last_message = tail[1]["blocks"][0]["message"].as_str().unwrap();
        assert!(last_message.contains("omitted from the quick preview"));
    }
}
