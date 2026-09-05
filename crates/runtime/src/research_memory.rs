use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SCHEMA_VERSION: i64 = 7;
/// Identifies the rule set that produced an atom. R1 is frozen at extraction
/// time, so a change to [`extract_candidates`] only reaches new conversations
/// until the library is replayed; stamping the version is what lets
/// [`ResearchMemoryStore::stale_extractor_atoms`] tell the user a replay is
/// worth running. Bump it whenever the extraction rules change.
const EXTRACTOR_VERSION: &str = "builtin_rules_v5";

/// The rule generation new atoms are written under, for surfaces that name it.
/// Hardcoding it beside the store is how the Settings header came to advertise
/// `research-v3` while the store was writing v4.
pub const RESEARCH_MEMORY_EXTRACTOR_VERSION: &str = EXTRACTOR_VERSION;
/// Session families owned by workflow state rather than research memory.
///
/// This lives in runtime because every writer and replay path must agree on
/// the boundary. Desktop filtering is useful for presentation, but cannot be
/// the authority: migrations and direct runtime callers bypass it.
pub const RESEARCH_MEMORY_EXCLUDED_SESSION_PREFIXES: &[&str] = &["wf-", "somni-"];
/// Written by [`ResearchMemoryStore::update_atom`]. A statement the user typed
/// is not reproducible by any extractor, so a replay must leave it alone.
const EXTRACTOR_USER: &str = "user";
const OUTBOX_MAX_ATTEMPTS: i64 = 10;
const PROFILE_CHAR_LIMIT: usize = 2_000;
const MAX_ATOMS_PER_TURN: usize = 12;
const EPISODE_MAX_ATOMS: usize = 6;
const EPISODE_SUMMARY_CHAR_LIMIT: usize = 1_200;
const EPISODE_STATEMENT_CHAR_LIMIT: usize = 280;
const RECALL_TEXT_CHAR_LIMIT: usize = 1_200;
/// Minimum normalised length before an assistant sentence contained in the
/// user's own text counts as a restatement rather than a coincidence.
const RESEARCH_RESTATEMENT_MIN_CHARS: usize = 24;
/// How far into a sentence an acknowledgement verb still counts as one.
const ACKNOWLEDGEMENT_PREFIX_CHARS: usize = 12;
/// Where a statement came from. R1 keeps every class; R3 does not.
///
/// The distinction the extractor can actually make today is "the user wrote
/// this" versus "the assistant wrote this". `artifact_verified` and
/// `tool_observed` belong here too, but only once captures carry real tool and
/// artifact observations — a file path matched by [`extract_artifact_paths`] in
/// assistant prose is a mention, not a verification, and must not buy promotion.
const SOURCE_CLASS_USER: &str = "user_asserted";
const SOURCE_CLASS_ASSISTANT: &str = "assistant_synthesis";
/// Base confidence [`extract_candidates`] assigns the user's own sentences.
/// Assistant sentences start below it and [`ResearchMemoryStore::update_atom`]
/// writes 1000, so a row stored before `source_class` existed can be classified
/// from the number the same extractor wrote.
const USER_ASSERTED_CONFIDENCE: i64 = 860;
/// Statuses that mean a human vouched for the statement in the Explorer,
/// whatever its origin. A correction the user typed outranks its own provenance.
const HUMAN_VOUCHED_STATUSES: &[&str] = &["user_confirmed", "reviewed"];
/// Kinds R3 injects into every prompt regardless of the question. Decisions and
/// lessons stay in the stored profile for inspection and reach the prompt
/// through R1 when the query calls for them; mirrored by the desktop renderer's
/// `RESEARCH_STANDING_KINDS`, which keeps filtering as a backstop for profiles
/// written by older versions.
const R3_STANDING_KINDS: &[&str] = &["user_preference", "constraint"];
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
const RECALL_CJK_OVERLAP_DIVISOR: usize = 4;
const RECALL_MAX_CJK_REQUIRED_OVERLAP: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryCapture {
    pub project_id: String,
    pub session_id: String,
    /// Zero-based index of the final assistant message in the durable Session.
    ///
    /// This is intentionally separate from `source_event_ids`: a final answer
    /// can be replayed or repaired many times, but `(project, session, index)`
    /// remains one capture obligation.
    pub source_message_index: Option<i64>,
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

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct ResearchMemoryLegacyPurge {
    pub atoms: u64,
    pub cards: u64,
    pub profiles: u64,
    pub outbox: u64,
}

/// Delivery state for a final assistant response that has a durable Session
/// index. Settings uses this to compare the authoritative Session projection
/// with the derived-memory outbox without treating a pending retry as absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryCaptureDelivery {
    pub session_id: String,
    pub source_message_index: i64,
    pub status: String,
    pub occurred_at: String,
}

/// Minimal, ordered lineage used by governance surfaces for R2/R3. Keeping this
/// separate from `ResearchMemoryAtom` avoids turning a provenance lookup into a
/// second recall/search API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryAtomProvenance {
    pub atom_id: String,
    pub statement: String,
    pub kind: String,
    pub status: String,
    pub subject_key: Option<String>,
    pub source_session_id: String,
    pub source_event_ids: Vec<String>,
    /// Whether this line is eligible for unconditional standing R3 injection.
    pub standing_injected: bool,
}

/// What a [`ResearchMemoryStore::rebuild_derived`] pass did, for the Settings
/// page to report. `atoms_preserved` counts the rows a replay deliberately did
/// not touch: user corrections and confirmations.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryRebuild {
    pub captures_replayed: usize,
    pub atoms_removed: usize,
    pub atoms_written: usize,
    pub atoms_preserved: usize,
}

/// What a [`ResearchMemoryStore::rebuild_all`] pass did. An extractor upgrade is
/// a store-wide migration, not a per-project chore, so the totals are summed and
/// `projects` names what was actually replayed. A project that fails is recorded
/// in `failures` instead of abandoning the ones that still work — each project
/// commits on its own, and a replay is idempotent, so a partial pass can simply
/// be run again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryRebuildSummary {
    pub projects: Vec<String>,
    pub failures: Vec<String>,
    pub captures_replayed: usize,
    pub atoms_removed: usize,
    pub atoms_written: usize,
    pub atoms_preserved: usize,
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
    source_class: &'static str,
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

type ExistingAtom = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
);

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

    /// Permanently removes the retired v1 derived projection while preserving
    /// Session JSONL and the separate v2 store. The v1 outbox is derived input,
    /// not R0 authority, so it is removed as well to prevent an old worker or
    /// future compatibility path from recreating the deleted noise.
    pub fn purge_legacy_derived(&self) -> Result<ResearchMemoryLegacyPurge, String> {
        let mut connection = self.open()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let summary = ResearchMemoryLegacyPurge {
            atoms: row_count(&transaction, "research_memory_atoms")?,
            cards: row_count(&transaction, "research_memory_cards")?,
            profiles: row_count(&transaction, "research_memory_profiles")?,
            outbox: row_count(&transaction, "research_memory_outbox")?,
        };
        transaction
            .execute_batch(
                "DELETE FROM research_memory_atoms_fts;
                 DELETE FROM research_memory_cards_fts;
                 DELETE FROM research_memory_sources;
                 DELETE FROM research_memory_relations;
                 DELETE FROM research_memory_atom_terms;
                 DELETE FROM research_memory_atoms;
                 DELETE FROM research_memory_cards;
                 DELETE FROM research_memory_profiles;
                 DELETE FROM research_memory_outbox;
                 DELETE FROM research_memory_legacy_marks;
                 INSERT INTO research_memory_metadata(key, value)
                   VALUES ('derived_projection_status', 'purged_v2_active')
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(summary)
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
                       id, project_id, session_id, source_message_index, source_event_ids, user_text,
                       assistant_text, occurred_at, status, attempts, next_attempt_at,
                       created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 0, 0, ?9, ?9)",
                )
                .map_err(|error| error.to_string())?;
            for capture in captures {
                if !is_research_memory_session_id(&capture.session_id) {
                    continue;
                }
                inserted += statement
                    .execute(params![
                        capture_id(capture),
                        capture.project_id,
                        capture.session_id,
                        capture.source_message_index,
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
            self.refresh_subjects(&project_id)?;
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

    /// Atoms produced by a rule set older than [`EXTRACTOR_VERSION`]. A non-zero
    /// count is the signal that [`Self::rebuild_derived`] has something to do.
    pub fn stale_extractor_atoms(&self, project_id: &str) -> Result<u64, String> {
        validate_project(project_id)?;
        let connection = self.open()?;
        let session_filter = research_memory_session_sql("source_session_id");
        connection
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM research_memory_atoms
                     WHERE project_id=?1 AND deleted=0 AND extractor NOT IN (?2, ?3)
                       AND {session_filter}"
                ),
                params![project_id, EXTRACTOR_VERSION, EXTRACTOR_USER],
                |row| row.get::<_, u64>(0),
            )
            .map_err(|error| error.to_string())
    }

    /// Replays every stored capture through the current extractor.
    ///
    /// R1 is frozen at extraction time: the statement, kind and `normalized_key`
    /// a capture produced are written once and never revisited, so a fix to the
    /// extraction rules otherwise only ever reaches new conversations. The outbox
    /// keeps every completed capture verbatim, which makes a replay the natural
    /// migration path — and the only way an existing library benefits from a
    /// rule change at all.
    ///
    /// Human decisions survive it. Atoms the user confirmed or edited are left
    /// untouched, and deleted atoms stay deleted: their tombstone row keeps the
    /// deterministic id the replay would reuse, so the insert is ignored.
    pub fn rebuild_derived(&self, project_id: &str) -> Result<ResearchMemoryRebuild, String> {
        validate_project(project_id)?;
        let mut connection = self.open()?;
        let captures = load_completed_captures(&connection, project_id)?;
        let doomed = machine_derived_atom_ids(&connection, project_id)?;
        let preserved = connection
            .query_row(
                "SELECT COUNT(*) FROM research_memory_atoms
                 WHERE project_id=?1 AND deleted=0",
                [project_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?
            - i64::try_from(doomed.len()).unwrap_or_default();

        let mut touched_sessions = BTreeSet::new();
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        for id in &doomed {
            for sql in [
                "DELETE FROM research_memory_atoms_fts WHERE id=?1",
                "DELETE FROM research_memory_sources WHERE atom_id=?1",
                "DELETE FROM research_memory_relations WHERE from_atom_id=?1 OR to_atom_id=?1",
                "DELETE FROM research_memory_atom_terms WHERE atom_id=?1",
                "DELETE FROM research_memory_atoms WHERE id=?1",
            ] {
                transaction
                    .execute(sql, [id])
                    .map_err(|error| error.to_string())?;
            }
        }
        // R2 and R3 are pure projections of R1, so they are rebuilt from the
        // replayed atoms rather than patched.
        for sql in [
            "DELETE FROM research_memory_cards_fts
             WHERE id IN (SELECT id FROM research_memory_cards WHERE project_id=?1)",
            "DELETE FROM research_memory_cards WHERE project_id=?1",
            "DELETE FROM research_memory_profiles WHERE project_id=?1",
        ] {
            transaction
                .execute(sql, [project_id])
                .map_err(|error| error.to_string())?;
        }
        for capture in &captures {
            for candidate in extract_candidates(capture) {
                touched_sessions.extend(upsert_candidate(&transaction, capture, &candidate)?);
            }
        }
        // Subjects are a projection over the finished corpus: a term only earns
        // its key once a second Session has mentioned it, which during a replay
        // may not have happened yet when its first atom is written.
        refresh_subject_keys(&transaction, project_id)?;
        let written = transaction
            .query_row(
                "SELECT COUNT(*) FROM research_memory_atoms
                 WHERE project_id=?1 AND deleted=0 AND extractor=?2",
                params![project_id, EXTRACTOR_VERSION],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;

        for session_id in &touched_sessions {
            self.refresh_episode(project_id, session_id)?;
        }
        self.refresh_profile(project_id)?;
        Ok(ResearchMemoryRebuild {
            captures_replayed: captures.len(),
            atoms_removed: doomed.len(),
            atoms_written: usize::try_from(written).unwrap_or_default(),
            atoms_preserved: usize::try_from(preserved.max(0)).unwrap_or_default(),
        })
    }

    /// Replays every project in the store through the current extractor.
    ///
    /// [`Self::rebuild_derived`] is scoped to one project, but the thing that
    /// makes a replay necessary — a new extractor version — invalidates every
    /// project at once. Leaving the untouched ones behind is how a store ends up
    /// mixing rule generations, which makes the stored `kind` incomparable
    /// across rows.
    pub fn rebuild_all(&self) -> Result<ResearchMemoryRebuildSummary, String> {
        let ids = {
            let connection = self.open()?;
            project_ids(&connection)?
        };
        let mut summary = ResearchMemoryRebuildSummary::default();
        for id in ids {
            if validate_project(&id).is_err() {
                continue;
            }
            match self.rebuild_derived(&id) {
                Ok(rebuild) => {
                    summary.captures_replayed += rebuild.captures_replayed;
                    summary.atoms_removed += rebuild.atoms_removed;
                    summary.atoms_written += rebuild.atoms_written;
                    summary.atoms_preserved += rebuild.atoms_preserved;
                    summary.projects.push(id);
                }
                Err(_) => summary.failures.push(id),
            }
        }
        if summary.projects.is_empty() && !summary.failures.is_empty() {
            return Err(format!(
                "research memory replay failed for every project: {}",
                summary.failures.join(", ")
            ));
        }
        Ok(summary)
    }

    /// Store-wide count behind [`Self::rebuild_all`]. The per-project figure
    /// would under-report the work an extractor upgrade actually left pending.
    pub fn stale_extractor_atoms_all(&self) -> Result<u64, String> {
        let connection = self.open()?;
        let session_filter = research_memory_session_sql("source_session_id");
        connection
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM research_memory_atoms
                     WHERE deleted=0 AND extractor NOT IN (?1, ?2)
                       AND {session_filter}"
                ),
                params![EXTRACTOR_VERSION, EXTRACTOR_USER],
                |row| row.get::<_, u64>(0),
            )
            .map_err(|error| error.to_string())
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
                   extractor='user', updated_at=?5, recall_text=?3
                 WHERE project_id=?1 AND id=?2",
                params![project_id, id, statement, normalized_key, now_millis()],
            )
            .map_err(|error| error.to_string())?;
        replace_atom_fts(&transaction, id, project_id, "user_confirmed", statement)?;
        // The user rewrote the sentence, so the entities it names may have
        // changed with it.
        transaction
            .execute(
                "DELETE FROM research_memory_atom_terms WHERE atom_id=?1",
                [id],
            )
            .map_err(|error| error.to_string())?;
        record_atom_terms(&transaction, id, project_id, statement, "")?;
        refresh_subject_keys(&transaction, project_id)?;
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
        // The terms stay with the tombstone — they are provenance — but they
        // stop counting, which can drop a subject back below its threshold.
        refresh_subject_keys(&transaction, project_id)?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.refresh_episode(project_id, &source_session_id)?;
        self.refresh_profile(project_id)
    }

    pub fn stats(&self, project_id: &str) -> Result<ResearchMemoryStats, String> {
        validate_project(project_id)?;
        let connection = self.open()?;
        stats_conn(&connection, project_id)
    }

    /// Returns every final assistant response the durable outbox already knows
    /// about. A `pending` or `dead_letter` row deliberately counts as present:
    /// it is observable retry state, whereas no row at all is a capture gap.
    pub fn final_turn_deliveries(
        &self,
        project_id: &str,
    ) -> Result<Vec<ResearchMemoryCaptureDelivery>, String> {
        validate_project(project_id)?;
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT session_id, source_message_index, status, occurred_at
                 FROM research_memory_outbox
                 WHERE project_id=?1 AND source_message_index IS NOT NULL
                 ORDER BY occurred_at, created_at",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([project_id], |row| {
                Ok(ResearchMemoryCaptureDelivery {
                    session_id: row.get(0)?,
                    source_message_index: row.get(1)?,
                    status: row.get(2)?,
                    occurred_at: row.get(3)?,
                })
            })
            .map_err(|error| error.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// Attaches a pre-identity historical capture to the authoritative final
    /// assistant-message index when its durable source text matches exactly.
    ///
    /// This is intentionally a bind, not a new enqueue: earlier manual
    /// backfills used a `history:<session>:...` event id and already represent
    /// the same final reply. Reconciliation can therefore become idempotent
    /// across the schema transition instead of duplicating every old turn.
    pub fn bind_legacy_final_turn(
        &self,
        project_id: &str,
        session_id: &str,
        source_message_index: i64,
        user_text: &str,
        assistant_text: &str,
    ) -> Result<bool, String> {
        validate_project(project_id)?;
        if session_id.trim().is_empty() || source_message_index < 0 {
            return Ok(false);
        }
        let mut connection = self.open()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let already_bound = transaction
            .query_row(
                "SELECT 1 FROM research_memory_outbox
                 WHERE project_id=?1 AND session_id=?2 AND source_message_index=?3
                 LIMIT 1",
                params![project_id, session_id, source_message_index],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .is_some();
        if already_bound {
            transaction.commit().map_err(|error| error.to_string())?;
            return Ok(false);
        }
        let legacy_id = transaction
            .query_row(
                "SELECT id FROM research_memory_outbox
                 WHERE project_id=?1 AND session_id=?2 AND source_message_index IS NULL
                   AND user_text=?3 AND assistant_text=?4
                 ORDER BY CASE status
                   WHEN 'completed' THEN 0
                   WHEN 'pending' THEN 1
                   WHEN 'dead_letter' THEN 2
                   ELSE 3
                 END, updated_at DESC, id DESC
                 LIMIT 1",
                params![project_id, session_id, user_text, assistant_text],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(legacy_id) = legacy_id else {
            transaction.commit().map_err(|error| error.to_string())?;
            return Ok(false);
        };
        transaction
            .execute(
                "UPDATE research_memory_outbox
                 SET source_message_index=?2, updated_at=?3 WHERE id=?1",
                params![legacy_id, source_message_index, now_millis()],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(true)
    }

    /// Resolves the R1 lineage for displayed R2/R3 lines in caller-provided
    /// order. The R2 card and R3 profile are projections, so their own rows do
    /// not duplicate source Session ids or event ids.
    pub fn atom_provenance(
        &self,
        project_id: &str,
        atom_ids: &[String],
    ) -> Result<Vec<ResearchMemoryAtomProvenance>, String> {
        validate_project(project_id)?;
        if atom_ids.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.open()?;
        let placeholders = (0..atom_ids.len())
            .map(|index| format!("?{}", index + 2))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT id, statement, kind, status, subject_key, source_session_id,
                    source_event_ids, source_class
             FROM research_memory_atoms
             WHERE project_id=?1 AND id IN ({placeholders})"
        );
        let mut values = vec![rusqlite::types::Value::from(project_id.to_string())];
        values.extend(atom_ids.iter().cloned().map(rusqlite::types::Value::from));
        let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values), |row| {
                let kind = row.get::<_, String>(2)?;
                let status = row.get::<_, String>(3)?;
                let source_class = row.get::<_, String>(7)?;
                let standing_injected = R3_STANDING_KINDS.contains(&kind.as_str())
                    && (source_class == SOURCE_CLASS_USER
                        || HUMAN_VOUCHED_STATUSES.contains(&status.as_str()))
                    && !matches!(status.as_str(), "superseded" | "deleted" | "conflict");
                Ok(ResearchMemoryAtomProvenance {
                    atom_id: row.get(0)?,
                    statement: row.get(1)?,
                    kind,
                    status,
                    subject_key: row.get(4)?,
                    source_session_id: row.get(5)?,
                    source_event_ids: parse_json_vec(&row.get::<_, String>(6)?),
                    standing_injected,
                })
            })
            .map_err(|error| error.to_string())?;
        let mut by_id = BTreeMap::new();
        for row in rows {
            let provenance = row.map_err(|error| error.to_string())?;
            by_id.insert(provenance.atom_id.clone(), provenance);
        }
        Ok(atom_ids
            .iter()
            .filter_map(|id| by_id.remove(id))
            .collect())
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

    /// The terms this project keeps returning to, with how much evidence backs
    /// each. Inspection surface for the derived subject identity.
    pub fn project_subjects(
        &self,
        project_id: &str,
    ) -> Result<Vec<ResearchMemorySubject>, String> {
        validate_project(project_id)?;
        let connection = self.open()?;
        list_subjects_conn(&connection, project_id)
    }

    /// The subject one atom is keyed to, or `None` while no term it mentions
    /// has reached [`SUBJECT_MIN_SESSIONS`].
    pub fn atom_subject(
        &self,
        project_id: &str,
        atom_id: &str,
    ) -> Result<Option<String>, String> {
        validate_project(project_id)?;
        let connection = self.open()?;
        connection
            .query_row(
                "SELECT subject_key FROM research_memory_atoms
                 WHERE project_id=?1 AND id=?2",
                params![project_id, atom_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(|error| error.to_string())
    }

    fn refresh_subjects(&self, project_id: &str) -> Result<(), String> {
        let mut connection = self.open()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        refresh_subject_keys(&transaction, project_id)?;
        transaction.commit().map_err(|error| error.to_string())
    }

    fn refresh_episode(&self, project_id: &str, session_id: &str) -> Result<(), String> {
        let mut connection = self.open()?;
        let atoms = if is_research_memory_session_id(session_id) {
            list_active_atoms_for_episode(&connection, project_id, session_id)?
        } else {
            Vec::new()
        };
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

/// Whether a Session belongs to the general research-memory continuity layer.
/// Workflow Sessions remain auditable in their own ledger but must never seed
/// R1/R2/R3 or be injected into a general chat prompt.
#[must_use]
pub fn is_research_memory_session_id(session_id: &str) -> bool {
    !RESEARCH_MEMORY_EXCLUDED_SESSION_PREFIXES
        .iter()
        .any(|prefix| session_id.starts_with(prefix))
}

/// SQL counterpart of is_research_memory_session_id. The column argument is
/// always an internal identifier; prefix values are fixed constants.
fn research_memory_session_sql(column: &str) -> String {
    RESEARCH_MEMORY_EXCLUDED_SESSION_PREFIXES
        .iter()
        .map(|prefix| format!("{column} NOT LIKE '{}%'", prefix.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn row_count(transaction: &Transaction<'_>, table: &str) -> Result<u64, String> {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    transaction
        .query_row(&sql, [], |row| row.get::<_, u64>(0))
        .map_err(|error| error.to_string())
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
               deleted INTEGER NOT NULL DEFAULT 0,
               source_class TEXT NOT NULL DEFAULT '',
               recall_text TEXT NOT NULL DEFAULT ''
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
               source_message_index INTEGER,
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
               ON research_memory_outbox(status, created_at);
             CREATE TABLE IF NOT EXISTS research_memory_atom_terms(
               atom_id TEXT NOT NULL,
               project_id TEXT NOT NULL,
               subject TEXT NOT NULL,
               display TEXT NOT NULL,
               PRIMARY KEY(atom_id, subject)
             );
             CREATE INDEX IF NOT EXISTS research_memory_atom_terms_project
               ON research_memory_atom_terms(project_id, subject);
             -- Cutover markers are separate from the v1 semantic status. They
             -- preserve historical reviewed/user-confirmed state while making
             -- the retirement of the whole derived projection explicit.
             CREATE TABLE IF NOT EXISTS research_memory_legacy_marks(
               entity_type TEXT NOT NULL,
               entity_id TEXT NOT NULL,
               layer TEXT NOT NULL,
               reason TEXT NOT NULL,
               marked_at TEXT NOT NULL,
               PRIMARY KEY(entity_type, entity_id)
             );
             CREATE INDEX IF NOT EXISTS research_memory_legacy_marks_layer
               ON research_memory_legacy_marks(layer, marked_at);
             CREATE TRIGGER IF NOT EXISTS research_memory_mark_atom_legacy
               AFTER INSERT ON research_memory_atoms
               BEGIN
                 INSERT OR IGNORE INTO research_memory_legacy_marks(entity_type, entity_id, layer, reason, marked_at)
                 VALUES ('atom', NEW.id, 'r1', 'v1 derived projection retired at v2 cutover', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
               END;
             CREATE TRIGGER IF NOT EXISTS research_memory_mark_card_legacy
               AFTER INSERT ON research_memory_cards
               BEGIN
                 INSERT OR IGNORE INTO research_memory_legacy_marks(entity_type, entity_id, layer, reason, marked_at)
                 VALUES ('card', NEW.id, 'r2', 'v1 derived projection retired at v2 cutover', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
               END;
             CREATE TRIGGER IF NOT EXISTS research_memory_mark_profile_legacy
               AFTER INSERT ON research_memory_profiles
               BEGIN
                 INSERT OR IGNORE INTO research_memory_legacy_marks(entity_type, entity_id, layer, reason, marked_at)
                 VALUES ('profile', NEW.project_id, 'r3', 'v1 derived projection retired at v2 cutover', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
               END;",
        )
        .map_err(|error| error.to_string())?;
    ensure_outbox_next_attempt_column(connection)?;
    ensure_outbox_source_message_index_column(connection)?;
    deduplicate_final_turn_outbox_rows(connection)?;
    ensure_atom_source_class_column(connection)?;
    ensure_atom_recall_text_column(connection)?;
    ensure_atom_subject_key_column(connection)?;
    migrate_typed_current_fact_keys(connection)?;
    ensure_legacy_cutover_marks(connection)?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS research_memory_outbox_due
             ON research_memory_outbox(status, next_attempt_at, created_at)",
            [],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS research_memory_outbox_final_turn
             ON research_memory_outbox(project_id, session_id, source_message_index)
             WHERE source_message_index IS NOT NULL",
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

/// Adds `source_class`, classifies the rows written before it existed, and
/// rebuilds every profile once.
///
/// The rebuild is the point of the migration, not a side effect: profiles are
/// only refreshed when a project receives a turn, so without it a project that
/// is idle would keep injecting assistant-authored rules into every prompt
/// indefinitely. Everything here runs exactly once, on the open that finds the
/// column missing.
fn ensure_atom_source_class_column(connection: &Connection) -> Result<(), String> {
    if has_column(connection, "research_memory_atoms", "source_class")? {
        return Ok(());
    }
    connection
        .execute(
            "ALTER TABLE research_memory_atoms
             ADD COLUMN source_class TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE research_memory_atoms
             SET source_class = CASE WHEN confidence_millis >= ?1 THEN ?2 ELSE ?3 END
             WHERE source_class = ''",
            params![
                USER_ASSERTED_CONFIDENCE,
                SOURCE_CLASS_USER,
                SOURCE_CLASS_ASSISTANT
            ],
        )
        .map_err(|error| error.to_string())?;
    let project_ids = {
        let mut statement = connection
            .prepare("SELECT DISTINCT project_id FROM research_memory_atoms")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row.map_err(|error| error.to_string())?);
        }
        ids
    };
    for project_id in project_ids {
        let atoms = list_active_atoms_for_derived(connection, &project_id)?;
        refresh_profile(connection, &project_id, &atoms)?;
    }
    Ok(())
}

/// Add the query-side context used to find an answer that does not repeat the
/// wording of the user's question. Existing rows fall back to their statement;
/// replaying stale extractor rows repopulates this with the source user turn.
fn ensure_atom_recall_text_column(connection: &Connection) -> Result<(), String> {
    if !has_column(connection, "research_memory_atoms", "recall_text")? {
        connection
            .execute(
                "ALTER TABLE research_memory_atoms
                 ADD COLUMN recall_text TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    connection
        .execute(
            "UPDATE research_memory_atoms SET recall_text=statement
             WHERE TRIM(recall_text)=''",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Adds the derived subject identity. Existing rows stay `NULL` until a replay
/// re-extracts their terms: the column is an index into
/// `research_memory_atom_terms`, and there is nothing to point at until that
/// table is populated.
fn ensure_atom_subject_key_column(connection: &Connection) -> Result<(), String> {
    if has_column(connection, "research_memory_atoms", "subject_key")? {
        return Ok(());
    }
    connection
        .execute(
            "ALTER TABLE research_memory_atoms ADD COLUMN subject_key TEXT",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;
    for candidate in columns {
        if candidate.map_err(|error| error.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
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

/// Rewrites artifact mentions that resolve inside `workspace` to their actual
/// project-relative spelling. It never guesses a moved or missing file: only a
/// path the filesystem confirms is changed, keeping external and historical
/// references untouched.
#[must_use]
pub fn canonicalize_research_memory_text(workspace: &Path, text: &str) -> String {
    let Ok(canonical_workspace) = workspace.canonicalize() else {
        return text.to_string();
    };
    let mut replacements = Vec::new();
    for artifact in extract_artifact_paths(text) {
        let path = Path::new(&artifact);
        let candidate = if path.is_absolute() {
            path.to_path_buf()
        } else {
            canonical_workspace.join(path)
        };
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        let Ok(relative) = canonical.strip_prefix(&canonical_workspace) else {
            continue;
        };
        let display = relative.to_string_lossy().replace('\\', "/");
        if !display.is_empty() && display != artifact {
            replacements.push((artifact, display));
        }
    }
    let mut canonical = text.to_string();
    replacements.sort_by(|left, right| right.0.len().cmp(&left.0.len()));
    replacements.dedup_by(|left, right| left.0 == right.0);
    for (source, destination) in replacements {
        canonical = canonical.replace(&source, &destination);
    }
    canonical
}

/// Gives existing derived compiler and page-count facts the same lifecycle
/// identity newly extracted facts receive. This is a key migration only: it
/// preserves every atom, source and statement, then lets the next newer capture
/// establish the supersession relation in the normal audited path.
fn migrate_typed_current_fact_keys(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT id, kind, statement, artifact_paths, normalized_key
             FROM research_memory_atoms
             WHERE deleted=0 AND normalized_key NOT LIKE 'current:%'",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut updates = Vec::new();
    for row in rows {
        let (id, kind, statement, artifacts, existing_key) =
            row.map_err(|error| error.to_string())?;
        let artifact_paths = parse_json_vec(&artifacts);
        let lower = classifiable_text(&statement, &artifact_paths);
        // A new capture can emit two typed facts from one sentence. A legacy
        // atom has one row and therefore one key, so retain the identity that
        // matches its prior semantic kind rather than arbitrarily taking the
        // first (page count) identity.
        let identities = typed_current_fact_identities(&statement, &lower, &artifact_paths);
        let typed = identities
            .into_iter()
            .find(|(candidate_kind, _)| {
                (*candidate_kind == "build_status" && kind == "negative_result")
                    || (*candidate_kind == "artifact_page_count" && kind == "artifact_pointer")
            })
            .or_else(|| {
                typed_current_fact_identities(&statement, &lower, &artifact_paths)
                    .into_iter()
                    .next()
            });
        let Some((_, key)) = typed else {
            continue;
        };
        if key != existing_key {
            updates.push((id, key));
        }
    }
    for (id, key) in updates {
        connection
            .execute(
                "UPDATE research_memory_atoms SET normalized_key=?2 WHERE id=?1",
                params![id, key],
            )
            .map_err(|error| error.to_string())?;
    }
    repair_typed_current_fact_lifecycle(connection)?;
    Ok(())
}

/// Mark all pre-v2 derived entities once, without rewriting their semantic
/// status or touching the authoritative Session files. Triggers above keep
/// the marker true even if an old maintenance path is called accidentally.
fn ensure_legacy_cutover_marks(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "INSERT OR IGNORE INTO research_memory_legacy_marks(entity_type, entity_id, layer, reason, marked_at)
             SELECT 'atom', id, 'r1', 'v1 derived projection retired at v2 cutover', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM research_memory_atoms;
             INSERT OR IGNORE INTO research_memory_legacy_marks(entity_type, entity_id, layer, reason, marked_at)
             SELECT 'card', id, 'r2', 'v1 derived projection retired at v2 cutover', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM research_memory_cards;
             INSERT OR IGNORE INTO research_memory_legacy_marks(entity_type, entity_id, layer, reason, marked_at)
             SELECT 'profile', project_id, 'r3', 'v1 derived projection retired at v2 cutover', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM research_memory_profiles;
             INSERT INTO research_memory_metadata(key, value) VALUES ('derived_projection_status', 'legacy')
             ON CONFLICT(key) DO UPDATE SET value='legacy';",
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// A schema upgrade can turn several formerly unrelated rows into the same
/// `current:` identity. Keep their evidence and audit trail, but make the
/// newest observation the sole default-current fact immediately rather than
/// waiting for the next live capture to do so.
fn repair_typed_current_fact_lifecycle(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT id, normalized_key, COALESCE(valid_from, ''), updated_at
             FROM research_memory_atoms
             WHERE deleted=0 AND normalized_key LIKE 'current:%'
               AND status NOT IN ('superseded', 'deleted', 'conflict')
             ORDER BY normalized_key, COALESCE(valid_from, '') DESC, updated_at DESC, id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut grouped = BTreeMap::<String, Vec<(String, String, i64)>>::new();
    for row in rows {
        let (id, key, valid_from, updated_at) = row.map_err(|error| error.to_string())?;
        grouped
            .entry(key)
            .or_default()
            .push((id, valid_from, updated_at));
    }
    for rows in grouped.into_values() {
        let Some((current_id, current_valid_from, _)) = rows.first() else {
            continue;
        };
        let current_id = current_id.clone();
        let current_valid_from = current_valid_from.clone();
        for (historical_id, _, _) in rows.into_iter().skip(1) {
            connection
                .execute(
                    "UPDATE research_memory_atoms
                     SET status='superseded',
                         valid_until=COALESCE(valid_until, ?2),
                         supersedes_id=COALESCE(supersedes_id, ?3),
                         updated_at=?4
                     WHERE id=?1",
                    params![historical_id, current_valid_from, current_id, now_millis()],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "INSERT OR IGNORE INTO research_memory_relations(
                       from_atom_id, to_atom_id, relation, created_at
                     ) VALUES (?1, ?2, 'supersedes', ?3)",
                    params![current_id, historical_id, now_millis()],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Adds the stable final-assistant message index used to reconcile the durable
/// Session projection with the outbox. Older live captures encoded exactly this
/// index as `<session_id>:<index>` in `source_event_ids`, so importing it here
/// preserves their idempotency instead of enqueueing a duplicate on upgrade.
fn ensure_outbox_source_message_index_column(connection: &Connection) -> Result<(), String> {
    if !has_column(connection, "research_memory_outbox", "source_message_index")? {
        connection
            .execute(
                "ALTER TABLE research_memory_outbox
                 ADD COLUMN source_message_index INTEGER",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    // Once the partial unique index exists, a NULL index may deliberately be a
    // detached duplicate retained for audit. Do not infer it again on every
    // open, or that audit row would immediately collide with the retained
    // final-turn delivery.
    if has_index(connection, "research_memory_outbox_final_turn")? {
        return Ok(());
    }
    let mut statement = connection
        .prepare(
            "SELECT id, session_id, source_event_ids FROM research_memory_outbox
             WHERE source_message_index IS NULL",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut recovered = Vec::new();
    for row in rows {
        let (id, session_id, source_event_ids) = row.map_err(|error| error.to_string())?;
        let index = parse_final_message_index(&session_id, &parse_json_vec(&source_event_ids));
        if let Some(index) = index {
            recovered.push((id, index));
        }
    }
    for (id, index) in recovered {
        connection
            .execute(
                "UPDATE research_memory_outbox SET source_message_index=?2 WHERE id=?1",
                params![id, index],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn has_index(connection: &Connection, name: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1 LIMIT 1",
            [name],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|error| error.to_string())
}

/// Older installations could have more than one outbox row for a final reply
/// before that reply gained a first-class identity. Preserve those historical
/// captures for audit, but leave exactly one row addressable by the new unique
/// final-turn key. A completed delivery wins over retry state, then the newest
/// record is preferred.
fn deduplicate_final_turn_outbox_rows(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, session_id, source_message_index
             FROM research_memory_outbox
             WHERE source_message_index IS NOT NULL
             ORDER BY project_id, session_id, source_message_index,
                      CASE status
                        WHEN 'completed' THEN 0
                        WHEN 'pending' THEN 1
                        WHEN 'dead_letter' THEN 2
                        ELSE 3
                      END,
                      updated_at DESC, id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut retained = BTreeSet::new();
    let mut duplicates = Vec::new();
    for row in rows {
        let (id, project_id, session_id, index) = row.map_err(|error| error.to_string())?;
        if !retained.insert((project_id, session_id, index)) {
            duplicates.push(id);
        }
    }
    for id in duplicates {
        connection
            .execute(
                "UPDATE research_memory_outbox SET source_message_index=NULL WHERE id=?1",
                [id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn parse_final_message_index(session_id: &str, source_event_ids: &[String]) -> Option<i64> {
    source_event_ids.iter().find_map(|event_id| {
        let suffix = event_id.strip_prefix(&format!("{session_id}:"))?;
        if suffix.is_empty() || !suffix.chars().all(|character| character.is_ascii_digit()) {
            return None;
        }
        suffix.parse::<i64>().ok().filter(|index| *index >= 0)
    })
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
        "SELECT id, project_id, session_id, source_message_index, source_event_ids, user_text,
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
            let source_event_ids = parse_json_vec(&row.get::<_, String>(4)?);
            Ok(OutboxItem {
                id: row.get(0)?,
                capture: ResearchMemoryCapture {
                    project_id: row.get(1)?,
                    session_id: row.get(2)?,
                    source_message_index: row.get(3)?,
                    source_event_ids,
                    user_text: row.get(5)?,
                    assistant_text: row.get(6)?,
                    occurred_at: row.get(7)?,
                },
                attempts: row.get(8)?,
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Every capture this project has already extracted, in the order it happened.
/// Replay order is not cosmetic: supersession only fires on a strictly newer
/// `occurred_at`, so replaying out of order would invert which fact survives.
fn load_completed_captures(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<ResearchMemoryCapture>, String> {
    let mut statement = connection
        .prepare(
            "SELECT project_id, session_id, source_message_index, source_event_ids, user_text,
                    assistant_text, occurred_at
             FROM research_memory_outbox
             WHERE project_id=?1 AND status='completed'
             ORDER BY occurred_at, created_at",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], |row| {
            Ok(ResearchMemoryCapture {
                project_id: row.get(0)?,
                session_id: row.get(1)?,
                source_message_index: row.get(2)?,
                source_event_ids: parse_json_vec(&row.get::<_, String>(3)?),
                user_text: row.get(4)?,
                assistant_text: row.get(5)?,
                occurred_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows
        .filter_map(Result::ok)
        .filter(|capture| is_research_memory_session_id(&capture.session_id))
        .collect())
}

/// Every project the store knows about. Captures are unioned with atoms because
/// a project can hold replayable captures whose current rules produce no atom at
/// all, and skipping it would leave its stale cards and profile in place.
fn project_ids(connection: &Connection) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT project_id FROM research_memory_atoms
             UNION
             SELECT project_id FROM research_memory_outbox
             ORDER BY 1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(|error| error.to_string())?);
    }
    Ok(ids)
}

/// Atoms a replay may discard: anything an extractor produced and no human has
/// vouched for. Tombstones (`deleted=1`) stay put — deleting them would let the
/// replay recreate a row the user removed on purpose.
fn machine_derived_atom_ids(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<String>, String> {
    let placeholders = HUMAN_VOUCHED_STATUSES
        .iter()
        .enumerate()
        .map(|(index, _)| format!("?{}", index + 3))
        .collect::<Vec<_>>()
        .join(", ");
    let mut statement = connection
        .prepare(&format!(
            "SELECT id FROM research_memory_atoms
             WHERE project_id=?1 AND deleted=0 AND extractor<>?2
               AND status NOT IN ({placeholders})"
        ))
        .map_err(|error| error.to_string())?;
    let mut bindings: Vec<&dyn rusqlite::ToSql> = vec![&project_id, &EXTRACTOR_USER];
    bindings.extend(
        HUMAN_VOUCHED_STATUSES
            .iter()
            .map(|status| status as &dyn rusqlite::ToSql),
    );
    let rows = statement
        .query_map(bindings.as_slice(), |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(|error| error.to_string())?);
    }
    Ok(ids)
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

fn find_existing_atom_by_key(
    transaction: &Transaction<'_>,
    capture: &ResearchMemoryCapture,
    candidate: &ExtractedCandidate,
) -> Result<Option<ExistingAtom>, String> {
    transaction
        .query_row(
            "SELECT id, statement, status, source_event_ids, artifact_paths,
                    source_session_id, valid_from, recall_text
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
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn find_existing_atom_by_subject(
    transaction: &Transaction<'_>,
    capture: &ResearchMemoryCapture,
    candidate: &ExtractedCandidate,
) -> Result<Option<ExistingAtom>, String> {
    let subjects = subject_terms(&format!("{}\n{}", candidate.statement, capture.user_text));
    for (subject, _) in subjects {
        let existing = transaction
            .query_row(
                "SELECT id, statement, status, source_event_ids, artifact_paths,
                        source_session_id, valid_from, recall_text
                 FROM research_memory_atoms
                 WHERE project_id=?1 AND subject_key=?2 AND kind=?3 AND deleted=0
                   AND status NOT IN ('superseded', 'deleted')
                 ORDER BY updated_at DESC LIMIT 1",
                params![capture.project_id, subject, candidate.kind],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if existing.is_some() {
            return Ok(existing);
        }
    }
    Ok(None)
}

fn upsert_candidate(
    transaction: &Transaction<'_>,
    capture: &ResearchMemoryCapture,
    candidate: &ExtractedCandidate,
) -> Result<BTreeSet<String>, String> {
    let mut affected_sessions = BTreeSet::from([capture.session_id.clone()]);
    let mut existing = find_existing_atom_by_key(transaction, capture, candidate)?;
    let mut matched_by_subject = false;
    // `subject_key` only becomes available after two independent Sessions have
    // referred to the same concrete entity. Once it exists, use it as a
    // conservative fallback for an explicit update to a decision/rule: wording
    // may change completely while the file, LaTex label, or named identifier is
    // still the thing being revised.
    if existing.is_none()
        && candidate.update_signal
        && matches!(
            candidate.kind.as_str(),
            "research_decision" | "constraint" | "user_preference"
        )
    {
        existing = find_existing_atom_by_subject(transaction, capture, candidate)?;
        matched_by_subject = existing.is_some();
    }
    if let Some((
        id,
        statement,
        _,
        existing_events,
        existing_artifacts,
        existing_session_id,
        _,
        existing_recall_text,
    )) = existing.as_ref()
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
            let recall_text = merge_recall_text(
                existing_recall_text,
                &candidate.statement,
                &capture.user_text,
            );
            transaction
                .execute(
                    // The user restating what the assistant said first upgrades
                    // the origin: otherwise whoever happened to phrase it first
                    // decides forever whether the statement can reach R3.
                    "UPDATE research_memory_atoms SET updated_at=?2,
                       confidence_millis=MAX(confidence_millis, ?3),
                       source_event_ids=?4, artifact_paths=?5,
                       source_class=CASE WHEN ?6=?7 THEN ?6 ELSE source_class END,
                       recall_text=?8
                     WHERE id=?1",
                    params![
                        id,
                        now_millis(),
                        candidate.confidence_millis,
                        json_string(&source_event_ids)?,
                        json_string(&artifact_paths)?,
                        candidate.source_class,
                        SOURCE_CLASS_USER,
                        recall_text,
                    ],
                )
                .map_err(|error| error.to_string())?;
            replace_atom_fts(
                transaction,
                id,
                &capture.project_id,
                &candidate.kind,
                &recall_text,
            )?;
            insert_sources(transaction, id, capture, &candidate.artifact_paths)?;
            record_atom_terms(
                transaction,
                id,
                &capture.project_id,
                &candidate.statement,
                &capture.user_text,
            )?;
            return Ok(affected_sessions);
        }
    }

    let id = atom_id(capture, candidate);
    let mut status = "derived".to_string();
    let mut supersedes_id = None;
    let mut valid_until = None;
    if let Some((existing_id, _, _, _, _, existing_session_id, existing_valid_from, _)) = existing {
        affected_sessions.insert(existing_session_id);
        let may_supersede = candidate.normalized_key.starts_with("current:")
            || candidate.update_signal
            || matches!(
                candidate.kind.as_str(),
                "research_decision" | "constraint" | "user_preference" | "environment_fact"
            );
        if (candidate.normalized_key.starts_with("subject:")
            || candidate.normalized_key.starts_with("current:")
            || matched_by_subject)
            && may_supersede
        {
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
    let recall_text = candidate_recall_text(&candidate.statement, &capture.user_text);
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO research_memory_atoms(
               id, project_id, kind, statement, normalized_key, scope,
               confidence_millis, status, source_session_id, source_event_ids,
               artifact_paths, extractor, created_at, updated_at,
               valid_from, valid_until, supersedes_id, deleted, source_class,
               recall_text
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'project', ?6, ?7, ?8, ?9,
                       ?10, ?16, ?11, ?11, ?12, ?13, ?14, 0, ?15, ?17)",
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
                candidate.source_class,
                EXTRACTOR_VERSION,
                recall_text,
            ],
        )
        .map_err(|error| error.to_string())?;
    if inserted == 0 {
        // The id already exists, which on a replay means the user deleted this
        // atom: the tombstone keeps the deterministic id precisely so the row
        // cannot come back. Re-indexing it would resurrect it in search even
        // though the row stays `deleted=1`.
        return Ok(affected_sessions);
    }
    replace_atom_fts(
        transaction,
        &id,
        &capture.project_id,
        &candidate.kind,
        &recall_text,
    )?;
    insert_sources(transaction, &id, capture, &candidate.artifact_paths)?;
    record_atom_terms(
        transaction,
        &id,
        &capture.project_id,
        &candidate.statement,
        &capture.user_text,
    )?;
    Ok(affected_sessions)
}

/// Stores the subject terms one atom mentions.
///
/// Terms are extracted once, at write time, from the statement *and* the user
/// turn that produced it. The question routinely names the entity the answer
/// only refers to — measured on the real store, reading both raises subject
/// coverage from 33% to 54% of atoms.
fn record_atom_terms(
    transaction: &Transaction<'_>,
    atom_id: &str,
    project_id: &str,
    statement: &str,
    user_text: &str,
) -> Result<(), String> {
    for (subject, display) in subject_terms(&format!("{statement}\n{user_text}")) {
        transaction
            .execute(
                "INSERT OR IGNORE INTO research_memory_atom_terms(
                   atom_id, project_id, subject, display
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![atom_id, project_id, subject, display],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Re-points every atom in the project at the most salient subject it mentions.
///
/// A term only becomes a subject once a *second* Session mentions it, so the
/// atom that first named it cannot be keyed at write time — the evidence for
/// its own key does not exist yet. Assignment is therefore a projection over
/// the whole project, re-run whenever atoms change, rather than a decision made
/// once per row.
fn refresh_subject_keys(transaction: &Transaction<'_>, project_id: &str) -> Result<(), String> {
    transaction
        .execute(
            "UPDATE research_memory_atoms SET subject_key=NULL WHERE project_id=?1",
            [project_id],
        )
        .map_err(|error| error.to_string())?;
    // Salience: how many Sessions returned to the term, then how concrete the
    // form is (a file or a LaTeX key names one thing; a bare identifier may
    // not), then longest, then the key itself so the choice is deterministic.
    transaction
        .execute(
            "WITH registered AS (
               SELECT t.project_id AS project_id, t.subject AS subject,
                      COUNT(DISTINCT a.source_session_id) AS sessions
               FROM research_memory_atom_terms t
               JOIN research_memory_atoms a ON a.id=t.atom_id
               WHERE t.project_id=?1 AND a.deleted=0
               GROUP BY 1, 2
               HAVING COUNT(DISTINCT a.source_session_id) >= ?2
             ),
             ranked AS (
               SELECT t.atom_id AS atom_id, t.subject AS subject,
                      ROW_NUMBER() OVER (
                        PARTITION BY t.atom_id
                        ORDER BY r.sessions DESC,
                                 CASE
                                   WHEN t.subject LIKE 'file:%' THEN 0
                                   WHEN t.subject LIKE 'tex:%' THEN 1
                                   WHEN t.subject LIKE 'code:%' THEN 2
                                   WHEN t.subject LIKE 'quoted:%' THEN 3
                                   ELSE 4
                                 END,
                                 LENGTH(t.subject) DESC,
                                 t.subject
                      ) AS rank
               FROM research_memory_atom_terms t
               JOIN registered r
                 ON r.project_id=t.project_id AND r.subject=t.subject
               WHERE t.project_id=?1
             )
             UPDATE research_memory_atoms
             SET subject_key=(
               SELECT subject FROM ranked
               WHERE ranked.atom_id=research_memory_atoms.id AND ranked.rank=1
             )
             WHERE project_id=?1",
            params![project_id, SUBJECT_MIN_SESSIONS],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn list_subjects_conn(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<ResearchMemorySubject>, String> {
    let mut statement = connection
        .prepare(
            "SELECT t.subject, MIN(t.display),
                    COUNT(DISTINCT a.source_session_id), COUNT(DISTINCT t.atom_id)
             FROM research_memory_atom_terms t
             JOIN research_memory_atoms a ON a.id=t.atom_id
             WHERE t.project_id=?1 AND a.deleted=0
             GROUP BY t.subject
             HAVING COUNT(DISTINCT a.source_session_id) >= ?2
             ORDER BY 3 DESC, 4 DESC, 1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id, SUBJECT_MIN_SESSIONS], |row| {
            Ok(ResearchMemorySubject {
                subject: row.get(0)?,
                display: row.get(1)?,
                session_count: row.get(2)?,
                atom_count: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut subjects = Vec::new();
    for row in rows {
        subjects.push(row.map_err(|error| error.to_string())?);
    }
    Ok(subjects)
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
    searchable_text: &str,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM research_memory_atoms_fts WHERE id=?1", [id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO research_memory_atoms_fts(id, project_id, kind, statement)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, project_id, kind, searchable_text],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn candidate_recall_text(statement: &str, user_text: &str) -> String {
    let statement = statement.split_whitespace().collect::<Vec<_>>().join(" ");
    let user_text = user_text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut combined = if user_text.is_empty()
        || normalize_statement(&user_text).contains(&normalize_statement(&statement))
    {
        format!("{statement} {statement}")
    } else {
        format!("{statement} {statement} {user_text}")
    };
    let aliases = semantic_recall_aliases(&format!("{statement} {user_text}"));
    if !aliases.is_empty() {
        combined.push(' ');
        combined.push_str(&aliases.join(" "));
    }
    truncate_chars(&combined, RECALL_TEXT_CHAR_LIMIT)
}

fn merge_recall_text(existing: &str, statement: &str, user_text: &str) -> String {
    let incoming = candidate_recall_text(statement, user_text);
    if existing.trim().is_empty() {
        return incoming;
    }
    let existing_normalized = normalize_statement(existing);
    let incoming_normalized = normalize_statement(&incoming);
    if existing_normalized.contains(&incoming_normalized) {
        truncate_chars(existing, RECALL_TEXT_CHAR_LIMIT)
    } else {
        truncate_chars(
            &format!("{} {}", existing.trim(), incoming.trim()),
            RECALL_TEXT_CHAR_LIMIT,
        )
    }
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
    let worthy_ids = episode_worthy_atom_ids(transaction, project_id, session_id)?;
    let mut members = atoms
        .iter()
        .filter(|atom| atom.status != "conflict" && worthy_ids.contains(&atom.id))
        .collect::<Vec<_>>();
    if members.is_empty() {
        return Ok(());
    }
    members.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    members.truncate(EPISODE_MAX_ATOMS);
    let (title_prefix, kind) = episode_title(&members);
    let title_anchor = episode_title_anchor(&members);
    let title = format!(
        "{title_prefix} · {}",
        truncate_chars(&title_anchor, 72)
    );
    let atom_ids = members
        .iter()
        .map(|atom| atom.id.clone())
        .collect::<Vec<_>>();
    let mut summary_lines = Vec::new();
    let mut used_chars = 0_usize;
    for atom in &members {
        let line = format!(
            "- {} [R1:{}]",
            truncate_chars(&atom.statement, EPISODE_STATEMENT_CHAR_LIMIT),
            atom.id
        );
        let line_chars = line.chars().count() + usize::from(!summary_lines.is_empty());
        if !summary_lines.is_empty()
            && used_chars.saturating_add(line_chars) > EPISODE_SUMMARY_CHAR_LIMIT
        {
            break;
        }
        used_chars = used_chars.saturating_add(line_chars);
        summary_lines.push(line);
    }
    let summary = summary_lines.join("\n");
    let now = now_millis();
    let created_at = existing_created.unwrap_or(now);
    let recall_context = card_recall_context(transaction, &atom_ids)?;
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
            params![
                id,
                project_id,
                kind,
                title,
                format!("{summary} {recall_context}")
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn episode_worthy_atom_ids(
    transaction: &Transaction<'_>,
    project_id: &str,
    session_id: &str,
) -> Result<BTreeSet<String>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT id FROM research_memory_atoms
             WHERE project_id=?1 AND source_session_id=?2 AND deleted=0
               AND status NOT IN ('superseded', 'deleted', 'conflict')
               AND (
                 source_class=?3 OR status IN ('user_confirmed', 'reviewed') OR
                  (source_class=?4 AND kind IN (
                    'experiment_result', 'negative_result',
                    'environment_fact', 'artifact_pointer', 'artifact_page_count',
                    'build_status', 'research_finding'
                  ))
               )",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![
                project_id,
                session_id,
                SOURCE_CLASS_USER,
                SOURCE_CLASS_ASSISTANT
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn card_recall_context(
    transaction: &Transaction<'_>,
    atom_ids: &[String],
) -> Result<String, String> {
    let mut contexts = Vec::new();
    for atom_id in atom_ids {
        let context = transaction
            .query_row(
                "SELECT recall_text FROM research_memory_atoms WHERE id=?1",
                [atom_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(context) = context.filter(|value| !value.trim().is_empty()) {
            contexts.push(context);
        }
    }
    Ok(truncate_chars(
        &contexts.join(" "),
        EPISODE_SUMMARY_CHAR_LIMIT,
    ))
}

/// Atom ids R3 is allowed to quote.
///
/// R3 is the only layer injected into every prompt with no relevance test, so
/// it is restricted to what the user actually asserted plus what a human
/// vouched for in the Explorer. The extractor recognises a "constraint" by
/// keyword, and the assistant writes `必须` / `must` / `不能` constantly while
/// narrating its own work — under the old confidence-only gate those sentences
/// became standing project rules, including rules belonging to a different
/// project's paper. Keeping them in R1 costs nothing: R1 is recalled on topic
/// overlap, so an assistant statement still comes back when it is relevant.
fn promotable_atom_ids(
    connection: &Connection,
    project_id: &str,
) -> Result<BTreeSet<String>, String> {
    let placeholders = HUMAN_VOUCHED_STATUSES
        .iter()
        .enumerate()
        .map(|(index, _)| format!("?{}", index + 3))
        .collect::<Vec<_>>()
        .join(", ");
    let mut statement = connection
        .prepare(&format!(
            "SELECT id FROM research_memory_atoms
             WHERE project_id=?1 AND deleted=0
               AND (source_class=?2 OR status IN ({placeholders}))"
        ))
        .map_err(|error| error.to_string())?;
    let mut bindings: Vec<&dyn rusqlite::ToSql> = vec![&project_id, &SOURCE_CLASS_USER];
    bindings.extend(
        HUMAN_VOUCHED_STATUSES
            .iter()
            .map(|status| status as &dyn rusqlite::ToSql),
    );
    let rows = statement
        .query_map(bindings.as_slice(), |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut ids = BTreeSet::new();
    for row in rows {
        ids.insert(row.map_err(|error| error.to_string())?);
    }
    Ok(ids)
}

fn refresh_profile(
    connection: &Connection,
    project_id: &str,
    atoms: &[ResearchMemoryAtom],
) -> Result<(), String> {
    let promotable = promotable_atom_ids(connection, project_id)?;
    let selected = atoms
        .iter()
        .filter(|atom| {
            promotable.contains(&atom.id)
                && atom.confidence_millis >= 650
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
        connection
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
    connection
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
    let session_filter = research_memory_session_sql("source_session_id");
    let mut statement = connection
        .prepare(&format!(
            "SELECT id, project_id, kind, statement, normalized_key, scope,
                    confidence_millis, status, source_session_id, source_event_ids,
                    artifact_paths, created_at, updated_at, valid_from, valid_until,
                    supersedes_id
             FROM research_memory_atoms
             WHERE project_id=?1 AND deleted=0 AND status NOT IN ('superseded', 'deleted')
               AND {session_filter}
             ORDER BY CASE status WHEN 'user_confirmed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                      updated_at DESC LIMIT 500"
        ))
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
    let mut candidates = if query.chars().any(is_cjk) {
        recall_atoms_like(connection, project_id, &terms, over_fetch(limit), moment)?
    } else {
        recall_atoms_fts(connection, project_id, &terms, over_fetch(limit), moment)?
    };
    let query_subjects = subject_terms(query)
        .into_iter()
        .map(|(subject, _)| subject)
        .collect::<BTreeSet<_>>();
    if !query_subjects.is_empty() {
        candidates.extend(recall_atoms_by_subject(
            connection,
            project_id,
            &query_subjects,
            over_fetch(limit),
            moment,
        )?);
    }
    let mut seen = BTreeSet::new();
    Ok(candidates
        .into_iter()
        .filter(|atom| {
            seen.insert(atom.id.clone())
                && is_research_memory_session_id(&atom.source_session_id)
                && (atom_meets_overlap(connection, atom, &terms)
                    || atom_matches_subject(connection, atom, &query_subjects))
        })
        .take(limit)
        .collect())
}

fn atom_matches_subject(
    connection: &Connection,
    atom: &ResearchMemoryAtom,
    query_subjects: &BTreeSet<String>,
) -> bool {
    if query_subjects.is_empty() {
        return false;
    }
    connection
        .query_row(
            "SELECT subject_key FROM research_memory_atoms WHERE id=?1",
            [&atom.id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
        .is_some_and(|subject| query_subjects.contains(&subject))
}

fn recall_atoms_by_subject(
    connection: &Connection,
    project_id: &str,
    subjects: &BTreeSet<String>,
    limit: usize,
    moment: &RecallMoment,
) -> Result<Vec<ResearchMemoryAtom>, String> {
    if subjects.is_empty() {
        return Ok(Vec::new());
    }
    let excluded_statuses = recall_excluded_statuses(moment);
    let session_filter = research_memory_session_sql("source_session_id");
    let placeholders = (0..subjects.len())
        .map(|index| format!("?{}", index + 4))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT id, project_id, kind, statement, normalized_key, scope,
                confidence_millis, status, source_session_id, source_event_ids,
                artifact_paths, created_at, updated_at, valid_from, valid_until,
                supersedes_id
         FROM research_memory_atoms
         WHERE project_id=?1 AND deleted=0 AND status NOT IN {excluded_statuses}
           AND {session_filter}
           AND (valid_from IS NULL OR valid_from <= ?2)
           AND (valid_until IS NULL OR valid_until > ?2)
           AND subject_key IN ({placeholders})
         ORDER BY CASE status WHEN 'user_confirmed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                  confidence_millis DESC, COALESCE(valid_from, '') DESC, updated_at DESC
         LIMIT ?3"
    );
    let mut values = vec![
        rusqlite::types::Value::from(project_id.to_string()),
        rusqlite::types::Value::from(moment.as_of.clone()),
        rusqlite::types::Value::from(i64::try_from(limit).unwrap_or(i64::MAX)),
    ];
    values.extend(subjects.iter().cloned().map(rusqlite::types::Value::from));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    map_atoms(
        &mut statement,
        rusqlite::params_from_iter(values),
        false,
    )
}

fn atom_meets_overlap(
    connection: &Connection,
    atom: &ResearchMemoryAtom,
    terms: &[String],
) -> bool {
    let recall_text = connection
        .query_row(
            "SELECT recall_text FROM research_memory_atoms WHERE id=?1",
            [&atom.id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| atom.statement.clone());
    meets_overlap(&recall_text, terms)
}

fn recall_atoms_fts(
    connection: &Connection,
    project_id: &str,
    terms: &[String],
    limit: usize,
    moment: &RecallMoment,
) -> Result<Vec<ResearchMemoryAtom>, String> {
    let excluded_statuses = recall_excluded_statuses(moment);
    let session_filter = research_memory_session_sql("a.source_session_id");
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
           AND {session_filter}
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
    let session_filter = research_memory_session_sql("source_session_id");
    let (matches, relevance) = like_clauses("recall_text", terms.len(), 4);
    let (_, statement_relevance) = like_clauses("statement", terms.len(), 4);
    let sql = format!(
        "SELECT id, project_id, kind, statement, normalized_key, scope,
                confidence_millis, status, source_session_id, source_event_ids,
                artifact_paths, created_at, updated_at, valid_from, valid_until,
                supersedes_id
         FROM research_memory_atoms
         WHERE project_id=?1 AND deleted=0 AND status NOT IN {excluded_statuses}
           AND {session_filter}
           AND (valid_from IS NULL OR valid_from <= ?2)
           AND (valid_until IS NULL OR valid_until > ?2)
           AND ({matches})
         ORDER BY (({statement_relevance}) + ({relevance}) * 2) DESC,
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
    let session_filter = research_memory_session_sql("source_session_id");
    let sql = format!(
        "SELECT id, project_id, kind, statement, normalized_key, scope,
                confidence_millis, status, source_session_id, source_event_ids,
                artifact_paths, created_at, updated_at, valid_from, valid_until,
                supersedes_id
         FROM research_memory_atoms
         WHERE id=?1 AND project_id=?2 AND deleted=0
           AND status NOT IN {excluded_statuses}
           AND {session_filter}
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
    let (matches, relevance) =
        like_clauses("(recall_text || ' ' || kind)", terms.len(), 3);
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
    // Two filters the stored profile applies but this one used to skip.
    //
    // `R3_STANDING_KINDS`: the renderer injects R3 unconditionally, on every
    // turn, so it admits only lines that hold regardless of the question.
    // Building the profile from four kinds and then discarding half of it at
    // render time spent the query and the budget check on rows that could never
    // be used.
    //
    // The promotion predicate: R3 is standing project policy, so an
    // assistant-authored sentence must not become one without a human vouching
    // for it. `refresh_profile` has enforced that since the `source_class`
    // migration, but this is the query that actually feeds the prompt.
    let standing_kinds = R3_STANDING_KINDS
        .iter()
        .map(|kind| format!("'{kind}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let vouched_statuses = HUMAN_VOUCHED_STATUSES
        .iter()
        .map(|status| format!("'{status}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let session_filter = research_memory_session_sql("source_session_id");
    let sql = format!(
        "SELECT id, project_id, kind, statement, normalized_key, scope,
                confidence_millis, status, source_session_id, source_event_ids,
                artifact_paths, created_at, updated_at, valid_from, valid_until,
                supersedes_id
         FROM research_memory_atoms
         WHERE project_id=?1 AND deleted=0 AND status NOT IN {excluded_statuses}
           AND {session_filter}
           AND confidence_millis >= 650
           AND kind IN ({standing_kinds})
           AND (source_class=?3 OR status IN ({vouched_statuses}))
           AND (valid_from IS NULL OR valid_from <= ?2)
           AND (valid_until IS NULL OR valid_until > ?2)
         ORDER BY CASE status WHEN 'user_confirmed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                  COALESCE(valid_from, '') DESC, updated_at DESC
         LIMIT 16"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let atoms = map_atoms(
        &mut statement,
        params![project_id, &moment.as_of, SOURCE_CLASS_USER],
        false,
    )?;
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
    if !is_research_memory_session_id(&capture.session_id) {
        return Vec::new();
    }
    let mut candidates = Vec::new();
    let mut seen = BTreeSet::new();
    let user_normalized = normalize_statement(&capture.user_text);
    for (role, source_class, text, base_confidence) in [
        (
            "user",
            SOURCE_CLASS_USER,
            capture.user_text.as_str(),
            USER_ASSERTED_CONFIDENCE,
        ),
        (
            "assistant",
            SOURCE_CLASS_ASSISTANT,
            capture.assistant_text.as_str(),
            760_i64,
        ),
    ] {
        let reply_draft_context =
            role == "assistant" && looks_like_reply_draft_context(text);
        for raw_sentence in split_sentences(text) {
            let Some(sentence) = clean_candidate_sentence(&raw_sentence) else {
                continue;
            };
            let minimum_chars = if sentence.chars().any(is_cjk) { 6 } else { 12 };
            if sentence.chars().count() < minimum_chars
                || sentence.chars().count() > 520
                || looks_like_question(&sentence)
                || has_unresolved_placeholder(&sentence)
                || (role == "user"
                    && looks_like_user_request(&sentence)
                    && !looks_like_explicit_user_commitment(&sentence))
            {
                continue;
            }
            let artifacts = extract_artifact_paths(&sentence);
            let lower = classifiable_text(&sentence, &artifacts);
            if role == "assistant"
                && (looks_like_acknowledgement(&lower)
                    || looks_like_assistant_process_or_proposal(&lower)
                    || (reply_draft_context && looks_like_reply_draft_claim(&raw_sentence))
                    || restates_user_text(&sentence, &user_normalized))
            {
                continue;
            }
            let mut kinds = Vec::new();
            if contains_any_keyword(
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
            if contains_any_keyword(
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
            if contains_any_keyword(
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
            if contains_any_keyword(
                &lower,
                &[
                    "failed",
                    "failure",
                    "did not work",
                    "undefined control sequence",
                    "fatal error",
                    "compilation error",
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
                    "编译报错",
                ],
            ) {
                kinds.push("negative_result");
            }
            if !looks_like_external_claim(&lower)
                && contains_any_keyword(
                    &lower,
                    &[
                        "experiment",
                        "result",
                        "results",
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
            if contains_any_keyword(
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
                    "软件版本",
                    "环境版本",
                    "版本号",
                    "运行时",
                ],
            ) {
                kinds.push("environment_fact");
            }
            if contains_any_keyword(
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
            if contains_any_keyword(
                &lower,
                &[
                    "key finding",
                    "core finding",
                    "our finding",
                    "we found",
                    "the conclusion is",
                    "novelty",
                    "contribution",
                    "核心结论",
                    "主要结论",
                    "结论是",
                    "真正的创新",
                    "真正能立住的创新",
                    "核心创新",
                    "主要创新",
                ],
            ) {
                kinds.push("research_finding");
            }
            if !artifacts.is_empty() {
                kinds.push("artifact_pointer");
            }
            // One sentence is one fact, whatever number of keyword lists it
            // trips. Storing a row per matched kind duplicated the statement,
            // and both copies then competed for the same handful of R1 recall
            // slots while the prompt deduplicator threw the second away.
            let Some(kind) = primary_kind(&kinds) else {
                continue;
            };
            if kind == "artifact_pointer" && !has_materialized_artifact_evidence(&lower) {
                continue;
            }
            if kind == "experiment_result" && !has_specific_result_evidence(&sentence, &lower) {
                continue;
            }
            let update_signal = contains_any_keyword(
                &lower,
                &[
                    "latest",
                    "now use",
                    "update",
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
            // The artifact bonus follows the evidence, not the label: a
            // statement that names a produced file is better sourced whether or
            // not `artifact_pointer` won the priority contest.
            let confidence = if artifacts.is_empty() {
                base_confidence
            } else {
                (base_confidence + 80).min(980)
            };
            // A materialized PDF can carry two independently changing facts:
            // page count and build health. Keeping them as typed rows is what
            // lets a new successful compile retire an old failure without
            // confusing it with a changed page count.
            let typed = typed_current_fact_identities(&sentence, &lower, &artifacts);
            let identities = if typed.is_empty() {
                vec![(kind, normalized_key(&sentence, kind))]
            } else {
                typed
            };
            for (candidate_kind, normalized_key) in identities {
                let candidate_key = format!("{candidate_kind}:{normalized_key}");
                if !seen.insert(candidate_key) || candidates.len() >= MAX_ATOMS_PER_TURN {
                    continue;
                }
                candidates.push(ExtractedCandidate {
                    kind: candidate_kind.to_string(),
                    statement: sentence.clone(),
                    normalized_key,
                    confidence_millis: confidence,
                    source_class,
                    artifact_paths: artifacts.clone(),
                    update_signal,
                });
            }
        }
    }
    candidates
}

/// The sentence with its artifact paths blanked out, lowercased for matching.
///
/// Keyword classification must not read file names. `./reports/result.json`
/// contains "result", which labelled an artifact pointer an experiment result;
/// a path is evidence of provenance, not a statement about content. The paths
/// are still captured separately in `artifact_paths`.
fn classifiable_text(sentence: &str, artifacts: &[String]) -> String {
    let mut lower = sentence.to_ascii_lowercase();
    for artifact in artifacts {
        lower = lower.replace(&artifact.to_ascii_lowercase(), " ");
    }
    lower
}

/// Kinds in descending order of standing. The four R3-eligible kinds lead so a
/// sentence that is both a rule and an observation keeps its rule label — the
/// profile query filters on `kind`, so losing that label would silently drop the
/// statement out of the constitution.
const KIND_PRIORITY: &[&str] = &[
    "user_preference",
    "constraint",
    "research_decision",
    "methodological_lesson",
    "research_finding",
    "negative_result",
    "experiment_result",
    "environment_fact",
    "artifact_pointer",
];

fn primary_kind<'a>(kinds: &[&'a str]) -> Option<&'a str> {
    KIND_PRIORITY
        .iter()
        .find_map(|ranked| kinds.iter().find(|kind| *kind == ranked).copied())
}

/// True when an assistant sentence repeats a user sentence from the same turn
/// verbatim. Shorter fragments collide by chance, so containment is only trusted
/// past the same length the prompt deduplicator uses.
fn restates_user_text(sentence: &str, user_normalized: &str) -> bool {
    let normalized = normalize_statement(sentence);
    normalized.chars().count() >= RESEARCH_RESTATEMENT_MIN_CHARS
        && user_normalized.contains(&normalized)
}

/// True when an assistant sentence is bookkeeping about the conversation rather
/// than a claim about the research: "recorded the executor model choice",
/// "已记录该决定". These carry the user's subject without adding a fact, so they
/// used to land as sibling atoms that shared a `normalized_key` with the
/// statement they were acknowledging and then competed with it for recall slots.
///
/// Only the opening of the sentence counts. An acknowledgement leads with its
/// verb in both languages ("已记录…", "I have recorded…"), whereas a real finding
/// that happens to end with one — "实验结果 p95 延迟降低到 42 ms，来源已经记录。" —
/// states the result first and must keep its atom. Matching anywhere in the
/// sentence threw those away.
///
/// Deliberately narrow overall: R3 promotion is already gated on `source_class`,
/// so this filter only has to stop pure bookkeeping from occupying R1.
fn looks_like_acknowledgement(lower: &str) -> bool {
    let opening = lower
        .chars()
        .take(ACKNOWLEDGEMENT_PREFIX_CHARS)
        .collect::<String>();
    contains_any(
        &opening,
        &[
            "已记录",
            "已经记录",
            "记录了",
            "已保存",
            "已经保存",
            "已写入",
            "已经写入",
            "已更新",
            "已经更新",
            "好的",
            "收到",
            "明白了",
            "have recorded",
            "has been recorded",
            "have saved",
            "has been saved",
            "noted",
            "acknowledged",
            "got it",
            "understood",
        ],
    )
}

fn clean_candidate_sentence(value: &str) -> Option<String> {
    let raw = value.trim();
    if raw.is_empty()
        || raw.starts_with('#')
        || looks_like_table_row(raw)
        || looks_like_raw_json(raw)
    {
        return None;
    }
    let mut sentence = raw;
    if let Some(stripped) = sentence.strip_prefix('>') {
        sentence = stripped.trim_start();
    }
    if let Some(stripped) = sentence
        .strip_prefix("- ")
        .or_else(|| sentence.strip_prefix("* "))
        .or_else(|| sentence.strip_prefix("+ "))
    {
        sentence = stripped.trim();
    } else if let Some((prefix, rest)) = sentence.split_once(". ") {
        if !prefix.is_empty() && prefix.chars().all(|character| character.is_ascii_digit()) {
            sentence = rest.trim();
        }
    }
    let plain = sentence
        .trim_matches(|character: char| matches!(character, '*' | '_' | '`'))
        .trim();
    if plain.is_empty()
        || (plain.chars().count() <= 100
            && (plain.ends_with(':') || plain.ends_with('：')))
        || looks_like_table_row(plain)
        || looks_like_raw_json(plain)
    {
        None
    } else {
        Some(plain.to_string())
    }
}

fn looks_like_table_row(value: &str) -> bool {
    value.matches('|').count() >= 2
        || (value.contains("---")
            && value
                .chars()
                .all(|character| matches!(character, '-' | ':' | '|' | ' ')))
}

fn looks_like_raw_json(value: &str) -> bool {
    let trimmed = value.trim();
    (trimmed.starts_with('{') && trimmed.contains("\":"))
        || (trimmed.starts_with('[') && trimmed.contains("\":"))
}

fn looks_like_user_request(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    [
        "please ",
        "can you ",
        "could you ",
        "would you ",
        "help me ",
        "take a look",
        "请",
        "麻烦",
        "帮我",
        "能不能",
        "可不可以",
        "先说",
        "先看",
        "看看",
        "审查一下",
        "修改一下",
        "解决上述",
    ]
    .iter()
    .any(|marker| lower.starts_with(marker))
}

fn looks_like_explicit_user_commitment(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    contains_any_keyword(
        &lower,
        &[
            "i prefer",
            "we prefer",
            "we decided",
            "must",
            "must not",
            "偏好",
            "决定",
            "必须",
            "不得",
            "只允许",
        ],
    )
}

fn looks_like_assistant_process_or_proposal(lower: &str) -> bool {
    let opening = normalized_candidate_opening(lower);
    [
        "if ",
        "if you ",
        "before replying",
        "i can ",
        "i will ",
        "i'll ",
        "do you want me",
        "would you like me",
        "next,",
        "next ",
        "the next step",
        "we can consider",
        "i recommend",
        "the user is ",
        "suggestion:",
        "suggested reply",
        "suggested response",
        "reply draft",
        "response draft",
        "reply template",
        "response template",
        "如果",
        "若要",
        "如需",
        "需要的话",
        "需要我",
        "要我",
        "我可以",
        "我会",
        "我将",
        "我来",
        "我先",
        "我看到",
        "我读取",
        "我再",
        "让我",
        "找到了",
        "接下来",
        "下一步",
        "现在验证",
        "现在结构",
        "建议",
        "可以考虑",
        "先来",
        "先看",
        "先试",
        "先把",
        "现在先",
        "正在",
        "回复前",
        "建议回复",
        "建议答复",
        "回复草稿",
        "答复草稿",
        "回复模板",
        "答复模板",
        "拟回复",
    ]
    .iter()
    .any(|marker| opening.starts_with(marker))
}

fn normalized_candidate_opening(value: &str) -> &str {
    value
        .trim_start_matches(|character: char| {
            character.is_whitespace()
                || matches!(
                    character,
                    '*' | '_' | '`' | '>' | '"' | '\'' | '“' | '”' | '‘' | '’'
                        | '(' | '（' | '[' | '【' | '{'
                )
        })
        .trim_start()
}

fn looks_like_reply_draft_context(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    contains_any(
        &lower,
        &[
            "draft reply",
            "reply draft",
            "draft response",
            "response draft",
            "suggested reply",
            "suggested response",
            "reply template",
            "response template",
            "proposed response",
            "you can reply",
            "回复草稿",
            "答复草稿",
            "建议回复",
            "建议答复",
            "回复模板",
            "答复模板",
            "拟回复",
            "可直接回复",
            "可以这样回复",
        ],
    )
}

fn looks_like_reply_draft_claim(value: &str) -> bool {
    let raw = value.trim_start();
    let quoted = raw.starts_with('>')
        || raw.starts_with('"')
        || raw.starts_with('\'')
        || raw.starts_with('“')
        || raw.starts_with('‘');
    let lower = raw.to_ascii_lowercase();
    let opening = normalized_candidate_opening(&lower);
    quoted
        || [
            "result:",
            "results:",
            "experimental result",
            "experimental results",
            "test result",
            "validation result",
            "实验结果",
            "验证结果",
            "测试结果",
        ]
        .iter()
        .any(|marker| opening.starts_with(marker))
}

fn has_unresolved_placeholder(value: &str) -> bool {
    static PLACEHOLDER_REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = PLACEHOLDER_REGEX.get_or_init(|| {
        Regex::new(
            r"(?ix)
              \[\s*(?:x|[a-f]|[a-f]\s*-\s*[a-f])\s*\]
              | \b(?:todo|tbd)\b
              | <\s*placeholder\s*>",
        )
        .expect("research-memory placeholder regex must compile")
    });
    regex.is_match(value)
        || contains_any(
            &value.to_ascii_lowercase(),
            &["待填", "待确认", "待补充", "待替换"],
        )
}

fn has_materialized_artifact_evidence(lower: &str) -> bool {
    contains_any_keyword(
        lower,
        &[
            "saved",
            "written to",
            "generated",
            "created at",
            "exported",
            "compiled",
            "produced",
            "available at",
            "located at",
            "已保存",
            "已写入",
            "写入了",
            "保存在",
            "已生成",
            "生成了",
            "已创建",
            "已导出",
            "已编译",
            "编译产物",
            "产物位于",
            "文件位于",
            "路径为",
        ],
    )
}

fn has_specific_result_evidence(sentence: &str, lower: &str) -> bool {
    let prefix = sentence
        .split(['(', '（', ':', '：'])
        .next()
        .unwrap_or(sentence)
        .trim()
        .trim_matches(|character: char| matches!(character, '*' | '_' | '`'));
    if matches!(
        prefix.to_ascii_lowercase().as_str(),
        "result" | "results" | "test result" | "validation result" | "实验结果" | "验证结果"
    ) && (sentence.contains('(') || sentence.contains('（'))
        && !sentence.contains(':')
        && !sentence.contains('：')
    {
        return false;
    }
    static QUANTIFIED_RESULT_REGEX: OnceLock<Regex> = OnceLock::new();
    let quantified = QUANTIFIED_RESULT_REGEX
        .get_or_init(|| {
            Regex::new(
                r"(?ix)
                  -?\d+(?:\.\d+)?\s*
                    (?:%|ms|msec|s|sec|seconds?|minutes?|hours?|runs?|trials?|
                       samples?|cases?|folds?|epochs?|activations?|tokens?|kb|mb|gb)
                  | -?\d+(?:\.\d+)?\s*(?:次|毫秒|秒|分钟|小时|轮|组|个|项|倍)
                  | (?:=|:|\bto\b|\bby\b|\bat\b|为|到|至)\s*
                    -?\d+(?:\.\d+)?",
            )
            .expect("research-memory result evidence regex must compile")
        })
        .is_match(lower);
    let explicit_result = contains_any_keyword(
        lower,
        &[
            "experiment result",
            "experimental result",
            "benchmark result",
            "test result",
            "validation result",
            "results show",
            "result shows",
            "实验结果",
            "测试结果",
            "验证结果",
            "结果显示",
        ],
    );
    let observed_outcome = contains_any_keyword(
        lower,
        &[
            "measured",
            "observed",
            "achieved",
            "improved",
            "reduced",
            "increased",
            "decreased",
            "completed",
            "测得",
            "实测",
            "观察到",
            "达到",
            "提升",
            "降低",
            "增加",
            "减少",
            "完成",
        ],
    );
    let verified_pass = contains_any_keyword(
        lower,
        &[
            "passed",
            "passes",
            "through test",
            "tests passed",
            "通过测试",
            "全部通过",
            "测试通过",
        ],
    );
    quantified && (explicit_result || observed_outcome || verified_pass)
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
    let mut raw_candidates = delimited_segments(value, '`', '`');
    raw_candidates.extend(delimited_segments(value, '<', '>'));
    raw_candidates.extend(markdown_link_destinations(value));
    raw_candidates.extend(
        value
            .split_whitespace()
            .filter(|candidate| {
                !candidate.contains(['`', '<', '>'])
                    && !candidate.contains("](")
            })
            .map(ToOwned::to_owned),
    );

    let mut seen = BTreeSet::new();
    let mut paths = Vec::new();
    for candidate in raw_candidates {
        let Some(path) = normalize_artifact_candidate(&candidate) else {
            continue;
        };
        let key = path.to_ascii_lowercase();
        if seen.insert(key) {
            paths.push(path);
        }
        if paths.len() >= 8 {
            break;
        }
    }
    paths
}

fn delimited_segments(value: &str, opening: char, closing: char) -> Vec<String> {
    let mut segments = Vec::new();
    let mut start = None;
    for (index, character) in value.char_indices() {
        if start.is_none() && character == opening {
            start = Some(index + character.len_utf8());
        } else if let Some(segment_start) = start {
            if character == closing {
                if segment_start < index {
                    segments.push(value[segment_start..index].to_string());
                }
                start = None;
            }
        }
    }
    segments
}

fn markdown_link_destinations(value: &str) -> Vec<String> {
    let mut destinations = Vec::new();
    let mut remainder = value;
    while let Some(start) = remainder.find("](") {
        remainder = &remainder[start + 2..];
        let (candidate, consumed) = if let Some(after_open) = remainder.strip_prefix('<') {
            match after_open.find('>') {
                Some(end) => (&after_open[..end], end + 2),
                None => break,
            }
        } else {
            match remainder.find(')') {
                Some(end) => (&remainder[..end], end + 1),
                None => break,
            }
        };
        destinations.push(candidate.to_string());
        remainder = remainder.get(consumed..).unwrap_or_default();
    }
    destinations
}

fn normalize_artifact_candidate(value: &str) -> Option<String> {
    let mut candidate = value
        .trim()
        .trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | '`' | '<' | '>' | '[' | ']' | '(' | ')' | '{' | '}' | ',' | '，'
            )
        })
        .trim_end_matches(['.', '。', ';', '；', ':'])
        .trim()
        .to_string();
    if candidate.is_empty() {
        return None;
    }
    if let Some(start) = candidate.rfind("](") {
        candidate = candidate[start + 2..]
            .trim_matches(|character| matches!(character, '<' | '>'))
            .to_string();
    }
    let lower = candidate.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file://")
        || lower.contains("://")
    {
        return None;
    }
    if let Some(anchor) = candidate.rfind('#') {
        let suffix = &candidate[anchor + 1..];
        if suffix.starts_with('L') || suffix.starts_with('l') || suffix.chars().all(|ch| ch.is_ascii_digit()) {
            candidate.truncate(anchor);
        }
    }
    for _ in 0..2 {
        let Some(colon) = candidate.rfind(':') else {
            break;
        };
        let suffix = &candidate[colon + 1..];
        if suffix.is_empty() || !suffix.chars().all(|ch| ch.is_ascii_digit()) {
            break;
        }
        candidate.truncate(colon);
    }
    if candidate.contains('：')
        || candidate
            .chars()
            .any(|character| matches!(character, '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return None;
    }
    if let Some(colon) = candidate.find(':') {
        let bytes = candidate.as_bytes();
        let is_windows_drive = colon == 1
            && bytes.first().is_some_and(u8::is_ascii_alphabetic)
            && bytes
                .get(2)
                .is_some_and(|separator| matches!(*separator, b'/' | b'\\'));
        if !is_windows_drive {
            return None;
        }
    }
    let file_name = candidate
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(candidate.as_str());
    let extension = file_name.rsplit_once('.')?.1.to_ascii_lowercase();
    if !is_allowed_artifact_extension(&extension)
        || file_name.starts_with('.')
        || file_name.chars().any(char::is_whitespace)
    {
        return None;
    }
    Some(candidate)
}

fn is_allowed_artifact_extension(extension: &str) -> bool {
    matches!(
        extension,
        "csv"
            | "json"
            | "jsonl"
            | "md"
            | "tex"
            | "pdf"
            | "py"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "ipynb"
            | "png"
            | "jpg"
            | "jpeg"
            | "svg"
            | "parquet"
            | "pt"
            | "pth"
            | "safetensors"
    )
}

/// Minimum distinct Sessions a term must appear in before it becomes a project
/// subject.
///
/// One session is not evidence of a subject — every passing mention would
/// qualify. Two is the cheapest signal that the project keeps coming back to
/// something. Measured on a real 474-atom store, this registers 117 subjects
/// covering 54% of atoms; admitting single-session terms triples the subject
/// count for terms that are never referred to again.
const SUBJECT_MIN_SESSIONS: i64 = 2;

const SUBJECT_MAX_TERM_CHARS: usize = 60;

/// Head nouns and boilerplate that name no specific thing. A subject key exists
/// to group statements about *one* entity; `model` or `result` would collapse
/// unrelated facts onto a single key, which is the failure
/// [`SUPERSEDABLE_SUBJECTS`] documents.
const SUBJECT_STOPWORDS: &[&str] = &[
    "abstract", "all", "and", "any", "appendix", "april", "are", "august", "can",
    "chapter", "com", "conclusion", "data", "default", "december", "error", "example",
    "false", "february", "figure", "final", "first", "for", "from", "has", "have",
    "however", "http", "https", "initial", "input", "introduction", "its", "january",
    "july", "june", "key", "last", "main", "march", "may", "method", "methods",
    "model", "models", "new", "next", "none", "not", "note", "november", "null",
    "october", "old", "one", "only", "org", "output", "overview", "paper", "papers",
    "pdf", "result", "results", "section", "september", "state", "such", "summary",
    "table", "text", "that", "the", "then", "they", "this", "todo", "total", "true",
    "two", "version", "warning", "with", "www", "you", "your", "e.g", "i.e", "et.al",
    "vs",
];

/// A term the project keeps returning to, and the atoms that mention it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemorySubject {
    /// Normalised `kind:term` key, e.g. `file:main.tex` or `ident:esn`.
    pub subject: String,
    /// The surface form as first written, for display.
    pub display: String,
    pub session_count: u64,
    pub atom_count: u64,
}

/// Candidate subject terms in one text.
///
/// Only concrete, stable names are admitted: normalized file paths, LaTeX
/// labels, and explicit identifiers. Free CJK n-grams and quoted natural
/// language look meaningful but collapse unrelated facts into the same
/// subject, which is worse than leaving a fact ungrouped.
fn subject_terms(text: &str) -> Vec<(String, String)> {
    let mut found: BTreeMap<String, String> = BTreeMap::new();
    let mut files: BTreeSet<String> = BTreeSet::new();

    for key in delimited_after_marker(text, &["\\ref{", "\\label{", "\\eqref{", "\\cref{"]) {
        push_subject(&mut found, "tex", &key, true);
    }
    // Preserve the full project-relative path when one is present. The older
    // word scanner below intentionally still adds a bare filename for prose,
    // but lifecycle and recall prefer this more concrete identity.
    for path in extract_artifact_paths(text) {
        files.insert(path.to_lowercase());
        push_subject(
            &mut found,
            "file",
            &canonical_artifact_identity(&path),
            true,
        );
    }
    for (word, _) in ascii_runs(text) {
        if let Some(name) = file_like(&word) {
            files.insert(name.to_lowercase());
            push_subject(&mut found, "file", &name, true);
        }
    }
    for span in delimited_segments(text, '`', '`') {
        let span = span.trim();
        if files.contains(&span.to_lowercase())
            || file_like(span).is_some()
            || !is_explicit_subject_identifier(span)
        {
            continue;
        }
        push_subject(&mut found, "ident", span, true);
    }
    for (word, sentence_initial) in ascii_runs(text) {
        if !looks_like_identifier(&word, sentence_initial) || files.contains(&word.to_lowercase()) {
            continue;
        }
        push_subject(&mut found, "ident", &word, true);
    }
    found.into_iter().map(|(k, v)| (k, v)).collect()
}

/// Code formatting alone does not make prose an identity. Admit a code span
/// only when it has the structure of an explicit identifier, such as
/// `eq:admissible-set`, `MuST-C`, or `run_042`.
fn is_explicit_subject_identifier(value: &str) -> bool {
    if value.is_empty()
        || value.chars().any(char::is_whitespace)
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_-.:".contains(character))
    {
        return false;
    }
    value.contains(['_', '-', '.', ':']) || looks_like_identifier(value, false)
}

fn push_subject(found: &mut BTreeMap<String, String>, kind: &str, display: &str, lowercase: bool) {
    let display = display.trim_matches(|c: char| {
        c.is_whitespace() || ".,;:!?()[]{}<>\u{3002}\u{ff0c}\u{3001}\u{ff1a}\u{ff1b}".contains(c)
    });
    if display.is_empty() || display.chars().count() > SUBJECT_MAX_TERM_CHARS {
        return;
    }
    let term = if lowercase {
        display.to_lowercase()
    } else {
        display.to_string()
    };
    if SUBJECT_STOPWORDS.contains(&term.as_str()) || is_opaque_token(&term) {
        return;
    }
    found
        .entry(format!("{kind}:{term}"))
        .or_insert_with(|| display.to_string());
}

/// Hashes, ids and timestamps read as identifiers but name nothing a later turn
/// can refer back to.
fn is_opaque_token(term: &str) -> bool {
    let digits = term.chars().filter(char::is_ascii_digit).count();
    let letters = term.chars().filter(|c| c.is_ascii_alphabetic()).count();
    digits * 2 > term.chars().count() || (letters == 0 && !term.chars().any(is_cjk))
}

/// Word-shaped runs, each flagged with whether it opens a sentence.
///
/// The flag is what separates `Mamba` from `However`: in English prose every
/// sentence-initial word is capitalised, so capitalisation only carries naming
/// intent away from that position.
fn ascii_runs(text: &str) -> Vec<(String, bool)> {
    const RUN_EXTRAS: [char; 3] = ['-', '_', '.'];
    let mut runs: Vec<(String, bool)> = Vec::new();
    let mut current = String::new();
    let mut sentence_boundary = true;
    let mut current_initial = true;
    // A run absorbs `.` so that `main.tex` survives, which also swallows the
    // full stop that ends a sentence. Trim it back off and let it close the
    // sentence, or every word after a period reads as mid-sentence.
    let flush = |current: &mut String,
                     initial: bool,
                     boundary: &mut bool,
                     runs: &mut Vec<(String, bool)>| {
        if current.is_empty() {
            return;
        }
        let raw = std::mem::take(current);
        let without_tail = raw.trim_end_matches(RUN_EXTRAS);
        *boundary = raw[without_tail.len()..].contains('.');
        let word = without_tail.trim_start_matches(RUN_EXTRAS);
        if !word.is_empty() {
            runs.push((word.to_string(), initial));
        }
    };
    for character in text.chars() {
        if character.is_ascii_alphanumeric() || RUN_EXTRAS.contains(&character) {
            if current.is_empty() {
                current_initial = sentence_boundary;
            }
            current.push(character);
            continue;
        }
        flush(&mut current, current_initial, &mut sentence_boundary, &mut runs);
        if ".!?\n\u{3002}\u{ff01}\u{ff1f}\u{ff1b};:\u{ff1a}".contains(character) {
            sentence_boundary = true;
        } else if !character.is_whitespace()
            && !"-*#>|\u{201c}\u{300c}\"'(\u{ff08}".contains(character)
        {
            sentence_boundary = false;
        }
    }
    flush(&mut current, current_initial, &mut sentence_boundary, &mut runs);
    runs
}

/// `MuST-C`, `BSL-1K`, `off-policy`, `ch5_sparse_extremes` or a capitalised name
/// like `Mamba`. A bare lowercase word is prose, not a name.
///
/// A capitalised word that opens a sentence needs a second signal — an internal
/// capital, a digit, or a separator — because the capital there is grammar. On
/// the real corpus, without this the top "subjects" of one project were
/// `However`, `Initial`, `Introduction` and `August`.
fn looks_like_identifier(word: &str, sentence_initial: bool) -> bool {
    if word.chars().count() < 3 || !word.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return false;
    }
    if word.to_lowercase().starts_with("www.") {
        return false;
    }
    let tail = &word[1..];
    let separated = tail.contains(['-', '_', '.']);
    if separated {
        return true;
    }
    if !word.starts_with(|c: char| c.is_ascii_uppercase()) {
        return false;
    }
    !sentence_initial
        || tail.contains(|c: char| c.is_ascii_uppercase() || c.is_ascii_digit())
}

fn file_like(word: &str) -> Option<String> {
    let (stem, extension) = word.rsplit_once('.')?;
    if stem.is_empty() || !is_allowed_artifact_extension(&extension.to_lowercase()) {
        return None;
    }
    Some(word.to_string())
}

fn delimited_after_marker(text: &str, markers: &[&str]) -> Vec<String> {
    let mut found = Vec::new();
    for marker in markers {
        let mut rest = text;
        while let Some(start) = rest.find(marker) {
            rest = &rest[start + marker.len()..];
            if let Some(end) = rest.find('}') {
                let key = &rest[..end];
                if !key.is_empty() && !key.contains(char::is_whitespace) {
                    found.push(key.to_string());
                }
            }
        }
    }
    found
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

/// Returns deterministic identities for facts whose *latest* value matters.
///
/// These are deliberately narrow. A document's page count and the project's
/// current build health are scalar observations; later evidence can replace an
/// earlier value without discarding a separate research decision. In contrast,
/// arbitrary prose about the same file remains a normal R1 atom.
fn typed_current_fact_identities(
    sentence: &str,
    lower: &str,
    artifacts: &[String],
) -> Vec<(&'static str, String)> {
    let mut identities = Vec::new();
    if page_count_in_sentence(sentence) {
        if let Some(pdf) = artifacts
            .iter()
            .find(|path| path.to_ascii_lowercase().ends_with(".pdf"))
        {
            identities.push((
                "artifact_page_count",
                format!(
                    "current:artifact:{}:page_count",
                    canonical_artifact_identity(pdf)
                ),
            ));
        }
    }
    if looks_like_compile_outcome(lower) {
        // Compiler diagnostics often name only a chapter or a TeX control
        // sequence, not the eventual PDF. Treat build health as project-wide
        // until extraction has a trustworthy document identity. That makes a
        // later successful project compile close a prior resolved error rather
        // than leaving it in normal current-state recall forever.
        identities.push((
            "build_status",
            "current:build:project:compile_status".to_string(),
        ));
    }
    identities
}

fn page_count_in_sentence(sentence: &str) -> bool {
    static PAGE_COUNT_REGEX: OnceLock<Regex> = OnceLock::new();
    PAGE_COUNT_REGEX
        .get_or_init(|| Regex::new(r"(?ix)\b\d+\s*(?:pages?|pp\.)\b|\d+\s*页").expect("page regex"))
        .is_match(sentence)
}

fn looks_like_compile_outcome(lower: &str) -> bool {
    contains_any_keyword(
        lower,
        &[
            "compiled",
            "compilation",
            "compile error",
            "undefined control sequence",
            "fatal error",
            "latex error",
            "tectonic",
            "已编译",
            "编译成功",
            "编译失败",
            "编译报错",
            "控制序列未定义",
        ],
    )
}

/// Canonical form for a project-relative artifact identity. Filesystem
/// canonicalisation happens at the desktop capture boundary; this normalises
/// only spelling so Windows separators and `./` do not fork a lifecycle key.
fn canonical_artifact_identity(path: &str) -> String {
    let mut parts = Vec::new();
    for part in path.replace('\\', "/").split('/') {
        match part.trim() {
            "" | "." => {}
            ".." => {
                let _ = parts.pop();
            }
            value => parts.push(value.to_ascii_lowercase()),
        }
    }
    parts.join("/")
}

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
        || contains_any(
            &value.to_ascii_lowercase(),
            &[
                "what ",
                "why ",
                "how ",
                "which ",
                "where ",
                "when ",
                "who ",
                "什么",
                "如何",
                "怎么",
                "为何",
                "是否",
                "能否",
                "可否",
                "哪一",
            ],
        )
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

fn contains_any_keyword(value: &str, needles: &[&str]) -> bool {
    needles
        .iter()
        .any(|needle| contains_keyword(value, needle))
}

fn contains_keyword(value: &str, needle: &str) -> bool {
    let needle = needle.trim();
    if needle.is_empty() {
        return false;
    }
    if needle.chars().any(is_cjk) {
        return value.match_indices(needle).any(|(start, _)| {
            !is_cjk_keyword_false_friend(value.get(start..).unwrap_or_default(), needle)
        });
    }
    value.match_indices(needle).any(|(start, matched)| {
        let end = start + matched.len();
        let left_is_word = value[..start]
            .chars()
            .next_back()
            .is_some_and(|character| character.is_ascii_alphanumeric() || character == '_');
        let right_is_word = value[end..]
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric() || character == '_');
        !left_is_word && !right_is_word
    })
}

/// Chinese has no whitespace word boundary, but a handful of short classifier
/// words are also prefixes of unrelated technical terms. In particular, 经验
/// means a lesson only in some contexts; in 经验证据 / 经验公式 it means
/// empirical and must not create a methodological-lesson atom.
fn is_cjk_keyword_false_friend(tail: &str, needle: &str) -> bool {
    needle == "经验"
        && [
            "经验证据",
            "经验值",
            "经验公式",
            "经验模型",
            "经验分布",
            "经验风险",
            "经验研究",
            "经验结果",
            "经验数据",
            "经验测量",
        ]
        .iter()
        .any(|compound| tail.starts_with(compound))
}

fn episode_title(atoms: &[&ResearchMemoryAtom]) -> (&'static str, &'static str) {
    let has = |kind: &str| atoms.iter().any(|atom| atom.kind == kind);
    if has("build_status")
        || atoms.iter().any(|atom| {
            let lower = atom.statement.to_ascii_lowercase();
            looks_like_compile_outcome(&lower)
        })
    {
        ("Build episode", "build")
    } else if has("experiment_result") || has("negative_result") {
        ("Experiment episode", "experiment")
    } else if has("research_decision") || has("constraint") {
        ("Research decision episode", "decision")
    } else if has("methodological_lesson") || has("research_finding") {
        ("Methodology episode", "method")
    } else if has("user_preference") {
        ("Researcher preference episode", "preference")
    } else if has("artifact_pointer") || has("artifact_page_count") {
        ("Artifact episode", "artifact")
    } else {
        ("Research episode", "other")
    }
}

fn episode_title_anchor(atoms: &[&ResearchMemoryAtom]) -> String {
    if let Some(path) = atoms
        .iter()
        .flat_map(|atom| atom.artifact_paths.iter())
        .next()
    {
        return path.clone();
    }
    let combined = atoms
        .iter()
        .map(|atom| atom.statement.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if let Some((_, display)) = subject_terms(&combined).into_iter().next() {
        return display;
    }
    atoms
        .first()
        .map_or_else(|| "Research activity".to_string(), |atom| atom.statement.clone())
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
    for alias in semantic_recall_aliases(value) {
        if !terms.iter().any(|term| term == alias) {
            terms.push(alias.to_string());
        }
    }
    terms
}

fn semantic_recall_aliases(value: &str) -> Vec<&'static str> {
    let lower = value.to_ascii_lowercase();
    let mut aliases = Vec::new();
    if contains_any(
        &lower,
        &[
            "失败",
            "错误",
            "报错",
            "编译不了",
            "致命",
            "undefined control sequence",
            "fatal",
            "error",
            "failed",
        ],
    ) {
        aliases.push("somniq_error_concept");
    }
    if contains_any(
        &lower,
        &[
            "创新",
            "发明",
            "novelty",
            "contribution",
            "original contribution",
        ],
    ) {
        aliases.push("somniq_novelty_concept");
    }
    if contains_any(
        &lower,
        &["第五章", "第 5 章", "chapter 5", "chapter5", "ch5"],
    ) {
        aliases.push("somniq_chapter5_concept");
    }
    if contains_any(
        &lower,
        &[
            "逐章",
            "每个章节",
            "一个章节一个章节",
            "单章",
            "chapter-by-chapter",
            "standalone chapter",
        ],
    ) {
        aliases.push("somniq_chapterwise_concept");
    }
    if contains_any(&lower, &["编译", "compile", "latexmk", "pdflatex"]) {
        aliases.push("somniq_compile_concept");
    }
    aliases
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
            .min(RECALL_MAX_CJK_REQUIRED_OVERLAP)
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
