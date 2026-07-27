//! Desktop commands for the literature library — thin wrappers over the
//! shared kernel implementation in `tools::literature`, so the desktop UI,
//! CLI agents, and the literature skills (`/arxiv`, `/research-lit`) all
//! operate on the same project-local SQLite store; `papers/library.json` is
//! only a compatibility projection for legacy tools.
//!
//! `literature_llm` is the one exception: a one-shot, tool-free completion on
//! the user's configured chat executor, so screening and Brief generation can
//! use a real model instead of the offline keyword heuristic.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager, State};

use runtime::{
    ContentBlock, ConversationMessage, PermissionMode, RuntimeError, RuntimeFeatureConfig, Session,
    ToolError, ToolExecutor,
};

use crate::projects::{self, ProjectState};

fn project_base(projects_state: &ProjectState) -> Result<std::path::PathBuf, String> {
    projects::current_project_path(projects_state)
}

/// One-shot LLM completion on the configured executor — no tools, no
/// streaming, no session persistence. Returns the assistant's text (callers
/// ask for JSON and parse it). Errors when no executor is configured, which
/// the frontend treats as "fall back to the heuristic".
#[tauri::command]
pub async fn literature_llm(system: String, prompt: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_oneshot(&system, ConversationMessage::user_text(prompt))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Independent literature judgment through ARIS' built-in `LlmReview` tool.
/// This deliberately uses the configured reviewer instead of the normal chat
/// executor so screening is an independent review step.
#[tauri::command]
pub async fn literature_review_llm(system: String, prompt: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_review_oneshot(&system, &prompt))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn run_review_oneshot(system: &str, prompt: &str) -> Result<String, String> {
    crate::config::apply_reviewer_environment(true);
    let review_skill = tools::skill_markdown("research-review")
        .unwrap_or_else(|| "Use evidence-first independent research review.".to_string());
    tools::execute_tool(
        "LlmReview",
        &json!({
            "prompt": format!(
                "{system}\n\nSomniQ built-in research-review skill instructions:\n{review_skill}\n\n\
                 Apply those evidence-first independent review standards and return exactly \
                 the output format requested below.\n\n{prompt}"
            )
        }),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureVisionImage {
    page: usize,
    mime_type: String,
    data: String,
    fingerprint: String,
}

#[tauri::command]
pub async fn literature_llm_vision(
    system: String,
    prompt: String,
    images: Vec<LiteratureVisionImage>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_oneshot(&system, vision_message(prompt, images)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

struct SilentObserver;
impl aris_executor::StreamObserver for SilentObserver {
    fn on_text_delta(&mut self, _text: &str) -> Result<(), RuntimeError> {
        Ok(())
    }
    fn on_thinking_delta(&mut self, _thinking: &str) -> Result<(), RuntimeError> {
        Ok(())
    }
    fn on_tool_call(&mut self, _id: &str, _name: &str, _input: &str) -> Result<(), RuntimeError> {
        Ok(())
    }
}

struct NoTools;
impl ToolExecutor for NoTools {
    fn execute(&mut self, tool_name: &str, _input: &str) -> Result<String, ToolError> {
        Err(ToolError::new(format!(
            "tool `{tool_name}` is not available during literature LLM calls"
        )))
    }
}

pub(crate) fn run_oneshot(system: &str, message: ConversationMessage) -> Result<String, String> {
    run_oneshot_with_model(system, message, None).map(|(text, _model)| text)
}

pub(crate) fn run_oneshot_with_model(
    system: &str,
    message: ConversationMessage,
    requested_model: Option<&str>,
) -> Result<(String, String), String> {
    // Use the managed-normalized object (not raw `load_object`) so a managed
    // model switch resolves the current gateway credentials and probed transport
    // rather than a stale executor slot.
    let requested_model = requested_model
        .map(str::trim)
        .filter(|model| !model.is_empty());
    let config = match requested_model {
        Some(model) => crate::config::executor_object_for_model(model)?.ok_or_else(|| {
            format!(
                "retrieval-card model `{model}` is not configured; select a verified model in Settings"
            )
        })?,
        None => crate::config::current_executor_object()?,
    };
    let (model, _provider, executor_config) = aris_chat::resolve_settings_executor_config(&config)?;
    if message
        .blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::Image { .. }))
    {
        validate_vision_model(&model)?;
    }
    runtime::clear_interrupt();
    let observer: Box<dyn aris_executor::StreamObserver> = Box::new(SilentObserver);
    let mut conversation = aris_chat::build_conversation_runtime(
        Session::new(),
        executor_config,
        model.clone(),
        false,
        Vec::new(),
        observer,
        NoTools,
        aris_chat::permission_policy_for_tools(Vec::new(), PermissionMode::ReadOnly),
        vec![system.to_string()],
        RuntimeFeatureConfig::default(),
        // Single-turn helper; never compacts, so no summarizer needed.
        None,
        None,
    )?;
    let summary = conversation
        .run_turn_message(message, None)
        .map_err(|e| e.to_string())?;
    Ok((aris_chat::final_assistant_text(&summary), model))
}

fn validate_vision_model(model: &str) -> Result<(), String> {
    let normalized = model.trim().to_ascii_lowercase();
    if normalized.starts_with("minimax-") && normalized != "minimax-m3" {
        Err(format!(
            "{model} does not accept image input; select MiniMax-M3 or another vision-capable executor"
        ))
    } else {
        Ok(())
    }
}

fn vision_message(
    prompt: String,
    images: Vec<LiteratureVisionImage>,
) -> Result<ConversationMessage, String> {
    const MAX_IMAGES: usize = 8;
    const MAX_IMAGE_BASE64_CHARS: usize = 10 * 1024 * 1024;
    const MAX_TOTAL_BASE64_CHARS: usize = 40 * 1024 * 1024;

    if images.is_empty() {
        return Err("vision literature call requires at least one page image".to_string());
    }
    if images.len() > MAX_IMAGES {
        return Err(format!(
            "vision literature call accepts at most {MAX_IMAGES} page images per batch"
        ));
    }
    let total_chars = images.iter().map(|image| image.data.len()).sum::<usize>();
    if total_chars > MAX_TOTAL_BASE64_CHARS {
        return Err("vision literature image batch exceeds the 40 MB base64 limit".to_string());
    }

    let mut blocks = vec![ContentBlock::Text { text: prompt }];
    for image in images {
        if image.page == 0 {
            return Err("page images must use 1-based page numbers".to_string());
        }
        if !matches!(
            image.mime_type.as_str(),
            "image/jpeg" | "image/png" | "image/webp"
        ) {
            return Err(format!(
                "page {} has unsupported image media type `{}`",
                image.page, image.mime_type
            ));
        }
        if image.data.is_empty() || image.data.len() > MAX_IMAGE_BASE64_CHARS {
            return Err(format!(
                "page {} image is empty or exceeds the 10 MB base64 limit",
                image.page
            ));
        }
        blocks.push(ContentBlock::Text {
            text: format!(
                "[[PAGE IMAGE {}]] fingerprint={}",
                image.page, image.fingerprint
            ),
        });
        blocks.push(ContentBlock::Image {
            media_type: image.mime_type,
            data: image.data,
        });
    }
    Ok(ConversationMessage::user_blocks(blocks))
}

fn resolve_pdf_path(
    projects_state: &ProjectState,
    relative_path: &str,
) -> Result<std::path::PathBuf, String> {
    resolve_pdf_path_at(&project_base(projects_state)?, relative_path)
}

fn resolve_pdf_path_at(
    base: &std::path::Path,
    relative_path: &str,
) -> Result<std::path::PathBuf, String> {
    let relative = std::path::Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("invalid PDF path".to_string());
    }
    let allowed_roots = ["papers", "slides", "poster", "studio"]
        .into_iter()
        .filter_map(|directory| base.join(directory).canonicalize().ok())
        .collect::<Vec<_>>();
    let path = base
        .join(relative)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !allowed_roots.iter().any(|root| path.starts_with(root))
        || !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    {
        return Err(
            "PDF must be a local file inside papers/, slides/, poster/, or studio/".to_string(),
        );
    }
    Ok(path)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfPageText {
    page: usize,
    text: String,
    source: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfTextExtraction {
    text: String,
    pages: Vec<PdfPageText>,
    total_characters: usize,
    extracted_characters: usize,
    truncated: bool,
    ocr_used: bool,
    missing_pages: Vec<usize>,
    warnings: Vec<String>,
}

struct PreparedPdfRagIndex {
    paper_id: String,
    relative_path: String,
    page_count: usize,
    ocr_used: bool,
    indexed_for_search: bool,
    document_content_hash: String,
    chunks: Vec<tools::pdf_rag::LiteraturePdfChunk>,
    assets: Vec<tools::pdf_rag::LiteratureAssetInput>,
    parser_engine: String,
    parser_warning: Option<String>,
    metadata_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureRagPdfPage {
    page: usize,
    text: String,
    source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiteParseBridgeOutput {
    engine: String,
    ocr_enabled: bool,
    pages: Vec<LiteParseBridgePage>,
    #[serde(default)]
    assets: Vec<LiteParseBridgeAsset>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiteParseBridgePage {
    page: usize,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiteParseBridgeAsset {
    source_id: String,
    page: usize,
    mime_type: String,
    path: String,
    content_hash: String,
}

/// Extract readable text from a downloaded PDF so the Brief can read the full
/// paper, not just the abstract. The result reports truncation explicitly so
/// the UI never presents partial extraction as a full-paper brief.
#[tauri::command]
pub fn literature_pdf_text(
    projects_state: State<ProjectState>,
    relative_path: String,
) -> Result<Value, String> {
    let path = resolve_pdf_path(&projects_state, &relative_path)?;
    let extraction = extract_pdf_text_by_page(&path)?;
    let indexed_for_search = tools::literature::library_index_pdf_text_at(
        &project_base(&projects_state)?,
        &relative_path,
        &extraction.text,
    )?;
    let mut response = serde_json::to_value(extraction).map_err(|error| error.to_string())?;
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "indexedForSearch".to_string(),
            Value::Bool(indexed_for_search),
        );
    }
    Ok(response)
}

/// Build or incrementally refresh the page-grounded local text index for one
/// literature PDF. The derived index contains exact page text only; LLM
/// retrieval cards are generated separately and remain traceable to these
/// source chunks.
#[tauri::command]
pub async fn literature_rag_index_pdf(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    relative_path: String,
    paper_id: Option<String>,
    pages: Option<Vec<LiteratureRagPdfPage>>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let liteparse_bridge = liteparse_bridge_path(&app);
    let input_base = base.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_pdf_rag_index(
            &input_base,
            &relative_path,
            paper_id.as_deref(),
            pages.as_deref(),
            liteparse_bridge.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    let text_base = base.clone();
    let text_chunks = prepared.chunks.clone();
    let text_hash = prepared.document_content_hash.clone();
    let assets = prepared.assets.clone();
    let asset_paper_id = prepared.paper_id.clone();
    let metadata_text = prepared.metadata_text.clone();
    let metadata_relative_path = prepared.relative_path.clone();
    let stats = tauri::async_runtime::spawn_blocking(move || {
        let stats = tools::pdf_rag::index_literature_document_text_at(
            &text_base,
            &text_chunks,
            &text_hash,
        )?;
        tools::pdf_rag::replace_literature_assets_at(&text_base, &asset_paper_id, &assets)?;
        tools::pdf_rag::replace_literature_document_metadata_at(
            &text_base,
            &asset_paper_id,
            &metadata_relative_path,
            &metadata_text,
        )?;
        Ok::<_, String>(stats)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(json!({
        "paperId": prepared.paper_id,
        "relativePath": prepared.relative_path,
        "pageCount": prepared.page_count,
        "ocrUsed": prepared.ocr_used,
        "indexedForSearch": prepared.indexed_for_search,
        "parserEngine": prepared.parser_engine,
        "parserWarning": prepared.parser_warning,
        "assetCount": prepared.assets.len(),
        "stats": stats,
    }))
}

fn liteparse_bridge_path(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("resources").join("liteparse_bridge.py"));
        candidates.push(resource_dir.join("liteparse_bridge.py"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("liteparse_bridge.py"),
    );
    candidates.into_iter().find(|path| path.is_file())
}

fn extract_pdf_with_liteparse(
    base: &Path,
    relative_path: &str,
    pdf_path: &Path,
    bridge_path: &Path,
) -> Result<(PdfTextExtraction, Vec<LiteParseBridgeAsset>, String), String> {
    let digest = format!("{:x}", Sha256::digest(relative_path.as_bytes()));
    let asset_dir = base
        .join("papers")
        .join("rag")
        .join("assets")
        .join(&digest[..20]);
    let python = std::env::var("SOMNIQ_LITEPARSE_PYTHON")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "python".to_string());
    let mut command = Command::new(&python);
    command
        .arg(bridge_path)
        .arg("--pdf")
        .arg(pdf_path)
        .arg("--asset-dir")
        .arg(&asset_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().map_err(|error| {
        format!(
            "could not launch LiteParse through `{}`: {error}",
            python.trim()
        )
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "LiteParse bridge exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    let parsed: LiteParseBridgeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("LiteParse bridge returned invalid JSON: {error}"))?;
    if parsed.pages.is_empty() || parsed.pages.len() > MAX_RAG_PDF_PAGES {
        return Err(format!(
            "LiteParse returned an invalid page count: {}",
            parsed.pages.len()
        ));
    }
    for asset in &parsed.assets {
        let path = Path::new(&asset.path);
        if !path.starts_with(&asset_dir) {
            return Err(
                "LiteParse returned an asset path outside the project evidence directory"
                    .to_string(),
            );
        }
    }
    let pages = parsed
        .pages
        .into_iter()
        .map(|page| PdfPageText {
            page: page.page,
            text: page.text.replace('\0', "").trim().to_string(),
            source: "liteparse",
        })
        .collect::<Vec<_>>();
    let extraction = finalize_pdf_extraction(pages, parsed.ocr_enabled, Vec::new())?;
    Ok((extraction, parsed.assets, parsed.engine))
}

/// CPU-only preparation work for one PDF. Source extraction and canonical
/// indexing remain separate from later LLM retrieval-card generation.
fn prepare_pdf_rag_index(
    base: &Path,
    relative_path: &str,
    selected_paper_id: Option<&str>,
    supplied_pages: Option<&[LiteratureRagPdfPage]>,
    liteparse_bridge: Option<&Path>,
) -> Result<PreparedPdfRagIndex, String> {
    let path = resolve_pdf_path_at(base, relative_path)?;
    let liteparse = liteparse_bridge
        .ok_or_else(|| "LiteParse bridge resource was not found".to_string())
        .and_then(|bridge| extract_pdf_with_liteparse(base, relative_path, &path, bridge));
    let (mut extraction, liteparse_assets, parser_engine, parser_warning) = match liteparse {
        Ok((extraction, assets, engine)) => (extraction, assets, engine, None),
        Err(error) => {
            let extraction = match supplied_pages {
                Some(pages) => extraction_from_rag_pages(pages)?,
                None => extract_pdf_text_by_page(&path)?,
            };
            (
                extraction,
                Vec::new(),
                if supplied_pages.is_some() {
                    "pdfjs-page-extraction".to_string()
                } else {
                    "bundled-pdf-extract-ocr".to_string()
                },
                Some(format!(
                    "LiteParse unavailable; used local fallback: {error}"
                )),
            )
        }
    };
    if let Some(warning) = &parser_warning {
        extraction.warnings.push(warning.clone());
    }
    let paper_id = match selected_paper_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(paper_id) => {
            tools::literature::library_index_pdf_text_for_record_at(
                base,
                paper_id,
                &extraction.text,
            )?;
            paper_id.to_string()
        }
        None => {
            let paper_id = tools::literature::library_record_id_for_pdf_at(base, relative_path)?
                .ok_or_else(|| {
                    "PDF RAG requires the file to be attached to a canonical literature record"
                        .to_string()
                })?;
            tools::literature::library_index_pdf_text_for_record_at(
                base,
                &paper_id,
                &extraction.text,
            )?;
            paper_id
        }
    };
    let indexed_for_search = true;
    let metadata_text = tools::literature::library_record_retrieval_metadata_at(base, &paper_id)?;
    let pages = extraction
        .pages
        .iter()
        .map(|page| tools::pdf_rag::PdfPageText {
            page: page.page as i64,
            text: page.text.clone(),
            source: page.source.to_string(),
        })
        .collect::<Vec<_>>();
    let document_content_hash = tools::pdf_rag::pdf_pages_content_hash(&pages);
    let chunks = tools::pdf_rag::chunk_pdf_pages(&paper_id, relative_path, &pages)?;
    if chunks.is_empty() {
        return Err("PDF contains no page text that can be indexed".to_string());
    }
    let assets = liteparse_assets
        .into_iter()
        .map(|asset| {
            let stored_path = Path::new(&asset.path)
                .strip_prefix(base)
                .unwrap_or_else(|_| Path::new(&asset.path))
                .to_string_lossy()
                .replace('\\', "/");
            tools::pdf_rag::LiteratureAssetInput {
                asset_id: format!("{}:p{}:asset:{}", paper_id, asset.page, asset.source_id),
                paper_id: paper_id.clone(),
                relative_path: stored_path,
                page: asset.page as i64,
                asset_type: "extracted-image".to_string(),
                mime_type: asset.mime_type,
                caption: format!(
                    "Extracted figure {} on page {}",
                    asset.source_id, asset.page
                ),
                content_hash: asset.content_hash,
                parser_engine: parser_engine.clone(),
            }
        })
        .collect::<Vec<_>>();
    Ok(PreparedPdfRagIndex {
        paper_id,
        relative_path: relative_path.to_string(),
        page_count: extraction.pages.len(),
        ocr_used: extraction.ocr_used,
        indexed_for_search,
        document_content_hash,
        chunks,
        assets,
        parser_engine,
        parser_warning,
        metadata_text,
    })
}

/// Incrementally index every canonical literature PDF in the current project.
/// Documents are prepared and committed one at a time. Retrieval cards are
/// generated by a separate bounded background operation.
#[tauri::command]
pub async fn literature_rag_index_library(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    force_rebuild: Option<bool>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let liteparse_bridge = liteparse_bridge_path(&app);
    let force_rebuild = force_rebuild.unwrap_or(false);
    if force_rebuild {
        let reset_base = base.clone();
        tauri::async_runtime::spawn_blocking(move || {
            tools::pdf_rag::reset_literature_text_index_at(&reset_base)
        })
        .await
        .map_err(|error| error.to_string())??;
    }
    let records_base = base.clone();
    let records = tauri::async_runtime::spawn_blocking(move || {
        tools::literature::library_pdf_records_at(&records_base)
    })
    .await
    .map_err(|error| error.to_string())??;
    let total = records.len();
    let mut indexed = 0usize;
    let mut skipped = 0usize;
    let mut results = Vec::with_capacity(total);
    let mut failures = Vec::new();

    for record in records {
        let prep_base = base.clone();
        let prep_path = record.relative_path.clone();
        let prep_id = record.paper_id.clone();
        let prep_bridge = liteparse_bridge.clone();
        let prepared = match tauri::async_runtime::spawn_blocking(move || {
            prepare_pdf_rag_index(
                &prep_base,
                &prep_path,
                Some(&prep_id),
                None,
                prep_bridge.as_deref(),
            )
        })
        .await
        {
            Ok(Ok(prepared)) => prepared,
            Ok(Err(error)) => {
                failures.push(json!({
                    "paperId": record.paper_id,
                    "relativePath": record.relative_path,
                    "error": error,
                }));
                continue;
            }
            Err(error) => {
                failures.push(json!({
                    "paperId": record.paper_id,
                    "relativePath": record.relative_path,
                    "error": error.to_string(),
                }));
                continue;
            }
        };
        let text_base = base.clone();
        let text_chunks = prepared.chunks.clone();
        let text_hash = prepared.document_content_hash.clone();
        let assets = prepared.assets.clone();
        let asset_paper_id = prepared.paper_id.clone();
        let metadata_text = prepared.metadata_text.clone();
        let metadata_relative_path = prepared.relative_path.clone();
        let stats = match tauri::async_runtime::spawn_blocking(move || {
            let stats = tools::pdf_rag::index_literature_document_text_at(
                &text_base,
                &text_chunks,
                &text_hash,
            )?;
            tools::pdf_rag::replace_literature_assets_at(&text_base, &asset_paper_id, &assets)?;
            tools::pdf_rag::replace_literature_document_metadata_at(
                &text_base,
                &asset_paper_id,
                &metadata_relative_path,
                &metadata_text,
            )?;
            Ok::<_, String>(stats)
        })
        .await
        {
            Ok(Ok(stats)) => stats,
            Ok(Err(error)) => {
                failures.push(json!({
                    "paperId": prepared.paper_id,
                    "relativePath": prepared.relative_path,
                    "error": error,
                }));
                continue;
            }
            Err(error) => {
                failures.push(json!({
                    "paperId": prepared.paper_id,
                    "relativePath": prepared.relative_path,
                    "error": error.to_string(),
                }));
                continue;
            }
        };
        if stats.skipped_as_current {
            skipped += 1;
        } else {
            indexed += 1;
        }
        results.push(json!({
            "paperId": prepared.paper_id,
            "relativePath": prepared.relative_path,
            "pageCount": prepared.page_count,
            "ocrUsed": prepared.ocr_used,
            "indexedForSearch": prepared.indexed_for_search,
            "parserEngine": prepared.parser_engine,
            "parserWarning": prepared.parser_warning,
            "assetCount": prepared.assets.len(),
            "stats": stats,
        }));
    }

    Ok(json!({
        "forceRebuild": force_rebuild,
        "total": total,
        "indexed": indexed,
        "skipped": skipped,
        "failed": failures.len(),
        "results": results,
        "failures": failures,
    }))
}

/// Page-grounded exact-source retrieval. Query expansion and reranking are
/// orchestrated by the project retrieval command in `knowledge.rs`.
#[tauri::command]
pub async fn literature_rag_search(
    projects_state: State<'_, ProjectState>,
    query: String,
    limit: Option<usize>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("literature RAG search query is empty".to_string());
    }
    let bounded_limit = limit.unwrap_or(8).clamp(1, 50);
    let result = tauri::async_runtime::spawn_blocking(move || {
        tools::pdf_rag::search_literature_at(&base, &query, bounded_limit)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(json!({
        "query": result.query_plan.original_query,
        "retrieval": result.retrieval,
        "queryPlan": result.query_plan,
        "results": result.results,
    }))
}

/// Read-only inventory of the rebuildable no-embedding retrieval database for
/// the Literature search UI. This does not create an empty database.
#[tauri::command]
pub async fn literature_rag_status(
    projects_state: State<'_, ProjectState>,
    preview_limit: Option<usize>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let status = tauri::async_runtime::spawn_blocking(move || {
        tools::pdf_rag::literature_rag_database_status_at(
            &base,
            preview_limit.unwrap_or(12).clamp(1, 200),
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    serde_json::to_value(status).map_err(|error| error.to_string())
}

/// Browse the generated retrieval cards with an optional text filter and offset
/// pagination for the Literature card browser. Read-only; does not create an
/// empty database.
#[tauri::command]
pub async fn literature_rag_cards(
    projects_state: State<'_, ProjectState>,
    query: Option<String>,
    paper_id: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let query = query.unwrap_or_default();
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let page = tauri::async_runtime::spawn_blocking(move || {
        tools::pdf_rag::literature_rag_cards_page_at(
            &base,
            &query,
            paper_id.as_deref(),
            offset,
            limit,
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    serde_json::to_value(page).map_err(|error| error.to_string())
}

/// Read a validated local PDF for the embedded PDF.js viewer.
#[tauri::command]
pub fn literature_pdf_bytes(
    projects_state: State<ProjectState>,
    relative_path: String,
) -> Result<Vec<u8>, String> {
    let path = resolve_pdf_path(&projects_state, &relative_path)?;
    std::fs::read(path).map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedPdf {
    path: String,
    relative_path: String,
    bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedAttachment {
    path: String,
    relative_path: String,
    file_name: String,
    bytes: u64,
    mime_type: Option<&'static str>,
}

fn attachment_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => Some("application/pdf"),
        "txt" | "md" => Some("text/plain"),
        "html" | "htm" => Some("text/html"),
        "json" => Some("application/json"),
        "csv" => Some("text/csv"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "zip" => Some("application/zip"),
        _ => None,
    }
}

fn import_attachment_at(base: &Path, source_path: &Path) -> Result<ImportedAttachment, String> {
    const MAX_ATTACHMENT_BYTES: u64 = 512 * 1024 * 1024;
    if !source_path.is_file() {
        return Err("selected attachment must be a file".to_string());
    }
    let source_metadata = std::fs::metadata(source_path).map_err(|error| error.to_string())?;
    if source_metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err("attachments may not exceed 512 MB".to_string());
    }
    let source_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "selected attachment has no file name".to_string())?;
    let safe_name = tools::literature::sanitize_file_name(source_name)?;
    let attachments_dir = base.join("papers").join("attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|error| error.to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    let destination_name = format!("{nonce}-{safe_name}");
    let destination = attachments_dir.join(&destination_name);
    std::fs::copy(source_path, &destination).map_err(|error| error.to_string())?;
    let bytes = std::fs::metadata(&destination)
        .map_err(|error| error.to_string())?
        .len();
    Ok(ImportedAttachment {
        path: destination.to_string_lossy().to_string(),
        relative_path: PathBuf::from("papers")
            .join("attachments")
            .join(&destination_name)
            .to_string_lossy()
            .replace('\\', "/"),
        file_name: source_name.to_string(),
        bytes,
        mime_type: attachment_mime_type(source_path),
    })
}

fn import_pdf_at(base: &Path, source_path: &Path, file_name: &str) -> Result<ImportedPdf, String> {
    if !source_path.is_file()
        || !source_path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    {
        return Err("selected file must be a PDF".to_string());
    }
    let mut header = [0_u8; 5];
    std::fs::File::open(source_path)
        .map_err(|error| error.to_string())?
        .read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    if &header != b"%PDF-" {
        return Err("selected file does not have a valid PDF header".to_string());
    }
    let papers_dir = base.join("papers");
    std::fs::create_dir_all(&papers_dir).map_err(|error| error.to_string())?;
    let safe_name = tools::literature::sanitize_file_name(file_name)?;
    let destination = papers_dir.join(safe_name);
    let same_file = source_path.canonicalize().ok() == destination.canonicalize().ok();
    if destination.exists() && !same_file {
        return Err(format!(
            "refusing to overwrite existing PDF: {}",
            destination.display()
        ));
    }
    if !same_file {
        std::fs::copy(source_path, &destination).map_err(|error| error.to_string())?;
    }
    let bytes = std::fs::metadata(&destination)
        .map_err(|error| error.to_string())?
        .len();
    let relative = PathBuf::from("papers").join(
        destination
            .file_name()
            .ok_or_else(|| "imported PDF has no file name".to_string())?,
    );
    Ok(ImportedPdf {
        path: destination.to_string_lossy().to_string(),
        relative_path: relative.to_string_lossy().replace('\\', "/"),
        bytes,
    })
}

/// Copy a user-selected PDF into the active project's literature library.
#[tauri::command]
pub fn literature_import_pdf(
    projects_state: State<ProjectState>,
    source_path: String,
    file_name: String,
) -> Result<Value, String> {
    serde_json::to_value(import_pdf_at(
        &project_base(&projects_state)?,
        Path::new(&source_path),
        &file_name,
    )?)
    .map_err(|error| error.to_string())
}

/// Copy an explicit user-selected local file into `papers/attachments/`.
/// This is intentionally separate from importing a PDF: the item is attached
/// to an existing bibliography record by the frontend and never becomes a
/// duplicate literature record by accident.
#[tauri::command]
pub fn literature_import_attachment(
    projects_state: State<ProjectState>,
    source_path: String,
) -> Result<Value, String> {
    serde_json::to_value(import_attachment_at(
        &project_base(&projects_state)?,
        Path::new(&source_path),
    )?)
    .map_err(|error| error.to_string())
}

/// Copy a PDF and immediately create (or merge) its local-first literature
/// record. This is distinct from `literature_import_pdf`, which attaches a
/// file to an already selected record.
#[tauri::command]
pub fn literature_import_pdf_as_record(
    projects_state: State<ProjectState>,
    source_path: String,
    title: Option<String>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let source = Path::new(&source_path);
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "selected PDF has no file name".to_string())?;
    let imported = import_pdf_at(&base, source, file_name)?;
    let fallback_title = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_name);
    let extracted = extract_pdf_text_by_page(Path::new(&imported.path)).ok();
    let inferred_title = extracted
        .as_ref()
        .and_then(|extraction| infer_pdf_title(&extraction.text));
    let inferred_doi = extracted
        .as_ref()
        .and_then(|extraction| infer_pdf_doi(&extraction.text));
    let record_title = title
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or(inferred_title.as_deref())
        .unwrap_or(fallback_title);
    let report = tools::literature::library_create_pdf_record_at(
        &base,
        record_title,
        &imported.relative_path,
        imported.bytes,
        inferred_doi.as_deref(),
    )?;
    let indexed_for_search = extracted
        .as_ref()
        .map(|extraction| {
            tools::literature::library_index_pdf_text_at(
                &base,
                &imported.relative_path,
                &extraction.text,
            )
        })
        .transpose()?
        .unwrap_or(false);
    Ok(json!({
        "pdf": imported,
        "record": report,
        "metadata": {
            "titleInferred": inferred_title.is_some() && title.as_deref().is_none_or(|value| value.trim().is_empty()),
            "doi": inferred_doi,
            "indexedForSearch": indexed_for_search,
        },
    }))
}

/// Add an explicitly supplied DOI or ISBN through the same audited source
/// adapters used by reproducible literature discovery.
#[tauri::command]
pub async fn literature_add_identifier(
    projects_state: State<'_, ProjectState>,
    identifier: String,
) -> Result<Value, String> {
    let identifier = identifier.trim().to_string();
    let is_doi = identifier.to_ascii_lowercase().starts_with("10.");
    let isbn_digits = identifier.chars().filter(char::is_ascii_digit).count();
    if !is_doi && !(isbn_digits == 10 || isbn_digits == 13) {
        return Err("enter a DOI beginning with 10. or a 10/13-digit ISBN".to_string());
    }
    let base = project_base(&projects_state)?;
    tauri::async_runtime::spawn_blocking(move || {
        tools::literature::literature_search_ad_hoc_at(
            &base,
            tools::literature::LiteratureSearchInput {
                query: identifier,
                sources: vec!["crossref".to_string(), "openalex".to_string()],
                max_results: Some(3),
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

/// OCR one rendered PDF page supplied by the embedded PDF.js reader. This
/// keeps page rendering self-contained in the desktop bundle and uses the
/// platform OCR engine (or Tesseract when available) only for image-only pages.
#[tauri::command]
pub fn literature_image_ocr(image: Vec<u8>) -> Result<String, String> {
    if image.len() > 24 * 1024 * 1024 {
        return Err("OCR page image exceeds the 24 MB limit".to_string());
    }
    if !image.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("OCR input must be a PNG page image".to_string());
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let path = std::env::temp_dir().join(format!(
        "somniq-pdf-page-ocr-{}-{nonce}.png",
        std::process::id()
    ));
    std::fs::write(&path, image).map_err(|error| error.to_string())?;
    let result = tesseract_ocr(&path).or_else(|tesseract_error| {
        #[cfg(windows)]
        {
            windows_ocr(&path).map_err(|windows_error| {
                format!("{tesseract_error}; Windows OCR failed: {windows_error}")
            })
        }
        #[cfg(not(windows))]
        {
            Err(tesseract_error)
        }
    });
    let _ = std::fs::remove_file(path);
    result
}

/// Open a downloaded library PDF with the operating system's PDF viewer.
#[tauri::command]
pub fn literature_pdf_open(
    projects_state: State<ProjectState>,
    relative_path: String,
) -> Result<(), String> {
    let path = resolve_pdf_path(&projects_state, &relative_path)?;
    #[cfg(target_os = "windows")]
    let mut command = crate::process::hidden_command("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = crate::process::hidden_command("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = crate::process::hidden_command("xdg-open");

    command
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn resolve_attachment_path(
    projects_state: &ProjectState,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let base = project_base(projects_state)?;
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("invalid attachment path".to_string());
    }
    let attachments_root = base
        .join("papers")
        .canonicalize()
        .map_err(|error| format!("papers directory is unavailable: {error}"))?;
    let path = base
        .join(relative)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !path.starts_with(&attachments_root) {
        return Err("attachment must be a local file inside papers/".to_string());
    }
    Ok(path)
}

/// Open a validated project-local attachment in its system-default viewer.
#[tauri::command]
pub fn literature_attachment_open(
    projects_state: State<ProjectState>,
    relative_path: String,
) -> Result<(), String> {
    let path = resolve_attachment_path(&projects_state, &relative_path)?;
    #[cfg(target_os = "windows")]
    let mut command = crate::process::hidden_command("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = crate::process::hidden_command("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = crate::process::hidden_command("xdg-open");

    command
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Read a user-selected annotation export. The payload is bounded and must be
/// a JSON object so malformed files cannot mutate the library state.
#[tauri::command]
pub fn literature_read_annotation_export(source_path: String) -> Result<Value, String> {
    const MAX_ANNOTATION_EXPORT_BYTES: u64 = 10 * 1024 * 1024;
    let path = Path::new(&source_path);
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_ANNOTATION_EXPORT_BYTES {
        return Err("annotation export must be a JSON file no larger than 10 MB".to_string());
    }
    let value: Value =
        serde_json::from_slice(&std::fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("invalid annotation export: {error}"))?;
    if !value.is_object() {
        return Err("annotation export must contain a JSON object".to_string());
    }
    Ok(value)
}

/// Write a portable JSON export to the explicit destination chosen by the
/// user. Annotation export is intentionally never written into the canonical
/// database automatically.
#[tauri::command]
pub fn literature_write_annotation_export(
    destination_path: String,
    payload: Value,
) -> Result<(), String> {
    const MAX_ANNOTATION_EXPORT_BYTES: usize = 10 * 1024 * 1024;
    let destination = Path::new(&destination_path);
    if destination_path.trim().is_empty() || destination.is_dir() {
        return Err("select a JSON export destination".to_string());
    }
    let encoded = serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_ANNOTATION_EXPORT_BYTES {
        return Err("annotation export exceeds the 10 MB safety limit".to_string());
    }
    std::fs::write(destination, encoded).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn literature_load(projects_state: State<ProjectState>) -> Result<Value, String> {
    tools::literature::library_load_at(&project_base(&projects_state)?)
}

/// The SQLite store is canonical; `papers/library.json` exists only as a
/// compatibility projection for existing Desktop, CLI, and skill clients.
#[tauri::command]
pub fn literature_storage_status(
    projects_state: State<ProjectState>,
) -> Result<tools::literature::LiteratureStorageStatus, String> {
    tools::literature::library_storage_status_at(&project_base(&projects_state)?)
}

/// Create a consistent copy of the canonical SQLite store.  This intentionally
/// backs up the database rather than the legacy `papers/library.json` export.
#[tauri::command]
pub fn literature_storage_backup(
    projects_state: State<ProjectState>,
) -> Result<runtime::literature::LiteratureBackup, String> {
    tools::literature::library_create_backup_at(&project_base(&projects_state)?)
}

/// Search titles, abstracts and local literature metadata through the SQLite
/// FTS5 index. This is read-only and never treats the JSON projection as the
/// source of truth.
#[tauri::command]
pub fn literature_full_text_search(
    projects_state: State<ProjectState>,
    query: String,
    limit: Option<usize>,
) -> Result<Value, String> {
    tools::literature::library_full_text_search_at(&project_base(&projects_state)?, &query, limit)
}

#[tauri::command]
pub fn literature_duplicate_candidates(
    projects_state: State<ProjectState>,
) -> Result<Vec<runtime::literature::LiteratureDuplicateCandidate>, String> {
    tools::literature::library_duplicate_candidates_at(&project_base(&projects_state)?)
}

#[tauri::command]
pub fn literature_merge_duplicates(
    projects_state: State<ProjectState>,
    primary_record_id: String,
    duplicate_record_id: String,
) -> Result<Value, String> {
    tools::literature::library_merge_duplicates_at(
        &project_base(&projects_state)?,
        &primary_record_id,
        &duplicate_record_id,
    )
}

#[tauri::command]
pub fn literature_apply_delta(
    projects_state: State<ProjectState>,
    delta: tools::literature::LiteratureLibraryDelta,
) -> Result<Value, String> {
    tools::literature::library_apply_delta_at(&project_base(&projects_state)?, &delta)
}

#[tauri::command]
pub fn literature_import_bibliography(
    projects_state: State<ProjectState>,
    input: tools::literature::LiteratureBibliographyImportInput,
) -> Result<tools::literature::LiteratureBibliographyImportReport, String> {
    tools::literature::library_import_bibliography_at(&project_base(&projects_state)?, &input)
}

/// Render one selected set of canonical records as a standard bibliography
/// interchange format. The caller chooses any destination separately, keeping
/// the operation local and explicit.
#[tauri::command]
pub fn literature_export_bibliography(
    projects_state: State<ProjectState>,
    input: tools::literature::LiteratureBibliographyExportInput,
) -> Result<tools::literature::LiteratureBibliographyExportReport, String> {
    tools::literature::library_export_bibliography_at(&project_base(&projects_state)?, &input)
}

/// Write rendered bibliography content only to a destination chosen through a
/// desktop save dialog. This does not alter the canonical SQLite library.
#[tauri::command]
pub fn literature_write_bibliography_export(
    destination_path: String,
    content: String,
) -> Result<(), String> {
    const MAX_BIBLIOGRAPHY_EXPORT_BYTES: usize = 25 * 1024 * 1024;
    let destination = Path::new(&destination_path);
    if destination_path.trim().is_empty() || destination.is_dir() {
        return Err("select a bibliography export destination".to_string());
    }
    if content.len() > MAX_BIBLIOGRAPHY_EXPORT_BYTES {
        return Err("bibliography export exceeds the 25 MB safety limit".to_string());
    }
    std::fs::write(destination, content).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn literature_save(projects_state: State<ProjectState>, library: Value) -> Result<(), String> {
    tools::literature::library_save_at(&project_base(&projects_state)?, &library)
}

#[tauri::command]
pub async fn literature_search(
    projects_state: State<'_, ProjectState>,
    query: String,
    sources: Vec<String>,
    max_results: Option<usize>,
) -> Result<Value, String> {
    let limit = max_results.unwrap_or(20).max(1);
    let base = project_base(&projects_state)?;
    tauri::async_runtime::spawn_blocking(move || {
        tools::literature::literature_search_ad_hoc_at(
            &base,
            tools::literature::LiteratureSearchInput {
                query,
                sources,
                max_results: Some(limit),
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create a project-local, reproducible search protocol. The Desktop uses the
/// same tools-layer operation as Chat and CLI, but supplies its active project
/// root explicitly rather than relying on a process-wide workspace variable.
#[tauri::command]
pub fn literature_protocol_create(
    projects_state: State<ProjectState>,
    protocol: runtime::SearchProtocolDraft,
) -> Result<Value, String> {
    tools::literature::literature_search_protocol_create_at(
        &project_base(&projects_state)?,
        tools::literature::LiteratureSearchProtocolCreateInput { protocol },
    )
}

#[tauri::command]
pub fn literature_protocol_preview(
    projects_state: State<ProjectState>,
    protocol_id: String,
) -> Result<Value, String> {
    tools::literature::literature_search_preview_at(
        &project_base(&projects_state)?,
        tools::literature::LiteratureSearchPreviewInput { protocol_id },
    )
}

/// Execute only after Desktop has displayed the provider scope and the user
/// has explicitly confirmed it. Progress events are advisory; the shared
/// runtime checkpoints every source transition independently of this window.
#[tauri::command]
pub async fn literature_protocol_execute(
    app: tauri::AppHandle,
    projects_state: State<'_, ProjectState>,
    protocol_id: String,
    confirmation: String,
    max_results: Option<usize>,
    resume_run_id: Option<String>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    tauri::async_runtime::spawn_blocking(move || {
        tools::literature::literature_search_execute_at(
            &base,
            tools::literature::LiteratureSearchExecuteInput {
                protocol_id,
                confirmation,
                max_results,
                resume_run_id,
            },
            |progress| {
                let _ = app.emit("literature-search-progress", progress.clone());
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn literature_download_pdf(
    projects_state: State<'_, ProjectState>,
    url: String,
    file_name: String,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    tauri::async_runtime::spawn_blocking(move || {
        tools::literature::download_pdf_at(&base, &url, &file_name, None)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn literature_library_upsert(
    projects_state: State<ProjectState>,
    papers: Vec<Value>,
    query: String,
    sources: Vec<String>,
) -> Result<Value, String> {
    let search = tools::literature::UpsertSearch { query, sources };
    let stats = tools::literature::library_upsert_at(
        &project_base(&projects_state)?,
        &papers,
        Some(&search),
    )?;
    serde_json::to_value(stats).map_err(|error| error.to_string())
}

const MAX_RAG_PDF_PAGES: usize = 10_000;
const MAX_RAG_EXTRACTED_CHARS: usize = 10_000_000;

fn extraction_from_rag_pages(pages: &[LiteratureRagPdfPage]) -> Result<PdfTextExtraction, String> {
    if pages.is_empty() {
        return Err("PDF extraction returned no pages".to_string());
    }
    if pages.len() > MAX_RAG_PDF_PAGES {
        return Err(format!(
            "PDF has too many pages to index safely ({} > {MAX_RAG_PDF_PAGES})",
            pages.len()
        ));
    }
    let mut supplied = pages.to_vec();
    supplied.sort_by_key(|page| page.page);
    let mut total_characters = 0usize;
    let mut normalized = Vec::with_capacity(supplied.len());
    let mut ocr_used = false;
    for (index, page) in supplied.into_iter().enumerate() {
        let expected = index + 1;
        if page.page != expected {
            return Err(format!(
                "PDF extraction pages must be unique and contiguous from page 1; expected page {expected}, got {}",
                page.page
            ));
        }
        let source = match page.source.trim() {
            "embedded" => "embedded",
            "ocr" => {
                ocr_used = true;
                "ocr"
            }
            "empty" => "empty",
            value => return Err(format!("unsupported PDF page source: {value}")),
        };
        total_characters = total_characters.saturating_add(page.text.chars().count());
        if total_characters > MAX_RAG_EXTRACTED_CHARS {
            return Err(format!(
                "PDF extracted text exceeds the {MAX_RAG_EXTRACTED_CHARS}-character indexing limit"
            ));
        }
        normalized.push(PdfPageText {
            page: page.page,
            text: page.text.trim().to_string(),
            source,
        });
    }
    finalize_pdf_extraction(normalized, ocr_used, Vec::new())
}

fn extract_pdf_text_by_page(path: &Path) -> Result<PdfTextExtraction, String> {
    let rust_pages = pdf_extract::extract_text_by_pages(path)
        .map(|pages| {
            pages
                .into_iter()
                .map(|text| text.replace('\0', "").trim().to_string())
                .collect::<Vec<_>>()
        })
        .map_err(|error| format!("bundled PDF text extraction failed: {error}"));
    let page_count = rust_pages
        .as_ref()
        .ok()
        .map(Vec::len)
        .filter(|count| *count > 0)
        .map(Ok)
        .unwrap_or_else(|| pdf_page_count(path))?;
    if page_count > MAX_RAG_PDF_PAGES {
        return Err(format!(
            "PDF has too many pages to index safely ({page_count} > {MAX_RAG_PDF_PAGES})"
        ));
    }
    let mut warnings = Vec::new();
    if let Err(error) = &rust_pages {
        warnings.push(error.clone());
    }
    let mut pages = Vec::with_capacity(page_count);
    let mut ocr_used = false;

    for page in 1..=page_count {
        let bundled = rust_pages
            .as_ref()
            .ok()
            .and_then(|pages| pages.get(page - 1))
            .cloned()
            .unwrap_or_default();
        let embedded = if has_readable_text(&bundled) {
            bundled
        } else {
            pdftotext_page(path, page).unwrap_or_else(|error| {
                if page == 1 && !warnings.contains(&error) {
                    warnings.push(error);
                }
                String::new()
            })
        };
        if has_readable_text(&embedded) {
            pages.push(PdfPageText {
                page,
                text: embedded.trim().to_string(),
                source: "embedded",
            });
            continue;
        }

        match ocr_pdf_page(path, page) {
            Ok(text) if has_readable_text(&text) => {
                ocr_used = true;
                pages.push(PdfPageText {
                    page,
                    text: text.trim().to_string(),
                    source: "ocr",
                });
            }
            Ok(_) => pages.push(PdfPageText {
                page,
                text: String::new(),
                source: "empty",
            }),
            Err(error) => {
                if !warnings.contains(&error) {
                    warnings.push(error);
                }
                pages.push(PdfPageText {
                    page,
                    text: String::new(),
                    source: "empty",
                });
            }
        }
    }

    finalize_pdf_extraction(pages, ocr_used, warnings)
}

fn finalize_pdf_extraction(
    pages: Vec<PdfPageText>,
    ocr_used: bool,
    mut warnings: Vec<String>,
) -> Result<PdfTextExtraction, String> {
    let readable_pages = pages
        .iter()
        .filter(|page| has_readable_text(&page.text))
        .count();
    if readable_pages == 0 {
        return Err(format!(
            "PDF has no readable text after embedded extraction and OCR. {}",
            warnings.join(" ")
        ));
    }
    let missing_pages = pages
        .iter()
        .filter(|page| !has_readable_text(&page.text))
        .map(|page| page.page)
        .collect::<Vec<_>>();
    if !missing_pages.is_empty() {
        warnings.push(format!(
            "No readable text could be recovered from pages: {}",
            missing_pages
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    let text = pages
        .iter()
        .filter(|page| has_readable_text(&page.text))
        .map(|page| format!("[[PAGE {}]]\n{}", page.page, page.text))
        .collect::<Vec<_>>()
        .join("\n\n");
    let characters = text.chars().count();
    if characters > MAX_RAG_EXTRACTED_CHARS {
        return Err(format!(
            "PDF extracted text exceeds the {MAX_RAG_EXTRACTED_CHARS}-character indexing limit"
        ));
    }
    Ok(PdfTextExtraction {
        text,
        pages,
        total_characters: characters,
        extracted_characters: characters,
        truncated: !missing_pages.is_empty(),
        ocr_used,
        missing_pages,
        warnings,
    })
}

/// Infer a conservative display title from the first readable PDF lines. A
/// user-supplied title always wins; this is only a local fallback for a file
/// dropped directly into the literature library.
fn infer_pdf_title(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .find(|line| {
            let lower = line.to_ascii_lowercase();
            (12..=240).contains(&line.chars().count())
                && !lower.starts_with("abstract")
                && !lower.starts_with("introduction")
                && !lower.starts_with("keywords")
                && !lower.starts_with("doi")
                && !lower.starts_with("arxiv")
                && !lower.starts_with("copyright")
                && !line
                    .chars()
                    .all(|character| character.is_ascii_digit() || character.is_ascii_punctuation())
        })
}

/// Extract the first DOI-like token from readable PDF text. It is passed into
/// the canonical identity resolver, which may safely merge an already-known
/// work instead of creating a second local record.
fn infer_pdf_doi(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|token| {
        let token = token.trim_matches(|character: char| {
            matches!(
                character,
                '.' | ',' | ';' | ':' | ')' | ']' | '}' | '"' | '\''
            )
        });
        let index = token.to_ascii_lowercase().find("10.")?;
        let candidate = token[index..].trim_end_matches(|character: char| {
            matches!(character, '.' | ',' | ';' | ')' | ']' | '}')
        });
        let (prefix, suffix) = candidate.split_once('/')?;
        let registrant = prefix.strip_prefix("10.")?;
        (registrant.len() >= 4
            && registrant.len() <= 9
            && registrant
                .chars()
                .all(|character| character.is_ascii_digit())
            && !suffix.is_empty())
        .then(|| candidate.to_string())
    })
}

fn pdf_page_count(path: &Path) -> Result<usize, String> {
    let pdfinfo = crate::process::hidden_command("pdfinfo")
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    if let Ok(output) = pdfinfo {
        if output.status.success() {
            if let Some(count) = String::from_utf8_lossy(&output.stdout)
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Pages:")
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .filter(|count| *count > 0)
            {
                return Ok(count);
            }
        }
    }

    let output = crate::process::hidden_command("pdftotext")
        .args(["-layout", "-enc", "UTF-8"])
        .arg(path)
        .arg("-")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Poppler pdfinfo or pdftotext is required: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not determine PDF page count: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .matches('\u{c}')
        .count()
        .max(1))
}

fn pdftotext_page(path: &Path, page: usize) -> Result<String, String> {
    let output = crate::process::hidden_command("pdftotext")
        .args([
            "-f",
            &page.to_string(),
            "-l",
            &page.to_string(),
            "-layout",
            "-enc",
            "UTF-8",
        ])
        .arg(path)
        .arg("-")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("pdftotext is unavailable: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "pdftotext failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .replace('\u{c}', "")
        .trim()
        .to_string())
}

fn ocr_pdf_page(path: &Path, page: usize) -> Result<String, String> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let temp_dir = std::env::temp_dir().join(format!(
        "somniq-pdf-ocr-{}-{page}-{nonce}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
    let prefix = temp_dir.join("page");
    let image = prefix.with_extension("png");
    let render = crate::process::hidden_command("pdftoppm")
        .args([
            "-f",
            &page.to_string(),
            "-l",
            &page.to_string(),
            "-singlefile",
            "-r",
            "180",
            "-png",
        ])
        .arg(path)
        .arg(&prefix)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("pdftoppm is required for OCR: {error}"))?;
    if !render.status.success() {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!(
            "pdftoppm failed: {}",
            String::from_utf8_lossy(&render.stderr).trim()
        ));
    }

    let result = tesseract_ocr(&image).or_else(|tesseract_error| {
        #[cfg(windows)]
        {
            windows_ocr(&image).map_err(|windows_error| {
                format!("{tesseract_error}; Windows OCR failed: {windows_error}")
            })
        }
        #[cfg(not(windows))]
        {
            Err(tesseract_error)
        }
    });
    let _ = std::fs::remove_dir_all(&temp_dir);
    result
}

fn tesseract_ocr(image: &Path) -> Result<String, String> {
    let output = crate::process::hidden_command("tesseract")
        .arg(image)
        .arg("stdout")
        .arg("-l")
        .arg("eng")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Tesseract OCR is unavailable: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Tesseract OCR failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(windows)]
fn windows_ocr(image: &Path) -> Result<String, String> {
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
})[0]
function Await($operation, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait()
  $task.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:ARIS_OCR_IMAGE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'Windows OCR language pack is unavailable' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$result.Text
"#;
    let output = crate::process::hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("ARIS_OCR_IMAGE", image)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn has_readable_text(text: &str) -> bool {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .count()
        >= 8
}

#[cfg(test)]
#[path = "tests/literature.rs"]
mod tests;
