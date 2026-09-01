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
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

use runtime::{
    ContentBlock, ConversationMessage, PermissionMode, RuntimeError, RuntimeFeatureConfig, Session,
    ToolError, ToolExecutor,
};

use crate::projects::{self, ProjectState};

fn project_base(projects_state: &ProjectState) -> Result<std::path::PathBuf, String> {
    projects::current_project_path(projects_state)
}

/// Run store work on Tauri's blocking pool.
///
/// A `#[tauri::command]` declared as a plain `fn` is dispatched with
/// `ExecutionContext::Blocking`, which runs it on the main thread; only an
/// `async fn` reaches the pool. Every command that opens the literature store
/// can touch the whole library, and on a large one that is seconds of work —
/// which on the main thread is a window the OS marks as not responding, not
/// merely a slow load.
async fn off_main_thread<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

type CancelFlags = Mutex<HashMap<String, Arc<AtomicBool>>>;

/// Cancellation flags for in-flight one-shot literature calls, keyed by the
/// caller-minted request id. These calls run on `spawn_blocking` with no session
/// and no turn registry, so without this there is nothing to interrupt them.
fn llm_cancellations() -> &'static CancelFlags {
    static REGISTRY: OnceLock<CancelFlags> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cancellation flags for in-flight protocol search runs. Kept separate from the
/// model-call registry so stopping a search cannot interrupt a screening call
/// that happens to reuse an id, and vice versa.
fn search_cancellations() -> &'static CancelFlags {
    static REGISTRY: OnceLock<CancelFlags> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Publishes a request's cancellation flag for the lifetime of the call and
/// withdraws it on drop, so a cancel that arrives after the call finished cannot
/// interrupt an unrelated later request that reuses the id.
struct CancelRegistration {
    registry: &'static CancelFlags,
    request_id: Option<String>,
    flag: Arc<AtomicBool>,
}

impl CancelRegistration {
    fn new(request_id: Option<&str>) -> Self {
        Self::in_registry(llm_cancellations(), request_id)
    }

    fn in_registry(registry: &'static CancelFlags, request_id: Option<&str>) -> Self {
        let flag = Arc::new(AtomicBool::new(false));
        let request_id = request_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(id) = &request_id {
            if let Ok(mut registry) = registry.lock() {
                registry.insert(id.clone(), flag.clone());
            }
        }
        Self {
            registry,
            request_id,
            flag,
        }
    }

    fn flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }
}

impl Drop for CancelRegistration {
    fn drop(&mut self) {
        if let Some(id) = &self.request_id {
            if let Ok(mut registry) = self.registry.lock() {
                registry.remove(id);
            }
        }
    }
}

fn raise_cancel_flag(registry: &'static CancelFlags, request_id: &str) -> bool {
    let Ok(registry) = registry.lock() else {
        return false;
    };
    match registry.get(request_id.trim()) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// Interrupts an in-flight literature/workflow model call. Returns `false` when
/// the id is unknown — the request already finished, or has not started yet.
/// Callers that batch many requests must also stop their own loop; this only
/// unwinds the call that is currently streaming.
#[tauri::command]
pub fn literature_llm_cancel(request_id: String) -> bool {
    raise_cancel_flag(llm_cancellations(), &request_id)
}

/// Stops an in-flight protocol search run. Returns `false` when the id is
/// unknown — the run already finished, or has not started yet.
///
/// The run stops at the next source, query variant, or provider page boundary
/// and is finished as `partial`: everything already retrieved stays in the
/// SearchRun with its cursors, so the same protocol can be continued later.
#[tauri::command]
pub fn literature_search_cancel(request_id: String) -> bool {
    raise_cancel_flag(search_cancellations(), &request_id)
}

/// Aborts a stream as soon as the request's flag is set. Mirrors the chat
/// surface's observer: the executor polls `is_cancelled` between chunks, and the
/// delta guards unwind a stream that is already mid-chunk.
struct CancellableObserver {
    cancelled: Arc<AtomicBool>,
}

impl aris_executor::StreamObserver for CancellableObserver {
    fn on_text_delta(&mut self, _text: &str) -> Result<(), RuntimeError> {
        self.check()
    }

    fn on_thinking_delta(&mut self, _thinking: &str) -> Result<(), RuntimeError> {
        self.check()
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

impl CancellableObserver {
    fn check(&self) -> Result<(), RuntimeError> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err(RuntimeError::new("interrupted by user"))
        } else {
            Ok(())
        }
    }
}

/// One-shot LLM completion on the configured executor — no tools, no
/// streaming, no session persistence. Returns the assistant's text (callers
/// ask for JSON and parse it). Errors when no executor is configured, which
/// the frontend treats as "fall back to the heuristic".
///
/// `request_id` is optional; supplying one makes the call cancellable through
/// `literature_llm_cancel`.
#[tauri::command]
pub async fn literature_llm(
    system: String,
    prompt: String,
    model: Option<String>,
    request_id: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let registration = CancelRegistration::new(request_id.as_deref());
        run_oneshot_with_model_and_observer(
            &system,
            ConversationMessage::user_text(prompt),
            model.as_deref(),
            Box::new(CancellableObserver {
                cancelled: registration.flag(),
            }),
        )
        .map(|(text, _model)| text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A one-shot Executor call that exposes its streamed reasoning/text deltas to
/// the workflow UI. The request id is supplied by the UI so concurrent runs do
/// not leak activity into each other's progress panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureLlmResponse {
    pub text: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiteratureLlmProgressEvent {
    request_id: String,
    phase: String,
    text: Option<String>,
    model: Option<String>,
}

fn emit_llm_progress(
    app: &AppHandle,
    request_id: &str,
    phase: &str,
    text: Option<String>,
    model: Option<String>,
) {
    let _ = app.emit(
        "literature-llm-progress",
        LiteratureLlmProgressEvent {
            request_id: request_id.to_string(),
            phase: phase.to_string(),
            text,
            model,
        },
    );
}

struct ProgressObserver {
    app: AppHandle,
    request_id: String,
    cancelled: Arc<AtomicBool>,
}

impl ProgressObserver {
    fn check(&self) -> Result<(), RuntimeError> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err(RuntimeError::new("interrupted by user"))
        } else {
            Ok(())
        }
    }
}

impl aris_executor::StreamObserver for ProgressObserver {
    fn on_text_delta(&mut self, text: &str) -> Result<(), RuntimeError> {
        self.check()?;
        emit_llm_progress(
            &self.app,
            &self.request_id,
            "text",
            Some(text.to_string()),
            None,
        );
        Ok(())
    }

    fn on_thinking_delta(&mut self, thinking: &str) -> Result<(), RuntimeError> {
        self.check()?;
        emit_llm_progress(
            &self.app,
            &self.request_id,
            "thinking",
            Some(thinking.to_string()),
            None,
        );
        Ok(())
    }

    fn on_tool_call(&mut self, _id: &str, name: &str, input: &str) -> Result<(), RuntimeError> {
        emit_llm_progress(
            &self.app,
            &self.request_id,
            "tool",
            Some(format!("{name}: {input}")),
            None,
        );
        Ok(())
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[tauri::command]
pub async fn literature_llm_stream(
    app: AppHandle,
    system: String,
    prompt: String,
    model: Option<String>,
    request_id: String,
) -> Result<LiteratureLlmResponse, String> {
    let requested_model = model.filter(|value| !value.trim().is_empty());
    emit_llm_progress(
        &app,
        &request_id,
        "started",
        Some("Executor is preparing the constrained research task.".to_string()),
        requested_model.clone(),
    );
    let task_app = app.clone();
    let task_request_id = request_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let registration = CancelRegistration::new(Some(&task_request_id));
        run_oneshot_with_model_and_observer(
            &system,
            ConversationMessage::user_text(prompt),
            requested_model.as_deref(),
            Box::new(ProgressObserver {
                app: task_app,
                request_id: task_request_id,
                cancelled: registration.flag(),
            }),
        )
    })
    .await
    .map_err(|error| error.to_string())?;

    match result {
        Ok((text, resolved_model)) => {
            emit_llm_progress(
                &app,
                &request_id,
                "completed",
                None,
                Some(resolved_model.clone()),
            );
            Ok(LiteratureLlmResponse {
                text,
                model: resolved_model,
            })
        }
        Err(error) => {
            emit_llm_progress(&app, &request_id, "failed", Some(error.clone()), None);
            Err(error)
        }
    }
}

/// Independent literature judgment through ARIS' built-in `LlmReview` tool.
/// This deliberately uses the configured reviewer instead of the normal chat
/// executor so screening is an independent review step.
///
/// `request_id` is optional; supplying one makes the call cancellable through
/// `literature_llm_cancel`.
#[tauri::command]
pub async fn literature_review_llm(
    system: String,
    prompt: String,
    request_id: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_review_oneshot_cancellable(&system, &prompt, request_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn run_review_oneshot(system: &str, prompt: &str) -> Result<String, String> {
    run_review_oneshot_cancellable(system, prompt, None)
}

pub(crate) fn run_review_oneshot_cancellable(
    system: &str,
    prompt: &str,
    request_id: Option<&str>,
) -> Result<String, String> {
    crate::config::apply_reviewer_environment(true);
    let review_skill = tools::skill_markdown("research-review")
        .unwrap_or_else(|| "Use evidence-first independent research review.".to_string());
    let prompt = format!(
        "{system}\n\nSomniQ built-in research-review skill instructions:\n{review_skill}\n\n\
         Apply those evidence-first independent review standards and return exactly \
         the output format requested below.\n\n{prompt}"
    );
    let registration = CancelRegistration::new(request_id);
    // `LlmReview` reaches the same reviewer as `execute_tool`, but through the
    // observed entry point so the stream unwinds when the flag is set.
    tools::execute_llm_review_observed_with_cancel(prompt, None, registration.flag())
        .map(|run| run.text)
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
    run_oneshot_with_model_and_observer(system, message, requested_model, Box::new(SilentObserver))
}

fn run_oneshot_with_model_and_observer(
    system: &str,
    message: ConversationMessage,
    requested_model: Option<&str>,
    observer: Box<dyn aris_executor::StreamObserver>,
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
                "LLM model `{model}` is not configured; select a verified model in Settings"
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
    )?
    // These are isolated, caller-specified transformation/JSON tasks, not
    // open-ended research answers. The retrieval guard prepends a status and
    // evidence verdict to research-looking source text, which corrupts
    // translations (and structured JSON) before it reaches the caller.
    .without_retrieval_guard();
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
    let allowed_roots = [
        tools::layout::papers_dir_at(base),
        tools::layout::slides_dir_at(base),
        tools::layout::poster_dir_at(base),
        tools::layout::reports_dir_at(base),
        base.join("papers"),
        base.join("slides"),
        base.join("poster"),
        base.join("posters"),
        base.join("reports"),
    ]
    .into_iter()
    .filter_map(|directory| directory.canonicalize().ok())
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
            "PDF must be a local file inside a managed SomniQ artifact directory".to_string(),
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
    let asset_dir = tools::layout::papers_dir_at(base)
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
    let attachments_dir = tools::layout::papers_dir_at(base).join("attachments");
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
        relative_path: PathBuf::from(tools::layout::PROJECT_DATA_DIR)
            .join(tools::layout::PAPERS_DIR)
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
    let papers_dir = tools::layout::papers_dir_at(base);
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
    let relative = PathBuf::from(tools::layout::PROJECT_DATA_DIR)
        .join(tools::layout::PAPERS_DIR)
        .join(
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
                time_window: None,
                sort_order: None,
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
    let attachment_roots = [
        tools::layout::papers_dir_at(&base),
        base.join(tools::layout::PAPERS_DIR),
    ]
    .into_iter()
    .filter_map(|directory| directory.canonicalize().ok())
    .collect::<Vec<_>>();
    let path = base
        .join(relative)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !attachment_roots.iter().any(|root| path.starts_with(root)) {
        return Err("attachment must be a local file inside the literature library".to_string());
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

fn open_external_file(path: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("attachment path must point to a file".to_string());
    }
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

/// Open a linked file whose original location is outside the project. The
/// path comes from an explicit file picker/import record and is never copied
/// implicitly.
#[tauri::command]
pub fn literature_attachment_open_external(source_path: String) -> Result<(), String> {
    let path = Path::new(source_path.trim());
    if source_path.trim().is_empty() {
        return Err("attachment path is empty".to_string());
    }
    open_external_file(path)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureAttachmentStatus {
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<i64>,
}

/// Check whether a linked external attachment is still available without
/// opening it. Missing files are a normal lifecycle state, not a command
/// failure, so the UI can render a recoverable "missing" badge.
#[tauri::command]
pub fn literature_attachment_status(
    projects_state: State<ProjectState>,
    source_path: String,
) -> Result<LiteratureAttachmentStatus, String> {
    let trimmed = source_path.trim();
    if trimmed.is_empty() {
        return Ok(LiteratureAttachmentStatus {
            exists: false,
            bytes: None,
            mtime: None,
        });
    }
    let raw_path = Path::new(trimmed);
    let path = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        match resolve_attachment_path(&projects_state, trimmed) {
            Ok(path) => path,
            Err(_) => {
                return Ok(LiteratureAttachmentStatus {
                    exists: false,
                    bytes: None,
                    mtime: None,
                });
            }
        }
    };
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_secs() as i64);
            Ok(LiteratureAttachmentStatus {
                exists: true,
                bytes: Some(metadata.len()),
                mtime,
            })
        }
        Ok(_) | Err(_) => Ok(LiteratureAttachmentStatus {
            exists: false,
            bytes: None,
            mtime: None,
        }),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureAttachmentText {
    pub path: String,
    pub source_name: String,
    pub mime_type: String,
    pub content: String,
}

const MAX_READABLE_ATTACHMENT_BYTES: u64 = 16 * 1024 * 1024;

/// Persist text extracted by the embedded reader for the selected attachment.
/// The UI has already performed the explicit read, so this command only
/// writes the bounded text to the canonical attachment index.
#[tauri::command]
pub fn literature_index_attachment_text(
    projects_state: State<ProjectState>,
    record_id: String,
    attachment_id: String,
    text: String,
) -> Result<(), String> {
    let base = project_base(&projects_state)?;
    tools::literature::library_index_attachment_text_for_record_at(
        &base,
        &record_id,
        &attachment_id,
        &text,
    )
}

fn readable_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" | "xhtml" => "text/html",
        "epub" => "application/xhtml+xml",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        _ => "text/plain",
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn html_body(content: &str) -> &str {
    let lower = content.to_ascii_lowercase();
    let Some(body_start) = lower.find("<body") else {
        return content;
    };
    let Some(content_start) = lower[body_start..].find('>') else {
        return content;
    };
    let content_start = body_start + content_start + 1;
    let content_end = lower[content_start..]
        .find("</body>")
        .map(|offset| content_start + offset)
        .unwrap_or(content.len());
    &content[content_start..content_end]
}

fn read_epub_preview(path: &Path, display_path: &str) -> Result<LiteratureAttachmentText, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("invalid EPUB package: {error}"))?;
    let mut chapters = Vec::<(String, String)>::new();
    let mut total_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("failed to inspect EPUB entry: {error}"))?;
        let name = entry.name().to_string();
        let lower_name = name.to_ascii_lowercase();
        if entry.is_dir()
            || name.starts_with("/")
            || lower_name.starts_with("meta-inf/")
            || !(lower_name.ends_with(".xhtml")
                || lower_name.ends_with(".html")
                || lower_name.ends_with(".htm"))
        {
            continue;
        }
        total_bytes = total_bytes.saturating_add(entry.size());
        if total_bytes > MAX_READABLE_ATTACHMENT_BYTES {
            return Err("EPUB readable content is larger than the 16 MB preview limit".to_string());
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| format!("failed to read EPUB document: {error}"))?;
        chapters.push((name, String::from_utf8_lossy(&bytes).into_owned()));
    }
    if chapters.is_empty() {
        return Err("EPUB package contains no readable XHTML/HTML document".to_string());
    }
    let body = chapters
        .iter()
        .map(|(name, content)| {
            format!(
                "<section class=\"somniq-epub-section\"><h2>{}</h2>{}</section>",
                escape_html(name),
                html_body(content),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let content = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>body{{font:16px/1.65 system-ui,sans-serif;max-width:900px;margin:0 auto;padding:24px;color:#1f2937}}.somniq-epub-section{{padding-bottom:32px;margin-bottom:32px;border-bottom:1px solid #e5e7eb}}h2{{font-size:18px;color:#4f46e5}}</style></head><body>{body}</body></html>"
    );
    Ok(LiteratureAttachmentText {
        path: display_path.to_string(),
        source_name: format!("EPUB · {} document(s)", chapters.len()),
        mime_type: "text/html".to_string(),
        content,
    })
}

fn read_attachment_text(path: &Path, display_path: &str) -> Result<LiteratureAttachmentText, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "epub" {
        return read_epub_preview(path, display_path);
    }

    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_READABLE_ATTACHMENT_BYTES {
        return Err("text attachment must be a file no larger than 16 MB".to_string());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("failed to read text attachment: {error}"))?;
    Ok(LiteratureAttachmentText {
        path: display_path.to_string(),
        source_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Attachment")
            .to_string(),
        mime_type: readable_mime_type(&path).to_string(),
        content,
    })
}

/// Read local HTML/text resources in the embedded reader. Project-local paths
/// are resolved below the literature directory so the command cannot traverse
/// outside the project.
#[tauri::command]
pub fn literature_attachment_read_text(
    projects_state: State<ProjectState>,
    relative_path: String,
) -> Result<LiteratureAttachmentText, String> {
    let path = resolve_attachment_path(&projects_state, &relative_path)?;
    read_attachment_text(&path, &relative_path)
}

/// Read a linked file only after the researcher explicitly chose it through
/// the attachment picker. This mirrors the existing external-open action but
/// keeps text/HTML/EPUB inside the same reader when the file is available.
#[tauri::command]
pub fn literature_attachment_read_external_text(
    source_path: String,
) -> Result<LiteratureAttachmentText, String> {
    let trimmed = source_path.trim();
    if trimmed.is_empty() {
        return Err("attachment path is empty".to_string());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("external attachment path must be absolute".to_string());
    }
    read_attachment_text(path, trimmed)
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

/// Reading a large library decodes every canonical record, so this must not be
/// a blocking command: Tauri runs those on the main thread, where the cost
/// shows up as a frozen window rather than a slow load.
#[tauri::command]
pub async fn literature_load(
    projects_state: State<'_, ProjectState>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_load_at(&base)).await
}

/// Read the normalized Zotero-style relationship graph for new Desktop
/// surfaces. The existing load command remains the compatibility projection
/// used by the current UI.
#[tauri::command]
pub async fn literature_library_relations(
    projects_state: State<'_, ProjectState>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let relations = off_main_thread(move || tools::literature::library_relations_at(&base)).await?;
    serde_json::to_value(relations).map_err(|error| error.to_string())
}

/// Read the complete local Zotero-shaped data plane, including child items
/// and normalized fields/creators/relations.
#[tauri::command]
pub async fn literature_library_model(
    projects_state: State<'_, ProjectState>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let model = off_main_thread(move || tools::literature::library_model_at(&base)).await?;
    serde_json::to_value(model).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn literature_update_item(
    projects_state: State<'_, ProjectState>,
    item_id: String,
    patch: Value,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_update_item_at(&base, &item_id, &patch)).await
}

#[tauri::command]
pub async fn literature_create_item(
    projects_state: State<'_, ProjectState>,
    item: Value,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_create_item_at(&base, &item)).await
}

#[tauri::command]
pub async fn literature_trash_items(
    projects_state: State<'_, ProjectState>,
    item_ids: Vec<String>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_trash_items_at(&base, &item_ids)).await
}

#[tauri::command]
pub async fn literature_restore_items(
    projects_state: State<'_, ProjectState>,
    item_ids: Vec<String>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_restore_items_at(&base, &item_ids)).await
}

#[tauri::command]
pub async fn literature_permanently_delete_items(
    projects_state: State<'_, ProjectState>,
    item_ids: Vec<String>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || {
        tools::literature::library_permanently_delete_items_at(&base, &item_ids)
    })
    .await
}

#[tauri::command]
pub async fn literature_update_saved_searches(
    projects_state: State<'_, ProjectState>,
    searches: Value,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_update_saved_searches_at(&base, &searches))
        .await
}

/// Read the project's library preferences (attachment naming, and whether
/// imports are renamed automatically).
#[tauri::command]
pub async fn literature_preferences(
    projects_state: State<'_, ProjectState>,
) -> Result<runtime::LibraryPreferences, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_preferences_at(&base)).await
}

/// Persist library preferences. The normalized values are returned so the UI
/// shows what was actually stored rather than what the user typed.
#[tauri::command]
pub async fn literature_set_preferences(
    projects_state: State<'_, ProjectState>,
    preferences: runtime::LibraryPreferences,
) -> Result<runtime::LibraryPreferences, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_set_preferences_at(&base, &preferences)).await
}

/// Rename local attachments to the project's naming template. `dry_run` is the
/// preview the UI shows before any file moves; nothing is written for it.
#[tauri::command]
pub async fn literature_rename_attachments(
    projects_state: State<'_, ProjectState>,
    record_ids: Vec<String>,
    dry_run: bool,
) -> Result<tools::literature::AttachmentRenameReport, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || {
        tools::literature::library_rename_attachments_at(&base, &record_ids, dry_run)
    })
    .await
}

/// Replace the normalized Library collection tree and refresh the
/// compatibility projection used by older UI consumers.
#[tauri::command]
pub async fn literature_update_collections(
    projects_state: State<'_, ProjectState>,
    collections: Value,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_update_collections_at(&base, &collections))
        .await
}

/// Update only one item's normalized relationships. Bibliographic metadata,
/// workflow decisions, and manuscript artifacts are deliberately outside this
/// command's write set.
#[tauri::command]
pub async fn literature_update_relations(
    projects_state: State<'_, ProjectState>,
    record_id: String,
    relations: Value,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || {
        tools::literature::library_update_relations_at(&base, &record_id, &relations)
    })
    .await
}

/// The SQLite store is canonical; `papers/library.json` exists only as a
/// compatibility projection for existing Desktop, CLI, and skill clients.
///
/// `include_health` is opt-in because the integrity check reads the whole
/// database file. The Literature footer polls this status whenever the paper
/// or saved-search count changes, so it asks for the cheap variant and
/// requests the health report once, separately.
#[tauri::command]
pub async fn literature_storage_status(
    projects_state: State<'_, ProjectState>,
    include_health: Option<bool>,
) -> Result<tools::literature::LiteratureStorageStatus, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || {
        tools::literature::library_storage_status_with(&base, include_health.unwrap_or(false))
    })
    .await
}

/// Create a consistent copy of the canonical SQLite store.  This intentionally
/// backs up the database rather than the legacy `papers/library.json` export.
#[tauri::command]
pub async fn literature_storage_backup(
    projects_state: State<'_, ProjectState>,
) -> Result<runtime::literature::LiteratureBackup, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_create_backup_at(&base)).await
}

/// Search titles, abstracts and local literature metadata through the SQLite
/// FTS5 index. This is read-only and never treats the JSON projection as the
/// source of truth.
#[tauri::command]
pub async fn literature_full_text_search(
    projects_state: State<'_, ProjectState>,
    query: String,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || {
        // The Literature view filters papers it already holds, so it needs the
        // ranked ids, not another copy of the records.
        tools::literature::library_full_text_search_page_with(&base, &query, limit, offset, false)
    })
    .await
}

#[tauri::command]
pub fn literature_search_protocol_create(
    projects_state: State<ProjectState>,
    protocol: runtime::SearchProtocolDraft,
) -> Result<Value, String> {
    tools::literature::literature_search_protocol_create_at(
        &project_base(&projects_state)?,
        tools::literature::LiteratureSearchProtocolCreateInput { protocol },
    )
}

#[tauri::command]
pub fn literature_search_protocol_preview(
    projects_state: State<ProjectState>,
    protocol_id: String,
) -> Result<Value, String> {
    tools::literature::literature_search_preview_at(
        &project_base(&projects_state)?,
        tools::literature::LiteratureSearchPreviewInput { protocol_id },
    )
}

#[tauri::command]
pub async fn literature_search_protocol_execute(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    protocol_id: String,
    confirmation: String,
    continue_run_id: Option<String>,
    variant_budgets: Option<std::collections::BTreeMap<String, usize>>,
    request_id: Option<String>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let progress_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // A protocol run is minutes of provider paging on a blocking thread that
        // nothing else can interrupt, so publish a stop flag for its lifetime
        // when the caller supplied an id to stop it by.
        let registration =
            CancelRegistration::in_registry(search_cancellations(), request_id.as_deref());
        let cancelled = registration.flag();
        tools::literature::literature_search_execute_at_with_cancel(
            &base,
            tools::literature::LiteratureSearchExecuteInput {
                protocol_id,
                confirmation,
                max_results: None,
                resume_run_id: None,
                continue_run_id,
                variant_budgets,
            },
            |progress| {
                let _ = progress_app.emit("literature-search-progress", progress.clone());
            },
            &move || cancelled.load(Ordering::SeqCst),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn literature_duplicate_candidates(
    projects_state: State<'_, ProjectState>,
) -> Result<Vec<runtime::literature::LiteratureDuplicateCandidate>, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_duplicate_candidates_at(&base)).await
}

#[tauri::command]
pub async fn literature_merge_duplicates(
    projects_state: State<'_, ProjectState>,
    primary_record_id: String,
    duplicate_record_id: String,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || {
        tools::literature::library_merge_duplicates_at(
            &base,
            &primary_record_id,
            &duplicate_record_id,
        )
    })
    .await
}

/// Every save re-projects the whole library, so this is blocking work too.
#[tauri::command]
pub async fn literature_apply_delta(
    projects_state: State<'_, ProjectState>,
    delta: tools::literature::LiteratureLibraryDelta,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_apply_delta_at(&base, &delta)).await
}

#[tauri::command]
pub async fn literature_import_bibliography(
    projects_state: State<'_, ProjectState>,
    input: tools::literature::LiteratureBibliographyImportInput,
) -> Result<tools::literature::LiteratureBibliographyImportReport, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_import_bibliography_at(&base, &input)).await
}

/// Render one selected set of canonical records as a standard bibliography
/// interchange format. The caller chooses any destination separately, keeping
/// the operation local and explicit.
#[tauri::command]
pub async fn literature_export_bibliography(
    projects_state: State<'_, ProjectState>,
    input: tools::literature::LiteratureBibliographyExportInput,
) -> Result<tools::literature::LiteratureBibliographyExportReport, String> {
    let base = project_base(&projects_state)?;
    off_main_thread(move || tools::literature::library_export_bibliography_at(&base, &input)).await
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
pub async fn literature_download_pdf(
    projects_state: State<'_, ProjectState>,
    url: String,
    file_name: String,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    tauri::async_runtime::spawn_blocking(move || {
        match tools::literature::download_pdf_at(&base, &url, &file_name, None) {
            Ok(download) => Ok(download),
            Err(http_error) => {
                let Some(task) = tools::literature::browser_download_task_for_url(&url, &file_name)
                else {
                    return Err(http_error);
                };
                crate::playwright_pdf::download_pdf_at(&base, task, &file_name, None).map_err(
                    |browser_error| {
                        format!(
                            "HTTP PDF download failed: {http_error}; Playwright fallback failed: {browser_error}"
                        )
                    },
                )
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
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
