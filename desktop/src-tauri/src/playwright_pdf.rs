//! Long-lived publisher-PDF browser worker using the bundled Playwright runtime.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

struct BrowserWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

pub struct PlaywrightPdfService {
    profile_dir: PathBuf,
    worker: Mutex<Option<BrowserWorker>>,
}

static SERVICE: OnceLock<PlaywrightPdfService> = OnceLock::new();
pub const PLAYWRIGHT_CDP_ENDPOINT: &str = "http://127.0.0.1:38465";

fn resource_file(name: &str) -> Result<PathBuf, String> {
    let root = std::env::var_os("ARIS_RESOURCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    let path = root.join(name);
    path.is_file()
        .then_some(path.clone())
        .ok_or_else(|| format!("bundled resource is missing: {}", path.display()))
}

fn bundled_node() -> Result<PathBuf, String> {
    let root = std::env::var_os("ARIS_RESOURCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    let path = root
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    path.is_file()
        .then_some(path.clone())
        .ok_or_else(|| format!("bundled Node runtime is missing: {}", path.display()))
}

fn task_string(task: &Value, key: &str) -> Result<String, String> {
    task[key]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("browser PDF task is missing {key}"))
}

impl PlaywrightPdfService {
    fn new(profile_dir: PathBuf) -> Self {
        Self {
            profile_dir,
            worker: Mutex::new(None),
        }
    }

    fn start_worker(&self) -> Result<BrowserWorker, String> {
        let launch = |profile_dir: &Path| -> Result<BrowserWorker, String> {
            std::fs::create_dir_all(profile_dir).map_err(|error| error.to_string())?;
            let mut child = runtime::hidden_command(bundled_node()?)
                .arg(resource_file("literature_playwright_download.cjs")?)
                .arg("--server")
                .arg("--profile-dir")
                .arg(profile_dir)
                .arg("--cdp-port")
                .arg("38465")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| {
                    format!("failed to start bundled Playwright downloader: {error}")
                })?;
            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| "Playwright worker stdin is unavailable".to_string())?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| "Playwright worker stdout is unavailable".to_string())?;
            let mut stdout = BufReader::new(stdout);
            let mut ready_line = String::new();
            let bytes = stdout
                .read_line(&mut ready_line)
                .map_err(|error| format!("could not read Playwright worker startup: {error}"))?;
            if bytes == 0 {
                let mut stderr = String::new();
                if let Some(mut stderr_reader) = child.stderr.take() {
                    let _ = std::io::Read::read_to_string(&mut stderr_reader, &mut stderr);
                }
                let _ = child.wait();
                return Err(format!(
                    "Playwright worker stopped during startup{}",
                    if stderr.trim().is_empty() {
                        String::new()
                    } else {
                        format!(": {}", stderr.trim())
                    }
                ));
            }
            let ready: Value = serde_json::from_str(&ready_line)
                .map_err(|error| format!("invalid Playwright worker startup response: {error}"))?;
            if ready["ready"] != Value::Bool(true) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Playwright worker did not become ready: {ready}"));
            }
            Ok(BrowserWorker {
                child,
                stdin,
                stdout,
            })
        };

        match launch(&self.profile_dir) {
            Ok(worker) => Ok(worker),
            Err(primary_error)
                if primary_error.contains("ProcessSingleton")
                    || primary_error.contains("profile directory")
                    || primary_error.contains("Lock file") =>
            {
                // A stale MCP/browser process may still own the shared profile.
                // Keep the app usable with a persistent fallback profile while
                // MCP connects to this worker over CDP (so it still shares the
                // exact browser session created here).
                let fallback = self.profile_dir.with_file_name("profile-worker");
                launch(&fallback).map_err(|fallback_error| {
                    format!(
                        "primary Playwright profile is locked: {primary_error}; fallback profile failed: {fallback_error}"
                    )
                })
            }
            Err(error) => Err(error),
        }
    }

    /// Send one download request; the worker's `result` object on success.
    fn request(&self, request: Value) -> Result<Value, String> {
        let mut worker_guard = self
            .worker
            .lock()
            .map_err(|_| "Playwright worker state is unavailable".to_string())?;
        if worker_guard.is_none() {
            *worker_guard = Some(self.start_worker()?);
        }
        let payload = serde_json::to_string(&request)
            .map_err(|error| format!("could not serialize Playwright request: {error}"))?;
        for attempt in 0..2 {
            let worker = worker_guard.as_mut().expect("worker was initialized above");
            if writeln!(worker.stdin, "{payload}")
                .and_then(|_| worker.stdin.flush())
                .is_err()
            {
                *worker_guard = None;
            } else {
                let mut line = String::new();
                if worker.stdout.read_line(&mut line).unwrap_or_default() != 0 {
                    let response: Value = serde_json::from_str(&line)
                        .map_err(|error| format!("invalid Playwright worker response: {error}"))?;
                    if response["ok"] == Value::Bool(true) {
                        return Ok(response["result"].clone());
                    }
                    return Err(response["error"]
                        .as_str()
                        .filter(|error| !error.trim().is_empty())
                        .unwrap_or("Playwright PDF download failed")
                        .to_string());
                }
                *worker_guard = None;
            }
            if attempt == 0 {
                *worker_guard = Some(self.start_worker()?);
                continue;
            }
            return Err("Playwright worker stopped while downloading the PDF".to_string());
        }
        unreachable!("worker retry loop always returns")
    }

    fn shutdown(&self) {
        let Ok(mut worker_guard) = self.worker.lock() else {
            return;
        };
        let Some(mut worker) = worker_guard.take() else {
            return;
        };
        let _ = writeln!(worker.stdin, "{{\"command\":\"shutdown\"}}");
        let _ = worker.stdin.flush();
        let _ = worker.child.kill();
        let _ = worker.child.wait();
    }
}

/// Start the headless browser session once during desktop initialization. The
/// first active project owns its persistent cookie profile for this app
/// session. The worker stays hidden because app startup is not an explicit
/// request to interact with a browser.
pub fn initialize(base: &Path) -> Result<(), String> {
    let profile_dir = tools::layout::scratch_tmp_dir_at(base)
        .join("browser")
        .join("profile");
    let service = SERVICE.get_or_init(|| PlaywrightPdfService::new(profile_dir));
    let mut worker = service
        .worker
        .lock()
        .map_err(|_| "Playwright worker state is unavailable".to_string())?;
    if worker.is_none() {
        *worker = Some(service.start_worker()?);
    }
    Ok(())
}

pub fn shutdown() {
    if let Some(service) = SERVICE.get() {
        service.shutdown();
    }
}

pub fn download_pdf_at(
    base: &Path,
    task: Value,
    file_name: &str,
    paper_id: Option<&str>,
) -> Result<Value, String> {
    let safe_name = tools::literature::sanitize_file_name(file_name)?;
    let papers_dir = tools::layout::papers_dir_at(base);
    std::fs::create_dir_all(&papers_dir).map_err(|error| error.to_string())?;
    let path = papers_dir.join(&safe_name);
    if path.exists() {
        return Err(format!(
            "refusing to overwrite existing PDF: {}",
            path.display()
        ));
    }

    let page_url = task_string(&task, "page_url")?;
    let pdf_url = task["pdf_url"].as_str().unwrap_or_default();
    let extractor = task["extractor"].as_str().unwrap_or_default();
    let expected = expected_identity(base, &task, paper_id);
    let work_dir = tools::layout::scratch_tmp_dir_at(base)
        .join("playwright-pdf-download")
        .join(format!("{:x}", epoch_millis()));
    let download_path = work_dir.join("download.pdf");
    std::fs::create_dir_all(&work_dir).map_err(|error| error.to_string())?;
    // A refused or failed download must not leave its bytes behind.
    let _work_dir = RemoveDirOnDrop(work_dir.clone());

    let service = SERVICE.get_or_init(|| {
        PlaywrightPdfService::new(
            tools::layout::scratch_tmp_dir_at(base)
                .join("browser")
                .join("profile"),
        )
    });
    let reply = service.request(json!({
        "pageUrl": page_url,
        "pdfUrl": pdf_url,
        "extractor": extractor,
        "output": download_path,
        "expected": expected,
    }))?;

    tools::literature::validate_pdf_file(&download_path)?;
    let pdf = std::fs::read(&download_path).map_err(|error| error.to_string())?;
    let identity = check_downloaded_identity(&expected, &reply, &pdf)?;
    let bytes = pdf.len();
    drop(pdf);
    std::fs::rename(&download_path, &path).map_err(|error| {
        format!("failed to move Playwright-downloaded PDF into place without overwrite: {error}")
    })?;
    if let Some(paper_id) = paper_id {
        tools::literature::mark_pdf_downloaded_at(base, paper_id, &safe_name, bytes)?;
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "relativePath": format!(".somniq/papers/{safe_name}"),
        "bytes": bytes,
        "method": "playwright",
        "identity": identity,
        "finalUrl": reply["finalUrl"],
    }))
}

struct RemoveDirOnDrop(PathBuf);

impl Drop for RemoveDirOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// What the caller asked for: the task's DOI/title and, when the download is
/// for a library paper, that record's DOI/title.
fn expected_identity(
    base: &Path,
    task: &Value,
    paper_id: Option<&str>,
) -> tools::literature::ExpectedPaperIdentity {
    let mut expected = tools::literature::ExpectedPaperIdentity::default();
    if let Some(doi) = task["doi"].as_str() {
        expected.add_doi(doi);
    }
    if let Some(title) = task["title"].as_str() {
        expected.add_title(title);
    }
    if let Some(paper_id) = paper_id {
        if let Ok(record) = tools::literature::library_paper_identity_at(base, paper_id) {
            expected.merge(&record);
        }
    }
    expected
}

/// The identity gate before the PDF enters `papers/`.
///
/// The worker already refused anything its own scan found contradicting the
/// caller or the landing page; this re-checks with a real PDF parser and adds
/// the landing page's declared identity to what is expected. A mismatch here
/// rejects; otherwise the stronger of the two verdicts is reported.
fn check_downloaded_identity(
    expected: &tools::literature::ExpectedPaperIdentity,
    reply: &Value,
    pdf: &[u8],
) -> Result<tools::literature::PdfIdentityVerdict, String> {
    use tools::literature::{PdfIdentityStatus, PdfIdentityVerdict};

    let mut expected = expected.clone();
    if let Ok(page) = serde_json::from_value::<tools::literature::ExpectedPaperIdentity>(
        reply["pageIdentity"].clone(),
    ) {
        for doi in &page.dois {
            expected.add_doi(doi);
        }
        for title in page.titles.iter().chain(&page.page_titles) {
            expected.add_page_title(title);
        }
    }
    let evidence = pdf_identity_evidence(pdf).unwrap_or_default();
    let verdict = tools::literature::validate_pdf_identity(&expected, &evidence)?;
    let worker = serde_json::from_value::<PdfIdentityVerdict>(reply["identity"].clone()).ok();
    Ok(match worker {
        Some(worker)
            if worker.status != PdfIdentityStatus::Mismatch && worker.status > verdict.status =>
        {
            worker
        }
        _ => verdict,
    })
}

/// DOIs and titles from the document information dictionary and XMP, and
/// the text of the first two pages. `None` when lopdf cannot read the file.
fn pdf_identity_evidence(pdf: &[u8]) -> Option<tools::literature::PdfIdentityEvidence> {
    // lopdf has panicked on malformed publisher PDFs; a bad file must fail the
    // check, not the download thread.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let document = lopdf::Document::load_mem(pdf).ok()?;
        let mut evidence = tools::literature::PdfIdentityEvidence::default();

        let info = document
            .trailer
            .get(b"Info")
            .ok()
            .and_then(|info| document.dereference(info).ok())
            .and_then(|(_, info)| info.as_dict().ok());
        for (key, value) in info.into_iter().flat_map(|info| info.iter()) {
            let Ok(text) = lopdf::decode_text_string(value) else {
                continue;
            };
            if key.as_slice() == b"Title" {
                evidence.metadata_titles.push(text.clone());
            }
            if text.contains("10.") {
                evidence.metadata_dois.push(text);
            }
        }

        let xmp = document
            .catalog()
            .ok()
            .and_then(|catalog| catalog.get(b"Metadata").ok())
            .and_then(|metadata| document.dereference(metadata).ok())
            .and_then(|(_, metadata)| metadata.as_stream().ok())
            .and_then(|stream| stream.decompressed_content().ok())
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
        if let Some(xmp) = xmp {
            evidence
                .metadata_dois
                .extend(tools::literature::extract_dois(&xmp));
            if let Some(title) = xmp_title(&xmp) {
                evidence.metadata_titles.push(title);
            }
        }

        for page_id in document.get_pages().values().take(2) {
            append_page_text(&document, *page_id, &mut evidence.front_text);
            if evidence.front_text.len() >= tools::literature::PDF_IDENTITY_FRONT_TEXT_CHARS {
                break;
            }
            evidence.front_text.push('\n');
        }
        Some(evidence)
    }))
    .ok()
    .flatten()
}

fn xmp_title(xmp: &str) -> Option<String> {
    let block = &xmp[xmp.find("<dc:title")?..];
    let block = &block[..block.find("</dc:title>")?];
    let item = &block[block.find("<rdf:li")?..];
    let text = &item[item.find('>')? + 1..];
    let text = &text[..text.find("</rdf:li>")?];
    let text = text
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    (!text.trim().is_empty()).then(|| text.trim().to_string())
}

/// Page text with line breaks at text moves and spaces at wide TJ kerning,
/// which `lopdf::Document::extract_text` drops: without them a DOI runs into
/// the next line and title words run together.
fn append_page_text(document: &lopdf::Document, page_id: lopdf::ObjectId, out: &mut String) {
    fn push_operands(
        out: &mut String,
        encoding: Option<&lopdf::Encoding>,
        operands: &[lopdf::Object],
    ) {
        for operand in operands {
            match operand {
                lopdf::Object::String(bytes, _) => match encoding {
                    Some(encoding) => {
                        let _ = encoding.write_to_string(bytes, out);
                    }
                    None => out.extend(bytes.iter().map(|byte| char::from(*byte))),
                },
                lopdf::Object::Array(items) => push_operands(out, encoding, items),
                lopdf::Object::Integer(kern) if *kern < -150 => out.push(' '),
                lopdf::Object::Real(kern) if *kern < -150.0 => out.push(' '),
                _ => {}
            }
        }
    }

    let Ok(content) = document.get_and_decode_page_content(page_id) else {
        return;
    };
    let encodings: std::collections::BTreeMap<Vec<u8>, lopdf::Encoding> = document
        .get_page_fonts(page_id)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(name, font)| font.get_font_encoding(document).ok().map(|e| (name, e)))
        .collect();
    let mut encoding = None;
    for operation in &content.operations {
        if out.len() >= tools::literature::PDF_IDENTITY_FRONT_TEXT_CHARS {
            return;
        }
        match operation.operator.as_str() {
            "Tf" => {
                encoding = operation
                    .operands
                    .first()
                    .and_then(|name| name.as_name().ok())
                    .and_then(|name| encodings.get(name));
            }
            "Tj" | "TJ" => push_operands(out, encoding, &operation.operands),
            "'" | "\"" => {
                out.push('\n');
                push_operands(out, encoding, &operation.operands);
            }
            "Td" | "TD" | "T*" | "Tm" | "ET" => out.push('\n'),
            _ => {}
        }
    }
}

fn epoch_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tools::literature::{ExpectedPaperIdentity, PdfIdentityStatus};

    /// The R0 publisher fixture's PDF (benchmarks/computer-use/fixtures/
    /// publisher/pdf.mjs): uncompressed, one Helvetica text block per page,
    /// the DOI in the text and in `/Subject`.
    fn fixture_pdf(title: &str, doi: &str, pages: usize) -> Vec<u8> {
        let mut objects = vec![
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_string()),
            (
                2,
                format!(
                    "<< /Type /Pages /Kids [{}] /Count {pages} >>",
                    (0..pages)
                        .map(|page| format!("{} 0 R", 4 + 2 * page))
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
            ),
            (
                3,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            ),
        ];
        for page in 0..pages {
            // The repeated note makes the stream large enough that
            // `lopdf::Document::compress` actually deflates it.
            let stream = format!(
                "BT\n/F1 14 Tf\n72 720 Td\n({title}) Tj\n0 -22 Td\n(DOI: {doi}) Tj\n0 -22 Td\n(Page {} of {pages}) Tj\n{}ET",
                page + 1,
                "0 -22 Td\n(SomniQ R0 publisher fixture. Not a real paper.) Tj\n".repeat(6)
            );
            objects.push((
                4 + 2 * page,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents "
                    .to_string()
                    + &format!("{} 0 R >>", 5 + 2 * page),
            ));
            objects.push((
                5 + 2 * page,
                format!(
                    "<< /Length {} >>\nstream\n{stream}\nendstream",
                    stream.len()
                ),
            ));
        }
        let info = 4 + 2 * pages;
        objects.push((
            info,
            format!("<< /Title ({title}) /Subject ({doi}) /Producer (SomniQ R0 fixture) >>"),
        ));
        let mut body = String::from("%PDF-1.4\n");
        let mut offsets = vec![0; objects.len() + 1];
        for (id, content) in &objects {
            offsets[*id] = body.len();
            body.push_str(&format!("{id} 0 obj\n{content}\nendobj\n"));
        }
        let xref = body.len();
        body.push_str(&format!(
            "xref\n0 {}\n0000000000 65535 f \n",
            objects.len() + 1
        ));
        for offset in &offsets[1..] {
            body.push_str(&format!("{offset:010} 00000 n \n"));
        }
        body.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R /Info {info} 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        ));
        body.into_bytes()
    }

    fn compressed(pdf: &[u8]) -> Vec<u8> {
        let mut document = lopdf::Document::load_mem(pdf).expect("fixture PDF loads");
        document.compress();
        let mut out = Vec::new();
        document.save_to(&mut out).expect("save compressed PDF");
        out
    }

    #[test]
    fn the_startup_browser_worker_is_headless() {
        let script = include_str!("../resources/literature_playwright_download.cjs");
        assert!(script.contains("headless: true"));
        assert!(!script.contains("headless: false"));
    }

    #[test]
    fn pdf_identity_evidence_reads_info_and_page_text_plain_and_compressed() {
        let plain = fixture_pdf(
            "Open Access Fixture: Measuring Reviewer Agreement",
            "10.5555/somniq.r0.0001",
            3,
        );
        let squeezed = compressed(&plain);
        assert!(
            !squeezed.windows(4).any(|window| window == b"DOI:"),
            "the compressed copy must not expose the text to a byte search"
        );
        for pdf in [plain, squeezed] {
            let evidence = pdf_identity_evidence(&pdf).expect("lopdf reads the fixture");
            assert_eq!(
                evidence.metadata_titles,
                vec!["Open Access Fixture: Measuring Reviewer Agreement".to_string()]
            );
            assert!(evidence
                .metadata_dois
                .iter()
                .any(|value| value == "10.5555/somniq.r0.0001"));
            // Line breaks at text moves keep the DOI apart from "Page 1".
            assert!(
                evidence
                    .front_text
                    .contains("\nDOI: 10.5555/somniq.r0.0001\n"),
                "{:?}",
                evidence.front_text
            );
            assert!(evidence.front_text.contains("Page 2 of 3"));
            assert!(
                !evidence.front_text.contains("Page 3 of 3"),
                "only two pages are read"
            );
        }
        assert!(pdf_identity_evidence(b"%PDF-1.4\nnot really a pdf").is_none());
    }

    #[test]
    fn the_ingest_gate_refuses_a_pdf_for_another_doi_than_the_landing_page() {
        // C7-MISMATCH: no caller expectation, the landing page declares …0003.
        let served = fixture_pdf("A Different Paper Entirely", "10.5555/somniq.r0.0099", 2);
        let reply = json!({
            "pageIdentity": {
                "dois": ["10.5555/somniq.r0.0003"],
                "titles": ["Mismatch Fixture: The Page Says One Paper"],
            },
        });
        let error = check_downloaded_identity(&ExpectedPaperIdentity::default(), &reply, &served)
            .expect_err("a mismatched PDF must not enter the library");
        assert!(error.starts_with("identity_mismatch:"), "{error}");
        assert!(error.contains("10.5555/somniq.r0.0099"), "{error}");
    }

    #[test]
    fn the_ingest_gate_checks_the_caller_expectation_even_when_the_page_declares_nothing() {
        let served = compressed(&fixture_pdf(
            "A Different Paper Entirely",
            "10.5555/somniq.r0.0099",
            2,
        ));
        let mut expected = ExpectedPaperIdentity::default();
        expected.add_doi("https://doi.org/10.5555/somniq.r0.0003");
        let error = check_downloaded_identity(&expected, &json!({}), &served)
            .expect_err("the caller's DOI is not in the PDF");
        assert!(error.starts_with("identity_mismatch:"), "{error}");

        let mut right = ExpectedPaperIdentity::default();
        right.add_doi("10.5555/SOMNIQ.R0.0099");
        let verdict = check_downloaded_identity(&right, &json!({}), &served).expect("matches");
        assert_eq!(verdict.status, PdfIdentityStatus::Verified);
        assert_eq!(verdict.matched_by.as_deref(), Some("doi"));
    }

    #[test]
    fn the_ingest_gate_reports_the_stronger_of_its_own_and_the_workers_verdict() {
        // No expectation at all: Rust can only say "unchecked", the worker may
        // have verified against something it saw on the page.
        let pdf = fixture_pdf("Some Paper", "10.5555/somniq.r0.0001", 1);
        let reply = json!({
            "identity": { "status": "verified", "matchedBy": "title", "foundDois": [], "reason": "worker" },
        });
        let verdict = check_downloaded_identity(&ExpectedPaperIdentity::default(), &reply, &pdf)
            .expect("kept");
        assert_eq!(verdict.status, PdfIdentityStatus::Verified);
        assert_eq!(verdict.reason, "worker");

        let unverifiable = b"%PDF-1.4\nnot really a pdf".to_vec();
        let mut expected = ExpectedPaperIdentity::default();
        expected.add_doi("10.5555/somniq.r0.0001");
        let verdict = check_downloaded_identity(&expected, &json!({}), &unverifiable)
            .expect("an unreadable PDF is not evidence of a wrong paper");
        assert_eq!(verdict.status, PdfIdentityStatus::Unverified);
    }

    #[test]
    fn expected_identity_takes_only_real_task_fields() {
        let base = std::env::temp_dir().join(format!("somniq-pw-identity-{:x}", epoch_millis()));
        let empty = expected_identity(&base, &json!({ "title": "", "doi": "" }), None);
        assert!(empty.is_empty());
        let task = json!({
            "title": "Measuring  Reviewer\nAgreement",
            "doi": "https://doi.org/10.5555/somniq.r0.0001",
        });
        let expected = expected_identity(&base, &task, None);
        assert_eq!(expected.dois, vec!["10.5555/somniq.r0.0001".to_string()]);
        assert_eq!(
            expected.titles,
            vec!["Measuring Reviewer Agreement".to_string()]
        );
    }
}
