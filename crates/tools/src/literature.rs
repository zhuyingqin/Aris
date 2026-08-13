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
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{collapse_whitespace, read_json_file};

const PAPERS_DIR: &str = crate::layout::PAPERS_DIR;
const LIBRARY_FILE: &str = "library.json";
const HTTP_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_PDF_BYTES: u64 = 80 * 1024 * 1024;
/// PDF publishers occasionally keep a response alive indefinitely by sending
/// a few bytes at a time. Use a short per-read idle deadline plus a hard
/// overall deadline so a stalled download cannot hold a chat turn forever.
const PDF_DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(10);
const PDF_DOWNLOAD_TOTAL_TIMEOUT: Duration = Duration::from_secs(180);
const PDF_DOWNLOAD_CHUNK_BYTES: usize = 64 * 1024;
/// Default per-source result target, used only when the caller omits
/// `maxResults`. There is no hard ceiling — the agent (or user) decides how many
/// records to pull, and every source, including the arXiv supplement, fetches up
/// to that count.
const DEFAULT_RESULT_LIMIT: usize = 50;
const ARXIV_PAGE_MAX: usize = 100;
const CROSSREF_PAGE_MAX: usize = 1_000;
const OPENALEX_PAGE_MAX: usize = 100;
const SEMANTIC_SCHOLAR_PAGE_MAX: usize = 100;
const SEMANTIC_SCHOLAR_RESULT_WINDOW: usize = 1_000;
const MAX_HTTP_ATTEMPTS: usize = 3;
/// Product-level minimum spacing between any two arXiv API request starts.
const ARXIV_MIN_REQUEST_INTERVAL: Duration = Duration::from_secs(2);
/// Three rate-limit waits mean four total attempts for a single arXiv request.
pub(crate) const ARXIV_RATE_LIMIT_RETRIES: usize = 3;
const ARXIV_FALLBACK_BACKOFFS: [Duration; ARXIV_RATE_LIMIT_RETRIES] = [
    Duration::from_secs(3),
    Duration::from_secs(6),
    Duration::from_secs(12),
];
const ARXIV_BACKOFF_JITTER_MAX_MILLIS: u64 = 250;
const EXHAUSTED_VARIANT_CURSOR: &str = "__exhausted__";
/// Marker for a user-requested stop.
///
/// It travels as an ordinary adapter error so the existing per-source failure
/// plumbing records the partial coverage and the resumable cursor, while the
/// run loop matches on it to stop the remaining sources instead of treating it
/// as one misbehaving provider.
const CANCELLED_ERROR: &str = "search cancelled by the user";
const USER_AGENT: &str = concat!(
    "aris/",
    env!("CARGO_PKG_VERSION"),
    " (literature tools; +https://github.com/zhuyingqin/Aris)"
);
const SCIENCEDIRECT_ORIGIN: &str = "https://www.sciencedirect.com";

/// Process-wide scheduler for the arXiv API. It deliberately owns queue order
/// rather than relying on per-search sleeps: a broad query, exact query,
/// pagination request, and calls from separate desktop conversations all use
/// this same gate.
static ARXIV_REQUEST_GATE: OnceLock<ArxivRequestGate> = OnceLock::new();

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
    pub attachments: usize,
    pub notes: usize,
    pub annotations: usize,
    pub collections: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureCitationsInput {
    /// `arxiv:2401.00001`, a bare arXiv id, `doi:10.1145/x`, a bare DOI, or an
    /// opaque Semantic Scholar id.
    pub paper_id: String,
    /// `citing` (default) or `references`.
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub max_results: Option<usize>,
    /// Continues a previous traversal from its reported `nextCursor`.
    #[serde(default)]
    pub cursor: Option<String>,
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
    /// Start a new bounded page from the per-source cursors of a previous
    /// terminal partial run. A continuation is a distinct SearchRun so the
    /// protocol's per-run `maxResults` bound remains true and auditable.
    #[serde(default)]
    pub continue_run_id: Option<String>,
    /// Per-pass ceiling for individual query variants, keyed by variant `kind`.
    ///
    /// The protocol's own `maxResults` per variant is a *per-request* ceiling
    /// and is re-applied in full on every continuation, so it cannot express a
    /// cumulative corpus quota. A caller that admits records into a bounded
    /// corpus owns the remaining-budget arithmetic; this override lets it spend
    /// only what is left for a variant, and `0` retires a variant that already
    /// reached its quota without fetching another page.
    #[serde(default)]
    pub variant_budgets: Option<BTreeMap<String, usize>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedTimeWindow {
    from_date: Option<String>,
    until_date: Option<String>,
}

impl ParsedTimeWindow {
    fn from_year(&self) -> Option<u32> {
        self.from_date
            .as_deref()
            .and_then(|value| value.get(0..4))
            .and_then(|value| value.parse().ok())
    }

    fn until_year(&self) -> Option<u32> {
        self.until_date
            .as_deref()
            .and_then(|value| value.get(0..4))
            .and_then(|value| value.parse().ok())
    }
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
    let limit = input.max_results.unwrap_or(DEFAULT_RESULT_LIMIT).max(1);
    let draft = casual_search_protocol_draft_with_limit(&input, limit)?;
    let protocol = {
        let mut store = runtime::open_literature_store_at(base)?;
        store.create_protocol(draft)?
    };
    let execution = literature_search_execute_at(
        base,
        LiteratureSearchExecuteInput {
            protocol_id: protocol.id.clone(),
            confirmation: "execute".to_string(),
            max_results: None,
            resume_run_id: None,
            continue_run_id: None,
            variant_budgets: None,
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
        "note": "This explicit casual search created and executed an automatic ad-hoc SearchProtocol. Its records are already canonical in the local literature database; the compatibility projection has been refreshed. Do not call LiteratureLibraryUpsert to ingest them."
    }))
}

#[cfg(test)]
fn casual_search_protocol_draft(
    input: &LiteratureSearchInput,
) -> Result<runtime::SearchProtocolDraft, String> {
    casual_search_protocol_draft_with_limit(
        input,
        input.max_results.unwrap_or(DEFAULT_RESULT_LIMIT).max(1),
    )
}

fn casual_search_protocol_draft_with_limit(
    input: &LiteratureSearchInput,
    limit: usize,
) -> Result<runtime::SearchProtocolDraft, String> {
    let question = input.query.trim();
    if question.is_empty() {
        return Err("search query is empty".to_string());
    }
    let databases = casual_search_sources(&input.sources);
    if databases
        .iter()
        .any(|source| source.eq_ignore_ascii_case("scopus"))
        && contains_cjk(question)
    {
        return Err(
            "Scopus queries must use English academic terms; Chinese/CJK characters are not sent"
                .to_string(),
        );
    }
    let query_variants = databases
        .iter()
        .map(|source| (source.clone(), plan_source_query_variants(question, source)))
        .collect::<BTreeMap<_, _>>();
    let queries = query_variants
        .iter()
        .filter_map(|(source, variants)| {
            variants
                .first()
                .map(|variant| (source.clone(), variant.query.clone()))
        })
        .collect::<BTreeMap<_, _>>();
    Ok(runtime::SearchProtocolDraft {
        question: question.to_string(),
        scope: "Automatically created for an explicit casual Chat search. Refine this protocol before relying on it for screening, evidence synthesis, or novelty claims.".to_string(),
        time_window: String::new(),
        sort_order: "relevance".to_string(),
        databases,
        queries,
        query_variants,
        max_results: Some(limit),
        inclusion_criteria: Vec::new(),
        exclusion_criteria: Vec::new(),
        known_key_papers: Vec::new(),
    })
}

/// The identity of the provider requests a `LiteratureSearch` call will send.
///
/// A search's cost is the set of `(source, compiled query)` pairs it issues,
/// not the sentence the caller typed. Two differently worded questions that
/// compile to the same provider queries are one request; the Deep-02 session
/// spent two of twelve discovery calls proving it, sending
/// `all:(inverse AND reinforcement AND learning)` twice from different prose.
/// `maxResults` is deliberately excluded: asking the same question again for
/// more rows is a continuation, which the duplicate notice already directs
/// callers to do with the previous run's cursor.
#[must_use]
pub fn literature_search_provider_fingerprint(input: &str) -> Option<String> {
    let input = serde_json::from_str::<LiteratureSearchInput>(input).ok()?;
    let question = collapse_whitespace(&input.query);
    if question.is_empty() {
        return None;
    }
    let mut requests = casual_search_sources(&input.sources)
        .into_iter()
        .flat_map(|source| {
            plan_source_query_variants(&question, &source)
                .into_iter()
                .map(move |variant| {
                    format!("{source}\u{1f}{}", collapse_whitespace(&variant.query))
                })
        })
        .collect::<Vec<_>>();
    if requests.is_empty() {
        return None;
    }
    // Order-independent: the same set of provider requests is the same cost
    // regardless of which source the planner happened to emit first.
    requests.sort_unstable();
    requests.dedup();
    Some(requests.join("\u{1e}"))
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
    let engines = planned_engines(&requested);
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

fn parse_time_window(value: &str) -> Result<Option<ParsedTimeWindow>, String> {
    let value = collapse_whitespace(value);
    if value.is_empty() {
        return Ok(None);
    }
    let normalized = value
        .replace(['–', '—'], "..")
        .replace(" to ", "..")
        .replace(" TO ", "..");
    let lower = normalized.to_ascii_lowercase();

    let (from, until) = if let Some(rest) = lower
        .strip_prefix("since ")
        .or_else(|| lower.strip_prefix("from "))
    {
        (Some(rest.trim()), None)
    } else if let Some(rest) = lower
        .strip_prefix("until ")
        .or_else(|| lower.strip_prefix("through "))
        .or_else(|| lower.strip_prefix("before "))
    {
        (None, Some(rest.trim()))
    } else if let Some((left, right)) = normalized.split_once("..") {
        (non_empty_str(left), non_empty_str(right))
    } else if normalized.len() == 9
        && normalized.as_bytes().get(4) == Some(&b'-')
        && normalized[..4]
            .chars()
            .all(|character| character.is_ascii_digit())
        && normalized[5..]
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        (Some(&normalized[..4]), Some(&normalized[5..]))
    } else if let Some((left, right)) = normalized.split_once('/') {
        (non_empty_str(left), non_empty_str(right))
    } else {
        (Some(normalized.as_str()), Some(normalized.as_str()))
    };

    let from_date = from
        .map(|part| normalize_time_boundary(part, false))
        .transpose()?;
    let until_date = until
        .map(|part| normalize_time_boundary(part, true))
        .transpose()?;
    if let (Some(from), Some(until)) = (&from_date, &until_date) {
        if from > until {
            return Err(format!(
                "invalid timeWindow {value:?}: start date must not be after end date"
            ));
        }
    }
    Ok(Some(ParsedTimeWindow {
        from_date,
        until_date,
    }))
}

fn non_empty_str(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn normalize_time_boundary(value: &str, end: bool) -> Result<String, String> {
    let value = value.trim();
    if value.len() == 4 && value.chars().all(|character| character.is_ascii_digit()) {
        let year = value
            .parse::<u32>()
            .map_err(|error| format!("invalid year {value:?}: {error}"))?;
        validate_year(year)?;
        return Ok(format!(
            "{year:04}-{}-{}",
            if end { "12" } else { "01" },
            if end { "31" } else { "01" }
        ));
    }
    if value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
    {
        let year = value[..4]
            .parse::<u32>()
            .map_err(|_| format!("invalid ISO date in timeWindow: {value:?}"))?;
        let month = value[5..7]
            .parse::<u32>()
            .map_err(|_| format!("invalid ISO date in timeWindow: {value:?}"))?;
        let day = value[8..10]
            .parse::<u32>()
            .map_err(|_| format!("invalid ISO date in timeWindow: {value:?}"))?;
        validate_year(year)?;
        let max_day = match month {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 if is_leap_year(year) => 29,
            2 => 28,
            _ => 0,
        };
        if day == 0 || day > max_day {
            return Err(format!("invalid ISO date in timeWindow: {value:?}"));
        }
        return Ok(value.to_string());
    }
    Err(format!(
        "invalid timeWindow boundary {value:?}; use YYYY, YYYY-YYYY, YYYY-MM-DD..YYYY-MM-DD, since YYYY, or until YYYY"
    ))
}

fn validate_year(year: u32) -> Result<(), String> {
    if (1000..=3000).contains(&year) {
        Ok(())
    } else {
        Err(format!("timeWindow year {year} is outside 1000..=3000"))
    }
}

fn is_leap_year(year: u32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
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

/// Traverse the citation graph around one paper.
///
/// A whole class of identification task is defined by a citation edge — "the
/// paper that cites X" — and metadata search cannot answer it: arXiv indexes no
/// reference lists at all, and a keyword query over titles and abstracts has no
/// way to express "cites". Without this, such a task can only be approached by
/// guessing keywords until the wanted paper happens to surface, which is what
/// left one identification run with a 274-paper corpus that never contained the
/// target.
///
/// Results are persisted as a durable `SearchRun` with provider artifacts, the
/// same as a metadata search, so a traversal is as auditable and as citable as
/// any other retrieval.
pub fn run_literature_citations(input: LiteratureCitationsInput) -> Result<String, String> {
    let base = runtime::workspace_root_from_env();
    serde_json::to_string_pretty(&literature_citations_at(&base, input, &|| false)?)
        .map_err(|error| error.to_string())
}

pub fn literature_citations_at(
    base: &Path,
    input: LiteratureCitationsInput,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let anchor = normalize_citation_anchor(&input.paper_id)?;
    let direction = CitationDirection::parse(input.direction.as_deref())?;
    let limit = input.max_results.unwrap_or(DEFAULT_RESULT_LIMIT).max(1);
    let client = http_client()?;

    // Semantic Scholar is primary: it addresses arXiv ids and DOIs directly and
    // pages both directions. OpenAlex is the fallback rather than a merge
    // partner, so a working provider is never delayed by a broken one.
    let mut warnings = Vec::new();
    let outcome = match search_semantic_scholar_citations(
        &client,
        &anchor,
        direction,
        limit,
        input.cursor.as_deref(),
        should_cancel,
    ) {
        Ok(outcome) => Ok(("semantic-scholar", outcome)),
        Err(error) if is_cancelled_error(&error) => Err(error),
        Err(error) => {
            warnings.push(format!("semantic-scholar: {error}"));
            search_openalex_citations(&client, &anchor, direction, limit, should_cancel)
                .map(|outcome| ("openalex", outcome))
                .map_err(|fallback| format!("{error}; openalex: {fallback}"))
        }
    }?;
    let (provider, outcome) = outcome;
    warnings.extend(outcome.warnings.clone());

    let question = format!("{} of {}", direction.as_str(), anchor.label);
    let mut store = runtime::open_literature_store_at(base)?;
    let protocol = store.create_protocol(runtime::SearchProtocolDraft {
        question: question.clone(),
        scope: "Citation-graph traversal. Provider citation indexes lag publication and are never complete for recent work; absence here is not evidence that no such paper exists."
            .to_string(),
        time_window: String::new(),
        // A traversal has no query to sort by; results arrive in the provider's
        // own citation order, which `relevance` is the protocol's name for.
        sort_order: "relevance".to_string(),
        databases: vec![provider.to_string()],
        queries: BTreeMap::from([(provider.to_string(), question.clone())]),
        query_variants: BTreeMap::new(),
        max_results: Some(limit),
        inclusion_criteria: Vec::new(),
        exclusion_criteria: Vec::new(),
        known_key_papers: vec![anchor.label.clone()],
    })?;
    let mut run = store.start_run(&protocol)?;

    let mut artifact_ids = Vec::new();
    for provider_artifact in &outcome.raw_artifacts {
        let artifact = store.write_run_artifact(
            &run.id,
            provider,
            &provider_artifact.kind,
            &provider_artifact.extension,
            &provider_artifact.media_type,
            &provider_artifact.bytes,
        )?;
        artifact_ids.push(artifact.id.clone());
        run.artifact_ids.push(artifact.id);
    }
    let normalized_bytes = serde_json::to_vec_pretty(&json!({
        "anchor": anchor.label,
        "direction": direction.as_str(),
        "provider": provider,
        "papers": outcome.papers,
        "coverage": outcome.coverage,
    }))
    .map_err(|error| error.to_string())?;
    let normalized = store.write_run_artifact(
        &run.id,
        provider,
        "normalised-results",
        "json",
        "application/json",
        &normalized_bytes,
    )?;
    artifact_ids.push(normalized.id.clone());
    run.artifact_ids.push(normalized.id.clone());

    let mut record_ids = BTreeSet::new();
    let mut source_ranks = BTreeMap::<String, BTreeMap<String, u32>>::new();
    for (index, paper) in outcome.papers.iter().enumerate() {
        let value = serde_json::to_value(paper).map_err(|error| error.to_string())?;
        let record = canonical_record_from_remote(&value, &run.id, &normalized.id);
        let persisted = store.upsert_canonical_record(&record)?;
        let record_id = persisted.record.id.clone();
        for merged in &persisted.merged_record_ids {
            record_ids.remove(merged);
            source_ranks.remove(merged);
        }
        let rank = u32::try_from(index.saturating_add(1)).unwrap_or(u32::MAX);
        source_ranks
            .entry(record_id.clone())
            .or_default()
            .entry(provider.to_string())
            .and_modify(|current| *current = (*current).min(rank))
            .or_insert(rank);
        record_ids.insert(record_id);
    }
    apply_fused_ranking(&mut run, &record_ids, &source_ranks, &BTreeMap::new());

    run.source_attempts.push(runtime::SourceAttempt {
        source: provider.to_string(),
        request: outcome.request,
        started_at: runtime::now_iso8601(),
        completed_at: Some(runtime::now_iso8601()),
        status: if outcome.coverage.exhausted && warnings.is_empty() {
            runtime::SourceAttemptStatus::Completed
        } else {
            runtime::SourceAttemptStatus::Partial
        },
        hit_count: outcome.hit_count,
        returned_count: u64::try_from(outcome.papers.len()).unwrap_or(u64::MAX),
        coverage: outcome.coverage.clone(),
        quota: outcome.quota,
        failure_code: None,
        failure_message: None,
        coverage_note: outcome.coverage_note.clone(),
        artifact_ids,
    });
    run.status = if outcome.coverage.exhausted && warnings.is_empty() {
        runtime::SearchRunStatus::Completed
    } else {
        runtime::SearchRunStatus::Partial
    };
    run.completed_at = Some(runtime::now_iso8601());
    run.notes.extend(warnings.clone());
    store.finish_run(&mut run)?;

    Ok(json!({
        "anchor": anchor.label,
        "direction": direction.as_str(),
        "provider": provider,
        "searchRun": run,
        "papers": outcome.papers,
        "warnings": warnings,
        "coverage": outcome.coverage,
        "coverageNote": outcome.coverage_note,
        "note": "Citation indexes lag publication and never cover every venue. An empty or short result is a coverage statement about the provider, not evidence that no such paper exists.",
    }))
}

pub fn run_literature_library_upsert(
    input: LiteratureLibraryUpsertInput,
) -> Result<String, String> {
    let base = runtime::workspace_root_from_env();
    let stats = library_upsert_at(&base, &input.papers, input.search.as_ref())?;
    serde_json::to_string_pretty(&stats).map_err(|e| e.to_string())
}

pub fn run_literature_pdf_download(input: LiteraturePdfDownloadInput) -> Result<String, String> {
    run_literature_pdf_download_with_cancel(input, &|| false)
}

pub fn run_literature_pdf_download_with_cancel(
    input: LiteraturePdfDownloadInput,
    should_cancel: &dyn Fn() -> bool,
) -> Result<String, String> {
    let base = runtime::workspace_root_from_env();
    let result = download_pdf_at_with_cancel(
        &base,
        &input.url,
        &input.file_name,
        input.paper_id.as_deref(),
        should_cancel,
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
    let mut draft = input.protocol;
    parse_time_window(&draft.time_window)?;
    if draft.databases.is_empty() {
        draft.databases = casual_search_sources(&[]);
    }
    draft.max_results = Some(draft.max_results.unwrap_or(DEFAULT_RESULT_LIMIT).max(1));
    let question = draft.question.clone();
    for source in &draft.databases {
        let variants = draft
            .query_variants
            .entry(source.clone())
            .or_insert_with(|| plan_source_query_variants(&question, source));
        if let Some(primary) = variants.first() {
            draft
                .queries
                .entry(source.clone())
                .or_insert_with(|| primary.query.clone());
        }
    }
    let mut store = runtime::open_literature_store_at(base)?;
    let protocol = store.create_protocol(draft)?;
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
    let max_results = protocol
        .draft
        .max_results
        .unwrap_or(DEFAULT_RESULT_LIMIT)
        .max(1);
    let parsed_time_window = parse_time_window(&protocol.draft.time_window)?;
    let sources = effective_protocol_sources(&protocol);
    let plan = sources
        .iter()
        .map(|source| -> Result<Value, String> {
            let availability = adapter_availability(source);
            let query_variants = protocol_query_variants_for(&protocol, source);
            let budgets = variant_budgets(max_results, &query_variants)?;
            let query_variant_plan = query_variants
                .iter()
                .zip(budgets)
                .map(|(variant, budget)| {
                    json!({
                        "kind": variant.kind,
                        "query": variant.query,
                        "rationale": variant.rationale,
                        "maxResults": budget,
                        "willExecute": budget > 0,
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "source": source,
                "query": protocol_query_for(&protocol, source),
                "queryVariants": query_variants,
                "queryVariantPlan": query_variant_plan,
                "maxResults": max_results,
                "timeWindow": {
                    "fromDate": parsed_time_window.as_ref().and_then(|window| window.from_date.clone()),
                    "untilDate": parsed_time_window.as_ref().and_then(|window| window.until_date.clone()),
                },
                "sortOrder": protocol.draft.sort_order,
                "adapterStatus": availability.status,
                "executionMode": availability.execution_mode,
                "coverageNote": availability.coverage_note,
                "quotaPolicy": availability.quota_policy,
            }))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "protocol": protocol,
        "plan": plan,
        "confirmationRequired": true,
        "confirmationValue": "execute",
        "maxResults": max_results,
        "fullExport": {
            "requiresExplicitConfirmation": true,
            "note": "maxResults is versioned with this protocol and applies to unique retained records per source. Every adapter pages within provider limits and records whether the result set was exhausted or truncated."
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
    on_progress: impl FnMut(&Value),
) -> Result<Value, String> {
    literature_search_execute_at_with_cancel(base, input, on_progress, &|| false)
}

/// Same as [`literature_search_execute_at`], but stoppable.
///
/// A large protocol is minutes of provider paging — Scopus alone pages 25 rows
/// at a time and arXiv holds a process-wide two-second request interval — so a
/// caller that cannot interrupt it leaves the user watching a run they no
/// longer want. `should_cancel` is polled before each source, before each query
/// variant, and before each provider page, so a stop takes effect within one
/// in-flight request rather than at the end of the run.
///
/// Cancelling never discards work: every source completed before the stop keeps
/// its checkpointed attempt, records, and cursors, and the run is finished as
/// `Partial` so `continueRunId` can pick it up later.
pub fn literature_search_execute_at_with_cancel(
    base: &Path,
    input: LiteratureSearchExecuteInput,
    mut on_progress: impl FnMut(&Value),
    should_cancel: &dyn Fn() -> bool,
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
    let protocol_limit = protocol
        .draft
        .max_results
        .unwrap_or(DEFAULT_RESULT_LIMIT)
        .max(1);
    if let Some(execution_limit) = input.max_results {
        if execution_limit.max(1) != protocol_limit {
            return Err(format!(
                "execution maxResults ({}) does not match the previewed protocol maxResults ({protocol_limit}); create a new protocol revision instead",
                execution_limit.max(1)
            ));
        }
    }
    if input.resume_run_id.is_some() && input.continue_run_id.is_some() {
        return Err("resumeRunId and continueRunId cannot be used together".to_string());
    }
    let limit = protocol_limit;
    let continuation_run = input
        .continue_run_id
        .as_deref()
        .map(|run_id| {
            let previous = store
                .load_run(run_id)?
                .ok_or_else(|| format!("unknown continuation search run: {run_id}"))?;
            if previous.protocol_id != protocol.id
                || previous.protocol_revision != protocol.revision
            {
                return Err(
                    "a continuation can only use the exact protocol revision of its previous run"
                        .to_string(),
                );
            }
            if previous.status == runtime::SearchRunStatus::Running {
                return Err(format!(
                    "search run {run_id} is still running; use resumeRunId instead"
                ));
            }
            if previous.status == runtime::SearchRunStatus::Completed
                || previous.status == runtime::SearchRunStatus::LegacyImported
            {
                return Err(format!(
                    "search run {run_id} is already exhausted and has no continuation"
                ));
            }
            Ok(previous)
        })
        .transpose()?;
    let continuation_attempts = continuation_run
        .as_ref()
        .map(latest_source_attempts)
        .unwrap_or_default();
    let mut run = match input.resume_run_id.as_deref() {
        Some(run_id) => store.resume_run(run_id, &protocol)?,
        None => store.start_run(&protocol)?,
    };
    if let Some(previous) = continuation_run.as_ref() {
        // The network request is a new bounded page, while the continuation
        // SearchRun is the cumulative protocol result. Preserve the prior
        // records and provider ranks so later pages cannot hide or outrank
        // earlier provider results.
        run.record_ids = previous.record_ids.clone();
        run.ranked_records = previous.ranked_records.clone();
        run.notes.push(format!(
            "Continuation of bounded SearchRun {}.",
            previous.id
        ));
    }
    let mut warnings = Vec::new();
    let mut cancelled = false;
    let mut all_record_ids = run.record_ids.iter().cloned().collect::<BTreeSet<_>>();
    let mut record_source_ranks = BTreeMap::<String, BTreeMap<String, u32>>::new();
    let mut record_variant_ranks = BTreeMap::<String, BTreeMap<String, u32>>::new();
    for ranked in &run.ranked_records {
        record_source_ranks.insert(ranked.record_id.clone(), ranked.source_ranks.clone());
        if !ranked.variant_ranks.is_empty() {
            record_variant_ranks.insert(ranked.record_id.clone(), ranked.variant_ranks.clone());
        }
    }

    for source in effective_protocol_sources(&protocol) {
        // Stop before opening a new source. Sources already checkpointed above
        // keep their records and cursors, so the run stays continuable.
        if !cancelled && should_cancel() {
            cancelled = true;
        }
        if cancelled {
            on_progress(&json!({
                "searchRunId": run.id,
                "source": source,
                "phase": "cancelled",
                "message": "The user stopped this run before the source was attempted."
            }));
            continue;
        }
        if source_has_completed_attempt(&run, &source) {
            on_progress(&json!({
                "searchRunId": run.id,
                "source": source,
                "phase": "skipped",
                "message": "Source was already checkpointed as a terminal completed or partial attempt."
            }));
            continue;
        }
        let continuation_attempt = continuation_attempts.get(&source);
        if let Some(previous) = continuation_attempt.filter(|attempt| attempt.coverage.exhausted) {
            run.source_attempts.push(runtime::SourceAttempt {
                source: source.clone(),
                request: json!({
                    "continuedFromRunId": continuation_run.as_ref().map(|run| &run.id),
                    "action": "already_exhausted",
                }),
                started_at: runtime::now_iso8601(),
                completed_at: Some(runtime::now_iso8601()),
                status: runtime::SourceAttemptStatus::Completed,
                hit_count: previous.hit_count,
                returned_count: 0,
                coverage: runtime::SearchCoverage {
                    total_hits: previous.coverage.total_hits,
                    fetched: previous.coverage.fetched,
                    unique: previous.coverage.unique,
                    exhausted: true,
                    next_cursor: None,
                    truncated_reason: None,
                },
                quota: Value::Null,
                failure_code: None,
                failure_message: None,
                coverage_note: Some(format!(
                    "No request was made because {source} was exhausted in the previous run."
                )),
                artifact_ids: Vec::new(),
            });
            store.checkpoint_run(&mut run)?;
            on_progress(&json!({
                "searchRunId": run.id,
                "source": source,
                "phase": "skipped",
                "message": "Source was exhausted in the previous bounded page."
            }));
            continue;
        }
        if let Some(previous) = continuation_attempt.filter(|attempt| {
            matches!(attempt.status, runtime::SourceAttemptStatus::Partial)
                && attempt.coverage.next_cursor.is_none()
        }) {
            let reason = previous
                .coverage
                .truncated_reason
                .clone()
                .unwrap_or_else(|| "provider_result_window".to_string());
            warnings.push(format!(
                "{source}: previous partial result has no resumable cursor ({reason})"
            ));
            run.source_attempts.push(runtime::SourceAttempt {
                source: source.clone(),
                request: json!({
                    "continuedFromRunId": continuation_run.as_ref().map(|run| &run.id),
                    "action": "unresumable",
                }),
                started_at: runtime::now_iso8601(),
                completed_at: Some(runtime::now_iso8601()),
                status: runtime::SourceAttemptStatus::Partial,
                hit_count: previous.hit_count,
                returned_count: 0,
                coverage: runtime::SearchCoverage {
                    total_hits: previous.coverage.total_hits,
                    fetched: previous.coverage.fetched,
                    unique: previous.coverage.unique,
                    exhausted: false,
                    next_cursor: None,
                    truncated_reason: Some(reason),
                },
                quota: Value::Null,
                failure_code: Some("continuation_unavailable".to_string()),
                failure_message: Some(
                    "The provider did not expose a cursor beyond its result window.".to_string(),
                ),
                coverage_note: previous.coverage_note.clone(),
                artifact_ids: Vec::new(),
            });
            store.checkpoint_run(&mut run)?;
            continue;
        }
        let continuation_cursor =
            continuation_attempt.and_then(|attempt| attempt.coverage.next_cursor.as_deref());
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
        let query_variants = protocol_query_variants_for(&protocol, &source);
        let query = query_variants
            .first()
            .map(|variant| variant.query.clone())
            .unwrap_or_else(|| protocol_query_for(&protocol, &source));
        let availability = adapter_availability(&source);
        if availability.status != "available" {
            let missing_credentials = availability.status == "missing_credentials";
            let failure_code = if missing_credentials {
                "credentials_missing"
            } else {
                "adapter_not_implemented"
            };
            let failure_message = if missing_credentials {
                "The requested source is unavailable because its API credential is not configured."
            } else {
                "The source adapter has not been migrated yet."
            };
            warnings.push(format!("{source}: {failure_message}"));
            run.source_attempts.push(runtime::SourceAttempt {
                source,
                request: json!({ "query": query, "maxResults": limit }),
                started_at,
                completed_at: Some(runtime::now_iso8601()),
                status: if missing_credentials {
                    runtime::SourceAttemptStatus::Unauthorised
                } else {
                    runtime::SourceAttemptStatus::Unavailable
                },
                hit_count: continuation_attempt.and_then(|previous| previous.hit_count),
                returned_count: 0,
                coverage: runtime::SearchCoverage {
                    total_hits: continuation_attempt
                        .and_then(|previous| previous.coverage.total_hits),
                    fetched: continuation_attempt
                        .map(|previous| previous.coverage.fetched)
                        .unwrap_or(0),
                    unique: continuation_attempt
                        .map(|previous| previous.coverage.unique)
                        .unwrap_or(0),
                    exhausted: false,
                    next_cursor: continuation_cursor.map(str::to_string),
                    truncated_reason: Some(failure_code.to_string()),
                },
                quota: Value::Null,
                failure_code: Some(failure_code.to_string()),
                failure_message: Some(failure_message.to_string()),
                coverage_note: Some(availability.coverage_note.to_string()),
                artifact_ids: Vec::new(),
            });
            store.checkpoint_run(&mut run)?;
            continue;
        }

        run.source_attempts.push(runtime::SourceAttempt {
            source: source.clone(),
            request: json!({
                "preview": adapter_request_preview(&source, &query, limit),
                "timeWindow": protocol.draft.time_window,
                "cursor": continuation_cursor,
                "continuedFromRunId": continuation_run.as_ref().map(|run| &run.id),
            }),
            started_at: started_at.clone(),
            completed_at: None,
            status: runtime::SourceAttemptStatus::Running,
            hit_count: None,
            returned_count: 0,
            coverage: runtime::SearchCoverage::default(),
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

        let source_rank_offset = record_source_ranks
            .values()
            .filter_map(|ranks| ranks.get(&source))
            .copied()
            .max()
            .unwrap_or(0);
        // Each variant keeps its own rank sequence, so a continuation page must
        // start after that variant's furthest known rank rather than after the
        // source-wide maximum.
        let variant_rank_offsets = query_variants
            .iter()
            .map(|variant| {
                let offset = record_variant_ranks
                    .values()
                    .filter_map(|ranks| ranks.get(&variant.kind))
                    .copied()
                    .max()
                    .unwrap_or(0);
                (variant.kind.clone(), offset)
            })
            .collect::<BTreeMap<_, _>>();
        match search_source_with_audit(
            &query_variants,
            &source,
            limit,
            &protocol.draft.time_window,
            &protocol.draft.sort_order,
            continuation_cursor,
            input.variant_budgets.as_ref(),
            should_cancel,
        ) {
            Ok(mut outcome) => {
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
                    // Positionally aligned with `papers`, so the normalised
                    // artifact stays a self-contained audit record of which
                    // query variant produced each paper at which rank.
                    "variantRanks": outcome.variant_ranks,
                    "warnings": outcome.warnings,
                    "request": outcome.request,
                    "hitCount": outcome.hit_count,
                    "coverage": outcome.coverage,
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
                let paper_variant_ranks = normalized["variantRanks"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let mut inserted_or_seen = 0_u64;
                for (source_index, paper) in papers.iter().enumerate() {
                    let record = canonical_record_from_remote(paper, &run.id, &artifact.id);
                    let persisted = store.upsert_canonical_record(&record)?;
                    let record_id = persisted.record.id.clone();
                    for merged_record_id in &persisted.merged_record_ids {
                        all_record_ids.remove(merged_record_id);
                        if let Some(merged_ranks) = record_source_ranks.remove(merged_record_id) {
                            let target = record_source_ranks.entry(record_id.clone()).or_default();
                            for (ranked_source, rank) in merged_ranks {
                                target
                                    .entry(ranked_source)
                                    .and_modify(|current| *current = (*current).min(rank))
                                    .or_insert(rank);
                            }
                        }
                        if let Some(merged_ranks) = record_variant_ranks.remove(merged_record_id) {
                            let target = record_variant_ranks.entry(record_id.clone()).or_default();
                            for (ranked_variant, rank) in merged_ranks {
                                target
                                    .entry(ranked_variant)
                                    .and_modify(|current| *current = (*current).min(rank))
                                    .or_insert(rank);
                            }
                        }
                    }
                    let page_rank =
                        u32::try_from(source_index.saturating_add(1)).unwrap_or(u32::MAX);
                    let source_rank = source_rank_offset.saturating_add(page_rank);
                    record_source_ranks
                        .entry(record_id.clone())
                        .or_default()
                        .entry(source.clone())
                        .and_modify(|rank| *rank = (*rank).min(source_rank))
                        .or_insert(source_rank);
                    for (variant_kind, variant_page_rank) in paper_variant_ranks
                        .get(source_index)
                        .and_then(Value::as_object)
                        .into_iter()
                        .flatten()
                        .filter_map(|(kind, rank)| {
                            rank.as_u64()
                                .and_then(|rank| u32::try_from(rank).ok())
                                .map(|rank| (kind.clone(), rank))
                        })
                    {
                        let variant_rank = variant_rank_offsets
                            .get(&variant_kind)
                            .copied()
                            .unwrap_or(0)
                            .saturating_add(variant_page_rank);
                        record_variant_ranks
                            .entry(record_id.clone())
                            .or_default()
                            .entry(variant_kind)
                            .and_modify(|rank| *rank = (*rank).min(variant_rank))
                            .or_insert(variant_rank);
                    }
                    all_record_ids.insert(record_id);
                    inserted_or_seen = inserted_or_seen.saturating_add(1);
                }
                let source_warnings = outcome.warnings;
                warnings.extend(source_warnings.clone());
                if let Some(previous) = continuation_attempt {
                    outcome.coverage.fetched = previous
                        .coverage
                        .fetched
                        .saturating_add(outcome.coverage.fetched);
                    outcome.coverage.total_hits =
                        outcome.coverage.total_hits.or(previous.coverage.total_hits);
                    outcome.hit_count = outcome.hit_count.or(previous.hit_count);
                    outcome.coverage.unique = u64::try_from(
                        record_source_ranks
                            .values()
                            .filter(|ranks| ranks.contains_key(&source))
                            .count(),
                    )
                    .unwrap_or(u64::MAX);
                }
                if !outcome.coverage.exhausted {
                    warnings.push(format!(
                        "{source}: retrieval was not exhausted ({})",
                        outcome
                            .coverage
                            .truncated_reason
                            .as_deref()
                            .unwrap_or("unknown_reason")
                    ));
                }
                let status = if source_warnings.is_empty() && outcome.coverage.exhausted {
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
                    attempt.coverage = outcome.coverage;
                    attempt.quota = outcome.quota;
                    attempt.coverage_note = outcome.coverage_note;
                    attempt.artifact_ids = artifact_ids;
                }
                apply_fused_ranking(
                    &mut run,
                    &all_record_ids,
                    &record_source_ranks,
                    &record_variant_ranks,
                );
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
                // A stop is a user decision, not a provider fault: record it
                // under its own code so a cancelled run is never read back as a
                // broken adapter, and stop opening further sources.
                let stopped = is_cancelled_error(&error);
                cancelled |= stopped;
                let failure_code = if stopped {
                    "cancelled"
                } else {
                    "adapter_request_failed"
                };
                let status = if stopped {
                    runtime::SourceAttemptStatus::Partial
                } else {
                    source_failure_status(&error)
                };
                warnings.push(format!("{source}: {error}"));
                let attempt = run
                    .source_attempts
                    .last_mut()
                    .expect("running attempt exists");
                attempt.completed_at = Some(runtime::now_iso8601());
                attempt.status = status;
                attempt.failure_code = Some(failure_code.to_string());
                attempt.failure_message = Some(error.to_string());
                attempt.coverage = runtime::SearchCoverage {
                    total_hits: continuation_attempt
                        .and_then(|previous| previous.coverage.total_hits),
                    fetched: continuation_attempt
                        .map(|previous| previous.coverage.fetched)
                        .unwrap_or(0),
                    unique: continuation_attempt
                        .map(|previous| previous.coverage.unique)
                        .unwrap_or(0),
                    exhausted: false,
                    next_cursor: continuation_cursor.map(str::to_string),
                    truncated_reason: Some(failure_code.to_string()),
                };
                store.checkpoint_run(&mut run)?;
                on_progress(&json!({
                    "searchRunId": run.id,
                    "source": source,
                    "phase": if stopped { "cancelled" } else { "failed" },
                    "message": error.to_string(),
                }));
            }
        }
    }
    apply_fused_ranking(
        &mut run,
        &all_record_ids,
        &record_source_ranks,
        &record_variant_ranks,
    );
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
    let incomplete = latest_attempts.iter().any(|attempt| {
        matches!(attempt.status, runtime::SourceAttemptStatus::Partial)
            || !attempt.coverage.exhausted
    });
    run.status = if cancelled {
        // A stop is never `Failed` (the sources that ran are intact) and never
        // `Completed` (the rest never ran). `Partial` is also the only status
        // `continueRunId` accepts, so the run stays resumable.
        runtime::SearchRunStatus::Partial
    } else if !latest_attempts.is_empty() && failures == latest_attempts.len() {
        runtime::SearchRunStatus::Failed
    } else if failures > 0 || incomplete || !warnings.is_empty() {
        runtime::SearchRunStatus::Partial
    } else {
        runtime::SearchRunStatus::Completed
    };
    run.completed_at = Some(runtime::now_iso8601());
    if cancelled {
        run.notes.push(
            "Execution was stopped by the user. Sources checkpointed before the stop keep their records and cursors; continue this run to finish the remaining coverage."
                .to_string(),
        );
    }
    run.notes.extend(warnings.clone());
    store.finish_run(&mut run)?;
    let mut record_preview = Vec::new();
    for ranked in run.ranked_records.iter().take(20) {
        if let Some(record) = store.load_canonical_record(&ranked.record_id)? {
            record_preview.push(json!({
                "id": ranked.record_id,
                "title": record.title,
                "authors": record.authors,
                "year": record.year,
                "venue": record.venue,
                "sourceRanks": ranked.source_ranks,
                "fusedScoreMicros": ranked.fused_score_micros,
            }));
        }
    }
    Ok(json!({
        "searchRun": run,
        "warnings": warnings,
        "cancelled": cancelled,
        "recordPreview": record_preview,
        "recordPreviewNote": "Metadata samples from this SearchRun only. They are not ScreenDecision or EvidenceCard objects.",
        "next": if cancelled {
            "The user stopped this run. Report the partial coverage as partial, and continue the run with continueRunId if the remaining sources are still wanted."
        } else {
            "Review the run and canonical records before creating ScreenDecision or EvidenceCard objects."
        }
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

fn latest_source_attempts(run: &runtime::SearchRun) -> BTreeMap<String, runtime::SourceAttempt> {
    let mut attempts = BTreeMap::new();
    for attempt in run.source_attempts.iter().rev() {
        attempts
            .entry(attempt.source.trim().to_ascii_lowercase())
            .or_insert_with(|| attempt.clone());
    }
    attempts
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

fn protocol_query_variants_for(
    protocol: &runtime::SearchProtocol,
    source: &str,
) -> Vec<runtime::SearchQueryVariant> {
    let mut variants = protocol
        .draft
        .query_variants
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(source))
        .map(|(_, variants)| variants.clone())
        .unwrap_or_default();
    if variants.is_empty() {
        variants.push(runtime::SearchQueryVariant {
            kind: "primary".to_string(),
            query: protocol_query_for(protocol, source),
            rationale: "Backwards-compatible protocol query.".to_string(),
            max_results: None,
        });
    }
    let mut seen = BTreeSet::new();
    variants.retain(|variant| {
        !variant.query.trim().is_empty()
            && seen.insert(
                variant
                    .query
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_ascii_lowercase(),
            )
    });
    variants
}

fn plan_source_query_variants(question: &str, source: &str) -> Vec<runtime::SearchQueryVariant> {
    let normalized = collapse_whitespace(question);
    if source.trim().eq_ignore_ascii_case("scopus") && contains_cjk(&normalized) {
        return Vec::new();
    }
    if source.trim().eq_ignore_ascii_case("arxiv") {
        return plan_arxiv_query_variants(question);
    }
    let terms = query_content_terms(&normalized);
    let broad = if terms.is_empty() {
        normalized.clone()
    } else {
        terms.join(" ")
    };
    let exact = normalized.trim_matches('"').to_string();
    let synonym = synonym_query_variant(&terms);
    let language = language_query_variant(&terms);
    let precision_kind = if source.eq_ignore_ascii_case("scopus") {
        "precision_terms"
    } else {
        "exact_phrase"
    };
    let mut variants = vec![
        runtime::SearchQueryVariant {
            kind: "broad_keywords".to_string(),
            query: format_source_query(source, "broad_keywords", &broad),
            rationale: "High-recall content terms with question scaffolding removed.".to_string(),
            max_results: None,
        },
        runtime::SearchQueryVariant {
            kind: precision_kind.to_string(),
            query: format_source_query(source, precision_kind, &exact),
            rationale: if source.eq_ignore_ascii_case("scopus") {
                "Precision terms joined explicitly without forcing the full question into one quoted Scopus phrase."
                    .to_string()
            } else {
                "Precision supplement; never replaces the broad query.".to_string()
            },
            max_results: None,
        },
    ];
    if let Some(query) = synonym {
        variants.push(runtime::SearchQueryVariant {
            kind: "synonym_expansion".to_string(),
            query: format_source_query(source, "synonym_expansion", &query),
            rationale: "Research terminology and spelling aliases.".to_string(),
            max_results: None,
        });
    }
    if let Some(query) = language {
        variants.push(runtime::SearchQueryVariant {
            kind: "language_variant".to_string(),
            query: format_source_query(source, "language_variant", &query),
            rationale: "Cross-language aliases for common research concepts.".to_string(),
            max_results: None,
        });
    }
    let mut seen = BTreeSet::new();
    variants.retain(|variant| {
        !variant.query.trim().is_empty() && seen.insert(variant.query.trim().to_ascii_lowercase())
    });
    variants
}

/// arXiv's API indexes metadata, not reference lists or PDF/HTML body text.
/// A casual clue bundle must therefore discover candidates through a few
/// independent, metadata-plausible anchors and reserve citation, appendix, and
/// preprocessing details for the later full-text verification step. Joining
/// every clue with `AND` silently turns those body-only details into a
/// zero-result query.
fn plan_arxiv_query_variants(question: &str) -> Vec<runtime::SearchQueryVariant> {
    let explicit = question.trim();
    if explicit.is_empty() {
        return Vec::new();
    }
    if has_explicit_arxiv_syntax(explicit) {
        return vec![runtime::SearchQueryVariant {
            kind: "explicit_arxiv".to_string(),
            query: explicit.to_string(),
            rationale: "Caller-supplied arXiv field syntax is preserved byte-for-byte; it is not tokenized into a casual-query variant.".to_string(),
            max_results: None,
        }];
    }
    let normalized = collapse_whitespace(explicit);

    // One call must be able to carry both a precise conjunction and a second,
    // materially different one. The Deep-02 post-mortem showed twelve calls
    // buying only eleven distinct arXiv queries because each call compiled to a
    // single three-term conjunction.
    const MAX_DISCOVERY_VARIANTS: usize = 4;
    const TOPIC_CONJUNCTION_TERMS: usize = 3;
    let mut variants = Vec::new();
    let mut seen = BTreeSet::new();

    for identifier in arxiv_named_anchors(&normalized) {
        push_arxiv_discovery_anchor(
            &mut variants,
            &mut seen,
            MAX_DISCOVERY_VARIANTS,
            "named_anchor",
            format!("all:\"{identifier}\""),
            "One named dataset/person/corpus anchor for metadata discovery. Do not require unindexed citation or appendix clues here.",
        );
    }
    for phrase in quoted_arxiv_phrases(&normalized)
        .into_iter()
        .filter(|phrase| is_distinctive_arxiv_phrase(phrase))
    {
        push_arxiv_discovery_anchor(
            &mut variants,
            &mut seen,
            MAX_DISCOVERY_VARIANTS,
            "phrase_anchor",
            format!("all:\"{phrase}\""),
            "One distinctive phrase anchor for metadata discovery. Its relationship to the candidate is verified from full text later.",
        );
    }

    // Ranked most-discriminative first, so the conjunction keeps the terms that
    // actually narrow the search instead of the ones written first.
    let topic_terms = arxiv_topic_terms(&normalized);
    if !topic_terms.is_empty() {
        push_arxiv_discovery_anchor(
            &mut variants,
            &mut seen,
            MAX_DISCOVERY_VARIANTS,
            "topic_anchor",
            format!(
                "all:({})",
                topic_terms
                    .iter()
                    .take(TOPIC_CONJUNCTION_TERMS)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" AND ")
            ),
            "The most discriminative terms of the question. Citation, preprocessing, and recording-quality clues are verification-only because arXiv metadata does not index paper bodies.",
        );
    }
    // A three-way AND on rare terms can legitimately return nothing, and the
    // terms just outside the cut are often the ones that would have matched.
    // Keep the strongest anchor and pair it with the next tier so the second
    // conjunction explores a different region instead of a subset of the first.
    if topic_terms.len() > TOPIC_CONJUNCTION_TERMS {
        let mut alternate = vec![topic_terms[0].clone()];
        alternate.extend(
            topic_terms
                .iter()
                .skip(TOPIC_CONJUNCTION_TERMS)
                .take(TOPIC_CONJUNCTION_TERMS - 1)
                .cloned(),
        );
        push_arxiv_discovery_anchor(
            &mut variants,
            &mut seen,
            MAX_DISCOVERY_VARIANTS,
            "topic_alt_anchor",
            format!("all:({})", alternate.join(" AND ")),
            "The strongest anchor paired with the next tier of terms, so one call covers two materially different conjunctions rather than one.",
        );
    }

    if variants.is_empty() {
        let fallback = arxiv_terms_by_specificity(query_content_terms(&normalized))
            .into_iter()
            .take(TOPIC_CONJUNCTION_TERMS)
            .collect::<Vec<_>>()
            .join(" AND ");
        if !fallback.is_empty() {
            push_arxiv_discovery_anchor(
                &mut variants,
                &mut seen,
                MAX_DISCOVERY_VARIANTS,
                "topic_anchor",
                format!("all:({fallback})"),
                "Compact fallback metadata query.",
            );
        }
    }
    variants
}

fn push_arxiv_discovery_anchor(
    variants: &mut Vec<runtime::SearchQueryVariant>,
    seen: &mut BTreeSet<String>,
    limit: usize,
    kind: &str,
    query: String,
    rationale: &str,
) {
    if variants.len() < limit && seen.insert(query.trim().to_ascii_lowercase()) {
        variants.push(runtime::SearchQueryVariant {
            kind: kind.to_string(),
            query,
            rationale: rationale.to_string(),
            max_results: None,
        });
    }
}

fn has_explicit_arxiv_syntax(query: &str) -> bool {
    let lower = query.to_ascii_lowercase();
    [
        "all:", "abs:", "ti:", "au:", "cat:", "co:", "jr:", "rn:", "id:",
    ]
    .iter()
    .any(|field| lower.contains(field))
}

fn quoted_arxiv_phrases(query: &str) -> Vec<String> {
    let mut phrases = Vec::new();
    let mut in_quote = false;
    let mut current = String::new();
    for character in query.chars() {
        if character == '"' {
            if in_quote {
                let phrase = collapse_whitespace(&current);
                if phrase.chars().count() >= 3 {
                    phrases.push(phrase);
                }
                current.clear();
            }
            in_quote = !in_quote;
        } else if in_quote {
            current.push(character);
        }
    }
    dedupe_query_atoms(phrases)
}

fn is_distinctive_arxiv_phrase(phrase: &str) -> bool {
    query_content_terms(phrase).len() >= 2 || looks_like_arxiv_named_anchor(phrase)
}

fn arxiv_named_anchors(query: &str) -> Vec<String> {
    let anchors = query
        .split(|character: char| !(character.is_alphanumeric() || character == '-'))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .filter(|token| looks_like_arxiv_named_anchor(token))
        .map(str::to_string)
        .collect::<Vec<_>>();
    dedupe_query_atoms(anchors)
}

fn looks_like_arxiv_named_anchor(token: &str) -> bool {
    let letters = token
        .chars()
        .filter(|character| character.is_ascii_alphabetic())
        .collect::<Vec<_>>();
    if letters.len() < 2 {
        return false;
    }
    let has_upper = letters
        .iter()
        .any(|character| character.is_ascii_uppercase());
    let all_upper = letters
        .iter()
        .all(|character| character.is_ascii_uppercase());
    let has_digit = token.chars().any(|character| character.is_ascii_digit());
    let has_hyphen = token.contains('-');
    let has_internal_upper = token
        .chars()
        .skip(1)
        .any(|character| character.is_ascii_uppercase());
    (all_upper && token.len() >= 2)
        || (has_upper && (has_digit || has_hyphen || has_internal_upper))
}

/// Words that appear in a large fraction of machine-learning abstracts and so
/// remove almost nothing from a conjunction. They stay usable — a query built
/// only from them is still better than no query — but they sort last, after any
/// term that actually narrows the result set.
const LOW_SPECIFICITY_TERMS: &[&str] = &[
    "algorithm",
    "algorithms",
    "analysis",
    "approach",
    "approaches",
    "based",
    "data",
    "deep",
    "framework",
    "general",
    "learning",
    "method",
    "methods",
    "model",
    "models",
    "network",
    "networks",
    "neural",
    "new",
    "novel",
    "paper",
    "performance",
    "problem",
    "problems",
    "research",
    "result",
    "results",
    "study",
    "system",
    "systems",
    "task",
    "tasks",
    "train",
    "training",
    "using",
    "via",
    "work",
];

/// How much a single term narrows an arXiv metadata search, higher is narrower.
///
/// arXiv exposes no term statistics, so this is a deliberately coarse proxy
/// rather than a real IDF. It answers one question — is this word worth a slot
/// in a three-way `AND`? — with three tiers, and nothing finer. Word length is
/// specifically *not* a signal: `evaluation` is no rarer than `retrieval`, and
/// scoring by length would reshuffle equally common terms on every query and
/// make the compiled request harder to read against the caller's own wording.
fn arxiv_term_specificity(term: &str) -> u8 {
    if LOW_SPECIFICITY_TERMS.contains(&term) {
        return 0;
    }
    // A hyphen or digit marks a compound or versioned technical token —
    // `off-policy`, `sim2real`, `d4rl` — which is nearly always narrower than a
    // plain English word.
    if term.contains('-') || term.chars().any(|character| character.is_ascii_digit()) {
        return 2;
    }
    1
}

/// Order a query's content terms most-discriminative first, preserving the
/// caller's order within a tier.
///
/// The compiler used to keep whichever three terms the caller happened to write
/// first, which deleted exactly the words a clue is built from: a search for
/// "random network ensemble disagreement imitation learning demonstrations
/// bounded" went out as `all:(random AND network AND ensemble)` while
/// `disagreement` and `bounded` — the only terms that distinguish the wanted
/// paper from thousands of others — were dropped before the request was made.
fn arxiv_terms_by_specificity(terms: Vec<String>) -> Vec<String> {
    let mut ranked = terms;
    // Stable, so a caller's own ordering still decides between terms the
    // heuristic cannot separate.
    ranked.sort_by_key(|term| std::cmp::Reverse(arxiv_term_specificity(term)));
    ranked
}

fn arxiv_topic_terms(query: &str) -> Vec<String> {
    const VERIFICATION_ONLY_TERMS: &[&str] = &[
        "actual",
        "appendix",
        "citation",
        "citations",
        "cited",
        "cites",
        "excluded",
        "frame",
        "half",
        "labeled",
        "labelled",
        "nominal",
        "preprocess",
        "preprocessing",
        "punctuation",
        "rate",
        "recording",
        "recordings",
        "reference",
        "references",
        "session",
        "sessions",
        "transcript",
        "transcripts",
        "weakly",
    ];
    let quoted_terms = quoted_arxiv_phrases(query)
        .into_iter()
        .flat_map(|phrase| query_content_terms(&phrase))
        .collect::<BTreeSet<_>>();
    let named_terms = arxiv_named_anchors(query)
        .into_iter()
        .flat_map(|anchor| query_content_terms(&anchor))
        .collect::<BTreeSet<_>>();
    arxiv_terms_by_specificity(
        query_content_terms(query)
            .into_iter()
            .filter(|term| {
                !VERIFICATION_ONLY_TERMS.contains(&term.as_str())
                    && !quoted_terms.contains(term)
                    && !named_terms.contains(term)
            })
            .collect(),
    )
}

fn dedupe_query_atoms(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.to_ascii_lowercase()))
        .collect()
}

fn query_content_terms(query: &str) -> Vec<String> {
    const STOPWORDS: [&str; 30] = [
        "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "how", "in",
        "is", "of", "on", "or", "that", "the", "these", "this", "to", "use", "what", "when",
        "where", "which", "with", "why",
    ];
    let mut terms = Vec::new();
    let mut seen = BTreeSet::new();
    for term in query
        .split(|character: char| !(character.is_alphanumeric() || character == '-'))
        .map(str::trim)
        .filter(|term| !term.is_empty())
    {
        let normalized = term.trim_matches('-').to_lowercase();
        if normalized.is_empty()
            || (normalized.is_ascii() && STOPWORDS.contains(&normalized.as_str()))
            || !seen.insert(normalized.clone())
        {
            continue;
        }
        terms.push(normalized);
    }
    terms
}

fn synonym_query_variant(terms: &[String]) -> Option<String> {
    let aliases = [
        ("evaluation", "assessment"),
        ("assessment", "evaluation"),
        ("method", "approach"),
        ("methods", "approaches"),
        ("effect", "impact"),
        ("behavior", "behaviour"),
        ("behaviour", "behavior"),
        ("optimization", "optimisation"),
        ("optimisation", "optimization"),
        ("retrieval", "search"),
        ("search", "retrieval"),
        ("paper", "literature"),
        ("robot", "robotics"),
    ];
    let mut expanded = terms.to_vec();
    for term in terms {
        if let Some((_, alias)) = aliases.iter().find(|(candidate, _)| candidate == term) {
            expanded.push((*alias).to_string());
        }
    }
    (expanded.len() > terms.len()).then(|| expanded.join(" "))
}

fn language_query_variant(terms: &[String]) -> Option<String> {
    if !terms.iter().any(|term| contains_cjk(term)) {
        return None;
    }
    let aliases = [
        ("研究", "research"),
        ("方法", "method approach"),
        ("模型", "model"),
        ("评估", "evaluation assessment"),
        ("系统", "system"),
        ("搜索", "search retrieval"),
        ("检索", "retrieval search"),
        ("文献", "literature paper"),
        ("机器人", "robot robotics"),
        ("通信", "communication"),
        ("网络", "network"),
    ];
    let mut translated = Vec::new();
    for term in terms {
        for (candidate, alias) in aliases {
            if term == candidate || term.contains(candidate) {
                translated.extend(alias.split_whitespace().map(str::to_string));
            }
        }
    }
    (!translated.is_empty()).then(|| translated.join(" "))
}

fn contains_cjk(value: &str) -> bool {
    value.chars().any(|character| {
        matches!(
            character as u32,
            0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF
        )
    })
}

fn format_source_query(source: &str, kind: &str, query: &str) -> String {
    let source = source.trim().to_ascii_lowercase();
    let normalized = if source == "semantic-scholar" {
        collapse_whitespace(&query.replace(['-', '‐', '‑', '–', '—'], " "))
    } else {
        collapse_whitespace(query)
    };
    match (source.as_str(), kind) {
        ("scopus", "precision_terms") => {
            let terms = query_content_terms(&normalized);
            if terms.is_empty() {
                format!("TITLE-ABS-KEY({})", scopus_phrase(&normalized))
            } else {
                format!("TITLE-ABS-KEY({})", terms.join(" AND "))
            }
        }
        ("scopus", "synonym_expansion") => {
            format!(
                "TITLE-ABS-KEY({})",
                query_content_terms(&normalized).join(" OR ")
            )
        }
        ("openalex", "synonym_expansion") => query_content_terms(&normalized).join(" OR "),
        ("semantic-scholar", "synonym_expansion") => query_content_terms(&normalized).join(" | "),
        ("arxiv", "exact_phrase") => format!("all:\"{}\"", normalized.replace('"', " ")),
        ("arxiv", "synonym_expansion") => {
            format!("all:({})", query_content_terms(&normalized).join(" OR "))
        }
        ("arxiv", _) => {
            let terms = query_content_terms(&normalized);
            if terms.is_empty() {
                normalized
            } else {
                format!("all:({})", terms.join(" AND "))
            }
        }
        (_, "exact_phrase") => format!("\"{}\"", normalized.replace('"', " ")),
        _ => normalized,
    }
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

fn apply_fused_ranking(
    run: &mut runtime::SearchRun,
    all_record_ids: &BTreeSet<String>,
    source_ranks: &BTreeMap<String, BTreeMap<String, u32>>,
    variant_ranks: &BTreeMap<String, BTreeMap<String, u32>>,
) {
    const RRF_K: u64 = 60;
    const SCORE_SCALE: u64 = 1_000_000_000;
    let mut ranked = all_record_ids
        .iter()
        .map(|record_id| {
            let ranks = source_ranks.get(record_id).cloned().unwrap_or_default();
            let fused_score_micros = ranks.values().fold(0_u64, |score, rank| {
                score.saturating_add(SCORE_SCALE / RRF_K.saturating_add(u64::from(*rank)))
            });
            runtime::SearchRecordRank {
                record_id: record_id.clone(),
                source_ranks: ranks,
                variant_ranks: variant_ranks.get(record_id).cloned().unwrap_or_default(),
                fused_score_micros,
            }
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .fused_score_micros
            .cmp(&left.fused_score_micros)
            .then_with(|| {
                let left_best = left
                    .source_ranks
                    .values()
                    .copied()
                    .min()
                    .unwrap_or(u32::MAX);
                let right_best = right
                    .source_ranks
                    .values()
                    .copied()
                    .min()
                    .unwrap_or(u32::MAX);
                left_best.cmp(&right_best)
            })
            .then_with(|| left.record_id.cmp(&right.record_id))
    });
    run.record_ids = ranked
        .iter()
        .map(|ranked| ranked.record_id.clone())
        .collect();
    run.ranked_records = ranked;
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

fn is_cancelled_error(error: &str) -> bool {
    error.contains(CANCELLED_ERROR)
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
    crate::layout::papers_dir_at(base).join(LIBRARY_FILE)
}

fn legacy_library_path_at(base: &Path) -> PathBuf {
    base.join(PAPERS_DIR).join(LIBRARY_FILE)
}

fn existing_library_path_at(base: &Path) -> PathBuf {
    let managed = library_path_at(base);
    if managed.exists() || managed.with_extension("json.bak").exists() {
        managed
    } else {
        legacy_library_path_at(base)
    }
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
    library_full_text_search_page_at(base, query, limit, Some(0))
}

pub fn library_full_text_search_page_at(
    base: &Path,
    query: &str,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Value, String> {
    let store = runtime::open_literature_store_at(base)?;
    let page = store.full_text_search_page(
        query,
        limit.unwrap_or(100).clamp(1, 250),
        offset.unwrap_or(0),
    )?;
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
    let papers = page
        .hits
        .iter()
        .filter_map(|hit| papers_by_id.get(&hit.record_id).cloned())
        .collect::<Vec<_>>();
    Ok(json!({
        "query": query,
        "hits": page.hits,
        "papers": papers,
        "total": page.total,
        "offset": page.offset,
        "limit": page.limit,
        "exhausted": page.exhausted,
        "nextOffset": page.next_offset,
        "strategies": page.strategies,
    }))
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

/// Index extracted PDF text against an already selected canonical record.
/// Desktop callers use this after an explicit paper selection so a freshly
/// attached PDF does not race the delayed compatibility-projection update.
pub fn library_index_pdf_text_for_record_at(
    base: &Path,
    record_id: &str,
    text: &str,
) -> Result<(), String> {
    let record_id = record_id.trim();
    if record_id.is_empty() {
        return Err("PDF text indexing requires a canonical record id".to_string());
    }
    let mut store = runtime::open_literature_store_at(base)?;
    if store.load_canonical_record(record_id)?.is_none() {
        return Err(format!("unknown canonical literature record: {record_id}"));
    }
    store.set_record_pdf_text(record_id, text)
}

/// Resolve the canonical literature record associated with a local PDF.  PDF
/// RAG uses this to anchor every vector chunk to the stable literature record
/// instead of treating a file path as an identity.
pub fn library_record_id_for_pdf_at(
    base: &Path,
    relative_path: &str,
) -> Result<Option<String>, String> {
    let normalized_path = relative_path.replace('\\', "/");
    let store = runtime::open_literature_store_at(base)?;
    Ok(store
        .list_canonical_records()?
        .into_iter()
        .find(|record| {
            record.metadata["legacyLibrary"]["pdf"]["path"]
                .as_str()
                .map(|path| path.replace('\\', "/") == normalized_path)
                .unwrap_or(false)
        })
        .map(|record| record.id))
}

/// A canonical, local list of PDFs attached to literature records.  The
/// desktop batch RAG command consumes this instead of scanning directories so
/// orphaned files never become silently searchable literature.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPdfRecord {
    pub paper_id: String,
    pub relative_path: String,
}

/// Flatten canonical bibliographic metadata for the rebuildable lexical RAG
/// projection. The canonical literature database remains authoritative.
pub fn library_record_retrieval_metadata_at(
    base: &Path,
    record_id: &str,
) -> Result<String, String> {
    let store = runtime::open_literature_store_at(base)?;
    let record = store
        .load_canonical_record(record_id)?
        .ok_or_else(|| format!("unknown canonical literature record: {record_id}"))?;
    Ok(format!(
        "paper id: {}\nbibliographic metadata: {}",
        record.id, record.metadata["legacyLibrary"]
    ))
}

pub fn library_pdf_records_at(base: &Path) -> Result<Vec<LibraryPdfRecord>, String> {
    let store = runtime::open_literature_store_at(base)?;
    let mut records = store
        .list_canonical_records()?
        .into_iter()
        .filter_map(|record| {
            let relative_path = record.metadata["legacyLibrary"]["pdf"]["path"]
                .as_str()?
                .trim()
                .replace('\\', "/");
            (!relative_path.is_empty()).then_some(LibraryPdfRecord {
                paper_id: record.id,
                relative_path,
            })
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        left.relative_path
            .cmp(&right.relative_path)
            .then_with(|| left.paper_id.cmp(&right.paper_id))
    });
    records.dedup_by(|left, right| {
        left.paper_id == right.paper_id && left.relative_path == right.relative_path
    });
    Ok(records)
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
pub fn library_apply_delta_at(
    base: &Path,
    delta: &LiteratureLibraryDelta,
) -> Result<Value, String> {
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
    let requested = input
        .format
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let format = if requested.is_empty() {
        match source_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "json" => "json".to_string(),
            "ris" => "ris".to_string(),
            "bib" | "bibtex" => "bibtex".to_string(),
            _ => {
                return Err(
                    "unsupported bibliography extension; choose JSON, RIS, or BibTeX".to_string(),
                )
            }
        }
    } else {
        requested
    };
    let (format, items) = standard_bibliography_items(&format, &bytes)?;
    let zotero_collections = zotero_collection_catalog(&format, &bytes);
    let mut store = runtime::open_literature_store_at(base)?;
    if !store.has_legacy_library_bootstrap()? {
        drop(store);
        let _ = library_load_at(base)?;
        store = runtime::open_literature_store_at(base)?;
    }
    let mut imported = 0;
    let mut merged = 0;
    let mut skipped = 0;
    let mut attachments = 0;
    let mut notes = 0;
    let mut annotations = 0;
    let mut warnings = Vec::new();
    let mut papers_by_record = BTreeMap::<String, Value>::new();
    let mut record_by_zotero_key = BTreeMap::<String, String>::new();
    let mut imported_collections = BTreeMap::<String, Value>::new();
    let mut child_items = Vec::new();

    for item in items {
        if matches!(
            item["itemType"].as_str(),
            Some("attachment" | "note" | "annotation")
        ) {
            child_items.push(item);
            continue;
        }
        let Some((record, paper)) = canonical_record_from_standard_json(&item) else {
            skipped += 1;
            continue;
        };
        let result = store.upsert_canonical_record(&record)?;
        let mut paper = merge_imported_paper(&result.record.metadata["legacyLibrary"], paper);
        let mut collection_ids = paper["collectionIds"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for collection in zotero_collection_values(&item, &zotero_collections) {
            let collection_id = collection["id"].as_str().unwrap_or_default().to_string();
            if collection_id.is_empty() {
                continue;
            }
            if !collection_ids
                .iter()
                .any(|id| id.as_str() == Some(collection_id.as_str()))
            {
                collection_ids.push(Value::String(collection_id.clone()));
            }
            add_zotero_collection_and_parents(
                &collection,
                &zotero_collections,
                &mut imported_collections,
            );
        }
        paper["collectionIds"] = Value::Array(collection_ids);
        if let Some(key) = zotero_item_key(&item) {
            record_by_zotero_key.insert(key, result.record.id.clone());
        }
        if result.inserted {
            imported += 1;
        } else {
            merged += 1;
        }
        papers_by_record.insert(result.record.id, paper);
    }

    for item in child_items {
        let Some(parent_key) = zotero_parent_key(&item) else {
            skipped += 1;
            warnings.push("Skipped a Zotero child item without a parent record.".to_string());
            continue;
        };
        let Some(record_id) = record_by_zotero_key.get(&parent_key) else {
            skipped += 1;
            warnings.push(format!(
                "Skipped Zotero child item for unavailable parent {parent_key}."
            ));
            continue;
        };
        let Some(paper) = papers_by_record.get_mut(record_id) else {
            continue;
        };
        match item["itemType"].as_str() {
            Some("attachment") => {
                let attachment = zotero_attachment_value(
                    base,
                    Path::new(&input.source_path),
                    &item,
                    &mut warnings,
                );
                if let Some(attachment) = attachment {
                    if attachment["kind"].as_str() == Some("pdf")
                        && paper["pdf"]["status"].as_str() != Some("downloaded")
                    {
                        if let Some(path) = attachment["path"].as_str() {
                            paper["pdf"] = json!({ "status": "downloaded", "path": path, "bytes": attachment["bytes"] });
                        }
                    }
                    append_paper_array_item(paper, "attachments", attachment, "id");
                    attachments += 1;
                } else {
                    skipped += 1;
                }
            }
            Some("note") => {
                if let Some(note) = zotero_note_value(&item) {
                    append_paper_array_item(paper, "notes", note, "id");
                    notes += 1;
                } else {
                    skipped += 1;
                }
            }
            Some("annotation") => {
                if let Some(annotation) = zotero_annotation_value(&item) {
                    append_paper_array_item(paper, "pdfAnnotations", annotation, "id");
                    annotations += 1;
                } else {
                    skipped += 1;
                }
            }
            _ => {
                skipped += 1;
            }
        }
    }

    for (record_id, paper) in papers_by_record {
        store.update_legacy_library_paper(&record_id, &paper)?;
    }
    let mut metadata = store.legacy_library_projection_meta()?;
    let existing_collections = metadata["collections"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let known_collection_ids = existing_collections
        .iter()
        .filter_map(|collection| collection["id"].as_str())
        .collect::<BTreeSet<_>>();
    let added_collections = imported_collections
        .into_iter()
        .filter_map(|(id, collection)| {
            (!known_collection_ids.contains(id.as_str())).then_some(collection)
        })
        .collect::<Vec<_>>();
    let collections = added_collections.len();
    if !added_collections.is_empty() {
        let mut combined = existing_collections;
        combined.extend(added_collections);
        metadata["collections"] = Value::Array(combined);
        store.set_legacy_library_projection_meta(&metadata)?;
    }
    store.mark_legacy_library_bootstrap()?;
    let projection = project_legacy_library(
        &store.legacy_library_projection_meta()?,
        &store.list_canonical_records()?,
        &store.list_search_runs(None)?,
    );
    write_library_file(&library_path_at(base), &projection)?;
    Ok(LiteratureBibliographyImportReport {
        format,
        imported,
        merged,
        skipped,
        attachments,
        notes,
        annotations,
        collections,
        warnings,
        total: projection["papers"].as_array().map_or(0, Vec::len),
    })
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
            return Err(format!(
                "cannot export unknown literature record(s): {}",
                missing.join(", ")
            ));
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
        "csl-json" => {
            serde_json::to_string_pretty(&entries.iter().map(csl_json_entry).collect::<Vec<_>>())
                .map_err(|error| error.to_string())?
        }
        _ => unreachable!("format is validated above"),
    };
    Ok(LiteratureBibliographyExportReport {
        format,
        exported: entries.len(),
        content: if content.is_empty() {
            content
        } else {
            format!("{content}\n")
        },
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
        .filter_map(|character| {
            character
                .is_ascii_alphanumeric()
                .then_some(character.to_ascii_lowercase())
        })
        .collect()
}

fn valid_citation_key(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let key = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        })
        .collect::<String>();
    if key.is_empty() {
        None
    } else if key
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
    {
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
            format!(
                "{}{}{}",
                if family.is_empty() { "ref" } else { &family },
                year,
                title_word
            )
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
        "thesis" => {
            if biblatex {
                "thesis"
            } else {
                "phdthesis"
            }
        }
        "report" => "techreport",
        "webpage" => {
            if biblatex {
                "online"
            } else {
                "misc"
            }
        }
        "dataset" => {
            if biblatex {
                "dataset"
            } else {
                "misc"
            }
        }
        "preprint" => "article",
        _ => "misc",
    }
}

fn bibtex_entry(entry: &BibliographyExportEntry<'_>, biblatex: bool) -> String {
    let paper = entry.paper;
    let item_type = paper_string(paper, "itemType");
    let mut fields = vec![format!(
        "  title = {{{}}}",
        bibtex_value(&paper_string(paper, "title"))
    )];
    let authors = paper_authors(paper);
    if !authors.is_empty() {
        fields.push(format!(
            "  author = {{{}}}",
            bibtex_value(&authors.join(" and "))
        ));
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
    for (paper_field, bib_field) in [
        ("volume", "volume"),
        ("issue", if biblatex { "number" } else { "number" }),
        ("pages", "pages"),
        ("edition", "edition"),
        ("series", "series"),
        ("language", "language"),
    ] {
        let value = paper_string(paper, paper_field);
        if !value.is_empty() {
            fields.push(format!("  {bib_field} = {{{}}}", bibtex_value(&value)));
        }
    }
    let publisher = paper_string(paper, "publisher");
    if !publisher.is_empty() {
        fields.push(format!("  publisher = {{{}}}", bibtex_value(&publisher)));
    }
    let place = paper_string(paper, "place");
    if !place.is_empty() {
        fields.push(format!(
            "  {} = {{{}}}",
            if biblatex { "location" } else { "address" },
            bibtex_value(&place),
        ));
    }
    for (paper_field, bib_field) in [("doi", "doi"), ("isbn", "isbn"), ("url", "url")] {
        let value = paper_string(paper, paper_field);
        if !value.is_empty() {
            fields.push(format!("  {bib_field} = {{{}}}", bibtex_value(&value)));
        }
    }
    if biblatex {
        let accessed = paper_string(paper, "accessed");
        if !accessed.is_empty() {
            fields.push(format!("  urldate = {{{}}}", bibtex_value(&accessed)));
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
        fields.push(format!(
            "  keywords = {{{}}}",
            bibtex_value(&tags.join(", "))
        ));
    }
    format!(
        "@{}{{{},\n{}\n}}",
        bibtex_entry_type(&item_type, biblatex),
        entry.citation_key,
        fields.join(",\n")
    )
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
    let mut lines = vec![format!(
        "TY  - {}",
        ris_type(&paper_string(paper, "itemType"))
    )];
    lines.push(format!("ID  - {}", entry.citation_key));
    lines.push(format!("TI  - {}", paper_string(paper, "title")));
    lines.extend(
        paper_authors(paper)
            .into_iter()
            .map(|author| format!("AU  - {author}")),
    );
    if let Some(year) = paper["year"].as_u64() {
        lines.push(format!("PY  - {year}"));
    }
    let venue = paper_string(paper, "venue");
    if !venue.is_empty() {
        lines.push(format!("JO  - {venue}"));
    }
    for (paper_field, ris_field) in [
        ("volume", "VL"),
        ("issue", "IS"),
        ("publisher", "PB"),
        ("place", "CY"),
        ("edition", "ET"),
        ("language", "LA"),
    ] {
        let value = paper_string(paper, paper_field);
        if !value.is_empty() {
            lines.push(format!("{ris_field}  - {value}"));
        }
    }
    let pages = paper_string(paper, "pages");
    if let Some((start, end)) = pages.split_once('-').or_else(|| pages.split_once('–')) {
        lines.push(format!("SP  - {}", start.trim()));
        lines.push(format!("EP  - {}", end.trim()));
    } else if !pages.is_empty() {
        lines.push(format!("SP  - {pages}"));
    }
    for (paper_field, ris_field) in [
        ("doi", "DO"),
        ("isbn", "SN"),
        ("url", "UR"),
        ("abstract", "AB"),
    ] {
        let value = paper_string(paper, paper_field);
        if !value.is_empty() {
            lines.push(format!("{ris_field}  - {value}"));
        }
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
    item.insert(
        "citation-key".to_string(),
        Value::String(entry.citation_key.clone()),
    );
    item.insert(
        "type".to_string(),
        Value::String(csl_type(&paper_string(paper, "itemType")).to_string()),
    );
    item.insert(
        "title".to_string(),
        Value::String(paper_string(paper, "title")),
    );
    let authors = paper_authors(paper);
    if !authors.is_empty() {
        item.insert(
            "author".to_string(),
            Value::Array(authors.iter().map(|author| csl_person(author)).collect()),
        );
    }
    if let Some(year) = paper["year"].as_u64() {
        item.insert("issued".to_string(), json!({ "date-parts": [[year]] }));
    }
    let venue = paper_string(paper, "venue");
    if !venue.is_empty() {
        item.insert("container-title".to_string(), Value::String(venue));
    }
    for (paper_field, csl_field) in [
        ("volume", "volume"),
        ("issue", "issue"),
        ("pages", "page"),
        ("publisher", "publisher"),
        ("place", "publisher-place"),
        ("edition", "edition"),
        ("series", "collection-title"),
        ("language", "language"),
    ] {
        let value = paper_string(paper, paper_field);
        if !value.is_empty() {
            item.insert(csl_field.to_string(), Value::String(value));
        }
    }
    for (paper_field, csl_field) in [
        ("doi", "DOI"),
        ("isbn", "ISBN"),
        ("url", "URL"),
        ("abstract", "abstract"),
    ] {
        let value = paper_string(paper, paper_field);
        if !value.is_empty() {
            item.insert(csl_field.to_string(), Value::String(value));
        }
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
    if title.is_empty() {
        return Err("a PDF record needs a title".to_string());
    }
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
        drop(store);
        let _ = library_load_at(base)?;
        store = runtime::open_literature_store_at(base)?;
    }
    let result = store.upsert_canonical_record(&record)?;
    store.update_legacy_library_paper(&result.record.id, &paper)?;
    store.mark_legacy_library_bootstrap()?;
    let projection = project_legacy_library(
        &store.legacy_library_projection_meta()?,
        &store.list_canonical_records()?,
        &store.list_search_runs(None)?,
    );
    write_library_file(&library_path_at(base), &projection)?;
    Ok(LiteraturePdfRecordImportReport {
        record_id: result.record.id,
        inserted: result.inserted,
        merged_record_ids: result.merged_record_ids,
    })
}

fn merge_imported_paper(existing: &Value, imported: Value) -> Value {
    let Some(existing) = existing.as_object() else {
        return imported;
    };
    let Some(mut merged) = imported.as_object().cloned() else {
        return imported;
    };
    // Preserve researcher-authored working data when a re-import updates the
    // same DOI/title. Bibliographic values come from the import; local reading
    // state, files, notes, annotations and evidence must never disappear.
    for key in [
        "attachments",
        "notes",
        "pdfAnnotations",
        "evidence",
        "answerChains",
        "screenings",
        "brief",
        "agentSummary",
        "verdict",
    ] {
        if existing.get(key).is_some_and(|value| !value.is_null()) {
            merged.insert(key.to_string(), existing[key].clone());
        }
    }
    for key in ["stage", "starred", "unread", "addedAt", "pdf"] {
        if existing.get(key).is_some_and(|value| !value.is_null()) {
            merged.insert(key.to_string(), existing[key].clone());
        }
    }
    for key in ["tags", "collectionIds"] {
        let mut values = existing[key].as_array().cloned().unwrap_or_default();
        for value in imported[key].as_array().into_iter().flatten() {
            if !values.contains(value) {
                values.push(value.clone());
            }
        }
        if !values.is_empty() {
            merged.insert(key.to_string(), Value::Array(values));
        }
    }
    Value::Object(merged)
}

fn append_paper_array_item(paper: &mut Value, field: &str, item: Value, id_field: &str) {
    let id = item[id_field].as_str().unwrap_or_default();
    let mut values = paper[field].as_array().cloned().unwrap_or_default();
    if !id.is_empty() {
        values.retain(|existing| existing[id_field].as_str() != Some(id));
    }
    values.push(item);
    paper[field] = Value::Array(values);
}

fn zotero_item_key(item: &Value) -> Option<String> {
    item["key"]
        .as_str()
        .or_else(|| item["itemKey"].as_str())
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(ToOwned::to_owned)
}

fn zotero_parent_key(item: &Value) -> Option<String> {
    item["parentItem"]
        .as_str()
        .or_else(|| item["parentItemKey"].as_str())
        .or_else(|| item["parent"]["key"].as_str())
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(ToOwned::to_owned)
}

fn zotero_collection_catalog(format: &str, bytes: &[u8]) -> BTreeMap<String, Value> {
    if format != "zotero-json" {
        return BTreeMap::new();
    }
    let Ok(root) = serde_json::from_slice::<Value>(bytes) else {
        return BTreeMap::new();
    };
    let entries = root["collections"]
        .as_array()
        .or_else(|| root["library"]["collections"].as_array())
        .into_iter()
        .flatten();
    entries.filter_map(zotero_collection_value).collect()
}

fn zotero_collection_value(collection: &Value) -> Option<(String, Value)> {
    let id = collection["key"]
        .as_str()
        .or_else(|| collection["id"].as_str())
        .or_else(|| collection["name"].as_str())?
        .trim()
        .to_string();
    let label = collection["name"]
        .as_str()
        .or_else(|| collection["label"].as_str())
        .unwrap_or(&id)
        .trim()
        .to_string();
    if id.is_empty() || label.is_empty() {
        return None;
    }
    let mut value = json!({ "id": format!("zotero:{id}"), "label": label });
    if let Some(parent) = collection["parentCollection"]
        .as_str()
        .or_else(|| collection["parentId"].as_str())
        .map(str::trim)
        .filter(|parent| !parent.is_empty())
    {
        value["parentId"] = Value::String(format!("zotero:{parent}"));
    }
    Some((id, value))
}

fn zotero_collection_values(item: &Value, catalog: &BTreeMap<String, Value>) -> Vec<Value> {
    item["collections"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|collection| {
            if let Some(key) = collection
                .as_str()
                .map(str::trim)
                .filter(|key| !key.is_empty())
            {
                return Some(
                    catalog
                        .get(key)
                        .cloned()
                        .unwrap_or_else(|| json!({ "id": format!("zotero:{key}"), "label": key })),
                );
            }
            zotero_collection_value(collection).map(|(_, value)| value)
        })
        .collect()
}

fn add_zotero_collection_and_parents(
    collection: &Value,
    catalog: &BTreeMap<String, Value>,
    imported: &mut BTreeMap<String, Value>,
) {
    let mut current = collection.clone();
    let mut seen = BTreeSet::new();
    loop {
        let Some(id) = current["id"].as_str().map(ToOwned::to_owned) else {
            break;
        };
        if !seen.insert(id.clone()) {
            break;
        }
        imported.entry(id).or_insert_with(|| current.clone());
        let Some(parent_key) = current["parentId"]
            .as_str()
            .and_then(|parent| parent.strip_prefix("zotero:"))
        else {
            break;
        };
        let Some(parent) = catalog.get(parent_key) else {
            break;
        };
        current = parent.clone();
    }
}

fn zotero_attachment_source(source_json: &Path, item: &Value) -> Option<PathBuf> {
    let raw = item["path"].as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    if path.is_file() {
        return Some(path);
    }
    let root = source_json.parent()?;
    let relative = raw.strip_prefix("storage:").unwrap_or(raw);
    [
        root.join(raw),
        root.join(relative),
        zotero_item_key(item)
            .map(|key| root.join("storage").join(key).join(relative))
            .unwrap_or_default(),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

fn zotero_attachment_value(
    base: &Path,
    source_json: &Path,
    item: &Value,
    warnings: &mut Vec<String>,
) -> Option<Value> {
    let source_key =
        zotero_item_key(item).unwrap_or_else(|| format!("item-{}", runtime::now_iso8601()));
    let raw_path = item["path"]
        .as_str()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned);
    let label = item["title"]
        .as_str()
        .or_else(|| item["filename"].as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::trim)
        .map(ToOwned::to_owned)
        .or_else(|| {
            raw_path
                .as_deref()
                .and_then(|path| Path::new(path).file_name())
                .and_then(|name| name.to_str())
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "Zotero attachment".to_string());
    let mime_type = item["contentType"]
        .as_str()
        .or_else(|| item["mimeType"].as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let is_pdf = mime_type
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("application/pdf"))
        || label.to_ascii_lowercase().ends_with(".pdf");
    let added_at = item["dateAdded"]
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(runtime::now_iso8601);
    let mut attachment = json!({
        "id": format!("zotero-attachment:{source_key}"),
        "label": label,
        "kind": if is_pdf { "pdf" } else { "supplement" },
        "mimeType": mime_type,
        "addedAt": added_at,
    });
    if let Some(url) = item["url"]
        .as_str()
        .map(str::trim)
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
    {
        attachment["url"] = Value::String(url.to_string());
        attachment["kind"] = Value::String("externalLink".to_string());
        return Some(attachment);
    }
    if let Some(source) = zotero_attachment_source(source_json, item) {
        let file_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("attachment");
        let destination_name = match sanitize_file_name(&format!("zotero-{source_key}-{file_name}"))
        {
            Ok(name) => name,
            Err(error) => {
                warnings.push(format!(
                    "Could not import Zotero attachment {label}: {error}"
                ));
                return Some(attachment);
            }
        };
        let destination = crate::layout::papers_dir_at(base)
            .join("attachments")
            .join(destination_name);
        if let Some(parent) = destination.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                warnings.push(format!(
                    "Could not create attachment directory for {label}: {error}"
                ));
                return Some(attachment);
            }
        }
        if !destination.exists() {
            if let Err(error) = std::fs::copy(&source, &destination) {
                warnings.push(format!("Could not copy Zotero attachment {label}: {error}"));
                return Some(attachment);
            }
        }
        match std::fs::metadata(&destination) {
            Ok(metadata) => {
                attachment["path"] = Value::String(
                    destination
                        .strip_prefix(base)
                        .unwrap_or(&destination)
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
                attachment["bytes"] = Value::from(metadata.len());
            }
            Err(error) => warnings.push(format!(
                "Could not read imported Zotero attachment {label}: {error}"
            )),
        }
    } else if let Some(path) = raw_path {
        // The export may refer to a linked local Zotero file not included with
        // the JSON. Retain its location visibly instead of discarding it.
        attachment["externalPath"] = Value::String(path);
    }
    Some(attachment)
}

fn zotero_note_value(item: &Value) -> Option<Value> {
    let content = item["note"]
        .as_str()
        .or_else(|| item["noteText"].as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let id = zotero_item_key(item).unwrap_or_else(|| format!("note-{}", runtime::now_iso8601()));
    let created_at = item["dateAdded"]
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(runtime::now_iso8601);
    let updated_at = item["dateModified"]
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| created_at.clone());
    Some(
        json!({ "id": format!("zotero-note:{id}"), "title": item["title"].as_str(), "content": content, "createdAt": created_at, "updatedAt": updated_at, "source": "imported" }),
    )
}

fn zotero_annotation_value(item: &Value) -> Option<Value> {
    let quote = item["annotationText"].as_str().unwrap_or("").trim();
    let note = item["annotationComment"].as_str().unwrap_or("").trim();
    if quote.is_empty() && note.is_empty() {
        return None;
    }
    let position_page = item["annotationPosition"]
        .as_str()
        .and_then(|position| serde_json::from_str::<Value>(position).ok())
        .and_then(|position| position["pageIndex"].as_u64())
        .map(|page| page.saturating_add(1));
    let page = item["annotationPageLabel"]
        .as_str()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .or(position_page)
        .unwrap_or(1);
    let id =
        zotero_item_key(item).unwrap_or_else(|| format!("annotation-{}", runtime::now_iso8601()));
    let color = match item["annotationColor"]
        .as_str()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "#5fb236" => "green",
        "#2ea8e5" => "blue",
        "#a28ae5" => "purple",
        "#ff6666" => "red",
        _ => "yellow",
    };
    let style = if item["annotationType"]
        .as_str()
        .is_some_and(|value| value.eq_ignore_ascii_case("underline"))
    {
        "underline"
    } else {
        "highlight"
    };
    let created_at = item["dateAdded"]
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(runtime::now_iso8601);
    Some(
        json!({ "id": format!("zotero-annotation:{id}"), "page": page, "quote": quote, "note": note, "kind": "note", "color": color, "style": style, "createdAt": created_at }),
    )
}

fn standard_bibliography_items(format: &str, bytes: &[u8]) -> Result<(String, Vec<Value>), String> {
    match format {
        "json" | "zotero-json" | "csl-json" => {
            let value: Value = serde_json::from_slice(bytes)
                .map_err(|error| format!("invalid bibliography JSON: {error}"))?;
            let items = value
                .as_array()
                .cloned()
                .or_else(|| value["items"].as_array().cloned())
                .ok_or_else(|| {
                    "a Zotero or CSL-JSON export must contain an item array".to_string()
                })?;
            let resolved = if items.iter().any(|item| item.get("itemType").is_some()) {
                "zotero-json"
            } else {
                "csl-json"
            };
            Ok((resolved.to_string(), items))
        }
        "ris" => Ok((
            "ris".to_string(),
            parse_ris_items(std::str::from_utf8(bytes).map_err(|_| "RIS must be UTF-8 text")?),
        )),
        "bib" | "bibtex" | "biblatex" => Ok((
            "bibtex".to_string(),
            parse_bibtex_items(
                std::str::from_utf8(bytes).map_err(|_| "BibTeX must be UTF-8 text")?,
            ),
        )),
        other => Err(format!("unsupported bibliography format: {other}")),
    }
}

fn parse_ris_items(input: &str) -> Vec<Value> {
    let mut records = Vec::new();
    let mut fields = BTreeMap::<String, Vec<String>>::new();
    let finish = |fields: &mut BTreeMap<String, Vec<String>>, records: &mut Vec<Value>| {
        let title = fields
            .get("TI")
            .or_else(|| fields.get("T1"))
            .and_then(|values| values.first())
            .cloned()
            .unwrap_or_default();
        if title.trim().is_empty() {
            fields.clear();
            return;
        }
        let type_code = fields
            .get("TY")
            .and_then(|values| values.first())
            .map(String::as_str)
            .unwrap_or("");
        let item_type = ris_item_type(type_code);
        let authors = fields
            .get("AU")
            .or_else(|| fields.get("A1"))
            .cloned()
            .unwrap_or_default();
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
            "volume": fields.get("VL").and_then(|values| values.first()),
            "issue": fields.get("IS").and_then(|values| values.first()),
            "pages": match (fields.get("SP").and_then(|values| values.first()), fields.get("EP").and_then(|values| values.first())) {
                (Some(start), Some(end)) => Some(format!("{start}-{end}")),
                (Some(start), None) => Some(start.clone()),
                _ => None,
            },
            "publisher": fields.get("PB").and_then(|values| values.first()),
            "place": fields.get("CY").and_then(|values| values.first()),
            "edition": fields.get("ET").and_then(|values| values.first()),
            "language": fields.get("LA").and_then(|values| values.first()),
            "tags": tags,
        }));
        fields.clear();
    };
    for raw in input.lines() {
        let line = raw.trim_end();
        if line.len() < 6
            || line.as_bytes().get(2) != Some(&b' ')
            || line.as_bytes().get(3) != Some(&b' ')
            || line.as_bytes().get(4) != Some(&b'-')
        {
            continue;
        }
        let key = line[..2].to_ascii_uppercase();
        let value = line[6..].trim().to_string();
        if key == "ER" {
            finish(&mut fields, &mut records);
        } else {
            fields.entry(key).or_default().push(value);
        }
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
        let type_end = input[start..]
            .find(|character: char| character == '{' || character == '(')
            .map(|offset| start + offset);
        let Some(type_end) = type_end else {
            break;
        };
        let entry_type = input[start..type_end].trim().to_ascii_lowercase();
        let opener = bytes[type_end] as char;
        let closer = if opener == '{' { '}' } else { ')' };
        let mut depth = 0_i32;
        let mut end = None;
        for (offset, character) in input[type_end..].char_indices() {
            if character == opener {
                depth += 1;
            }
            if character == closer {
                depth -= 1;
                if depth == 0 {
                    end = Some(type_end + offset);
                    break;
                }
            }
        }
        let Some(end) = end else {
            break;
        };
        let body = &input[type_end + 1..end];
        if let Some(item) = bibtex_item(&entry_type, body) {
            items.push(item);
        }
        cursor = end + 1;
    }
    items
}

fn bibtex_item(entry_type: &str, body: &str) -> Option<Value> {
    // The token before the first comma is the standard BibTeX entry key, not
    // a field. Retaining it is essential for a Zotero/BibTeX -> SomniQ -> TeX
    // round trip: existing \cite{key} commands must keep resolving.
    let (entry_key, fields) = body.split_once(',')?;
    let entry_key = entry_key.trim();
    let mut values = BTreeMap::new();
    for field in split_bibtex_fields(fields) {
        let Some((key, value)) = field.split_once('=') else {
            continue;
        };
        values.insert(
            key.trim().to_ascii_lowercase(),
            unquote_bibtex(value.trim()),
        );
    }
    let title = values.get("title")?.trim();
    if title.is_empty() {
        return None;
    }
    let authors = values
        .get("author")
        .map(|value| {
            value
                .split(" and ")
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let tags = values
        .get("keywords")
        .map(|value| {
            value
                .split([',', ';'])
                .map(str::trim)
                .filter(|tag| !tag.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(json!({
        "itemType": bibtex_item_type(entry_type), "title": title, "author": authors,
        "date": values.get("date").or_else(|| values.get("year")),
        "publicationTitle": values.get("journaltitle").or_else(|| values.get("journal")).or_else(|| values.get("booktitle")).or_else(|| values.get("publisher")),
        "DOI": values.get("doi"), "ISBN": values.get("isbn"), "url": values.get("url"), "abstract": values.get("abstract"),
        "citationKey": values.get("citationkey").or_else(|| values.get("key")).cloned().or_else(|| (!entry_key.is_empty()).then(|| entry_key.to_string())),
        "volume": values.get("volume"), "issue": values.get("number").or_else(|| values.get("issue")), "pages": values.get("pages"),
        "publisher": values.get("publisher"), "place": values.get("location").or_else(|| values.get("address")),
        "edition": values.get("edition"), "series": values.get("series").or_else(|| values.get("collection")),
        "language": values.get("language"), "accessDate": values.get("urldate"), "tags": tags,
    }))
}

fn bibtex_item_type(entry_type: &str) -> &'static str {
    match entry_type {
        "article" => "article",
        "book" | "mvbook" => "book",
        "inbook" | "incollection" => "bookSection",
        "inproceedings" | "conference" | "proceedings" => "conferencePaper",
        "phdthesis" | "mastersthesis" | "thesis" => "thesis",
        "techreport" | "report" => "report",
        "online" | "www" => "webpage",
        "unpublished" | "preprint" => "preprint",
        _ => "other",
    }
}

fn split_bibtex_fields(input: &str) -> Vec<&str> {
    let mut fields = Vec::new();
    let mut start = 0;
    let mut depth = 0_i32;
    let mut quoted = false;
    for (index, character) in input.char_indices() {
        match character {
            '"' if depth == 0 => quoted = !quoted,
            '{' if !quoted => depth += 1,
            '}' if !quoted => depth -= 1,
            ',' if !quoted && depth == 0 => {
                fields.push(input[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }
    if !input[start..].trim().is_empty() {
        fields.push(input[start..].trim());
    }
    fields
}

fn unquote_bibtex(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_start_matches('{')
        .trim_end_matches('}')
        .replace(['{', '}'], "")
        .trim()
        .to_string()
}

fn canonical_record_from_standard_json(item: &Value) -> Option<(runtime::CanonicalRecord, Value)> {
    let title = item["title"]
        .as_str()
        .map(collapse_whitespace)
        .filter(|value| !value.is_empty())?;
    let item_type = item["itemType"]
        .as_str()
        .or_else(|| item["type"].as_str())
        .unwrap_or("article");
    if matches!(item_type, "attachment" | "note" | "annotation") {
        return None;
    }
    let authors = item["creators"]
        .as_array()
        .or_else(|| item["author"].as_array())
        .map(|people| {
            people
                .iter()
                .filter_map(|person| {
                    person.as_str().map(str::to_string).or_else(|| {
                        let family = person["lastName"]
                            .as_str()
                            .or_else(|| person["family"].as_str())
                            .unwrap_or("")
                            .trim();
                        let given = person["firstName"]
                            .as_str()
                            .or_else(|| person["given"].as_str())
                            .unwrap_or("")
                            .trim();
                        let literal = person["name"].as_str().unwrap_or("").trim();
                        let joined = if !literal.is_empty() {
                            literal.to_string()
                        } else {
                            format!("{given} {family}").trim().to_string()
                        };
                        (!joined.is_empty()).then_some(joined)
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let doi = non_empty(
        item["DOI"]
            .as_str()
            .or_else(|| item["doi"].as_str())
            .unwrap_or(""),
    );
    let isbn = non_empty(
        item["ISBN"]
            .as_str()
            .or_else(|| item["isbn"].as_str())
            .unwrap_or(""),
    );
    let url = non_empty(
        item["url"]
            .as_str()
            .or_else(|| item["URL"].as_str())
            .unwrap_or(""),
    );
    let year = item["date"]
        .as_str()
        .and_then(|value| value.get(0..4))
        .and_then(|value| value.parse().ok())
        .or_else(|| {
            item["issued"]["date-parts"]
                .get(0)
                .and_then(|part| part.get(0))
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
        });
    let venue = item["publicationTitle"]
        .as_str()
        .or_else(|| item["container-title"].as_str())
        .or_else(|| item["bookTitle"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let abstract_text = item["abstractNote"]
        .as_str()
        .or_else(|| item["abstract"].as_str())
        .unwrap_or("")
        .to_string();
    let date = item["date"]
        .as_str()
        .or_else(|| item["issued"]["raw"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let volume = item["volume"].as_str().unwrap_or("").trim().to_string();
    let issue = item["issue"]
        .as_str()
        .or_else(|| item["number"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let pages = item["pages"]
        .as_str()
        .or_else(|| item["page"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let publisher = item["publisher"].as_str().unwrap_or("").trim().to_string();
    let place = item["place"]
        .as_str()
        .or_else(|| item["publisher-place"].as_str())
        .or_else(|| item["location"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let edition = item["edition"].as_str().unwrap_or("").trim().to_string();
    let series = item["series"]
        .as_str()
        .or_else(|| item["collection-title"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let language = item["language"].as_str().unwrap_or("").trim().to_string();
    let accessed = item["accessDate"]
        .as_str()
        .or_else(|| item["accessed"]["raw"].as_str())
        .or_else(|| item["urldate"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let tags = item["tags"]
        .as_array()
        .map(|tags| {
            tags.iter()
                .filter_map(|tag| {
                    tag.as_str()
                        .map(str::to_string)
                        .or_else(|| tag["tag"].as_str().map(str::to_string))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let now = runtime::now_iso8601();
    let id = runtime::canonical_record_id(doi.as_deref(), None, None, &title);
    let paper = json!({ "id": id, "title": title, "authors": authors, "year": year, "date": date, "venue": venue, "doi": doi, "url": url, "abstract": abstract_text, "itemType": item_type, "isbn": isbn, "citationKey": item["citationKey"].as_str().or_else(|| item["citation-key"].as_str()), "volume": volume, "issue": issue, "pages": pages, "publisher": publisher, "place": place, "edition": edition, "series": series, "language": language, "accessed": accessed, "tags": tags, "collectionIds": [], "searchIds": [], "stage": "inbox", "starred": false, "unread": true, "source": "standard_import", "addedAt": now, "pdf": { "status": "none" }, "attachments": [], "evidence": [], "answerChains": [], "pdfAnnotations": [], "notes": [] });
    Some((
        runtime::CanonicalRecord {
            schema_version: runtime::LITERATURE_SCHEMA_VERSION,
            id,
            revision: 1,
            normalized_title: runtime::normalized_record_title(&title),
            title,
            authors,
            year,
            venue,
            abstract_text,
            url,
            pdf_url: None,
            identifiers: runtime::RecordIdentifiers {
                doi,
                arxiv_id: None,
                scopus_id: None,
                source_ids: BTreeMap::new(),
            },
            provenance: vec![runtime::RecordProvenance {
                source: "standard_import".to_string(),
                external_id: None,
                search_run_id: None,
                artifact_id: None,
                observed_at: now.clone(),
            }],
            field_conflicts: Vec::new(),
            observations: vec![runtime::RecordObservation {
                source: "standard_import".to_string(),
                external_id: None,
                artifact_id: None,
                observed_at: now.clone(),
                fields: item.clone(),
            }],
            metadata: json!({ "standard": { "itemType": item_type, "isbn": isbn, "citationKey": item["citationKey"].as_str().or_else(|| item["citation-key"].as_str()), "date": date, "volume": volume, "issue": issue, "pages": pages, "publisher": publisher, "place": place, "edition": edition, "series": series, "language": language, "accessed": accessed } }),
            created_at: now.clone(),
            updated_at: now,
        },
        paper,
    ))
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
    let existing_path = existing_library_path_at(base);
    let mut store = runtime::open_literature_store_at(base)?;
    let bootstrapped = store.has_legacy_library_bootstrap()?;
    let legacy = if bootstrapped {
        Value::Null
    } else {
        load_legacy_library_file(&existing_path)?
    };
    if !bootstrapped && existing_path.exists() {
        store.import_legacy_library(&existing_path)?;
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
    let existing_path = existing_library_path_at(base);
    let mut store = runtime::open_literature_store_at(base)?;
    if !store.has_legacy_library_bootstrap()? && existing_path.exists() {
        store.import_legacy_library(&existing_path)?;
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
        return Err(format!(
            "failed to refresh the legacy library projection: {error}"
        ));
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
    let hidden_search_run_ids = library
        .get("hiddenSearchRunIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<std::collections::BTreeSet<_>>();
    searches.retain(|entry| {
        !entry["searchRunId"]
            .as_str()
            .is_some_and(|run_id| hidden_search_run_ids.contains(run_id))
    });
    let known_run_ids = searches
        .iter()
        .filter_map(|entry| entry["searchRunId"].as_str().map(str::to_string))
        .collect::<std::collections::BTreeSet<_>>();
    for run in runs {
        if known_run_ids.contains(&run.id) || hidden_search_run_ids.contains(&run.id) {
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
    /// Per-variant one-based rank for each entry of `papers`, positionally
    /// aligned with it. Single-stream adapters leave it empty; only the
    /// variant-fusing wrapper knows which query variant produced a paper, and
    /// that attribution would otherwise be lost in the fused ordering.
    variant_ranks: Vec<BTreeMap<String, u32>>,
    request: Value,
    raw_artifacts: Vec<AdapterArtifact>,
    hit_count: Option<u64>,
    quota: Value,
    warnings: Vec<String>,
    coverage_note: Option<String>,
    coverage: runtime::SearchCoverage,
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
        "scopus" if scopus_api_key().is_err() => AdapterAvailability {
            status: "missing_credentials",
            execution_mode: "not_available",
            coverage_note: "Scopus was requested but SCOPUS_API_KEY is not configured; the run will record an explicit unauthorised source attempt.",
            quota_policy: "Configure SCOPUS_API_KEY in Settings before execution."
        },
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
            "query": { "query": scopus_query(query), "count": limit.min(SCOPUS_PAGE_MAX), "cursor": "*", "view": "COMPLETE" },
            "authentication": "SCOPUS_API_KEY (redacted)",
            "fallback": "STANDARD on 401/403 entitlement response"
        }),
        "openalex" => json!({
            "method": "GET",
            "url": "https://api.openalex.org/works",
            "query": {
                "search": query,
                "per-page": limit.min(OPENALEX_PAGE_MAX),
                "cursor": "*",
                "select": "id,doi,title,publication_year,publication_date,authorships,primary_location,best_oa_location,open_access,cited_by_count,abstract_inverted_index"
            },
        }),
        "semantic-scholar" | "semantic_scholar" | "semanticscholar" => json!({
            "method": "GET",
            "url": "https://api.semanticscholar.org/graph/v1/paper/search",
            "query": {
                "query": query,
                "limit": limit.min(SEMANTIC_SCHOLAR_PAGE_MAX),
                "offset": 0,
                "fields": "paperId,title,authors,year,venue,abstract,externalIds,url,openAccessPdf,citationCount,publicationDate"
            },
            "authentication": "SEMANTIC_SCHOLAR_API_KEY when configured (redacted)"
        }),
        "crossref" => json!({
            "method": "GET",
            "url": "https://api.crossref.org/works",
            "query": {
                "query": query,
                "rows": limit.min(CROSSREF_PAGE_MAX),
                "cursor": "*",
                "select": "DOI,title,author,issued,container-title,abstract,URL,link,is-referenced-by-count"
            },
        }),
        "arxiv" => json!({
            "method": "GET",
            "url": "https://export.arxiv.org/api/query",
            "query": { "search_query": query, "start": 0, "max_results": limit.min(ARXIV_PAGE_MAX) },
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
struct ArxivRequestGate {
    minimum_interval: Duration,
    state: Mutex<ArxivRequestGateState>,
    changed: Condvar,
}

#[derive(Debug)]
struct ArxivRequestGateState {
    next_ticket: u64,
    serving_ticket: u64,
    next_start_at: Option<Instant>,
    circuit_open_until: Option<Instant>,
}

impl ArxivRequestGate {
    fn new(minimum_interval: Duration) -> Self {
        Self {
            minimum_interval,
            state: Mutex::new(ArxivRequestGateState {
                next_ticket: 0,
                serving_ticket: 0,
                next_start_at: None,
                circuit_open_until: None,
            }),
            changed: Condvar::new(),
        }
    }

    /// Reserve the next API request start. Tickets make this a real FIFO queue
    /// even when several conversations wake at the same instant.
    fn wait_for_request_start(&self) -> Instant {
        self.wait_for_request_start_inner(false)
            .expect("blocking arXiv gate does not fast-fail an open circuit")
    }

    /// Literature discovery must not let one server-directed 429 pause every
    /// remaining query variant for minutes. Queued requests fail fast once an
    /// earlier request opens the shared circuit, allowing other providers to
    /// complete the broad first pass.
    fn wait_for_request_start_or_open_circuit(&self) -> Result<Instant, Duration> {
        self.wait_for_request_start_inner(true)
    }

    fn wait_for_request_start_inner(
        &self,
        fail_if_circuit_open: bool,
    ) -> Result<Instant, Duration> {
        let mut state = self.state.lock().expect("arXiv request gate lock");
        let ticket = state.next_ticket;
        state.next_ticket = state.next_ticket.saturating_add(1);

        loop {
            let now = Instant::now();
            if ticket == state.serving_ticket && fail_if_circuit_open {
                if let Some(until) = state.circuit_open_until.filter(|until| *until > now) {
                    state.serving_ticket = state.serving_ticket.saturating_add(1);
                    self.changed.notify_all();
                    return Err(until.saturating_duration_since(now));
                }
            }
            let allowed_at = latest_instant(state.next_start_at, state.circuit_open_until);
            if ticket == state.serving_ticket && allowed_at.is_none_or(|at| at <= now) {
                state.serving_ticket = state.serving_ticket.saturating_add(1);
                state.next_start_at = Some(now + self.minimum_interval);
                self.changed.notify_all();
                return Ok(now);
            }

            if ticket == state.serving_ticket {
                // This ticket is at the head of the queue but must honour the
                // request interval or an open 429 circuit. A later 429 wakes
                // it early so it can extend its wait instead of colliding.
                let delay = allowed_at
                    .and_then(|at| at.checked_duration_since(now))
                    .unwrap_or(Duration::ZERO);
                let (next_state, _) = self
                    .changed
                    .wait_timeout(state, delay)
                    .expect("arXiv request gate lock");
                state = next_state;
            } else {
                state = self.changed.wait(state).expect("arXiv request gate lock");
            }
        }
    }

    /// Open or extend the shared circuit after a 429. The next request (from
    /// any conversation) remains queued until the server-directed wait ends.
    fn open_circuit(&self, delay: Duration) {
        let until = Instant::now() + delay;
        let mut state = self.state.lock().expect("arXiv request gate lock");
        if state
            .circuit_open_until
            .is_none_or(|current| current < until)
        {
            state.circuit_open_until = Some(until);
        }
        self.changed.notify_all();
    }
}

fn latest_instant(first: Option<Instant>, second: Option<Instant>) -> Option<Instant> {
    match (first, second) {
        (Some(first), Some(second)) => Some(first.max(second)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn arxiv_request_gate() -> &'static ArxivRequestGate {
    ARXIV_REQUEST_GATE.get_or_init(|| ArxivRequestGate::new(ARXIV_MIN_REQUEST_INTERVAL))
}

/// Shared with WebFetch so a direct fetch of the arXiv Atom endpoint cannot
/// bypass the same process-wide request queue used by LiteratureSearch.
pub(crate) fn wait_for_arxiv_api_request_start() {
    arxiv_request_gate().wait_for_request_start();
}

pub(crate) fn open_arxiv_api_circuit(delay: Duration) {
    arxiv_request_gate().open_circuit(delay);
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

fn send_provider_request(
    provider: &str,
    mut build: impl FnMut() -> reqwest::blocking::RequestBuilder,
) -> Result<ProviderResponse, String> {
    let mut last_error = None;
    for attempt in 0..MAX_HTTP_ATTEMPTS {
        match build().send() {
            Ok(response) => {
                let response = capture_provider_response(response)?;
                let retriable = matches!(response.status, 429 | 500 | 502 | 503 | 504);
                if !retriable || attempt + 1 == MAX_HTTP_ATTEMPTS {
                    return Ok(response);
                }
                let retry_after_ms = response
                    .headers
                    .get("retry-after")
                    .and_then(Value::as_str)
                    .and_then(|value| value.parse::<u64>().ok())
                    .map(|seconds| seconds.saturating_mul(1_000).min(5_000));
                let delay_ms =
                    retry_after_ms.unwrap_or_else(|| 250_u64.saturating_mul(1_u64 << attempt));
                std::thread::sleep(Duration::from_millis(delay_ms));
            }
            Err(error) => {
                last_error = Some(error.to_string());
                if attempt + 1 < MAX_HTTP_ATTEMPTS {
                    std::thread::sleep(Duration::from_millis(
                        250_u64.saturating_mul(1_u64 << attempt),
                    ));
                }
            }
        }
    }
    Err(format!(
        "{provider} request failed after {MAX_HTTP_ATTEMPTS} attempts: {}",
        last_error.unwrap_or_else(|| "unknown transport failure".to_string())
    ))
}

/// arXiv requests cannot use the generic provider retry loop. Every attempt
/// must first enter the process-wide queue, and a 429 must pause the queue
/// itself rather than merely sleeping this one caller.
fn send_arxiv_request(
    mut build: impl FnMut() -> reqwest::blocking::RequestBuilder,
) -> Result<ProviderResponse, String> {
    let max_attempts = ARXIV_RATE_LIMIT_RETRIES.saturating_add(1);
    let mut last_error = None;

    for attempt in 0..max_attempts {
        if let Err(remaining) = arxiv_request_gate().wait_for_request_start_or_open_circuit() {
            return Ok(arxiv_open_circuit_response(remaining));
        }
        match build().send() {
            Ok(response) => {
                let response = capture_provider_response(response)?;
                if response.status == 429 {
                    let retry_after = response.headers.get("retry-after").and_then(Value::as_str);
                    let delay = arxiv_rate_limit_backoff_from_retry_after(retry_after, attempt);
                    // Return the first 429 immediately. The shared circuit
                    // makes queued and later variants fail fast without
                    // hitting arXiv again; other configured sources can still
                    // finish the discovery pass.
                    open_arxiv_api_circuit(delay);
                    return Ok(response);
                }

                let retriable = matches!(response.status, 500 | 502 | 503 | 504);
                if !retriable || attempt + 1 == max_attempts {
                    return Ok(response);
                }
                std::thread::sleep(generic_retry_delay(attempt));
            }
            Err(error) => {
                last_error = Some(error.to_string());
                if attempt + 1 < max_attempts {
                    std::thread::sleep(generic_retry_delay(attempt));
                }
            }
        }
    }

    Err(format!(
        "arXiv request failed after {max_attempts} attempts: {}",
        last_error.unwrap_or_else(|| "unknown transport failure".to_string())
    ))
}

fn arxiv_open_circuit_response(remaining: Duration) -> ProviderResponse {
    let seconds = remaining
        .as_secs()
        .saturating_add(u64::from(remaining.subsec_nanos() > 0));
    ProviderResponse {
        status: 429,
        headers: json!({"retry-after": seconds.to_string()}),
        body: format!(
            "arXiv rate-limit circuit is open; retry after approximately {seconds} seconds"
        )
        .into_bytes(),
    }
}

fn generic_retry_delay(attempt: usize) -> Duration {
    Duration::from_millis(250_u64.saturating_mul(1_u64 << attempt.min(5)))
}

/// Parse both forms accepted by HTTP `Retry-After`: delay-seconds and an HTTP
/// date. The value is never capped; the shared circuit honours the full server
/// requested delay.
fn retry_after_delay_header(raw: &str, now: SystemTime) -> Option<Duration> {
    let raw = raw.trim();
    if let Ok(seconds) = raw.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    httpdate::parse_http_date(raw)
        .ok()
        .map(|deadline| deadline.duration_since(now).unwrap_or(Duration::ZERO))
}

fn arxiv_rate_limit_backoff(retry_after: Option<Duration>, attempt: usize) -> Duration {
    retry_after.unwrap_or_else(|| arxiv_fallback_backoff(attempt, arxiv_backoff_jitter_millis()))
}

pub(crate) fn arxiv_rate_limit_backoff_from_retry_after(
    retry_after: Option<&str>,
    attempt: usize,
) -> Duration {
    arxiv_rate_limit_backoff(
        retry_after.and_then(|value| retry_after_delay_header(value, SystemTime::now())),
        attempt,
    )
}

fn arxiv_fallback_backoff(attempt: usize, jitter_millis: u64) -> Duration {
    let base = ARXIV_FALLBACK_BACKOFFS[attempt.min(ARXIV_FALLBACK_BACKOFFS.len() - 1)];
    base.saturating_add(Duration::from_millis(
        jitter_millis.min(ARXIV_BACKOFF_JITTER_MAX_MILLIS),
    ))
}

fn arxiv_backoff_jitter_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::from(elapsed.subsec_nanos()) % (ARXIV_BACKOFF_JITTER_MAX_MILLIS + 1))
        .unwrap_or_default()
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
/// order `sources` lists them. Empty `sources` means the full default set,
/// which always includes Scopus: a missing `SCOPUS_API_KEY` is reported as an
/// explicit unauthorised source attempt rather than silently dropping the
/// source, so the run records the coverage gap instead of hiding it.
/// arXiv always runs last as the preprint supplement.
fn planned_engines(sources: &[String]) -> Vec<Engine> {
    let explicit = |name: &str| {
        sources
            .iter()
            .any(|source| source.eq_ignore_ascii_case(name))
    };
    let wants = |name: &str| sources.is_empty() || explicit(name);
    let mut engines = Vec::new();
    if explicit("scopus") || sources.is_empty() {
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

/// Blocking remote metadata search, run in canonical-priority order (Scopus →
/// OpenAlex → Crossref → arXiv) so dedupe keeps the published-venue record and
/// arXiv only fills the gaps (e.g. an open PDF link). Empty `sources` means the
/// full default set, which always includes Scopus; a missing `SCOPUS_API_KEY`
/// surfaces as a per-source warning instead of dropping the source.
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
    let never_cancel = || false;
    for engine in planned_engines(sources) {
        match engine {
            Engine::Scopus => run(
                "Scopus",
                search_scopus(
                    &client,
                    query,
                    limit,
                    None,
                    "relevance",
                    None,
                    &never_cancel,
                ),
            ),
            Engine::OpenAlex => run(
                "OpenAlex",
                search_openalex(&client, query, limit, None, None, &never_cancel),
            ),
            Engine::SemanticScholar => run(
                "Semantic Scholar",
                search_semantic_scholar(&client, query, limit, None, None, &never_cancel),
            ),
            Engine::Crossref => run(
                "Crossref",
                search_crossref(&client, query, limit, None, None, &never_cancel),
            ),
            Engine::Arxiv => run(
                "arXiv",
                search_arxiv(&client, query, limit, None, None, &never_cancel),
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

// The protocol fields this needs are versioned independently of each other, and
// bundling them into a struct here would only move the same list one call up.
#[allow(clippy::too_many_arguments)]
fn search_source_with_audit(
    variants: &[runtime::SearchQueryVariant],
    source: &str,
    limit: usize,
    time_window: &str,
    sort_order: &str,
    resume_cursor: Option<&str>,
    variant_budget_overrides: Option<&BTreeMap<String, usize>>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<AdapterSearchOutcome, String> {
    let parsed_time_window = parse_time_window(time_window)?;
    let resume_cursors = decode_variant_cursors(resume_cursor, variants);
    let mut prepared_variants = Vec::new();
    let mut seen_queries = BTreeSet::new();
    for variant in variants {
        let query = variant.query.trim();
        if !query.is_empty() && seen_queries.insert(query.to_ascii_lowercase()) {
            prepared_variants.push(variant.clone());
        }
    }
    if prepared_variants.is_empty() {
        return Err("search query is empty".to_string());
    }
    let budgets = apply_variant_budget_overrides(
        variant_budgets(limit, &prepared_variants)?,
        &prepared_variants,
        variant_budget_overrides,
    );
    let mut omitted_variants = Vec::new();
    let mut retired_variants = Vec::new();
    let mut cancelled_variants = Vec::new();
    let mut outcomes = Vec::new();
    let mut failures = Vec::new();
    let mut stopped = false;
    for (variant, variant_limit) in prepared_variants.into_iter().zip(budgets) {
        if stopped {
            // One stop ends the whole source; the streams that already ran keep
            // their cursors below, and these are recorded as never attempted so
            // the audit does not imply they were searched and found nothing.
            cancelled_variants.push(variant);
            continue;
        }
        if variant_limit == 0 {
            // A caller-supplied budget of zero means "this stream already filled
            // its corpus quota", which is a deliberate stop rather than the
            // protocol bound being too small to attempt the variant at all.
            if variant_budget_overrides
                .is_some_and(|overrides| overrides.get(&variant.kind) == Some(&0))
            {
                retired_variants.push(variant);
            } else {
                omitted_variants.push(variant);
            }
            continue;
        }
        let query = variant.query.trim();
        let cursor = resume_cursors.get(&variant.kind).map(String::as_str);
        if cursor == Some(EXHAUSTED_VARIANT_CURSOR) {
            outcomes.push((
                variant.clone(),
                AdapterSearchOutcome {
                    papers: Vec::new(),
                    variant_ranks: Vec::new(),
                    request: json!({
                        "provider": source,
                        "query": query,
                        "cursor": EXHAUSTED_VARIANT_CURSOR,
                        "action": "already_exhausted",
                    }),
                    raw_artifacts: Vec::new(),
                    hit_count: None,
                    quota: Value::Null,
                    warnings: Vec::new(),
                    coverage_note: Some(
                        "This query stream was exhausted in the previous bounded page.".to_string(),
                    ),
                    coverage: runtime::SearchCoverage {
                        exhausted: true,
                        ..runtime::SearchCoverage::default()
                    },
                },
            ));
            continue;
        }
        match search_single_source_with_audit(
            query,
            source,
            variant_limit,
            parsed_time_window.as_ref(),
            sort_order,
            cursor.filter(|value| !value.is_empty()),
            should_cancel,
        ) {
            Ok(outcome) => outcomes.push((variant.clone(), outcome)),
            Err(error) => {
                stopped |= is_cancelled_error(&error);
                failures.push((variant.clone(), error, cursor.map(str::to_string)));
            }
        }
    }
    if outcomes.is_empty() {
        if failures.is_empty() {
            return Err("search query is empty".to_string());
        }
        return Err(failures
            .into_iter()
            .map(|(variant, error, _)| format!("{}: {error}", variant.kind))
            .collect::<Vec<_>>()
            .join("; "));
    }

    const RRF_K: u64 = 60;
    const SCALE: u64 = 1_000_000_000;
    let mut fused = BTreeMap::<String, (RemotePaper, u64, BTreeMap<String, u32>)>::new();
    let mut requests = Vec::new();
    let mut artifacts = Vec::new();
    let mut quotas = Vec::new();
    let mut warnings = Vec::new();
    if !omitted_variants.is_empty() {
        warnings.push(format!(
            "{} query variant(s) were not attempted because protocol maxResults={limit} is smaller than the planned variant count; create a new protocol revision with a larger bound to execute every variant",
            omitted_variants.len()
        ));
        for variant in &omitted_variants {
            requests.push(json!({
                "kind": variant.kind,
                "query": variant.query,
                "action": "not_attempted",
                "reason": "protocol_variant_bound",
            }));
        }
    }
    for variant in &retired_variants {
        requests.push(json!({
            "kind": variant.kind,
            "query": variant.query,
            "action": "not_attempted",
            "reason": "path_quota_reached",
        }));
    }
    for variant in &cancelled_variants {
        requests.push(json!({
            "kind": variant.kind,
            "query": variant.query,
            "action": "not_attempted",
            "reason": "cancelled",
        }));
    }
    let had_failures = !failures.is_empty();
    // A retired or stopped stream still has provider results behind it, so
    // neither its hit count nor its unread pages may be folded away as if the
    // source had been fully traversed.
    let single_successful_stream = outcomes.len() == 1
        && !had_failures
        && omitted_variants.is_empty()
        && retired_variants.is_empty()
        && cancelled_variants.is_empty();
    let mut single_total_hits: Option<u64> = None;
    let mut fetched = 0_u64;
    let mut all_exhausted = failures.is_empty()
        && omitted_variants.is_empty()
        && retired_variants.is_empty()
        && cancelled_variants.is_empty();
    let mut hit_explicit_path_budget = false;
    let mut cursors = serde_json::Map::new();
    let mut coverage_notes = Vec::new();
    for (variant, outcome) in outcomes {
        requests.push(json!({
            "kind": variant.kind,
            "query": variant.query,
            "request": outcome.request,
            "hitCount": outcome.hit_count,
            "coverage": outcome.coverage,
        }));
        artifacts.extend(outcome.raw_artifacts);
        quotas.push(outcome.quota);
        warnings.extend(
            outcome
                .warnings
                .into_iter()
                .map(|warning| format!("{}: {warning}", variant.kind)),
        );
        if single_successful_stream {
            single_total_hits = outcome.hit_count;
        }
        fetched = fetched.saturating_add(outcome.coverage.fetched);
        all_exhausted &= outcome.coverage.exhausted;
        hit_explicit_path_budget |= variant.max_results.is_some() && !outcome.coverage.exhausted;
        if let Some(cursor) = outcome.coverage.next_cursor {
            cursors.insert(variant.kind.clone(), Value::String(cursor));
        } else if outcome.coverage.exhausted {
            cursors.insert(
                variant.kind.clone(),
                Value::String(EXHAUSTED_VARIANT_CURSOR.to_string()),
            );
        }
        if let Some(note) = outcome.coverage_note {
            coverage_notes.push(note);
        }
        for (index, paper) in outcome.papers.into_iter().enumerate() {
            let key = remote_paper_identity_key(&paper);
            let rank = u64::try_from(index.saturating_add(1)).unwrap_or(u64::MAX);
            let increment = SCALE / RRF_K.saturating_add(rank);
            let variant_rank = u32::try_from(index.saturating_add(1)).unwrap_or(u32::MAX);
            fused
                .entry(key)
                .and_modify(|(_, score, ranks)| {
                    *score = score.saturating_add(increment);
                    ranks
                        .entry(variant.kind.clone())
                        .and_modify(|current| *current = (*current).min(variant_rank))
                        .or_insert(variant_rank);
                })
                .or_insert_with(|| {
                    (
                        paper,
                        increment,
                        BTreeMap::from([(variant.kind.clone(), variant_rank)]),
                    )
                });
        }
    }
    for (variant, error, cursor) in failures {
        let kind = variant.kind;
        warnings.push(format!("{kind}: {error}"));
        requests.push(json!({
            "kind": kind,
            "query": variant.query,
            "error": error,
        }));
        cursors.insert(kind, Value::String(cursor.unwrap_or_default()));
    }
    // A stream retired by a caller quota made no request this pass, so it
    // contributes no fresh cursor. Carry its previous position forward instead
    // of dropping it, so raising the quota later resumes where it stopped
    // rather than re-reading the path from the first page.
    for variant in &retired_variants {
        if let Some(cursor) = resume_cursors.get(&variant.kind) {
            cursors.insert(variant.kind.clone(), Value::String(cursor.clone()));
        }
    }
    // A stream the stop reached before its first request keeps whatever
    // position it already had, so continuing resumes it rather than replaying
    // pages the previous pass already read.
    for variant in &cancelled_variants {
        cursors.insert(
            variant.kind.clone(),
            Value::String(
                resume_cursors
                    .get(&variant.kind)
                    .cloned()
                    .unwrap_or_default(),
            ),
        );
    }
    let mut fused = fused.into_values().collect::<Vec<_>>();
    fused.sort_by(
        |(left_paper, left_score, _), (right_paper, right_score, _)| {
            right_score
                .cmp(left_score)
                .then_with(|| left_paper.title.cmp(&right_paper.title))
        },
    );
    let candidate_unique = fused.len();
    let retained = candidate_unique.min(limit);
    let (papers, variant_ranks): (Vec<_>, Vec<_>) = fused
        .into_iter()
        .take(limit)
        .map(|(paper, _, ranks)| (paper, ranks))
        .unzip();
    let exhausted = all_exhausted && candidate_unique <= limit;
    let mut truncated_reasons = BTreeSet::new();
    if !exhausted {
        if !omitted_variants.is_empty() {
            truncated_reasons.insert("protocol_variant_bound");
        }
        if had_failures {
            truncated_reasons.insert("query_variant_error");
        }
        if candidate_unique > limit {
            truncated_reasons.insert("protocol_max_results");
        } else if !all_exhausted {
            truncated_reasons.insert("provider_has_more_results");
        }
        if hit_explicit_path_budget {
            truncated_reasons.insert("protocol_path_budget");
        }
        if !cancelled_variants.is_empty() || stopped {
            truncated_reasons.insert("cancelled");
        }
        if !retired_variants.is_empty() {
            truncated_reasons.insert("path_quota_reached");
        }
    }
    let total_hits = single_total_hits;
    let has_resumable_cursor = cursors.values().any(|value| {
        value
            .as_str()
            .is_some_and(|cursor| cursor != EXHAUSTED_VARIANT_CURSOR)
    });
    Ok(AdapterSearchOutcome {
        papers,
        variant_ranks,
        request: json!({
            "provider": source,
            "queryVariants": requests,
            "timeWindow": time_window,
        }),
        raw_artifacts: artifacts,
        hit_count: total_hits,
        quota: Value::Array(quotas),
        warnings,
        coverage_note: Some(coverage_notes.join(" ")).filter(|note| !note.is_empty()),
        coverage: runtime::SearchCoverage {
            total_hits,
            fetched,
            unique: u64::try_from(retained).unwrap_or(u64::MAX),
            exhausted,
            next_cursor: (!exhausted && has_resumable_cursor)
                .then(|| Value::Object(cursors).to_string()),
            truncated_reason: (!truncated_reasons.is_empty())
                .then(|| truncated_reasons.into_iter().collect::<Vec<_>>().join(",")),
        },
    })
}

fn distribute_variant_budget(total: usize, variant_count: usize) -> Vec<usize> {
    if total == 0 || variant_count == 0 {
        return Vec::new();
    }
    let count = variant_count.min(total);
    let base = total / count;
    let remainder = total % count;
    (0..count)
        .map(|index| base + usize::from(index < remainder))
        .collect()
}

/// Narrows the protocol's per-request variant ceilings with a caller-supplied
/// remaining-quota map.
///
/// The protocol ceiling stays the hard upper bound: an override may only take
/// capacity away, never grant a variant more than the previewed and approved
/// protocol allows. Variants absent from the map keep their protocol ceiling,
/// so a caller can steer a single stream without restating the others.
fn apply_variant_budget_overrides(
    budgets: Vec<usize>,
    variants: &[runtime::SearchQueryVariant],
    overrides: Option<&BTreeMap<String, usize>>,
) -> Vec<usize> {
    let Some(overrides) = overrides else {
        return budgets;
    };
    budgets
        .into_iter()
        .zip(variants)
        .map(|(budget, variant)| match overrides.get(&variant.kind) {
            Some(remaining) => budget.min(*remaining),
            None => budget,
        })
        .collect()
}

/// Explicit path ceilings are part of the previewed protocol. Remaining
/// capacity is shared by unbounded generic variants, preserving the old
/// equal-share behaviour when no path ceiling was specified.
fn variant_budgets(
    total: usize,
    variants: &[runtime::SearchQueryVariant],
) -> Result<Vec<usize>, String> {
    let explicit_total = variants
        .iter()
        .filter_map(|variant| variant.max_results)
        .try_fold(0_usize, |sum, value| sum.checked_add(value))
        .ok_or_else(|| "query variant maxResults overflow".to_string())?;
    if explicit_total > total {
        return Err(format!(
            "query variant maxResults totals {explicit_total}, exceeding source maxResults {total}"
        ));
    }
    let unbounded = variants
        .iter()
        .enumerate()
        .filter_map(|(index, variant)| variant.max_results.is_none().then_some(index))
        .collect::<Vec<_>>();
    let fallback = distribute_variant_budget(total - explicit_total, unbounded.len());
    let mut budgets = variants
        .iter()
        .map(|variant| variant.max_results.unwrap_or(0))
        .collect::<Vec<_>>();
    for (index, budget) in unbounded.into_iter().zip(fallback) {
        budgets[index] = budget;
    }
    Ok(budgets)
}

fn decode_variant_cursors(
    cursor: Option<&str>,
    variants: &[runtime::SearchQueryVariant],
) -> BTreeMap<String, String> {
    let Some(cursor) = cursor.map(str::trim).filter(|value| !value.is_empty()) else {
        return BTreeMap::new();
    };
    if let Ok(Value::Object(values)) = serde_json::from_str::<Value>(cursor) {
        return values
            .into_iter()
            .filter_map(|(kind, value)| value.as_str().map(|cursor| (kind, cursor.to_string())))
            .collect();
    }
    variants
        .first()
        .map(|variant| BTreeMap::from([(variant.kind.clone(), cursor.to_string())]))
        .unwrap_or_default()
}

fn remote_paper_identity_key(paper: &RemotePaper) -> String {
    if let Some(arxiv_id) = paper.arxiv_id.as_deref() {
        return format!("arxiv:{}", strip_version(arxiv_id));
    }
    if let Some(arxiv_id) = paper.doi.as_deref().and_then(|doi| {
        doi.strip_prefix("10.48550/arxiv.")
            .or_else(|| doi.strip_prefix("10.48550/ARXIV."))
    }) {
        return format!("arxiv:{}", strip_version(arxiv_id));
    }
    paper
        .doi
        .as_deref()
        .map(|doi| format!("doi:{}", doi.to_ascii_lowercase()))
        .or_else(|| {
            paper
                .arxiv_id
                .as_deref()
                .map(|id| format!("arxiv:{}", strip_version(id)))
        })
        .unwrap_or_else(|| format!("title:{}", normalized_title(&paper.title)))
}

fn search_single_source_with_audit(
    query: &str,
    source: &str,
    limit: usize,
    time_window: Option<&ParsedTimeWindow>,
    sort_order: &str,
    cursor: Option<&str>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<AdapterSearchOutcome, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("search query is empty".to_string());
    }
    let client = http_client()?;
    match source.trim().to_ascii_lowercase().as_str() {
        "scopus" => search_scopus(
            &client,
            query,
            limit,
            time_window,
            sort_order,
            cursor,
            should_cancel,
        ),
        "openalex" => search_openalex(&client, query, limit, time_window, cursor, should_cancel),
        "semantic-scholar" | "semantic_scholar" | "semanticscholar" => {
            search_semantic_scholar(&client, query, limit, time_window, cursor, should_cancel)
        }
        "crossref" => search_crossref(&client, query, limit, time_window, cursor, should_cancel),
        "arxiv" => search_arxiv(&client, query, limit, time_window, cursor, should_cancel),
        _ => Err(format!("source adapter is not implemented: {source}")),
    }
}

/// A provider page is the smallest unit a run can stop between: the request
/// itself is already in flight or already paid for, so each adapter checks here
/// before opening the next page.
fn stop_before_next_page(should_cancel: &dyn Fn() -> bool, provider: &str) -> Result<(), String> {
    if should_cancel() {
        return Err(format!("{provider}: {CANCELLED_ERROR}"));
    }
    Ok(())
}

fn search_arxiv(
    client: &reqwest::blocking::Client,
    query: &str,
    limit: usize,
    time_window: Option<&ParsedTimeWindow>,
    cursor: Option<&str>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<AdapterSearchOutcome, String> {
    let query = arxiv_query_with_time_window(query, time_window);
    let mut papers = Vec::new();
    let mut requests = Vec::new();
    let mut artifacts = Vec::new();
    let mut quotas = Vec::new();
    let mut hit_count = None;
    let mut start = cursor
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|error| format!("invalid arXiv cursor: {error}"))?;
    let mut raw_fetched = 0usize;
    let mut exhausted = false;
    let mut warnings = Vec::new();
    while papers.len() < limit {
        // arXiv holds a process-wide two-second request interval, so a page
        // that has not started yet is exactly where a stop should take effect.
        stop_before_next_page(should_cancel, "arXiv")?;
        let page_size = (limit - papers.len()).min(ARXIV_PAGE_MAX);
        let page_start = start;
        // This path is used for every arXiv variant (broad/exact) and every
        // continuation page, so all arXiv API traffic passes the same queue.
        let response = send_arxiv_request(|| {
            client.get("https://export.arxiv.org/api/query").query(&[
                ("search_query", query.clone()),
                ("start", page_start.to_string()),
                ("max_results", page_size.to_string()),
                ("sortBy", "relevance".to_string()),
                ("sortOrder", "descending".to_string()),
            ])
        })?;
        requests.push(json!({
            "method": "GET",
            "url": "https://export.arxiv.org/api/query",
            "query": {
                "search_query": query,
                "start": page_start,
                "max_results": page_size,
                "sortBy": "relevance",
                "sortOrder": "descending"
            }
        }));
        require_success(&response, "arXiv")?;
        quotas.push(response_quota(&response));
        artifacts.push(provider_artifact(
            "provider-response",
            "xml",
            "application/atom+xml",
            &response,
        ));
        let body = std::str::from_utf8(&response.body).map_err(|error| error.to_string())?;
        let page = parse_arxiv_feed_with_count(body)?;
        if let Some(error) = page.api_error {
            // A rejected query is a source failure, not an empty result set.
            return Err(format!("arXiv rejected the query: {error}"));
        }
        hit_count = page.total_results.or(hit_count);
        let entry_count = page.entry_count;
        let parsed = page.papers.len();
        raw_fetched = raw_fetched.saturating_add(entry_count);
        papers.extend(page.papers);
        // Advance by the rows the provider returned, not by the rows that
        // parsed: a dropped entry would otherwise shift every later page back
        // over rows this page already consumed.
        start = start.saturating_add(entry_count);
        if entry_count > parsed {
            warnings.push(format!(
                "{} of {entry_count} entries at start={page_start} had no usable arXiv id or title and were skipped",
                entry_count - parsed
            ));
        }
        exhausted = entry_count < page_size
            || hit_count.is_some_and(|total| u64::try_from(start).unwrap_or(u64::MAX) >= total);
        if exhausted || entry_count == 0 {
            break;
        }
        // Do not sleep locally between pages: `send_arxiv_request` reserves
        // the next shared start, which also coordinates other conversations.
    }
    papers = dedupe_remote_ordered(papers);
    papers.truncate(limit);
    let unique = papers.len();
    let next_cursor = (!exhausted).then(|| start.to_string());
    Ok(AdapterSearchOutcome {
        papers,
        variant_ranks: Vec::new(),
        request: json!({ "provider": "arxiv", "requests": requests }),
        raw_artifacts: artifacts,
        hit_count,
        quota: Value::Array(quotas),
        warnings,
        coverage_note: Some(
            "arXiv runs last as a preprint supplement; pages are fetched in relevance order with provider-friendly pacing."
                .to_string(),
        ),
        coverage: runtime::SearchCoverage {
            total_hits: hit_count,
            fetched: u64::try_from(raw_fetched).unwrap_or(u64::MAX),
            unique: u64::try_from(unique).unwrap_or(u64::MAX),
            exhausted,
            next_cursor,
            truncated_reason: (!exhausted).then(|| "protocol_max_results".to_string()),
        },
    })
}

fn arxiv_query_with_time_window(query: &str, time_window: Option<&ParsedTimeWindow>) -> String {
    let Some(window) = time_window else {
        return query.to_string();
    };
    let from = window
        .from_date
        .as_deref()
        .map(|date| date.replace('-', "") + "0000")
        .unwrap_or_else(|| "100001010000".to_string());
    let until = window
        .until_date
        .as_deref()
        .map(|date| date.replace('-', "") + "2359")
        .unwrap_or_else(|| "300012312359".to_string());
    format!("({query}) AND submittedDate:[{from} TO {until}]")
}

/// One parsed page of the arXiv Atom feed.
///
/// `entry_count` is the number of `<entry>` elements the provider actually
/// returned, which is what the `start` offset must advance by. It can exceed
/// `papers.len()` because entries without a usable id or title are dropped, and
/// advancing by the parsed count instead would re-request rows already seen.
#[derive(Debug, Default)]
struct ArxivFeedPage {
    papers: Vec<RemotePaper>,
    total_results: Option<u64>,
    entry_count: usize,
    /// arXiv reports query errors as HTTP 200 with a single error `<entry>`,
    /// so this is the only way to tell a rejected query from an empty result.
    api_error: Option<String>,
}

#[cfg(test)]
fn parse_arxiv_feed(xml: &str) -> Result<Vec<RemotePaper>, String> {
    Ok(parse_arxiv_feed_with_count(xml)?.papers)
}

fn parse_arxiv_feed_with_count(xml: &str) -> Result<ArxivFeedPage, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("invalid Atom feed: {e}"))?;
    let hit_count = doc
        .descendants()
        .find(|node| node.tag_name().name() == "totalResults")
        .and_then(|node| node.text())
        .and_then(|value| value.trim().parse::<u64>().ok());
    let mut papers = Vec::new();
    let mut entry_count = 0usize;
    let mut api_error = None;
    for entry in doc
        .descendants()
        .filter(|node| node.has_tag_name((ATOM_NS, "entry")))
    {
        entry_count = entry_count.saturating_add(1);
        let child_text = |tag: &str| -> String {
            entry
                .children()
                .find(|node| node.has_tag_name((ATOM_NS, tag)))
                .and_then(|node| node.text())
                .map(collapse_whitespace)
                .unwrap_or_default()
        };
        let raw_id = child_text("id");
        let title = child_text("title");
        if raw_id.contains("arxiv.org/api/errors") {
            // arXiv rejected the query (unbalanced quotes or parentheses, an
            // unknown field prefix, a malformed start/max_results). Capture the
            // reason so the caller fails the source attempt instead of
            // recording a clean, exhausted, zero-result search.
            let detail = child_text("summary");
            api_error = Some(
                non_empty(&detail)
                    .or_else(|| non_empty(&title))
                    .unwrap_or_else(|| "the provider rejected this query".to_string()),
            );
            continue;
        }
        let arxiv_id = raw_id
            .rsplit_once("/abs/")
            .map(|(_, id)| strip_version(id))
            .unwrap_or_default();
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
    Ok(ArxivFeedPage {
        papers,
        total_results: hit_count,
        entry_count,
        api_error,
    })
}

fn search_crossref(
    client: &reqwest::blocking::Client,
    query: &str,
    limit: usize,
    time_window: Option<&ParsedTimeWindow>,
    initial_cursor: Option<&str>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<AdapterSearchOutcome, String> {
    let select = "DOI,title,author,issued,container-title,abstract,URL,link,is-referenced-by-count";
    let mut cursor = initial_cursor
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("*")
        .to_string();
    let mut papers = Vec::new();
    let mut requests = Vec::new();
    let mut artifacts = Vec::new();
    let mut quotas = Vec::new();
    let mut hit_count = None;
    let mut exhausted = false;
    let mut raw_fetched = 0usize;
    while papers.len() < limit {
        stop_before_next_page(should_cancel, "Crossref")?;
        let page_size = (limit - papers.len()).min(CROSSREF_PAGE_MAX);
        let page_cursor = cursor.clone();
        let response = send_provider_request("Crossref", || {
            let mut params = vec![
                ("query", query.to_string()),
                ("rows", page_size.to_string()),
                ("cursor", page_cursor.clone()),
                ("select", select.to_string()),
            ];
            if let Some(filter) = crossref_time_filter(time_window) {
                params.push(("filter", filter));
            }
            client.get("https://api.crossref.org/works").query(&params)
        })?;
        requests.push(json!({
            "method": "GET",
            "url": "https://api.crossref.org/works",
            "query": {
                "query": query,
                "rows": page_size,
                "cursor": page_cursor,
                "select": select,
                "filter": crossref_time_filter(time_window),
            }
        }));
        require_success(&response, "Crossref")?;
        quotas.push(response_quota(&response));
        artifacts.push(provider_artifact(
            "provider-response",
            "json",
            "application/json",
            &response,
        ));
        let body: Value = serde_json::from_slice(&response.body).map_err(|e| e.to_string())?;
        hit_count = body["message"]["total-results"].as_u64().or(hit_count);
        let items = body["message"]["items"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let page_len = items.len();
        raw_fetched = raw_fetched.saturating_add(page_len);
        papers.extend(items.iter().filter_map(crossref_item_to_paper));
        let next = body["message"]["next-cursor"]
            .as_str()
            .map(str::to_string)
            .filter(|next| next != &cursor);
        exhausted = page_len < page_size
            || hit_count
                .is_some_and(|total| u64::try_from(papers.len()).unwrap_or(u64::MAX) >= total)
            || next.is_none();
        if let Some(next) = next {
            cursor = next;
        }
        if exhausted || page_len == 0 {
            break;
        }
    }
    papers = dedupe_remote_ordered(papers);
    papers.truncate(limit);
    let unique = papers.len();
    Ok(AdapterSearchOutcome {
        papers,
        variant_ranks: Vec::new(),
        request: json!({ "provider": "crossref", "requests": requests }),
        raw_artifacts: artifacts,
        hit_count,
        quota: Value::Array(quotas),
        warnings: Vec::new(),
        coverage_note: Some(
            "Crossref provides DOI metadata; abstracts and full-text links are only present when the depositor supplied them."
                .to_string(),
        ),
        coverage: runtime::SearchCoverage {
            total_hits: hit_count,
            fetched: u64::try_from(raw_fetched).unwrap_or(u64::MAX),
            unique: u64::try_from(unique).unwrap_or(u64::MAX),
            exhausted,
            next_cursor: (!exhausted).then_some(cursor),
            truncated_reason: (!exhausted).then(|| "protocol_max_results".to_string()),
        },
    })
}

fn crossref_time_filter(time_window: Option<&ParsedTimeWindow>) -> Option<String> {
    let window = time_window?;
    let mut filters = Vec::new();
    if let Some(from) = &window.from_date {
        filters.push(format!("from-pub-date:{from}"));
    }
    if let Some(until) = &window.until_date {
        filters.push(format!("until-pub-date:{until}"));
    }
    (!filters.is_empty()).then(|| filters.join(","))
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
    time_window: Option<&ParsedTimeWindow>,
    initial_cursor: Option<&str>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<AdapterSearchOutcome, String> {
    let select = "id,doi,title,publication_year,publication_date,authorships,primary_location,\
                  best_oa_location,open_access,cited_by_count,abstract_inverted_index";
    let mailto = std::env::var("OPENALEX_MAILTO")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let api_key = std::env::var("OPENALEX_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut cursor = initial_cursor
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("*")
        .to_string();
    let mut papers = Vec::new();
    let mut requests = Vec::new();
    let mut artifacts = Vec::new();
    let mut quotas = Vec::new();
    let mut hit_count = None;
    let mut exhausted = false;
    let mut raw_fetched = 0usize;
    while papers.len() < limit {
        stop_before_next_page(should_cancel, "OpenAlex")?;
        let page_size = (limit - papers.len()).min(OPENALEX_PAGE_MAX);
        let page_cursor = cursor.clone();
        let build_params = || {
            let mut params = vec![
                ("search", query.to_string()),
                ("per-page", page_size.to_string()),
                ("cursor", page_cursor.clone()),
                ("select", select.to_string()),
            ];
            if let Some(mailto) = &mailto {
                params.push(("mailto", mailto.clone()));
            }
            if let Some(api_key) = &api_key {
                params.push(("api_key", api_key.clone()));
            }
            if let Some(filter) = openalex_time_filter(time_window) {
                params.push(("filter", filter));
            }
            params
        };
        let response = send_provider_request("OpenAlex", || {
            client
                .get("https://api.openalex.org/works")
                .query(&build_params())
        })?;
        requests.push(json!({
            "method": "GET",
            "url": "https://api.openalex.org/works",
            "query": {
                "search": query,
                "per-page": page_size,
                "cursor": page_cursor,
                "select": select,
                "mailto": mailto,
                "filter": openalex_time_filter(time_window),
            },
            "authentication": if api_key.is_some() { "OPENALEX_API_KEY (redacted)" } else { "anonymous" },
        }));
        require_success(&response, "OpenAlex")?;
        quotas.push(response_quota(&response));
        artifacts.push(provider_artifact(
            "provider-response",
            "json",
            "application/json",
            &response,
        ));
        let body: Value = serde_json::from_slice(&response.body).map_err(|e| e.to_string())?;
        hit_count = body["meta"]["count"].as_u64().or(hit_count);
        let results = body["results"].as_array().cloned().unwrap_or_default();
        let page_len = results.len();
        raw_fetched = raw_fetched.saturating_add(page_len);
        papers.extend(results.iter().filter_map(openalex_work_to_paper));
        let next = body["meta"]["next_cursor"]
            .as_str()
            .map(str::to_string)
            .filter(|next| !next.is_empty() && next != &cursor);
        exhausted = page_len < page_size
            || hit_count
                .is_some_and(|total| u64::try_from(papers.len()).unwrap_or(u64::MAX) >= total)
            || next.is_none();
        if let Some(next) = next {
            cursor = next;
        }
        if exhausted || page_len == 0 {
            break;
        }
    }
    papers = dedupe_remote_ordered(papers);
    papers.truncate(limit);
    let unique = papers.len();
    Ok(AdapterSearchOutcome {
        papers,
        variant_ranks: Vec::new(),
        request: json!({ "provider": "openalex", "requests": requests }),
        raw_artifacts: artifacts,
        hit_count,
        quota: Value::Array(quotas),
        warnings: Vec::new(),
        coverage_note: Some(
            "OpenAlex metadata is index-derived; an absent abstract or OA link is recorded as a coverage gap rather than inferred."
                .to_string(),
        ),
        coverage: runtime::SearchCoverage {
            total_hits: hit_count,
            fetched: u64::try_from(raw_fetched).unwrap_or(u64::MAX),
            unique: u64::try_from(unique).unwrap_or(u64::MAX),
            exhausted,
            next_cursor: (!exhausted).then_some(cursor),
            truncated_reason: (!exhausted).then(|| "protocol_max_results".to_string()),
        },
    })
}

fn openalex_time_filter(time_window: Option<&ParsedTimeWindow>) -> Option<String> {
    let window = time_window?;
    let mut filters = Vec::new();
    if let Some(from) = &window.from_date {
        filters.push(format!("from_publication_date:{from}"));
    }
    if let Some(until) = &window.until_date {
        filters.push(format!("to_publication_date:{until}"));
    }
    (!filters.is_empty()).then(|| filters.join(","))
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
    time_window: Option<&ParsedTimeWindow>,
    initial_cursor: Option<&str>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<AdapterSearchOutcome, String> {
    let query = collapse_whitespace(&query.replace(['-', '‐', '‑', '–', '—'], " "));
    let fields = "paperId,title,authors,year,venue,abstract,externalIds,url,openAccessPdf,citationCount,publicationDate";
    let api_key = semantic_scholar_api_key();
    let target = limit.min(SEMANTIC_SCHOLAR_RESULT_WINDOW);
    let mut offset = initial_cursor
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|error| format!("invalid Semantic Scholar cursor: {error}"))?;
    let mut papers = Vec::new();
    let mut requests = Vec::new();
    let mut artifacts = Vec::new();
    let mut quotas = Vec::new();
    let mut hit_count = None;
    let mut exhausted = false;
    let mut raw_fetched = 0usize;
    while papers.len() < target {
        stop_before_next_page(should_cancel, "Semantic Scholar")?;
        let page_size = (target - papers.len()).min(SEMANTIC_SCHOLAR_PAGE_MAX);
        let page_offset = offset;
        let response = send_provider_request("Semantic Scholar", || {
            let mut params = vec![
                ("query", query.clone()),
                ("limit", page_size.to_string()),
                ("offset", page_offset.to_string()),
                ("fields", fields.to_string()),
            ];
            if let Some(year) = semantic_scholar_year_filter(time_window) {
                params.push(("year", year));
            }
            let request = client
                .get("https://api.semanticscholar.org/graph/v1/paper/search")
                .query(&params);
            if let Some(api_key) = &api_key {
                request.header("x-api-key", api_key)
            } else {
                request
            }
        })?;
        requests.push(json!({
            "method": "GET",
            "url": "https://api.semanticscholar.org/graph/v1/paper/search",
            "query": {
                "query": query,
                "limit": page_size,
                "offset": page_offset,
                "fields": fields,
                "year": semantic_scholar_year_filter(time_window),
            },
            "authentication": if api_key.is_some() { "SEMANTIC_SCHOLAR_API_KEY (redacted)" } else { "anonymous" },
        }));
        require_success(&response, "Semantic Scholar")?;
        quotas.push(response_quota(&response));
        artifacts.push(provider_artifact(
            "provider-response",
            "json",
            "application/json",
            &response,
        ));
        let body: Value =
            serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
        hit_count = body["total"].as_u64().or(hit_count);
        let data = body["data"].as_array().cloned().unwrap_or_default();
        let page_len = data.len();
        raw_fetched = raw_fetched.saturating_add(page_len);
        papers.extend(data.iter().filter_map(semantic_scholar_item_to_paper));
        offset = offset.saturating_add(page_len);
        exhausted = page_len < page_size
            || hit_count.is_some_and(|total| u64::try_from(offset).unwrap_or(u64::MAX) >= total);
        if exhausted || page_len == 0 || offset >= SEMANTIC_SCHOLAR_RESULT_WINDOW {
            break;
        }
    }
    papers = dedupe_remote_ordered(papers);
    papers.truncate(target);
    let unique = papers.len();
    let result_window_reached = !exhausted
        && offset >= SEMANTIC_SCHOLAR_RESULT_WINDOW
        && hit_count.is_none_or(|total| total > offset as u64);
    let truncated_reason = (!exhausted).then(|| {
        if result_window_reached || limit > SEMANTIC_SCHOLAR_RESULT_WINDOW {
            "provider_result_window".to_string()
        } else {
            "protocol_max_results".to_string()
        }
    });
    Ok(AdapterSearchOutcome {
        papers,
        variant_ranks: Vec::new(),
        request: json!({ "provider": "semantic-scholar", "requests": requests }),
        raw_artifacts: artifacts,
        hit_count,
        quota: Value::Array(quotas),
        warnings: Vec::new(),
        coverage_note: Some(
            "Semantic Scholar result and citation metadata are point-in-time provider observations."
                .to_string(),
        ),
        coverage: runtime::SearchCoverage {
            total_hits: hit_count,
            fetched: u64::try_from(raw_fetched).unwrap_or(u64::MAX),
            unique: u64::try_from(unique).unwrap_or(u64::MAX),
            exhausted,
            next_cursor: (!exhausted && offset < SEMANTIC_SCHOLAR_RESULT_WINDOW)
                .then(|| offset.to_string()),
            truncated_reason,
        },
    })
}

fn semantic_scholar_year_filter(time_window: Option<&ParsedTimeWindow>) -> Option<String> {
    let window = time_window?;
    match (window.from_year(), window.until_year()) {
        (Some(from), Some(until)) if from == until => Some(from.to_string()),
        (Some(from), Some(until)) => Some(format!("{from}-{until}")),
        (Some(from), None) => Some(format!("{from}-")),
        (None, Some(until)) => Some(format!("-{until}")),
        (None, None) => None,
    }
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

// ── Citation traversal ──────────────────────────────────────────────────────

/// How a citation anchor is addressed at each provider.
///
/// The two APIs disagree about identifiers: Semantic Scholar accepts an arXiv
/// id directly, OpenAlex only knows the registered DOI, and arXiv itself has no
/// citation index at all. Resolving once here keeps that per-provider knowledge
/// out of the traversal loop.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CitationAnchor {
    /// Canonical label echoed back to the caller.
    label: String,
    /// `arXiv:2401.00001`, `DOI:10.1145/x`, or an opaque Semantic Scholar id.
    #[allow(clippy::doc_markdown)]
    semantic_scholar_id: String,
    /// OpenAlex single-work selector, when the anchor maps to one.
    openalex_id: Option<String>,
}

fn normalize_citation_anchor(raw: &str) -> Result<CitationAnchor, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("paperId is empty".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    let arxiv_id = lower
        .strip_prefix("arxiv:")
        .map(str::trim)
        .map(str::to_string)
        .or_else(|| {
            lower
                .strip_prefix("10.48550/arxiv.")
                .map(str::trim)
                .map(str::to_string)
        })
        .or_else(|| looks_like_bare_arxiv_id(trimmed).then(|| lower.clone()));
    if let Some(arxiv_id) = arxiv_id.map(|id| strip_version(&id)) {
        if arxiv_id.is_empty() {
            return Err(format!("invalid arXiv identifier: {raw:?}"));
        }
        return Ok(CitationAnchor {
            label: format!("arxiv:{arxiv_id}"),
            semantic_scholar_id: format!("arXiv:{arxiv_id}"),
            // arXiv registers a DOI for every submission, which is how the
            // record is reachable in OpenAlex.
            openalex_id: Some(format!("doi:10.48550/arXiv.{arxiv_id}")),
        });
    }
    let doi = lower
        .strip_prefix("doi:")
        .map(str::trim)
        .map(str::to_string)
        .or_else(|| is_doi_like(trimmed).then(|| lower.clone()));
    if let Some(doi) = doi {
        if doi.is_empty() {
            return Err(format!("invalid DOI: {raw:?}"));
        }
        return Ok(CitationAnchor {
            label: format!("doi:{doi}"),
            semantic_scholar_id: format!("DOI:{doi}"),
            openalex_id: Some(format!("doi:{doi}")),
        });
    }
    // An opaque provider id: usable at Semantic Scholar, not resolvable at
    // OpenAlex, and recorded as such rather than guessed at.
    Ok(CitationAnchor {
        label: trimmed.to_string(),
        semantic_scholar_id: trimmed.to_string(),
        openalex_id: None,
    })
}

fn looks_like_bare_arxiv_id(value: &str) -> bool {
    // Modern `NNNN.NNNNN` form; the legacy `cs/9901002` form always arrives
    // with an explicit prefix in practice and is handled by that branch.
    let Some((head, tail)) = value.split_once('.') else {
        return false;
    };
    let tail = tail.split_once('v').map_or(tail, |(digits, _)| digits);
    head.len() == 4
        && head.chars().all(|character| character.is_ascii_digit())
        && (4..=5).contains(&tail.len())
        && tail.chars().all(|character| character.is_ascii_digit())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CitationDirection {
    /// Papers that cite the anchor — the incoming edge.
    Citing,
    /// Papers the anchor cites — its reference list.
    References,
}

impl CitationDirection {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value
            .unwrap_or("citing")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "citing" | "citations" | "cited_by" | "citedby" => Ok(Self::Citing),
            "references" | "referenced" | "cites" => Ok(Self::References),
            other => Err(format!(
                "unknown citation direction {other:?}; use \"citing\" or \"references\""
            )),
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Citing => "citing",
            Self::References => "references",
        }
    }

    const fn semantic_scholar_path(self) -> &'static str {
        match self {
            Self::Citing => "citations",
            Self::References => "references",
        }
    }

    /// Which side of the edge carries the other paper's metadata.
    const fn semantic_scholar_field(self) -> &'static str {
        match self {
            Self::Citing => "citingPaper",
            Self::References => "citedPaper",
        }
    }
}

const CITATION_PAGE_MAX: usize = 100;

fn search_semantic_scholar_citations(
    client: &reqwest::blocking::Client,
    anchor: &CitationAnchor,
    direction: CitationDirection,
    limit: usize,
    initial_cursor: Option<&str>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<AdapterSearchOutcome, String> {
    let fields = "paperId,title,authors,year,venue,abstract,externalIds,url,openAccessPdf,citationCount,publicationDate";
    let api_key = semantic_scholar_api_key();
    let url = format!(
        "https://api.semanticscholar.org/graph/v1/paper/{}/{}",
        anchor.semantic_scholar_id,
        direction.semantic_scholar_path()
    );
    let mut offset = initial_cursor
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|error| format!("invalid Semantic Scholar citation cursor: {error}"))?;
    let mut papers = Vec::new();
    let mut requests = Vec::new();
    let mut artifacts = Vec::new();
    let mut quotas = Vec::new();
    let mut raw_fetched = 0usize;
    let mut exhausted = false;
    while papers.len() < limit {
        stop_before_next_page(should_cancel, "Semantic Scholar")?;
        let page_size = (limit - papers.len()).min(CITATION_PAGE_MAX);
        let page_offset = offset;
        let page_url = url.clone();
        let response = send_provider_request("Semantic Scholar", || {
            let request = client.get(&page_url).query(&[
                ("fields", fields.to_string()),
                ("limit", page_size.to_string()),
                ("offset", page_offset.to_string()),
            ]);
            if let Some(api_key) = &api_key {
                request.header("x-api-key", api_key)
            } else {
                request
            }
        })?;
        requests.push(json!({
            "method": "GET",
            "url": url,
            "query": { "fields": fields, "limit": page_size, "offset": page_offset },
            "authentication": if api_key.is_some() { "SEMANTIC_SCHOLAR_API_KEY (redacted)" } else { "anonymous" },
        }));
        require_success(&response, "Semantic Scholar")?;
        quotas.push(response_quota(&response));
        artifacts.push(provider_artifact(
            "provider-response",
            "json",
            "application/json",
            &response,
        ));
        let body: Value =
            serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
        let edges = body["data"].as_array().cloned().unwrap_or_default();
        let page_len = edges.len();
        raw_fetched = raw_fetched.saturating_add(page_len);
        papers.extend(edges.iter().filter_map(|edge| {
            semantic_scholar_item_to_paper(&edge[direction.semantic_scholar_field()])
        }));
        offset = offset.saturating_add(page_len);
        // `next` is absent on the last page; a short page means the same thing.
        exhausted = body["next"].is_null() || page_len < page_size;
        if exhausted || page_len == 0 {
            break;
        }
    }
    papers = dedupe_remote_ordered(papers);
    papers.truncate(limit);
    let unique = papers.len();
    Ok(AdapterSearchOutcome {
        papers,
        variant_ranks: Vec::new(),
        request: json!({ "provider": "semantic-scholar", "requests": requests }),
        raw_artifacts: artifacts,
        hit_count: None,
        quota: Value::Array(quotas),
        warnings: Vec::new(),
        coverage_note: Some(format!(
            "Semantic Scholar {} edges for {}. Citation coverage is a point-in-time provider observation and is never complete for very recent work.",
            direction.as_str(),
            anchor.label
        )),
        coverage: runtime::SearchCoverage {
            total_hits: None,
            fetched: u64::try_from(raw_fetched).unwrap_or(u64::MAX),
            unique: u64::try_from(unique).unwrap_or(u64::MAX),
            exhausted,
            next_cursor: (!exhausted).then(|| offset.to_string()),
            truncated_reason: (!exhausted).then(|| "protocol_max_results".to_string()),
        },
    })
}

fn search_openalex_citations(
    client: &reqwest::blocking::Client,
    anchor: &CitationAnchor,
    direction: CitationDirection,
    limit: usize,
    should_cancel: &dyn Fn() -> bool,
) -> Result<AdapterSearchOutcome, String> {
    let Some(selector) = anchor.openalex_id.as_deref() else {
        return Err(format!(
            "OpenAlex cannot resolve {:?}; supply an arXiv id or a DOI",
            anchor.label
        ));
    };
    let select = "id,doi,title,publication_year,publication_date,authorships,primary_location,\
                  best_oa_location,open_access,cited_by_count,abstract_inverted_index";
    let mailto = std::env::var("OPENALEX_MAILTO")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut requests = Vec::new();
    let mut artifacts = Vec::new();
    let mut quotas = Vec::new();

    // Resolve the anchor to an OpenAlex work id, which is the only form the
    // `cites` filter and the reference list are expressed in.
    stop_before_next_page(should_cancel, "OpenAlex")?;
    let anchor_url = format!("https://api.openalex.org/works/{selector}");
    let anchor_response = send_provider_request("OpenAlex", || {
        let mut request = client
            .get(&anchor_url)
            .query(&[("select", "id,referenced_works")]);
        if let Some(mailto) = &mailto {
            request = request.query(&[("mailto", mailto.as_str())]);
        }
        request
    })?;
    requests.push(json!({ "method": "GET", "url": anchor_url, "select": "id,referenced_works" }));
    quotas.push(response_quota(&anchor_response));
    artifacts.push(provider_artifact(
        "anchor-response",
        "json",
        "application/json",
        &anchor_response,
    ));
    require_success(&anchor_response, "OpenAlex")?;
    let anchor_work: Value =
        serde_json::from_slice(&anchor_response.body).map_err(|error| error.to_string())?;
    let work_id = anchor_work["id"]
        .as_str()
        .and_then(|id| id.rsplit('/').next())
        .map(str::to_string)
        .ok_or_else(|| format!("OpenAlex returned no work id for {selector}"))?;

    let filter = match direction {
        CitationDirection::Citing => format!("cites:{work_id}"),
        CitationDirection::References => {
            let referenced = anchor_work["referenced_works"]
                .as_array()
                .map(|works| {
                    works
                        .iter()
                        .filter_map(Value::as_str)
                        .filter_map(|work| work.rsplit('/').next())
                        .take(limit.min(CITATION_PAGE_MAX))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if referenced.is_empty() {
                return Err(format!(
                    "OpenAlex lists no referenced works for {}",
                    anchor.label
                ));
            }
            format!("openalex_id:{}", referenced.join("|"))
        }
    };

    stop_before_next_page(should_cancel, "OpenAlex")?;
    let page_size = limit.min(OPENALEX_PAGE_MAX);
    let list_filter = filter.clone();
    let response = send_provider_request("OpenAlex", || {
        let mut request = client.get("https://api.openalex.org/works").query(&[
            ("filter", list_filter.clone()),
            ("per-page", page_size.to_string()),
            ("select", select.to_string()),
        ]);
        if let Some(mailto) = &mailto {
            request = request.query(&[("mailto", mailto.as_str())]);
        }
        request
    })?;
    requests.push(json!({
        "method": "GET",
        "url": "https://api.openalex.org/works",
        "query": { "filter": filter, "per-page": page_size, "select": select, "mailto": mailto },
    }));
    quotas.push(response_quota(&response));
    artifacts.push(provider_artifact(
        "provider-response",
        "json",
        "application/json",
        &response,
    ));
    require_success(&response, "OpenAlex")?;
    let body: Value = serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
    let total = body["meta"]["count"].as_u64();
    let results = body["results"].as_array().cloned().unwrap_or_default();
    let fetched = results.len();
    let mut papers = results
        .iter()
        .filter_map(openalex_work_to_paper)
        .collect::<Vec<_>>();
    papers = dedupe_remote_ordered(papers);
    papers.truncate(limit);
    let unique = papers.len();
    let exhausted = total.is_none_or(|total| u64::try_from(fetched).unwrap_or(u64::MAX) >= total);
    Ok(AdapterSearchOutcome {
        papers,
        variant_ranks: Vec::new(),
        request: json!({ "provider": "openalex", "requests": requests }),
        raw_artifacts: artifacts,
        hit_count: total,
        quota: Value::Array(quotas),
        warnings: Vec::new(),
        coverage_note: Some(format!(
            "OpenAlex {} edges for {}. Only the first page is read; raise maxResults or fall back to Semantic Scholar for deeper coverage.",
            direction.as_str(),
            anchor.label
        )),
        coverage: runtime::SearchCoverage {
            total_hits: total,
            fetched: u64::try_from(fetched).unwrap_or(u64::MAX),
            unique: u64::try_from(unique).unwrap_or(u64::MAX),
            exhausted,
            next_cursor: None,
            truncated_reason: (!exhausted).then(|| "provider_first_page_only".to_string()),
        },
    })
}

/// Scopus caps `count` at 25 per request for most entitlements.
const SCOPUS_PAGE_MAX: usize = 25;

/// Upper bound on a probe's sample. A probe answers "does this query hit
/// anything, and does what it hits look right" — it is not a retrieval path.
pub const SCOPUS_PROBE_MAX: usize = 10;

/// One non-persisting Scopus lookup.
///
/// `hit_count` is the provider's own total for the query, so a probe answers
/// "would this query return anything" without paging the result set.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScopusProbe {
    pub query: String,
    /// `None` when the provider answered without a usable total.
    pub hit_count: Option<u64>,
    pub sample_titles: Vec<String>,
    /// Provider-side notes (entitlement downgrades and similar). A zero that
    /// comes with a warning is a different problem from a zero that does not,
    /// and without this the caller cannot tell them apart.
    pub warnings: Vec<String>,
    /// The query as actually sent, after field-code wrapping. A probe whose
    /// result surprises the caller is usually a probe whose query was rewritten.
    pub sent_query: String,
}

/// Runs `query` against Scopus and returns the hit count with a small sample,
/// writing nothing.
///
/// The persisted path (`LiteratureSearch` and the protocol tools) creates a
/// SearchProtocol, a SearchRun and canonical library records, which makes it
/// unusable for "let the model check its own candidate query before committing
/// to it": a rejected draft would still leave durable artifacts behind, and its
/// `WorkspaceWrite` permission cannot be granted to an autonomous run. This
/// borrows the same adapter and drops everything except the counts.
pub fn scopus_probe(query: &str, limit: usize) -> Result<ScopusProbe, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("probe query cannot be empty".to_string());
    }
    let limit = limit.clamp(1, SCOPUS_PROBE_MAX);
    let client = http_client()?;
    // A probe is a single bounded page, so there is nothing long enough to stop.
    let outcome = search_scopus(&client, query, limit, None, "relevance", None, &|| false)?;
    let sample_titles = outcome
        .papers
        .iter()
        .take(limit)
        .map(|paper| paper.title.clone())
        .filter(|title| !title.trim().is_empty())
        .collect::<Vec<_>>();
    // `search_scopus` leaves `hit_count` at `None` for a zero-result query,
    // because on the retrieval path an absent total means "unknown" and is
    // harmless. A probe exists to answer exactly that case, and reporting it as
    // `null` is indistinguishable from "the probe told us nothing" — which is
    // the one answer a caller must not confuse with "your query is too narrow".
    // A response that carried neither a total nor a record is a zero.
    let hit_count = outcome
        .hit_count
        .or_else(|| (outcome.papers.is_empty()).then_some(0));
    Ok(ScopusProbe {
        query: query.to_string(),
        hit_count,
        sample_titles,
        warnings: outcome.warnings,
        sent_query: scopus_query(query),
    })
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScopusTokenKind {
    Open,
    Close,
    /// `W/n` or `PRE/n`.
    Proximity,
    /// A field code immediately followed by `(`, e.g. `TITLE-ABS-KEY(`.
    Field,
    Other,
}

#[derive(Debug, Clone, Copy)]
struct ScopusToken {
    kind: ScopusTokenKind,
    start: usize,
    end: usize,
}

fn tokenize_scopus(query: &str) -> Vec<ScopusToken> {
    let bytes = query.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() {
            index += 1;
            continue;
        }
        let start = index;
        let kind = match byte {
            b'(' => {
                index += 1;
                ScopusTokenKind::Open
            }
            b')' => {
                index += 1;
                ScopusTokenKind::Close
            }
            // A quoted or braced phrase is one operand even when it contains
            // spaces, parentheses or an operator-looking word.
            b'"' | b'{' => {
                let closing = if byte == b'"' { b'"' } else { b'}' };
                index += 1;
                while index < bytes.len() && bytes[index] != closing {
                    index += 1;
                }
                index = (index + 1).min(bytes.len());
                ScopusTokenKind::Other
            }
            _ => {
                while index < bytes.len()
                    && !bytes[index].is_ascii_whitespace()
                    && bytes[index] != b'('
                    && bytes[index] != b')'
                    && bytes[index] != b'"'
                {
                    index += 1;
                }
                let word = &query[start..index];
                if index < bytes.len() && bytes[index] == b'(' {
                    ScopusTokenKind::Field
                } else if is_scopus_proximity_operator(word) {
                    ScopusTokenKind::Proximity
                } else {
                    ScopusTokenKind::Other
                }
            }
        };
        tokens.push(ScopusToken {
            kind,
            start,
            end: index,
        });
    }
    tokens
}

fn is_scopus_proximity_operator(word: &str) -> bool {
    let Some((name, distance)) = word.split_once('/') else {
        return false;
    };
    (name.eq_ignore_ascii_case("W") || name.eq_ignore_ascii_case("PRE"))
        && !distance.is_empty()
        && distance.bytes().all(|byte| byte.is_ascii_digit())
}

/// Index of the token closing the group opened at `open`, if any.
fn scopus_group_end(tokens: &[ScopusToken], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (index, token) in tokens.iter().enumerate().skip(open) {
        match token.kind {
            ScopusTokenKind::Open => depth += 1,
            ScopusTokenKind::Close => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

/// Index of the token opening the group closed at `close`, if any.
fn scopus_group_start(tokens: &[ScopusToken], close: usize) -> Option<usize> {
    let mut depth = 0usize;
    for index in (0..=close).rev() {
        match tokens[index].kind {
            ScopusTokenKind::Close => depth += 1,
            ScopusTokenKind::Open => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

/// Parenthesises every `W/n` / `PRE/n` chain that is not already parenthesised.
///
/// Scopus binds a bare proximity operator across neighbouring `OR` terms, so
/// `(time W/3 series OR timeseries OR ...)` does not mean what it reads as: the
/// same group returns 5 records where `(time W/3 series) OR timeseries OR ...`
/// returns over a million. Every query this crate sends is normalised here
/// because a silently collapsed result set is indistinguishable from a topic
/// with no literature — which is exactly how it was read for several rounds of
/// an automated review workflow.
///
/// Adding parentheses around a complete sub-expression cannot change the meaning
/// of a correctly parsed query, so this is safe to apply unconditionally.
fn balance_scopus_proximity(query: &str) -> (String, bool) {
    let tokens = tokenize_scopus(query);
    let mut insertions: Vec<(usize, char)> = Vec::new();
    let mut index = 0usize;
    while index < tokens.len() {
        if tokens[index].kind != ScopusTokenKind::Proximity {
            index += 1;
            continue;
        }
        // Expand to the whole chain: `a W/3 b W/3 c` is one expression.
        let Some(first) = scopus_operand_start(&tokens, index) else {
            index += 1;
            continue;
        };
        let mut last = index;
        loop {
            let Some(right) = scopus_operand_end(&tokens, last) else {
                break;
            };
            last = right;
            if tokens
                .get(last + 1)
                .is_some_and(|token| token.kind == ScopusTokenKind::Proximity)
            {
                last += 1;
                continue;
            }
            break;
        }
        let already_wrapped = first > 0
            && tokens[first - 1].kind == ScopusTokenKind::Open
            && scopus_group_end(&tokens, first - 1) == Some(last + 1);
        if !already_wrapped {
            insertions.push((tokens[first].start, '('));
            insertions.push((tokens[last].end, ')'));
        }
        index = last + 1;
    }
    if insertions.is_empty() {
        return (query.to_string(), false);
    }
    // Splice from the right so earlier offsets stay valid.
    insertions.sort_by(|left, right| right.0.cmp(&left.0));
    let mut rewritten = query.to_string();
    for (position, character) in insertions {
        rewritten.insert(position, character);
    }
    (rewritten, true)
}

/// Start token of the operand to the left of the proximity operator at `op`.
fn scopus_operand_start(tokens: &[ScopusToken], op: usize) -> Option<usize> {
    let left = op.checked_sub(1)?;
    match tokens[left].kind {
        ScopusTokenKind::Close => {
            let open = scopus_group_start(tokens, left)?;
            // A field-qualified group (`TITLE(x)`) belongs to its field code.
            Some(match open.checked_sub(1) {
                Some(previous) if tokens[previous].kind == ScopusTokenKind::Field => previous,
                _ => open,
            })
        }
        ScopusTokenKind::Other => Some(left),
        _ => None,
    }
}

/// End token of the operand to the right of the proximity operator at `op`.
fn scopus_operand_end(tokens: &[ScopusToken], op: usize) -> Option<usize> {
    let right = op + 1;
    match tokens.get(right)?.kind {
        ScopusTokenKind::Open => scopus_group_end(tokens, right),
        ScopusTokenKind::Field => scopus_group_end(tokens, right + 1),
        ScopusTokenKind::Other => Some(right),
        _ => None,
    }
}

/// The query as it will actually be sent to Scopus, after field-code wrapping
/// and proximity normalisation.
///
/// Exposed because a caller that reports "0 results" needs to be able to show
/// the query the provider actually answered, not the one it was handed.
pub fn scopus_query_for_provider(query: &str) -> String {
    scopus_query(query)
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
    let wrapped = if fielded {
        compact
    } else {
        format!("TITLE-ABS-KEY({compact})")
    };
    balance_scopus_proximity(&wrapped).0
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

#[allow(dead_code)]
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
    time_window: Option<&ParsedTimeWindow>,
    sort_order: &str,
    initial_cursor: Option<&str>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<AdapterSearchOutcome, String> {
    if contains_cjk(query) {
        return Err(
            "Scopus queries must use English academic terms; Chinese/CJK characters are not sent"
                .to_string(),
        );
    }
    let api_key = scopus_api_key()?;
    let query = scopus_query_with_time_window(&scopus_query(query), time_window);
    // COMPLETE view includes abstracts but needs extra entitlement — fall back
    // to the STANDARD view (no abstracts) once, then keep using it for the rest
    // of the pages instead of failing the search.
    let mut view = "COMPLETE";
    let mut papers = Vec::new();
    let mut fetched_entries = 0usize;
    let mut cursor = initial_cursor
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("*")
        .to_string();
    let mut hit_count = None;
    let mut raw_artifacts = Vec::new();
    let mut requests = Vec::new();
    let mut quotas = Vec::new();
    let mut warnings = Vec::new();
    let mut exhausted = false;
    // Scopus caps each page at SCOPUS_PAGE_MAX, so page through until we reach
    // the requested `limit` or exhaust the result set.
    loop {
        let count = (limit - papers.len()).min(SCOPUS_PAGE_MAX);
        if count == 0 {
            break;
        }
        // Scopus pages 25 rows at a time, so a large protocol is dozens of
        // requests; without this a stop would only land at the source boundary.
        // Checked after the natural exit so a stop arriving as the last page
        // lands cannot relabel a finished source as interrupted.
        stop_before_next_page(should_cancel, "Scopus")?;
        let page_cursor = cursor.clone();
        let request = |view: &str| {
            let mut params: Vec<(&str, String)> = vec![
                ("query", query.clone()),
                ("count", count.to_string()),
                ("cursor", page_cursor.clone()),
                ("view", view.to_string()),
            ];
            if let Some(provider_sort) = scopus_sort_parameter(sort_order) {
                params.push(("sort", provider_sort.to_string()));
            }
            client
                .get("https://api.elsevier.com/content/search/scopus")
                .header("X-ELS-APIKey", api_key.clone())
                .header("Accept", "application/json")
                .query(&params)
        };
        let mut response = send_provider_request("Scopus", || request(view))?;
        requests.push(json!({
            "method": "GET",
            "url": "https://api.elsevier.com/content/search/scopus",
            "query": {
                "query": query,
                "count": count,
                "cursor": page_cursor,
                "view": view,
                "sortOrder": sort_order,
                "providerSort": scopus_sort_parameter(sort_order),
            },
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
            response = send_provider_request("Scopus", || request(view))?;
            requests.push(json!({
                "method": "GET",
                "url": "https://api.elsevier.com/content/search/scopus",
                "query": {
                    "query": query,
                    "count": count,
                    "cursor": page_cursor,
                    "view": view,
                    "sortOrder": sort_order,
                    "providerSort": scopus_sort_parameter(sort_order),
                },
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
        fetched_entries = fetched_entries.saturating_add(entries.len());
        let next_cursor = results["cursor"]["@next"]
            .as_str()
            .or_else(|| results["cursor"]["next"].as_str())
            .map(str::to_string)
            .filter(|next| !next.is_empty() && next != &cursor);
        if let Some(next) = next_cursor.as_ref() {
            cursor = next.clone();
        }
        // Stop at the reported total (when known), a short page (no more rows),
        // or when a page yields nothing usable.
        exhausted = (total > 0 && fetched_entries >= total)
            || entries.len() < count
            || next_cursor.is_none();
        if exhausted || added == 0 {
            break;
        }
    }
    papers = dedupe_remote_ordered(papers);
    papers.truncate(limit);
    let unique = papers.len();
    Ok(AdapterSearchOutcome {
        papers,
        variant_ranks: Vec::new(),
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
        coverage: runtime::SearchCoverage {
            total_hits: hit_count,
            fetched: u64::try_from(fetched_entries).unwrap_or(u64::MAX),
            unique: u64::try_from(unique).unwrap_or(u64::MAX),
            exhausted,
            next_cursor: (!exhausted).then_some(cursor),
            truncated_reason: (!exhausted).then(|| "protocol_max_results".to_string()),
        },
    })
}

fn scopus_sort_parameter(sort_order: &str) -> Option<&'static str> {
    sort_order
        .eq_ignore_ascii_case("publication_date_desc")
        .then_some("-coverDate")
}

fn scopus_query_with_time_window(query: &str, time_window: Option<&ParsedTimeWindow>) -> String {
    let Some(window) = time_window else {
        return query.to_string();
    };
    let mut clauses = vec![format!("({query})")];
    if let Some(from) = window.from_year() {
        clauses.push(format!("PUBYEAR > {}", from.saturating_sub(1)));
    }
    if let Some(until) = window.until_year() {
        clauses.push(format!("PUBYEAR < {}", until.saturating_add(1)));
    }
    clauses.join(" AND ")
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
    dedupe_remote_ordered(papers)
}

fn dedupe_remote_ordered(papers: Vec<RemotePaper>) -> Vec<RemotePaper> {
    let mut result: Vec<RemotePaper> = Vec::with_capacity(papers.len());
    let mut positions = BTreeMap::<String, usize>::new();
    for paper in papers {
        let key = remote_paper_identity_key(&paper);
        if let Some(index) = positions.get(&key).copied() {
            merge_remote(&mut result[index], paper);
        } else {
            positions.insert(key, result.len());
            result.push(paper);
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
    download_pdf_at_with_cancel(base, url, file_name, paper_id, &|| false)
}

pub fn download_pdf_at_with_cancel(
    base: &Path,
    url: &str,
    file_name: &str,
    paper_id: Option<&str>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Value, String> {
    if should_cancel() {
        return Err("interrupted by user".to_string());
    }
    let safe_name = sanitize_file_name(file_name)?;
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("PDF URL must be http(s)".to_string());
    }
    let dir = crate::layout::papers_dir_at(base);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&safe_name);
    if path.exists() {
        return Err(format!(
            "refusing to overwrite existing PDF: {}",
            path.display()
        ));
    }

    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(PDF_DOWNLOAD_IDLE_TIMEOUT)
        .timeout(PDF_DOWNLOAD_IDLE_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if should_cancel() {
        return Err("interrupted by user".to_string());
    }
    if let Some(length) = response.content_length() {
        if length > MAX_PDF_BYTES {
            return Err(format!("PDF is too large ({length} bytes)"));
        }
    }

    let tmp = dir.join(format!("{safe_name}.part-{}", epoch_millis()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|error| error.to_string())?;
    let started = Instant::now();
    let mut bytes = 0_u64;
    let mut signature = Vec::with_capacity(4);
    let mut chunk = [0_u8; PDF_DOWNLOAD_CHUNK_BYTES];
    let download_result = (|| -> Result<(), String> {
        loop {
            if should_cancel() {
                return Err("interrupted by user".to_string());
            }
            if started.elapsed() >= PDF_DOWNLOAD_TOTAL_TIMEOUT {
                return Err(format!(
                    "PDF download timed out after {} seconds",
                    PDF_DOWNLOAD_TOTAL_TIMEOUT.as_secs()
                ));
            }
            let read = response
                .read(&mut chunk)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            if should_cancel() {
                return Err("interrupted by user".to_string());
            }
            bytes += read as u64;
            if bytes > MAX_PDF_BYTES {
                return Err(format!("PDF is too large ({bytes} bytes)"));
            }
            if signature.len() < 4 {
                let needed = 4 - signature.len();
                signature.extend_from_slice(&chunk[..read.min(needed)]);
            }
            file.write_all(&chunk[..read])
                .map_err(|error| error.to_string())?;
        }
        if !signature.starts_with(b"%PDF") {
            return Err(
                "the URL did not return a PDF (the publisher may not expose a direct link)"
                    .to_string(),
            );
        }
        file.flush().map_err(|error| error.to_string())?;
        Ok(())
    })();
    drop(file);
    if let Err(error) = download_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "failed to move PDF into place without overwrite: {error}"
        ));
    }

    let relative_path = format!(
        "{}/{PAPERS_DIR}/{safe_name}",
        crate::layout::PROJECT_DATA_DIR
    );
    if let Some(paper_id) = paper_id {
        mark_pdf_downloaded(base, paper_id, &relative_path, bytes as usize)?;
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "relativePath": relative_path,
        "bytes": bytes,
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
    let output_dir = crate::layout::papers_dir_at(base);
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
