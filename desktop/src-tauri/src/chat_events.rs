use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use runtime::{
    ContentBlock, ConversationMessage, MessageRole, Session, SessionCompactionRecord, TokenUsage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

const EVENT_VERSION: u32 = 1;
const DEFAULT_WIRE_TRACE_MAX_STRING_CHARS: usize = 64_000;
const DEFAULT_WIRE_TRACE_MAX_BYTES: u64 = 50 * 1024 * 1024;
const DEFAULT_WIRE_TRACE_ROTATIONS: usize = 3;
const MAX_WIRE_TRACE_ROTATIONS: usize = 10;

#[derive(Debug, Clone, Copy)]
struct EventSeqState {
    seq: u64,
    bytes: u64,
}

static EVENT_SEQS: OnceLock<Mutex<HashMap<String, EventSeqState>>> = OnceLock::new();
static WIRE_SEQS: OnceLock<Mutex<HashMap<String, EventSeqState>>> = OnceLock::new();
static SESSION_EVENT_DIRS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

pub struct SessionEventDirGuard {
    session_id: String,
}

impl Drop for SessionEventDirGuard {
    fn drop(&mut self) {
        if let Ok(mut dirs) = session_event_dirs().lock() {
            dirs.remove(&self.session_id);
        }
    }
}

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

fn event_seqs() -> &'static Mutex<HashMap<String, EventSeqState>> {
    EVENT_SEQS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn wire_seqs() -> &'static Mutex<HashMap<String, EventSeqState>> {
    WIRE_SEQS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_event_dirs() -> &'static Mutex<HashMap<String, PathBuf>> {
    SESSION_EVENT_DIRS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn bind_session_event_dir(
    session_id: &str,
    sessions_dir: PathBuf,
) -> Result<SessionEventDirGuard, String> {
    validate_session_id(session_id)?;
    session_event_dirs()
        .lock()
        .map_err(|_| "chat event state poisoned".to_string())?
        .insert(session_id.to_string(), sessions_dir);
    Ok(SessionEventDirGuard {
        session_id: session_id.to_string(),
    })
}

fn session_events_dir(session_id: &str) -> PathBuf {
    session_event_dirs()
        .lock()
        .ok()
        .and_then(|dirs| dirs.get(session_id).cloned())
        .unwrap_or_else(crate::state::sessions_dir)
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
    Ok(session_events_dir(session_id).join(format!("{session_id}.events.jsonl")))
}

pub fn chat_event_log_exists(session_id: &str) -> bool {
    chat_event_log_path(session_id).is_ok_and(|path| path.exists())
}

pub fn chat_wire_log_path(session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(session_events_dir(session_id).join(format!("{session_id}.wire.jsonl")))
}

pub fn chat_wire_rotated_log_paths(session_id: &str) -> Result<Vec<PathBuf>, String> {
    let path = chat_wire_log_path(session_id)?;
    Ok((1..=wire_trace_rotation_count())
        .map(|index| rotated_wire_log_path(&path, index))
        .collect())
}

pub fn remove_chat_wire_logs(session_id: &str) -> Result<(), String> {
    let mut paths = vec![chat_wire_log_path(session_id)?];
    paths.extend(chat_wire_rotated_log_paths(session_id)?);
    for path in paths {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to remove {}: {error}", path.display())),
        }
    }
    Ok(())
}

pub fn chat_wire_log_exists(session_id: &str) -> bool {
    chat_wire_log_path(session_id).is_ok_and(|path| path.exists())
}

/// Where the tail scan for the newest sequence starts, and how fast it backs
/// off. One archived compaction row can be megabytes on its own, so the window
/// has to be able to grow past a single line.
const SEQ_TAIL_SCAN_BYTES: u64 = 64 * 1024;
const SEQ_TAIL_SCAN_GROWTH: u64 = 16;

/// Newest sequence in an event log.
///
/// Sequences are assigned under the path lock in append order, so the last
/// well-formed row carries the maximum and there is no reason to decode the
/// whole log — which on a long session meant re-reading tens of megabytes
/// every time the in-process sequence cache missed.
fn read_last_seq(path: &Path) -> Result<u64, String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    let len = file.metadata().map_err(|error| error.to_string())?.len();
    if len == 0 {
        return Ok(0);
    }
    let mut window = SEQ_TAIL_SCAN_BYTES;
    loop {
        let start = len.saturating_sub(window);
        file.seek(SeekFrom::Start(start))
            .map_err(|error| error.to_string())?;
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer)
            .map_err(|error| error.to_string())?;
        let text = String::from_utf8_lossy(&buffer);
        let mut lines = text.split('\n').collect::<Vec<_>>();
        // The window can start mid-row; that partial line is never the newest.
        if start > 0 && !lines.is_empty() {
            lines.remove(0);
        }
        if let Some(seq) = lines.iter().rev().find_map(|line| {
            (!line.trim().is_empty())
                .then(|| serde_json::from_str::<ChatEventHeader>(line).ok())
                .flatten()
                .map(|header| header.seq)
        }) {
            return Ok(seq);
        }
        if start == 0 {
            // Nothing in the log parses. A fresh sequence is the only option
            // that keeps the session writable.
            return Ok(0);
        }
        window = window.saturating_mul(SEQ_TAIL_SCAN_GROWTH);
    }
}

fn append_jsonl_entry(file: &mut fs::File, entry: &ChatEventLogEntry) -> Result<(), String> {
    // `serde_json::to_writer` can issue several writes. When another desktop
    // process has the same event log open for append, those fragments can be
    // interleaved into invalid JSON. Encode first and append one complete line.
    let mut encoded = serde_json::to_vec(entry).map_err(|error| error.to_string())?;
    encoded.push(b'\n');
    file.write_all(&encoded)
        .map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())
}

pub fn append_event(
    session_id: &str,
    kind: impl Into<String>,
    payload: Value,
) -> Result<ChatEventLogEntry, String> {
    validate_session_id(session_id)?;
    let path = chat_event_log_path(session_id)?;
    let kind = kind.into();
    runtime::with_path_lock(&path, || {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let current_bytes = fs::metadata(&path)
            .map(|meta| meta.len())
            .unwrap_or_default();

        let mut seqs = event_seqs()
            .lock()
            .map_err(|_| "chat event state poisoned".to_string())?;
        let last = match seqs.get(session_id).copied() {
            Some(state) if state.bytes == current_bytes => state.seq,
            None => {
                let seq = read_last_seq(&path)?;
                seqs.insert(
                    session_id.to_string(),
                    EventSeqState {
                        seq,
                        bytes: current_bytes,
                    },
                );
                seq
            }
            Some(_) => {
                let seq = read_last_seq(&path)?;
                seqs.insert(
                    session_id.to_string(),
                    EventSeqState {
                        seq,
                        bytes: current_bytes,
                    },
                );
                seq
            }
        };
        let entry = ChatEventLogEntry {
            version: EVENT_VERSION,
            seq: last.saturating_add(1),
            ts: now_millis(),
            session_id: session_id.to_string(),
            kind,
            payload,
        };
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        append_jsonl_entry(&mut file, &entry)?;
        let bytes = file
            .metadata()
            .map(|meta| meta.len())
            .unwrap_or(current_bytes);
        seqs.insert(
            session_id.to_string(),
            EventSeqState {
                seq: entry.seq,
                bytes,
            },
        );
        Ok(entry)
    })
}

pub fn append_wire_event(
    session_id: &str,
    kind: impl Into<String>,
    payload: Value,
) -> Result<ChatEventLogEntry, String> {
    if !wire_trace_enabled() {
        return Err("chat wire trace disabled".to_string());
    }
    validate_session_id(session_id)?;
    let path = chat_wire_log_path(session_id)?;
    let kind = kind.into();
    runtime::with_path_lock(&path, || {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        rotate_wire_log_if_needed(&path)?;
        let current_bytes = fs::metadata(&path)
            .map(|meta| meta.len())
            .unwrap_or_default();

        let mut seqs = wire_seqs()
            .lock()
            .map_err(|_| "chat wire trace state poisoned".to_string())?;
        let last = match seqs.get(session_id).copied() {
            Some(state) if state.bytes == current_bytes => state.seq,
            None => {
                let seq = read_last_seq(&path)?;
                seqs.insert(
                    session_id.to_string(),
                    EventSeqState {
                        seq,
                        bytes: current_bytes,
                    },
                );
                seq
            }
            Some(_) => {
                let seq = read_last_seq(&path)?;
                seqs.insert(
                    session_id.to_string(),
                    EventSeqState {
                        seq,
                        bytes: current_bytes,
                    },
                );
                seq
            }
        };
        let entry = ChatEventLogEntry {
            version: EVENT_VERSION,
            seq: last.saturating_add(1),
            ts: now_millis(),
            session_id: session_id.to_string(),
            kind,
            payload: govern_wire_payload(payload),
        };
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        append_jsonl_entry(&mut file, &entry)?;
        let bytes = file
            .metadata()
            .map(|meta| meta.len())
            .unwrap_or(current_bytes);
        seqs.insert(
            session_id.to_string(),
            EventSeqState {
                seq: entry.seq,
                bytes,
            },
        );
        Ok(entry)
    })
}

pub fn record_event(session_id: &str, kind: &str, payload: Value) {
    if let Err(error) = append_event(session_id, kind, payload) {
        eprintln!("SomniQ desktop: failed to write chat event log: {error}");
    }
}

pub fn record_wire_event(session_id: &str, kind: &str, payload: Value) {
    if !wire_trace_enabled() || !should_record_wire_event(kind, wire_trace_raw_sse_enabled()) {
        return;
    }
    if let Err(error) = append_wire_event(session_id, kind, payload) {
        eprintln!("SomniQ desktop: failed to write chat wire trace: {error}");
    }
}

fn should_record_wire_event(kind: &str, include_raw_sse: bool) -> bool {
    include_raw_sse || kind != "llm.raw_sse"
}

fn wire_trace_enabled() -> bool {
    std::env::var("ARIS_WIRE_TRACE")
        .ok()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            !matches!(normalized.as_str(), "0" | "false" | "off" | "no")
        })
        .unwrap_or(true)
}

fn wire_trace_raw_sse_enabled() -> bool {
    std::env::var("ARIS_WIRE_TRACE_RAW_SSE")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "on" | "yes"
            )
        })
}

fn wire_trace_max_string_chars() -> usize {
    std::env::var("ARIS_WIRE_TRACE_MAX_STRING_CHARS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_WIRE_TRACE_MAX_STRING_CHARS)
}

fn wire_trace_max_bytes() -> u64 {
    std::env::var("ARIS_WIRE_TRACE_MAX_BYTES")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_WIRE_TRACE_MAX_BYTES)
}

fn wire_trace_rotation_count() -> usize {
    std::env::var("ARIS_WIRE_TRACE_ROTATIONS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_WIRE_TRACE_ROTATIONS))
        .unwrap_or(DEFAULT_WIRE_TRACE_ROTATIONS)
}

fn rotated_wire_log_path(path: &Path, index: usize) -> PathBuf {
    // `with_extension` replaces only the final extension.  For
    // `<session>.wire.jsonl` it would therefore produce
    // `<session>.wire.wire.jsonl.1`, while the debug export expects
    // `<session>.wire.jsonl.1`.
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("wire.jsonl");
    path.with_file_name(format!("{file_name}.{index}"))
}

fn rotate_wire_log_if_needed(path: &Path) -> Result<(), String> {
    let max_bytes = wire_trace_max_bytes();
    if max_bytes == 0 || !path.exists() {
        return Ok(());
    }
    let current_bytes = fs::metadata(path)
        .map(|meta| meta.len())
        .unwrap_or_default();
    if current_bytes < max_bytes {
        return Ok(());
    }
    for index in (1..=wire_trace_rotation_count()).rev() {
        let source = if index == 1 {
            path.to_path_buf()
        } else {
            rotated_wire_log_path(path, index - 1)
        };
        if !source.exists() {
            continue;
        }
        let destination = rotated_wire_log_path(path, index);
        if destination.exists() {
            fs::remove_file(&destination).map_err(|error| error.to_string())?;
        }
        fs::rename(source, destination).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn govern_wire_payload(payload: Value) -> Value {
    govern_wire_value(payload, None, wire_trace_max_string_chars())
}

fn govern_wire_value(value: Value, key: Option<&str>, max_string_chars: usize) -> Value {
    if key.is_some_and(is_sensitive_wire_key) {
        return Value::String("<redacted>".to_string());
    }
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    let value = govern_wire_value(value, Some(&key), max_string_chars);
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| govern_wire_value(item, key, max_string_chars))
                .collect(),
        ),
        Value::String(text) => govern_wire_string(key, text, max_string_chars),
        other => other,
    }
}

fn govern_wire_string(key: Option<&str>, text: String, max_string_chars: usize) -> Value {
    let char_count = text.chars().count();
    if key.is_some_and(is_binary_wire_key) && char_count > 256 {
        return json!({
            "redacted": true,
            "reason": "binary_or_base64_payload",
            "chars": char_count,
        });
    }
    if looks_like_secret_bearing_string(&text) {
        return Value::String("<redacted>".to_string());
    }
    if char_count <= max_string_chars {
        return Value::String(text);
    }
    json!({
        "truncated": true,
        "chars": char_count,
        "preview": text.chars().take(max_string_chars).collect::<String>(),
    })
}

fn is_sensitive_wire_key(key: &str) -> bool {
    let normalized = key
        .bytes()
        .filter(u8::is_ascii_alphanumeric)
        .map(char::from)
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "apikey"
            | "xapikey"
            | "openaiapikey"
            | "authorization"
            | "proxyauthorization"
            | "password"
            | "secret"
            | "clientsecret"
            | "token"
            | "bearertoken"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "clienttoken"
            | "servicetoken"
            | "xapitoken"
            | "httpauthtoken"
            | "oauthbearer"
    )
}

fn is_binary_wire_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "data" | "image" | "bytes" | "base64" | "content_bytes"
    )
}

fn looks_like_secret_bearing_string(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("bearer ")
        || lower.contains("authorization:")
        || lower.contains("api_key=")
        || lower.contains("apikey=")
        || lower.contains("access_token=")
        || lower.contains("refresh_token=")
        || lower.contains("token=")
        || lower.contains("sk-")
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
        "compactionCount": session.compactions.len(),
        "storage": "event_log",
    });
    record_event(session_id, "session_checkpoint", payload);
    compact_session_log(session_id);
}

/// Collect the streaming rows the checkpoint just superseded.
///
/// Best-effort: the checkpoint is already durable, so a failed compaction
/// costs disk, not history.
fn compact_session_log(session_id: &str) {
    let Ok(path) = chat_event_log_path(session_id) else {
        return;
    };
    let compacted = runtime::with_path_lock(&path, || {
        runtime::compact_session_event_log_unlocked(&path)
    });
    match compacted {
        Ok(outcome) if outcome.removed_lines > 0 => {
            // The cached sequence is keyed on the file length, which the
            // rewrite just changed.
            if let Ok(mut seqs) = event_seqs().lock() {
                seqs.remove(session_id);
            }
        }
        Ok(_) => {}
        Err(error) => {
            eprintln!("SomniQ desktop: failed to compact chat event log: {error}");
        }
    }
}

/// Read an event log, optionally decoding only the kinds a caller needs.
///
/// A session log is dominated by streaming deltas and archived compaction
/// snapshots — a 98 MB log here is 140k lines of which a reader like the
/// independent-review restore wants six. `kinds` is matched against the raw
/// line before the JSON parser runs, so everything else costs a substring scan
/// instead of a decoded `Value`.
pub fn read_events_for_session(
    session_id: &str,
    kinds: Option<&[&str]>,
) -> Result<Vec<ChatEventLogEntry>, String> {
    let path = chat_event_log_path(session_id)?;
    read_events_from_path(session_id, &path, kinds)
}

/// Read a project-scoped event log without changing the process-wide live
/// binding used by an in-flight Chat turn.
pub fn read_events_for_session_in_dir(
    session_id: &str,
    sessions_dir: &Path,
    kinds: Option<&[&str]>,
) -> Result<Vec<ChatEventLogEntry>, String> {
    validate_session_id(session_id)?;
    read_events_from_path(session_id, &session_log_path(session_id, sessions_dir), kinds)
}

fn session_log_path(session_id: &str, sessions_dir: &Path) -> PathBuf {
    sessions_dir.join(format!("{session_id}.events.jsonl"))
}

fn read_events_from_path(
    session_id: &str,
    path: &Path,
    kinds: Option<&[&str]>,
) -> Result<Vec<ChatEventLogEntry>, String> {
    runtime::with_path_lock(path, || {
        read_events_from_path_unlocked(session_id, path, kinds)
    })
}

/// The `"kind":"<k>"` needles for a kind list. Entries are written by
/// [`append_jsonl_entry`] with compact `serde_json`, so the field always
/// renders in exactly this shape.
fn kind_needles(kinds: &[&str]) -> Vec<String> {
    kinds.iter().map(|kind| format!("\"kind\":\"{kind}\"")).collect()
}

/// Whether a raw line may carry one of `needles`.
///
/// A match is only a hint — the payload can contain the same text — so callers
/// still check the decoded `kind`. A line with no `"kind":` field at all is
/// treated as a candidate rather than dropped, so a hand-edited or
/// foreign-format row still reaches the parser that knows how to complain.
fn line_may_match(line: &str, needles: &[String]) -> bool {
    if !line.contains("\"kind\":\"") {
        return true;
    }
    needles.iter().any(|needle| line.contains(needle.as_str()))
}

/// Everything but the payload. Deserializing into this skips the payload
/// structurally instead of materializing it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatEventHeader {
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    kind: String,
}

fn open_event_log(path: &Path) -> Result<Option<fs::File>, String> {
    match fs::File::open(path) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn read_events_from_path_unlocked(
    session_id: &str,
    path: &Path,
    kinds: Option<&[&str]>,
) -> Result<Vec<ChatEventLogEntry>, String> {
    let Some(file) = open_event_log(path)? else {
        return Ok(Vec::new());
    };
    let needles = kinds.map(kind_needles);
    let mut out = Vec::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(needles) = needles.as_deref() {
            if !line_may_match(&line, needles) {
                continue;
            }
        }
        match serde_json::from_str::<ChatEventLogEntry>(&line) {
            Ok(entry)
                if entry.session_id == session_id
                    && kinds.is_none_or(|kinds| kinds.contains(&entry.kind.as_str())) =>
            {
                out.push(entry)
            }
            Ok(_) => {}
            Err(error) => {
                // Recovery logs are append-only. A malformed historical line
                // must not hide all later valid events or prevent a session
                // from reopening.
                eprintln!(
                    "SomniQ desktop: ignoring malformed chat event at line {}: {error}",
                    index + 1
                );
            }
        }
    }
    Ok(out)
}

/// Canonical kinds whose payload the replay projection reads.
///
/// `session_compaction` is deliberately absent: its payload is an archived
/// snapshot of every removed message (3 MB each, 45 MB of one real 98 MB log),
/// it is pushed into `Session::compactions`, and nothing in the replay ever
/// reads that field back.
const REPLAY_CANONICAL_KINDS: &[&str] = &[
    "session_reset",
    "session_message",
    "session_usage",
    "session_checkpoint",
];
const SESSION_COMPACTION_KIND: &str = "session_compaction";

#[derive(Default)]
struct ReplaySource {
    entries: Vec<ChatEventLogEntry>,
    total_events: usize,
}

struct ReplayBoundaries {
    /// Newest line `replay_events` treats as the canonical cut-off — the last
    /// checkpoint, else the last canonical event. `None` when the log has no
    /// canonical events, which replays the whole UI stream exactly as before.
    boundary: Option<usize>,
    /// Only tracked when there is no checkpoint, which is the one case where
    /// the cut-off can land on an archived compaction.
    last_compaction: Option<usize>,
}

/// Locate the canonical cut-off without decoding payloads.
///
/// Events are appended under a path lock with a monotonic sequence, so file
/// order is sequence order and a line index stands in for the `seq` comparison
/// `replay_events` makes. A session is checkpointed on every save, so scanning
/// from the end normally settles within a few lines of the tail.
fn scan_replay_boundaries(session_id: &str, lines: &[&str]) -> ReplayBoundaries {
    let mut canonical_kinds = REPLAY_CANONICAL_KINDS.to_vec();
    canonical_kinds.push(SESSION_COMPACTION_KIND);
    let canonical_needles = kind_needles(&canonical_kinds);
    let mut last_canonical = None;
    let mut last_compaction = None;
    for (index, line) in lines.iter().enumerate().rev() {
        if !line_may_match(line, &canonical_needles) {
            continue;
        }
        let Ok(header) = serde_json::from_str::<ChatEventHeader>(line) else {
            continue;
        };
        if header.session_id != session_id {
            continue;
        }
        match header.kind.as_str() {
            // The newest checkpoint wins outright, so the scan can stop here.
            "session_checkpoint" => {
                return ReplayBoundaries {
                    boundary: Some(index),
                    last_compaction: None,
                }
            }
            SESSION_COMPACTION_KIND => {
                last_canonical = last_canonical.or(Some(index));
                last_compaction = last_compaction.or(Some(index));
            }
            kind if REPLAY_CANONICAL_KINDS.contains(&kind) => {
                last_canonical = last_canonical.or(Some(index))
            }
            _ => {}
        }
    }
    ReplayBoundaries {
        boundary: last_canonical,
        last_compaction,
    }
}

/// An archived compaction reduced to its header. Keeping the row lets the
/// cut-off logic in `replay_events` see the same canonical stream it always
/// did; dropping the payload is what makes reopening a long session cheap.
fn compaction_header_entry(session_id: &str, line: &str) -> Option<ChatEventLogEntry> {
    let header = serde_json::from_str::<ChatEventHeader>(line).ok()?;
    (header.session_id == session_id).then(|| ChatEventLogEntry {
        version: EVENT_VERSION,
        seq: header.seq,
        ts: 0,
        session_id: header.session_id,
        kind: header.kind,
        payload: Value::Null,
    })
}

/// Read only what the replay projection consumes: the canonical stream plus
/// every event after the latest checkpoint. Everything the cut-off would
/// discard anyway — which on a long session is ~98% of the lines — costs a
/// substring scan instead of a decoded payload.
fn read_events_for_replay(session_id: &str, path: &Path) -> Result<ReplaySource, String> {
    // One read, then two scans over the same buffer: the cut-off is only known
    // after looking at the tail, and re-reading a 280 MB log — or allocating a
    // String per line — costs more than holding it.
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ReplaySource::default())
        }
        Err(error) => return Err(error.to_string()),
    };
    let lines = raw
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    let boundaries = scan_replay_boundaries(session_id, &lines);

    let keep_needles = kind_needles(REPLAY_CANONICAL_KINDS);
    let session_needle = format!("\"sessionId\":\"{session_id}\"");
    let mut entries = Vec::new();
    let mut total_events = 0;
    for (index, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        if line.contains(session_needle.as_str()) {
            total_events += 1;
        }
        let after_boundary = boundaries.boundary.is_none_or(|boundary| index > boundary);
        if !after_boundary && !line_may_match(line, &keep_needles) {
            if boundaries.last_compaction == Some(index) {
                if let Some(entry) = compaction_header_entry(session_id, line) {
                    entries.push(entry);
                }
            }
            continue;
        }
        match serde_json::from_str::<ChatEventLogEntry>(line) {
            Ok(entry) if entry.session_id == session_id => entries.push(entry),
            Ok(_) => {}
            Err(error) => {
                eprintln!(
                    "SomniQ desktop: ignoring malformed chat event at line {}: {error}",
                    index + 1
                );
            }
        }
    }
    Ok(ReplaySource {
        entries,
        total_events,
    })
}

/// Replay one session's durable event log into the UI transcript.
pub fn replay_session_events(session_id: &str) -> Result<ChatEventsReplay, String> {
    let path = chat_event_log_path(session_id)?;
    replay_session_events_at(session_id, &path)
}

/// [`replay_session_events`] for a log outside the process-default event
/// directory, used by project-owned workflow sessions.
pub fn replay_session_events_in_dir(
    session_id: &str,
    sessions_dir: &Path,
) -> Result<ChatEventsReplay, String> {
    validate_session_id(session_id)?;
    replay_session_events_at(session_id, &session_log_path(session_id, sessions_dir))
}

fn replay_session_events_at(session_id: &str, path: &Path) -> Result<ChatEventsReplay, String> {
    let source = runtime::with_path_lock(path, || read_events_for_replay(session_id, path))?;
    let mut replay = replay_events(session_id, &source.entries);
    replay.event_count = source.total_events;
    Ok(replay)
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

pub fn export_wire_to_path(session_id: &str, target: &Path) -> Result<(), String> {
    let source = chat_wire_log_path(session_id)?;
    if !source.exists() {
        return Err("chat wire trace not found".to_string());
    }
    let data = fs::read(source).map_err(|error| error.to_string())?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    runtime::write_file_atomically(target, data).map_err(|error| error.to_string())
}

/// Read a session's event log, optionally narrowed to the kinds the caller
/// consumes.
///
/// Async on purpose: Tauri runs a blocking command on the main thread, and a
/// session log is unbounded, so decoding one there is a window the OS marks as
/// not responding rather than a slow load.
#[tauri::command]
pub async fn chat_events_read(
    session_id: String,
    kinds: Option<Vec<String>>,
) -> Result<Vec<ChatEventLogEntry>, String> {
    crate::blocking::off_main_thread(move || {
        let kinds = kinds
            .as_ref()
            .map(|kinds| kinds.iter().map(String::as_str).collect::<Vec<_>>());
        read_events_for_session(&session_id, kinds.as_deref())
    })
    .await
}

/// See [`chat_events_read`] for why this is async.
#[tauri::command]
pub async fn chat_events_replay(session_id: String) -> Result<ChatEventsReplay, String> {
    crate::blocking::off_main_thread(move || replay_session_events(&session_id)).await
}

/// Build the bounded UI transcript from an explicitly scoped event stream.
/// Project-owned workflow sessions use this instead of the process-default
/// event directory so a cold restart cannot lose their transcript binding.
pub fn replay_events(session_id: &str, events: &[ChatEventLogEntry]) -> ChatEventsReplay {
    // The canonical stream is the durable source of truth after a session
    // save. UI stream events before its latest checkpoint can describe an
    // earlier session generation (for example, before `/clear`), so never
    // replay them over the canonical projection. UI events after that point
    // remain useful for an in-flight turn that has not reached disk yet.
    let (mut turns, replay_after_seq) = if events.iter().any(is_canonical_session_event) {
        match canonical_session_from_events(events) {
            Ok(session) => {
                let checkpoint = events
                    .iter()
                    .rev()
                    .find(|event| event.kind == "session_checkpoint")
                    .or_else(|| {
                        events
                            .iter()
                            .rev()
                            .find(|event| is_canonical_session_event(event))
                    })
                    .map(|event| event.seq)
                    .unwrap_or_default();
                (turns_from_session(&session), checkpoint)
            }
            // A malformed historical canonical entry must not block recovery
            // from a valid UI event stream.
            Err(_) => (Vec::new(), 0),
        }
    } else {
        (Vec::new(), 0)
    };

    for event in events.iter().filter(|event| event.seq > replay_after_seq) {
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
            "tool_progress" | "tool_timeout" => {
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
                if let Some(turn) = turns
                    .last_mut()
                    .filter(|turn| turn.get("role").and_then(Value::as_str) == Some("assistant"))
                {
                    if let Some(object) = turn.as_object_mut() {
                        object.insert("streaming".to_string(), Value::Bool(false));
                    }
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

/// Reconstruct the most complete runtime-shaped session available from UI
/// stream events. This is used only for diagnostics when a turn was stopped
/// before its canonical session projection reached disk. It deliberately does
/// not mutate or resume the live conversation.
pub fn recover_session_for_export(session_id: &str, events: &[ChatEventLogEntry]) -> Session {
    let replay = replay_events(session_id, events);
    let mut session = Session::new();
    for turn in replay.turns {
        let Some(object) = turn.as_object() else {
            continue;
        };
        let role = object
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let blocks = object
            .get("blocks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if role == "user" {
            let recovered = blocks
                .iter()
                .filter_map(recovered_visible_block)
                .collect::<Vec<_>>();
            if !recovered.is_empty() {
                session
                    .messages
                    .push(ConversationMessage::user_blocks(recovered));
            }
            continue;
        }
        if role != "assistant" {
            continue;
        }

        let mut assistant_blocks = Vec::new();
        let mut tool_results = Vec::new();
        for block in &blocks {
            let kind = block
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if matches!(kind, "text" | "thinking" | "notice" | "permission")
                && !tool_results.is_empty()
            {
                flush_recovered_assistant_segment(
                    &mut session,
                    &mut assistant_blocks,
                    &mut tool_results,
                );
            }
            match kind {
                "text" => assistant_blocks.push(ContentBlock::Text {
                    text: block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                }),
                "thinking" => assistant_blocks.push(ContentBlock::Thinking {
                    thinking: block
                        .get("thinking")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    signature: String::new(),
                }),
                "tool" => {
                    let id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    assistant_blocks.push(ContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: block
                            .get("input")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    });
                    if let Some(output) = block.get("output").and_then(Value::as_str) {
                        tool_results.push(ContentBlock::ToolResult {
                            tool_use_id: id,
                            tool_name: name,
                            output: output.to_string(),
                            is_error: block
                                .get("isError")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        });
                    }
                }
                "notice" | "permission" => assistant_blocks.push(ContentBlock::Text {
                    text: format!(
                        "[{}] {}",
                        kind,
                        block
                            .get("message")
                            .or_else(|| block.get("status"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                    ),
                }),
                _ => {}
            }
        }
        if let Some(error) = object.get("error").and_then(Value::as_str) {
            if !error.is_empty() {
                if !tool_results.is_empty() {
                    flush_recovered_assistant_segment(
                        &mut session,
                        &mut assistant_blocks,
                        &mut tool_results,
                    );
                }
                assistant_blocks.push(ContentBlock::Text {
                    text: format!("[error] {error}"),
                });
            }
        }
        flush_recovered_assistant_segment(&mut session, &mut assistant_blocks, &mut tool_results);
    }
    session
}

fn recovered_visible_block(block: &Value) -> Option<ContentBlock> {
    match block.get("kind").and_then(Value::as_str) {
        Some("text") => Some(ContentBlock::Text {
            text: block.get("text")?.as_str()?.to_string(),
        }),
        Some("notice") => Some(ContentBlock::Text {
            text: block.get("message")?.as_str()?.to_string(),
        }),
        _ => None,
    }
}

fn flush_recovered_assistant_segment(
    session: &mut Session,
    assistant_blocks: &mut Vec<ContentBlock>,
    tool_results: &mut Vec<ContentBlock>,
) {
    if !assistant_blocks.is_empty() {
        session
            .messages
            .push(ConversationMessage::assistant(std::mem::take(
                assistant_blocks,
            )));
    }
    if !tool_results.is_empty() {
        session.messages.push(ConversationMessage {
            role: MessageRole::Tool,
            blocks: std::mem::take(tool_results),
            usage: None,
        });
    }
}

fn is_canonical_session_event(event: &ChatEventLogEntry) -> bool {
    matches!(
        event.kind.as_str(),
        "session_reset"
            | "session_message"
            | "session_compaction"
            | "session_usage"
            | "session_checkpoint"
    )
}

fn turns_from_session(session: &Session) -> Vec<Value> {
    let mut turns = Vec::new();
    for (message_index, message) in session.messages.iter().enumerate() {
        match message.role {
            MessageRole::User => turns.push(json!({
                "id": format!("session-{message_index}-user"),
                "role": "user",
                "blocks": ui_blocks_from_message(message),
                "streaming": false,
            })),
            MessageRole::Assistant => turns.push(json!({
                "id": format!("session-{message_index}-assistant"),
                "role": "assistant",
                "blocks": ui_blocks_from_message(message),
                "streaming": false,
            })),
            MessageRole::Tool => merge_tool_message_into_turns(&mut turns, message, message_index),
            MessageRole::System => {}
        }
    }
    turns
}

fn ui_blocks_from_message(message: &ConversationMessage) -> Vec<Value> {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(json!({ "kind": "text", "text": text })),
            ContentBlock::Thinking { thinking, .. } => {
                Some(json!({ "kind": "thinking", "thinking": thinking }))
            }
            ContentBlock::Image { media_type, .. } => Some(json!({
                "kind": "notice",
                "message": format!("[Image: {media_type}]"),
            })),
            ContentBlock::ToolUse { id, name, input } => Some(json!({
                "kind": "tool",
                "id": id,
                "name": name,
                "input": input,
            })),
            ContentBlock::ToolResult {
                tool_use_id,
                tool_name,
                output,
                is_error,
            } => Some(json!({
                "kind": "tool",
                "id": tool_use_id,
                "name": tool_name,
                "input": "{}",
                "output": output,
                "isError": is_error,
            })),
        })
        .collect()
}

fn merge_tool_message_into_turns(
    turns: &mut Vec<Value>,
    message: &ConversationMessage,
    message_index: usize,
) {
    if !turns
        .last()
        .and_then(Value::as_object)
        .and_then(|object| object.get("role"))
        .and_then(Value::as_str)
        .is_some_and(|role| role == "assistant")
    {
        turns.push(json!({
            "id": format!("session-{message_index}-assistant"),
            "role": "assistant",
            "blocks": [],
            "streaming": false,
        }));
    }
    let blocks = ensure_assistant_turn(turns, message_index as u64);
    for block in &message.blocks {
        let ContentBlock::ToolResult {
            tool_use_id,
            tool_name,
            output,
            is_error,
        } = block
        else {
            continue;
        };
        let payload = json!({
            "id": tool_use_id,
            "name": tool_name,
            "output": output,
            "isError": is_error,
        });
        append_tool_result(blocks, &payload);
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
        // Grow the existing string in place. Rebuilding it per delta is
        // quadratic in the block's length, and a stopped turn can replay
        // hundreds of thousands of deltas into one block.
        match object.get_mut(field) {
            Some(Value::String(existing)) => existing.push_str(delta),
            _ => {
                object.insert(field.to_string(), Value::String(delta.to_string()));
            }
        }
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
            if let Some(ready) = payload.get("ready").and_then(Value::as_bool) {
                object.insert("ready".to_string(), Value::Bool(ready));
            }
        }
        return;
    }
    let mut block = json!({
        "kind": "tool",
        "id": if id.is_empty() { Value::Null } else { Value::String(id.to_string()) },
        "name": name,
        "input": input,
    });
    if let (Some(object), Some(ready)) = (
        block.as_object_mut(),
        payload.get("ready").and_then(Value::as_bool),
    ) {
        object.insert("ready".to_string(), Value::Bool(ready));
    }
    blocks.push(block);
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

fn canonical_session_from_events(events: &[ChatEventLogEntry]) -> Result<Session, String> {
    let mut session = Session::new();
    for event in events {
        match event.kind.as_str() {
            "session_reset" => session = Session::new(),
            "session_message" => {
                if let Some(value) = event.payload.get("message") {
                    session.messages.push(message_from_value(value)?);
                }
            }
            "session_compaction" => {
                if let Some(value) = event.payload.get("compaction") {
                    session.compactions.push(compaction_from_value(value)?);
                }
            }
            "session_usage" => {
                let Some(message_index) = event
                    .payload
                    .get("messageIndex")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                else {
                    continue;
                };
                let Some(usage) = event.payload.get("usage").and_then(usage_from_value) else {
                    continue;
                };
                if let Some(message) = session.messages.get_mut(message_index) {
                    message.usage = Some(usage);
                }
            }
            _ => {}
        }
    }
    Ok(session)
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
#[path = "tests/chat_events.rs"]
mod tests;
