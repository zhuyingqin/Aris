//! Auditable v2 research-memory control plane.
//!
//! The v1 [`super::research_memory`] store is deliberately left intact as a
//! read-only legacy projection.  V2 never treats that projection as a source:
//! its only authority is a span in a durable local Session.  This module keeps
//! the small, local control plane (outbox, screening decisions, provenance and
//! user confirmation) available when an optional semantic backend is offline.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Schema and policy version emitted in audit records and displayed by clients.
pub const RESEARCH_MEMORY_V2_VERSION: &str = "research_memory_v2";
const OUTBOX_MAX_ATTEMPTS: i64 = 10;
const R3_KINDS: &[&str] = &["user_preference", "constraint"];

/// The closed taxonomy for R1.
///
/// R1 previously accepted any snake_case `kind`, which produced 63 distinct
/// kinds across 93 atoms -- 59 of them used exactly once. A category invented
/// per row is not a category: nothing can be grouped by it, so R2 and R3 had
/// nothing to aggregate *from* and stayed empty and meaningless.
///
/// Three types, chosen so the layers above have something to consolidate:
/// `decision` and `finding` describe project state and roll up into R2
/// scenarios; `constraint` describes how the user wants work done and rolls up
/// into the R3 profile.
///
/// There is deliberately no "current task" type. What is being worked on right
/// now is in the conversation already; recording it buys something that was
/// free, and it was 47 of the first 93 atoms.
const L1_KINDS: &[&str] = &["decision", "finding", "constraint"];

/// A statement shorter than this cannot name its own subject. This is only the
/// mechanical floor -- the real admission test ("would this still be actionable
/// in a session that cannot see this conversation?") lives in the extraction
/// prompt, because no text heuristic can decide it.
///
/// It is deliberately *not* an "anchor" check for paths/numbers/latin tokens:
/// measured against real data such a rule discarded the most valuable entries
/// in the store, including "论文中心科学问题正式改为知识迁移" and
/// "标签全部 ≤ 2 个词", because they are pure CJK prose.
const MIN_STATEMENT_CHARS: usize = 6;
const MAX_SUBJECT_CHARS: usize = 120;
const MAX_CANDIDATES_PER_CAPTURE: usize = 8;
const MAX_STATEMENT_CHARS: usize = 500;

/// Marker the desktop capture writes for a tool call that returned an error.
/// The prefilter, the extraction prompt, and the tests all key on this one
/// token, so it must not be spelled differently in any of them.
pub const TOOL_TRACE_FAILURE_MARKER: &str = "FAILED";

/// Signals that a span is worth durable memory even when it also reads as an
/// instruction.  Shared by the prefilter and the per-candidate validator so the
/// two gates cannot drift apart.
const DURABLE_SIGNALS: &[&str] = &[
    "记住",
    "长期",
    "项目约束",
    "用户偏好",
    "硬约束",
    "我偏好",
    "我希望",
    "必须",
    "不得",
    "始终",
    "优先",
    "must",
    "must not",
    "preference",
    "long-term",
    "project constraint",
];

/// One-off document operations.  These are the user's editing instructions, not
/// research facts.
const EDITORIAL_SIGNALS: &[&str] = &[
    "保留",
    "删除",
    "删掉",
    "替换",
    "改写",
    "润色",
    "这段",
    "本段",
    "表格",
    "图注",
    "figure",
    "table",
    "rewrite",
    "delete this",
    "keep this",
    "edit this",
    "draft",
    "下一段",
];

/// Assistant filler: acknowledgements and plan narration that restate what the
/// model is about to do.
const PROCESS_SIGNALS: &[&str] = &[
    "我会",
    "我可以",
    "接下来",
    "下一步",
    "已记录",
    "已经记录",
    "收到",
    "好的",
    "i will",
    "i can",
    "next step",
    "recorded",
    "acknowledged",
];

/// Feature state. `LegacyR0Only` is intentionally the safe default: v1's
/// derived R1--R3 rows are inspectable but cannot reach a model prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchMemoryV2Mode {
    LegacyR0Only,
    Observe,
    Canary,
    Active,
}

impl Default for ResearchMemoryV2Mode {
    fn default() -> Self {
        Self::LegacyR0Only
    }
}

impl ResearchMemoryV2Mode {
    #[must_use]
    pub fn allows_prompt(self) -> bool {
        matches!(self, Self::Canary | Self::Active)
    }

    #[must_use]
    pub fn runs_pipeline(self) -> bool {
        !matches!(self, Self::LegacyR0Only)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchMemoryV2Layer {
    R1,
    R2,
    R3,
}

impl ResearchMemoryV2Layer {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::R1 => "r1",
            Self::R2 => "r2",
            Self::R3 => "r3",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "r1" => Some(Self::R1),
            "r2" => Some(Self::R2),
            "r3" => Some(Self::R3),
            _ => None,
        }
    }
}

/// A durable final turn stored locally before any model or network call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResearchMemoryV2Capture {
    pub project_id: String,
    pub session_id: String,
    pub source_message_index: i64,
    pub source_event_ids: Vec<String>,
    pub user_text: String,
    pub assistant_text: String,
    /// Bounded rendering of the turn's tool activity: which tools ran, whether
    /// they failed, and what they said.
    ///
    /// Without it the pipeline sees only "the user asked X" and "the assistant
    /// says it did X", so the only extractable statement is a restatement of the
    /// task. The reusable knowledge in a turn -- a tool failing, and the route
    /// taken instead -- lives here and nowhere else.
    #[serde(default)]
    pub tool_trace: String,
    pub occurred_at: String,
}

/// Item leased by the desktop worker.  A failed model call is deliberately
/// represented as an unfinished item rather than an empty successful capture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryV2OutboxItem {
    pub id: String,
    pub capture: ResearchMemoryV2Capture,
    pub attempts: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResearchMemoryV2Prefilter {
    Eligible,
    Rejected { reason: String },
}

/// Strict LLM extraction input.  `source_quote` must be an exact substring of
/// the indicated source text; summaries without a source quote are rejected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResearchMemoryV2Extraction {
    pub source: String,
    pub source_quote: String,
    pub statement: String,
    pub kind: String,
    /// What the memory is *about*, and therefore its identity.
    ///
    /// Without it the same fact recorded in four turns became four atoms under
    /// four invented kinds, and a decision that was later revised sat beside its
    /// own replacement with nothing marking which one still holds.
    /// `(project, layer, kind, subject)` is the supersession key.
    pub subject: String,
    pub target_layer: ResearchMemoryV2Layer,
    pub scope: String,
    pub ttl_days: Option<i64>,
    pub reason: String,
}

/// A memory written at the moment it is established, rather than reconstructed
/// from a transcript afterwards.
///
/// `evidence` is whatever the author can point at -- a tool-trace line, a user
/// sentence -- and is stored as the atom's `source_quote`. It is not validated
/// against a source span, because unlike the screening path there is no fresh
/// model here that could have invented it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryV2InlineWrite {
    pub project_id: String,
    pub session_id: String,
    pub message_index: i64,
    pub source_event_ids: Vec<String>,
    pub layer: ResearchMemoryV2Layer,
    pub kind: String,
    pub subject: String,
    pub statement: String,
    pub scope: String,
    pub ttl_days: Option<i64>,
    pub evidence: String,
    /// Short label for the audit trail, e.g. `tool_episode` or `agent_tool`.
    pub origin: String,
}

/// The second, independent Reviewer pass.  R3 is not an acceptance verdict:
/// it becomes `pending_user_confirmation` until a human explicitly approves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResearchMemoryV2Promotion {
    pub accept: bool,
    pub target_layer: ResearchMemoryV2Layer,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryV2Atom {
    pub id: String,
    pub candidate_id: String,
    pub project_id: String,
    pub session_id: String,
    pub layer: ResearchMemoryV2Layer,
    pub kind: String,
    pub statement: String,
    pub scope: String,
    pub status: String,
    pub source_event_ids: Vec<String>,
    pub source_quote: String,
    pub source_start: usize,
    pub source_end: usize,
    pub expires_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchMemoryV2Stats {
    pub pending_outbox: u64,
    pub deferred_outbox: u64,
    pub rejected_candidates: u64,
    pub r1_active: u64,
    pub r2_active: u64,
    pub r3_pending_confirmation: u64,
    pub r3_confirmed: u64,
}

#[derive(Debug, Clone)]
pub struct ResearchMemoryV2Store {
    path: PathBuf,
}

impl Default for ResearchMemoryV2Store {
    fn default() -> Self {
        Self::new(research_memory_v2_db_path())
    }
}

impl ResearchMemoryV2Store {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Lists the durable v2 atoms that belong in the Settings library. Active
    /// R1/R2/R3 rows are visible, as are R3 proposals awaiting the user's
    /// confirmation; rejected and remote-pending rows stay out of the library.
    pub fn library_atoms(
        &self,
        project_id: &str,
        limit_per_layer: usize,
    ) -> Result<Vec<ResearchMemoryV2Atom>, String> {
        if project_id.trim().is_empty() {
            return Err("project_id is required".to_string());
        }
        let connection = self.open()?;
        let limit = i64::try_from(limit_per_layer.clamp(1, 1_000)).unwrap_or(1_000);
        let mut statement = connection
            .prepare(
                "WITH ranked AS (
                   SELECT id, candidate_id, project_id, session_id, layer, kind, statement, scope,
                          status, source_event_ids, source_quote, source_start, source_end,
                          expires_at, created_at, updated_at,
                          ROW_NUMBER() OVER (
                     PARTITION BY layer ORDER BY updated_at DESC, id
                   ) AS layer_rank
                   FROM memory_v2_atoms a
                   WHERE project_id=?1
                     AND (status='active' OR (layer='r3' AND status='pending_user_confirmation'))
                     AND (expires_at IS NULL OR expires_at > ?2)
                 )
                 SELECT id, candidate_id, project_id, session_id, layer, kind, statement, scope,
                        status, source_event_ids, source_quote, source_start, source_end,
                        expires_at, created_at
                 FROM ranked WHERE layer_rank <= ?3
                 ORDER BY CASE layer WHEN 'r1' THEN 1 WHEN 'r2' THEN 2 ELSE 3 END,
                          layer_rank",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![project_id, now_iso8601(), limit], atom_from_row)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn enqueue_capture(&self, capture: &ResearchMemoryV2Capture) -> Result<bool, String> {
        validate_capture(capture)?;
        let connection = self.open()?;
        let id = capture_id(capture);
        let inserted = connection
            .execute(
                "INSERT OR IGNORE INTO memory_v2_outbox(
                   id, project_id, session_id, source_message_index, source_event_ids,
                   user_text, assistant_text, tool_trace, occurred_at, status, attempts,
                   next_attempt_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', 0, 0, ?10, ?10)",
                params![
                    id,
                    capture.project_id,
                    capture.session_id,
                    capture.source_message_index,
                    json_string(&capture.source_event_ids)?,
                    capture.user_text,
                    capture.assistant_text,
                    capture.tool_trace,
                    capture.occurred_at,
                    now_millis(),
                ],
            )
            .map_err(|error| error.to_string())?;
        if inserted == 0 && !capture.tool_trace.trim().is_empty() {
            // The row predates tool capture. Fill in the missing evidence so a
            // later re-screen can reach it, but never overwrite a trace that is
            // already there and never touch the captured text or the status:
            // this adds evidence, it does not revise history.
            connection
                .execute(
                    "UPDATE memory_v2_outbox SET tool_trace=?2, updated_at=?3
                     WHERE id=?1 AND tool_trace=''",
                    params![id, capture.tool_trace, now_millis()],
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(inserted > 0)
    }

    /// Returns due captures without changing them.  Writes are idempotent by
    /// deterministic candidate IDs, so an app crash between a model result and
    /// completion cannot duplicate memory.
    pub fn due_outbox(&self, limit: usize) -> Result<Vec<ResearchMemoryV2OutboxItem>, String> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT id, project_id, session_id, source_message_index, source_event_ids,
                        user_text, assistant_text, occurred_at, attempts, tool_trace
                 FROM memory_v2_outbox
                 WHERE status IN ('pending', 'deferred', 'promoting') AND next_attempt_at <= ?1
                 ORDER BY created_at, id LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![now_millis(), limit.clamp(1, 50)], |row| {
                Ok(ResearchMemoryV2OutboxItem {
                    id: row.get(0)?,
                    capture: ResearchMemoryV2Capture {
                        project_id: row.get(1)?,
                        session_id: row.get(2)?,
                        source_message_index: row.get(3)?,
                        source_event_ids: parse_json_vec(&row.get::<_, String>(4)?),
                        user_text: row.get(5)?,
                        assistant_text: row.get(6)?,
                        tool_trace: row.get(9)?,
                        occurred_at: row.get(7)?,
                    },
                    attempts: row.get(8)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    /// Returns the time until the next persisted attempt.  The desktop worker
    /// uses this rather than relying on a new chat turn to revive a deferred
    /// extraction, so transient model or TencentDB failures remain durable and
    /// never turn into an implicit injection.
    pub fn next_outbox_delay(&self) -> Result<Option<Duration>, String> {
        let connection = self.open()?;
        let next_attempt: Option<i64> = connection
            .query_row(
                "SELECT MIN(next_attempt_at) FROM memory_v2_outbox WHERE status IN ('pending', 'deferred', 'promoting')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        Ok(next_attempt.map(|value| {
            Duration::from_millis(
                u64::try_from(value.saturating_sub(now_millis())).unwrap_or_default(),
            )
        }))
    }

    /// Returns final-turn keys already captured by v2. This is intentionally
    /// independent of the frozen v1 delivery table: historical v1 rows are not
    /// evidence that a v2 capture was screened or reviewed.
    pub fn captured_final_turns(
        &self,
        project_id: &str,
    ) -> Result<Vec<(String, i64, String)>, String> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT session_id, source_message_index, occurred_at FROM memory_v2_outbox
                 WHERE project_id=?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([project_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn reject_prefilter(
        &self,
        item: &ResearchMemoryV2OutboxItem,
        reason: &str,
    ) -> Result<(), String> {
        let connection = self.open()?;
        record_audit(&connection, &item.id, "prefilter_rejected", reason, None)?;
        connection
            .execute(
                "UPDATE memory_v2_outbox SET status='rejected', updated_at=?2 WHERE id=?1",
                params![item.id, now_millis()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Persists only syntactically and provenance-valid LLM extractions.  The
    /// candidate statement is constrained to its quoted source so a model cannot
    /// manufacture a remembered fact.
    pub fn record_extractions(
        &self,
        item: &ResearchMemoryV2OutboxItem,
        extractions: &[ResearchMemoryV2Extraction],
        model_label: &str,
    ) -> Result<Vec<String>, String> {
        let connection = self.open()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        let mut ids = Vec::new();
        // A capture usually yields several candidates.  Failing the whole batch
        // on the first invalid one threw away its valid siblings and deferred the
        // capture until `OUTBOX_MAX_ATTEMPTS` burned it, so a single malformed
        // quote could cost every fact in that turn.  Invalid candidates are now
        // dropped individually; the capture only fails when nothing survives.
        let mut rejections: Vec<String> = Vec::new();
        for extraction in extractions.iter().take(MAX_CANDIDATES_PER_CAPTURE) {
            let validated = match validate_extraction(&item.capture, extraction) {
                Ok(validated) => validated,
                Err(error) => {
                    rejections.push(error);
                    continue;
                }
            };
            let id = candidate_id(&item.id, extraction);
            transaction
                .execute(
                    "INSERT OR IGNORE INTO memory_v2_candidates(
                       id, outbox_id, project_id, session_id, source_event_ids, source_kind,
                       source_quote, source_start, source_end, statement, kind, subject,
                       target_layer, scope, ttl_days, status, extraction_model, reason,
                       created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                               ?14, ?15, 'awaiting_promotion', ?16, ?17, ?18, ?18)",
                    params![
                        id,
                        item.id,
                        item.capture.project_id,
                        item.capture.session_id,
                        json_string(&item.capture.source_event_ids)?,
                        validated.source,
                        extraction.source_quote.trim(),
                        i64::try_from(validated.start).unwrap_or(i64::MAX),
                        i64::try_from(validated.end).unwrap_or(i64::MAX),
                        validated.statement,
                        validated.kind,
                        validated.subject,
                        validated.layer.as_str(),
                        validated.scope,
                        validated.ttl_days,
                        model_label,
                        truncate(reason_or_default(&validated.reason), 500),
                        now_millis(),
                    ],
                )
                .map_err(|error| error.to_string())?;
            ids.push(id);
        }
        if ids.is_empty() {
            if let Some(error) = rejections.first() {
                // Nothing survived: keep the retry/defer path so a transient bad
                // generation is re-tried rather than silently dropped.
                return Err(error.clone());
            }
        }
        let audit = if rejections.is_empty() {
            format!("{} valid candidate(s); model={model_label}", ids.len())
        } else {
            format!(
                "{} valid candidate(s), {} dropped ({}); model={model_label}",
                ids.len(),
                rejections.len(),
                rejections.join("; ")
            )
        };
        record_audit(&transaction, &item.id, "llm_extracted", &audit, None)?;
        transaction
            .execute(
                "UPDATE memory_v2_outbox SET status=?2, updated_at=?3 WHERE id=?1",
                params![
                    item.id,
                    if ids.is_empty() {
                        "rejected"
                    } else {
                        "promoting"
                    },
                    now_millis(),
                ],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(ids)
    }

    pub fn candidate(&self, candidate_id: &str) -> Result<Option<ResearchMemoryV2Atom>, String> {
        let connection = self.open()?;
        load_candidate_as_atom(&connection, candidate_id)
    }

    /// Resolves a locally-audited atom by stable id.  Remote semantic search
    /// returns only these ids; prompt text is always read back from the local
    /// provenance store rather than trusted from a remote result row.
    pub fn atom(&self, atom_id: &str) -> Result<Option<ResearchMemoryV2Atom>, String> {
        let connection = self.open()?;
        connection
            .query_row(
                "SELECT id, candidate_id, project_id, session_id, layer, kind, statement, scope,
                        status, source_event_ids, source_quote, source_start, source_end,
                        expires_at, created_at FROM memory_v2_atoms WHERE id=?1",
                [atom_id],
                atom_from_row,
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    /// Applies the independent promotion judgement.  A caller cannot use this
    /// API to sneak an arbitrary layer into the store: the promoter must agree
    /// with the extractor, R1 needs a TTL, R2 needs exact provenance, and R3
    /// remains pending for a human confirmation.
    pub fn apply_promotion(
        &self,
        candidate_id: &str,
        promotion: &ResearchMemoryV2Promotion,
        reviewer_label: &str,
    ) -> Result<Option<ResearchMemoryV2Atom>, String> {
        self.apply_promotion_inner(candidate_id, promotion, reviewer_label, false)
    }

    /// Stages an accepted R2 atom until an optional remote semantic backend has
    /// durably accepted it.  This is intentionally not a best-effort mirror:
    /// when the user enabled TencentDB, a remote failure must not leak an
    /// unindexed atom into local prompt recall.
    pub fn stage_promotion_for_remote(
        &self,
        candidate_id: &str,
        promotion: &ResearchMemoryV2Promotion,
        reviewer_label: &str,
    ) -> Result<Option<ResearchMemoryV2Atom>, String> {
        self.apply_promotion_inner(candidate_id, promotion, reviewer_label, true)
    }

    fn apply_promotion_inner(
        &self,
        candidate_id: &str,
        promotion: &ResearchMemoryV2Promotion,
        reviewer_label: &str,
        remote_required: bool,
    ) -> Result<Option<ResearchMemoryV2Atom>, String> {
        let connection = self.open()?;
        let candidate = load_candidate_row(&connection, candidate_id)?;
        let Some(candidate) = candidate else {
            return Ok(None);
        };
        if candidate.status != "awaiting_promotion" {
            let atom = load_atom_by_candidate(&connection, candidate_id)?;
            if atom
                .as_ref()
                .is_none_or(|value| value.status != "remote_pending")
            {
                finish_outbox_if_ready(&connection, &candidate.outbox_id)?;
            }
            return Ok(atom);
        }
        if !promotion.accept || promotion.target_layer != candidate.layer {
            connection
                .execute(
                    "UPDATE memory_v2_candidates SET status='rejected', reviewer_model=?2,
                     reviewer_reason=?3, updated_at=?4 WHERE id=?1",
                    params![
                        candidate_id,
                        reviewer_label,
                        truncate(&promotion.reason, 500),
                        now_millis()
                    ],
                )
                .map_err(|error| error.to_string())?;
            record_audit(
                &connection,
                &candidate.outbox_id,
                "promotion_rejected",
                &promotion.reason,
                Some(candidate_id),
            )?;
            finish_outbox_if_ready(&connection, &candidate.outbox_id)?;
            return Ok(None);
        }
        if candidate.layer == ResearchMemoryV2Layer::R1 && candidate.ttl_days.is_none() {
            return Err("R1 task memory must carry a finite ttl_days".to_string());
        }
        if candidate.layer == ResearchMemoryV2Layer::R3
            && !R3_KINDS.contains(&candidate.kind.as_str())
        {
            return Err("R3 only accepts user_preference or constraint candidates".to_string());
        }
        let status = if candidate.layer == ResearchMemoryV2Layer::R3 {
            "pending_user_confirmation"
        } else if remote_required && candidate.layer == ResearchMemoryV2Layer::R2 {
            "remote_pending"
        } else {
            "active"
        };
        let atom_id = atom_id(candidate_id);
        let expires_at = candidate.ttl_days.map(|days| iso_after_days(days));
        connection
            .execute(
                "INSERT OR IGNORE INTO memory_v2_atoms(
                   id, candidate_id, project_id, session_id, layer, kind, subject, statement,
                   scope, status, source_event_ids, source_quote, source_start, source_end,
                   expires_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?16, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                           ?14, ?15, ?15)",
                params![
                    atom_id,
                    candidate_id,
                    candidate.project_id,
                    candidate.session_id,
                    candidate.layer.as_str(),
                    candidate.kind,
                    candidate.statement,
                    candidate.scope,
                    status,
                    candidate.source_event_ids,
                    candidate.source_quote,
                    i64::try_from(candidate.source_start).unwrap_or(i64::MAX),
                    i64::try_from(candidate.source_end).unwrap_or(i64::MAX),
                    expires_at,
                    now_iso8601(),
                    candidate.subject,
                ],
            )
            .map_err(|error| error.to_string())?;
        supersede_same_subject(
            &connection,
            &candidate.project_id,
            candidate.layer.as_str(),
            &candidate.kind,
            &candidate.subject,
            &atom_id,
        )?;
        connection
            .execute(
                "UPDATE memory_v2_candidates SET status=?2, reviewer_model=?3,
                 reviewer_reason=?4, updated_at=?5 WHERE id=?1",
                params![
                    candidate_id,
                    status,
                    reviewer_label,
                    truncate(&promotion.reason, 500),
                    now_millis()
                ],
            )
            .map_err(|error| error.to_string())?;
        record_audit(
            &connection,
            &candidate.outbox_id,
            "promotion_accepted",
            &promotion.reason,
            Some(candidate_id),
        )?;
        if status != "remote_pending" {
            finish_outbox_if_ready(&connection, &candidate.outbox_id)?;
        }
        load_atom_by_candidate(&connection, candidate_id)
    }

    /// Makes an R2 atom visible only after TencentDB has acknowledged its
    /// semantic projection.  R3 is local and confirmation-gated, so this API
    /// deliberately refuses every other layer.
    pub fn activate_remote_r2(&self, atom_id: &str) -> Result<bool, String> {
        let connection = self.open()?;
        let outbox_id = connection
            .query_row(
                "SELECT c.outbox_id FROM memory_v2_atoms a
                 JOIN memory_v2_candidates c ON c.id=a.candidate_id
                 WHERE a.id=?1 AND a.layer='r2' AND a.status='remote_pending'",
                [atom_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(outbox_id) = outbox_id else {
            return Ok(false);
        };
        connection
            .execute(
                "UPDATE memory_v2_atoms SET status='active', updated_at=?2 WHERE id=?1",
                params![atom_id, now_iso8601()],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "UPDATE memory_v2_candidates SET status='active', updated_at=?2
                 WHERE id=(SELECT candidate_id FROM memory_v2_atoms WHERE id=?1)",
                params![atom_id, now_millis()],
            )
            .map_err(|error| error.to_string())?;
        record_audit(
            &connection,
            &outbox_id,
            "remote_sync_accepted",
            "TencentDB semantic projection acknowledged",
            Some(atom_id),
        )?;
        finish_outbox_if_ready(&connection, &outbox_id)?;
        Ok(true)
    }

    /// Persists the remote failure state without exposing the atom.  The caller
    /// also schedules the outbox retry, so a recovered backend can activate the
    /// exact same atom instead of extracting a new fact.
    pub fn keep_remote_r2_pending(&self, atom_id: &str, reason: &str) -> Result<(), String> {
        let connection = self.open()?;
        connection
            .execute(
                "UPDATE memory_v2_atoms SET status='remote_pending', updated_at=?2 WHERE id=?1 AND layer='r2'",
                params![atom_id, now_iso8601()],
            )
            .map_err(|error| error.to_string())?;
        let outbox_id = connection
            .query_row(
                "SELECT c.outbox_id FROM memory_v2_atoms a JOIN memory_v2_candidates c ON c.id=a.candidate_id WHERE a.id=?1",
                [atom_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(outbox_id) = outbox_id {
            record_audit(
                &connection,
                &outbox_id,
                "remote_sync_deferred",
                reason,
                None,
            )?;
        }
        Ok(())
    }

    /// The only operation that makes an R3 rule eligible for prompt injection.
    pub fn confirm_r3(
        &self,
        project_id: &str,
        atom_id: &str,
        confirmed_by: &str,
    ) -> Result<bool, String> {
        if project_id.trim().is_empty() || confirmed_by.trim().is_empty() {
            return Err("project_id and confirmed_by are required".to_string());
        }
        let connection = self.open()?;
        let changed = connection
            .execute(
                "UPDATE memory_v2_atoms SET status='active', confirmed_by=?3, confirmed_at=?4,
                 updated_at=?4 WHERE id=?1 AND project_id=?2 AND layer='r3'
                   AND status='pending_user_confirmation'",
                params![atom_id, project_id, confirmed_by, now_iso8601()],
            )
            .map_err(|error| error.to_string())?;
        if changed > 0 {
            if let Some(outbox_id) = connection
                .query_row(
                    "SELECT c.outbox_id FROM memory_v2_atoms a
                     JOIN memory_v2_candidates c ON c.id=a.candidate_id WHERE a.id=?1",
                    [atom_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| error.to_string())?
            {
                record_audit(
                    &connection,
                    &outbox_id,
                    "r3_user_confirmed",
                    confirmed_by,
                    Some(atom_id),
                )?;
            }
        }
        Ok(changed > 0)
    }

    /// Writes a memory the moment it is established, from the agent that
    /// observed it, with no screening round-trip.
    ///
    /// The screening pipeline exists because a *fresh* model reconstructing a
    /// memory from a stripped transcript can hallucinate, so a second opinion
    /// was required before an atom could reach a prompt. An inline write does
    /// not have that failure mode: the author watched the event, the user was
    /// present, and the evidence is attached. Re-deriving the same knowledge
    /// later costs thousands of tokens and is lossy, which is why the pipeline
    /// kept producing restatements of the task instead of lessons.
    ///
    /// R3 keeps its user-confirmation gate: a standing rule about how the user
    /// wants to work is still only theirs to grant.
    pub fn record_inline(
        &self,
        write: &ResearchMemoryV2InlineWrite,
    ) -> Result<Option<ResearchMemoryV2Atom>, String> {
        let validated = validate_inline(write)?;
        let connection = self.open()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        // Provenance is uniform with the screened path -- outbox, candidate,
        // atom -- so Settings can drill down to the source either way. The
        // difference is recorded in the audit trail, not in the shape.
        let outbox_id = stable_id(&format!(
            "inline\0{}\0{}\0{}",
            write.project_id, write.session_id, write.message_index
        ));
        transaction
            .execute(
                "INSERT OR IGNORE INTO memory_v2_outbox(
                   id, project_id, session_id, source_message_index, source_event_ids,
                   user_text, assistant_text, tool_trace, occurred_at, status, attempts,
                   next_attempt_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, '', '', ?6, ?7, 'completed', 0, 0, ?8, ?8)",
                params![
                    outbox_id,
                    write.project_id,
                    write.session_id,
                    write.message_index,
                    json_string(&write.source_event_ids)?,
                    validated.evidence,
                    now_iso8601(),
                    now_millis(),
                ],
            )
            .map_err(|error| error.to_string())?;
        // Deduplicated on the statement rather than the turn: the same lesson
        // learned twice is one memory, not two. A repeat refreshes the row so
        // recency ordering still reflects that it came up again.
        let candidate_id = stable_id(&format!(
            "inline-candidate\0{}\0{}\0{}",
            write.project_id,
            validated.layer.as_str(),
            normalise_for_grounding(&validated.statement)
        ));
        transaction
            .execute(
                "INSERT OR IGNORE INTO memory_v2_candidates(
                   id, outbox_id, project_id, session_id, source_event_ids, source_kind,
                   source_quote, source_start, source_end, statement, kind, subject,
                   target_layer, scope, ttl_days, status, extraction_model, reviewer_model,
                   reviewer_reason, reason, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?16, ?11, ?12, ?13,
                           'awaiting_promotion', 'inline-author', 'inline-author',
                           'authored in context by the agent that observed it', ?14, ?15, ?15)",
                params![
                    candidate_id,
                    outbox_id,
                    write.project_id,
                    write.session_id,
                    json_string(&write.source_event_ids)?,
                    validated.source_kind,
                    validated.evidence,
                    i64::try_from(validated.evidence.len()).unwrap_or(i64::MAX),
                    validated.statement,
                    validated.kind,
                    validated.layer.as_str(),
                    validated.scope,
                    validated.ttl_days,
                    validated.origin,
                    now_millis(),
                    validated.subject,
                ],
            )
            .map_err(|error| error.to_string())?;
        let status = if validated.layer == ResearchMemoryV2Layer::R3 {
            "pending_user_confirmation"
        } else {
            "active"
        };
        let atom_id = atom_id(&candidate_id);
        transaction
            .execute(
                "INSERT OR IGNORE INTO memory_v2_atoms(
                   id, candidate_id, project_id, session_id, layer, kind, subject, statement,
                   scope, status, source_event_ids, source_quote, source_start, source_end,
                   expires_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?15, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13,
                           ?14, ?14)",
                params![
                    atom_id,
                    candidate_id,
                    write.project_id,
                    write.session_id,
                    validated.layer.as_str(),
                    validated.kind,
                    validated.statement,
                    validated.scope,
                    status,
                    json_string(&write.source_event_ids)?,
                    validated.evidence,
                    i64::try_from(validated.evidence.len()).unwrap_or(i64::MAX),
                    validated.ttl_days.map(iso_after_days),
                    now_iso8601(),
                    validated.subject,
                ],
            )
            .map_err(|error| error.to_string())?;
        supersede_same_subject(
            &transaction,
            &write.project_id,
            validated.layer.as_str(),
            &validated.kind,
            &validated.subject,
            &atom_id,
        )?;
        transaction
            .execute(
                "UPDATE memory_v2_candidates SET status=?2, updated_at=?3 WHERE id=?1",
                params![candidate_id, status, now_millis()],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE memory_v2_atoms SET updated_at=?2 WHERE id=?1",
                params![atom_id, now_iso8601()],
            )
            .map_err(|error| error.to_string())?;
        record_audit(
            &transaction,
            &outbox_id,
            "authored_inline",
            &validated.origin,
            Some(&candidate_id),
        )?;
        transaction.commit().map_err(|error| error.to_string())?;
        load_atom_by_candidate(&connection, &candidate_id)
    }

    /// Re-opens captures that an earlier screening policy rejected, so a
    /// corrected prefilter or reviewer reaches the history the user already has
    /// instead of only future turns.
    ///
    /// Only terminal *rejections* are re-opened; promoted atoms and their
    /// captures are untouched.  Rejected candidates of those captures are reset
    /// to `awaiting_promotion` as well, because candidate IDs are deterministic:
    /// without the reset a re-extraction would produce the same ID, be ignored
    /// by `INSERT OR IGNORE`, and keep the stale verdict forever.
    pub fn rescreen_rejected(&self, project_id: &str) -> Result<usize, String> {
        if project_id.trim().is_empty() {
            return Err("project_id is required".to_string());
        }
        let connection = self.open()?;
        let candidates = {
            let mut statement = connection
                .prepare(
                    // A capture whose every candidate was refused by the reviewer
                    // is marked `completed`, not `rejected`, so selecting on the
                    // outbox status alone would miss exactly the rows a corrected
                    // reviewer needs to see again.
                    "SELECT o.id, o.user_text, o.assistant_text FROM memory_v2_outbox o
                     WHERE o.project_id=?1
                       AND (o.status IN ('rejected', 'dead_letter')
                            OR EXISTS (SELECT 1 FROM memory_v2_candidates c
                                       WHERE c.outbox_id=o.id AND c.status='rejected'))",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([project_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        };
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        let mut requeued = 0;
        for (id, user_text, assistant_text) in candidates {
            // Skip whatever the *current* policy would still reject locally, so
            // a re-screen never spends a model call to reach the same verdict.
            if matches!(
                screen_texts(&user_text, &assistant_text),
                ResearchMemoryV2Prefilter::Rejected { .. }
            ) {
                continue;
            }
            transaction
                .execute(
                    "UPDATE memory_v2_candidates SET status='awaiting_promotion', reviewer_model=NULL,
                     reviewer_reason=NULL, updated_at=?2 WHERE outbox_id=?1 AND status='rejected'",
                    params![id, now_millis()],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE memory_v2_outbox SET status='pending', attempts=0, next_attempt_at=0,
                     last_error=NULL, updated_at=?2 WHERE id=?1",
                    params![id, now_millis()],
                )
                .map_err(|error| error.to_string())?;
            record_audit(&transaction, &id, "rescreen_requeued", "policy update", None)?;
            requeued += 1;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(requeued)
    }

    pub fn defer_outbox(
        &self,
        item: &ResearchMemoryV2OutboxItem,
        reason: &str,
    ) -> Result<(), String> {
        let connection = self.open()?;
        let attempts = item.attempts.saturating_add(1);
        let status = if attempts >= OUTBOX_MAX_ATTEMPTS {
            "dead_letter"
        } else {
            "deferred"
        };
        let delay_ms = 1_000_i64.saturating_mul(2_i64.saturating_pow(attempts.min(12) as u32));
        connection
            .execute(
                "UPDATE memory_v2_outbox SET status=?2, attempts=?3, last_error=?4,
                 next_attempt_at=?5, updated_at=?6 WHERE id=?1",
                params![
                    item.id,
                    status,
                    attempts,
                    truncate(reason, 500),
                    now_millis().saturating_add(delay_ms.min(3_600_000)),
                    now_millis(),
                ],
            )
            .map_err(|error| error.to_string())?;
        record_audit(&connection, &item.id, "deferred", reason, None)
    }

    /// Local fail-safe retrieval.  Remote vector hits are merged by the
    /// desktop adapter, but when it is unavailable this gives R2 a bounded
    /// lexical recall path without ever consulting legacy v1 atoms.
    pub fn recall_local(
        &self,
        project_id: &str,
        session_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ResearchMemoryV2Atom>, String> {
        let terms = recall_terms(query);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.open()?;
        let now = now_iso8601();
        let mut statement = connection
            .prepare(
                "SELECT id, candidate_id, project_id, session_id, layer, kind, statement, scope,
                        status, source_event_ids, source_quote, source_start, source_end,
                        expires_at, created_at
                 FROM memory_v2_atoms
                 WHERE project_id=?1 AND status='active'
                   AND (expires_at IS NULL OR expires_at > ?2)
                   AND (layer='r2' OR (layer='r1' AND session_id=?3))
                 ORDER BY CASE layer WHEN 'r1' THEN 0 ELSE 1 END, updated_at DESC LIMIT 100",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![project_id, now, session_id], atom_from_row)
            .map_err(|error| error.to_string())?;
        let mut scored = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter_map(|atom| {
                let text = format!("{} {}", atom.statement.to_ascii_lowercase(), atom.kind);
                let score = terms
                    .iter()
                    .filter(|term| text.contains(term.as_str()))
                    .count();
                (score > 0).then_some((score, atom))
            })
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| right.0.cmp(&left.0));
        Ok(scored
            .into_iter()
            .take(limit.clamp(1, 12))
            .map(|(_, atom)| atom)
            .collect())
    }

    pub fn confirmed_r3(
        &self,
        project_id: &str,
        limit: usize,
    ) -> Result<Vec<ResearchMemoryV2Atom>, String> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT id, candidate_id, project_id, session_id, layer, kind, statement, scope,
                        status, source_event_ids, source_quote, source_start, source_end,
                        expires_at, created_at
                 FROM memory_v2_atoms
                 WHERE project_id=?1 AND layer='r3' AND status='active'
                 ORDER BY confirmed_at DESC, updated_at DESC LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let atoms = statement
            .query_map(params![project_id, limit.clamp(1, 16)], atom_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(atoms)
    }

    /// Pending R3 proposals are inspectable but deliberately excluded from
    /// every recall path.  The desktop exposes these records so the human who
    /// owns the preference can make the final confirmation decision.
    pub fn pending_r3(
        &self,
        project_id: &str,
        limit: usize,
    ) -> Result<Vec<ResearchMemoryV2Atom>, String> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT id, candidate_id, project_id, session_id, layer, kind, statement, scope,
                        status, source_event_ids, source_quote, source_start, source_end,
                        expires_at, created_at
                 FROM memory_v2_atoms
                 WHERE project_id=?1 AND layer='r3' AND status='pending_user_confirmation'
                 ORDER BY updated_at DESC LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let atoms = statement
            .query_map(params![project_id, limit.clamp(1, 32)], atom_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(atoms)
    }

    pub fn stats(&self, project_id: &str) -> Result<ResearchMemoryV2Stats, String> {
        let connection = self.open()?;
        let count = |sql: &str| -> Result<u64, String> {
            connection
                .query_row(sql, [project_id], |row| row.get(0))
                .map_err(|error| error.to_string())
        };
        // The library and recall both hide expired rows, so the counters must
        // apply the same TTL filter or Settings reports atoms the user cannot
        // find anywhere. R1 is the only layer that routinely carries a TTL.
        let now = now_iso8601();
        let count_live = |sql: &str| -> Result<u64, String> {
            connection
                .query_row(sql, params![project_id, now], |row| row.get(0))
                .map_err(|error| error.to_string())
        };
        Ok(ResearchMemoryV2Stats {
            pending_outbox: count("SELECT COUNT(*) FROM memory_v2_outbox WHERE project_id=?1 AND status IN ('pending', 'promoting')")?,
            deferred_outbox: count("SELECT COUNT(*) FROM memory_v2_outbox WHERE project_id=?1 AND status IN ('deferred', 'dead_letter')")?,
            rejected_candidates: count("SELECT COUNT(*) FROM memory_v2_candidates WHERE project_id=?1 AND status='rejected'")?,
            r1_active: count_live("SELECT COUNT(*) FROM memory_v2_atoms WHERE project_id=?1 AND layer='r1' AND status='active' AND (expires_at IS NULL OR expires_at > ?2)")?,
            r2_active: count_live("SELECT COUNT(*) FROM memory_v2_atoms WHERE project_id=?1 AND layer='r2' AND status='active' AND (expires_at IS NULL OR expires_at > ?2)")?,
            r3_pending_confirmation: count("SELECT COUNT(*) FROM memory_v2_atoms WHERE project_id=?1 AND layer='r3' AND status='pending_user_confirmation'")?,
            r3_confirmed: count("SELECT COUNT(*) FROM memory_v2_atoms WHERE project_id=?1 AND layer='r3' AND status='active'")?,
        })
    }

    fn open(&self) -> Result<Connection, String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(&self.path).map_err(|error| error.to_string())?;
        // Status, recall, and the background promoter can open the store at the
        // same time. Waiting briefly is preferable to flashing a raw
        // `database is locked` error in Settings for ordinary WAL contention.
        connection
            .busy_timeout(Duration::from_secs(5))
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

/// True when a single side of a turn carries nothing a later layer could quote:
/// it reads as an editing instruction or as assistant narration, and it has no
/// explicit durable-memory signal to redeem it.
fn side_is_ephemeral(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if contains_signal(&lower, DURABLE_SIGNALS) {
        return false;
    }
    contains_signal(&lower, EDITORIAL_SIGNALS) || contains_signal(&lower, PROCESS_SIGNALS)
}

/// Fast, explainable local rejection before a network/model call.  The rule is
/// intentionally conservative: it only rejects editorial/process text when it
/// lacks an explicit durable-memory signal, leaving ambiguous work for Review.
///
/// The judgement is made **per side**.  A turn is only ephemeral when neither
/// side could supply a quotable span: an assistant reply that opens with "我可以"
/// must not discard a user message that stated a durable project constraint,
/// because the extractor is free to quote just the surviving side.
#[must_use]
pub fn prefilter_v2(capture: &ResearchMemoryV2Capture) -> ResearchMemoryV2Prefilter {
    // A tool that failed is the single strongest reason to keep a turn: the
    // reusable knowledge is the failure and the route taken after it. Such a
    // turn is never "ephemeral chatter", whatever its prose looks like.
    if trace_has_failure(&capture.tool_trace) {
        return ResearchMemoryV2Prefilter::Eligible;
    }
    screen_texts(&capture.user_text, &capture.assistant_text)
}

/// Whether a captured trace records at least one failed tool call.
#[must_use]
pub fn trace_has_failure(tool_trace: &str) -> bool {
    tool_trace.contains(TOOL_TRACE_FAILURE_MARKER)
}

/// How much of one tool result reaches memory. Failures get the wider budget:
/// the error text is what a later turn needs in order not to repeat the
/// attempt, while a success only has to establish that the route worked.
const TOOL_TRACE_ERROR_CHARS: usize = 260;
const TOOL_TRACE_OK_CHARS: usize = 70;
const TOOL_TRACE_INPUT_CHARS: usize = 120;
const TOOL_TRACE_MAX_CHARS: usize = 4_000;

/// Renders the tool activity of one turn into bounded, individually quotable
/// lines: `[n] Tool(args) FAILED: message` or `[n] Tool(args) ok: message`.
///
/// This lives beside the prefilter and the validator on purpose -- all three
/// depend on the exact line format, and the extraction prompt documents it.
/// Splitting them across crates is how the format silently drifts.
#[must_use]
pub fn tool_trace_for_turn(messages: &[crate::ConversationMessage]) -> String {
    let mut calls: Vec<(String, String)> = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    for message in messages {
        for block in &message.blocks {
            match block {
                crate::ContentBlock::ToolUse { id, name, input } => calls.push((
                    id.clone(),
                    format!("{name}({})", trace_snippet(input, TOOL_TRACE_INPUT_CHARS)),
                )),
                crate::ContentBlock::ToolResult {
                    tool_use_id,
                    tool_name,
                    output,
                    is_error,
                } => {
                    let call = calls
                        .iter()
                        .find(|(id, _)| id == tool_use_id)
                        .map(|(_, label)| label.clone())
                        .unwrap_or_else(|| tool_name.clone());
                    let (verdict, budget) = if *is_error {
                        (TOOL_TRACE_FAILURE_MARKER, TOOL_TRACE_ERROR_CHARS)
                    } else {
                        ("ok", TOOL_TRACE_OK_CHARS)
                    };
                    lines.push(format!(
                        "[{}] {call} {verdict}: {}",
                        lines.len() + 1,
                        trace_snippet(&tool_output_digest(output), budget)
                    ));
                }
                _ => {}
            }
        }
    }
    let mut trace = String::new();
    for line in lines {
        if trace.chars().count() + line.chars().count() > TOOL_TRACE_MAX_CHARS {
            trace.push_str("[trace truncated]\n");
            break;
        }
        trace.push_str(&line);
        trace.push('\n');
    }
    trace
}

/// Fields, in priority order, that actually carry why a tool call went wrong.
const TOOL_OUTPUT_DIGEST_FIELDS: &[&str] = &[
    "returnCodeInterpretation",
    "stderr",
    "error",
    "message",
    "recoveryHint",
    "stdout",
];

/// Reduces a structured tool result to the part a lesson can be drawn from.
///
/// Several tools return a JSON envelope whose first fields are bookkeeping
/// (`assistantAutoBackgrounded`, `backgroundTaskId`, ...). Truncating that raw
/// text to a budget yields a line of nulls and buries the `stderr` that explains
/// the failure, so the digest lifts the meaningful fields out first.
fn tool_output_digest(output: &str) -> String {
    let trimmed = output.trim();
    if !trimmed.starts_with('{') {
        return trimmed.to_string();
    }
    let Ok(serde_json::Value::Object(envelope)) = serde_json::from_str(trimmed) else {
        return trimmed.to_string();
    };
    let mut parts = Vec::new();
    for field in TOOL_OUTPUT_DIGEST_FIELDS {
        let Some(value) = envelope.get(*field) else {
            continue;
        };
        let text = match value {
            serde_json::Value::String(text) => text.trim().to_string(),
            serde_json::Value::Null => String::new(),
            other => other.to_string(),
        };
        if !text.is_empty() && text != "False" && text != "None" {
            parts.push(format!("{field}={text}"));
        }
    }
    if parts.is_empty() {
        return trimmed.to_string();
    }
    parts.join(" ")
}

/// A tool that failed and the call that worked instead, both inside one turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolEpisode {
    pub tool: String,
    pub statement: String,
    pub evidence: String,
}

/// Derives failure-then-recovery episodes from a turn, with no model call.
///
/// This is the free floor under memory: whatever the agent does or does not
/// choose to write down, a tool that failed and the route that replaced it is
/// recorded. Only *recovered* failures qualify -- a failure with no subsequent
/// success teaches nothing except that something is broken, and a turn full of
/// unrecovered errors would otherwise flood the store.
#[must_use]
pub fn tool_episodes_for_turn(messages: &[crate::ConversationMessage]) -> Vec<ToolEpisode> {
    let mut calls: Vec<(String, String, String)> = Vec::new();
    let mut results: Vec<(String, String, bool, String)> = Vec::new();
    for message in messages {
        for block in &message.blocks {
            match block {
                crate::ContentBlock::ToolUse { id, name, input } => calls.push((
                    id.clone(),
                    name.clone(),
                    trace_snippet(input, TOOL_TRACE_INPUT_CHARS),
                )),
                crate::ContentBlock::ToolResult {
                    tool_use_id,
                    tool_name,
                    output,
                    is_error,
                } => {
                    let args = calls
                        .iter()
                        .find(|(id, _, _)| id == tool_use_id)
                        .map(|(_, _, args)| args.clone())
                        .unwrap_or_default();
                    results.push((
                        tool_name.clone(),
                        args,
                        *is_error,
                        trace_snippet(&tool_output_digest(output), TOOL_TRACE_ERROR_CHARS),
                    ));
                }
                _ => {}
            }
        }
    }
    let mut episodes = Vec::new();
    for (index, (tool, args, is_error, digest)) in results.iter().enumerate() {
        if !is_error {
            continue;
        }
        // The recovery is the next call of the same tool that succeeded. A
        // different tool succeeding says nothing about this failure.
        let Some((_, recovery_args, _, _)) = results[index + 1..]
            .iter()
            .find(|(name, _, failed, _)| name == tool && !failed)
        else {
            continue;
        };
        if recovery_args == args {
            // The identical call succeeding on retry is a flake, not a lesson.
            continue;
        }
        episodes.push(ToolEpisode {
            tool: tool.clone(),
            statement: format!(
                "{tool}({args}) failed: {digest} — {tool}({recovery_args}) succeeded instead"
            ),
            evidence: format!("[{}] {tool}({args}) {TOOL_TRACE_FAILURE_MARKER}: {digest}", index + 1),
        });
    }
    episodes
}

/// Collapses a tool payload onto one line. A newline inside a payload would let
/// a model quote a fragment that spans two unrelated results.
fn trace_snippet(value: &str, budget: usize) -> String {
    let flattened = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= budget {
        return flattened;
    }
    flattened.chars().take(budget).collect::<String>() + "…"
}

/// The screening rule itself, over the two sides of a turn.  `rescreen_rejected`
/// replays it against stored outbox text, so it must not require a full capture.
fn screen_texts(user_text: &str, assistant_text: &str) -> ResearchMemoryV2Prefilter {
    if user_text.chars().count() + assistant_text.chars().count() < 12 {
        return ResearchMemoryV2Prefilter::Rejected {
            reason: "capture is too short to establish durable meaning".to_string(),
        };
    }
    if side_is_ephemeral(user_text) && side_is_ephemeral(assistant_text) {
        return ResearchMemoryV2Prefilter::Rejected {
            reason: "ephemeral editorial instruction or assistant process narration".to_string(),
        };
    }
    ResearchMemoryV2Prefilter::Eligible
}

struct ValidatedExtraction {
    source: String,
    start: usize,
    end: usize,
    statement: String,
    kind: String,
    subject: String,
    layer: ResearchMemoryV2Layer,
    scope: String,
    ttl_days: Option<i64>,
    reason: String,
}

struct ValidatedInline {
    layer: ResearchMemoryV2Layer,
    kind: String,
    subject: String,
    statement: String,
    scope: String,
    ttl_days: Option<i64>,
    evidence: String,
    source_kind: String,
    origin: String,
}

/// Inline writes skip the *screening* gates, not the *shape* gates. Layer
/// invariants -- R1 must expire, R3 must be a preference or a constraint -- are
/// what make the layers mean anything, so they hold on every path.
fn validate_inline(write: &ResearchMemoryV2InlineWrite) -> Result<ValidatedInline, String> {
    if write.project_id.trim().is_empty() || write.session_id.trim().is_empty() {
        return Err("inline memory requires a project and session".to_string());
    }
    if write.source_event_ids.is_empty()
        || write
            .source_event_ids
            .iter()
            .any(|event_id| event_id.trim().is_empty())
    {
        return Err("inline memory requires at least one source event id".to_string());
    }
    let statement = write.statement.trim();
    if statement.chars().count() < MIN_STATEMENT_CHARS
        || statement.chars().count() > MAX_STATEMENT_CHARS
    {
        return Err("inline memory statement is too short or over the character limit".to_string());
    }
    let subject = write.subject.trim();
    if subject.is_empty() || subject.chars().count() > MAX_SUBJECT_CHARS {
        return Err("inline memory requires a bounded subject".to_string());
    }
    let evidence = write.evidence.trim();
    if evidence.is_empty() {
        return Err("inline memory requires evidence to point at".to_string());
    }
    let kind = write.kind.trim().to_ascii_lowercase();
    if kind.is_empty()
        || kind.len() > 80
        || !kind
            .chars()
            .all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit())
    {
        return Err("inline memory kind is invalid".to_string());
    }
    let scope = write.scope.trim().to_ascii_lowercase();
    if !matches!(scope.as_str(), "session" | "milestone" | "project") {
        return Err("inline memory scope must be session, milestone, or project".to_string());
    }
    let ttl_days = write.ttl_days.map(|days| days.clamp(1, 365));
    if write.layer == ResearchMemoryV2Layer::R1 && ttl_days.is_none() {
        return Err("inline R1 memory must carry a finite ttl_days".to_string());
    }
    if write.layer == ResearchMemoryV2Layer::R1 && !L1_KINDS.contains(&kind.as_str()) {
        return Err(format!(
            "inline R1 kind must be one of {}",
            L1_KINDS.join(", ")
        ));
    }
    if write.layer == ResearchMemoryV2Layer::R3 && !R3_KINDS.contains(&kind.as_str()) {
        return Err("inline R3 memory must be a user_preference or constraint".to_string());
    }
    let origin = write.origin.trim();
    if origin.is_empty() {
        return Err("inline memory requires an origin label for the audit trail".to_string());
    }
    Ok(ValidatedInline {
        layer: write.layer,
        kind,
        subject: subject.to_string(),
        statement: statement.to_string(),
        scope,
        ttl_days,
        evidence: truncate(evidence, 2_000),
        source_kind: "inline".to_string(),
        origin: truncate(origin, 120),
    })
}

fn validate_extraction(
    capture: &ResearchMemoryV2Capture,
    extraction: &ResearchMemoryV2Extraction,
) -> Result<ValidatedExtraction, String> {
    let source = extraction.source.trim().to_ascii_lowercase();
    let source_text = match source.as_str() {
        "user" => &capture.user_text,
        "assistant" => &capture.assistant_text,
        "tool" => &capture.tool_trace,
        _ => {
            return Err(
                "memory extraction source must be `user`, `assistant`, or `tool`".to_string(),
            )
        }
    };
    if source == "tool" && source_text.trim().is_empty() {
        return Err("memory extraction cites tool evidence but the turn ran no tools".to_string());
    }
    let quote = extraction.source_quote.trim();
    if quote.is_empty() {
        return Err("memory extraction source_quote cannot be empty".to_string());
    }
    let Some(start) = source_text.find(quote) else {
        return Err("memory extraction source_quote is not an exact source span".to_string());
    };
    // R1 is finite task memory, so a task instruction is its *legitimate* source
    // span.  Applying the editorial/process ban to R1 as well left the layer with
    // no admissible raw material at all, which is why it stayed empty.  R2 and R3
    // claim durability and keep the strict gate.  A tool trace is machine text,
    // never editorial prose, so the ban does not apply to it either.
    if extraction.target_layer != ResearchMemoryV2Layer::R1
        && source != "tool"
        && side_is_ephemeral(quote)
    {
        return Err("memory extraction source span is editorial or process narration".to_string());
    }
    let statement = extraction.statement.trim();
    if statement.is_empty() || statement.chars().count() > MAX_STATEMENT_CHARS {
        return Err("memory extraction statement is empty or over the character limit".to_string());
    }
    // Source-grounding is stronger than a generic JSON schema: a statement may
    // omit punctuation, but it cannot introduce words that did not occur in the
    // source.
    //
    // An operational lesson -- "ran X, hit Y, took route Z" -- is inherently a
    // synthesis across the tool trace and the surrounding prose, so it can never
    // be a sub-span of any single quote.  Anchoring it to a tool span keeps the
    // provenance requirement (the quote must still appear verbatim in the trace)
    // while widening the vocabulary it may draw on to the spans actually
    // captured for this turn.  Nothing outside the turn is ever admissible.
    let grounded = if source == "tool" {
        statement_is_grounded_in_any(
            &[&capture.tool_trace, &capture.assistant_text, &capture.user_text],
            statement,
        )
    } else {
        statement_is_grounded(quote, statement)
    };
    if !grounded {
        return Err("memory extraction statement is not grounded in source_quote".to_string());
    }
    if statement.chars().count() < MIN_STATEMENT_CHARS {
        return Err("memory extraction statement is too short to name its subject".to_string());
    }
    let kind = extraction.kind.trim().to_ascii_lowercase();
    if kind.is_empty()
        || kind.len() > 80
        || !kind
            .chars()
            .all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit())
    {
        return Err("memory extraction kind is invalid".to_string());
    }
    // The taxonomy is enforced here, not just requested in the prompt: a free
    // kind per row is what made R1 ungroupable and left R2/R3 with nothing to
    // aggregate from.
    if extraction.target_layer == ResearchMemoryV2Layer::R1 && !L1_KINDS.contains(&kind.as_str()) {
        return Err(format!(
            "R1 kind must be one of {}; `{kind}` is not a category, it is a label for one row",
            L1_KINDS.join(", ")
        ));
    }
    let subject = extraction.subject.trim();
    if subject.is_empty() || subject.chars().count() > MAX_SUBJECT_CHARS {
        return Err("memory extraction requires a bounded subject".to_string());
    }
    let scope = extraction.scope.trim().to_ascii_lowercase();
    if !matches!(scope.as_str(), "session" | "milestone" | "project") {
        return Err("memory extraction scope must be session, milestone, or project".to_string());
    }
    let ttl_days = extraction.ttl_days.map(|days| days.clamp(1, 365));
    if extraction.target_layer == ResearchMemoryV2Layer::R1 && ttl_days.is_none() {
        return Err("R1 extraction requires ttl_days".to_string());
    }
    if extraction.target_layer == ResearchMemoryV2Layer::R3 && !R3_KINDS.contains(&kind.as_str()) {
        return Err("R3 extraction must be a user_preference or constraint".to_string());
    }
    if extraction.target_layer == ResearchMemoryV2Layer::R3 && source != "user" {
        return Err("R3 extraction must be grounded in an explicit user statement".to_string());
    }
    Ok(ValidatedExtraction {
        source,
        start,
        end: start + quote.len(),
        statement: statement.to_string(),
        kind,
        subject: subject.to_string(),
        layer: extraction.target_layer,
        scope,
        ttl_days,
        reason: extraction.reason.trim().to_string(),
    })
}

#[derive(Debug)]
struct CandidateRow {
    outbox_id: String,
    project_id: String,
    session_id: String,
    source_event_ids: String,
    source_quote: String,
    source_start: usize,
    source_end: usize,
    statement: String,
    kind: String,
    subject: String,
    layer: ResearchMemoryV2Layer,
    scope: String,
    ttl_days: Option<i64>,
    status: String,
}

fn load_candidate_row(
    connection: &Connection,
    candidate_id: &str,
) -> Result<Option<CandidateRow>, String> {
    connection
        .query_row(
            "SELECT id, outbox_id, project_id, session_id, source_event_ids, source_quote,
                    source_start, source_end, statement, kind, target_layer, scope, ttl_days,
                    status, subject
             FROM memory_v2_candidates WHERE id=?1",
            [candidate_id],
            |row| {
                let layer = row.get::<_, String>(10)?;
                Ok(CandidateRow {
                    outbox_id: row.get(1)?,
                    project_id: row.get(2)?,
                    session_id: row.get(3)?,
                    source_event_ids: row.get(4)?,
                    source_quote: row.get(5)?,
                    source_start: usize::try_from(row.get::<_, i64>(6)?).unwrap_or(usize::MAX),
                    source_end: usize::try_from(row.get::<_, i64>(7)?).unwrap_or(usize::MAX),
                    statement: row.get(8)?,
                    kind: row.get(9)?,
                    layer: ResearchMemoryV2Layer::parse(&layer)
                        .ok_or_else(|| rusqlite::Error::InvalidQuery)?,
                    scope: row.get(11)?,
                    ttl_days: row.get(12)?,
                    status: row.get(13)?,
                    subject: row.get(14)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn load_candidate_as_atom(
    connection: &Connection,
    candidate_id: &str,
) -> Result<Option<ResearchMemoryV2Atom>, String> {
    load_atom_by_candidate(connection, candidate_id)
}

fn load_atom_by_candidate(
    connection: &Connection,
    candidate_id: &str,
) -> Result<Option<ResearchMemoryV2Atom>, String> {
    connection
        .query_row(
            "SELECT id, candidate_id, project_id, session_id, layer, kind, statement, scope,
                    status, source_event_ids, source_quote, source_start, source_end,
                    expires_at, created_at FROM memory_v2_atoms WHERE candidate_id=?1",
            [candidate_id],
            atom_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn atom_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResearchMemoryV2Atom> {
    let layer = row.get::<_, String>(4)?;
    Ok(ResearchMemoryV2Atom {
        id: row.get(0)?,
        candidate_id: row.get(1)?,
        project_id: row.get(2)?,
        session_id: row.get(3)?,
        layer: ResearchMemoryV2Layer::parse(&layer).ok_or(rusqlite::Error::InvalidQuery)?,
        kind: row.get(5)?,
        statement: row.get(6)?,
        scope: row.get(7)?,
        status: row.get(8)?,
        source_event_ids: parse_json_vec(&row.get::<_, String>(9)?),
        source_quote: row.get(10)?,
        source_start: usize::try_from(row.get::<_, i64>(11)?).unwrap_or(usize::MAX),
        source_end: usize::try_from(row.get::<_, i64>(12)?).unwrap_or(usize::MAX),
        expires_at: row.get(13)?,
        created_at: row.get(14)?,
    })
}

fn finish_outbox_if_ready(connection: &Connection, outbox_id: &str) -> Result<(), String> {
    let outstanding = connection
        .query_row(
            "SELECT COUNT(*) FROM memory_v2_candidates
             WHERE outbox_id=?1 AND status IN ('awaiting_promotion', 'remote_pending')",
            [outbox_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    if outstanding == 0 {
        connection
            .execute(
                "UPDATE memory_v2_outbox SET status='completed', updated_at=?2 WHERE id=?1",
                params![outbox_id, now_millis()],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Retires atoms the new one replaces.
///
/// `(project, layer, kind, subject)` is one memory, not a list. Without this a
/// revised decision sat beside the decision it revised with nothing to say which
/// still held, and a fact restated in four turns became four atoms.
fn supersede_same_subject(
    connection: &Connection,
    project_id: &str,
    layer: &str,
    kind: &str,
    subject: &str,
    keep_atom_id: &str,
) -> Result<usize, String> {
    if subject.trim().is_empty() {
        return Ok(0);
    }
    connection
        .execute(
            "UPDATE memory_v2_atoms SET status='superseded', updated_at=?6
             WHERE project_id=?1 AND layer=?2 AND kind=?3 AND subject=?4
               AND id<>?5 AND status='active'",
            params![
                project_id,
                layer,
                kind,
                subject,
                keep_atom_id,
                now_iso8601()
            ],
        )
        .map_err(|error| error.to_string())
}

fn record_audit(
    connection: &Connection,
    outbox_id: &str,
    action: &str,
    reason: &str,
    candidate_id: Option<&str>,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO memory_v2_audit(id, outbox_id, candidate_id, action, reason, policy_version, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                audit_id(outbox_id, action, candidate_id),
                outbox_id,
                candidate_id,
                action,
                truncate(reason, 500),
                RESEARCH_MEMORY_V2_VERSION,
                now_iso8601(),
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS memory_v2_outbox(
             id TEXT PRIMARY KEY,
             project_id TEXT NOT NULL,
             session_id TEXT NOT NULL,
             source_message_index INTEGER NOT NULL,
             source_event_ids TEXT NOT NULL,
             user_text TEXT NOT NULL,
             assistant_text TEXT NOT NULL,
             tool_trace TEXT NOT NULL DEFAULT '',
             occurred_at TEXT NOT NULL,
             status TEXT NOT NULL,
             attempts INTEGER NOT NULL DEFAULT 0,
             last_error TEXT,
             next_attempt_at INTEGER NOT NULL DEFAULT 0,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL,
             UNIQUE(project_id, session_id, source_message_index)
         );
         CREATE INDEX IF NOT EXISTS memory_v2_outbox_due
           ON memory_v2_outbox(status, next_attempt_at, created_at);
         CREATE TABLE IF NOT EXISTS memory_v2_candidates(
             id TEXT PRIMARY KEY,
             outbox_id TEXT NOT NULL REFERENCES memory_v2_outbox(id),
             project_id TEXT NOT NULL,
             session_id TEXT NOT NULL,
             source_event_ids TEXT NOT NULL,
             source_kind TEXT NOT NULL,
             source_quote TEXT NOT NULL,
             source_start INTEGER NOT NULL,
             source_end INTEGER NOT NULL,
             statement TEXT NOT NULL,
             kind TEXT NOT NULL,
             subject TEXT NOT NULL DEFAULT '',
             target_layer TEXT NOT NULL,
             scope TEXT NOT NULL,
             ttl_days INTEGER,
             status TEXT NOT NULL,
             extraction_model TEXT NOT NULL,
             reviewer_model TEXT,
             reviewer_reason TEXT,
             reason TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS memory_v2_candidates_project_status
           ON memory_v2_candidates(project_id, status, updated_at);
         CREATE TABLE IF NOT EXISTS memory_v2_atoms(
             id TEXT PRIMARY KEY,
             candidate_id TEXT NOT NULL UNIQUE REFERENCES memory_v2_candidates(id),
             project_id TEXT NOT NULL,
             session_id TEXT NOT NULL,
             layer TEXT NOT NULL,
             kind TEXT NOT NULL,
             subject TEXT NOT NULL DEFAULT '',
             statement TEXT NOT NULL,
             scope TEXT NOT NULL,
             status TEXT NOT NULL,
             source_event_ids TEXT NOT NULL,
             source_quote TEXT NOT NULL,
             source_start INTEGER NOT NULL,
             source_end INTEGER NOT NULL,
             expires_at TEXT,
             confirmed_by TEXT,
             confirmed_at TEXT,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS memory_v2_atoms_recall
           ON memory_v2_atoms(project_id, layer, status, expires_at, updated_at);
         CREATE TABLE IF NOT EXISTS memory_v2_audit(
             id TEXT PRIMARY KEY,
             outbox_id TEXT NOT NULL REFERENCES memory_v2_outbox(id),
             candidate_id TEXT,
             action TEXT NOT NULL,
             reason TEXT NOT NULL,
             policy_version TEXT NOT NULL,
             created_at TEXT NOT NULL
         );",
        )
        .map_err(|error| error.to_string())?;
    ensure_outbox_tool_trace_column(connection)?;
    ensure_column(connection, "memory_v2_candidates", "subject")?;
    ensure_column(connection, "memory_v2_atoms", "subject")?;
    migrate_l1_taxonomy(connection)
}

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    Ok(connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| error.to_string())?
        .iter()
        .any(|name| name == column))
}

fn ensure_column(connection: &Connection, table: &str, column: &str) -> Result<(), String> {
    if has_column(connection, table, column)? {
        return Ok(());
    }
    connection
        .execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"),
            [],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Kinds that named the turn rather than anything that outlives it.
fn legacy_kind_is_ephemeral(kind: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "active_",
        "current_task",
        "task_request",
        "task_scope",
        "task_instruction",
        "translation_request",
        "proposed_next_action",
        "pending_decision",
        "next_step_plan",
        "milestone_objective",
        "review_chapter",
        "merge_sections",
        "rewrite_section",
        "paper_reclassification",
        "modification_status",
    ];
    PREFIXES.iter().any(|prefix| kind.starts_with(prefix))
}

/// Maps a free-form legacy kind onto the closed taxonomy.
fn legacy_kind_to_type(kind: &str) -> &'static str {
    const FINDING: &[&str] = &[
        "_status",
        "_state",
        "_finding",
        "_verification",
        "_complete",
        "_files",
        "_debug",
        "remaining_work",
        "current_state",
        "diagnostic",
        "deliverable_",
    ];
    const CONSTRAINT: &[&str] = &[
        "constraint",
        "_feedback",
        "_adjustment",
        "design_decision",
        "_naming_revision",
        "_rhythm",
    ];
    if CONSTRAINT.iter().any(|marker| kind.contains(marker)) {
        return "constraint";
    }
    if FINDING.iter().any(|marker| kind.contains(marker)) {
        return "finding";
    }
    "decision"
}

/// One-time, non-destructive reclassification of R1 onto the closed taxonomy.
///
/// Rows that named the turn are moved to `archived_legacy_kind` rather than
/// deleted: they keep their provenance and stay inspectable, they just stop
/// reaching a prompt. Everything else keeps its statement and gains a type.
fn migrate_l1_taxonomy(connection: &Connection) -> Result<(), String> {
    let done: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM memory_v2_audit WHERE action='l1_taxonomy_migrated'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if done > 0 {
        return Ok(());
    }
    let rows: Vec<(String, String, String, String)> = connection
        .prepare(
            "SELECT id, kind, statement, candidate_id FROM memory_v2_atoms
             WHERE layer='r1' AND status='active'",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| error.to_string())?;
    if rows.is_empty() {
        return Ok(());
    }
    let (mut archived, mut retyped) = (0_usize, 0_usize);
    for (id, kind, statement, candidate_id) in rows {
        // Rows already on the taxonomy are left alone. The audit guard above
        // cannot be written when the outbox is empty (its foreign key needs a
        // row), so this is what actually makes a second pass a no-op -- without
        // it, re-running would map `finding` back onto `decision`.
        if L1_KINDS.contains(&kind.as_str()) {
            continue;
        }
        let ephemeral =
            legacy_kind_is_ephemeral(&kind) || statement.trim().chars().count() < MIN_STATEMENT_CHARS;
        let (status, new_kind) = if ephemeral {
            archived += 1;
            ("archived_legacy_kind", kind.clone())
        } else {
            retyped += 1;
            ("active", legacy_kind_to_type(&kind).to_string())
        };
        connection
            .execute(
                "UPDATE memory_v2_atoms SET status=?2, kind=?3, subject=?4, updated_at=?5
                 WHERE id=?1",
                params![
                    id,
                    status,
                    new_kind,
                    // Legacy rows have no author-supplied subject. The original
                    // kind is the best available stand-in and keeps supersession
                    // from collapsing unrelated rows onto one another.
                    truncate(&kind, MAX_SUBJECT_CHARS),
                    now_iso8601()
                ],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "UPDATE memory_v2_candidates SET subject=?2 WHERE id=?1",
                params![candidate_id, truncate(&kind, MAX_SUBJECT_CHARS)],
            )
            .map_err(|error| error.to_string())?;
    }
    // Best effort only: the audit row needs an existing outbox row to satisfy
    // its foreign key, and correctness does not depend on it being written.
    let _ = connection.execute(
        "INSERT OR IGNORE INTO memory_v2_audit(
           id, outbox_id, candidate_id, action, reason, policy_version, created_at)
         SELECT ?1, id, NULL, 'l1_taxonomy_migrated', ?2, ?3, ?4
         FROM memory_v2_outbox LIMIT 1",
        params![
            stable_id("l1-taxonomy-migration"),
            format!("{retyped} retyped, {archived} archived"),
            RESEARCH_MEMORY_V2_VERSION,
            now_iso8601(),
        ],
    );
    Ok(())
}

/// Databases created before tool capture existed have no `tool_trace`. Their
/// rows keep an empty trace, which simply means "no tool evidence for this
/// turn" -- they are not re-processed just to backfill a column.
fn ensure_outbox_tool_trace_column(connection: &Connection) -> Result<(), String> {
    let exists = connection
        .prepare("PRAGMA table_info(memory_v2_outbox)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| error.to_string())?
        .iter()
        .any(|name| name == "tool_trace");
    if exists {
        return Ok(());
    }
    connection
        .execute(
            "ALTER TABLE memory_v2_outbox ADD COLUMN tool_trace TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn validate_capture(capture: &ResearchMemoryV2Capture) -> Result<(), String> {
    if capture.project_id.trim().is_empty()
        || capture.session_id.trim().is_empty()
        || capture.source_message_index < 0
    {
        return Err(
            "v2 memory capture requires project, session, and a final message index".to_string(),
        );
    }
    if capture.source_event_ids.is_empty()
        || capture
            .source_event_ids
            .iter()
            .any(|event_id| event_id.trim().is_empty())
    {
        return Err(
            "v2 memory capture requires at least one non-empty source event id".to_string(),
        );
    }
    if capture.user_text.trim().is_empty() || capture.assistant_text.trim().is_empty() {
        return Err("v2 memory capture requires user and final assistant text".to_string());
    }
    Ok(())
}

fn research_memory_v2_db_path() -> PathBuf {
    let config = std::env::var("ARIS_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(crate::home_dir())
                .join(".config")
                .join("SomniQ")
        });
    std::env::var_os("SOMNIQ_RESEARCH_MEMORY_V2_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            config
                .join("memory")
                .join("builtin")
                .join("research-memory-v2.sqlite3")
        })
}

fn capture_id(capture: &ResearchMemoryV2Capture) -> String {
    stable_id(&format!(
        "capture\0{}\0{}\0{}",
        capture.project_id, capture.session_id, capture.source_message_index
    ))
}

fn candidate_id(outbox_id: &str, extraction: &ResearchMemoryV2Extraction) -> String {
    stable_id(&format!(
        "candidate\0{outbox_id}\0{}\0{}\0{}\0{}\0{}\0{}",
        extraction.source,
        extraction.source_quote.trim(),
        extraction.statement.trim(),
        extraction.kind.trim(),
        extraction.target_layer.as_str(),
        extraction.scope.trim(),
    ))
}

fn atom_id(candidate_id: &str) -> String {
    stable_id(&format!("atom\0{candidate_id}"))
}
fn audit_id(outbox_id: &str, action: &str, candidate_id: Option<&str>) -> String {
    stable_id(&format!(
        "audit\0{outbox_id}\0{action}\0{}\0{}",
        candidate_id.unwrap_or_default(),
        now_millis()
    ))
}
fn stable_id(value: &str) -> String {
    format!("v2-{:x}", Sha256::digest(value.as_bytes()))
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
        .map(|v| i64::try_from(v.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}
fn now_iso8601() -> String {
    crate::now_iso8601()
}
fn iso_after_days(days: i64) -> String {
    let seconds = u64::try_from(days.max(0))
        .unwrap_or_default()
        .saturating_mul(86_400);
    crate::iso8601_from_epoch_secs(crate::epoch_secs_now().saturating_add(seconds))
}
fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
fn reason_or_default(value: &str) -> &str {
    if value.trim().is_empty() {
        "source-grounded candidate"
    } else {
        value
    }
}
/// Source-grounding is stronger than a generic JSON schema: a statement may drop
/// words, reorder them, or lose punctuation, but it cannot introduce vocabulary
/// that never occurred in the quoted span.
///
/// Requiring the statement to be a literal *substring* of the quote was stricter
/// than that rule and stricter than the extractor prompt, so ordinary
/// condensations ("X 用 Y 做 Z" from a longer sentence) were discarded as
/// ungrounded.  Whole-token containment keeps the anti-fabrication guarantee
/// while allowing a statement to be a condensation of its own source.
fn statement_is_grounded(quote: &str, statement: &str) -> bool {
    let normalized_quote = normalise_for_grounding(quote);
    let normalized_statement = normalise_for_grounding(statement);
    if normalized_quote.is_empty() || normalized_statement.is_empty() {
        return false;
    }
    if normalized_quote.contains(&normalized_statement) {
        return true;
    }
    let terms = grounding_terms(statement);
    !terms.is_empty()
        && terms
            .iter()
            .all(|term| normalized_quote.contains(term.as_str()))
}

/// Grounding across several captured spans at once, for statements that are a
/// synthesis rather than a quotation.  The union is only ever the text captured
/// for this one turn, so a model still cannot introduce outside vocabulary.
fn statement_is_grounded_in_any(sources: &[&str], statement: &str) -> bool {
    let corpus = sources
        .iter()
        .map(|source| normalise_for_grounding(source))
        .collect::<Vec<_>>()
        .join("\u{0}");
    let normalized_statement = normalise_for_grounding(statement);
    if corpus.is_empty() || normalized_statement.is_empty() {
        return false;
    }
    let terms = grounding_terms(statement);
    !terms.is_empty() && terms.iter().all(|term| corpus.contains(term.as_str()))
}

/// Splits text into the units that must already exist in the source: ASCII
/// alphanumeric runs, and single CJK characters (which have no word boundaries
/// to segment on).
fn grounding_terms(value: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut ascii = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            ascii.extend(character.to_lowercase());
            continue;
        }
        if !ascii.is_empty() {
            terms.push(std::mem::take(&mut ascii));
        }
        if !character.is_whitespace() && !character.is_ascii_punctuation() {
            terms.push(character.to_lowercase().collect());
        }
    }
    if !ascii.is_empty() {
        terms.push(ascii);
    }
    terms.sort();
    terms.dedup();
    terms
}

fn normalise_for_grounding(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_ascii_punctuation())
        .flat_map(char::to_lowercase)
        .collect()
}
/// Substring search for CJK needles, whole-word search for ASCII ones.
///
/// CJK is unsegmented, so substring is the only workable rule there.  ASCII
/// needles must not match inside a longer word: plain `contains` made "table"
/// fire on "immutable" and "draft" on "drafts/", which silently classified
/// research text as a document edit.  `value` is expected to be lowercased.
fn contains_signal(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| {
        if needle.is_ascii() {
            contains_word(value, needle)
        } else {
            value.contains(needle)
        }
    })
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(offset) = haystack[from..].find(needle) {
        let start = from + offset;
        let end = start + needle.len();
        let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let after_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        // Advance by one byte so overlapping occurrences are still examined;
        // `find` operates on a char boundary, so this cannot split a code point
        // for the ASCII needles this helper is used with.
        from = start + 1;
        if from >= haystack.len() {
            break;
        }
    }
    false
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}
fn recall_terms(value: &str) -> Vec<String> {
    let mut terms = value
        .split(|c: char| !c.is_alphanumeric() && !('\u{4e00}'..='\u{9fff}').contains(&c))
        .map(|term| term.trim().to_ascii_lowercase())
        .filter(|term| term.chars().count() >= 2)
        .collect::<Vec<_>>();
    terms.sort();
    terms.dedup();
    terms.into_iter().take(12).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn capture() -> ResearchMemoryV2Capture {
        ResearchMemoryV2Capture {
            project_id: "project-a".to_string(),
            session_id: "chat-a".to_string(),
            source_message_index: 4,
            source_event_ids: vec!["chat-a:4".to_string()],
            user_text: "我偏好简洁的中文回答，实验必须保留完整来源。".to_string(),
            assistant_text: "已按要求完成本轮说明。".to_string(),
            tool_trace: String::new(),
            occurred_at: "2026-09-03T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn editorial_text_is_rejected_before_llm_screening() {
        let mut item = capture();
        item.user_text = "正文继续保留各类方法的详细解释，但不再用表格重复总结。".to_string();
        item.assistant_text = "已记录这项编辑修改。".to_string();
        assert!(matches!(
            prefilter_v2(&item),
            ResearchMemoryV2Prefilter::Rejected { .. }
        ));
    }

    #[test]
    fn assistant_narration_does_not_discard_a_durable_user_message() {
        // The dominant funnel loss: the prefilter judged `user + assistant` as one
        // blob, so an assistant reply opening with "我可以" threw away the user's
        // own statement. 47 of 64 rejections in the field were assistant-only.
        let mut item = capture();
        item.user_text = "本项目用 Reservoir Computing 做风机 SCADA 的短期功率预测。".to_string();
        item.assistant_text = "我可以先把数据管线搭起来，接下来再对齐指标。".to_string();
        assert!(matches!(
            prefilter_v2(&item),
            ResearchMemoryV2Prefilter::Eligible
        ));
    }

    #[test]
    fn ascii_signals_do_not_match_inside_longer_words() {
        let mut item = capture();
        // "table" inside "immutable" and "draft" inside "drafts" used to classify
        // research text as a one-off document edit.
        item.user_text = "The reservoir state is immutable across drafts.".to_string();
        item.assistant_text = "Verified on the CARE wind SCADA split.".to_string();
        assert!(matches!(
            prefilter_v2(&item),
            ResearchMemoryV2Prefilter::Eligible
        ));
        item.user_text = "Please rewrite this table before the deadline.".to_string();
        item.assistant_text = "好的".to_string();
        assert!(matches!(
            prefilter_v2(&item),
            ResearchMemoryV2Prefilter::Rejected { .. }
        ));
    }

    #[test]
    fn r1_accepts_a_task_instruction_that_r2_must_still_refuse() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let mut item = capture();
        item.user_text = "请改写方法章节的第二段，把符号统一成 \\mathbf{x}。".to_string();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        let task = ResearchMemoryV2Extraction {
            source: "user".to_string(),
            source_quote: "改写方法章节的第二段".to_string(),
            statement: "改写方法章节的第二段".to_string(),
            kind: "decision".to_string(),
            subject: "active_task".to_string(),
            target_layer: ResearchMemoryV2Layer::R1,
            scope: "session".to_string(),
            ttl_days: Some(7),
            reason: "current work".to_string(),
        };
        // R1 is working memory, so a task instruction is its legitimate source.
        assert_eq!(
            store
                .record_extractions(&queued, &[task.clone()], "extractor")
                .expect("r1 accepted")
                .len(),
            1
        );
        // The same span promoted as a durable research fact stays refused.
        let durable = ResearchMemoryV2Extraction {
            target_layer: ResearchMemoryV2Layer::R2,
            scope: "project".to_string(),
            ttl_days: None,
            ..task
        };
        assert!(store
            .record_extractions(&queued, &[durable], "extractor")
            .is_err());
    }

    #[test]
    fn statement_may_condense_its_quote_but_not_add_vocabulary() {
        let quote = "本项目用 Reservoir Computing 做风机 SCADA 的短期功率预测";
        // A condensation: reordered, words dropped, no new vocabulary.
        assert!(statement_is_grounded(
            quote,
            "用 Reservoir Computing 做短期功率预测"
        ));
        // Verbatim still passes.
        assert!(statement_is_grounded(quote, quote));
        // Fabrication: "误差" and "下降" never occur in the quote.
        assert!(!statement_is_grounded(quote, "预测误差下降"));
        assert!(!statement_is_grounded(quote, "uses LSTM for forecasting"));
    }

    #[test]
    fn one_malformed_candidate_does_not_discard_its_valid_siblings() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let mut item = capture();
        item.user_text = "当前里程碑必须先完成方法章节。".to_string();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        let ids = store
            .record_extractions(
                &queued,
                &[
                    ResearchMemoryV2Extraction {
                        source: "user".to_string(),
                        source_quote: "从未出现过的引用".to_string(),
                        statement: "从未出现过的引用".to_string(),
                        kind: "finding".to_string(),
                        subject: "bogus".to_string(),
                        target_layer: ResearchMemoryV2Layer::R2,
                        scope: "project".to_string(),
                        ttl_days: None,
                        reason: "quote is not in the source".to_string(),
                    },
                    ResearchMemoryV2Extraction {
                        source: "user".to_string(),
                        source_quote: "当前里程碑必须先完成方法章节".to_string(),
                        statement: "当前里程碑必须先完成方法章节".to_string(),
                        kind: "decision".to_string(),
                        subject: "task_constraint".to_string(),
                        target_layer: ResearchMemoryV2Layer::R1,
                        scope: "milestone".to_string(),
                        ttl_days: Some(7),
                        reason: "current work".to_string(),
                    },
                ],
                "extractor",
            )
            .expect("valid sibling survives");
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn expired_r1_leaves_the_settings_counter() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let mut item = capture();
        item.user_text = "当前里程碑必须先完成方法章节。".to_string();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        let ids = store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "user".to_string(),
                    source_quote: "当前里程碑必须先完成方法章节".to_string(),
                    statement: "当前里程碑必须先完成方法章节".to_string(),
                    kind: "decision".to_string(),
                    subject: "task_constraint".to_string(),
                    target_layer: ResearchMemoryV2Layer::R1,
                    scope: "milestone".to_string(),
                    ttl_days: Some(7),
                    reason: "current work".to_string(),
                }],
                "extractor",
            )
            .expect("extract");
        store
            .apply_promotion(
                &ids[0],
                &ResearchMemoryV2Promotion {
                    accept: true,
                    target_layer: ResearchMemoryV2Layer::R1,
                    reason: "allowed".to_string(),
                },
                "reviewer",
            )
            .expect("promote");
        assert_eq!(store.stats("project-a").expect("stats").r1_active, 1);
        let connection = Connection::open(store.path()).expect("open");
        connection
            .execute(
                "UPDATE memory_v2_atoms SET expires_at='2020-01-01T00:00:00Z' WHERE layer='r1'",
                [],
            )
            .expect("expire");
        // The library already hides expired rows; the counter must agree, or
        // Settings advertises atoms the user cannot find.
        assert!(store
            .library_atoms("project-a", 10)
            .expect("library")
            .is_empty());
        assert_eq!(store.stats("project-a").expect("stats").r1_active, 0);
    }

    /// The shape the desktop capture writes: one quotable line per tool result.
    fn capture_with_failed_tool() -> ResearchMemoryV2Capture {
        let mut item = capture();
        item.user_text = "把规划 tex 编译成 PDF".to_string();
        item.assistant_text =
            "latexmk 直接跑会失败，改用 xelatex 才能编译成 PDF。".to_string();
        item.tool_trace = "[1] Bash(latexmk 规划.tex) FAILED: Package inputenc Error: Unicode character not set up for use with LaTeX\n\
             [2] Bash(xelatex 规划.tex) ok: Output written on PDF\n"
            .to_string();
        item
    }

    #[test]
    fn tool_trace_renders_one_quotable_line_per_result() {
        use crate::{ContentBlock, ConversationMessage, MessageRole};
        let messages = vec![
            ConversationMessage {
                role: MessageRole::User,
                blocks: vec![ContentBlock::Text {
                    text: "编译 PDF".to_string(),
                }],
                usage: None,
            },
            ConversationMessage {
                role: MessageRole::Assistant,
                blocks: vec![
                    ContentBlock::ToolUse {
                        id: "call-1".to_string(),
                        name: "Bash".to_string(),
                        input: "latexmk main.tex".to_string(),
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "call-1".to_string(),
                        tool_name: "Bash".to_string(),
                        // Multi-line payloads must collapse: a quote spanning a
                        // newline could join two unrelated results.
                        output: "Package inputenc Error:\n  Unicode character".to_string(),
                        is_error: true,
                    },
                    ContentBlock::Text {
                        text: "改用 xelatex。".to_string(),
                    },
                ],
                usage: None,
            },
        ];
        let trace = tool_trace_for_turn(&messages);
        assert_eq!(
            trace,
            "[1] Bash(latexmk main.tex) FAILED: Package inputenc Error: Unicode character\n"
        );
        assert!(trace_has_failure(&trace));
        // Text blocks are prose and belong to the assistant source, not here.
        assert!(!trace.contains("xelatex"));
    }

    #[test]
    fn a_json_envelope_is_reduced_to_the_fields_that_explain_the_failure() {
        // The real shape of a failed bash result: 16 keys, 13 of them bookkeeping.
        // Truncating the raw text to a budget produced a line of nulls and buried
        // the stderr that the lesson depends on.
        let envelope = r#"{"assistantAutoBackgrounded":null,"backgroundTaskId":null,
             "backgroundedByUser":null,"interrupted":"False","isImage":null,
             "noOutputExpected":"False","persistedOutputPath":null,
             "returnCodeInterpretation":"exit_code:127",
             "stderr":"/usr/bin/bash: line 1: ls: command not found\n","stdout":""}"#;
        let digest = tool_output_digest(envelope);
        assert!(digest.contains("exit_code:127"), "{digest}");
        assert!(digest.contains("ls: command not found"), "{digest}");
        assert!(!digest.contains("assistantAutoBackgrounded"), "{digest}");
        assert!(!digest.contains("null"), "{digest}");
        // Plain-text results are passed through untouched.
        assert_eq!(tool_output_digest("  plain failure  "), "plain failure");
        // A JSON body with no recognised field keeps its raw text rather than
        // silently becoming empty.
        assert_eq!(tool_output_digest(r#"{"other":1}"#), r#"{"other":1}"#);
    }

    fn tool_use(id: &str, name: &str, input: &str) -> crate::ContentBlock {
        crate::ContentBlock::ToolUse {
            id: id.to_string(),
            name: name.to_string(),
            input: input.to_string(),
        }
    }

    fn tool_result(id: &str, name: &str, output: &str, is_error: bool) -> crate::ContentBlock {
        crate::ContentBlock::ToolResult {
            tool_use_id: id.to_string(),
            tool_name: name.to_string(),
            output: output.to_string(),
            is_error,
        }
    }

    fn turn(blocks: Vec<crate::ContentBlock>) -> Vec<crate::ConversationMessage> {
        vec![crate::ConversationMessage {
            role: crate::MessageRole::Assistant,
            blocks,
            usage: None,
        }]
    }

    #[test]
    fn a_recovered_tool_failure_becomes_an_episode_with_no_model_call() {
        let episodes = tool_episodes_for_turn(&turn(vec![
            tool_use("a", "bash", "latexmk main.tex"),
            tool_result("a", "bash", r#"{"returnCodeInterpretation":"exit_code:1"}"#, true),
            tool_use("b", "bash", "xelatex main.tex"),
            tool_result("b", "bash", "Output written", false),
        ]));
        assert_eq!(episodes.len(), 1);
        assert!(episodes[0].statement.contains("latexmk main.tex"), "{:?}", episodes[0]);
        assert!(episodes[0].statement.contains("xelatex main.tex"), "{:?}", episodes[0]);
        assert!(episodes[0].evidence.contains(TOOL_TRACE_FAILURE_MARKER));
    }

    #[test]
    fn an_unrecovered_failure_is_not_an_episode() {
        // A failure with no route out teaches nothing reusable, and a turn full
        // of them would flood the store.
        let episodes = tool_episodes_for_turn(&turn(vec![
            tool_use("a", "bash", "latexmk main.tex"),
            tool_result("a", "bash", "boom", true),
        ]));
        assert!(episodes.is_empty());
    }

    #[test]
    fn retrying_the_identical_call_is_a_flake_not_a_lesson() {
        let episodes = tool_episodes_for_turn(&turn(vec![
            tool_use("a", "bash", "cargo test"),
            tool_result("a", "bash", "timeout", true),
            tool_use("b", "bash", "cargo test"),
            tool_result("b", "bash", "ok", false),
        ]));
        assert!(episodes.is_empty());
    }

    #[test]
    fn a_different_tool_succeeding_is_not_a_recovery() {
        let episodes = tool_episodes_for_turn(&turn(vec![
            tool_use("a", "bash", "latexmk main.tex"),
            tool_result("a", "bash", "boom", true),
            tool_use("b", "read_file", "main.tex"),
            tool_result("b", "read_file", "contents", false),
        ]));
        assert!(episodes.is_empty());
    }

    #[test]
    fn tool_trace_is_empty_when_a_turn_ran_no_tools() {
        use crate::{ContentBlock, ConversationMessage, MessageRole};
        let messages = vec![ConversationMessage {
            role: MessageRole::Assistant,
            blocks: vec![ContentBlock::Text {
                text: "没有调用工具。".to_string(),
            }],
            usage: None,
        }];
        assert!(tool_trace_for_turn(&messages).is_empty());
    }

    #[test]
    fn re_enqueue_backfills_a_missing_trace_without_revising_the_capture() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        // A row captured before tool evidence existed.
        let mut old = capture_with_failed_tool();
        old.tool_trace = String::new();
        assert!(store.enqueue_capture(&old).expect("enqueue"));
        assert!(store.due_outbox(1).expect("due")[0]
            .capture
            .tool_trace
            .is_empty());

        // Replaying the same turn now carries the trace.
        let replayed = capture_with_failed_tool();
        assert!(
            !store.enqueue_capture(&replayed).expect("re-enqueue"),
            "a backfill is not a new capture"
        );
        let item = store.due_outbox(1).expect("due").pop().expect("item");
        assert!(item.capture.tool_trace.contains(TOOL_TRACE_FAILURE_MARKER));
        assert_eq!(item.capture.user_text, old.user_text);

        // A trace already present is never overwritten.
        let mut altered = capture_with_failed_tool();
        altered.tool_trace = "[1] Other(x) FAILED: different".to_string();
        store.enqueue_capture(&altered).expect("re-enqueue");
        let item = store.due_outbox(1).expect("due").pop().expect("item");
        assert!(!item.capture.tool_trace.contains("different"));
    }

    fn inline(layer: ResearchMemoryV2Layer, kind: &str, statement: &str) -> ResearchMemoryV2InlineWrite {
        ResearchMemoryV2InlineWrite {
            project_id: "project-a".to_string(),
            session_id: "chat-a".to_string(),
            message_index: 4,
            source_event_ids: vec!["chat-a:4".to_string()],
            layer,
            kind: kind.to_string(),
            subject: "latexmk".to_string(),
            statement: statement.to_string(),
            scope: match layer {
                ResearchMemoryV2Layer::R1 => "session",
                _ => "project",
            }
            .to_string(),
            ttl_days: match layer {
                ResearchMemoryV2Layer::R1 => Some(30),
                _ => None,
            },
            evidence: "[1] Bash(latexmk main.tex) FAILED: exit_code:1".to_string(),
            origin: "tool_episode".to_string(),
        }
    }

    #[test]
    fn r1_rejects_a_kind_invented_for_one_row() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let mut item = capture();
        item.user_text = "当前里程碑必须先完成方法章节。".to_string();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        let candidate = |kind: &str| ResearchMemoryV2Extraction {
            source: "user".to_string(),
            source_quote: "当前里程碑必须先完成方法章节".to_string(),
            statement: "当前里程碑必须先完成方法章节".to_string(),
            kind: kind.to_string(),
            subject: "方法章节".to_string(),
            target_layer: ResearchMemoryV2Layer::R1,
            scope: "milestone".to_string(),
            ttl_days: Some(7),
            reason: "n/a".to_string(),
        };
        // 93 atoms once produced 63 distinct kinds, 59 of them used once. A
        // category invented per row cannot be grouped, so R2/R3 had nothing to
        // aggregate from.
        for invented in ["active_task", "completion_state_tex_pdf", "chapter_plan_decision"] {
            assert!(
                store
                    .record_extractions(&queued, &[candidate(invented)], "extractor")
                    .is_err(),
                "`{invented}` must not be admissible as an R1 kind"
            );
        }
        for allowed in L1_KINDS {
            assert!(store
                .record_extractions(&queued, &[candidate(allowed)], "extractor")
                .is_ok());
        }
    }

    #[test]
    fn the_taxonomy_migration_is_a_no_op_the_second_time() {
        let root = tempdir().expect("temp");
        let path = root.path().join("v2.sqlite");
        {
            let connection = Connection::open(&path).expect("open");
            ensure_schema(&connection).expect("schema");
            // The atom's candidate_id is a foreign key, so seed the whole chain.
            connection
                .execute_batch(
                    "INSERT INTO memory_v2_outbox(
                       id, project_id, session_id, source_message_index, source_event_ids,
                       user_text, assistant_text, tool_trace, occurred_at, status, attempts,
                       next_attempt_at, created_at, updated_at)
                     VALUES ('o','p','s',1,'[]','u','a','','t','completed',0,0,1,1);
                     INSERT INTO memory_v2_candidates(
                       id, outbox_id, project_id, session_id, source_event_ids, source_kind,
                       source_quote, source_start, source_end, statement, kind, subject,
                       target_layer, scope, status, extraction_model, reason, created_at, updated_at)
                     VALUES ('c','o','p','s','[]','user','q',0,1,'x','k','', 'r1','session',
                             'active','m','r',1,1),
                            ('d','o','p','s','[]','user','q',0,1,'x','k','', 'r1','session',
                             'active','m','r',1,1);",
                )
                .expect("seed chain");
            connection
                .execute(
                    "INSERT INTO memory_v2_atoms(
                       id, candidate_id, project_id, session_id, layer, kind, subject, statement,
                       scope, status, source_event_ids, source_quote, source_start, source_end,
                       created_at, updated_at)
                     VALUES ('a','c','p','s','r1','latex_compile_verification','', 'PDF 已生成 108 页',
                             'session','active','[]','q',0,1,'t','t'),
                            ('b','d','p','s','r1','active_task','', '英语版本',
                             'session','active','[]','q',0,1,'t','t')",
                    [],
                )
                .expect("seed");
        }
        let read_kinds = || -> Vec<(String, String)> {
            let connection = Connection::open(&path).expect("open");
            let mut statement = connection
                .prepare("SELECT kind, status FROM memory_v2_atoms ORDER BY id")
                .expect("prepare");
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("query");
            rows.collect::<Result<Vec<_>, _>>().expect("rows")
        };
        // The migration runs from `ensure_schema`, which the store's own opens
        // call; a bare `Connection::open` does not trigger it.
        let store = ResearchMemoryV2Store::new(&path);
        store.stats("p").expect("first open migrates");
        // A `_verification` kind becomes `finding`, and a kind that named the
        // turn is archived rather than deleted.
        let first = read_kinds();
        assert_eq!(
            first,
            vec![
                ("finding".to_string(), "active".to_string()),
                ("active_task".to_string(), "archived_legacy_kind".to_string()),
            ]
        );
        // Second open must not touch them. `finding` contains none of the
        // legacy `finding` markers, so a re-run would silently demote it to
        // `decision` if already-typed rows were not skipped.
        store.stats("p").expect("second open");
        assert_eq!(read_kinds(), first);
    }

    #[test]
    fn a_request_fragment_cannot_become_a_memory() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let mut item = capture();
        item.user_text = "英语版本，翻译一下当前里程碑的方法章节".to_string();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        // "英语版本" is a genuine substring of the turn and would pass every
        // grounding rule; it is still meaningless in a session that cannot see
        // this conversation.
        assert!(store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "user".to_string(),
                    source_quote: "英语版本".to_string(),
                    statement: "英语版本".to_string(),
                    kind: "decision".to_string(),
                    subject: "翻译".to_string(),
                    target_layer: ResearchMemoryV2Layer::R1,
                    scope: "session".to_string(),
                    ttl_days: Some(7),
                    reason: "n/a".to_string(),
                }],
                "extractor"
            )
            .is_err());
    }

    #[test]
    fn a_revised_memory_replaces_the_one_it_revises() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let write = |statement: &str| ResearchMemoryV2InlineWrite {
            project_id: "project-a".to_string(),
            session_id: "chat-a".to_string(),
            message_index: 4,
            source_event_ids: vec!["chat-a:4".to_string()],
            layer: ResearchMemoryV2Layer::R2,
            kind: "decision".to_string(),
            subject: "论文中心科学问题".to_string(),
            statement: statement.to_string(),
            scope: "project".to_string(),
            ttl_days: None,
            evidence: "user said so".to_string(),
            origin: "agent_tool".to_string(),
        };
        store
            .record_inline(&write("中心科学问题是机制条件化"))
            .expect("first");
        store
            .record_inline(&write("中心科学问题正式改为知识迁移"))
            .expect("revision");
        // One subject is one memory. Previously the revision sat beside the
        // decision it revised, with nothing marking which one still held.
        let live = store.library_atoms("project-a", 10).expect("library");
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].statement, "中心科学问题正式改为知识迁移");
        assert_eq!(store.stats("project-a").expect("stats").r2_active, 1);
    }

    #[test]
    fn different_subjects_do_not_supersede_each_other() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let write = |subject: &str, statement: &str| ResearchMemoryV2InlineWrite {
            project_id: "project-a".to_string(),
            session_id: "chat-a".to_string(),
            message_index: 4,
            source_event_ids: vec!["chat-a:4".to_string()],
            layer: ResearchMemoryV2Layer::R2,
            kind: "constraint".to_string(),
            subject: subject.to_string(),
            statement: statement.to_string(),
            scope: "project".to_string(),
            ttl_days: None,
            evidence: "user said so".to_string(),
            origin: "agent_tool".to_string(),
        };
        store.record_inline(&write("标签命名", "标签全部不超过 2 个词")).expect("a");
        store.record_inline(&write("章节命名", "章节名不要是问题 1 2 3")).expect("b");
        assert_eq!(store.stats("project-a").expect("stats").r2_active, 2);
    }

    #[test]
    fn an_inline_write_becomes_an_atom_without_any_model_call() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let atom = store
            .record_inline(&inline(
                ResearchMemoryV2Layer::R2,
                "tool_lesson",
                "latexmk 在本项目失败，改用 xelatex",
            ))
            .expect("inline write")
            .expect("atom");
        assert_eq!(atom.layer, ResearchMemoryV2Layer::R2);
        assert_eq!(atom.status, "active");
        assert_eq!(store.stats("project-a").expect("stats").r2_active, 1);
        // Provenance is uniform with the screened path, so Settings can still
        // drill down to the source event.
        assert_eq!(atom.source_event_ids, vec!["chat-a:4".to_string()]);
        assert!(atom.source_quote.contains("latexmk"));
        // And it is immediately recallable -- no outbox round trip.
        assert_eq!(
            store
                .recall_local("project-a", "chat-a", "xelatex", 5)
                .expect("recall")
                .len(),
            1
        );
    }

    #[test]
    fn the_same_lesson_learned_twice_is_one_memory() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let first = inline(ResearchMemoryV2Layer::R2, "tool_lesson", "latexmk 失败，改用 xelatex");
        store.record_inline(&first).expect("first");
        // A later session hits the same wall and records it again.
        let mut again = first.clone();
        again.session_id = "chat-b".to_string();
        again.message_index = 9;
        again.source_event_ids = vec!["chat-b:9".to_string()];
        store.record_inline(&again).expect("second");
        assert_eq!(store.stats("project-a").expect("stats").r2_active, 1);
    }

    #[test]
    fn an_inline_r3_rule_still_waits_for_the_user() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let atom = store
            .record_inline(&inline(
                ResearchMemoryV2Layer::R3,
                "user_preference",
                "回答一律用中文",
            ))
            .expect("inline write")
            .expect("atom");
        assert_eq!(atom.status, "pending_user_confirmation");
        let stats = store.stats("project-a").expect("stats");
        assert_eq!(stats.r3_confirmed, 0);
        assert_eq!(stats.r3_pending_confirmation, 1);
        // Skipping the screening round trip must not skip the user's gate.
        assert!(store
            .recall_local("project-a", "chat-a", "中文", 5)
            .expect("recall")
            .is_empty());
    }

    #[test]
    fn inline_writes_keep_the_layer_invariants() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        // R1 without a TTL would be indistinguishable from durable knowledge.
        let mut no_ttl = inline(ResearchMemoryV2Layer::R1, "active_task", "正在改第四章");
        no_ttl.ttl_days = None;
        assert!(store.record_inline(&no_ttl).is_err());
        // R3 is only ever a preference or a constraint.
        assert!(store
            .record_inline(&inline(
                ResearchMemoryV2Layer::R3,
                "tool_lesson",
                "latexmk 失败"
            ))
            .is_err());
        // Evidence is mandatory: an atom nobody can trace is not a memory.
        let mut no_evidence = inline(ResearchMemoryV2Layer::R2, "tool_lesson", "某条结论");
        no_evidence.evidence = "   ".to_string();
        assert!(store.record_inline(&no_evidence).is_err());
    }

    #[test]
    fn a_failed_tool_call_always_survives_the_prefilter() {
        // The turn's prose is pure process narration, which the text-only rule
        // rejects -- but a tool failure is the most reusable thing a turn can
        // contain, so it must never be screened out before the extractor sees it.
        let mut item = capture_with_failed_tool();
        item.user_text = "好的，接下来呢".to_string();
        item.assistant_text = "我可以先试一下。".to_string();
        assert!(matches!(
            screen_texts(&item.user_text, &item.assistant_text),
            ResearchMemoryV2Prefilter::Rejected { .. }
        ));
        assert!(matches!(
            prefilter_v2(&item),
            ResearchMemoryV2Prefilter::Eligible
        ));
    }

    #[test]
    fn a_tool_lesson_may_synthesise_across_the_turn() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let item = capture_with_failed_tool();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        assert!(
            queued.capture.tool_trace.contains(TOOL_TRACE_FAILURE_MARKER),
            "the trace must survive the round trip through SQLite"
        );
        // The lesson is not a substring of any single quote: it joins the failed
        // tool line to the route that replaced it.
        let ids = store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "tool".to_string(),
                    source_quote: "Bash(latexmk 规划.tex) FAILED".to_string(),
                    statement: "latexmk 失败，改用 xelatex 才能编译成 PDF".to_string(),
                    kind: "finding".to_string(),
                    subject: "tool_lesson".to_string(),
                    target_layer: ResearchMemoryV2Layer::R2,
                    scope: "project".to_string(),
                    ttl_days: None,
                    reason: "reusable route".to_string(),
                }],
                "extractor",
            )
            .expect("tool lesson accepted");
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn a_tool_lesson_still_cannot_invent_vocabulary() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let item = capture_with_failed_tool();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        // "Tectonic" appears nowhere in the captured turn.
        assert!(store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "tool".to_string(),
                    source_quote: "Bash(latexmk 规划.tex) FAILED".to_string(),
                    statement: "latexmk 失败，应改用 Tectonic".to_string(),
                    kind: "finding".to_string(),
                    subject: "tool_lesson".to_string(),
                    target_layer: ResearchMemoryV2Layer::R2,
                    scope: "project".to_string(),
                    ttl_days: None,
                    reason: "fabricated route".to_string(),
                }],
                "extractor",
            )
            .is_err());
        // And a quote that never appears in the trace is still refused.
        assert!(store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "tool".to_string(),
                    source_quote: "Bash(pdflatex 规划.tex) FAILED".to_string(),
                    statement: "latexmk 失败".to_string(),
                    kind: "finding".to_string(),
                    subject: "tool_lesson".to_string(),
                    target_layer: ResearchMemoryV2Layer::R2,
                    scope: "project".to_string(),
                    ttl_days: None,
                    reason: "quote not in trace".to_string(),
                }],
                "extractor",
            )
            .is_err());
    }

    #[test]
    fn tool_evidence_cannot_be_claimed_for_a_turn_that_ran_no_tools() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let item = capture();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        assert!(store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "tool".to_string(),
                    source_quote: "anything".to_string(),
                    statement: "anything".to_string(),
                    kind: "finding".to_string(),
                    subject: "tool_lesson".to_string(),
                    target_layer: ResearchMemoryV2Layer::R2,
                    scope: "project".to_string(),
                    ttl_days: None,
                    reason: "no trace exists".to_string(),
                }],
                "extractor",
            )
            .is_err());
    }

    #[test]
    fn rescreen_reopens_rejected_captures_and_their_candidates() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let mut item = capture();
        item.user_text = "当前里程碑必须先完成方法章节。".to_string();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        let ids = store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "user".to_string(),
                    source_quote: "当前里程碑必须先完成方法章节".to_string(),
                    statement: "当前里程碑必须先完成方法章节".to_string(),
                    kind: "decision".to_string(),
                    subject: "task_constraint".to_string(),
                    target_layer: ResearchMemoryV2Layer::R1,
                    scope: "milestone".to_string(),
                    ttl_days: Some(7),
                    reason: "current work".to_string(),
                }],
                "extractor",
            )
            .expect("extract");
        // A reviewer verdict the corrected policy would no longer produce.
        store
            .apply_promotion(
                &ids[0],
                &ResearchMemoryV2Promotion {
                    accept: false,
                    target_layer: ResearchMemoryV2Layer::R1,
                    reason: "stale policy".to_string(),
                },
                "reviewer",
            )
            .expect("reject");
        assert_eq!(store.stats("project-a").expect("stats").r1_active, 0);

        assert_eq!(store.rescreen_rejected("project-a").expect("rescreen"), 1);
        // The capture is due again and its candidate awaits a fresh verdict.
        let requeued = store.due_outbox(1).expect("due").pop().expect("item");
        assert_eq!(requeued.id, queued.id);
        assert_eq!(requeued.attempts, 0);
        let ids = store
            .record_extractions(
                &requeued,
                &[ResearchMemoryV2Extraction {
                    source: "user".to_string(),
                    source_quote: "当前里程碑必须先完成方法章节".to_string(),
                    statement: "当前里程碑必须先完成方法章节".to_string(),
                    kind: "decision".to_string(),
                    subject: "task_constraint".to_string(),
                    target_layer: ResearchMemoryV2Layer::R1,
                    scope: "milestone".to_string(),
                    ttl_days: Some(7),
                    reason: "current work".to_string(),
                }],
                "extractor",
            )
            .expect("re-extract");
        store
            .apply_promotion(
                &ids[0],
                &ResearchMemoryV2Promotion {
                    accept: true,
                    target_layer: ResearchMemoryV2Layer::R1,
                    reason: "task memory".to_string(),
                },
                "reviewer",
            )
            .expect("promote");
        assert_eq!(store.stats("project-a").expect("stats").r1_active, 1);
    }

    #[test]
    fn rescreen_leaves_captures_the_current_policy_still_rejects() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let mut item = capture();
        item.user_text = "正文继续保留各类方法的详细解释，但不再用表格重复总结。".to_string();
        item.assistant_text = "已记录这项编辑修改。".to_string();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        store
            .reject_prefilter(&queued, "ephemeral")
            .expect("prefilter reject");
        assert_eq!(store.rescreen_rejected("project-a").expect("rescreen"), 0);
        assert!(store.due_outbox(1).expect("due").is_empty());
    }

    #[test]
    fn r3_requires_user_confirmation_and_exact_provenance() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let item = capture();
        assert!(store.enqueue_capture(&item).expect("enqueue"));
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        assert!(store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "assistant".to_string(),
                    source_quote: "已按要求完成本轮说明".to_string(),
                    statement: "已按要求完成本轮说明".to_string(),
                    kind: "user_preference".to_string(),
                    subject: "user_preference".to_string(),
                    target_layer: ResearchMemoryV2Layer::R3,
                    scope: "project".to_string(),
                    ttl_days: None,
                    reason: "assistant paraphrase is not user authority".to_string(),
                }],
                "extractor"
            )
            .is_err());
        let ids = store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "user".to_string(),
                    source_quote: "我偏好简洁的中文回答".to_string(),
                    statement: "我偏好简洁的中文回答".to_string(),
                    kind: "user_preference".to_string(),
                    subject: "user_preference".to_string(),
                    target_layer: ResearchMemoryV2Layer::R3,
                    scope: "project".to_string(),
                    ttl_days: None,
                    reason: "explicit user preference".to_string(),
                }],
                "extractor",
            )
            .expect("extract");
        let atom = store
            .apply_promotion(
                &ids[0],
                &ResearchMemoryV2Promotion {
                    accept: true,
                    target_layer: ResearchMemoryV2Layer::R3,
                    reason: "independent review accepted".to_string(),
                },
                "reviewer",
            )
            .expect("promote")
            .expect("atom");
        assert_eq!(atom.status, "pending_user_confirmation");
        let status: String = rusqlite::Connection::open(root.path().join("v2.sqlite"))
            .expect("open status db")
            .query_row(
                "SELECT status FROM memory_v2_outbox WHERE id=?1",
                [&queued.id],
                |row| row.get(0),
            )
            .expect("outbox status");
        assert_eq!(
            status, "completed",
            "pending R3 confirmation is not a stuck worker item"
        );
        assert!(store
            .confirmed_r3("project-a", 5)
            .expect("profile")
            .is_empty());
        assert!(store
            .confirm_r3("project-a", &atom.id, "user")
            .expect("confirm"));
        assert_eq!(
            store.confirmed_r3("project-a", 5).expect("profile").len(),
            1
        );
    }

    #[test]
    fn invalid_llm_summary_cannot_be_persisted() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let item = capture();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        let error = store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "user".to_string(),
                    source_quote: "我偏好简洁的中文回答".to_string(),
                    statement: "用户喜欢在每周五开会".to_string(),
                    kind: "user_preference".to_string(),
                    subject: "user_preference".to_string(),
                    target_layer: ResearchMemoryV2Layer::R3,
                    scope: "project".to_string(),
                    ttl_days: None,
                    reason: "hallucinated".to_string(),
                }],
                "extractor",
            )
            .expect_err("unfounded statement rejected");
        assert!(error.contains("grounded"));
    }

    #[test]
    fn r1_is_scoped_to_its_own_session_and_expires() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let mut item = capture();
        item.user_text = "请记住当前里程碑必须先完成方法章节。".to_string();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        let ids = store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "user".to_string(),
                    source_quote: "当前里程碑必须先完成方法章节".to_string(),
                    statement: "当前里程碑必须先完成方法章节".to_string(),
                    kind: "decision".to_string(),
                    subject: "task_constraint".to_string(),
                    target_layer: ResearchMemoryV2Layer::R1,
                    scope: "milestone".to_string(),
                    ttl_days: Some(7),
                    reason: "current work".to_string(),
                }],
                "extractor",
            )
            .expect("extract");
        store
            .apply_promotion(
                &ids[0],
                &ResearchMemoryV2Promotion {
                    accept: true,
                    target_layer: ResearchMemoryV2Layer::R1,
                    reason: "allowed".to_string(),
                },
                "reviewer",
            )
            .expect("promote");
        assert_eq!(
            store
                .recall_local("project-a", "chat-a", "方法章节", 5)
                .expect("own session")
                .len(),
            1
        );
        assert!(store
            .recall_local("project-a", "chat-b", "方法章节", 5)
            .expect("other session")
            .is_empty());
    }

    #[test]
    fn promoting_outbox_is_recoverable_after_store_reopen() {
        let root = tempdir().expect("temp");
        let path = root.path().join("v2.sqlite");
        let store = ResearchMemoryV2Store::new(&path);
        let mut item = capture();
        item.user_text = "当前里程碑必须先完成方法章节。".to_string();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        let ids = store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "user".to_string(),
                    source_quote: "当前里程碑必须先完成方法章节".to_string(),
                    statement: "当前里程碑必须先完成方法章节".to_string(),
                    kind: "decision".to_string(),
                    subject: "task_constraint".to_string(),
                    target_layer: ResearchMemoryV2Layer::R1,
                    scope: "milestone".to_string(),
                    ttl_days: Some(7),
                    reason: "current work".to_string(),
                }],
                "extractor",
            )
            .expect("extract");
        let status: String = rusqlite::Connection::open(&path)
            .expect("open status db")
            .query_row(
                "SELECT status FROM memory_v2_outbox WHERE id=?1",
                [&queued.id],
                |row| row.get(0),
            )
            .expect("outbox status");
        assert_eq!(status, "promoting");

        // Simulate a process crash after extraction committed but before the
        // independent promotion pass completed. A fresh store must reclaim
        // the same durable item and finish it without re-running extraction.
        drop(store);
        let reopened = ResearchMemoryV2Store::new(&path);
        let recovered = reopened.due_outbox(1).expect("recovered due");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, queued.id);
        assert_eq!(recovered[0].capture, queued.capture);
        let atom = reopened
            .apply_promotion(
                &ids[0],
                &ResearchMemoryV2Promotion {
                    accept: true,
                    target_layer: ResearchMemoryV2Layer::R1,
                    reason: "independent review accepted after restart".to_string(),
                },
                "reviewer",
            )
            .expect("promote")
            .expect("atom");
        assert_eq!(atom.status, "active");
        let final_status: String = rusqlite::Connection::open(&path)
            .expect("open final db")
            .query_row(
                "SELECT status FROM memory_v2_outbox WHERE id=?1",
                [&queued.id],
                |row| row.get(0),
            )
            .expect("final outbox status");
        assert_eq!(final_status, "completed");
        assert!(reopened.due_outbox(1).expect("no longer due").is_empty());
    }

    #[test]
    fn remote_r2_is_not_recalled_before_remote_acknowledgement() {
        let root = tempdir().expect("temp");
        let store = ResearchMemoryV2Store::new(root.path().join("v2.sqlite"));
        let mut item = capture();
        item.user_text = "实验必须保留完整来源。".to_string();
        store.enqueue_capture(&item).expect("enqueue");
        let queued = store.due_outbox(1).expect("due").pop().expect("item");
        let ids = store
            .record_extractions(
                &queued,
                &[ResearchMemoryV2Extraction {
                    source: "user".to_string(),
                    source_quote: "实验必须保留完整来源".to_string(),
                    statement: "实验必须保留完整来源".to_string(),
                    kind: "constraint".to_string(),
                    subject: "constraint".to_string(),
                    target_layer: ResearchMemoryV2Layer::R2,
                    scope: "project".to_string(),
                    ttl_days: None,
                    reason: "durable project constraint".to_string(),
                }],
                "extractor",
            )
            .expect("extract");
        let atom = store
            .stage_promotion_for_remote(
                &ids[0],
                &ResearchMemoryV2Promotion {
                    accept: true,
                    target_layer: ResearchMemoryV2Layer::R2,
                    reason: "accepted".to_string(),
                },
                "reviewer",
            )
            .expect("stage")
            .expect("atom");
        assert_eq!(atom.status, "remote_pending");
        assert!(store
            .recall_local("project-a", "chat-a", "完整来源", 5)
            .expect("not injected")
            .is_empty());
        assert!(store.activate_remote_r2(&atom.id).expect("activate"));
        assert_eq!(
            store
                .recall_local("project-a", "chat-a", "完整来源", 5)
                .expect("visible")
                .len(),
            1
        );
    }
}
