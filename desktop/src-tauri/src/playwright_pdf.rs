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

    fn request(&self, request: Value) -> Result<(), String> {
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
                        return Ok(());
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

/// Start the real browser session once during desktop initialization. The first
/// active project owns its persistent cookie profile for this app session.
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
    let work_dir = tools::layout::scratch_tmp_dir_at(base)
        .join("playwright-pdf-download")
        .join(format!("{:x}", epoch_millis()));
    let download_path = work_dir.join("download.pdf");
    std::fs::create_dir_all(&work_dir).map_err(|error| error.to_string())?;

    let service = SERVICE.get_or_init(|| {
        PlaywrightPdfService::new(
            tools::layout::scratch_tmp_dir_at(base)
                .join("browser")
                .join("profile"),
        )
    });
    service.request(json!({
        "pageUrl": page_url,
        "pdfUrl": pdf_url,
        "extractor": extractor,
        "output": download_path,
    }))?;

    tools::literature::validate_pdf_file(&download_path)?;
    let bytes = std::fs::metadata(&download_path)
        .map_err(|error| error.to_string())?
        .len() as usize;
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
        "method": "playwright"
    }))
}

fn epoch_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}
