use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::Serialize;
use serde_json::Value as JsonValue;

use crate::{ContentBlock, MessageRole, Session};

/// Index base for archived (compacted-out) messages. Live sessions never reach
/// this many messages, so archived rows never collide with live `message_index`
/// values in the shared `messages` table.
const ARCHIVE_INDEX_BASE: usize = 1_000_000;
const INDEX_SCHEMA_VERSION: i64 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
struct IndexedMessageRow {
    index: usize,
    role: String,
    content: String,
    recorded_at: i64,
    profile_score: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSearchMessage {
    pub index: usize,
    pub role: String,
    pub content: String,
    pub anchor: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSearchHit {
    pub session_id: String,
    pub path: String,
    pub snippet: String,
    pub match_message_index: usize,
    pub messages: Vec<SessionSearchMessage>,
    /// Weighted reciprocal-rank score scaled by one million. Higher is better.
    pub score_micros: i64,
    /// Source message timestamp when available (Unix milliseconds or imported
    /// sortable date milliseconds); zero means the source had no timestamp.
    pub matched_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionBrowseEntry {
    pub session_id: String,
    pub path: String,
    pub updated_at: i64,
    pub message_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecentSessionMessage {
    pub id: String,
    pub session_id: String,
    pub message_index: usize,
    pub role: String,
    pub content: String,
    pub recorded_at: i64,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct SessionIndexStats {
    pub session_count: u64,
    pub message_count: u64,
}

/// What a status surface needs to know about projection freshness without
/// paying for a rebuild itself.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct SessionIndexReindexState {
    /// The projection is flagged stale (schema upgrade or a failed repair) and
    /// has not been rebuilt yet.
    pub pending: bool,
    /// A rebuild for this directory is running right now.
    pub running: bool,
    pub completed: usize,
    pub total: usize,
}

#[derive(Debug, Clone)]
struct ReindexProgress {
    sessions_dir: PathBuf,
    completed: usize,
    total: usize,
}

/// `sync_sessions_dir` is the only writer; status surfaces read it so they can
/// report "rebuilding" instead of blocking on the rebuild.
static REINDEX_PROGRESS: Mutex<Option<ReindexProgress>> = Mutex::new(None);

struct ReindexProgressGuard {
    sessions_dir: PathBuf,
}

impl ReindexProgressGuard {
    fn begin(sessions_dir: &Path, total: usize) -> Self {
        if let Ok(mut progress) = REINDEX_PROGRESS.lock() {
            *progress = Some(ReindexProgress {
                sessions_dir: sessions_dir.to_path_buf(),
                completed: 0,
                total,
            });
        }
        Self {
            sessions_dir: sessions_dir.to_path_buf(),
        }
    }

    fn advance(&self, completed: usize) {
        if let Ok(mut guard) = REINDEX_PROGRESS.lock() {
            if let Some(progress) = guard.as_mut() {
                if progress.sessions_dir == self.sessions_dir {
                    progress.completed = completed;
                }
            }
        }
    }
}

impl Drop for ReindexProgressGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = REINDEX_PROGRESS.lock() {
            // A concurrent sync of another directory owns the slot now; leaving
            // its progress alone is better than reporting a finished rebuild.
            if guard
                .as_ref()
                .is_some_and(|progress| progress.sessions_dir == self.sessions_dir)
            {
                *guard = None;
            }
        }
    }
}

/// Report whether `sessions_dir` still owes a projection rebuild, and how far
/// an in-flight rebuild has got.
pub fn session_index_reindex_state(
    sessions_dir: &Path,
) -> Result<SessionIndexReindexState, String> {
    let running = REINDEX_PROGRESS
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .filter(|progress| progress.sessions_dir == sessions_dir);
    let connection = open_index(sessions_dir)?;
    Ok(SessionIndexReindexState {
        pending: metadata_flag(&connection, "reindex_required")?,
        running: running.is_some(),
        completed: running.as_ref().map_or(0, |progress| progress.completed),
        total: running.as_ref().map_or(0, |progress| progress.total),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SessionSearchResult {
    Search {
        query: String,
        results: Vec<SessionSearchHit>,
    },
    Read {
        session_id: String,
        messages: Vec<SessionSearchMessage>,
    },
    Browse {
        sessions: Vec<SessionBrowseEntry>,
    },
}

pub fn index_session(path: &Path, session: &Session) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("session path has no parent directory".to_string());
    };
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let session_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "session path has no valid file stem".to_string())?;
    let metadata = fs::metadata(path).ok();
    let updated_at = metadata
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default();
    let file_size = metadata.as_ref().map_or(0, |metadata| {
        i64::try_from(metadata.len()).unwrap_or(i64::MAX)
    });
    let desired = indexed_message_rows(path, session);
    let mut connection = open_index(parent)?;
    let existing = load_indexed_rows(&connection, session_id)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO sessions(session_id, path, updated_at, file_size, message_count)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id) DO UPDATE SET
               path=excluded.path, updated_at=excluded.updated_at,
               file_size=excluded.file_size, message_count=excluded.message_count",
            params![
                session_id,
                path.display().to_string(),
                updated_at,
                file_size,
                session.logical_message_count()
            ],
        )
        .map_err(|error| error.to_string())?;

    // Session saves are overwhelmingly append-only. Compare the desired
    // projection with the existing rows and touch only additions or changes;
    // this preserves the append-only Session as authority without rewriting
    // every FTS row on every turn.
    for row in &desired {
        if existing.get(&row.index) == Some(row) {
            continue;
        }
        replace_index_row(&transaction, session_id, row)?;
    }
    let desired_indices = desired.iter().map(|row| row.index).collect::<BTreeSet<_>>();
    for stale_index in existing
        .keys()
        .filter(|index| !desired_indices.contains(index))
    {
        delete_index_row(&transaction, session_id, *stale_index)?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionEmbeddingInput {
    pub session_id: String,
    pub message_index: usize,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct SessionMessageEmbedding {
    pub session_id: String,
    pub message_index: usize,
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SessionSearchFilter {
    pub time_start_ms: Option<i64>,
    pub time_end_ms: Option<i64>,
    pub prefer_recent: bool,
}

#[derive(Debug, Clone)]
struct RankedMessageHit {
    session_id: String,
    message_index: usize,
    snippet: String,
    updated_at: i64,
    recorded_at: i64,
    score: f64,
    supplemental_indices: Vec<usize>,
}

fn load_indexed_rows(
    connection: &Connection,
    session_id: &str,
) -> Result<BTreeMap<usize, IndexedMessageRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT message_index, role, content, recorded_at, profile_score
             FROM messages WHERE session_id = ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([session_id], |row| {
            let index = usize::try_from(row.get::<_, i64>(0)?).unwrap_or_default();
            Ok(IndexedMessageRow {
                index,
                role: row.get(1)?,
                content: row.get(2)?,
                recorded_at: row.get(3)?,
                profile_score: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows
        .filter_map(Result::ok)
        .map(|row| (row.index, row))
        .collect())
}

fn replace_index_row(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
    row: &IndexedMessageRow,
) -> Result<(), String> {
    delete_fts_rows(transaction, session_id, row.index)?;
    transaction
        .execute(
            "INSERT INTO messages(
               session_id, message_index, role, content, recorded_at, profile_score
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(session_id, message_index) DO UPDATE SET
               role=excluded.role, content=excluded.content,
               recorded_at=excluded.recorded_at, profile_score=excluded.profile_score",
            params![
                session_id,
                row.index,
                row.role,
                row.content,
                row.recorded_at,
                row.profile_score
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO messages_fts(session_id, message_index, role, content) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, row.index, row.role, row.content],
        )
        .map_err(|error| error.to_string())?;
    if row.profile_score > 0 {
        transaction
            .execute(
                "INSERT INTO profile_fts(session_id, message_index, content) VALUES (?1, ?2, ?3)",
                params![session_id, row.index, row.content],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn delete_index_row(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
    message_index: usize,
) -> Result<(), String> {
    delete_fts_rows(transaction, session_id, message_index)?;
    transaction
        .execute(
            "DELETE FROM messages WHERE session_id = ?1 AND message_index = ?2",
            params![session_id, message_index],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn delete_fts_rows(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
    message_index: usize,
) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM messages_fts WHERE session_id = ?1 AND message_index = ?2",
            params![session_id, message_index],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM profile_fts WHERE session_id = ?1 AND message_index = ?2",
            params![session_id, message_index],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM message_embeddings WHERE session_id = ?1 AND message_index = ?2",
            params![session_id, message_index],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn indexed_message_rows(path: &Path, session: &Session) -> Vec<IndexedMessageRow> {
    let event_timestamps = session_event_timestamps(path);
    let mut rows = session
        .messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            let content = searchable_message_text(message);
            if content.trim().is_empty() {
                return None;
            }
            let role = role_name(message.role).to_string();
            let recorded_at = embedded_date_millis(&content)
                .or_else(|| event_timestamps.get(&index).copied())
                .unwrap_or_default();
            Some(IndexedMessageRow {
                index,
                profile_score: profile_signal_score(&role, &content),
                role,
                content,
                recorded_at,
            })
        })
        .collect::<Vec<_>>();

    // Also index the compaction archive (removed messages and their summaries)
    // so session search can recover content compacted out of the live list.
    let mut archive_index = ARCHIVE_INDEX_BASE;
    for record in &session.compactions {
        let summary = record.summary.trim();
        if !summary.is_empty() {
            rows.push(IndexedMessageRow {
                index: archive_index,
                role: "archived:summary".to_string(),
                content: summary.to_string(),
                recorded_at: embedded_date_millis(summary).unwrap_or_default(),
                profile_score: profile_signal_score("archived:summary", summary),
            });
            archive_index = archive_index.saturating_add(1);
        }
        for message in &record.messages {
            let content = searchable_message_text(message);
            if content.trim().is_empty() {
                continue;
            }
            let role = format!("archived:{}", role_name(message.role));
            rows.push(IndexedMessageRow {
                index: archive_index,
                recorded_at: embedded_date_millis(&content).unwrap_or_default(),
                profile_score: profile_signal_score(&role, &content),
                role,
                content,
            });
            archive_index = archive_index.saturating_add(1);
        }
    }
    rows
}

fn session_event_timestamps(path: &Path) -> BTreeMap<usize, i64> {
    let event_path = path.with_extension("events.jsonl");
    let Ok(contents) = fs::read_to_string(event_path) else {
        return BTreeMap::new();
    };
    let mut timestamps = BTreeMap::new();
    for line in contents.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(entry) = serde_json::from_str::<JsonValue>(line) else {
            continue;
        };
        match entry.get("kind").and_then(JsonValue::as_str) {
            Some("session_reset") => timestamps.clear(),
            Some("session_message") => {
                let Some(index) = entry
                    .pointer("/payload/index")
                    .and_then(JsonValue::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                else {
                    continue;
                };
                let timestamp = entry
                    .get("ts")
                    .and_then(JsonValue::as_u64)
                    .and_then(|value| i64::try_from(value).ok())
                    .unwrap_or_default();
                timestamps.insert(index, timestamp);
            }
            _ => {}
        }
    }
    timestamps
}

fn embedded_date_millis(content: &str) -> Option<i64> {
    // LongMemEval and imported histories commonly carry an explicit
    // `date=YYYY/MM/DD` marker. Preserve it as sortable metadata so temporal
    // retrieval does not have to infer chronology from file creation order.
    let marker = "date=";
    let start = content.find(marker)?.saturating_add(marker.len());
    let raw = content.get(start..start.saturating_add(10))?;
    let bytes = raw.as_bytes();
    if bytes.get(4) != Some(&b'/') || bytes.get(7) != Some(&b'/') {
        return None;
    }
    let year = raw.get(0..4)?.parse::<i64>().ok()?;
    let month = raw.get(5..7)?.parse::<i64>().ok()?;
    let day = raw.get(8..10)?.parse::<i64>().ok()?;
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => return None,
    };
    if !(1..=days_in_month).contains(&day) {
        return None;
    }
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year / 400
    } else {
        (adjusted_year - 399) / 400
    };
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days_since_epoch = era * 146_097 + day_of_era - 719_468;
    days_since_epoch.checked_mul(86_400_000)
}

pub fn session_search_date_millis(value: &str) -> Result<i64, String> {
    let value = value.trim();
    let raw = value
        .get(0..10)
        .ok_or_else(|| "session search date must use YYYY-MM-DD".to_string())?;
    if raw.as_bytes().get(4) != Some(&b'-') || raw.as_bytes().get(7) != Some(&b'-') {
        return Err("session search date must use YYYY-MM-DD".to_string());
    }
    let marker = format!("date={}", raw.replace('-', "/"));
    embedded_date_millis(&marker).ok_or_else(|| "session search date is invalid".to_string())
}

fn profile_signal_score(role: &str, content: &str) -> i64 {
    let lower = content.to_lowercase();
    let strong_user_signals = [
        "i prefer",
        "i like",
        "i love",
        "i enjoy",
        "my favorite",
        "my favourite",
        "i don't like",
        "i do not like",
        "i dislike",
        "my budget",
        "allergic",
        "我喜欢",
        "我偏好",
        "我更喜欢",
        "我不喜欢",
        "我的预算",
        "过敏",
    ];
    let weak_user_signals = [
        "i usually",
        "i tend to",
        "i need",
        "i want",
        "i'm looking for",
        "i am looking for",
        "我通常",
        "我习惯",
        "我需要",
        "我想要",
    ];
    let assistant_signals = [
        "you prefer",
        "you like",
        "you enjoy",
        "your favorite",
        "your favourite",
        "you mentioned",
        "your budget",
        "你的偏好",
        "你喜欢",
        "你提到",
        "你的预算",
    ];
    let strong_count = strong_user_signals
        .iter()
        .filter(|signal| lower.contains(**signal))
        .count();
    let weak_count = weak_user_signals
        .iter()
        .filter(|signal| lower.contains(**signal))
        .count();
    let assistant_count = assistant_signals
        .iter()
        .filter(|signal| lower.contains(**signal))
        .count();
    let role_weight = if role.ends_with("user") { 2 } else { 1 };
    i64::try_from(
        strong_count
            .saturating_mul(4)
            .saturating_add(weak_count.saturating_mul(2))
            .saturating_mul(role_weight)
            .saturating_add(assistant_count),
    )
    .unwrap_or(i64::MAX)
}

#[must_use]
pub(crate) fn should_index_session_path(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    if parent
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("sessions"))
    {
        return true;
    }
    crate::execution_env_var_os("ARIS_SESSIONS_DIR")
        .map(PathBuf::from)
        .is_some_and(|sessions_dir| sessions_dir == parent)
}

pub fn sync_sessions_dir(sessions_dir: &Path) -> Result<(), String> {
    if !sessions_dir.exists() {
        return Ok(());
    }
    let connection = open_index(sessions_dir)?;
    let force_rebuild = metadata_flag(&connection, "reindex_required")?;
    let indexed_metadata = load_session_metadata(&connection)?;
    drop(connection);
    let mut seen = BTreeSet::new();
    let mut stale = Vec::new();
    for entry in fs::read_dir(sessions_dir).map_err(|error| error.to_string())? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.ends_with(".json")
            || name.ends_with(".timeline.json")
            || name.ends_with(".json.tmp")
        {
            continue;
        }
        if let Some(session_id) = path.file_stem().and_then(|value| value.to_str()) {
            seen.insert(session_id.to_string());
            let metadata = fs::metadata(&path).ok();
            let updated_at = metadata
                .as_ref()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
                .unwrap_or_default();
            let file_size = metadata.as_ref().map_or(0, |metadata| {
                i64::try_from(metadata.len()).unwrap_or(i64::MAX)
            });
            let unchanged =
                indexed_metadata
                    .get(session_id)
                    .is_some_and(|(known_updated_at, known_size)| {
                        *known_updated_at == updated_at && *known_size == file_size
                    });
            if !force_rebuild && unchanged {
                continue;
            }
            stale.push(path);
        }
    }
    // Sessions are collected before indexing so the count is known up front and
    // a status surface can show real progress instead of an open-ended spinner.
    let progress = ReindexProgressGuard::begin(sessions_dir, stale.len());
    for (completed, path) in stale.into_iter().enumerate() {
        if let Ok(session) = Session::load_from_path(&path) {
            let _ = index_session(&path, &session);
        }
        progress.advance(completed + 1);
    }
    drop(progress);
    prune_missing_sessions(sessions_dir, &seen)?;
    let connection = open_index(sessions_dir)?;
    set_metadata_flag(&connection, "reindex_required", false)
}

/// Return messages that do not yet have a vector for `embedding_model`.
/// Generation is intentionally external so builtin memory remains usable with
/// no model, network, or sidecar dependency.
pub fn pending_session_embedding_inputs(
    sessions_dir: &Path,
    embedding_model: &str,
    limit: usize,
) -> Result<Vec<SessionEmbeddingInput>, String> {
    if embedding_model.trim().is_empty() {
        return Err("embedding model must not be empty".to_string());
    }
    ensure_index_ready(sessions_dir)?;
    let connection = open_index(sessions_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT messages.session_id, messages.message_index, messages.content
             FROM messages
             LEFT JOIN message_embeddings
               ON message_embeddings.session_id = messages.session_id
              AND message_embeddings.message_index = messages.message_index
              AND message_embeddings.model = ?1
             WHERE message_embeddings.session_id IS NULL
             ORDER BY messages.recorded_at, messages.session_id, messages.message_index
             LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![embedding_model, limit.clamp(1, 1_000)], |row| {
            Ok(SessionEmbeddingInput {
                session_id: row.get(0)?,
                message_index: usize::try_from(row.get::<_, i64>(1)?).unwrap_or_default(),
                content: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Store a batch of externally generated message embeddings transactionally.
pub fn upsert_session_message_embeddings(
    sessions_dir: &Path,
    embedding_model: &str,
    embeddings: &[SessionMessageEmbedding],
) -> Result<usize, String> {
    if embedding_model.trim().is_empty() {
        return Err("embedding model must not be empty".to_string());
    }
    let mut connection = open_index(sessions_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut stored = 0;
    for embedding in embeddings {
        validate_embedding(&embedding.vector)?;
        let message_exists = transaction
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM messages WHERE session_id=?1 AND message_index=?2
                 )",
                params![embedding.session_id, embedding.message_index],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?
            != 0;
        if !message_exists {
            continue;
        }
        let encoded = encode_embedding(&embedding.vector);
        transaction
            .execute(
                "INSERT INTO message_embeddings(
                   session_id, message_index, model, dimensions, vector
                 ) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(session_id, message_index, model) DO UPDATE SET
                   dimensions=excluded.dimensions, vector=excluded.vector",
                params![
                    embedding.session_id,
                    embedding.message_index,
                    embedding_model,
                    embedding.vector.len(),
                    encoded
                ],
            )
            .map_err(|error| error.to_string())?;
        stored += 1;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(stored)
}

fn load_session_metadata(connection: &Connection) -> Result<BTreeMap<String, (i64, i64)>, String> {
    let mut statement = connection
        .prepare("SELECT session_id, updated_at, file_size FROM sessions")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn search_sessions(
    sessions_dir: &Path,
    query: Option<&str>,
    session_id: Option<&str>,
    limit: usize,
    window: usize,
) -> Result<SessionSearchResult, String> {
    search_sessions_internal(
        sessions_dir,
        query,
        session_id,
        limit,
        window,
        SessionSearchFilter::default(),
        None,
    )
}

/// `session_id NOT LIKE 'prefix%'` for each excluded prefix, so a caller can
/// scope the projection to the sessions it actually governs.
fn excluded_prefix_clause(column: &str, excluded_prefixes: &[&str], first_param: usize) -> String {
    excluded_prefixes
        .iter()
        .enumerate()
        .map(|(offset, _)| {
            format!(
                " AND {column} NOT LIKE ?{} ESCAPE '\\'",
                first_param + offset
            )
        })
        .collect()
}

fn excluded_prefix_patterns(excluded_prefixes: &[&str]) -> Vec<rusqlite::types::Value> {
    excluded_prefixes
        .iter()
        .map(|prefix| {
            rusqlite::types::Value::from(format!(
                "{}%",
                prefix
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            ))
        })
        .collect()
}

/// Return a bounded recent L0 projection for governance UI. This reads only
/// the SQLite projection and never scans Session files: a stale projection
/// reports what is currently indexed and leaves the repair to
/// [`sync_sessions_dir`] on the background repair thread.
///
/// `excluded_prefixes` drops session ids by prefix. Memory governance passes
/// the workflow prefix so the R0 view matches what recall and backfill actually
/// consider; pass `&[]` for the whole projection.
pub fn recent_session_messages(
    sessions_dir: &Path,
    limit: usize,
    excluded_prefixes: &[&str],
) -> Result<Vec<RecentSessionMessage>, String> {
    let connection = open_index(sessions_dir)?;
    let excluded = excluded_prefix_clause("messages.session_id", excluded_prefixes, 2);
    let sql = format!(
        "SELECT messages.session_id, messages.message_index, messages.role,
                messages.content, messages.recorded_at
         FROM messages
         JOIN sessions ON sessions.session_id=messages.session_id
         WHERE 1=1{excluded}
         ORDER BY CASE WHEN messages.recorded_at > 0 THEN messages.recorded_at
                       ELSE sessions.updated_at END DESC,
                  messages.session_id DESC, messages.message_index DESC
         LIMIT ?1"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let mut values = vec![rusqlite::types::Value::from(
        i64::try_from(limit.clamp(1, 500)).unwrap_or(500),
    )];
    values.extend(excluded_prefix_patterns(excluded_prefixes));
    let rows = statement
        .query_map(rusqlite::params_from_iter(values), |row| {
            let session_id = row.get::<_, String>(0)?;
            let message_index = usize::try_from(row.get::<_, i64>(1)?).unwrap_or_default();
            Ok(RecentSessionMessage {
                id: format!("{session_id}:{message_index}"),
                session_id,
                message_index,
                role: row.get(2)?,
                content: row.get(3)?,
                recorded_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Counts for the current projection. Like [`recent_session_messages`] this is
/// a read-only status surface: it never rebuilds, because a schema upgrade can
/// make the rebuild take a minute and callers on a UI thread would freeze for
/// its whole duration. Pair it with [`session_index_reindex_state`] to tell the
/// user the numbers are still catching up.
///
/// `excluded_prefixes` scopes the counts the same way it scopes
/// [`recent_session_messages`], so a caller cannot report a total it will not
/// actually serve.
pub fn session_index_stats(
    sessions_dir: &Path,
    excluded_prefixes: &[&str],
) -> Result<SessionIndexStats, String> {
    let connection = open_index(sessions_dir)?;
    let patterns = excluded_prefix_patterns(excluded_prefixes);
    let session_count = connection
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM sessions WHERE 1=1{}",
                excluded_prefix_clause("session_id", excluded_prefixes, 1)
            ),
            rusqlite::params_from_iter(patterns.clone()),
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let message_count = connection
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM messages WHERE 1=1{}",
                excluded_prefix_clause("session_id", excluded_prefixes, 1)
            ),
            rusqlite::params_from_iter(patterns),
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(SessionIndexStats {
        session_count,
        message_count,
    })
}

pub fn search_sessions_filtered(
    sessions_dir: &Path,
    query: Option<&str>,
    session_id: Option<&str>,
    limit: usize,
    window: usize,
    filter: SessionSearchFilter,
) -> Result<SessionSearchResult, String> {
    if filter
        .time_start_ms
        .zip(filter.time_end_ms)
        .is_some_and(|(start, end)| start > end)
    {
        return Err("session search time_start_ms must not exceed time_end_ms".to_string());
    }
    search_sessions_internal(sessions_dir, query, session_id, limit, window, filter, None)
}

/// Search with an optional precomputed query embedding. The default
/// [`search_sessions`] path never calls a network service; callers that have a
/// verified local or remote embedding provider may backfill message vectors
/// and opt into this hybrid RRF path explicitly.
pub fn search_sessions_hybrid(
    sessions_dir: &Path,
    query: Option<&str>,
    session_id: Option<&str>,
    limit: usize,
    window: usize,
    embedding_model: &str,
    query_embedding: &[f32],
) -> Result<SessionSearchResult, String> {
    if embedding_model.trim().is_empty() {
        return Err("embedding model must not be empty".to_string());
    }
    validate_embedding(query_embedding)?;
    search_sessions_internal(
        sessions_dir,
        query,
        session_id,
        limit,
        window,
        SessionSearchFilter::default(),
        Some((embedding_model, query_embedding)),
    )
}

fn search_sessions_internal(
    sessions_dir: &Path,
    query: Option<&str>,
    session_id: Option<&str>,
    limit: usize,
    window: usize,
    filter: SessionSearchFilter,
    semantic_query: Option<(&str, &[f32])>,
) -> Result<SessionSearchResult, String> {
    ensure_index_ready(sessions_dir)?;
    let connection = open_index(sessions_dir)?;
    if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
        return Ok(SessionSearchResult::Read {
            session_id: session_id.to_string(),
            messages: load_messages(&connection, session_id, None, usize::MAX)?,
        });
    }
    let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) else {
        let mut statement = connection
            .prepare(
                "SELECT session_id, path, updated_at, message_count
                 FROM sessions ORDER BY updated_at DESC LIMIT ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([limit.max(1)], |row| {
                Ok(SessionBrowseEntry {
                    session_id: row.get(0)?,
                    path: row.get(1)?,
                    updated_at: row.get(2)?,
                    message_count: row.get(3)?,
                })
            })
            .map_err(|error| error.to_string())?;
        return Ok(SessionSearchResult::Browse {
            sessions: rows.filter_map(Result::ok).collect(),
        });
    };

    let candidate_multiplier = if filter.time_start_ms.is_some() || filter.time_end_ms.is_some() {
        32
    } else if is_temporal_query(query) {
        12
    } else {
        8
    };
    let candidate_limit = limit
        .saturating_mul(candidate_multiplier)
        .max(candidate_multiplier);
    let mut ranked_hits = if query.chars().any(is_cjk) {
        search_like(&connection, query, candidate_limit)?
    } else {
        let strict = search_fts(&connection, query, candidate_limit)?;
        if strict.is_empty() {
            search_fts_relaxed(&connection, query, candidate_limit)?
        } else {
            strict
        }
    };
    for (rank, hit) in ranked_hits.iter_mut().enumerate() {
        hit.score = 1.0 / (60.0 + rank as f64 + 1.0);
    }
    if is_preference_query(query) {
        let profile = if query.chars().any(is_cjk) {
            search_profile_like(&connection, query, candidate_limit)?
        } else {
            search_profile_fts(&connection, query, candidate_limit)?
        };
        improve_profile_anchors(&mut ranked_hits, profile);
    }
    if let Some((model, query_embedding)) = semantic_query {
        let semantic = search_embeddings(&connection, model, query_embedding, candidate_limit)?;
        if !semantic.is_empty() {
            ranked_hits = merge_ranked_lists(query, &[(ranked_hits, 1.25), (semantic, 1.0)]);
        }
    }
    apply_time_filter_and_update_ranking(
        &mut ranked_hits,
        filter,
        filter.prefer_recent || is_update_query(query),
    );
    let mut seen = BTreeSet::new();
    let ranked_hits = ranked_hits
        .into_iter()
        .filter(|hit| seen.insert(hit.session_id.clone()))
        .take(limit.max(1))
        .collect::<Vec<_>>();
    let mut results = Vec::new();
    for hit in ranked_hits {
        let path = connection
            .query_row(
                "SELECT path FROM sessions WHERE session_id = ?1",
                [&hit.session_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_default();
        results.push(SessionSearchHit {
            messages: load_messages_with_supplements(
                &connection,
                &hit.session_id,
                hit.message_index,
                window,
                &hit.supplemental_indices,
            )?,
            session_id: hit.session_id,
            path,
            snippet: hit.snippet,
            match_message_index: hit.message_index,
            score_micros: (hit.score * 1_000_000.0)
                .round()
                .clamp(i64::MIN as f64, i64::MAX as f64) as i64,
            matched_at: hit.recorded_at,
        });
    }
    Ok(SessionSearchResult::Search {
        query: query.to_string(),
        results,
    })
}

#[must_use]
pub fn sessions_dir_from_env() -> PathBuf {
    crate::project_sessions_dir_from_env()
}

fn open_index(sessions_dir: &Path) -> Result<Connection, String> {
    fs::create_dir_all(sessions_dir).map_err(|error| error.to_string())?;
    let connection = Connection::open(sessions_dir.join("session-index.sqlite3"))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=2000;
             CREATE TABLE IF NOT EXISTS sessions(
               session_id TEXT PRIMARY KEY,
               path TEXT NOT NULL,
               updated_at INTEGER NOT NULL,
               file_size INTEGER NOT NULL DEFAULT 0,
               message_count INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS messages(
               session_id TEXT NOT NULL,
               message_index INTEGER NOT NULL,
               role TEXT NOT NULL,
               content TEXT NOT NULL,
               recorded_at INTEGER NOT NULL DEFAULT 0,
               profile_score INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(session_id, message_index)
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
               session_id UNINDEXED,
               message_index UNINDEXED,
               role UNINDEXED,
               content
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS profile_fts USING fts5(
               session_id UNINDEXED,
               message_index UNINDEXED,
               content
             );
             CREATE TABLE IF NOT EXISTS index_metadata(
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS message_embeddings(
               session_id TEXT NOT NULL,
               message_index INTEGER NOT NULL,
               model TEXT NOT NULL,
               dimensions INTEGER NOT NULL,
               vector BLOB NOT NULL,
               PRIMARY KEY(session_id, message_index, model)
             );",
        )
        .map_err(|error| error.to_string())?;
    ensure_column(
        &connection,
        "sessions",
        "file_size",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &connection,
        "messages",
        "recorded_at",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &connection,
        "messages",
        "profile_score",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    let current_version = connection
        .query_row(
            "SELECT value FROM index_metadata WHERE key='schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    if current_version < INDEX_SCHEMA_VERSION {
        let has_existing_projection = connection
            .query_row("SELECT EXISTS(SELECT 1 FROM sessions LIMIT 1)", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or_default()
            != 0;
        connection
            .execute(
                "INSERT INTO index_metadata(key, value) VALUES('reindex_required', ?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [if has_existing_projection { "1" } else { "0" }],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO index_metadata(key, value) VALUES('schema_version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [INDEX_SCHEMA_VERSION.to_string()],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(connection)
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let exists = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .any(|name| name == column);
    drop(statement);
    if !exists {
        connection
            .execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition};"
            ))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn metadata_flag(connection: &Connection, key: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT value FROM index_metadata WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .map(|value| value == "1")
        .or_else(|error| {
            if error == rusqlite::Error::QueryReturnedNoRows {
                Ok(false)
            } else {
                Err(error)
            }
        })
        .map_err(|error| error.to_string())
}

fn set_metadata_flag(connection: &Connection, key: &str, enabled: bool) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO index_metadata(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, if enabled { "1" } else { "0" }],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_index_ready(sessions_dir: &Path) -> Result<(), String> {
    let index_path = sessions_dir.join("session-index.sqlite3");
    let index_existed = index_path.exists();
    let connection = open_index(sessions_dir)?;
    let needs_reindex = metadata_flag(&connection, "reindex_required")?;
    let indexed_sessions = connection
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or_default();
    drop(connection);
    if needs_reindex || (!index_existed && indexed_sessions == 0) {
        sync_sessions_dir(sessions_dir)?;
    }
    Ok(())
}

fn prune_missing_sessions(sessions_dir: &Path, seen: &BTreeSet<String>) -> Result<(), String> {
    let mut connection = open_index(sessions_dir)?;
    let indexed = {
        let mut statement = connection
            .prepare("SELECT session_id FROM sessions")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.filter_map(Result::ok).collect::<Vec<_>>()
    };
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for session_id in indexed
        .into_iter()
        .filter(|session_id| !seen.contains(session_id))
    {
        transaction
            .execute(
                "DELETE FROM messages_fts WHERE session_id = ?1",
                [&session_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM profile_fts WHERE session_id = ?1",
                [&session_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM message_embeddings WHERE session_id = ?1",
                [&session_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM messages WHERE session_id = ?1", [&session_id])
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM sessions WHERE session_id = ?1", [&session_id])
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn search_fts(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<RankedMessageHit>, String> {
    search_fts_with_operator(connection, query, " AND ", limit)
}

fn search_fts_relaxed(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<RankedMessageHit>, String> {
    search_fts_with_operator(connection, query, " OR ", limit)
}

fn search_fts_with_operator(
    connection: &Connection,
    query: &str,
    operator: &str,
    limit: usize,
) -> Result<Vec<RankedMessageHit>, String> {
    let fts_query = query
        .split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(operator);
    if fts_query.is_empty() {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "SELECT messages_fts.session_id, messages_fts.message_index,
                    snippet(messages_fts, 3, '[', ']', '...', 24),
                    sessions.updated_at, messages.recorded_at
             FROM messages_fts
             JOIN sessions ON sessions.session_id = messages_fts.session_id
             JOIN messages ON messages.session_id = messages_fts.session_id
                          AND messages.message_index = messages_fts.message_index
             WHERE messages_fts MATCH ?1
             ORDER BY bm25(messages_fts), messages.recorded_at DESC
             LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![fts_query, limit], |row| {
            Ok(RankedMessageHit {
                session_id: row.get(0)?,
                message_index: usize::try_from(row.get::<_, i64>(1)?).unwrap_or_default(),
                snippet: row.get(2)?,
                updated_at: row.get(3)?,
                recorded_at: row.get(4)?,
                score: 0.0,
                supplemental_indices: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn search_profile_fts(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<RankedMessageHit>, String> {
    let fts_query = english_query_terms(query)
        .into_iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
    if fts_query.is_empty() {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "SELECT profile_fts.session_id, profile_fts.message_index,
                    snippet(profile_fts, 2, '[', ']', '...', 24),
                    sessions.updated_at, messages.recorded_at
             FROM profile_fts
             JOIN sessions ON sessions.session_id = profile_fts.session_id
             JOIN messages ON messages.session_id = profile_fts.session_id
                          AND messages.message_index = profile_fts.message_index
             WHERE profile_fts MATCH ?1
             ORDER BY messages.profile_score DESC, bm25(profile_fts),
                      messages.recorded_at DESC
             LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![fts_query, limit], |row| {
            Ok(RankedMessageHit {
                session_id: row.get(0)?,
                message_index: usize::try_from(row.get::<_, i64>(1)?).unwrap_or_default(),
                snippet: row.get(2)?,
                updated_at: row.get(3)?,
                recorded_at: row.get(4)?,
                score: 0.0,
                supplemental_indices: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn search_like(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<RankedMessageHit>, String> {
    search_like_table(connection, query, limit, false)
}

fn search_profile_like(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<RankedMessageHit>, String> {
    search_like_table(connection, query, limit, true)
}

fn search_like_table(
    connection: &Connection,
    query: &str,
    limit: usize,
    profile_only: bool,
) -> Result<Vec<RankedMessageHit>, String> {
    let terms = cjk_search_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let matches = std::iter::repeat("content LIKE ? ESCAPE '\\'")
        .take(terms.len())
        .collect::<Vec<_>>()
        .join(" OR ");
    let score = std::iter::repeat("CASE WHEN content LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END")
        .take(terms.len())
        .collect::<Vec<_>>()
        .join(" + ");
    let profile_filter = if profile_only {
        "profile_score > 0 AND "
    } else {
        ""
    };
    let sql = format!(
        "SELECT messages.session_id, messages.message_index,
                substr(messages.content, 1, 300), sessions.updated_at,
                messages.recorded_at, ({score}) AS relevance
         FROM messages JOIN sessions ON sessions.session_id = messages.session_id
         WHERE {profile_filter}({matches})
         ORDER BY relevance DESC, messages.recorded_at DESC,
                  messages.message_index DESC LIMIT ?"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let mut values = terms
        .iter()
        .chain(terms.iter())
        .map(|term| Value::Text(like_pattern(term)))
        .collect::<Vec<_>>();
    values.push(Value::Integer(i64::try_from(limit).unwrap_or(i64::MAX)));
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            Ok(RankedMessageHit {
                session_id: row.get(0)?,
                message_index: usize::try_from(row.get::<_, i64>(1)?).unwrap_or_default(),
                snippet: row.get(2)?,
                updated_at: row.get(3)?,
                recorded_at: row.get(4)?,
                score: 0.0,
                supplemental_indices: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn search_embeddings(
    connection: &Connection,
    embedding_model: &str,
    query_embedding: &[f32],
    limit: usize,
) -> Result<Vec<RankedMessageHit>, String> {
    validate_embedding(query_embedding)?;
    let mut statement = connection
        .prepare(
            "SELECT message_embeddings.session_id,
                    message_embeddings.message_index,
                    message_embeddings.dimensions,
                    message_embeddings.vector,
                    messages.content, sessions.updated_at, messages.recorded_at
             FROM message_embeddings
             JOIN messages ON messages.session_id = message_embeddings.session_id
                          AND messages.message_index = message_embeddings.message_index
             JOIN sessions ON sessions.session_id = message_embeddings.session_id
             WHERE message_embeddings.model = ?1
               AND message_embeddings.dimensions = ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![embedding_model, query_embedding.len()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                usize::try_from(row.get::<_, i64>(1)?).unwrap_or_default(),
                usize::try_from(row.get::<_, i64>(2)?).unwrap_or_default(),
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut hits = rows
        .filter_map(Result::ok)
        .filter_map(
            |(session_id, message_index, dimensions, encoded, content, updated_at, recorded_at)| {
                let vector = decode_embedding(&encoded, dimensions)?;
                let score = cosine_similarity(query_embedding, &vector)?;
                Some(RankedMessageHit {
                    session_id,
                    message_index,
                    snippet: content.chars().take(300).collect(),
                    updated_at,
                    recorded_at,
                    score,
                    supplemental_indices: Vec::new(),
                })
            },
        )
        .collect::<Vec<_>>();
    hits.sort_by(|left, right| right.score.total_cmp(&left.score));
    hits.truncate(limit.max(1));
    Ok(hits)
}

fn validate_embedding(vector: &[f32]) -> Result<(), String> {
    if vector.is_empty() {
        return Err("embedding vector must not be empty".to_string());
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return Err("embedding vector contains a non-finite value".to_string());
    }
    Ok(())
}

fn encode_embedding(vector: &[f32]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(vector.len().saturating_mul(4));
    for value in vector {
        encoded.extend_from_slice(&value.to_le_bytes());
    }
    encoded
}

fn decode_embedding(encoded: &[u8], dimensions: usize) -> Option<Vec<f32>> {
    if encoded.len() != dimensions.checked_mul(4)? {
        return None;
    }
    Some(
        encoded
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .collect(),
    )
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> Option<f64> {
    if left.len() != right.len() || left.is_empty() {
        return None;
    }
    let mut dot = 0.0_f64;
    let mut left_norm = 0.0_f64;
    let mut right_norm = 0.0_f64;
    for (left, right) in left.iter().zip(right) {
        let left = f64::from(*left);
        let right = f64::from(*right);
        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
    }
    let denominator = left_norm.sqrt() * right_norm.sqrt();
    (denominator > f64::EPSILON).then_some(dot / denominator)
}

fn improve_profile_anchors(lexical: &mut Vec<RankedMessageHit>, profile: Vec<RankedMessageHit>) {
    let mut best_by_session = BTreeMap::<String, RankedMessageHit>::new();
    for hit in profile {
        best_by_session.entry(hit.session_id.clone()).or_insert(hit);
    }
    for hit in lexical.iter_mut() {
        let Some(profile_hit) = best_by_session.get(&hit.session_id) else {
            continue;
        };
        // Preserve both the proven lexical anchor and its full neighbour
        // window. Add one exact preference-bearing turn as supplemental
        // context; replacement can move the window away from the answer.
        if profile_hit.message_index != hit.message_index {
            hit.supplemental_indices.push(profile_hit.message_index);
        }
    }
    if lexical.is_empty() {
        lexical.extend(best_by_session.into_values());
    }
}

fn merge_ranked_lists(
    _query: &str,
    lists: &[(Vec<RankedMessageHit>, f64)],
) -> Vec<RankedMessageHit> {
    const RRF_K: f64 = 60.0;
    let mut merged = BTreeMap::<(String, usize), RankedMessageHit>::new();
    for (list, weight) in lists {
        for (rank, hit) in list.iter().enumerate() {
            let contribution = *weight / (RRF_K + rank as f64 + 1.0);
            let key = (hit.session_id.clone(), hit.message_index);
            merged
                .entry(key)
                .and_modify(|existing| {
                    existing.score += contribution;
                    if hit.snippet.len() > existing.snippet.len() {
                        existing.snippet.clone_from(&hit.snippet);
                    }
                    existing.recorded_at = existing.recorded_at.max(hit.recorded_at);
                    existing.updated_at = existing.updated_at.max(hit.updated_at);
                    for index in &hit.supplemental_indices {
                        if !existing.supplemental_indices.contains(index) {
                            existing.supplemental_indices.push(*index);
                        }
                    }
                })
                .or_insert_with(|| {
                    let mut hit = hit.clone();
                    hit.score = contribution;
                    hit
                });
        }
    }

    let mut results = merged.into_values().collect::<Vec<_>>();
    results.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| right.recorded_at.cmp(&left.recorded_at))
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
    results
}

fn apply_time_filter_and_update_ranking(
    hits: &mut Vec<RankedMessageHit>,
    filter: SessionSearchFilter,
    prefer_recent: bool,
) {
    if filter.time_start_ms.is_some() || filter.time_end_ms.is_some() {
        hits.retain(|hit| {
            let timestamp = hit_timestamp(hit);
            timestamp > 0
                && filter.time_start_ms.is_none_or(|start| timestamp >= start)
                && filter.time_end_ms.is_none_or(|end| timestamp <= end)
        });
    }
    if !prefer_recent || hits.len() < 2 {
        return;
    }
    let timestamps = hits
        .iter()
        .map(hit_timestamp)
        .filter(|timestamp| *timestamp > 0)
        .collect::<Vec<_>>();
    let (Some(oldest), Some(newest)) = (timestamps.iter().min(), timestamps.iter().max()) else {
        return;
    };
    let span = newest.saturating_sub(*oldest);
    if span <= 0 {
        return;
    }
    for hit in hits.iter_mut() {
        let timestamp = hit_timestamp(hit);
        let recency = timestamp.saturating_sub(*oldest) as f64 / span as f64;
        // At most enough to break a neighbouring near-tie; strong lexical
        // evidence remains dominant.
        hit.score += recency * 0.000_2;
    }
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| right.recorded_at.cmp(&left.recorded_at))
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
}

fn hit_timestamp(hit: &RankedMessageHit) -> i64 {
    if hit.recorded_at > 0 {
        hit.recorded_at
    } else {
        hit.updated_at
    }
}

fn english_query_terms(query: &str) -> Vec<String> {
    const STOP_WORDS: &[&str] = &[
        "a", "an", "and", "are", "as", "at", "be", "can", "could", "did", "do", "does", "for",
        "from", "had", "has", "have", "how", "i", "in", "is", "it", "me", "my", "of", "on", "our",
        "please", "remind", "say", "the", "that", "to", "was", "we", "were", "what", "when",
        "where", "which", "who", "why", "with", "would", "you", "your",
    ];
    let mut terms = BTreeSet::new();
    for raw in query.split(|character: char| !character.is_alphanumeric()) {
        let term = raw.trim().to_lowercase();
        if term.is_empty()
            || (term.chars().count() == 1 && !term.chars().all(|ch| ch.is_ascii_digit()))
            || STOP_WORDS.contains(&term.as_str())
        {
            continue;
        }
        terms.insert(term.clone());
        if let Some(alias) = weekday_alias(&term) {
            terms.insert(alias.to_string());
        }
    }
    terms.into_iter().collect()
}

fn weekday_alias(term: &str) -> Option<&'static str> {
    match term {
        "monday" => Some("mon"),
        "tuesday" => Some("tue"),
        "wednesday" => Some("wed"),
        "thursday" => Some("thu"),
        "friday" => Some("fri"),
        "saturday" => Some("sat"),
        "sunday" => Some("sun"),
        _ => None,
    }
}

fn is_preference_query(query: &str) -> bool {
    let lower = query.to_lowercase();
    [
        "recommend",
        "suggest",
        "for me",
        "would suit",
        "would fit",
        "should i",
        "helpful tips",
        "personalized",
        "personalised",
        "preference",
        "推荐",
        "建议",
        "适合我",
        "我的偏好",
        "我会喜欢",
    ]
    .iter()
    .any(|cue| lower.contains(cue))
}

fn is_update_query(query: &str) -> bool {
    let lower = query.to_lowercase();
    [
        "latest",
        "current",
        "currently",
        "changed",
        "updated",
        "ended up",
        "finally",
        "actually",
        "now",
        "最新",
        "现在",
        "后来",
        "最终",
        "改成",
        "更新",
    ]
    .iter()
    .any(|cue| lower.contains(cue))
}

fn is_temporal_query(query: &str) -> bool {
    let lower = query.to_lowercase();
    [
        "yesterday",
        "last week",
        "last month",
        "last monday",
        "last tuesday",
        "last wednesday",
        "last thursday",
        "last friday",
        "last saturday",
        "last sunday",
        "before",
        "after",
        "昨天",
        "上周",
        "上个月",
        "之前",
        "之后",
    ]
    .iter()
    .any(|cue| lower.contains(cue))
}

fn cjk_search_terms(query: &str) -> Vec<String> {
    let mut terms = BTreeSet::new();
    let mut run = Vec::new();
    for character in query.chars() {
        if is_cjk(character) {
            run.push(character);
        } else if !run.is_empty() {
            add_cjk_run_terms(&mut run, &mut terms);
        }
    }
    if !run.is_empty() {
        add_cjk_run_terms(&mut run, &mut terms);
    }
    for term in query.split(|character: char| !character.is_alphanumeric()) {
        if term.len() > 1 && !term.chars().any(is_cjk) {
            terms.insert(term.to_string());
        }
    }
    terms.into_iter().collect()
}

fn add_cjk_run_terms(run: &mut Vec<char>, terms: &mut BTreeSet<String>) {
    if run.len() == 1 {
        terms.insert(run.iter().collect());
    } else {
        for pair in run.windows(2) {
            terms.insert(pair.iter().collect());
        }
    }
    run.clear();
}

fn like_pattern(term: &str) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn load_messages(
    connection: &Connection,
    session_id: &str,
    anchor: Option<usize>,
    window: usize,
) -> Result<Vec<SessionSearchMessage>, String> {
    let (start, end) = anchor.map_or((0_i64, i64::MAX), |anchor| {
        (
            i64::try_from(anchor.saturating_sub(window)).unwrap_or_default(),
            i64::try_from(anchor.saturating_add(window)).unwrap_or(i64::MAX),
        )
    });
    let mut statement = connection
        .prepare(
            "SELECT message_index, role, content FROM messages
             WHERE session_id = ?1 AND message_index >= ?2 AND message_index <= ?3
             ORDER BY message_index ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![session_id, start, end], |row| {
            let index = usize::try_from(row.get::<_, i64>(0)?).unwrap_or_default();
            Ok(SessionSearchMessage {
                index,
                role: row.get(1)?,
                content: row.get(2)?,
                anchor: anchor == Some(index),
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn load_messages_with_supplements(
    connection: &Connection,
    session_id: &str,
    anchor: usize,
    window: usize,
    supplemental_indices: &[usize],
) -> Result<Vec<SessionSearchMessage>, String> {
    let mut messages = load_messages(connection, session_id, Some(anchor), window)?;
    let mut seen = messages
        .iter()
        .map(|message| message.index)
        .collect::<BTreeSet<_>>();
    for supplemental_index in supplemental_indices.iter().take(1) {
        if seen.contains(supplemental_index) {
            continue;
        }
        let mut supplemental = load_messages(connection, session_id, Some(*supplemental_index), 0)?;
        for message in &mut supplemental {
            message.anchor = false;
        }
        for message in supplemental {
            if seen.insert(message.index) {
                messages.push(message);
            }
        }
    }
    messages.sort_by_key(|message| message.index);
    Ok(messages)
}

fn searchable_message_text(message: &crate::ConversationMessage) -> String {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.clone()),
            ContentBlock::ToolUse { name, input, .. } => Some(format!("tool {name}: {input}")),
            ContentBlock::ToolResult {
                tool_name, output, ..
            } => Some(format!("tool result {tool_name}: {output}")),
            ContentBlock::Image { .. } | ContentBlock::Thinking { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn role_name(role: MessageRole) -> &'static str {
    match role {
        MessageRole::System => "system",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::Tool => "tool",
    }
}

fn is_cjk(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

#[cfg(test)]
#[path = "tests/session_index.rs"]
mod tests;
