//! Project knowledge base kernel tools.
//!
//! Split-ownership companion to `literature.rs`:
//! - `papers/library.json` stays canonical for papers and the raw per-paper
//!   reading record (answer chains, evidence notes, PDF annotations).
//! - `papers/knowledge.db` (this module) is canonical for the *project
//!   knowledge graph*: confirmed knowledge points, their relations,
//!   confirmation status and version history. A knowledge point references its
//!   evidence by stable anchors (annotation/evidence ids + hashes) so a Chat
//!   citation still resolves back to the existing PDF-reader anchor.
//! - `retrieval_chunks` + `retrieval_fts` (+ a future `chunk_embeddings`) are a
//!   derived, rebuildable retrieval sublayer — drop and rebuild them to swap
//!   the embedding model without touching the knowledge data.
//!
//! Confirmation authority: the LLM-callable `KnowledgeUpsert` only ever writes
//! `draft` points (`allow_confirm = false`). `confirmed` is reachable solely
//! through `knowledge_confirm_at`, which the desktop wires to an explicit user
//! action — never to an LLM tool. This is the structural enforcement of "AI
//! generates, human filters".

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const PAPERS_DIR: &str = "papers";
const KNOWLEDGE_FILE: &str = "knowledge.db";

// ── Tool inputs ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceInput {
    pub paper_id: String,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub quote: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub annotation_id: Option<String>,
    #[serde(default)]
    pub evidence_id: Option<String>,
    /// Hash of the source page/region text; computed from `quote` when absent.
    #[serde(default)]
    pub content_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationInput {
    pub dst_id: String,
    pub kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePointInput {
    #[serde(default)]
    pub id: Option<String>,
    pub question: String,
    pub answer: String,
    pub statement: String,
    #[serde(default)]
    pub kind: Option<String>,
    /// Ignored unless `allow_confirm` is set — see module docs.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub source_paper_id: Option<String>,
    #[serde(default)]
    pub project_focus_snapshot: Option<String>,
    #[serde(default)]
    pub evidence: Vec<EvidenceInput>,
    #[serde(default)]
    pub relations: Vec<RelationInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeUpsertInput {
    pub points: Vec<KnowledgePointInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchInput {
    pub query: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

// ── Tool entry points (sync, pretty-JSON out) ───────────────────────────────

/// LLM-callable upsert. Forces `draft` (never confirms) — see module docs.
#[allow(clippy::needless_pass_by_value)] // by-value to match the execute_tool dispatch
pub fn run_knowledge_upsert(input: KnowledgeUpsertInput) -> Result<String, String> {
    let base = workspace_base()?;
    let stats = knowledge_upsert_at(&base, &input.points, false)?;
    serde_json::to_string_pretty(&stats).map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)] // by-value to match the execute_tool dispatch
pub fn run_knowledge_search(input: KnowledgeSearchInput) -> Result<String, String> {
    let base = workspace_base()?;
    let limit = input.limit.unwrap_or(8).clamp(1, 50);
    let result = knowledge_search_at(&base, &input.query, limit)?;
    serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
}

fn workspace_base() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|e| e.to_string())
}

// ── Database ────────────────────────────────────────────────────────────────

#[must_use]
pub fn knowledge_db_path_at(base: &Path) -> PathBuf {
    base.join(PAPERS_DIR).join(KNOWLEDGE_FILE)
}

/// Open (creating if needed) the per-project knowledge database. The schema is
/// applied idempotently on every open, mirroring `session_index::open_index`.
pub fn open_db(base: &Path) -> Result<Connection, String> {
    let dir = base.join(PAPERS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let connection = Connection::open(dir.join(KNOWLEDGE_FILE)).map_err(|e| e.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=2000;
             CREATE TABLE IF NOT EXISTS knowledge_points(
               id TEXT PRIMARY KEY,
               question TEXT NOT NULL,
               answer TEXT NOT NULL,
               statement TEXT NOT NULL,
               kind TEXT,
               status TEXT NOT NULL,
               project_focus_snapshot TEXT,
               source_paper_id TEXT,
               created_at TEXT,
               confirmed_at TEXT,
               version INTEGER NOT NULL DEFAULT 1
             );
             CREATE TABLE IF NOT EXISTS kp_evidence(
               kp_id TEXT NOT NULL,
               paper_id TEXT,
               page INTEGER,
               quote TEXT,
               role TEXT,
               annotation_id TEXT,
               evidence_id TEXT,
               quote_hash TEXT,
               content_hash TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_kp_evidence_kp ON kp_evidence(kp_id);
             CREATE TABLE IF NOT EXISTS kp_relations(
               src_id TEXT NOT NULL,
               dst_id TEXT NOT NULL,
               kind TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_kp_relations_src ON kp_relations(src_id);
             CREATE TABLE IF NOT EXISTS kp_versions(
               kp_id TEXT NOT NULL,
               version INTEGER NOT NULL,
               question TEXT,
               answer TEXT,
               statement TEXT,
               changed_at TEXT
             );
             CREATE TABLE IF NOT EXISTS retrieval_chunks(
               chunk_id TEXT PRIMARY KEY,
               kp_id TEXT NOT NULL,
               text TEXT NOT NULL,
               content_hash TEXT,
               tags TEXT,
               status TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_kp ON retrieval_chunks(kp_id);
             CREATE TABLE IF NOT EXISTS chunk_embeddings(
               chunk_id TEXT NOT NULL,
               model TEXT NOT NULL,
               dimensions INTEGER,
               content_hash TEXT,
               embedding BLOB,
               PRIMARY KEY(chunk_id, model)
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_fts USING fts5(
               chunk_id UNINDEXED,
               kp_id UNINDEXED,
               text,
               tokenize='trigram'
             );",
        )
        .map_err(|e| e.to_string())?;
    Ok(connection)
}

// ── Upsert ──────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertStats {
    pub added: usize,
    pub updated: usize,
    pub total: usize,
    /// Ids written this call, in input order (generated when not supplied).
    pub ids: Vec<String>,
    pub knowledge_db_path: String,
}

struct ExistingPoint {
    status: String,
    version: i64,
    created_at: String,
    confirmed_at: Option<String>,
    question: String,
    answer: String,
    statement: String,
}

/// Insert or update knowledge points (with their evidence and relations).
///
/// When `allow_confirm` is false (the LLM path), the function never sets
/// `confirmed`: a new point lands as `draft`, and an existing confirmed point is
/// downgraded to `draft` if its question/answer/statement changed (so it must be
/// re-reviewed) and otherwise left confirmed. `confirmed` only originates from
/// `knowledge_confirm_at`.
pub fn knowledge_upsert_at(
    base: &Path,
    points: &[KnowledgePointInput],
    allow_confirm: bool,
) -> Result<UpsertStats, String> {
    let mut connection = open_db(base)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let mut added = 0;
    let mut updated = 0;
    let mut ids = Vec::new();
    let now = now_iso();
    for point in points {
        if point.statement.trim().is_empty() {
            continue;
        }
        let id = point
            .id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| derive_point_id(point));
        ids.push(id.clone());
        let existing = load_existing_point(&transaction, &id)?;
        let content_changed = existing.as_ref().is_none_or(|prev| {
            prev.question != point.question
                || prev.answer != point.answer
                || prev.statement != point.statement
        });
        let requested = point.status.as_deref().unwrap_or("draft");
        let status = effective_status(allow_confirm, requested, existing.as_ref(), content_changed);
        let version = match &existing {
            Some(prev) if content_changed => prev.version + 1,
            Some(prev) => prev.version,
            None => 1,
        };
        let created_at = existing
            .as_ref()
            .map_or(now.clone(), |prev| prev.created_at.clone());
        let confirmed_at = if status == "confirmed" {
            existing
                .as_ref()
                .and_then(|prev| prev.confirmed_at.clone())
                .or_else(|| Some(now.clone()))
        } else {
            None
        };
        transaction
            .execute(
                "INSERT INTO knowledge_points(
                   id, question, answer, statement, kind, status,
                   project_focus_snapshot, source_paper_id, created_at, confirmed_at, version)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
                 ON CONFLICT(id) DO UPDATE SET
                   question=excluded.question, answer=excluded.answer,
                   statement=excluded.statement, kind=excluded.kind, status=excluded.status,
                   project_focus_snapshot=excluded.project_focus_snapshot,
                   source_paper_id=excluded.source_paper_id, confirmed_at=excluded.confirmed_at,
                   version=excluded.version",
                params![
                    id,
                    point.question,
                    point.answer,
                    point.statement,
                    point.kind,
                    status,
                    point.project_focus_snapshot,
                    point.source_paper_id,
                    created_at,
                    confirmed_at,
                    version,
                ],
            )
            .map_err(|e| e.to_string())?;
        if existing.is_none() || content_changed {
            transaction
                .execute(
                    "INSERT INTO kp_versions(kp_id, version, question, answer, statement, changed_at)
                     VALUES (?1,?2,?3,?4,?5,?6)",
                    params![id, version, point.question, point.answer, point.statement, now],
                )
                .map_err(|e| e.to_string())?;
        }
        replace_evidence(&transaction, &id, &point.evidence)?;
        replace_relations(&transaction, &id, &point.relations)?;
        if status == "confirmed" {
            derive_chunks_for_point(&transaction, &id)?;
        } else {
            delete_chunks_for_point(&transaction, &id)?;
        }
        if existing.is_none() {
            added += 1;
        } else {
            updated += 1;
        }
    }
    let total: i64 = transaction
        .query_row("SELECT COUNT(*) FROM knowledge_points", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(UpsertStats {
        added,
        updated,
        total: usize::try_from(total).unwrap_or(0),
        ids,
        knowledge_db_path: knowledge_db_path_at(base).to_string_lossy().into_owned(),
    })
}

/// Confirm a knowledge point — the ONLY path that sets `confirmed`. Derives the
/// point's retrieval chunks so it becomes searchable.
pub fn knowledge_confirm_at(base: &Path, kp_id: &str) -> Result<(), String> {
    let mut connection = open_db(base)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let changed = transaction
        .execute(
            "UPDATE knowledge_points
             SET status='confirmed',
                 confirmed_at=COALESCE(confirmed_at, ?2)
             WHERE id=?1",
            params![kp_id, now_iso()],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("knowledge point `{kp_id}` not found"));
    }
    derive_chunks_for_point(&transaction, kp_id)?;
    transaction.commit().map_err(|e| e.to_string())
}

/// Delete a knowledge point and everything derived from it. Used by the
/// review UI's "reject" action on a draft candidate.
pub fn knowledge_delete_at(base: &Path, kp_id: &str) -> Result<bool, String> {
    let mut connection = open_db(base)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    delete_chunks_for_point(&transaction, kp_id)?;
    transaction
        .execute("DELETE FROM kp_evidence WHERE kp_id=?1", [kp_id])
        .map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM kp_relations WHERE src_id=?1 OR dst_id=?1", [kp_id])
        .map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM kp_versions WHERE kp_id=?1", [kp_id])
        .map_err(|e| e.to_string())?;
    let removed = transaction
        .execute("DELETE FROM knowledge_points WHERE id=?1", [kp_id])
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(removed > 0)
}

fn effective_status(
    allow_confirm: bool,
    requested: &str,
    existing: Option<&ExistingPoint>,
    content_changed: bool,
) -> String {
    if allow_confirm {
        return match requested {
            "confirmed" | "archived" | "draft" => requested.to_string(),
            _ => "draft".to_string(),
        };
    }
    // LLM path: confirmation state is the user's; the LLM cannot raise it. An
    // unchanged confirmed point stays confirmed; anything else is a draft.
    match existing {
        Some(prev) if prev.status == "confirmed" && !content_changed => "confirmed".to_string(),
        _ => "draft".to_string(),
    }
}

fn load_existing_point(
    connection: &Connection,
    id: &str,
) -> Result<Option<ExistingPoint>, String> {
    connection
        .query_row(
            "SELECT status, version, created_at, confirmed_at, question, answer, statement
             FROM knowledge_points WHERE id=?1",
            [id],
            |row| {
                Ok(ExistingPoint {
                    status: row.get(0)?,
                    version: row.get(1)?,
                    created_at: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    confirmed_at: row.get(3)?,
                    question: row.get(4)?,
                    answer: row.get(5)?,
                    statement: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
}

fn replace_evidence(
    connection: &Connection,
    kp_id: &str,
    evidence: &[EvidenceInput],
) -> Result<(), String> {
    connection
        .execute("DELETE FROM kp_evidence WHERE kp_id=?1", [kp_id])
        .map_err(|e| e.to_string())?;
    for item in evidence {
        let quote_hash = (!item.quote.trim().is_empty()).then(|| stable_hash(&normalize(&item.quote)));
        let content_hash = item
            .content_hash
            .clone()
            .or_else(|| quote_hash.clone());
        connection
            .execute(
                "INSERT INTO kp_evidence(
                   kp_id, paper_id, page, quote, role, annotation_id, evidence_id,
                   quote_hash, content_hash)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    kp_id,
                    item.paper_id,
                    item.page,
                    item.quote,
                    item.role,
                    item.annotation_id,
                    item.evidence_id,
                    quote_hash,
                    content_hash,
                ],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn replace_relations(
    connection: &Connection,
    src_id: &str,
    relations: &[RelationInput],
) -> Result<(), String> {
    connection
        .execute("DELETE FROM kp_relations WHERE src_id=?1", [src_id])
        .map_err(|e| e.to_string())?;
    for relation in relations {
        if relation.dst_id.trim().is_empty() {
            continue;
        }
        connection
            .execute(
                "INSERT INTO kp_relations(src_id, dst_id, kind) VALUES (?1,?2,?3)",
                params![src_id, relation.dst_id, relation.kind],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Retrieval chunk derivation ───────────────────────────────────────────────

fn delete_chunks_for_point(connection: &Connection, kp_id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM retrieval_fts WHERE kp_id=?1", [kp_id])
        .map_err(|e| e.to_string())?;
    connection
        .execute("DELETE FROM retrieval_chunks WHERE kp_id=?1", [kp_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// (Re)derive the single retrieval chunk for one confirmed point. The chunk
/// text combines question + answer + statement + evidence quotes so keyword
/// recall hits the question, the conclusion, and its supporting sentences.
fn derive_chunks_for_point(connection: &Connection, kp_id: &str) -> Result<(), String> {
    delete_chunks_for_point(connection, kp_id)?;
    let Some((question, answer, statement)) = connection
        .query_row(
            "SELECT question, answer, statement FROM knowledge_points WHERE id=?1",
            [kp_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };
    let quotes = {
        let mut statement = connection
            .prepare("SELECT quote FROM kp_evidence WHERE kp_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([kp_id], |row| row.get::<_, Option<String>>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok)
            .flatten()
            .filter(|quote| !quote.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let text = [question, answer, statement, quotes]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let chunk_id = format!("chunk-{kp_id}-0");
    let content_hash = stable_hash(&text);
    connection
        .execute(
            "INSERT INTO retrieval_chunks(chunk_id, kp_id, text, content_hash, tags, status)
             VALUES (?1,?2,?3,?4,?5,'confirmed')",
            params![chunk_id, kp_id, text, content_hash, Option::<String>::None],
        )
        .map_err(|e| e.to_string())?;
    connection
        .execute(
            "INSERT INTO retrieval_fts(chunk_id, kp_id, text) VALUES (?1,?2,?3)",
            params![chunk_id, kp_id, text],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Drop and rebuild every derived chunk from the confirmed points. This is the
/// model-swap path: rebuild chunks (and, in a later phase, embeddings) without
/// migrating the authoritative knowledge tables.
pub fn rebuild_chunks_at(base: &Path) -> Result<usize, String> {
    let mut connection = open_db(base)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute_batch("DELETE FROM retrieval_fts; DELETE FROM retrieval_chunks;")
        .map_err(|e| e.to_string())?;
    let confirmed: Vec<String> = {
        let mut statement = transaction
            .prepare("SELECT id FROM knowledge_points WHERE status='confirmed'")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    for kp_id in &confirmed {
        derive_chunks_for_point(&transaction, kp_id)?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(confirmed.len())
}

// ── Search ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEvidence {
    pub paper_id: String,
    pub page: Option<i64>,
    pub quote: String,
    pub role: Option<String>,
    pub annotation_id: Option<String>,
    pub evidence_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRelation {
    pub dst_id: String,
    pub kind: Option<String>,
    pub statement: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub question: String,
    pub answer: String,
    pub statement: String,
    pub kind: Option<String>,
    pub source_paper_id: Option<String>,
    pub snippet: String,
    pub evidence: Vec<SearchEvidence>,
    pub relations: Vec<SearchRelation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchResult {
    pub query: String,
    pub results: Vec<SearchHit>,
    pub note: String,
}

/// Confirmed-only knowledge recall: trigram FTS5 (BM25), expanded with each
/// hit's evidence anchors and 1-hop relations. Only confirmed points have
/// chunks, so the status filter is implicit.
pub fn knowledge_search_at(
    base: &Path,
    query: &str,
    limit: usize,
) -> Result<KnowledgeSearchResult, String> {
    let connection = open_db(base)?;
    let query = query.trim();
    if query.is_empty() {
        return Err("knowledge search query is empty".to_string());
    }
    let recall = limit.saturating_mul(4).max(4);
    let mut hits = match fts_match_query(query) {
        Some(match_query) => search_fts(&connection, &match_query, recall)?,
        None => Vec::new(),
    };
    if hits.is_empty() {
        hits = search_like(&connection, query, recall)?;
    }
    let mut seen = std::collections::BTreeSet::new();
    hits.retain(|(kp_id, _)| seen.insert(kp_id.clone()));
    hits.truncate(limit.max(1));
    let mut results = Vec::new();
    for (kp_id, snippet) in hits {
        if let Some(hit) = load_hit(&connection, &kp_id, snippet)? {
            results.push(hit);
        }
    }
    Ok(KnowledgeSearchResult {
        query: query.to_string(),
        results,
        note: "Confirmed knowledge from the project knowledge base. Cite evidence as \
               [paperId p.PAGE]; expand the supporting quote when answering."
            .to_string(),
    })
}

/// Build an FTS5 MATCH expression. The trigram tokenizer needs ≥3-character
/// terms, so terms shorter than that (including 1–2 char CJK queries) are
/// dropped; when nothing qualifies we return `None` and the caller falls back
/// to a LIKE scan.
fn fts_match_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .filter(|term| term.chars().count() >= 3)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}

fn search_fts(
    connection: &Connection,
    match_query: &str,
    limit: usize,
) -> Result<Vec<(String, String)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT kp_id, snippet(retrieval_fts, 2, '[', ']', '…', 16)
             FROM retrieval_fts WHERE retrieval_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![match_query, limit], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn search_like(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<(String, String)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT kp_id, substr(text, 1, 200) FROM retrieval_chunks
             WHERE text LIKE ?1 ORDER BY rowid DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![format!("%{query}%"), limit], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn load_hit(
    connection: &Connection,
    kp_id: &str,
    snippet: String,
) -> Result<Option<SearchHit>, String> {
    let point = connection
        .query_row(
            "SELECT question, answer, statement, kind, source_paper_id
             FROM knowledge_points WHERE id=?1",
            [kp_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((question, answer, statement, kind, source_paper_id)) = point else {
        return Ok(None);
    };
    let evidence = {
        let mut prepared = connection
            .prepare(
                "SELECT paper_id, page, quote, role, annotation_id, evidence_id
                 FROM kp_evidence WHERE kp_id=?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = prepared
            .query_map([kp_id], |row| {
                Ok(SearchEvidence {
                    paper_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    page: row.get(1)?,
                    quote: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    role: row.get(3)?,
                    annotation_id: row.get(4)?,
                    evidence_id: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect::<Vec<_>>()
    };
    let relations = {
        let mut prepared = connection
            .prepare(
                "SELECT r.dst_id, r.kind, p.statement
                 FROM kp_relations r LEFT JOIN knowledge_points p ON p.id = r.dst_id
                 WHERE r.src_id=?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = prepared
            .query_map([kp_id], |row| {
                Ok(SearchRelation {
                    dst_id: row.get(0)?,
                    kind: row.get(1)?,
                    statement: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect::<Vec<_>>()
    };
    Ok(Some(SearchHit {
        id: kp_id.to_string(),
        question,
        answer,
        statement,
        kind,
        source_paper_id,
        snippet,
        evidence,
        relations,
    }))
}

/// Load all knowledge points (with their evidence) as JSON — used by the
/// desktop review UI so both draft cards and the confirmed list can render
/// page-anchored evidence after a reload.
pub fn knowledge_load_at(base: &Path) -> Result<Value, String> {
    let connection = open_db(base)?;
    let mut prepared = connection
        .prepare(
            "SELECT id, question, answer, statement, kind, status, source_paper_id,
                    created_at, confirmed_at, version
             FROM knowledge_points ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = prepared
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                json!({
                    "id": row.get::<_, String>(0)?,
                    "question": row.get::<_, String>(1)?,
                    "answer": row.get::<_, String>(2)?,
                    "statement": row.get::<_, String>(3)?,
                    "kind": row.get::<_, Option<String>>(4)?,
                    "status": row.get::<_, String>(5)?,
                    "sourcePaperId": row.get::<_, Option<String>>(6)?,
                    "createdAt": row.get::<_, Option<String>>(7)?,
                    "confirmedAt": row.get::<_, Option<String>>(8)?,
                    "version": row.get::<_, i64>(9)?,
                }),
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut points: Vec<Value> = Vec::new();
    for row in rows {
        let (id, mut point) = row.map_err(|e| e.to_string())?;
        point["evidence"] = json!(load_evidence(&connection, &id)?);
        points.push(point);
    }
    Ok(json!({ "points": points }))
}

fn load_evidence(connection: &Connection, kp_id: &str) -> Result<Vec<Value>, String> {
    let mut prepared = connection
        .prepare(
            "SELECT paper_id, page, quote, role, annotation_id, evidence_id
             FROM kp_evidence WHERE kp_id=?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = prepared
        .query_map([kp_id], |row| {
            Ok(json!({
                "paperId": row.get::<_, Option<String>>(0)?,
                "page": row.get::<_, Option<i64>>(1)?,
                "quote": row.get::<_, Option<String>>(2)?,
                "role": row.get::<_, Option<String>>(3)?,
                "annotationId": row.get::<_, Option<String>>(4)?,
                "evidenceId": row.get::<_, Option<String>>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

// ── Helpers ───────────────────────────────────────────────────────────────--

fn derive_point_id(point: &KnowledgePointInput) -> String {
    let basis = format!(
        "{}|{}|{}",
        point.source_paper_id.as_deref().unwrap_or(""),
        normalize(&point.question),
        normalize(&point.statement)
    );
    format!("kp-{}", stable_hash(&basis))
}

fn normalize(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn stable_hash(value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let of_day = secs % 86_400;
    format!(
        "{}T{:02}:{:02}:{:02}.000Z",
        runtime::today_iso(),
        of_day / 3600,
        (of_day % 3600) / 60,
        of_day % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let base = std::env::temp_dir().join(format!("aris-knowledge-{name}-{unique}"));
        std::fs::create_dir_all(&base).expect("create temp base");
        base
    }

    fn point(question: &str, answer: &str, statement: &str) -> KnowledgePointInput {
        KnowledgePointInput {
            id: None,
            question: question.to_string(),
            answer: answer.to_string(),
            statement: statement.to_string(),
            kind: Some("finding".to_string()),
            status: None,
            source_paper_id: Some("arxiv:2602.01491".to_string()),
            project_focus_snapshot: None,
            evidence: vec![EvidenceInput {
                paper_id: "arxiv:2602.01491".to_string(),
                page: Some(4),
                quote: "Throughput improved by 32% under congestion.".to_string(),
                role: Some("answer-support".to_string()),
                annotation_id: Some("ann-1".to_string()),
                evidence_id: Some("ev-1".to_string()),
                content_hash: None,
            }],
            relations: Vec::new(),
        }
    }

    #[test]
    fn upsert_confirm_and_search_round_trip() {
        let base = temp_base("round-trip");
        let mut input = point(
            "How much does the scheme improve throughput?",
            "It improves throughput by 32% under congestion.",
            "The scheme improves throughput by 32% under congestion.",
        );
        let stats = knowledge_upsert_at(&base, &[input.clone_for_test()], false)
            .expect("upsert draft");
        assert_eq!(stats.added, 1);
        let id = derive_point_id(&input);

        // Draft is not retrievable yet.
        let before = knowledge_search_at(&base, "throughput congestion", 5).expect("search");
        assert!(before.results.is_empty());

        knowledge_confirm_at(&base, &id).expect("confirm");
        let after = knowledge_search_at(&base, "throughput congestion", 5).expect("search");
        assert_eq!(after.results.len(), 1);
        let hit = &after.results[0];
        assert_eq!(hit.id, id);
        assert_eq!(hit.evidence.len(), 1);
        assert_eq!(hit.evidence[0].page, Some(4));
        assert_eq!(hit.evidence[0].annotation_id.as_deref(), Some("ann-1"));

        // Idempotent rebuild keeps it searchable.
        input.statement = input.statement.clone();
        let rebuilt = rebuild_chunks_at(&base).expect("rebuild");
        assert_eq!(rebuilt, 1);
        let again = knowledge_search_at(&base, "throughput", 5).expect("search again");
        assert_eq!(again.results.len(), 1);

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn chinese_query_recall_via_trigram_or_like() {
        let base = temp_base("cjk");
        let input = KnowledgePointInput {
            id: Some("kp-cjk".to_string()),
            question: "拥塞控制方案的吞吐量提升多少？".to_string(),
            answer: "在拥塞条件下吞吐量提升了百分之三十二。".to_string(),
            statement: "该方案在拥塞条件下将吞吐量提升约百分之三十二。".to_string(),
            kind: None,
            status: None,
            source_paper_id: Some("arxiv:1".to_string()),
            project_focus_snapshot: None,
            evidence: vec![EvidenceInput {
                paper_id: "arxiv:1".to_string(),
                page: Some(2),
                quote: "吞吐量在拥塞条件下提升。".to_string(),
                role: None,
                annotation_id: None,
                evidence_id: None,
                content_hash: None,
            }],
            relations: Vec::new(),
        };
        knowledge_upsert_at(&base, &[input], false).expect("upsert");
        knowledge_confirm_at(&base, "kp-cjk").expect("confirm");
        let result = knowledge_search_at(&base, "拥塞条件下吞吐量", 5).expect("cjk search");
        assert_eq!(result.results.len(), 1);
        assert_eq!(result.results[0].id, "kp-cjk");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn version_bumps_only_when_content_changes() {
        let base = temp_base("version");
        let mut input = point("Q?", "A.", "Statement one.");
        input.id = Some("kp-v".to_string());
        knowledge_upsert_at(&base, &[input.clone_for_test()], false).expect("v1");

        // Same content → no bump.
        knowledge_upsert_at(&base, &[input.clone_for_test()], false).expect("v1 again");
        assert_eq!(point_version(&base, "kp-v"), 1);

        // Changed statement → bump + history row.
        input.statement = "Statement two.".to_string();
        knowledge_upsert_at(&base, &[input], false).expect("v2");
        assert_eq!(point_version(&base, "kp-v"), 2);
        assert_eq!(version_count(&base, "kp-v"), 2);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn upsert_cannot_confirm_without_authority() {
        let base = temp_base("authority");
        let mut input = point("Q?", "A.", "A confirmed-looking statement.");
        input.id = Some("kp-auth".to_string());
        input.status = Some("confirmed".to_string());

        // LLM path (allow_confirm=false) must downgrade to draft.
        knowledge_upsert_at(&base, &[input.clone_for_test()], false).expect("llm upsert");
        assert_eq!(point_status(&base, "kp-auth"), "draft");
        assert!(knowledge_search_at(&base, "confirmed-looking", 5)
            .expect("search")
            .results
            .is_empty());

        // The user-action path confirms.
        knowledge_confirm_at(&base, "kp-auth").expect("confirm");
        assert_eq!(point_status(&base, "kp-auth"), "confirmed");

        // A later LLM edit that changes content downgrades it for re-review.
        input.statement = "An edited statement.".to_string();
        knowledge_upsert_at(&base, &[input], false).expect("llm edit");
        assert_eq!(point_status(&base, "kp-auth"), "draft");
        let _ = std::fs::remove_dir_all(base);
    }

    // ── test helpers ──
    impl KnowledgePointInput {
        fn clone_for_test(&self) -> KnowledgePointInput {
            KnowledgePointInput {
                id: self.id.clone(),
                question: self.question.clone(),
                answer: self.answer.clone(),
                statement: self.statement.clone(),
                kind: self.kind.clone(),
                status: self.status.clone(),
                source_paper_id: self.source_paper_id.clone(),
                project_focus_snapshot: self.project_focus_snapshot.clone(),
                evidence: self
                    .evidence
                    .iter()
                    .map(|item| EvidenceInput {
                        paper_id: item.paper_id.clone(),
                        page: item.page,
                        quote: item.quote.clone(),
                        role: item.role.clone(),
                        annotation_id: item.annotation_id.clone(),
                        evidence_id: item.evidence_id.clone(),
                        content_hash: item.content_hash.clone(),
                    })
                    .collect(),
                relations: self
                    .relations
                    .iter()
                    .map(|item| RelationInput {
                        dst_id: item.dst_id.clone(),
                        kind: item.kind.clone(),
                    })
                    .collect(),
            }
        }
    }

    fn point_status(base: &Path, id: &str) -> String {
        let connection = open_db(base).expect("open");
        connection
            .query_row(
                "SELECT status FROM knowledge_points WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .expect("status")
    }

    fn point_version(base: &Path, id: &str) -> i64 {
        let connection = open_db(base).expect("open");
        connection
            .query_row(
                "SELECT version FROM knowledge_points WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .expect("version")
    }

    fn version_count(base: &Path, id: &str) -> i64 {
        let connection = open_db(base).expect("open");
        connection
            .query_row(
                "SELECT COUNT(*) FROM kp_versions WHERE kp_id=?1",
                [id],
                |row| row.get(0),
            )
            .expect("count")
    }
}
