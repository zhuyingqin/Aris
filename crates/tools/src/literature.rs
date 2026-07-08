//! Literature kernel tools.
//!
//! Skills (`/arxiv`, `/research-lit`, …) stay the orchestration layer; these
//! tools are the mechanical hands they use in environments without a shell
//! (ARIS desktop chat) — and the contract both CLI agents and the desktop
//! Literature UI share: one `papers/library.json` per project.
//!
//! - `LiteratureSearch` — arXiv Atom, Crossref REST, OpenAlex works and
//!   Scopus Search API metadata search, normalised into one record shape and
//!   deduplicated. Scopus needs `SCOPUS_API_KEY` (desktop Settings exports it).
//! - `LiteratureLibraryUpsert` — merge search records into
//!   `papers/library.json` without touching user state (stage, stars, tags,
//!   verdicts survive re-discovery).
//! - `LiteraturePdfDownload` — fetch a PDF into `papers/` and, when a paper
//!   id is given, mark it downloaded in the library.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const PAPERS_DIR: &str = "papers";
const LIBRARY_FILE: &str = "library.json";
const HTTP_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_PDF_BYTES: u64 = 80 * 1024 * 1024;
const USER_AGENT: &str = concat!(
    "aris/",
    env!("CARGO_PKG_VERSION"),
    " (literature tools; +https://github.com/zhuyingqin/Aris)"
);
const SCIENCEDIRECT_ORIGIN: &str = "https://www.sciencedirect.com";

const ATOM_NS: &str = "http://www.w3.org/2005/Atom";
const ARXIV_NS: &str = "http://arxiv.org/schemas/atom";

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

// ── Tool entry points (sync, pretty-JSON out) ───────────────────────────────

pub fn run_literature_search(input: LiteratureSearchInput) -> Result<String, String> {
    let limit = input.max_results.unwrap_or(20).clamp(1, 50);
    let outcome = search_remote(&input.query, &input.sources, limit)?;
    serde_json::to_string_pretty(&json!({
        "papers": outcome.papers,
        "warnings": outcome.warnings,
        "sourceCounts": outcome.source_counts,
        "note": "Record results with the LiteratureLibraryUpsert tool so they appear in the shared literature library (papers/library.json).",
    }))
    .map_err(|e| e.to_string())
}

pub fn run_literature_library_upsert(
    input: LiteratureLibraryUpsertInput,
) -> Result<String, String> {
    let base = workspace_base()?;
    let stats = library_upsert_at(&base, &input.papers, input.search.as_ref())?;
    serde_json::to_string_pretty(&stats).map_err(|e| e.to_string())
}

pub fn run_literature_pdf_download(input: LiteraturePdfDownloadInput) -> Result<String, String> {
    let base = workspace_base()?;
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

fn workspace_base() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|e| e.to_string())
}

// ── Library persistence ─────────────────────────────────────────────────────

pub fn library_path_at(base: &Path) -> PathBuf {
    base.join(PAPERS_DIR).join(LIBRARY_FILE)
}

pub fn empty_library() -> Value {
    json!({ "version": 1, "papers": [], "searches": [], "collections": [], "reviewTasks": [] })
}

pub fn library_load_at(base: &Path) -> Result<Value, String> {
    let path = library_path_at(base);
    let backup = path.with_extension("json.bak");
    if !path.exists() {
        return if backup.exists() {
            read_library_json(&backup)
        } else {
            Ok(empty_library())
        };
    }
    match read_library_json(&path) {
        Ok(library) => Ok(library),
        Err(primary_error) if backup.exists() => {
            read_library_json(&backup).map_err(|backup_error| {
                format!("{primary_error}; backup recovery failed: {backup_error}")
            })
        }
        Err(error) => Err(error),
    }
}

fn read_library_json(path: &Path) -> Result<Value, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))
}

pub fn library_save_at(base: &Path, library: &Value) -> Result<(), String> {
    if !library.is_object() {
        return Err("library must be a JSON object".to_string());
    }
    let path = library_path_at(base);
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertStats {
    pub search_id: Option<String>,
    pub added: usize,
    pub merged: usize,
    pub total: usize,
    pub library_path: String,
}

/// Merge remote records (the `papers` array from `LiteratureSearch`) into the
/// library. New papers land in the `inbox` stage; existing papers only get
/// metadata gaps filled — stage, stars, tags, verdicts, and evidence are
/// never overwritten.
pub fn library_upsert_at(
    base: &Path,
    records: &[Value],
    search: Option<&UpsertSearch>,
) -> Result<UpsertStats, String> {
    let mut library = library_load_at(base)?;
    if !library.is_object() {
        library = empty_library();
    }
    let search_id = search.map(|_| format!("search-{:x}", epoch_millis()));
    let mut added = 0;
    let mut merged = 0;
    {
        let papers = library
            .as_object_mut()
            .expect("library is an object")
            .entry("papers")
            .or_insert_with(|| Value::Array(Vec::new()));
        let Value::Array(papers) = papers else {
            return Err("library.papers must be an array".to_string());
        };
        for record in records {
            if record_title(record).is_empty() {
                continue;
            }
            let existing = papers.iter_mut().find(|paper| same_record(paper, record));
            match existing {
                Some(paper) => {
                    enrich_paper(paper, record, search_id.as_deref());
                    merged += 1;
                }
                None => {
                    papers.insert(0, paper_from_record(record, search_id.as_deref()));
                    added += 1;
                }
            }
        }
    }
    let total = library["papers"].as_array().map_or(0, Vec::len);
    if let (Some(search), Some(search_id)) = (search, search_id.as_deref()) {
        let entry = json!({
            "id": search_id,
            "query": search.query,
            "sources": search.sources,
            "ranAt": now_iso(),
            "resultCount": records.len(),
            "newCount": added,
        });
        let searches = library
            .as_object_mut()
            .expect("library is an object")
            .entry("searches")
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(searches) = searches {
            searches.insert(0, entry);
        }
    }
    library_save_at(base, &library)?;
    Ok(UpsertStats {
        search_id,
        added,
        merged,
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

fn same_record(paper: &Value, record: &Value) -> bool {
    let id_match =
        !record_str(record, "id").is_empty() && record_str(paper, "id") == record_str(record, "id");
    let doi_match = !record_str(record, "doi").is_empty()
        && record_str(paper, "doi").eq_ignore_ascii_case(record_str(record, "doi"));
    let arxiv_match = !record_str(record, "arxivId").is_empty()
        && record_str(paper, "arxivId") == record_str(record, "arxivId");
    let title_match = {
        let left = normalized_title(record_str(paper, "title"));
        let right = normalized_title(record_str(record, "title"));
        !right.is_empty() && left == right
    };
    id_match || doi_match || arxiv_match || title_match
}

fn paper_from_record(record: &Value, search_id: Option<&str>) -> Value {
    let search_ids: Vec<Value> = search_id.map(|id| json!(id)).into_iter().collect();
    json!({
        "id": non_empty(record_str(record, "id"))
            .unwrap_or_else(|| format!("title:{}", normalized_title(record_str(record, "title")))),
        "title": record_title(record),
        "authors": record["authors"].as_array().cloned().unwrap_or_default(),
        "year": record["year"].as_u64(),
        "venue": record_str(record, "venue"),
        "doi": record["doi"].as_str(),
        "arxivId": record["arxivId"].as_str(),
        "url": record["url"].as_str(),
        "abstract": record_str(record, "abstract"),
        "tags": [],
        "collectionIds": [],
        "searchIds": search_ids,
        "stage": "inbox",
        "starred": false,
        "unread": true,
        "source": record_str(record, "source"),
        "citedBy": record["citedBy"].as_u64(),
        "addedAt": now_iso(),
        "pdf": { "status": "none", "url": record["pdfUrl"].as_str() },
        "evidence": [],
    })
}

fn enrich_paper(paper: &mut Value, record: &Value, search_id: Option<&str>) {
    let fill = |paper: &mut Value, key: &str, value: Option<Value>| {
        let missing = paper[key].is_null()
            || paper[key]
                .as_str()
                .is_some_and(|value| value.trim().is_empty());
        if missing {
            if let Some(value) = value {
                paper[key] = value;
            }
        }
    };
    fill(paper, "doi", record["doi"].as_str().map(Value::from));
    fill(
        paper,
        "arxivId",
        record["arxivId"].as_str().map(Value::from),
    );
    fill(paper, "url", record["url"].as_str().map(Value::from));
    fill(paper, "year", record["year"].as_u64().map(Value::from));
    fill(
        paper,
        "venue",
        non_empty(record_str(record, "venue")).map(Value::from),
    );
    fill(
        paper,
        "abstract",
        non_empty(record_str(record, "abstract")).map(Value::from),
    );
    if paper["authors"].as_array().is_none_or(Vec::is_empty) {
        if let Some(authors) = record["authors"]
            .as_array()
            .filter(|authors| !authors.is_empty())
        {
            paper["authors"] = Value::Array(authors.clone());
        }
    }
    let incoming_source = record_str(record, "source").to_string();
    let existing_source = record_str(paper, "source").to_string();
    if existing_source.is_empty() {
        if !incoming_source.is_empty() {
            paper["source"] = Value::from(incoming_source);
        }
    } else if !incoming_source.is_empty() && !existing_source.contains(&incoming_source) {
        paper["source"] = Value::from(format!("{existing_source} + {incoming_source}"));
    }
    if let Some(cited_by) = record["citedBy"].as_u64() {
        paper["citedBy"] = Value::from(cited_by);
    }
    if !paper["pdf"].is_object() {
        paper["pdf"] = json!({ "status": "none" });
    }
    if paper["pdf"]["url"].as_str().unwrap_or_default().is_empty() {
        if let Some(pdf_url) = record["pdfUrl"].as_str() {
            paper["pdf"]["url"] = Value::from(pdf_url);
        }
    }
    if let Some(search_id) = search_id {
        if !paper["searchIds"].is_array() {
            paper["searchIds"] = Value::Array(Vec::new());
        }
        if let Value::Array(ids) = &mut paper["searchIds"] {
            if !ids.iter().any(|id| id.as_str() == Some(search_id)) {
                ids.push(Value::from(search_id));
            }
        }
    }
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

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Blocking remote metadata search. Empty `sources` means every available
/// source — Scopus joins the default set only when `SCOPUS_API_KEY` is set,
/// but an explicit `"scopus"` request always runs (and surfaces the missing
/// key as a warning).
pub fn search_remote(
    query: &str,
    sources: &[String],
    limit: usize,
) -> Result<SearchOutcome, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("search query is empty".to_string());
    }
    let explicit = |name: &str| {
        sources
            .iter()
            .any(|source| source.eq_ignore_ascii_case(name))
    };
    let wants = |name: &str| sources.is_empty() || explicit(name);
    let client = http_client()?;
    let mut papers = Vec::new();
    let mut warnings = Vec::new();
    let mut source_counts = Vec::new();
    let mut run = |label: &str, batch: Result<Vec<RemotePaper>, String>| match batch {
        Ok(batch) => {
            source_counts.push(SourceCount {
                source: label.to_string(),
                count: batch.len(),
            });
            papers.extend(batch);
        }
        Err(error) => warnings.push(format!("{label}: {error}")),
    };
    if wants("arxiv") {
        run("arXiv", search_arxiv(&client, query, limit));
    }
    if wants("crossref") {
        run("Crossref", search_crossref(&client, query, limit));
    }
    if wants("openalex") {
        run("OpenAlex", search_openalex(&client, query, limit));
    }
    if explicit("scopus") || (sources.is_empty() && scopus_api_key().is_ok()) {
        run("Scopus", search_scopus(&client, query, limit));
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

fn search_arxiv(
    client: &reqwest::blocking::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<RemotePaper>, String> {
    let body = client
        .get("https://export.arxiv.org/api/query")
        .query(&[
            ("search_query", query),
            ("start", "0"),
            ("max_results", &limit.to_string()),
            ("sortBy", "relevance"),
            ("sortOrder", "descending"),
        ])
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .map_err(|e| e.to_string())?;
    parse_arxiv_feed(&body)
}

fn parse_arxiv_feed(xml: &str) -> Result<Vec<RemotePaper>, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("invalid Atom feed: {e}"))?;
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
    Ok(papers)
}

fn search_crossref(
    client: &reqwest::blocking::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<RemotePaper>, String> {
    let body: Value = client
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
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    let items = body["message"]["items"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(items.iter().filter_map(crossref_item_to_paper).collect())
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
) -> Result<Vec<RemotePaper>, String> {
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
    let body: Value = client
        .get("https://api.openalex.org/works")
        .query(&params)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    let results = body["results"].as_array().cloned().unwrap_or_default();
    Ok(results.iter().filter_map(openalex_work_to_paper).collect())
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
) -> Result<Vec<RemotePaper>, String> {
    let api_key = scopus_api_key()?;
    let count = limit.min(SCOPUS_PAGE_MAX);
    let query = scopus_query(query);
    let request = |view: Option<&str>| {
        let mut params: Vec<(&str, String)> = vec![
            ("query", query.clone()),
            ("count", count.to_string()),
            ("start", "0".to_string()),
        ];
        if let Some(view) = view {
            params.push(("view", view.to_string()));
        }
        client
            .get("https://api.elsevier.com/content/search/scopus")
            .header("X-ELS-APIKey", api_key.clone())
            .header("Accept", "application/json")
            .query(&params)
            .send()
    };
    // COMPLETE view includes abstracts but needs extra entitlement — fall back
    // to the STANDARD view (no abstracts) instead of failing the search.
    let response = request(Some("COMPLETE")).map_err(|e| e.to_string())?;
    let response = if matches!(response.status().as_u16(), 401 | 403) {
        request(None).map_err(|e| e.to_string())?
    } else {
        response
    };
    let response = response
        .error_for_status()
        .map_err(|e| format!("{e} (check the SCOPUS_API_KEY and its entitlements)"))?;
    let body: Value = response.json().map_err(|e| e.to_string())?;
    let entries = body["search-results"]["entry"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    // An empty result set arrives as one `{ "error": "Result set was empty" }`
    // entry — filter_map drops it because it has no title.
    Ok(entries.iter().filter_map(scopus_entry_to_paper).collect())
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

    let path = dir.join(&safe_name);
    let tmp = dir.join(format!("{safe_name}.part"));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;

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

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

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
        let unique = epoch_millis();
        let base = std::env::temp_dir().join(format!("somniq-lit-{name}-{unique}"));
        std::fs::create_dir_all(&base).expect("create temp base");
        base
    }

    fn record(id: &str, title: &str) -> Value {
        json!({
            "id": id,
            "title": title,
            "authors": [],
            "year": 2026,
            "venue": "arXiv",
            "doi": null,
            "arxivId": id.strip_prefix("arxiv:"),
            "abstract": "An abstract.",
            "url": "https://arxiv.org/abs/x",
            "pdfUrl": "https://arxiv.org/pdf/x.pdf",
            "source": "arXiv",
            "citedBy": null,
        })
    }

    const ARXIV_FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2602.01491v2</id>
    <title>Agentic Literature  Review:
      Planning and Synthesis</title>
    <summary>  A system design for
      grounded review work.  </summary>
    <published>2026-02-03T18:00:00Z</published>
    <author><name>Maya Rivera</name></author>
    <author><name>Li Chen</name></author>
    <arxiv:doi>10.48550/arXiv.2602.01491</arxiv:doi>
    <link href="http://arxiv.org/abs/2602.01491v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2602.01491v2" rel="related" type="application/pdf"/>
  </entry>
</feed>"#;

    #[test]
    fn parses_arxiv_atom_entries() {
        let papers = parse_arxiv_feed(ARXIV_FIXTURE).expect("fixture should parse");
        assert_eq!(papers.len(), 1);
        let paper = &papers[0];
        assert_eq!(paper.id, "arxiv:2602.01491");
        assert_eq!(paper.arxiv_id.as_deref(), Some("2602.01491"));
        assert_eq!(
            paper.title,
            "Agentic Literature Review: Planning and Synthesis"
        );
        assert_eq!(paper.summary, "A system design for grounded review work.");
        assert_eq!(paper.authors, vec!["Maya Rivera", "Li Chen"]);
        assert_eq!(paper.year, Some(2026));
        assert_eq!(paper.published.as_deref(), Some("2026-02-03"));
        assert_eq!(paper.doi.as_deref(), Some("10.48550/arxiv.2602.01491"));
        assert_eq!(
            paper.pdf_url.as_deref(),
            Some("http://arxiv.org/pdf/2602.01491v2")
        );
        assert_eq!(paper.venue, "arXiv");
    }

    #[test]
    fn maps_crossref_items_and_strips_jats_abstract() {
        let item = json!({
            "DOI": "10.1145/Example.1024",
            "title": ["Grounded PDF  Summarization"],
            "author": [
                { "given": "Sana", "family": "Iyer" },
                { "family": "Almeida" }
            ],
            "issued": { "date-parts": [[2025, 4]] },
            "container-title": ["CHI Late Breaking Work"],
            "abstract": "<jats:p>An interface &amp; annotation study.</jats:p>",
            "URL": "https://doi.org/10.1145/example.1024",
            "is-referenced-by-count": 12,
            "link": [
                { "URL": "https://dl.acm.org/example.pdf", "content-type": "application/pdf" }
            ]
        });
        let paper = crossref_item_to_paper(&item).expect("item should map");
        assert_eq!(paper.id, "doi:10.1145/example.1024");
        assert_eq!(paper.title, "Grounded PDF Summarization");
        assert_eq!(paper.authors, vec!["Sana Iyer", "Almeida"]);
        assert_eq!(paper.year, Some(2025));
        assert_eq!(paper.venue, "CHI Late Breaking Work");
        assert_eq!(paper.summary, "An interface & annotation study.");
        assert_eq!(
            paper.pdf_url.as_deref(),
            Some("https://dl.acm.org/example.pdf")
        );
        assert_eq!(paper.cited_by, Some(12));
    }

    #[test]
    fn maps_openalex_works_and_rebuilds_inverted_abstract() {
        let work = json!({
            "id": "https://openalex.org/W4399100000",
            "doi": "https://doi.org/10.48550/arXiv.2602.01491",
            "title": "Agentic Literature  Review: Planning and Synthesis",
            "publication_year": 2026,
            "publication_date": "2026-02-03",
            "authorships": [
                { "author": { "display_name": "Maya Rivera" } },
                { "author": { "display_name": "Li Chen" } }
            ],
            "primary_location": {
                "source": { "display_name": "arXiv" },
                "landing_page_url": "https://arxiv.org/abs/2602.01491v2",
                "pdf_url": null
            },
            "best_oa_location": { "pdf_url": "https://arxiv.org/pdf/2602.01491" },
            "open_access": { "oa_url": "https://arxiv.org/abs/2602.01491" },
            "cited_by_count": 31,
            "abstract_inverted_index": {
                "grounded": [4],
                "A": [0],
                "system": [1],
                "for": [3],
                "design": [2],
                "review.": [5]
            }
        });
        let paper = openalex_work_to_paper(&work).expect("work should map");
        assert_eq!(paper.id, "openalex:W4399100000");
        assert_eq!(
            paper.title,
            "Agentic Literature Review: Planning and Synthesis"
        );
        assert_eq!(paper.doi.as_deref(), Some("10.48550/arxiv.2602.01491"));
        assert_eq!(paper.arxiv_id.as_deref(), Some("2602.01491"));
        assert_eq!(paper.authors, vec!["Maya Rivera", "Li Chen"]);
        assert_eq!(paper.year, Some(2026));
        assert_eq!(paper.venue, "arXiv");
        assert_eq!(paper.summary, "A system design for grounded review.");
        assert_eq!(
            paper.url.as_deref(),
            Some("https://doi.org/10.48550/arXiv.2602.01491")
        );
        assert_eq!(
            paper.pdf_url.as_deref(),
            Some("https://arxiv.org/pdf/2602.01491")
        );
        assert_eq!(paper.cited_by, Some(31));
        assert_eq!(paper.source, "OpenAlex");
    }

    #[test]
    fn openalex_falls_back_to_landing_page_arxiv_id() {
        let work = json!({
            "id": "https://openalex.org/W123",
            "title": "Paper",
            "primary_location": {
                "landing_page_url": "https://arxiv.org/abs/2409.01010v3"
            }
        });
        let paper = openalex_work_to_paper(&work).expect("work should map");
        assert_eq!(paper.arxiv_id.as_deref(), Some("2409.01010"));
        assert!(paper.doi.is_none());
    }

    #[test]
    fn maps_scopus_entries() {
        let entry = json!({
            "dc:identifier": "SCOPUS_ID:85190000001",
            "eid": "2-s2.0-85190000001",
            "dc:title": "Congestion Control  for Satellite Networks",
            "dc:creator": "Iyer S.",
            "author": [
                { "authname": "Iyer S." },
                { "authname": "Almeida P." }
            ],
            "prism:publicationName": "IEEE Transactions on Networking",
            "prism:coverDate": "2025-04-01",
            "prism:doi": "10.1109/Example.2025.42",
            "dc:description": "We study congestion control &amp; queueing.",
            "citedby-count": "17",
            "link": [
                { "@ref": "self", "@href": "https://api.elsevier.com/content/abstract/scopus_id/85190000001" },
                { "@ref": "scopus", "@href": "https://www.scopus.com/inward/record.uri?eid=2-s2.0-85190000001" }
            ]
        });
        let paper = scopus_entry_to_paper(&entry).expect("entry should map");
        assert_eq!(paper.id, "scopus:85190000001");
        assert_eq!(paper.title, "Congestion Control for Satellite Networks");
        assert_eq!(paper.authors, vec!["Iyer S.", "Almeida P."]);
        assert_eq!(paper.year, Some(2025));
        assert_eq!(paper.venue, "IEEE Transactions on Networking");
        assert_eq!(paper.doi.as_deref(), Some("10.1109/example.2025.42"));
        assert_eq!(paper.summary, "We study congestion control & queueing.");
        assert_eq!(paper.cited_by, Some(17));
        assert_eq!(
            paper.url.as_deref(),
            Some("https://www.scopus.com/inward/record.uri?eid=2-s2.0-85190000001")
        );
        assert_eq!(paper.pdf_url, None);
        assert_eq!(paper.source, "Scopus");
    }

    #[test]
    fn scopus_empty_result_entry_is_dropped() {
        let entry = json!({ "error": "Result set was empty" });
        assert!(scopus_entry_to_paper(&entry).is_none());
    }

    #[test]
    fn wraps_bare_scopus_queries_in_title_abs_key() {
        assert_eq!(
            scopus_query("satellite  congestion control"),
            "TITLE-ABS-KEY(satellite congestion control)"
        );
        assert_eq!(
            scopus_query("10.1109/TKDE.2020.2981314"),
            "DOI(10.1109/tkde.2020.2981314)"
        );
        assert_eq!(
            scopus_query(
                "Reinforcement learning–guided angle PSO for optimizing echo state networks in wind power forecasting"
            ),
            "TITLE-ABS-KEY(\"Reinforcement learning-guided angle PSO for optimizing echo state networks in wind power forecasting\")"
        );
        assert_eq!(
            scopus_query("TITLE-ABS-KEY(\"semantic communication\") AND PUBYEAR > 2020"),
            "TITLE-ABS-KEY(\"semantic communication\") AND PUBYEAR > 2020"
        );
        assert_eq!(
            scopus_query("AUTH(rivera) AND KEY(agents)"),
            "AUTH(rivera) AND KEY(agents)"
        );
    }

    #[test]
    fn parses_ieee_stamp_pdf_routes() {
        assert_eq!(
            parse_ieee_arnumber("https://ieeexplore.ieee.org/document/9039685/").as_deref(),
            Some("9039685")
        );
        assert_eq!(
            parse_ieee_arnumber(
                "https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=9039685&ref="
            )
            .as_deref(),
            Some("9039685")
        );
    }

    #[test]
    fn extracts_sciencedirect_pdfft_links() {
        let html = r#"
          <a aria-label="View PDF" href="/science/article/pii/S0010482520301621/pdfft?md5=abc&amp;pid=main.pdf">ViewPDF</a>
        "#;
        let href = find_sciencedirect_pdf_href(html).expect("href");
        assert_eq!(
            absolutize_sciencedirect_url(&href),
            "https://www.sciencedirect.com/science/article/pii/S0010482520301621/pdfft?md5=abc&pid=main.pdf"
        );
    }

    #[test]
    fn maps_elsevier_linkinghub_pii_to_sciencedirect_page() {
        assert_eq!(
            sciencedirect_article_page_url(
                "https://linkinghub.elsevier.com/retrieve/pii/S0020025526001908"
            )
            .as_deref(),
            Some("https://www.sciencedirect.com/science/article/pii/S0020025526001908")
        );
    }

    #[test]
    fn builds_ieee_browser_download_task() {
        let paper = RemotePaper {
            id: "doi:10.1109/tkde.2020.2981314".into(),
            title: "A Survey on Deep Learning for Named Entity Recognition".into(),
            authors: Vec::new(),
            year: Some(2022),
            venue: "IEEE Transactions on Knowledge and Data Engineering".into(),
            doi: Some("10.1109/tkde.2020.2981314".into()),
            arxiv_id: None,
            summary: String::new(),
            url: Some("https://ieeexplore.ieee.org/document/9039685/".into()),
            pdf_url: None,
            source: "IEEE".into(),
            published: None,
            cited_by: None,
        };
        let task = browser_download_task_for_paper(&paper)
            .expect("task")
            .expect("publisher task");
        assert_eq!(task["publisher"], "IEEE");
        assert_eq!(
            task["pdf_url"],
            "https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=9039685&ref="
        );
    }

    #[test]
    fn builds_sciencedirect_browser_download_task() {
        let paper = RemotePaper {
            id: "doi:10.1016/j.compbiomed.2020.103792".into(),
            title: "COVID-19 diagnosis using artificial intelligence".into(),
            authors: Vec::new(),
            year: Some(2020),
            venue: "Computers in Biology and Medicine".into(),
            doi: Some("10.1016/j.compbiomed.2020.103792".into()),
            arxiv_id: None,
            summary: String::new(),
            url: Some("https://www.sciencedirect.com/science/article/pii/S0010482520301621".into()),
            pdf_url: None,
            source: "ScienceDirect".into(),
            published: None,
            cited_by: None,
        };
        let task = browser_download_task_for_paper(&paper)
            .expect("task")
            .expect("publisher task");
        assert_eq!(task["publisher"], "Elsevier/ScienceDirect");
        assert_eq!(task["extractor"], "sciencedirect_viewpdf");
        assert_eq!(
            task["page_url"],
            "https://www.sciencedirect.com/science/article/pii/S0010482520301621"
        );
    }

    #[test]
    fn builds_sciencedirect_browser_task_from_elsevier_linkinghub() {
        let paper = RemotePaper {
            id: "doi:10.1016/j.ins.2026.123259".into(),
            title: "Reinforcement learning-guided angle PSO for optimizing echo state networks in wind power forecasting".into(),
            authors: Vec::new(),
            year: Some(2026),
            venue: "Information Sciences".into(),
            doi: Some("10.1016/j.ins.2026.123259".into()),
            arxiv_id: None,
            summary: String::new(),
            url: Some("https://linkinghub.elsevier.com/retrieve/pii/S0020025526001908".into()),
            pdf_url: None,
            source: "Scopus".into(),
            published: None,
            cited_by: None,
        };
        let task = browser_download_task_for_paper(&paper)
            .expect("task")
            .expect("publisher task");
        assert_eq!(task["publisher"], "Elsevier/ScienceDirect");
        assert_eq!(task["extractor"], "sciencedirect_viewpdf");
        assert_eq!(
            task["page_url"],
            "https://www.sciencedirect.com/science/article/pii/S0020025526001908"
        );
    }

    #[test]
    fn dedupe_merges_arxiv_and_crossref_records() {
        let arxiv = RemotePaper {
            id: "arxiv:2602.01491".into(),
            title: "Agentic Literature Review: Planning and Synthesis".into(),
            authors: vec!["Maya Rivera".into()],
            year: Some(2026),
            venue: "arXiv".into(),
            doi: None,
            arxiv_id: Some("2602.01491".into()),
            summary: "A system design.".into(),
            url: Some("https://arxiv.org/abs/2602.01491".into()),
            pdf_url: Some("https://arxiv.org/pdf/2602.01491.pdf".into()),
            source: "arXiv".into(),
            published: Some("2026-02-03".into()),
            cited_by: None,
        };
        let crossref = RemotePaper {
            id: "doi:10.48550/arxiv.2602.01491".into(),
            title: "Agentic literature review: planning and synthesis".into(),
            authors: vec!["Maya Rivera".into()],
            year: Some(2026),
            venue: "TMLR".into(),
            doi: Some("10.48550/arxiv.2602.01491".into()),
            arxiv_id: None,
            summary: String::new(),
            url: Some("https://doi.org/10.48550/arxiv.2602.01491".into()),
            pdf_url: None,
            source: "Crossref".into(),
            published: None,
            cited_by: Some(31),
        };
        let merged = dedupe(vec![arxiv, crossref]);
        assert_eq!(merged.len(), 1);
        let paper = &merged[0];
        assert_eq!(paper.doi.as_deref(), Some("10.48550/arxiv.2602.01491"));
        assert_eq!(paper.venue, "TMLR");
        assert_eq!(paper.cited_by, Some(31));
        assert_eq!(paper.source, "arXiv + Crossref");
        assert_eq!(
            paper.pdf_url.as_deref(),
            Some("https://arxiv.org/pdf/2602.01491.pdf")
        );
    }

    #[test]
    fn upsert_adds_new_papers_into_the_inbox() {
        let base = temp_base("upsert-add");
        let stats = library_upsert_at(
            &base,
            &[record("arxiv:1111.00001", "Paper One")],
            Some(&UpsertSearch {
                query: "paper one".into(),
                sources: vec!["arxiv".into()],
            }),
        )
        .expect("upsert should work");
        assert_eq!(stats.added, 1);
        assert_eq!(stats.merged, 0);
        assert_eq!(stats.total, 1);
        let library = library_load_at(&base).expect("library loads");
        let paper = &library["papers"][0];
        assert_eq!(paper["stage"], "inbox");
        assert_eq!(paper["unread"], true);
        assert_eq!(paper["pdf"]["status"], "none");
        assert_eq!(library["searches"][0]["query"], "paper one");
        assert_eq!(library["searches"][0]["newCount"], 1);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn library_save_keeps_the_previous_version_as_a_backup() {
        let base = temp_base("save-backup");
        let mut first = empty_library();
        first["projectFocus"] = json!({ "question": "first" });
        library_save_at(&base, &first).expect("save first version");

        let mut second = empty_library();
        second["projectFocus"] = json!({ "question": "second" });
        library_save_at(&base, &second).expect("save second version");

        let backup_path = library_path_at(&base).with_extension("json.bak");
        let backup: Value = serde_json::from_str(
            &std::fs::read_to_string(backup_path).expect("backup should exist"),
        )
        .expect("backup should be valid JSON");
        assert_eq!(backup["projectFocus"]["question"], "first");
        assert_eq!(
            library_load_at(&base).expect("current library")["projectFocus"]["question"],
            "second"
        );
        std::fs::write(library_path_at(&base), "{broken").expect("corrupt current library");
        assert_eq!(
            library_load_at(&base).expect("recover backup")["projectFocus"]["question"],
            "first"
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn upsert_enriches_existing_papers_without_touching_user_state() {
        let base = temp_base("upsert-merge");
        let mut library = empty_library();
        library["papers"] = json!([{
            "id": "arxiv:1111.00001",
            "title": "Paper One",
            "authors": ["A. One"],
            "venue": "",
            "abstract": "",
            "tags": ["keeper"],
            "collectionIds": [],
            "searchIds": [],
            "stage": "shortlist",
            "starred": true,
            "unread": false,
            "source": "arXiv",
            "addedAt": "2026-06-01T00:00:00.000Z",
            "pdf": { "status": "none" },
            "evidence": [],
        }]);
        library_save_at(&base, &library).expect("seed library");

        let mut incoming = record("arxiv:1111.00001", "Paper One");
        incoming["authors"] = json!(["A. One"]);
        incoming["doi"] = Value::from("10.1234/abc");
        incoming["citedBy"] = Value::from(7);
        incoming["source"] = Value::from("OpenAlex");
        let stats = library_upsert_at(&base, &[incoming], None).expect("upsert should work");
        assert_eq!(stats.added, 0);
        assert_eq!(stats.merged, 1);
        assert_eq!(stats.total, 1);

        let saved = library_load_at(&base).expect("library loads");
        let paper = &saved["papers"][0];
        assert_eq!(paper["stage"], "shortlist");
        assert_eq!(paper["starred"], true);
        assert_eq!(paper["tags"], json!(["keeper"]));
        assert_eq!(paper["authors"], json!(["A. One"]));
        assert_eq!(paper["source"], "arXiv + OpenAlex");
        assert_eq!(paper["doi"], "10.1234/abc");
        assert_eq!(paper["citedBy"], 7);
        assert_eq!(paper["abstract"], "An abstract.");
        assert_eq!(paper["pdf"]["url"], "https://arxiv.org/pdf/x.pdf");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn sanitizes_pdf_file_names() {
        assert_eq!(sanitize_file_name("2602.01491").unwrap(), "2602.01491.pdf");
        assert_eq!(
            sanitize_file_name("cs/9901002v1 draft").unwrap(),
            "cs-9901002v1-draft.pdf"
        );
        assert_eq!(
            sanitize_file_name("../../etc/passwd").unwrap(),
            "etc-passwd.pdf"
        );
        assert!(sanitize_file_name("  ").is_err());
        assert_eq!(sanitize_file_name("Paper.PDF").unwrap(), "Paper.PDF");
    }

    #[test]
    fn strips_arxiv_version_suffixes() {
        assert_eq!(strip_version("2602.01491v2"), "2602.01491");
        assert_eq!(strip_version("2602.01491"), "2602.01491");
        assert_eq!(strip_version("cs/9901002v11"), "cs/9901002");
        assert_eq!(strip_version("cs/9901002"), "cs/9901002");
    }
}
