//! Literature library backend.
//!
//! Persistence: one `papers/library.json` per project, written atomically —
//! the same folder the `/arxiv` skill downloads PDFs into, so the desktop UI
//! and CLI agents share a single library.
//!
//! Search: arXiv Atom API + Crossref REST, normalised into one record shape
//! and deduplicated by DOI / arXiv id / title.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::projects::{self, ProjectState};

const PAPERS_DIR: &str = "papers";
const LIBRARY_FILE: &str = "library.json";
const HTTP_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_PDF_BYTES: u64 = 80 * 1024 * 1024;
const USER_AGENT: &str = concat!(
    "aris-studio/",
    env!("CARGO_PKG_VERSION"),
    " (literature library; +https://github.com/zhuyingqin/Aris)"
);

const ATOM_NS: &str = "http://www.w3.org/2005/Atom";
const ARXIV_NS: &str = "http://arxiv.org/schemas/atom";

fn papers_dir(projects_state: &ProjectState) -> Result<PathBuf, String> {
    Ok(projects::current_project_path(projects_state)?.join(PAPERS_DIR))
}

// ── Persistence ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn literature_load(projects_state: State<ProjectState>) -> Result<Value, String> {
    let path = papers_dir(&projects_state)?.join(LIBRARY_FILE);
    if !path.exists() {
        return Ok(json!({ "version": 1, "papers": [], "searches": [], "collections": [] }));
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("library.json is not valid JSON: {e}"))
}

#[tauri::command]
pub fn literature_save(projects_state: State<ProjectState>, library: Value) -> Result<(), String> {
    if !library.is_object() {
        return Err("library must be a JSON object".to_string());
    }
    let dir = papers_dir(&projects_state)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(LIBRARY_FILE);
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(&library).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
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

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn literature_search(
    query: String,
    sources: Vec<String>,
    max_results: Option<usize>,
) -> Result<Value, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("search query is empty".to_string());
    }
    let limit = max_results.unwrap_or(20).clamp(1, 50);
    let wants = |name: &str| {
        sources.is_empty() || sources.iter().any(|source| source.eq_ignore_ascii_case(name))
    };
    let client = http_client()?;

    let arxiv = async {
        if wants("arxiv") {
            Some(search_arxiv(&client, &query, limit).await)
        } else {
            None
        }
    };
    let crossref = async {
        if wants("crossref") {
            Some(search_crossref(&client, &query, limit).await)
        } else {
            None
        }
    };
    let (arxiv_outcome, crossref_outcome) = tokio::join!(arxiv, crossref);

    let mut papers = Vec::new();
    let mut warnings = Vec::new();
    for (name, outcome) in [("arXiv", arxiv_outcome), ("Crossref", crossref_outcome)] {
        match outcome {
            Some(Ok(batch)) => papers.extend(batch),
            Some(Err(error)) => warnings.push(format!("{name}: {error}")),
            None => {}
        }
    }
    if papers.is_empty() && !warnings.is_empty() {
        return Err(warnings.join("; "));
    }
    Ok(json!({ "papers": dedupe(papers), "warnings": warnings }))
}

async fn search_arxiv(
    client: &reqwest::Client,
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
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
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

async fn search_crossref(
    client: &reqwest::Client,
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
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
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

#[tauri::command]
pub async fn literature_download_pdf(
    projects_state: State<'_, ProjectState>,
    url: String,
    file_name: String,
) -> Result<Value, String> {
    let dir = papers_dir(&projects_state)?;
    let safe_name = sanitize_file_name(&file_name)?;
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("PDF URL must be http(s)".to_string());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let client = http_client()?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if let Some(length) = response.content_length() {
        if length > MAX_PDF_BYTES {
            return Err(format!("PDF is too large ({length} bytes)"));
        }
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
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
    Ok(json!({
        "path": path.to_string_lossy(),
        "relativePath": format!("{PAPERS_DIR}/{safe_name}"),
        "bytes": bytes.len(),
    }))
}

fn sanitize_file_name(name: &str) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let item = serde_json::json!({
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
