use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SCHEMA_VERSION: i64 = 2;
const OUTBOX_MAX_ATTEMPTS: i64 = 10;
const PROFILE_CHAR_LIMIT: usize = 2_000;
const MAX_ATOMS_PER_TURN: usize = 12;
/// A recall candidate must share at least this many distinct content terms with
/// the query. Prompt budget is scarce, so an unrelated derived row is worse than
/// no row at all: it displaces authoritative Session context.
const RECALL_MIN_TERM_OVERLAP: usize = 2;
/// Queries this short cannot supply two content terms, so one is required.
const RECALL_SHORT_QUERY_TERMS: usize = 3;
/// Shorter words are function words or fragments rather than topic anchors.
const RECALL_MIN_WORD_CHARS: usize = 3;
/// Word terms are discriminative enough that a dozen of them saturate a query.
const RECALL_MAX_TERMS: usize = 12;
/// A bigram carries far less signal than a word, so a CJK query needs more of
/// them before its topic is represented; the tail of a Chinese question is
/// usually where the subject sits.
const RECALL_MAX_CJK_TERMS: usize = 24;
/// Fraction of a CJK bigram set a candidate must contain to clear the recall
/// gate. Two unrelated Chinese sentences routinely share a bigram or two, so the
/// fixed word-level bar of [`RECALL_MIN_TERM_OVERLAP`] would admit noise.
const RECALL_CJK_OVERLAP_DIVISOR: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryCapture {
    pub project_id: String,
    pub session_id: String,
    pub source_event_ids: Vec<String>,
    pub user_text: String,
    pub assistant_text: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryAtom {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub statement: String,
    pub normalized_key: String,
    pub scope: String,
    pub confidence_millis: i64,
    pub status: String,
    pub source_session_id: String,
    pub source_event_ids: Vec<String>,
    pub artifact_paths: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub valid_from: Option<String>,
    pub valid_until: Option<String>,
    pub supersedes_id: Option<String>,
    pub score_millis: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryCard {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub atom_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub score_millis: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryProfile {
    pub project_id: String,
    pub content: String,
    pub atom_ids: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryRecall {
    pub atoms: Vec<ResearchMemoryAtom>,
    pub cards: Vec<ResearchMemoryCard>,
    pub profile: Option<ResearchMemoryProfile>,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemorySnapshot {
    pub atoms: Vec<ResearchMemoryAtom>,
    pub cards: Vec<ResearchMemoryCard>,
    pub profile: Option<ResearchMemoryProfile>,
    pub stats: ResearchMemoryStats,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryStats {
    pub atom_count: u64,
    pub card_count: u64,
    pub profile_count: u64,
    pub conflict_count: u64,
    pub pending_count: u64,
    pub dead_letter_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryDeadLetter {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub source_event_ids: Vec<String>,
    pub occurred_at: String,
    pub attempts: i64,
    pub last_error: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct ResearchMemoryStore {
    path: PathBuf,
}

#[derive(Debug, Clone)]
struct ExtractedCandidate {
    kind: String,
    statement: String,
    normalized_key: String,
    confidence_millis: i64,
    artifact_paths: Vec<String>,
    update_signal: bool,
}

#[derive(Debug, Clone)]
struct OutboxItem {
    id: String,
    capture: ResearchMemoryCapture,
    attempts: i64,
}

#[derive(Debug, Clone)]
struct RecallMoment {
    as_of: String,
    historical: bool,
}

impl Default for ResearchMemoryStore {
    fn default() -> Self {
        Self::new(research_memory_db_path())
    }
}

impl ResearchMemoryStore {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn enqueue_capture(&self, capture: &ResearchMemoryCapture) -> Result<bool, String> {
        self.enqueue_captures(std::slice::from_ref(capture))
            .map(|inserted| inserted > 0)
    }

    /// Adds multiple captured turns to the durable outbox using one connection and
    /// transaction. This is intended for session backfills and dataset migration;
    /// normal chat capture can continue to call [`Self::enqueue_capture`].
    pub fn enqueue_captures(&self, captures: &[ResearchMemoryCapture]) -> Result<usize, String> {
        if captures.is_empty() {
            return Ok(0);
        }
        for capture in captures {
            validate_capture(capture)?;
        }
        let mut connection = self.open()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let timestamp = now_millis();
        let mut inserted = 0_usize;
        {
            let mut statement = transaction
                .prepare_cached(
                    "INSERT OR IGNORE INTO research_memory_outbox(
                       id, project_id, session_id, source_event_ids, user_text,
                       assistant_text, occurred_at, status, attempts, next_attempt_at,
                       created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 0, 0, ?8, ?8)",
                )
                .map_err(|error| error.to_string())?;
            for capture in captures {
                inserted += statement
                    .execute(params![
                        capture_id(capture),
                        capture.project_id,
                        capture.session_id,
                        json_string(&capture.source_event_ids)?,
                        capture.user_text,
                        capture.assistant_text,
                        capture.occurred_at,
                        timestamp,
                    ])
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(inserted)
    }

    pub fn drain_outbox(&self, limit: usize) -> Result<usize, String> {
        self.drain_outbox_scoped(None, limit)
    }

    /// Drains one project's queue. The Settings backfill is project-scoped, so
    /// it must not stall on — or report progress against — another project's
    /// backlog.
    pub fn drain_project_outbox(&self, project_id: &str, limit: usize) -> Result<usize, String> {
        validate_project(project_id)?;
        self.drain_outbox_scoped(Some(project_id), limit)
    }

    fn drain_outbox_scoped(
        &self,
        project_id: Option<&str>,
        limit: usize,
    ) -> Result<usize, String> {
        let mut connection = self.open()?;
        let items = load_outbox(&connection, project_id, limit.clamp(1, 100))?;
        let mut completed = 0;
        let mut touched_projects = BTreeSet::new();
        let mut touched_episodes = BTreeSet::new();
        let mut first_error = None;
        for item in items {
            let candidates = extract_candidates(&item.capture);
            let transaction = connection
                .transaction()
                .map_err(|error| error.to_string())?;
            let result = (|| {
                let mut affected_sessions = BTreeSet::new();
                for candidate in &candidates {
                    affected_sessions.extend(upsert_candidate(
                        &transaction,
                        &item.capture,
                        candidate,
                    )?);
                }
                transaction
                    .execute(
                        "UPDATE research_memory_outbox
                         SET status='completed', updated_at=?2 WHERE id=?1",
                        params![item.id, now_millis()],
                    )
                    .map_err(|error| error.to_string())?;
                transaction.commit().map_err(|error| error.to_string())?;
                Ok::<_, String>(affected_sessions)
            })();
            match result {
                Ok(affected_sessions) => {
                    completed += 1;
                    touched_projects.insert(item.capture.project_id.clone());
                    for session_id in affected_sessions {
                        touched_episodes.insert((item.capture.project_id.clone(), session_id));
                    }
                }
                Err(error) => {
                    mark_outbox_failed(&connection, &item.id, item.attempts, &error)?;
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        for (project_id, session_id) in touched_episodes {
            self.refresh_episode(&project_id, &session_id)?;
        }
        for project_id in touched_projects {
            self.refresh_profile(&project_id)?;
        }
        if let Some(error) = first_error {
            Err(error)
        } else {
            Ok(completed)
        }
    }

    /// Drains every currently due item, regardless of backlog size. Future
    /// retries remain pending until their persisted `next_attempt_at`.
    pub fn drain_due_outbox(&self, batch_size: usize) -> Result<usize, String> {
        let batch_size = batch_size.clamp(1, 100);
        let mut total = 0_usize;
        loop {
            let completed = self.drain_outbox(batch_size)?;
            total = total.saturating_add(completed);
            if completed < batch_size {
                return Ok(total);
            }
        }
    }

    /// Returns dead-lettered captures to the queue. Nothing else moves an item
    /// out of `dead_letter`, so without this the Settings page can only watch
    /// them accumulate.
    pub fn retry_dead_letters(&self, project_id: &str) -> Result<usize, String> {
        validate_project(project_id)?;
        let connection = self.open()?;
        let restored = connection
            .execute(
                "UPDATE research_memory_outbox
                 SET status='pending', attempts=0, next_attempt_at=0, updated_at=?2
                 WHERE project_id=?1 AND status='dead_letter'",
                params![project_id, now_millis()],
            )
            .map_err(|error| error.to_string())?;
        Ok(restored)
    }

    pub fn recall(
        &self,
        project_id: &str,
        query: &str,
        atom_limit: usize,
        card_limit: usize,
    ) -> Result<ResearchMemoryRecall, String> {
        validate_project(project_id)?;
        let started = Instant::now();
        let connection = self.open()?;
        let moment = recall_moment(query);
        let atoms = recall_atoms_conn(
            &connection,
            project_id,
            query,
            atom_limit.clamp(1, 20),
            &moment,
        )?;
        let cards = recall_cards_conn(
            &connection,
            project_id,
            query,
            card_limit.clamp(1, 10),
            &moment,
        )?;
        let profile = load_recall_profile_conn(&connection, project_id, &moment)?;
        Ok(ResearchMemoryRecall {
            atoms,
            cards,
            profile,
            latency_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        })
    }

    pub fn snapshot(
        &self,
        project_id: &str,
        limit: usize,
    ) -> Result<ResearchMemorySnapshot, String> {
        validate_project(project_id)?;
        let connection = self.open()?;
        let atoms = list_atoms_conn(&connection, project_id, limit.clamp(1, 200))?;
        let cards = list_cards_conn(&connection, project_id, limit.clamp(1, 100))?;
        let profile = load_profile_conn(&connection, project_id)?;
        let stats = stats_conn(&connection, project_id)?;
        Ok(ResearchMemorySnapshot {
            atoms,
            cards,
            profile,
            stats,
        })
    }

    pub fn search_atoms(
        &self,
        project_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ResearchMemoryAtom>, String> {
        validate_project(project_id)?;
        let connection = self.open()?;
        search_atoms_conn(&connection, project_id, query, limit.clamp(1, 100), true)
    }

    pub fn read_card(
        &self,
        project_id: &str,
        id: &str,
    ) -> Result<Option<ResearchMemoryCard>, String> {
        validate_project(project_id)?;
        let connection = self.open()?;
        load_card_conn(&connection, project_id, id)
    }

    pub fn update_atom(&self, project_id: &str, id: &str, statement: &str) -> Result<(), String> {
        validate_project(project_id)?;
        let statement = statement.trim();
        if statement.is_empty() {
            return Err("research memory statement cannot be empty".to_string());
        }
        let mut connection = self.open()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let existing = transaction
            .query_row(
                "SELECT kind, source_session_id FROM research_memory_atoms
                  WHERE project_id=?1 AND id=?2 AND deleted=0",
                params![project_id, id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "research memory atom was not found".to_string())?;
        let normalized_key = normalized_key(statement, &existing.0);
        transaction
            .execute(
                "UPDATE research_memory_atoms SET statement=?3, status='user_confirmed',
                   normalized_key=?4, confidence_millis=1000,
                   extractor='user', updated_at=?5
                 WHERE project_id=?1 AND id=?2",
                params![project_id, id, statement, normalized_key, now_millis()],
            )
            .map_err(|error| error.to_string())?;
        replace_atom_fts(&transaction, id, project_id, "user_confirmed", statement)?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.refresh_episode(project_id, &existing.1)?;
        self.refresh_profile(project_id)
    }

    pub fn delete_atom(&self, project_id: &str, id: &str) -> Result<(), String> {
        validate_project(project_id)?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let source_session_id = transaction
            .query_row(
                "SELECT source_session_id FROM research_memory_atoms
                 WHERE project_id=?1 AND id=?2 AND deleted=0",
                params![project_id, id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "research memory atom was not found".to_string())?;
        let changed = transaction
            .execute(
                "UPDATE research_memory_atoms SET deleted=1, status='deleted', updated_at=?3
                 WHERE project_id=?1 AND id=?2 AND deleted=0",
                params![project_id, id, now_millis()],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("research memory atom was not found".to_string());
        }
        transaction
            .execute("DELETE FROM research_memory_atoms_fts WHERE id=?1", [id])
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.refresh_episode(project_id, &source_session_id)?;
        self.refresh_profile(project_id)
    }

    pub fn stats(&self, project_id: &str) -> Result<ResearchMemoryStats, String> {
        validate_project(project_id)?;
        let connection = self.open()?;
        stats_conn(&connection, project_id)
    }

    pub fn dead_letters(
        &self,
        project_id: &str,
        limit: usize,
    ) -> Result<Vec<ResearchMemoryDeadLetter>, String> {
        validate_project(project_id)?;
        let connection = self.open()?;
        load_dead_letters(&connection, project_id, limit.clamp(1, 100))
    }

    pub fn next_outbox_delay(&self) -> Result<Option<Duration>, String> {
        let connection = self.open()?;
        let next = connection
            .query_row(
                "SELECT MIN(next_attempt_at) FROM research_memory_outbox
                 WHERE status='pending'",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(|error| error.to_string())?;
        Ok(next.map(|next_attempt| {
            let wait_millis = next_attempt.saturating_sub(now_millis()).max(0);
            Duration::from_millis(u64::try_from(wait_millis).unwrap_or(u64::MAX))
        }))
    }

    fn refresh_episode(&self, project_id: &str, session_id: &str) -> Result<(), String> {
        let mut connection = self.open()?;
        let atoms = list_active_atoms_for_episode(&connection, project_id, session_id)?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        refresh_episode_card(&transaction, project_id, session_id, &atoms)?;
        transaction.commit().map_err(|error| error.to_string())
    }

    fn refresh_profile(&self, project_id: &str) -> Result<(), String> {
        let mut connection = self.open()?;
        let atoms = list_active_atoms_for_derived(&connection, project_id)?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        refresh_profile(&transaction, project_id, &atoms)?;
        transaction.commit().map_err(|error| error.to_string())
    }

    fn open(&self) -> Result<Connection, String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(&self.path).map_err(|error| error.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=NORMAL;
                 PRAGMA foreign_keys=ON;",
            )
            .map_err(|error| error.to_string())?;
        ensure_schema(&connection)?;
        Ok(connection)
    }
}

#[must_use]
pub fn research_memory_db_path() -> PathBuf {
    std::env::var_os("SOMNIQ_RESEARCH_MEMORY_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            crate::somniq_config_dir_from_env()
                .join("memory")
                .join("builtin")
                .join("research-memory.sqlite3")
        })
}

fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS research_memory_metadata(
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS research_memory_atoms(
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               kind TEXT NOT NULL,
               statement TEXT NOT NULL,
               normalized_key TEXT NOT NULL,
               scope TEXT NOT NULL,
               confidence_millis INTEGER NOT NULL,
               status TEXT NOT NULL,
               source_session_id TEXT NOT NULL,
               source_event_ids TEXT NOT NULL,
               artifact_paths TEXT NOT NULL,
               extractor TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               valid_from TEXT,
               valid_until TEXT,
               supersedes_id TEXT,
               deleted INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS research_memory_atoms_project_key
               ON research_memory_atoms(project_id, normalized_key, deleted, updated_at);
             CREATE INDEX IF NOT EXISTS research_memory_atoms_project_kind
               ON research_memory_atoms(project_id, kind, status, updated_at);
             CREATE VIRTUAL TABLE IF NOT EXISTS research_memory_atoms_fts USING fts5(
               id UNINDEXED, project_id UNINDEXED, kind, statement,
               tokenize='unicode61 remove_diacritics 2'
             );
             CREATE TABLE IF NOT EXISTS research_memory_sources(
               atom_id TEXT NOT NULL,
               session_id TEXT NOT NULL,
               event_id TEXT NOT NULL,
               artifact_path TEXT NOT NULL DEFAULT '',
               observed_at TEXT NOT NULL,
               PRIMARY KEY(atom_id, session_id, event_id, artifact_path)
             );
             CREATE TABLE IF NOT EXISTS research_memory_relations(
               from_atom_id TEXT NOT NULL,
               to_atom_id TEXT NOT NULL,
               relation TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               PRIMARY KEY(from_atom_id, to_atom_id, relation)
             );
             CREATE TABLE IF NOT EXISTS research_memory_cards(
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               kind TEXT NOT NULL,
               title TEXT NOT NULL,
               summary TEXT NOT NULL,
               atom_ids TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS research_memory_cards_project
               ON research_memory_cards(project_id, updated_at);
             CREATE VIRTUAL TABLE IF NOT EXISTS research_memory_cards_fts USING fts5(
               id UNINDEXED, project_id UNINDEXED, kind, title, summary,
               tokenize='unicode61 remove_diacritics 2'
             );
             CREATE TABLE IF NOT EXISTS research_memory_profiles(
               project_id TEXT PRIMARY KEY,
               content TEXT NOT NULL,
               atom_ids TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS research_memory_outbox(
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               session_id TEXT NOT NULL,
               source_event_ids TEXT NOT NULL,
               user_text TEXT NOT NULL,
               assistant_text TEXT NOT NULL,
               occurred_at TEXT NOT NULL,
               status TEXT NOT NULL,
               attempts INTEGER NOT NULL,
               next_attempt_at INTEGER NOT NULL DEFAULT 0,
               last_error TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS research_memory_outbox_status
               ON research_memory_outbox(status, created_at);",
        )
        .map_err(|error| error.to_string())?;
    ensure_outbox_next_attempt_column(connection)?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS research_memory_outbox_due
             ON research_memory_outbox(status, next_attempt_at, created_at)",
            [],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO research_memory_metadata(key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [SCHEMA_VERSION.to_string()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_outbox_next_attempt_column(connection: &Connection) -> Result<(), String> {
    let has_column = {
        let mut statement = connection
            .prepare("PRAGMA table_info(research_memory_outbox)")
            .map_err(|error| error.to_string())?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?;
        let mut found = false;
        for column in columns {
            if column.map_err(|error| error.to_string())? == "next_attempt_at" {
                found = true;
                break;
            }
        }
        found
    };
    if !has_column {
        connection
            .execute(
                "ALTER TABLE research_memory_outbox
                 ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn validate_capture(capture: &ResearchMemoryCapture) -> Result<(), String> {
    validate_project(&capture.project_id)?;
    if capture.session_id.trim().is_empty() {
        return Err("research memory capture requires a session id".to_string());
    }
    if capture.source_event_ids.is_empty() {
        return Err("research memory capture requires source event ids".to_string());
    }
    if capture.user_text.trim().is_empty() || capture.assistant_text.trim().is_empty() {
        return Err("research memory capture requires user and assistant text".to_string());
    }
    Ok(())
}

fn validate_project(project_id: &str) -> Result<(), String> {
    if project_id.trim().is_empty() {
        Err("research memory requires a project id".to_string())
    } else {
        Ok(())
    }
}

fn load_outbox(
    connection: &Connection,
    project_id: Option<&str>,
    limit: usize,
) -> Result<Vec<OutboxItem>, String> {
    let project_filter = if project_id.is_some() {
        "AND project_id=?3"
    } else {
        ""
    };
    let sql = format!(
        "SELECT id, project_id, session_id, source_event_ids, user_text,
                assistant_text, occurred_at, attempts
         FROM research_memory_outbox
         WHERE status='pending' AND next_attempt_at <= ?1 {project_filter}
         ORDER BY next_attempt_at, created_at LIMIT ?2"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let mut values = vec![
        rusqlite::types::Value::from(now_millis()),
        rusqlite::types::Value::from(i64::try_from(limit).unwrap_or(i64::MAX)),
    ];
    if let Some(project_id) = project_id {
        values.push(project_id.to_string().into());
    }
    let rows = statement
        .query_map(rusqlite::params_from_iter(values), |row| {
            let source_event_ids = parse_json_vec(&row.get::<_, String>(3)?);
            Ok(OutboxItem {
                id: row.get(0)?,
                capture: ResearchMemoryCapture {
                    project_id: row.get(1)?,
                    session_id: row.get(2)?,
                    source_event_ids,
                    user_text: row.get(4)?,
                    assistant_text: row.get(5)?,
                    occurred_at: row.get(6)?,
                },
                attempts: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn mark_outbox_failed(
    connection: &Connection,
    id: &str,
    attempts: i64,
    error: &str,
) -> Result<(), String> {
    let attempts = attempts + 1;
    let status = if attempts >= OUTBOX_MAX_ATTEMPTS {
        "dead_letter"
    } else {
        "pending"
    };
    let exponent = u32::try_from(attempts.clamp(0, 12)).unwrap_or(12);
    let delay_seconds = 2_i64.pow(exponent).min(3_600);
    connection
        .execute(
            "UPDATE research_memory_outbox
             SET status=?2, attempts=?3, next_attempt_at=?4, last_error=?5,
                 updated_at=?6 WHERE id=?1",
            params![
                id,
                status,
                attempts,
                now_millis().saturating_add(delay_seconds.saturating_mul(1_000)),
                truncate_chars(error, 500),
                now_millis()
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn upsert_candidate(
    transaction: &Transaction<'_>,
    capture: &ResearchMemoryCapture,
    candidate: &ExtractedCandidate,
) -> Result<BTreeSet<String>, String> {
    let mut affected_sessions = BTreeSet::from([capture.session_id.clone()]);
    let existing = transaction
        .query_row(
            "SELECT id, statement, status, source_event_ids, artifact_paths,
                    source_session_id, valid_from
             FROM research_memory_atoms
             WHERE project_id=?1 AND normalized_key=?2 AND deleted=0
               AND status NOT IN ('superseded', 'deleted')
             ORDER BY updated_at DESC LIMIT 1",
            params![capture.project_id, candidate.normalized_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some((id, statement, _, existing_events, existing_artifacts, existing_session_id, _)) =
        existing.as_ref()
    {
        affected_sessions.insert(existing_session_id.clone());
        if normalize_statement(statement) == normalize_statement(&candidate.statement) {
            let mut source_event_ids = parse_json_vec(existing_events);
            source_event_ids.extend(capture.source_event_ids.iter().cloned());
            source_event_ids.sort();
            source_event_ids.dedup();
            let mut artifact_paths = parse_json_vec(existing_artifacts);
            artifact_paths.extend(candidate.artifact_paths.iter().cloned());
            artifact_paths.sort();
            artifact_paths.dedup();
            transaction
                .execute(
                    "UPDATE research_memory_atoms SET updated_at=?2,
                       confidence_millis=MAX(confidence_millis, ?3),
                       source_event_ids=?4, artifact_paths=?5 WHERE id=?1",
                    params![
                        id,
                        now_millis(),
                        candidate.confidence_millis,
                        json_string(&source_event_ids)?,
                        json_string(&artifact_paths)?
                    ],
                )
                .map_err(|error| error.to_string())?;
            insert_sources(transaction, id, capture, &candidate.artifact_paths)?;
            return Ok(affected_sessions);
        }
    }

    let id = atom_id(capture, candidate);
    let mut status = "derived".to_string();
    let mut supersedes_id = None;
    let mut valid_until = None;
    if let Some((existing_id, _, _, _, _, existing_session_id, existing_valid_from)) = existing {
        affected_sessions.insert(existing_session_id);
        let may_supersede = candidate.update_signal
            || matches!(
                candidate.kind.as_str(),
                "research_decision" | "constraint" | "user_preference" | "environment_fact"
            );
        if candidate.normalized_key.starts_with("subject:") && may_supersede {
            // Strictly newer, not "not older". Both halves of one captured turn
            // carry the same `occurred_at`, and the assistant's acknowledgement
            // ("recorded the executor model choice") is extracted after the
            // user's actual decision — under `>=` the echo superseded the
            // statement it was echoing. An equal timestamp is the same moment,
            // never a knowledge update.
            let candidate_is_newer = existing_valid_from
                .as_deref()
                .is_none_or(|current| capture.occurred_at.as_str() > current);
            if candidate_is_newer {
                transaction
                    .execute(
                        "UPDATE research_memory_atoms SET status='superseded', valid_until=?2,
                           updated_at=?3
                         WHERE id=?1",
                        params![existing_id, capture.occurred_at, now_millis()],
                    )
                    .map_err(|error| error.to_string())?;
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO research_memory_relations(
                           from_atom_id, to_atom_id, relation, created_at
                         ) VALUES (?1, ?2, 'supersedes', ?3)",
                        params![id, existing_id, now_millis()],
                    )
                    .map_err(|error| error.to_string())?;
                supersedes_id = Some(existing_id);
            } else {
                status = "superseded".to_string();
                valid_until = existing_valid_from;
                transaction
                    .execute(
                        "UPDATE research_memory_atoms
                         SET supersedes_id=COALESCE(supersedes_id, ?2) WHERE id=?1",
                        params![existing_id, id],
                    )
                    .map_err(|error| error.to_string())?;
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO research_memory_relations(
                           from_atom_id, to_atom_id, relation, created_at
                         ) VALUES (?1, ?2, 'supersedes', ?3)",
                        params![existing_id, id, now_millis()],
                    )
                    .map_err(|error| error.to_string())?;
            }
        } else if candidate.normalized_key.starts_with("subject:") {
            status = "conflict".to_string();
            transaction
                .execute(
                    "UPDATE research_memory_atoms SET status='conflict', updated_at=?2
                     WHERE id=?1",
                    params![existing_id, now_millis()],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO research_memory_relations(
                       from_atom_id, to_atom_id, relation, created_at
                     ) VALUES (?1, ?2, 'conflicts_with', ?3)",
                    params![id, existing_id, now_millis()],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    let now = now_millis();
    transaction
        .execute(
            "INSERT OR IGNORE INTO research_memory_atoms(
               id, project_id, kind, statement, normalized_key, scope,
               confidence_millis, status, source_session_id, source_event_ids,
               artifact_paths, extractor, created_at, updated_at,
               valid_from, valid_until, supersedes_id, deleted
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'project', ?6, ?7, ?8, ?9,
                       ?10, 'builtin_rules_v1', ?11, ?11, ?12, ?13, ?14, 0)",
            params![
                id,
                capture.project_id,
                candidate.kind,
                candidate.statement,
                candidate.normalized_key,
                candidate.confidence_millis,
                status,
                capture.session_id,
                json_string(&capture.source_event_ids)?,
                json_string(&candidate.artifact_paths)?,
                now,
                capture.occurred_at,
                valid_until,
                supersedes_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    replace_atom_fts(
        transaction,
        &id,
        &capture.project_id,
        &candidate.kind,
        &candidate.statement,
    )?;
    insert_sources(transaction, &id, capture, &candidate.artifact_paths)?;
    Ok(affected_sessions)
}

fn insert_sources(
    transaction: &Transaction<'_>,
    atom_id: &str,
    capture: &ResearchMemoryCapture,
    artifacts: &[String],
) -> Result<(), String> {
    let artifacts = if artifacts.is_empty() {
        vec![String::new()]
    } else {
        artifacts.to_vec()
    };
    for event_id in &capture.source_event_ids {
        for artifact in &artifacts {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO research_memory_sources(
                       atom_id, session_id, event_id, artifact_path, observed_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        atom_id,
                        capture.session_id,
                        event_id,
                        artifact,
                        capture.occurred_at
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn replace_atom_fts(
    transaction: &Transaction<'_>,
    id: &str,
    project_id: &str,
    kind: &str,
    statement: &str,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM research_memory_atoms_fts WHERE id=?1", [id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO research_memory_atoms_fts(id, project_id, kind, statement)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, project_id, kind, statement],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn refresh_episode_card(
    transaction: &Transaction<'_>,
    project_id: &str,
    session_id: &str,
    atoms: &[ResearchMemoryAtom],
) -> Result<(), String> {
    let id = stable_id("card", &[project_id, session_id]);
    let existing_created = transaction
        .query_row(
            "SELECT created_at FROM research_memory_cards
             WHERE project_id=?1 AND id=?2",
            params![project_id, id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM research_memory_cards_fts WHERE id=?1", [&id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM research_memory_cards WHERE project_id=?1 AND id=?2",
            params![project_id, id],
        )
        .map_err(|error| error.to_string())?;
    let mut members = atoms
        .iter()
        .filter(|atom| atom.status != "conflict")
        .collect::<Vec<_>>();
    if members.is_empty() {
        return Ok(());
    }
    members.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    members.truncate(10);
    let (title_prefix, kind) = episode_title(&members);
    let title = format!(
        "{title_prefix} · Session {}",
        truncate_chars(session_id, 24)
    );
    let atom_ids = members
        .iter()
        .map(|atom| atom.id.clone())
        .collect::<Vec<_>>();
    let summary = members
        .iter()
        .map(|atom| format!("- {} [R1:{}]", atom.statement, atom.id))
        .collect::<Vec<_>>()
        .join("\n");
    let now = now_millis();
    let created_at = existing_created.unwrap_or(now);
    transaction
        .execute(
            "INSERT INTO research_memory_cards(
               id, project_id, kind, title, summary, atom_ids, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                project_id,
                kind,
                title,
                summary,
                json_string(&atom_ids)?,
                created_at,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO research_memory_cards_fts(id, project_id, kind, title, summary)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, project_id, kind, title, summary],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn refresh_profile(
    transaction: &Transaction<'_>,
    project_id: &str,
    atoms: &[ResearchMemoryAtom],
) -> Result<(), String> {
    let selected = atoms
        .iter()
        .filter(|atom| {
            atom.confidence_millis >= 650
                && atom.status != "conflict"
                && matches!(
                    atom.kind.as_str(),
                    "user_preference"
                        | "research_decision"
                        | "constraint"
                        | "methodological_lesson"
                )
        })
        .take(16)
        .collect::<Vec<_>>();
    if selected.is_empty() {
        transaction
            .execute(
                "DELETE FROM research_memory_profiles WHERE project_id=?1",
                [project_id],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    let mut content = String::from("# Project research constitution\n");
    let mut atom_ids = Vec::new();
    for atom in selected {
        let line = format!("\n- [{}] {}", atom.kind, atom.statement);
        if content.chars().count() + line.chars().count() > PROFILE_CHAR_LIMIT {
            break;
        }
        content.push_str(&line);
        atom_ids.push(atom.id.clone());
    }
    transaction
        .execute(
            "INSERT INTO research_memory_profiles(project_id, content, atom_ids, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(project_id) DO UPDATE SET
               content=excluded.content, atom_ids=excluded.atom_ids,
               updated_at=excluded.updated_at",
            params![project_id, content, json_string(&atom_ids)?, now_millis()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn list_active_atoms_for_derived(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<ResearchMemoryAtom>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, kind, statement, normalized_key, scope,
                    confidence_millis, status, source_session_id, source_event_ids,
                    artifact_paths, created_at, updated_at, valid_from, valid_until,
                    supersedes_id
             FROM research_memory_atoms
             WHERE project_id=?1 AND deleted=0 AND status NOT IN ('superseded', 'deleted')
             ORDER BY CASE status WHEN 'user_confirmed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                      updated_at DESC LIMIT 500",
        )
        .map_err(|error| error.to_string())?;
    map_atoms(&mut statement, params![project_id], false)
}

fn list_active_atoms_for_episode(
    connection: &Connection,
    project_id: &str,
    session_id: &str,
) -> Result<Vec<ResearchMemoryAtom>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, kind, statement, normalized_key, scope,
                    confidence_millis, status, source_session_id, source_event_ids,
                    artifact_paths, created_at, updated_at, valid_from, valid_until,
                    supersedes_id
             FROM research_memory_atoms
             WHERE project_id=?1 AND source_session_id=?2 AND deleted=0
               AND status NOT IN ('superseded', 'deleted')
             ORDER BY CASE status WHEN 'user_confirmed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                      updated_at DESC LIMIT 100",
        )
        .map_err(|error| error.to_string())?;
    map_atoms(&mut statement, params![project_id, session_id], false)
}

fn list_atoms_conn(
    connection: &Connection,
    project_id: &str,
    limit: usize,
) -> Result<Vec<ResearchMemoryAtom>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, kind, statement, normalized_key, scope,
                    confidence_millis, status, source_session_id, source_event_ids,
                    artifact_paths, created_at, updated_at, valid_from, valid_until,
                    supersedes_id
             FROM research_memory_atoms
             WHERE project_id=?1 AND deleted=0
             ORDER BY updated_at DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    map_atoms(&mut statement, params![project_id, limit], false)
}

fn search_atoms_conn(
    connection: &Connection,
    project_id: &str,
    query: &str,
    limit: usize,
    include_conflicts: bool,
) -> Result<Vec<ResearchMemoryAtom>, String> {
    // FTS5's `unicode61` tokenizer cannot segment ideographs, so a CJK query
    // goes straight to the substring path instead of spending a round trip on a
    // match that can never land.
    if query.chars().any(is_cjk) {
        return like_search_atoms(connection, project_id, query, limit, include_conflicts);
    }
    let fts = fts_query(query);
    if fts.is_empty() {
        return if include_conflicts {
            list_atoms_conn(connection, project_id, limit)
        } else {
            list_recall_atoms_conn(connection, project_id, limit)
        };
    }
    let excluded_statuses = if include_conflicts {
        "('superseded', 'deleted')"
    } else {
        "('superseded', 'deleted', 'conflict')"
    };
    let sql = format!(
        "SELECT a.id, a.project_id, a.kind, a.statement, a.normalized_key,
                a.scope, a.confidence_millis, a.status, a.source_session_id,
                a.source_event_ids, a.artifact_paths, a.created_at, a.updated_at,
                a.valid_from, a.valid_until, a.supersedes_id,
                bm25(research_memory_atoms_fts) AS rank
         FROM research_memory_atoms_fts
         JOIN research_memory_atoms a ON a.id=research_memory_atoms_fts.id
         WHERE research_memory_atoms_fts MATCH ?1 AND a.project_id=?2
           AND a.deleted=0 AND a.status NOT IN {excluded_statuses}
         ORDER BY CASE a.status WHEN 'user_confirmed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                  rank, a.confidence_millis DESC, a.updated_at DESC
         LIMIT ?3"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let hits = map_atoms(&mut statement, params![fts, project_id, limit], true)?;
    if hits.is_empty() {
        like_search_atoms(connection, project_id, query, limit, include_conflicts)
    } else {
        Ok(hits)
    }
}

fn recall_excluded_statuses(moment: &RecallMoment) -> &'static str {
    if moment.historical {
        "('deleted', 'conflict')"
    } else {
        "('superseded', 'deleted', 'conflict')"
    }
}

/// Gated recall for prompt injection. Unlike [`search_atoms_conn`], which backs
/// the inspection UI and must always show something, this path returns nothing
/// when the query has no lexical anchor in the derived rows.
fn recall_atoms_conn(
    connection: &Connection,
    project_id: &str,
    query: &str,
    limit: usize,
    moment: &RecallMoment,
) -> Result<Vec<ResearchMemoryAtom>, String> {
    let terms = recall_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    // FTS5 cannot segment CJK, so a query carrying any ideograph is answered
    // over bigrams with LIKE instead. Without this branch R1 is unreachable for
    // a Chinese-language project even though the statements are indexed.
    let candidates = if query.chars().any(is_cjk) {
        recall_atoms_like(connection, project_id, &terms, over_fetch(limit), moment)?
    } else {
        recall_atoms_fts(connection, project_id, &terms, over_fetch(limit), moment)?
    };
    Ok(candidates
        .into_iter()
        .filter(|atom| meets_overlap(&atom.statement, &terms))
        .take(limit)
        .collect())
}

fn recall_atoms_fts(
    connection: &Connection,
    project_id: &str,
    terms: &[String],
    limit: usize,
    moment: &RecallMoment,
) -> Result<Vec<ResearchMemoryAtom>, String> {
    let excluded_statuses = recall_excluded_statuses(moment);
    let sql = format!(
        "SELECT a.id, a.project_id, a.kind, a.statement, a.normalized_key,
                a.scope, a.confidence_millis, a.status, a.source_session_id,
                a.source_event_ids, a.artifact_paths, a.created_at, a.updated_at,
                a.valid_from, a.valid_until, a.supersedes_id,
                bm25(research_memory_atoms_fts) AS rank
         FROM research_memory_atoms_fts
         JOIN research_memory_atoms a ON a.id=research_memory_atoms_fts.id
         WHERE research_memory_atoms_fts MATCH ?1 AND a.project_id=?2
           AND a.deleted=0 AND a.status NOT IN {excluded_statuses}
           AND (a.valid_from IS NULL OR a.valid_from <= ?3)
           AND (a.valid_until IS NULL OR a.valid_until > ?3)
         ORDER BY CASE a.status WHEN 'user_confirmed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                  rank, a.confidence_millis DESC, COALESCE(a.valid_from, '') DESC,
                  a.updated_at DESC
         LIMIT ?4"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    map_atoms(
        &mut statement,
        params![fts_terms_query(terms), project_id, &moment.as_of, limit],
        true,
    )
}

fn recall_atoms_like(
    connection: &Connection,
    project_id: &str,
    terms: &[String],
    limit: usize,
    moment: &RecallMoment,
) -> Result<Vec<ResearchMemoryAtom>, String> {
    let excluded_statuses = recall_excluded_statuses(moment);
    let (matches, relevance) = like_clauses("statement", terms.len(), 4);
    let sql = format!(
        "SELECT id, project_id, kind, statement, normalized_key, scope,
                confidence_millis, status, source_session_id, source_event_ids,
                artifact_paths, created_at, updated_at, valid_from, valid_until,
                supersedes_id
         FROM research_memory_atoms
         WHERE project_id=?1 AND deleted=0 AND status NOT IN {excluded_statuses}
           AND (valid_from IS NULL OR valid_from <= ?2)
           AND (valid_until IS NULL OR valid_until > ?2)
           AND ({matches})
         ORDER BY ({relevance}) DESC,
                  CASE status WHEN 'user_confirmed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                  confidence_millis DESC, COALESCE(valid_from, '') DESC, updated_at DESC
         LIMIT ?3"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let mut values = vec![
        rusqlite::types::Value::from(project_id.to_string()),
        rusqlite::types::Value::from(moment.as_of.clone()),
        rusqlite::types::Value::from(i64::try_from(limit).unwrap_or(i64::MAX)),
    ];
    values.extend(terms.iter().map(|term| like_pattern(term).into()));
    map_atoms(
        &mut statement,
        rusqlite::params_from_iter(values),
        false,
    )
}

/// Gated card recall; see [`recall_atoms_conn`].
fn recall_cards_conn(
    connection: &Connection,
    project_id: &str,
    query: &str,
    limit: usize,
    moment: &RecallMoment,
) -> Result<Vec<ResearchMemoryCard>, String> {
    let terms = recall_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let candidates = if query.chars().any(is_cjk) {
        recall_cards_like(connection, project_id, &terms, over_fetch(limit))?
    } else {
        recall_cards_fts(connection, project_id, &terms, over_fetch(limit))?
    };
    let mut recalled = Vec::new();
    for card in candidates {
        if !meets_overlap(&format!("{} {}", card.title, card.summary), &terms) {
            continue;
        }
        if let Some(card) = materialize_recall_card(connection, card, moment)? {
            recalled.push(card);
        }
        if recalled.len() >= limit {
            break;
        }
    }
    Ok(recalled)
}

fn recall_cards_fts(
    connection: &Connection,
    project_id: &str,
    terms: &[String],
    limit: usize,
) -> Result<Vec<ResearchMemoryCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT c.id, c.project_id, c.kind, c.title, c.summary, c.atom_ids,
                    c.created_at, c.updated_at, bm25(research_memory_cards_fts) AS rank
             FROM research_memory_cards_fts
             JOIN research_memory_cards c ON c.id=research_memory_cards_fts.id
             WHERE research_memory_cards_fts MATCH ?1 AND c.project_id=?2
             ORDER BY rank, c.updated_at DESC LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    map_cards(
        &mut statement,
        params![fts_terms_query(terms), project_id, limit],
        true,
    )
}

fn recall_cards_like(
    connection: &Connection,
    project_id: &str,
    terms: &[String],
    limit: usize,
) -> Result<Vec<ResearchMemoryCard>, String> {
    let (matches, relevance) = like_clauses("(title || ' ' || summary)", terms.len(), 3);
    let sql = format!(
        "SELECT id, project_id, kind, title, summary, atom_ids, created_at, updated_at
         FROM research_memory_cards
         WHERE project_id=?1 AND ({matches})
         ORDER BY ({relevance}) DESC, updated_at DESC LIMIT ?2"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let mut values = vec![
        rusqlite::types::Value::from(project_id.to_string()),
        rusqlite::types::Value::from(i64::try_from(limit).unwrap_or(i64::MAX)),
    ];
    values.extend(terms.iter().map(|term| like_pattern(term).into()));
    map_cards(&mut statement, rusqlite::params_from_iter(values), false)
}

fn materialize_recall_card(
    connection: &Connection,
    mut card: ResearchMemoryCard,
    moment: &RecallMoment,
) -> Result<Option<ResearchMemoryCard>, String> {
    let excluded_statuses = recall_excluded_statuses(moment);
    let sql = format!(
        "SELECT id, project_id, kind, statement, normalized_key, scope,
                confidence_millis, status, source_session_id, source_event_ids,
                artifact_paths, created_at, updated_at, valid_from, valid_until,
                supersedes_id
         FROM research_memory_atoms
         WHERE id=?1 AND project_id=?2 AND deleted=0
           AND status NOT IN {excluded_statuses}
           AND (valid_from IS NULL OR valid_from <= ?3)
           AND (valid_until IS NULL OR valid_until > ?3)"
    );
    let mut atoms = Vec::new();
    for atom_id in &card.atom_ids {
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let mut matches = map_atoms(
            &mut statement,
            params![atom_id, &card.project_id, &moment.as_of],
            false,
        )?;
        atoms.append(&mut matches);
    }
    if atoms.is_empty() {
        return Ok(None);
    }
    card.atom_ids = atoms.iter().map(|atom| atom.id.clone()).collect();
    card.summary = atoms
        .iter()
        .map(|atom| format!("- {} [R1:{}]", atom.statement, atom.id))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(Some(card))
}

/// BM25 ranks noise above signal when a query ORs many terms, so read past the
/// requested window before the overlap filter runs.
fn over_fetch(limit: usize) -> usize {
    limit.saturating_mul(4).clamp(limit, 80)
}

fn list_recall_atoms_conn(
    connection: &Connection,
    project_id: &str,
    limit: usize,
) -> Result<Vec<ResearchMemoryAtom>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, kind, statement, normalized_key, scope,
                    confidence_millis, status, source_session_id, source_event_ids,
                    artifact_paths, created_at, updated_at, valid_from, valid_until,
                    supersedes_id
             FROM research_memory_atoms
             WHERE project_id=?1 AND deleted=0
               AND status NOT IN ('superseded', 'deleted', 'conflict')
             ORDER BY CASE status WHEN 'user_confirmed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                      confidence_millis DESC, updated_at DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    map_atoms(&mut statement, params![project_id, limit], false)
}

/// Substring fallback for the inspection UI. A CJK query is matched term by term
/// rather than as one long substring: FTS returns nothing for ideographs, so
/// this is the only path Chinese search has, and requiring the whole sentence to
/// appear verbatim would make it useless.
fn like_search_atoms(
    connection: &Connection,
    project_id: &str,
    query: &str,
    limit: usize,
    include_conflicts: bool,
) -> Result<Vec<ResearchMemoryAtom>, String> {
    let mut terms = recall_terms(query);
    if terms.is_empty() {
        // Nothing survived tokenisation (a two-letter acronym, say). The raw
        // query is still better than no search at all.
        terms.push(query.trim().to_string());
    }
    let excluded_statuses = if include_conflicts {
        "('superseded', 'deleted')"
    } else {
        "('superseded', 'deleted', 'conflict')"
    };
    let (matches, relevance) = like_clauses("(statement || ' ' || kind)", terms.len(), 3);
    let sql = format!(
        "SELECT id, project_id, kind, statement, normalized_key, scope,
                confidence_millis, status, source_session_id, source_event_ids,
                artifact_paths, created_at, updated_at, valid_from, valid_until,
                supersedes_id
         FROM research_memory_atoms
         WHERE project_id=?1 AND deleted=0 AND status NOT IN {excluded_statuses}
           AND ({matches})
         ORDER BY ({relevance}) DESC, confidence_millis DESC, updated_at DESC LIMIT ?2"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let mut values = vec![
        rusqlite::types::Value::from(project_id.to_string()),
        rusqlite::types::Value::from(i64::try_from(limit).unwrap_or(i64::MAX)),
    ];
    values.extend(terms.iter().map(|term| like_pattern(term).into()));
    map_atoms(&mut statement, rusqlite::params_from_iter(values), false)
}

fn map_atoms<P: rusqlite::Params>(
    statement: &mut rusqlite::Statement<'_>,
    params: P,
    has_rank: bool,
) -> Result<Vec<ResearchMemoryAtom>, String> {
    let rows = statement
        .query_map(params, |row| {
            let confidence = row.get::<_, i64>(6)?;
            let status = row.get::<_, String>(7)?;
            let rank_bonus = if has_rank {
                let rank = row.get::<_, f64>(16).unwrap_or_default().abs();
                (300.0 / (1.0 + rank)).round() as i64
            } else {
                0
            };
            let status_bonus = match status.as_str() {
                "user_confirmed" => 200,
                "reviewed" => 120,
                "conflict" => -250,
                _ => 0,
            };
            Ok(ResearchMemoryAtom {
                id: row.get(0)?,
                project_id: row.get(1)?,
                kind: row.get(2)?,
                statement: row.get(3)?,
                normalized_key: row.get(4)?,
                scope: row.get(5)?,
                confidence_millis: confidence,
                status,
                source_session_id: row.get(8)?,
                source_event_ids: parse_json_vec(&row.get::<_, String>(9)?),
                artifact_paths: parse_json_vec(&row.get::<_, String>(10)?),
                created_at: millis_iso(row.get(11)?),
                updated_at: millis_iso(row.get(12)?),
                valid_from: row.get(13)?,
                valid_until: row.get(14)?,
                supersedes_id: row.get(15)?,
                score_millis: (confidence + status_bonus + rank_bonus).clamp(0, 1000),
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn list_cards_conn(
    connection: &Connection,
    project_id: &str,
    limit: usize,
) -> Result<Vec<ResearchMemoryCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, kind, title, summary, atom_ids, created_at, updated_at
             FROM research_memory_cards WHERE project_id=?1
             ORDER BY updated_at DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    map_cards(&mut statement, params![project_id, limit], false)
}

fn load_card_conn(
    connection: &Connection,
    project_id: &str,
    id: &str,
) -> Result<Option<ResearchMemoryCard>, String> {
    connection
        .query_row(
            "SELECT id, project_id, kind, title, summary, atom_ids, created_at, updated_at
             FROM research_memory_cards WHERE project_id=?1 AND id=?2",
            params![project_id, id],
            |row| {
                Ok(ResearchMemoryCard {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    kind: row.get(2)?,
                    title: row.get(3)?,
                    summary: row.get(4)?,
                    atom_ids: parse_json_vec(&row.get::<_, String>(5)?),
                    created_at: millis_iso(row.get(6)?),
                    updated_at: millis_iso(row.get(7)?),
                    score_millis: 0,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn map_cards<P: rusqlite::Params>(
    statement: &mut rusqlite::Statement<'_>,
    params: P,
    has_rank: bool,
) -> Result<Vec<ResearchMemoryCard>, String> {
    let rows = statement
        .query_map(params, |row| {
            let rank_bonus = if has_rank {
                let rank = row.get::<_, f64>(8).unwrap_or_default().abs();
                (1000.0 / (1.0 + rank)).round() as i64
            } else {
                0
            };
            Ok(ResearchMemoryCard {
                id: row.get(0)?,
                project_id: row.get(1)?,
                kind: row.get(2)?,
                title: row.get(3)?,
                summary: row.get(4)?,
                atom_ids: parse_json_vec(&row.get::<_, String>(5)?),
                created_at: millis_iso(row.get(6)?),
                updated_at: millis_iso(row.get(7)?),
                score_millis: rank_bonus.clamp(0, 1000),
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn load_profile_conn(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<ResearchMemoryProfile>, String> {
    connection
        .query_row(
            "SELECT project_id, content, atom_ids, updated_at
             FROM research_memory_profiles WHERE project_id=?1",
            [project_id],
            |row| {
                Ok(ResearchMemoryProfile {
                    project_id: row.get(0)?,
                    content: row.get(1)?,
                    atom_ids: parse_json_vec(&row.get::<_, String>(2)?),
                    updated_at: millis_iso(row.get(3)?),
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn load_recall_profile_conn(
    connection: &Connection,
    project_id: &str,
    moment: &RecallMoment,
) -> Result<Option<ResearchMemoryProfile>, String> {
    let excluded_statuses = if moment.historical {
        "('deleted', 'conflict')"
    } else {
        "('superseded', 'deleted', 'conflict')"
    };
    let sql = format!(
        "SELECT id, project_id, kind, statement, normalized_key, scope,
                confidence_millis, status, source_session_id, source_event_ids,
                artifact_paths, created_at, updated_at, valid_from, valid_until,
                supersedes_id
         FROM research_memory_atoms
         WHERE project_id=?1 AND deleted=0 AND status NOT IN {excluded_statuses}
           AND confidence_millis >= 650
           AND kind IN ('user_preference', 'research_decision', 'constraint',
                        'methodological_lesson')
           AND (valid_from IS NULL OR valid_from <= ?2)
           AND (valid_until IS NULL OR valid_until > ?2)
         ORDER BY CASE status WHEN 'user_confirmed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                  COALESCE(valid_from, '') DESC, updated_at DESC
         LIMIT 16"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let atoms = map_atoms(&mut statement, params![project_id, &moment.as_of], false)?;
    if atoms.is_empty() {
        return Ok(None);
    }
    let mut content = String::from("# Project research constitution\n");
    let mut atom_ids = Vec::new();
    for atom in &atoms {
        let line = format!("\n- [{}] {}", atom.kind, atom.statement);
        if content.chars().count() + line.chars().count() > PROFILE_CHAR_LIMIT {
            break;
        }
        content.push_str(&line);
        atom_ids.push(atom.id.clone());
    }
    let updated_at = atoms
        .iter()
        .map(|atom| atom.updated_at.as_str())
        .max()
        .unwrap_or(moment.as_of.as_str())
        .to_string();
    Ok(Some(ResearchMemoryProfile {
        project_id: project_id.to_string(),
        content,
        atom_ids,
        updated_at,
    }))
}

fn stats_conn(connection: &Connection, project_id: &str) -> Result<ResearchMemoryStats, String> {
    let atom_count = count_query(
        connection,
        "SELECT COUNT(*) FROM research_memory_atoms WHERE project_id=?1 AND deleted=0",
        project_id,
    )?;
    let card_count = count_query(
        connection,
        "SELECT COUNT(*) FROM research_memory_cards WHERE project_id=?1",
        project_id,
    )?;
    let profile_count = count_query(
        connection,
        "SELECT COUNT(*) FROM research_memory_profiles WHERE project_id=?1",
        project_id,
    )?;
    let conflict_count = count_query(
        connection,
        "SELECT COUNT(*) FROM research_memory_atoms
         WHERE project_id=?1 AND deleted=0 AND status='conflict'",
        project_id,
    )?;
    let pending_count = count_query(
        connection,
        "SELECT COUNT(*) FROM research_memory_outbox
         WHERE project_id=?1 AND status='pending'",
        project_id,
    )?;
    let dead_letter_count = count_query(
        connection,
        "SELECT COUNT(*) FROM research_memory_outbox
         WHERE project_id=?1 AND status='dead_letter'",
        project_id,
    )?;
    Ok(ResearchMemoryStats {
        atom_count,
        card_count,
        profile_count,
        conflict_count,
        pending_count,
        dead_letter_count,
    })
}

fn load_dead_letters(
    connection: &Connection,
    project_id: &str,
    limit: usize,
) -> Result<Vec<ResearchMemoryDeadLetter>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, session_id, source_event_ids, occurred_at,
                    attempts, COALESCE(last_error, ''), updated_at
             FROM research_memory_outbox
             WHERE project_id=?1 AND status='dead_letter'
             ORDER BY updated_at DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id, limit], |row| {
            Ok(ResearchMemoryDeadLetter {
                id: row.get(0)?,
                project_id: row.get(1)?,
                session_id: row.get(2)?,
                source_event_ids: parse_json_vec(&row.get::<_, String>(3)?),
                occurred_at: row.get(4)?,
                attempts: row.get(5)?,
                last_error: row.get(6)?,
                updated_at: millis_iso(row.get(7)?),
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn count_query(connection: &Connection, sql: &str, project_id: &str) -> Result<u64, String> {
    connection
        .query_row(sql, [project_id], |row| row.get::<_, u64>(0))
        .map_err(|error| error.to_string())
}

fn extract_candidates(capture: &ResearchMemoryCapture) -> Vec<ExtractedCandidate> {
    let mut candidates = Vec::new();
    let mut seen = BTreeSet::new();
    for (role, text, base_confidence) in [
        ("user", capture.user_text.as_str(), 860_i64),
        ("assistant", capture.assistant_text.as_str(), 760_i64),
    ] {
        for sentence in split_sentences(text) {
            let sentence = sentence.trim();
            let minimum_chars = if sentence.chars().any(is_cjk) { 6 } else { 12 };
            if sentence.chars().count() < minimum_chars
                || sentence.chars().count() > 520
                || (role == "user" && looks_like_question(sentence))
            {
                continue;
            }
            let lower = sentence.to_ascii_lowercase();
            let artifacts = extract_artifact_paths(sentence);
            let mut kinds = Vec::new();
            if contains_any(
                &lower,
                &[
                    "i prefer",
                    "i like",
                    "my preference",
                    "we prefer",
                    "偏好",
                    "我喜欢",
                    "我希望",
                    "习惯",
                    "写作风格",
                    "回答风格",
                ],
            ) {
                kinds.push("user_preference");
            }
            if contains_any(
                &lower,
                &[
                    "decided",
                    "we chose",
                    "we choose",
                    "will use",
                    "adopt",
                    "retain",
                    "replace",
                    "决定",
                    "选择",
                    "采用",
                    "保留",
                    "替代",
                    "改用",
                    "优先使用",
                ],
            ) {
                kinds.push("research_decision");
            }
            if contains_any(
                &lower,
                &[
                    "must",
                    "must not",
                    "cannot",
                    "constraint",
                    "budget",
                    "limited to",
                    "禁止",
                    "必须",
                    "不得",
                    "不能",
                    "限制",
                    "预算",
                    "只允许",
                    "门槛",
                ],
            ) {
                kinds.push("constraint");
            }
            if contains_any(
                &lower,
                &[
                    "failed",
                    "failure",
                    "did not work",
                    "regression",
                    "degraded",
                    "worse",
                    "失败",
                    "未通过",
                    "无效",
                    "不可用",
                    "退化",
                    "变差",
                    "不工作",
                    "崩溃",
                ],
            ) {
                kinds.push("negative_result");
            }
            if !looks_like_external_claim(&lower)
                && contains_any(
                    &lower,
                    &[
                        "experiment",
                        "result",
                        "recall",
                        "precision",
                        "accuracy",
                        "latency",
                        "p95",
                        "mrr",
                        "improved",
                        "reduced",
                        "实验",
                        "结果",
                        "召回率",
                        "准确率",
                        "延迟",
                        "提升",
                        "降低",
                        "通过测试",
                    ],
                )
            {
                kinds.push("experiment_result");
            }
            if contains_any(
                &lower,
                &[
                    "windows",
                    "linux",
                    "cuda",
                    "gpu",
                    "rtx",
                    "python",
                    "node.js",
                    "node ",
                    "sqlite",
                    "环境",
                    "显卡",
                    "版本",
                    "运行时",
                ],
            ) {
                kinds.push("environment_fact");
            }
            if contains_any(
                &lower,
                &[
                    "lesson",
                    "next time",
                    "should avoid",
                    "do not repeat",
                    "经验",
                    "教训",
                    "下次",
                    "应避免",
                    "不要重复",
                    "以后应该",
                ],
            ) {
                kinds.push("methodological_lesson");
            }
            if !artifacts.is_empty() {
                kinds.push("artifact_pointer");
            }
            kinds.sort_unstable();
            kinds.dedup();
            for kind in kinds {
                let key = format!("{kind}:{}", normalize_statement(sentence));
                if !seen.insert(key) || candidates.len() >= MAX_ATOMS_PER_TURN {
                    continue;
                }
                let normalized_key = normalized_key(sentence, kind);
                let update_signal = contains_any(
                    &lower,
                    &[
                        "latest",
                        "now use",
                        "changed to",
                        "updated",
                        "replace",
                        "current",
                        "最新",
                        "现在使用",
                        "改为",
                        "更新为",
                        "替代",
                        "当前",
                    ],
                );
                let confidence = if kind == "artifact_pointer" {
                    (base_confidence + 80).min(980)
                } else {
                    base_confidence
                };
                candidates.push(ExtractedCandidate {
                    kind: kind.to_string(),
                    statement: sentence.to_string(),
                    normalized_key,
                    confidence_millis: confidence,
                    artifact_paths: artifacts.clone(),
                    update_signal,
                });
            }
        }
    }
    candidates
}

fn split_sentences(value: &str) -> Vec<String> {
    let mut output = Vec::new();
    let mut current = String::new();
    let mut in_code = false;
    for line in value.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        for character in line.chars() {
            current.push(character);
            if matches!(character, '。' | '！' | '？' | '!' | '?' | ';' | '；') {
                if !current.trim().is_empty() {
                    output.push(current.trim().to_string());
                }
                current.clear();
            }
        }
        if !current.trim().is_empty() {
            output.push(current.trim().to_string());
            current.clear();
        }
    }
    output
}

fn extract_artifact_paths(value: &str) -> Vec<String> {
    static ARTIFACT_PATH_REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = ARTIFACT_PATH_REGEX.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:[a-z]:[\\/]|(?:\.{0,2}[\\/]))[^\s`\"'<>]+\.(?:csv|jsonl?|md|tex|pdf|py|rs|tsx?|ipynb|png|svg|parquet|pt|pth|safetensors)"#,
        )
        .expect("research-memory artifact path regex must compile")
    });
    regex
        .find_iter(value)
        .map(|item| {
            item.as_str()
                .trim_end_matches([',', '.', ')', ']', '}', '。'])
                .to_string()
        })
        .take(8)
        .collect()
}

/// Subjects a later statement is allowed to silently supersede.
///
/// Every entry has to name one specific variable. A bare head noun — `model`,
/// `模型`, `provider`, `dataset`, `gpu` — collapses unrelated facts onto a single
/// key, and supersession then drops the loser out of recall entirely: a project
/// that picks an executor model and a reviewer model would keep only whichever
/// was mentioned last. When no qualified subject matches, the statement keys on
/// its own text, so the two facts coexist. Carrying a stale fact alongside a new
/// one is recoverable; destroying one is not.
const SUPERSEDABLE_SUBJECTS: &[&str] = &[
    "learning rate",
    "学习率",
    "batch size",
    "批大小",
    "memory provider",
    "记忆后端",
    "recall strategy",
    "召回策略",
    "citation style",
    "引用格式",
    "embedding model",
    "嵌入模型",
    "executor model",
    "执行模型",
    "reviewer model",
    "审查模型",
    "summarizer model",
    "摘要模型",
    "training dataset",
    "训练集",
    "训练数据集",
    "evaluation dataset",
    "评测集",
    "验证集",
    "测试集",
    "cuda version",
    "cuda 版本",
    "cuda版本",
    "python version",
    "python 版本",
    "python版本",
    "node.js version",
    "node 版本",
];

fn normalized_key(statement: &str, kind: &str) -> String {
    let lower = statement.to_ascii_lowercase();
    for subject in SUPERSEDABLE_SUBJECTS {
        if lower.contains(subject) {
            return format!("subject:{kind}:{}", subject.replace(' ', "_"));
        }
    }
    format!(
        "statement:{kind}:{}",
        stable_id("statement", &[&normalize_statement(statement)])
    )
}

fn normalize_statement(value: &str) -> String {
    value
        .chars()
        .filter_map(|character| {
            if character.is_alphanumeric() || is_cjk(character) {
                Some(character.to_ascii_lowercase())
            } else if character.is_whitespace() {
                Some(' ')
            } else {
                None
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_cjk(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x9FFF | 0xF900..=0xFAFF)
}

fn looks_like_question(value: &str) -> bool {
    value.contains('?')
        || value.contains('？')
        || value.trim_end().ends_with('吗')
        || value.trim_end().ends_with("呢")
}

fn looks_like_external_claim(lower: &str) -> bool {
    contains_any(
        lower,
        &[
            "paper reports",
            "according to the paper",
            "the study found",
            "论文表明",
            "文献表明",
            "研究表明",
            "该论文",
            "作者发现",
        ],
    )
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

fn episode_title(atoms: &[&ResearchMemoryAtom]) -> (&'static str, &'static str) {
    let has = |kind: &str| atoms.iter().any(|atom| atom.kind == kind);
    if has("experiment_result") || has("negative_result") || has("environment_fact") {
        ("Experiment episode", "experiment")
    } else if has("research_decision") || has("constraint") {
        ("Research decision episode", "decision")
    } else if has("methodological_lesson") {
        ("Methodology episode", "method")
    } else if has("user_preference") {
        ("Researcher preference episode", "preference")
    } else if has("artifact_pointer") {
        ("Artifact episode", "artifact")
    } else {
        ("Research episode", "other")
    }
}

fn recall_moment(query: &str) -> RecallMoment {
    static DATE_REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = DATE_REGEX.get_or_init(|| {
        Regex::new(
            r"(?x)
              (?P<year>20\d{2})
              (?:-|/|年)
              (?P<month>0?[1-9]|1[0-2])
              (?:-|/|月)
              (?P<day>0?[1-9]|[12]\d|3[01])
              日?",
        )
        .expect("research-memory date regex must compile")
    });
    if let Some(captures) = regex.captures(query) {
        let year = captures.name("year").map_or("1970", |value| value.as_str());
        let month = captures
            .name("month")
            .and_then(|value| value.as_str().parse::<u8>().ok())
            .unwrap_or(1);
        let day = captures
            .name("day")
            .and_then(|value| value.as_str().parse::<u8>().ok())
            .unwrap_or(1);
        return RecallMoment {
            as_of: format!("{year}-{month:02}-{day:02}T23:59:59Z"),
            historical: true,
        };
    }
    RecallMoment {
        as_of: crate::now_iso8601(),
        historical: false,
    }
}

/// Function words that carry no discriminative signal. A LongMemEval-style
/// question is a full sentence, so an unfiltered `OR` of its tokens matches
/// almost every stored row and turns BM25 into a popularity ranking.
const RECALL_STOPWORDS: &[&str] = &[
    "about",
    "after",
    "all",
    "also",
    "and",
    "any",
    "are",
    "did",
    "does",
    "for",
    "from",
    "had",
    "has",
    "have",
    "how",
    "into",
    "its",
    "just",
    "many",
    "much",
    "not",
    "now",
    "old",
    "one",
    "only",
    "our",
    "out",
    "over",
    "should",
    "some",
    "such",
    "than",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "use",
    "used",
    "very",
    "was",
    "were",
    "what",
    "when",
    "where",
    "which",
    "who",
    "whom",
    "why",
    "will",
    "with",
    "would",
    "you",
    "your",
    "的",
    "了",
    "吗",
    "呢",
    "是",
    "在",
    "我",
    "你",
    "他",
    "她",
    "它",
    "有",
    "和",
    "与",
    "或",
    "什么",
    "哪些",
    "怎么",
    "如何",
    "为什么",
];

/// Discriminative query terms used for gated recall.
///
/// Latin text splits on word boundaries. CJK has none, and FTS5's `unicode61`
/// tokenizer indexes an entire run of ideographs as a single token, so a Chinese
/// query can only ever match a stored statement that repeats the run verbatim.
/// Runs are therefore reduced to overlapping bigrams and matched with `LIKE`,
/// the same shape [`crate::session_index`] uses to answer CJK queries.
fn recall_terms(value: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut run: Vec<char> = Vec::new();
    let mut word = String::new();
    for character in value.chars() {
        if is_cjk(character) {
            push_word_term(&mut word, &mut terms);
            run.push(character);
            continue;
        }
        push_cjk_terms(&mut run, &mut terms);
        if character.is_alphanumeric() || character == '_' || character == '-' {
            word.push(character);
        } else {
            push_word_term(&mut word, &mut terms);
        }
    }
    push_cjk_terms(&mut run, &mut terms);
    push_word_term(&mut word, &mut terms);
    terms.truncate(if is_cjk_dominant(&terms) {
        RECALL_MAX_CJK_TERMS
    } else {
        RECALL_MAX_TERMS
    });
    terms
}

fn push_word_term(word: &mut String, terms: &mut Vec<String>) {
    let token = std::mem::take(word).to_lowercase();
    if token.chars().count() < RECALL_MIN_WORD_CHARS
        || RECALL_STOPWORDS.contains(&token.as_str())
        || terms.contains(&token)
    {
        return;
    }
    terms.push(token);
}

/// A run of ideographs contributes its overlapping bigrams. A single ideograph
/// is too common to discriminate, and the run as a whole matches nothing but an
/// identical run, so neither is kept on its own.
fn push_cjk_terms(run: &mut Vec<char>, terms: &mut Vec<String>) {
    for pair in run.windows(2) {
        let term = pair.iter().collect::<String>();
        if RECALL_STOPWORDS.contains(&term.as_str()) || terms.contains(&term) {
            continue;
        }
        terms.push(term);
    }
    run.clear();
}

/// True when the term set is mostly CJK bigrams, which are matched and gated
/// differently from words.
fn is_cjk_dominant(terms: &[String]) -> bool {
    let cjk = terms
        .iter()
        .filter(|term| term.chars().any(is_cjk))
        .count();
    cjk * 2 > terms.len()
}

/// Distinct query terms that literally appear in the candidate text.
fn term_overlap(text: &str, terms: &[String]) -> usize {
    let haystack = text.to_lowercase();
    terms
        .iter()
        .filter(|term| haystack.contains(term.as_str()))
        .count()
}

fn meets_overlap(text: &str, terms: &[String]) -> bool {
    term_overlap(text, terms) >= required_overlap(terms)
}

fn required_overlap(terms: &[String]) -> usize {
    if is_cjk_dominant(terms) {
        return terms
            .len()
            .div_ceil(RECALL_CJK_OVERLAP_DIVISOR)
            .max(RECALL_MIN_TERM_OVERLAP)
            .min(terms.len())
            .max(1);
    }
    if terms.len() >= RECALL_SHORT_QUERY_TERMS {
        RECALL_MIN_TERM_OVERLAP
    } else {
        1
    }
}

/// `%term%` with the LIKE wildcards in the term itself neutralised.
fn like_pattern(term: &str) -> String {
    format!(
        "%{}%",
        term.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

/// Builds `(col LIKE ?n OR ...)` plus a parallel `0/1` sum that counts how many
/// terms a row matched, so LIKE recall can still rank by term coverage.
fn like_clauses(column: &str, count: usize, first_param: usize) -> (String, String) {
    let matches = (0..count)
        .map(|offset| format!("{column} LIKE ?{} ESCAPE '\\'", first_param + offset))
        .collect::<Vec<_>>()
        .join(" OR ");
    let relevance = (0..count)
        .map(|offset| {
            format!(
                "CASE WHEN {column} LIKE ?{} ESCAPE '\\' THEN 1 ELSE 0 END",
                first_param + offset
            )
        })
        .collect::<Vec<_>>()
        .join(" + ");
    (matches, relevance)
}

fn fts_terms_query(terms: &[String]) -> String {
    terms
        .iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn fts_query(value: &str) -> String {
    let terms = value
        .split(|character: char| {
            !(character.is_alphanumeric()
                || is_cjk(character)
                || character == '_'
                || character == '-')
        })
        .filter(|term| term.chars().count() >= 2)
        .take(12)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    terms.join(" OR ")
}

fn capture_id(capture: &ResearchMemoryCapture) -> String {
    stable_id(
        "capture",
        &[
            &capture.project_id,
            &capture.session_id,
            &capture.source_event_ids.join("|"),
        ],
    )
}

fn atom_id(capture: &ResearchMemoryCapture, candidate: &ExtractedCandidate) -> String {
    stable_id(
        "atom",
        &[
            &capture.project_id,
            &capture.session_id,
            &capture.source_event_ids.join("|"),
            &candidate.kind,
            &candidate.statement,
        ],
    )
}

fn stable_id(prefix: &str, parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    let digest = format!("{:x}", hasher.finalize());
    format!("{prefix}-{}", &digest[..20])
}

fn json_string(values: &[String]) -> Result<String, String> {
    serde_json::to_string(values).map_err(|error| error.to_string())
}

fn parse_json_vec(value: &str) -> Vec<String> {
    serde_json::from_str(value).unwrap_or_default()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn millis_iso(value: i64) -> String {
    crate::iso8601_from_epoch_secs(value.max(0) as u64 / 1_000)
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
#[path = "tests/research_memory.rs"]
mod tests;
