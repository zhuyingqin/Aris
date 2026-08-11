use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    epoch_secs_now, iso8601_from_epoch_secs, now_iso8601, somniq_project_dir, write_file_atomically,
};

pub const REVIEW_WORKFLOW_PROTOCOL_VERSION: u32 = 1;
pub const REVIEW_WORKFLOW_TEMPLATE_ID: &str = "review-paper-from-topic";
pub const REVIEW_WORKFLOW_TEMPLATE_VERSION: u32 = 3;
pub const DEFAULT_PRIMARY_TARGET_RESULTS: u32 = 500;

const WORKFLOW_DIR: &str = "workflows/review-paper-v1";
const MAX_EVENTS: usize = 500;

/// Legacy sentinel `reviewer_gate.reviewer` value written by an older,
/// deterministic coverage-target backfill, before `primary-library` required a
/// real independent Reviewer. Never written by current code — kept only so a
/// verdict stamped by that old validator is never read back as a genuine
/// Reviewer approval. Mirrored as a literal string in
/// `desktop/src/workflows/workflowPersistence.ts` (`migratePreviewRun`), which
/// cannot import a Rust constant; keep both in sync by hand.
const LEGACY_COVERAGE_TARGET_VALIDATOR_REVIEWER: &str = "Coverage target validator";

const fn default_primary_target_results() -> u32 {
    DEFAULT_PRIMARY_TARGET_RESULTS
}

/// Only high-value papers contribute to the review outline. Lower-priority
/// grades remain in the durable grading audit, but do not enter section mapping.
pub fn is_outline_mapped_grade(grade: &str) -> bool {
    grade.trim().eq_ignore_ascii_case("A") || grade.trim().eq_ignore_ascii_case("B")
}

fn has_assigned_outline_section(mapping: &WorkflowPaperMapping) -> bool {
    mapping
        .direct_section_id
        .as_deref()
        .is_some_and(|section_id| !section_id.trim().is_empty())
        || mapping
            .indirect_section_id
            .as_deref()
            .is_some_and(|section_id| !section_id.trim().is_empty())
}

fn workflow_mutation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewWorkflowStatus {
    Draft,
    AwaitingPlanApproval,
    Running,
    WaitingUser,
    RevisionRequired,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScoutAutomationStatus {
    Idle,
    Running,
    Paused,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewWorkflowStageStatus {
    NotStarted,
    Ready,
    InProgress,
    WaitingUser,
    WaitingReviewer,
    RevisionRequired,
    Blocked,
    Partial,
    Passed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewerGateStatus {
    NotRequired,
    Pending,
    Approved,
    Rejected,
    /// The stage ran with independent review switched off. Distinct from
    /// `Approved` on purpose: a stage nobody reviewed must never be able to look
    /// like a stage that passed review.
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewCountBranch {
    Unknown,
    Insufficient,
    Focused,
    Broad,
}

impl Default for ReviewCountBranch {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWorkflowCreateInput {
    pub topic: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub databases: Vec<String>,
    pub year_from: i32,
    pub year_to: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSearchQuery {
    pub id: String,
    pub source: String,
    pub kind: String,
    pub language: String,
    pub query: String,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSearchPlan {
    #[serde(default)]
    pub queries: Vec<ReviewSearchQuery>,
    #[serde(default)]
    pub inclusion_criteria: Vec<String>,
    #[serde(default)]
    pub exclusion_criteria: Vec<String>,
    pub generated_by: String,
    pub generated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowContextPolicy {
    pub abstract_batch_size: u32,
    pub abstract_chars_per_record: u32,
    pub synthesis_input_chars: u32,
    pub full_text_strategy: String,
}

impl Default for WorkflowContextPolicy {
    fn default() -> Self {
        Self {
            abstract_batch_size: 50,
            abstract_chars_per_record: 2_400,
            synthesis_input_chars: 60_000,
            full_text_strategy: "retrieve_relevant_sections_on_demand".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCoverage {
    pub total_hits: Option<u64>,
    pub fetched: u64,
    pub unique: u64,
    pub exhausted: bool,
    pub next_cursor: Option<String>,
    pub truncated_reason: Option<String>,
    #[serde(default)]
    pub skipped_sources: Vec<String>,
    #[serde(default)]
    pub failed_sources: Vec<String>,
    #[serde(default)]
    pub source_attempts: Vec<WorkflowSourceCoverage>,
}

/// Executor-produced, server-validated first-pass allocation for Stage 09's
/// four matrix paths. The allocation is kept with the workflow so the
/// protocol, preview and later audit all describe the same decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryPathAllocation {
    pub id: String,
    pub max_results: u32,
    pub rationale: String,
}

/// How one Stage 09 matrix path spent its corpus quota.
///
/// `candidate_record_ids` is everything retrieval attributed to the path,
/// `admitted_record_ids` is the quality-ranked prefix that fits the quota, and
/// `deferred_record_ids` is the auditable remainder. A deferred record is
/// retained and reportable, never silently dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryPathAdmission {
    pub path_id: String,
    pub quota: u32,
    #[serde(default)]
    pub candidate_record_ids: Vec<String>,
    #[serde(default)]
    pub admitted_record_ids: Vec<String>,
    #[serde(default)]
    pub deferred_record_ids: Vec<String>,
    /// Set when the path admitted fewer records than its quota, explaining why.
    #[serde(default)]
    pub shortfall_reason: Option<String>,
    pub selected_at: String,
    pub method: String,
}

/// Per-candidate relevance evidence behind one admission decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryCandidateScore {
    pub record_id: String,
    pub path_id: String,
    #[serde(default)]
    pub relevant: bool,
    /// Legacy Stage 09 runs stored A/B/C/D here. New runs leave it empty;
    /// formal grading belongs to `paper_grades`.
    #[serde(default)]
    pub grade: String,
    #[serde(default)]
    pub key_finding: String,
    #[serde(default)]
    pub rationale: String,
    /// Bibliometric tie-breakers, recorded so the ordering stays reproducible.
    #[serde(default)]
    pub citation_count: Option<u64>,
    #[serde(default)]
    pub year: Option<u32>,
    #[serde(default)]
    pub admitted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSourceCoverage {
    pub source: String,
    pub status: String,
    pub total_hits: Option<u64>,
    pub fetched: u64,
    pub unique: u64,
    pub exhausted: bool,
    pub next_cursor: Option<String>,
    pub truncated_reason: Option<String>,
    pub failure_message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEligibilitySummary {
    #[serde(default)]
    pub candidate_record_ids: Vec<String>,
    #[serde(default)]
    pub eligible_record_ids: Vec<String>,
    #[serde(default)]
    pub excluded_record_ids: Vec<String>,
    #[serde(default)]
    pub missing_abstract_record_ids: Vec<String>,
    pub complete: bool,
    pub method: String,
    pub screened_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDirection {
    pub id: String,
    pub title: String,
    pub gap: String,
    pub outline: String,
    pub workload: String,
    pub difficulty: String,
    pub feasibility: String,
    #[serde(default)]
    pub evidence_record_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLandscapeAnalysis {
    pub development_status: String,
    #[serde(default)]
    pub major_problems: Vec<String>,
    #[serde(default)]
    pub newcomer_notes: Vec<String>,
    #[serde(default)]
    pub temporal_trends: Vec<String>,
    #[serde(default)]
    pub topic_evolution: Vec<String>,
    #[serde(default)]
    pub review_gaps: Vec<String>,
    #[serde(default)]
    pub directions: Vec<ReviewDirection>,
    pub generated_at: String,
    pub generated_by: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixConcept {
    pub role: String,
    pub entity: String,
    pub rationale: String,
    #[serde(default)]
    pub terms: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixSearchPath {
    pub id: String,
    pub combination: String,
    pub target: String,
    pub strategic_intent: String,
    pub query: String,
    pub action_guide: String,
    pub expected_results: String,
    pub review_value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixSearchStrategy {
    pub mode: String,
    #[serde(default)]
    pub concepts: Vec<MatrixConcept>,
    #[serde(default)]
    pub paths: Vec<MatrixSearchPath>,
    pub exclusion_advice: String,
    pub exclusion_query: Option<String>,
    #[serde(default)]
    pub syntax_checks: Vec<String>,
    pub generated_at: String,
    pub generated_by: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryQualityIteration {
    pub id: String,
    pub iteration: u32,
    pub path_id: String,
    pub query: String,
    #[serde(default)]
    pub sample_record_ids: Vec<String>,
    pub sample_size: u32,
    pub relevant_count: u32,
    pub low_relevance_count: u32,
    pub estimated_precision: f32,
    #[serde(default)]
    pub false_positive_patterns: Vec<String>,
    #[serde(default)]
    pub adjustment_directions: Vec<String>,
    pub recommendation: String,
    #[serde(default)]
    pub reviewer_status: Option<ReviewerGateStatus>,
    #[serde(default)]
    pub reviewer_summary: Option<String>,
    #[serde(default)]
    pub reviewer_issues: Vec<String>,
    #[serde(default)]
    pub quality_issues: Vec<String>,
    pub reviewer_approved: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPaperGrade {
    pub record_id: String,
    pub original_index: u32,
    pub grade: String,
    pub key_finding: String,
    pub rationale: String,
    pub method: String,
}

/// A durable, evidence-linked theme constructed before the final review outline.
/// Keeping it separate from the outline makes the clustering inspectable and
/// reusable when a user asks the Executor to regenerate the writing structure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowOutlineCluster {
    pub id: String,
    pub title: String,
    pub claim: String,
    #[serde(default)]
    pub record_ids: Vec<String>,
    #[serde(default)]
    pub evidence_gaps: Vec<String>,
    #[serde(default)]
    pub contested: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowOutlineSection {
    pub id: String,
    pub title: String,
    pub purpose: String,
    /// Evidence links are part of the outline itself, not transient UI data.
    /// Keeping them in the canonical Rust model lets an edited outline retain
    /// and audit the papers that justify each leaf section.
    #[serde(default)]
    pub record_ids: Vec<String>,
    #[serde(default)]
    pub children: Vec<WorkflowOutlineSection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPaperMapping {
    pub record_id: String,
    pub original_index: u32,
    pub zotero_locator: String,
    pub direct_section_id: Option<String>,
    pub indirect_section_id: Option<String>,
    pub contribution: String,
}

/// Resumable progress for a batched model job (eligibility screening, landscape
/// digests, primary-library selection, A/B/C/D grading, outline mapping).
///
/// Batched stages run tens to hundreds of sequential model calls, and their
/// per-batch validation is deliberately strict, so a single malformed batch used
/// to discard every batch before it. The checkpoint keeps finished batches on
/// disk while the job is still running.
///
/// `partial` is kind-specific and intentionally staged here rather than written
/// straight into `paper_grades` / `paper_mappings`: those canonical fields carry
/// one-to-one coverage invariants that a half-finished job would violate. The
/// checkpoint is merged into them only when `completed_batches == total_batches`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowBatchCheckpoint {
    /// One of `BATCH_CHECKPOINT_KINDS`.
    pub kind: String,
    pub stage_id: String,
    /// Digest of the ordered input record ids plus the batch policy. A resume
    /// whose inputs no longer match this digest is discarded, never merged.
    pub input_fingerprint: String,
    pub batch_size: usize,
    pub completed_batches: usize,
    pub total_batches: usize,
    #[serde(default)]
    pub partial: Value,
    pub updated_at: String,
}

const BATCH_CHECKPOINT_KINDS: [&str; 7] = [
    "eligibility",
    "landscape",
    "primary-select",
    "grading",
    "mapping",
    "outline",
    "query_quality",
];

/// Action whose consecutive events collapse into one. Per-batch checkpoints save
/// on every batch by design; without this a long grading run would push every
/// other event out of the activity log.
const COALESCING_ACTION: &str = "batch_checkpoint";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewerGate {
    pub required: bool,
    pub status: ReviewerGateStatus,
    pub reviewer: Option<String>,
    pub summary: Option<String>,
    #[serde(default)]
    pub issues: Vec<String>,
    pub reviewed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWorkflowStage {
    pub id: String,
    pub ordinal: u32,
    pub title: String,
    pub description: String,
    pub status: ReviewWorkflowStageStatus,
    pub reviewer_gate: ReviewerGate,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowArtifact {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub uri: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEvent {
    pub sequence: u64,
    pub timestamp: String,
    pub actor: String,
    pub action: String,
    pub summary: String,
    pub stage_id: Option<String>,
}

/// One finished executor/reviewer call. The event log records that a stage
/// happened; this records what the model was actually asked to produce and
/// what came back, so a finished stage can still be reviewed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowActivityEntry {
    pub id: String,
    pub stage_id: String,
    pub actor: String,
    pub title: String,
    #[serde(default)]
    pub model: Option<String>,
    pub status: WorkflowActivityStatus,
    #[serde(default)]
    pub detail: Option<String>,
    pub started_at: String,
    pub completed_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowActivityStatus {
    Completed,
    Failed,
}

/// Exclusive right to drive one run, held by a single controller loop.
///
/// A run advances by appending turns to one durable session, so two controllers
/// on the same run would interleave into one transcript and race each other's
/// optimistic writes. The lease makes a second start fail fast instead. It is
/// advisory only in the sense that an *expired* lease may be taken over — a
/// crashed app must not leave a run permanently unstartable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLease {
    /// Identifies the controller turn holding the lease, so the activity log can
    /// be matched against the loop that produced it after a crash.
    pub owner_turn_id: String,
    pub acquired_at: String,
    pub expires_at: String,
}

/// How long a freshly taken lease stays valid without being refreshed.
///
/// Every checkpoint save refreshes it, so the window only has to outlast a
/// single batch. Long enough that a slow model call cannot orphan a live job,
/// short enough that a crashed one frees the run within a couple of minutes.
pub const RUN_LEASE_TTL_SECS: u64 = 600;

impl RunLease {
    /// Whether the lease has lapsed and may be taken over.
    ///
    /// Both timestamps come from [`iso8601_from_epoch_secs`], whose fixed-width
    /// UTC form orders correctly as plain strings.
    #[must_use]
    pub fn is_expired(&self, now: &str) -> bool {
        now >= self.expires_at.as_str()
    }

    fn new(owner_turn_id: String, ttl_secs: u64) -> Self {
        let now = epoch_secs_now();
        Self {
            owner_turn_id,
            acquired_at: iso8601_from_epoch_secs(now),
            expires_at: iso8601_from_epoch_secs(now.saturating_add(ttl_secs)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWorkflowRun {
    pub protocol_version: u32,
    pub id: String,
    pub template_id: String,
    pub template_version: u32,
    pub revision: u64,
    /// Durable chat session carrying this run's conversation.
    ///
    /// The same id the desktop `ChatState` and the Chat UI use, so the workflow
    /// is one continuous conversation rather than a series of one-shot prompts
    /// with a snapshot pasted into a separate chat. Assigned once at creation;
    /// changing it would orphan the transcript.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Held while a controller loop is driving this run. See [`RunLease`].
    #[serde(default)]
    pub lease: Option<RunLease>,
    pub title: String,
    pub topic: String,
    pub keywords: Vec<String>,
    pub languages: Vec<String>,
    pub databases: Vec<String>,
    pub year_from: i32,
    pub year_to: i32,
    /// Optional verified executor selected for this workflow run. Keeping the
    /// selection with the run makes later planning and evidence steps auditable.
    #[serde(default)]
    pub executor_model: Option<String>,
    /// Switches off the separate reviewer model for this run. Gate stages record
    /// `Skipped` instead of `Approved`, and the classification steps that
    /// normally run on the reviewer fall back to the executor.
    #[serde(default)]
    pub reviewer_disabled: bool,
    #[serde(default)]
    pub context_policy: WorkflowContextPolicy,
    pub status: ReviewWorkflowStatus,
    pub active_stage_id: String,
    pub plan_approved: bool,
    /// Persisted controller state for the user-facing review reconnaissance step.
    #[serde(default)]
    pub scout_automation_status: Option<ScoutAutomationStatus>,
    #[serde(default)]
    pub scout_pause_reason: Option<String>,
    #[serde(default)]
    pub scout_revision_limit: Option<u32>,
    #[serde(default = "default_search_iteration")]
    pub review_search_iteration: u32,
    #[serde(default)]
    pub search_revision_reason: Option<String>,
    #[serde(default)]
    pub previous_eligible_review_count: Option<u64>,
    pub search_plan: Option<ReviewSearchPlan>,
    pub search_protocol_id: Option<String>,
    pub search_run_id: Option<String>,
    #[serde(default)]
    pub search_record_ids: Vec<String>,
    pub coverage: Option<WorkflowCoverage>,
    #[serde(default)]
    pub review_eligibility: ReviewEligibilitySummary,
    #[serde(default)]
    pub review_count_branch: ReviewCountBranch,
    #[serde(default)]
    pub landscape_analysis: Option<ReviewLandscapeAnalysis>,
    #[serde(default)]
    pub selected_direction_id: Option<String>,
    #[serde(default)]
    pub matrix_strategy: Option<MatrixSearchStrategy>,
    #[serde(default)]
    pub matrix_plan_approved: bool,
    #[serde(default)]
    pub matrix_search_protocol_id: Option<String>,
    #[serde(default)]
    pub matrix_search_run_id: Option<String>,
    #[serde(default)]
    pub matrix_search_path_id: Option<String>,
    #[serde(default)]
    pub matrix_record_ids: Vec<String>,
    #[serde(default)]
    pub matrix_coverage: Option<WorkflowCoverage>,
    #[serde(default)]
    pub query_quality_iterations: Vec<QueryQualityIteration>,
    #[serde(default)]
    pub primary_search_protocol_id: Option<String>,
    #[serde(default)]
    pub primary_search_run_id: Option<String>,
    /// User-approved external retrieval budget. Deduplication and binary
    /// relevance screening may produce a smaller admitted corpus.
    #[serde(default = "default_primary_target_results")]
    pub primary_target_results: u32,
    #[serde(default)]
    pub primary_path_allocations: Vec<PrimaryPathAllocation>,
    /// Everything retrieval attributed to each matrix path, keyed by path id.
    /// Retrieval fills these; binary screening turns them into admissions.
    ///
    /// Durable because the pool is accumulated across several bounded provider
    /// passes. Dropping it on save would restart every continuation from an
    /// empty pool while the provider cursors kept advancing, so the pool could
    /// never fill and the paths already read to exhaustion would never be read
    /// again.
    #[serde(default)]
    pub primary_path_candidates: std::collections::BTreeMap<String, Vec<String>>,
    /// Quota spend per matrix path. `primary_record_ids` is its admitted union.
    #[serde(default)]
    pub primary_path_admissions: Vec<PrimaryPathAdmission>,
    /// Audit trail for the binary screening that produced the admissions.
    #[serde(default)]
    pub primary_candidate_scores: Vec<PrimaryCandidateScore>,
    #[serde(default)]
    pub primary_record_ids: Vec<String>,
    #[serde(default)]
    pub primary_coverage: Option<WorkflowCoverage>,
    #[serde(default)]
    pub paper_grades: Vec<WorkflowPaperGrade>,
    #[serde(default)]
    pub outline_clusters: Vec<WorkflowOutlineCluster>,
    /// Identity of the graded A/B corpus used to construct `outline_clusters`.
    /// An upstream grading change invalidates the clusters rather than silently
    /// reusing them for a different evidence set.
    #[serde(default)]
    pub outline_cluster_fingerprint: Option<String>,
    #[serde(default)]
    pub outline: Vec<WorkflowOutlineSection>,
    #[serde(default)]
    pub paper_mappings: Vec<WorkflowPaperMapping>,
    /// In-flight batched model job, if any. Present only while a job is
    /// unfinished; completing or restarting a job clears it.
    #[serde(default)]
    pub batch_checkpoint: Option<WorkflowBatchCheckpoint>,
    pub stages: Vec<ReviewWorkflowStage>,
    #[serde(default)]
    pub artifacts: Vec<WorkflowArtifact>,
    #[serde(default)]
    pub events: Vec<WorkflowEvent>,
    /// Durable transcript of the model calls behind each stage. Bounded by the
    /// caller; the store keeps whatever it is handed.
    #[serde(default)]
    pub activity_log: Vec<WorkflowActivityEntry>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWorkflowSaveInput {
    pub expected_revision: u64,
    pub run: ReviewWorkflowRun,
    pub actor: String,
    pub action: String,
    pub summary: String,
    pub stage_id: Option<String>,
    /// Proof that this writer holds the run's lease, when one is held.
    ///
    /// Deliberately out-of-band rather than read off `run.lease`: any writer
    /// that loads the run gets the lease in the payload for free, so echoing it
    /// back proves nothing. A caller has to know the owner id it was issued.
    #[serde(default)]
    pub lease_owner_turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWorkflowSummary {
    pub id: String,
    pub title: String,
    pub topic: String,
    pub status: ReviewWorkflowStatus,
    pub active_stage_id: String,
    pub revision: u64,
    pub updated_at: String,
}

pub fn review_workflow_dir(workspace: &Path) -> PathBuf {
    somniq_project_dir(workspace).join(WORKFLOW_DIR)
}

/// The chat session id that carries a run's conversation.
///
/// Derived from the run id rather than allocated separately so a run whose
/// `session_id` predates this field — or was lost to a partial write — resolves
/// to the same transcript instead of silently starting a second one.
#[must_use]
pub fn workflow_session_id(run_id: &str) -> String {
    format!("wf-{run_id}")
}

pub fn create_review_workflow(
    workspace: &Path,
    input: ReviewWorkflowCreateInput,
) -> Result<ReviewWorkflowRun, String> {
    let topic = clean_required(&input.topic, 600, "review topic")?;
    if input.year_from < 1900 || input.year_to < input.year_from || input.year_to > 2200 {
        return Err("review workflow year range is invalid".to_string());
    }
    let now = now_iso8601();
    let id = new_run_id();
    let mut run = ReviewWorkflowRun {
        protocol_version: REVIEW_WORKFLOW_PROTOCOL_VERSION,
        session_id: Some(workflow_session_id(&id)),
        lease: None,
        id,
        template_id: REVIEW_WORKFLOW_TEMPLATE_ID.to_string(),
        template_version: REVIEW_WORKFLOW_TEMPLATE_VERSION,
        revision: 1,
        title: format!("综述：{topic}"),
        topic,
        keywords: clean_list(input.keywords, 40, 120),
        languages: clean_list_or_default(input.languages, 8, 40, &["中文", "English"]),
        databases: clean_list_or_default(
            input.databases,
            12,
            80,
            &["scopus", "openalex", "semantic-scholar", "crossref"],
        ),
        year_from: input.year_from,
        year_to: input.year_to,
        executor_model: None,
        reviewer_disabled: false,
        context_policy: WorkflowContextPolicy::default(),
        status: ReviewWorkflowStatus::Draft,
        active_stage_id: "scope-and-plan".to_string(),
        plan_approved: false,
        scout_automation_status: Some(ScoutAutomationStatus::Idle),
        scout_pause_reason: None,
        scout_revision_limit: Some(4),
        review_search_iteration: 1,
        search_revision_reason: None,
        previous_eligible_review_count: None,
        search_plan: None,
        search_protocol_id: None,
        search_run_id: None,
        search_record_ids: Vec::new(),
        coverage: None,
        review_eligibility: ReviewEligibilitySummary::default(),
        review_count_branch: ReviewCountBranch::Unknown,
        landscape_analysis: None,
        selected_direction_id: None,
        matrix_strategy: None,
        matrix_plan_approved: false,
        matrix_search_protocol_id: None,
        matrix_search_run_id: None,
        matrix_search_path_id: None,
        matrix_record_ids: Vec::new(),
        matrix_coverage: None,
        query_quality_iterations: Vec::new(),
        primary_search_protocol_id: None,
        primary_search_run_id: None,
        primary_target_results: DEFAULT_PRIMARY_TARGET_RESULTS,
        primary_path_allocations: Vec::new(),
        primary_path_candidates: std::collections::BTreeMap::new(),
        primary_path_admissions: Vec::new(),
        primary_candidate_scores: Vec::new(),
        primary_record_ids: Vec::new(),
        primary_coverage: None,
        paper_grades: Vec::new(),
        outline_clusters: Vec::new(),
        outline_cluster_fingerprint: None,
        outline: Vec::new(),
        paper_mappings: Vec::new(),
        batch_checkpoint: None,
        stages: default_review_stages(),
        artifacts: Vec::new(),
        events: Vec::new(),
        activity_log: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
    };
    append_event(
        &mut run,
        "user",
        "workflow_created",
        "创建“从主题到可投稿综述论文”工作流。",
        Some("scope-and-plan"),
    );
    save_run(workspace, &run)?;
    Ok(run)
}

pub fn list_review_workflows(workspace: &Path) -> Result<Vec<ReviewWorkflowSummary>, String> {
    let directory = review_workflow_dir(workspace);
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut summaries = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read_to_string(entry.path()).map_err(|error| error.to_string())?;
        let run: ReviewWorkflowRun = serde_json::from_str(&raw).map_err(|error| {
            format!(
                "invalid review workflow {}: {error}",
                entry.path().display()
            )
        })?;
        let run = migrate_run(run)?;
        summaries.push(ReviewWorkflowSummary {
            id: run.id,
            title: run.title,
            topic: run.topic,
            status: run.status,
            active_stage_id: run.active_stage_id,
            revision: run.revision,
            updated_at: run.updated_at,
        });
    }
    summaries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(summaries)
}

pub fn load_review_workflow(
    workspace: &Path,
    id: &str,
) -> Result<Option<ReviewWorkflowRun>, String> {
    validate_id(id)?;
    let path = run_path(workspace, id);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let run = serde_json::from_str::<ReviewWorkflowRun>(&raw)
        .map_err(|error| format!("invalid review workflow at {}: {error}", path.display()))?;
    let run = migrate_run(run)?;
    validate_run_shape(&run)?;
    Ok(Some(run))
}

pub fn rename_review_workflow(
    workspace: &Path,
    id: &str,
    title: &str,
) -> Result<ReviewWorkflowRun, String> {
    let _guard = workflow_mutation_lock()
        .lock()
        .map_err(|_| "review workflow mutation lock poisoned".to_string())?;
    let mut run = load_review_workflow(workspace, id)?
        .ok_or_else(|| "review workflow not found".to_string())?;
    if run
        .lease
        .as_ref()
        .is_some_and(|lease| !lease.is_expired(&now_iso8601()))
    {
        return Err("cannot rename a review workflow while it has a live run lease".to_string());
    }
    run.title = clean_required(title, 240, "workflow title")?;
    run.revision += 1;
    run.updated_at = now_iso8601();
    let stage_id = run.active_stage_id.clone();
    append_event(
        &mut run,
        "user",
        "workflow_renamed",
        "用户更新了工作流名称。",
        Some(&stage_id),
    );
    save_run(workspace, &run)?;
    Ok(run)
}

pub fn delete_review_workflow(workspace: &Path, id: &str) -> Result<(), String> {
    let _guard = workflow_mutation_lock()
        .lock()
        .map_err(|_| "review workflow mutation lock poisoned".to_string())?;
    validate_id(id)?;
    let path = run_path(workspace, id);
    if !path.is_file() {
        return Err("review workflow not found".to_string());
    }
    if let Some(run) = load_review_workflow(workspace, id)? {
        if run
            .lease
            .as_ref()
            .is_some_and(|lease| !lease.is_expired(&now_iso8601()))
        {
            return Err(
                "cannot delete a review workflow while it has a live run lease".to_string(),
            );
        }
    }
    fs::remove_file(&path).map_err(|error| error.to_string())
}

/// Takes exclusive control of a run for one batched job or controller loop.
///
/// Fails when another owner still holds a live lease. An expired lease may be
/// taken over: an app that was killed mid-job must not leave the run
/// permanently unstartable.
pub fn acquire_run_lease(
    workspace: &Path,
    id: &str,
    owner_turn_id: &str,
    ttl_secs: u64,
) -> Result<ReviewWorkflowRun, String> {
    let _guard = workflow_mutation_lock()
        .lock()
        .map_err(|_| "review workflow mutation lock poisoned".to_string())?;
    let owner_turn_id = clean_required(owner_turn_id, 120, "lease owner")?;
    let mut run = load_review_workflow(workspace, id)?
        .ok_or_else(|| "review workflow not found".to_string())?;
    let now = now_iso8601();
    if let Some(existing) = run.lease.as_ref() {
        if existing.owner_turn_id != owner_turn_id && !existing.is_expired(&now) {
            return Err(format!(
                "review workflow is already running under lease `{}` until {}",
                existing.owner_turn_id, existing.expires_at
            ));
        }
    }
    run.lease = Some(RunLease::new(owner_turn_id, ttl_secs));
    run.revision += 1;
    run.updated_at = now;
    save_run(workspace, &run)?;
    Ok(run)
}

/// Gives up a lease so the run can be started again immediately.
///
/// A lease held by somebody else is left alone rather than reported as an
/// error: releasing is cleanup, and cleanup that fails loudly on an already
/// taken-over run only produces noise in the path that was already recovering.
pub fn release_run_lease(
    workspace: &Path,
    id: &str,
    owner_turn_id: &str,
) -> Result<ReviewWorkflowRun, String> {
    let _guard = workflow_mutation_lock()
        .lock()
        .map_err(|_| "review workflow mutation lock poisoned".to_string())?;
    let mut run = load_review_workflow(workspace, id)?
        .ok_or_else(|| "review workflow not found".to_string())?;
    if run
        .lease
        .as_ref()
        .is_none_or(|lease| lease.owner_turn_id != owner_turn_id)
    {
        return Ok(run);
    }
    run.lease = None;
    run.revision += 1;
    run.updated_at = now_iso8601();
    save_run(workspace, &run)?;
    Ok(run)
}

/// Stage 09 is a bounded working corpus. Provider exhaustion is not required
/// once the user-requested deduplicated target has been reached; the remaining
/// cursor is retained for auditability but must not block grading. Binary
/// screening may also settle a path with an explicit shortfall (for example,
/// when every remaining candidate is completely unrelated), so the persistence guard
/// must recognize the same durable completion signal as the desktop UI.
#[must_use]
pub fn primary_library_ready(run: &ReviewWorkflowRun) -> bool {
    let target = usize::try_from(run.primary_target_results).unwrap_or(usize::MAX);
    let target_reached = run.primary_record_ids.len() >= target;
    // An exhausted search with zero admitted records is not a corpus — it is a
    // query that found nothing. Without this guard a narrow query could pass
    // straight to grading with nothing to grade.
    let coverage_exhausted = !run.primary_record_ids.is_empty()
        && run
            .primary_coverage
            .as_ref()
            .is_some_and(|coverage| coverage.exhausted);
    let selection_settled = !run.primary_path_allocations.is_empty()
        && run.primary_path_allocations.iter().all(|allocation| {
            run.primary_path_admissions
                .iter()
                .find(|admission| admission.path_id == allocation.id)
                .is_some_and(|admission| {
                    u32::try_from(admission.admitted_record_ids.len()).unwrap_or(u32::MAX)
                        >= admission.quota
                        || admission.shortfall_reason.is_some()
                })
        });
    target_reached || coverage_exhausted || selection_settled
}

fn validate_primary_path_allocations(run: &ReviewWorkflowRun) -> Result<(), String> {
    if run.primary_path_allocations.is_empty() {
        return Ok(());
    }
    const REQUIRED_PATHS: [&str; 4] = ["abc", "ab", "bc", "ac"];
    if run.primary_path_allocations.len() != REQUIRED_PATHS.len() {
        return Err("primary-library allocation must cover exactly four matrix paths".to_string());
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut total = 0_u32;
    let mut broad_total = 0_u32;
    for allocation in &run.primary_path_allocations {
        if !REQUIRED_PATHS.contains(&allocation.id.as_str())
            || !seen.insert(allocation.id.as_str())
            || allocation.max_results == 0
            || allocation.rationale.trim().is_empty()
        {
            return Err(
                "primary-library allocation requires each canonical path once, with a positive limit and rationale"
                    .to_string(),
            );
        }
        total = total
            .checked_add(allocation.max_results)
            .ok_or_else(|| "primary-library allocation total overflow".to_string())?;
        if matches!(allocation.id.as_str(), "bc" | "ac") {
            broad_total = broad_total
                .checked_add(allocation.max_results)
                .ok_or_else(|| "primary-library broad allocation total overflow".to_string())?;
        }
    }
    if total != run.primary_target_results {
        return Err(format!(
            "primary-library allocation totals {total}, expected {}",
            run.primary_target_results
        ));
    }
    if broad_total > run.primary_target_results / 2 {
        return Err(
            "B+C and A+C allocations cannot dominate the default primary-library corpus"
                .to_string(),
        );
    }
    Ok(())
}

pub fn save_review_workflow(
    workspace: &Path,
    input: ReviewWorkflowSaveInput,
) -> Result<ReviewWorkflowRun, String> {
    let _guard = workflow_mutation_lock()
        .lock()
        .map_err(|_| "review workflow mutation lock poisoned".to_string())?;
    let mut next = input.run;
    let previous = load_review_workflow(workspace, &next.id)?
        .ok_or_else(|| "review workflow not found".to_string())?;
    if input.expected_revision != previous.revision || next.revision != previous.revision {
        return Err(format!(
            "review workflow changed on disk (expected revision {}, current revision {})",
            input.expected_revision, previous.revision
        ));
    }
    // Older clients can legitimately mark the active stage passed without
    // moving the cursor. Advance one stage here, before transition validation
    // and persistence, so Rust remains the only authority for the cursor.
    // A multi-stage repair is reserved for load-time migration: skipping over
    // more than one stage in a fresh write would evade transition validation.
    advance_active_stage_once(&mut next);
    // While a live lease is held, only its owner may write. The optimistic
    // revision alone does not cover this: two batched loops on the same run each
    // read a fresh revision before their next save, so they interleave
    // successfully while staging checkpoints computed from different partial
    // results.
    if let Some(held) = previous.lease.as_ref() {
        if !held.is_expired(&now_iso8601())
            && input.lease_owner_turn_id.as_deref() != Some(held.owner_turn_id.as_str())
        {
            return Err(format!(
                "review workflow is held by lease `{}`; another writer cannot save over it",
                held.owner_turn_id
            ));
        }
    }
    validate_transition(&previous, &next, input.stage_id.as_deref())?;
    // The owner's own save is the heartbeat, so a job that is making progress
    // keeps its lease without a background timer bumping the revision underneath
    // the loop that is tracking it. Refreshed here rather than by the caller so
    // the expiry stays server-owned.
    if let Some(lease) = next.lease.as_mut() {
        lease.expires_at =
            iso8601_from_epoch_secs(epoch_secs_now().saturating_add(RUN_LEASE_TTL_SECS));
    }
    next.revision += 1;
    next.updated_at = now_iso8601();
    append_event(
        &mut next,
        &clean_required(&input.actor, 80, "workflow actor")?,
        &clean_required(&input.action, 100, "workflow action")?,
        &clean_required(&input.summary, 800, "workflow event summary")?,
        input.stage_id.as_deref(),
    );
    save_run(workspace, &next)?;
    Ok(next)
}

#[must_use]
pub fn branch_for_review_count(unique: u64, coverage_exhausted: bool) -> ReviewCountBranch {
    if !coverage_exhausted {
        return ReviewCountBranch::Unknown;
    }
    match unique {
        0..=9 => ReviewCountBranch::Insufficient,
        10..=49 => ReviewCountBranch::Focused,
        _ => ReviewCountBranch::Broad,
    }
}

fn validate_transition(
    previous: &ReviewWorkflowRun,
    next: &ReviewWorkflowRun,
    changed_stage_id: Option<&str>,
) -> Result<(), String> {
    validate_run_shape(next)?;
    if next.protocol_version != previous.protocol_version
        || next.id != previous.id
        || next.template_id != previous.template_id
        || next.template_version != previous.template_version
        || next.created_at != previous.created_at
    {
        return Err("immutable review workflow identity fields changed".to_string());
    }
    // Repointing a live run at another session would orphan its transcript, and
    // the run would look continuous while having lost everything it decided.
    if previous.session_id.is_some() && next.session_id != previous.session_id {
        return Err("review workflow session cannot be repointed".to_string());
    }
    if next.stages.len() != previous.stages.len()
        || next
            .stages
            .iter()
            .zip(&previous.stages)
            .any(|(left, right)| {
                left.id != right.id
                    || left.ordinal != right.ordinal
                    || left.reviewer_gate.required != right.reviewer_gate.required
            })
    {
        return Err("review workflow stage template cannot be changed by a run update".to_string());
    }
    for stage in &next.stages {
        // A required gate still cannot be waved through: passing needs either a
        // real approval, or an explicit `Skipped` marker that stays visible in
        // the run forever. What is forbidden is looking approved without being
        // reviewed — not choosing to run without a reviewer.
        if stage.status == ReviewWorkflowStageStatus::Passed
            && stage.reviewer_gate.required
            && !matches!(
                stage.reviewer_gate.status,
                ReviewerGateStatus::Approved | ReviewerGateStatus::Skipped
            )
        {
            return Err(format!(
                "stage {} cannot pass before the independent Reviewer approves it",
                stage.id
            ));
        }
        if stage.status == ReviewWorkflowStageStatus::Passed {
            let has_unfinished_predecessor = next.stages.iter().any(|candidate| {
                candidate.ordinal < stage.ordinal
                    && candidate.status != ReviewWorkflowStageStatus::Passed
            });
            if has_unfinished_predecessor {
                return Err(format!(
                    "stage {} cannot pass before all predecessor stages pass",
                    stage.id
                ));
            }
        }
    }
    let previous_active = previous
        .stages
        .iter()
        .find(|stage| stage.id == previous.active_stage_id)
        .ok_or_else(|| "previous active review workflow stage does not exist".to_string())?;
    let next_active = next
        .stages
        .iter()
        .find(|stage| stage.id == next.active_stage_id)
        .ok_or_else(|| "next active review workflow stage does not exist".to_string())?;
    if let Some(changed_stage_id) = changed_stage_id {
        if !next.stages.iter().any(|stage| stage.id == changed_stage_id) {
            return Err(format!(
                "unknown changed review workflow stage `{changed_stage_id}`"
            ));
        }
    }
    if next_active.ordinal > previous_active.ordinal {
        let next_previous_active = next
            .stages
            .iter()
            .find(|stage| stage.id == previous_active.id)
            .ok_or_else(|| {
                "previous active review workflow stage does not exist in next state".to_string()
            })?;
        if next_previous_active.status != ReviewWorkflowStageStatus::Passed {
            return Err(format!(
                "workflow cannot advance past active stage {} before it passes",
                previous_active.id
            ));
        }
        if next_active.ordinal != previous_active.ordinal + 1 {
            return Err("workflow may advance only to the immediately following stage".to_string());
        }
    } else if next_active.ordinal < previous_active.ordinal {
        // Revisions are allowed, but the caller must leave the downstream
        // stages non-passed. This prevents a stale later artifact from making
        // a reopened upstream stage look complete.
        if next.stages.iter().any(|stage| {
            stage.ordinal > next_active.ordinal && stage.status == ReviewWorkflowStageStatus::Passed
        }) {
            return Err(
                "reopening an upstream stage requires clearing all passed downstream stages"
                    .to_string(),
            );
        }
    }
    if let Some(primary) = next
        .stages
        .iter()
        .find(|stage| stage.id == "primary-library")
    {
        if primary.status == ReviewWorkflowStageStatus::Passed && !primary_library_ready(next) {
            return Err(
                "primary-library cannot pass before its target is reached or coverage is exhausted"
                    .to_string(),
            );
        }
        if primary.status == ReviewWorkflowStageStatus::Passed
            && primary.reviewer_gate.required
            && primary.reviewer_gate.reviewer.as_deref()
                == Some(LEGACY_COVERAGE_TARGET_VALIDATOR_REVIEWER)
        {
            return Err(
                "primary-library cannot claim independent Reviewer approval from a deterministic target validator"
                    .to_string(),
            );
        }
    }
    if next.review_count_branch != ReviewCountBranch::Unknown {
        if !next
            .coverage
            .as_ref()
            .is_some_and(|coverage| coverage.exhausted)
        {
            return Err(
                "review-count branching requires exhausted search coverage; partial search is not complete"
                    .to_string(),
            );
        }
        if !next.review_eligibility.complete {
            return Err(
                "review-count branching requires completed review-eligibility screening"
                    .to_string(),
            );
        }
        let eligible =
            u64::try_from(next.review_eligibility.eligible_record_ids.len()).unwrap_or(u64::MAX);
        if branch_for_review_count(eligible, true) != next.review_count_branch {
            return Err(
                "review-count branch must be calculated from eligible recent review papers"
                    .to_string(),
            );
        }
    }
    if let Some(selected) = next.selected_direction_id.as_deref() {
        if !next
            .landscape_analysis
            .as_ref()
            .is_some_and(|analysis| analysis.directions.iter().any(|item| item.id == selected))
        {
            return Err("selected review direction does not exist".to_string());
        }
    }
    if next.matrix_plan_approved && next.matrix_strategy.is_none() {
        return Err("matrix search strategy cannot be approved before it exists".to_string());
    }
    validate_active_stage_progress(next)?;
    Ok(())
}

fn validate_active_stage_progress(run: &ReviewWorkflowRun) -> Result<(), String> {
    let Some(active) = run
        .stages
        .iter()
        .find(|stage| stage.id == run.active_stage_id)
    else {
        return Err("active review workflow stage does not exist".to_string());
    };
    if active.status == ReviewWorkflowStageStatus::Passed
        && run.stages.iter().any(|stage| {
            stage.ordinal > active.ordinal && stage.status != ReviewWorkflowStageStatus::Passed
        })
    {
        return Err(
            "active review workflow stage is already passed while a downstream stage remains unfinished"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_run_shape(run: &ReviewWorkflowRun) -> Result<(), String> {
    validate_id(&run.id)?;
    if run.protocol_version != REVIEW_WORKFLOW_PROTOCOL_VERSION
        || run.template_id != REVIEW_WORKFLOW_TEMPLATE_ID
        || run.template_version != REVIEW_WORKFLOW_TEMPLATE_VERSION
    {
        return Err("unsupported review workflow protocol or template version".to_string());
    }
    if !run
        .stages
        .iter()
        .any(|stage| stage.id == run.active_stage_id)
    {
        return Err("active review workflow stage does not exist".to_string());
    }
    if !(50..=10_000).contains(&run.primary_target_results) {
        return Err("primary-library target must be between 50 and 10000".to_string());
    }
    validate_primary_path_allocations(run)?;
    if run.landscape_analysis.is_some()
        && !matches!(
            run.review_count_branch,
            ReviewCountBranch::Focused | ReviewCountBranch::Broad
        )
    {
        return Err(
            "landscape analysis requires an approved focused or broad review-count branch"
                .to_string(),
        );
    }
    if run.matrix_strategy.is_some() && run.selected_direction_id.is_none() {
        return Err("matrix strategy requires a selected review direction".to_string());
    }
    if !run.query_quality_iterations.is_empty() && run.matrix_strategy.is_none() {
        return Err("query-quality iterations require a matrix strategy".to_string());
    }
    let primary_ids = run
        .primary_record_ids
        .iter()
        .collect::<std::collections::BTreeSet<_>>();
    let grade_ids = run
        .paper_grades
        .iter()
        .map(|grade| &grade.record_id)
        .collect::<std::collections::BTreeSet<_>>();
    if grade_ids.len() != run.paper_grades.len()
        || !grade_ids
            .iter()
            .all(|record_id| primary_ids.contains(record_id))
    {
        return Err(
            "paper grades must be unique and reference primary-library records".to_string(),
        );
    }
    let ab_grade_ids = run
        .paper_grades
        .iter()
        .filter(|grade| is_outline_mapped_grade(&grade.grade))
        .map(|grade| &grade.record_id)
        .collect::<std::collections::BTreeSet<_>>();
    let cluster_ids = run
        .outline_clusters
        .iter()
        .map(|cluster| &cluster.id)
        .collect::<std::collections::BTreeSet<_>>();
    if cluster_ids.len() != run.outline_clusters.len()
        || run.outline_clusters.iter().any(|cluster| {
            cluster.id.trim().is_empty()
                || cluster.title.trim().is_empty()
                || cluster.claim.trim().is_empty()
                || cluster.record_ids.is_empty()
                || cluster
                    .record_ids
                    .iter()
                    .any(|record_id| !ab_grade_ids.contains(record_id))
        })
    {
        return Err(
            "outline clusters must be uniquely named, evidence-linked, and only reference A/B grades"
                .to_string(),
        );
    }
    if run.outline_clusters.is_empty() != run.outline_cluster_fingerprint.is_none() {
        return Err(
            "outline cluster fingerprint must exist exactly when clusters exist".to_string(),
        );
    }
    let mapping_ids = run
        .paper_mappings
        .iter()
        .map(|mapping| &mapping.record_id)
        .collect::<std::collections::BTreeSet<_>>();
    if mapping_ids.len() != run.paper_mappings.len()
        || run.paper_mappings.iter().any(|mapping| {
            !ab_grade_ids.contains(&mapping.record_id) || !has_assigned_outline_section(mapping)
        })
    {
        return Err(
            "paper mappings must uniquely reference A/B grades and assign at least one outline section"
                .to_string(),
        );
    }
    if let Some(checkpoint) = &run.batch_checkpoint {
        if !BATCH_CHECKPOINT_KINDS.contains(&checkpoint.kind.as_str()) {
            return Err(format!(
                "unknown batch checkpoint kind `{}`",
                checkpoint.kind
            ));
        }
        if !run
            .stages
            .iter()
            .any(|stage| stage.id == checkpoint.stage_id)
        {
            return Err("batch checkpoint references a stage that does not exist".to_string());
        }
        if checkpoint.input_fingerprint.trim().is_empty() {
            return Err("batch checkpoint requires an input fingerprint".to_string());
        }
        if checkpoint.batch_size == 0 || checkpoint.total_batches == 0 {
            return Err("batch checkpoint requires a positive batch and total count".to_string());
        }
        if checkpoint.completed_batches > checkpoint.total_batches {
            return Err(format!(
                "batch checkpoint completed {} of {} batches",
                checkpoint.completed_batches, checkpoint.total_batches
            ));
        }
    }
    Ok(())
}

fn save_run(workspace: &Path, run: &ReviewWorkflowRun) -> Result<(), String> {
    validate_run_shape(run)?;
    let path = run_path(workspace, &run.id);
    let body = serde_json::to_vec_pretty(run).map_err(|error| error.to_string())?;
    write_file_atomically(&path, body).map_err(|error| error.to_string())
}

fn run_path(workspace: &Path, id: &str) -> PathBuf {
    review_workflow_dir(workspace).join(format!("{id}.json"))
}

fn append_event(
    run: &mut ReviewWorkflowRun,
    actor: &str,
    action: &str,
    summary: &str,
    stage_id: Option<&str>,
) {
    let sequence = run.events.last().map_or(1, |event| event.sequence + 1);
    let event = WorkflowEvent {
        sequence,
        timestamp: now_iso8601(),
        actor: clean_text(actor, 80),
        action: clean_text(action, 100),
        summary: clean_text(summary, 800),
        stage_id: stage_id.map(|value| clean_text(value, 100)),
    };
    // Progress events for one batched job collapse onto a single log line; the
    // authoritative batch count lives in `batch_checkpoint`, not in the history.
    let coalesce = event.action == COALESCING_ACTION
        && run.events.last().is_some_and(|last| {
            last.action == event.action
                && last.stage_id == event.stage_id
                && last.actor == event.actor
        });
    if coalesce {
        if let Some(last) = run.events.last_mut() {
            last.timestamp = event.timestamp;
            last.summary = event.summary;
        }
        return;
    }
    run.events.push(event);
    if run.events.len() > MAX_EVENTS {
        run.events.drain(0..run.events.len() - MAX_EVENTS);
    }
}

fn default_review_stages() -> Vec<ReviewWorkflowStage> {
    [
        (
            "scope-and-plan",
            "研究范围与检索计划",
            "澄清主题，生成多语言、宽松、精确、同义词检索式，并由独立 Reviewer 审查。",
            true,
        ),
        (
            "review-landscape-search",
            "近五年综述全量检索",
            "执行可续读检索，直到所有数据源耗尽或明确记录失败、跳过与截断；独立 Reviewer 先审查检索回收质量。",
            true,
        ),
        (
            "review-eligibility",
            "真实综述资格核验",
            "按标题、摘要、文献类型和时间窗分批核验候选记录；只有确认的综述论文进入数量分支。",
            true,
        ),
        (
            "coverage-and-branch",
            "覆盖核验与数量分支",
            "仅对资格核验完成且覆盖已耗尽的真实综述计数；少于 10 篇回到检索审查。",
            true,
        ),
        (
            "gap-analysis",
            "趋势与综述空白",
            "分别完成领域现状、主题演变、空白探索与三个月可行性分析。",
            true,
        ),
        (
            "direction-selection",
            "方向选择与研究问题",
            "由用户从 3–5 个候选中确认方向，并冻结范围、边界和研究问题。",
            false,
        ),
        (
            "matrix-strategy",
            "矩阵式 Scopus 策略",
            "分解 A/B/C 实体、构建完整语义群和四条可执行路径，并完成确定性语法检查与独立审查。",
            true,
        ),
        (
            "query-quality-loop",
            "试检与误检优化循环",
            "按日期抽取前 100 篇含摘要记录，识别误检共性并迭代查询，平衡查全率与查准率。",
            true,
        ),
        (
            "primary-library",
            "高质量原始文献库",
            "使用已批准策略全量检索、续读、去重并保留覆盖状态，形成可审计的核心文献库。",
            true,
        ),
        (
            "batch-grading",
            "A/B/C/D 批量分级",
            "逐篇评估相关性并提取 1–2 句关键发现；完整保留顺序、方法和分批检查点。",
            true,
        ),
        (
            "outline",
            "数据驱动的综述大纲",
            "综合高价值文献的观点、主题和证据密度，生成到 x.x 层级的完整写作大纲。",
            true,
        ),
        (
            "section-mapping",
            "论文到章节映射",
            "把每篇论文映射到直接与间接子章节，并生成一句话核心贡献与应用点。",
            true,
        ),
        (
            "evidence-synthesis",
            "全文证据与综合",
            "按大纲按需读取全文片段，构建证据卡、质量评价、主张边界、图表与可追溯引用。",
            true,
        ),
        (
            "manuscript",
            "证据约束的全文写作",
            "按证据映射大纲逐节写作；每个关键主张链接证据卡和原始文献。",
            true,
        ),
        (
            "independent-review",
            "独立审稿与修订循环",
            "Reviewer 检查覆盖、偏倚、证据、论证、引用和报告规范，Executor 逐轮修订。",
            true,
        ),
        (
            "submission-package",
            "投稿包",
            "导出正文、参考文献、图表、补充材料、方案、筛选日志、清单与投稿信。",
            true,
        ),
    ]
    .into_iter()
    .enumerate()
    .map(
        |(index, (id, title, description, reviewer_required))| ReviewWorkflowStage {
            id: id.to_string(),
            ordinal: u32::try_from(index + 1).unwrap_or(u32::MAX),
            title: title.to_string(),
            description: description.to_string(),
            status: if index == 0 {
                ReviewWorkflowStageStatus::Ready
            } else {
                ReviewWorkflowStageStatus::NotStarted
            },
            reviewer_gate: ReviewerGate {
                required: reviewer_required,
                status: if reviewer_required {
                    ReviewerGateStatus::Pending
                } else {
                    ReviewerGateStatus::NotRequired
                },
                reviewer: None,
                summary: None,
                issues: Vec::new(),
                reviewed_at: None,
            },
            started_at: None,
            completed_at: None,
            summary: None,
        },
    )
    .collect()
}

fn migrate_run(mut run: ReviewWorkflowRun) -> Result<ReviewWorkflowRun, String> {
    if run.protocol_version != REVIEW_WORKFLOW_PROTOCOL_VERSION
        || run.template_id != REVIEW_WORKFLOW_TEMPLATE_ID
    {
        return Err("unsupported review workflow protocol or template version".to_string());
    }
    if run.template_version == REVIEW_WORKFLOW_TEMPLATE_VERSION {
        normalize_context_policy(&mut run);
        normalize_retrieval_quality_gate(&mut run);
        normalize_scout_automation_status(&mut run);
        normalize_session_binding(&mut run);
        normalize_primary_library_target(&mut run);
        normalize_non_ab_grade_mappings(&mut run);
        normalize_active_stage(&mut run);
        return Ok(run);
    }
    if !matches!(run.template_version, 1 | 2) {
        return Err("unsupported review workflow protocol or template version".to_string());
    }

    let old_stages = std::mem::take(&mut run.stages);
    let mut stages = default_review_stages();
    let mappings: &[(&str, &str)] = if run.template_version == 1 {
        &[
            ("direction-validation", "direction-selection"),
            ("formal-protocol", "matrix-strategy"),
            ("screening", "primary-library"),
            ("evidence-extraction", "batch-grading"),
            ("synthesis", "evidence-synthesis"),
        ]
    } else {
        &[]
    };
    for stage in &mut stages {
        let old_id = mappings
            .iter()
            .find_map(|(old, new)| (*new == stage.id).then_some(*old))
            .unwrap_or(stage.id.as_str());
        if let Some(previous) = old_stages.iter().find(|candidate| candidate.id == old_id) {
            stage.status = previous.status;
            stage.started_at.clone_from(&previous.started_at);
            stage.completed_at.clone_from(&previous.completed_at);
            stage.summary.clone_from(&previous.summary);
            if stage.reviewer_gate.required {
                stage.reviewer_gate = previous.reviewer_gate.clone();
                stage.reviewer_gate.required = true;
            }
        }
    }
    let migrated_from_removed_zotero = run.active_stage_id == "zotero-organization";
    let migrated_active_stage = if migrated_from_removed_zotero {
        "evidence-synthesis".to_string()
    } else {
        mappings
            .iter()
            .find_map(|(old, new)| (run.active_stage_id == *old).then_some((*new).to_string()))
            .unwrap_or_else(|| run.active_stage_id.clone())
    };
    run.active_stage_id = migrated_active_stage;
    run.stages = stages;
    run.template_version = REVIEW_WORKFLOW_TEMPLATE_VERSION;
    if migrated_from_removed_zotero {
        if let Some(stage) = run
            .stages
            .iter_mut()
            .find(|stage| stage.id == "evidence-synthesis")
        {
            stage.status = ReviewWorkflowStageStatus::WaitingUser;
            stage.summary =
                Some("Zotero 结构化重构已从当前版本移除；当前版本止于论文到章节映射。".to_string());
        }
        run.status = ReviewWorkflowStatus::WaitingUser;
    }
    normalize_retrieval_quality_gate(&mut run);
    normalize_context_policy(&mut run);
    normalize_scout_automation_status(&mut run);
    normalize_session_binding(&mut run);
    normalize_primary_library_target(&mut run);
    normalize_non_ab_grade_mappings(&mut run);
    normalize_active_stage(&mut run);
    Ok(run)
}

/// C/D-grade papers and entries with no assigned section are retained in the
/// grading audit but do not contribute to the evidence outline. Drop their
/// legacy mappings on load so older runs resume under the current invariant.
fn normalize_non_ab_grade_mappings(run: &mut ReviewWorkflowRun) {
    run.paper_mappings.retain(|mapping| {
        has_assigned_outline_section(mapping)
            && run
                .paper_grades
                .iter()
                .find(|grade| grade.record_id == mapping.record_id)
                .map_or(true, |grade| is_outline_mapped_grade(&grade.grade))
    });
}

/// Repairs legacy client-written runs in which a completed stage remained
/// active. New writes are rejected by `validate_run_shape`; this load-time
/// normalisation lets an existing run reopen at the first unfinished stage.
fn normalize_active_stage(run: &mut ReviewWorkflowRun) {
    let Some(active) = run
        .stages
        .iter()
        .find(|stage| stage.id == run.active_stage_id)
    else {
        return;
    };
    if active.status != ReviewWorkflowStageStatus::Passed {
        return;
    }
    let active_ordinal = active.ordinal;
    if let Some(next) = run
        .stages
        .iter()
        .filter(|stage| stage.ordinal > active_ordinal)
        .find(|stage| stage.status != ReviewWorkflowStageStatus::Passed)
    {
        run.active_stage_id.clone_from(&next.id);
    }
}

fn advance_active_stage_once(run: &mut ReviewWorkflowRun) {
    let Some(active) = run
        .stages
        .iter()
        .find(|stage| stage.id == run.active_stage_id)
    else {
        return;
    };
    if active.status != ReviewWorkflowStageStatus::Passed {
        return;
    }
    let active_ordinal = active.ordinal;
    if let Some(following) = run
        .stages
        .iter()
        .find(|stage| stage.ordinal == active_ordinal + 1)
        .filter(|stage| stage.status != ReviewWorkflowStageStatus::Passed)
    {
        run.active_stage_id.clone_from(&following.id);
    }
}

/// Older runs inherited the former fixed default of 20. The client treats the
/// value as a cap and still splits by actual prompt size, so migrating that
/// default to 50 raises throughput without risking a context-window overflow.
fn normalize_context_policy(run: &mut ReviewWorkflowRun) {
    if run.context_policy.abstract_batch_size == 20 {
        run.context_policy.abstract_batch_size =
            WorkflowContextPolicy::default().abstract_batch_size;
    }
}

/// Stage 09 builds a bounded working corpus, not a complete export of every
/// matching Scopus row. Older runs used provider exhaustion as the only pass
/// condition and could therefore remain blocked after retaining far more than
/// the user-requested 500 papers. Backfill the intended target semantics on
/// load without hiding the provider cursor or claiming exhaustive coverage.
fn normalize_primary_library_target(run: &mut ReviewWorkflowRun) {
    let target = usize::try_from(run.primary_target_results).unwrap_or(usize::MAX);
    let Some(coverage) = run.primary_coverage.as_ref() else {
        return;
    };
    let target_reached = run.primary_record_ids.len() >= target;
    if !target_reached && !coverage.exhausted {
        return;
    }

    let summary = if target_reached {
        format!(
            "已达到目标，形成 {} 篇去重原始文献库；Scopus 剩余分页不阻塞后续分级。",
            run.primary_record_ids.len()
        )
    } else {
        format!(
            "Scopus 已遍历完全部分页，形成 {} 篇去重原始文献库（低于目标 {} 篇）。",
            run.primary_record_ids.len(),
            run.primary_target_results
        )
    };
    let completed_at = run.updated_at.clone();
    let mut primary_needs_review = false;
    if let Some(stage) = run
        .stages
        .iter_mut()
        .find(|stage| stage.id == "primary-library")
    {
        stage.summary = Some(summary);
        stage.reviewer_gate.required = true;
        // A rejection is a review that happened. Backfilling the coverage
        // verdict over it rewrote the gate as `Pending` and cleared the issues
        // on *every* load, so a user who closed the app after a rejection came
        // back to a stage that had forgotten what it was asked to fix.
        let rejected = stage.reviewer_gate.status == ReviewerGateStatus::Rejected;
        let has_real_review = run.reviewer_disabled
            || (stage.reviewer_gate.status == ReviewerGateStatus::Approved
                && stage.reviewer_gate.reviewer.as_deref()
                    != Some(LEGACY_COVERAGE_TARGET_VALIDATOR_REVIEWER));
        if run.reviewer_disabled {
            stage.status = ReviewWorkflowStageStatus::Passed;
            stage.completed_at.get_or_insert(completed_at.clone());
            stage.reviewer_gate.status = ReviewerGateStatus::Skipped;
            stage.reviewer_gate.reviewer =
                Some("Reviewer disabled by workflow setting".to_string());
        } else if has_real_review {
            stage.status = ReviewWorkflowStageStatus::Passed;
            stage.completed_at.get_or_insert(completed_at.clone());
        } else if rejected {
            primary_needs_review = true;
            stage.status = ReviewWorkflowStageStatus::RevisionRequired;
            stage.completed_at = None;
        } else {
            primary_needs_review = true;
            stage.status = ReviewWorkflowStageStatus::WaitingReviewer;
            stage.completed_at = None;
            stage.reviewer_gate.status = ReviewerGateStatus::Pending;
            stage.reviewer_gate.reviewer = None;
            stage.reviewer_gate.reviewed_at = None;
        }
        if !rejected {
            stage.reviewer_gate.summary = Some(if target_reached {
                format!(
                    "去重文献数已达到目标 {} 篇；未读取的提供商分页已保留在覆盖记录中。",
                    run.primary_target_results
                )
            } else {
                "所有矩阵检索路径均已耗尽；现有记录构成可获得的完整结果。".to_string()
            });
            stage.reviewer_gate.issues.clear();
        }
        if run.reviewer_disabled || has_real_review {
            stage.reviewer_gate.reviewed_at.get_or_insert(completed_at);
        }
    }
    if let Some(stage) = run
        .stages
        .iter_mut()
        .find(|stage| stage.id == "batch-grading")
    {
        if !primary_needs_review && stage.status == ReviewWorkflowStageStatus::NotStarted {
            stage.status = ReviewWorkflowStageStatus::Ready;
        }
    }
    if primary_needs_review
        && (run.active_stage_id == "primary-library" || run.active_stage_id == "batch-grading")
    {
        run.active_stage_id = "primary-library".to_string();
    } else if !primary_needs_review && run.active_stage_id == "primary-library" {
        run.active_stage_id = "batch-grading".to_string();
    }
}

/// Backfills the durable session binding for runs created before it existed.
///
/// Deriving it keeps a pre-existing run resumable in the same conversation it
/// would have had, instead of stranding its history behind a fresh session.
fn normalize_session_binding(run: &mut ReviewWorkflowRun) {
    if run
        .session_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return;
    }
    run.session_id = Some(workflow_session_id(&run.id));
}

fn normalize_scout_automation_status(run: &mut ReviewWorkflowRun) {
    run.scout_revision_limit.get_or_insert(4);
    if run.scout_automation_status.is_some() {
        return;
    }

    let reconnaissance_stage = matches!(
        run.active_stage_id.as_str(),
        "review-landscape-search" | "review-eligibility" | "coverage-and-branch" | "gap-analysis"
    );
    let reconnaissance_complete = matches!(
        run.active_stage_id.as_str(),
        "direction-selection"
            | "matrix-strategy"
            | "query-quality-loop"
            | "primary-library"
            | "batch-grading"
            | "outline"
            | "section-mapping"
            | "evidence-synthesis"
            | "manuscript"
            | "independent-review"
            | "submission-package"
    );

    run.scout_automation_status = Some(if reconnaissance_complete {
        ScoutAutomationStatus::Completed
    } else if run.plan_approved && reconnaissance_stage {
        match run.status {
            ReviewWorkflowStatus::WaitingUser | ReviewWorkflowStatus::RevisionRequired => {
                run.scout_pause_reason.get_or_insert_with(|| {
                    "旧版运行在需要人工处理的状态中恢复；确认问题后可继续综述侦察。".to_string()
                });
                ScoutAutomationStatus::Paused
            }
            _ => ScoutAutomationStatus::Running,
        }
    } else {
        ScoutAutomationStatus::Idle
    });
}

fn normalize_retrieval_quality_gate(run: &mut ReviewWorkflowRun) {
    let updated_at = run.updated_at.clone();
    let Some(stage) = run
        .stages
        .iter_mut()
        .find(|stage| stage.id == "review-landscape-search")
    else {
        return;
    };
    if stage.reviewer_gate.required && stage.reviewer_gate.status != ReviewerGateStatus::NotRequired
    {
        return;
    }
    stage.reviewer_gate.required = true;
    if stage.status == ReviewWorkflowStageStatus::Passed {
        stage.reviewer_gate.status = ReviewerGateStatus::Skipped;
        stage.reviewer_gate.reviewer = Some("Legacy workflow migration".to_string());
        stage.reviewer_gate.summary =
            Some("该阶段在旧版工作流中没有检索回收质量门禁，保留为未经独立审查。".to_string());
        stage.reviewer_gate.reviewed_at = stage.completed_at.clone().or(Some(updated_at));
    } else {
        stage.reviewer_gate.status = ReviewerGateStatus::Pending;
        stage.reviewer_gate.reviewer = None;
        stage.reviewer_gate.summary = Some("等待独立 Reviewer 审查检索回收质量。".to_string());
        stage.reviewer_gate.reviewed_at = None;
    }
    stage.reviewer_gate.issues.clear();
}

fn new_run_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("review-{nanos:032x}-{:x}", std::process::id())
}

const fn default_search_iteration() -> u32 {
    1
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.len() < 8
        || id.len() > 100
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("invalid review workflow id".to_string());
    }
    Ok(())
}

fn clean_required(value: &str, max_chars: usize, label: &str) -> Result<String, String> {
    let value = clean_text(value, max_chars);
    if value.is_empty() {
        Err(format!("{label} is required"))
    } else {
        Ok(value)
    }
}

fn clean_text(value: &str, max_chars: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

fn clean_list(values: Vec<String>, max_items: usize, max_chars: usize) -> Vec<String> {
    let mut output = Vec::new();
    for value in values {
        let value = clean_text(&value, max_chars);
        if !value.is_empty() && !output.iter().any(|existing| existing == &value) {
            output.push(value);
        }
        if output.len() == max_items {
            break;
        }
    }
    output
}

fn clean_list_or_default(
    values: Vec<String>,
    max_items: usize,
    max_chars: usize,
    defaults: &[&str],
) -> Vec<String> {
    let values = clean_list(values, max_items, max_chars);
    if values.is_empty() {
        defaults.iter().map(|value| (*value).to_string()).collect()
    } else {
        values
    }
}

#[cfg(test)]
#[path = "tests/review_workflow.rs"]
mod tests;

#[cfg(test)]
#[path = "tests/review_workflow_e2e.rs"]
mod tests_e2e;
