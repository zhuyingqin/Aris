//! Versioned, project-local literature evidence store.
//!
//! This module is deliberately independent of network clients and agent prompts.
//! It owns the durable contract shared by Desktop, CLI, and tools; source adapters
//! only provide records and sanitized execution details to it.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{now_iso8601, somniq_project_dir, write_file_atomically};

pub const LITERATURE_SCHEMA_VERSION: u32 = 7;
pub const LITERATURE_DIRECTORY: &str = "literature";
const DATABASE_FILE: &str = "literature.sqlite3";
const ARTIFACTS_DIRECTORY: &str = "artifacts";
const BACKUPS_DIRECTORY: &str = "backups";
const LEGACY_LIBRARY_BOOTSTRAP_KEY: &str = "legacy_library_bootstrap_v1";
const LEGACY_LIBRARY_META_KEY: &str = "legacy_library_projection_meta_v1";
const LIBRARY_RELATIONS_BACKFILL_KEY: &str = "library_relations_backfill_v1";
const LIBRARY_ITEM_MODEL_BACKFILL_KEY: &str = "library_item_model_backfill_v1";
const SAVED_SEARCH_RUN_MIRROR_CLEANUP_KEY: &str = "saved_search_run_mirror_cleanup_v1";
const LEGACY_PRIMARY_PDF_ATTACHMENT_ID: &str = "attachment-primary-pdf";
const LOCAL_LIBRARY_ID: &str = "local";
const DEFAULT_LIBRARY_ITEM_TYPE: &str = "journalArticle";

const LIBRARY_PREFERENCES_KEY: &str = "library_preferences_v1";

/// Saved searches whose id carries this prefix mirror a `SearchRun`.
pub const SEARCH_RUN_SAVED_SEARCH_PREFIX: &str = "search-run:";

/// Zotero-style attachment naming. `{creator} - {year} - {title}` is Zotero's
/// own default and the one researchers recognise in a file picker.
pub const DEFAULT_ATTACHMENT_NAME_TEMPLATE: &str = "{creator} - {year} - {title}";

/// Attachment file names are joined onto an already deep workspace path
/// (`…\.config\SomniQ\desktop-workspace\papers\`), so the title segment is
/// capped well below any single-component limit and the whole path is checked
/// separately at rename time.
const ATTACHMENT_TITLE_CHARS: usize = 80;
const ATTACHMENT_STEM_CHARS: usize = 120;

/// A saved search that mirrors a `SearchRun` is derived state: the run is the
/// record of truth and the projection regenerates the entry on every load.
/// Storing such a row in `library_saved_searches` gives one search two homes,
/// and the projection can then no longer tell that the run is already
/// represented — so it appends a duplicate, and a delete of either copy is
/// undone by the other. The id prefix is the single place that decides.
#[must_use]
pub fn search_run_id_for_saved_search(id: &str) -> Option<&str> {
    id.trim()
        .strip_prefix(SEARCH_RUN_SAVED_SEARCH_PREFIX)
        .map(str::trim)
        .filter(|run_id| !run_id.is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProtocolDraft {
    /// The research question the protocol is designed to answer.
    pub question: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub time_window: String,
    /// Stable provider-independent sort intent. Adapters translate supported
    /// values (for example `publication_date_desc`) into provider syntax.
    #[serde(default)]
    pub sort_order: String,
    /// Adapter identifiers, for example `scopus` or `arxiv`.
    #[serde(default)]
    pub databases: Vec<String>,
    /// Complete, source-specific queries. Keys are adapter identifiers.
    #[serde(default)]
    pub queries: BTreeMap<String, String>,
    /// Ordered query variants per adapter. The first variant is the broad
    /// recall query; later variants may add exact phrases, terminology
    /// aliases, spelling variants, or another language. `queries` remains the
    /// backwards-compatible primary-query projection.
    #[serde(default)]
    pub query_variants: BTreeMap<String, Vec<SearchQueryVariant>>,
    /// Maximum number of unique records to retain from each source. Keeping
    /// this in the versioned protocol binds preview and execution to the same
    /// retrieval scope.
    #[serde(default)]
    pub max_results: Option<usize>,
    #[serde(default)]
    pub inclusion_criteria: Vec<String>,
    #[serde(default)]
    pub exclusion_criteria: Vec<String>,
    #[serde(default)]
    pub known_key_papers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryVariant {
    pub kind: String,
    pub query: String,
    #[serde(default)]
    pub rationale: String,
    /// Optional durable ceiling for this query stream. Explicit path ceilings
    /// cannot exceed the protocol's source-wide `max_results` bound.
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProtocol {
    pub schema_version: u32,
    pub id: String,
    pub revision: u32,
    #[serde(flatten)]
    pub draft: SearchProtocolDraft,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchRunStatus {
    Planned,
    Running,
    Completed,
    Partial,
    Failed,
    LegacyImported,
}

impl SearchRunStatus {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Partial | Self::Failed | Self::LegacyImported
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceAttemptStatus {
    Running,
    Completed,
    Partial,
    Unavailable,
    Unauthorised,
    RateLimited,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawArtifact {
    pub id: String,
    pub search_run_id: String,
    pub source: String,
    pub kind: String,
    pub relative_path: String,
    pub sha256: String,
    pub bytes: u64,
    pub media_type: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAttempt {
    pub source: String,
    /// Sanitized request only. Credentials, cookies, and authorization headers
    /// are forbidden here.
    #[serde(default)]
    pub request: Value,
    pub started_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    pub status: SourceAttemptStatus,
    #[serde(default)]
    pub hit_count: Option<u64>,
    #[serde(default)]
    pub returned_count: u64,
    /// Explicit coverage accounting. A successful HTTP response is not enough
    /// to claim complete retrieval: `exhausted` must also be true.
    #[serde(default)]
    pub coverage: SearchCoverage,
    #[serde(default)]
    pub quota: Value,
    #[serde(default)]
    pub failure_code: Option<String>,
    #[serde(default)]
    pub failure_message: Option<String>,
    #[serde(default)]
    pub coverage_note: Option<String>,
    #[serde(default)]
    pub artifact_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchCoverage {
    #[serde(default)]
    pub total_hits: Option<u64>,
    #[serde(default)]
    pub fetched: u64,
    #[serde(default)]
    pub unique: u64,
    #[serde(default)]
    pub exhausted: bool,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub truncated_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRecordRank {
    pub record_id: String,
    /// One-based provider rank for every source that returned this canonical
    /// record. The minimum rank is retained when query variants overlap.
    #[serde(default)]
    pub source_ranks: BTreeMap<String, u32>,
    /// One-based rank inside every *query variant* that returned this canonical
    /// record, keyed by the variant `kind`. Reciprocal-rank fusion merges the
    /// variants into a single ordered result set, which on its own destroys the
    /// record-to-variant attribution a caller needs to enforce a per-variant
    /// corpus quota. Retaining the per-variant rank keeps that attribution
    /// durable and auditable. Empty for runs written before variant attribution
    /// existed, and for protocols with a single implicit variant.
    #[serde(default)]
    pub variant_ranks: BTreeMap<String, u32>,
    /// Reciprocal-rank-fusion score scaled by one billion so the durable model
    /// remains deterministic and Eq/JSON friendly.
    ///
    /// This stays the *fusion* score alone. Re-ranking is recorded separately
    /// rather than folded in here, so a reader can still see what agreement
    /// between providers said before topical relevance was applied to it.
    #[serde(default)]
    pub fused_score_micros: u64,
    /// The score `record_ids` is actually ordered by: the fusion score after
    /// re-ranking. Zero on runs written before re-ranking existed, which read
    /// back in their original fused order.
    #[serde(default)]
    pub ranking_score_micros: u64,
    /// Why re-ranking moved this record, kept so a surprising order can be
    /// explained without re-running the search.
    #[serde(default)]
    pub ranking_signals: RankingSignals,
}

/// Evidence behind one record's re-ranking, in thousandths.
///
/// Reciprocal-rank fusion combines *rankings*, so it only carries a signal when
/// providers agree on a record. Across Scopus, `OpenAlex`, Crossref and arXiv
/// they mostly do not — the indexes overlap far less than they appear to — and
/// with no agreement to weigh, fusion degenerates into round-robin: measured on
/// one ordinary query, every source's first result scored identically and the
/// merged list was just the three provider lists interleaved, with a book's
/// front matter in first place and the field's most-cited survey in third.
/// These signals are what break that tie.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankingSignals {
    /// Share of the question's content terms present in the record title.
    #[serde(default)]
    pub title_coverage_millis: u32,
    /// Age-normalised citation impact. `None` means no index reported a count
    /// — arXiv reports none at all — and is treated as unknown, never as zero,
    /// so a preprint is not demoted for a number nobody published.
    #[serde(default)]
    pub impact_millis: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRun {
    pub schema_version: u32,
    pub id: String,
    /// Optimistic-concurrency token. It is incremented on every checkpoint or
    /// terminal transition so independent Desktop, Chat, and CLI processes
    /// cannot silently replace one another's run payload.
    #[serde(default = "initial_revision")]
    pub revision: u64,
    pub protocol_id: String,
    pub protocol_revision: u32,
    pub status: SearchRunStatus,
    pub started_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub source_attempts: Vec<SourceAttempt>,
    #[serde(default)]
    pub record_ids: Vec<String>,
    /// Canonical records in fused relevance order. `record_ids` mirrors this
    /// order for compatibility with existing Desktop and Chat consumers.
    #[serde(default)]
    pub ranked_records: Vec<SearchRecordRank>,
    #[serde(default)]
    pub artifact_ids: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordIdentifiers {
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub arxiv_id: Option<String>,
    #[serde(default)]
    pub scopus_id: Option<String>,
    #[serde(default)]
    pub source_ids: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordProvenance {
    pub source: String,
    #[serde(default)]
    pub external_id: Option<String>,
    #[serde(default)]
    pub search_run_id: Option<String>,
    #[serde(default)]
    pub artifact_id: Option<String>,
    pub observed_at: String,
}

/// A source-specific metadata observation retained alongside the chosen
/// canonical values. This means later reconciliation never has to reparse raw
/// provider payloads merely to discover that fields disagreed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordObservation {
    pub source: String,
    #[serde(default)]
    pub external_id: Option<String>,
    #[serde(default)]
    pub artifact_id: Option<String>,
    pub observed_at: String,
    #[serde(default)]
    pub fields: Value,
}

/// A disagreement between a retained canonical value and a source
/// observation. Conflicts are append-only review material, not an implicit
/// instruction to overwrite user-resolved metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordFieldConflict {
    pub field: String,
    pub canonical_value: Value,
    pub observed_value: Value,
    pub source: String,
    #[serde(default)]
    pub external_id: Option<String>,
    #[serde(default)]
    pub artifact_id: Option<String>,
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalRecord {
    pub schema_version: u32,
    pub id: String,
    /// Optimistic-concurrency token for source-observation merges and legacy
    /// UI projection updates.
    #[serde(default = "initial_revision")]
    pub revision: u64,
    pub title: String,
    pub normalized_title: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub year: Option<u32>,
    #[serde(default)]
    pub venue: String,
    #[serde(default)]
    pub abstract_text: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub pdf_url: Option<String>,
    #[serde(default)]
    pub identifiers: RecordIdentifiers,
    #[serde(default)]
    pub provenance: Vec<RecordProvenance>,
    #[serde(default)]
    pub observations: Vec<RecordObservation>,
    #[serde(default)]
    pub field_conflicts: Vec<RecordFieldConflict>,
    /// Legacy UI fields and unresolved metadata can be kept here without being
    /// promoted to a screening decision or evidence claim.
    #[serde(default)]
    pub metadata: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreeningOutcome {
    Include,
    Exclude,
    Maybe,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionActor {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenDecision {
    pub schema_version: u32,
    pub id: String,
    pub record_id: String,
    pub protocol_id: String,
    pub stage: String,
    pub outcome: ScreeningOutcome,
    #[serde(default)]
    pub reason_code: Option<String>,
    pub reason: String,
    pub executor: DecisionActor,
    #[serde(default)]
    pub reviewer: Option<DecisionActor>,
    #[serde(default)]
    pub reviewer_outcome: Option<ScreeningOutcome>,
    #[serde(default)]
    pub reviewer_reason: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub reviewed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceStrength {
    High,
    Moderate,
    Low,
    Insufficient,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CitationLocator {
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub section: Option<String>,
    #[serde(default)]
    pub quote: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceCard {
    pub schema_version: u32,
    pub id: String,
    pub record_id: String,
    pub claim: String,
    #[serde(default)]
    pub limitations: Vec<String>,
    pub strength: EvidenceStrength,
    pub locator: CitationLocator,
    #[serde(default)]
    pub usable_in: Vec<String>,
    pub created_by: DecisionActor,
    pub created_at: String,
    #[serde(default)]
    pub verified_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportReport {
    pub already_imported: bool,
    pub protocol_id: String,
    pub search_run_id: String,
    pub imported_records: usize,
    pub source_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalRecordUpsert {
    pub record: CanonicalRecord,
    pub inserted: bool,
    /// Existing canonical record ids absorbed into `record` while reconciling
    /// equivalent DOI, arXiv, Scopus, or normalized-title identities.
    #[serde(default)]
    pub merged_record_ids: Vec<String>,
}

pub struct LiteratureStore {
    root: PathBuf,
    connection: Connection,
}

/// Zotero-style collection metadata. Collections are views over items rather
/// than folders that own or duplicate the item itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCollection {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Stable sibling order in the Zotero-style collection tree.
    #[serde(default)]
    pub order_index: u32,
}

/// A normalized tag definition. The `kind` field lets the UI distinguish
/// researcher-authored tags from future derived or workflow-scoped tags.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTag {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// Zotero-compatible tag type: 0 is a user tag and 1 is an automatic tag.
    #[serde(default)]
    pub tag_type: u32,
    #[serde(default)]
    pub color: Option<String>,
}

/// Project-scoped library preferences. Every field must have a default so an
/// older store, or one that has never been configured, keeps working.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPreferences {
    #[serde(default = "default_attachment_name_template")]
    pub attachment_name_template: String,
    /// Off by default: renaming touches files the researcher can see in their
    /// own file manager, so the first rename has to be a deliberate act.
    #[serde(default)]
    pub rename_attachments_on_import: bool,
}

fn default_attachment_name_template() -> String {
    DEFAULT_ATTACHMENT_NAME_TEMPLATE.to_string()
}

impl Default for LibraryPreferences {
    fn default() -> Self {
        Self {
            attachment_name_template: default_attachment_name_template(),
            rename_attachments_on_import: false,
        }
    }
}

impl LibraryPreferences {
    #[must_use]
    pub fn normalized(&self) -> Self {
        let template = self.attachment_name_template.trim();
        Self {
            attachment_name_template: if template.is_empty() {
                default_attachment_name_template()
            } else {
                template.to_string()
            },
            rename_attachments_on_import: self.rename_attachments_on_import,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAttachment {
    pub id: String,
    pub record_id: String,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub external_path: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub link_mode: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub charset: Option<String>,
    #[serde(default)]
    pub hash: Option<String>,
    #[serde(default)]
    pub mtime: Option<i64>,
    #[serde(default)]
    pub last_page_index: Option<u32>,
    #[serde(default)]
    pub source_payload: Option<Value>,
    pub added_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryNote {
    pub id: String,
    pub record_id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub annotation_id: Option<String>,
    #[serde(default)]
    pub attachment_id: Option<String>,
    #[serde(default)]
    pub evidence_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub source_payload: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAnnotation {
    pub id: String,
    pub record_id: String,
    #[serde(default)]
    pub attachment_id: Option<String>,
    pub page: u32,
    #[serde(default)]
    pub page_label: Option<String>,
    pub quote: String,
    pub note: String,
    pub kind: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub rects: Option<Value>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub image_fingerprint: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub evidence_id: Option<String>,
    #[serde(default)]
    pub annotation_type: Option<String>,
    #[serde(default)]
    pub position: Option<Value>,
    #[serde(default)]
    pub sort_index: Option<u32>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub is_external: bool,
    #[serde(default)]
    pub source_payload: Option<Value>,
    pub created_at: String,
}

/// All normalized relationships for one canonical literature item. This is a
/// read model used by Desktop projections; the individual tables remain the
/// write-side source of truth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItemRelations {
    pub record_id: String,
    pub collection_ids: Vec<String>,
    pub tags: Vec<String>,
    pub attachments: Vec<LibraryAttachment>,
    pub notes: Vec<LibraryNote>,
    pub annotations: Vec<LibraryAnnotation>,
    #[serde(default)]
    pub relations: Vec<LibraryItemRelation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRelationSnapshot {
    pub collections: Vec<LibraryCollection>,
    pub items: BTreeMap<String, LibraryItemRelations>,
    /// Read-only views materialized from local state. They are never persisted
    /// as ordinary collections, which keeps the collection tree user-owned.
    #[serde(default)]
    pub special_collections: Vec<LibrarySpecialCollection>,
}

/// The local Library data-plane item. Parent bibliographic records and their
/// attachments, notes, and annotations share this identity model; SomniQ's
/// screening/evidence records remain in the research plane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub key: String,
    pub library_id: String,
    pub item_type: String,
    #[serde(default)]
    pub parent_item_id: Option<String>,
    pub version: u64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub trashed: bool,
    pub date_added: String,
    pub date_modified: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCreator {
    pub id: String,
    pub creator_type: String,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// `twoField` is a family/given creator; `oneField` is a literal name.
    #[serde(default = "default_creator_field_mode")]
    pub field_mode: String,
    pub order_index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItemRelation {
    pub id: String,
    pub source_item_id: String,
    pub predicate: String,
    pub target: String,
    pub target_kind: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySearchCondition {
    pub id: String,
    pub condition_index: u32,
    pub field: String,
    pub operator: String,
    pub value: String,
    #[serde(default)]
    pub joiner: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySavedSearch {
    pub id: String,
    pub name: String,
    pub query: String,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub dynamic: bool,
    pub version: u64,
    #[serde(default)]
    pub conditions: Vec<LibrarySearchCondition>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySpecialCollection {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub readonly: bool,
    #[serde(default)]
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFullTextStatus {
    pub item_id: String,
    #[serde(default)]
    pub indexed_pages: Option<u32>,
    #[serde(default)]
    pub total_pages: Option<u32>,
    #[serde(default)]
    pub indexed_chars: Option<u64>,
    #[serde(default)]
    pub total_chars: Option<u64>,
    pub version: u64,
    #[serde(default)]
    pub text_hash: Option<String>,
    pub status: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItemSnapshot {
    pub item: LibraryItem,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    #[serde(default)]
    pub creators: Vec<LibraryCreator>,
    #[serde(default)]
    pub tags: Vec<LibraryTag>,
    #[serde(default)]
    pub collection_ids: Vec<String>,
    #[serde(default)]
    pub relations: Vec<LibraryItemRelation>,
    #[serde(default)]
    pub source_payload: Option<Value>,
    #[serde(default)]
    pub full_text: Option<LibraryFullTextStatus>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryModelSnapshot {
    pub items: Vec<LibraryItemSnapshot>,
    pub collections: Vec<LibraryCollection>,
    pub tags: Vec<LibraryTag>,
    pub saved_searches: Vec<LibrarySavedSearch>,
    pub special_collections: Vec<LibrarySpecialCollection>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureFullTextHit {
    pub record_id: String,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureFullTextPage {
    pub hits: Vec<LiteratureFullTextHit>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub exhausted: bool,
    #[serde(default)]
    pub next_offset: Option<usize>,
    pub strategies: Vec<String>,
}

/// A deliberately conservative duplicate suggestion. The rows remain
/// separate until a user explicitly chooses to merge them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureDuplicateCandidate {
    pub primary_record_id: String,
    pub duplicate_record_id: String,
    pub normalized_title: String,
    pub reason: String,
}

/// A recoverable, point-in-time SQLite copy stored beside the canonical
/// literature database.  The copy is created with SQLite's `VACUUM INTO`, so
/// it is consistent even while the primary database uses WAL mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureBackup {
    pub path: String,
    pub bytes: u64,
    pub created_at: String,
}

/// A lightweight health report safe to expose to Desktop and CLI callers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureHealth {
    pub healthy: bool,
    pub integrity_check: String,
    pub foreign_key_violations: u64,
    pub journal_mode: String,
}

#[must_use]
pub fn literature_root_for(workspace: &Path) -> PathBuf {
    somniq_project_dir(workspace).join(LITERATURE_DIRECTORY)
}

pub fn open_literature_store_at(workspace: &Path) -> Result<LiteratureStore, String> {
    let root = literature_root_for(workspace);
    fs::create_dir_all(root.join(ARTIFACTS_DIRECTORY)).map_err(|error| error.to_string())?;
    let mut connection =
        Connection::open(root.join(DATABASE_FILE)).map_err(|error| error.to_string())?;
    initialize_schema(&mut connection)?;
    Ok(LiteratureStore { root, connection })
}

impl LiteratureStore {
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Path to the project-local SQLite database that owns canonical
    /// literature records, protocols, audit history, and evidence.
    #[must_use]
    pub fn database_path(&self) -> PathBuf {
        self.root.join(DATABASE_FILE)
    }

    /// Validate the SQLite file without mutating canonical records.
    pub fn health(&self) -> Result<LiteratureHealth, String> {
        let integrity_check = self
            .connection
            .query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        let journal_mode = self
            .connection
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        let foreign_key_violations = self
            .connection
            .prepare("PRAGMA foreign_key_check")
            .map_err(to_error)?
            .query_map([], |_| Ok(()))
            .map_err(to_error)?
            .count();
        let foreign_key_violations = u64::try_from(foreign_key_violations).unwrap_or(u64::MAX);
        Ok(LiteratureHealth {
            healthy: integrity_check.eq_ignore_ascii_case("ok") && foreign_key_violations == 0,
            integrity_check,
            foreign_key_violations,
            journal_mode,
        })
    }

    /// Return the most recently created local database backup, if one exists.
    pub fn latest_backup(&self) -> Result<Option<LiteratureBackup>, String> {
        let directory = self.root.join(BACKUPS_DIRECTORY);
        if !directory.exists() {
            return Ok(None);
        }
        let mut candidates = fs::read_dir(&directory)
            .map_err(to_error)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                (path.extension().and_then(|value| value.to_str()) == Some("sqlite3"))
                    .then_some(path)
            })
            .filter_map(|path| {
                let metadata = fs::metadata(&path).ok()?;
                let modified = metadata.modified().ok()?;
                Some((modified, path, metadata.len()))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| right.0.cmp(&left.0));
        let Some((modified, path, bytes)) = candidates.into_iter().next() else {
            return Ok(None);
        };
        let created_at = modified
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().to_string())
            .unwrap_or_default();
        Ok(Some(LiteratureBackup {
            path: path.to_string_lossy().into_owned(),
            bytes,
            created_at,
        }))
    }

    /// Create a transactionally consistent SQLite backup under
    /// `.somniq/literature/backups/`.
    pub fn create_backup(&self) -> Result<LiteratureBackup, String> {
        let directory = self.root.join(BACKUPS_DIRECTORY);
        fs::create_dir_all(&directory).map_err(to_error)?;
        let created_at = now_iso8601();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(to_error)?
            .as_millis();
        let path = directory.join(format!("literature-{timestamp}.sqlite3"));
        // The destination is generated locally, but quote it defensively so a
        // project path containing an apostrophe cannot change the SQL command.
        let destination = path.to_string_lossy().replace('\'', "''");
        self.connection
            .execute_batch(&format!("VACUUM INTO '{destination}'"))
            .map_err(to_error)?;
        let bytes = fs::metadata(&path).map_err(to_error)?.len();
        Ok(LiteratureBackup {
            path: path.to_string_lossy().into_owned(),
            bytes,
            created_at,
        })
    }

    pub fn create_protocol(
        &mut self,
        draft: SearchProtocolDraft,
    ) -> Result<SearchProtocol, String> {
        validate_protocol(&draft)?;
        let now = now_iso8601();
        let protocol = SearchProtocol {
            schema_version: LITERATURE_SCHEMA_VERSION,
            id: new_id("protocol")?,
            revision: 1,
            draft,
            created_at: now.clone(),
            updated_at: now,
        };
        let transaction = self.connection.transaction().map_err(to_error)?;
        insert_protocol(&transaction, &protocol)?;
        append_audit(
            &transaction,
            "search_protocol",
            &protocol.id,
            "created",
            &json!({ "revision": protocol.revision }),
        )?;
        transaction.commit().map_err(to_error)?;
        Ok(protocol)
    }

    pub fn load_protocol(&self, id: &str) -> Result<Option<SearchProtocol>, String> {
        self.connection
            .query_row(
                "SELECT payload FROM search_protocols WHERE id = ?1 ORDER BY revision DESC LIMIT 1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(to_error)?
            .map(|payload| decode_payload(&payload))
            .transpose()
    }

    /// Read-side API for Desktop projections and CLI consumers. The canonical
    /// store, not a compatibility JSON file, is the source of these records.
    pub fn list_canonical_records(&self) -> Result<Vec<CanonicalRecord>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT payload FROM canonical_records ORDER BY updated_at DESC, id ASC")
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        let records = rows
            .map(|row| {
                row.map_err(to_error)
                    .and_then(|payload| decode_payload(&payload))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(records)
    }

    /// How many canonical records the store holds. Callers that only report a
    /// count must use this instead of `list_canonical_records().len()`:
    /// decoding every payload is the single most expensive read in the store.
    pub fn canonical_record_count(&self) -> Result<usize, String> {
        self.count_rows("SELECT COUNT(*) FROM canonical_records")
    }

    /// How many search runs the store holds, without decoding their payloads.
    pub fn search_run_count(&self) -> Result<usize, String> {
        self.count_rows("SELECT COUNT(*) FROM search_runs")
    }

    fn count_rows(&self, sql: &str) -> Result<usize, String> {
        let count: i64 = self
            .connection
            .query_row(sql, [], |row| row.get(0))
            .map_err(to_error)?;
        Ok(usize::try_from(count).unwrap_or(0))
    }

    /// Return the normalized Zotero-style relationship graph used by
    /// Desktop projections. The canonical item rows remain the identity
    /// source; this snapshot only materializes their collections, tags,
    /// attachments, notes, and PDF annotations.
    pub fn library_relation_snapshot(&self) -> Result<LibraryRelationSnapshot, String> {
        let record_ids = self.canonical_record_ids()?;
        self.library_relation_snapshot_for(record_ids)
    }

    /// Same snapshot restricted to record ids the caller already has. Callers
    /// that just listed the canonical records — or that only need one page of
    /// search hits — must use this instead, because decoding every canonical
    /// payload a second time dominates the cost of the whole projection.
    pub fn library_relation_snapshot_for(
        &self,
        record_ids: Vec<String>,
    ) -> Result<LibraryRelationSnapshot, String> {
        Ok(LibraryRelationSnapshot {
            collections: load_library_collections(&self.connection)?,
            items: load_library_item_relations_bulk(&self.connection, record_ids)?,
            special_collections: load_library_special_collections(&self.connection)?,
        })
    }

    /// Canonical record identifiers in projection order. Unlike
    /// [`Self::list_canonical_records`] this never decodes the JSON payloads,
    /// which is the expensive part of reading a large library.
    pub fn canonical_record_ids(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT id FROM canonical_records ORDER BY updated_at DESC, id ASC")
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        rows.map(|row| row.map_err(to_error))
            .collect::<Result<Vec<_>, _>>()
    }

    /// Decode only the requested canonical records, preserving the caller's
    /// order. Search result pages use this so a query never pays for the whole
    /// library.
    pub fn load_canonical_records(
        &self,
        ids: &[String],
    ) -> Result<Vec<CanonicalRecord>, String> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; ids.len()].join(",");
        let mut statement = self
            .connection
            .prepare(&format!(
                "SELECT id, payload FROM canonical_records WHERE id IN ({placeholders})"
            ))
            .map_err(to_error)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(to_error)?;
        let mut decoded = BTreeMap::new();
        for row in rows {
            let (id, payload) = row.map_err(to_error)?;
            decoded.insert(id, decode_payload::<CanonicalRecord>(&payload)?);
        }
        Ok(ids
            .iter()
            .filter_map(|id| decoded.remove(id))
            .collect::<Vec<_>>())
    }

    /// Read the complete local Zotero-shaped Library data plane. Unlike the
    /// compatibility relation snapshot, this includes child items, generic
    /// item fields/creators/relations, saved-search conditions, tag metadata,
    /// and the computed special collections.
    pub fn library_model_snapshot(&self) -> Result<LibraryModelSnapshot, String> {
        Ok(LibraryModelSnapshot {
            items: load_library_item_snapshots(&self.connection)?,
            collections: load_library_collections(&self.connection)?,
            tags: load_library_tags(&self.connection)?,
            saved_searches: load_library_saved_searches(&self.connection)?,
            special_collections: load_library_special_collections(&self.connection)?,
        })
    }

    pub fn library_item(&self, item_id: &str) -> Result<Option<LibraryItem>, String> {
        load_library_item(&self.connection, item_id.trim())
    }

    /// Return visibility flags for every normalized library item in one read.
    /// Compatibility projections use this instead of issuing one item lookup
    /// per canonical record.
    pub fn library_item_visibility(&self) -> Result<BTreeMap<String, (bool, bool)>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT id, deleted, trashed FROM library_items")
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (sql_to_bool(row.get(1)?), sql_to_bool(row.get(2)?)),
                ))
            })
            .map_err(to_error)?;
        rows.collect::<Result<BTreeMap<_, _>, _>>()
            .map_err(to_error)
    }

    /// Apply an object-level local Library patch. `expectedVersion`, when
    /// supplied, is checked before the write; this gives Desktop and CLI a
    /// deterministic conflict instead of silently replacing a newer edit.
    /// Supported patch keys are `itemType`, `parentItemId`, `key`, `trashed`,
    /// `deleted`, `fields`, `creators`, and `relations`.
    pub fn update_library_item(
        &mut self,
        item_id: &str,
        patch: &Value,
    ) -> Result<LibraryItemSnapshot, String> {
        let item_id = item_id.trim();
        if item_id.is_empty() || !patch.is_object() {
            return Err("library item update requires an item id and JSON object".to_string());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        let current = load_library_item(&transaction, item_id)?
            .ok_or_else(|| format!("unknown library item: {item_id}"))?;
        if let Some(expected) = patch.get("expectedVersion").and_then(Value::as_u64) {
            if expected != current.version {
                return Err(format!(
                    "library item {item_id} is version {}; expected {expected}",
                    current.version
                ));
            }
        }
        let item_key = patch
            .get("key")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| current.key.clone());
        if item_key != current.key {
            let collision = transaction
                .query_row(
                    "SELECT 1 FROM library_items WHERE item_key = ?1 AND id != ?2 LIMIT 1",
                    params![item_key, item_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(to_error)?;
            if collision.is_some() {
                return Err(format!("library item key is already in use: {item_key}"));
            }
        }
        let parent_item_id = if let Some(parent) = patch.get("parentItemId") {
            if parent.is_null() {
                None
            } else {
                let parent = parent
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "parentItemId must be a non-empty string or null".to_string())?;
                if parent == item_id {
                    return Err("a library item cannot be its own parent".to_string());
                }
                let exists = transaction
                    .query_row(
                        "SELECT 1 FROM library_items WHERE id = ?1",
                        [parent],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(to_error)?
                    .is_some();
                if !exists {
                    return Err(format!("unknown parent library item: {parent}"));
                }
                let creates_cycle = transaction
                    .query_row(
                        "WITH RECURSIVE ancestors(id) AS (
                           SELECT parent_item_id FROM library_items WHERE id = ?1
                           UNION
                           SELECT parent.parent_item_id
                           FROM library_items AS parent
                           JOIN ancestors ON parent.id = ancestors.id
                           WHERE ancestors.id IS NOT NULL
                         )
                         SELECT 1 FROM ancestors WHERE id = ?2 LIMIT 1",
                        params![parent, item_id],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(to_error)?
                    .is_some();
                if creates_cycle {
                    return Err(format!(
                        "library item {item_id} cannot be moved below one of its descendants"
                    ));
                }
                Some(parent.to_string())
            }
        } else {
            current.parent_item_id.clone()
        };
        let item_type = patch
            .get("itemType")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&current.item_type);
        let library_id = patch
            .get("libraryId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&current.library_id);
        let deleted = patch
            .get("deleted")
            .and_then(Value::as_bool)
            .unwrap_or(current.deleted);
        let trashed = patch
            .get("trashed")
            .and_then(Value::as_bool)
            .unwrap_or(current.trashed);
        let version = current.version.saturating_add(1);
        let now = now_iso8601();
        transaction
            .execute(
                "UPDATE library_items SET item_key = ?2, library_id = ?3,
                 item_type = ?4, parent_item_id = ?5, version = ?6,
                 deleted = ?7, trashed = ?8, date_modified = ?9, updated_at = ?9
                 WHERE id = ?1 AND version = ?10",
                params![
                    item_id,
                    item_key,
                    library_id,
                    item_type,
                    parent_item_id,
                    version,
                    bool_to_sql(deleted),
                    bool_to_sql(trashed),
                    now,
                    current.version,
                ],
            )
            .map_err(to_error)?;
        if let Some(fields) = patch.get("fields") {
            replace_library_item_fields_in_transaction(&transaction, item_id, fields)?;
        }
        if let Some(creators) = patch.get("creators") {
            replace_library_item_creators_in_transaction(&transaction, item_id, creators)?;
        }
        if let Some(relations) = patch.get("relations") {
            replace_library_item_relations_in_transaction(&transaction, item_id, relations)?;
        }
        if transaction
            .query_row(
                "SELECT 1 FROM canonical_records WHERE id = ?1",
                [item_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(to_error)?
            .is_some()
        {
            sync_canonical_record_from_library_item_in_transaction(&transaction, item_id)?;
            set_record_visibility_in_transaction(&transaction, item_id, !trashed && !deleted)?;
        }
        append_audit(
            &transaction,
            "library_item",
            item_id,
            "updated",
            &json!({ "version": version }),
        )?;
        transaction.commit().map_err(to_error)?;
        load_library_item_snapshot(&self.connection, item_id)?.ok_or_else(|| {
            format!("library item disappeared after update: {item_id}")
        })
    }

    /// Move local Library items to the recoverable Trash view. Child items are
    /// moved with their parent; canonical records and audit/evidence history
    /// are retained for restoration.
    pub fn trash_library_items(&mut self, item_ids: &[String]) -> Result<Vec<LibraryItem>, String> {
        set_library_items_trash(self, item_ids, true)
    }

    pub fn restore_library_items(
        &mut self,
        item_ids: &[String],
    ) -> Result<Vec<LibraryItem>, String> {
        set_library_items_trash(self, item_ids, false)
    }

    /// Permanently remove items that are already in the recoverable Trash.
    /// Parent records and every normalized child are deleted in one SQLite
    /// transaction; audit rows remain so the local activity history still
    /// explains why an item disappeared.
    pub fn permanently_delete_library_items(
        &mut self,
        item_ids: &[String],
    ) -> Result<Vec<String>, String> {
        let roots = item_ids
            .iter()
            .map(|id| id.trim())
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned)
            .collect::<BTreeSet<_>>();
        if roots.is_empty() {
            return Ok(Vec::new());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        let mut descendants = BTreeSet::new();
        for root in &roots {
            let status = load_library_item(&transaction, root)?
                .ok_or_else(|| format!("unknown library item: {root}"))?;
            if !status.trashed && !status.deleted {
                return Err(format!(
                    "library item {root} must be in Trash before permanent deletion"
                ));
            }
            let ids = {
                let mut statement = transaction
                    .prepare(
                        "WITH RECURSIVE descendants(id) AS (
                           SELECT id FROM library_items WHERE id = ?1
                           UNION ALL
                           SELECT child.id FROM library_items AS child
                           JOIN descendants ON child.parent_item_id = descendants.id
                         )
                         SELECT id FROM descendants",
                    )
                    .map_err(to_error)?;
                let rows = statement
                    .query_map([root], |row| row.get::<_, String>(0))
                    .map_err(to_error)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
            };
            descendants.extend(ids);
        }
        for id in &descendants {
            append_audit(
                &transaction,
                "library_item",
                id,
                "permanently_deleted",
                &json!({ "rootIds": roots }),
            )?;
            transaction
                .execute(
                    "DELETE FROM library_attachment_full_text WHERE item_id = ?1",
                    [id],
                )
                .map_err(to_error)?;
            transaction
                .execute(
                    "DELETE FROM literature_full_text WHERE record_id = ?1",
                    [id],
                )
                .map_err(to_error)?;
            transaction
                .execute(
                    "DELETE FROM screen_decisions WHERE record_id = ?1",
                    [id],
                )
                .map_err(to_error)?;
            transaction
                .execute(
                    "DELETE FROM evidence_cards WHERE record_id = ?1",
                    [id],
                )
                .map_err(to_error)?;
            transaction
                .execute(
                    "DELETE FROM library_item_relations
                     WHERE source_item_id = ?1
                        OR (target_kind = 'item' AND target = ?1)",
                    [id],
                )
                .map_err(to_error)?;
            // Canonical relationship tables use ON DELETE CASCADE. Delete
            // this row before the data-plane item so both parent records and
            // standalone child items are handled by the same path.
            transaction
                .execute("DELETE FROM canonical_records WHERE id = ?1", [id])
                .map_err(to_error)?;
            transaction
                .execute("DELETE FROM library_items WHERE id = ?1", [id])
                .map_err(to_error)?;
        }
        transaction
            .execute(
                "DELETE FROM library_creators
                 WHERE id NOT IN (SELECT creator_id FROM library_item_creators)",
                [],
            )
            .map_err(to_error)?;
        transaction.commit().map_err(to_error)?;
        Ok(descendants.into_iter().collect())
    }

    /// Replace normalized saved searches and their conditions. SearchRun rows
    /// remain immutable and are projected separately, so deleting a saved
    /// search cannot erase retrieval provenance.
    pub fn update_library_saved_searches(
        &mut self,
        searches: &Value,
    ) -> Result<Vec<LibrarySavedSearch>, String> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        sync_library_saved_searches_in_transaction(&transaction, searches)?;
        append_audit(
            &transaction,
            "library_saved_searches",
            "local",
            "updated",
            &json!({ "count": searches.as_array().map_or(0, Vec::len) }),
        )?;
        transaction.commit().map_err(to_error)?;
        load_library_saved_searches(&self.connection)
    }

    pub fn library_saved_searches(&self) -> Result<Vec<LibrarySavedSearch>, String> {
        load_library_saved_searches(&self.connection)
    }

    /// Update only Library relationships for an existing canonical item.
    /// Bibliographic metadata and workflow decisions intentionally stay on
    /// their own write paths.
    pub fn update_library_relations(
        &mut self,
        record_id: &str,
        relations: &Value,
    ) -> Result<LibraryItemRelations, String> {
        let record_id = record_id.trim();
        if record_id.is_empty() {
            return Err("library relationship update requires a record id".to_string());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        let (stored_revision, payload) = transaction
            .query_row(
                "SELECT revision, payload FROM canonical_records WHERE id = ?1",
                [record_id],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(to_error)?
            .ok_or_else(|| format!("unknown canonical record: {record_id}"))?;
        let mut record = decode_payload::<CanonicalRecord>(&payload)?;
        let normalized_relations = normalize_legacy_primary_pdf_references(relations, record_id);
        sync_library_item_relations_in_transaction(&transaction, record_id, &normalized_relations)?;
        merge_legacy_library_relation_cache(&mut record, &normalized_relations);
        record.revision = stored_revision.saturating_add(1);
        record.updated_at = now_iso8601();
        let changed = transaction
            .execute(
                "UPDATE canonical_records SET revision = ?2, payload = ?3, updated_at = ?4
                 WHERE id = ?1 AND revision = ?5",
                params![
                    record.id,
                    record.revision,
                    encode_payload(&record)?,
                    record.updated_at,
                    stored_revision,
                ],
            )
            .map_err(to_error)?;
        if changed == 0 {
            return Err(format!(
                "canonical record {record_id} changed in another process; retry library relationship update"
            ));
        }
        // The normalized tables are authoritative, while legacyLibrary is a
        // rebuildable compatibility cache. Refreshing that cache here keeps
        // old retrieval and FTS consumers coherent without moving
        // bibliographic or workflow fields into the relationship tables.
        upsert_full_text_index(&transaction, &record)?;
        append_audit(
            &transaction,
            "library_item",
            record_id,
            "relations_updated",
            &json!({
                "fields": [
                    "collections",
                    "tags",
                    "attachments",
                    "notes",
                    "annotations",
                    "relations"
                ]
            }),
        )?;
        transaction.commit().map_err(to_error)?;
        load_library_item_relations(&self.connection, record_id)
    }

    /// Replace the normalized collection tree without touching item
    /// bibliographic fields, screening decisions, or evidence. Removing a
    /// collection cascades only its membership links.
    pub fn update_library_collections(
        &mut self,
        collections: &Value,
    ) -> Result<Vec<LibraryCollection>, String> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        sync_library_collections_in_transaction(&transaction, collections)?;
        append_audit(
            &transaction,
            "library_collections",
            "library",
            "collections_updated",
            &json!({
                "count": collections.as_array().map_or(0, Vec::len),
            }),
        )?;
        transaction.commit().map_err(to_error)?;
        load_library_collections(&self.connection)
    }

    /// Search title, abstract, tags, notes, annotations, and other local
    /// record metadata through SQLite FTS5. The returned identifiers remain
    /// canonical record ids, so callers can fetch the authoritative payload.
    pub fn full_text_search(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<LiteratureFullTextHit>, String> {
        Ok(self.full_text_search_page(query, limit, 0)?.hits)
    }

    /// Ranked, paged local retrieval that combines strict AND, broad
    /// prefix-OR and a bounded typo-tolerant fallback. All matching ids are
    /// ranked before slicing, so `total` and `nextOffset` are honest.
    pub fn full_text_search_page(
        &self,
        query: &str,
        limit: usize,
        offset: usize,
    ) -> Result<LiteratureFullTextPage, String> {
        let exact = fts_expression(query);
        if exact.is_empty() {
            return Ok(LiteratureFullTextPage {
                hits: Vec::new(),
                total: 0,
                offset,
                limit: limit.max(1),
                exhausted: true,
                next_offset: None,
                strategies: Vec::new(),
            });
        }
        let broad = fts_or_prefix_expression(query);
        let mut scores = BTreeMap::<String, f64>::new();
        let mut strategies = Vec::new();
        collect_fts_scores(&self.connection, &exact, 0.0, &mut scores)?;
        strategies.push("and_exact".to_string());
        if !broad.is_empty() && broad != exact {
            collect_fts_scores(&self.connection, &broad, 4.0, &mut scores)?;
            strategies.push("or_prefix".to_string());
        }

        // Typo recovery is activated adaptively when lexical retrieval does
        // not fill the requested page. Candidate spellings come from the
        // bounded FTS vocabulary and are then resolved by the FTS index; this
        // avoids scanning every title/body document for each deeper page.
        let target = offset.saturating_add(limit.max(1));
        if scores.len() < target {
            let terms = fts_terms(query);
            let fuzzy = fuzzy_fts_expression(&self.connection, &terms)?;
            if !fuzzy.is_empty() {
                collect_fts_scores(&self.connection, &fuzzy, 100.0, &mut scores)?;
                strategies.push("fuzzy_fallback".to_string());
            }
        }
        let mut hits = scores
            .into_iter()
            .map(|(record_id, score)| LiteratureFullTextHit { record_id, score })
            .collect::<Vec<_>>();
        hits.sort_by(|left, right| {
            left.score
                .total_cmp(&right.score)
                .then_with(|| left.record_id.cmp(&right.record_id))
        });
        let total = hits.len();
        let page_limit = limit.max(1);
        let hits = hits
            .into_iter()
            .skip(offset)
            .take(page_limit)
            .collect::<Vec<_>>();
        let next = offset.saturating_add(hits.len());
        let exhausted = next >= total;
        Ok(LiteratureFullTextPage {
            hits,
            total,
            offset,
            limit: page_limit,
            exhausted,
            next_offset: (!exhausted).then_some(next),
            strategies,
        })
    }

    /// Suggest title-normalized duplicate candidates without merging them.
    /// Strong-identifier conflicts are intentionally left for a human to
    /// resolve in the Desktop merge panel.
    pub fn duplicate_candidates(&self) -> Result<Vec<LiteratureDuplicateCandidate>, String> {
        // Grouping runs entirely in SQL. The identifier columns are written
        // from `record.identifiers` on every insert and merge, so they carry
        // the same precedence signal the payload does — and reading them
        // instead means a library with no duplicates decodes nothing at all.
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, normalized_title, doi, arxiv_id, scopus_id
                 FROM canonical_records
                 WHERE normalized_title IN (
                   SELECT normalized_title FROM canonical_records
                   GROUP BY normalized_title HAVING COUNT(*) > 1
                 )
                 ORDER BY normalized_title, id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(DuplicateCandidateRow {
                    id: row.get(0)?,
                    normalized_title: row.get(1)?,
                    doi: row.get(2)?,
                    arxiv_id: row.get(3)?,
                    scopus_id: row.get(4)?,
                })
            })
            .map_err(to_error)?;
        let mut grouped = BTreeMap::<String, Vec<DuplicateCandidateRow>>::new();
        for row in rows {
            let row = row.map_err(to_error)?;
            grouped
                .entry(row.normalized_title.clone())
                .or_default()
                .push(row);
        }
        let mut candidates = Vec::new();
        for (title, mut records) in grouped {
            if records.len() < 2 {
                continue;
            }
            records.sort_by(duplicate_candidate_precedence);
            for duplicate in records.iter().skip(1) {
                candidates.push(LiteratureDuplicateCandidate {
                    primary_record_id: records[0].id.clone(),
                    duplicate_record_id: duplicate.id.clone(),
                    normalized_title: title.clone(),
                    reason: "same_normalized_title".to_string(),
                });
            }
        }
        Ok(candidates)
    }

    /// Merge two explicitly user-selected canonical records. Related search
    /// runs, screening decisions, evidence cards, legacy tags, collections,
    /// attachments, notes, and annotations are remapped before the duplicate
    /// row is removed.
    pub fn merge_canonical_records(
        &mut self,
        primary_record_id: &str,
        duplicate_record_id: &str,
    ) -> Result<CanonicalRecord, String> {
        if primary_record_id.trim().is_empty() || duplicate_record_id.trim().is_empty() {
            return Err("choose both a primary and duplicate record".to_string());
        }
        if primary_record_id == duplicate_record_id {
            return Err("a record cannot be merged into itself".to_string());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        let load = |id: &str| -> Result<CanonicalRecord, String> {
            let payload = transaction
                .query_row(
                    "SELECT payload FROM canonical_records WHERE id = ?1",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(to_error)?
                .ok_or_else(|| format!("unknown canonical record: {id}"))?;
            decode_payload(&payload)
        };
        let mut primary = load(primary_record_id)?;
        let duplicate = load(duplicate_record_id)?;
        let expected_revision = primary.revision.max(initial_revision());
        merge_record_observation(&mut primary, &duplicate);
        primary.revision = expected_revision.saturating_add(1);
        primary.updated_at = now_iso8601();
        let changed = transaction
            .execute(
                "UPDATE canonical_records SET normalized_title = ?2, doi = ?3, arxiv_id = ?4,
                 scopus_id = ?5, revision = ?6, payload = ?7, updated_at = ?8
                 WHERE id = ?1 AND revision = ?9",
                params![
                    primary.id,
                    primary.normalized_title,
                    primary.identifiers.doi,
                    primary.identifiers.arxiv_id,
                    primary.identifiers.scopus_id,
                    primary.revision,
                    encode_payload(&primary)?,
                    primary.updated_at,
                    expected_revision,
                ],
            )
            .map_err(to_error)?;
        if changed == 0 {
            return Err("primary record changed in another process; retry the merge".to_string());
        }
        remap_record_references(&transaction, duplicate_record_id, primary_record_id)?;
        transaction
            .execute(
                "DELETE FROM canonical_records WHERE id = ?1",
                [duplicate_record_id],
            )
            .map_err(to_error)?;
        transaction
            .execute(
                "DELETE FROM literature_full_text WHERE record_id = ?1",
                [duplicate_record_id],
            )
            .map_err(to_error)?;
        upsert_record_aliases(&transaction, &primary, primary_record_id)?;
        upsert_record_aliases(&transaction, &duplicate, primary_record_id)?;
        upsert_full_text_index(&transaction, &primary)?;
        append_audit(
            &transaction,
            "canonical_record",
            primary_record_id,
            "user_merged_duplicate",
            &json!({ "duplicateRecordId": duplicate_record_id }),
        )?;
        transaction.commit().map_err(to_error)?;
        Ok(primary)
    }

    /// Read-side API for protocol history. Consumers should use this instead
    /// of deriving search history from legacy library JSON.
    pub fn list_search_runs(&self, protocol_id: Option<&str>) -> Result<Vec<SearchRun>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT payload FROM search_runs
                 WHERE (?1 IS NULL OR protocol_id = ?1)
                 ORDER BY started_at DESC, id ASC",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([protocol_id], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        let runs = rows
            .map(|row| {
                row.map_err(to_error)
                    .and_then(|payload| decode_payload(&payload))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(runs)
    }

    pub fn has_legacy_library_bootstrap(&self) -> Result<bool, String> {
        Ok(self.meta_value(LEGACY_LIBRARY_BOOTSTRAP_KEY)?.is_some())
    }

    pub fn mark_legacy_library_bootstrap(&mut self) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        transaction
            .execute(
                "INSERT INTO metadata(key, value) VALUES (?1, 'true')
                 ON CONFLICT(key) DO NOTHING",
                [LEGACY_LIBRARY_BOOTSTRAP_KEY],
            )
            .map_err(to_error)?;
        transaction.commit().map_err(to_error)
    }

    pub fn set_legacy_library_projection_meta(&mut self, metadata: &Value) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        transaction
            .execute(
                "INSERT INTO metadata(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![LEGACY_LIBRARY_META_KEY, encode_payload(metadata)?],
            )
            .map_err(to_error)?;
        if metadata.get("collections").is_some() {
            sync_library_collections_in_transaction(&transaction, &metadata["collections"])?;
        }
        if metadata.get("searches").is_some() {
            sync_library_saved_searches_in_transaction(&transaction, &metadata["searches"])?;
        }
        append_audit(
            &transaction,
            "legacy_library_projection",
            LEGACY_LIBRARY_META_KEY,
            "metadata_updated",
            &json!({}),
        )?;
        transaction.commit().map_err(to_error)
    }

    pub fn legacy_library_projection_meta(&self) -> Result<Value, String> {
        self.meta_value(LEGACY_LIBRARY_META_KEY)?
            .map(|value| decode_payload(&value))
            .transpose()
            .map(|value| value.unwrap_or_else(|| json!({})))
    }

    /// Researcher-owned library preferences. These are scoped to the project
    /// rather than the application: a Chinese review and an English paper in
    /// two projects legitimately want different attachment naming.
    pub fn library_preferences(&self) -> Result<LibraryPreferences, String> {
        let stored = self
            .meta_value(LIBRARY_PREFERENCES_KEY)?
            .map(|value| decode_payload::<LibraryPreferences>(&value))
            .transpose()?;
        Ok(stored.unwrap_or_default())
    }

    pub fn set_library_preferences(
        &mut self,
        preferences: &LibraryPreferences,
    ) -> Result<LibraryPreferences, String> {
        let normalized = preferences.normalized();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        transaction
            .execute(
                "INSERT INTO metadata(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![LIBRARY_PREFERENCES_KEY, encode_payload(&normalized)?],
            )
            .map_err(to_error)?;
        append_audit(
            &transaction,
            "library_preferences",
            LIBRARY_PREFERENCES_KEY,
            "preferences_updated",
            &json!({ "attachmentNameTemplate": normalized.attachment_name_template }),
        )?;
        transaction.commit().map_err(to_error)?;
        Ok(normalized)
    }

    pub fn start_run(&mut self, protocol: &SearchProtocol) -> Result<SearchRun, String> {
        let run = SearchRun {
            schema_version: LITERATURE_SCHEMA_VERSION,
            id: new_id("run")?,
            revision: initial_revision(),
            protocol_id: protocol.id.clone(),
            protocol_revision: protocol.revision,
            status: SearchRunStatus::Running,
            started_at: now_iso8601(),
            completed_at: None,
            source_attempts: Vec::new(),
            record_ids: Vec::new(),
            ranked_records: Vec::new(),
            artifact_ids: Vec::new(),
            notes: Vec::new(),
        };
        let transaction = self.connection.transaction().map_err(to_error)?;
        insert_run(&transaction, &run)?;
        append_audit(&transaction, "search_run", &run.id, "started", &json!({}))?;
        transaction.commit().map_err(to_error)?;
        Ok(run)
    }

    /// Loads an interrupted running run so callers can continue only the
    /// unfinished source attempts. A resumed run retains its original id and
    /// audit trail; it is never silently replaced by a fresh execution.
    pub fn resume_run(
        &mut self,
        run_id: &str,
        protocol: &SearchProtocol,
    ) -> Result<SearchRun, String> {
        let run = self
            .load_run(run_id)?
            .ok_or_else(|| format!("unknown search run: {run_id}"))?;
        if run.status != SearchRunStatus::Running {
            return Err(format!(
                "search run {run_id} is {:?} and cannot be resumed",
                run.status
            ));
        }
        if run.protocol_id != protocol.id || run.protocol_revision != protocol.revision {
            return Err("a search run can only resume its original protocol revision".to_string());
        }
        let transaction = self.connection.transaction().map_err(to_error)?;
        append_audit(
            &transaction,
            "search_run",
            &run.id,
            "resumed",
            &json!({ "sourceAttempts": run.source_attempts.len() }),
        )?;
        transaction.commit().map_err(to_error)?;
        Ok(run)
    }

    #[must_use]
    pub fn load_run(&self, run_id: &str) -> Result<Option<SearchRun>, String> {
        self.connection
            .query_row(
                "SELECT payload FROM search_runs WHERE id = ?1",
                [run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(to_error)?
            .map(|payload| decode_payload(&payload))
            .transpose()
    }

    /// Makes a running run durable after every source-state transition. This
    /// is the checkpoint used by the tool and Desktop paths after a process or
    /// network interruption.
    pub fn checkpoint_run(&mut self, run: &mut SearchRun) -> Result<(), String> {
        if run.status != SearchRunStatus::Running {
            return Err("only running search runs can be checkpointed".to_string());
        }
        let expected_revision = run.revision.max(initial_revision());
        run.revision = expected_revision.saturating_add(1);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        let changed = transaction
            .execute(
                "UPDATE search_runs SET revision = ?2, payload = ?3
                 WHERE id = ?1 AND status = 'running' AND revision = ?4",
                params![
                    run.id,
                    run.revision,
                    encode_payload(run)?,
                    expected_revision
                ],
            )
            .map_err(to_error)?;
        if changed == 0 {
            run.revision = expected_revision;
            return Err(format!(
                "search run {} changed in another process and cannot be checkpointed",
                run.id
            ));
        }
        append_audit(
            &transaction,
            "search_run",
            &run.id,
            "checkpointed",
            &json!({ "sourceAttempts": run.source_attempts.len(), "artifacts": run.artifact_ids.len() }),
        )?;
        transaction.commit().map_err(to_error)
    }

    pub fn finish_run(&mut self, run: &mut SearchRun) -> Result<(), String> {
        if !run.status.is_terminal() {
            return Err("search run must be terminal before it can be persisted".to_string());
        }
        let expected_revision = run.revision.max(initial_revision());
        run.revision = expected_revision.saturating_add(1);
        if run.completed_at.is_none() {
            run.completed_at = Some(now_iso8601());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        let changed = transaction
            .execute(
                "UPDATE search_runs SET status = ?2, completed_at = ?3, revision = ?4, payload = ?5
                 WHERE id = ?1 AND status = 'running' AND revision = ?6",
                params![
                    run.id,
                    run_status_name(run.status),
                    run.completed_at,
                    run.revision,
                    encode_payload(run)?,
                    expected_revision,
                ],
            )
            .map_err(to_error)?;
        if changed == 0 {
            run.revision = expected_revision;
            return Err(format!(
                "search run {} is already terminal or changed in another process",
                run.id
            ));
        }
        append_audit(
            &transaction,
            "search_run",
            &run.id,
            "completed",
            &json!({ "status": run_status_name(run.status) }),
        )?;
        transaction.commit().map_err(to_error)
    }

    /// Writes an immutable artifact under the project-local literature root.
    /// The caller must pass a sanitized request/result body; this store never
    /// accepts credentials as artifact metadata.
    pub fn write_run_artifact(
        &mut self,
        search_run_id: &str,
        source: &str,
        kind: &str,
        extension: &str,
        media_type: &str,
        bytes: &[u8],
    ) -> Result<RawArtifact, String> {
        if !self.run_exists(search_run_id)? {
            return Err(format!("unknown search run: {search_run_id}"));
        }
        let artifact_id = new_id("artifact")?;
        let safe_source = safe_component(source)?;
        let safe_kind = safe_component(kind)?;
        let safe_extension = safe_extension(extension)?;
        let relative_path = PathBuf::from(ARTIFACTS_DIRECTORY)
            .join(safe_component(search_run_id)?)
            .join(format!(
                "{safe_source}-{safe_kind}-{artifact_id}.{safe_extension}"
            ));
        let path = self.root.join(&relative_path);
        write_file_atomically(&path, bytes).map_err(to_error)?;
        let artifact = RawArtifact {
            id: artifact_id,
            search_run_id: search_run_id.to_string(),
            source: source.trim().to_string(),
            kind: kind.trim().to_string(),
            relative_path: relative_path.to_string_lossy().replace('\\', "/"),
            sha256: sha256_hex(bytes),
            bytes: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            media_type: media_type.trim().to_string(),
            created_at: now_iso8601(),
        };
        let transaction = self.connection.transaction().map_err(to_error)?;
        transaction
            .execute(
                "INSERT INTO raw_artifacts(id, search_run_id, source, relative_path, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    artifact.id,
                    artifact.search_run_id,
                    artifact.source,
                    artifact.relative_path,
                    encode_payload(&artifact)?,
                    artifact.created_at,
                ],
            )
            .map_err(to_error)?;
        append_audit(
            &transaction,
            "raw_artifact",
            &artifact.id,
            "written",
            &json!({ "searchRunId": search_run_id, "sha256": artifact.sha256 }),
        )?;
        transaction.commit().map_err(to_error)?;
        Ok(artifact)
    }

    /// Inserts a record or attaches newly observed identifiers/provenance to an
    /// existing canonical record. Later discovery fills metadata gaps but never
    /// overwrites a user-resolved value.
    pub fn insert_canonical_record(&mut self, record: &CanonicalRecord) -> Result<bool, String> {
        Ok(self.upsert_canonical_record(record)?.inserted)
    }

    /// Resolves every supported identifier before writing. The whole
    /// read/merge/write operation runs in an IMMEDIATE transaction and uses a
    /// revision guard, so a second project process receives a retryable error
    /// rather than silently losing provenance or a field conflict.
    pub fn upsert_canonical_record(
        &mut self,
        record: &CanonicalRecord,
    ) -> Result<CanonicalRecordUpsert, String> {
        validate_record(record)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        let mut matches = resolve_equivalent_records(&transaction, record)?;
        if matches.is_empty() {
            let mut inserted = record.clone();
            inserted.revision = initial_revision();
            ensure_record_observation(&mut inserted);
            insert_canonical_record(&transaction, &inserted)?;
            upsert_record_aliases(&transaction, &inserted, &inserted.id)?;
            append_audit(
                &transaction,
                "canonical_record",
                &inserted.id,
                "inserted",
                &json!({ "title": inserted.title }),
            )?;
            transaction.commit().map_err(to_error)?;
            return Ok(CanonicalRecordUpsert {
                record: inserted,
                inserted: true,
                merged_record_ids: Vec::new(),
            });
        }

        matches.sort_by(canonical_record_precedence);
        let mut canonical = matches.remove(0);
        let mut merged_record_ids = Vec::new();
        for duplicate in matches {
            if duplicate.id == canonical.id {
                continue;
            }
            // An identifier-less observation can title-match multiple existing
            // records (for example, two different editorials). It may enrich
            // the selected canonical record, but it must never cause those
            // independently identified existing records to merge with each
            // other merely because the incoming title is ambiguous.
            if !records_are_equivalent(&canonical, &duplicate) {
                continue;
            }
            merge_record_observation(&mut canonical, &duplicate);
            remap_record_references(&transaction, &duplicate.id, &canonical.id)?;
            transaction
                .execute(
                    "DELETE FROM canonical_records WHERE id = ?1",
                    [&duplicate.id],
                )
                .map_err(to_error)?;
            transaction
                .execute(
                    "DELETE FROM literature_full_text WHERE record_id = ?1",
                    [&duplicate.id],
                )
                .map_err(to_error)?;
            merged_record_ids.push(duplicate.id);
        }
        let changed = merge_record_observation(&mut canonical, record);
        let expected_revision = canonical.revision.max(initial_revision());
        canonical.revision = expected_revision.saturating_add(1);
        canonical.updated_at = now_iso8601();
        let changed_rows = transaction
            .execute(
                "UPDATE canonical_records SET normalized_title = ?2, doi = ?3, arxiv_id = ?4,
                 scopus_id = ?5, revision = ?6, payload = ?7, updated_at = ?8
                 WHERE id = ?1 AND revision = ?9",
                params![
                    canonical.id,
                    canonical.normalized_title,
                    canonical.identifiers.doi,
                    canonical.identifiers.arxiv_id,
                    canonical.identifiers.scopus_id,
                    canonical.revision,
                    encode_payload(&canonical)?,
                    canonical.updated_at,
                    expected_revision,
                ],
            )
            .map_err(to_error)?;
        if changed_rows == 0 {
            return Err(format!(
                "canonical record {} changed in another process; retry the observation merge",
                canonical.id
            ));
        }
        upsert_full_text_index(&transaction, &canonical)?;
        sync_library_item_model_in_transaction(&transaction, &canonical, None, false)?;
        // Every alias observed on this upsert must resolve to the surviving
        // canonical row. In particular, `record.id` can be an incoming
        // provisional id that has never had its own database row.
        upsert_record_aliases(&transaction, &canonical, &canonical.id)?;
        upsert_record_aliases(&transaction, record, &canonical.id)?;
        append_audit(
            &transaction,
            "canonical_record",
            &canonical.id,
            if changed || !merged_record_ids.is_empty() {
                "observation_merged"
            } else {
                "observation_replayed"
            },
            &json!({
                "provenanceCount": canonical.provenance.len(),
                "conflictCount": canonical.field_conflicts.len(),
                "mergedRecordIds": merged_record_ids,
            }),
        )?;
        transaction.commit().map_err(to_error)?;
        Ok(CanonicalRecordUpsert {
            record: canonical,
            inserted: false,
            merged_record_ids,
        })
    }

    pub fn load_canonical_record(&self, id: &str) -> Result<Option<CanonicalRecord>, String> {
        self.connection
            .query_row(
                "SELECT payload FROM canonical_records WHERE id = ?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(to_error)?
            .map(|payload| decode_payload(&payload))
            .transpose()
    }

    pub fn append_screen_decision(&mut self, decision: &ScreenDecision) -> Result<(), String> {
        self.ensure_record_exists(&decision.record_id)?;
        self.ensure_protocol_exists(&decision.protocol_id)?;
        if decision.reason.trim().is_empty() {
            return Err("screen decision reason must not be empty".to_string());
        }
        let transaction = self.connection.transaction().map_err(to_error)?;
        transaction
            .execute(
                "INSERT INTO screen_decisions(id, record_id, protocol_id, created_at, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    decision.id,
                    decision.record_id,
                    decision.protocol_id,
                    decision.created_at,
                    encode_payload(decision)?,
                ],
            )
            .map_err(to_error)?;
        append_audit(
            &transaction,
            "screen_decision",
            &decision.id,
            "appended",
            &json!({ "recordId": decision.record_id, "outcome": decision.outcome }),
        )?;
        transaction.commit().map_err(to_error)
    }

    pub fn append_evidence_card(&mut self, card: &EvidenceCard) -> Result<(), String> {
        self.ensure_record_exists(&card.record_id)?;
        if card.claim.trim().is_empty() {
            return Err("evidence card claim must not be empty".to_string());
        }
        let transaction = self.connection.transaction().map_err(to_error)?;
        transaction
            .execute(
                "INSERT INTO evidence_cards(id, record_id, created_at, payload) VALUES (?1, ?2, ?3, ?4)",
                params![card.id, card.record_id, card.created_at, encode_payload(card)?],
            )
            .map_err(to_error)?;
        append_audit(
            &transaction,
            "evidence_card",
            &card.id,
            "appended",
            &json!({ "recordId": card.record_id, "strength": card.strength }),
        )?;
        transaction.commit().map_err(to_error)
    }

    /// Imports the existing Desktop library without guessing protocols,
    /// screening reasons, evidence strength, or reviewer decisions.
    pub fn import_legacy_library(
        &mut self,
        library_path: &Path,
    ) -> Result<LegacyImportReport, String> {
        let bytes = fs::read(library_path).map_err(to_error)?;
        let fingerprint = sha256_hex(&bytes);
        let marker = format!("legacy_library_import:{fingerprint}");
        if let Some(previous) = self.meta_value(&marker)? {
            let report = decode_payload::<LegacyImportReport>(&previous)?;
            return Ok(LegacyImportReport {
                already_imported: true,
                ..report
            });
        }
        let library: Value = serde_json::from_slice(&bytes).map_err(|error| {
            format!("invalid legacy library {}: {error}", library_path.display())
        })?;
        let papers = library["papers"].as_array().cloned().unwrap_or_default();
        let now = now_iso8601();
        let protocol = SearchProtocol {
            schema_version: LITERATURE_SCHEMA_VERSION,
            id: new_id("protocol")?,
            revision: 1,
            draft: SearchProtocolDraft {
                question: "Imported legacy literature library".to_string(),
                scope: "Historical metadata imported from papers/library.json; original search protocols are unavailable."
                    .to_string(),
                time_window: String::new(),
                sort_order: "relevance".to_string(),
                databases: vec!["legacy_library".to_string()],
                queries: BTreeMap::new(),
                query_variants: BTreeMap::new(),
                max_results: Some(papers.len().max(1)),
                inclusion_criteria: Vec::new(),
                exclusion_criteria: Vec::new(),
                known_key_papers: Vec::new(),
            },
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        let run = SearchRun {
            schema_version: LITERATURE_SCHEMA_VERSION,
            id: new_id("run")?,
            revision: initial_revision(),
            protocol_id: protocol.id.clone(),
            protocol_revision: protocol.revision,
            status: SearchRunStatus::LegacyImported,
            started_at: now.clone(),
            completed_at: Some(now.clone()),
            source_attempts: vec![SourceAttempt {
                source: "legacy_library".to_string(),
                request: json!({
                    "sourcePath": library_path.display().to_string(),
                    "sha256": fingerprint,
                }),
                started_at: now.clone(),
                completed_at: Some(now.clone()),
                status: SourceAttemptStatus::Completed,
                hit_count: Some(u64::try_from(papers.len()).unwrap_or(u64::MAX)),
                returned_count: u64::try_from(papers.len()).unwrap_or(u64::MAX),
                coverage: SearchCoverage {
                    total_hits: Some(u64::try_from(papers.len()).unwrap_or(u64::MAX)),
                    fetched: u64::try_from(papers.len()).unwrap_or(u64::MAX),
                    unique: u64::try_from(papers.len()).unwrap_or(u64::MAX),
                    exhausted: true,
                    next_cursor: None,
                    truncated_reason: None,
                },
                quota: Value::Null,
                failure_code: None,
                failure_message: None,
                coverage_note: Some(
                    "Legacy import preserves library metadata but does not infer historical protocols, screening decisions, or evidence cards."
                        .to_string(),
                ),
                artifact_ids: Vec::new(),
            }],
            record_ids: Vec::new(),
            ranked_records: Vec::new(),
            artifact_ids: Vec::new(),
            notes: vec!["Imported from legacy papers/library.json".to_string()],
        };
        let artifact = self.write_legacy_artifact(&run.id, &bytes)?;
        let mut completed_run = run;
        completed_run.artifact_ids.push(artifact.id.clone());
        completed_run.source_attempts[0]
            .artifact_ids
            .push(artifact.id.clone());

        // Reuse the normal identity resolver so importing an old library into
        // a project that already has protocol records cannot fork identities.
        // The artifact and run ids are deterministic inputs to the observation
        // even though their rows are committed immediately afterwards.
        let mut imported_record_ids = Vec::new();
        let mut imported_records = 0usize;
        for paper in &papers {
            let Some(record) =
                legacy_record_from_value(paper, Some(&completed_run.id), Some(&artifact.id), &now)
            else {
                continue;
            };
            let persisted = self.upsert_canonical_record(&record)?.record;
            // Keep the historical top-level metadata for compatibility, but
            // also write its Library relationships into the normalized tables
            // and materialize the canonical legacyLibrary cache.
            let persisted = self.set_legacy_library_paper(&persisted.id, paper, true)?;
            imported_record_ids.push(persisted.id);
            imported_records += 1;
        }
        completed_run.record_ids = imported_record_ids;
        let report = LegacyImportReport {
            already_imported: false,
            protocol_id: protocol.id.clone(),
            search_run_id: completed_run.id.clone(),
            imported_records,
            source_path: library_path.display().to_string(),
        };

        let transaction = self.connection.transaction().map_err(to_error)?;
        insert_protocol(&transaction, &protocol)?;
        insert_run(&transaction, &completed_run)?;
        insert_artifact(&transaction, &artifact)?;
        transaction
            .execute(
                "INSERT INTO metadata(key, value) VALUES (?1, ?2)",
                params![marker, encode_payload(&report)?],
            )
            .map_err(to_error)?;
        transaction
            .execute(
                "INSERT INTO metadata(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![LEGACY_LIBRARY_BOOTSTRAP_KEY, "true"],
            )
            .map_err(to_error)?;
        let projection_meta = legacy_projection_meta_from_library(&library);
        transaction
            .execute(
                "INSERT INTO metadata(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![LEGACY_LIBRARY_META_KEY, encode_payload(&projection_meta)?],
            )
            .map_err(to_error)?;
        append_audit(
            &transaction,
            "legacy_library",
            &completed_run.id,
            "imported",
            &json!({ "records": imported_records, "artifactId": artifact.id }),
        )?;
        transaction.commit().map_err(to_error)?;
        Ok(report)
    }

    /// Converts legacy Desktop-library edits into canonical records before the
    /// compatibility projection is rewritten. This is the only supported JSON
    /// write-back path; callers must not mutate `papers/library.json` directly.
    pub fn sync_legacy_library_snapshot(
        &mut self,
        library: &Value,
    ) -> Result<Vec<CanonicalRecord>, String> {
        if !library.is_object() {
            return Err("legacy library snapshot must be a JSON object".to_string());
        }
        let papers = library["papers"].as_array().cloned().unwrap_or_default();
        let observed_at = now_iso8601();
        let mut records = Vec::new();
        for paper in papers {
            let Some(record) = legacy_record_from_value(&paper, None, None, &observed_at) else {
                continue;
            };
            let persisted = self.upsert_canonical_record(&record)?.record;
            let persisted = self.set_legacy_library_paper(&persisted.id, &paper, true)?;
            records.push(persisted);
        }
        let visible_ids = records
            .iter()
            .map(|record| record.id.as_str())
            .collect::<BTreeSet<_>>();
        for existing in self.list_canonical_records()? {
            self.set_legacy_library_visibility(
                &existing.id,
                visible_ids.contains(existing.id.as_str()),
            )?;
        }
        self.set_legacy_library_projection_meta(&legacy_projection_meta_from_library(library))?;
        self.mark_legacy_library_bootstrap()?;
        Ok(records)
    }

    pub fn set_legacy_library_visibility(
        &mut self,
        record_id: &str,
        visible: bool,
    ) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        let (stored_revision, payload) = transaction
            .query_row(
                "SELECT revision, payload FROM canonical_records WHERE id = ?1",
                [record_id],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(to_error)?
            .ok_or_else(|| format!("unknown canonical record: {record_id}"))?;
        let mut record = decode_payload::<CanonicalRecord>(&payload)?;
        let mut metadata = record.metadata.as_object().cloned().unwrap_or_default();
        if metadata.get("legacyLibraryHidden").and_then(Value::as_bool) == Some(!visible) {
            return Ok(());
        }
        metadata.insert("legacyLibraryHidden".to_string(), Value::Bool(!visible));
        record.metadata = Value::Object(metadata);
        record.revision = stored_revision.saturating_add(1);
        record.updated_at = now_iso8601();
        let changed = transaction
            .execute(
                "UPDATE canonical_records SET revision = ?2, payload = ?3, updated_at = ?4
                 WHERE id = ?1 AND revision = ?5",
                params![
                    record.id,
                    record.revision,
                    encode_payload(&record)?,
                    record.updated_at,
                    stored_revision,
                ],
            )
            .map_err(to_error)?;
        if changed == 0 {
            return Err(format!(
                "canonical record {record_id} changed in another process; retry library visibility update"
            ));
        }
        set_record_visibility_in_transaction(&transaction, record_id, visible)?;
        upsert_full_text_index(&transaction, &record)?;
        transaction.commit().map_err(to_error)
    }

    fn set_legacy_library_paper(
        &mut self,
        record_id: &str,
        paper: &Value,
        complete_snapshot: bool,
    ) -> Result<CanonicalRecord, String> {
        let normalized_paper = normalize_legacy_primary_pdf_references(paper, record_id);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        let (stored_revision, payload) = transaction
            .query_row(
                "SELECT revision, payload FROM canonical_records WHERE id = ?1",
                [record_id],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(to_error)?
            .ok_or_else(|| format!("unknown canonical record: {record_id}"))?;
        let mut record = decode_payload::<CanonicalRecord>(&payload)?;
        let mut metadata = record.metadata.as_object().cloned().unwrap_or_default();
        metadata.insert("legacyLibrary".to_string(), normalized_paper.clone());
        record.metadata = Value::Object(metadata);
        record.revision = stored_revision.saturating_add(1);
        record.updated_at = now_iso8601();
        let changed = transaction
            .execute(
                "UPDATE canonical_records SET revision = ?2, payload = ?3, updated_at = ?4
                 WHERE id = ?1 AND revision = ?5",
                params![
                    record.id,
                    record.revision,
                    encode_payload(&record)?,
                    record.updated_at,
                    stored_revision,
                ],
            )
            .map_err(to_error)?;
        if changed == 0 {
            return Err(format!(
                "canonical record {record_id} changed in another process; retry legacy projection"
            ));
        }
        sync_library_item_relations_in_transaction(&transaction, record_id, &normalized_paper)?;
        sync_library_item_model_in_transaction(
            &transaction,
            &record,
            Some(&normalized_paper),
            complete_snapshot,
        )?;
        // The normalized item tables are now complete. Rebuild the canonical
        // projection from them so clears, creator roles and custom fields are
        // reflected in the record returned after this compatibility write.
        sync_canonical_record_from_library_item_in_transaction(&transaction, record_id)?;
        let refreshed_payload = transaction
            .query_row(
                "SELECT payload FROM canonical_records WHERE id = ?1",
                [record_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(to_error)?;
        let record = decode_payload::<CanonicalRecord>(&refreshed_payload)?;
        append_audit(
            &transaction,
            "canonical_record",
            record_id,
            "legacy_library_metadata_updated",
            &json!({}),
        )?;
        transaction.commit().map_err(to_error)?;
        Ok(record)
    }

    /// Update only the Desktop compatibility metadata for one already
    /// canonical record.  This is deliberately narrower than importing a
    /// whole legacy library snapshot: callers cannot hide, overwrite, or
    /// re-ingest unrelated records through this path.
    pub fn update_legacy_library_paper(
        &mut self,
        record_id: &str,
        paper: &Value,
    ) -> Result<CanonicalRecord, String> {
        self.set_legacy_library_paper(record_id, paper, false)
    }

    /// Update the compatibility projection from a complete Desktop paper
    /// snapshot. Unlike the legacy incremental bridge, omitted optional
    /// fields are intentional clears on this path.
    pub fn update_legacy_library_paper_snapshot(
        &mut self,
        record_id: &str,
        paper: &Value,
    ) -> Result<CanonicalRecord, String> {
        self.set_legacy_library_paper(record_id, paper, true)
    }

    /// Store extracted local PDF text only in the canonical SQLite payload and
    /// refresh its FTS5 row. The compatibility JSON projection never needs to
    /// carry a large full-text copy.
    pub fn set_record_pdf_text(&mut self, record_id: &str, text: &str) -> Result<(), String> {
        const MAX_INDEXED_PDF_CHARS: usize = 5_000_000;
        let text = text.trim();
        if text.is_empty() {
            return Ok(());
        }
        let text = text.chars().take(MAX_INDEXED_PDF_CHARS).collect::<String>();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        let (stored_revision, payload) = transaction
            .query_row(
                "SELECT revision, payload FROM canonical_records WHERE id = ?1",
                [record_id],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(to_error)?
            .ok_or_else(|| format!("unknown canonical record: {record_id}"))?;
        let mut record = decode_payload::<CanonicalRecord>(&payload)?;
        let mut metadata = record.metadata.as_object().cloned().unwrap_or_default();
        if metadata
            .get("extractedPdfText")
            .and_then(Value::as_str)
            .is_some_and(|existing| existing == text)
        {
            return Ok(());
        }
        metadata.insert(
            "extractedPdfText".to_string(),
            Value::String(text.clone()),
        );
        record.metadata = Value::Object(metadata);
        record.revision = stored_revision.saturating_add(1);
        record.updated_at = now_iso8601();
        let changed = transaction
            .execute(
                "UPDATE canonical_records SET revision = ?2, payload = ?3, updated_at = ?4
                 WHERE id = ?1 AND revision = ?5",
                params![
                    record.id,
                    record.revision,
                    encode_payload(&record)?,
                    record.updated_at,
                    stored_revision,
                ],
            )
            .map_err(to_error)?;
        if changed == 0 {
            return Err(format!(
                "canonical record {record_id} changed in another process; retry PDF text indexing"
            ));
        }
        upsert_full_text_index(&transaction, &record)?;
        sync_library_attachment_full_text_in_transaction(&transaction, record_id, None, &text)?;
        append_audit(
            &transaction,
            "canonical_record",
            record_id,
            "pdf_text_indexed",
            &json!({ "characters": record.metadata["extractedPdfText"].as_str().map_or(0, str::len) }),
        )?;
        transaction.commit().map_err(to_error)
    }

    /// Store extracted text for any attached local resource. Unlike the PDF
    /// compatibility path above, this does not copy a large body into the
    /// canonical record payload; it keeps the text in the attachment FTS table
    /// and joins it back to the parent record during local search.
    /// Repoint one attachment at a renamed file. Only the workspace-relative
    /// path and the display file name move; the attachment identity, its
    /// extracted full text and its annotations all stay attached to the same
    /// id, so renaming never costs the researcher their reading history.
    pub fn relocate_library_attachment(
        &mut self,
        attachment_id: &str,
        relative_path: &str,
        file_name: &str,
    ) -> Result<(), String> {
        let attachment_id = attachment_id.trim();
        let relative_path = relative_path.trim();
        let file_name = file_name.trim();
        if attachment_id.is_empty() || relative_path.is_empty() || file_name.is_empty() {
            return Err("attachment relocation requires an id, path and file name".to_string());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        let changed = transaction
            .execute(
                "UPDATE library_attachments SET path = ?2, filename = ?3 WHERE id = ?1",
                params![attachment_id, relative_path, file_name],
            )
            .map_err(to_error)?;
        if changed == 0 {
            return Err(format!("unknown library attachment: {attachment_id}"));
        }
        append_audit(
            &transaction,
            "library_attachment",
            attachment_id,
            "renamed",
            &json!({ "path": relative_path }),
        )?;
        transaction.commit().map_err(to_error)
    }

    pub fn set_record_attachment_text(
        &mut self,
        record_id: &str,
        attachment_id: &str,
        text: &str,
    ) -> Result<(), String> {
        const MAX_INDEXED_ATTACHMENT_CHARS: usize = 5_000_000;
        let record_id = record_id.trim();
        let attachment_id = attachment_id.trim();
        let text = text.trim();
        if record_id.is_empty() || attachment_id.is_empty() {
            return Err("attachment text indexing requires a record and attachment id".to_string());
        }
        let text = text
            .chars()
            .take(MAX_INDEXED_ATTACHMENT_CHARS)
            .collect::<String>();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(to_error)?;
        let record_exists = transaction
            .query_row(
                "SELECT 1 FROM canonical_records WHERE id = ?1",
                [record_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(to_error)?
            .is_some();
        if !record_exists {
            return Err(format!("unknown canonical record: {record_id}"));
        }
        let attachment_exists = transaction
            .query_row(
                "SELECT 1 FROM library_attachments
                 WHERE id = ?1 AND item_id = ?2",
                params![attachment_id, record_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(to_error)?
            .is_some();
        if !attachment_exists {
            return Err(format!(
                "unknown attachment {attachment_id} for canonical record {record_id}"
            ));
        }
        sync_library_attachment_full_text_in_transaction(
            &transaction,
            record_id,
            Some(attachment_id),
            &text,
        )?;
        append_audit(
            &transaction,
            "library_attachment",
            attachment_id,
            "text_indexed",
            &json!({
                "recordId": record_id,
                "characters": text.chars().count(),
            }),
        )?;
        transaction.commit().map_err(to_error)
    }

    fn write_legacy_artifact(&self, run_id: &str, bytes: &[u8]) -> Result<RawArtifact, String> {
        let artifact_id = new_id("artifact")?;
        let relative_path = PathBuf::from(ARTIFACTS_DIRECTORY)
            .join(safe_component(run_id)?)
            .join(format!("legacy-library-{artifact_id}.json"));
        write_file_atomically(&self.root.join(&relative_path), bytes).map_err(to_error)?;
        Ok(RawArtifact {
            id: artifact_id,
            search_run_id: run_id.to_string(),
            source: "legacy_library".to_string(),
            kind: "legacy_library_snapshot".to_string(),
            relative_path: relative_path.to_string_lossy().replace('\\', "/"),
            sha256: sha256_hex(bytes),
            bytes: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            media_type: "application/json".to_string(),
            created_at: now_iso8601(),
        })
    }

    fn run_exists(&self, id: &str) -> Result<bool, String> {
        self.connection
            .query_row("SELECT 1 FROM search_runs WHERE id = ?1", [id], |_| Ok(()))
            .optional()
            .map(|value| value.is_some())
            .map_err(to_error)
    }

    fn ensure_record_exists(&self, id: &str) -> Result<(), String> {
        self.connection
            .query_row(
                "SELECT 1 FROM canonical_records WHERE id = ?1",
                [id],
                |_| Ok(()),
            )
            .optional()
            .map_err(to_error)?
            .ok_or_else(|| format!("unknown canonical record: {id}"))
    }

    fn ensure_protocol_exists(&self, id: &str) -> Result<(), String> {
        self.connection
            .query_row(
                "SELECT 1 FROM search_protocols WHERE id = ?1 LIMIT 1",
                [id],
                |_| Ok(()),
            )
            .optional()
            .map_err(to_error)?
            .ok_or_else(|| format!("unknown search protocol: {id}"))
    }

    fn meta_value(&self, key: &str) -> Result<Option<String>, String> {
        self.connection
            .query_row("SELECT value FROM metadata WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(to_error)
    }
}

fn initialize_schema(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
             PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=2000;
             CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS search_protocols(
               id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id, revision)
             );
             CREATE TABLE IF NOT EXISTS search_runs(
               id TEXT PRIMARY KEY, protocol_id TEXT NOT NULL, protocol_revision INTEGER NOT NULL,
               status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
               payload TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS search_runs_protocol_idx ON search_runs(protocol_id, started_at DESC);
             CREATE TABLE IF NOT EXISTS raw_artifacts(
               id TEXT PRIMARY KEY, search_run_id TEXT NOT NULL, source TEXT NOT NULL,
               relative_path TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS canonical_records(
               id TEXT PRIMARY KEY, normalized_title TEXT NOT NULL, doi TEXT, arxiv_id TEXT,
               scopus_id TEXT, revision INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS canonical_records_doi_idx
               ON canonical_records(doi) WHERE doi IS NOT NULL;
             -- Title-normalized matching is on the hot path three times over:
             -- duplicate detection, the Duplicates special collection, and the
             -- identity probe every upsert runs. Without this index each of
             -- those is a full table scan.
             CREATE INDEX IF NOT EXISTS canonical_records_normalized_title_idx
               ON canonical_records(normalized_title);
             CREATE TABLE IF NOT EXISTS canonical_record_aliases(
               alias TEXT PRIMARY KEY, record_id TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS canonical_record_aliases_record_idx
               ON canonical_record_aliases(record_id);
             CREATE TABLE IF NOT EXISTS library_collections(
               id TEXT PRIMARY KEY, parent_id TEXT, label TEXT NOT NULL,
               order_index INTEGER NOT NULL DEFAULT 0,
               library_id TEXT NOT NULL DEFAULT 'local', item_key TEXT,
               version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
               revision INTEGER NOT NULL DEFAULT 1,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS library_collections_parent_idx
               ON library_collections(parent_id);
             CREATE TABLE IF NOT EXISTS library_tags(
               id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
               kind TEXT NOT NULL DEFAULT 'user',
               tag_type INTEGER NOT NULL DEFAULT 0, color TEXT,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS library_collection_items(
               item_id TEXT NOT NULL, collection_id TEXT NOT NULL,
               order_index INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
               PRIMARY KEY(item_id, collection_id),
               FOREIGN KEY(item_id) REFERENCES canonical_records(id) ON DELETE CASCADE,
               FOREIGN KEY(collection_id) REFERENCES library_collections(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS library_collection_items_collection_idx
               ON library_collection_items(collection_id, order_index, item_id);
             CREATE TABLE IF NOT EXISTS library_item_tags(
               item_id TEXT NOT NULL, tag_id TEXT NOT NULL,
               origin TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL,
               PRIMARY KEY(item_id, tag_id),
               FOREIGN KEY(item_id) REFERENCES canonical_records(id) ON DELETE CASCADE,
               FOREIGN KEY(tag_id) REFERENCES library_tags(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS library_item_tags_tag_idx
               ON library_item_tags(tag_id, item_id);
             CREATE TABLE IF NOT EXISTS library_attachments(
               id TEXT PRIMARY KEY, item_id TEXT NOT NULL, label TEXT NOT NULL,
               kind TEXT NOT NULL, path TEXT, url TEXT, external_path TEXT,
               mime_type TEXT, bytes INTEGER, link_mode TEXT, filename TEXT,
               charset TEXT, hash TEXT, mtime INTEGER, last_page_index INTEGER,
               source_payload TEXT, added_at TEXT NOT NULL,
               FOREIGN KEY(item_id) REFERENCES canonical_records(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS library_attachments_item_idx
               ON library_attachments(item_id, added_at, id);
             CREATE TABLE IF NOT EXISTS library_annotations(
               id TEXT PRIMARY KEY, item_id TEXT NOT NULL, attachment_id TEXT,
               page INTEGER NOT NULL, page_label TEXT, quote TEXT NOT NULL, note TEXT NOT NULL,
               kind TEXT NOT NULL, color TEXT, style TEXT, rects TEXT,
               source TEXT, image_fingerprint TEXT, source_id TEXT,
               evidence_id TEXT, annotation_type TEXT, position TEXT,
               sort_index INTEGER, author TEXT, is_external INTEGER NOT NULL DEFAULT 0,
               source_payload TEXT, created_at TEXT NOT NULL,
               FOREIGN KEY(item_id) REFERENCES canonical_records(id) ON DELETE CASCADE,
               FOREIGN KEY(attachment_id) REFERENCES library_attachments(id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS library_annotations_item_idx
               ON library_annotations(item_id, page, created_at, id);
             CREATE TABLE IF NOT EXISTS library_notes(
               id TEXT PRIMARY KEY, item_id TEXT NOT NULL, title TEXT,
               content TEXT NOT NULL, created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL, annotation_id TEXT, attachment_id TEXT,
               evidence_id TEXT, source TEXT, source_payload TEXT,
               FOREIGN KEY(item_id) REFERENCES canonical_records(id) ON DELETE CASCADE,
               FOREIGN KEY(annotation_id) REFERENCES library_annotations(id) ON DELETE SET NULL,
               FOREIGN KEY(attachment_id) REFERENCES library_attachments(id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS library_notes_item_idx
               ON library_notes(item_id, updated_at DESC, id);
             CREATE TABLE IF NOT EXISTS library_items(
               id TEXT PRIMARY KEY, item_key TEXT NOT NULL UNIQUE,
               library_id TEXT NOT NULL DEFAULT 'local',
               item_type TEXT NOT NULL DEFAULT 'journalArticle',
               parent_item_id TEXT, version INTEGER NOT NULL DEFAULT 1,
               deleted INTEGER NOT NULL DEFAULT 0, trashed INTEGER NOT NULL DEFAULT 0,
               date_added TEXT NOT NULL, date_modified TEXT NOT NULL,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
               FOREIGN KEY(parent_item_id) REFERENCES library_items(id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS library_items_parent_idx
               ON library_items(parent_item_id, item_type, id);
             CREATE INDEX IF NOT EXISTS library_items_status_idx
               ON library_items(library_id, deleted, trashed, date_modified DESC);
             CREATE TABLE IF NOT EXISTS library_item_data(
               item_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL,
               PRIMARY KEY(item_id, field),
               FOREIGN KEY(item_id) REFERENCES library_items(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS library_item_data_field_idx
               ON library_item_data(field, value);
             CREATE TABLE IF NOT EXISTS library_creators(
               id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, name TEXT,
               field_mode TEXT NOT NULL DEFAULT 'twoField',
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS library_item_creators(
               item_id TEXT NOT NULL, creator_id TEXT NOT NULL,
               creator_type TEXT NOT NULL DEFAULT 'author', order_index INTEGER NOT NULL,
               PRIMARY KEY(item_id, creator_id, creator_type),
               FOREIGN KEY(item_id) REFERENCES library_items(id) ON DELETE CASCADE,
               FOREIGN KEY(creator_id) REFERENCES library_creators(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS library_item_creators_order_idx
               ON library_item_creators(item_id, order_index, creator_type);
             CREATE TABLE IF NOT EXISTS library_item_relations(
               id TEXT PRIMARY KEY, source_item_id TEXT NOT NULL,
               predicate TEXT NOT NULL, target TEXT NOT NULL,
               target_kind TEXT NOT NULL DEFAULT 'item', created_at TEXT NOT NULL,
               UNIQUE(source_item_id, predicate, target, target_kind),
               FOREIGN KEY(source_item_id) REFERENCES library_items(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS library_item_relations_target_idx
               ON library_item_relations(target, predicate);
             CREATE TABLE IF NOT EXISTS library_saved_searches(
               id TEXT PRIMARY KEY, library_id TEXT NOT NULL DEFAULT 'local',
               name TEXT NOT NULL, query TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]',
               dynamic INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
               deleted INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS library_saved_search_conditions(
               id TEXT PRIMARY KEY, saved_search_id TEXT NOT NULL,
               condition_index INTEGER NOT NULL, field TEXT NOT NULL,
               operator TEXT NOT NULL, value TEXT NOT NULL, joiner TEXT NOT NULL DEFAULT 'AND',
               FOREIGN KEY(saved_search_id) REFERENCES library_saved_searches(id) ON DELETE CASCADE,
               UNIQUE(saved_search_id, condition_index)
             );
             CREATE INDEX IF NOT EXISTS library_saved_search_conditions_idx
               ON library_saved_search_conditions(saved_search_id, condition_index);
             CREATE TABLE IF NOT EXISTS library_fulltext_items(
               item_id TEXT PRIMARY KEY, indexed_pages INTEGER, total_pages INTEGER,
               indexed_chars INTEGER, total_chars INTEGER, version INTEGER NOT NULL DEFAULT 1,
               text_hash TEXT, status TEXT NOT NULL DEFAULT 'not_indexed',
               updated_at TEXT NOT NULL,
               FOREIGN KEY(item_id) REFERENCES library_items(id) ON DELETE CASCADE
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS library_attachment_full_text
               USING fts5(item_id UNINDEXED, content);
             CREATE TABLE IF NOT EXISTS screen_decisions(
               id TEXT PRIMARY KEY, record_id TEXT NOT NULL, protocol_id TEXT NOT NULL,
               created_at TEXT NOT NULL, payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS evidence_cards(
               id TEXT PRIMARY KEY, record_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS literature_audit_log(
               sequence INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
               entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS literature_full_text
               USING fts5(record_id UNINDEXED, title, body);
             CREATE VIRTUAL TABLE IF NOT EXISTS literature_full_text_vocab
               USING fts5vocab(literature_full_text, 'row');",
        )
        .map_err(to_error)?;
    ensure_column(
        connection,
        "search_runs",
        "revision",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    ensure_column(
        connection,
        "canonical_records",
        "revision",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    // Schema v5 adds the local Zotero-shaped data plane to databases created
    // by schema v4. `CREATE TABLE IF NOT EXISTS` cannot add columns to those
    // already-existing relationship tables, so keep this migration explicit
    // and idempotent.
    for (table, column, definition) in [
        ("library_collections", "library_id", "TEXT NOT NULL DEFAULT 'local'"),
        ("library_collections", "item_key", "TEXT"),
        ("library_collections", "order_index", "INTEGER NOT NULL DEFAULT 0"),
        ("library_collections", "version", "INTEGER NOT NULL DEFAULT 1"),
        ("library_collections", "deleted", "INTEGER NOT NULL DEFAULT 0"),
        ("library_tags", "tag_type", "INTEGER NOT NULL DEFAULT 0"),
        ("library_tags", "color", "TEXT"),
        ("library_attachments", "link_mode", "TEXT"),
        ("library_attachments", "filename", "TEXT"),
        ("library_attachments", "charset", "TEXT"),
        ("library_attachments", "hash", "TEXT"),
        ("library_attachments", "mtime", "INTEGER"),
        ("library_attachments", "last_page_index", "INTEGER"),
        ("library_attachments", "source_payload", "TEXT"),
        ("library_annotations", "page_label", "TEXT"),
        ("library_annotations", "annotation_type", "TEXT"),
        ("library_annotations", "position", "TEXT"),
        ("library_annotations", "sort_index", "INTEGER"),
        ("library_annotations", "author", "TEXT"),
        ("library_annotations", "is_external", "INTEGER NOT NULL DEFAULT 0"),
        ("library_annotations", "source_payload", "TEXT"),
        ("library_notes", "source_payload", "TEXT"),
    ] {
        ensure_column(connection, table, column, definition)?;
    }
    // A development build briefly materialized this relationship table before
    // the composite primary key was added. Collapse any rows that such a
    // database may already contain before the v5 backfill starts. Current
    // databases have the primary key and this is an idempotent no-op.
    repair_library_item_creator_relations(connection)?;
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;
    let mut rebuild_full_text = false;
    let mut repair_primary_pdf_attachment_ids = false;
    if let Some(stored) = stored {
        let version = stored
            .parse::<u32>()
            .map_err(|error| format!("invalid literature schema version: {error}"))?;
        if version > LITERATURE_SCHEMA_VERSION {
            return Err(format!(
                "literature store schema {version} is newer than this runtime ({LITERATURE_SCHEMA_VERSION})"
            ));
        }
        if version < LITERATURE_SCHEMA_VERSION {
            connection
                .execute(
                    "UPDATE metadata SET value = ?1 WHERE key = 'schema_version'",
                    [LITERATURE_SCHEMA_VERSION.to_string()],
                )
                .map_err(to_error)?;
            rebuild_full_text = true;
            repair_primary_pdf_attachment_ids = true;
        }
    } else {
        connection
            .execute(
                "INSERT INTO metadata(key, value) VALUES ('schema_version', ?1)",
                [LITERATURE_SCHEMA_VERSION.to_string()],
            )
            .map_err(to_error)?;
        rebuild_full_text = true;
    }
    // Order matters. `backfill_legacy_library_relations` materializes child
    // rows through `sync_library_children_in_transaction`, and every child
    // `library_items` row carries a `parent_item_id` foreign key onto its
    // record's own top-level `library_items` row. Only the item-model backfill
    // creates those top-level rows, so running the relation backfill first
    // fails with "FOREIGN KEY constraint failed" on any database that already
    // held records with attachments, notes, or annotations before the
    // normalized item model existed — and because that backfill records its
    // completion key only on success, it then fails again on every subsequent
    // open, leaving the whole literature store unreadable.
    backfill_library_item_model(connection)?;
    // Must follow the item-model backfill: that is the pass which copied the
    // run-mirrored saved searches out of the compatibility metadata in the
    // first place, so cleaning up before it would just let them back in.
    cleanup_run_mirrored_saved_searches(connection)?;
    backfill_legacy_library_relations(connection)?;
    if repair_primary_pdf_attachment_ids {
        repair_legacy_primary_pdf_attachment_ids(connection)?;
    }
    if rebuild_full_text {
        rebuild_full_text_index(connection)?;
    }
    Ok(())
}

fn repair_library_item_creator_relations(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(to_error)?;
    transaction
        .execute(
            "DELETE FROM library_item_creators
             WHERE rowid NOT IN (
               SELECT MIN(rowid)
               FROM library_item_creators
               GROUP BY item_id, creator_id, creator_type
             )",
            [],
        )
        .map_err(to_error)?;
    transaction.commit().map_err(to_error)
}

fn backfill_legacy_library_relations(connection: &mut Connection) -> Result<(), String> {
    let already_backfilled: Option<String> = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = ?1",
            [LIBRARY_RELATIONS_BACKFILL_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;
    if already_backfilled.is_some() {
        return Ok(());
    }

    let records = {
        let mut statement = connection
            .prepare("SELECT id, payload FROM canonical_records ORDER BY id")
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    let projection_meta = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = ?1",
            [LEGACY_LIBRARY_META_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(to_error)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(to_error)?;

    if let Some(payload) = projection_meta {
        let metadata: Value = decode_payload(&payload)?;
        if let Some(collections) = metadata.get("collections") {
            sync_library_collections_in_transaction(&transaction, collections)?;
        }
    }

    let mut relation_records = 0usize;
    for (record_id, payload) in records {
        let record: CanonicalRecord = decode_payload(&payload)?;
        let Some(legacy_paper) = legacy_library_payload(&record.metadata) else {
            continue;
        };
        if !legacy_paper.is_object() {
            continue;
        }
        sync_library_item_relations_in_transaction(&transaction, &record_id, legacy_paper)?;
        relation_records += 1;
    }

    transaction
        .execute(
            "INSERT INTO metadata(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![LIBRARY_RELATIONS_BACKFILL_KEY, relation_records.to_string()],
        )
        .map_err(to_error)?;
    append_audit(
        &transaction,
        "library_relations",
        LIBRARY_RELATIONS_BACKFILL_KEY,
        "legacy_backfill_completed",
        &json!({ "records": relation_records }),
    )?;
    transaction.commit().map_err(to_error)
}

fn replace_legacy_library_payload(record: &mut CanonicalRecord, paper: Value) {
    let mut metadata = record.metadata.as_object().cloned().unwrap_or_default();
    if metadata
        .get("legacyLibrary")
        .is_some_and(Value::is_object)
    {
        metadata.insert("legacyLibrary".to_string(), paper);
        record.metadata = Value::Object(metadata);
    } else {
        // When the compatibility projection predates the nested
        // `legacyLibrary` wrapper, `paper` is already a clone of the complete
        // metadata object. Keeping it intact avoids dropping unrelated local
        // metadata while fixing the attachment references in place.
        record.metadata = paper;
    }
}

fn repair_legacy_primary_pdf_attachment_ids(connection: &mut Connection) -> Result<(), String> {
    let records = {
        let mut statement = connection
            .prepare("SELECT id, revision, payload FROM canonical_records ORDER BY id")
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(to_error)?;
    let mut repaired = 0usize;
    for (record_id, stored_revision, payload) in records {
        let mut record: CanonicalRecord = decode_payload(&payload)?;
        let Some(legacy_paper) = legacy_library_payload(&record.metadata).cloned() else {
            continue;
        };
        let normalized_paper = normalize_legacy_primary_pdf_references(&legacy_paper, &record_id);
        let has_pdf_path = normalized_paper
            .get("pdf")
            .and_then(Value::as_object)
            .and_then(|pdf| pdf.get("path"))
            .and_then(Value::as_str)
            .is_some_and(|path| !path.trim().is_empty());
        if !has_pdf_path && normalized_paper == legacy_paper {
            continue;
        }
        // Re-running the relationship materializer for a paper with a legacy
        // PDF pointer repairs the old global-ID collision and also recreates a
        // missing synthetic attachment for records that lost it to that
        // collision. The operation is transactional and idempotent.
        sync_library_item_relations_in_transaction(&transaction, &record_id, &normalized_paper)?;
        if normalized_paper != legacy_paper {
            replace_legacy_library_payload(&mut record, normalized_paper);
            record.revision = stored_revision.saturating_add(1);
            record.updated_at = now_iso8601();
            transaction
                .execute(
                    "UPDATE canonical_records SET revision = ?2, payload = ?3, updated_at = ?4
                     WHERE id = ?1 AND revision = ?5",
                    params![
                        record_id,
                        record.revision,
                        encode_payload(&record)?,
                        record.updated_at,
                        stored_revision,
                    ],
                )
                .map_err(to_error)?;
            upsert_full_text_index(&transaction, &record)?;
        }
        repaired += 1;
    }
    if repaired > 0 {
        append_audit(
            &transaction,
            "library_attachment",
            LEGACY_PRIMARY_PDF_ATTACHMENT_ID,
            "legacy_primary_id_repaired",
            &json!({ "records": repaired }),
        )?;
    }
    transaction.commit().map_err(to_error)
}

/// Remove saved-search rows that mirror a `SearchRun`.
///
/// Older projections wrote `search-run:<id>` rows into
/// `library_saved_searches` without the `searchRunId` field. The projection
/// then could not tell that those rows already represented a run, so it
/// appended a second entry per run — every saved search appeared twice, and
/// deleting one copy was silently undone by the other on the next load.
///
/// Rows the user had already deleted carry the only surviving record of that
/// intent, so their run ids are promoted to `hiddenSearchRunIds` — the
/// tombstone list the projection actually honours — before the rows go.
fn cleanup_run_mirrored_saved_searches(connection: &mut Connection) -> Result<(), String> {
    let already_cleaned: Option<String> = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = ?1",
            [SAVED_SEARCH_RUN_MIRROR_CLEANUP_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;
    if already_cleaned.is_some() {
        return Ok(());
    }
    let mirrored = {
        let mut statement = connection
            .prepare("SELECT id, deleted FROM library_saved_searches")
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, sql_to_bool(row.get::<_, i64>(1)?)))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(to_error)?
            .into_iter()
            .filter(|(id, _)| search_run_id_for_saved_search(id).is_some())
            .collect::<Vec<_>>()
    };
    let projection_meta = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = ?1",
            [LEGACY_LIBRARY_META_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(to_error)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(to_error)?;
    let mut hidden_run_ids = BTreeSet::new();
    for (id, deleted) in &mirrored {
        if *deleted {
            if let Some(run_id) = search_run_id_for_saved_search(id) {
                hidden_run_ids.insert(run_id.to_string());
            }
        }
        transaction
            .execute("DELETE FROM library_saved_searches WHERE id = ?1", [id])
            .map_err(to_error)?;
    }
    if !mirrored.is_empty() {
        let mut metadata = projection_meta
            .map(|payload| decode_payload::<Value>(&payload))
            .transpose()?
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let mut hidden = metadata["hiddenSearchRunIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<BTreeSet<_>>();
        hidden.extend(hidden_run_ids.iter().cloned());
        let object = metadata
            .as_object_mut()
            .ok_or_else(|| "literature projection metadata must be a JSON object".to_string())?;
        object.insert(
            "hiddenSearchRunIds".to_string(),
            json!(hidden.into_iter().collect::<Vec<_>>()),
        );
        // The same rows are usually mirrored in the compatibility metadata;
        // leaving them there would restore what was just removed as soon as
        // the normalized table is empty.
        if let Some(searches) = object.get_mut("searches").and_then(Value::as_array_mut) {
            searches.retain(|entry| {
                entry["id"]
                    .as_str()
                    .is_none_or(|id| search_run_id_for_saved_search(id).is_none())
            });
        }
        transaction
            .execute(
                "INSERT INTO metadata(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![LEGACY_LIBRARY_META_KEY, encode_payload(&metadata)?],
            )
            .map_err(to_error)?;
    }
    transaction
        .execute(
            "INSERT INTO metadata(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![
                SAVED_SEARCH_RUN_MIRROR_CLEANUP_KEY,
                mirrored.len().to_string()
            ],
        )
        .map_err(to_error)?;
    if !mirrored.is_empty() {
        append_audit(
            &transaction,
            "library_saved_searches",
            SAVED_SEARCH_RUN_MIRROR_CLEANUP_KEY,
            "run_mirrored_rows_removed",
            &json!({
                "removed": mirrored.len(),
                "hiddenSearchRunIds": hidden_run_ids,
            }),
        )?;
    }
    transaction.commit().map_err(to_error)
}

fn backfill_library_item_model(connection: &mut Connection) -> Result<(), String> {
    let already_backfilled: Option<String> = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = ?1",
            [LIBRARY_ITEM_MODEL_BACKFILL_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;
    if already_backfilled.is_some() {
        return Ok(());
    }

    let records = {
        let mut statement = connection
            .prepare("SELECT payload FROM canonical_records ORDER BY id")
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    let projection_meta = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = ?1",
            [LEGACY_LIBRARY_META_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(to_error)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(to_error)?;
    let mut item_count = 0usize;
    for payload in records {
        let record: CanonicalRecord = decode_payload(&payload)?;
        sync_library_item_model_in_transaction(&transaction, &record, None, false)?;
        item_count += 1;
    }
    if let Some(payload) = projection_meta {
        let metadata: Value = decode_payload(&payload)?;
        if let Some(searches) = metadata.get("searches") {
            sync_library_saved_searches_in_transaction(&transaction, searches)?;
        }
    }
    transaction
        .execute(
            "INSERT INTO metadata(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![LIBRARY_ITEM_MODEL_BACKFILL_KEY, item_count.to_string()],
        )
        .map_err(to_error)?;
    append_audit(
        &transaction,
        "library_item_model",
        LIBRARY_ITEM_MODEL_BACKFILL_KEY,
        "backfill_completed",
        &json!({ "items": item_count }),
    )?;
    transaction.commit().map_err(to_error)
}

fn default_creator_field_mode() -> String {
    "twoField".to_string()
}

fn bool_to_sql(value: bool) -> i64 {
    i64::from(value)
}

fn sql_to_bool(value: i64) -> bool {
    value != 0
}

fn stable_library_item_key(item_id: &str) -> String {
    let digest = sha256_hex(item_id.as_bytes());
    digest[..8].to_ascii_uppercase()
}

fn normalize_library_item_type(value: Option<&str>) -> String {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    match value {
        Some("article") => "journalArticle".to_string(),
        Some("bookSection") => "bookSection".to_string(),
        Some("conference") => "conferencePaper".to_string(),
        Some(value) => value.to_string(),
        None => DEFAULT_LIBRARY_ITEM_TYPE.to_string(),
    }
}

fn value_string_from_object(object: Option<&Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        object
            .and_then(|value| value.get(*key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn canonical_standard_observation(record: &CanonicalRecord) -> Option<&Value> {
    record
        .observations
        .iter()
        .rev()
        .find_map(|observation| {
            observation
                .fields
                .is_object()
                .then_some(&observation.fields)
        })
}

fn canonical_legacy_library(record: &CanonicalRecord) -> Option<&Value> {
    legacy_library_payload(&record.metadata).filter(|value| value.is_object())
}

fn library_item_type_for_record(record: &CanonicalRecord, legacy: Option<&Value>) -> String {
    let raw = value_string_from_object(legacy, &["itemType", "type"]).or_else(|| {
        value_string_from_object(
            canonical_standard_observation(record),
            &["itemType", "type"],
        )
    });
    normalize_library_item_type(raw.as_deref())
}

fn library_item_key_for_record(
    transaction: &Transaction<'_>,
    record: &CanonicalRecord,
    legacy: Option<&Value>,
) -> Result<String, String> {
    let candidate = value_string_from_object(legacy, &["zoteroKey", "key", "itemKey"])
        .or_else(|| {
            value_string_from_object(
                canonical_standard_observation(record),
                &["key", "itemKey", "zoteroKey"],
            )
        })
        .unwrap_or_else(|| stable_library_item_key(&record.id));
    let candidate = candidate.trim().to_string();
    let collision = transaction
        .query_row(
            "SELECT id FROM library_items WHERE item_key = ?1 AND id != ?2",
            params![candidate, record.id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(to_error)?;
    if collision.is_none() {
        return Ok(candidate);
    }
    Ok(format!("{}-{}", candidate, stable_library_item_key(&record.id)))
}

fn library_field_values_for_record(
    record: &CanonicalRecord,
    legacy: Option<&Value>,
) -> BTreeMap<String, String> {
    let standard = canonical_standard_observation(record);
    let mut fields = BTreeMap::new();
    let mut add = |field: &str, value: Option<String>| {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            fields.insert(field.to_string(), value);
        }
    };
    add("title", Some(record.title.clone()));
    add(
        "abstractNote",
        Some(record.abstract_text.clone()).filter(|value| !value.trim().is_empty()),
    );
    add(
        "date",
        value_string_from_object(legacy, &["date"])
            .or_else(|| value_string_from_object(standard, &["date"])),
    );
    add(
        "publicationTitle",
        Some(record.venue.clone()).filter(|value| !value.trim().is_empty()),
    );
    add(
        "DOI",
        record.identifiers.doi.clone().or_else(|| {
            value_string_from_object(legacy, &["DOI", "doi"])
                .or_else(|| value_string_from_object(standard, &["DOI", "doi"]))
        }),
    );
    add("url", record.url.clone());
    add(
        "ISBN",
        value_string_from_object(legacy, &["ISBN", "isbn"])
            .or_else(|| value_string_from_object(standard, &["ISBN", "isbn"])),
    );
    for (field, keys) in [
        ("volume", &["volume"][..]),
        ("issue", &["issue", "number"][..]),
        ("pages", &["pages", "page"][..]),
        ("publisher", &["publisher"][..]),
        ("place", &["place", "publisher-place", "location"][..]),
        ("edition", &["edition"][..]),
        ("series", &["series", "collection-title"][..]),
        ("language", &["language"][..]),
        ("accessDate", &["accessDate", "accessed", "urldate"][..]),
        ("citationKey", &["citationKey", "citation-key"][..]),
        ("rating", &["rating"][..]),
    ] {
        add(
            field,
            value_string_from_object(legacy, keys)
                .or_else(|| value_string_from_object(standard, keys)),
        );
    }
    // Preserve additional scalar fields from both the standard observation and
    // the compatibility projection. The latter carries `metadataFields` for
    // edits made before the normalized model has finished hydrating, so it must
    // be included as a write source too.
    for source in [standard, legacy] {
        let Some(object) = source.and_then(Value::as_object) else {
            continue;
        };
        for (key, value) in object {
            if fields.contains_key(key)
                || matches!(
                    key.as_str(),
                    "creators"
                        | "tags"
                        | "collections"
                        | "itemType"
                        | "key"
                        | "itemKey"
                        | "parentItem"
                        | "parentItemKey"
                )
            {
                continue;
            }
            if let Some(value) = scalar_string_from_value(value) {
                fields.insert(key.clone(), value);
            }
        }
    }
    if let Some(object) = legacy
        .and_then(|value| value.get("metadataFields"))
        .and_then(Value::as_object)
    {
        for (key, value) in object {
            if fields.contains_key(key) || key.trim().is_empty() {
                continue;
            }
            if let Some(value) = scalar_string_from_value(value) {
                fields.insert(key.clone(), value);
            }
        }
    }
    fields
}

fn scalar_string_from_value(value: &Value) -> Option<String> {
    let value = match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        _ => return None,
    };
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn snapshot_value(snapshot: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        snapshot
            .get(*key)
            .and_then(scalar_string_from_value)
    })
}

fn compatibility_snapshot_key(key: &str) -> bool {
    matches!(
        key,
        "id"
            | "recordId"
            | "key"
            | "itemKey"
            | "zoteroKey"
            | "authors"
            | "creators"
            | "year"
            | "venue"
            | "doi"
            | "isbn"
            | "abstract"
            | "url"
            | "itemType"
            | "tags"
            | "collectionIds"
            | "relations"
            | "attachments"
            | "pdf"
            | "notes"
            | "pdfAnnotations"
            | "evidence"
            | "answerChains"
            | "workflowGrades"
            | "searchIds"
            | "stage"
            | "starred"
            | "unread"
            | "source"
            | "addedAt"
            | "dateAdded"
            | "dateModified"
            | "readAt"
            | "verdict"
            | "screenings"
            | "brief"
            | "agentSummary"
            | "metadataFields"
            | "citedBy"
    )
}

/// Convert a complete Desktop compatibility paper into the normalized field
/// map. This intentionally does not consult the previous canonical record:
/// omitted optional values in a full snapshot are clears, not merge hints.
fn library_field_values_for_snapshot(snapshot: &Value) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let mut add = |field: &str, keys: &[&str]| {
        if let Some(value) = snapshot_value(snapshot, keys) {
            fields.insert(field.to_string(), value);
        }
    };
    add("title", &["title"]);
    add("abstractNote", &["abstractNote", "abstract"]);
    add("date", &["date", "year"]);
    add(
        "publicationTitle",
        &["publicationTitle", "venue", "container-title", "bookTitle"],
    );
    add("DOI", &["DOI", "doi"]);
    add("ISBN", &["ISBN", "isbn"]);
    add("url", &["url", "URL"]);
    for (field, keys) in [
        ("volume", &["volume"][..]),
        ("issue", &["issue", "number"][..]),
        ("pages", &["pages", "page"][..]),
        ("publisher", &["publisher"][..]),
        ("place", &["place", "publisher-place", "location"][..]),
        ("edition", &["edition"][..]),
        ("series", &["series", "collection-title"][..]),
        ("language", &["language"][..]),
        ("accessDate", &["accessDate", "accessed", "urldate"][..]),
        ("citationKey", &["citationKey", "citation-key"][..]),
        ("rating", &["rating"][..]),
    ] {
        add(field, keys);
    }

    // `metadataFields` is the compatibility carrier for fields that are not
    // promoted to the compact LiteraturePaper shape. Accepting scalar values
    // beyond strings keeps numeric/bool provider fields from being discarded.
    if let Some(object) = snapshot.get("metadataFields").and_then(Value::as_object) {
        for (key, value) in object {
            let key = key.trim();
            if key.is_empty() || compatibility_snapshot_key(key) {
                continue;
            }
            if let Some(value) = scalar_string_from_value(value) {
                fields.insert(key.to_string(), value);
            }
        }
    }

    // Preserve scalar provider fields that were carried directly on a Zotero
    // shaped item. Known compatibility keys are excluded so `venue` and
    // `abstract` do not become duplicate custom fields beside their canonical
    // Zotero names.
    if let Some(object) = snapshot.as_object() {
        for (key, value) in object {
            let key = key.trim();
            if key.is_empty() || compatibility_snapshot_key(key) {
                continue;
            }
            if let Some(value) = scalar_string_from_value(value) {
                fields.entry(key.to_string()).or_insert(value);
            }
        }
    }
    fields
}

fn creator_from_value(value: &Value, creator_type: &str, order_index: u32) -> Option<LibraryCreator> {
    if let Some(literal) = value.as_str().map(str::trim).filter(|value| !value.is_empty()) {
        let id = format!(
            "creator:{}",
            sha256_hex(format!("{creator_type}\u{1f}oneField\u{1f}{literal}").as_bytes())
        );
        return Some(LibraryCreator {
            id,
            creator_type: creator_type.to_string(),
            first_name: None,
            last_name: None,
            name: Some(literal.to_string()),
            field_mode: "oneField".to_string(),
            order_index,
        });
    }
    let literal = value_string_from_object(Some(value), &["name", "literal"]);
    let first_name = value_string_from_object(Some(value), &["firstName", "given"]);
    let last_name = value_string_from_object(Some(value), &["lastName", "family"]);
    if literal.is_none() && first_name.is_none() && last_name.is_none() {
        return None;
    }
    let field_mode = if literal.is_some() && first_name.is_none() && last_name.is_none() {
        "oneField"
    } else {
        "twoField"
    };
    let fingerprint = format!(
        "{creator_type}\u{1f}{field_mode}\u{1f}{}\u{1f}{}\u{1f}{}",
        first_name.as_deref().unwrap_or_default(),
        last_name.as_deref().unwrap_or_default(),
        literal.as_deref().unwrap_or_default(),
    );
    Some(LibraryCreator {
        id: format!("creator:{}", sha256_hex(fingerprint.as_bytes())),
        creator_type: creator_type.to_string(),
        first_name,
        last_name,
        name: literal,
        field_mode: field_mode.to_string(),
        order_index,
    })
}

fn creators_for_record(
    record: &CanonicalRecord,
    legacy: Option<&Value>,
) -> (Vec<LibraryCreator>, bool) {
    let standard = canonical_standard_observation(record);
    for source in [standard, legacy] {
        if let Some(values) = source.and_then(|value| value.get("creators")).and_then(Value::as_array)
        {
            let creators = values
                .iter()
                .enumerate()
                .filter_map(|(index, value)| {
                    let creator_type = value_string_from_object(Some(value), &["creatorType"])
                        .unwrap_or_else(|| "author".to_string());
                    creator_from_value(
                        value,
                        &creator_type,
                        u32::try_from(index).unwrap_or(u32::MAX),
                    )
                })
                .collect::<Vec<_>>();
            if !creators.is_empty() {
                return (creators, true);
            }
        }
    }
    let creators = record
        .authors
        .iter()
        .enumerate()
        .filter_map(|(index, author)| {
            creator_from_value(
                &Value::String(author.clone()),
                "author",
                u32::try_from(index).unwrap_or(u32::MAX),
            )
        })
        .collect::<Vec<_>>();
    (creators, false)
}

fn creators_for_snapshot(snapshot: &Value) -> (Vec<LibraryCreator>, bool) {
    if let Some(values) = snapshot.get("creators").and_then(Value::as_array) {
        let creators = values
            .iter()
            .enumerate()
            .filter_map(|(index, value)| {
                let creator_type = value_string_from_object(Some(value), &["creatorType"])
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "author".to_string());
                creator_from_value(
                    value,
                    &creator_type,
                    u32::try_from(index).unwrap_or(u32::MAX),
                )
            })
            .collect::<Vec<_>>();
        return (creators, true);
    }
    let values = snapshot
        .get("authors")
        .and_then(Value::as_array)
        .or_else(|| snapshot.get("author").and_then(Value::as_array));
    let creators = values
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, value)| {
            creator_from_value(
                value,
                "author",
                u32::try_from(index).unwrap_or(u32::MAX),
            )
        })
        .collect::<Vec<_>>();
    (creators, values.is_some())
}

fn sync_library_item_model_in_transaction(
    transaction: &Transaction<'_>,
    record: &CanonicalRecord,
    legacy_override: Option<&Value>,
    complete_snapshot: bool,
) -> Result<(), String> {
    let legacy = legacy_override.or_else(|| canonical_legacy_library(record));
    let item_type = library_item_type_for_record(record, legacy);
    let item_key = library_item_key_for_record(transaction, record, legacy)?;
    let existing = transaction
        .query_row(
            "SELECT version, deleted, trashed, date_added FROM library_items WHERE id = ?1",
            [&record.id],
            |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(to_error)?;
    let now = now_iso8601();
    let date_added = existing
        .as_ref()
        .map(|(_, _, _, date_added)| date_added.clone())
        .or_else(|| {
            value_string_from_object(legacy, &["addedAt", "dateAdded"])
                .or_else(|| Some(record.created_at.clone()))
        })
        .unwrap_or_else(|| now.clone());
    let trashed = existing
        .as_ref()
        .map(|(_, _, trashed, _)| sql_to_bool(*trashed))
        .unwrap_or_else(|| {
            record.metadata["legacyLibraryHidden"]
                .as_bool()
                .unwrap_or(false)
        });
    let deleted = existing
        .as_ref()
        .map(|(_, deleted, _, _)| sql_to_bool(*deleted))
        .unwrap_or(false);
    let version = existing
        .as_ref()
        .map(|(version, _, _, _)| version.saturating_add(1))
        .unwrap_or(1);
    transaction
        .execute(
            "INSERT INTO library_items(
               id, item_key, library_id, item_type, parent_item_id, version,
               deleted, trashed, date_added, date_modified, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               item_key = excluded.item_key,
               item_type = excluded.item_type,
               version = excluded.version,
               deleted = excluded.deleted,
               trashed = excluded.trashed,
               date_modified = excluded.date_modified,
               updated_at = excluded.updated_at",
            params![
                record.id,
                item_key,
                LOCAL_LIBRARY_ID,
                item_type,
                version,
                bool_to_sql(deleted),
                bool_to_sql(trashed),
                date_added,
                now,
            ],
        )
        .map_err(to_error)?;

    let fields = if complete_snapshot {
        legacy_override
            .map(library_field_values_for_snapshot)
            .unwrap_or_else(|| library_field_values_for_record(record, legacy))
    } else {
        library_field_values_for_record(record, legacy)
    };
    if complete_snapshot {
        // A compatibility projection is a complete local item snapshot. On
        // this path replace the field set so a removed custom/standard field
        // cannot survive in SQLite merely because an older observation had it.
        replace_library_item_fields_map_in_transaction(transaction, &record.id, &fields)?;
    } else {
        upsert_library_item_fields_in_transaction(transaction, &record.id, &fields)?;
    }
    let (creators, rich_creators) = if complete_snapshot {
        legacy_override
            .map(creators_for_snapshot)
            .unwrap_or_else(|| creators_for_record(record, legacy))
    } else {
        creators_for_record(record, legacy)
    };
    let existing_creator_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM library_item_creators WHERE item_id = ?1",
            [&record.id],
            |row| row.get(0),
        )
        .map_err(to_error)?;
    if complete_snapshot || rich_creators || existing_creator_count == 0 {
        replace_library_item_creators_with_values_in_transaction(
            transaction,
            &record.id,
            &creators,
        )?;
    }
    sync_library_children_in_transaction(transaction, &record.id)?;
    Ok(())
}

fn upsert_library_item_fields_in_transaction(
    transaction: &Transaction<'_>,
    item_id: &str,
    fields: &BTreeMap<String, String>,
) -> Result<(), String> {
    for (field, value) in fields {
        transaction
            .execute(
                "INSERT INTO library_item_data(item_id, field, value)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(item_id, field) DO UPDATE SET value = excluded.value",
                params![item_id, field, value],
            )
            .map_err(to_error)?;
    }
    Ok(())
}

fn replace_library_item_fields_in_transaction(
    transaction: &Transaction<'_>,
    item_id: &str,
    fields: &Value,
) -> Result<(), String> {
    let object = fields
        .as_object()
        .ok_or_else(|| "library item fields must be a JSON object".to_string())?;
    transaction
        .execute("DELETE FROM library_item_data WHERE item_id = ?1", [item_id])
        .map_err(to_error)?;
    let normalized = object
        .iter()
        .filter_map(|(field, value)| {
            let value = match value {
                Value::String(value) => value.clone(),
                Value::Null => return None,
                value => value.to_string(),
            };
            (!field.trim().is_empty()).then_some((field.trim().to_string(), value))
        })
        .collect::<BTreeMap<_, _>>();
    upsert_library_item_fields_in_transaction(transaction, item_id, &normalized)
}

fn replace_library_item_creators_in_transaction(
    transaction: &Transaction<'_>,
    item_id: &str,
    creators: &Value,
) -> Result<(), String> {
    let values = creators
        .as_array()
        .ok_or_else(|| "library item creators must be a JSON array".to_string())?;
    let parsed = values
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            let creator_type = value_string_from_object(Some(value), &["creatorType"])
                .unwrap_or_else(|| "author".to_string());
            creator_from_value(
                value,
                &creator_type,
                u32::try_from(index).unwrap_or(u32::MAX),
            )
        })
        .collect::<Vec<_>>();
    replace_library_item_creators_with_values_in_transaction(transaction, item_id, &parsed)
}

fn replace_library_item_creators_with_values_in_transaction(
    transaction: &Transaction<'_>,
    item_id: &str,
    creators: &[LibraryCreator],
) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM library_item_creators WHERE item_id = ?1",
            [item_id],
        )
        .map_err(to_error)?;
    let creators = deduplicate_library_creators(creators);
    for creator in creators {
        let now = now_iso8601();
        transaction
            .execute(
                "INSERT INTO library_creators(
                   id, first_name, last_name, name, field_mode, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                   first_name = excluded.first_name,
                   last_name = excluded.last_name,
                   name = excluded.name,
                   field_mode = excluded.field_mode,
                   updated_at = excluded.updated_at",
                params![
                    creator.id,
                    creator.first_name,
                    creator.last_name,
                    creator.name,
                    creator.field_mode,
                    now,
                ],
            )
            .map_err(to_error)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO library_item_creators(
                   item_id, creator_id, creator_type, order_index
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    item_id,
                    creator.id,
                    creator.creator_type,
                    i64::from(creator.order_index),
                ],
            )
            .map_err(to_error)?;
    }
    Ok(())
}

fn deduplicate_library_creators(creators: &[LibraryCreator]) -> Vec<LibraryCreator> {
    let mut seen = BTreeSet::new();
    creators
        .iter()
        .filter_map(|creator| {
            if !seen.insert((creator.id.clone(), creator.creator_type.clone())) {
                return None;
            }
            let mut creator = creator.clone();
            creator.order_index =
                u32::try_from(seen.len().saturating_sub(1)).unwrap_or(u32::MAX);
            Some(creator)
        })
        .collect()
}

fn replace_library_item_relations_in_transaction(
    transaction: &Transaction<'_>,
    source_item_id: &str,
    relations: &Value,
) -> Result<(), String> {
    let values = relations
        .as_array()
        .ok_or_else(|| "library item relations must be a JSON array".to_string())?;
    transaction
        .execute(
            "DELETE FROM library_item_relations WHERE source_item_id = ?1",
            [source_item_id],
        )
        .map_err(to_error)?;
    for value in values {
        let (predicate, target, target_kind) = if let Some(target) = value.as_str() {
            ("related".to_string(), target.trim().to_string(), "item".to_string())
        } else {
            (
                value_string_from_object(Some(value), &["predicate", "relation"])
                    .unwrap_or_else(|| "related".to_string()),
                value_string_from_object(Some(value), &["targetItemId", "target", "uri"])
                    .unwrap_or_default(),
                value_string_from_object(Some(value), &["targetKind", "type"])
                    .unwrap_or_else(|| "item".to_string()),
            )
        };
        if target.is_empty() || predicate.trim().is_empty() || target == source_item_id {
            continue;
        }
        let id = format!(
            "relation:{}",
            sha256_hex(format!("{source_item_id}\u{1f}{predicate}\u{1f}{target}\u{1f}{target_kind}").as_bytes())
        );
        transaction
            .execute(
                "INSERT OR IGNORE INTO library_item_relations(
                   id, source_item_id, predicate, target, target_kind, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, source_item_id, predicate.trim(), target, target_kind.trim(), now_iso8601()],
            )
            .map_err(to_error)?;
    }
    Ok(())
}

fn load_library_item_fields(
    connection: &Connection,
    item_id: &str,
) -> Result<BTreeMap<String, String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT field, value FROM library_item_data
             WHERE item_id = ?1 ORDER BY field",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map([item_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(to_error)?;
    rows.collect::<Result<BTreeMap<String, String>, _>>()
        .map_err(to_error)
}

fn display_creator(creator: &LibraryCreator) -> String {
    if creator.field_mode == "oneField" {
        return creator.name.clone().unwrap_or_default();
    }
    match (
        creator.first_name.as_deref().filter(|value| !value.is_empty()),
        creator.last_name.as_deref().filter(|value| !value.is_empty()),
    ) {
        (Some(first), Some(last)) => format!("{first} {last}"),
        (Some(first), None) => first.to_string(),
        (None, Some(last)) => last.to_string(),
        (None, None) => creator.name.clone().unwrap_or_default(),
    }
}

fn load_library_item_creators(
    connection: &Connection,
    item_id: &str,
) -> Result<Vec<LibraryCreator>, String> {
    let mut statement = connection
        .prepare(
            "SELECT creators.id, item_creators.creator_type,
                    creators.first_name, creators.last_name, creators.name,
                    creators.field_mode, item_creators.order_index
             FROM library_item_creators AS item_creators
             JOIN library_creators AS creators ON creators.id = item_creators.creator_id
             WHERE item_creators.item_id = ?1
             ORDER BY item_creators.order_index, item_creators.creator_type, creators.id",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map([item_id], |row| {
            Ok(LibraryCreator {
                id: row.get(0)?,
                creator_type: row.get(1)?,
                first_name: row.get(2)?,
                last_name: row.get(3)?,
                name: row.get(4)?,
                field_mode: row.get(5)?,
                order_index: row.get::<_, i64>(6)?.try_into().unwrap_or_default(),
            })
        })
        .map_err(to_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(to_error)
}

fn sync_canonical_record_from_library_item_in_transaction(
    transaction: &Transaction<'_>,
    record_id: &str,
) -> Result<(), String> {
    let payload = transaction
        .query_row(
            "SELECT payload FROM canonical_records WHERE id = ?1",
            [record_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(to_error)?
        .ok_or_else(|| format!("unknown canonical record: {record_id}"))?;
    let mut record: CanonicalRecord = decode_payload(&payload)?;
    let fields = load_library_item_fields(transaction, record_id)?;
    let creators = load_library_item_creators(transaction, record_id)?;
    if let Some(title) = fields.get("title").filter(|value| !value.trim().is_empty()) {
        record.title = title.clone();
        record.normalized_title = normalized_record_title(title);
    }
    // The normalized field table is authoritative for local edits. A missing
    // optional field therefore means "cleared", rather than "keep the last
    // provider value"; otherwise deleting a DOI/abstract/date would appear to
    // work until the next reload restored the old canonical value.
    record.abstract_text = fields
        .get("abstractNote")
        .cloned()
        .unwrap_or_default();
    record.venue = fields
        .get("publicationTitle")
        .cloned()
        .unwrap_or_default();
    record.url = fields
        .get("url")
        .filter(|value| !value.trim().is_empty())
        .cloned();
    record.identifiers.doi = fields
        .get("DOI")
        .filter(|value| !value.trim().is_empty())
        .cloned();
    record.year = fields.get("date").and_then(|date| {
        date.get(0..4)
            .and_then(|year| year.parse::<u32>().ok())
    });
    let author_names = creators
        .iter()
        .filter(|creator| creator.creator_type == "author")
        .map(display_creator)
        .filter(|name| !name.trim().is_empty())
        .collect::<Vec<_>>();
    // An empty creator list is meaningful: it is how a user removes all
    // authors. Keeping the old value here would resurrect deleted authors in
    // the compatibility projection after the next metadata edit/reload.
    record.authors = author_names;
    let creator_values = creators
        .iter()
        .map(|creator| {
            let mut value = json!({
                "creatorType": creator.creator_type,
                "fieldMode": creator.field_mode,
            });
            if let Some(first_name) = creator.first_name.as_deref() {
                value["firstName"] = Value::String(first_name.to_string());
            }
            if let Some(last_name) = creator.last_name.as_deref() {
                value["lastName"] = Value::String(last_name.to_string());
            }
            if let Some(name) = creator.name.as_deref() {
                value["name"] = Value::String(name.to_string());
            }
            value
        })
        .collect::<Vec<_>>();
    let item_type = transaction
        .query_row(
            "SELECT item_type FROM library_items WHERE id = ?1",
            [record_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(to_error)?
        .unwrap_or_else(|| DEFAULT_LIBRARY_ITEM_TYPE.to_string());
    let mut metadata = record.metadata.as_object().cloned().unwrap_or_default();
    let mut legacy = metadata
        .get("legacyLibrary")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut standard = metadata
        .get("standard")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // The normalized field map is authoritative after a local edit. Clear
    // every known compatibility alias before writing the current values so a
    // removed DOI/volume/custom field cannot be resurrected by a later
    // projection or backfill.
    for key in [
        "title", "abstract", "abstractNote", "date", "year",
        "publicationTitle", "venue", "container-title", "bookTitle",
        "DOI", "doi", "ISBN", "isbn", "url", "URL", "volume", "issue",
        "number", "pages", "page", "publisher", "place", "publisher-place",
        "location", "edition", "series", "collection-title", "language",
        "accessDate", "accessed", "urldate", "citationKey", "citation-key",
        "rating",
    ] {
        legacy.remove(key);
        standard.remove(key);
    }
    legacy.remove("metadataFields");
    standard.remove("metadataFields");
    let legacy_control_keys = [
        "id", "recordId", "key", "itemKey", "zoteroKey", "authors", "creators",
        "itemType", "type", "tags", "collectionIds", "collections", "relations",
        "attachments", "notes", "pdfAnnotations", "pdf", "evidence", "answerChains",
        "workflowGrades", "searchIds", "stage", "starred", "unread", "source",
        "addedAt", "dateAdded", "dateModified", "readAt", "verdict", "screenings",
        "brief", "agentSummary", "citedBy",
    ];
    for key in legacy.keys().cloned().collect::<Vec<_>>() {
        if !fields.contains_key(&key)
            && !legacy_control_keys.contains(&key.as_str())
            && legacy
                .get(&key)
                .is_some_and(|value| scalar_string_from_value(value).is_some())
        {
            legacy.remove(&key);
        }
    }
    for key in standard.keys().cloned().collect::<Vec<_>>() {
        if !fields.contains_key(&key)
            && !matches!(key.as_str(), "creators" | "itemType" | "key" | "itemKey" | "zoteroKey")
            && standard
                .get(&key)
                .is_some_and(|value| scalar_string_from_value(value).is_some())
        {
            standard.remove(&key);
        }
    }
    for (field, value) in &fields {
        let legacy_key = match field.as_str() {
            "abstractNote" => "abstract",
            "publicationTitle" => "venue",
            "DOI" => "doi",
            "accessDate" => "accessed",
            other => other,
        };
        legacy.insert(legacy_key.to_string(), Value::String(value.clone()));
        standard.insert(field.clone(), Value::String(value.clone()));
    }
    legacy.insert("authors".to_string(), json!(record.authors));
    legacy.insert("creators".to_string(), Value::Array(creator_values.clone()));
    legacy.insert("itemType".to_string(), Value::String(item_type.clone()));
    if let Some(year) = record.year {
        legacy.insert("year".to_string(), json!(year));
    }
    standard.insert("creators".to_string(), Value::Array(creator_values.clone()));
    standard.insert("itemType".to_string(), Value::String(item_type.clone()));
    metadata.insert("legacyLibrary".to_string(), Value::Object(legacy));
    metadata.insert("standard".to_string(), Value::Object(standard));
    record.metadata = Value::Object(metadata);
    // Keep a compact local overlay as the newest standard observation. The
    // normalized tables remain authoritative, while this overlay prevents a
    // later import/backfill from restoring removed fields or creators.
    let now = now_iso8601();
    let mut local_observation_fields = record
        .observations
        .iter()
        .rev()
        .find_map(|observation| observation.fields.as_object().cloned())
        .unwrap_or_default();
    for key in local_observation_fields
        .keys()
        .cloned()
        .collect::<Vec<_>>()
    {
        let reserved = matches!(
            key.as_str(),
            "itemType"
                | "key"
                | "itemKey"
                | "version"
                | "dateAdded"
                | "dateModified"
                | "tags"
                | "collections"
                | "relations"
                | "parentItem"
                | "parentItemKey"
        );
        if !reserved
            && !fields.contains_key(&key)
            && local_observation_fields
                .get(&key)
                .is_some_and(Value::is_string)
        {
            local_observation_fields.remove(&key);
        }
    }
    for (field, value) in &fields {
        local_observation_fields.insert(field.clone(), Value::String(value.clone()));
    }
    local_observation_fields.insert("itemType".to_string(), Value::String(item_type.clone()));
    local_observation_fields.insert(
        "creators".to_string(),
        Value::Array(creator_values),
    );
    let local_observation = RecordObservation {
        source: "local-edit".to_string(),
        external_id: None,
        artifact_id: None,
        observed_at: now.clone(),
        fields: Value::Object(local_observation_fields),
    };
    if let Some(observation) = record
        .observations
        .iter_mut()
        .rev()
        .find(|observation| observation.source == "local-edit")
    {
        *observation = local_observation;
    } else {
        record.observations.push(local_observation);
    }
    let stored_revision = transaction
        .query_row(
            "SELECT revision FROM canonical_records WHERE id = ?1",
            [record_id],
            |row| row.get::<_, u64>(0),
        )
        .map_err(to_error)?;
    record.revision = stored_revision.saturating_add(1);
    record.updated_at = now;
    transaction
        .execute(
            "UPDATE canonical_records SET normalized_title = ?2, doi = ?3,
             revision = ?4, payload = ?5, updated_at = ?6 WHERE id = ?1 AND revision = ?7",
            params![
                record.id,
                record.normalized_title,
                record.identifiers.doi,
                record.revision,
                encode_payload(&record)?,
                record.updated_at,
                stored_revision,
            ],
        )
        .map_err(to_error)?;
    upsert_full_text_index(transaction, &record)
}

fn set_record_visibility_in_transaction(
    transaction: &Transaction<'_>,
    record_id: &str,
    visible: bool,
) -> Result<(), String> {
    let now = now_iso8601();
    transaction
        .execute(
            "UPDATE library_items SET trashed = ?2, version = version + 1,
             date_modified = ?3, updated_at = ?3
             WHERE id = ?1 AND trashed != ?2",
            params![record_id, bool_to_sql(!visible), now],
        )
        .map_err(to_error)?;
    let payload = transaction
        .query_row(
            "SELECT revision, payload FROM canonical_records WHERE id = ?1",
            [record_id],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(to_error)?;
    let Some((stored_revision, payload)) = payload else {
        return Ok(());
    };
    let mut record: CanonicalRecord = decode_payload(&payload)?;
    let mut metadata = record.metadata.as_object().cloned().unwrap_or_default();
    let hidden = !visible;
    if metadata
        .get("legacyLibraryHidden")
        .and_then(Value::as_bool)
        == Some(hidden)
    {
        return Ok(());
    }
    metadata.insert("legacyLibraryHidden".to_string(), Value::Bool(hidden));
    record.metadata = Value::Object(metadata);
    record.revision = stored_revision.saturating_add(1);
    record.updated_at = now;
    let changed = transaction
        .execute(
            "UPDATE canonical_records SET revision = ?2, payload = ?3, updated_at = ?4
             WHERE id = ?1 AND revision = ?5",
            params![
                record.id,
                record.revision,
                encode_payload(&record)?,
                record.updated_at,
                stored_revision,
            ],
        )
        .map_err(to_error)?;
    if changed == 0 {
        return Err(format!("canonical record {record_id} changed during visibility update"));
    }
    upsert_full_text_index(transaction, &record)
}

fn set_library_items_trash(
    store: &mut LiteratureStore,
    item_ids: &[String],
    trashed: bool,
) -> Result<Vec<LibraryItem>, String> {
    let ids = item_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let transaction = store
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(to_error)?;
    for id in &ids {
        if load_library_item(&transaction, id)?.is_none() {
            let payload = transaction
                .query_row(
                    "SELECT payload FROM canonical_records WHERE id = ?1",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(to_error)?;
            if let Some(payload) = payload {
                let record: CanonicalRecord = decode_payload(&payload)?;
                sync_library_item_model_in_transaction(&transaction, &record, None, false)?;
            }
        }
        let changed = transaction
            .execute(
                "WITH RECURSIVE descendants(id) AS (
                   SELECT id FROM library_items WHERE id = ?1
                   UNION ALL
                   SELECT child.id FROM library_items AS child
                   JOIN descendants ON child.parent_item_id = descendants.id
                 )
                 UPDATE library_items SET trashed = ?2, version = version + 1,
                   date_modified = ?3, updated_at = ?3
                 WHERE id IN (SELECT id FROM descendants)
                   AND trashed != ?2",
                params![id, bool_to_sql(trashed), now_iso8601()],
            )
            .map_err(to_error)?;
        if changed == 0 && load_library_item(&transaction, id)?.is_none() {
            return Err(format!("unknown library item: {id}"));
        }
        if transaction
            .query_row(
                "SELECT 1 FROM canonical_records WHERE id = ?1",
                [id],
                |_| Ok(()),
            )
            .optional()
            .map_err(to_error)?
            .is_some()
        {
            set_record_visibility_in_transaction(&transaction, id, !trashed)?;
        }
    }
    for id in &ids {
        append_audit(
            &transaction,
            "library_item",
            id,
            if trashed { "moved_to_trash" } else { "restored" },
            &json!({}),
        )?;
    }
    transaction.commit().map_err(to_error)?;
    let mut result = Vec::new();
    for id in ids {
        if let Some(item) = load_library_item(&store.connection, &id)? {
            result.push(item);
        }
    }
    Ok(result)
}

fn sync_library_saved_searches_in_transaction(
    transaction: &Transaction<'_>,
    value: &Value,
) -> Result<(), String> {
    let searches = value
        .as_array()
        .ok_or_else(|| "library saved searches must be a JSON array".to_string())?;
    let mut retained = BTreeSet::new();
    for entry in searches {
        let Some(id) = relation_string_field(entry, "id") else {
            continue;
        };
        // Run-mirrored entries are regenerated from `search_runs` on every
        // projection. Storing them here would duplicate every saved search and
        // make deleting one a no-op, because whichever copy survives restores
        // the other one on the next load.
        if search_run_id_for_saved_search(&id).is_some() {
            continue;
        }
        let query = relation_string_field(entry, "query").unwrap_or_else(|| id.clone());
        let name = relation_string_field(entry, "name")
            .or_else(|| relation_string_field(entry, "label"))
            .unwrap_or_else(|| query.clone());
        if name.is_empty() && query.is_empty() {
            continue;
        }
        let sources = entry
            .get("sources")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let existing = transaction
            .query_row(
                "SELECT version, created_at FROM library_saved_searches WHERE id = ?1",
                [&id],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(to_error)?;
        let version = existing
            .as_ref()
            .map(|(version, _)| version.saturating_add(1))
            .unwrap_or(1);
        let created_at = existing
            .as_ref()
            .map(|(_, created_at)| created_at.clone())
            .unwrap_or_else(now_iso8601);
        let updated_at = now_iso8601();
        transaction
            .execute(
                "INSERT INTO library_saved_searches(
                   id, library_id, name, query, sources, dynamic, version,
                   deleted, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   query = excluded.query,
                   sources = excluded.sources,
                   dynamic = excluded.dynamic,
                   version = excluded.version,
                   deleted = 0,
                   updated_at = excluded.updated_at",
                params![
                    id,
                    LOCAL_LIBRARY_ID,
                    name,
                    query,
                    encode_payload(&sources)?,
                    bool_to_sql(entry.get("dynamic").and_then(Value::as_bool).unwrap_or(false)),
                    version,
                    created_at,
                    updated_at,
                ],
            )
            .map_err(to_error)?;
        transaction
            .execute(
                "DELETE FROM library_saved_search_conditions WHERE saved_search_id = ?1",
                [&id],
            )
            .map_err(to_error)?;
        if let Some(conditions) = entry.get("conditions").and_then(Value::as_array) {
            for (condition_index, condition) in conditions.iter().enumerate() {
                let field = relation_string_field(condition, "field").unwrap_or_default();
                let operator = relation_string_field(condition, "operator")
                    .unwrap_or_else(|| "contains".to_string());
                let condition_value = relation_string_field(condition, "value").unwrap_or_default();
                if field.is_empty() {
                    continue;
                }
                let index = u32::try_from(condition_index).unwrap_or(u32::MAX);
                let condition_id = format!("condition:{}:{}", id, index);
                transaction
                    .execute(
                        "INSERT INTO library_saved_search_conditions(
                           id, saved_search_id, condition_index, field, operator, value, joiner
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![
                            condition_id,
                            id,
                            i64::from(index),
                            field,
                            operator,
                            condition_value,
                            relation_string_field(condition, "joiner")
                                .unwrap_or_else(|| "AND".to_string()),
                        ],
                    )
                    .map_err(to_error)?;
            }
        }
        retained.insert(id);
    }
    let existing_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM library_saved_searches WHERE deleted = 0")
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    for id in existing_ids {
        if !retained.contains(&id) {
            transaction
                .execute(
                    "UPDATE library_saved_searches SET deleted = 1, version = version + 1,
                     updated_at = ?2 WHERE id = ?1",
                    params![id, now_iso8601()],
                )
                .map_err(to_error)?;
        }
    }
    Ok(())
}

fn child_item_key(
    transaction: &Transaction<'_>,
    item_id: &str,
    source_payload: Option<&Value>,
) -> Result<String, String> {
    let candidate = value_string_from_object(source_payload, &["key", "itemKey"])
        .unwrap_or_else(|| stable_library_item_key(item_id));
    let collision = transaction
        .query_row(
            "SELECT id FROM library_items WHERE item_key = ?1 AND id != ?2",
            params![candidate, item_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(to_error)?;
    if collision.is_none() {
        Ok(candidate)
    } else {
        Ok(format!("{}-{}", candidate, stable_library_item_key(item_id)))
    }
}

fn ensure_child_library_item_in_transaction(
    transaction: &Transaction<'_>,
    item_id: &str,
    parent_item_id: &str,
    item_type: &str,
    source_payload: Option<&Value>,
    fields: &BTreeMap<String, String>,
) -> Result<(), String> {
    let item_key = child_item_key(transaction, item_id, source_payload)?;
    let existing = transaction
        .query_row(
            "SELECT version, date_added, deleted, trashed FROM library_items WHERE id = ?1",
            [item_id],
            |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(to_error)?;
    let version = existing
        .as_ref()
        .map(|(version, _, _, _)| version.saturating_add(1))
        .unwrap_or(1);
    let date_added = existing
        .as_ref()
        .map(|(_, date_added, _, _)| date_added.clone())
        .or_else(|| value_string_from_object(source_payload, &["dateAdded"]))
        .unwrap_or_else(now_iso8601);
    let deleted = existing
        .as_ref()
        .map(|(_, _, deleted, _)| sql_to_bool(*deleted))
        .unwrap_or(false);
    let trashed = existing
        .as_ref()
        .map(|(_, _, _, trashed)| sql_to_bool(*trashed))
        .unwrap_or(false);
    let now = now_iso8601();
    transaction
        .execute(
            "INSERT INTO library_items(
               id, item_key, library_id, item_type, parent_item_id, version,
               deleted, trashed, date_added, date_modified, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
               item_key = excluded.item_key,
               item_type = excluded.item_type,
               parent_item_id = excluded.parent_item_id,
               version = excluded.version,
               deleted = excluded.deleted,
               trashed = excluded.trashed,
               date_modified = excluded.date_modified,
               updated_at = excluded.updated_at",
            params![
                item_id,
                item_key,
                LOCAL_LIBRARY_ID,
                item_type,
                parent_item_id,
                version,
                bool_to_sql(deleted),
                bool_to_sql(trashed),
                date_added,
                now,
            ],
        )
        .map_err(to_error)?;
    replace_library_item_fields_map_in_transaction(transaction, item_id, fields)?;
    Ok(())
}

fn replace_library_item_fields_map_in_transaction(
    transaction: &Transaction<'_>,
    item_id: &str,
    fields: &BTreeMap<String, String>,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM library_item_data WHERE item_id = ?1", [item_id])
        .map_err(to_error)?;
    upsert_library_item_fields_in_transaction(transaction, item_id, fields)
}

fn attachment_fields(attachment: &LibraryAttachment) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    fields.insert("title".to_string(), attachment.label.clone());
    for (field, value) in [
        ("path", attachment.path.clone()),
        ("url", attachment.url.clone()),
        ("externalPath", attachment.external_path.clone()),
        ("contentType", attachment.mime_type.clone()),
        ("linkMode", attachment.link_mode.clone()),
        ("filename", attachment.filename.clone()),
        ("charset", attachment.charset.clone()),
        ("hash", attachment.hash.clone()),
    ] {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            fields.insert(field.to_string(), value);
        }
    }
    if let Some(bytes) = attachment.bytes {
        fields.insert("bytes".to_string(), bytes.to_string());
    }
    if let Some(last_page_index) = attachment.last_page_index {
        fields.insert("lastPageIndex".to_string(), last_page_index.to_string());
    }
    fields
}

fn note_fields(note: &LibraryNote) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::from([
        ("note".to_string(), note.content.clone()),
    ]);
    if let Some(title) = &note.title {
        fields.insert("title".to_string(), title.clone());
    }
    fields
}

fn annotation_fields(annotation: &LibraryAnnotation) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::from([
        ("annotationText".to_string(), annotation.quote.clone()),
        ("annotationComment".to_string(), annotation.note.clone()),
        ("annotationType".to_string(), annotation.annotation_type.clone().unwrap_or_else(|| annotation.kind.clone())),
        ("annotationPageLabel".to_string(), annotation.page_label.clone().unwrap_or_else(|| annotation.page.to_string())),
    ]);
    if let Some(color) = &annotation.color {
        fields.insert("annotationColor".to_string(), color.clone());
    }
    if let Some(style) = &annotation.style {
        fields.insert("annotationStyle".to_string(), style.clone());
    }
    if let Some(position) = &annotation.position {
        fields.insert("annotationPosition".to_string(), position.to_string());
    }
    fields
}

fn sync_library_children_in_transaction(
    transaction: &Transaction<'_>,
    parent_item_id: &str,
) -> Result<(), String> {
    let attachments = load_library_attachments_for_sync(transaction, parent_item_id)?;
    let notes = load_library_notes_for_sync(transaction, parent_item_id)?;
    let annotations = load_library_annotations_for_sync(transaction, parent_item_id)?;
    let attachment_ids = attachments
        .iter()
        .map(|attachment| attachment.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut retained = BTreeSet::new();
    for attachment in &attachments {
        retained.insert(attachment.id.clone());
        ensure_child_library_item_in_transaction(
            transaction,
            &attachment.id,
            parent_item_id,
            "attachment",
            attachment.source_payload.as_ref(),
            &attachment_fields(attachment),
        )?;
    }
    for note in &notes {
        retained.insert(note.id.clone());
        let note_parent = note
            .attachment_id
            .as_deref()
            .filter(|attachment_id| attachment_ids.contains(*attachment_id))
            .unwrap_or(parent_item_id);
        ensure_child_library_item_in_transaction(
            transaction,
            &note.id,
            note_parent,
            "note",
            note.source_payload.as_ref(),
            &note_fields(note),
        )?;
    }
    for annotation in &annotations {
        retained.insert(annotation.id.clone());
        let annotation_parent = annotation
            .attachment_id
            .as_deref()
            .filter(|attachment_id| attachment_ids.contains(*attachment_id))
            .unwrap_or(parent_item_id);
        ensure_child_library_item_in_transaction(
            transaction,
            &annotation.id,
            annotation_parent,
            "annotation",
            annotation.source_payload.as_ref(),
            &annotation_fields(annotation),
        )?;
    }
    let existing = {
        let mut statement = transaction
            .prepare(
                "WITH RECURSIVE descendants(id, depth) AS (
                   SELECT id, 1 FROM library_items WHERE parent_item_id = ?1
                   UNION ALL
                   SELECT child.id, descendants.depth + 1
                   FROM library_items AS child
                   JOIN descendants ON child.parent_item_id = descendants.id
                 )
                 SELECT id FROM descendants ORDER BY depth DESC, id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([parent_item_id], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    for item_id in existing {
        if !retained.contains(&item_id) {
            transaction
                .execute("DELETE FROM library_items WHERE id = ?1", [item_id])
                .map_err(to_error)?;
        }
    }
    Ok(())
}

fn sync_library_collections_in_transaction(
    transaction: &Transaction<'_>,
    value: &Value,
) -> Result<(), String> {
    let collections = value
        .as_array()
        .ok_or_else(|| "library collections must be a JSON array".to_string())?;
    let mut entries = Vec::<(String, String, Option<String>, i64)>::new();
    let mut parent_by_id = BTreeMap::<String, Option<String>>::new();
    for (collection_index, entry) in collections.iter().enumerate() {
        let Some(id) = relation_string_field(entry, "id") else {
            continue;
        };
        let Some(label) = relation_string_field(entry, "label") else {
            continue;
        };
        if id.is_empty() || label.is_empty() {
            continue;
        }
        let parent_id = relation_string_field(entry, "parentId");
        let order_index = entry
            .get("orderIndex")
            .and_then(Value::as_i64)
            .filter(|value| *value >= 0)
            .or_else(|| {
                entry
                    .get("orderIndex")
                    .and_then(Value::as_u64)
                    .and_then(|value| i64::try_from(value).ok())
            })
            .unwrap_or_else(|| i64::try_from(collection_index).unwrap_or(i64::MAX));
        if parent_id.as_deref() == Some(id.as_str()) {
            return Err(format!("library collection {id} cannot be its own parent"));
        }
        parent_by_id.insert(id.clone(), parent_id.clone());
        entries.push((id, label, parent_id, order_index));
    }
    for id in parent_by_id.keys() {
        let mut visited = BTreeSet::new();
        let mut current = Some(id.clone());
        while let Some(collection_id) = current {
            if !visited.insert(collection_id.clone()) {
                return Err(format!(
                    "library collection hierarchy contains a cycle at {collection_id}"
                ));
            }
            current = parent_by_id.get(&collection_id).cloned().flatten();
        }
    }
    let mut retained_ids = BTreeSet::new();
    for (id, label, parent_id, order_index) in entries {
        let now = now_iso8601();
        transaction
            .execute(
                "INSERT INTO library_collections(
                   id, parent_id, label, order_index, revision, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                   parent_id = excluded.parent_id,
                   label = excluded.label,
                   order_index = excluded.order_index,
                   revision = library_collections.revision + 1,
                   updated_at = excluded.updated_at",
                params![id, parent_id, label, order_index, now],
            )
            .map_err(to_error)?;
        retained_ids.insert(id);
    }

    let existing_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM library_collections")
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    for id in existing_ids {
        if !retained_ids.contains(&id) {
            transaction
                .execute("DELETE FROM library_collections WHERE id = ?1", [id])
                .map_err(to_error)?;
        }
    }
    Ok(())
}

fn legacy_library_payload(metadata: &Value) -> Option<&Value> {
    if metadata
        .get("legacyLibrary")
        .is_some_and(Value::is_object)
    {
        return metadata.get("legacyLibrary");
    }
    let object = metadata.as_object()?;
    let has_legacy_fields = [
        "stage",
        "tags",
        "collectionIds",
        "attachments",
        "notes",
        "pdfAnnotations",
        "pdf",
        "relations",
    ]
    .iter()
    .any(|key| object.contains_key(*key));
    has_legacy_fields.then_some(metadata)
}

fn merge_legacy_library_relation_cache(record: &mut CanonicalRecord, relations: &Value) {
    let mut metadata = record.metadata.as_object().cloned().unwrap_or_default();
    let mut legacy = metadata
        .get("legacyLibrary")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for key in [
        "tags",
        "collectionIds",
        "attachments",
        "notes",
        "pdfAnnotations",
        "pdf",
        "relations",
    ] {
        if let Some(value) = relations.get(key) {
            legacy.insert(key.to_string(), value.clone());
        }
    }
    metadata.insert("legacyLibrary".to_string(), Value::Object(legacy));
    record.metadata = Value::Object(metadata);
}

fn scoped_primary_pdf_attachment_id(record_id: &str) -> String {
    format!("{LEGACY_PRIMARY_PDF_ATTACHMENT_ID}:{record_id}")
}

fn remap_legacy_primary_pdf_id(value: &Value, key: &str, scoped_id: &str) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    if object.get(key).and_then(Value::as_str) != Some(LEGACY_PRIMARY_PDF_ATTACHMENT_ID) {
        return value.clone();
    }
    let mut normalized = object.clone();
    normalized.insert(key.to_string(), Value::String(scoped_id.to_string()));
    Value::Object(normalized)
}

/// Older Desktop snapshots used one synthetic attachment ID for every paper.
/// Attachment IDs are database-wide primary keys, so normalize that legacy
/// marker to a record-scoped ID before any relationship is persisted.
fn normalize_legacy_primary_pdf_references(paper: &Value, record_id: &str) -> Value {
    let Some(object) = paper.as_object() else {
        return paper.clone();
    };
    let scoped_id = scoped_primary_pdf_attachment_id(record_id);
    let mut normalized = object.clone();
    if let Some(attachments) = object.get("attachments").and_then(Value::as_array) {
        normalized.insert(
            "attachments".to_string(),
            Value::Array(
                attachments
                    .iter()
                    .map(|attachment| remap_legacy_primary_pdf_id(attachment, "id", &scoped_id))
                    .collect(),
            ),
        );
    }
    for key in ["pdfAnnotations", "notes"] {
        if let Some(entries) = object.get(key).and_then(Value::as_array) {
            normalized.insert(
                key.to_string(),
                Value::Array(
                    entries
                        .iter()
                        .map(|entry| {
                            remap_legacy_primary_pdf_id(entry, "attachmentId", &scoped_id)
                        })
                        .collect(),
                ),
            );
        }
    }
    if let Some(pdf) = object.get("pdf") {
        normalized.insert(
            "pdf".to_string(),
            remap_legacy_primary_pdf_id(pdf, "attachmentId", &scoped_id),
        );
    }
    Value::Object(normalized)
}

fn sync_library_item_relations_in_transaction(
    transaction: &Transaction<'_>,
    record_id: &str,
    paper: &Value,
) -> Result<(), String> {
    if !paper.is_object() {
        return Err("library item relationships must be a JSON object".to_string());
    }
    let paper = normalize_legacy_primary_pdf_references(paper, record_id);

    if let Some(collections) = paper.get("collectionIds") {
        transaction
            .execute(
                "DELETE FROM library_collection_items WHERE item_id = ?1",
                [record_id],
            )
            .map_err(to_error)?;
        for (order_index, collection_id) in relation_string_values(collections).into_iter().enumerate()
        {
            transaction
                .execute(
                    "INSERT INTO library_collections(
                       id, label, revision, created_at, updated_at
                     ) VALUES (?1, ?1, 1, ?2, ?2)
                     ON CONFLICT(id) DO NOTHING",
                    params![collection_id, now_iso8601()],
                )
                .map_err(to_error)?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO library_collection_items(
                       item_id, collection_id, order_index, created_at
                     ) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        record_id,
                        collection_id,
                        i64::try_from(order_index).unwrap_or(i64::MAX),
                        now_iso8601(),
                    ],
                )
                .map_err(to_error)?;
        }
    }

    if let Some(tags) = paper.get("tags") {
        transaction
            .execute(
                "DELETE FROM library_item_tags WHERE item_id = ?1",
                [record_id],
            )
            .map_err(to_error)?;
        for tag in tags.as_array().into_iter().flatten() {
            let tag_id = ensure_library_tag_value_in_transaction(transaction, tag)?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO library_item_tags(
                       item_id, tag_id, origin, created_at
                     ) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        record_id,
                        tag_id,
                        relation_string_field(tag, "origin")
                            .or_else(|| relation_string_field(tag, "kind"))
                            .unwrap_or_else(|| "user".to_string()),
                        now_iso8601()
                    ],
                )
                .map_err(to_error)?;
        }
    }

    let should_sync_attachments =
        paper.get("attachments").is_some() || paper.get("pdf").is_some();
    let previous_attachment_ids = if should_sync_attachments {
        existing_attachment_ids(transaction, record_id)?
    } else {
        BTreeSet::new()
    };
    let attachment_values = if should_sync_attachments {
        relation_attachment_values(&paper, record_id)
    } else {
        Vec::new()
    };
    if should_sync_attachments {
        let next_attachment_ids = attachment_values
            .iter()
            .filter_map(|entry| relation_string_field(entry, "id"))
            .collect::<BTreeSet<_>>();
        // Attachment full text is an FTS5 table without a foreign key, so
        // deleting the normalized attachment row cannot clean its index.
        // Remove only IDs that leave this record; retained attachments keep
        // their extracted text across metadata/relationship updates.
        for attachment_id in previous_attachment_ids.difference(&next_attachment_ids) {
            transaction
                .execute(
                    "DELETE FROM library_attachment_full_text WHERE item_id = ?1",
                    [attachment_id],
                )
                .map_err(to_error)?;
        }
        transaction
            .execute(
                "DELETE FROM library_attachments WHERE item_id = ?1",
                [record_id],
            )
            .map_err(to_error)?;
        for attachment in &attachment_values {
            insert_library_attachment_in_transaction(transaction, record_id, attachment)?;
        }
    }
    let attachment_ids = if should_sync_attachments {
        attachment_values
            .iter()
            .filter_map(|entry| relation_string_field(entry, "id"))
            .collect::<BTreeSet<_>>()
    } else {
        existing_attachment_ids(transaction, record_id)?
    };

    let should_sync_annotations = paper.get("pdfAnnotations").is_some();
    let annotation_values = paper
        .get("pdfAnnotations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if should_sync_annotations {
        transaction
            .execute(
                "DELETE FROM library_annotations WHERE item_id = ?1",
                [record_id],
            )
            .map_err(to_error)?;
        for annotation in &annotation_values {
            insert_library_annotation_in_transaction(
                transaction,
                record_id,
                annotation,
                &attachment_ids,
            )?;
        }
    }
    let annotation_ids = if should_sync_annotations {
        annotation_values
            .iter()
            .filter_map(|entry| relation_string_field(entry, "id"))
            .collect::<BTreeSet<_>>()
    } else {
        existing_annotation_ids(transaction, record_id)?
    };

    if let Some(notes) = paper.get("notes") {
        transaction
            .execute(
                "DELETE FROM library_notes WHERE item_id = ?1",
                [record_id],
            )
            .map_err(to_error)?;
        for note in notes.as_array().into_iter().flatten() {
            insert_library_note_in_transaction(
                transaction,
                record_id,
                note,
                &attachment_ids,
                &annotation_ids,
            )?;
        }
    }
    if let Some(relations) = paper.get("relations") {
        replace_library_item_relations_in_transaction(transaction, record_id, relations)?;
    }
    // Relationship-only updates also need to reconcile normalized child
    // library items. Without this call, removing an attachment from the
    // canonical payload leaves a stale child item visible in the model even
    // though the relationship table no longer contains it.
    sync_library_children_in_transaction(transaction, record_id)?;
    Ok(())
}

fn relation_string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn relation_string_values(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            entry
                .as_str()
                .or_else(|| entry.get("tag").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn relation_attachment_values(paper: &Value, record_id: &str) -> Vec<Value> {
    let mut attachments = paper
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(pdf) = paper.get("pdf").and_then(Value::as_object) else {
        return attachments;
    };
    let Some(path) = pdf
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return attachments;
    };
    let already_present = attachments.iter().any(|attachment| {
        attachment.get("kind").and_then(Value::as_str) == Some("pdf")
            && attachment.get("path").and_then(Value::as_str) == Some(path)
    });
    if !already_present {
        attachments.insert(
            0,
            json!({
                "id": scoped_primary_pdf_attachment_id(record_id),
                "label": "Primary PDF",
                "kind": "pdf",
                "path": path,
                "url": pdf.get("url").cloned().unwrap_or(Value::Null),
                "bytes": pdf.get("bytes").cloned().unwrap_or(Value::Null),
                "addedAt": paper
                    .get("addedAt")
                    .cloned()
                    .unwrap_or_else(|| Value::String(now_iso8601())),
            }),
        );
    }
    attachments
}

fn valid_library_attachment_kind(kind: &str) -> &str {
    match kind {
        "pdf" | "supplement" | "webSnapshot" | "externalLink" => kind,
        _ => "externalLink",
    }
}

fn insert_library_attachment_in_transaction(
    transaction: &Transaction<'_>,
    record_id: &str,
    attachment: &Value,
) -> Result<(), String> {
    let Some(id) = relation_string_field(attachment, "id") else {
        return Ok(());
    };
    let label = relation_string_field(attachment, "label").unwrap_or_else(|| "Attachment".to_string());
    let kind_value = relation_string_field(attachment, "kind");
    let kind = valid_library_attachment_kind(kind_value.as_deref().unwrap_or("externalLink"));
    let bytes = attachment
        .get("bytes")
        .and_then(Value::as_u64)
        .and_then(|bytes| i64::try_from(bytes).ok());
    let mtime = attachment
        .get("mtime")
        .and_then(Value::as_i64)
        .or_else(|| {
            attachment
                .get("mtime")
                .and_then(Value::as_u64)
                .and_then(|value| i64::try_from(value).ok())
        });
    let source_payload = encode_payload(
        attachment
            .get("sourcePayload")
            .filter(|value| value.is_object())
            .unwrap_or(attachment),
    )?;
    transaction
        .execute(
            "INSERT INTO library_attachments(
               id, item_id, label, kind, path, url, external_path,
               mime_type, bytes, link_mode, filename, charset, hash, mtime,
               last_page_index, source_payload, added_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
             ON CONFLICT(id) DO UPDATE SET
               item_id = excluded.item_id,
               label = excluded.label,
               kind = excluded.kind,
               path = excluded.path,
               url = excluded.url,
               external_path = excluded.external_path,
               mime_type = excluded.mime_type,
               bytes = excluded.bytes,
               link_mode = excluded.link_mode,
               filename = excluded.filename,
               charset = excluded.charset,
               hash = excluded.hash,
               mtime = excluded.mtime,
               last_page_index = excluded.last_page_index,
               source_payload = excluded.source_payload,
               added_at = excluded.added_at",
            params![
                id,
                record_id,
                label,
                kind,
                relation_string_field(attachment, "path"),
                relation_string_field(attachment, "url"),
                relation_string_field(attachment, "externalPath"),
                relation_string_field(attachment, "mimeType"),
                bytes,
                relation_string_field(attachment, "linkMode"),
                relation_string_field(attachment, "filename"),
                relation_string_field(attachment, "charset"),
                relation_string_field(attachment, "hash"),
                mtime,
                attachment
                    .get("lastPageIndex")
                    .and_then(Value::as_u64)
                    .and_then(|value| i64::try_from(value).ok()),
                source_payload,
                relation_string_field(attachment, "addedAt").unwrap_or_else(now_iso8601),
            ],
        )
        .map_err(to_error)?;
    Ok(())
}

fn insert_library_annotation_in_transaction(
    transaction: &Transaction<'_>,
    record_id: &str,
    annotation: &Value,
    attachment_ids: &BTreeSet<String>,
) -> Result<(), String> {
    let Some(id) = relation_string_field(annotation, "id") else {
        return Ok(());
    };
    let page = annotation
        .get("page")
        .and_then(Value::as_u64)
        .and_then(|page| u32::try_from(page).ok())
        .filter(|page| *page > 0)
        .unwrap_or(1);
    let attachment_id = relation_string_field(annotation, "attachmentId")
        .filter(|attachment_id| attachment_ids.contains(attachment_id));
    let rects = annotation
        .get("rects")
        .filter(|value| !value.is_null())
        .map(encode_payload)
        .transpose()?;
    let position = annotation
        .get("position")
        .or_else(|| annotation.get("annotationPosition"))
        .filter(|value| !value.is_null())
        .map(|value| {
            if let Some(value) = value.as_str() {
                serde_json::from_str::<Value>(value)
                    .unwrap_or_else(|_| Value::String(value.to_string()))
            } else {
                value.clone()
            }
        })
        .map(|value| encode_payload(&value))
        .transpose()?;
    let source_payload = encode_payload(
        annotation
            .get("sourcePayload")
            .filter(|value| value.is_object())
            .unwrap_or(annotation),
    )?;
    transaction
        .execute(
            "INSERT INTO library_annotations(
               id, item_id, attachment_id, page, page_label, quote, note, kind, color,
               style, rects, source, image_fingerprint, source_id, evidence_id,
               annotation_type, position, sort_index, author, is_external,
               source_payload, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
             ON CONFLICT(id) DO UPDATE SET
               item_id = excluded.item_id,
               attachment_id = excluded.attachment_id,
               page = excluded.page,
               page_label = excluded.page_label,
               quote = excluded.quote,
               note = excluded.note,
               kind = excluded.kind,
               color = excluded.color,
               style = excluded.style,
               rects = excluded.rects,
               source = excluded.source,
               image_fingerprint = excluded.image_fingerprint,
               source_id = excluded.source_id,
               evidence_id = excluded.evidence_id,
               annotation_type = excluded.annotation_type,
               position = excluded.position,
               sort_index = excluded.sort_index,
               author = excluded.author,
               is_external = excluded.is_external,
               source_payload = excluded.source_payload,
               created_at = excluded.created_at",
            params![
                id,
                record_id,
                attachment_id,
                i64::from(page),
                relation_string_field(annotation, "pageLabel")
                    .or_else(|| relation_string_field(annotation, "annotationPageLabel")),
                relation_string_field(annotation, "quote").unwrap_or_default(),
                relation_string_field(annotation, "note").unwrap_or_default(),
                relation_string_field(annotation, "kind").unwrap_or_else(|| "note".to_string()),
                relation_string_field(annotation, "color"),
                relation_string_field(annotation, "style"),
                rects,
                relation_string_field(annotation, "source"),
                relation_string_field(annotation, "imageFingerprint"),
                relation_string_field(annotation, "sourceId"),
                relation_string_field(annotation, "evidenceId"),
                relation_string_field(annotation, "annotationType")
                    .or_else(|| relation_string_field(annotation, "type")),
                position,
                annotation
                    .get("sortIndex")
                    .and_then(Value::as_u64)
                    .and_then(|value| i64::try_from(value).ok()),
                relation_string_field(annotation, "author"),
                bool_to_sql(
                    annotation
                        .get("isExternal")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                ),
                source_payload,
                relation_string_field(annotation, "createdAt").unwrap_or_else(now_iso8601),
            ],
        )
        .map_err(to_error)?;
    Ok(())
}

fn insert_library_note_in_transaction(
    transaction: &Transaction<'_>,
    record_id: &str,
    note: &Value,
    attachment_ids: &BTreeSet<String>,
    annotation_ids: &BTreeSet<String>,
) -> Result<(), String> {
    let Some(id) = relation_string_field(note, "id") else {
        return Ok(());
    };
    let Some(content) = relation_string_field(note, "content") else {
        return Ok(());
    };
    let annotation_id = relation_string_field(note, "annotationId")
        .filter(|annotation_id| annotation_ids.contains(annotation_id));
    let attachment_id = relation_string_field(note, "attachmentId")
        .filter(|attachment_id| attachment_ids.contains(attachment_id));
    let created_at = relation_string_field(note, "createdAt").unwrap_or_else(now_iso8601);
    let updated_at = relation_string_field(note, "updatedAt").unwrap_or_else(|| created_at.clone());
    let source_payload = encode_payload(
        note.get("sourcePayload")
            .filter(|value| value.is_object())
            .unwrap_or(note),
    )?;
    transaction
        .execute(
            "INSERT INTO library_notes(
               id, item_id, title, content, created_at, updated_at,
               annotation_id, attachment_id, evidence_id, source, source_payload
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
               item_id = excluded.item_id,
               title = excluded.title,
               content = excluded.content,
               created_at = excluded.created_at,
               updated_at = excluded.updated_at,
               annotation_id = excluded.annotation_id,
               attachment_id = excluded.attachment_id,
               evidence_id = excluded.evidence_id,
               source = excluded.source,
               source_payload = excluded.source_payload",
            params![
                id,
                record_id,
                relation_string_field(note, "title"),
                content,
                created_at,
                updated_at,
                annotation_id,
                attachment_id,
                relation_string_field(note, "evidenceId"),
                relation_string_field(note, "source"),
                source_payload,
            ],
        )
        .map_err(to_error)?;
    Ok(())
}

fn ensure_library_tag_value_in_transaction(
    transaction: &Transaction<'_>,
    value: &Value,
) -> Result<String, String> {
    let name = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| relation_string_field(value, "tag"))
        .ok_or_else(|| "library tag must contain a non-empty name".to_string())?;
    let kind = relation_string_field(value, "kind")
        .or_else(|| relation_string_field(value, "origin"))
        .unwrap_or_else(|| "user".to_string());
    let tag_type = value
        .get("type")
        .and_then(Value::as_u64)
        .or_else(|| value.get("tagType").and_then(Value::as_u64))
        .and_then(|value| i64::try_from(value).ok())
        .unwrap_or(0);
    let color = relation_string_field(value, "color");
    let id = transaction
        .query_row(
            "SELECT id FROM library_tags WHERE name = ?1 COLLATE NOCASE",
            [&name],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(to_error)?
        .unwrap_or_else(|| format!("tag:{}", sha256_hex(name.to_ascii_lowercase().as_bytes())));
    let now = now_iso8601();
    transaction
        .execute(
            "INSERT INTO library_tags(id, name, kind, tag_type, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(name) DO UPDATE SET
               kind = excluded.kind,
               tag_type = excluded.tag_type,
               color = COALESCE(excluded.color, library_tags.color),
               updated_at = excluded.updated_at",
            params![id, name, kind, tag_type, color, now],
        )
        .map_err(to_error)?;
    transaction
        .query_row(
            "SELECT id FROM library_tags WHERE name = ?1 COLLATE NOCASE",
            [&name],
            |row| row.get::<_, String>(0),
        )
        .map_err(to_error)
}

fn existing_attachment_ids(
    transaction: &Transaction<'_>,
    record_id: &str,
) -> Result<BTreeSet<String>, String> {
    let mut statement = transaction
        .prepare("SELECT id FROM library_attachments WHERE item_id = ?1")
        .map_err(to_error)?;
    let rows = statement
        .query_map([record_id], |row| row.get::<_, String>(0))
        .map_err(to_error)?;
    rows.collect::<Result<BTreeSet<_>, _>>().map_err(to_error)
}

fn existing_annotation_ids(
    transaction: &Transaction<'_>,
    record_id: &str,
) -> Result<BTreeSet<String>, String> {
    let mut statement = transaction
        .prepare("SELECT id FROM library_annotations WHERE item_id = ?1")
        .map_err(to_error)?;
    let rows = statement
        .query_map([record_id], |row| row.get::<_, String>(0))
        .map_err(to_error)?;
    rows.collect::<Result<BTreeSet<_>, _>>().map_err(to_error)
}

fn decode_optional_payload_for_row(
    payload: Option<String>,
) -> Result<Option<Value>, rusqlite::Error> {
    payload
        .map(|payload| {
            decode_payload::<Value>(&payload).map_err(|error| {
                rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error)))
            })
        })
        .transpose()
}

fn load_library_item(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<LibraryItem>, String> {
    if item_id.is_empty() {
        return Ok(None);
    }
    connection
        .query_row(
            "SELECT id, item_key, library_id, item_type, parent_item_id, version,
                    deleted, trashed, date_added, date_modified
             FROM library_items WHERE id = ?1",
            [item_id],
            |row| {
                Ok(LibraryItem {
                    id: row.get(0)?,
                    key: row.get(1)?,
                    library_id: row.get(2)?,
                    item_type: row.get(3)?,
                    parent_item_id: row.get(4)?,
                    version: row.get(5)?,
                    deleted: sql_to_bool(row.get(6)?),
                    trashed: sql_to_bool(row.get(7)?),
                    date_added: row.get(8)?,
                    date_modified: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(to_error)
}

fn load_library_tags(connection: &Connection) -> Result<Vec<LibraryTag>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, name, kind, tag_type, color FROM library_tags
             ORDER BY name COLLATE NOCASE, id",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(LibraryTag {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                tag_type: row.get::<_, i64>(3)?.try_into().unwrap_or_default(),
                color: row.get(4)?,
            })
        })
        .map_err(to_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(to_error)
}

fn load_library_tags_for_item(
    connection: &Connection,
    item_id: &str,
) -> Result<Vec<LibraryTag>, String> {
    let mut statement = connection
        .prepare(
            "SELECT tags.id, tags.name, tags.kind, tags.tag_type, tags.color
             FROM library_item_tags AS item_tags
             JOIN library_tags AS tags ON tags.id = item_tags.tag_id
             WHERE item_tags.item_id = ?1
             ORDER BY item_tags.created_at, tags.name COLLATE NOCASE, tags.id",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map([item_id], |row| {
            Ok(LibraryTag {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                tag_type: row.get::<_, i64>(3)?.try_into().unwrap_or_default(),
                color: row.get(4)?,
            })
        })
        .map_err(to_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(to_error)
}

fn load_library_item_relations_generic(
    connection: &Connection,
    item_id: &str,
) -> Result<Vec<LibraryItemRelation>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, source_item_id, predicate, target, target_kind, created_at
             FROM library_item_relations
             WHERE source_item_id = ?1
             ORDER BY predicate, target_kind, target, id",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map([item_id], |row| {
            Ok(LibraryItemRelation {
                id: row.get(0)?,
                source_item_id: row.get(1)?,
                predicate: row.get(2)?,
                target: row.get(3)?,
                target_kind: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(to_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(to_error)
}

fn load_library_full_text_status(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<LibraryFullTextStatus>, String> {
    connection
        .query_row(
            "SELECT item_id, indexed_pages, total_pages, indexed_chars, total_chars,
                    version, text_hash, status, updated_at
             FROM library_fulltext_items WHERE item_id = ?1",
            [item_id],
            |row| {
                Ok(LibraryFullTextStatus {
                    item_id: row.get(0)?,
                    indexed_pages: row
                        .get::<_, Option<i64>>(1)?
                        .and_then(|value| u32::try_from(value).ok()),
                    total_pages: row
                        .get::<_, Option<i64>>(2)?
                        .and_then(|value| u32::try_from(value).ok()),
                    indexed_chars: row
                        .get::<_, Option<i64>>(3)?
                        .and_then(|value| u64::try_from(value).ok()),
                    total_chars: row
                        .get::<_, Option<i64>>(4)?
                        .and_then(|value| u64::try_from(value).ok()),
                    version: row.get(5)?,
                    text_hash: row.get(6)?,
                    status: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(to_error)
}

fn load_library_child_source_payload(
    connection: &Connection,
    item: &LibraryItem,
) -> Result<Option<Value>, String> {
    match item.item_type.as_str() {
        "attachment" => connection
            .query_row(
                "SELECT source_payload FROM library_attachments WHERE id = ?1",
                [&item.id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(to_error)?
            .flatten()
            .map(|payload| decode_payload(&payload))
            .transpose(),
        "note" => connection
            .query_row(
                "SELECT source_payload FROM library_notes WHERE id = ?1",
                [&item.id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(to_error)?
            .flatten()
            .map(|payload| decode_payload(&payload))
            .transpose(),
        "annotation" => connection
            .query_row(
                "SELECT source_payload FROM library_annotations WHERE id = ?1",
                [&item.id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(to_error)?
            .flatten()
            .map(|payload| decode_payload(&payload))
            .transpose(),
        _ => Ok(None),
    }
}

fn load_library_child_source_payloads(
    connection: &Connection,
    item_type: &str,
) -> Result<BTreeMap<String, Value>, String> {
    let table = match item_type {
        "attachment" => "library_attachments",
        "note" => "library_notes",
        "annotation" => "library_annotations",
        _ => return Ok(BTreeMap::new()),
    };
    let query = format!("SELECT id, source_payload FROM {table}");
    let mut statement = connection.prepare(&query).map_err(to_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                decode_optional_payload_for_row(row.get(1)?)?,
            ))
        })
        .map_err(to_error)?;
    let mut payloads = BTreeMap::new();
    for row in rows {
        let (item_id, payload) = row.map_err(to_error)?;
        if let Some(payload) = payload {
            payloads.insert(item_id, payload);
        }
    }
    Ok(payloads)
}

fn load_library_item_snapshot(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<LibraryItemSnapshot>, String> {
    let Some(item) = load_library_item(connection, item_id)? else {
        return Ok(None);
    };
    let collection_ids = {
        let mut statement = connection
            .prepare(
                "SELECT collection_id FROM library_collection_items
                 WHERE item_id = ?1 ORDER BY order_index, collection_id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([item_id], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    Ok(Some(LibraryItemSnapshot {
        source_payload: load_library_child_source_payload(connection, &item)?,
        full_text: load_library_full_text_status(connection, item_id)?,
        fields: load_library_item_fields(connection, item_id)?,
        creators: load_library_item_creators(connection, item_id)?,
        tags: load_library_tags_for_item(connection, item_id)?,
        collection_ids,
        relations: load_library_item_relations_generic(connection, item_id)?,
        item,
    }))
}

fn load_library_item_snapshots(
    connection: &Connection,
) -> Result<Vec<LibraryItemSnapshot>, String> {
    let items = {
        let mut statement = connection
            .prepare(
                "SELECT id, item_key, library_id, item_type, parent_item_id, version,
                        deleted, trashed, date_added, date_modified
                 FROM library_items
                 ORDER BY parent_item_id IS NOT NULL, date_modified DESC, id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(LibraryItem {
                    id: row.get(0)?,
                    key: row.get(1)?,
                    library_id: row.get(2)?,
                    item_type: row.get(3)?,
                    parent_item_id: row.get(4)?,
                    version: row.get(5)?,
                    deleted: sql_to_bool(row.get(6)?),
                    trashed: sql_to_bool(row.get(7)?),
                    date_added: row.get(8)?,
                    date_modified: row.get(9)?,
                })
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    if items.is_empty() {
        return Ok(Vec::new());
    }

    let mut fields_by_item = BTreeMap::<String, BTreeMap<String, String>>::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT item_id, field, value FROM library_item_data
                 ORDER BY item_id, field",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(to_error)?;
        for row in rows {
            let (item_id, field, value): (String, String, String) = row.map_err(to_error)?;
            fields_by_item
                .entry(item_id)
                .or_default()
                .insert(field, value);
        }
    }

    let mut creators_by_item = BTreeMap::<String, Vec<LibraryCreator>>::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT item_creators.item_id, creators.id, item_creators.creator_type,
                        creators.first_name, creators.last_name, creators.name,
                        creators.field_mode, item_creators.order_index
                 FROM library_item_creators AS item_creators
                 JOIN library_creators AS creators ON creators.id = item_creators.creator_id
                 ORDER BY item_creators.item_id, item_creators.order_index,
                          item_creators.creator_type, creators.id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                let item_id: String = row.get(0)?;
                let creator = LibraryCreator {
                    id: row.get(1)?,
                    creator_type: row.get(2)?,
                    first_name: row.get(3)?,
                    last_name: row.get(4)?,
                    name: row.get(5)?,
                    field_mode: row.get(6)?,
                    order_index: row
                        .get::<_, i64>(7)?
                        .try_into()
                        .unwrap_or_default(),
                };
                Ok((item_id, creator))
            })
            .map_err(to_error)?;
        for row in rows {
            let (item_id, creator) = row.map_err(to_error)?;
            creators_by_item.entry(item_id).or_default().push(creator);
        }
    }

    let mut tags_by_item = BTreeMap::<String, Vec<LibraryTag>>::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT library_item_tags.item_id, library_tags.id, library_tags.name,
                        library_tags.kind, library_tags.tag_type, library_tags.color
                 FROM library_item_tags
                 JOIN library_tags ON library_tags.id = library_item_tags.tag_id
                 ORDER BY library_item_tags.item_id, library_item_tags.created_at,
                          library_tags.name COLLATE NOCASE, library_tags.id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    LibraryTag {
                        id: row.get(1)?,
                        name: row.get(2)?,
                        kind: row.get(3)?,
                        tag_type: row.get::<_, i64>(4)?.try_into().unwrap_or_default(),
                        color: row.get(5)?,
                    },
                ))
            })
            .map_err(to_error)?;
        for row in rows {
            let (item_id, tag) = row.map_err(to_error)?;
            tags_by_item.entry(item_id).or_default().push(tag);
        }
    }

    let mut collection_ids_by_item = BTreeMap::<String, Vec<String>>::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT item_id, collection_id FROM library_collection_items
                 ORDER BY item_id, order_index, collection_id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(to_error)?;
        for row in rows {
            let (item_id, collection_id): (String, String) = row.map_err(to_error)?;
            collection_ids_by_item
                .entry(item_id)
                .or_default()
                .push(collection_id);
        }
    }

    let mut generic_relations_by_item = BTreeMap::<String, Vec<LibraryItemRelation>>::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT source_item_id, id, predicate, target, target_kind, created_at
                 FROM library_item_relations
                 ORDER BY source_item_id, predicate, target_kind, target, id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                let item_id: String = row.get(0)?;
                Ok((
                    item_id,
                    LibraryItemRelation {
                        id: row.get(1)?,
                        source_item_id: row.get(0)?,
                        predicate: row.get(2)?,
                        target: row.get(3)?,
                        target_kind: row.get(4)?,
                        created_at: row.get(5)?,
                    },
                ))
            })
            .map_err(to_error)?;
        for row in rows {
            let (item_id, relation) = row.map_err(to_error)?;
            generic_relations_by_item
                .entry(item_id)
                .or_default()
                .push(relation);
        }
    }

    let mut full_text_by_item = BTreeMap::<String, LibraryFullTextStatus>::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT item_id, indexed_pages, total_pages, indexed_chars, total_chars,
                        version, text_hash, status, updated_at
                 FROM library_fulltext_items",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(LibraryFullTextStatus {
                    item_id: row.get(0)?,
                    indexed_pages: row
                        .get::<_, Option<i64>>(1)?
                        .and_then(|value| u32::try_from(value).ok()),
                    total_pages: row
                        .get::<_, Option<i64>>(2)?
                        .and_then(|value| u32::try_from(value).ok()),
                    indexed_chars: row
                        .get::<_, Option<i64>>(3)?
                        .and_then(|value| u64::try_from(value).ok()),
                    total_chars: row
                        .get::<_, Option<i64>>(4)?
                        .and_then(|value| u64::try_from(value).ok()),
                    version: row.get(5)?,
                    text_hash: row.get(6)?,
                    status: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(to_error)?;
        for row in rows {
            let status = row.map_err(to_error)?;
            full_text_by_item.insert(status.item_id.clone(), status);
        }
    }

    let attachment_source_payloads =
        load_library_child_source_payloads(connection, "attachment")?;
    let note_source_payloads = load_library_child_source_payloads(connection, "note")?;
    let annotation_source_payloads =
        load_library_child_source_payloads(connection, "annotation")?;

    let mut snapshots = Vec::with_capacity(items.len());
    for item in items {
        let item_id = item.id.clone();
        let source_payload = match item.item_type.as_str() {
            "attachment" => attachment_source_payloads.get(&item_id).cloned(),
            "note" => note_source_payloads.get(&item_id).cloned(),
            "annotation" => annotation_source_payloads.get(&item_id).cloned(),
            _ => None,
        };
        snapshots.push(LibraryItemSnapshot {
            item,
            fields: fields_by_item.remove(&item_id).unwrap_or_default(),
            creators: creators_by_item.remove(&item_id).unwrap_or_default(),
            tags: tags_by_item.remove(&item_id).unwrap_or_default(),
            collection_ids: collection_ids_by_item
                .remove(&item_id)
                .unwrap_or_default(),
            relations: generic_relations_by_item
                .remove(&item_id)
                .unwrap_or_default(),
            source_payload,
            full_text: full_text_by_item.remove(&item_id),
        });
    }
    Ok(snapshots)
}

fn load_library_saved_searches(
    connection: &Connection,
) -> Result<Vec<LibrarySavedSearch>, String> {
    let rows = {
        let mut statement = connection
            .prepare(
                "SELECT id, name, query, sources, dynamic, version, created_at, updated_at
                 FROM library_saved_searches WHERE deleted = 0
                 ORDER BY updated_at DESC, id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                let sources: Vec<String> = decode_payload(&row.get::<_, String>(3)?).map_err(
                    |error| {
                        rusqlite::Error::ToSqlConversionFailure(Box::new(
                            std::io::Error::other(error),
                        ))
                    },
                )?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    sources,
                    sql_to_bool(row.get(4)?),
                    row.get::<_, u64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    rows.into_iter()
        .map(|(id, name, query, sources, dynamic, version, created_at, updated_at)| {
            let mut statement = connection
                .prepare(
                    "SELECT id, condition_index, field, operator, value, joiner
                     FROM library_saved_search_conditions
                     WHERE saved_search_id = ?1 ORDER BY condition_index",
                )
                .map_err(to_error)?;
            let rows = statement
                .query_map([&id], |row| {
                    Ok(LibrarySearchCondition {
                        id: row.get(0)?,
                        condition_index: row
                            .get::<_, i64>(1)?
                            .try_into()
                            .unwrap_or_default(),
                        field: row.get(2)?,
                        operator: row.get(3)?,
                        value: row.get(4)?,
                        joiner: row.get(5)?,
                    })
                })
                .map_err(to_error)?;
            let conditions = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(to_error)?;
            Ok(LibrarySavedSearch {
                id,
                name,
                query,
                sources,
                dynamic,
                version,
                conditions,
                created_at,
                updated_at,
            })
        })
        .collect()
}

fn load_library_special_collections(
    connection: &Connection,
) -> Result<Vec<LibrarySpecialCollection>, String> {
    let all_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM library_items
             WHERE parent_item_id IS NULL AND deleted = 0 AND trashed = 0",
            [],
            |row| row.get(0),
        )
        .map_err(to_error)?;
    let unfiled_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM library_items AS items
             WHERE items.parent_item_id IS NULL AND items.deleted = 0
               AND items.trashed = 0
               AND NOT EXISTS (
                 SELECT 1 FROM library_collection_items AS memberships
                 WHERE memberships.item_id = items.id
               )",
            [],
            |row| row.get(0),
        )
        .map_err(to_error)?;
    let trash_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM library_items WHERE deleted = 0 AND trashed = 1",
            [],
            |row| row.get(0),
        )
        .map_err(to_error)?;
    let duplicate_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM (
               SELECT normalized_title FROM canonical_records
               GROUP BY normalized_title HAVING COUNT(*) > 1
             )",
            [],
            |row| row.get(0),
        )
        .map_err(to_error)?;
    Ok(vec![
        LibrarySpecialCollection {
            id: "special:all".to_string(),
            kind: "all".to_string(),
            label: "All Items".to_string(),
            readonly: true,
            count: u64::try_from(all_count).unwrap_or_default(),
        },
        LibrarySpecialCollection {
            id: "special:unfiled".to_string(),
            kind: "unfiled".to_string(),
            label: "Unfiled Items".to_string(),
            readonly: true,
            count: u64::try_from(unfiled_count).unwrap_or_default(),
        },
        LibrarySpecialCollection {
            id: "special:duplicates".to_string(),
            kind: "duplicates".to_string(),
            label: "Duplicate Items".to_string(),
            readonly: true,
            count: u64::try_from(duplicate_count).unwrap_or_default(),
        },
        LibrarySpecialCollection {
            id: "special:trash".to_string(),
            kind: "trash".to_string(),
            label: "Trash".to_string(),
            readonly: true,
            count: u64::try_from(trash_count).unwrap_or_default(),
        },
    ])
}

fn load_library_attachments_for_sync(
    transaction: &Transaction<'_>,
    record_id: &str,
) -> Result<Vec<LibraryAttachment>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, label, kind, path, url, external_path, mime_type, bytes,
                    link_mode, filename, charset, hash, mtime, last_page_index,
                    source_payload, added_at
             FROM library_attachments WHERE item_id = ?1 ORDER BY added_at, id",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map([record_id], |row| {
            Ok(LibraryAttachment {
                id: row.get(0)?,
                record_id: record_id.to_string(),
                label: row.get(1)?,
                kind: row.get(2)?,
                path: row.get(3)?,
                url: row.get(4)?,
                external_path: row.get(5)?,
                mime_type: row.get(6)?,
                bytes: row
                    .get::<_, Option<i64>>(7)?
                    .and_then(|value| u64::try_from(value).ok()),
                link_mode: row.get(8)?,
                filename: row.get(9)?,
                charset: row.get(10)?,
                hash: row.get(11)?,
                mtime: row.get(12)?,
                last_page_index: row
                    .get::<_, Option<i64>>(13)?
                    .and_then(|value| u32::try_from(value).ok()),
                source_payload: decode_optional_payload_for_row(row.get(14)?)?,
                added_at: row.get(15)?,
            })
        })
        .map_err(to_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(to_error)
}

fn load_library_notes_for_sync(
    transaction: &Transaction<'_>,
    record_id: &str,
) -> Result<Vec<LibraryNote>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, title, content, created_at, updated_at,
                    annotation_id, attachment_id, evidence_id, source, source_payload
             FROM library_notes WHERE item_id = ?1 ORDER BY updated_at DESC, id",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map([record_id], |row| {
            Ok(LibraryNote {
                id: row.get(0)?,
                record_id: record_id.to_string(),
                title: row.get(1)?,
                content: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                annotation_id: row.get(5)?,
                attachment_id: row.get(6)?,
                evidence_id: row.get(7)?,
                source: row.get(8)?,
                source_payload: decode_optional_payload_for_row(row.get(9)?)?,
            })
        })
        .map_err(to_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(to_error)
}

fn load_library_annotations_for_sync(
    transaction: &Transaction<'_>,
    record_id: &str,
) -> Result<Vec<LibraryAnnotation>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, attachment_id, page, page_label, quote, note, kind, color, style,
                    rects, source, image_fingerprint, source_id, evidence_id,
                    annotation_type, position, sort_index, author, is_external,
                    source_payload, created_at
             FROM library_annotations WHERE item_id = ?1
             ORDER BY page, sort_index, created_at, id",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map([record_id], |row| {
            let rects = row
                .get::<_, Option<String>>(9)?
                .map(|payload| decode_payload::<Value>(&payload))
                .transpose()
                .map_err(|error| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                        error,
                    )))
                })?;
            let position = row
                .get::<_, Option<String>>(15)?
                .map(|payload| decode_payload::<Value>(&payload))
                .transpose()
                .map_err(|error| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                        error,
                    )))
                })?;
            Ok(LibraryAnnotation {
                id: row.get(0)?,
                record_id: record_id.to_string(),
                attachment_id: row.get(1)?,
                page: row.get::<_, i64>(2)?.try_into().unwrap_or_default(),
                page_label: row.get(3)?,
                quote: row.get(4)?,
                note: row.get(5)?,
                kind: row.get(6)?,
                color: row.get(7)?,
                style: row.get(8)?,
                rects,
                source: row.get(10)?,
                image_fingerprint: row.get(11)?,
                source_id: row.get(12)?,
                evidence_id: row.get(13)?,
                annotation_type: row.get(14)?,
                position,
                sort_index: row
                    .get::<_, Option<i64>>(16)?
                    .and_then(|value| u32::try_from(value).ok()),
                author: row.get(17)?,
                is_external: sql_to_bool(row.get(18)?),
                source_payload: decode_optional_payload_for_row(row.get(19)?)?,
                created_at: row.get(20)?,
            })
        })
        .map_err(to_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(to_error)
}

fn load_library_collections(connection: &Connection) -> Result<Vec<LibraryCollection>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, label, parent_id, order_index
             FROM library_collections
             ORDER BY parent_id IS NOT NULL, parent_id, order_index, label, id",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(LibraryCollection {
                id: row.get(0)?,
                label: row.get(1)?,
                parent_id: row.get(2)?,
                order_index: row.get::<_, i64>(3)?.try_into().unwrap_or_default(),
            })
        })
        .map_err(to_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(to_error)
}

/// Materialize the relation projection with one scan per relation table.
/// The previous implementation prepared and executed six queries for every
/// canonical record, which made opening a large library effectively O(items ×
/// relation tables) at the SQLite boundary.
fn load_library_item_relations_bulk(
    connection: &Connection,
    record_ids: Vec<String>,
) -> Result<BTreeMap<String, LibraryItemRelations>, String> {
    let mut items = record_ids
        .into_iter()
        .map(|record_id| {
            let relations = LibraryItemRelations {
                record_id: record_id.clone(),
                collection_ids: Vec::new(),
                tags: Vec::new(),
                attachments: Vec::new(),
                notes: Vec::new(),
                annotations: Vec::new(),
                relations: Vec::new(),
            };
            (record_id, relations)
        })
        .collect::<BTreeMap<_, _>>();
    if items.is_empty() {
        return Ok(items);
    }

    // A whole-library projection wants every relation row, so scanning the
    // relation tables once is the cheapest plan. A search result page asks for
    // a hundred ids out of a library that may hold hundreds of thousands of
    // annotation rows, and there the scan is the whole cost — so bind the ids
    // and let SQLite use the per-item indexes instead.
    const RELATION_SCOPE_LIMIT: usize = 500;
    let scope = if items.len() <= RELATION_SCOPE_LIMIT {
        items.keys().cloned().collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let scope_clause = |column: &str| {
        if scope.is_empty() {
            String::new()
        } else {
            format!(
                " WHERE {column} IN ({})",
                vec!["?"; scope.len()].join(",")
            )
        }
    };

    let mut collection_ids = BTreeMap::<String, Vec<String>>::new();
    {
        let mut statement = connection
            .prepare(&format!(
                "SELECT item_id, collection_id
                 FROM library_collection_items{}
                 ORDER BY item_id, order_index, collection_id",
                scope_clause("item_id"),
            ))
            .map_err(to_error)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(scope.iter()), |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(to_error)?;
        for row in rows {
            let (item_id, collection_id): (String, String) = row.map_err(to_error)?;
            if items.contains_key(&item_id) {
                collection_ids
                    .entry(item_id)
                    .or_default()
                    .push(collection_id);
            }
        }
    }

    let mut tags = BTreeMap::<String, Vec<String>>::new();
    {
        let mut statement = connection
            .prepare(&format!(
                "SELECT library_item_tags.item_id, library_tags.name
                 FROM library_item_tags
                 JOIN library_tags ON library_tags.id = library_item_tags.tag_id{}
                 ORDER BY library_item_tags.item_id, library_tags.name COLLATE NOCASE,
                          library_tags.id",
                scope_clause("library_item_tags.item_id"),
            ))
            .map_err(to_error)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(scope.iter()), |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(to_error)?;
        for row in rows {
            let (item_id, tag): (String, String) = row.map_err(to_error)?;
            if items.contains_key(&item_id) {
                tags.entry(item_id).or_default().push(tag);
            }
        }
    }

    let mut attachments = BTreeMap::<String, Vec<LibraryAttachment>>::new();
    {
        let mut statement = connection
            .prepare(&format!(
                "SELECT item_id, id, label, kind, path, url, external_path, mime_type, bytes,
                        link_mode, filename, charset, hash, mtime, last_page_index,
                        source_payload, added_at
                 FROM library_attachments{}
                 ORDER BY item_id, added_at, id",
                scope_clause("item_id"),
            ))
            .map_err(to_error)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(scope.iter()), |row| {
                let record_id: String = row.get(0)?;
                let bytes = row
                    .get::<_, Option<i64>>(8)?
                    .and_then(|value| u64::try_from(value).ok());
                let attachment = LibraryAttachment {
                    id: row.get(1)?,
                    record_id: record_id.clone(),
                    label: row.get(2)?,
                    kind: row.get(3)?,
                    path: row.get(4)?,
                    url: row.get(5)?,
                    external_path: row.get(6)?,
                    mime_type: row.get(7)?,
                    bytes,
                    link_mode: row.get(9)?,
                    filename: row.get(10)?,
                    charset: row.get(11)?,
                    hash: row.get(12)?,
                    mtime: row.get(13)?,
                    last_page_index: row
                        .get::<_, Option<i64>>(14)?
                        .and_then(|value| u32::try_from(value).ok()),
                    source_payload: decode_optional_payload_for_row(row.get(15)?)?,
                    added_at: row.get(16)?,
                };
                Ok((record_id, attachment))
            })
            .map_err(to_error)?;
        for row in rows {
            let (record_id, attachment) = row.map_err(to_error)?;
            if items.contains_key(&record_id) {
                attachments
                    .entry(record_id)
                    .or_default()
                    .push(attachment);
            }
        }
    }

    let mut annotations = BTreeMap::<String, Vec<LibraryAnnotation>>::new();
    {
        let mut statement = connection
            .prepare(&format!(
                "SELECT item_id, id, attachment_id, page, page_label, quote, note, kind, color,
                        style, rects, source, image_fingerprint, source_id, evidence_id,
                        annotation_type, position, sort_index, author, is_external,
                        source_payload, created_at
                 FROM library_annotations{}
                 ORDER BY item_id, page, sort_index, created_at, id",
                scope_clause("item_id"),
            ))
            .map_err(to_error)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(scope.iter()), |row| {
                let record_id: String = row.get(0)?;
                let rects = row
                    .get::<_, Option<String>>(10)?
                    .map(|payload| decode_payload::<Value>(&payload))
                    .transpose()
                    .map_err(|error| {
                        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                            error,
                        )))
                    })?;
                let position = row
                    .get::<_, Option<String>>(16)?
                    .map(|payload| decode_payload::<Value>(&payload))
                    .transpose()
                    .map_err(|error| {
                        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                            error,
                        )))
                    })?;
                let annotation = LibraryAnnotation {
                    id: row.get(1)?,
                    record_id: record_id.clone(),
                    attachment_id: row.get(2)?,
                    page: row.get::<_, i64>(3)?.try_into().unwrap_or_default(),
                    page_label: row.get(4)?,
                    quote: row.get(5)?,
                    note: row.get(6)?,
                    kind: row.get(7)?,
                    color: row.get(8)?,
                    style: row.get(9)?,
                    rects,
                    source: row.get(11)?,
                    image_fingerprint: row.get(12)?,
                    source_id: row.get(13)?,
                    evidence_id: row.get(14)?,
                    annotation_type: row.get(15)?,
                    position,
                    sort_index: row
                        .get::<_, Option<i64>>(17)?
                        .and_then(|value| u32::try_from(value).ok()),
                    author: row.get(18)?,
                    is_external: sql_to_bool(row.get(19)?),
                    source_payload: decode_optional_payload_for_row(row.get(20)?)?,
                    created_at: row.get(21)?,
                };
                Ok((record_id, annotation))
            })
            .map_err(to_error)?;
        for row in rows {
            let (record_id, annotation) = row.map_err(to_error)?;
            if items.contains_key(&record_id) {
                annotations
                    .entry(record_id)
                    .or_default()
                    .push(annotation);
            }
        }
    }

    let mut notes = BTreeMap::<String, Vec<LibraryNote>>::new();
    {
        let mut statement = connection
            .prepare(&format!(
                "SELECT item_id, id, title, content, created_at, updated_at,
                        annotation_id, attachment_id, evidence_id, source, source_payload
                 FROM library_notes{}
                 ORDER BY item_id, updated_at DESC, id",
                scope_clause("item_id"),
            ))
            .map_err(to_error)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(scope.iter()), |row| {
                let record_id: String = row.get(0)?;
                let note = LibraryNote {
                    id: row.get(1)?,
                    record_id: record_id.clone(),
                    title: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    annotation_id: row.get(6)?,
                    attachment_id: row.get(7)?,
                    evidence_id: row.get(8)?,
                    source: row.get(9)?,
                    source_payload: decode_optional_payload_for_row(row.get(10)?)?,
                };
                Ok((record_id, note))
            })
            .map_err(to_error)?;
        for row in rows {
            let (record_id, note) = row.map_err(to_error)?;
            if items.contains_key(&record_id) {
                notes.entry(record_id).or_default().push(note);
            }
        }
    }

    let mut relations = BTreeMap::<String, Vec<LibraryItemRelation>>::new();
    {
        let mut statement = connection
            .prepare(&format!(
                "SELECT source_item_id, id, predicate, target, target_kind, created_at
                 FROM library_item_relations{}
                 ORDER BY source_item_id, predicate, target_kind, target, id",
                scope_clause("source_item_id"),
            ))
            .map_err(to_error)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(scope.iter()), |row| {
                let record_id: String = row.get(0)?;
                Ok((
                    record_id,
                    LibraryItemRelation {
                        id: row.get(1)?,
                        source_item_id: row.get(0)?,
                        predicate: row.get(2)?,
                        target: row.get(3)?,
                        target_kind: row.get(4)?,
                        created_at: row.get(5)?,
                    },
                ))
            })
            .map_err(to_error)?;
        for row in rows {
            let (record_id, relation) = row.map_err(to_error)?;
            if items.contains_key(&record_id) {
                relations.entry(record_id).or_default().push(relation);
            }
        }
    }

    for (record_id, item) in &mut items {
        item.collection_ids = collection_ids.remove(record_id).unwrap_or_default();
        item.tags = tags.remove(record_id).unwrap_or_default();
        item.attachments = attachments.remove(record_id).unwrap_or_default();
        item.notes = notes.remove(record_id).unwrap_or_default();
        item.annotations = annotations.remove(record_id).unwrap_or_default();
        item.relations = relations.remove(record_id).unwrap_or_default();
    }
    Ok(items)
}

fn load_library_item_relations(
    connection: &Connection,
    record_id: &str,
) -> Result<LibraryItemRelations, String> {
    let collection_ids = {
        let mut statement = connection
            .prepare(
                "SELECT collection_id FROM library_collection_items
                 WHERE item_id = ?1 ORDER BY order_index, collection_id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([record_id], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    let tags = {
        let mut statement = connection
            .prepare(
                "SELECT tags.name FROM library_item_tags
                 JOIN library_tags AS tags ON tags.id = library_item_tags.tag_id
                 WHERE library_item_tags.item_id = ?1
                 ORDER BY tags.name COLLATE NOCASE, tags.id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([record_id], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    let attachments = {
        let mut statement = connection
            .prepare(
                "SELECT id, label, kind, path, url, external_path, mime_type, bytes,
                        link_mode, filename, charset, hash, mtime, last_page_index,
                        source_payload, added_at
                 FROM library_attachments WHERE item_id = ?1
                 ORDER BY added_at, id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([record_id], |row| {
                let bytes = row
                    .get::<_, Option<i64>>(7)?
                    .and_then(|value| u64::try_from(value).ok());
                Ok(LibraryAttachment {
                    id: row.get(0)?,
                    record_id: record_id.to_string(),
                    label: row.get(1)?,
                    kind: row.get(2)?,
                    path: row.get(3)?,
                    url: row.get(4)?,
                    external_path: row.get(5)?,
                    mime_type: row.get(6)?,
                    bytes,
                    link_mode: row.get(8)?,
                    filename: row.get(9)?,
                    charset: row.get(10)?,
                    hash: row.get(11)?,
                    mtime: row.get(12)?,
                    last_page_index: row
                        .get::<_, Option<i64>>(13)?
                        .and_then(|value| u32::try_from(value).ok()),
                    source_payload: decode_optional_payload_for_row(row.get(14)?)?,
                    added_at: row.get(15)?,
                })
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    let annotations = {
        let mut statement = connection
            .prepare(
                "SELECT id, attachment_id, page, page_label, quote, note, kind, color, style,
                        rects, source, image_fingerprint, source_id, evidence_id,
                        annotation_type, position, sort_index, author, is_external,
                        source_payload, created_at
                 FROM library_annotations WHERE item_id = ?1
                 ORDER BY page, sort_index, created_at, id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([record_id], |row| {
                let rects = row
                    .get::<_, Option<String>>(9)?
                    .map(|payload| decode_payload::<Value>(&payload))
                    .transpose()
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(
                        Box::new(std::io::Error::other(error)),
                    ))?;
                Ok(LibraryAnnotation {
                    id: row.get(0)?,
                    record_id: record_id.to_string(),
                    attachment_id: row.get(1)?,
                    page: row.get::<_, i64>(2)?.try_into().unwrap_or_default(),
                    page_label: row.get(3)?,
                    quote: row.get(4)?,
                    note: row.get(5)?,
                    kind: row.get(6)?,
                    color: row.get(7)?,
                    style: row.get(8)?,
                    rects,
                    source: row.get(10)?,
                    image_fingerprint: row.get(11)?,
                    source_id: row.get(12)?,
                    evidence_id: row.get(13)?,
                    annotation_type: row.get(14)?,
                    position: row
                        .get::<_, Option<String>>(15)?
                        .map(|payload| decode_payload::<Value>(&payload))
                        .transpose()
                        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(
                            Box::new(std::io::Error::other(error)),
                        ))?,
                    sort_index: row
                        .get::<_, Option<i64>>(16)?
                        .and_then(|value| u32::try_from(value).ok()),
                    author: row.get(17)?,
                    is_external: sql_to_bool(row.get(18)?),
                    source_payload: decode_optional_payload_for_row(row.get(19)?)?,
                    created_at: row.get(20)?,
                })
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    let notes = {
        let mut statement = connection
            .prepare(
                "SELECT id, title, content, created_at, updated_at,
                        annotation_id, attachment_id, evidence_id, source, source_payload
                 FROM library_notes WHERE item_id = ?1
                 ORDER BY updated_at DESC, id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([record_id], |row| {
                Ok(LibraryNote {
                    id: row.get(0)?,
                    record_id: record_id.to_string(),
                    title: row.get(1)?,
                    content: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    annotation_id: row.get(5)?,
                    attachment_id: row.get(6)?,
                    evidence_id: row.get(7)?,
                    source: row.get(8)?,
                    source_payload: decode_optional_payload_for_row(row.get(9)?)?,
                })
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    Ok(LibraryItemRelations {
        record_id: record_id.to_string(),
        collection_ids,
        tags,
        attachments,
        notes,
        annotations,
        relations: load_library_item_relations_generic(connection, record_id)?,
    })
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(to_error)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(to_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_error)?;
    if !columns.iter().any(|current| current == column) {
        connection
            .execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(to_error)?;
    }
    Ok(())
}

fn insert_protocol(transaction: &Transaction<'_>, protocol: &SearchProtocol) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO search_protocols(id, revision, created_at, updated_at, payload)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                protocol.id,
                protocol.revision,
                protocol.created_at,
                protocol.updated_at,
                encode_payload(protocol)?,
            ],
        )
        .map_err(to_error)?;
    Ok(())
}

fn insert_run(transaction: &Transaction<'_>, run: &SearchRun) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO search_runs(id, protocol_id, protocol_revision, status, started_at, completed_at, revision, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                run.id,
                run.protocol_id,
                run.protocol_revision,
                run_status_name(run.status),
                run.started_at,
                run.completed_at,
                run.revision,
                encode_payload(run)?,
            ],
        )
        .map_err(to_error)?;
    Ok(())
}

fn insert_canonical_record(
    transaction: &Transaction<'_>,
    record: &CanonicalRecord,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO canonical_records(
                id, normalized_title, doi, arxiv_id, scopus_id, revision, payload, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                record.id,
                record.normalized_title,
                record.identifiers.doi,
                record.identifiers.arxiv_id,
                record.identifiers.scopus_id,
                record.revision,
                encode_payload(record)?,
                record.created_at,
                record.updated_at,
            ],
    )
    .map_err(to_error)?;
    upsert_full_text_index(transaction, record)?;
    sync_library_item_model_in_transaction(transaction, record, None, false)?;
    Ok(())
}

fn upsert_full_text_index(
    transaction: &Transaction<'_>,
    record: &CanonicalRecord,
) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM literature_full_text WHERE record_id = ?1",
            [&record.id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "INSERT INTO literature_full_text(record_id, title, body) VALUES (?1, ?2, ?3)",
            params![record.id, record.title, full_text_body(record)],
        )
        .map_err(to_error)?;
    Ok(())
}

fn full_text_body(record: &CanonicalRecord) -> String {
    let metadata = serde_json::to_string(&record.metadata).unwrap_or_default();
    format!(
        "{}\n{}\n{}",
        record.authors.join(" "),
        record.abstract_text,
        metadata
    )
}

fn rebuild_full_text_index(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("SELECT payload FROM canonical_records")
        .map_err(to_error)?;
    let records = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(to_error)?
        .map(|row| {
            row.map_err(to_error)
                .and_then(|payload| decode_payload::<CanonicalRecord>(&payload))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let transaction = connection.unchecked_transaction().map_err(to_error)?;
    transaction
        .execute("DELETE FROM literature_full_text", [])
        .map_err(to_error)?;
    for record in &records {
        upsert_full_text_index(&transaction, record)?;
    }
    transaction.commit().map_err(to_error)
}

fn fts_expression(query: &str) -> String {
    fts_terms(query)
        .into_iter()
        .map(|term| format!("\"{term}\""))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn fts_or_prefix_expression(query: &str) -> String {
    fts_terms(query)
        .into_iter()
        .map(|term| format!("\"{term}\"*"))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn fts_terms(query: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(str::to_lowercase)
        .filter(|term| seen.insert(term.clone()))
        .collect::<Vec<_>>()
}

fn collect_fts_scores(
    connection: &Connection,
    expression: &str,
    strategy_penalty: f64,
    scores: &mut BTreeMap<String, f64>,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT record_id, bm25(literature_full_text) AS score
             FROM literature_full_text
             WHERE literature_full_text MATCH ?1
             ORDER BY score ASC, record_id ASC",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map([expression], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })
        .map_err(to_error)?;
    for row in rows {
        let (record_id, score) = row.map_err(to_error)?;
        let adjusted = score + strategy_penalty;
        scores
            .entry(record_id)
            .and_modify(|current| *current = current.min(adjusted))
            .or_insert(adjusted);
    }

    // Text extracted from HTML/EPUB/TXT and from linked supplements lives in
    // the attachment FTS table. Join child attachment items back to their
    // canonical parent so every local resource participates in the same ranked
    // search result instead of returning an attachment-only id.
    let mut attachment_statement = connection
        .prepare(
            "SELECT COALESCE(child.parent_item_id, library_attachment_full_text.item_id),
                    bm25(library_attachment_full_text) AS score
             FROM library_attachment_full_text
             LEFT JOIN library_items AS child ON child.id = library_attachment_full_text.item_id
             JOIN canonical_records AS record
               ON record.id = COALESCE(child.parent_item_id, library_attachment_full_text.item_id)
             WHERE library_attachment_full_text MATCH ?1
               AND (child.id IS NULL OR (child.deleted = 0 AND child.trashed = 0))
             ORDER BY score ASC, 1 ASC",
        )
        .map_err(to_error)?;
    let attachment_rows = attachment_statement
        .query_map([expression], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })
        .map_err(to_error)?;
    for row in attachment_rows {
        let (record_id, score) = row.map_err(to_error)?;
        let adjusted = score + strategy_penalty;
        scores
            .entry(record_id)
            .and_modify(|current| *current = current.min(adjusted))
            .or_insert(adjusted);
    }
    Ok(())
}

fn fuzzy_fts_expression(connection: &Connection, query_terms: &[String]) -> Result<String, String> {
    const VOCABULARY_CANDIDATE_LIMIT: usize = 4_096;
    const SPELLINGS_PER_TERM: usize = 8;

    let mut spellings = BTreeSet::new();
    for query_term in query_terms {
        let query_len = query_term.chars().count();
        if query_len < 2 {
            continue;
        }
        let min_len = query_len.saturating_sub(1);
        let max_len = query_len.saturating_add(1);
        let mut statement = connection
            .prepare(
                "SELECT term, doc
                 FROM literature_full_text_vocab
                 WHERE length(term) BETWEEN ?1 AND ?2
                 ORDER BY doc DESC, term ASC
                 LIMIT ?3",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map(
                params![
                    i64::try_from(min_len).unwrap_or(i64::MAX),
                    i64::try_from(max_len).unwrap_or(i64::MAX),
                    i64::try_from(VOCABULARY_CANDIDATE_LIMIT).unwrap_or(i64::MAX),
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)),
            )
            .map_err(to_error)?;
        let mut matches = Vec::new();
        for row in rows {
            let (candidate, document_count) = row.map_err(to_error)?;
            if candidate == *query_term {
                continue;
            }
            let distance = if query_term.chars().any(is_cjk_character) {
                let query_bigrams = character_bigrams(query_term);
                let candidate_bigrams = character_bigrams(&candidate);
                let overlap = query_bigrams
                    .iter()
                    .filter(|gram| candidate_bigrams.contains(*gram))
                    .count();
                if !query_bigrams.is_empty() && overlap.saturating_mul(2) >= query_bigrams.len() {
                    query_bigrams.len().saturating_sub(overlap)
                } else {
                    continue;
                }
            } else if query_len >= 4 {
                let distance = levenshtein_distance_at_most_one(query_term, &candidate);
                if distance > 1 {
                    continue;
                }
                distance
            } else {
                continue;
            };
            matches.push((distance, std::cmp::Reverse(document_count), candidate));
        }
        matches.sort();
        for (_, _, candidate) in matches.into_iter().take(SPELLINGS_PER_TERM) {
            spellings.insert(candidate);
        }
    }
    Ok(spellings
        .into_iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR "))
}

fn is_cjk_character(character: char) -> bool {
    matches!(
        character as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF
    )
}

fn character_bigrams(value: &str) -> BTreeSet<String> {
    let characters = value.chars().collect::<Vec<_>>();
    characters
        .windows(2)
        .map(|pair| pair.iter().collect::<String>())
        .collect()
}

fn levenshtein_distance_at_most_one(left: &str, right: &str) -> usize {
    if left == right {
        return 0;
    }
    let left = left.chars().collect::<Vec<_>>();
    let right = right.chars().collect::<Vec<_>>();
    if left.len().abs_diff(right.len()) > 1 {
        return 2;
    }
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    for (left_index, left_character) in left.iter().enumerate() {
        let mut current = vec![left_index + 1; right.len() + 1];
        for (right_index, right_character) in right.iter().enumerate() {
            current[right_index + 1] = (previous[right_index + 1] + 1)
                .min(current[right_index] + 1)
                .min(previous[right_index] + usize::from(left_character != right_character));
        }
        if current.iter().copied().min().unwrap_or(2) > 1 {
            return 2;
        }
        previous = current;
    }
    previous[right.len()].min(2)
}

fn resolve_equivalent_records(
    transaction: &Transaction<'_>,
    incoming: &CanonicalRecord,
) -> Result<Vec<CanonicalRecord>, String> {
    let mut records = BTreeMap::new();
    let doi = incoming
        .identifiers
        .doi
        .as_deref()
        .map(|value| value.to_ascii_lowercase());
    let arxiv_id = incoming
        .identifiers
        .arxiv_id
        .as_deref()
        .map(|value| value.to_ascii_lowercase());
    let scopus_id = incoming
        .identifiers
        .scopus_id
        .as_deref()
        .map(|value| value.to_ascii_lowercase());
    let mut statement = transaction
        .prepare(
            "SELECT payload FROM canonical_records
             WHERE (?1 IS NOT NULL AND lower(doi) = ?1)
                OR (?2 IS NOT NULL AND lower(arxiv_id) = ?2)
                OR (?3 IS NOT NULL AND lower(scopus_id) = ?3)
                OR normalized_title = ?4",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map(
            params![doi, arxiv_id, scopus_id, incoming.normalized_title],
            |row| row.get::<_, String>(0),
        )
        .map_err(to_error)?;
    for row in rows {
        let record = decode_payload::<CanonicalRecord>(&row.map_err(to_error)?)?;
        records.insert(record.id.clone(), record);
    }
    for alias in record_identity_aliases(incoming) {
        let record_id = transaction
            .query_row(
                "SELECT record_id FROM canonical_record_aliases WHERE alias = ?1",
                [&alias],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(to_error)?;
        let Some(record_id) = record_id else {
            continue;
        };
        let payload = transaction
            .query_row(
                "SELECT payload FROM canonical_records WHERE id = ?1",
                [&record_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(to_error)?;
        if let Some(payload) = payload {
            let record = decode_payload::<CanonicalRecord>(&payload)?;
            records.insert(record.id.clone(), record);
        }
    }
    records.retain(|_, candidate| records_are_equivalent(candidate, incoming));
    Ok(records.into_values().collect())
}

/// DOI, arXiv and Scopus identifiers are strong identity signals. An exact
/// strong-id match remains authoritative even when a provider supplies a
/// conflicting secondary identifier. A title-only match, however, is unsafe
/// when both records supply different values for the same strong identifier:
/// common editorial titles are not a work identity.
fn records_are_equivalent(existing: &CanonicalRecord, incoming: &CanonicalRecord) -> bool {
    if shares_strong_identifier(existing, incoming) {
        return true;
    }
    if existing.normalized_title != incoming.normalized_title {
        // A non-title alias can represent a prior, explicitly resolved record
        // identity. Preserve that historical resolution rather than requiring
        // its display title to remain unchanged forever.
        return true;
    }
    !has_conflicting_strong_identifier(existing, incoming)
}

fn shares_strong_identifier(left: &CanonicalRecord, right: &CanonicalRecord) -> bool {
    same_identifier(
        left.identifiers.doi.as_deref(),
        right.identifiers.doi.as_deref(),
    ) || same_identifier(
        left.identifiers.arxiv_id.as_deref(),
        right.identifiers.arxiv_id.as_deref(),
    ) || same_identifier(
        left.identifiers.scopus_id.as_deref(),
        right.identifiers.scopus_id.as_deref(),
    )
}

fn has_conflicting_strong_identifier(left: &CanonicalRecord, right: &CanonicalRecord) -> bool {
    conflicting_identifier(
        left.identifiers.doi.as_deref(),
        right.identifiers.doi.as_deref(),
    ) || conflicting_identifier(
        left.identifiers.arxiv_id.as_deref(),
        right.identifiers.arxiv_id.as_deref(),
    ) || conflicting_identifier(
        left.identifiers.scopus_id.as_deref(),
        right.identifiers.scopus_id.as_deref(),
    )
}

fn same_identifier(left: Option<&str>, right: Option<&str>) -> bool {
    let (Some(left), Some(right)) = (normalized_identifier(left), normalized_identifier(right))
    else {
        return false;
    };
    left == right
}

fn conflicting_identifier(left: Option<&str>, right: Option<&str>) -> bool {
    let (Some(left), Some(right)) = (normalized_identifier(left), normalized_identifier(right))
    else {
        return false;
    };
    left != right
}

fn normalized_identifier(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

fn record_identity_aliases(record: &CanonicalRecord) -> BTreeSet<String> {
    let mut aliases = BTreeSet::new();
    aliases.insert(format!("record:{}", record.id));
    if let Some(doi) = record
        .identifiers
        .doi
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let doi = doi.trim().to_ascii_lowercase();
        // arXiv registers its DataCite DOI as `10.48550/arXiv.<id>`, and every
        // index reports its own capitalisation of it. The same preprint reached
        // through Crossref (DOI only) and through arXiv (id only) is one record,
        // so the DOI form has to resolve to the arXiv alias as well.
        if let Some(arxiv_id) = doi.strip_prefix("10.48550/arxiv.") {
            aliases.insert(format!("arxiv:{}", strip_arxiv_version(arxiv_id)));
        }
        aliases.insert(format!("doi:{doi}"));
    }
    if let Some(arxiv_id) = record
        .identifiers
        .arxiv_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        aliases.insert(format!(
            "arxiv:{}",
            strip_arxiv_version(&arxiv_id.trim().to_ascii_lowercase())
        ));
    }
    if let Some(scopus_id) = record
        .identifiers
        .scopus_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        aliases.insert(format!("scopus:{}", scopus_id.trim().to_ascii_lowercase()));
    }
    if !record.normalized_title.trim().is_empty() {
        aliases.insert(format!("title:{}", record.normalized_title));
    }
    aliases
}

fn upsert_record_aliases(
    transaction: &Transaction<'_>,
    record: &CanonicalRecord,
    canonical_record_id: &str,
) -> Result<(), String> {
    for alias in record_identity_aliases(record) {
        if let Some(title) = alias.strip_prefix("title:") {
            // A one-to-many title collision cannot be represented truthfully
            // in the unique alias table. Direct title lookup remains available
            // to the resolver, so remove the ambiguous shortcut rather than
            // letting the last writer silently claim the title.
            let collision = transaction
                .query_row(
                    "SELECT 1 FROM canonical_records
                     WHERE normalized_title = ?1 AND id != ?2 LIMIT 1",
                    params![title, canonical_record_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(to_error)?;
            if collision.is_some() {
                transaction
                    .execute(
                        "DELETE FROM canonical_record_aliases WHERE alias = ?1",
                        [&alias],
                    )
                    .map_err(to_error)?;
                continue;
            }
        }
        transaction
            .execute(
                "INSERT INTO canonical_record_aliases(alias, record_id) VALUES (?1, ?2)
                 ON CONFLICT(alias) DO UPDATE SET record_id = excluded.record_id",
                params![alias, canonical_record_id],
            )
            .map_err(to_error)?;
    }
    Ok(())
}

fn canonical_record_precedence(
    left: &CanonicalRecord,
    right: &CanonicalRecord,
) -> std::cmp::Ordering {
    fn rank(record: &CanonicalRecord) -> u8 {
        if record.identifiers.doi.is_some() {
            0
        } else if record.identifiers.arxiv_id.is_some() {
            1
        } else if record.identifiers.scopus_id.is_some() {
            2
        } else {
            3
        }
    }
    rank(left)
        .cmp(&rank(right))
        .then_with(|| left.id.cmp(&right.id))
}

/// The identifier columns of one `canonical_records` row. Duplicate detection
/// reads these instead of the payload, so it never decodes a record it is not
/// going to report.
struct DuplicateCandidateRow {
    id: String,
    normalized_title: String,
    doi: Option<String>,
    arxiv_id: Option<String>,
    scopus_id: Option<String>,
}

/// Same ordering as [`canonical_record_precedence`], expressed over the
/// identifier columns rather than the decoded payload.
fn duplicate_candidate_precedence(
    left: &DuplicateCandidateRow,
    right: &DuplicateCandidateRow,
) -> std::cmp::Ordering {
    fn rank(row: &DuplicateCandidateRow) -> u8 {
        if row.doi.is_some() {
            0
        } else if row.arxiv_id.is_some() {
            1
        } else if row.scopus_id.is_some() {
            2
        } else {
            3
        }
    }
    rank(left)
        .cmp(&rank(right))
        .then_with(|| left.id.cmp(&right.id))
}

fn remap_record_references(
    transaction: &Transaction<'_>,
    old_record_id: &str,
    canonical_record_id: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "UPDATE canonical_record_aliases SET record_id = ?2 WHERE record_id = ?1",
            params![old_record_id, canonical_record_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO library_collection_items(
               item_id, collection_id, order_index, created_at
             )
             SELECT ?2, collection_id, order_index, created_at
             FROM library_collection_items WHERE item_id = ?1",
            params![old_record_id, canonical_record_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "DELETE FROM library_collection_items WHERE item_id = ?1",
            [old_record_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO library_item_tags(item_id, tag_id, origin, created_at)
             SELECT ?2, tag_id, origin, created_at
             FROM library_item_tags WHERE item_id = ?1",
            params![old_record_id, canonical_record_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "DELETE FROM library_item_tags WHERE item_id = ?1",
            [old_record_id],
        )
        .map_err(to_error)?;
    for table in ["library_notes", "library_annotations", "library_attachments"] {
        transaction
            .execute(
                &format!(
                    "DELETE FROM {table}
                     WHERE item_id = ?1
                       AND id IN (SELECT id FROM {table} WHERE item_id = ?2)"
                ),
                params![old_record_id, canonical_record_id],
            )
            .map_err(to_error)?;
    }
    for table in ["library_attachments", "library_annotations", "library_notes"] {
        transaction
            .execute(
                &format!("UPDATE {table} SET item_id = ?2 WHERE item_id = ?1"),
                params![old_record_id, canonical_record_id],
            )
            .map_err(to_error)?;
    }
    remap_library_item_model(transaction, old_record_id, canonical_record_id)?;
    remap_screen_decisions(transaction, old_record_id, canonical_record_id)?;
    remap_evidence_cards(transaction, old_record_id, canonical_record_id)?;
    remap_run_record_ids(transaction, old_record_id, canonical_record_id)
}

fn remap_library_item_model(
    transaction: &Transaction<'_>,
    old_item_id: &str,
    canonical_item_id: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT OR IGNORE INTO library_item_data(item_id, field, value)
             SELECT ?2, field, value FROM library_item_data WHERE item_id = ?1",
            params![old_item_id, canonical_item_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "DELETE FROM library_item_data WHERE item_id = ?1",
            [old_item_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO library_item_creators(
               item_id, creator_id, creator_type, order_index
             )
             SELECT ?2, creator_id, creator_type, order_index
             FROM library_item_creators WHERE item_id = ?1",
            params![old_item_id, canonical_item_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "DELETE FROM library_item_creators WHERE item_id = ?1",
            [old_item_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO library_item_relations(
               id, source_item_id, predicate, target, target_kind, created_at
             )
             SELECT id, ?2, predicate, target, target_kind, created_at
             FROM library_item_relations WHERE source_item_id = ?1",
            params![old_item_id, canonical_item_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "DELETE FROM library_item_relations WHERE source_item_id = ?1",
            [old_item_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "UPDATE library_item_relations SET target = ?2
             WHERE target = ?1 AND target_kind = 'item'",
            params![old_item_id, canonical_item_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "UPDATE library_items SET parent_item_id = ?2
             WHERE parent_item_id = ?1",
            params![old_item_id, canonical_item_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "DELETE FROM library_items WHERE id = ?1",
            [old_item_id],
        )
        .map_err(to_error)?;
    Ok(())
}

fn sync_library_attachment_full_text_in_transaction(
    transaction: &Transaction<'_>,
    record_id: &str,
    attachment_id: Option<&str>,
    text: &str,
) -> Result<(), String> {
    let item_id = if let Some(attachment_id) = attachment_id {
        transaction
            .query_row(
                "SELECT id FROM library_attachments
                 WHERE item_id = ?1 AND id = ?2",
                params![record_id, attachment_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(to_error)?
            .ok_or_else(|| {
                format!("unknown attachment {attachment_id} for canonical record {record_id}")
            })?
    } else {
        transaction
            .query_row(
                "SELECT id FROM library_attachments
                 WHERE item_id = ?1 AND kind = 'pdf'
                 ORDER BY added_at, id LIMIT 1",
                [record_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(to_error)?
            .unwrap_or_else(|| record_id.to_string())
    };
    let item_exists = transaction
        .query_row(
            "SELECT 1 FROM library_items WHERE id = ?1",
            [&item_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(to_error)?
        .is_some();
    if !item_exists {
        return Ok(());
    }
    let text_hash = sha256_hex(text.as_bytes());
    transaction
        .execute(
            "DELETE FROM library_attachment_full_text WHERE item_id = ?1",
            [&item_id],
        )
        .map_err(to_error)?;
    transaction
        .execute(
            "INSERT INTO library_attachment_full_text(item_id, content)
             VALUES (?1, ?2)",
            params![item_id, text],
        )
        .map_err(to_error)?;
    let existing_version = transaction
        .query_row(
            "SELECT version FROM library_fulltext_items WHERE item_id = ?1",
            [&item_id],
            |row| row.get::<_, u64>(0),
        )
        .optional()
        .map_err(to_error)?
        .unwrap_or(0)
        .saturating_add(1);
    let character_count = i64::try_from(text.chars().count()).unwrap_or(i64::MAX);
    transaction
        .execute(
            "INSERT INTO library_fulltext_items(
               item_id, indexed_pages, total_pages, indexed_chars, total_chars,
               version, text_hash, status, updated_at
             ) VALUES (?1, NULL, NULL, ?2, ?2, ?3, ?4, 'indexed', ?5)
             ON CONFLICT(item_id) DO UPDATE SET
               indexed_chars = excluded.indexed_chars,
               total_chars = excluded.total_chars,
               version = excluded.version,
               text_hash = excluded.text_hash,
               status = excluded.status,
               updated_at = excluded.updated_at",
            params![item_id, character_count, existing_version, text_hash, now_iso8601()],
        )
        .map_err(to_error)?;
    Ok(())
}

fn remap_screen_decisions(
    transaction: &Transaction<'_>,
    old_record_id: &str,
    canonical_record_id: &str,
) -> Result<(), String> {
    let mut statement = transaction
        .prepare("SELECT id, payload FROM screen_decisions WHERE record_id = ?1")
        .map_err(to_error)?;
    let rows = statement
        .query_map([old_record_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(to_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_error)?;
    drop(statement);
    for (id, payload) in rows {
        let mut decision = decode_payload::<ScreenDecision>(&payload)?;
        decision.record_id = canonical_record_id.to_string();
        transaction
            .execute(
                "UPDATE screen_decisions SET record_id = ?2, payload = ?3 WHERE id = ?1",
                params![id, canonical_record_id, encode_payload(&decision)?],
            )
            .map_err(to_error)?;
    }
    Ok(())
}

fn remap_evidence_cards(
    transaction: &Transaction<'_>,
    old_record_id: &str,
    canonical_record_id: &str,
) -> Result<(), String> {
    let mut statement = transaction
        .prepare("SELECT id, payload FROM evidence_cards WHERE record_id = ?1")
        .map_err(to_error)?;
    let rows = statement
        .query_map([old_record_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(to_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_error)?;
    drop(statement);
    for (id, payload) in rows {
        let mut card = decode_payload::<EvidenceCard>(&payload)?;
        card.record_id = canonical_record_id.to_string();
        transaction
            .execute(
                "UPDATE evidence_cards SET record_id = ?2, payload = ?3 WHERE id = ?1",
                params![id, canonical_record_id, encode_payload(&card)?],
            )
            .map_err(to_error)?;
    }
    Ok(())
}

fn remap_run_record_ids(
    transaction: &Transaction<'_>,
    old_record_id: &str,
    canonical_record_id: &str,
) -> Result<(), String> {
    let mut statement = transaction
        .prepare("SELECT id, revision, payload FROM search_runs")
        .map_err(to_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(to_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_error)?;
    drop(statement);
    for (id, revision, payload) in rows {
        let mut run = decode_payload::<SearchRun>(&payload)?;
        let mut changed = false;
        for record_id in &mut run.record_ids {
            if record_id == old_record_id {
                *record_id = canonical_record_id.to_string();
                changed = true;
            }
        }
        for ranked in &mut run.ranked_records {
            if ranked.record_id == old_record_id {
                ranked.record_id = canonical_record_id.to_string();
                changed = true;
            }
        }
        if !changed {
            continue;
        }
        let mut seen = BTreeSet::new();
        run.record_ids
            .retain(|record_id| seen.insert(record_id.clone()));
        let mut merged_ranks = BTreeMap::<String, SearchRecordRank>::new();
        for ranked in run.ranked_records {
            let entry = merged_ranks
                .entry(ranked.record_id.clone())
                .or_insert_with(|| SearchRecordRank {
                    record_id: ranked.record_id.clone(),
                    source_ranks: BTreeMap::new(),
                    variant_ranks: BTreeMap::new(),
                    fused_score_micros: 0,
                    ranking_score_micros: 0,
                    ranking_signals: RankingSignals::default(),
                });
            for (source, rank) in ranked.source_ranks {
                entry
                    .source_ranks
                    .entry(source)
                    .and_modify(|current| *current = (*current).min(rank))
                    .or_insert(rank);
            }
            // Two records collapsing into one canonical record keeps the best
            // rank each query variant gave it, so a per-variant quota still
            // sees the record as belonging to every path that found it.
            for (variant, rank) in ranked.variant_ranks {
                entry
                    .variant_ranks
                    .entry(variant)
                    .and_modify(|current| *current = (*current).min(rank))
                    .or_insert(rank);
            }
            entry.fused_score_micros = entry.fused_score_micros.max(ranked.fused_score_micros);
            // Two records collapsing into one keep the better of their scores
            // and the signals that earned it, so a merge never demotes a record
            // below where either of its halves stood.
            if ranked.ranking_score_micros >= entry.ranking_score_micros {
                entry.ranking_score_micros = ranked.ranking_score_micros;
                entry.ranking_signals = ranked.ranking_signals;
            }
        }
        run.ranked_records = run
            .record_ids
            .iter()
            .filter_map(|record_id| merged_ranks.remove(record_id))
            .collect();
        run.revision = revision.saturating_add(1);
        transaction
            .execute(
                "UPDATE search_runs SET revision = ?2, payload = ?3 WHERE id = ?1 AND revision = ?4",
                params![id, run.revision, encode_payload(&run)?, revision],
            )
            .map_err(to_error)?;
    }
    Ok(())
}

fn insert_artifact(transaction: &Transaction<'_>, artifact: &RawArtifact) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO raw_artifacts(id, search_run_id, source, relative_path, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                artifact.id,
                artifact.search_run_id,
                artifact.source,
                artifact.relative_path,
                encode_payload(artifact)?,
                artifact.created_at,
            ],
        )
        .map_err(to_error)?;
    Ok(())
}

fn append_audit(
    transaction: &Transaction<'_>,
    entity_type: &str,
    entity_id: &str,
    action: &str,
    payload: &Value,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO literature_audit_log(created_at, entity_type, entity_id, action, payload)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                now_iso8601(),
                entity_type,
                entity_id,
                action,
                encode_payload(payload)?
            ],
        )
        .map_err(to_error)?;
    Ok(())
}

fn validate_protocol(draft: &SearchProtocolDraft) -> Result<(), String> {
    if draft.question.trim().is_empty() {
        return Err("search protocol question must not be empty".to_string());
    }
    let mut databases = BTreeSet::new();
    for database in &draft.databases {
        let normalized = database.trim().to_ascii_lowercase();
        if normalized.is_empty() || !databases.insert(normalized) {
            return Err("search protocol databases must be non-empty and unique".to_string());
        }
    }
    if draft
        .queries
        .iter()
        .any(|(source, query)| source.trim().is_empty() || query.trim().is_empty())
    {
        return Err("search protocol queries must have non-empty source and query".to_string());
    }
    if draft.queries.iter().any(|(source, query)| {
        source.trim().eq_ignore_ascii_case("scopus") && query.chars().any(is_cjk_character)
    }) {
        return Err(
            "Scopus queries must use English academic terms; Chinese/CJK characters are not allowed"
                .to_string(),
        );
    }
    if draft.max_results.is_some_and(|limit| limit == 0) {
        return Err("search protocol maxResults must be greater than zero".to_string());
    }
    if !draft.sort_order.trim().is_empty()
        && !matches!(
            draft.sort_order.trim().to_ascii_lowercase().as_str(),
            "relevance" | "publication_date_desc"
        )
    {
        return Err(
            "search protocol sortOrder must be relevance or publication_date_desc".to_string(),
        );
    }
    if draft.query_variants.iter().any(|(source, variants)| {
        source.trim().is_empty()
            || variants.is_empty()
            || variants.iter().any(|variant| {
                variant.kind.trim().is_empty()
                    || variant.query.trim().is_empty()
                    || variant.max_results == Some(0)
            })
    }) {
        return Err(
            "search protocol query variants require a source, kind, non-empty query, and positive maxResults when set"
                .to_string(),
        );
    }
    if let Some(limit) = draft.max_results {
        if let Some((source, requested)) =
            draft.query_variants.iter().find_map(|(source, variants)| {
                let requested = variants
                    .iter()
                    .filter_map(|variant| variant.max_results)
                    .sum::<usize>();
                (requested > limit).then_some((source, requested))
            })
        {
            return Err(format!(
                "search protocol query variant maxResults for {source} totals {requested}, exceeding source maxResults {limit}"
            ));
        }
    }
    if draft.query_variants.iter().any(|(source, variants)| {
        source.trim().eq_ignore_ascii_case("scopus")
            && variants
                .iter()
                .any(|variant| variant.query.chars().any(is_cjk_character))
    }) {
        return Err(
            "Scopus query variants must use English academic terms; Chinese/CJK characters are not allowed"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_record(record: &CanonicalRecord) -> Result<(), String> {
    if record.id.trim().is_empty()
        || record.title.trim().is_empty()
        || record.normalized_title.trim().is_empty()
    {
        return Err("canonical records require id, title, and normalized title".to_string());
    }
    Ok(())
}

fn merge_record_observation(existing: &mut CanonicalRecord, incoming: &CanonicalRecord) -> bool {
    let mut changed = false;
    let existing_authors = json!(existing.authors);
    let incoming_authors = json!(incoming.authors);
    let existing_year = json!(existing.year);
    let incoming_year = json!(incoming.year);
    let existing_venue = json!(existing.venue);
    let incoming_venue = json!(incoming.venue);
    let existing_abstract = json!(existing.abstract_text);
    let incoming_abstract = json!(incoming.abstract_text);
    let existing_url = json!(existing.url);
    let incoming_url = json!(incoming.url);
    let existing_pdf_url = json!(existing.pdf_url);
    let incoming_pdf_url = json!(incoming.pdf_url);
    let existing_doi = json!(existing.identifiers.doi);
    let incoming_doi = json!(incoming.identifiers.doi);
    let existing_arxiv_id = json!(existing.identifiers.arxiv_id);
    let incoming_arxiv_id = json!(incoming.identifiers.arxiv_id);
    let existing_scopus_id = json!(existing.identifiers.scopus_id);
    let incoming_scopus_id = json!(incoming.identifiers.scopus_id);
    record_conflict_if_different(
        existing,
        incoming,
        "authors",
        &existing_authors,
        &incoming_authors,
        !existing.authors.is_empty() && !incoming.authors.is_empty(),
    );
    record_conflict_if_different(
        existing,
        incoming,
        "year",
        &existing_year,
        &incoming_year,
        existing.year.is_some() && incoming.year.is_some(),
    );
    record_conflict_if_different(
        existing,
        incoming,
        "venue",
        &existing_venue,
        &incoming_venue,
        !existing.venue.trim().is_empty() && !incoming.venue.trim().is_empty(),
    );
    record_conflict_if_different(
        existing,
        incoming,
        "abstractText",
        &existing_abstract,
        &incoming_abstract,
        !existing.abstract_text.trim().is_empty() && !incoming.abstract_text.trim().is_empty(),
    );
    record_conflict_if_different(
        existing,
        incoming,
        "url",
        &existing_url,
        &incoming_url,
        existing.url.is_some() && incoming.url.is_some(),
    );
    record_conflict_if_different(
        existing,
        incoming,
        "pdfUrl",
        &existing_pdf_url,
        &incoming_pdf_url,
        existing.pdf_url.is_some() && incoming.pdf_url.is_some(),
    );
    record_conflict_if_different(
        existing,
        incoming,
        "identifiers.doi",
        &existing_doi,
        &incoming_doi,
        existing.identifiers.doi.is_some() && incoming.identifiers.doi.is_some(),
    );
    record_conflict_if_different(
        existing,
        incoming,
        "identifiers.arxivId",
        &existing_arxiv_id,
        &incoming_arxiv_id,
        existing.identifiers.arxiv_id.is_some() && incoming.identifiers.arxiv_id.is_some(),
    );
    record_conflict_if_different(
        existing,
        incoming,
        "identifiers.scopusId",
        &existing_scopus_id,
        &incoming_scopus_id,
        existing.identifiers.scopus_id.is_some() && incoming.identifiers.scopus_id.is_some(),
    );
    changed |= fill_option(&mut existing.identifiers.doi, &incoming.identifiers.doi);
    changed |= fill_option(
        &mut existing.identifiers.arxiv_id,
        &incoming.identifiers.arxiv_id,
    );
    changed |= fill_option(
        &mut existing.identifiers.scopus_id,
        &incoming.identifiers.scopus_id,
    );
    for (source, id) in &incoming.identifiers.source_ids {
        if let Some(existing_id) = existing.identifiers.source_ids.get(source).cloned() {
            let canonical_value = json!(existing_id);
            let observed_value = json!(id);
            record_conflict_if_different(
                existing,
                incoming,
                &format!("identifiers.sourceIds.{source}"),
                &canonical_value,
                &observed_value,
                true,
            );
        } else {
            existing
                .identifiers
                .source_ids
                .insert(source.clone(), id.clone());
            changed = true;
        }
    }
    if existing.authors.is_empty() && !incoming.authors.is_empty() {
        existing.authors = incoming.authors.clone();
        changed = true;
    }
    changed |= fill_option(&mut existing.year, &incoming.year);
    changed |= fill_string(&mut existing.venue, &incoming.venue);
    changed |= fill_string(&mut existing.abstract_text, &incoming.abstract_text);
    changed |= fill_option(&mut existing.url, &incoming.url);
    changed |= fill_option(&mut existing.pdf_url, &incoming.pdf_url);
    for provenance in &incoming.provenance {
        if !existing.provenance.contains(provenance) {
            existing.provenance.push(provenance.clone());
            changed = true;
        }
    }
    let mut incoming_observations = incoming.observations.clone();
    if incoming_observations.is_empty() {
        incoming_observations.push(observation_from_record(incoming));
    }
    for observation in incoming_observations {
        if !existing.observations.contains(&observation) {
            existing.observations.push(observation);
            changed = true;
        }
    }
    for conflict in &incoming.field_conflicts {
        if !existing.field_conflicts.contains(conflict) {
            existing.field_conflicts.push(conflict.clone());
            changed = true;
        }
    }
    if changed {
        existing.updated_at = now_iso8601();
    }
    changed
}

fn ensure_record_observation(record: &mut CanonicalRecord) {
    if record.observations.is_empty() {
        record.observations.push(observation_from_record(record));
    }
}

fn observation_from_record(record: &CanonicalRecord) -> RecordObservation {
    let provenance = record.provenance.first();
    RecordObservation {
        source: provenance
            .map(|item| item.source.clone())
            .unwrap_or_else(|| "unknown".to_string()),
        external_id: provenance.and_then(|item| item.external_id.clone()),
        artifact_id: provenance.and_then(|item| item.artifact_id.clone()),
        observed_at: provenance
            .map(|item| item.observed_at.clone())
            .unwrap_or_else(|| record.updated_at.clone()),
        fields: json!({
            "title": record.title,
            "authors": record.authors,
            "year": record.year,
            "venue": record.venue,
            "abstractText": record.abstract_text,
            "url": record.url,
            "pdfUrl": record.pdf_url,
            "identifiers": record.identifiers,
        }),
    }
}

fn record_conflict_if_different(
    existing: &mut CanonicalRecord,
    incoming: &CanonicalRecord,
    field: &str,
    canonical_value: &Value,
    observed_value: &Value,
    both_present: bool,
) {
    if !both_present || canonical_value == observed_value {
        return;
    }
    let provenance = incoming.provenance.first();
    let conflict = RecordFieldConflict {
        field: field.to_string(),
        canonical_value: canonical_value.clone(),
        observed_value: observed_value.clone(),
        source: provenance
            .map(|item| item.source.clone())
            .unwrap_or_else(|| "unknown".to_string()),
        external_id: provenance.and_then(|item| item.external_id.clone()),
        artifact_id: provenance.and_then(|item| item.artifact_id.clone()),
        observed_at: provenance
            .map(|item| item.observed_at.clone())
            .unwrap_or_else(|| now_iso8601()),
    };
    if !existing.field_conflicts.contains(&conflict) {
        existing.field_conflicts.push(conflict);
    }
}

fn fill_option<T: Clone>(target: &mut Option<T>, incoming: &Option<T>) -> bool {
    if target.is_none() && incoming.is_some() {
        *target = incoming.clone();
        true
    } else {
        false
    }
}

fn fill_string(target: &mut String, incoming: &str) -> bool {
    if target.trim().is_empty() && !incoming.trim().is_empty() {
        *target = incoming.to_string();
        true
    } else {
        false
    }
}

fn legacy_record_from_value(
    paper: &Value,
    search_run_id: Option<&str>,
    artifact_id: Option<&str>,
    observed_at: &str,
) -> Option<CanonicalRecord> {
    let title = value_string(paper, "title");
    if title.is_empty() {
        return None;
    }
    let doi = optional_string(paper, "doi");
    let arxiv_id = optional_string(paper, "arxivId");
    let legacy_id = optional_string(paper, "id");
    let scopus_id = legacy_id
        .as_deref()
        .and_then(|id| id.strip_prefix("scopus:"))
        .map(str::to_string);
    let mut source_ids = BTreeMap::new();
    if let Some(id) = legacy_id.clone() {
        source_ids.insert("legacy_library".to_string(), id);
    }
    let id = canonical_record_id(
        doi.as_deref(),
        arxiv_id.as_deref(),
        scopus_id.as_deref(),
        &title,
    );
    let source = optional_string(paper, "source").unwrap_or_else(|| "legacy_library".to_string());
    Some(CanonicalRecord {
        schema_version: LITERATURE_SCHEMA_VERSION,
        id,
        revision: initial_revision(),
        normalized_title: normalized_record_title(&title),
        title,
        authors: paper["authors"]
            .as_array()
            .map(|authors| {
                authors
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|author| author.trim().to_string())
                    .filter(|author| !author.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        year: paper["year"]
            .as_u64()
            .and_then(|year| u32::try_from(year).ok()),
        venue: value_string(paper, "venue"),
        abstract_text: value_string(paper, "abstract"),
        url: optional_string(paper, "url"),
        pdf_url: paper["pdf"]
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        identifiers: RecordIdentifiers {
            doi,
            arxiv_id,
            scopus_id,
            source_ids,
        },
        provenance: vec![RecordProvenance {
            source: source.clone(),
            external_id: legacy_id.clone(),
            search_run_id: search_run_id.map(str::to_string),
            artifact_id: artifact_id.map(str::to_string),
            observed_at: observed_at.to_string(),
        }],
        observations: vec![RecordObservation {
            source: source.clone(),
            external_id: legacy_id.clone(),
            artifact_id: artifact_id.map(str::to_string),
            observed_at: observed_at.to_string(),
            fields: paper.clone(),
        }],
        field_conflicts: Vec::new(),
        metadata: paper.clone(),
        created_at: optional_string(paper, "addedAt").unwrap_or_else(|| observed_at.to_string()),
        updated_at: observed_at.to_string(),
    })
}

fn legacy_projection_meta_from_library(library: &Value) -> Value {
    let mut meta = library.as_object().cloned().unwrap_or_default();
    meta.remove("papers");
    Value::Object(meta)
}

#[must_use]
pub fn canonical_record_id(
    doi: Option<&str>,
    arxiv_id: Option<&str>,
    scopus_id: Option<&str>,
    title: &str,
) -> String {
    if let Some(doi) = doi.map(str::trim).filter(|value| !value.is_empty()) {
        return format!("doi:{}", doi.to_ascii_lowercase());
    }
    if let Some(arxiv_id) = arxiv_id.map(str::trim).filter(|value| !value.is_empty()) {
        return format!("arxiv:{arxiv_id}");
    }
    if let Some(scopus_id) = scopus_id.map(str::trim).filter(|value| !value.is_empty()) {
        return format!("scopus:{scopus_id}");
    }
    let digest = sha256_hex(normalized_record_title(title).as_bytes());
    format!("title:{}", &digest[..16])
}

#[must_use]
/// Family name of the first author. Handles both `"Sutton, Richard S."` and
/// `"Richard S. Sutton"`, which both occur across our source adapters.
fn attachment_creator_segment(record: &CanonicalRecord) -> String {
    let Some(first) = record.authors.iter().find(|name| !name.trim().is_empty()) else {
        return String::new();
    };
    let first = first.trim();
    if let Some((family, _)) = first.split_once(',') {
        return family.trim().to_string();
    }
    first
        .split_whitespace()
        .last()
        .unwrap_or(first)
        .to_string()
}

/// Characters no Windows path component may contain, plus the control range.
/// Applied after the template is filled so a template cannot smuggle in a
/// path separator and write outside the attachments directory.
fn sanitize_path_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_control() {
            out.push(' ');
        } else if matches!(
            character,
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
        ) {
            out.push(' ');
        } else {
            out.push(character);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Truncate by characters, not bytes: a CJK title is one character per glyph
/// but three bytes, and cutting on a byte boundary would corrupt it.
fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value.chars().take(limit).collect::<String>().trim_end().to_string()
}

/// Render one attachment file stem from a template. Placeholders that resolve
/// to nothing are dropped along with the separator that would have followed
/// them, so a record with no year does not produce `Sutton -  - Title`.
#[must_use]
pub fn render_attachment_stem(record: &CanonicalRecord, template: &str) -> String {
    let creator = attachment_creator_segment(record);
    let year = record.year.map(|year| year.to_string()).unwrap_or_default();
    let title = truncate_chars(record.title.trim(), ATTACHMENT_TITLE_CHARS);
    let citation_key = record.metadata["citationKey"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    let item_type = record.metadata["itemType"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    let value_for = |name: &str| -> String {
        match name {
            "creator" => creator.clone(),
            "year" => year.clone(),
            "title" => title.clone(),
            "citationKey" => citation_key.clone(),
            "venue" => record.venue.trim().to_string(),
            "itemType" => item_type.clone(),
            _ => String::new(),
        }
    };

    // Split on placeholders so an empty value can take its trailing literal
    // separator with it.
    let mut rendered = String::new();
    let mut rest = template;
    let mut pending_literal = String::new();
    while let Some(start) = rest.find('{') {
        let Some(end) = rest[start..].find('}').map(|offset| start + offset) else {
            break;
        };
        pending_literal.push_str(&rest[..start]);
        let value = value_for(&rest[start + 1..end]);
        if !value.is_empty() {
            // A separator only earns its place between two rendered values, so
            // nothing is emitted while the name is still empty.
            if !rendered.is_empty() {
                rendered.push_str(&pending_literal);
            }
            rendered.push_str(&value);
        }
        pending_literal.clear();
        rest = &rest[end + 1..];
    }
    pending_literal.push_str(rest);
    if !rendered.is_empty() {
        rendered.push_str(&pending_literal);
    }

    let stem = truncate_chars(sanitize_path_component(&rendered).trim(), ATTACHMENT_STEM_CHARS);
    let stem = stem.trim_matches(|character: char| character == '.' || character.is_whitespace());
    if stem.is_empty() {
        // Never return an empty stem: the record id is always unique and safe.
        return truncate_chars(&sanitize_path_component(&record.id), ATTACHMENT_STEM_CHARS);
    }
    stem.to_string()
}

pub fn normalized_record_title(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

/// `2301.12345v2` and `2301.12345` are the same preprint. Identity aliases must
/// agree on one of them or a revised submission becomes a second record.
fn strip_arxiv_version(id: &str) -> String {
    let id = id.trim();
    match id.rsplit_once('v') {
        Some((base, version))
            if !base.is_empty() && !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit()) =>
        {
            base.to_string()
        }
        _ => id.to_string(),
    }
}

const fn initial_revision() -> u64 {
    1
}

fn value_string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().trim().to_string()
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    let value = value_string(value, key);
    (!value.is_empty()).then_some(value)
}

fn new_id(prefix: &str) -> Result<String, String> {
    let mut random = [0_u8; 10];
    getrandom::fill(&mut random).map_err(to_error)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(to_error)?
        .as_millis();
    Ok(format!("{prefix}-{timestamp}-{}", hex_encode(&random)))
}

fn safe_component(value: &str) -> Result<String, String> {
    let cleaned = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return Err("artifact path component must contain a safe name".to_string());
    }
    Ok(cleaned)
}

fn safe_extension(value: &str) -> Result<String, String> {
    let extension = safe_component(value)?;
    if extension.contains('-') {
        return Err("artifact extension must be alphanumeric or underscore".to_string());
    }
    Ok(extension)
}

fn run_status_name(status: SearchRunStatus) -> &'static str {
    match status {
        SearchRunStatus::Planned => "planned",
        SearchRunStatus::Running => "running",
        SearchRunStatus::Completed => "completed",
        SearchRunStatus::Partial => "partial",
        SearchRunStatus::Failed => "failed",
        SearchRunStatus::LegacyImported => "legacy_imported",
    }
}

fn encode_payload<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(to_error)
}

fn decode_payload<T: for<'de> Deserialize<'de>>(payload: &str) -> Result<T, String> {
    serde_json::from_str(payload).map_err(to_error)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_encode(&hasher.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn to_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "tests/literature.rs"]
mod tests;
