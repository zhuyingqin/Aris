//! Literature kernel tools.
//!
//! Skills (`/arxiv`, `/research-lit`, …) stay the orchestration layer; these
//! tools are the mechanical hands they use in environments without a shell
//! (ARIS desktop chat) — and the contract both CLI agents and the desktop
//! Literature UI share: one `papers/library.json` per project.
//!
//! - `LiteratureSearch` — arXiv Atom + Crossref REST metadata search,
//!   normalised into one record shape and deduplicated.
//! - `LiteratureLibraryUpsert` — merge search records into
//!   `papers/library.json` without touching user state (stage, stars, tags,
//!   verdicts survive re-discovery).
//! - `LiteraturePdfDownload` — fetch a PDF into `papers/` and, when a paper
//!   id is given, mark it downloaded in the library.

use std::path::{Path, PathBuf};
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

pub fn run_literature_library_upsert(input: LiteratureLibraryUpsertInput) -> Result<String, String> {
    let base = workspace_base()?;
    let stats = library_upsert_at(&base, &input.papers, input.search.as_ref())?;
    serde_json::to_string_pretty(&stats).map_err(|e| e.to_string())
}

pub fn run_literature_pdf_download(input: LiteraturePdfDownloadInput) -> Result<String, String> {
    let base = workspace_base()?;
    let result = download_pdf_at(&base, &input.url, &input.file_name, input.paper_id.as_deref())?;
    serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
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
    if !path.exists() {
        return Ok(empty_library());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("library.json is not valid JSON: {e}"))
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
    let data = serde_json::to_vec_pretty(library).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
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
    let id_match = !record_str(record, "id").is_empty()
        && record_str(paper, "id") == record_str(record, "id");
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
            || paper[key].as_str().is_some_and(|value| value.trim().is_empty());
        if missing {
            if let Some(value) = value {
                paper[key] = value;
            }
        }
    };
    fill(paper, "doi", record["doi"].as_str().map(Value::from));
    fill(paper, "arxivId", record["arxivId"].as_str().map(Value::from));
    fill(paper, "url", record["url"].as_str().map(Value::from));
    fill(paper, "year", record["year"].as_u64().map(Value::from));
    fill(paper, "venue", non_empty(record_str(record, "venue")).map(Value::from));
    fill(
        paper,
        "abstract",
        non_empty(record_str(record, "abstract")).map(Value::from),
    );
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

#[derive(Debug, Clone, Serialize)]
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

/// Blocking remote metadata search. Empty `sources` means every source.
pub fn search_remote(
    query: &str,
    sources: &[String],
    limit: usize,
) -> Result<SearchOutcome, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("search query is empty".to_string());
    }
    let wants = |name: &str| {
        sources.is_empty() || sources.iter().any(|source| source.eq_ignore_ascii_case(name))
    };
    let client = http_client()?;
    let mut papers = Vec::new();
    let mut warnings = Vec::new();
    let mut source_counts = Vec::new();
    if wants("arxiv") {
        match search_arxiv(&client, query, limit) {
            Ok(batch) => {
                source_counts.push(SourceCount {
                    source: "arXiv".to_string(),
                    count: batch.len(),
                });
                papers.extend(batch);
            }
            Err(error) => warnings.push(format!("arXiv: {error}")),
        }
    }
    if wants("crossref") {
        match search_crossref(&client, query, limit) {
            Ok(batch) => {
                source_counts.push(SourceCount {
                    source: "Crossref".to_string(),
                    count: batch.len(),
                });
                papers.extend(batch);
            }
            Err(error) => warnings.push(format!("Crossref: {error}")),
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
    let items = body["message"]["items"].as_array().cloned().unwrap_or_default();
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
            "the URL did not return a PDF (the publisher may not expose a direct link)"
                .to_string(),
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
        let base = std::env::temp_dir().join(format!("aris-lit-{name}-{unique}"));
        std::fs::create_dir_all(&base).expect("create temp base");
        base
    }

    fn record(id: &str, title: &str) -> Value {
        json!({
            "id": id,
            "title": title,
            "authors": ["A. One"],
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
        assert_eq!(paper.title, "Agentic Literature Review: Planning and Synthesis");
        assert_eq!(paper.summary, "A system design for grounded review work.");
        assert_eq!(paper.authors, vec!["Maya Rivera", "Li Chen"]);
        assert_eq!(paper.year, Some(2026));
        assert_eq!(paper.published.as_deref(), Some("2026-02-03"));
        assert_eq!(paper.doi.as_deref(), Some("10.48550/arxiv.2602.01491"));
        assert_eq!(paper.pdf_url.as_deref(), Some("http://arxiv.org/pdf/2602.01491v2"));
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
        assert_eq!(paper.pdf_url.as_deref(), Some("https://dl.acm.org/example.pdf"));
        assert_eq!(paper.cited_by, Some(12));
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
        assert_eq!(paper.pdf_url.as_deref(), Some("https://arxiv.org/pdf/2602.01491.pdf"));
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
        incoming["doi"] = Value::from("10.1234/abc");
        incoming["citedBy"] = Value::from(7);
        let stats = library_upsert_at(&base, &[incoming], None).expect("upsert should work");
        assert_eq!(stats.added, 0);
        assert_eq!(stats.merged, 1);
        assert_eq!(stats.total, 1);

        let saved = library_load_at(&base).expect("library loads");
        let paper = &saved["papers"][0];
        assert_eq!(paper["stage"], "shortlist");
        assert_eq!(paper["starred"], true);
        assert_eq!(paper["tags"], json!(["keeper"]));
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
