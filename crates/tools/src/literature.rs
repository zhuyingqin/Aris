//! Literature kernel tools.
//!
//! Skills (`/arxiv`, `/research-lit`, …) stay the orchestration layer; these
//! tools are the mechanical hands they use in environments without a shell
//! (ARIS desktop chat) — and the contract both CLI agents and the desktop
//! Literature UI share one project-local canonical store. `papers/library.json`
//! is a compatibility projection, never an independent source of truth.
//!
//! - `LiteratureSearch` — Scopus Search API, OpenAlex works, Crossref REST and
//!   arXiv Atom metadata search, normalised into one record shape and
//!   deduplicated. Scopus and OpenAlex are the published-venue core; arXiv runs
//!   last as a preprint supplement, so a paper found in the core keeps its
//!   peer-reviewed record and only borrows arXiv's open PDF link. Scopus needs
//!   `SCOPUS_API_KEY` (desktop Settings exports it) and auto-joins the default
//!   set only when the key is present.
//! - `LiteratureLibraryUpsert` — compatibility projection refresh for records
//!   that are already canonical. It cannot ingest untracked search results.
//! - `LiteraturePdfDownload` — fetch a PDF into `papers/` and, when a paper
//!   id is given, mark it downloaded in the library.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{collapse_whitespace, read_json_file};

const PAPERS_DIR: &str = "papers";
const LIBRARY_FILE: &str = "library.json";
const HTTP_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_PDF_BYTES: u64 = 80 * 1024 * 1024;
/// Per-source result target. The published-venue core (Scopus, OpenAlex,
/// Crossref) fetches up to this many; the arXiv supplement is capped lower so
/// preprints don't crowd out peer-reviewed hits.
const DEFAULT_RESULT_LIMIT: usize = 50;
const MAX_RESULT_LIMIT: usize = 100;
const ARXIV_SUPPLEMENT_MAX: usize = 25;
const USER_AGENT: &str = concat!(
    "aris/",
    env!("CARGO_PKG_VERSION"),
    " (literature tools; +https://github.com/zhuyingqin/Aris)"
);
const SCIENCEDIRECT_ORIGIN: &str = "https://www.sciencedirect.com";

const ATOM_NS: &str = "http://www.w3.org/2005/Atom";
const ARXIV_NS: &str = "http://arxiv.org/schemas/atom";

/// Read-only summary of the local canonical literature store.  The Desktop
/// uses this to distinguish the SQLite source of truth from its legacy JSON
/// compatibility projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureStorageStatus {
    pub schema_version: u32,
    pub database_path: String,
    pub database_bytes: u64,
    pub canonical_record_count: usize,
    pub search_run_count: usize,
    pub health: runtime::literature::LiteratureHealth,
    pub latest_backup: Option<runtime::literature::LiteratureBackup>,
    pub projection_path: String,
    pub projection_exists: bool,
}

/// A targeted Desktop mutation.  It never accepts a full library snapshot:
/// canonical rows and compatibility-only metadata are updated independently.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureLibraryDelta {
    #[serde(default)]
    pub upsert_papers: Vec<Value>,
    #[serde(default)]
    pub hide_paper_ids: Vec<String>,
    #[serde(default)]
    pub projection_metadata: Option<Value>,
}

/// A user-selected bibliographic export.  `source_path` is intentionally a
/// local desktop path; no bibliography is uploaded during import.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureBibliographyImportInput {
    pub source_path: String,
    /// Optional explicit parser: `zotero-json`, `csl-json`, `ris`, or
    /// `bibtex`. When omitted, the extension and JSON shape are used.
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureBibliographyImportReport {
    pub format: String,
    pub imported: usize,
    pub merged: usize,
    pub skipped: usize,
    pub total: usize,
}

/// Request a portable bibliography projection from the canonical local store.
/// An empty `record_ids` list exports the complete visible library.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureBibliographyExportInput {
    pub format: String,
    #[serde(default)]
    pub record_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureBibliographyExportReport {
    pub format: String,
    pub exported: usize,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteraturePdfRecordImportReport {
    pub record_id: String,
    pub inserted: bool,
    pub merged_record_ids: Vec<String>,
}

// ── Tool inputs ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureSearchInput {
    pub query: String,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSearch {
    pub query: String,
    #[serde(default)]
    pub sources: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureLibraryUpsertInput {
    pub papers: Vec<Value>,
    #[serde(default)]
    pub search: Option<UpsertSearch>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteraturePdfDownloadInput {
    pub url: String,
    pub file_name: String,
    #[serde(default)]
    pub paper_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureBrowserDownloadTaskInput {
    pub paper: RemotePaper,
}

/// Creates a durable, project-local retrieval protocol. Executing it is a
/// separate confirmed operation so an agent cannot turn a draft into a full
/// export implicitly.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureSearchProtocolCreateInput {
    pub protocol: runtime::SearchProtocolDraft,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureSearchPreviewInput {
    pub protocol_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureSearchExecuteInput {
    pub protocol_id: String,
    /// Must be the exact string `execute`, after a user has reviewed the
    /// preview. This makes the confirmation visible in the tool transcript.
    pub confirmation: String,
    #[serde(default)]
    pub max_results: Option<usize>,
    /// Continue a previous, checkpointed non-terminal run for this exact
    /// protocol revision instead of starting a duplicate run.
    #[serde(default)]
    pub resume_run_id: Option<String>,
}

// ── Tool entry points (sync, pretty-JSON out) ───────────────────────────────

pub fn run_literature_search(input: LiteratureSearchInput) -> Result<String, String> {
    let base = runtime::workspace_root_from_env();
    serde_json::to_string_pretty(&literature_search_ad_hoc_at(&base, input)?)
        .map_err(|error| error.to_string())
}

/// Execute an explicit casual Chat search through the same durable path as a
/// reviewed protocol. The tool invocation itself is the user's request for a
/// bounded search, so this deliberately creates a lightweight ad-hoc protocol
/// and immediately executes it instead of requiring a second confirmation
/// turn. The resulting `SearchRun` still preserves the exact source queries,
/// raw artifacts, quota/failure details, and canonical record identities.
pub fn literature_search_ad_hoc_at(
    base: &Path,
    input: LiteratureSearchInput,
) -> Result<Value, String> {
    let limit = input
        .max_results
        .unwrap_or(DEFAULT_RESULT_LIMIT)
        .clamp(1, MAX_RESULT_LIMIT);
    let draft = casual_search_protocol_draft(&input)?;
    let protocol = {
        let mut store = runtime::open_literature_store_at(base)?;
        store.create_protocol(draft)?
    };
    let execution = literature_search_execute_at(
        base,
        LiteratureSearchExecuteInput {
            protocol_id: protocol.id.clone(),
            confirmation: "execute".to_string(),
            max_results: Some(limit),
            resume_run_id: None,
        },
        |_| {},
    )?;
    let run: runtime::SearchRun = serde_json::from_value(execution["searchRun"].clone())
        .map_err(|error| format!("ad-hoc search returned an invalid SearchRun: {error}"))?;
    let papers = {
        let store = runtime::open_literature_store_at(base)?;
        let mut papers = Vec::new();
        for record_id in &run.record_ids {
            if let Some(record) = store.load_canonical_record(record_id)? {
                papers.push(remote_paper_from_canonical(&record));
            }
        }
        papers
    };
    // Materialise the compatibility view only after the canonical run and
    // records are committed. This is a one-way projection, not a second write
    // path for Chat.
    let library = library_load_at(base)?;
    let source_counts = run
        .source_attempts
        .iter()
        .map(|attempt| SourceCount {
            source: attempt.source.clone(),
            count: usize::try_from(attempt.returned_count).unwrap_or(usize::MAX),
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "protocol": protocol,
        "searchRun": run,
        "papers": papers,
        "warnings": execution["warnings"],
        "sourceCounts": source_counts,
        "libraryPath": library_path_at(base),
        "libraryRecordCount": library["papers"].as_array().map_or(0, Vec::len),
        "note": "This explicit casual search created and executed an automatic ad-hoc SearchProtocol. Its records are already canonical and have been projected to papers/library.json; do not call LiteratureLibraryUpsert to ingest them."
    }))
}

fn casual_search_protocol_draft(
    input: &LiteratureSearchInput,
) -> Result<runtime::SearchProtocolDraft, String> {
    let question = input.query.trim();
    if question.is_empty() {
        return Err("search query is empty".to_string());
    }
    let databases = casual_search_sources(&input.sources);
    let queries = databases
        .iter()
        .map(|source| (source.clone(), question.to_string()))
        .collect::<BTreeMap<_, _>>();
    Ok(runtime::SearchProtocolDraft {
        question: question.to_string(),
        scope: "Automatically created for an explicit casual Chat search. Refine this protocol before relying on it for screening, evidence synthesis, or novelty claims.".to_string(),
        time_window: String::new(),
        databases,
        queries,
        inclusion_criteria: Vec::new(),
        exclusion_criteria: Vec::new(),
        known_key_papers: Vec::new(),
    })
}

fn casual_search_sources(sources: &[String]) -> Vec<String> {
    let canonical = |source: &str| match source.trim().to_ascii_lowercase().as_str() {
        "semantic_scholar" | "semanticscholar" => "semantic-scholar".to_string(),
        source => source.to_string(),
    };
    let requested = sources
        .iter()
        .map(|source| canonical(source))
        .collect::<Vec<_>>();
    let engines = planned_engines(&requested, scopus_api_key().is_ok());
    let mut resolved = engines
        .into_iter()
        .map(Engine::source_name)
        .map(str::to_string)
        .collect::<Vec<_>>();
    // Tool schemas only admit supported sources, but retain an unexpected
    // caller-provided identifier so the SearchRun records the coverage gap
    // rather than silently changing the requested search.
    for source in requested {
        if !resolved.iter().any(|known| known == &source) {
            resolved.push(source);
        }
    }
    resolved
}

fn remote_paper_from_canonical(record: &runtime::CanonicalRecord) -> RemotePaper {
    let source = record
        .provenance
        .first()
        .map(|provenance| provenance.source.clone())
        .unwrap_or_else(|| "canonical_store".to_string());
    RemotePaper {
        id: record.id.clone(),
        title: record.title.clone(),
        authors: record.authors.clone(),
        year: record.year,
        venue: record.venue.clone(),
        doi: record.identifiers.doi.clone(),
        arxiv_id: record.identifiers.arxiv_id.clone(),
        summary: record.abstract_text.clone(),
        url: record.url.clone(),
        pdf_url: record.pdf_url.clone(),
        source,
        published: record.metadata["legacyKernel"]["published"]
            .as_str()
            .map(str::to_string),
        cited_by: record.metadata["legacyKernel"]["citedBy"].as_u64(),
    }
}

pub fn run_literature_library_upsert(
    input: LiteratureLibraryUpsertInput,
) -> Result<String, String> {
    let base = runtime::workspace_root_from_env();
    let stats = library_upsert_at(&base, &input.papers, input.search.as_ref())?;
    serde_json::to_string_pretty(&stats).map_err(|e| e.to_string())
}

pub fn run_literature_pdf_download(input: LiteraturePdfDownloadInput) -> Result<String, String> {
    let base = runtime::workspace_root_from_env();
    let result = download_pdf_at(
        &base,
        &input.url,
        &input.file_name,
        input.paper_id.as_deref(),
    )?;
    serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
}

pub fn run_literature_browser_download_task(
    input: LiteratureBrowserDownloadTaskInput,
) -> Result<String, String> {
    let task = browser_download_task_for_paper(&input.paper)?
        .ok_or_else(|| "no IEEE Xplore or ScienceDirect browser route found".to_string())?;
    serde_json::to_string_pretty(&task).map_err(|e| e.to_string())
}

pub fn run_literature_search_protocol_create(
    input: LiteratureSearchProtocolCreateInput,
) -> Result<String, String> {
    let base = runtime::workspace_root_from_env();
    serde_json::to_string_pretty(&literature_search_protocol_create_at(&base, input)?)
        .map_err(|error| error.to_string())
}

pub fn literature_search_protocol_create_at(
    base: &Path,
    input: LiteratureSearchProtocolCreateInput,
) -> Result<Value, String> {
    let mut store = runtime::open_literature_store_at(base)?;
    let protocol = store.create_protocol(input.protocol)?;
    Ok(json!({
        "protocol": protocol,
        "storeRoot": store.root(),
        "next": "Call LiteratureSearchPreview before asking the user to confirm execution."
    }))
}

pub fn run_literature_search_preview(
    input: LiteratureSearchPreviewInput,
) -> Result<String, String> {
    let base = runtime::workspace_root_from_env();
    serde_json::to_string_pretty(&literature_search_preview_at(&base, input)?)
        .map_err(|error| error.to_string())
}

pub fn literature_search_preview_at(
    base: &Path,
    input: LiteratureSearchPreviewInput,
) -> Result<Value, String> {
    let store = runtime::open_literature_store_at(base)?;
    let protocol = store
        .load_protocol(&input.protocol_id)?
        .ok_or_else(|| format!("unknown search protocol: {}", input.protocol_id))?;
    let sources = effective_protocol_sources(&protocol);
    let plan = sources
        .iter()
        .map(|source| {
            let availability = adapter_availability(source);
            json!({
                "source": source,
                "query": protocol_query_for(&protocol, source),
                "adapterStatus": availability.status,
                "executionMode": availability.execution_mode,
                "coverageNote": availability.coverage_note,
                "quotaPolicy": availability.quota_policy,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "protocol": protocol,
        "plan": plan,
        "confirmationRequired": true,
        "confirmationValue": "execute",
        "defaultMaxResults": DEFAULT_RESULT_LIMIT,
        "maximumMaxResults": MAX_RESULT_LIMIT,
        "fullExport": {
            "requiresExplicitConfirmation": true,
            "maximumPerSource": MAX_RESULT_LIMIT,
            "note": "The result cap applies per source. Scopus is paged and begins with COMPLETE; entitlement failure is recorded before a one-time STANDARD fallback."
        },
        "note": "Each supported adapter persists its sanitised request, provider response artifacts, result count, quota headers when exposed, and a restart checkpoint."
    }))
}

pub fn run_literature_search_execute(
    input: LiteratureSearchExecuteInput,
) -> Result<String, String> {
    let base = runtime::workspace_root_from_env();
    serde_json::to_string_pretty(&literature_search_execute_at(&base, input, |_| {})?)
        .map_err(|error| error.to_string())
}

/// Executes a durable run from a Desktop or tool caller. `on_progress` is
/// intentionally observational: persistence never depends on UI delivery.
pub fn literature_search_execute_at(
    base: &Path,
    input: LiteratureSearchExecuteInput,
    mut on_progress: impl FnMut(&Value),
) -> Result<Value, String> {
    if input.confirmation.trim() != "execute" {
        return Err(
            "execution requires confirmation: \"execute\" after LiteratureSearchPreview"
                .to_string(),
        );
    }
    let mut store = runtime::open_literature_store_at(base)?;
    let protocol = store
        .load_protocol(&input.protocol_id)?
        .ok_or_else(|| format!("unknown search protocol: {}", input.protocol_id))?;
    let limit = input
        .max_results
        .unwrap_or(DEFAULT_RESULT_LIMIT)
        .clamp(1, MAX_RESULT_LIMIT);
    let mut run = match input.resume_run_id.as_deref() {
        Some(run_id) => store.resume_run(run_id, &protocol)?,
        None => store.start_run(&protocol)?,
    };
    let mut warnings = Vec::new();
    let mut all_record_ids = run.record_ids.iter().cloned().collect::<BTreeSet<_>>();
    let mut preview_record_ids = BTreeSet::new();
    let mut record_preview = Vec::new();

    for source in effective_protocol_sources(&protocol) {
        if source_has_completed_attempt(&run, &source) {
            on_progress(&json!({
                "searchRunId": run.id,
                "source": source,
                "phase": "skipped",
                "message": "Source was already checkpointed as complete."
            }));
            continue;
        }
        if mark_interrupted_attempts(&mut run, &source) {
            store.checkpoint_run(&mut run)?;
            on_progress(&json!({
                "searchRunId": run.id,
                "source": source,
                "phase": "restarting",
                "message": "An interrupted source attempt was checkpointed and will be retried."
            }));
        }
        let started_at = runtime::now_iso8601();
        let query = protocol_query_for(&protocol, &source);
        let availability = adapter_availability(&source);
        if availability.status != "available" {
            warnings.push(format!("{source}: adapter is not implemented"));
            run.source_attempts.push(runtime::SourceAttempt {
                source,
                request: json!({ "query": query, "maxResults": limit }),
                started_at,
                completed_at: Some(runtime::now_iso8601()),
                status: runtime::SourceAttemptStatus::Unavailable,
                hit_count: None,
                returned_count: 0,
                quota: Value::Null,
                failure_code: Some("adapter_not_implemented".to_string()),
                failure_message: Some("The source adapter has not been migrated yet.".to_string()),
                coverage_note: None,
                artifact_ids: Vec::new(),
            });
            store.checkpoint_run(&mut run)?;
            continue;
        }

        run.source_attempts.push(runtime::SourceAttempt {
            source: source.clone(),
            request: adapter_request_preview(&source, &query, limit),
            started_at: started_at.clone(),
            completed_at: None,
            status: runtime::SourceAttemptStatus::Running,
            hit_count: None,
            returned_count: 0,
            quota: Value::Null,
            failure_code: None,
            failure_message: None,
            coverage_note: None,
            artifact_ids: Vec::new(),
        });
        store.checkpoint_run(&mut run)?;
        on_progress(&json!({
            "searchRunId": run.id,
            "source": source,
            "phase": "started",
            "query": query,
        }));

        match search_source_with_audit(&query, &source, limit) {
            Ok(outcome) => {
                let mut artifact_ids = Vec::new();
                for provider_artifact in outcome.raw_artifacts {
                    let artifact = store.write_run_artifact(
                        &run.id,
                        &source,
                        &provider_artifact.kind,
                        &provider_artifact.extension,
                        &provider_artifact.media_type,
                        &provider_artifact.bytes,
                    )?;
                    artifact_ids.push(artifact.id.clone());
                    run.artifact_ids.push(artifact.id);
                }
                let artifact_bytes = serde_json::to_vec_pretty(&json!({
                    "query": query,
                    "source": source,
                    "papers": outcome.papers,
                    "warnings": outcome.warnings,
                    "request": outcome.request,
                    "hitCount": outcome.hit_count,
                    "quota": outcome.quota,
                }))
                .map_err(|error| error.to_string())?;
                let artifact = store.write_run_artifact(
                    &run.id,
                    &source,
                    "normalised-results",
                    "json",
                    "application/json",
                    &artifact_bytes,
                )?;
                artifact_ids.push(artifact.id.clone());
                run.artifact_ids.push(artifact.id.clone());
                let normalized: Value =
                    serde_json::from_slice(&artifact_bytes).map_err(|error| error.to_string())?;
                let papers = normalized["papers"].as_array().cloned().unwrap_or_default();
                let mut inserted_or_seen = 0_u64;
                for paper in &papers {
                    let record = canonical_record_from_remote(paper, &run.id, &artifact.id);
                    let persisted = store.upsert_canonical_record(&record)?;
                    let record_id = persisted.record.id.clone();
                    if record_preview.len() < 20 && preview_record_ids.insert(record_id.clone()) {
                        record_preview.push(json!({
                            "id": &record_id,
                            "title": &persisted.record.title,
                            "authors": &persisted.record.authors,
                            "year": persisted.record.year,
                            "venue": &persisted.record.venue,
                            "source": &source,
                        }));
                    }
                    all_record_ids.insert(record_id);
                    inserted_or_seen = inserted_or_seen.saturating_add(1);
                }
                let source_warnings = outcome.warnings;
                warnings.extend(source_warnings.clone());
                let status = if source_warnings.is_empty() {
                    runtime::SourceAttemptStatus::Completed
                } else {
                    runtime::SourceAttemptStatus::Partial
                };
                let hit_count = outcome.hit_count;
                {
                    let attempt = run
                        .source_attempts
                        .last_mut()
                        .expect("running attempt exists");
                    attempt.request = outcome.request;
                    attempt.completed_at = Some(runtime::now_iso8601());
                    attempt.status = status;
                    attempt.hit_count = hit_count;
                    attempt.returned_count = inserted_or_seen;
                    attempt.quota = outcome.quota;
                    attempt.coverage_note = outcome.coverage_note;
                    attempt.artifact_ids = artifact_ids;
                }
                run.record_ids = all_record_ids.iter().cloned().collect();
                store.checkpoint_run(&mut run)?;
                on_progress(&json!({
                    "searchRunId": run.id,
                    "source": source,
                    "phase": "completed",
                    "returnedCount": inserted_or_seen,
                    "hitCount": hit_count,
                }));
            }
            Err(error) => {
                let status = source_failure_status(&error);
                warnings.push(format!("{source}: {error}"));
                let attempt = run
                    .source_attempts
                    .last_mut()
                    .expect("running attempt exists");
                attempt.completed_at = Some(runtime::now_iso8601());
                attempt.status = status;
                attempt.failure_code = Some("adapter_request_failed".to_string());
                attempt.failure_message = Some(error.to_string());
                store.checkpoint_run(&mut run)?;
                on_progress(&json!({
                    "searchRunId": run.id,
                    "source": source,
                    "phase": "failed",
                    "message": error.to_string(),
                }));
            }
        }
    }
    run.record_ids = all_record_ids.into_iter().collect();
    let latest_attempts = effective_protocol_sources(&protocol)
        .iter()
        .filter_map(|source| {
            run.source_attempts
                .iter()
                .rev()
                .find(|attempt| attempt.source.eq_ignore_ascii_case(source))
        })
        .collect::<Vec<_>>();
    let failures = latest_attempts
        .iter()
        .filter(|attempt| {
            matches!(
                attempt.status,
                runtime::SourceAttemptStatus::Unavailable
                    | runtime::SourceAttemptStatus::Unauthorised
                    | runtime::SourceAttemptStatus::RateLimited
                    | runtime::SourceAttemptStatus::Failed
            )
        })
        .count();
    run.status = if failures == latest_attempts.len() {
        runtime::SearchRunStatus::Failed
    } else if failures > 0 || !warnings.is_empty() {
        runtime::SearchRunStatus::Partial
    } else {
        runtime::SearchRunStatus::Completed
    };
    run.completed_at = Some(runtime::now_iso8601());
    run.notes.extend(warnings.clone());
    store.finish_run(&mut run)?;
    Ok(json!({
        "searchRun": run,
        "warnings": warnings,
        "recordPreview": record_preview,
        "recordPreviewNote": "Metadata samples from this SearchRun only. They are not ScreenDecision or EvidenceCard objects.",
        "next": "Review the run and canonical records before creating ScreenDecision or EvidenceCard objects."
    }))
}

fn effective_protocol_sources(protocol: &runtime::SearchProtocol) -> Vec<String> {
    let mut sources = protocol
        .draft
        .databases
        .iter()
        .map(|source| source.trim().to_ascii_lowercase())
        .filter(|source| !source.is_empty())
        .collect::<Vec<_>>();
    if sources.is_empty() {
        sources.extend(
            protocol
                .draft
                .queries
                .keys()
                .map(|source| source.to_ascii_lowercase()),
        );
    }
    if sources.is_empty() {
        sources.extend(
            [
                "scopus",
                "openalex",
                "semantic-scholar",
                "crossref",
                "arxiv",
            ]
            .map(str::to_string),
        );
    }
    let mut seen = BTreeSet::new();
    sources.retain(|source| seen.insert(source.clone()));
    sources
}

fn protocol_query_for(protocol: &runtime::SearchProtocol, source: &str) -> String {
    protocol
        .draft
        .queries
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(source))
        .map(|(_, query)| query.trim().to_string())
        .or_else(|| {
            protocol
                .draft
                .queries
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("default"))
                .map(|(_, query)| query.trim().to_string())
        })
        .filter(|query| !query.is_empty())
        .unwrap_or_else(|| protocol.draft.question.trim().to_string())
}

fn source_has_completed_attempt(run: &runtime::SearchRun, source: &str) -> bool {
    run.source_attempts.iter().rev().any(|attempt| {
        attempt.source.eq_ignore_ascii_case(source)
            && matches!(
                attempt.status,
                runtime::SourceAttemptStatus::Completed | runtime::SourceAttemptStatus::Partial
            )
    })
}

fn mark_interrupted_attempts(run: &mut runtime::SearchRun, source: &str) -> bool {
    let mut changed = false;
    for attempt in &mut run.source_attempts {
        if attempt.source.eq_ignore_ascii_case(source)
            && attempt.status == runtime::SourceAttemptStatus::Running
        {
            attempt.status = runtime::SourceAttemptStatus::Failed;
            attempt.completed_at = Some(runtime::now_iso8601());
            attempt.failure_code = Some("interrupted".to_string());
            attempt.failure_message = Some(
                "The application stopped before this source attempt completed; a resumed run retried it."
                    .to_string(),
            );
            changed = true;
        }
    }
    changed
}

fn source_failure_status(error: &str) -> runtime::SourceAttemptStatus {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("api key") || normalized.contains("401") || normalized.contains("403") {
        runtime::SourceAttemptStatus::Unauthorised
    } else if normalized.contains("429")
        || normalized.contains("rate limit")
        || normalized.contains("quota")
    {
        runtime::SourceAttemptStatus::RateLimited
    } else {
        runtime::SourceAttemptStatus::Failed
    }
}

fn canonical_record_from_remote(
    paper: &Value,
    search_run_id: &str,
    artifact_id: &str,
) -> runtime::CanonicalRecord {
    let title = record_title(paper);
    let doi = non_empty(record_str(paper, "doi"));
    let arxiv_id = non_empty(record_str(paper, "arxivId"));
    let remote_id = non_empty(record_str(paper, "id"));
    let scopus_id = remote_id
        .as_deref()
        .and_then(|id| id.strip_prefix("scopus:"))
        .map(str::to_string);
    let source = non_empty(record_str(paper, "source")).unwrap_or_else(|| "unknown".to_string());
    let mut source_ids = std::collections::BTreeMap::new();
    if let Some(id) = remote_id.clone() {
        source_ids.insert(source.clone(), id);
    }
    let now = runtime::now_iso8601();
    runtime::CanonicalRecord {
        schema_version: runtime::LITERATURE_SCHEMA_VERSION,
        id: runtime::canonical_record_id(
            doi.as_deref(),
            arxiv_id.as_deref(),
            scopus_id.as_deref(),
            &title,
        ),
        revision: 1,
        normalized_title: runtime::normalized_record_title(&title),
        title,
        authors: paper["authors"]
            .as_array()
            .map(|authors| {
                authors
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        year: paper["year"]
            .as_u64()
            .and_then(|year| u32::try_from(year).ok()),
        venue: record_str(paper, "venue").to_string(),
        abstract_text: record_str(paper, "abstract").to_string(),
        url: non_empty(record_str(paper, "url")),
        pdf_url: non_empty(record_str(paper, "pdfUrl")),
        identifiers: runtime::RecordIdentifiers {
            doi,
            arxiv_id,
            scopus_id,
            source_ids,
        },
        provenance: vec![runtime::RecordProvenance {
            source: source.clone(),
            external_id: remote_id.clone(),
            search_run_id: Some(search_run_id.to_string()),
            artifact_id: Some(artifact_id.to_string()),
            observed_at: now.clone(),
        }],
        observations: vec![runtime::RecordObservation {
            source: source.clone(),
            external_id: remote_id.clone(),
            artifact_id: Some(artifact_id.to_string()),
            observed_at: now.clone(),
            fields: paper.clone(),
        }],
        field_conflicts: Vec::new(),
        metadata: json!({
            "legacyKernel": {
                "source": source,
                "published": paper["published"],
                "citedBy": paper["citedBy"],
            }
        }),
        created_at: now.clone(),
        updated_at: now,
    }
}

// ── Library persistence ─────────────────────────────────────────────────────

pub fn library_path_at(base: &Path) -> PathBuf {
    base.join(PAPERS_DIR).join(LIBRARY_FILE)
}

/// Reports the durable local store without treating `papers/library.json` as
/// an independent database.  Opening the store also ensures a newly created
/// project has an initialized SQLite schema before the Desktop renders it.
pub fn library_storage_status_at(base: &Path) -> Result<LiteratureStorageStatus, String> {
    let store = runtime::open_literature_store_at(base)?;
    let database_path = store.database_path();
    let database_bytes = std::fs::metadata(&database_path)
        .map_err(|error| error.to_string())?
        .len();
    let projection_path = library_path_at(base);
    Ok(LiteratureStorageStatus {
        schema_version: runtime::LITERATURE_SCHEMA_VERSION,
        database_path: database_path.to_string_lossy().to_string(),
        database_bytes,
        canonical_record_count: store.list_canonical_records()?.len(),
        search_run_count: store.list_search_runs(None)?.len(),
        health: store.health()?,
        latest_backup: store.latest_backup()?,
        projection_path: projection_path.to_string_lossy().to_string(),
        projection_exists: projection_path.exists(),
    })
}

/// Create an explicit, recoverable SQLite backup without treating the legacy
/// JSON projection as data that needs to be copied or restored.
pub fn library_create_backup_at(
    base: &Path,
) -> Result<runtime::literature::LiteratureBackup, String> {
    runtime::open_literature_store_at(base)?.create_backup()
}

/// Search the canonical local store through its SQLite FTS5 index.  Results
/// are projected through the same compatibility shape as `library_load_at`,
/// while ordering is retained from the canonical ranked result set.
pub fn library_full_text_search_at(
    base: &Path,
    query: &str,
    limit: Option<usize>,
) -> Result<Value, String> {
    let store = runtime::open_literature_store_at(base)?;
    let hits = store.full_text_search(query, limit.unwrap_or(100).clamp(1, 250))?;
    drop(store);

    let library = library_load_at(base)?;
    let papers_by_id = library["papers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|paper| {
            paper
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_string(), paper.clone()))
        })
        .collect::<BTreeMap<_, _>>();
    let papers = hits
        .iter()
        .filter_map(|hit| papers_by_id.get(&hit.record_id).cloned())
        .collect::<Vec<_>>();
    Ok(json!({ "query": query, "hits": hits, "papers": papers }))
}

/// Index the extracted text for one local PDF without exposing it through the
/// legacy JSON projection. Returns false when the file is not attached to a
/// canonical literature record.
pub fn library_index_pdf_text_at(
    base: &Path,
    relative_path: &str,
    text: &str,
) -> Result<bool, String> {
    let normalized_path = relative_path.replace('\\', "/");
    let mut store = runtime::open_literature_store_at(base)?;
    let record_id = store
        .list_canonical_records()?
        .into_iter()
        .find(|record| {
            record.metadata["legacyLibrary"]["pdf"]["path"]
                .as_str()
                .map(|path| path.replace('\\', "/") == normalized_path)
                .unwrap_or(false)
        })
        .map(|record| record.id);
    let Some(record_id) = record_id else {
        return Ok(false);
    };
    store.set_record_pdf_text(&record_id, text)?;
    Ok(true)
}

/// List conservative duplicate candidates for the Desktop review panel.
pub fn library_duplicate_candidates_at(
    base: &Path,
) -> Result<Vec<runtime::literature::LiteratureDuplicateCandidate>, String> {
    runtime::open_literature_store_at(base)?.duplicate_candidates()
}

/// Apply a deliberate user-selected duplicate merge and regenerate the legacy
/// JSON projection only after the canonical transaction succeeds.
pub fn library_merge_duplicates_at(
    base: &Path,
    primary_record_id: &str,
    duplicate_record_id: &str,
) -> Result<Value, String> {
    let mut store = runtime::open_literature_store_at(base)?;
    let primary = store.merge_canonical_records(primary_record_id, duplicate_record_id)?;
    let projection = project_legacy_library(
        &store.legacy_library_projection_meta()?,
        &store.list_canonical_records()?,
        &store.list_search_runs(None)?,
    );
    write_library_file(&library_path_at(base), &projection)?;
    Ok(json!({ "primaryRecordId": primary.id, "projection": projection }))
}

/// Apply a minimal Desktop change to the canonical store, then refresh the
/// JSON compatibility projection.  The JSON file is never read back as a
/// writable source of truth in this path.
pub fn library_apply_delta_at(base: &Path, delta: &LiteratureLibraryDelta) -> Result<Value, String> {
    let mut store = runtime::open_literature_store_at(base)?;
    if !store.has_legacy_library_bootstrap()? {
        drop(store);
        let _ = library_load_at(base)?;
        store = runtime::open_literature_store_at(base)?;
    }
    for paper in &delta.upsert_papers {
        let record_id = record_str(paper, "id");
        if record_id.is_empty() {
            return Err("literature delta paper update requires a canonical record id".to_string());
        }
        if store.load_canonical_record(record_id)?.is_none() {
            return Err(format!(
                "unknown canonical record {record_id:?}; use a standard import or search protocol to add records"
            ));
        }
        store.update_legacy_library_paper(record_id, paper)?;
    }
    for record_id in &delta.hide_paper_ids {
        let record_id = record_id.trim();
        if !record_id.is_empty() {
            store.set_legacy_library_visibility(record_id, false)?;
        }
    }
    if let Some(metadata) = &delta.projection_metadata {
        if !metadata.is_object() {
            return Err("literature projection metadata must be a JSON object".to_string());
        }
        store.set_legacy_library_projection_meta(metadata)?;
    }
    store.mark_legacy_library_bootstrap()?;
    let projection = project_legacy_library(
        &store.legacy_library_projection_meta()?,
        &store.list_canonical_records()?,
        &store.list_search_runs(None)?,
    );
    write_library_file(&library_path_at(base), &projection)?;
    Ok(projection)
}

/// Import a standard local bibliography export directly into the canonical
/// SQLite store. All parsers normalise to one internal JSON shape before the
/// identity resolver runs, so imports can never create a parallel library.
pub fn library_import_bibliography_at(
    base: &Path,
    input: &LiteratureBibliographyImportInput,
) -> Result<LiteratureBibliographyImportReport, String> {
    let source_path = PathBuf::from(input.source_path.trim());
    if input.source_path.trim().is_empty() || !source_path.is_file() {
        return Err("select a readable local bibliography export file".to_string());
    }
    let bytes = std::fs::read(&source_path).map_err(|error| error.to_string())?;
    let requested = input.format.as_deref().unwrap_or("").trim().to_ascii_lowercase();
    let format = if requested.is_empty() {
        match source_path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
            "json" => "json".to_string(),
            "ris" => "ris".to_string(),
            "bib" | "bibtex" => "bibtex".to_string(),
            _ => return Err("unsupported bibliography extension; choose JSON, RIS, or BibTeX".to_string()),
        }
    } else { requested };
    let (format, items) = standard_bibliography_items(&format, &bytes)?;
    let mut store = runtime::open_literature_store_at(base)?;
    if !store.has_legacy_library_bootstrap()? {
        drop(store);
        let _ = library_load_at(base)?;
        store = runtime::open_literature_store_at(base)?;
    }
    let mut imported = 0;
    let mut merged = 0;
    let mut skipped = 0;
    for item in items {
        let Some((record, paper)) = canonical_record_from_standard_json(&item) else {
            skipped += 1;
            continue;
        };
        let result = store.upsert_canonical_record(&record)?;
        store.update_legacy_library_paper(&result.record.id, &paper)?;
        if result.inserted { imported += 1; } else { merged += 1; }
    }
    store.mark_legacy_library_bootstrap()?;
    let projection = project_legacy_library(&store.legacy_library_projection_meta()?, &store.list_canonical_records()?, &store.list_search_runs(None)?);
    write_library_file(&library_path_at(base), &projection)?;
    Ok(LiteratureBibliographyImportReport { format, imported, merged, skipped, total: projection["papers"].as_array().map_or(0, Vec::len) })
}

/// Export records projected from the canonical SQLite store.  This intentionally
/// reads the same projection used by the Desktop and CLI instead of treating
/// `papers/library.json` as an independently writable bibliography database.
pub fn library_export_bibliography_at(
    base: &Path,
    input: &LiteratureBibliographyExportInput,
) -> Result<LiteratureBibliographyExportReport, String> {
    let format = normalize_bibliography_export_format(&input.format)?;
    let library = library_load_at(base)?;
    let papers = library["papers"]
        .as_array()
        .ok_or_else(|| "canonical literature projection has no paper list".to_string())?;
    let requested = input
        .record_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>();
    let selected = papers
        .iter()
        .filter(|paper| {
            requested.is_empty()
                || paper["id"]
                    .as_str()
                    .is_some_and(|id| requested.contains(id))
        })
        .cloned()
        .collect::<Vec<_>>();
    if !requested.is_empty() {
        let found = selected
            .iter()
            .filter_map(|paper| paper["id"].as_str())
            .collect::<BTreeSet<_>>();
        let missing = requested
            .iter()
            .filter(|id| !found.contains(id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(format!("cannot export unknown literature record(s): {}", missing.join(", ")));
        }
    }
    let mut used_keys = BTreeSet::new();
    let entries = selected
        .iter()
        .map(|paper| BibliographyExportEntry {
            paper,
            citation_key: bibliography_citation_key(paper, &mut used_keys),
        })
        .collect::<Vec<_>>();
    let content = match format.as_str() {
        "bibtex" => entries
            .iter()
            .map(|entry| bibtex_entry(entry, false))
            .collect::<Vec<_>>()
            .join("\n\n"),
        "biblatex" => entries
            .iter()
            .map(|entry| bibtex_entry(entry, true))
            .collect::<Vec<_>>()
            .join("\n\n"),
        "ris" => entries.iter().map(ris_entry).collect::<Vec<_>>().join("\n"),
        "csl-json" => serde_json::to_string_pretty(
            &entries.iter().map(csl_json_entry).collect::<Vec<_>>(),
        )
        .map_err(|error| error.to_string())?,
        _ => unreachable!("format is validated above"),
    };
    Ok(LiteratureBibliographyExportReport {
        format,
        exported: entries.len(),
        content: if content.is_empty() { content } else { format!("{content}\n") },
    })
}

struct BibliographyExportEntry<'a> {
    paper: &'a Value,
    citation_key: String,
}

fn normalize_bibliography_export_format(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "bib" | "bibtex" => Ok("bibtex".to_string()),
        "biblatex" => Ok("biblatex".to_string()),
        "ris" => Ok("ris".to_string()),
        "csl" | "csl-json" | "csljson" | "json" => Ok("csl-json".to_string()),
        _ => Err("choose BibTeX, BibLaTeX, RIS, or CSL-JSON for bibliography export".to_string()),
    }
}

fn paper_string(paper: &Value, field: &str) -> String {
    paper[field].as_str().unwrap_or_default().trim().to_string()
}

fn paper_authors(paper: &Value) -> Vec<String> {
    paper["authors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|author| !author.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn citation_key_component(value: &str) -> String {
    value
        .chars()
        .filter_map(|character| character.is_ascii_alphanumeric().then_some(character.to_ascii_lowercase()))
        .collect()
}

fn valid_citation_key(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let key = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.'))
        .collect::<String>();
    if key.is_empty() {
        None
    } else if key.chars().next().is_some_and(|character| character.is_ascii_alphabetic()) {
        Some(key)
    } else {
        Some(format!("ref{key}"))
    }
}

fn bibliography_citation_key(paper: &Value, used: &mut BTreeSet<String>) -> String {
    let author = paper_authors(paper)
        .into_iter()
        .next()
        .unwrap_or_else(|| "reference".to_string());
    let family = author
        .split_once(',')
        .map(|(family, _)| family)
        .or_else(|| author.split_whitespace().last())
        .unwrap_or("reference");
    let year = paper["year"]
        .as_u64()
        .map(|year| year.to_string())
        .unwrap_or_else(|| "nd".to_string());
    let title_word = paper_string(paper, "title")
        .split_whitespace()
        .map(citation_key_component)
        .find(|word| word.len() > 2)
        .unwrap_or_else(|| "work".to_string());
    let base = paper["citationKey"]
        .as_str()
        .and_then(valid_citation_key)
        .unwrap_or_else(|| {
            let family = citation_key_component(family);
            format!("{}{}{}", if family.is_empty() { "ref" } else { &family }, year, title_word)
        });
    let mut candidate = base.clone();
    let mut suffix = 2_usize;
    while used.contains(&candidate.to_ascii_lowercase()) {
        candidate = format!("{base}{suffix}");
        suffix += 1;
    }
    used.insert(candidate.to_ascii_lowercase());
    candidate
}

fn bibtex_value(value: &str) -> String {
    value
        .replace('\\', "\\textbackslash{}")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace('%', "\\%")
        .replace('&', "\\&")
        .replace('#', "\\#")
        .replace('_', "\\_")
}

fn bibtex_entry_type(item_type: &str, biblatex: bool) -> &'static str {
    match item_type {
        "article" => "article",
        "book" => "book",
        "bookSection" => "incollection",
        "conferencePaper" => "inproceedings",
        "thesis" => if biblatex { "thesis" } else { "phdthesis" },
        "report" => "techreport",
        "webpage" => if biblatex { "online" } else { "misc" },
        "dataset" => if biblatex { "dataset" } else { "misc" },
        "preprint" => "article",
        _ => "misc",
    }
}

fn bibtex_entry(entry: &BibliographyExportEntry<'_>, biblatex: bool) -> String {
    let paper = entry.paper;
    let item_type = paper_string(paper, "itemType");
    let mut fields = vec![format!("  title = {{{}}}", bibtex_value(&paper_string(paper, "title")))];
    let authors = paper_authors(paper);
    if !authors.is_empty() {
        fields.push(format!("  author = {{{}}}", bibtex_value(&authors.join(" and "))));
    }
    if let Some(year) = paper["year"].as_u64() {
        fields.push(if biblatex {
            format!("  date = {{{year}}}")
        } else {
            format!("  year = {{{year}}}")
        });
    }
    let venue = paper_string(paper, "venue");
    if !venue.is_empty() {
        let field = match item_type.as_str() {
            "conferencePaper" | "bookSection" => "booktitle",
            "book" => "publisher",
            "thesis" => "school",
            "report" => "institution",
            _ if biblatex => "journaltitle",
            _ => "journal",
        };
        fields.push(format!("  {field} = {{{}}}", bibtex_value(&venue)));
    }
    for (paper_field, bib_field) in [("doi", "doi"), ("isbn", "isbn"), ("url", "url")] {
        let value = paper_string(paper, paper_field);
        if !value.is_empty() {
            fields.push(format!("  {bib_field} = {{{}}}", bibtex_value(&value)));
        }
    }
    let abstract_text = paper_string(paper, "abstract");
    if !abstract_text.is_empty() {
        fields.push(format!("  abstract = {{{}}}", bibtex_value(&abstract_text)));
    }
    let tags = paper["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    if !tags.is_empty() {
        fields.push(format!("  keywords = {{{}}}", bibtex_value(&tags.join(", "))));
    }
    format!("@{}{{{},\n{}\n}}", bibtex_entry_type(&item_type, biblatex), entry.citation_key, fields.join(",\n"))
}

fn ris_type(item_type: &str) -> &'static str {
    match item_type {
        "article" => "JOUR",
        "book" => "BOOK",
        "bookSection" => "CHAP",
        "conferencePaper" => "CONF",
        "thesis" => "THES",
        "report" => "RPRT",
        "webpage" => "ELEC",
        _ => "GEN",
    }
}

fn ris_entry(entry: &BibliographyExportEntry<'_>) -> String {
    let paper = entry.paper;
    let mut lines = vec![format!("TY  - {}", ris_type(&paper_string(paper, "itemType")))];
    lines.push(format!("ID  - {}", entry.citation_key));
    lines.push(format!("TI  - {}", paper_string(paper, "title")));
    lines.extend(paper_authors(paper).into_iter().map(|author| format!("AU  - {author}")));
    if let Some(year) = paper["year"].as_u64() { lines.push(format!("PY  - {year}")); }
    let venue = paper_string(paper, "venue");
    if !venue.is_empty() { lines.push(format!("JO  - {venue}")); }
    for (paper_field, ris_field) in [("doi", "DO"), ("isbn", "SN"), ("url", "UR"), ("abstract", "AB")] {
        let value = paper_string(paper, paper_field);
        if !value.is_empty() { lines.push(format!("{ris_field}  - {value}")); }
    }
    lines.push("ER  - ".to_string());
    lines.join("\n")
}

fn csl_type(item_type: &str) -> &'static str {
    match item_type {
        "article" => "article-journal",
        "book" => "book",
        "bookSection" => "chapter",
        "conferencePaper" => "paper-conference",
        "thesis" => "thesis",
        "report" => "report",
        "webpage" => "webpage",
        "dataset" => "dataset",
        "preprint" => "article",
        _ => "article",
    }
}

fn csl_person(author: &str) -> Value {
    let author = author.trim();
    if let Some((family, given)) = author.split_once(',') {
        return json!({ "family": family.trim(), "given": given.trim() });
    }
    let mut parts = author.split_whitespace().collect::<Vec<_>>();
    if parts.len() >= 2 {
        let family = parts.pop().unwrap_or_default();
        return json!({ "family": family, "given": parts.join(" ") });
    }
    json!({ "literal": author })
}

fn csl_json_entry(entry: &BibliographyExportEntry<'_>) -> Value {
    let paper = entry.paper;
    let mut item = serde_json::Map::new();
    item.insert("id".to_string(), Value::String(entry.citation_key.clone()));
    item.insert("citation-key".to_string(), Value::String(entry.citation_key.clone()));
    item.insert("type".to_string(), Value::String(csl_type(&paper_string(paper, "itemType")).to_string()));
    item.insert("title".to_string(), Value::String(paper_string(paper, "title")));
    let authors = paper_authors(paper);
    if !authors.is_empty() {
        item.insert("author".to_string(), Value::Array(authors.iter().map(|author| csl_person(author)).collect()));
    }
    if let Some(year) = paper["year"].as_u64() {
        item.insert("issued".to_string(), json!({ "date-parts": [[year]] }));
    }
    let venue = paper_string(paper, "venue");
    if !venue.is_empty() { item.insert("container-title".to_string(), Value::String(venue)); }
    for (paper_field, csl_field) in [("doi", "DOI"), ("isbn", "ISBN"), ("url", "URL"), ("abstract", "abstract")] {
        let value = paper_string(paper, paper_field);
        if !value.is_empty() { item.insert(csl_field.to_string(), Value::String(value)); }
    }
    Value::Object(item)
}

/// Create a local-first record for an already copied PDF. Metadata extraction
/// can enrich it later, but the attachment is immediately durable and linked
/// to one canonical row.
pub fn library_create_pdf_record_at(
    base: &Path,
    title: &str,
    relative_path: &str,
    bytes: u64,
    doi: Option<&str>,
) -> Result<LiteraturePdfRecordImportReport, String> {
    let title = collapse_whitespace(title);
    if title.is_empty() { return Err("a PDF record needs a title".to_string()); }
    let item = json!({
        "itemType": "other",
        "title": title,
        "DOI": doi.map(str::trim).filter(|value| !value.is_empty()),
        "url": Value::Null,
        "tags": [],
    });
    let (record, mut paper) = canonical_record_from_standard_json(&item)
        .ok_or_else(|| "could not construct a PDF record".to_string())?;
    paper["source"] = Value::String("local_pdf".to_string());
    paper["pdf"] = json!({ "status": "downloaded", "path": relative_path, "bytes": bytes });
    let mut store = runtime::open_literature_store_at(base)?;
    if !store.has_legacy_library_bootstrap()? {
        drop(store); let _ = library_load_at(base)?; store = runtime::open_literature_store_at(base)?;
    }
    let result = store.upsert_canonical_record(&record)?;
    store.update_legacy_library_paper(&result.record.id, &paper)?;
    store.mark_legacy_library_bootstrap()?;
    let projection = project_legacy_library(&store.legacy_library_projection_meta()?, &store.list_canonical_records()?, &store.list_search_runs(None)?);
    write_library_file(&library_path_at(base), &projection)?;
    Ok(LiteraturePdfRecordImportReport { record_id: result.record.id, inserted: result.inserted, merged_record_ids: result.merged_record_ids })
}

fn standard_bibliography_items(format: &str, bytes: &[u8]) -> Result<(String, Vec<Value>), String> {
    match format {
        "json" | "zotero-json" | "csl-json" => {
            let value: Value = serde_json::from_slice(bytes)
                .map_err(|error| format!("invalid bibliography JSON: {error}"))?;
            let items = value.as_array().cloned().or_else(|| value["items"].as_array().cloned())
                .ok_or_else(|| "a Zotero or CSL-JSON export must contain an item array".to_string())?;
            let resolved = if items.iter().any(|item| item.get("itemType").is_some()) { "zotero-json" } else { "csl-json" };
            Ok((resolved.to_string(), items))
        }
        "ris" => Ok(("ris".to_string(), parse_ris_items(std::str::from_utf8(bytes).map_err(|_| "RIS must be UTF-8 text")?))),
        "bib" | "bibtex" | "biblatex" => Ok(("bibtex".to_string(), parse_bibtex_items(std::str::from_utf8(bytes).map_err(|_| "BibTeX must be UTF-8 text")?))),
        other => Err(format!("unsupported bibliography format: {other}")),
    }
}

fn parse_ris_items(input: &str) -> Vec<Value> {
    let mut records = Vec::new();
    let mut fields = BTreeMap::<String, Vec<String>>::new();
    let finish = |fields: &mut BTreeMap<String, Vec<String>>, records: &mut Vec<Value>| {
        let title = fields.get("TI").or_else(|| fields.get("T1")).and_then(|values| values.first()).cloned().unwrap_or_default();
        if title.trim().is_empty() { fields.clear(); return; }
        let type_code = fields.get("TY").and_then(|values| values.first()).map(String::as_str).unwrap_or("");
        let item_type = ris_item_type(type_code);
        let authors = fields.get("AU").or_else(|| fields.get("A1")).cloned().unwrap_or_default();
        let tags = fields.get("KW").cloned().unwrap_or_default();
        records.push(json!({
            "itemType": item_type,
            "title": title,
            "author": authors,
            "date": fields.get("PY").or_else(|| fields.get("Y1")).and_then(|values| values.first()),
            "publicationTitle": fields.get("JO").or_else(|| fields.get("T2")).or_else(|| fields.get("JF")).and_then(|values| values.first()),
            "DOI": fields.get("DO").and_then(|values| values.first()),
            "ISBN": fields.get("SN").and_then(|values| values.first()),
            "url": fields.get("UR").and_then(|values| values.first()),
            "abstract": fields.get("AB").and_then(|values| values.first()),
            "tags": tags,
        }));
        fields.clear();
    };
    for raw in input.lines() {
        let line = raw.trim_end();
        if line.len() < 6 || line.as_bytes().get(2) != Some(&b' ') || line.as_bytes().get(3) != Some(&b' ') || line.as_bytes().get(4) != Some(&b'-') { continue; }
        let key = line[..2].to_ascii_uppercase();
        let value = line[6..].trim().to_string();
        if key == "ER" { finish(&mut fields, &mut records); } else { fields.entry(key).or_default().push(value); }
    }
    finish(&mut fields, &mut records);
    records
}

fn ris_item_type(code: &str) -> &'static str {
    match code.trim().to_ascii_uppercase().as_str() {
        "JOUR" | "JFULL" | "EJOUR" => "article",
        "CONF" | "CPAPER" => "conferencePaper",
        "BOOK" | "EBOOK" => "book",
        "CHAP" => "bookSection",
        "THES" | "DISS" => "thesis",
        "RPRT" | "REPORT" => "report",
        "WEB" | "ELEC" => "webpage",
        _ => "other",
    }
}

fn parse_bibtex_items(input: &str) -> Vec<Value> {
    let mut items = Vec::new();
    let bytes = input.as_bytes();
    let mut cursor = 0;
    while let Some(relative) = input[cursor..].find('@') {
        let start = cursor + relative + 1;
        let type_end = input[start..].find(|character: char| character == '{' || character == '(').map(|offset| start + offset);
        let Some(type_end) = type_end else { break; };
        let entry_type = input[start..type_end].trim().to_ascii_lowercase();
        let opener = bytes[type_end] as char;
        let closer = if opener == '{' { '}' } else { ')' };
        let mut depth = 0_i32;
        let mut end = None;
        for (offset, character) in input[type_end..].char_indices() {
            if character == opener { depth += 1; }
            if character == closer { depth -= 1; if depth == 0 { end = Some(type_end + offset); break; } }
        }
        let Some(end) = end else { break; };
        let body = &input[type_end + 1..end];
        if let Some(item) = bibtex_item(&entry_type, body) { items.push(item); }
        cursor = end + 1;
    }
    items
}

fn bibtex_item(entry_type: &str, body: &str) -> Option<Value> {
    let (_, fields) = body.split_once(',')?;
    let mut values = BTreeMap::new();
    for field in split_bibtex_fields(fields) {
        let Some((key, value)) = field.split_once('=') else { continue; };
        values.insert(key.trim().to_ascii_lowercase(), unquote_bibtex(value.trim()));
    }
    let title = values.get("title")?.trim();
    if title.is_empty() { return None; }
    let authors = values.get("author").map(|value| value.split(" and ").map(str::trim).filter(|name| !name.is_empty()).collect::<Vec<_>>()).unwrap_or_default();
    let tags = values.get("keywords").map(|value| value.split([',', ';']).map(str::trim).filter(|tag| !tag.is_empty()).collect::<Vec<_>>()).unwrap_or_default();
    Some(json!({
        "itemType": bibtex_item_type(entry_type), "title": title, "author": authors,
        "date": values.get("year"), "publicationTitle": values.get("journal").or_else(|| values.get("booktitle")).or_else(|| values.get("publisher")),
        "DOI": values.get("doi"), "ISBN": values.get("isbn"), "url": values.get("url"), "abstract": values.get("abstract"),
        "citationKey": values.get("citationkey").or_else(|| values.get("key")), "tags": tags,
    }))
}

fn bibtex_item_type(entry_type: &str) -> &'static str {
    match entry_type { "article" => "article", "book" | "mvbook" => "book", "inbook" | "incollection" => "bookSection", "inproceedings" | "conference" | "proceedings" => "conferencePaper", "phdthesis" | "mastersthesis" | "thesis" => "thesis", "techreport" | "report" => "report", "online" | "www" => "webpage", "unpublished" | "preprint" => "preprint", _ => "other" }
}

fn split_bibtex_fields(input: &str) -> Vec<&str> {
    let mut fields = Vec::new(); let mut start = 0; let mut depth = 0_i32; let mut quoted = false;
    for (index, character) in input.char_indices() {
        match character { '"' if depth == 0 => quoted = !quoted, '{' if !quoted => depth += 1, '}' if !quoted => depth -= 1, ',' if !quoted && depth == 0 => { fields.push(input[start..index].trim()); start = index + 1; }, _ => {} }
    }
    if !input[start..].trim().is_empty() { fields.push(input[start..].trim()); }
    fields
}

fn unquote_bibtex(value: &str) -> String {
    value.trim().trim_matches('"').trim_start_matches('{').trim_end_matches('}').replace(['{', '}'], "").trim().to_string()
}

fn canonical_record_from_standard_json(item: &Value) -> Option<(runtime::CanonicalRecord, Value)> {
    let title = item["title"].as_str().map(collapse_whitespace).filter(|value| !value.is_empty())?;
    let item_type = item["itemType"].as_str().or_else(|| item["type"].as_str()).unwrap_or("article");
    if matches!(item_type, "attachment" | "note" | "annotation") { return None; }
    let authors = item["creators"].as_array().or_else(|| item["author"].as_array()).map(|people| people.iter().filter_map(|person| {
        person.as_str().map(str::to_string).or_else(|| {
            let family = person["lastName"].as_str().or_else(|| person["family"].as_str()).unwrap_or("").trim();
            let given = person["firstName"].as_str().or_else(|| person["given"].as_str()).unwrap_or("").trim();
            let literal = person["name"].as_str().unwrap_or("").trim();
            let joined = if !literal.is_empty() { literal.to_string() } else { format!("{given} {family}").trim().to_string() };
            (!joined.is_empty()).then_some(joined)
        })
    }).collect()).unwrap_or_default();
    let doi = non_empty(item["DOI"].as_str().or_else(|| item["doi"].as_str()).unwrap_or(""));
    let isbn = non_empty(item["ISBN"].as_str().or_else(|| item["isbn"].as_str()).unwrap_or(""));
    let url = non_empty(item["url"].as_str().or_else(|| item["URL"].as_str()).unwrap_or(""));
    let year = item["date"].as_str().and_then(|value| value.get(0..4)).and_then(|value| value.parse().ok())
        .or_else(|| item["issued"]["date-parts"].get(0).and_then(|part| part.get(0)).and_then(Value::as_u64).and_then(|value| u32::try_from(value).ok()));
    let venue = item["publicationTitle"].as_str().or_else(|| item["container-title"].as_str()).or_else(|| item["bookTitle"].as_str()).unwrap_or("").trim().to_string();
    let abstract_text = item["abstractNote"].as_str().or_else(|| item["abstract"].as_str()).unwrap_or("").to_string();
    let tags = item["tags"].as_array().map(|tags| tags.iter().filter_map(|tag| {
        tag.as_str().map(str::to_string).or_else(|| tag["tag"].as_str().map(str::to_string))
    }).collect::<Vec<_>>()).unwrap_or_default();
    let now = runtime::now_iso8601();
    let id = runtime::canonical_record_id(doi.as_deref(), None, None, &title);
    let paper = json!({ "id": id, "title": title, "authors": authors, "year": year, "venue": venue, "doi": doi, "url": url, "abstract": abstract_text, "itemType": item_type, "isbn": isbn, "citationKey": item["citationKey"].as_str().or_else(|| item["citation-key"].as_str()), "tags": tags, "collectionIds": [], "searchIds": [], "stage": "inbox", "starred": false, "unread": true, "source": "standard_import", "addedAt": now, "pdf": { "status": "none" }, "evidence": [], "answerChains": [], "pdfAnnotations": [] });
    Some((runtime::CanonicalRecord { schema_version: runtime::LITERATURE_SCHEMA_VERSION, id, revision: 1, normalized_title: runtime::normalized_record_title(&title), title, authors, year, venue, abstract_text, url, pdf_url: None, identifiers: runtime::RecordIdentifiers { doi, arxiv_id: None, scopus_id: None, source_ids: BTreeMap::new() }, provenance: vec![runtime::RecordProvenance { source: "standard_import".to_string(), external_id: None, search_run_id: None, artifact_id: None, observed_at: now.clone() }], observations: vec![runtime::RecordObservation { source: "standard_import".to_string(), external_id: None, artifact_id: None, observed_at: now.clone(), fields: item.clone() }], field_conflicts: Vec::new(), metadata: json!({ "standard": { "itemType": item_type, "isbn": isbn, "citationKey": item["citationKey"].as_str().or_else(|| item["citation-key"].as_str()) } }), created_at: now.clone(), updated_at: now }, paper))
}

pub fn empty_library() -> Value {
    json!({
        "version": 1,
        "papers": [],
        "searches": [],
        "collections": [],
        "reviewTasks": [],
        "screenRuns": []
    })
}

pub fn library_load_at(base: &Path) -> Result<Value, String> {
    let path = library_path_at(base);
    let mut store = runtime::open_literature_store_at(base)?;
    let bootstrapped = store.has_legacy_library_bootstrap()?;
    let legacy = if bootstrapped {
        Value::Null
    } else {
        load_legacy_library_file(&path)?
    };
    if !bootstrapped && path.exists() {
        store.import_legacy_library(&path)?;
    } else if !bootstrapped {
        // There is no legacy primary file to import. Mark the bridge active
        // before writing the first canonical projection, otherwise a later
        // legacy save would mistake that projection for an external library.
        store.mark_legacy_library_bootstrap()?;
    }
    let projection = project_legacy_library(
        &store.legacy_library_projection_meta()?,
        &store.list_canonical_records()?,
        &store.list_search_runs(None)?,
    );
    if projection["papers"]
        .as_array()
        .is_some_and(|papers| !papers.is_empty())
        || legacy["papers"]
            .as_array()
            .is_some_and(|papers| !papers.is_empty())
    {
        write_library_file(&path, &projection)?;
    }
    Ok(projection)
}

pub fn library_save_at(base: &Path, library: &Value) -> Result<(), String> {
    if !library.is_object() {
        return Err("library must be a JSON object".to_string());
    }
    let path = library_path_at(base);
    let mut store = runtime::open_literature_store_at(base)?;
    if !store.has_legacy_library_bootstrap()? && path.exists() {
        store.import_legacy_library(&path)?;
    }
    store.sync_legacy_library_snapshot(library)?;
    let projection = project_legacy_library(
        &store.legacy_library_projection_meta()?,
        &store.list_canonical_records()?,
        &store.list_search_runs(None)?,
    );
    write_library_file(&path, &projection)
}

fn load_legacy_library_file(path: &Path) -> Result<Value, String> {
    let backup = path.with_extension("json.bak");
    if !path.exists() {
        return if backup.exists() {
            read_json_file(&backup)
        } else {
            Ok(empty_library())
        };
    }
    match read_json_file(path) {
        Ok(library) => Ok(library),
        Err(primary_error) if backup.exists() => read_json_file(&backup).map_err(|backup_error| {
            format!("{primary_error}; backup recovery failed: {backup_error}")
        }),
        Err(error) => Err(error),
    }
}

fn write_library_file(path: &Path, library: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let data = serde_json::to_vec_pretty(library).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    let had_existing = path.exists();
    if had_existing {
        std::fs::copy(&path, &backup).map_err(|e| e.to_string())?;
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    if let Err(error) = std::fs::rename(&tmp, &path) {
        if had_existing {
            let _ = std::fs::copy(&backup, &path);
        }
        return Err(format!("failed to replace library.json: {error}"));
    }
    Ok(())
}

fn project_legacy_library(
    metadata: &Value,
    records: &[runtime::CanonicalRecord],
    runs: &[runtime::SearchRun],
) -> Value {
    let mut library = metadata.as_object().cloned().unwrap_or_default();
    library.insert("version".to_string(), Value::from(1));
    let mut search_ids_by_record = BTreeMap::<String, BTreeSet<String>>::new();
    for run in runs {
        let search_id = format!("search-run:{}", run.id);
        for record_id in &run.record_ids {
            search_ids_by_record
                .entry(record_id.clone())
                .or_default()
                .insert(search_id.clone());
        }
    }
    let papers = records
        .iter()
        .filter(|record| record.metadata["legacyLibraryHidden"].as_bool() != Some(true))
        .map(|record| project_legacy_paper(record, search_ids_by_record.get(&record.id)))
        .collect::<Vec<_>>();
    library.insert("papers".to_string(), Value::Array(papers));
    let mut searches = library
        .get("searches")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let known_run_ids = searches
        .iter()
        .filter_map(|entry| entry["searchRunId"].as_str().map(str::to_string))
        .collect::<std::collections::BTreeSet<_>>();
    for run in runs {
        if known_run_ids.contains(&run.id) {
            continue;
        }
        searches.push(json!({
            "id": format!("search-run:{}", run.id),
            "searchRunId": run.id,
            "protocolId": run.protocol_id,
            "query": projected_search_query(run),
            "ranAt": run.started_at,
            "completedAt": run.completed_at,
            "status": run.status,
            "resultCount": run.record_ids.len(),
            "newCount": 0,
            "sources": run.source_attempts.iter().map(|attempt| attempt.source.clone()).collect::<BTreeSet<_>>(),
        }));
    }
    library.insert("searches".to_string(), Value::Array(searches));
    library
        .entry("collections".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    library
        .entry("reviewTasks".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    library
        .entry("screenRuns".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    Value::Object(library)
}

fn projected_search_query(run: &runtime::SearchRun) -> String {
    const QUERY_POINTERS: &[&str] = &[
        "/query",
        "/params/search",
        "/params/query",
        "/params/query.bibliographic",
        "/params/query.title",
    ];
    run.source_attempts
        .iter()
        .rev()
        .find_map(|attempt| {
            QUERY_POINTERS.iter().find_map(|pointer| {
                attempt
                    .request
                    .pointer(pointer)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|query| !query.is_empty())
                    .map(str::to_string)
            })
        })
        .unwrap_or_else(|| format!("SearchRun {}", run.id))
}

fn project_legacy_paper(
    record: &runtime::CanonicalRecord,
    projected_search_ids: Option<&BTreeSet<String>>,
) -> Value {
    let mut paper = record.metadata["legacyLibrary"]
        .as_object()
        .cloned()
        .or_else(|| {
            record
                .metadata
                .as_object()
                .cloned()
                .filter(|value| value.contains_key("stage"))
        })
        .unwrap_or_default();
    paper.insert("id".to_string(), Value::String(record.id.clone()));
    paper.insert("title".to_string(), Value::String(record.title.clone()));
    paper.insert("authors".to_string(), json!(record.authors));
    paper.insert("year".to_string(), json!(record.year));
    paper.insert("venue".to_string(), Value::String(record.venue.clone()));
    paper.insert("doi".to_string(), json!(record.identifiers.doi));
    paper.insert("arxivId".to_string(), json!(record.identifiers.arxiv_id));
    paper.insert("url".to_string(), json!(record.url));
    paper.insert(
        "abstract".to_string(),
        Value::String(record.abstract_text.clone()),
    );
    if paper
        .get("source")
        .and_then(Value::as_str)
        .map(|source| source.trim().is_empty())
        .unwrap_or(true)
    {
        paper.insert(
            "source".to_string(),
            Value::String(
                record
                    .provenance
                    .first()
                    .map(|provenance| provenance.source.clone())
                    .unwrap_or_else(|| "canonical_store".to_string()),
            ),
        );
    }
    paper
        .entry("tags".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    paper
        .entry("collectionIds".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let mut search_ids = paper
        .get("searchIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    if let Some(projected_search_ids) = projected_search_ids {
        search_ids.extend(projected_search_ids.iter().cloned());
    }
    paper.insert("searchIds".to_string(), json!(search_ids));
    paper
        .entry("stage".to_string())
        .or_insert_with(|| Value::String("inbox".to_string()));
    paper
        .entry("starred".to_string())
        .or_insert_with(|| Value::Bool(false));
    paper
        .entry("unread".to_string())
        .or_insert_with(|| Value::Bool(true));
    paper
        .entry("addedAt".to_string())
        .or_insert_with(|| Value::String(record.created_at.clone()));
    paper
        .entry("evidence".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let mut pdf = paper
        .get("pdf")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    pdf.entry("status".to_string())
        .or_insert_with(|| Value::String("none".to_string()));
    if let Some(url) = &record.pdf_url {
        pdf.insert("url".to_string(), Value::String(url.clone()));
    }
    paper.insert("pdf".to_string(), Value::Object(pdf));
    Value::Object(paper)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertStats {
    pub search_id: Option<String>,
    pub added: usize,
    pub merged: usize,
    pub total: usize,
    pub library_path: String,
}

/// Refresh the legacy JSON projection for records that have already been
/// committed to the canonical store. This compatibility endpoint deliberately
/// cannot turn arbitrary Chat output into a second ingestion path.
pub fn library_upsert_at(
    base: &Path,
    records: &[Value],
    _search: Option<&UpsertSearch>,
) -> Result<UpsertStats, String> {
    let store = runtime::open_literature_store_at(base)?;
    for record in records {
        let record_id = record_str(record, "id");
        if record_id.is_empty() {
            return Err("LiteratureLibraryUpsert requires canonical record ids; use LiteratureSearch to create a SearchRun first".to_string());
        }
        if store.load_canonical_record(record_id)?.is_none() {
            return Err(format!(
                "record {record_id:?} is not in the canonical literature store; LiteratureLibraryUpsert cannot ingest untracked records. Use LiteratureSearch or a saved SearchProtocol instead."
            ));
        }
    }
    drop(store);
    let library = library_load_at(base)?;
    let total = library["papers"].as_array().map_or(0, Vec::len);
    Ok(UpsertStats {
        search_id: None,
        added: 0,
        merged: records.len(),
        total,
        library_path: library_path_at(base).to_string_lossy().into_owned(),
    })
}

fn record_str<'a>(record: &'a Value, key: &str) -> &'a str {
    record[key].as_str().unwrap_or_default().trim()
}

fn record_title(record: &Value) -> String {
    collapse_whitespace(record_str(record, "title"))
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

// ── Remote search ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaper {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<u32>,
    pub venue: String,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    #[serde(rename = "abstract")]
    pub summary: String,
    pub url: Option<String>,
    pub pdf_url: Option<String>,
    pub source: String,
    pub published: Option<String>,
    pub cited_by: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCount {
    pub source: String,
    pub count: usize,
}

#[derive(Debug)]
pub struct SearchOutcome {
    pub papers: Vec<RemotePaper>,
    pub warnings: Vec<String>,
    pub source_counts: Vec<SourceCount>,
}

/// A source-level adapter result. It carries everything the durable
/// `SearchRun` needs without exposing credentials: exact sanitized requests,
/// raw provider bodies, count/quota metadata, and normalized records.
#[derive(Debug)]
struct AdapterSearchOutcome {
    papers: Vec<RemotePaper>,
    request: Value,
    raw_artifacts: Vec<AdapterArtifact>,
    hit_count: Option<u64>,
    quota: Value,
    warnings: Vec<String>,
    coverage_note: Option<String>,
}

#[derive(Debug)]
struct AdapterArtifact {
    kind: String,
    extension: String,
    media_type: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy)]
struct AdapterAvailability {
    status: &'static str,
    execution_mode: &'static str,
    coverage_note: &'static str,
    quota_policy: &'static str,
}

fn adapter_availability(source: &str) -> AdapterAvailability {
    match source.trim().to_ascii_lowercase().as_str() {
        "scopus" => AdapterAvailability {
            status: "available",
            execution_mode: "confirmed_network_search",
            coverage_note: "Searches Scopus with COMPLETE first. A 401/403 entitlement response is preserved and followed once by STANDARD.",
            quota_policy: "Uses SCOPUS_API_KEY; captures exposed Elsevier rate-limit headers."
        },
        "openalex" => AdapterAvailability {
            status: "available",
            execution_mode: "confirmed_network_search",
            coverage_note: "Open metadata coverage; abstract and OA fields depend on the indexed work record.",
            quota_policy: "Captures exposed rate-limit headers; OPENALEX_MAILTO remains request-only."
        },
        "semantic-scholar" | "semantic_scholar" | "semanticscholar" => AdapterAvailability {
            status: "available",
            execution_mode: "confirmed_network_search",
            coverage_note: "Metadata and citation coverage from Semantic Scholar; provider rate limits can be stricter without an API key.",
            quota_policy: "Uses optional SEMANTIC_SCHOLAR_API_KEY and captures exposed rate-limit headers."
        },
        "crossref" => AdapterAvailability {
            status: "available",
            execution_mode: "confirmed_network_search",
            coverage_note: "DOI metadata coverage; publisher abstracts and PDF links may be absent.",
            quota_policy: "Captures exposed rate-limit headers when supplied."
        },
        "arxiv" => AdapterAvailability {
            status: "available",
            execution_mode: "confirmed_network_search",
            coverage_note: "Preprint supplement, capped below venue sources to avoid crowding them out.",
            quota_policy: "Captures exposed rate-limit headers when supplied."
        },
        _ => AdapterAvailability {
            status: "not_implemented",
            execution_mode: "not_available",
            coverage_note: "No registered adapter exists for this source.",
            quota_policy: "Unavailable."
        },
    }
}

fn adapter_request_preview(source: &str, query: &str, limit: usize) -> Value {
    match source.trim().to_ascii_lowercase().as_str() {
        "scopus" => json!({
            "method": "GET",
            "url": "https://api.elsevier.com/content/search/scopus",
            "query": { "query": scopus_query(query), "count": limit.min(SCOPUS_PAGE_MAX), "start": 0, "view": "COMPLETE" },
            "authentication": "SCOPUS_API_KEY (redacted)",
            "fallback": "STANDARD on 401/403 entitlement response"
        }),
        "openalex" => json!({
            "method": "GET",
            "url": "https://api.openalex.org/works",
            "query": {
                "search": query,
                "per-page": limit,
                "select": "id,doi,title,publication_year,publication_date,authorships,primary_location,best_oa_location,open_access,cited_by_count,abstract_inverted_index"
            },
        }),
        "semantic-scholar" | "semantic_scholar" | "semanticscholar" => json!({
            "method": "GET",
            "url": "https://api.semanticscholar.org/graph/v1/paper/search",
            "query": {
                "query": query,
                "limit": limit,
                "fields": "paperId,title,authors,year,venue,abstract,externalIds,url,openAccessPdf,citationCount,publicationDate"
            },
            "authentication": "SEMANTIC_SCHOLAR_API_KEY when configured (redacted)"
        }),
        "crossref" => json!({
            "method": "GET",
            "url": "https://api.crossref.org/works",
            "query": {
                "query": query,
                "rows": limit,
                "select": "DOI,title,author,issued,container-title,abstract,URL,link,is-referenced-by-count"
            },
        }),
        "arxiv" => json!({
            "method": "GET",
            "url": "https://export.arxiv.org/api/query",
            "query": { "search_query": query, "start": 0, "max_results": supplement_limit(limit) },
        }),
        _ => json!({ "query": query, "maxResults": limit }),
    }
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Debug)]
struct ProviderResponse {
    status: u16,
    headers: Value,
    body: Vec<u8>,
}

fn capture_provider_response(
    response: reqwest::blocking::Response,
) -> Result<ProviderResponse, String> {
    let status = response.status().as_u16();
    let mut headers = serde_json::Map::new();
    for name in [
        "content-type",
        "retry-after",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
        "x-rate-limit-limit",
        "x-rate-limit-remaining",
        "x-rate-limit-reset",
        "x-els-status",
        "x-els-reqid",
    ] {
        if let Some(value) = response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
        {
            headers.insert(name.to_string(), Value::String(value.to_string()));
        }
    }
    let body = response
        .bytes()
        .map_err(|error| error.to_string())?
        .to_vec();
    Ok(ProviderResponse {
        status,
        headers: Value::Object(headers),
        body,
    })
}

fn require_success(response: &ProviderResponse, provider: &str) -> Result<(), String> {
    if (200..300).contains(&response.status) {
        return Ok(());
    }
    let detail = std::str::from_utf8(&response.body)
        .ok()
        .map(str::trim)
        .filter(|body| !body.is_empty())
        .map(|body| body.chars().take(240).collect::<String>())
        .unwrap_or_default();
    let suffix = (!detail.is_empty()).then(|| format!(": {detail}"));
    Err(format!(
        "{provider} HTTP {}{}",
        response.status,
        suffix.unwrap_or_default()
    ))
}

fn provider_artifact(
    kind: &str,
    extension: &str,
    media_type: &str,
    response: &ProviderResponse,
) -> AdapterArtifact {
    AdapterArtifact {
        kind: kind.to_string(),
        extension: extension.to_string(),
        media_type: media_type.to_string(),
        bytes: response.body.clone(),
    }
}

fn response_quota(response: &ProviderResponse) -> Value {
    json!({ "headers": response.headers })
}

/// The metadata engines `LiteratureSearch` can query, in canonical-priority
/// order: the published-venue core (Scopus → OpenAlex → Crossref) runs before
/// arXiv so dedupe keeps the peer-reviewed record and arXiv only supplements.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Engine {
    Scopus,
    OpenAlex,
    SemanticScholar,
    Crossref,
    Arxiv,
}

impl Engine {
    const fn source_name(self) -> &'static str {
        match self {
            Self::Scopus => "scopus",
            Self::OpenAlex => "openalex",
            Self::SemanticScholar => "semantic-scholar",
            Self::Crossref => "crossref",
            Self::Arxiv => "arxiv",
        }
    }
}

/// Resolve which engines to run, always in priority order regardless of the
/// order `sources` lists them. Empty `sources` means the full default set —
/// Scopus joins it only when its key is available; an explicit `scopus`
/// request always runs (and surfaces the missing key as a warning downstream).
/// arXiv always runs last as the preprint supplement.
fn planned_engines(sources: &[String], scopus_available: bool) -> Vec<Engine> {
    let explicit = |name: &str| {
        sources
            .iter()
            .any(|source| source.eq_ignore_ascii_case(name))
    };
    let wants = |name: &str| sources.is_empty() || explicit(name);
    let mut engines = Vec::new();
    if explicit("scopus") || (sources.is_empty() && scopus_available) {
        engines.push(Engine::Scopus);
    }
    if wants("openalex") {
        engines.push(Engine::OpenAlex);
    }
    if wants("semantic-scholar") || explicit("semantic_scholar") || explicit("semanticscholar") {
        engines.push(Engine::SemanticScholar);
    }
    if wants("crossref") {
        engines.push(Engine::Crossref);
    }
    if wants("arxiv") {
        engines.push(Engine::Arxiv);
    }
    engines
}

/// arXiv is a supplement — cap its result count so preprints don't crowd out
/// the published-venue core when many overlap.
fn supplement_limit(limit: usize) -> usize {
    limit.min(ARXIV_SUPPLEMENT_MAX)
}

/// Blocking remote metadata search, run in canonical-priority order (Scopus →
/// OpenAlex → Crossref → arXiv) so dedupe keeps the published-venue record and
/// arXiv only fills the gaps (e.g. an open PDF link). Empty `sources` means the
/// full default set — Scopus joins it only when `SCOPUS_API_KEY` is set, but an
/// explicit `"scopus"` request always runs (and surfaces the missing key as a
/// warning).
pub fn search_remote(
    query: &str,
    sources: &[String],
    limit: usize,
) -> Result<SearchOutcome, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("search query is empty".to_string());
    }
    let client = http_client()?;
    let mut papers = Vec::new();
    let mut warnings = Vec::new();
    let mut source_counts = Vec::new();
    let mut run = |label: &str, batch: Result<AdapterSearchOutcome, String>| match batch {
        Ok(batch) => {
            source_counts.push(SourceCount {
                source: label.to_string(),
                count: batch.papers.len(),
            });
            warnings.extend(batch.warnings);
            papers.extend(batch.papers);
        }
        Err(error) => warnings.push(format!("{label}: {error}")),
    };
    for engine in planned_engines(sources, scopus_api_key().is_ok()) {
        match engine {
            Engine::Scopus => run("Scopus", search_scopus(&client, query, limit)),
            Engine::OpenAlex => run("OpenAlex", search_openalex(&client, query, limit)),
            Engine::SemanticScholar => run(
                "Semantic Scholar",
                search_semantic_scholar(&client, query, limit),
            ),
            Engine::Crossref => run("Crossref", search_crossref(&client, query, limit)),
            Engine::Arxiv => run(
                "arXiv",
                search_arxiv(&client, query, supplement_limit(limit)),
            ),
        }
    }
    if papers.is_empty() && !warnings.is_empty() {
        return Err(warnings.join("; "));
    }
    Ok(SearchOutcome {
        papers: dedupe(papers),
        warnings,
        source_counts,
    })
}

fn search_source_with_audit(
    query: &str,
    source: &str,
    limit: usize,
) -> Result<AdapterSearchOutcome, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("search query is empty".to_string());
    }
    let client = http_client()?;
    match source.trim().to_ascii_lowercase().as_str() {
        "scopus" => search_scopus(&client, query, limit),
        "openalex" => search_openalex(&client, query, limit),
        "semantic-scholar" | "semantic_scholar" | "semanticscholar" => {
            search_semantic_scholar(&client, query, limit)
        }
        "crossref" => search_crossref(&client, query, limit),
        "arxiv" => search_arxiv(&client, query, supplement_limit(limit)),
        _ => Err(format!("source adapter is not implemented: {source}")),
    }
}

fn search_arxiv(
    client: &reqwest::blocking::Client,
    query: &str,
    limit: usize,
) -> Result<AdapterSearchOutcome, String> {
    let request = adapter_request_preview("arxiv", query, limit);
    let response = client
        .get("https://export.arxiv.org/api/query")
        .query(&[
            ("search_query", query),
            ("start", "0"),
            ("max_results", &limit.to_string()),
            ("sortBy", "relevance"),
            ("sortOrder", "descending"),
        ])
        .send()
        .map_err(|e| e.to_string())?;
    let response = capture_provider_response(response)?;
    require_success(&response, "arXiv")?;
    let body = std::str::from_utf8(&response.body).map_err(|error| error.to_string())?;
    let (papers, hit_count) = parse_arxiv_feed_with_count(body)?;
    Ok(AdapterSearchOutcome {
        papers,
        request,
        raw_artifacts: vec![provider_artifact(
            "provider-response",
            "xml",
            "application/atom+xml",
            &response,
        )],
        hit_count,
        quota: response_quota(&response),
        warnings: Vec::new(),
        coverage_note: Some(
            "arXiv is a preprint supplement and its result cap is intentionally lower than venue sources."
                .to_string(),
        ),
    })
}

#[cfg(test)]
fn parse_arxiv_feed(xml: &str) -> Result<Vec<RemotePaper>, String> {
    Ok(parse_arxiv_feed_with_count(xml)?.0)
}

fn parse_arxiv_feed_with_count(xml: &str) -> Result<(Vec<RemotePaper>, Option<u64>), String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("invalid Atom feed: {e}"))?;
    let hit_count = doc
        .descendants()
        .find(|node| node.tag_name().name() == "totalResults")
        .and_then(|node| node.text())
        .and_then(|value| value.trim().parse::<u64>().ok());
    let mut papers = Vec::new();
    for entry in doc
        .descendants()
        .filter(|node| node.has_tag_name((ATOM_NS, "entry")))
    {
        let child_text = |tag: &str| -> String {
            entry
                .children()
                .find(|node| node.has_tag_name((ATOM_NS, tag)))
                .and_then(|node| node.text())
                .map(collapse_whitespace)
                .unwrap_or_default()
        };
        let arxiv_id = child_text("id")
            .rsplit_once("/abs/")
            .map(|(_, id)| strip_version(id))
            .unwrap_or_default();
        let title = child_text("title");
        if title.is_empty() || arxiv_id.is_empty() {
            continue;
        }
        let authors: Vec<String> = entry
            .children()
            .filter(|node| node.has_tag_name((ATOM_NS, "author")))
            .filter_map(|author| {
                author
                    .children()
                    .find(|node| node.has_tag_name((ATOM_NS, "name")))
                    .and_then(|node| node.text())
                    .map(collapse_whitespace)
            })
            .collect();
        let published = child_text("published");
        let year = published.get(0..4).and_then(|y| y.parse().ok());
        let doi = entry
            .children()
            .find(|node| node.has_tag_name((ARXIV_NS, "doi")))
            .and_then(|node| node.text())
            .map(|value| value.trim().to_lowercase());
        let journal_ref = entry
            .children()
            .find(|node| node.has_tag_name((ARXIV_NS, "journal_ref")))
            .and_then(|node| node.text())
            .map(collapse_whitespace)
            .filter(|value| !value.is_empty());
        let pdf_url = entry
            .children()
            .filter(|node| node.has_tag_name((ATOM_NS, "link")))
            .find(|node| {
                node.attribute("title") == Some("pdf")
                    || node.attribute("type") == Some("application/pdf")
            })
            .and_then(|node| node.attribute("href"))
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://arxiv.org/pdf/{arxiv_id}.pdf"));
        papers.push(RemotePaper {
            id: format!("arxiv:{arxiv_id}"),
            title,
            authors,
            year,
            venue: journal_ref.unwrap_or_else(|| "arXiv".to_string()),
            doi,
            arxiv_id: Some(arxiv_id.clone()),
            summary: child_text("summary"),
            url: Some(format!("https://arxiv.org/abs/{arxiv_id}")),
            pdf_url: Some(pdf_url),
            source: "arXiv".to_string(),
            published: (!published.is_empty())
                .then(|| published.get(0..10).unwrap_or(&published).to_string()),
            cited_by: None,
        });
    }
    Ok((papers, hit_count))
}

fn search_crossref(
    client: &reqwest::blocking::Client,
    query: &str,
    limit: usize,
) -> Result<AdapterSearchOutcome, String> {
    let request = adapter_request_preview("crossref", query, limit);
    let response = client
        .get("https://api.crossref.org/works")
        .query(&[
            ("query", query),
            ("rows", &limit.to_string()),
            (
                "select",
                "DOI,title,author,issued,container-title,abstract,URL,link,is-referenced-by-count",
            ),
        ])
        .send()
        .map_err(|e| e.to_string())?;
    let response = capture_provider_response(response)?;
    require_success(&response, "Crossref")?;
    let body: Value = serde_json::from_slice(&response.body).map_err(|e| e.to_string())?;
    let items = body["message"]["items"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(AdapterSearchOutcome {
        papers: items.iter().filter_map(crossref_item_to_paper).collect(),
        request,
        raw_artifacts: vec![provider_artifact(
            "provider-response",
            "json",
            "application/json",
            &response,
        )],
        hit_count: body["message"]["total-results"].as_u64(),
        quota: response_quota(&response),
        warnings: Vec::new(),
        coverage_note: Some(
            "Crossref provides DOI metadata; abstracts and full-text links are only present when the depositor supplied them."
                .to_string(),
        ),
    })
}

fn crossref_item_to_paper(item: &Value) -> Option<RemotePaper> {
    let title = item["title"]
        .as_array()
        .and_then(|titles| titles.first())
        .and_then(|value| value.as_str())
        .map(collapse_whitespace)?;
    if title.is_empty() {
        return None;
    }
    let doi = item["DOI"]
        .as_str()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let authors: Vec<String> = item["author"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|author| {
                    let given = author["given"].as_str().unwrap_or("").trim();
                    let family = author["family"].as_str().unwrap_or("").trim();
                    let name = format!("{given} {family}");
                    let name = name.trim();
                    (!name.is_empty()).then(|| name.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    let year = item["issued"]["date-parts"][0][0]
        .as_i64()
        .and_then(|value| u32::try_from(value).ok());
    let venue = item["container-title"]
        .as_array()
        .and_then(|titles| titles.first())
        .and_then(|value| value.as_str())
        .map(collapse_whitespace)
        .unwrap_or_default();
    let pdf_url = item["link"].as_array().and_then(|links| {
        links
            .iter()
            .find(|link| link["content-type"].as_str() == Some("application/pdf"))
            .and_then(|link| link["URL"].as_str())
            .map(str::to_string)
    });
    let id = doi
        .as_ref()
        .map(|doi| format!("doi:{doi}"))
        .unwrap_or_else(|| format!("title:{}", normalized_title(&title)));
    Some(RemotePaper {
        id,
        title,
        authors,
        year,
        venue,
        doi,
        arxiv_id: None,
        summary: strip_jats(item["abstract"].as_str().unwrap_or("")),
        url: item["URL"].as_str().map(str::to_string),
        pdf_url,
        source: "Crossref".to_string(),
        published: None,
        cited_by: item["is-referenced-by-count"].as_u64(),
    })
}

fn search_openalex(
    client: &reqwest::blocking::Client,
    query: &str,
    limit: usize,
) -> Result<AdapterSearchOutcome, String> {
    let mut params: Vec<(&str, String)> = vec![
        ("search", query.to_string()),
        ("per-page", limit.to_string()),
        (
            "select",
            "id,doi,title,publication_year,publication_date,authorships,primary_location,\
             best_oa_location,open_access,cited_by_count,abstract_inverted_index"
                .to_string(),
        ),
    ];
    if let Ok(mailto) = std::env::var("OPENALEX_MAILTO") {
        if !mailto.trim().is_empty() {
            params.push(("mailto", mailto.trim().to_string()));
        }
    }
    let mut request = adapter_request_preview("openalex", query, limit);
    if let Some(mailto) = params
        .iter()
        .find(|(name, _)| *name == "mailto")
        .map(|(_, value)| value.clone())
    {
        request["query"]["mailto"] = Value::String(mailto);
    }
    let response = client
        .get("https://api.openalex.org/works")
        .query(&params)
        .send()
        .map_err(|e| e.to_string())?;
    let response = capture_provider_response(response)?;
    require_success(&response, "OpenAlex")?;
    let body: Value = serde_json::from_slice(&response.body).map_err(|e| e.to_string())?;
    let results = body["results"].as_array().cloned().unwrap_or_default();
    Ok(AdapterSearchOutcome {
        papers: results.iter().filter_map(openalex_work_to_paper).collect(),
        request,
        raw_artifacts: vec![provider_artifact(
            "provider-response",
            "json",
            "application/json",
            &response,
        )],
        hit_count: body["meta"]["count"].as_u64(),
        quota: response_quota(&response),
        warnings: Vec::new(),
        coverage_note: Some(
            "OpenAlex metadata is index-derived; an absent abstract or OA link is recorded as a coverage gap rather than inferred."
                .to_string(),
        ),
    })
}

/// OpenAlex returns abstracts as `{ word: [positions...] }` — flatten back
/// into reading order.
fn openalex_abstract(index: &Value) -> String {
    let Some(map) = index.as_object() else {
        return String::new();
    };
    let mut words: Vec<(u64, &str)> = Vec::new();
    for (word, positions) in map {
        if let Some(positions) = positions.as_array() {
            for position in positions {
                if let Some(position) = position.as_u64() {
                    words.push((position, word.as_str()));
                }
            }
        }
    }
    words.sort_by_key(|(position, _)| *position);
    collapse_whitespace(
        &words
            .iter()
            .map(|(_, word)| *word)
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn openalex_work_to_paper(work: &Value) -> Option<RemotePaper> {
    let title = collapse_whitespace(work["title"].as_str()?);
    if title.is_empty() {
        return None;
    }
    let doi = work["doi"]
        .as_str()
        .map(|value| {
            value
                .trim()
                .trim_start_matches("https://doi.org/")
                .to_lowercase()
        })
        .filter(|value| !value.is_empty());
    // arXiv-hosted works carry a DataCite DOI (10.48550/arxiv.<id>) or an
    // arxiv.org landing page — recover the id so dedupe can match arXiv hits.
    let arxiv_id = doi
        .as_deref()
        .and_then(|doi| doi.strip_prefix("10.48550/arxiv."))
        .map(str::to_string)
        .or_else(|| {
            work["primary_location"]["landing_page_url"]
                .as_str()
                .and_then(|url| url.split("arxiv.org/abs/").nth(1))
                .map(|id| strip_version(id.trim_end_matches('/')))
        });
    let authors: Vec<String> = work["authorships"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|authorship| authorship["author"]["display_name"].as_str())
                .map(collapse_whitespace)
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let short_id = work["id"]
        .as_str()
        .and_then(|url| url.rsplit('/').next())
        .map(str::to_string);
    let id = short_id
        .as_ref()
        .map(|short| format!("openalex:{short}"))
        .unwrap_or_else(|| format!("title:{}", normalized_title(&title)));
    let url = work["doi"]
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            work["primary_location"]["landing_page_url"]
                .as_str()
                .map(str::to_string)
        })
        .or_else(|| work["id"].as_str().map(str::to_string));
    let pdf_url = [
        &work["best_oa_location"]["pdf_url"],
        &work["primary_location"]["pdf_url"],
        &work["open_access"]["oa_url"],
    ]
    .into_iter()
    .find_map(|value| value.as_str())
    .map(str::to_string);
    Some(RemotePaper {
        id,
        title,
        authors,
        year: work["publication_year"]
            .as_u64()
            .and_then(|year| u32::try_from(year).ok()),
        venue: collapse_whitespace(
            work["primary_location"]["source"]["display_name"]
                .as_str()
                .unwrap_or(""),
        ),
        doi,
        arxiv_id,
        summary: openalex_abstract(&work["abstract_inverted_index"]),
        url,
        pdf_url,
        source: "OpenAlex".to_string(),
        published: work["publication_date"].as_str().map(str::to_string),
        cited_by: work["cited_by_count"].as_u64(),
    })
}

fn semantic_scholar_api_key() -> Option<String> {
    std::env::var("SEMANTIC_SCHOLAR_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn search_semantic_scholar(
    client: &reqwest::blocking::Client,
    query: &str,
    limit: usize,
) -> Result<AdapterSearchOutcome, String> {
    let request = adapter_request_preview("semantic-scholar", query, limit);
    let fields = "paperId,title,authors,year,venue,abstract,externalIds,url,openAccessPdf,citationCount,publicationDate";
    let mut request_builder = client
        .get("https://api.semanticscholar.org/graph/v1/paper/search")
        .query(&[
            ("query", query),
            ("limit", &limit.to_string()),
            ("fields", fields),
        ]);
    if let Some(api_key) = semantic_scholar_api_key() {
        request_builder = request_builder.header("x-api-key", api_key);
    }
    let response = request_builder.send().map_err(|error| error.to_string())?;
    let response = capture_provider_response(response)?;
    require_success(&response, "Semantic Scholar")?;
    let body: Value = serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
    let data = body["data"].as_array().cloned().unwrap_or_default();
    Ok(AdapterSearchOutcome {
        papers: data.iter().filter_map(semantic_scholar_item_to_paper).collect(),
        request,
        raw_artifacts: vec![provider_artifact(
            "provider-response",
            "json",
            "application/json",
            &response,
        )],
        hit_count: body["total"].as_u64(),
        quota: response_quota(&response),
        warnings: Vec::new(),
        coverage_note: Some(
            "Semantic Scholar result and citation metadata are point-in-time provider observations."
                .to_string(),
        ),
    })
}

fn semantic_scholar_item_to_paper(item: &Value) -> Option<RemotePaper> {
    let title = item["title"].as_str().map(collapse_whitespace)?;
    if title.is_empty() {
        return None;
    }
    let doi = item["externalIds"]["DOI"]
        .as_str()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let arxiv_id = item["externalIds"]["ArXiv"]
        .as_str()
        .map(strip_version)
        .filter(|value| !value.is_empty());
    let external_id = item["paperId"]
        .as_str()
        .map(|value| format!("semantic-scholar:{value}"))
        .or_else(|| doi.as_ref().map(|value| format!("doi:{value}")))
        .unwrap_or_else(|| format!("title:{}", normalized_title(&title)));
    let authors = item["authors"]
        .as_array()
        .map(|authors| {
            authors
                .iter()
                .filter_map(|author| author["name"].as_str())
                .map(collapse_whitespace)
                .filter(|author| !author.is_empty())
                .collect()
        })
        .unwrap_or_default();
    Some(RemotePaper {
        id: external_id,
        title,
        authors,
        year: item["year"]
            .as_u64()
            .and_then(|year| u32::try_from(year).ok()),
        venue: collapse_whitespace(item["venue"].as_str().unwrap_or("")),
        doi,
        arxiv_id,
        summary: collapse_whitespace(item["abstract"].as_str().unwrap_or("")),
        url: item["url"].as_str().map(str::to_string),
        pdf_url: item["openAccessPdf"]["url"].as_str().map(str::to_string),
        source: "Semantic Scholar".to_string(),
        published: item["publicationDate"].as_str().map(str::to_string),
        cited_by: item["citationCount"].as_u64(),
    })
}

/// Scopus caps `count` at 25 per request for most entitlements.
const SCOPUS_PAGE_MAX: usize = 25;

fn scopus_api_key() -> Result<String, String> {
    std::env::var("SCOPUS_API_KEY")
        .ok()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .ok_or_else(|| {
            "SCOPUS_API_KEY is not set — add the Elsevier API key in Settings or the environment"
                .to_string()
        })
}

/// Bare keyword queries become `TITLE-ABS-KEY(...)`; queries that already use
/// Scopus field codes pass through untouched.
fn scopus_query(query: &str) -> String {
    const FIELD_CODES: [&str; 9] = [
        "TITLE-ABS-KEY(",
        "TITLE(",
        "ABS(",
        "KEY(",
        "AUTH(",
        "ALL(",
        "DOI(",
        "SRCTITLE(",
        "AFFIL(",
    ];
    let compact = collapse_whitespace(query);
    if let Some(doi) = scopus_doi_query(&compact) {
        return format!("DOI({doi})");
    }
    let field_probe = compact.to_ascii_uppercase().replace(" (", "(");
    let fielded = FIELD_CODES.iter().any(|code| field_probe.contains(code));
    if fielded {
        compact
    } else if should_quote_scopus_query(&compact) {
        format!("TITLE-ABS-KEY(\"{}\")", scopus_phrase(&compact))
    } else {
        format!("TITLE-ABS-KEY({compact})")
    }
}

fn scopus_doi_query(query: &str) -> Option<String> {
    let value = query
        .trim()
        .trim_start_matches("doi:")
        .trim_start_matches("DOI:")
        .trim()
        .trim_start_matches("https://doi.org/")
        .trim_start_matches("http://doi.org/")
        .trim();
    let value = value
        .trim_matches(['.', ',', ';', ':', ')', ']', '}', '）'])
        .to_ascii_lowercase();
    is_doi_like(&value).then_some(value)
}

fn is_doi_like(value: &str) -> bool {
    let Some(after_prefix) = value.strip_prefix("10.") else {
        return false;
    };
    let Some((registrant, suffix)) = after_prefix.split_once('/') else {
        return false;
    };
    (4..=9).contains(&registrant.len())
        && registrant.chars().all(|ch| ch.is_ascii_digit())
        && suffix.len() >= 3
}

fn should_quote_scopus_query(query: &str) -> bool {
    let words = query.split_whitespace().count();
    let booleanish = query
        .split_whitespace()
        .any(|word| matches!(word.to_ascii_uppercase().as_str(), "AND" | "OR" | "NOT"));
    !booleanish
        && (words >= 6
            || query
                .chars()
                .any(|ch| matches!(ch, ':' | '"' | '\'' | '–' | '—' | '：')))
}

fn scopus_phrase(query: &str) -> String {
    collapse_whitespace(&query.replace(['"', '“', '”'], " ").replace(['–', '—'], "-"))
}

fn search_scopus(
    client: &reqwest::blocking::Client,
    query: &str,
    limit: usize,
) -> Result<AdapterSearchOutcome, String> {
    let api_key = scopus_api_key()?;
    let query = scopus_query(query);
    // COMPLETE view includes abstracts but needs extra entitlement — fall back
    // to the STANDARD view (no abstracts) once, then keep using it for the rest
    // of the pages instead of failing the search.
    let mut view = "COMPLETE";
    let mut papers = Vec::new();
    let mut start = 0usize;
    let mut hit_count = None;
    let mut raw_artifacts = Vec::new();
    let mut requests = Vec::new();
    let mut quotas = Vec::new();
    let mut warnings = Vec::new();
    // Scopus caps each page at SCOPUS_PAGE_MAX, so page through until we reach
    // the requested `limit` or exhaust the result set.
    loop {
        let count = (limit - papers.len()).min(SCOPUS_PAGE_MAX);
        if count == 0 {
            break;
        }
        let request = |view: &str| {
            let params: Vec<(&str, String)> = vec![
                ("query", query.clone()),
                ("count", count.to_string()),
                ("start", start.to_string()),
                ("view", view.to_string()),
            ];
            client
                .get("https://api.elsevier.com/content/search/scopus")
                .header("X-ELS-APIKey", api_key.clone())
                .header("Accept", "application/json")
                .query(&params)
                .send()
        };
        let mut response = capture_provider_response(request(view).map_err(|e| e.to_string())?)?;
        requests.push(json!({
            "method": "GET",
            "url": "https://api.elsevier.com/content/search/scopus",
            "query": { "query": query, "count": count, "start": start, "view": view },
            "authentication": "SCOPUS_API_KEY (redacted)",
        }));
        quotas.push(response_quota(&response));
        raw_artifacts.push(provider_artifact(
            "provider-response",
            "json",
            "application/json",
            &response,
        ));
        if matches!(response.status, 401 | 403) && view == "COMPLETE" {
            warnings.push(
                "Scopus COMPLETE was not permitted; the provider response is retained and this run continues with STANDARD metadata."
                    .to_string(),
            );
            view = "STANDARD";
            response = capture_provider_response(request(view).map_err(|e| e.to_string())?)?;
            requests.push(json!({
                "method": "GET",
                "url": "https://api.elsevier.com/content/search/scopus",
                "query": { "query": query, "count": count, "start": start, "view": view },
                "authentication": "SCOPUS_API_KEY (redacted)",
                "fallbackFrom": "COMPLETE"
            }));
            quotas.push(response_quota(&response));
            raw_artifacts.push(provider_artifact(
                "provider-response",
                "json",
                "application/json",
                &response,
            ));
        }
        require_success(&response, "Scopus")?;
        let body: Value = serde_json::from_slice(&response.body).map_err(|e| e.to_string())?;
        let results = &body["search-results"];
        let total = scopus_total_results(results);
        if total > 0 {
            hit_count = Some(total as u64);
        }
        let entries = results["entry"].as_array().cloned().unwrap_or_default();
        // An empty result set arrives as one `{ "error": "Result set was empty" }`
        // entry — filter_map drops it because it has no title.
        let before = papers.len();
        papers.extend(entries.iter().filter_map(scopus_entry_to_paper));
        let added = papers.len() - before;
        start += count;
        // Stop at the reported total (when known), a short page (no more rows),
        // or when a page yields nothing usable.
        if (total > 0 && start >= total) || entries.len() < count || added == 0 {
            break;
        }
    }
    Ok(AdapterSearchOutcome {
        papers,
        request: json!({
            "provider": "scopus",
            "requests": requests,
            "view": view,
            "fallbackPolicy": "COMPLETE_to_STANDARD_on_401_or_403",
        }),
        raw_artifacts,
        hit_count,
        quota: Value::Array(quotas),
        warnings,
        coverage_note: Some(if view == "STANDARD" {
            "Scopus COMPLETE entitlement was unavailable; STANDARD fallback may omit abstract fields."
                .to_string()
        } else {
            "Scopus COMPLETE metadata was requested; actual fields remain subject to provider entitlement and index coverage."
                .to_string()
        }),
    })
}

/// Scopus reports the full match count in `opensearch:totalResults` (a JSON
/// string). Missing/unparseable means "unknown" — pagination then relies on
/// short-page detection instead.
fn scopus_total_results(results: &Value) -> usize {
    match &results["opensearch:totalResults"] {
        Value::String(value) => value.trim().parse().unwrap_or(0),
        value => usize::try_from(value.as_u64().unwrap_or(0)).unwrap_or(0),
    }
}

fn scopus_entry_to_paper(entry: &Value) -> Option<RemotePaper> {
    let title = collapse_whitespace(entry["dc:title"].as_str()?);
    if title.is_empty() {
        return None;
    }
    let scopus_id = entry["dc:identifier"]
        .as_str()
        .and_then(|raw| raw.rsplit(':').next())
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let doi = entry["prism:doi"]
        .as_str()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let mut authors: Vec<String> = entry["author"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|author| {
                    author["authname"]
                        .as_str()
                        .or_else(|| author["ce:indexed-name"].as_str())
                })
                .map(collapse_whitespace)
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if authors.is_empty() {
        if let Some(creator) = entry["dc:creator"].as_str() {
            let creator = collapse_whitespace(creator);
            if !creator.is_empty() {
                authors.push(creator);
            }
        }
    }
    let cover_date = entry["prism:coverDate"].as_str().unwrap_or("").trim();
    let year = cover_date.get(0..4).and_then(|year| year.parse().ok());
    let cited_by = match &entry["citedby-count"] {
        Value::String(value) => value.trim().parse().ok(),
        value => value.as_u64(),
    };
    let url = entry["link"]
        .as_array()
        .and_then(|links| {
            links
                .iter()
                .find(|link| link["@ref"].as_str() == Some("scopus"))
                .and_then(|link| link["@href"].as_str())
                .map(str::to_string)
        })
        .or_else(|| doi.as_ref().map(|doi| format!("https://doi.org/{doi}")));
    let id = scopus_id
        .map(|id| format!("scopus:{id}"))
        .or_else(|| doi.as_ref().map(|doi| format!("doi:{doi}")))
        .unwrap_or_else(|| format!("title:{}", normalized_title(&title)));
    Some(RemotePaper {
        id,
        title,
        authors,
        year,
        venue: collapse_whitespace(entry["prism:publicationName"].as_str().unwrap_or("")),
        doi,
        arxiv_id: None,
        summary: strip_jats(entry["dc:description"].as_str().unwrap_or("")),
        url,
        // Scopus does not expose direct PDF links through the search API.
        pdf_url: None,
        source: "Scopus".to_string(),
        published: (!cover_date.is_empty()).then(|| cover_date.to_string()),
        cited_by,
    })
}

fn dedupe(papers: Vec<RemotePaper>) -> Vec<RemotePaper> {
    let mut result: Vec<RemotePaper> = Vec::with_capacity(papers.len());
    for paper in papers {
        let duplicate = result.iter_mut().find(|existing| {
            (existing.doi.is_some() && existing.doi == paper.doi)
                || (existing.arxiv_id.is_some() && existing.arxiv_id == paper.arxiv_id)
                || normalized_title(&existing.title) == normalized_title(&paper.title)
        });
        match duplicate {
            Some(existing) => merge_remote(existing, paper),
            None => result.push(paper),
        }
    }
    result
}

fn merge_remote(existing: &mut RemotePaper, incoming: RemotePaper) {
    if existing.doi.is_none() {
        existing.doi = incoming.doi;
    }
    if existing.arxiv_id.is_none() {
        existing.arxiv_id = incoming.arxiv_id;
    }
    if existing.pdf_url.is_none() {
        existing.pdf_url = incoming.pdf_url;
    }
    if existing.url.is_none() {
        existing.url = incoming.url;
    }
    if existing.year.is_none() {
        existing.year = incoming.year;
    }
    if existing.cited_by.is_none() {
        existing.cited_by = incoming.cited_by;
    }
    if existing.summary.is_empty() {
        existing.summary = incoming.summary;
    }
    if (existing.venue.is_empty() || existing.venue == "arXiv") && !incoming.venue.is_empty() {
        existing.venue = incoming.venue;
    }
    if !existing.source.contains(&incoming.source) {
        existing.source = format!("{} + {}", existing.source, incoming.source);
    }
}

// ── PDF download ────────────────────────────────────────────────────────────

pub fn download_pdf_at(
    base: &Path,
    url: &str,
    file_name: &str,
    paper_id: Option<&str>,
) -> Result<Value, String> {
    let safe_name = sanitize_file_name(file_name)?;
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("PDF URL must be http(s)".to_string());
    }
    let dir = base.join(PAPERS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&safe_name);
    if path.exists() {
        return Err(format!(
            "refusing to overwrite existing PDF: {}",
            path.display()
        ));
    }

    let client = http_client()?;
    let response = client
        .get(url)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if let Some(length) = response.content_length() {
        if length > MAX_PDF_BYTES {
            return Err(format!("PDF is too large ({length} bytes)"));
        }
    }
    let bytes = response.bytes().map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(format!("PDF is too large ({} bytes)", bytes.len()));
    }
    if !bytes.starts_with(b"%PDF") {
        return Err(
            "the URL did not return a PDF (the publisher may not expose a direct link)".to_string(),
        );
    }

    let tmp = dir.join(format!("{safe_name}.part-{}", epoch_millis()));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "failed to move PDF into place without overwrite: {error}"
        ));
    }

    let relative_path = format!("{PAPERS_DIR}/{safe_name}");
    if let Some(paper_id) = paper_id {
        mark_pdf_downloaded(base, paper_id, &relative_path, bytes.len())?;
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "relativePath": relative_path,
        "bytes": bytes.len(),
    }))
}

fn validate_pdf_file(path: &Path) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(format!("PDF is too large ({} bytes)", bytes.len()));
    }
    if !bytes.starts_with(b"%PDF") {
        return Err(format!("{} is not a valid PDF", path.display()));
    }
    Ok(())
}

pub fn download_best_pdf_for_paper_at(base: &Path, paper: &RemotePaper) -> Result<Value, String> {
    let file_name = preferred_pdf_file_name(paper);
    let mut errors = Vec::new();
    if let Some(pdf_url) = paper.pdf_url.as_deref() {
        match download_pdf_at(base, pdf_url, &file_name, Some(&paper.id)) {
            Ok(result) => return Ok(result),
            Err(error) => errors.push(format!("direct PDF: {error}")),
        }
    }

    match publisher_pdf_url(paper) {
        Ok(Some(url)) => match download_pdf_at(base, &url, &file_name, Some(&paper.id)) {
            Ok(result) => Ok(result),
            Err(error) => {
                errors.push(format!("publisher route: {error}"));
                Err(errors.join("; "))
            }
        },
        Ok(None) => {
            errors.push("no IEEE/ScienceDirect PDF route found".to_string());
            Err(errors.join("; "))
        }
        Err(error) => {
            errors.push(error);
            Err(errors.join("; "))
        }
    }
}

pub fn browser_download_task_for_paper(paper: &RemotePaper) -> Result<Option<Value>, String> {
    match publisher_browser_route(paper)? {
        Some(PublisherBrowserRoute::Ieee { arnumber, page_url }) => Ok(Some(json!({
            "title": paper.title,
            "doi": paper.doi,
            "publisher": "IEEE",
            "page_url": page_url,
            "pdf_url": format!("https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber={arnumber}&ref="),
            "extractor": "",
            "notes": "Use a real browser session; direct HTTP may return 502."
        }))),
        Some(PublisherBrowserRoute::ScienceDirect { page_url }) => Ok(Some(json!({
            "title": paper.title,
            "doi": paper.doi,
            "publisher": "Elsevier/ScienceDirect",
            "page_url": page_url,
            "pdf_url": "",
            "extractor": "sciencedirect_viewpdf",
            "notes": "Open the article page in a real browser and extract the ViewPDF/pdfft href."
        }))),
        None => Ok(None),
    }
}

pub fn browser_download_pdf_for_paper_at(
    base: &Path,
    paper: &RemotePaper,
) -> Result<Value, String> {
    let task = browser_download_task_for_paper(paper)?
        .ok_or_else(|| "no browser-download task route found".to_string())?;
    let skill_dir = PathBuf::from(runtime::home_dir())
        .join(".codex")
        .join("skills")
        .join("paper-pdf-downloader");
    let script = skill_dir.join("scripts").join("browser_batch_download.py");
    if !script.exists() {
        return Err(format!(
            "paper-pdf-downloader browser script not found: {}",
            script.display()
        ));
    }

    let work_dir = crate::layout::scratch_tmp_dir_at(base)
        .join("paper-browser-download")
        .join(format!("{:x}", epoch_millis()));
    std::fs::create_dir_all(&work_dir).map_err(|error| error.to_string())?;
    let tasks_path = work_dir.join("tasks.json");
    let results_path = work_dir.join("download-results.json");
    let output_dir = base.join(PAPERS_DIR);
    std::fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
    let tasks = serde_json::to_vec_pretty(&json!([task])).map_err(|error| error.to_string())?;
    std::fs::write(&tasks_path, tasks).map_err(|error| error.to_string())?;

    let port = 9300 + (epoch_millis() % 500) as u16;
    let output = Command::new("python")
        .arg(&script)
        .arg("--tasks")
        .arg(&tasks_path)
        .arg("--output-dir")
        .arg(&output_dir)
        .arg("--results-out")
        .arg(&results_path)
        .arg("--port")
        .arg(port.to_string())
        .arg("--skip-existing")
        .output()
        .map_err(|error| format!("failed to start browser downloader: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "browser downloader failed: {}{}",
            stderr.trim(),
            if stdout.trim().is_empty() {
                String::new()
            } else {
                format!("; stdout: {}", stdout.trim())
            }
        ));
    }

    let raw = std::fs::read_to_string(&results_path).map_err(|error| error.to_string())?;
    let results: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("browser download results are invalid JSON: {error}"))?;
    let Some(item) = results.as_array().and_then(|items| items.first()) else {
        return Err("browser downloader returned no result rows".to_string());
    };
    let status = item["status"].as_str().unwrap_or("");
    if !matches!(status, "downloaded" | "skipped") {
        return Err(item["reason"]
            .as_str()
            .unwrap_or("browser downloader did not download the PDF")
            .to_string());
    }
    let path = item["file"]
        .as_str()
        .ok_or_else(|| "browser downloader result did not include a file path".to_string())?;
    let path = PathBuf::from(path);
    validate_pdf_file(&path)?;
    let bytes = std::fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len() as usize;
    let relative_path = path
        .strip_prefix(base)
        .ok()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    mark_pdf_downloaded(base, &paper.id, &relative_path, bytes)?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "relativePath": relative_path,
        "bytes": bytes,
        "method": "browser"
    }))
}

enum PublisherBrowserRoute {
    Ieee { arnumber: String, page_url: String },
    ScienceDirect { page_url: String },
}

fn publisher_browser_route(paper: &RemotePaper) -> Result<Option<PublisherBrowserRoute>, String> {
    let candidates = publisher_route_candidates(paper)?;
    for candidate in candidates {
        if let Some(arnumber) = parse_ieee_arnumber(&candidate) {
            return Ok(Some(PublisherBrowserRoute::Ieee {
                page_url: format!("https://ieeexplore.ieee.org/document/{arnumber}/"),
                arnumber,
            }));
        }
        if let Some(candidate) = sciencedirect_article_page_url(&candidate) {
            return Ok(Some(PublisherBrowserRoute::ScienceDirect {
                page_url: candidate,
            }));
        }
    }
    Ok(None)
}

fn preferred_pdf_file_name(paper: &RemotePaper) -> String {
    paper
        .arxiv_id
        .as_deref()
        .unwrap_or(&paper.id)
        .replace(['/', ':'], "-")
}

fn publisher_pdf_url(paper: &RemotePaper) -> Result<Option<String>, String> {
    let client = http_client()?;
    let candidates = publisher_route_candidates_with_client(paper, &client)?;
    for candidate in candidates {
        if let Some(arnumber) = parse_ieee_arnumber(&candidate) {
            return Ok(Some(format!(
                "https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber={arnumber}&ref="
            )));
        }
        if let Some(page_url) = sciencedirect_article_page_url(&candidate) {
            return extract_sciencedirect_pdf_url(&client, &page_url).map(Some);
        }
    }
    Ok(None)
}

fn publisher_route_candidates(paper: &RemotePaper) -> Result<Vec<String>, String> {
    let client = http_client()?;
    publisher_route_candidates_with_client(paper, &client)
}

fn publisher_route_candidates_with_client(
    paper: &RemotePaper,
    client: &reqwest::blocking::Client,
) -> Result<Vec<String>, String> {
    let mut candidates = Vec::new();
    if let Some(url) = paper.url.as_deref() {
        candidates.push(url.to_string());
    }
    if let Some(pdf_url) = paper.pdf_url.as_deref() {
        candidates.push(pdf_url.to_string());
    }
    if let Some(doi) = paper.doi.as_deref() {
        if let Ok(mut crossref_candidates) = crossref_route_candidates(client, doi) {
            candidates.append(&mut crossref_candidates);
        }
        if let Ok(resolved) = resolve_doi_url(&client, doi) {
            candidates.push(resolved);
        }
    }
    candidates = dedupe_strings(candidates);
    Ok(candidates)
}

fn crossref_route_candidates(
    client: &reqwest::blocking::Client,
    doi: &str,
) -> Result<Vec<String>, String> {
    let doi = doi
        .trim()
        .trim_start_matches("https://doi.org/")
        .trim_start_matches("http://doi.org/");
    let body: Value = client
        .get(format!("https://api.crossref.org/works/{doi}"))
        .send()
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .map_err(|error| error.to_string())?;
    let message = &body["message"];
    let mut candidates = Vec::new();
    let publisher = message["publisher"].as_str().unwrap_or("");
    let resource = message["resource"]["primary"]["URL"]
        .as_str()
        .or_else(|| message["URL"].as_str())
        .unwrap_or("");
    if !resource.is_empty() {
        candidates.push(resource.to_string());
    }
    if let Some(url) = message["URL"].as_str() {
        candidates.push(url.to_string());
    }
    if let Some(links) = message["link"].as_array() {
        for link in links {
            if let Some(url) = link["URL"].as_str() {
                candidates.push(url.to_string());
            }
        }
    }

    let lowered = format!("{publisher} {resource}").to_ascii_lowercase();
    if lowered.contains("elsevier") || lowered.contains("sciencedirect") {
        if let Some(page_url) = sciencedirect_article_page_url(resource) {
            candidates.push(page_url);
        }
    }
    if lowered.contains("ieee") || lowered.contains("ieeexplore") {
        for candidate in candidates.clone() {
            if let Some(arnumber) = parse_ieee_arnumber(&candidate) {
                candidates.push(format!("https://ieeexplore.ieee.org/document/{arnumber}/"));
                break;
            }
        }
    }
    Ok(dedupe_strings(candidates))
}

fn dedupe_strings(items: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        if !item.trim().is_empty() && !out.iter().any(|existing: &String| existing == &item) {
            out.push(item);
        }
    }
    out
}

fn resolve_doi_url(client: &reqwest::blocking::Client, doi: &str) -> Result<String, String> {
    let doi = doi
        .trim()
        .trim_start_matches("https://doi.org/")
        .trim_start_matches("http://doi.org/");
    client
        .get(format!("https://doi.org/{doi}"))
        .send()
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())
        .map(|response| response.url().to_string())
}

fn parse_ieee_arnumber(url: &str) -> Option<String> {
    find_digits_after(url, "/document/")
        .or_else(|| find_digits_after(url, "arnumber="))
        .or_else(|| find_digits_before_suffix(url, ".pdf"))
}

fn find_digits_after(value: &str, marker: &str) -> Option<String> {
    let start = value.find(marker)? + marker.len();
    let digits = value[start..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    (!digits.is_empty()).then_some(digits)
}

fn find_digits_before_suffix(value: &str, suffix: &str) -> Option<String> {
    let end = value.find(suffix)?;
    let prefix = &value[..end];
    let digits = prefix
        .chars()
        .rev()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    (!digits.is_empty()).then_some(digits)
}

fn sciencedirect_article_page_url(url: &str) -> Option<String> {
    if url.contains("sciencedirect.com/science/article/pii/") {
        return Some(
            url.split(['?', '#'])
                .next()
                .unwrap_or(url)
                .trim_end_matches('/')
                .to_string(),
        );
    }
    parse_sciencedirect_pii(url)
        .map(|pii| format!("https://www.sciencedirect.com/science/article/pii/{pii}"))
}

fn parse_sciencedirect_pii(url: &str) -> Option<String> {
    for marker in ["/pii/", "retrieve/pii/"] {
        if let Some(start) = url.find(marker).map(|start| start + marker.len()) {
            let pii = url[start..]
                .chars()
                .take_while(|ch| !matches!(ch, '?' | '#' | '/' | '&'))
                .collect::<String>();
            if !pii.is_empty() {
                return Some(pii);
            }
        }
    }
    None
}

fn extract_sciencedirect_pdf_url(
    client: &reqwest::blocking::Client,
    page_url: &str,
) -> Result<String, String> {
    let html = client
        .get(page_url)
        .send()
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .text()
        .map_err(|error| error.to_string())?;
    find_sciencedirect_pdf_href(&html)
        .map(|href| absolutize_sciencedirect_url(&href))
        .ok_or_else(|| "ScienceDirect page did not expose a ViewPDF/pdfft link".to_string())
}

fn find_sciencedirect_pdf_href(html: &str) -> Option<String> {
    for marker in ["href=\"", "href='", "\"href\":\""] {
        let quote = if marker.ends_with('\'') { '\'' } else { '"' };
        let mut rest = html;
        while let Some(index) = rest.find(marker) {
            let after = &rest[index + marker.len()..];
            if let Some(end) = after.find(quote) {
                let href = html_unescape(&after[..end]);
                if href.contains("/science/article/pii/") && href.contains("/pdfft?") {
                    return Some(href);
                }
                rest = &after[end + 1..];
            } else {
                break;
            }
        }
    }
    None
}

fn absolutize_sciencedirect_url(url: &str) -> String {
    if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else if url.starts_with('/') {
        format!("{SCIENCEDIRECT_ORIGIN}{url}")
    } else {
        format!("{SCIENCEDIRECT_ORIGIN}/{url}")
    }
}

fn html_unescape(value: &str) -> String {
    value
        .replace("\\/", "/")
        .replace("&amp;", "&")
        .replace("\\u0026", "&")
}

fn mark_pdf_downloaded(
    base: &Path,
    paper_id: &str,
    relative_path: &str,
    bytes: usize,
) -> Result<(), String> {
    let mut library = library_load_at(base)?;
    let Some(papers) = library["papers"].as_array_mut() else {
        return Ok(());
    };
    let Some(paper) = papers
        .iter_mut()
        .find(|paper| paper["id"].as_str() == Some(paper_id))
    else {
        return Ok(());
    };
    if !paper["pdf"].is_object() {
        paper["pdf"] = json!({});
    }
    paper["pdf"]["status"] = Value::from("downloaded");
    paper["pdf"]["path"] = Value::from(relative_path);
    paper["pdf"]["bytes"] = Value::from(bytes);
    let stage = paper["stage"].as_str().unwrap_or_default();
    if matches!(stage, "inbox" | "screened" | "shortlist") {
        paper["stage"] = Value::from("downloaded");
    }
    library_save_at(base, &library)
}

pub fn sanitize_file_name(name: &str) -> Result<String, String> {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => ch,
            _ => '-',
        })
        .collect();
    let cleaned = cleaned
        .trim_matches(|ch: char| ch == '-' || ch == '.')
        .to_string();
    if cleaned.is_empty() {
        return Err("file name is empty".to_string());
    }
    if cleaned.to_ascii_lowercase().ends_with(".pdf") {
        Ok(cleaned)
    } else {
        Ok(format!("{cleaned}.pdf"))
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn strip_version(id: &str) -> String {
    let id = id.trim();
    if let Some(pos) = id.rfind('v') {
        let (head, tail) = id.split_at(pos);
        if !head.is_empty() && tail.len() > 1 && tail[1..].chars().all(|ch| ch.is_ascii_digit()) {
            return head.to_string();
        }
    }
    id.to_string()
}

fn normalized_title(title: &str) -> String {
    title
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_lowercase()
}

fn strip_jats(value: &str) -> String {
    let mut text = String::with_capacity(value.len());
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => text.push(ch),
            _ => {}
        }
    }
    collapse_whitespace(&text)
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "tests/literature.rs"]
mod tests;
