//! Rebuildable, page-grounded literature retrieval without embeddings.
//!
//! The source PDF remains authoritative. This module stores two derived SQLite
//! projections under `papers/rag/`:
//! - exact page text for local FTS5 recall;
//! - LLM-generated retrieval cards that translate concepts, aliases, likely
//!   questions, and bilingual terminology into searchable text.
//!
//! Retrieval cards are routing hints, never evidence. Every returned candidate
//! resolves back to an unchanged source chunk with a stable paper/page anchor.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Increment when a chunking change should invalidate derived retrieval data.
pub const PDF_CHUNKER_VERSION: &str = "pdf-page-v2-no-embedding";
pub const DEFAULT_PDF_CHUNK_CHARS: usize = 2_400;
pub const DEFAULT_PDF_CHUNK_OVERLAP_CHARS: usize = 320;

const RAG_DIR: &str = "rag";
const LITERATURE_FTS_FILE: &str = "literature-retrieval.sqlite";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfPageText {
    /// One-based page number in the source PDF.
    pub page: i64,
    pub text: String,
    /// `embedded`, `ocr`, or `empty` as reported by the parser.
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteraturePdfChunk {
    pub chunk_id: String,
    pub paper_id: String,
    pub relative_path: String,
    pub page_start: i64,
    pub page_end: i64,
    pub page_source: String,
    pub ordinal_on_page: i64,
    pub text: String,
    pub content_hash: String,
    pub chunker_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureTextHit {
    pub chunk: LiteraturePdfChunk,
    pub rank: usize,
}

/// Local figure/table asset extracted by LiteParse. Only metadata and a
/// project-relative path are stored in SQLite; the source bytes remain under
/// `papers/rag/assets/` and never enter an embedding store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureAssetInput {
    pub asset_id: String,
    pub paper_id: String,
    pub relative_path: String,
    pub page: i64,
    pub asset_type: String,
    pub mime_type: String,
    pub caption: String,
    pub content_hash: String,
    pub parser_engine: String,
}

/// One offline LLM-generated bridge from a concept-level question to exact
/// source text. The source hash prevents stale cards from surviving PDF edits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalCardInput {
    pub chunk_id: String,
    pub source_content_hash: String,
    #[serde(default)]
    pub questions: Vec<String>,
    #[serde(default)]
    pub concepts: Vec<String>,
    #[serde(default)]
    pub section_headings: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub methods: Vec<String>,
    #[serde(default)]
    pub datasets: Vec<String>,
    #[serde(default)]
    pub metrics: Vec<String>,
    #[serde(default)]
    pub limitations: Vec<String>,
    #[serde(default)]
    pub language_terms: Vec<String>,
    #[serde(default)]
    pub generated_by: String,
    #[serde(default = "default_prompt_version")]
    pub prompt_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalCardStats {
    pub written: usize,
    pub unchanged: usize,
    pub index_path: String,
}

/// Read-only inventory for exposing the rebuildable local retrieval database in
/// the Desktop UI. Counts and previews never become answer evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureRagDatabaseStatus {
    pub exists: bool,
    pub index_path: String,
    pub relative_index_path: String,
    pub database_bytes: u64,
    pub document_count: usize,
    pub chunk_count: usize,
    pub current_card_count: usize,
    pub stale_card_count: usize,
    pub pending_card_count: usize,
    pub asset_count: usize,
    pub citation_mention_count: usize,
    pub metadata_document_count: usize,
    pub card_previews: Vec<RetrievalCardPreview>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalCardPreview {
    pub chunk_id: String,
    pub paper_id: String,
    pub relative_path: String,
    pub page_start: i64,
    pub page_end: i64,
    pub updated_at: String,
    pub source_preview: String,
    pub card: RetrievalCardInput,
}

/// One page of generated retrieval cards for the Desktop card browser. A
/// read-only projection that supports a text filter over the card's structured
/// terms and bound source text plus offset pagination, so the user can reach
/// every card instead of only the most recent ones shown in the status
/// inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureRetrievalCardPage {
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub query: String,
    pub cards: Vec<RetrievalCardPreview>,
}

/// Structured output of the fast query-planning LLM. Bounds are enforced by
/// `queries()` so a bad model response cannot fan out into an unbounded search.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalQueryPlan {
    #[serde(default)]
    pub original_query: String,
    #[serde(default)]
    pub exact_terms: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub subqueries: Vec<String>,
    #[serde(default)]
    pub entities: Vec<String>,
    #[serde(default)]
    pub answer_type: Option<String>,
}

impl RetrievalQueryPlan {
    #[must_use]
    pub fn from_query(query: &str) -> Self {
        Self {
            original_query: query.trim().to_string(),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn queries(&self) -> Vec<String> {
        const MAX_QUERIES: usize = 8;
        let mut seen = BTreeSet::new();
        std::iter::once(self.original_query.as_str())
            .chain(self.exact_terms.iter().take(2).map(String::as_str))
            .chain(self.aliases.iter().take(2).map(String::as_str))
            .chain(self.subqueries.iter().take(2).map(String::as_str))
            .chain(self.entities.iter().take(1).map(String::as_str))
            .filter_map(|query| {
                let normalized = query.split_whitespace().collect::<Vec<_>>().join(" ");
                (!normalized.is_empty() && seen.insert(normalized.to_lowercase()))
                    .then_some(normalized)
            })
            .take(MAX_QUERIES)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureRagHit {
    pub chunk: LiteraturePdfChunk,
    pub retrieval_score: f64,
    pub source_rank: Option<usize>,
    pub card_rank: Option<usize>,
    pub asset_rank: Option<usize>,
    pub citation_rank: Option<usize>,
    pub metadata_rank: Option<usize>,
    pub matched_queries: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureRagSearchResult {
    pub retrieval: String,
    pub query_plan: RetrievalQueryPlan,
    pub results: Vec<LiteratureRagHit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureIndexStats {
    pub indexed_chunks: usize,
    pub skipped_as_current: bool,
    pub document_content_hash: String,
}

fn default_prompt_version() -> u32 {
    1
}

/// Inspect the local SQLite/FTS projection without creating it when it does not
/// yet exist. Card payloads are shown for auditability, while source previews
/// make their page/chunk binding visible to the user.
pub fn literature_rag_database_status_at(
    base: &Path,
    preview_limit: usize,
) -> Result<LiteratureRagDatabaseStatus, String> {
    let path = literature_fts_path(base);
    let relative_index_path = Path::new(crate::layout::PROJECT_DATA_DIR)
        .join(crate::layout::PAPERS_DIR)
        .join(RAG_DIR)
        .join(LITERATURE_FTS_FILE)
        .to_string_lossy()
        .replace('\\', "/");
    if !path.exists() {
        return Ok(LiteratureRagDatabaseStatus {
            exists: false,
            index_path: path.to_string_lossy().into_owned(),
            relative_index_path,
            database_bytes: 0,
            document_count: 0,
            chunk_count: 0,
            current_card_count: 0,
            stale_card_count: 0,
            pending_card_count: 0,
            asset_count: 0,
            citation_mention_count: 0,
            metadata_document_count: 0,
            card_previews: Vec::new(),
        });
    }

    let _guard = literature_text_index_lock()
        .lock()
        .map_err(|_| "local literature retrieval lock is poisoned".to_string())?;
    let connection = open_literature_fts(base)?;
    let count = |sql: &str| -> Result<usize, String> {
        let value = connection
            .query_row(sql, [], |row| row.get::<_, i64>(0))
            .map_err(|error| error.to_string())?;
        usize::try_from(value).map_err(|_| format!("invalid negative database count for {sql}"))
    };
    let document_count = count("SELECT COUNT(*) FROM literature_pdf_documents")?;
    let chunk_count = count("SELECT COUNT(*) FROM literature_pdf_text_chunks")?;
    let total_card_count = count("SELECT COUNT(*) FROM literature_retrieval_cards")?;
    let current_card_count = count(
        "SELECT COUNT(*)
         FROM literature_retrieval_cards c
         JOIN literature_pdf_text_chunks t
           ON t.chunk_id=c.chunk_id AND t.content_hash=c.source_content_hash",
    )?;
    let pending_card_count = count(
        "SELECT COUNT(*)
         FROM literature_pdf_text_chunks t
         LEFT JOIN literature_retrieval_cards c
           ON c.chunk_id=t.chunk_id AND c.source_content_hash=t.content_hash
         WHERE c.chunk_id IS NULL",
    )?;
    let asset_count = count("SELECT COUNT(*) FROM literature_pdf_assets")?;
    let citation_mention_count = count("SELECT COUNT(*) FROM literature_citation_mentions")?;
    let metadata_document_count = count("SELECT COUNT(*) FROM literature_document_metadata")?;

    let mut statement = connection
        .prepare(
            "SELECT c.chunk_id,c.paper_id,c.relative_path,c.page_start,c.page_end,
                    c.updated_at,c.payload,t.text
             FROM literature_retrieval_cards c
             JOIN literature_pdf_text_chunks t
               ON t.chunk_id=c.chunk_id AND t.content_hash=c.source_content_hash
             ORDER BY CAST(c.updated_at AS INTEGER) DESC,c.paper_id,c.page_start
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let card_previews = statement
        .query_map([preview_limit.clamp(1, 200)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .map(|row| {
            let (
                chunk_id,
                paper_id,
                relative_path,
                page_start,
                page_end,
                updated_at,
                payload,
                text,
            ) = row.map_err(|error| error.to_string())?;
            let card = serde_json::from_str::<RetrievalCardInput>(&payload)
                .map_err(|error| format!("invalid retrieval card `{chunk_id}`: {error}"))?;
            Ok(RetrievalCardPreview {
                chunk_id,
                paper_id,
                relative_path,
                page_start,
                page_end,
                updated_at,
                source_preview: text.chars().take(360).collect(),
                card,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(LiteratureRagDatabaseStatus {
        exists: true,
        index_path: path.to_string_lossy().into_owned(),
        relative_index_path,
        database_bytes: fs::metadata(&path)
            .map(|value| value.len())
            .unwrap_or_default(),
        document_count,
        chunk_count,
        current_card_count,
        stale_card_count: total_card_count.saturating_sub(current_card_count),
        pending_card_count,
        asset_count,
        citation_mention_count,
        metadata_document_count,
        card_previews,
    })
}

/// Browse generated retrieval cards with an optional text filter and offset
/// pagination. Read-only and never creates the database. The filter matches the
/// card payload (all structured terms) and the bound source text, so a user can
/// locate any card by concept, method, dataset, metric, alias, or wording; an
/// optional `paper_id` narrows the browse to a single document.
pub fn literature_rag_cards_page_at(
    base: &Path,
    query: &str,
    paper_id: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<LiteratureRetrievalCardPage, String> {
    let trimmed = query.trim();
    let limit = limit.clamp(1, 100);
    let paper_filter = paper_id.map(str::trim).filter(|value| !value.is_empty());
    let path = literature_fts_path(base);
    if !path.exists() {
        return Ok(LiteratureRetrievalCardPage {
            total: 0,
            offset: 0,
            limit,
            query: trimmed.to_string(),
            cards: Vec::new(),
        });
    }

    let _guard = literature_text_index_lock()
        .lock()
        .map_err(|_| "local literature retrieval lock is poisoned".to_string())?;
    let connection = open_literature_fts(base)?;

    // Escape LIKE wildcards so user input is matched literally with ESCAPE '\'.
    let like = format!(
        "%{}%",
        trimmed
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let paper_bind = paper_filter.unwrap_or_default();

    let total = connection
        .query_row(
            "SELECT COUNT(*)
             FROM literature_retrieval_cards c
             JOIN literature_pdf_text_chunks t
               ON t.chunk_id=c.chunk_id AND t.content_hash=c.source_content_hash
             WHERE (?1='' OR c.paper_id=?1)
               AND (?2='' OR c.payload LIKE ?3 ESCAPE '\\' OR t.text LIKE ?3 ESCAPE '\\')",
            params![paper_bind, trimmed, like],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let total = usize::try_from(total).unwrap_or(0);

    let mut statement = connection
        .prepare(
            "SELECT c.chunk_id,c.paper_id,c.relative_path,c.page_start,c.page_end,
                    c.updated_at,c.payload,t.text
             FROM literature_retrieval_cards c
             JOIN literature_pdf_text_chunks t
               ON t.chunk_id=c.chunk_id AND t.content_hash=c.source_content_hash
             WHERE (?1='' OR c.paper_id=?1)
               AND (?2='' OR c.payload LIKE ?3 ESCAPE '\\' OR t.text LIKE ?3 ESCAPE '\\')
             ORDER BY CAST(c.updated_at AS INTEGER) DESC,c.paper_id,c.page_start
             LIMIT ?4 OFFSET ?5",
        )
        .map_err(|error| error.to_string())?;
    let cards = statement
        .query_map(
            params![paper_bind, trimmed, like, limit as i64, offset as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?
        .map(|row| {
            let (
                chunk_id,
                paper_id,
                relative_path,
                page_start,
                page_end,
                updated_at,
                payload,
                text,
            ) = row.map_err(|error| error.to_string())?;
            let card = serde_json::from_str::<RetrievalCardInput>(&payload)
                .map_err(|error| format!("invalid retrieval card `{chunk_id}`: {error}"))?;
            Ok(RetrievalCardPreview {
                chunk_id,
                paper_id,
                relative_path,
                page_start,
                page_end,
                updated_at,
                source_preview: text.chars().take(360).collect(),
                card,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(LiteratureRetrievalCardPage {
        total,
        offset,
        limit,
        query: trimmed.to_string(),
        cards,
    })
}

fn literature_text_index_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Replace one PDF's page chunks in the authoritative lexical projection.
/// Cards for a changed document are invalidated in the same transaction.
pub fn index_literature_document_text_at(
    base: &Path,
    chunks: &[LiteraturePdfChunk],
    document_content_hash: &str,
) -> Result<LiteratureIndexStats, String> {
    let first = validate_document_chunks(chunks, document_content_hash)?;
    let _guard = literature_text_index_lock()
        .lock()
        .map_err(|_| "local literature retrieval lock is poisoned".to_string())?;
    let mut connection = open_literature_fts(base)?;
    let current = connection
        .query_row(
            "SELECT document_content_hash, chunker_version, chunk_count
             FROM literature_pdf_documents
             WHERE paper_id=?1 AND relative_path=?2",
            params![first.paper_id, first.relative_path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if current.as_ref().is_some_and(|(hash, version, count)| {
        hash == document_content_hash
            && version == PDF_CHUNKER_VERSION
            && *count == chunks.len() as i64
    }) {
        return Ok(LiteratureIndexStats {
            indexed_chunks: 0,
            skipped_as_current: true,
            document_content_hash: document_content_hash.to_string(),
        });
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("could not start literature retrieval update: {error}"))?;
    delete_document_projection(&transaction, &first.paper_id, &first.relative_path)?;
    for chunk in chunks {
        transaction
            .execute(
                "INSERT INTO literature_pdf_text_chunks(
                   chunk_id, paper_id, relative_path, page_start, page_end,
                   page_source, ordinal_on_page, text, content_hash, chunker_version
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![
                    chunk.chunk_id,
                    chunk.paper_id,
                    chunk.relative_path,
                    chunk.page_start,
                    chunk.page_end,
                    chunk.page_source,
                    chunk.ordinal_on_page,
                    chunk.text,
                    chunk.content_hash,
                    chunk.chunker_version,
                ],
            )
            .map_err(|error| format!("could not store PDF page chunk: {error}"))?;
        transaction
            .execute(
                "INSERT INTO literature_pdf_fts(chunk_id, paper_id, relative_path, text)
                 VALUES (?1,?2,?3,?4)",
                params![
                    chunk.chunk_id,
                    chunk.paper_id,
                    chunk.relative_path,
                    chunk.text,
                ],
            )
            .map_err(|error| format!("could not index PDF page text: {error}"))?;
        for citation_text in extract_citation_mentions(&chunk.text) {
            let mention_id =
                sha256_hex(format!("{}\0{}", chunk.chunk_id, citation_text).as_bytes());
            let target_key = normalize_citation_target(&citation_text);
            transaction
                .execute(
                    "INSERT INTO literature_citation_mentions(
                       mention_id,chunk_id,paper_id,relative_path,page,citation_text,target_key
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![
                        mention_id,
                        chunk.chunk_id,
                        chunk.paper_id,
                        chunk.relative_path,
                        chunk.page_start,
                        citation_text,
                        target_key,
                    ],
                )
                .map_err(|error| format!("could not store citation mention: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO literature_citation_fts(
                       mention_id,chunk_id,paper_id,text
                     ) VALUES (?1,?2,?3,?4)",
                    params![mention_id, chunk.chunk_id, chunk.paper_id, citation_text],
                )
                .map_err(|error| format!("could not index citation mention: {error}"))?;
        }
    }
    transaction
        .execute(
            "INSERT INTO literature_pdf_documents(
               paper_id, relative_path, document_content_hash, chunker_version, chunk_count
             ) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(paper_id, relative_path) DO UPDATE SET
               document_content_hash=excluded.document_content_hash,
               chunker_version=excluded.chunker_version,
               chunk_count=excluded.chunk_count",
            params![
                first.paper_id,
                first.relative_path,
                document_content_hash,
                PDF_CHUNKER_VERSION,
                chunks.len() as i64,
            ],
        )
        .map_err(|error| format!("could not update PDF text-index state: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("could not commit literature retrieval update: {error}"))?;

    Ok(LiteratureIndexStats {
        indexed_chunks: chunks.len(),
        skipped_as_current: false,
        document_content_hash: document_content_hash.to_string(),
    })
}

/// Replace the extracted visual-asset manifest for one paper. The asset bytes
/// stay in the project evidence directory; captions and provenance are FTS5
/// searchable and can route retrieval back to the containing source page.
pub fn replace_literature_assets_at(
    base: &Path,
    paper_id: &str,
    assets: &[LiteratureAssetInput],
) -> Result<(), String> {
    let paper_id = paper_id.trim();
    if paper_id.is_empty() {
        return Err("cannot index assets without a paper id".to_string());
    }
    if assets.iter().any(|asset| asset.paper_id != paper_id) {
        return Err("an asset update may contain only one paper".to_string());
    }
    let _guard = literature_text_index_lock()
        .lock()
        .map_err(|_| "local literature retrieval lock is poisoned".to_string())?;
    let mut connection = open_literature_fts(base)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("could not start literature asset update: {error}"))?;
    transaction
        .execute(
            "DELETE FROM literature_asset_fts WHERE paper_id=?1",
            [paper_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM literature_pdf_assets WHERE paper_id=?1",
            [paper_id],
        )
        .map_err(|error| error.to_string())?;
    let mut ids = BTreeSet::new();
    for asset in assets {
        if !ids.insert(asset.asset_id.as_str()) {
            return Err(format!(
                "duplicate literature asset id `{}`",
                asset.asset_id
            ));
        }
        transaction
            .execute(
                "INSERT INTO literature_pdf_assets(
                   asset_id,paper_id,relative_path,page,asset_type,mime_type,
                   caption,content_hash,parser_engine
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    asset.asset_id,
                    asset.paper_id,
                    asset.relative_path,
                    asset.page,
                    asset.asset_type,
                    asset.mime_type,
                    asset.caption,
                    asset.content_hash,
                    asset.parser_engine,
                ],
            )
            .map_err(|error| format!("could not store literature asset: {error}"))?;
        transaction
            .execute(
                "INSERT INTO literature_asset_fts(asset_id,paper_id,caption)
                 VALUES (?1,?2,?3)",
                params![asset.asset_id, asset.paper_id, asset.caption],
            )
            .map_err(|error| format!("could not index literature asset caption: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("could not commit literature asset update: {error}"))
}

/// Refresh the FTS projection of canonical title/authors/venue/identifiers for
/// one PDF. The text is derived from the canonical literature record and is a
/// routing signal, never a replacement for page evidence.
pub fn replace_literature_document_metadata_at(
    base: &Path,
    paper_id: &str,
    relative_path: &str,
    metadata_text: &str,
) -> Result<(), String> {
    let paper_id = paper_id.trim();
    if paper_id.is_empty() {
        return Err("cannot index metadata without a paper id".to_string());
    }
    let _guard = literature_text_index_lock()
        .lock()
        .map_err(|_| "local literature retrieval lock is poisoned".to_string())?;
    let mut connection = open_literature_fts(base)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("could not start literature metadata update: {error}"))?;
    transaction
        .execute(
            "DELETE FROM literature_metadata_fts WHERE paper_id=?1",
            [paper_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO literature_document_metadata(
               paper_id,relative_path,metadata_text,updated_at
             ) VALUES (?1,?2,?3,?4)
             ON CONFLICT(paper_id) DO UPDATE SET
               relative_path=excluded.relative_path,
               metadata_text=excluded.metadata_text,
               updated_at=excluded.updated_at",
            params![paper_id, relative_path, metadata_text, unix_timestamp()],
        )
        .map_err(|error| format!("could not store literature metadata: {error}"))?;
    if !metadata_text.trim().is_empty() {
        transaction
            .execute(
                "INSERT INTO literature_metadata_fts(paper_id,text) VALUES (?1,?2)",
                params![paper_id, metadata_text],
            )
            .map_err(|error| format!("could not index literature metadata: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("could not commit literature metadata update: {error}"))
}

/// Chunks that do not yet have a current retrieval card. The bounded output is
/// suitable for background LLM batches after a PDF has been indexed.
pub fn pending_retrieval_card_chunks_at(
    base: &Path,
    paper_id: Option<&str>,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let _guard = literature_text_index_lock()
        .lock()
        .map_err(|_| "local literature retrieval lock is poisoned".to_string())?;
    let connection = open_literature_fts(base)?;
    let bounded_limit = limit.clamp(1, 200);
    let sql = if paper_id.is_some() {
        "SELECT t.chunk_id,t.paper_id,t.relative_path,t.page_start,t.page_end,
                t.page_source,t.ordinal_on_page,t.text,t.content_hash,t.chunker_version
         FROM literature_pdf_text_chunks t
         LEFT JOIN literature_retrieval_cards c
           ON c.chunk_id=t.chunk_id AND c.source_content_hash=t.content_hash
         WHERE c.chunk_id IS NULL AND t.paper_id=?1
         ORDER BY t.paper_id,t.page_start,t.ordinal_on_page LIMIT ?2"
    } else {
        "SELECT t.chunk_id,t.paper_id,t.relative_path,t.page_start,t.page_end,
                t.page_source,t.ordinal_on_page,t.text,t.content_hash,t.chunker_version
         FROM literature_pdf_text_chunks t
         LEFT JOIN literature_retrieval_cards c
           ON c.chunk_id=t.chunk_id AND c.source_content_hash=t.content_hash
         WHERE c.chunk_id IS NULL
         ORDER BY t.paper_id,t.page_start,t.ordinal_on_page LIMIT ?1"
    };
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let chunks = if let Some(paper_id) = paper_id {
        statement
            .query_map(params![paper_id, bounded_limit], literature_chunk_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    } else {
        statement
            .query_map(params![bounded_limit], literature_chunk_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    Ok(chunks)
}

/// Store LLM retrieval cards after verifying that every card still describes
/// the exact current source chunk. Generated text is never returned as proof.
pub fn upsert_retrieval_cards_at(
    base: &Path,
    cards: &[RetrievalCardInput],
) -> Result<RetrievalCardStats, String> {
    if cards.is_empty() {
        return Ok(RetrievalCardStats {
            written: 0,
            unchanged: 0,
            index_path: literature_fts_path(base).to_string_lossy().into_owned(),
        });
    }
    let _guard = literature_text_index_lock()
        .lock()
        .map_err(|_| "local literature retrieval lock is poisoned".to_string())?;
    let mut connection = open_literature_fts(base)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("could not start retrieval-card update: {error}"))?;
    let mut written = 0;
    let mut unchanged = 0;
    let mut seen = BTreeSet::new();
    for card in cards {
        if !seen.insert(card.chunk_id.clone()) {
            return Err(format!("duplicate retrieval card for `{}`", card.chunk_id));
        }
        let chunk = load_chunk(&transaction, &card.chunk_id)?
            .ok_or_else(|| format!("retrieval card refers to unknown chunk `{}`", card.chunk_id))?;
        if chunk.content_hash != card.source_content_hash {
            return Err(format!(
                "retrieval card for `{}` was generated from stale source text",
                card.chunk_id
            ));
        }
        let generated_text = retrieval_card_text(card);
        if generated_text.trim().is_empty() {
            return Err(format!("retrieval card for `{}` is empty", card.chunk_id));
        }
        let payload = serde_json::to_string(card).map_err(|error| error.to_string())?;
        let card_id = stable_card_id(&card.chunk_id);
        let current = transaction
            .query_row(
                "SELECT source_content_hash,payload FROM literature_retrieval_cards
                 WHERE chunk_id=?1",
                [&card.chunk_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if current
            .as_ref()
            .is_some_and(|(hash, stored)| hash == &card.source_content_hash && stored == &payload)
        {
            unchanged += 1;
            continue;
        }
        transaction
            .execute(
                "DELETE FROM literature_retrieval_card_fts WHERE chunk_id=?1",
                [&card.chunk_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO literature_retrieval_cards(
                   card_id,chunk_id,paper_id,relative_path,page_start,page_end,
                   source_content_hash,payload,generated_text,generator_model,
                   prompt_version,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                 ON CONFLICT(chunk_id) DO UPDATE SET
                   card_id=excluded.card_id,paper_id=excluded.paper_id,
                   relative_path=excluded.relative_path,page_start=excluded.page_start,
                   page_end=excluded.page_end,source_content_hash=excluded.source_content_hash,
                   payload=excluded.payload,generated_text=excluded.generated_text,
                   generator_model=excluded.generator_model,
                   prompt_version=excluded.prompt_version,updated_at=excluded.updated_at",
                params![
                    card_id,
                    card.chunk_id,
                    chunk.paper_id,
                    chunk.relative_path,
                    chunk.page_start,
                    chunk.page_end,
                    card.source_content_hash,
                    payload,
                    generated_text,
                    card.generated_by,
                    card.prompt_version,
                    unix_timestamp(),
                ],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO literature_retrieval_card_fts(
                   card_id,chunk_id,paper_id,relative_path,text
                 ) VALUES (?1,?2,?3,?4,?5)",
                params![
                    card_id,
                    card.chunk_id,
                    chunk.paper_id,
                    chunk.relative_path,
                    generated_text,
                ],
            )
            .map_err(|error| error.to_string())?;
        written += 1;
    }
    transaction
        .commit()
        .map_err(|error| format!("could not commit retrieval cards: {error}"))?;
    Ok(RetrievalCardStats {
        written,
        unchanged,
        index_path: literature_fts_path(base).to_string_lossy().into_owned(),
    })
}

/// Baseline local source search used by exact-term fast paths.
pub fn full_text_search_literature_at(
    base: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<LiteratureTextHit>, String> {
    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let _guard = literature_text_index_lock()
        .lock()
        .map_err(|_| "local literature retrieval lock is poisoned".to_string())?;
    let connection = open_literature_fts(base)?;
    let chunks = search_source_query(&connection, query, limit.clamp(1, 200))?;
    Ok(chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| LiteratureTextHit {
            chunk,
            rank: index + 1,
        })
        .collect())
}

/// Multi-query, non-vector retrieval across exact source text and generated
/// retrieval cards. Reciprocal-rank fusion avoids comparing incomparable FTS
/// raw scores and rewards candidates supported by multiple query rewrites.
pub fn search_literature_with_plan_at(
    base: &Path,
    plan: &RetrievalQueryPlan,
    limit: usize,
) -> Result<LiteratureRagSearchResult, String> {
    let queries = plan.queries();
    if queries.is_empty() {
        return Err("literature retrieval query plan is empty".to_string());
    }
    let _guard = literature_text_index_lock()
        .lock()
        .map_err(|_| "local literature retrieval lock is poisoned".to_string())?;
    let connection = open_literature_fts(base)?;
    let bounded_limit = limit.clamp(1, 50);
    let recall = bounded_limit.saturating_mul(4).max(12);
    let mut candidates = BTreeMap::<String, Candidate>::new();
    for (query_index, query) in queries.iter().enumerate() {
        let query_weight = if query_index == 0 { 1.2 } else { 1.0 };
        for (index, chunk) in search_source_query(&connection, query, recall)?
            .into_iter()
            .enumerate()
        {
            let rank = index + 1;
            let candidate = candidates.entry(chunk.chunk_id.clone()).or_default();
            candidate.chunk = Some(chunk);
            candidate.source_rank = Some(candidate.source_rank.map_or(rank, |old| old.min(rank)));
            candidate.score += query_weight * reciprocal_rank(rank);
            candidate.matched_queries.insert(query.clone());
        }
        for (index, chunk) in search_card_query(&connection, query, recall)?
            .into_iter()
            .enumerate()
        {
            let rank = index + 1;
            let candidate = candidates.entry(chunk.chunk_id.clone()).or_default();
            candidate.chunk = Some(chunk);
            candidate.card_rank = Some(candidate.card_rank.map_or(rank, |old| old.min(rank)));
            candidate.score += 0.85 * query_weight * reciprocal_rank(rank);
            candidate.matched_queries.insert(query.clone());
        }
        for (index, chunk) in search_asset_query(&connection, query, recall)?
            .into_iter()
            .enumerate()
        {
            let rank = index + 1;
            let candidate = candidates.entry(chunk.chunk_id.clone()).or_default();
            candidate.chunk = Some(chunk);
            candidate.asset_rank = Some(candidate.asset_rank.map_or(rank, |old| old.min(rank)));
            candidate.score += 0.65 * query_weight * reciprocal_rank(rank);
            candidate.matched_queries.insert(query.clone());
        }
        for (index, chunk) in search_citation_query(&connection, query, recall)?
            .into_iter()
            .enumerate()
        {
            let rank = index + 1;
            let candidate = candidates.entry(chunk.chunk_id.clone()).or_default();
            candidate.chunk = Some(chunk);
            candidate.citation_rank =
                Some(candidate.citation_rank.map_or(rank, |old| old.min(rank)));
            candidate.score += 0.7 * query_weight * reciprocal_rank(rank);
            candidate.matched_queries.insert(query.clone());
        }
        for (index, chunk) in search_metadata_query(&connection, query, recall)?
            .into_iter()
            .enumerate()
        {
            let rank = index + 1;
            let candidate = candidates.entry(chunk.chunk_id.clone()).or_default();
            candidate.chunk = Some(chunk);
            candidate.metadata_rank =
                Some(candidate.metadata_rank.map_or(rank, |old| old.min(rank)));
            candidate.score += 0.6 * query_weight * reciprocal_rank(rank);
            candidate.matched_queries.insert(query.clone());
        }
    }
    let mut candidates = candidates.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right.score.total_cmp(&left.score).then_with(|| {
            left.chunk
                .as_ref()
                .map(|chunk| chunk.chunk_id.as_str())
                .cmp(&right.chunk.as_ref().map(|chunk| chunk.chunk_id.as_str()))
        })
    });

    // Prevent one long document from crowding every other source out before
    // the LLM reranker can compare evidence across papers.
    let mut per_paper = BTreeMap::<String, usize>::new();
    let mut results = Vec::new();
    for candidate in candidates {
        let Some(chunk) = candidate.chunk else {
            continue;
        };
        let count = per_paper.entry(chunk.paper_id.clone()).or_default();
        if *count >= 3 && results.len() < bounded_limit / 2 {
            continue;
        }
        *count += 1;
        results.push(LiteratureRagHit {
            chunk,
            retrieval_score: candidate.score,
            source_rank: candidate.source_rank,
            card_rank: candidate.card_rank,
            asset_rank: candidate.asset_rank,
            citation_rank: candidate.citation_rank,
            metadata_rank: candidate.metadata_rank,
            matched_queries: candidate.matched_queries.into_iter().collect(),
        });
        if results.len() >= bounded_limit {
            break;
        }
    }
    Ok(LiteratureRagSearchResult {
        retrieval: "multi-query reciprocal-rank fusion (source FTS + retrieval-card FTS + metadata FTS + asset-caption FTS + citation FTS)".to_string(),
        query_plan: plan.clone(),
        results,
    })
}

pub fn search_literature_at(
    base: &Path,
    query: &str,
    limit: usize,
) -> Result<LiteratureRagSearchResult, String> {
    search_literature_with_plan_at(base, &RetrievalQueryPlan::from_query(query), limit)
}

/// Remove only rebuildable source/card projections. PDFs and canonical
/// literature records remain untouched.
pub fn reset_literature_text_index_at(base: &Path) -> Result<(), String> {
    let _guard = literature_text_index_lock()
        .lock()
        .map_err(|_| "local literature retrieval lock is poisoned".to_string())?;
    let mut connection = open_literature_fts(base)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("could not start literature retrieval reset: {error}"))?;
    transaction
        .execute_batch(
            "DELETE FROM literature_asset_fts;
             DELETE FROM literature_pdf_assets;
             DELETE FROM literature_citation_fts;
             DELETE FROM literature_citation_mentions;
             DELETE FROM literature_metadata_fts;
             DELETE FROM literature_document_metadata;
             DELETE FROM literature_retrieval_card_fts;
             DELETE FROM literature_retrieval_cards;
             DELETE FROM literature_pdf_fts;
             DELETE FROM literature_pdf_text_chunks;
             DELETE FROM literature_pdf_documents;",
        )
        .map_err(|error| format!("could not reset literature retrieval data: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("could not commit literature retrieval reset: {error}"))
}

#[derive(Default)]
struct Candidate {
    chunk: Option<LiteraturePdfChunk>,
    score: f64,
    source_rank: Option<usize>,
    card_rank: Option<usize>,
    asset_rank: Option<usize>,
    citation_rank: Option<usize>,
    metadata_rank: Option<usize>,
    matched_queries: BTreeSet<String>,
}

fn delete_document_projection(
    transaction: &Transaction<'_>,
    paper_id: &str,
    relative_path: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM literature_citation_fts WHERE paper_id=?1",
            [paper_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM literature_citation_mentions WHERE paper_id=?1",
            [paper_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM literature_retrieval_card_fts
             WHERE paper_id=?1 AND relative_path=?2",
            params![paper_id, relative_path],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM literature_retrieval_cards
             WHERE paper_id=?1 AND relative_path=?2",
            params![paper_id, relative_path],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM literature_pdf_fts WHERE paper_id=?1 AND relative_path=?2",
            params![paper_id, relative_path],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM literature_pdf_text_chunks WHERE paper_id=?1 AND relative_path=?2",
            params![paper_id, relative_path],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn literature_fts_path(base: &Path) -> PathBuf {
    crate::layout::papers_dir_at(base)
        .join(RAG_DIR)
        .join(LITERATURE_FTS_FILE)
}

fn open_literature_fts(base: &Path) -> Result<Connection, String> {
    let path = literature_fts_path(base);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=2000;
             CREATE TABLE IF NOT EXISTS literature_pdf_documents(
               paper_id TEXT NOT NULL,
               relative_path TEXT NOT NULL,
               document_content_hash TEXT NOT NULL,
               chunker_version TEXT NOT NULL,
               chunk_count INTEGER NOT NULL,
               PRIMARY KEY(paper_id,relative_path)
             );
             CREATE TABLE IF NOT EXISTS literature_pdf_text_chunks(
               chunk_id TEXT PRIMARY KEY,
               paper_id TEXT NOT NULL,
               relative_path TEXT NOT NULL,
               page_start INTEGER NOT NULL,
               page_end INTEGER NOT NULL,
               page_source TEXT NOT NULL,
               ordinal_on_page INTEGER NOT NULL,
               text TEXT NOT NULL,
               content_hash TEXT NOT NULL,
               chunker_version TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_lit_chunks_paper_page
               ON literature_pdf_text_chunks(paper_id,page_start,ordinal_on_page);
             CREATE VIRTUAL TABLE IF NOT EXISTS literature_pdf_fts USING fts5(
               chunk_id UNINDEXED,
               paper_id UNINDEXED,
               relative_path UNINDEXED,
               text,
               tokenize='trigram'
             );
             CREATE TABLE IF NOT EXISTS literature_pdf_assets(
               asset_id TEXT PRIMARY KEY,
               paper_id TEXT NOT NULL,
               relative_path TEXT NOT NULL,
               page INTEGER NOT NULL,
               asset_type TEXT NOT NULL,
               mime_type TEXT NOT NULL,
               caption TEXT NOT NULL,
               content_hash TEXT NOT NULL,
               parser_engine TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_lit_assets_paper_page
               ON literature_pdf_assets(paper_id,page);
             CREATE VIRTUAL TABLE IF NOT EXISTS literature_asset_fts USING fts5(
               asset_id UNINDEXED,
               paper_id UNINDEXED,
               caption,
               tokenize='trigram'
             );
             CREATE TABLE IF NOT EXISTS literature_citation_mentions(
               mention_id TEXT PRIMARY KEY,
               chunk_id TEXT NOT NULL,
               paper_id TEXT NOT NULL,
               relative_path TEXT NOT NULL,
               page INTEGER NOT NULL,
               citation_text TEXT NOT NULL,
               target_key TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_lit_citations_paper_page
               ON literature_citation_mentions(paper_id,page);
             CREATE INDEX IF NOT EXISTS idx_lit_citations_target
               ON literature_citation_mentions(target_key);
             CREATE VIRTUAL TABLE IF NOT EXISTS literature_citation_fts USING fts5(
               mention_id UNINDEXED,
               chunk_id UNINDEXED,
               paper_id UNINDEXED,
               text,
               tokenize='trigram'
             );
             CREATE TABLE IF NOT EXISTS literature_document_metadata(
               paper_id TEXT PRIMARY KEY,
               relative_path TEXT NOT NULL,
               metadata_text TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS literature_metadata_fts USING fts5(
               paper_id UNINDEXED,
               text,
               tokenize='trigram'
             );
             CREATE TABLE IF NOT EXISTS literature_retrieval_cards(
               card_id TEXT NOT NULL,
               chunk_id TEXT PRIMARY KEY,
               paper_id TEXT NOT NULL,
               relative_path TEXT NOT NULL,
               page_start INTEGER NOT NULL,
               page_end INTEGER NOT NULL,
               source_content_hash TEXT NOT NULL,
               payload TEXT NOT NULL,
               generated_text TEXT NOT NULL,
               generator_model TEXT,
               prompt_version INTEGER NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_lit_cards_paper_page
               ON literature_retrieval_cards(paper_id,page_start);
             CREATE VIRTUAL TABLE IF NOT EXISTS literature_retrieval_card_fts USING fts5(
               card_id UNINDEXED,
               chunk_id UNINDEXED,
               paper_id UNINDEXED,
               relative_path UNINDEXED,
               text,
               tokenize='trigram'
             );",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn validate_document_chunks<'a>(
    chunks: &'a [LiteraturePdfChunk],
    document_content_hash: &str,
) -> Result<&'a LiteraturePdfChunk, String> {
    let first = chunks
        .first()
        .ok_or_else(|| "cannot index a PDF with no extractable page chunks".to_string())?;
    if document_content_hash.trim().is_empty() {
        return Err("PDF document content hash is empty".to_string());
    }
    let mut ids = BTreeSet::new();
    for chunk in chunks {
        if chunk.paper_id != first.paper_id || chunk.relative_path != first.relative_path {
            return Err("a PDF index update may contain only one document".to_string());
        }
        if chunk.chunker_version != PDF_CHUNKER_VERSION {
            return Err(format!(
                "chunk `{}` uses stale chunker version `{}`",
                chunk.chunk_id, chunk.chunker_version
            ));
        }
        if chunk.content_hash != sha256_hex(chunk.text.as_bytes()) {
            return Err(format!(
                "chunk `{}` has an invalid content hash",
                chunk.chunk_id
            ));
        }
        if !ids.insert(&chunk.chunk_id) {
            return Err(format!("duplicate PDF chunk id `{}`", chunk.chunk_id));
        }
    }
    Ok(first)
}

fn load_chunk(
    connection: &rusqlite::Transaction<'_>,
    chunk_id: &str,
) -> Result<Option<LiteraturePdfChunk>, String> {
    connection
        .query_row(
            "SELECT chunk_id,paper_id,relative_path,page_start,page_end,page_source,
                    ordinal_on_page,text,content_hash,chunker_version
             FROM literature_pdf_text_chunks WHERE chunk_id=?1",
            [chunk_id],
            literature_chunk_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn literature_chunk_from_row(row: &Row<'_>) -> rusqlite::Result<LiteraturePdfChunk> {
    Ok(LiteraturePdfChunk {
        chunk_id: row.get(0)?,
        paper_id: row.get(1)?,
        relative_path: row.get(2)?,
        page_start: row.get(3)?,
        page_end: row.get(4)?,
        page_source: row.get(5)?,
        ordinal_on_page: row.get(6)?,
        text: row.get(7)?,
        content_hash: row.get(8)?,
        chunker_version: row.get(9)?,
    })
}

fn search_source_query(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let mut chunks = match fts_match_query(query, " AND ") {
        Some(expression) => search_source_fts(connection, &expression, limit)?,
        None => Vec::new(),
    };
    if chunks.is_empty() {
        if let Some(expression) = fts_match_query(query, " OR ") {
            chunks = search_source_fts(connection, &expression, limit)?;
        }
    }
    if chunks.is_empty() {
        chunks = search_literature_like(connection, query, limit)?;
    }
    deduplicate_chunks(chunks, limit)
}

fn search_card_query(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let mut chunks = match fts_match_query(query, " AND ") {
        Some(expression) => search_card_fts(connection, &expression, limit)?,
        None => Vec::new(),
    };
    if chunks.is_empty() {
        if let Some(expression) = fts_match_query(query, " OR ") {
            chunks = search_card_fts(connection, &expression, limit)?;
        }
    }
    deduplicate_chunks(chunks, limit)
}

fn search_asset_query(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let mut chunks = match fts_match_query(query, " AND ") {
        Some(expression) => search_asset_fts(connection, &expression, limit)?,
        None => Vec::new(),
    };
    if chunks.is_empty() {
        if let Some(expression) = fts_match_query(query, " OR ") {
            chunks = search_asset_fts(connection, &expression, limit)?;
        }
    }
    deduplicate_chunks(chunks, limit)
}

fn search_asset_fts(
    connection: &Connection,
    match_query: &str,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let matches = {
        let mut statement = connection
            .prepare(
                "SELECT a.paper_id,a.page
                 FROM literature_asset_fts f
                 JOIN literature_pdf_assets a ON a.asset_id=f.asset_id
                 WHERE literature_asset_fts MATCH ?1 ORDER BY rank LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![match_query, limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let mut chunks = Vec::new();
    for (paper_id, page) in matches {
        let mut statement = connection
            .prepare(
                "SELECT chunk_id,paper_id,relative_path,page_start,page_end,page_source,
                        ordinal_on_page,text,content_hash,chunker_version
                 FROM literature_pdf_text_chunks
                 WHERE paper_id=?1 AND page_start=?2
                 ORDER BY ordinal_on_page LIMIT 2",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![paper_id, page], literature_chunk_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        chunks.extend(rows);
    }
    Ok(chunks)
}

fn search_citation_query(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let mut chunks = match fts_match_query(query, " AND ") {
        Some(expression) => search_citation_fts(connection, &expression, limit)?,
        None => Vec::new(),
    };
    if chunks.is_empty() {
        if let Some(expression) = fts_match_query(query, " OR ") {
            chunks = search_citation_fts(connection, &expression, limit)?;
        }
    }
    deduplicate_chunks(chunks, limit)
}

fn search_citation_fts(
    connection: &Connection,
    match_query: &str,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let mut statement = connection
        .prepare(
            "SELECT t.chunk_id,t.paper_id,t.relative_path,t.page_start,t.page_end,
                    t.page_source,t.ordinal_on_page,t.text,t.content_hash,t.chunker_version
             FROM literature_citation_fts f
             JOIN literature_pdf_text_chunks t ON t.chunk_id=f.chunk_id
             WHERE literature_citation_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![match_query, limit], literature_chunk_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn search_metadata_query(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let mut chunks = match fts_match_query(query, " AND ") {
        Some(expression) => search_metadata_fts(connection, &expression, limit)?,
        None => Vec::new(),
    };
    if chunks.is_empty() {
        if let Some(expression) = fts_match_query(query, " OR ") {
            chunks = search_metadata_fts(connection, &expression, limit)?;
        }
    }
    deduplicate_chunks(chunks, limit)
}

fn search_metadata_fts(
    connection: &Connection,
    match_query: &str,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let paper_ids = {
        let mut statement = connection
            .prepare(
                "SELECT paper_id FROM literature_metadata_fts
                 WHERE literature_metadata_fts MATCH ?1 ORDER BY rank LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![match_query, limit], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let mut chunks = Vec::new();
    for paper_id in paper_ids {
        let mut statement = connection
            .prepare(
                "SELECT chunk_id,paper_id,relative_path,page_start,page_end,page_source,
                        ordinal_on_page,text,content_hash,chunker_version
                 FROM literature_pdf_text_chunks WHERE paper_id=?1
                 ORDER BY page_start,ordinal_on_page LIMIT 2",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([paper_id], literature_chunk_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        chunks.extend(rows);
    }
    Ok(chunks)
}

fn search_source_fts(
    connection: &Connection,
    match_query: &str,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let mut statement = connection
        .prepare(
            "SELECT t.chunk_id,t.paper_id,t.relative_path,t.page_start,t.page_end,
                    t.page_source,t.ordinal_on_page,t.text,t.content_hash,t.chunker_version
             FROM literature_pdf_fts f
             JOIN literature_pdf_text_chunks t ON t.chunk_id=f.chunk_id
             WHERE literature_pdf_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![match_query, limit], literature_chunk_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn search_card_fts(
    connection: &Connection,
    match_query: &str,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let mut statement = connection
        .prepare(
            "SELECT t.chunk_id,t.paper_id,t.relative_path,t.page_start,t.page_end,
                    t.page_source,t.ordinal_on_page,t.text,t.content_hash,t.chunker_version
             FROM literature_retrieval_card_fts f
             JOIN literature_pdf_text_chunks t ON t.chunk_id=f.chunk_id
             JOIN literature_retrieval_cards c
               ON c.chunk_id=t.chunk_id AND c.source_content_hash=t.content_hash
             WHERE literature_retrieval_card_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![match_query, limit], literature_chunk_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn search_literature_like(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let mut statement = connection
        .prepare(
            "SELECT chunk_id,paper_id,relative_path,page_start,page_end,page_source,
                    ordinal_on_page,text,content_hash,chunker_version
             FROM literature_pdf_text_chunks
             WHERE text LIKE ?1 ORDER BY paper_id,page_start,ordinal_on_page LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![format!("%{}%", query.trim()), limit],
            literature_chunk_from_row,
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn deduplicate_chunks(
    chunks: Vec<LiteraturePdfChunk>,
    limit: usize,
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let mut seen = BTreeSet::new();
    Ok(chunks
        .into_iter()
        .filter(|chunk| seen.insert(chunk.chunk_id.clone()))
        .take(limit)
        .collect())
}

fn fts_match_query(query: &str, joiner: &str) -> Option<String> {
    let terms = query
        .split_whitespace()
        .map(str::trim)
        .filter(|term| term.chars().count() >= 3)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    (!terms.is_empty()).then(|| terms.join(joiner))
}

fn retrieval_card_text(card: &RetrievalCardInput) -> String {
    [
        ("questions", &card.questions),
        ("concepts", &card.concepts),
        ("section headings", &card.section_headings),
        ("aliases", &card.aliases),
        ("methods", &card.methods),
        ("datasets", &card.datasets),
        ("metrics", &card.metrics),
        ("limitations", &card.limitations),
        ("language terms", &card.language_terms),
    ]
    .into_iter()
    .filter(|(_, values)| !values.is_empty())
    .map(|(label, values)| format!("{label}: {}", values.join("; ")))
    .collect::<Vec<_>>()
    .join("\n")
}

fn stable_card_id(chunk_id: &str) -> String {
    format!("card-{}", &sha256_hex(chunk_id.as_bytes())[..24])
}

fn unix_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn reciprocal_rank(rank: usize) -> f64 {
    1.0 / (60.0 + rank as f64)
}

/// Produce stable, page-bounded chunks. No chunk crosses a page boundary, so
/// every retrieval result has an unambiguous citation anchor.
pub fn chunk_pdf_pages(
    paper_id: &str,
    relative_path: &str,
    pages: &[PdfPageText],
) -> Result<Vec<LiteraturePdfChunk>, String> {
    let paper_id = paper_id.trim();
    let relative_path = relative_path.trim();
    if paper_id.is_empty() {
        return Err("PDF paper id is empty".to_string());
    }
    if relative_path.is_empty() {
        return Err("PDF relative path is empty".to_string());
    }
    let mut seen_pages = BTreeSet::new();
    let mut chunks = Vec::new();
    for page in pages {
        if page.page <= 0 {
            return Err("PDF pages must use one-based positive page numbers".to_string());
        }
        if !seen_pages.insert(page.page) {
            return Err(format!("duplicate extracted PDF page {}", page.page));
        }
        let normalized = normalize_page_text(&page.text);
        if normalized.is_empty() {
            continue;
        }
        for (ordinal, text) in split_page_text(
            &normalized,
            DEFAULT_PDF_CHUNK_CHARS,
            DEFAULT_PDF_CHUNK_OVERLAP_CHARS,
        )
        .into_iter()
        .enumerate()
        {
            let identity = format!(
                "{paper_id}\n{relative_path}\n{}\n{ordinal}\n{PDF_CHUNKER_VERSION}\n{text}",
                page.page
            );
            let chunk_id = format!("pdfchunk-{}", &sha256_hex(identity.as_bytes())[..32]);
            chunks.push(LiteraturePdfChunk {
                chunk_id,
                paper_id: paper_id.to_string(),
                relative_path: relative_path.to_string(),
                page_start: page.page,
                page_end: page.page,
                page_source: page.source.trim().to_string(),
                ordinal_on_page: ordinal as i64,
                content_hash: sha256_hex(text.as_bytes()),
                text,
                chunker_version: PDF_CHUNKER_VERSION.to_string(),
            });
        }
    }
    if chunks.is_empty() {
        return Err("PDF contains no extractable text chunks".to_string());
    }
    Ok(chunks)
}

#[must_use]
pub fn pdf_pages_content_hash(pages: &[PdfPageText]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(PDF_CHUNKER_VERSION.as_bytes());
    for page in pages {
        hasher.update(page.page.to_le_bytes());
        hasher.update(page.source.as_bytes());
        hasher.update(normalize_page_text(&page.text).as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn normalize_page_text(raw: &str) -> String {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn split_page_text(text: &str, chunk_chars: usize, overlap_chars: usize) -> Vec<String> {
    let characters = text.chars().collect::<Vec<_>>();
    if characters.len() <= chunk_chars {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < characters.len() {
        let upper = (start + chunk_chars).min(characters.len());
        let end = if upper == characters.len() {
            upper
        } else {
            preferred_break(&characters, start, upper)
        };
        let chunk = characters[start..end]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
        if !chunk.is_empty() {
            chunks.push(chunk);
        }
        if end >= characters.len() {
            break;
        }
        let next = end.saturating_sub(overlap_chars.min(end - start));
        start = next.max(start + 1);
    }
    chunks
}

fn preferred_break(characters: &[char], start: usize, upper: usize) -> usize {
    let lower = start + (upper - start) / 2;
    for index in (lower..upper).rev() {
        if matches!(
            characters[index],
            '\n' | '.' | '!' | '?' | '。' | '！' | '？' | ';' | '；'
        ) {
            return index + 1;
        }
    }
    for index in (lower..upper).rev() {
        if characters[index].is_whitespace() {
            return index + 1;
        }
    }
    upper
}

fn extract_citation_mentions(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| {
            let lower = line.to_lowercase();
            let numbered = line
                .strip_prefix('[')
                .and_then(|rest| rest.split_once(']'))
                .is_some_and(|(number, _)| number.chars().all(|value| value.is_ascii_digit()));
            numbered
                || lower.contains("doi.org/")
                || lower.contains("doi:")
                || lower.contains("arxiv:")
        })
        .filter(|line| line.chars().count() >= 12)
        .map(|line| line.chars().take(600).collect::<String>())
        .take(32)
        .collect()
}

fn normalize_citation_target(citation: &str) -> Option<String> {
    let lower = citation.to_lowercase();
    if let Some(start) = lower.find("10.") {
        let doi = lower[start..]
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_end_matches(|character: char| {
                matches!(character, '.' | ',' | ';' | ':' | ')' | ']' | '}')
            });
        if doi.contains('/') {
            return Some(format!("doi:{doi}"));
        }
    }
    if let Some(start) = lower.find("arxiv:") {
        let arxiv = lower[start + "arxiv:".len()..]
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_end_matches(|character: char| matches!(character, '.' | ',' | ';' | ')'));
        if !arxiv.is_empty() {
            return Some(format!("arxiv:{arxiv}"));
        }
    }
    None
}

fn sha256_hex(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let base = std::env::temp_dir().join(format!("somniq-no-embedding-{name}-{unique}"));
        fs::create_dir_all(&base).expect("create temp base");
        base
    }

    fn sample_chunks() -> (Vec<LiteraturePdfChunk>, String) {
        let pages = vec![
            PdfPageText {
                page: 1,
                text: "Adaptive scheduling improves congestion throughput.".to_string(),
                source: "embedded".to_string(),
            },
            PdfPageText {
                page: 2,
                text: "The evaluation reports lower message cost.".to_string(),
                source: "embedded".to_string(),
            },
        ];
        let hash = pdf_pages_content_hash(&pages);
        let chunks = chunk_pdf_pages("paper-1", "papers/paper-1.pdf", &pages).expect("chunks");
        (chunks, hash)
    }

    #[test]
    fn chunks_are_page_bound_stable_and_citeable() {
        let long = "A method improves throughput. ".repeat(220);
        let pages = vec![
            PdfPageText {
                page: 3,
                text: long,
                source: "ocr".to_string(),
            },
            PdfPageText {
                page: 4,
                text: "A separate page.".to_string(),
                source: "embedded".to_string(),
            },
        ];
        let first = chunk_pdf_pages("paper", "papers/paper.pdf", &pages).expect("first");
        let second = chunk_pdf_pages("paper", "papers/paper.pdf", &pages).expect("second");
        assert_eq!(first, second);
        assert!(first.iter().all(|chunk| chunk.page_start == chunk.page_end));
        assert!(first.iter().any(|chunk| chunk.page_start == 3));
        assert!(first.iter().any(|chunk| chunk.page_start == 4));
    }

    #[test]
    fn query_expansion_is_bounded_and_keeps_each_signal_class() {
        let plan = RetrievalQueryPlan {
            original_query: "original".to_string(),
            exact_terms: vec!["exact-1".into(), "exact-2".into(), "exact-3".into()],
            aliases: vec!["alias-1".into(), "alias-2".into(), "alias-3".into()],
            subqueries: vec!["sub-1".into(), "sub-2".into(), "sub-3".into()],
            entities: vec!["entity-1".into(), "entity-2".into()],
            answer_type: None,
        };
        let queries = plan.queries();
        assert_eq!(queries.len(), 8);
        assert!(queries.iter().any(|query| query == "sub-1"));
        assert!(queries.iter().any(|query| query == "entity-1"));
    }

    #[test]
    fn sqlite_fts_replaces_and_searches_page_chunks() {
        let base = temp_base("fts");
        let (chunks, hash) = sample_chunks();
        let stats = index_literature_document_text_at(&base, &chunks, &hash).expect("index");
        assert_eq!(stats.indexed_chunks, 2);
        let hits =
            full_text_search_literature_at(&base, "congestion throughput", 5).expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].chunk.page_start, 1);
        let repeated = index_literature_document_text_at(&base, &chunks, &hash).expect("repeat");
        assert!(repeated.skipped_as_current);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn retrieval_cards_bridge_paraphrases_to_source_evidence() {
        let base = temp_base("cards");
        let (chunks, hash) = sample_chunks();
        index_literature_document_text_at(&base, &chunks, &hash).expect("index");
        let card = RetrievalCardInput {
            chunk_id: chunks[0].chunk_id.clone(),
            source_content_hash: chunks[0].content_hash.clone(),
            questions: vec!["Which technique improves traffic efficiency?".to_string()],
            concepts: vec!["traffic efficiency".to_string()],
            section_headings: vec!["Evaluation".to_string()],
            aliases: vec!["network flow performance".to_string()],
            methods: vec!["adaptive scheduler".to_string()],
            datasets: Vec::new(),
            metrics: vec!["throughput".to_string()],
            limitations: Vec::new(),
            language_terms: vec!["流量效率".to_string()],
            generated_by: "test-model".to_string(),
            prompt_version: 1,
        };
        upsert_retrieval_cards_at(&base, &[card]).expect("card");
        let status = literature_rag_database_status_at(&base, 10).expect("inspect database");
        assert!(status.exists);
        assert_eq!(status.document_count, 1);
        assert_eq!(status.chunk_count, 2);
        assert_eq!(status.current_card_count, 1);
        assert_eq!(status.pending_card_count, 1);
        assert_eq!(status.stale_card_count, 0);
        assert_eq!(status.card_previews.len(), 1);
        assert_eq!(status.card_previews[0].paper_id, "paper-1");
        assert_eq!(status.card_previews[0].page_start, 1);
        assert_eq!(
            status.card_previews[0].card.concepts,
            vec!["traffic efficiency".to_string()]
        );
        assert!(status.card_previews[0]
            .source_preview
            .contains("Adaptive scheduling"));
        let plan = RetrievalQueryPlan::from_query("traffic efficiency");
        let result = search_literature_with_plan_at(&base, &plan, 5).expect("retrieve");
        assert_eq!(result.results.len(), 1);
        assert_eq!(result.results[0].chunk.page_start, 1);
        assert!(result.results[0].card_rank.is_some());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn database_status_does_not_create_an_empty_index() {
        let base = temp_base("missing-status");
        let status = literature_rag_database_status_at(&base, 10).expect("missing status");
        assert!(!status.exists);
        assert_eq!(status.chunk_count, 0);
        assert!(!literature_fts_path(&base).exists());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn card_browser_filters_and_paginates() {
        let base = temp_base("card-browser");

        // Missing index browses to an empty page rather than creating a database.
        let empty = literature_rag_cards_page_at(&base, "", None, 0, 20).expect("empty page");
        assert_eq!(empty.total, 0);
        assert!(empty.cards.is_empty());
        assert!(!literature_fts_path(&base).exists());

        // Paper 1: adaptive scheduling.
        let (chunks, hash) = sample_chunks();
        index_literature_document_text_at(&base, &chunks, &hash).expect("index paper-1");
        upsert_retrieval_cards_at(
            &base,
            &[RetrievalCardInput {
                chunk_id: chunks[0].chunk_id.clone(),
                source_content_hash: chunks[0].content_hash.clone(),
                questions: vec!["Which technique improves traffic efficiency?".to_string()],
                concepts: vec!["traffic efficiency".to_string()],
                section_headings: vec!["Evaluation".to_string()],
                aliases: Vec::new(),
                methods: vec!["adaptive scheduler".to_string()],
                datasets: Vec::new(),
                metrics: vec!["throughput".to_string()],
                limitations: Vec::new(),
                language_terms: vec!["流量效率".to_string()],
                generated_by: "test-model".to_string(),
                prompt_version: 1,
            }],
        )
        .expect("card paper-1");

        // Paper 2: diffusion models.
        let pages2 = vec![
            PdfPageText {
                page: 1,
                text: "Diffusion models denoise images step by step.".to_string(),
                source: "embedded".to_string(),
            },
            PdfPageText {
                page: 2,
                text: "Sampling schedules trade speed for quality.".to_string(),
                source: "embedded".to_string(),
            },
        ];
        let hash2 = pdf_pages_content_hash(&pages2);
        let chunks2 = chunk_pdf_pages("paper-2", "papers/paper-2.pdf", &pages2).expect("chunks2");
        index_literature_document_text_at(&base, &chunks2, &hash2).expect("index paper-2");
        upsert_retrieval_cards_at(
            &base,
            &[RetrievalCardInput {
                chunk_id: chunks2[0].chunk_id.clone(),
                source_content_hash: chunks2[0].content_hash.clone(),
                questions: vec!["How do diffusion models sample?".to_string()],
                concepts: vec!["diffusion models".to_string()],
                section_headings: vec!["Method".to_string()],
                aliases: Vec::new(),
                methods: vec!["denoising".to_string()],
                datasets: Vec::new(),
                metrics: Vec::new(),
                limitations: Vec::new(),
                language_terms: Vec::new(),
                generated_by: "test-model".to_string(),
                prompt_version: 1,
            }],
        )
        .expect("card paper-2");

        // Unfiltered browse sees both cards.
        let all = literature_rag_cards_page_at(&base, "", None, 0, 20).expect("all cards");
        assert_eq!(all.total, 2);
        assert_eq!(all.cards.len(), 2);

        // Text filter over structured terms / source text narrows to one card.
        let diffusion =
            literature_rag_cards_page_at(&base, "diffusion", None, 0, 20).expect("diffusion");
        assert_eq!(diffusion.total, 1);
        assert_eq!(diffusion.cards.len(), 1);
        assert_eq!(diffusion.cards[0].paper_id, "paper-2");

        // The filter also matches the bound source text, not only the card payload.
        let denoise =
            literature_rag_cards_page_at(&base, "denoise images", None, 0, 20).expect("denoise");
        assert_eq!(denoise.total, 1);
        assert_eq!(denoise.cards[0].paper_id, "paper-2");

        // Paper filter narrows to a single document.
        let paper1 =
            literature_rag_cards_page_at(&base, "", Some("paper-1"), 0, 20).expect("paper-1 only");
        assert_eq!(paper1.total, 1);
        assert_eq!(paper1.cards[0].paper_id, "paper-1");

        // Pagination returns disjoint pages while reporting the full total.
        let page_a = literature_rag_cards_page_at(&base, "", None, 0, 1).expect("page a");
        let page_b = literature_rag_cards_page_at(&base, "", None, 1, 1).expect("page b");
        assert_eq!(page_a.total, 2);
        assert_eq!(page_b.total, 2);
        assert_eq!(page_a.cards.len(), 1);
        assert_eq!(page_b.cards.len(), 1);
        assert_ne!(page_a.cards[0].chunk_id, page_b.cards[0].chunk_id);

        // LIKE wildcards in user input are matched literally, not as patterns.
        let literal = literature_rag_cards_page_at(&base, "%", None, 0, 20).expect("literal");
        assert_eq!(literal.total, 0);

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn liteparse_asset_manifest_is_local_and_fts_searchable() {
        let base = temp_base("assets");
        let asset = LiteratureAssetInput {
            asset_id: "paper-1:p2:asset:figure-1".to_string(),
            paper_id: "paper-1".to_string(),
            relative_path: "papers/rag/assets/doc/figure-1.png".to_string(),
            page: 2,
            asset_type: "extracted-image".to_string(),
            mime_type: "image/png".to_string(),
            caption: "Latency comparison figure".to_string(),
            content_hash: "asset-hash".to_string(),
            parser_engine: "liteparse-python-sdk".to_string(),
        };
        replace_literature_assets_at(&base, "paper-1", &[asset]).expect("asset manifest");
        let connection = open_literature_fts(&base).expect("database");
        let hits = connection
            .query_row(
                "SELECT COUNT(*) FROM literature_asset_fts
                 WHERE literature_asset_fts MATCH 'latency comparison'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("asset FTS");
        assert_eq!(hits, 1);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn citation_mentions_route_queries_back_to_the_source_page() {
        let base = temp_base("citations");
        let pages = vec![PdfPageText {
            page: 8,
            text: "References\n[12] Smith et al. Reliable systems. doi:10.1234/example.2026"
                .to_string(),
            source: "liteparse".to_string(),
        }];
        let hash = pdf_pages_content_hash(&pages);
        let chunks = chunk_pdf_pages("paper-refs", "papers/refs.pdf", &pages).expect("chunks");
        index_literature_document_text_at(&base, &chunks, &hash).expect("index");
        let result = search_literature_at(&base, "10.1234/example.2026", 5).expect("search");
        assert_eq!(result.results[0].chunk.page_start, 8);
        assert!(result.results[0].citation_rank.is_some());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn canonical_metadata_routes_title_queries_to_document_pages() {
        let base = temp_base("metadata");
        let (chunks, hash) = sample_chunks();
        index_literature_document_text_at(&base, &chunks, &hash).expect("index");
        replace_literature_document_metadata_at(
            &base,
            "paper-1",
            "papers/paper-1.pdf",
            "title: Rare Zebra Benchmark; authors: A. Researcher",
        )
        .expect("metadata");
        let result = search_literature_at(&base, "Rare Zebra Benchmark", 5).expect("search");
        assert_eq!(result.results[0].chunk.paper_id, "paper-1");
        assert!(result.results[0].metadata_rank.is_some());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn stale_retrieval_cards_are_rejected() {
        let base = temp_base("stale-card");
        let (chunks, hash) = sample_chunks();
        index_literature_document_text_at(&base, &chunks, &hash).expect("index");
        let card = RetrievalCardInput {
            chunk_id: chunks[0].chunk_id.clone(),
            source_content_hash: "stale".to_string(),
            questions: vec!["What improves traffic?".to_string()],
            concepts: Vec::new(),
            section_headings: Vec::new(),
            aliases: Vec::new(),
            methods: Vec::new(),
            datasets: Vec::new(),
            metrics: Vec::new(),
            limitations: Vec::new(),
            language_terms: Vec::new(),
            generated_by: "test-model".to_string(),
            prompt_version: 1,
        };
        let error = upsert_retrieval_cards_at(&base, &[card]).expect_err("stale rejected");
        assert!(error.contains("stale source"));
        let _ = fs::remove_dir_all(base);
    }
}
