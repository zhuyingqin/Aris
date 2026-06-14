//! Desktop commands for the literature library — thin wrappers over the
//! shared kernel implementation in `tools::literature`, so the desktop UI,
//! CLI agents, and the literature skills (`/arxiv`, `/research-lit`) all
//! operate on the same `papers/library.json` contract.
//!
//! `literature_llm` is the one exception: a one-shot, tool-free completion on
//! the user's configured chat executor, so screening and Brief generation can
//! use a real model instead of the offline keyword heuristic.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::State;

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
    tauri::async_runtime::spawn_blocking(move || {
        crate::config::apply_reviewer_environment(true);
        let review_skill = tools::skill_markdown("research-review")
            .unwrap_or_else(|| "Use evidence-first independent research review.".to_string());
        tools::execute_tool(
            "LlmReview",
            &json!({
                "prompt": format!(
                    "{system}\n\nARIS built-in research-review skill instructions:\n{review_skill}\n\n\
                     Apply those evidence-first independent review standards and return exactly \
                     the output format requested below.\n\n{prompt}"
                )
            }),
        )
    })
    .await
    .map_err(|e| e.to_string())?
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

fn run_oneshot(system: &str, message: ConversationMessage) -> Result<String, String> {
    let config = crate::config::load_object();
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
        model,
        false,
        Vec::new(),
        observer,
        NoTools,
        aris_chat::permission_policy_for_tools(Vec::new(), PermissionMode::ReadOnly),
        vec![system.to_string()],
        RuntimeFeatureConfig::default(),
    )?;
    let summary = conversation
        .run_turn_message(message, None)
        .map_err(|e| e.to_string())?;
    Ok(aris_chat::final_assistant_text(&summary))
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
    let papers_dir = base
        .join("papers")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = base
        .join(relative)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(&papers_dir)
        || !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    {
        return Err("PDF must be a downloaded file inside papers/".to_string());
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

/// Extract readable text from a downloaded PDF so the Brief can read the full
/// paper, not just the abstract. The result reports truncation explicitly so
/// the UI never presents partial extraction as a full-paper brief.
#[tauri::command]
pub fn literature_pdf_text(
    projects_state: State<ProjectState>,
    relative_path: String,
) -> Result<Value, String> {
    let path = resolve_pdf_path(&projects_state, &relative_path)?;
    serde_json::to_value(extract_pdf_text_by_page(&path)?).map_err(|error| error.to_string())
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
    if source_path.canonicalize().ok() != destination.canonicalize().ok() {
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
        "aris-pdf-page-ocr-{}-{nonce}.png",
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

#[tauri::command]
pub fn literature_load(projects_state: State<ProjectState>) -> Result<Value, String> {
    tools::literature::library_load_at(&project_base(&projects_state)?)
}

#[tauri::command]
pub fn literature_save(projects_state: State<ProjectState>, library: Value) -> Result<(), String> {
    tools::literature::library_save_at(&project_base(&projects_state)?, &library)
}

#[tauri::command]
pub async fn literature_search(
    query: String,
    sources: Vec<String>,
    max_results: Option<usize>,
) -> Result<Value, String> {
    let limit = max_results.unwrap_or(20).clamp(1, 50);
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = tools::literature::search_remote(&query, &sources, limit)?;
        Ok(json!({
            "papers": outcome.papers,
            "warnings": outcome.warnings,
            "sourceCounts": outcome.source_counts,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
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

fn extract_pdf_text_by_page(path: &Path) -> Result<PdfTextExtraction, String> {
    let page_count = pdf_page_count(path)?;
    let mut warnings = Vec::new();
    let mut pages = Vec::with_capacity(page_count);
    let mut ocr_used = false;

    for page in 1..=page_count {
        let embedded = pdftotext_page(path, page).unwrap_or_else(|error| {
            if page == 1 {
                warnings.push(error);
            }
            String::new()
        });
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
        "aris-pdf-ocr-{}-{page}-{nonce}",
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
mod tests {
    #[cfg(windows)]
    use super::{extract_pdf_text_by_page, literature_image_ocr, windows_ocr};
    use super::{
        import_pdf_at, resolve_pdf_path_at, validate_vision_model, vision_message,
        LiteratureVisionImage,
    };
    use runtime::ContentBlock;
    #[cfg(windows)]
    use std::process::Stdio;

    fn temp_base(name: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "aris-desktop-literature-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("papers")).expect("create papers");
        base
    }

    #[test]
    fn pdf_paths_are_limited_to_downloaded_papers() {
        let base = temp_base("paths");
        std::fs::write(base.join("papers/paper.pdf"), b"%PDF-1.4").expect("write pdf");
        std::fs::write(base.join("papers/notes.txt"), b"notes").expect("write text");
        std::fs::write(base.join("outside.pdf"), b"%PDF-1.4").expect("write outside pdf");

        assert!(resolve_pdf_path_at(&base, "papers/paper.pdf").is_ok());
        assert!(resolve_pdf_path_at(&base, "papers/notes.txt").is_err());
        assert!(resolve_pdf_path_at(&base, "outside.pdf").is_err());
        assert!(resolve_pdf_path_at(&base, "../outside.pdf").is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn imports_only_valid_pdf_files_into_papers() {
        let base = temp_base("import");
        let source = base.join("source.pdf");
        let invalid = base.join("invalid.pdf");
        std::fs::write(&source, b"%PDF-1.4 imported").expect("write source");
        std::fs::write(&invalid, b"not a pdf").expect("write invalid");

        let imported = import_pdf_at(&base, &source, "My Paper.pdf").expect("import pdf");
        assert_eq!(imported.relative_path, "papers/My-Paper.pdf");
        assert!(base.join("papers/My-Paper.pdf").exists());
        assert!(import_pdf_at(&base, &invalid, "invalid.pdf").is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn vision_message_labels_each_page_image() {
        let message = vision_message(
            "Read these pages.".to_string(),
            vec![
                LiteratureVisionImage {
                    page: 2,
                    mime_type: "image/jpeg".to_string(),
                    data: "ZmFrZQ==".to_string(),
                    fingerprint: "sha256:page-two".to_string(),
                },
                LiteratureVisionImage {
                    page: 3,
                    mime_type: "image/png".to_string(),
                    data: "ZmFrZTI=".to_string(),
                    fingerprint: "sha256:page-three".to_string(),
                },
            ],
        )
        .expect("vision message");
        assert_eq!(message.blocks.len(), 5);
        assert!(matches!(
            &message.blocks[1],
            ContentBlock::Text { text } if text.contains("[[PAGE IMAGE 2]]")
        ));
        assert!(matches!(
            &message.blocks[2],
            ContentBlock::Image { media_type, .. } if media_type == "image/jpeg"
        ));
        assert!(matches!(
            &message.blocks[3],
            ContentBlock::Text { text } if text.contains("[[PAGE IMAGE 3]]")
        ));
    }

    #[test]
    fn minimax_m3_is_the_only_minimax_vision_model() {
        assert!(validate_vision_model("MiniMax-M3").is_ok());
        assert!(validate_vision_model("minimax-m3").is_ok());
        assert!(validate_vision_model("MiniMax-M2.7").is_err());
        assert!(validate_vision_model("MiniMax-M2.7-highspeed").is_err());
        assert!(validate_vision_model("gpt-5.4").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn extracts_a_scanned_pdf_with_windows_ocr_when_poppler_is_available() {
        let base = temp_base("ocr");
        std::fs::create_dir_all(&base).expect("create OCR test directory");
        let source = crate::process::hidden_command("pdflatex")
            .current_dir(&base)
            .args([
                "-interaction=batchmode",
                "-halt-on-error",
                "-jobname=source",
                r"\documentclass{article}\begin{document}\Huge Scanned OCR test 12345\end{document}",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if !source.is_ok_and(|status| status.success()) {
            let _ = std::fs::remove_dir_all(base);
            return;
        }
        let rendered = crate::process::hidden_command("pdftoppm")
            .current_dir(&base)
            .args([
                "-f",
                "1",
                "-l",
                "1",
                "-singlefile",
                "-r",
                "180",
                "-png",
                "source.pdf",
                "scan",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("render source PDF");
        if !rendered.success() || windows_ocr(&base.join("scan.png")).is_err() {
            let _ = std::fs::remove_dir_all(base);
            return;
        }
        let direct_ocr =
            literature_image_ocr(std::fs::read(base.join("scan.png")).expect("read scan image"))
                .expect("OCR rendered page bytes");
        assert!(direct_ocr.contains("Scanned OCR test 12345"));
        let scanned = crate::process::hidden_command("pdflatex")
            .current_dir(&base)
            .args([
                "-interaction=batchmode",
                "-halt-on-error",
                "-jobname=scanned",
                r"\documentclass{article}\usepackage{graphicx}\pagestyle{empty}\begin{document}\includegraphics[width=\textwidth]{scan.png}\end{document}",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("build scanned PDF");
        assert!(scanned.success());

        let extraction =
            extract_pdf_text_by_page(&base.join("scanned.pdf")).expect("extract scanned PDF");
        assert!(extraction.ocr_used);
        assert!(extraction.missing_pages.is_empty());
        assert!(extraction.text.contains("Scanned OCR test 12345"));
        let _ = std::fs::remove_dir_all(base);
    }
}
