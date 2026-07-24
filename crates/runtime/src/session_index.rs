use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::{ContentBlock, MessageRole, Session};

/// Index base for archived (compacted-out) messages. Live sessions never reach
/// this many messages, so archived rows never collide with live `message_index`
/// values in the shared `messages` table.
const ARCHIVE_INDEX_BASE: usize = 1_000_000;

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
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionBrowseEntry {
    pub session_id: String,
    pub path: String,
    pub updated_at: i64,
    pub message_count: usize,
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
    let updated_at = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default();
    let mut connection = open_index(parent)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO sessions(session_id, path, updated_at, message_count)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id) DO UPDATE SET
               path=excluded.path, updated_at=excluded.updated_at, message_count=excluded.message_count",
            params![
                session_id,
                path.display().to_string(),
                updated_at,
                session.logical_message_count()
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM messages WHERE session_id = ?1", [session_id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM messages_fts WHERE session_id = ?1",
            [session_id],
        )
        .map_err(|error| error.to_string())?;
    for (index, message) in session.messages.iter().enumerate() {
        let content = searchable_message_text(message);
        if content.trim().is_empty() {
            continue;
        }
        let role = role_name(message.role);
        transaction
            .execute(
                "INSERT INTO messages(session_id, message_index, role, content) VALUES (?1, ?2, ?3, ?4)",
                params![session_id, index, role, content],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO messages_fts(session_id, message_index, role, content) VALUES (?1, ?2, ?3, ?4)",
                params![session_id, index, role, content],
            )
            .map_err(|error| error.to_string())?;
    }
    // Also index the compaction archive (removed messages and their summaries)
    // so session search can recover content that was compacted out of the live
    // list. Archived rows use a high index base and an `archived:` role prefix so
    // they never collide with, or masquerade as, live messages.
    let mut archive_index = ARCHIVE_INDEX_BASE;
    for record in &session.compactions {
        let summary = record.summary.trim();
        if !summary.is_empty() {
            index_row(&transaction, session_id, archive_index, "archived:summary", summary)?;
            archive_index += 1;
        }
        for message in &record.messages {
            let content = searchable_message_text(message);
            if content.trim().is_empty() {
                continue;
            }
            let role = format!("archived:{}", role_name(message.role));
            index_row(&transaction, session_id, archive_index, &role, &content)?;
            archive_index += 1;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

/// Insert one row into both `messages` and `messages_fts` within `transaction`.
fn index_row(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
    message_index: usize,
    role: &str,
    content: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO messages(session_id, message_index, role, content) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, message_index, role, content],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO messages_fts(session_id, message_index, role, content) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, message_index, role, content],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
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
    std::env::var("ARIS_SESSIONS_DIR")
        .map(PathBuf::from)
        .is_ok_and(|sessions_dir| sessions_dir == parent)
}

pub fn sync_sessions_dir(sessions_dir: &Path) -> Result<(), String> {
    if !sessions_dir.exists() {
        return Ok(());
    }
    let mut seen = BTreeSet::new();
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
        }
        if let Ok(session) = Session::load_from_path(&path) {
            let _ = index_session(&path, &session);
        }
    }
    prune_missing_sessions(sessions_dir, &seen)
}

pub fn search_sessions(
    sessions_dir: &Path,
    query: Option<&str>,
    session_id: Option<&str>,
    limit: usize,
    window: usize,
) -> Result<SessionSearchResult, String> {
    sync_sessions_dir(sessions_dir)?;
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

    let mut raw_hits = if query.chars().any(is_cjk) {
        search_like(&connection, query, limit.saturating_mul(4).max(4))?
    } else {
        search_fts(&connection, query, limit.saturating_mul(4).max(4))?
    };
    let mut seen = BTreeSet::new();
    raw_hits.retain(|(session_id, _, _)| seen.insert(session_id.clone()));
    raw_hits.truncate(limit.max(1));
    let mut results = Vec::new();
    for (hit_session_id, message_index, snippet) in raw_hits {
        let path = connection
            .query_row(
                "SELECT path FROM sessions WHERE session_id = ?1",
                [&hit_session_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_default();
        results.push(SessionSearchHit {
            messages: load_messages(&connection, &hit_session_id, Some(message_index), window)?,
            session_id: hit_session_id,
            path,
            snippet,
            match_message_index: message_index,
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
               message_count INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS messages(
               session_id TEXT NOT NULL,
               message_index INTEGER NOT NULL,
               role TEXT NOT NULL,
               content TEXT NOT NULL,
               PRIMARY KEY(session_id, message_index)
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
               session_id UNINDEXED,
               message_index UNINDEXED,
               role UNINDEXED,
               content
             );",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
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
) -> Result<Vec<(String, usize, String)>, String> {
    let fts_query = query
        .split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ");
    let mut statement = connection
        .prepare(
            "SELECT session_id, message_index, snippet(messages_fts, 3, '[', ']', '...', 24)
             FROM messages_fts WHERE messages_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![fts_query, limit], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn search_like(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<(String, usize, String)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT session_id, message_index, substr(content, 1, 300)
             FROM messages WHERE content LIKE ?1 ORDER BY rowid DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![format!("%{query}%"), limit], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
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
