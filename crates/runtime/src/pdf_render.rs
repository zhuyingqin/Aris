//! Render PDF pages to images the model can look at directly.
//!
//! A scanned PDF, or one whose fonts lack a usable Unicode map (common for
//! Chinese CID fonts), has no trustworthy text layer. Without this tool the
//! model was told to "use a rendered page or local OCR" and had no way to do
//! either, so it installed Python packages and wrote extraction scripts.
//!
//! Rendering uses what the machine already has: the Windows PDF and OCR
//! engines (built in since Windows 10), else Poppler's `pdftoppm` or MuPDF's
//! `mutool`, with Tesseract for OCR. Nothing is installed on the user's behalf.

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

use crate::conversation::{ToolMedia, ToolOutput};

pub const READ_PDF_PAGES_TOOL: &str = "read_pdf_pages";
/// Matches the conversation's per-result image ceiling, so every rendered page
/// reaches the model.
pub const MAX_PDF_PAGES_PER_CALL: usize = 4;
const DEFAULT_DPI: u32 = 130;
const MIN_DPI: u32 = 72;
const MAX_DPI: u32 = 200;
/// Kept under the conversation's 8 MiB per-image limit with room to spare.
const MAX_PAGE_IMAGE_BYTES: usize = 7 * 1024 * 1024;
const RENDER_TIMEOUT: Duration = Duration::from_secs(120);
const OUTPUT_KIND: &str = "pdf_pages";

#[derive(Debug, Clone, Deserialize)]
pub struct ReadPdfPagesInput {
    pub path: String,
    /// 1-based pages such as `"3"`, `"1-4"` or `"2,5,7-8"`. Defaults to the
    /// first pages of the document.
    #[serde(default)]
    pub pages: Option<String>,
    #[serde(default)]
    pub dpi: Option<u32>,
    /// Also return machine OCR text for each rendered page.
    #[serde(default)]
    pub ocr: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPdfPage {
    pub page: usize,
    pub media_type: String,
    pub bytes: usize,
    pub base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPagesOutput {
    #[serde(rename = "type")]
    pub kind: String,
    pub file_path: String,
    pub page_count: Option<usize>,
    pub renderer: String,
    pub dpi: u32,
    pub pages: Vec<RenderedPdfPage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr_engine: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Requested pages that did not fit in this call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_pages: Option<String>,
}

pub fn read_pdf_pages(
    input: &ReadPdfPagesInput,
    should_cancel: &dyn Fn() -> bool,
) -> io::Result<PdfPagesOutput> {
    let path = crate::file_ops::normalize_read_path(&input.path)?;
    ensure_pdf(&path)?;
    let dpi = input.dpi.unwrap_or(DEFAULT_DPI).clamp(MIN_DPI, MAX_DPI);
    let page_count = count_pages(&path);
    let requested = match input.pages.as_deref().map(str::trim) {
        Some(spec) if !spec.is_empty() => parse_page_spec(spec)?,
        _ => (1..=page_count.unwrap_or(MAX_PDF_PAGES_PER_CALL).min(MAX_PDF_PAGES_PER_CALL)).collect(),
    };
    let mut warnings = Vec::new();
    let mut in_range = requested.clone();
    if let Some(count) = page_count {
        let missing = requested.iter().filter(|page| **page > count).count();
        in_range.retain(|page| *page <= count);
        if missing > 0 {
            warnings.push(format!("The document has {count} pages; {missing} requested page(s) beyond it were skipped."));
        }
        if in_range.is_empty() {
            return Err(invalid_input(format!(
                "no requested page exists; the document has {count} pages"
            )));
        }
    }
    let pages = in_range.iter().copied().take(MAX_PDF_PAGES_PER_CALL).collect::<Vec<_>>();
    let remaining_pages = (in_range.len() > pages.len())
        .then(|| format_page_list(&in_range[pages.len()..]));

    let work_dir = TempDir::create()?;
    let rendered = render_pages(&path, &pages, dpi, input.ocr, work_dir.path(), should_cancel)?;
    warnings.extend(rendered.warnings);
    let mut ocr_engine = rendered.ocr_engine;
    let mut output_pages = Vec::new();
    for page in rendered.pages {
        let bytes = std::fs::read(&page.image)?;
        if bytes.len() > MAX_PAGE_IMAGE_BYTES {
            warnings.push(format!(
                "Page {} rendered to {} bytes, over the image limit; retry it with a lower dpi.",
                page.number,
                bytes.len()
            ));
            continue;
        }
        let mut ocr_text = page.ocr_text;
        if input.ocr && ocr_text.is_none() {
            match tesseract_ocr(&page.image, should_cancel) {
                Ok(text) => {
                    ocr_engine.get_or_insert_with(|| "tesseract".to_string());
                    ocr_text = Some(text);
                }
                Err(error) => warnings.push(format!("OCR for page {} unavailable: {error}", page.number)),
            }
        }
        output_pages.push(RenderedPdfPage {
            page: page.number,
            media_type: "image/png".to_string(),
            bytes: bytes.len(),
            base64: BASE64_STANDARD.encode(&bytes),
            ocr_text: ocr_text.map(|text| collapse_cjk_spaces(&text)),
        });
    }
    if output_pages.is_empty() {
        return Err(io::Error::other(format!(
            "no page image was produced. {}",
            warnings.join(" ")
        )));
    }
    Ok(PdfPagesOutput {
        kind: OUTPUT_KIND.to_string(),
        file_path: path.to_string_lossy().into_owned(),
        page_count: rendered.page_count.or(page_count),
        renderer: rendered.renderer,
        dpi,
        pages: output_pages,
        ocr_engine: if input.ocr { ocr_engine } else { None },
        warnings,
        remaining_pages,
    })
}

/// Move the page images of a `read_pdf_pages` result into media blocks and
/// leave a text summary (with any OCR text) in their place. Every surface that
/// shortens or spills tool output runs this first: the JSON is megabytes of
/// base64 the model cannot read as text, and a truncated copy is unrecoverable.
/// Idempotent: a lifted result no longer parses as the raw JSON.
#[must_use]
pub fn lift_pdf_page_media(tool_name: &str, output: ToolOutput) -> ToolOutput {
    if tool_name != READ_PDF_PAGES_TOOL || !output.text.contains("\"base64\"") {
        return output;
    }
    let Ok(parsed) = serde_json::from_str::<PdfPagesOutput>(&output.text) else {
        return output;
    };
    if parsed.kind != OUTPUT_KIND {
        return output;
    }
    let summary = pdf_pages_summary(&parsed);
    let mut media = output.media;
    media.extend(parsed.pages.into_iter().map(|page| ToolMedia::Image {
        media_type: page.media_type,
        data: page.base64,
    }));
    ToolOutput {
        text: summary.clone(),
        media,
        reported_error: output.reported_error,
        evidence_text: Some(summary),
    }
}

fn pdf_pages_summary(output: &PdfPagesOutput) -> String {
    let numbers = output.pages.iter().map(|page| page.page).collect::<Vec<_>>();
    let mut summary = format!(
        "Rendered page(s) {} of `{}`{} at {} dpi with {}. The page images are attached to this result in that order; read them directly.",
        format_page_list(&numbers),
        output.file_path,
        output
            .page_count
            .map(|count| format!(" ({count} pages)"))
            .unwrap_or_default(),
        output.dpi,
        output.renderer,
    );
    if let Some(remaining) = &output.remaining_pages {
        summary.push_str(&format!(
            "\nNot rendered in this call (limit {MAX_PDF_PAGES_PER_CALL} pages): {remaining}. Request them in a further call if they are needed."
        ));
    }
    for warning in &output.warnings {
        summary.push_str(&format!("\nWarning: {warning}"));
    }
    let ocr_pages = output
        .pages
        .iter()
        .filter_map(|page| page.ocr_text.as_ref().map(|text| (page.page, text)))
        .collect::<Vec<_>>();
    if !ocr_pages.is_empty() {
        summary.push_str(&format!(
            "\n\nMachine OCR text ({}). OCR can misread characters, digits and formulas; check quotes and numbers against the page images.",
            output.ocr_engine.as_deref().unwrap_or("ocr")
        ));
        for (page, text) in ocr_pages {
            let text = if text.trim().is_empty() { "(no text recognized)" } else { text.trim() };
            summary.push_str(&format!("\n\n--- Page {page} OCR ---\n{text}"));
        }
    }
    summary
}

fn ensure_pdf(path: &Path) -> io::Result<()> {
    use std::io::Read as _;
    let mut header = [0u8; 1024];
    let read = std::fs::File::open(path)?.read(&mut header)?;
    if header[..read].windows(5).any(|window| window == b"%PDF-") {
        return Ok(());
    }
    Err(invalid_input(format!(
        "`{}` is not a PDF file; use read_file or ReadMediaFile for other formats",
        path.display()
    )))
}

fn count_pages(path: &Path) -> Option<usize> {
    let bytes = std::fs::read(path).ok()?;
    std::panic::catch_unwind(|| {
        lopdf::Document::load_mem(&bytes)
            .ok()
            .map(|document| document.get_pages().len())
            .filter(|count| *count > 0)
    })
    .ok()
    .flatten()
}

pub(crate) fn parse_page_spec(spec: &str) -> io::Result<Vec<usize>> {
    let mut pages = BTreeSet::new();
    for part in spec.split([',', '，', ';', ' ']).map(str::trim).filter(|part| !part.is_empty()) {
        let (start, end) = match part.split_once(['-', '–', '~']) {
            Some((start, end)) => (parse_page_number(start)?, parse_page_number(end)?),
            None => {
                let page = parse_page_number(part)?;
                (page, page)
            }
        };
        if end < start {
            return Err(invalid_input(format!("page range `{part}` is reversed")));
        }
        if end - start > 10_000 {
            return Err(invalid_input(format!("page range `{part}` is too large")));
        }
        pages.extend(start..=end);
    }
    if pages.is_empty() {
        return Err(invalid_input("pages must name at least one page, such as \"1-4\""));
    }
    Ok(pages.into_iter().collect())
}

fn parse_page_number(value: &str) -> io::Result<usize> {
    match value.trim().parse::<usize>() {
        Ok(page) if page >= 1 => Ok(page),
        _ => Err(invalid_input(format!(
            "`{value}` is not a page number; pages are 1-based, e.g. \"1-4\" or \"2,5\""
        ))),
    }
}

pub(crate) fn format_page_list(pages: &[usize]) -> String {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for &page in pages {
        match ranges.last_mut() {
            Some((_, end)) if *end + 1 == page => *end = page,
            _ => ranges.push((page, page)),
        }
    }
    ranges
        .into_iter()
        .map(|(start, end)| if start == end { start.to_string() } else { format!("{start}-{end}") })
        .collect::<Vec<_>>()
        .join(",")
}

/// Windows OCR puts a space between every CJK character; drop the spaces that
/// sit between two CJK characters and keep those around Latin words.
pub(crate) fn collapse_cjk_spaces(text: &str) -> String {
    let characters = text.chars().collect::<Vec<_>>();
    let mut result = String::with_capacity(text.len());
    for (index, character) in characters.iter().enumerate() {
        if *character == ' ' {
            let before = characters[..index].iter().rev().find(|c| **c != ' ');
            let after = characters[index + 1..].iter().find(|c| **c != ' ');
            if before.is_some_and(|c| is_cjk(*c)) && after.is_some_and(|c| is_cjk(*c)) {
                continue;
            }
        }
        result.push(*character);
    }
    result
}

fn is_cjk(character: char) -> bool {
    matches!(character,
        '\u{3000}'..='\u{303f}'
        | '\u{3400}'..='\u{4dbf}'
        | '\u{4e00}'..='\u{9fff}'
        | '\u{f900}'..='\u{faff}'
        | '\u{ff00}'..='\u{ffef}'
        | '\u{20000}'..='\u{2fa1f}')
}

struct RenderedPage {
    number: usize,
    image: PathBuf,
    ocr_text: Option<String>,
}

struct RenderResult {
    renderer: String,
    page_count: Option<usize>,
    pages: Vec<RenderedPage>,
    ocr_engine: Option<String>,
    warnings: Vec<String>,
}

fn render_pages(
    path: &Path,
    pages: &[usize],
    dpi: u32,
    ocr: bool,
    out_dir: &Path,
    should_cancel: &dyn Fn() -> bool,
) -> io::Result<RenderResult> {
    let mut failures = Vec::new();
    #[cfg(windows)]
    match render_with_windows(path, pages, dpi, ocr, out_dir, should_cancel) {
        Ok(result) => return Ok(result),
        Err(error) if error.kind() == io::ErrorKind::Interrupted => return Err(error),
        Err(error) => failures.push(format!("Windows PDF renderer: {error}")),
    }
    #[cfg(not(windows))]
    let _ = ocr;
    match render_with_pdftoppm(path, pages, dpi, out_dir, should_cancel) {
        Ok(result) => return Ok(result),
        Err(error) if error.kind() == io::ErrorKind::Interrupted => return Err(error),
        Err(error) => failures.push(format!("pdftoppm: {error}")),
    }
    match render_with_mutool(path, pages, dpi, out_dir, should_cancel) {
        Ok(result) => return Ok(result),
        Err(error) if error.kind() == io::ErrorKind::Interrupted => return Err(error),
        Err(error) => failures.push(format!("mutool: {error}")),
    }
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!(
            "no PDF page renderer is available on this machine ({}). Do not install packages or write scripts to work around this: tell the user the PDF's pages cannot be viewed here and ask them to paste the needed text or provide a readable copy (for example a Word export or page screenshots).",
            failures.join("; ")
        ),
    ))
}

#[cfg(windows)]
const WINDOWS_RENDER_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
$methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOperation = ($methods | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
$asTaskAction = ($methods | Where-Object {
  $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]
function Await($operation, $type) {
  $task = $asTaskOperation.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait()
  $task.Result
}
function AwaitAction($action) {
  $task = $asTaskAction.Invoke($null, @($action))
  $task.Wait()
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:SOMNIQ_PDF_PATH)) ([Windows.Storage.StorageFile])
$document = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($env:SOMNIQ_PDF_OUT)) ([Windows.Storage.StorageFolder])
$scale = [double]$env:SOMNIQ_PDF_DPI / 96.0
$ocr = $null
if ($env:SOMNIQ_PDF_OCR -eq '1') {
  $ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $ocr) { 'OCRMISSING' }
}
'PAGECOUNT ' + $document.PageCount
foreach ($token in ($env:SOMNIQ_PDF_PAGES -split ',')) {
  $number = [int]$token
  if ($number -lt 1 -or $number -gt $document.PageCount) { continue }
  $page = $document.GetPage([uint32]($number - 1))
  $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $options.DestinationWidth = [uint32][math]::Max(1, [math]::Round($page.Size.Width * $scale))
  $options.DestinationHeight = [uint32][math]::Max(1, [math]::Round($page.Size.Height * $scale))
  $name = 'page-' + $number + '.png'
  $output = Await ($folder.CreateFileAsync($name, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  $stream = Await ($output.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
  AwaitAction ($page.RenderToStreamAsync($stream, $options))
  'PAGE ' + $number + ' ' + $name
  if ($null -ne $ocr) {
    $stream.Seek(0)
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($ocr.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($result.Lines | ForEach-Object { $_.Text }) -join "`n"
    'OCR ' + $number + ' ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($lines))
    $bitmap.Dispose()
  }
  $stream.Dispose()
  $page.Dispose()
}
"#;

#[cfg(windows)]
fn render_with_windows(
    path: &Path,
    pages: &[usize],
    dpi: u32,
    ocr: bool,
    out_dir: &Path,
    should_cancel: &dyn Fn() -> bool,
) -> io::Result<RenderResult> {
    let encoded = BASE64_STANDARD.encode(
        WINDOWS_RENDER_SCRIPT
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let mut command = crate::hidden_command("powershell");
    command
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .env("SOMNIQ_PDF_PATH", path)
        .env("SOMNIQ_PDF_OUT", out_dir)
        .env("SOMNIQ_PDF_DPI", dpi.to_string())
        .env("SOMNIQ_PDF_OCR", if ocr { "1" } else { "0" })
        .env("SOMNIQ_PDF_PAGES", pages.iter().map(usize::to_string).collect::<Vec<_>>().join(","));
    let stdout = run_renderer(&mut command, "Windows PDF renderer", should_cancel)?;
    let mut result = RenderResult {
        renderer: "the Windows PDF renderer".to_string(),
        page_count: None,
        pages: Vec::new(),
        ocr_engine: ocr.then(|| "Windows OCR".to_string()),
        warnings: Vec::new(),
    };
    for line in String::from_utf8_lossy(&stdout).lines() {
        let mut fields = line.trim().splitn(3, ' ');
        match (fields.next(), fields.next(), fields.next()) {
            (Some("PAGECOUNT"), Some(count), _) => result.page_count = count.parse().ok(),
            (Some("OCRMISSING"), _, _) => {
                result.ocr_engine = None;
                result.warnings.push("Windows OCR has no language pack for the user's profile languages.".to_string());
            }
            (Some("PAGE"), Some(number), Some(name)) => {
                if let Ok(number) = number.parse() {
                    result.pages.push(RenderedPage { number, image: out_dir.join(name), ocr_text: None });
                }
            }
            (Some("OCR"), Some(number), encoded) => {
                let number = number.parse::<usize>().ok();
                let text = BASE64_STANDARD
                    .decode(encoded.unwrap_or_default())
                    .ok()
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
                if let (Some(number), Some(text)) = (number, text) {
                    if let Some(page) = result.pages.iter_mut().find(|page| page.number == number) {
                        page.ocr_text = Some(text);
                    }
                }
            }
            _ => {}
        }
    }
    if result.pages.is_empty() {
        return Err(io::Error::other("rendered no pages"));
    }
    Ok(result)
}

fn render_with_pdftoppm(
    path: &Path,
    pages: &[usize],
    dpi: u32,
    out_dir: &Path,
    should_cancel: &dyn Fn() -> bool,
) -> io::Result<RenderResult> {
    let mut rendered = Vec::new();
    for &page in pages {
        let prefix = out_dir.join(format!("page-{page}"));
        let mut command = crate::hidden_command("pdftoppm");
        command
            .args(["-f", &page.to_string(), "-l", &page.to_string(), "-r", &dpi.to_string(), "-png", "-singlefile"])
            .arg(path)
            .arg(&prefix);
        run_renderer(&mut command, "pdftoppm", should_cancel)?;
        rendered.push(RenderedPage { number: page, image: prefix.with_extension("png"), ocr_text: None });
    }
    Ok(RenderResult {
        renderer: "Poppler pdftoppm".to_string(),
        page_count: None,
        pages: rendered,
        ocr_engine: None,
        warnings: Vec::new(),
    })
}

fn render_with_mutool(
    path: &Path,
    pages: &[usize],
    dpi: u32,
    out_dir: &Path,
    should_cancel: &dyn Fn() -> bool,
) -> io::Result<RenderResult> {
    let mut rendered = Vec::new();
    for &page in pages {
        let image = out_dir.join(format!("page-{page}.png"));
        let mut command = crate::hidden_command("mutool");
        command
            .args(["draw", "-q", "-r", &dpi.to_string(), "-o"])
            .arg(&image)
            .arg(path)
            .arg(page.to_string());
        run_renderer(&mut command, "mutool", should_cancel)?;
        rendered.push(RenderedPage { number: page, image, ocr_text: None });
    }
    Ok(RenderResult {
        renderer: "MuPDF mutool".to_string(),
        page_count: None,
        pages: rendered,
        ocr_engine: None,
        warnings: Vec::new(),
    })
}

fn tesseract_ocr(image: &Path, should_cancel: &dyn Fn() -> bool) -> io::Result<String> {
    let mut last_error = None;
    for languages in ["chi_sim+eng", "eng"] {
        let mut command = crate::hidden_command("tesseract");
        command.arg(image).arg("stdout").args(["-l", languages]);
        match run_renderer(&mut command, "tesseract", should_cancel) {
            Ok(stdout) => return Ok(crate::file_ops::decode_process_text(&stdout).trim().to_string()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => return Err(error),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| io::Error::other("tesseract failed")))
}

fn run_renderer(
    command: &mut std::process::Command,
    label: &str,
    should_cancel: &dyn Fn() -> bool,
) -> io::Result<Vec<u8>> {
    if should_cancel() {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "interrupted by user"));
    }
    let output = crate::run_managed_command_with_cancel(
        command,
        format!("PDF pages ({label})"),
        Some(RENDER_TIMEOUT),
        true,
        should_cancel,
    )?;
    if output.interrupted {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "interrupted by user"));
    }
    if output.timed_out {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("{label} timed out after {}s", RENDER_TIMEOUT.as_secs()),
        ));
    }
    if !output.status.success() {
        let stderr = crate::file_ops::decode_process_text(&output.stderr);
        let detail = stderr.trim().lines().last().unwrap_or("").trim();
        return Err(io::Error::other(format!("{label} exited with {}: {detail}", output.status)));
    }
    Ok(output.stdout)
}

fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

struct TempDir(PathBuf);

impl TempDir {
    fn create() -> io::Result<Self> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let path = std::env::temp_dir().join(format!("somniq-pdf-pages-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
#[path = "tests/pdf_render.rs"]
mod tests;
