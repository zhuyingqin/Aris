//! List managed sessions and read a session transcript for the Sessions page.
//! Reuses `runtime::Session` directly, so the on-disk format stays the kernel's.

use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs,
    io::ErrorKind,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use remote_protocol::{ChatToolProgress, ChatTranscriptBlock};
use runtime::Session;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

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
// Keep enough room for session metadata while preventing rich thinking/tool
// turns from turning the quick preview into a second full-session file.
const CHAT_UI_SESSION_PREVIEW_MAX_TURN_BYTES: usize = 192 * 1024;
const CHAT_UI_PREVIEW_VERSION: u64 = 6;
const PROJECT_REVIEW_MAX_MESSAGE_CHARS: usize = 8_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProjectConversationCorpus {
    pub fingerprint: String,
    pub conversation_count: usize,
    pub message_count: usize,
    pub question_count: usize,
    pub delta_conversation_count: usize,
    pub delta_message_count: usize,
    pub session_cursors: BTreeMap<String, String>,
    pub transcript: String,
}

// Remote chat is a bounded projection of the visible desktop UI session. These
// limits keep text, thinking, and UI-sanitized tool cards comfortably below the
// encrypted relay frame even when a saved conversation is unusually large.
const MAX_REMOTE_CHAT_SESSION_LIST: usize = 200;
const MAX_REMOTE_CHAT_SESSION_TITLE_BYTES: usize = 512;
const MAX_REMOTE_CHAT_TRANSCRIPT_MESSAGES: usize = 100;
// Keep a recovered phone transcript comfortably below the encrypted relay
// frame cap while preserving normal long-form Chat responses.
const MAX_REMOTE_CHAT_TRANSCRIPT_TEXT_BYTES: usize = 128 * 1024;
const MAX_REMOTE_CHAT_TRANSCRIPT_SERIALIZED_BYTES: usize =
    MAX_REMOTE_CHAT_TRANSCRIPT_TEXT_BYTES - (16 * 1024);
const MAX_REMOTE_CHAT_TRANSCRIPT_BLOCK_BYTES: usize = 32 * 1024;
// The terminal remote response uses the same 128 KiB safe frame budget.
// Accept it atomically in the durable completion fallback projection.
const MAX_REMOTE_CHAT_UI_ASSISTANT_TEXT_BYTES: usize = 128 * 1024;
const MAX_REMOTE_CHAT_SESSION_ID_BYTES: usize = 256;
const MAX_REMOTE_CHAT_USER_TEXT_BYTES: usize = 16 * 1024;
const MAX_REMOTE_CHAT_MESSAGE_ID_BYTES: usize = 256;

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

/// Build the token-triggered Reviewer's incremental visible-dialogue input.
/// Thinking and tool payloads still count toward the backend context-token
/// trigger, but are deliberately excluded from the summary evidence itself.
pub(crate) fn project_conversation_corpus_since(
    project_id: &str,
    reviewed_cursors: &BTreeMap<String, String>,
) -> Result<ProjectConversationCorpus, String> {
    if !state::valid_project_id(project_id) {
        return Err("invalid project id".to_string());
    }
    ensure_chat_ui_migrated()?;
    let sessions = match fs::read_dir(chat_ui_sessions_dir()) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                (path.extension().and_then(|extension| extension.to_str()) == Some("json"))
                    .then(|| fs::read_to_string(path).ok())
                    .flatten()
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            })
            .collect(),
        Err(error) if error.kind() == ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.to_string()),
    };
    Ok(project_conversation_corpus_from_sessions_since(
        project_id,
        sessions,
        reviewed_cursors,
    ))
}

#[cfg(test)]
fn project_conversation_corpus_from_sessions(
    project_id: &str,
    sessions: Vec<Value>,
) -> ProjectConversationCorpus {
    project_conversation_corpus_from_sessions_since(project_id, sessions, &BTreeMap::new())
}

fn project_conversation_corpus_from_sessions_since(
    project_id: &str,
    sessions: Vec<Value>,
    reviewed_cursors: &BTreeMap<String, String>,
) -> ProjectConversationCorpus {
    let mut sessions = sessions
        .into_iter()
        .filter(|session| chat_ui_session_project_id(session) == project_id)
        .filter(|session| session.get("remoteAgent").is_none_or(Value::is_null))
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| {
        let timestamp = |session: &Value| {
            session
                .get("updatedAt")
                .and_then(Value::as_i64)
                .or_else(|| session.get("createdAt").and_then(Value::as_i64))
                .unwrap_or_default()
        };
        timestamp(left).cmp(&timestamp(right)).then_with(|| {
            chat_ui_session_id(left)
                .unwrap_or_default()
                .cmp(chat_ui_session_id(right).unwrap_or_default())
        })
    });

    let mut fingerprint_records = Vec::new();
    let mut conversation_count = 0usize;
    let mut message_count = 0usize;
    let mut question_count = 0usize;
    let mut delta_conversation_count = 0usize;
    let mut delta_message_count = 0usize;
    let mut session_cursors = BTreeMap::new();
    let mut conversations = Vec::new();
    for session in sessions {
        let id = chat_ui_session_id(&session).unwrap_or("unknown");
        let title = session
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled chat");
        let updated_at = session
            .get("updatedAt")
            .and_then(Value::as_i64)
            .or_else(|| session.get("createdAt").and_then(Value::as_i64))
            .unwrap_or_default();
        let messages = session
            .get("turns")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, turn)| {
                project_review_message(turn).map(|(role, text)| {
                    let turn_id = turn
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("visible-turn-{index}"));
                    (turn_id, role, text)
                })
            })
            .collect::<Vec<_>>();
        if messages.is_empty() {
            continue;
        }

        conversation_count += 1;
        message_count += messages.len();
        if let Some((turn_id, _, _)) = messages.last() {
            session_cursors.insert(id.to_string(), turn_id.clone());
        }
        let delta_start = reviewed_cursors
            .get(id)
            .and_then(|cursor| messages.iter().position(|(turn_id, _, _)| turn_id == cursor))
            .map_or(0, |index| index.saturating_add(1));
        let delta_messages = &messages[delta_start..];
        if !delta_messages.is_empty() {
            delta_conversation_count = delta_conversation_count.saturating_add(1);
            delta_message_count = delta_message_count.saturating_add(delta_messages.len());
        }
        let mut session_hasher = Sha256::new();
        session_hasher.update(id.as_bytes());
        session_hasher.update([0]);
        session_hasher.update(title.as_bytes());
        session_hasher.update([0]);
        let mut lines = Vec::new();
        if !delta_messages.is_empty() {
            lines.push(format!(
                "## Conversation {conversation_count}: {title}\nUpdated: {updated_at}"
            ));
        }
        for (_, role, full_text) in &messages {
            if role == "user" {
                question_count = question_count.saturating_add(1);
            }
            session_hasher.update(role.as_bytes());
            session_hasher.update([0]);
            session_hasher.update(full_text.as_bytes());
            session_hasher.update([0]);
        }
        for (_, role, full_text) in delta_messages {
            lines.push(format!(
                "{}: {}",
                if role == "user" { "User" } else { "Assistant" },
                truncate_project_review_text(full_text, PROJECT_REVIEW_MAX_MESSAGE_CHARS)
            ));
        }
        fingerprint_records.push((id.to_string(), session_hasher.finalize()));
        if !lines.is_empty() {
            conversations.push(lines.join("\n\n"));
        }
    }

    // Draft edits can update a UI session timestamp without changing any
    // dialogue. Hash content in stable id order so those metadata-only saves
    // do not spend another token-triggered Reviewer call.
    fingerprint_records.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    for (_, fingerprint) in fingerprint_records {
        hasher.update(fingerprint);
    }

    ProjectConversationCorpus {
        fingerprint: format!("sha256:{:x}", hasher.finalize()),
        conversation_count,
        message_count,
        question_count,
        delta_conversation_count,
        delta_message_count,
        session_cursors,
        transcript: conversations.join("\n\n"),
    }
}

fn project_review_message(turn: &Value) -> Option<(String, String)> {
    let role = turn.get("role").and_then(Value::as_str)?;
    if role != "user" && role != "assistant" {
        return None;
    }
    let mut parts = turn
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("kind").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .map(clean_project_review_text)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    if role == "user" {
        let attachments = turn
            .get("attachments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|attachment| attachment.get("name").and_then(Value::as_str))
            .map(clean_project_review_text)
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>();
        if !attachments.is_empty() {
            parts.push(format!("Attachments: {}", attachments.join(", ")));
        }
    }
    let text = parts.join("\n");
    (!text.is_empty()).then(|| (role.to_string(), text))
}

fn clean_project_review_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_project_review_text(value: &str, max_chars: usize) -> String {
    let mut output = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        output.push_str(" …[message truncated]");
    }
    output
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
        object.remove("loadedTurnStartIndex");
        object.remove("questionCountBeforeLoadedTurns");
        object.remove("previewVersion");
    }
}

fn is_large_turn_placeholder(turn: &Value) -> bool {
    turn.get("omittedTurnIndex")
        .and_then(Value::as_u64)
        .is_some()
}

/// Read the summary index that backs the sidebar list. One entry per started
/// session, without any turn bodies, so listing never touches conversation data.
fn read_chat_ui_index() -> Result<Vec<Value>, String> {
    ensure_chat_ui_migrated()?;
    reconcile_chat_ui_index(read_json_array(&chat_ui_index_path())?)
}

/// Self-heal the summary index against `chat-ui-sessions/*.json`: recover
/// entries for per-session files the index doesn't know about (e.g. the index
/// file was lost or corrupted while the session data survived), and drop
/// entries whose backing file is gone. Cheap in the common case — only a
/// directory listing (no JSON parsing) unless drift is actually found.
fn reconcile_chat_ui_index(index: Vec<Value>) -> Result<Vec<Value>, String> {
    let Ok(entries) = fs::read_dir(chat_ui_sessions_dir()) else {
        return Ok(index);
    };
    let disk_ids: HashSet<String> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                return None;
            }
            path.file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_string)
        })
        .collect();

    let (mut reconciled, missing_ids, mut changed) = partition_chat_ui_index(index, &disk_ids);
    for id in missing_ids {
        if let Some(session) = read_chat_ui_session_file(&id)? {
            if let Some(summary) = summarize_chat_ui_session(&session) {
                reconciled.push(summary);
                changed = true;
            }
        }
    }

    if changed {
        write_chat_ui_index(reconciled.clone())?;
    }
    Ok(reconciled)
}

/// Split the stored index against the ids actually present on disk: keep
/// entries whose backing file still exists, drop stale ones, and report which
/// disk-only ids still need a freshly summarized entry. Pure and file-free so
/// the recovery decision is unit-testable without touching the filesystem.
fn partition_chat_ui_index(
    index: Vec<Value>,
    disk_ids: &HashSet<String>,
) -> (Vec<Value>, Vec<String>, bool) {
    let mut indexed_ids: HashSet<String> = HashSet::new();
    let mut reconciled: Vec<Value> = Vec::new();
    let mut changed = false;
    for entry in index {
        match chat_ui_session_id(&entry).map(str::to_string) {
            Some(id) if disk_ids.contains(&id) => {
                indexed_ids.insert(id);
                reconciled.push(entry);
            }
            // Stale entry: the backing per-session file is gone.
            _ => changed = true,
        }
    }
    let missing_ids = disk_ids.difference(&indexed_ids).cloned().collect();
    (reconciled, missing_ids, changed)
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
        Ok(raw) => {
            let preview = serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())?;
            // Regenerate older previews: v4 adds a serialized byte budget so
            // rich thinking/tool turns cannot make quick-load files unbounded;
            // v5 always keeps the newest turn in full so opening a conversation
            // never shows a "large turn omitted" placeholder for its latest
            // response (re-renders v4 files that omitted a huge newest turn);
            // v6 records the loaded slice's absolute offset and prior question
            // count so lazy history prepends do not renumber question navigation.
            Ok((preview.get("previewVersion").and_then(Value::as_u64)
                == Some(CHAT_UI_PREVIEW_VERSION))
            .then_some(preview))
        }
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

fn is_chat_ui_question_turn(turn: &Value) -> bool {
    turn.get("role").and_then(Value::as_str) == Some("user")
}

#[allow(dead_code)]
fn chat_ui_preview_turns(id: &str, turns: &[Value]) -> (Vec<Value>, bool, Vec<String>) {
    let start = turns
        .len()
        .saturating_sub(CHAT_UI_SESSION_PREVIEW_MAX_TURNS);
    chat_ui_preview_turn_slice(id, &turns[start..], start)
}

fn chat_ui_preview_turn_slice(
    id: &str,
    turns: &[Value],
    loaded_turn_start_index: usize,
) -> (Vec<Value>, bool, Vec<String>) {
    let base_ids = turns
        .iter()
        .filter_map(chat_ui_turn_id)
        .map(str::to_string)
        .collect::<Vec<_>>();
    let newest_offset = turns.len().saturating_sub(1);
    let mut remaining = CHAT_UI_SESSION_PREVIEW_MAX_TURN_BYTES;
    let mut omitted = false;
    // Spend the byte budget newest-first so the latest normal-sized exchange
    // remains immediately visible. Oversized turns stay available through the
    // existing on-demand `chat_ui_turn_load` placeholder path.
    let mut preview = turns
        .iter()
        .enumerate()
        .rev()
        .map(|(offset, turn)| {
            // The newest turn is always kept in full and never charged against
            // the budget: the budget bounds how much *older* history to inline,
            // not whether the latest response is visible. Opening a conversation
            // must never replace its newest turn — the entire content of a
            // single-turn or single-exchange session — with a "large turn
            // omitted" placeholder that strands the user on a manual load.
            if offset == newest_offset {
                return turn.clone();
            }
            let bytes = serde_json::to_vec(turn)
                .map(|value| value.len())
                .unwrap_or(remaining + 1);
            if bytes <= remaining {
                remaining -= bytes;
                turn.clone()
            } else {
                omitted = true;
                large_turn_placeholder(id, loaded_turn_start_index + offset, bytes)
            }
        })
        .collect::<Vec<_>>();
    preview.reverse();
    (preview, loaded_turn_start_index > 0 || omitted, base_ids)
}

fn chat_ui_preview_session(session: Value, turns: &[Value], turn_count: usize) -> Value {
    let loaded_turn_start_index = turns
        .len()
        .saturating_sub(CHAT_UI_SESSION_PREVIEW_MAX_TURNS);
    let question_count_before_loaded_turns = turns[..loaded_turn_start_index]
        .iter()
        .filter(|turn| is_chat_ui_question_turn(turn))
        .count();
    chat_ui_preview_session_from_turn_slice(
        session,
        &turns[loaded_turn_start_index..],
        turn_count,
        loaded_turn_start_index,
        question_count_before_loaded_turns,
    )
}

fn chat_ui_preview_session_from_turn_slice(
    mut session: Value,
    turns: &[Value],
    turn_count: usize,
    loaded_turn_start_index: usize,
    question_count_before_loaded_turns: usize,
) -> Value {
    let id = chat_ui_session_id(&session)
        .unwrap_or("chat-preview")
        .to_string();
    let (preview_turns, turns_partial, partial_base_turn_ids) =
        chat_ui_preview_turn_slice(&id, turns, loaded_turn_start_index);
    if let Value::Object(object) = &mut session {
        object.insert("turns".to_string(), Value::Array(preview_turns));
        object.insert("turnsLoaded".to_string(), Value::Bool(true));
        object.insert("turnCount".to_string(), json!(turn_count));
        object.insert("turnsPartial".to_string(), Value::Bool(turns_partial));
        object.insert(
            "loadedTurnStartIndex".to_string(),
            json!(loaded_turn_start_index),
        );
        object.insert(
            "questionCountBeforeLoadedTurns".to_string(),
            json!(question_count_before_loaded_turns),
        );
        object.insert(
            "partialBaseTurnIds".to_string(),
            json!(partial_base_turn_ids),
        );
        object.insert("previewVersion".to_string(), json!(CHAT_UI_PREVIEW_VERSION));
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
        "omittedTurnIndex": index,
        "omittedBytes": bytes,
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
) -> (usize, usize, Vec<Value>) {
    let bytes = raw.as_bytes();
    let mut index = array_start + 1;
    let mut object_depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut turn_start = None;
    let mut turn_count = 0usize;
    let mut question_count = 0usize;
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
                        let value = serde_json::from_str::<Value>(&raw[start..end])
                            .unwrap_or_else(|_| large_turn_placeholder(id, turn_count, bytes));
                        if is_chat_ui_question_turn(&value) {
                            question_count = question_count.saturating_add(1);
                        }
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

    let tail = tail.into_iter().collect::<Vec<_>>();
    let question_count_before_tail = question_count.saturating_sub(
        tail.iter()
            .filter(|turn| is_chat_ui_question_turn(turn))
            .count(),
    );
    (turn_count, question_count_before_tail, tail)
}

fn turn_from_array_index(
    raw: &str,
    array_start: usize,
    array_end: usize,
    turn_index: usize,
) -> Result<Option<Value>, String> {
    let bytes = raw.as_bytes();
    let mut index = array_start + 1;
    let mut object_depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut turn_start = None;
    let mut current_turn_index = 0usize;

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
                        if current_turn_index == turn_index {
                            let value = serde_json::from_str::<Value>(&raw[start..end])
                                .map_err(|e| e.to_string())?;
                            return Ok(Some(value));
                        }
                        current_turn_index += 1;
                    }
                }
            }
            _ => {}
        }
        index += 1;
    }

    Ok(None)
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
    let (turn_count, question_count_before_tail, tail_turns) =
        tail_turns_from_array(&raw, array_start, array_end, id);
    let Some(base) = chat_ui_index_entry(id)? else {
        return Ok(None);
    };
    let loaded_turn_start_index = turn_count.saturating_sub(tail_turns.len());
    let preview = chat_ui_preview_session_from_turn_slice(
        base,
        &tail_turns,
        turn_count,
        loaded_turn_start_index,
        question_count_before_tail,
    );
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
        if is_large_turn_placeholder(&incoming) {
            continue;
        }
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

/// A desktop save can carry a full but already-stale snapshot while a paired
/// device has just appended a durable remote turn. Remote turn ids are
/// reserved under `remote-`, so retain any such stored turn that the incoming
/// snapshot does not know about instead of letting the stale save erase it.
///
/// The normal case appends remote turns at the end of the conversation. For
/// older or interleaved data, insert before the next surviving stored turn (or
/// after the preceding one) so the stored ordering remains recognizable.
fn merge_missing_remote_chat_ui_turns(next: &mut Value, stored: &Value) -> bool {
    let Some(stored_turns) = stored.get("turns").and_then(Value::as_array) else {
        return false;
    };
    let Some(next_object) = next.as_object_mut() else {
        return false;
    };
    let Some(next_turns) = next_object
        .entry("turns".to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
    else {
        return false;
    };

    let mut present_ids = next_turns
        .iter()
        .filter_map(chat_ui_turn_id)
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let mut merged_any = false;

    for (stored_index, stored_turn) in stored_turns.iter().enumerate() {
        let Some(stored_id) = chat_ui_turn_id(stored_turn) else {
            continue;
        };
        if !stored_id.starts_with("remote-") || present_ids.contains(stored_id) {
            continue;
        }

        let next_surviving_id = stored_turns[stored_index.saturating_add(1)..]
            .iter()
            .filter_map(chat_ui_turn_id)
            .find(|id| present_ids.contains(*id));
        let insertion_index = next_surviving_id
            .and_then(|id| {
                next_turns
                    .iter()
                    .position(|turn| chat_ui_turn_id(turn) == Some(id))
            })
            .or_else(|| {
                stored_turns[..stored_index]
                    .iter()
                    .rev()
                    .filter_map(chat_ui_turn_id)
                    .find(|id| present_ids.contains(*id))
                    .and_then(|id| {
                        next_turns
                            .iter()
                            .rposition(|turn| chat_ui_turn_id(turn) == Some(id))
                    })
                    .map(|index| index.saturating_add(1))
            })
            .unwrap_or(next_turns.len());
        next_turns.insert(insertion_index, stored_turn.clone());
        present_ids.insert(stored_id.to_string());
        merged_any = true;
    }

    merged_any
}

fn preserve_remote_chat_updated_at(next: &mut Value, stored: &Value, merged_remote_turns: bool) {
    if !merged_remote_turns {
        return;
    }
    let Some(stored_updated_at) = stored.get("updatedAt").cloned() else {
        return;
    };
    let Some(stored_millis) = stored_updated_at.as_i64() else {
        return;
    };
    let incoming_millis = next.get("updatedAt").and_then(Value::as_i64);
    if incoming_millis.is_some_and(|incoming| incoming >= stored_millis) {
        return;
    }
    if let Some(next_object) = next.as_object_mut() {
        next_object.insert("updatedAt".to_string(), stored_updated_at);
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

/// A compact, project-scoped desktop chat entry safe for the encrypted mobile
/// control surface. This intentionally reflects the Chat UI's title and
/// timestamp rather than the lower-level runtime session file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteChatSessionSummary {
    pub id: String,
    pub title: String,
    pub updated_at_unix_ms: i64,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteChatSessionList {
    pub sessions: Vec<RemoteChatSessionSummary>,
    pub has_more: bool,
}

/// One visible user or assistant message reconstructed from the desktop Chat
/// UI projection. Permission prompts, notices, and attachments remain local;
/// thinking and the already-sanitized tool cards match the desktop rendering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteChatTranscriptMessage {
    pub role: String,
    pub text: String,
    pub blocks: Vec<ChatTranscriptBlock>,
    #[serde(skip)]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteChatTranscript {
    pub id: String,
    pub title: String,
    pub updated_at_unix_ms: i64,
    pub messages: Vec<RemoteChatTranscriptMessage>,
    pub has_more: bool,
}

fn validate_remote_chat_project_id(project_id: &str) -> Result<(), String> {
    if !state::valid_project_id(project_id) {
        return Err("invalid remote chat project id".to_string());
    }
    Ok(())
}

fn validate_remote_chat_session_id(session_id: &str) -> Result<(), String> {
    validate_chat_ui_session_id(session_id)?;
    if session_id.len() > MAX_REMOTE_CHAT_SESSION_ID_BYTES {
        return Err("invalid remote chat session id".to_string());
    }
    Ok(())
}

fn bounded_remote_chat_limit(limit: u16, maximum: usize, label: &str) -> Result<usize, String> {
    if limit == 0 {
        return Err(format!("remote chat {label} limit must be positive"));
    }
    Ok(usize::from(limit).min(maximum))
}

fn chat_ui_session_project_id(session: &Value) -> &str {
    session
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|project_id| !project_id.trim().is_empty())
        .unwrap_or("default")
}

fn chat_ui_session_title(session: &Value) -> String {
    let title = session
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or("New chat");
    truncate_utf8_bytes(title, MAX_REMOTE_CHAT_SESSION_TITLE_BYTES)
}

fn chat_ui_session_updated_at(session: &Value) -> i64 {
    session
        .get("updatedAt")
        .and_then(Value::as_i64)
        .filter(|timestamp| *timestamp >= 0)
        .unwrap_or_default()
}

fn chat_ui_session_model(session: &Value) -> Option<String> {
    session
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(ToOwned::to_owned)
}

fn truncate_utf8_bytes(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_string();
    }
    let mut end = maximum;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn remote_chat_session_summary_for_project(
    session: &Value,
    project_id: &str,
) -> Option<RemoteChatSessionSummary> {
    let id = chat_ui_session_id(session)?;
    validate_remote_chat_session_id(id).ok()?;
    (chat_ui_session_project_id(session) == project_id).then(|| RemoteChatSessionSummary {
        id: id.to_string(),
        title: chat_ui_session_title(session),
        updated_at_unix_ms: chat_ui_session_updated_at(session),
        model: chat_ui_session_model(session),
    })
}

fn remote_chat_new_session_value(project_id: &str, session_id: &str, now: i64) -> Value {
    json!({
        "id": session_id,
        "projectId": project_id,
        "title": "New chat",
        "model": null,
        "turns": [],
        "turnsLoaded": true,
        "turnsPartial": false,
        "turnCount": 0,
        "draft": "",
        "draftAttachments": [],
        "pinned": false,
        "createdAt": now,
        "updatedAt": now,
    })
}

fn truncate_remote_chat_block(value: &str, maximum: usize, truncated: &mut bool) -> String {
    if value.len() > maximum {
        *truncated = true;
    }
    truncate_utf8_bytes(value, maximum)
}

fn remote_chat_tool_progress(value: &Value, truncated: &mut bool) -> Option<ChatToolProgress> {
    let object = value.as_object()?;
    let elapsed_ms = object.get("elapsedMs")?.as_u64()?;
    let timeout_ms = object.get("timeoutMs").and_then(Value::as_u64);
    let pid = object
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok());
    Some(ChatToolProgress {
        elapsed_ms,
        timeout_ms,
        pid,
        stdout_tail: object
            .get("stdoutTail")
            .and_then(Value::as_str)
            .map(|value| {
                truncate_remote_chat_block(value, MAX_REMOTE_CHAT_TRANSCRIPT_BLOCK_BYTES, truncated)
            }),
        stderr_tail: object
            .get("stderrTail")
            .and_then(Value::as_str)
            .map(|value| {
                truncate_remote_chat_block(value, MAX_REMOTE_CHAT_TRANSCRIPT_BLOCK_BYTES, truncated)
            }),
        near_timeout: object
            .get("nearTimeout")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        message: object
            .get("message")
            .and_then(Value::as_str)
            .map(|value| {
                truncate_remote_chat_block(value, MAX_REMOTE_CHAT_TRANSCRIPT_BLOCK_BYTES, truncated)
            })
            .unwrap_or_default(),
    })
}

fn remote_chat_message_from_turn(turn: &Value) -> Option<RemoteChatTranscriptMessage> {
    let role = match turn.get("role").and_then(Value::as_str) {
        Some("user") => "user",
        Some("assistant") => "assistant",
        _ => return None,
    };
    let blocks = turn.get("blocks").and_then(Value::as_array);
    let has_blocks = blocks.is_some_and(|blocks| !blocks.is_empty());
    let mut visible_blocks = Vec::new();
    let mut truncated = false;
    for block in blocks.into_iter().flatten() {
        match block.get("kind").and_then(Value::as_str) {
            Some("text") => {
                let Some(text) = block.get("text").and_then(Value::as_str) else {
                    continue;
                };
                if !text.trim().is_empty() {
                    visible_blocks.push(ChatTranscriptBlock::Text {
                        text: truncate_remote_chat_block(
                            text,
                            MAX_REMOTE_CHAT_TRANSCRIPT_BLOCK_BYTES,
                            &mut truncated,
                        ),
                    });
                }
            }
            Some("thinking") if role == "assistant" => {
                let Some(thinking) = block.get("thinking").and_then(Value::as_str) else {
                    continue;
                };
                if !thinking.trim().is_empty() {
                    visible_blocks.push(ChatTranscriptBlock::Thinking {
                        thinking: truncate_remote_chat_block(
                            thinking,
                            MAX_REMOTE_CHAT_TRANSCRIPT_BLOCK_BYTES,
                            &mut truncated,
                        ),
                    });
                }
            }
            Some("tool") if role == "assistant" => {
                let Some(name) = block.get("name").and_then(Value::as_str) else {
                    continue;
                };
                visible_blocks.push(ChatTranscriptBlock::Tool {
                    tool_use_id: block
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|value| truncate_remote_chat_block(value, 512, &mut truncated)),
                    name: truncate_remote_chat_block(name, 512, &mut truncated),
                    input: block
                        .get("input")
                        .and_then(Value::as_str)
                        .map(|value| {
                            truncate_remote_chat_block(
                                value,
                                MAX_REMOTE_CHAT_TRANSCRIPT_BLOCK_BYTES,
                                &mut truncated,
                            )
                        })
                        .unwrap_or_default(),
                    output: block.get("output").and_then(Value::as_str).map(|value| {
                        truncate_remote_chat_block(
                            value,
                            MAX_REMOTE_CHAT_TRANSCRIPT_BLOCK_BYTES,
                            &mut truncated,
                        )
                    }),
                    is_error: block.get("isError").and_then(Value::as_bool),
                    progress: block
                        .get("progress")
                        .and_then(|value| remote_chat_tool_progress(value, &mut truncated)),
                });
            }
            _ => {}
        }
    }

    let mut texts = visible_blocks
        .iter()
        .filter_map(|block| match block {
            ChatTranscriptBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();

    // Pre-block UI records used a top-level `text` field. Keep that historical
    // conversation readable without accepting non-text block data.
    if texts.is_empty() && !has_blocks {
        if let Some(text) = turn
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        {
            texts.push(text.to_string());
            visible_blocks.push(ChatTranscriptBlock::Text {
                text: truncate_remote_chat_block(
                    text,
                    MAX_REMOTE_CHAT_TRANSCRIPT_BLOCK_BYTES,
                    &mut truncated,
                ),
            });
        }
    }
    (!visible_blocks.is_empty()).then(|| RemoteChatTranscriptMessage {
        role: role.to_string(),
        text: texts.join("\n"),
        blocks: visible_blocks,
        truncated,
    })
}

fn remote_chat_transcript_for_project(
    session: &Value,
    project_id: &str,
    limit: usize,
) -> Option<RemoteChatTranscript> {
    let summary = remote_chat_session_summary_for_project(session, project_id)?;
    let messages = session
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(remote_chat_message_from_turn)
        .collect::<Vec<_>>();
    let start = messages.len().saturating_sub(limit);
    let mut has_more = start > 0 || messages.iter().any(|message| message.truncated);
    let mut included_reversed = Vec::new();
    let mut included_bytes = 0usize;

    // Retain the newest meaningful messages first, then restore chronological
    // order. That makes a bounded response useful for continuing a chat.
    for message in messages[start..].iter().rev() {
        let available = MAX_REMOTE_CHAT_TRANSCRIPT_SERIALIZED_BYTES.saturating_sub(included_bytes);
        if available == 0 {
            has_more = true;
            continue;
        }
        let mut included = message.clone();
        let mut encoded_len = serde_json::to_vec(&included).map_or(usize::MAX, |value| value.len());
        if encoded_len > available {
            // Preserve a bounded text fallback for unusually large historical
            // turns instead of letting one rich card exceed the relay frame.
            let text_budget = available.saturating_sub(256) / 2;
            let text = truncate_utf8_bytes(&message.text, text_budget);
            included = RemoteChatTranscriptMessage {
                role: message.role.clone(),
                blocks: (!text.is_empty())
                    .then(|| ChatTranscriptBlock::Text { text: text.clone() })
                    .into_iter()
                    .collect(),
                text,
                truncated: true,
            };
            encoded_len = serde_json::to_vec(&included).map_or(usize::MAX, |value| value.len());
            has_more = true;
        }
        if included.blocks.is_empty() || encoded_len > available {
            has_more = true;
            continue;
        }
        included_bytes = included_bytes.saturating_add(encoded_len);
        included_reversed.push(included);
    }
    included_reversed.reverse();

    Some(RemoteChatTranscript {
        id: summary.id,
        title: summary.title,
        updated_at_unix_ms: summary.updated_at_unix_ms,
        messages: included_reversed,
        has_more,
    })
}

fn remote_chat_ui_session_for_project(project_id: &str, session_id: &str) -> Result<Value, String> {
    validate_remote_chat_project_id(project_id)?;
    validate_remote_chat_session_id(session_id)?;
    ensure_chat_ui_migrated()?;
    let session = read_chat_ui_session_file(session_id)?
        .ok_or_else(|| "remote chat session not found".to_string())?;
    if chat_ui_session_project_id(&session) != project_id {
        return Err("remote chat session not found".to_string());
    }
    Ok(session)
}

fn remote_chat_sessions_from_index(
    index: &[Value],
    project_id: &str,
    limit: usize,
) -> RemoteChatSessionList {
    let mut sessions = index
        .iter()
        .filter_map(|session| remote_chat_session_summary_for_project(session, project_id))
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| {
        right
            .updated_at_unix_ms
            .cmp(&left.updated_at_unix_ms)
            .then_with(|| left.id.cmp(&right.id))
    });
    let has_more = sessions.len() > limit;
    sessions.truncate(limit);
    RemoteChatSessionList { sessions, has_more }
}

/// Lists the started Chat UI conversations in one project, newest first. The
/// UI index is used intentionally: it has the title/timestamp users see and
/// avoids reading every transcript just to populate a mobile picker.
pub(crate) fn remote_chat_sessions_list(
    project_id: &str,
    limit: u16,
) -> Result<RemoteChatSessionList, String> {
    validate_remote_chat_project_id(project_id)?;
    let limit = bounded_remote_chat_limit(limit, MAX_REMOTE_CHAT_SESSION_LIST, "session list")?;
    Ok(remote_chat_sessions_from_index(
        &read_chat_ui_index()?,
        project_id,
        limit,
    ))
}

/// Creates the Chat UI projection for a new paired-device conversation. Empty
/// chats are deliberately omitted from the normal recent-chat index, so the
/// caller returns the summary from this value directly to the phone.
pub(crate) fn remote_chat_session_create(
    project_id: &str,
    session_id: &str,
) -> Result<RemoteChatSessionSummary, String> {
    validate_remote_chat_project_id(project_id)?;
    validate_remote_chat_session_id(session_id)?;
    ensure_chat_ui_migrated()?;
    fs::create_dir_all(chat_ui_sessions_dir()).map_err(|error| error.to_string())?;
    if chat_ui_session_file_path(session_id).exists() {
        return Err("remote chat session already exists".to_string());
    }

    let session = remote_chat_new_session_value(project_id, session_id, remote_chat_now_millis());
    let summary = remote_chat_session_summary_for_project(&session, project_id)
        .ok_or_else(|| "failed to create remote chat session summary".to_string())?;
    write_chat_ui_session_file(session_id, session)?;
    Ok(summary)
}

/// Verifies that an opaque remote session id is an existing Chat UI session in
/// the requested project. It does not reveal whether a missing id belongs to a
/// different project.
pub(crate) fn remote_chat_session_validate(
    project_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let _ = remote_chat_ui_session_for_project(project_id, session_id)?;
    Ok(())
}

/// Return the optional model override saved in one desktop-owned chat.
pub(crate) fn remote_chat_session_model(
    project_id: &str,
    session_id: &str,
) -> Result<Option<String>, String> {
    let session = remote_chat_ui_session_for_project(project_id, session_id)?;
    Ok(chat_ui_session_model(&session))
}

/// Persist a validated model override on one desktop-owned Chat UI session.
/// The caller validates the model against Settings before this write.
pub(crate) fn remote_chat_set_session_model(
    project_id: &str,
    session_id: &str,
    model: &str,
) -> Result<(), String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("remote chat model must not be empty".to_string());
    }
    let mut session = remote_chat_ui_session_for_project(project_id, session_id)?;
    let object = session
        .as_object_mut()
        .ok_or_else(|| "remote chat session must be an object".to_string())?;
    object.insert("model".to_string(), Value::String(model.to_string()));
    object.insert("updatedAt".to_string(), json!(remote_chat_now_millis()));
    write_chat_ui_session_file(session_id, session)
}

/// Reads the selected Chat UI session as a bounded visible transcript. It
/// includes the same thinking and already-sanitized tool cards shown by the
/// desktop, while permissions, attachments, and UI-only notices stay local.
pub(crate) fn remote_chat_session_transcript(
    project_id: &str,
    session_id: &str,
    limit: u16,
) -> Result<RemoteChatTranscript, String> {
    let limit =
        bounded_remote_chat_limit(limit, MAX_REMOTE_CHAT_TRANSCRIPT_MESSAGES, "transcript")?;
    let session = remote_chat_ui_session_for_project(project_id, session_id)?;
    remote_chat_transcript_for_project(&session, project_id, limit)
        .ok_or_else(|| "remote chat session not found".to_string())
}

fn remote_chat_now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

fn remote_chat_turn_value(id: String, role: &str, text: &str) -> Value {
    json!({
        "id": id,
        "role": role,
        "blocks": [{ "kind": "text", "text": text }],
        "streaming": false,
    })
}

/// Complete an existing rich assistant projection without flattening its
/// thinking/tool order. Returns `None` when the existing turn is text-only (or
/// malformed), in which case the caller should use the authoritative fallback.
fn complete_remote_chat_rich_turn(turn: &mut Value, assistant_text: &str) -> Option<bool> {
    let object = turn.as_object_mut()?;
    if object.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let blocks = object.get_mut("blocks")?.as_array_mut()?;
    let has_non_text = blocks
        .iter()
        .any(|block| block.get("kind").and_then(Value::as_str) != Some("text"));
    if !has_non_text {
        return None;
    }

    let existing_text = blocks
        .iter()
        .filter(|block| block.get("kind").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<String>();
    let mut changed = false;
    if existing_text != assistant_text {
        if assistant_text.starts_with(&existing_text) {
            let remainder = &assistant_text[existing_text.len()..];
            if !remainder.is_empty() {
                if let Some(text) = blocks
                    .iter_mut()
                    .rev()
                    .find(|block| block.get("kind").and_then(Value::as_str) == Some("text"))
                {
                    let current = text.get("text").and_then(Value::as_str).unwrap_or_default();
                    text["text"] = Value::String(format!("{current}{remainder}"));
                } else {
                    blocks.push(json!({ "kind": "text", "text": assistant_text }));
                }
            }
        } else {
            blocks.retain(|block| block.get("kind").and_then(Value::as_str) != Some("text"));
            blocks.push(json!({ "kind": "text", "text": assistant_text }));
        }
        changed = true;
    }
    if object.get("streaming").and_then(Value::as_bool) != Some(false) {
        object.insert("streaming".to_string(), Value::Bool(false));
        changed = true;
    }
    Some(changed)
}

/// Appends the two durable UI turns for a completed remote request. Returns
/// whether it wrote anything, so a caller may safely retry after a transport
/// failure without duplicating turns. A partially persisted pair is repaired
/// by appending only the missing side.
fn append_remote_chat_text_turns(
    session: &mut Value,
    message_id: &str,
    user_text: &str,
    assistant_text: &str,
    updated_at_unix_ms: i64,
) -> Result<bool, String> {
    let object = session
        .as_object_mut()
        .ok_or_else(|| "remote chat session must be an object".to_string())?;
    let turns = object
        .entry("turns".to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "remote chat session turns must be an array".to_string())?;
    let user_turn_id = format!("remote-{message_id}-user");
    let assistant_turn_id = format!("remote-{message_id}-assistant");
    let has_user_turn = turns
        .iter()
        .any(|turn| chat_ui_turn_id(turn) == Some(user_turn_id.as_str()));
    let assistant_turn_index = turns
        .iter()
        .position(|turn| chat_ui_turn_id(turn) == Some(assistant_turn_id.as_str()));
    let mut changed = false;
    if !has_user_turn {
        turns.push(remote_chat_turn_value(user_turn_id, "user", user_text));
        changed = true;
    }
    let completed_assistant =
        remote_chat_turn_value(assistant_turn_id, "assistant", assistant_text);
    if let Some(index) = assistant_turn_index {
        // The ordinary desktop renderer may have already saved thinking and
        // tool cards. Preserve those canonical visible blocks and use the
        // backend completion only to fill a missing final text suffix.
        match complete_remote_chat_rich_turn(&mut turns[index], assistant_text) {
            Some(rich_changed) => changed |= rich_changed,
            None if turns[index] != completed_assistant => {
                turns[index] = completed_assistant;
                changed = true;
            }
            None => {}
        }
    } else {
        turns.push(completed_assistant);
        changed = true;
    }
    if changed {
        object.insert("updatedAt".to_string(), json!(updated_at_unix_ms));
    }
    Ok(changed)
}

/// Persist a completed remote turn into the full Chat UI session file, then
/// atomically refresh its preview and sidebar index. This is the authoritative
/// terminal text fallback for remote turns. If the ordinary desktop renderer
/// has already saved rich visible blocks, they are retained and completed.
pub(crate) fn remote_chat_append_text_turn(
    project_id: &str,
    session_id: &str,
    message_id: &str,
    user_text: &str,
    assistant_text: &str,
) -> Result<(), String> {
    validate_remote_chat_project_id(project_id)?;
    validate_remote_chat_session_id(session_id)?;
    validate_chat_ui_session_id(message_id)
        .map_err(|_| "invalid remote chat message id".to_string())?;
    if message_id.len() > MAX_REMOTE_CHAT_MESSAGE_ID_BYTES {
        return Err("invalid remote chat message id".to_string());
    }
    if user_text.trim().is_empty() || user_text.len() > MAX_REMOTE_CHAT_USER_TEXT_BYTES {
        return Err("invalid remote chat user text".to_string());
    }
    if assistant_text.len() > MAX_REMOTE_CHAT_UI_ASSISTANT_TEXT_BYTES {
        return Err("remote chat assistant text is too long".to_string());
    }

    let mut session = remote_chat_ui_session_for_project(project_id, session_id)?;
    if append_remote_chat_text_turns(
        &mut session,
        message_id,
        user_text,
        assistant_text,
        remote_chat_now_millis(),
    )? {
        write_chat_ui_session_file(session_id, session)?;
    }
    Ok(())
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
            .map(|s| s.logical_message_count())
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

#[tauri::command]
pub fn chat_ui_sessions_list() -> Result<Value, String> {
    // Reads only the summary index — no turn bodies are touched, so the sidebar
    // list stays fast regardless of how large the conversation history grows.
    Ok(Value::Array(read_chat_ui_index()?))
}

fn chat_ui_session_load_blocking(id: String) -> Result<Value, String> {
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
pub async fn chat_ui_session_load(id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || chat_ui_session_load_blocking(id))
        .await
        .map_err(|error| error.to_string())?
}

fn chat_ui_turn_load_blocking(id: String, turn_index: usize) -> Result<Value, String> {
    validate_chat_ui_session_id(&id)?;
    ensure_chat_ui_migrated()?;
    let raw = match fs::read_to_string(chat_ui_session_file_path(&id)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err("chat UI session not found".to_string());
        }
        Err(error) => return Err(error.to_string()),
    };
    let Some((array_start, array_end)) = find_turns_array_bounds(&raw) else {
        return Err("chat UI session has no turns array".to_string());
    };
    turn_from_array_index(&raw, array_start, array_end, turn_index)?
        .ok_or_else(|| "chat UI turn not found".to_string())
}

#[tauri::command]
pub async fn chat_ui_turn_load(id: String, turn_index: usize) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || chat_ui_turn_load_blocking(id, turn_index))
        .await
        .map_err(|error| error.to_string())?
}

fn chat_ui_session_save_blocking(session: Value) -> Result<(), String> {
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
        let merged_remote_turns = merge_missing_remote_chat_ui_turns(&mut next, &stored);
        preserve_remote_chat_updated_at(&mut next, &stored, merged_remote_turns);
    }

    write_chat_ui_session_file(&id, next)
}

#[tauri::command]
pub async fn chat_ui_session_save(session: Value, app: AppHandle) -> Result<(), String> {
    let id = chat_ui_session_id(&session)
        .ok_or_else(|| "chat UI session must include an id".to_string())?
        .to_string();
    let (latest_user_turn_id, assistant_complete) =
        chat_ui_session_review_checkpoint(&session);
    let context_tokens = session.get("contextTokens").and_then(Value::as_u64);
    let context_tokens_user_turn_id = session
        .get("contextTokensUserTurnId")
        .and_then(Value::as_str)
        .map(str::to_string);
    tauri::async_runtime::spawn_blocking(move || chat_ui_session_save_blocking(session))
        .await
        .map_err(|error| error.to_string())??;
    let _ = app.emit(
        "chat-ui-session-updated",
        json!({
            "sessionId": id,
            "operation": "saved",
            "latestUserTurnId": latest_user_turn_id,
            "assistantComplete": assistant_complete,
            "contextTokens": context_tokens,
            "contextTokensUserTurnId": context_tokens_user_turn_id,
        }),
    );
    Ok(())
}

fn chat_ui_session_review_checkpoint(session: &Value) -> (Option<String>, bool) {
    let turns = session
        .get("turns")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let latest_user_turn_id = turns.iter().rev().find_map(|turn| {
        (turn.get("role").and_then(Value::as_str) == Some("user"))
            .then(|| turn.get("id").and_then(Value::as_str).map(str::to_string))
            .flatten()
    });
    let assistant_complete = turns.last().is_some_and(|turn| {
        turn.get("role").and_then(Value::as_str) == Some("assistant")
            && turn.get("streaming").and_then(Value::as_bool) != Some(true)
    });
    (latest_user_turn_id, assistant_complete)
}

#[tauri::command]
pub fn chat_ui_session_delete(id: String, app: AppHandle) -> Result<(), String> {
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
    upsert_chat_ui_index(&id, None)?;
    let _ = app.emit(
        "chat-ui-session-updated",
        json!({ "sessionId": id, "operation": "deleted" }),
    );
    Ok(())
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
#[path = "tests/sessions.rs"]
mod tests;
