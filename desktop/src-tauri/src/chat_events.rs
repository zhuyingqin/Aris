use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use runtime::{
    ContentBlock, ConversationMessage, MessageRole, Session, SessionCompactionRecord, TokenUsage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, State};

use crate::engine::ChatState;

const EVENT_VERSION: u32 = 1;

static EVENT_SEQS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEventLogEntry {
    pub version: u32,
    pub seq: u64,
    pub ts: u64,
    pub session_id: String,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEventsReplay {
    pub session_id: String,
    pub event_count: usize,
    pub last_seq: u64,
    pub turns: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEventsRestoreResult {
    pub session_id: String,
    pub event_count: usize,
    pub last_seq: u64,
    pub message_count: usize,
    pub restored_path: String,
}

fn event_seqs() -> &'static Mutex<HashMap<String, u64>> {
    EVENT_SEQS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return Err("invalid chat session id".to_string());
    }
    Ok(())
}

pub fn chat_event_log_path(session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(crate::state::sessions_dir().join(format!("{session_id}.events.jsonl")))
}

pub fn chat_event_log_exists(session_id: &str) -> bool {
    chat_event_log_path(session_id).is_ok_and(|path| path.exists())
}

fn read_last_seq(path: &Path) -> Result<u64, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    let mut last = 0;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let entry: ChatEventLogEntry =
            serde_json::from_str(&line).map_err(|error| error.to_string())?;
        last = last.max(entry.seq);
    }
    Ok(last)
}

pub fn append_event(
    session_id: &str,
    kind: impl Into<String>,
    payload: Value,
) -> Result<ChatEventLogEntry, String> {
    validate_session_id(session_id)?;
    let path = chat_event_log_path(session_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut seqs = event_seqs()
        .lock()
        .map_err(|_| "chat event state poisoned".to_string())?;
    let last = match seqs.get(session_id).copied() {
        Some(seq) => seq,
        None => {
            let seq = read_last_seq(&path)?;
            seqs.insert(session_id.to_string(), seq);
            seq
        }
    };
    let entry = ChatEventLogEntry {
        version: EVENT_VERSION,
        seq: last.saturating_add(1),
        ts: now_millis(),
        session_id: session_id.to_string(),
        kind: kind.into(),
        payload,
    };
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut file, &entry).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())?;
    seqs.insert(session_id.to_string(), entry.seq);
    Ok(entry)
}

pub fn record_event(session_id: &str, kind: &str, payload: Value) {
    if let Err(error) = append_event(session_id, kind, payload) {
        eprintln!("SomniQ desktop: failed to write chat event log: {error}");
    }
}

pub fn emit_chat_event(
    app: &AppHandle,
    event_name: &str,
    session_id: &str,
    kind: &str,
    payload: Value,
) {
    record_event(session_id, kind, payload.clone());
    let _ = app.emit(event_name, payload);
}

pub fn session_to_value(session: &Session) -> Result<Value, String> {
    serde_json::from_str(&session.to_json().render()).map_err(|error| error.to_string())
}

pub fn conversation_message_to_value(message: &ConversationMessage) -> Result<Value, String> {
    serde_json::from_str(&message.to_json().render()).map_err(|error| error.to_string())
}

pub fn token_usage_to_value(usage: TokenUsage) -> Value {
    json!({
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "cacheCreationInputTokens": usage.cache_creation_input_tokens,
        "cacheReadInputTokens": usage.cache_read_input_tokens,
        "promptTokens": usage.prompt_tokens(),
        "totalTokens": usage.total_tokens(),
    })
}

pub fn token_usages_to_value(usages: &[TokenUsage]) -> Value {
    Value::Array(usages.iter().copied().map(token_usage_to_value).collect())
}

pub fn record_user_message(session_id: &str, surface: &str, message: &ConversationMessage) {
    let payload = json!({
        "surface": surface,
        "message": conversation_message_to_value(message).unwrap_or(Value::Null),
    });
    record_event(session_id, "user_message", payload);
}

pub fn record_session_snapshot(session_id: &str, reason: &str, session: &Session) {
    let payload = json!({
        "reason": reason,
        "messageCount": session.messages.len(),
        "session": session_to_value(session).unwrap_or(Value::Null),
    });
    record_event(session_id, "session_snapshot", payload);
}

pub fn read_events_for_session(session_id: &str) -> Result<Vec<ChatEventLogEntry>, String> {
    let path = chat_event_log_path(session_id)?;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut out = Vec::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let entry: ChatEventLogEntry = serde_json::from_str(&line)
            .map_err(|error| format!("invalid chat event at line {}: {error}", index + 1))?;
        if entry.session_id == session_id {
            out.push(entry);
        }
    }
    Ok(out)
}

pub fn export_events_to_path(session_id: &str, target: &Path) -> Result<(), String> {
    let source = chat_event_log_path(session_id)?;
    if !source.exists() {
        return Err("chat event log not found".to_string());
    }
    let data = fs::read(source).map_err(|error| error.to_string())?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    runtime::write_file_atomically(target, data).map_err(|error| error.to_string())
}

fn default_export_path(session_id: &str) -> PathBuf {
    crate::state::runtime_dir().join(format!("chat-events-{session_id}-{}.jsonl", now_millis()))
}

fn resolve_export_path(
    session_id: &str,
    requested_path: Option<String>,
) -> Result<PathBuf, String> {
    let Some(raw) = requested_path else {
        return Ok(default_export_path(session_id));
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(default_export_path(session_id));
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(crate::state::runtime_dir().join(path))
    }
}

#[tauri::command]
pub fn chat_events_read(session_id: String) -> Result<Vec<ChatEventLogEntry>, String> {
    read_events_for_session(&session_id)
}

#[tauri::command]
pub fn chat_events_export(session_id: String, path: Option<String>) -> Result<String, String> {
    let target = resolve_export_path(&session_id, path)?;
    export_events_to_path(&session_id, &target)?;
    Ok(target.display().to_string())
}

#[tauri::command]
pub fn chat_events_replay(session_id: String) -> Result<ChatEventsReplay, String> {
    let events = read_events_for_session(&session_id)?;
    Ok(replay_events(&session_id, &events))
}

#[tauri::command]
pub fn chat_events_restore(
    state: State<ChatState>,
    session_id: String,
) -> Result<ChatEventsRestoreResult, String> {
    let events = read_events_for_session(&session_id)?;
    let last_seq = events.last().map(|event| event.seq).unwrap_or_default();
    let session = session_from_events(&events)?;
    let message_count = session.messages.len();
    crate::engine::store_chat_session(&state, session_id.clone(), session)?;
    let restored_path = crate::state::sessions_dir()
        .join(format!("{session_id}.json"))
        .display()
        .to_string();
    Ok(ChatEventsRestoreResult {
        session_id,
        event_count: events.len(),
        last_seq,
        message_count,
        restored_path,
    })
}

fn replay_events(session_id: &str, events: &[ChatEventLogEntry]) -> ChatEventsReplay {
    let mut turns = Vec::new();
    for event in events {
        match event.kind.as_str() {
            "reset" => turns.clear(),
            "user_message" => {
                turns.push(json!({
                    "id": format!("event-{}-user", event.seq),
                    "role": "user",
                    "blocks": user_blocks_from_payload(&event.payload),
                    "streaming": false,
                }));
            }
            "assistant_delta" => {
                let text = event
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let blocks = ensure_assistant_turn(&mut turns, event.seq);
                append_delta_block(blocks, "text", "text", text);
            }
            "assistant_thinking_delta" => {
                let thinking = event
                    .payload
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let blocks = ensure_assistant_turn(&mut turns, event.seq);
                append_delta_block(blocks, "thinking", "thinking", thinking);
            }
            "tool_call" => {
                let blocks = ensure_assistant_turn(&mut turns, event.seq);
                upsert_tool_call(blocks, &event.payload);
            }
            "tool_progress" => {
                let blocks = ensure_assistant_turn(&mut turns, event.seq);
                update_tool_progress(blocks, &event.payload);
            }
            "tool_result" => {
                let blocks = ensure_assistant_turn(&mut turns, event.seq);
                append_tool_result(blocks, &event.payload);
            }
            "approval_request" => {
                let blocks = ensure_assistant_turn(&mut turns, event.seq);
                append_permission_block(blocks, &event.payload);
            }
            "approval_resolved" => {
                let blocks = ensure_assistant_turn(&mut turns, event.seq);
                update_permission_block(blocks, &event.payload);
            }
            "context_warning" => {
                let blocks = ensure_assistant_turn(&mut turns, event.seq);
                blocks.push(json!({
                    "kind": "notice",
                    "message": "Context is approaching the compaction budget.",
                }));
            }
            "context_compacted" => {
                let removed = event
                    .payload
                    .get("removedMessageCount")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let blocks = ensure_assistant_turn(&mut turns, event.seq);
                blocks.push(json!({
                    "kind": "notice",
                    "message": format!("Context compacted; removed {removed} messages."),
                }));
            }
            "error" => {
                let message = event
                    .payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let turn = ensure_assistant_turn_value(&mut turns, event.seq);
                if let Some(object) = turn.as_object_mut() {
                    object.insert("error".to_string(), Value::String(message));
                    object.insert("streaming".to_string(), Value::Bool(false));
                }
            }
            "done" => {
                let turn = ensure_assistant_turn_value(&mut turns, event.seq);
                if let Some(object) = turn.as_object_mut() {
                    object.insert("streaming".to_string(), Value::Bool(false));
                }
            }
            _ => {}
        }
    }
    ChatEventsReplay {
        session_id: session_id.to_string(),
        event_count: events.len(),
        last_seq: events.last().map(|event| event.seq).unwrap_or_default(),
        turns,
    }
}

fn user_blocks_from_payload(payload: &Value) -> Vec<Value> {
    let Some(message) = payload.get("message") else {
        return Vec::new();
    };
    let Some(blocks) = message.get("blocks").and_then(Value::as_array) else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter_map(|block| match block.get("type").and_then(Value::as_str) {
            Some("text") => Some(json!({
                "kind": "text",
                "text": block.get("text").and_then(Value::as_str).unwrap_or_default(),
            })),
            Some("image") => Some(json!({
                "kind": "notice",
                "message": format!(
                    "[Image: {}]",
                    block
                        .get("media_type")
                        .and_then(Value::as_str)
                        .unwrap_or("image")
                ),
            })),
            _ => None,
        })
        .collect()
}

fn ensure_assistant_turn_value(turns: &mut Vec<Value>, seq: u64) -> &mut Value {
    let needs_new = turns
        .last()
        .and_then(Value::as_object)
        .and_then(|object| object.get("role"))
        .and_then(Value::as_str)
        != Some("assistant");
    if needs_new {
        turns.push(json!({
            "id": format!("event-{seq}-assistant"),
            "role": "assistant",
            "blocks": [],
            "streaming": true,
        }));
    }
    turns.last_mut().expect("assistant turn exists")
}

fn ensure_assistant_turn(turns: &mut Vec<Value>, seq: u64) -> &mut Vec<Value> {
    let turn = ensure_assistant_turn_value(turns, seq);
    let object = turn.as_object_mut().expect("assistant turn is object");
    object
        .entry("blocks")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .expect("assistant blocks is array")
}

fn append_delta_block(blocks: &mut Vec<Value>, kind: &str, field: &str, delta: &str) {
    if delta.is_empty() {
        return;
    }
    if let Some(object) = blocks
        .last_mut()
        .and_then(Value::as_object_mut)
        .filter(|object| object.get("kind").and_then(Value::as_str) == Some(kind))
    {
        let existing = object
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or_default();
        object.insert(
            field.to_string(),
            Value::String(format!("{existing}{delta}")),
        );
        return;
    }
    blocks.push(json!({ "kind": kind, field: delta }));
}

fn payload_str<'a>(payload: &'a Value, key: &str) -> &'a str {
    payload.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn find_tool_block_mut<'a>(blocks: &'a mut [Value], id: &str, name: &str) -> Option<&'a mut Value> {
    blocks.iter_mut().find(|block| {
        let Some(object) = block.as_object() else {
            return false;
        };
        if object.get("kind").and_then(Value::as_str) != Some("tool") {
            return false;
        }
        let block_id = object.get("id").and_then(Value::as_str).unwrap_or_default();
        let block_name = object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        (!id.is_empty() && block_id == id) || (id.is_empty() && block_name == name)
    })
}

fn upsert_tool_call(blocks: &mut Vec<Value>, payload: &Value) {
    let id = payload_str(payload, "id");
    let name = payload_str(payload, "name");
    let input = payload_str(payload, "input");
    if let Some(block) = find_tool_block_mut(blocks, id, name) {
        if let Some(object) = block.as_object_mut() {
            object.insert("input".to_string(), Value::String(input.to_string()));
        }
        return;
    }
    blocks.push(json!({
        "kind": "tool",
        "id": if id.is_empty() { Value::Null } else { Value::String(id.to_string()) },
        "name": name,
        "input": input,
    }));
}

fn update_tool_progress(blocks: &mut Vec<Value>, payload: &Value) {
    let id = payload_str(payload, "id");
    let name = payload_str(payload, "name");
    if find_tool_block_mut(blocks, id, name).is_none() {
        upsert_tool_call(blocks, payload);
    }
    if let Some(block) = find_tool_block_mut(blocks, id, name) {
        if let Some(object) = block.as_object_mut() {
            object.insert("progress".to_string(), payload.clone());
        }
    }
}

fn append_tool_result(blocks: &mut Vec<Value>, payload: &Value) {
    let id = payload_str(payload, "id");
    let name = payload_str(payload, "name");
    if find_tool_block_mut(blocks, id, name).is_none() {
        upsert_tool_call(blocks, payload);
    }
    if let Some(block) = find_tool_block_mut(blocks, id, name) {
        if let Some(object) = block.as_object_mut() {
            object.insert(
                "output".to_string(),
                Value::String(payload_str(payload, "output").to_string()),
            );
            object.insert(
                "isError".to_string(),
                Value::Bool(
                    payload
                        .get("isError")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                ),
            );
            object.remove("progress");
        }
    }
}

fn append_permission_block(blocks: &mut Vec<Value>, payload: &Value) {
    let prompt_id = payload_str(payload, "promptId");
    if blocks.iter().any(|block| {
        block.get("kind").and_then(Value::as_str) == Some("permission")
            && block.get("id").and_then(Value::as_str) == Some(prompt_id)
    }) {
        return;
    }
    blocks.push(json!({
        "kind": "permission",
        "id": prompt_id,
        "toolName": payload_str(payload, "toolName"),
        "input": payload_str(payload, "input"),
        "currentMode": payload_str(payload, "currentMode"),
        "requiredMode": payload_str(payload, "requiredMode"),
        "status": "pending",
    }));
}

fn update_permission_block(blocks: &mut [Value], payload: &Value) {
    let prompt_id = payload_str(payload, "promptId");
    let status = if payload.get("decision").and_then(Value::as_str) == Some("allow") {
        "allowed"
    } else {
        "skipped"
    };
    for block in blocks {
        let Some(object) = block.as_object_mut() else {
            continue;
        };
        if object.get("kind").and_then(Value::as_str) == Some("permission")
            && object.get("id").and_then(Value::as_str) == Some(prompt_id)
        {
            object.insert("status".to_string(), Value::String(status.to_string()));
        }
    }
}

fn session_from_events(events: &[ChatEventLogEntry]) -> Result<Session, String> {
    let mut session = Session::new();
    for event in events {
        match event.kind.as_str() {
            "reset" => session = Session::new(),
            "session_snapshot" => {
                if let Some(value) = event.payload.get("session") {
                    session = session_from_value(value)?;
                }
            }
            "user_message" => {
                if let Some(value) = event.payload.get("message") {
                    session.messages.push(message_from_value(value)?);
                }
            }
            "assistant_delta" => {
                let text = payload_str(&event.payload, "text");
                if !text.is_empty() {
                    append_assistant_text(&mut session, text);
                }
            }
            "assistant_thinking_delta" => {
                let thinking = payload_str(&event.payload, "thinking");
                if !thinking.is_empty() {
                    append_assistant_thinking(&mut session, thinking);
                }
            }
            "tool_call" => {
                let id = payload_str(&event.payload, "id");
                let name = payload_str(&event.payload, "name");
                if !name.is_empty() {
                    ensure_assistant_message(&mut session)
                        .blocks
                        .push(ContentBlock::ToolUse {
                            id: id.to_string(),
                            name: name.to_string(),
                            input: payload_str(&event.payload, "input").to_string(),
                        });
                }
            }
            "tool_result" => {
                let name = payload_str(&event.payload, "name");
                if !name.is_empty() {
                    session.messages.push(ConversationMessage::tool_result(
                        payload_str(&event.payload, "id"),
                        name,
                        payload_str(&event.payload, "output"),
                        event
                            .payload
                            .get("isError")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    ));
                }
            }
            "usage" => {
                if let Some(usage) = latest_usage_from_payload(&event.payload) {
                    if let Some(message) = session
                        .messages
                        .iter_mut()
                        .rev()
                        .find(|message| message.role == MessageRole::Assistant)
                    {
                        message.usage = Some(usage);
                    }
                }
            }
            "done" => {
                let text = payload_str(&event.payload, "text");
                let has_current_assistant = session
                    .messages
                    .last()
                    .is_some_and(|message| message.role == MessageRole::Assistant);
                if !text.is_empty() && !has_current_assistant {
                    session.messages.push(ConversationMessage::assistant(vec![
                        ContentBlock::Text {
                            text: text.to_string(),
                        },
                    ]));
                }
            }
            _ => {}
        }
    }
    Ok(session)
}

fn ensure_assistant_message(session: &mut Session) -> &mut ConversationMessage {
    let needs_new = session
        .messages
        .last()
        .is_none_or(|message| message.role != MessageRole::Assistant);
    if needs_new {
        session
            .messages
            .push(ConversationMessage::assistant(Vec::new()));
    }
    session.messages.last_mut().expect("assistant exists")
}

fn append_assistant_text(session: &mut Session, text: &str) {
    let message = ensure_assistant_message(session);
    if let Some(ContentBlock::Text { text: existing }) = message.blocks.last_mut() {
        existing.push_str(text);
    } else {
        message.blocks.push(ContentBlock::Text {
            text: text.to_string(),
        });
    }
}

fn append_assistant_thinking(session: &mut Session, thinking: &str) {
    let message = ensure_assistant_message(session);
    if let Some(ContentBlock::Thinking {
        thinking: existing, ..
    }) = message.blocks.last_mut()
    {
        existing.push_str(thinking);
    } else {
        message.blocks.push(ContentBlock::Thinking {
            thinking: thinking.to_string(),
            signature: String::new(),
        });
    }
}

fn latest_usage_from_payload(payload: &Value) -> Option<TokenUsage> {
    payload
        .get("turnUsages")
        .and_then(Value::as_array)
        .and_then(|values| values.last())
        .or_else(|| payload.get("providerUsage"))
        .and_then(usage_from_value)
}

fn session_from_value(value: &Value) -> Result<Session, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "session snapshot must be an object".to_string())?;
    let version = object
        .get("version")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(1);
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "session snapshot missing messages".to_string())?
        .iter()
        .map(message_from_value)
        .collect::<Result<Vec<_>, _>>()?;
    let compactions = object
        .get("compactions")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(compaction_from_value)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(Session {
        version,
        messages,
        compactions,
    })
}

fn message_from_value(value: &Value) -> Result<ConversationMessage, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "message must be an object".to_string())?;
    let role = match required_str(object, "role")? {
        "system" => MessageRole::System,
        "user" => MessageRole::User,
        "assistant" => MessageRole::Assistant,
        "tool" => MessageRole::Tool,
        other => return Err(format!("unsupported message role: {other}")),
    };
    let blocks = object
        .get("blocks")
        .and_then(Value::as_array)
        .ok_or_else(|| "message missing blocks".to_string())?
        .iter()
        .map(content_block_from_value)
        .collect::<Result<Vec<_>, _>>()?;
    let usage = object.get("usage").and_then(usage_from_value);
    Ok(ConversationMessage {
        role,
        blocks,
        usage,
    })
}

fn content_block_from_value(value: &Value) -> Result<ContentBlock, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "content block must be an object".to_string())?;
    match required_str(object, "type")? {
        "text" => Ok(ContentBlock::Text {
            text: required_string(object, "text")?,
        }),
        "image" => Ok(ContentBlock::Image {
            media_type: required_string(object, "media_type")?,
            data: required_string(object, "data")?,
        }),
        "tool_use" => Ok(ContentBlock::ToolUse {
            id: required_string(object, "id")?,
            name: required_string(object, "name")?,
            input: required_string(object, "input")?,
        }),
        "tool_result" => Ok(ContentBlock::ToolResult {
            tool_use_id: required_string(object, "tool_use_id")?,
            tool_name: required_string(object, "tool_name")?,
            output: required_string(object, "output")?,
            is_error: object
                .get("is_error")
                .and_then(Value::as_bool)
                .ok_or_else(|| "tool result missing is_error".to_string())?,
        }),
        "thinking" => Ok(ContentBlock::Thinking {
            thinking: required_string(object, "thinking")?,
            signature: object
                .get("signature")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        other => Err(format!("unsupported content block type: {other}")),
    }
}

fn compaction_from_value(value: &Value) -> Result<SessionCompactionRecord, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "compaction must be an object".to_string())?;
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "compaction missing messages".to_string())?
        .iter()
        .map(message_from_value)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SessionCompactionRecord {
        summary: required_string(object, "summary")?,
        messages,
        removed_message_count: optional_usize(object, "removed_message_count"),
        preserved_message_count: optional_usize(object, "preserved_message_count"),
        tokens_before: optional_usize(object, "tokens_before"),
        tokens_after: optional_usize(object, "tokens_after"),
        summary_source: object
            .get("summary_source")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
    })
}

fn usage_from_value(value: &Value) -> Option<TokenUsage> {
    let object = value.as_object()?;
    Some(TokenUsage {
        input_tokens: u32_field(object, "inputTokens")
            .or_else(|| u32_field(object, "input_tokens"))?,
        output_tokens: u32_field(object, "outputTokens")
            .or_else(|| u32_field(object, "output_tokens"))?,
        cache_creation_input_tokens: u32_field(object, "cacheCreationInputTokens")
            .or_else(|| u32_field(object, "cache_creation_input_tokens"))?,
        cache_read_input_tokens: u32_field(object, "cacheReadInputTokens")
            .or_else(|| u32_field(object, "cache_read_input_tokens"))?,
    })
}

fn required_str<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {key}"))
}

fn required_string(object: &Map<String, Value>, key: &str) -> Result<String, String> {
    required_str(object, key).map(ToOwned::to_owned)
}

fn optional_usize(object: &Map<String, Value>, key: &str) -> usize {
    object
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or_default()
}

fn u32_field(object: &Map<String, Value>, key: &str) -> Option<u32> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

#[cfg(test)]
mod tests {
    use super::{replay_events, session_from_events, ChatEventLogEntry};
    use serde_json::json;

    fn event(seq: u64, kind: &str, payload: serde_json::Value) -> ChatEventLogEntry {
        ChatEventLogEntry {
            version: 1,
            seq,
            ts: 1,
            session_id: "chat-test".to_string(),
            kind: kind.to_string(),
            payload,
        }
    }

    #[test]
    fn replay_projects_stream_events_into_turns() {
        let events = vec![
            event(
                1,
                "user_message",
                json!({"message":{"role":"user","blocks":[{"type":"text","text":"hi"}]}}),
            ),
            event(
                2,
                "assistant_delta",
                json!({"sessionId":"chat-test","text":"hello"}),
            ),
            event(
                3,
                "tool_call",
                json!({"sessionId":"chat-test","id":"t1","name":"bash","input":"{}"}),
            ),
            event(
                4,
                "tool_result",
                json!({"sessionId":"chat-test","id":"t1","name":"bash","output":"ok","isError":false}),
            ),
            event(5, "done", json!({"sessionId":"chat-test","text":"hello"})),
        ];
        let replay = replay_events("chat-test", &events);
        assert_eq!(replay.turns.len(), 2);
        assert_eq!(replay.last_seq, 5);
    }

    #[test]
    fn restore_rebuilds_runtime_session_from_basic_events() {
        let events = vec![
            event(
                1,
                "user_message",
                json!({"message":{"role":"user","blocks":[{"type":"text","text":"hi"}]}}),
            ),
            event(2, "assistant_delta", json!({"text":"hello"})),
            event(
                3,
                "tool_call",
                json!({"id":"t1","name":"bash","input":"{}"}),
            ),
            event(
                4,
                "tool_result",
                json!({"id":"t1","name":"bash","output":"ok","isError":false}),
            ),
        ];
        let session = session_from_events(&events).expect("session restores");
        assert_eq!(session.messages.len(), 3);
    }
}
