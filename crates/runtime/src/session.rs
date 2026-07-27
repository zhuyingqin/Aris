use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::json::{JsonError, JsonValue};
use crate::usage::TokenUsage;
use serde_json::{json, Value as SerdeValue};

const SESSION_EVENT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Image {
        media_type: String,
        data: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: String,
    },
    ToolResult {
        tool_use_id: String,
        tool_name: String,
        output: String,
        is_error: bool,
    },
    Thinking {
        thinking: String,
        signature: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationMessage {
    pub role: MessageRole,
    pub blocks: Vec<ContentBlock>,
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub version: u32,
    pub messages: Vec<ConversationMessage>,
    pub compactions: Vec<SessionCompactionRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCompactionRecord {
    pub summary: String,
    pub messages: Vec<ConversationMessage>,
    pub removed_message_count: usize,
    pub preserved_message_count: usize,
    pub tokens_before: usize,
    pub tokens_after: usize,
    pub summary_source: String,
}

#[derive(Debug)]
pub enum SessionError {
    Io(std::io::Error),
    Json(JsonError),
    Format(String),
}

impl Display for SessionError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Json(error) => write!(f, "{error}"),
            Self::Format(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<std::io::Error> for SessionError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<JsonError> for SessionError {
    fn from(value: JsonError) -> Self {
        Self::Json(value)
    }
}

impl Session {
    #[must_use]
    pub fn new() -> Self {
        Self {
            version: 1,
            messages: Vec::new(),
            compactions: Vec::new(),
        }
    }

    /// Return the user-visible conversation in chronological order.
    ///
    /// Compaction moves an older prefix into `compactions[].messages` and
    /// inserts an internal continuation message into the live message list.
    /// Consumers that present session history should use this projection so
    /// archived originals remain visible while synthetic continuation prompts
    /// do not appear as user messages.
    #[must_use]
    pub fn logical_messages(&self) -> Vec<&ConversationMessage> {
        self.compactions
            .iter()
            .flat_map(|record| record.messages.iter())
            .chain(self.messages.iter())
            .filter(|message| !crate::compact::is_internal_user_message(message))
            .collect()
    }

    /// Count the user-visible messages across the compaction archive and the
    /// current model context.
    #[must_use]
    pub fn logical_message_count(&self) -> usize {
        self.compactions
            .iter()
            .flat_map(|record| record.messages.iter())
            .chain(self.messages.iter())
            .filter(|message| !crate::compact::is_internal_user_message(message))
            .count()
    }

    /// Save session as an append-only event stream.
    ///
    /// The `<session>.json` file is now a small manifest/projection marker; the
    /// recoverable source of truth is the sibling `<session>.events.jsonl`.
    pub fn save_to_path(&self, path: impl AsRef<Path>) -> Result<(), SessionError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let event_path = session_event_log_path(path);
        crate::with_path_lock(&event_path, || -> Result<(), SessionError> {
            append_canonical_session_events(path, &event_path, self)?;
            let manifest = session_manifest_json(path, self).render();
            crate::atomic_file::write_replace_unlocked(path, manifest.as_bytes())?;
            Ok(())
        })?;
        if crate::session_index::should_index_session_path(path) {
            let _ = crate::session_index::index_session(path, self);
        }
        Ok(())
    }

    pub fn load_from_path(path: impl AsRef<Path>) -> Result<Self, SessionError> {
        let path = path.as_ref();
        let event_path = session_event_log_path(path);
        if event_path.exists() {
            let replayed = crate::with_path_lock(&event_path, || {
                replay_canonical_session_events(&event_path)
            })?;
            if replayed.saw_canonical {
                return Ok(replayed.session);
            }
        }

        let contents = fs::read_to_string(path)?;
        let value = JsonValue::parse(&contents)?;
        if is_session_event_manifest(&value) {
            return Ok(Session::new());
        }
        Self::from_json(&value)
    }

    #[must_use]
    pub fn to_json(&self) -> JsonValue {
        let mut object = BTreeMap::new();
        object.insert(
            "version".to_string(),
            JsonValue::Number(i64::from(self.version)),
        );
        object.insert(
            "messages".to_string(),
            JsonValue::Array(
                self.messages
                    .iter()
                    .map(ConversationMessage::to_json)
                    .collect(),
            ),
        );
        if !self.compactions.is_empty() {
            object.insert(
                "compactions".to_string(),
                JsonValue::Array(
                    self.compactions
                        .iter()
                        .map(SessionCompactionRecord::to_json)
                        .collect(),
                ),
            );
        }
        JsonValue::Object(object)
    }

    pub fn from_json(value: &JsonValue) -> Result<Self, SessionError> {
        let object = value
            .as_object()
            .ok_or_else(|| SessionError::Format("session must be an object".to_string()))?;
        let version = object
            .get("version")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| SessionError::Format("missing version".to_string()))?;
        let version = u32::try_from(version)
            .map_err(|_| SessionError::Format("version out of range".to_string()))?;
        let messages = object
            .get("messages")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| SessionError::Format("missing messages".to_string()))?
            .iter()
            .map(ConversationMessage::from_json)
            .collect::<Result<Vec<_>, _>>()?;
        let compactions = object
            .get("compactions")
            .and_then(JsonValue::as_array)
            .map(|values| {
                values
                    .iter()
                    .map(SessionCompactionRecord::from_json)
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            version,
            messages,
            compactions,
        })
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl ConversationMessage {
    #[must_use]
    pub fn user_text(text: impl Into<String>) -> Self {
        Self {
            role: MessageRole::User,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            usage: None,
        }
    }

    #[must_use]
    pub fn user_blocks(blocks: Vec<ContentBlock>) -> Self {
        Self {
            role: MessageRole::User,
            blocks,
            usage: None,
        }
    }

    #[must_use]
    pub fn assistant(blocks: Vec<ContentBlock>) -> Self {
        Self {
            role: MessageRole::Assistant,
            blocks,
            usage: None,
        }
    }

    #[must_use]
    pub fn assistant_with_usage(blocks: Vec<ContentBlock>, usage: Option<TokenUsage>) -> Self {
        Self {
            role: MessageRole::Assistant,
            blocks,
            usage,
        }
    }

    #[must_use]
    pub fn tool_result(
        tool_use_id: impl Into<String>,
        tool_name: impl Into<String>,
        output: impl Into<String>,
        is_error: bool,
    ) -> Self {
        Self {
            role: MessageRole::Tool,
            blocks: vec![ContentBlock::ToolResult {
                tool_use_id: tool_use_id.into(),
                tool_name: tool_name.into(),
                output: output.into(),
                is_error,
            }],
            usage: None,
        }
    }

    #[must_use]
    pub fn to_json(&self) -> JsonValue {
        let mut object = BTreeMap::new();
        object.insert(
            "role".to_string(),
            JsonValue::String(
                match self.role {
                    MessageRole::System => "system",
                    MessageRole::User => "user",
                    MessageRole::Assistant => "assistant",
                    MessageRole::Tool => "tool",
                }
                .to_string(),
            ),
        );
        object.insert(
            "blocks".to_string(),
            JsonValue::Array(self.blocks.iter().map(ContentBlock::to_json).collect()),
        );
        if let Some(usage) = self.usage {
            object.insert("usage".to_string(), usage_to_json(usage));
        }
        JsonValue::Object(object)
    }

    fn from_json(value: &JsonValue) -> Result<Self, SessionError> {
        let object = value
            .as_object()
            .ok_or_else(|| SessionError::Format("message must be an object".to_string()))?;
        let role = match object
            .get("role")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| SessionError::Format("missing role".to_string()))?
        {
            "system" => MessageRole::System,
            "user" => MessageRole::User,
            "assistant" => MessageRole::Assistant,
            "tool" => MessageRole::Tool,
            other => {
                return Err(SessionError::Format(format!(
                    "unsupported message role: {other}"
                )))
            }
        };
        let blocks = object
            .get("blocks")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| SessionError::Format("missing blocks".to_string()))?
            .iter()
            .map(ContentBlock::from_json)
            .collect::<Result<Vec<_>, _>>()?;
        let usage = object.get("usage").map(usage_from_json).transpose()?;
        Ok(Self {
            role,
            blocks,
            usage,
        })
    }
}

impl SessionCompactionRecord {
    #[must_use]
    pub fn to_json(&self) -> JsonValue {
        let mut object = BTreeMap::new();
        object.insert(
            "summary".to_string(),
            JsonValue::String(self.summary.clone()),
        );
        object.insert(
            "messages".to_string(),
            JsonValue::Array(
                self.messages
                    .iter()
                    .map(ConversationMessage::to_json)
                    .collect(),
            ),
        );
        object.insert(
            "removed_message_count".to_string(),
            JsonValue::Number(usize_to_i64(self.removed_message_count)),
        );
        object.insert(
            "preserved_message_count".to_string(),
            JsonValue::Number(usize_to_i64(self.preserved_message_count)),
        );
        object.insert(
            "tokens_before".to_string(),
            JsonValue::Number(usize_to_i64(self.tokens_before)),
        );
        object.insert(
            "tokens_after".to_string(),
            JsonValue::Number(usize_to_i64(self.tokens_after)),
        );
        object.insert(
            "summary_source".to_string(),
            JsonValue::String(self.summary_source.clone()),
        );
        JsonValue::Object(object)
    }

    fn from_json(value: &JsonValue) -> Result<Self, SessionError> {
        let object = value
            .as_object()
            .ok_or_else(|| SessionError::Format("compaction must be an object".to_string()))?;
        let summary = required_string(object, "summary")?;
        let messages = object
            .get("messages")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| SessionError::Format("missing compaction messages".to_string()))?
            .iter()
            .map(ConversationMessage::from_json)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            summary,
            messages,
            removed_message_count: optional_usize(object, "removed_message_count")?.unwrap_or(0),
            preserved_message_count: optional_usize(object, "preserved_message_count")?
                .unwrap_or(0),
            tokens_before: optional_usize(object, "tokens_before")?.unwrap_or(0),
            tokens_after: optional_usize(object, "tokens_after")?.unwrap_or(0),
            summary_source: object
                .get("summary_source")
                .and_then(JsonValue::as_str)
                .unwrap_or("unknown")
                .to_string(),
        })
    }
}

impl ContentBlock {
    #[must_use]
    pub fn to_json(&self) -> JsonValue {
        let mut object = BTreeMap::new();
        match self {
            Self::Text { text } => {
                object.insert("type".to_string(), JsonValue::String("text".to_string()));
                object.insert("text".to_string(), JsonValue::String(text.clone()));
            }
            Self::Image { media_type, data } => {
                object.insert("type".to_string(), JsonValue::String("image".to_string()));
                object.insert(
                    "media_type".to_string(),
                    JsonValue::String(media_type.clone()),
                );
                object.insert("data".to_string(), JsonValue::String(data.clone()));
            }
            Self::ToolUse { id, name, input } => {
                object.insert(
                    "type".to_string(),
                    JsonValue::String("tool_use".to_string()),
                );
                object.insert("id".to_string(), JsonValue::String(id.clone()));
                object.insert("name".to_string(), JsonValue::String(name.clone()));
                object.insert("input".to_string(), JsonValue::String(input.clone()));
            }
            Self::ToolResult {
                tool_use_id,
                tool_name,
                output,
                is_error,
            } => {
                object.insert(
                    "type".to_string(),
                    JsonValue::String("tool_result".to_string()),
                );
                object.insert(
                    "tool_use_id".to_string(),
                    JsonValue::String(tool_use_id.clone()),
                );
                object.insert(
                    "tool_name".to_string(),
                    JsonValue::String(tool_name.clone()),
                );
                object.insert("output".to_string(), JsonValue::String(output.clone()));
                object.insert("is_error".to_string(), JsonValue::Bool(*is_error));
            }
            Self::Thinking {
                thinking,
                signature,
            } => {
                object.insert(
                    "type".to_string(),
                    JsonValue::String("thinking".to_string()),
                );
                object.insert("thinking".to_string(), JsonValue::String(thinking.clone()));
                object.insert(
                    "signature".to_string(),
                    JsonValue::String(signature.clone()),
                );
            }
        }
        JsonValue::Object(object)
    }

    fn from_json(value: &JsonValue) -> Result<Self, SessionError> {
        let object = value
            .as_object()
            .ok_or_else(|| SessionError::Format("block must be an object".to_string()))?;
        match object
            .get("type")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| SessionError::Format("missing block type".to_string()))?
        {
            "text" => Ok(Self::Text {
                text: required_string(object, "text")?,
            }),
            "image" => Ok(Self::Image {
                media_type: required_string(object, "media_type")?,
                data: required_string(object, "data")?,
            }),
            "tool_use" => Ok(Self::ToolUse {
                id: required_string(object, "id")?,
                name: required_string(object, "name")?,
                input: required_string(object, "input")?,
            }),
            "tool_result" => Ok(Self::ToolResult {
                tool_use_id: required_string(object, "tool_use_id")?,
                tool_name: required_string(object, "tool_name")?,
                output: required_string(object, "output")?,
                is_error: object
                    .get("is_error")
                    .and_then(JsonValue::as_bool)
                    .ok_or_else(|| SessionError::Format("missing is_error".to_string()))?,
            }),
            "thinking" => Ok(Self::Thinking {
                thinking: required_string(object, "thinking")?,
                // Third-party Anthropic-compat proxies often omit the
                // redaction signature even on thinking blocks; treat as
                // optional with empty-string default to keep the JSON
                // parser from failing the whole conversation. Matches
                // the serde behaviour in api::types::{Input,Output}ContentBlock.
                signature: object
                    .get("signature")
                    .and_then(JsonValue::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_default(),
            }),
            other => Err(SessionError::Format(format!(
                "unsupported block type: {other}"
            ))),
        }
    }
}

fn usage_to_json(usage: TokenUsage) -> JsonValue {
    let mut object = BTreeMap::new();
    object.insert(
        "input_tokens".to_string(),
        JsonValue::Number(i64::from(usage.input_tokens)),
    );
    object.insert(
        "output_tokens".to_string(),
        JsonValue::Number(i64::from(usage.output_tokens)),
    );
    object.insert(
        "cache_creation_input_tokens".to_string(),
        JsonValue::Number(i64::from(usage.cache_creation_input_tokens)),
    );
    object.insert(
        "cache_read_input_tokens".to_string(),
        JsonValue::Number(i64::from(usage.cache_read_input_tokens)),
    );
    JsonValue::Object(object)
}

fn usage_from_json(value: &JsonValue) -> Result<TokenUsage, SessionError> {
    let object = value
        .as_object()
        .ok_or_else(|| SessionError::Format("usage must be an object".to_string()))?;
    Ok(TokenUsage {
        input_tokens: required_u32(object, "input_tokens")?,
        output_tokens: required_u32(object, "output_tokens")?,
        cache_creation_input_tokens: required_u32(object, "cache_creation_input_tokens")?,
        cache_read_input_tokens: required_u32(object, "cache_read_input_tokens")?,
    })
}

fn required_string(
    object: &BTreeMap<String, JsonValue>,
    key: &str,
) -> Result<String, SessionError> {
    object
        .get(key)
        .and_then(JsonValue::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| SessionError::Format(format!("missing {key}")))
}

fn required_u32(object: &BTreeMap<String, JsonValue>, key: &str) -> Result<u32, SessionError> {
    let value = object
        .get(key)
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| SessionError::Format(format!("missing {key}")))?;
    u32::try_from(value).map_err(|_| SessionError::Format(format!("{key} out of range")))
}

fn optional_usize(
    object: &BTreeMap<String, JsonValue>,
    key: &str,
) -> Result<Option<usize>, SessionError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    let value = value
        .as_i64()
        .ok_or_else(|| SessionError::Format(format!("{key} must be a number")))?;
    usize::try_from(value)
        .map(Some)
        .map_err(|_| SessionError::Format(format!("{key} out of range")))
}

fn usize_to_i64(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn session_event_log_path(path: &Path) -> PathBuf {
    path.with_extension("events.jsonl")
}

fn session_id_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("session")
        .to_string()
}

fn session_manifest_json(path: &Path, session: &Session) -> JsonValue {
    let mut object = BTreeMap::new();
    object.insert("version".to_string(), JsonValue::Number(2));
    object.insert(
        "storage".to_string(),
        JsonValue::String("event_log".to_string()),
    );
    object.insert(
        "event_log".to_string(),
        JsonValue::String(
            session_event_log_path(path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("session.events.jsonl")
                .to_string(),
        ),
    );
    object.insert(
        "message_count".to_string(),
        JsonValue::Number(usize_to_i64(session.messages.len())),
    );
    object.insert(
        "compaction_count".to_string(),
        JsonValue::Number(usize_to_i64(session.compactions.len())),
    );
    JsonValue::Object(object)
}

fn is_session_event_manifest(value: &JsonValue) -> bool {
    value
        .as_object()
        .and_then(|object| object.get("storage"))
        .and_then(JsonValue::as_str)
        == Some("event_log")
}

#[derive(Debug, Clone)]
struct CanonicalReplay {
    session: Session,
    saw_canonical: bool,
    last_seq: u64,
    invalid_line_count: usize,
}

fn replay_canonical_session_events(path: &Path) -> Result<CanonicalReplay, SessionError> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CanonicalReplay {
                session: Session::new(),
                saw_canonical: false,
                last_seq: 0,
                invalid_line_count: 0,
            });
        }
        Err(error) => return Err(SessionError::Io(error)),
    };

    let mut session = Session::new();
    let mut saw_canonical = false;
    let mut last_seq = 0;
    let mut invalid_line_count: usize = 0;
    for line in BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let entry: SerdeValue = match serde_json::from_str::<SerdeValue>(&line) {
            Ok(entry) if entry.is_object() => entry,
            // This file also carries best-effort UI telemetry. Older builds
            // could interleave two telemetry writes, leaving one or two bad
            // JSONL rows. Preserve the canonical history around those rows
            // instead of making the entire session impossible to restore.
            Ok(_) | Err(_) => {
                invalid_line_count = invalid_line_count.saturating_add(1);
                continue;
            }
        };
        last_seq = last_seq.max(entry.get("seq").and_then(SerdeValue::as_u64).unwrap_or(0));
        let kind = entry
            .get("kind")
            .and_then(SerdeValue::as_str)
            .unwrap_or_default();
        let payload = entry.get("payload").unwrap_or(&SerdeValue::Null);
        match kind {
            "session_reset" => {
                session = Session::new();
                saw_canonical = true;
            }
            "session_message" => {
                if let Some(message) = payload.get("message") {
                    session.messages.push(message_from_serde_value(message)?);
                    saw_canonical = true;
                }
            }
            "session_compaction" => {
                if let Some(compaction) = payload.get("compaction") {
                    session
                        .compactions
                        .push(compaction_from_serde_value(compaction)?);
                    saw_canonical = true;
                }
            }
            "session_usage" => {
                let Some(message_index) = payload
                    .get("messageIndex")
                    .and_then(SerdeValue::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                else {
                    continue;
                };
                let Some(usage) = payload.get("usage").and_then(usage_from_serde_value) else {
                    continue;
                };
                if let Some(message) = session.messages.get_mut(message_index) {
                    message.usage = Some(usage);
                    saw_canonical = true;
                }
            }
            _ => {}
        }
    }

    Ok(CanonicalReplay {
        session,
        saw_canonical,
        last_seq,
        invalid_line_count,
    })
}

fn append_canonical_session_events(
    session_path: &Path,
    event_path: &Path,
    session: &Session,
) -> Result<(), SessionError> {
    let mut replayed = replay_canonical_session_events(event_path)?;
    let needs_repair = replayed.invalid_line_count > 0;
    if needs_repair {
        repair_session_event_log(event_path)?;
        replayed = replay_canonical_session_events(event_path)?;
    }
    let mut events = Vec::new();
    let append_only = !needs_repair
        && replayed.saw_canonical
        && has_prefix(&session.messages, &replayed.session.messages)
        && has_prefix(&session.compactions, &replayed.session.compactions);

    if append_only {
        for (index, message) in session
            .messages
            .iter()
            .enumerate()
            .skip(replayed.session.messages.len())
        {
            events.push((
                "session_message",
                json!({
                    "index": index,
                    "message": message_to_serde_value(message)?,
                }),
            ));
        }
        for (index, compaction) in session
            .compactions
            .iter()
            .enumerate()
            .skip(replayed.session.compactions.len())
        {
            events.push((
                "session_compaction",
                json!({
                    "index": index,
                    "compaction": compaction_to_serde_value(compaction)?,
                }),
            ));
        }
    } else {
        events.push((
            "session_reset",
            json!({
                "reason": if replayed.saw_canonical { "replace" } else { "initial" },
            }),
        ));
        for (index, message) in session.messages.iter().enumerate() {
            events.push((
                "session_message",
                json!({
                    "index": index,
                    "message": message_to_serde_value(message)?,
                }),
            ));
        }
        for (index, compaction) in session.compactions.iter().enumerate() {
            events.push((
                "session_compaction",
                json!({
                    "index": index,
                    "compaction": compaction_to_serde_value(compaction)?,
                }),
            ));
        }
    }

    if events.is_empty() {
        return Ok(());
    }
    if let Some(parent) = event_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut seq = replayed.last_seq;
    let session_id = session_id_from_path(session_path);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(event_path)?;
    for (kind, payload) in events {
        seq = seq.saturating_add(1);
        let entry = json!({
            "version": SESSION_EVENT_VERSION,
            "seq": seq,
            "ts": now_millis(),
            "sessionId": session_id,
            "kind": kind,
            "payload": payload,
        });
        let mut encoded = serde_json::to_vec(&entry).map_err(|error| {
            SessionError::Format(format!("failed to encode session event: {error}"))
        })?;
        encoded.push(b'\n');
        file.write_all(&encoded)?;
    }
    file.flush()?;
    Ok(())
}

/// Remove malformed JSONL rows while retaining valid canonical and UI events.
/// The caller holds the per-path write lock, so the rewrite cannot race with a
/// normal in-process append. A fresh `session_reset` is appended afterwards to
/// make the supplied in-memory session authoritative again.
fn repair_session_event_log(path: &Path) -> Result<(), SessionError> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(SessionError::Io(error)),
    };
    let mut repaired = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if !matches!(serde_json::from_str::<SerdeValue>(&line), Ok(value) if value.is_object()) {
            continue;
        }
        repaired.extend_from_slice(line.as_bytes());
        repaired.push(b'\n');
    }
    crate::atomic_file::write_replace_unlocked(path, &repaired)?;
    Ok(())
}

fn has_prefix<T: PartialEq>(values: &[T], prefix: &[T]) -> bool {
    values.len() >= prefix.len() && values.iter().zip(prefix).all(|(left, right)| left == right)
}

fn message_to_serde_value(message: &ConversationMessage) -> Result<SerdeValue, SessionError> {
    serde_json::from_str(&message.to_json().render())
        .map_err(|error| SessionError::Format(format!("failed to encode message: {error}")))
}

fn message_from_serde_value(value: &SerdeValue) -> Result<ConversationMessage, SessionError> {
    let raw = serde_json::to_string(value)
        .map_err(|error| SessionError::Format(format!("failed to decode message: {error}")))?;
    ConversationMessage::from_json(&JsonValue::parse(&raw)?)
}

fn compaction_to_serde_value(
    compaction: &SessionCompactionRecord,
) -> Result<SerdeValue, SessionError> {
    serde_json::from_str(&compaction.to_json().render())
        .map_err(|error| SessionError::Format(format!("failed to encode compaction: {error}")))
}

fn compaction_from_serde_value(
    value: &SerdeValue,
) -> Result<SessionCompactionRecord, SessionError> {
    let raw = serde_json::to_string(value)
        .map_err(|error| SessionError::Format(format!("failed to decode compaction: {error}")))?;
    SessionCompactionRecord::from_json(&JsonValue::parse(&raw)?)
}

fn usage_from_serde_value(value: &SerdeValue) -> Option<TokenUsage> {
    let object = value.as_object()?;
    Some(TokenUsage {
        input_tokens: serde_u32_field(object, "inputTokens")
            .or_else(|| serde_u32_field(object, "input_tokens"))?,
        output_tokens: serde_u32_field(object, "outputTokens")
            .or_else(|| serde_u32_field(object, "output_tokens"))?,
        cache_creation_input_tokens: serde_u32_field(object, "cacheCreationInputTokens")
            .or_else(|| serde_u32_field(object, "cache_creation_input_tokens"))?,
        cache_read_input_tokens: serde_u32_field(object, "cacheReadInputTokens")
            .or_else(|| serde_u32_field(object, "cache_read_input_tokens"))?,
    })
}

fn serde_u32_field(object: &serde_json::Map<String, SerdeValue>, key: &str) -> Option<u32> {
    object
        .get(key)
        .and_then(SerdeValue::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

#[cfg(test)]
#[path = "tests/session.rs"]
mod tests;
