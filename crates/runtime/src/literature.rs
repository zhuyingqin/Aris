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

pub const LITERATURE_SCHEMA_VERSION: u32 = 1;
pub const LITERATURE_DIRECTORY: &str = "literature";
const DATABASE_FILE: &str = "literature.sqlite3";
const ARTIFACTS_DIRECTORY: &str = "artifacts";
const LEGACY_LIBRARY_BOOTSTRAP_KEY: &str = "legacy_library_bootstrap_v1";
const LEGACY_LIBRARY_META_KEY: &str = "legacy_library_projection_meta_v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProtocolDraft {
    /// The research question the protocol is designed to answer.
    pub question: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub time_window: String,
    /// Adapter identifiers, for example `scopus` or `arxiv`.
    #[serde(default)]
    pub databases: Vec<String>,
    /// Complete, source-specific queries. Keys are adapter identifiers.
    #[serde(default)]
    pub queries: BTreeMap<String, String>,
    #[serde(default)]
    pub inclusion_criteria: Vec<String>,
    #[serde(default)]
    pub exclusion_criteria: Vec<String>,
    #[serde(default)]
    pub known_key_papers: Vec<String>,
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

#[must_use]
pub fn literature_root_for(workspace: &Path) -> PathBuf {
    somniq_project_dir(workspace).join(LITERATURE_DIRECTORY)
}

pub fn open_literature_store_at(workspace: &Path) -> Result<LiteratureStore, String> {
    let root = literature_root_for(workspace);
    fs::create_dir_all(root.join(ARTIFACTS_DIRECTORY)).map_err(|error| error.to_string())?;
    let connection =
        Connection::open(root.join(DATABASE_FILE)).map_err(|error| error.to_string())?;
    initialize_schema(&connection)?;
    Ok(LiteratureStore { root, connection })
}

impl LiteratureStore {
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
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
                databases: vec!["legacy_library".to_string()],
                queries: BTreeMap::new(),
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
            artifact_ids: Vec::new(),
            notes: vec!["Imported from legacy papers/library.json".to_string()],
        };
        let artifact = self.write_legacy_artifact(&run.id, &bytes)?;
        let mut completed_run = run;
        completed_run.artifact_ids.push(artifact.id.clone());
        completed_run.source_attempts[0]
            .artifact_ids
            .push(artifact.id.clone());

        let records = papers
            .iter()
            .filter_map(|paper| {
                legacy_record_from_value(paper, Some(&completed_run.id), Some(&artifact.id), &now)
            })
            .collect::<Vec<_>>();
        // Reuse the normal identity resolver so importing an old library into
        // a project that already has protocol records cannot fork identities.
        // The artifact and run ids are deterministic inputs to the observation
        // even though their rows are committed immediately afterwards.
        completed_run.record_ids = records
            .iter()
            .map(|record| {
                self.upsert_canonical_record(record)
                    .map(|persisted| persisted.record.id)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let report = LegacyImportReport {
            already_imported: false,
            protocol_id: protocol.id.clone(),
            search_run_id: completed_run.id.clone(),
            imported_records: records.len(),
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
            &json!({ "records": records.len(), "artifactId": artifact.id }),
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
            let persisted = self.set_legacy_library_paper(&persisted.id, &paper)?;
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
        transaction.commit().map_err(to_error)
    }

    fn set_legacy_library_paper(
        &mut self,
        record_id: &str,
        paper: &Value,
    ) -> Result<CanonicalRecord, String> {
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
        metadata.insert("legacyLibrary".to_string(), paper.clone());
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

fn initialize_schema(connection: &Connection) -> Result<(), String> {
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
             CREATE TABLE IF NOT EXISTS canonical_record_aliases(
               alias TEXT PRIMARY KEY, record_id TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS canonical_record_aliases_record_idx
               ON canonical_record_aliases(record_id);
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
             );",
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
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;
    if let Some(stored) = stored {
        let version = stored
            .parse::<u32>()
            .map_err(|error| format!("invalid literature schema version: {error}"))?;
        if version > LITERATURE_SCHEMA_VERSION {
            return Err(format!(
                "literature store schema {version} is newer than this runtime ({LITERATURE_SCHEMA_VERSION})"
            ));
        }
    } else {
        connection
            .execute(
                "INSERT INTO metadata(key, value) VALUES ('schema_version', ?1)",
                [LITERATURE_SCHEMA_VERSION.to_string()],
            )
            .map_err(to_error)?;
    }
    Ok(())
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
    Ok(())
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
        aliases.insert(format!("doi:{}", doi.trim().to_ascii_lowercase()));
    }
    if let Some(arxiv_id) = record
        .identifiers
        .arxiv_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        aliases.insert(format!("arxiv:{}", arxiv_id.trim().to_ascii_lowercase()));
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
    remap_screen_decisions(transaction, old_record_id, canonical_record_id)?;
    remap_evidence_cards(transaction, old_record_id, canonical_record_id)?;
    remap_run_record_ids(transaction, old_record_id, canonical_record_id)
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
        if !changed {
            continue;
        }
        run.record_ids.sort();
        run.record_ids.dedup();
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
pub fn normalized_record_title(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
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
