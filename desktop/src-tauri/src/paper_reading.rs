//! The paper controller owns page scheduling; every model turn runs through
//! the ordinary Somni Chat engine under a source-only execution context.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use base64::Engine;
use runtime::{
    literature::open_literature_store_at,
    paper_reading::{
        content_sha256, page_perception_prompt, OriginalPageEvidence, PaperReadingCoverage,
        PaperReadingRun, PaperReadingStatus,
    },
    ContentBlock, ConversationMessage,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::projects::{self, ProjectState};
mod guide;

const MAX_PDF_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PAGE_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RUN_IMAGE_BYTES: u64 = 256 * 1024 * 1024;
// Serialize source file + metadata commits. This is separate from the shared
// atomic-file path locks, so nested atomic writes cannot deadlock a lock stripe.
static SOURCE_WRITES: Mutex<()> = Mutex::new(());
type ActiveRuns = Mutex<HashMap<(String, String), Arc<AtomicBool>>>;

fn active_runs() -> &'static ActiveRuns {
    static RUNS: OnceLock<ActiveRuns> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct RunGuard {
    key: (String, String),
    cancellation: Arc<AtomicBool>,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut runs) = active_runs().lock() {
            if runs
                .get(&self.key)
                .is_some_and(|flag| Arc::ptr_eq(flag, &self.cancellation))
            {
                runs.remove(&self.key);
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperReadingView {
    project_id: String,
    run: PaperReadingRun,
    coverage: PaperReadingCoverage,
    active: bool,
}

fn view(project_id: &str, mut run: PaperReadingRun) -> PaperReadingView {
    let coverage = run.coverage();
    // Original text remains in the authoritative store and model inputs. UI
    // progress projections need source identity, not another full PDF copy.
    for page in &mut run.pages {
        if let Some(source) = &mut page.source {
            source.embedded_text.clear();
        }
    }
    let active = active_runs()
        .lock()
        .ok()
        .is_some_and(|runs| runs.contains_key(&(project_id.to_owned(), run.id.clone())));
    PaperReadingView {
        project_id: project_id.into(),
        run,
        coverage,
        active,
    }
}

fn emit(app: &AppHandle, project_id: &str, run: PaperReadingRun) {
    let _ = app.emit("paper-reading-updated", view(project_id, run));
}

fn project(app: &AppHandle, project_id: Option<&str>) -> Result<(String, PathBuf), String> {
    let state = app.state::<ProjectState>();
    let id = match project_id {
        Some(id) => id.to_owned(),
        None => projects::active_project_id(state.inner())?,
    };
    let workspace = projects::project_path_for_id(state.inner(), &id)?;
    Ok((id, workspace))
}

fn validate_run_id(id: &str) -> Result<(), String> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid paper task ID".into());
    }
    Ok(())
}

fn artifact_dir(workspace: &Path, run_id: &str) -> Result<PathBuf, String> {
    validate_run_id(run_id)?;
    Ok(runtime::literature::literature_root_for(workspace)
        .join("artifacts")
        .join("paper-reading")
        .join(run_id))
}

fn load_run(workspace: &Path, run_id: &str) -> Result<PaperReadingRun, String> {
    validate_run_id(run_id)?;
    open_literature_store_at(workspace)?
        .paper_reading_run(run_id)?
        .ok_or_else(|| "Paper task not found in this project".into())
}

fn read_pdf(workspace: &Path, relative_path: &str) -> Result<Vec<u8>, String> {
    let path = crate::literature::resolve_pdf_path_at(workspace, relative_path)?;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_PDF_BYTES {
        return Err("This paper exceeds the 64 MiB input limit".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("PDF input exceeds its size limit".into());
    }
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparePaperInput {
    project_id: String,
    paper_id: String,
    relative_path: String,
    document_revision: String,
    language: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    regenerate: bool,
    #[serde(default)]
    run_id: Option<String>,
}

#[tauri::command]
pub async fn paper_reading_prepare(
    app: AppHandle,
    input: PreparePaperInput,
) -> Result<PaperReadingView, String> {
    let (project_id, workspace) = project(&app, Some(&input.project_id))?;
    let (model, executor_signature) =
        crate::engine::paper_reading_executor(input.model.as_deref())?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        let bytes = read_pdf(&workspace, &input.relative_path)?;
        let document_revision = content_sha256(&bytes);
        if document_revision != input.document_revision {
            return Err("The PDF changed; reload it before starting analysis".into());
        }
        let document = lopdf::Document::load_mem(&bytes)
            .map_err(|e| format!("Cannot read PDF page count: {e}"))?;
        let store = open_literature_store_at(&workspace)?;
        let paper = store
            .load_canonical_record(&input.paper_id)?
            .ok_or("Paper is not in this project's literature library")?;
        let metadata = paper
            .metadata
            .get("legacyLibrary")
            .unwrap_or(&paper.metadata);
        if metadata
            .get("pdf")
            .and_then(|pdf| pdf.get("path"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|path| path != input.relative_path)
        {
            return Err("PDF does not match the selected library paper".into());
        }
        let mut candidate = PaperReadingRun::new(
            input.paper_id,
            paper.title,
            input.relative_path,
            document_revision,
            document.get_pages().len(),
            model,
            executor_signature,
            input.language,
        )?;
        if !input.regenerate {
            if let Some(id) = input.run_id.as_deref() {
                let existing = load_run(&workspace, id)?;
                if existing.paper_id != candidate.paper_id
                    || existing.document_revision != candidate.document_revision
                    || existing.relative_path != candidate.relative_path
                    || existing.model != candidate.model
                    || existing.executor_signature != candidate.executor_signature
                    || existing.language != candidate.language
                {
                    return Err(
                        "Saved task does not match the requested paper/model configuration".into(),
                    );
                }
                return Ok(existing);
            }
            if let Some(existing) = store.paper_reading_run(&candidate.id)? {
                return Ok(existing);
            }
        } else {
            // A fresh version keeps all previous results and their evidence intact.
            candidate.id = content_sha256(
                format!(
                    "{}:{}",
                    candidate.id,
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(|e| e.to_string())?
                        .as_nanos()
                )
                .as_bytes(),
            );
        }
        let directory = artifact_dir(&workspace, &candidate.id)?;
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        runtime::write_file_atomically(&directory.join("source.pdf"), &bytes)
            .map_err(|e| e.to_string())?;
        match store.save_paper_reading_run(&candidate) {
            Ok(saved) => Ok(saved),
            Err(error) => store.paper_reading_run(&candidate.id)?.ok_or(error),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(view(&project_id, run))
}

#[tauri::command]
pub async fn paper_reading_get(
    app: AppHandle,
    project_id: String,
    paper_id: String,
    relative_path: String,
) -> Result<Option<PaperReadingView>, String> {
    let (project_id, workspace) = project(&app, Some(&project_id))?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        let revision = content_sha256(&read_pdf(&workspace, &relative_path)?);
        open_literature_store_at(&workspace)?.latest_paper_reading_run(&paper_id, &revision)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(run.map(|run| view(&project_id, run)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageSourceInput {
    project_id: String,
    run_id: String,
    page_index: usize,
    document_revision: String,
    image_base64: String,
    embedded_text: String,
    text_truncated: bool,
}

#[tauri::command]
pub async fn paper_reading_source(
    app: AppHandle,
    input: PageSourceInput,
) -> Result<PaperReadingView, String> {
    let (project_id, workspace) = project(&app, Some(&input.project_id))?;
    let run = tauri::async_runtime::spawn_blocking(move || save_page_source(&workspace, input))
        .await
        .map_err(|e| e.to_string())??;
    Ok(view(&project_id, run))
}

fn save_page_source(workspace: &Path, input: PageSourceInput) -> Result<PaperReadingRun, String> {
    validate_run_id(&input.run_id)?;
    if input.image_base64.len() > MAX_PAGE_IMAGE_BYTES * 4 / 3 + 4 {
        return Err("Page image exceeds the input budget".into());
    }
    let image = base64::engine::general_purpose::STANDARD
        .decode(&input.image_base64)
        .map_err(|_| "Invalid page image encoding")?;
    if image.len() > MAX_PAGE_IMAGE_BYTES
        || !image.starts_with(&[0xff, 0xd8, 0xff])
        || !image.ends_with(&[0xff, 0xd9])
    {
        return Err("A bounded JPEG rendering of the original page is required".into());
    }
    let _guard = SOURCE_WRITES
        .lock()
        .map_err(|_| "Page source storage unavailable")?;
    let store = open_literature_store_at(workspace)?;
    let source = OriginalPageEvidence {
        document_revision: input.document_revision,
        page_index: input.page_index,
        image_sha256: content_sha256(&image),
        image_file: format!("page-{}.jpg", input.page_index),
        mime_type: "image/jpeg".into(),
        embedded_text: input.embedded_text,
        text_truncated: input.text_truncated,
    };
    let directory = artifact_dir(workspace, &input.run_id)?;
    let existing_bytes = fs::read_dir(&directory)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jpg"))
        .filter_map(|entry| entry.metadata().ok())
        .map(|meta| meta.len())
        .sum::<u64>();
    let image_path = directory.join(&source.image_file);
    let replaced_bytes = fs::metadata(&image_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if existing_bytes.saturating_sub(replaced_bytes) + image.len() as u64 > MAX_RUN_IMAGE_BYTES {
        return Err(
            "Page images exceed the 256 MiB task budget; saved sources are retained".into(),
        );
    }
    for _ in 0..4 {
        let mut run = store
            .paper_reading_run(&input.run_id)?
            .ok_or("Paper task not found")?;
        source.validate_for(&run, input.page_index)?;
        let already_saved = run.pages[input.page_index].source.is_some();
        run.attach_source(source.clone())?;
        // Validate the immutable binding before touching any existing file.
        runtime::write_file_atomically(&image_path, &image).map_err(|e| e.to_string())?;
        if already_saved {
            return Ok(run);
        }
        if let Ok(saved) = store.save_paper_reading_run(&run) {
            return Ok(saved);
        }
    }
    Err("Paper task changed while saving its original page; retry preparation".into())
}

#[tauri::command]
pub async fn paper_reading_start(
    app: AppHandle,
    project_id: String,
    run_id: String,
) -> Result<PaperReadingView, String> {
    let (_, workspace) = project(&app, Some(&project_id))?;
    let key = (project_id.clone(), run_id.clone());
    let mut runs = active_runs()
        .lock()
        .map_err(|_| "Paper task registry unavailable")?;
    if runs.contains_key(&key) {
        drop(runs);
        return Ok(view(&project_id, load_run(&workspace, &run_id)?));
    }
    let cancellation = Arc::new(AtomicBool::new(false));
    runs.insert(key.clone(), cancellation.clone());
    drop(runs);
    let guard = RunGuard {
        key,
        cancellation: cancellation.clone(),
    };
    let mut run = load_run(&workspace, &run_id)?;
    let (_, signature) = crate::engine::paper_reading_executor(Some(&run.model))?;
    if signature != run.executor_signature {
        return Err(
            "The model connection changed; start a new analysis using the current settings".into(),
        );
    }
    // Resume verifies the immutable source snapshot instead of trusting the
    // library filename, which the user may have replaced since the first run.
    let source_pdf = fs::read(artifact_dir(&workspace, &run_id)?.join("source.pdf"))
        .map_err(|e| e.to_string())?;
    if content_sha256(&source_pdf) != run.document_revision {
        return Err("Original PDF snapshot changed; this task cannot be resumed".into());
    }
    guide::ensure_guide(&mut run);
    if run.status != PaperReadingStatus::Running {
        run.reopen_exhausted_attempts()?;
    }
    run.start()?;
    let run = open_literature_store_at(&workspace)?.save_paper_reading_run(&run)?;
    let initial = view(&project_id, run.clone());
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = drive(
            &task_app,
            &project_id,
            &workspace,
            run,
            cancellation.clone(),
        )
        .await;
        if cancellation.load(Ordering::SeqCst) {
            if let Ok(saved) = cancel_saved_run(&workspace, &run_id) {
                emit(&task_app, &project_id, saved);
            }
        } else if let Err(error) = result {
            if let Ok(mut run) = load_run(&workspace, &run_id) {
                if run.status == PaperReadingStatus::Running {
                    run.fail(&error);
                    if let Ok(saved) = open_literature_store_at(&workspace)
                        .and_then(|store| store.save_paper_reading_run(&run))
                    {
                        emit(&task_app, &project_id, saved);
                    }
                }
            }
            let _ = task_app.emit(
                "paper-reading-error",
                serde_json::json!({
                    "projectId": project_id, "runId": run_id, "message": error,
                }),
            );
        }
        drop(guard);
        if let Ok(run) = load_run(&workspace, &run_id) {
            emit(&task_app, &project_id, run);
        }
    });
    Ok(initial)
}

async fn drive(
    app: &AppHandle,
    project_id: &str,
    workspace: &Path,
    mut run: PaperReadingRun,
    cancellation: Arc<AtomicBool>,
) -> Result<(), String> {
    while let Some(page_index) = run.next_page() {
        if cancellation.load(Ordering::SeqCst) {
            return Ok(());
        }
        let session_id = format!(
            "paper-{}-{page_index}-{:016x}",
            &run.id[..16],
            rand::random::<u64>()
        );
        let message = original_page_message(workspace, &run, page_index);
        run.begin_page(page_index, session_id.clone())?;
        run = open_literature_store_at(workspace)?.save_paper_reading_run(&run)?;
        emit(app, project_id, run.clone());
        let output = match message {
            Err(error) => Err(error),
            Ok(message) => {
                crate::engine::run_paper_reading_turn(
                    app.clone(),
                    session_id.clone(),
                    project_id.into(),
                    crate::engine::PaperReadingRuntimeContext {
                        run_id: run.id.clone(),
                        paper_id: run.paper_id.clone(),
                        document_revision: run.document_revision.clone(),
                        page_index,
                        stage: "perception",
                        executor_signature: run.executor_signature.clone(),
                    },
                    message,
                    run.model.clone(),
                    cancellation.clone(),
                )
                .await
            }
        };
        if cancellation.load(Ordering::SeqCst) {
            return Ok(());
        }
        run.finish_page(
            page_index,
            &session_id,
            output.as_ref().map(String::as_str).map_err(String::as_str),
        )?;
        run.retry_invalid_page_output(page_index, output.is_ok());
        run = open_literature_store_at(workspace)?.save_paper_reading_run(&run)?;
        emit(app, project_id, run.clone());
    }
    run = guide::drive(app, project_id, workspace, run, cancellation.clone()).await?;
    if cancellation.load(Ordering::SeqCst) {
        return Ok(());
    }
    run.finish();
    let saved = open_literature_store_at(workspace)?.save_paper_reading_run(&run)?;
    emit(app, project_id, saved);
    Ok(())
}

fn original_page_message(
    workspace: &Path,
    run: &PaperReadingRun,
    page_index: usize,
) -> Result<ConversationMessage, String> {
    let mut prompt = page_perception_prompt(run, page_index)?;
    if let Some(error) = &run.pages[page_index].error {
        prompt.push_str(&format!("\nPrevious output was rejected: {error}. Regenerate from the original evidence. Return valid JSON with exact field types; escape quotes and backslashes inside strings."));
    }
    let image = read_original_page_image(workspace, run, page_index)?;
    Ok(ConversationMessage::user_blocks(vec![
        ContentBlock::Text { text: prompt },
        ContentBlock::Image {
            media_type: "image/jpeg".into(),
            data: base64::engine::general_purpose::STANDARD.encode(&image),
        },
    ]))
}

fn read_original_page_image(
    workspace: &Path,
    run: &PaperReadingRun,
    page_index: usize,
) -> Result<Vec<u8>, String> {
    let source = run.pages[page_index]
        .source
        .as_ref()
        .ok_or("Missing original page")?;
    let path = artifact_dir(workspace, &run.id)?.join(&source.image_file);
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_PAGE_IMAGE_BYTES as u64 {
        return Err("Original page image exceeds the input budget".into());
    }
    let image = fs::read(path).map_err(|e| e.to_string())?;
    if image.len() > MAX_PAGE_IMAGE_BYTES || content_sha256(&image) != source.image_sha256 {
        return Err("Original page image changed after preparation".into());
    }
    Ok(image)
}

#[tauri::command]
pub async fn paper_reading_cancel(
    app: AppHandle,
    project_id: String,
    run_id: String,
) -> Result<PaperReadingView, String> {
    let (_, workspace) = project(&app, Some(&project_id))?;
    if let Some(flag) = active_runs()
        .lock()
        .map_err(|_| "Paper task registry unavailable")?
        .get(&(project_id.clone(), run_id.clone()))
    {
        flag.store(true, Ordering::SeqCst);
    }
    let saved = cancel_saved_run(&workspace, &run_id)?;
    emit(&app, &project_id, saved.clone());
    Ok(view(&project_id, saved))
}

fn cancel_saved_run(workspace: &Path, run_id: &str) -> Result<PaperReadingRun, String> {
    // Retry a concurrent page commit; cancellation itself must be durable.
    for _ in 0..4 {
        let mut run = load_run(workspace, run_id)?;
        if matches!(
            run.status,
            PaperReadingStatus::Cancelled | PaperReadingStatus::GuideReady
        ) {
            return Ok(run);
        }
        run.cancel();
        if let Ok(saved) = open_literature_store_at(workspace)?.save_paper_reading_run(&run) {
            return Ok(saved);
        }
    }
    Err("Task changed while cancelling; retry cancellation".into())
}

#[cfg(test)]
#[path = "tests/paper_reading.rs"]
mod tests;

/// Explicit, debug-only live acceptance entry. It invokes the same commands
/// and Chat engine as the reader, using a separate project/configuration root.
#[cfg(debug_assertions)]
pub(crate) mod diagnostic;
