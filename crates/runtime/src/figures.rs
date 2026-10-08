//! Local figure artifacts and a write-ahead ledger for bounded model requests.
//! No request marked submitted is automatically sent again after a restart.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub mod svg_edits;
pub use svg_edits::FigureSvgEdit;

static WRITES: Mutex<()> = Mutex::new(());
pub const MAX_SVG_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_SOURCE_BYTES: usize = 10 * 1024 * 1024;
/// Sanity bound on a recorded output cap; Chat's largest is 128K.
pub const MAX_OUTPUT_LIMIT: u32 = 1_000_000;

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Stable gateway affinity across probes, revisions and later reviews. Roles
/// remain separate even when a project imports a figure with an existing ID.
pub fn routing_session_id(workspace: &Path, id: &str, role: &str) -> String {
    let workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let project = hash(workspace.to_string_lossy().as_bytes());
    format!("figure-{}-{id}-{role}", &project[..16])
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelIdentity {
    pub model: String,
    pub provider: String,
    pub endpoint: String,
    pub transport: String,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FigureRequest {
    pub id: String,
    pub kind: String,
    pub role: String,
    pub identity: ModelIdentity,
    pub max_output_tokens: u32,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub stop_reason: Option<String>,
    pub usage: Option<Value>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FigureVersion {
    pub index: usize,
    #[serde(default)]
    pub parent_index: Option<usize>,
    #[serde(default)]
    pub svg_edit_id: Option<String>,
    pub hash: String,
    pub svg_path: String,
    pub png_path: String,
    #[serde(default)]
    pub png_hash: String,
    pub pdf_path: String,
    pub author: String,
    pub classification: String,
    pub text_count: usize,
    pub vector_count: usize,
    pub review_status: String,
    pub renderer: String,
    pub font_fingerprint: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FigureReview {
    pub version_hash: String,
    pub structure_pass: bool,
    pub visual_pass: Option<bool>,
    pub issues: Vec<String>,
    pub received_images: bool,
    pub evidence_hashes: Vec<String>,
    pub raw_response: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FigureRasterVersion {
    pub index: usize,
    pub hash: String,
    pub path: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub parent_hash: Option<String>,
    #[serde(default)]
    pub parent_index: Option<usize>,
    pub prompt: Option<String>,
    pub mask_path: Option<String>,
    pub request_id: Option<String>,
    #[serde(default)]
    pub prompt_request_id: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FigureRun {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub method: String,
    pub style: String,
    pub source_mode: String,
    pub source_mime: Option<String>,
    pub source_hash: Option<String>,
    pub status: String,
    /// Output-token cap resolved from Chat's policy for the Executor when the
    /// task was prepared; 0 sends none, so the provider default applies.
    /// Earlier tasks recorded a user-chosen 8K–50K budget and keep it.
    pub output_limit: u32,
    pub executor: ModelIdentity,
    pub reviewer: ModelIdentity,
    #[serde(default)]
    pub image_identity: Option<ModelIdentity>,
    #[serde(default)]
    pub raster_versions: Vec<FigureRasterVersion>,
    /// A successfully returned edit awaiting a local application choice.
    #[serde(default)]
    pub pending_raster_edit: Option<FigureRasterVersion>,
    #[serde(default)]
    pub source_raster: Option<usize>,
    #[serde(default)]
    pub image_confirmed: bool,
    pub executor_vision: bool,
    pub reviewer_vision: bool,
    pub revision_used: bool,
    pub versions: Vec<FigureVersion>,
    #[serde(default)]
    pub svg_edits: Vec<FigureSvgEdit>,
    pub requests: Vec<FigureRequest>,
    pub review: Option<FigureReview>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl FigureRun {
    pub fn current_hash(&self) -> Option<&str> {
        self.versions.last().map(|v| v.hash.as_str())
    }
    pub fn request_limit(&self) -> usize {
        if self.source_mode == "generate" {
            8
        } else {
            6
        }
    }
    pub fn can_start(&self) -> bool {
        self.status == "ready" && self.requests.is_empty()
    }
    pub fn can_confirm_image(&self) -> bool {
        self.status == "image_ready" && !self.image_confirmed && self.versions.is_empty()
            && self.pending_raster_edit.is_none()
            && self.source_hash.is_some()
            && !self.requests.iter().any(|r| matches!(r.status.as_str(), "submitted" | "unknown"))
    }
}

pub fn validate_id(id: &str) -> Result<(), String> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid figure task ID".into());
    }
    Ok(())
}

/// Canonicalize each level, including existing directories, before writing.
pub fn directory(workspace: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    let root = workspace.canonicalize().map_err(|e| e.to_string())?;
    let mut path = root.clone();
    for component in [".somniq", "artifacts", "figures", id] {
        path.push(component);
        if !path.exists() {
            fs::create_dir(&path).map_err(|e| e.to_string())?;
        }
        path = path.canonicalize().map_err(|e| e.to_string())?;
        if !path.starts_with(&root) {
            return Err("Figure directory must remain inside its project".into());
        }
    }
    Ok(path)
}

fn write_run(dir: &Path, run: &FigureRun) -> Result<(), String> {
    crate::write_file_atomically(
        &dir.join("manifest.json"),
        serde_json::to_vec_pretty(run).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn create(
    workspace: &Path,
    mut run: FigureRun,
    source: Option<&[u8]>,
) -> Result<FigureRun, String> {
    let _lock = WRITES.lock().map_err(|e| e.to_string())?;
    let dir = directory(workspace, &run.id)?;
    if dir.join("manifest.json").exists() {
        let existing = load(workspace, &run.id)?;
        if existing.method != run.method
            || existing.style != run.style
            || existing.output_limit != run.output_limit
            || existing.executor != run.executor
            || existing.reviewer != run.reviewer
            || existing.image_identity != run.image_identity
            || existing.source_mode != run.source_mode
            || source
                .is_some_and(|bytes| existing.source_hash.as_deref() != Some(hash(bytes).as_str()))
        {
            return Err("Task ID already belongs to different inputs".into());
        }
        return Ok(existing);
    }
    if run.output_limit > MAX_OUTPUT_LIMIT {
        return Err("Unsupported output limit".into());
    }
    if run.method.trim().is_empty() || run.method.len() > 40_000 {
        return Err("Provide a method description (at most 40,000 characters)".into());
    }
    if let Some(bytes) = source {
        if bytes.len() > MAX_SOURCE_BYTES {
            return Err("Source image exceeds 10 MiB".into());
        }
        crate::write_file_atomically(&dir.join("figure.source"), bytes)
            .map_err(|e| e.to_string())?;
        let extension = match run.source_mime.as_deref() {
            Some("image/png") => "png",
            Some("image/jpeg") => "jpg",
            _ => "webp",
        };
        crate::write_file_atomically(&dir.join(format!("figure.{extension}")), bytes)
            .map_err(|e| e.to_string())?;
        run.source_hash = Some(hash(bytes));
    }
    write_run(&dir, &run)?;
    Ok(run)
}

pub fn load(workspace: &Path, id: &str) -> Result<FigureRun, String> {
    let dir = directory(workspace, id)?;
    let path = dir.join("manifest.json");
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&dir) {
        return Err("Invalid figure manifest path".into());
    }
    let bytes = fs::read(&canonical).map_err(|e| e.to_string())?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Figure manifest is too large".into());
    }
    let run: FigureRun = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if run.id != id || run.schema_version != 1 {
        return Err("Unsupported figure manifest".into());
    }
    Ok(run)
}

pub fn update<T>(
    workspace: &Path,
    id: &str,
    operation: impl FnOnce(&mut FigureRun) -> Result<T, String>,
) -> Result<(FigureRun, T), String> {
    let _lock = WRITES.lock().map_err(|e| e.to_string())?;
    let dir = directory(workspace, id)?;
    let mut run = load(workspace, id)?;
    let result = operation(&mut run)?;
    run.updated_at = crate::now_iso8601();
    write_run(&dir, &run)?;
    Ok((run, result))
}

pub fn list(workspace: &Path) -> Result<Vec<FigureRun>, String> {
    let root = workspace.join(".somniq/artifacts/figures");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut runs = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if validate_id(&id).is_ok() {
            if let Ok(run) = load(workspace, &id) {
                runs.push(run);
            }
        }
    }
    runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(runs)
}

/// Remove a task and all of its artifacts. Missing tasks are already deleted.
/// The path is resolved without creating directories and must stay inside the
/// project's figure root.
pub fn delete(workspace: &Path, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let _lock = WRITES.lock().map_err(|e| e.to_string())?;
    let root = workspace.canonicalize().map_err(|e| e.to_string())?;
    let path = root.join(".somniq").join("artifacts").join("figures").join(id);
    if !path.exists() {
        return Ok(());
    }
    let figures = root
        .join(".somniq/artifacts/figures")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if !figures.starts_with(&root) || canonical.parent() != Some(figures.as_path()) || !canonical.is_dir() {
        return Err("Figure directory must remain inside its project".into());
    }
    fs::remove_dir_all(&canonical).map_err(|e| e.to_string())
}

pub fn recover(workspace: &Path, id: &str) -> Result<FigureRun, String> {
    update(workspace, id, |run| {
        if run.requests.iter().any(|r| matches!(r.status.as_str(), "submitted" | "unknown")) {
            let was_submitted = run.requests.iter().any(|r| r.status == "submitted");
            for request in &mut run.requests {
                if request.status == "submitted" { request.status = "unknown".into(); }
            }
            run.status = "unknown".into();
            if was_submitted || run.error.is_none() {
                run.error = Some("A submitted request has no recorded result. Check usage before creating a new task; it will not be sent again automatically.".into());
            }
        } else if run.pending_raster_edit.is_some() {
            if run.status == "editing_image" {
                run.status = if !run.image_confirmed && run.versions.is_empty() { "image_ready" } else { "draft" }.into();
            }
            run.error = None;
        } else if matches!(run.status.as_str(), "probing" | "planning_image" | "planning_image_edit" | "generating" | "editing_image" | "editing_svg" | "reconstructing" | "reviewing" | "revising") {
            run.status = "draft".into();
            run.error = Some("Processing stopped. Saved artifacts remain available; no request is repeated automatically.".into());
        }
        for edit in &mut run.svg_edits {
            if edit.status == "running" {
                edit.status = if run.status == "unknown" { "unknown" } else { "interrupted" }.into();
                edit.error = run.error.clone();
                edit.finished_at = Some(crate::now_iso8601());
            }
        }
        Ok(())
    }).map(|(run, ())| run)
}

pub fn begin_request(
    workspace: &Path,
    id: &str,
    kind: &str,
    role: &str,
    identity: ModelIdentity,
    max_output_tokens: u32,
) -> Result<FigureRequest, String> {
    update(workspace, id, |run| {
        if (!matches!(kind, "manual_review" | "manual_image_edit" | "manual_image_prompt" | "manual_svg_edit")
            && run
                .requests
                .iter()
                .filter(|r| !matches!(r.kind.as_str(), "manual_review" | "manual_image_edit" | "manual_image_prompt" | "manual_svg_edit"))
                .count()
                >= run.request_limit())
            || run.requests.len() >= 200
        {
            return Err("Figure request budget exhausted".into());
        }
        if run
            .requests
            .iter()
            .any(|r| r.status == "submitted" || r.status == "unknown")
        {
            return Err("A previous submitted request is unresolved".into());
        }
        if run.pending_raster_edit.is_some() && matches!(kind, "manual_image_prompt" | "manual_image_edit") {
            return Err("Choose how to apply the returned image first".into());
        }
        let request = FigureRequest {
            id: format!("request-{:02}", run.requests.len() + 1),
            kind: kind.into(),
            role: role.into(),
            identity,
            max_output_tokens,
            status: "submitted".into(),
            started_at: crate::now_iso8601(),
            finished_at: None,
            stop_reason: None,
            usage: None,
            error: None,
            duration_ms: 0,
        };
        run.requests.push(request.clone());
        Ok(request)
    })
    .map(|(_, request)| request)
}

pub fn source(workspace: &Path, run: &FigureRun) -> Result<Vec<u8>, String> {
    let path = match run.source_raster {
        Some(index) => run.raster_versions.iter().find(|v| v.index == index).ok_or("Missing reference image version")?.path.as_str(),
        None => "figure.source",
    };
    let bytes = read_artifact(workspace, &run.id, path, MAX_SOURCE_BYTES)?;
    if run.source_hash.as_deref() != Some(hash(&bytes).as_str()) {
        return Err("Source image changed".into());
    }
    Ok(bytes)
}

/// Adds an immutable image revision. Only the unconfirmed input can change;
/// later PNG edits never invalidate the reference used by an existing SVG.
fn append_raster(workspace: &Path, id: &str, run: &mut FigureRun, mut version: FigureRasterVersion, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_SOURCE_BYTES || hash(bytes) != version.hash {
        return Err("Invalid raster image or hash".into());
    }
    if run.raster_versions.len() >= 100 { return Err("Image version limit reached".into()); }
    if let Some(parent) = &version.parent_hash {
        if !run.raster_versions.iter().any(|v| &v.hash == parent && version.parent_index.is_none_or(|index| v.index == index)) { return Err("Image parent version changed".into()); }
    }
    version.index = run.raster_versions.len() + 1;
    version.path = format!("raster-{:03}.image", version.index);
    let path = directory(workspace, id)?.join(&version.path);
    // A crash may leave a completed file before its manifest update. Reuse
    // identical pixels; preserve a different orphan under its original name.
    if path.exists() && hash(&read_artifact(workspace, id, &version.path, MAX_SOURCE_BYTES)?) != version.hash {
        version.path = format!("raster-{:03}-{}.image", version.index, &version.hash[..16]);
    }
    let path = directory(workspace, id)?.join(&version.path);
    if path.exists() {
        if hash(&read_artifact(workspace, id, &version.path, MAX_SOURCE_BYTES)?) != version.hash {
            return Err("Image version already exists".into());
        }
    } else { crate::write_file_atomically(&path, bytes).map_err(|e| e.to_string())?; }
    if !run.image_confirmed && run.versions.is_empty() && matches!(run.status.as_str(), "ready" | "generating" | "image_ready" | "editing_image") {
        run.source_raster = Some(version.index);
        run.source_hash = Some(version.hash.clone());
        run.source_mime = Some(version.mime_type.clone());
    }
    run.raster_versions.push(version);
    Ok(())
}

pub fn save_raster(workspace: &Path, id: &str, version: FigureRasterVersion, bytes: &[u8]) -> Result<FigureRun, String> {
    update(workspace, id, |run| {
        append_raster(workspace, id, run, version, bytes)
    }).map(|(run, ())| run)
}

/// Local application never submits a request. The candidate and accepted
/// version change in the same manifest update, preventing duplicate adoption.
pub fn resolve_raster_edit(workspace: &Path, id: &str, request_id: &str, expected_hash: &str,
    choice: &str, result: Option<(FigureRasterVersion, &[u8])>) -> Result<FigureRun, String> {
    update(workspace, id, |run| {
        let candidate = run.pending_raster_edit.as_ref().ok_or("图片结果已处理，请刷新。")?.clone();
        if candidate.request_id.as_deref() != Some(request_id) || candidate.hash != expected_hash {
            return Err("图片结果已变更，请刷新后重新选择。".into());
        }
        if !run.requests.iter().enumerate().any(|(index, request)| request.id == request_id
            && request_id == format!("request-{:02}", index + 1) && request.kind == "manual_image_edit" && request.status == "completed") {
            return Err("Missing completed image request".into());
        }
        if !matches!(choice, "returned" | "selection" | "keep" | "aligned") || (choice == "keep") != result.is_none()
            || run.requests.iter().any(|r| matches!(r.status.as_str(), "submitted" | "unknown")) {
            return Err("当前无法采用图片结果。".into());
        }
        if let Some((version, bytes)) = result {
            if version.request_id.as_deref() != Some(request_id) || version.parent_index != candidate.parent_index || version.parent_hash != candidate.parent_hash {
                return Err("Image result parent changed".into());
            }
            if choice == "aligned" && !run.raster_versions.iter().any(|parent|
                Some(parent.index) == candidate.parent_index && Some(&parent.hash) == candidate.parent_hash.as_ref()
                    && (parent.width, parent.height) == (version.width, version.height)) {
                return Err("Automatic alignment must retain original dimensions".into());
            }
            append_raster(workspace, id, run, version, bytes)?;
            // A restored legacy edit can be in draft before SVG was started.
            if !run.image_confirmed && run.versions.is_empty() {
                let version = run.raster_versions.last().ok_or("Missing image version")?;
                run.source_raster = Some(version.index); run.source_hash = Some(version.hash.clone()); run.source_mime = Some(version.mime_type.clone());
            }
        }
        crate::write_file_atomically(&directory(workspace, id)?.join(format!("{request_id}.application.json")),
            serde_json::to_vec_pretty(&serde_json::json!({"choice": choice, "automatic": choice == "aligned", "returnedHash": candidate.hash,
                "returnedWidth": candidate.width, "returnedHeight": candidate.height,
                "parentHash": candidate.parent_hash, "parentIndex": candidate.parent_index,
                "appliedHash": if choice == "keep" { None } else { run.raster_versions.last().map(|v| &v.hash) },
                "appliedWidth": if choice == "keep" { None } else { run.raster_versions.last().map(|v| v.width) },
                "appliedHeight": if choice == "keep" { None } else { run.raster_versions.last().map(|v| v.height) },
                "createdAt": crate::now_iso8601()})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        run.pending_raster_edit = None;
        run.error = None;
        if !run.image_confirmed && run.versions.is_empty() { run.status = "image_ready".into(); }
        Ok(())
    }).map(|(run, ())| run)
}

pub fn select_raster(workspace: &Path, id: &str, index: usize, expected_hash: &str) -> Result<FigureRun, String> {
    update(workspace, id, |run| {
        if !run.can_confirm_image() || run.source_hash.as_deref() != Some(expected_hash) {
            return Err("Reference changed or SVG reconstruction already started".into());
        }
        let version = run.raster_versions.iter().find(|v| v.index == index).ok_or("Missing image version")?;
        run.source_hash = Some(version.hash.clone());
        run.source_mime = Some(version.mime_type.clone());
        run.source_raster = Some(index);
        Ok(())
    }).map(|(run, ())| run)
}

pub fn confirm_image(workspace: &Path, id: &str, expected_hash: &str) -> Result<FigureRun, String> {
    update(workspace, id, |run| {
        if !run.can_confirm_image() || run.source_hash.as_deref() != Some(expected_hash) {
            return Err("图片已变更或重建已经启动，请重新确认当前图片。".into());
        }
        run.image_confirmed = true; run.error = None; run.status = "probing".into();
        Ok(())
    }).map(|(run, ())| run)
}

pub fn read_artifact(
    workspace: &Path,
    id: &str,
    relative: &str,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let dir = directory(workspace, id)?;
    let path = dir
        .join(relative)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(&dir) {
        return Err("Artifact path escaped the figure task".into());
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > limit as u64 {
        return Err("Artifact exceeds size limit".into());
    }
    fs::read(path).map_err(|e| e.to_string())
}

pub fn save_version(
    workspace: &Path,
    id: &str,
    expected_hash: Option<&str>,
    svg: &str,
    png: &[u8],
    pdf: &[u8],
    mut version: FigureVersion,
) -> Result<FigureRun, String> {
    let _lock = WRITES.lock().map_err(|e| e.to_string())?;
    let dir = directory(workspace, id)?;
    let mut run = load(workspace, id)?;
    if run.current_hash() != expected_hash {
        return Err(
            "Figure changed. Reload before saving; your draft has not been overwritten.".into(),
        );
    }
    if run.versions.len() >= 100 {
        return Err("Figure version limit reached".into());
    }
    version.parent_index = version.parent_index.or_else(|| run.versions.last().map(|v| v.index));
    if version.parent_index.is_some_and(|index| !run.versions.iter().any(|v| v.index == index)) {
        return Err("SVG parent version not found".into());
    }
    if let Some(edit_id) = &version.svg_edit_id {
        let latest_index = run.versions.last().map(|v| v.index);
        let edit = run.svg_edits.iter_mut().find(|edit| &edit.id == edit_id).ok_or("SVG edit not found")?;
        if edit.status != "running" || edit.result_version.is_some()
            || Some(edit.base_version) != latest_index || Some(edit.base_version) != version.parent_index || Some(edit.base_hash.as_str()) != expected_hash {
            return Err("SVG edit no longer matches its saved base".into());
        }
        // Link the prompt and output in the same manifest write as the version.
        edit.result_version = Some(run.versions.len() + 1);
    }
    let versions = dir.join("versions");
    fs::create_dir_all(&versions).map_err(|e| e.to_string())?;
    if !versions
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(&dir)
    {
        return Err("Invalid version directory".into());
    }
    version.index = run.versions.len() + 1;
    version.hash = hash(svg.as_bytes());
    version.svg_path = format!("versions/{:04}.svg", version.index);
    version.png_path = format!("versions/{:04}.png", version.index);
    version.png_hash = hash(png);
    version.pdf_path = format!("versions/{:04}.pdf", version.index);
    for (path, bytes) in [
        (&version.svg_path, svg.as_bytes()),
        (&version.png_path, png),
        (&version.pdf_path, pdf),
    ] {
        crate::write_file_atomically(&dir.join(path), bytes).map_err(|e| e.to_string())?;
    }
    if run.versions.is_empty() {
        crate::write_file_atomically(&dir.join("template.svg"), svg).map_err(|e| e.to_string())?;
    }
    // This is the editor source of truth even while visual review is pending.
    crate::write_file_atomically(&dir.join("current.svg"), svg).map_err(|e| e.to_string())?;
    run.versions.push(version);
    run.review = None;
    run.error = None;
    run.status = "draft".into();
    run.updated_at = crate::now_iso8601();
    write_run(&dir, &run)?;
    // The last accepted snapshot lives in its immutable version. Do not leave
    // a stale `final.svg` looking like the newly edited source.
    let final_path = dir.join("final.svg");
    if final_path.exists() {
        fs::remove_file(&final_path).map_err(|e| e.to_string())?;
    }
    Ok(run)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routing_sessions_are_stable_and_isolated_by_project_task_and_role() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let executor = routing_session_id(first.path(), "task-a", "executor");
        assert_eq!(
            executor,
            routing_session_id(&first.path().join("."), "task-a", "executor")
        );
        assert_ne!(executor, routing_session_id(first.path(), "task-a", "reviewer"));
        assert_ne!(executor, routing_session_id(first.path(), "task-b", "executor"));
        assert_ne!(executor, routing_session_id(second.path(), "task-a", "executor"));
        assert!(executor.is_ascii());
    }
    #[test]
    fn chat_caps_and_legacy_caps_round_trip_in_the_request_ledger() {
        let workspace = tempfile::tempdir().unwrap();
        for (index, limit) in [0, 128_000, 50_000].into_iter().enumerate() {
            let mut task = run(&format!("{:032x}", index + 1));
            task.output_limit = limit;
            let task = create(workspace.path(), task, None).unwrap();
            let request = begin_request(workspace.path(), &task.id, "reconstruct", "executor", task.executor.clone(), limit).unwrap();
            let recorded = load(workspace.path(), &task.id).unwrap();
            assert_eq!(recorded.output_limit, limit);
            assert_eq!(recorded.requests[0].max_output_tokens, limit);
            assert_eq!(request.max_output_tokens, limit);
        }
    }
    pub(super) fn run(id: &str) -> FigureRun {
        FigureRun {
            schema_version: 1,
            id: id.into(),
            title: "Example".into(),
            method: "A → B".into(),
            style: "paper".into(),
            source_mode: "import".into(),
            source_mime: Some("image/png".into()),
            source_hash: None,
            status: "ready".into(),
            output_limit: 16384,
            executor: ModelIdentity::default(),
            reviewer: ModelIdentity::default(),
            image_identity: None,
            raster_versions: vec![],
            pending_raster_edit: None,
            source_raster: None,
            image_confirmed: false,
            executor_vision: false,
            reviewer_vision: false,
            revision_used: false,
            versions: vec![],
            svg_edits: vec![],
            requests: vec![],
            review: None,
            error: None,
            created_at: "2026-10-06".into(),
            updated_at: "2026-10-06".into(),
        }
    }
    #[test]
    fn submitted_request_is_never_replayed_after_restart() {
        let temp = tempfile::tempdir().unwrap();
        let id = "a".repeat(32);
        create(temp.path(), run(&id), Some(b"source")).unwrap();
        begin_request(
            temp.path(),
            &id,
            "reconstruct",
            "executor",
            ModelIdentity::default(),
            16384,
        )
        .unwrap();
        let recovered = recover(temp.path(), &id).unwrap();
        assert_eq!(recovered.status, "unknown");
        assert!(!recovered.can_start());
        assert!(begin_request(
            temp.path(),
            &id,
            "reconstruct",
            "executor",
            ModelIdentity::default(),
            16384
        )
        .is_err());
        assert_eq!(
            create(temp.path(), run(&id), None).unwrap().requests.len(),
            1
        );
    }
    fn raster(bytes: &[u8], parent_hash: Option<String>) -> FigureRasterVersion {
        FigureRasterVersion { index: 0, hash: hash(bytes), path: String::new(), mime_type: "image/png".into(), width: 2, height: 3,
            parent_hash, parent_index: None, prompt: None, mask_path: None, request_id: None, prompt_request_id: None, created_at: crate::now_iso8601() }
    }

    #[test]
    fn png_revisions_and_confirmation_preserve_the_original_and_frozen_svg_reference() {
        let temp = tempfile::tempdir().unwrap(); let id = "e".repeat(32);
        create(temp.path(), run(&id), Some(b"original")).unwrap();
        let first = save_raster(temp.path(), &id, raster(b"original", None), b"original").unwrap();
        update(temp.path(), &id, |r| { r.status = "image_ready".into(); Ok(()) }).unwrap();
        let edited = save_raster(temp.path(), &id, raster(b"edited", first.source_hash), b"edited").unwrap();
        assert_eq!(source(temp.path(), &edited).unwrap(), b"edited");
        assert_eq!(read_artifact(temp.path(), &id, "figure.source", 100).unwrap(), b"original");
        assert!(edited.can_confirm_image());
        let paused = recover(temp.path(), &id).unwrap(); assert_eq!(paused.status, "image_ready"); assert!(paused.requests.is_empty());
        assert!(select_raster(temp.path(), &id, 1, "stale").is_err());
        let reverted = select_raster(temp.path(), &id, 1, &hash(b"edited")).unwrap();
        assert_eq!(source(temp.path(), &reverted).unwrap(), b"original");
        assert!(confirm_image(temp.path(), &id, "stale").is_err());
        let confirmed = confirm_image(temp.path(), &id, &hash(b"original")).unwrap(); assert!(confirmed.image_confirmed);
        assert!(confirm_image(temp.path(), &id, &hash(b"original")).is_err());
        update(temp.path(), &id, |r| { r.status = "draft".into(); Ok(()) }).unwrap();
        assert!(select_raster(temp.path(), &id, 2, &hash(b"original")).is_err());
        let later = save_raster(temp.path(), &id, raster(b"later", Some(hash(b"edited"))), b"later").unwrap();
        assert_eq!(later.raster_versions.len(), 3);
        assert_eq!(source(temp.path(), &later).unwrap(), b"original");
        assert!(!later.can_confirm_image());
        let mut legacy = serde_json::to_value(run(&id)).unwrap();
        for key in ["rasterVersions", "pendingRasterEdit", "sourceRaster", "imageConfirmed"] { legacy.as_object_mut().unwrap().remove(key); }
        let legacy: FigureRun = serde_json::from_value(legacy).unwrap(); assert!(legacy.raster_versions.is_empty());
        assert!(legacy.pending_raster_edit.is_none());
    }

    #[test]
    fn explicit_png_edits_do_not_consume_the_automatic_reconstruction_budget() {
        let temp = tempfile::tempdir().unwrap(); let id = "f".repeat(32);
        create(temp.path(), run(&id), None).unwrap();
        for kind in ["manual_image_prompt", "manual_image_edit", "manual_image_prompt", "manual_image_edit", "vision_probe", "vision_probe", "reconstruct", "review", "revise", "review"] {
            begin_request(temp.path(), &id, kind, "executor", ModelIdentity::default(), 0).unwrap();
            update(temp.path(), &id, |r| { r.requests.last_mut().unwrap().status = "completed".into(); Ok(()) }).unwrap();
        }
        assert!(begin_request(temp.path(), &id, "reconstruct", "executor", ModelIdentity::default(), 0).is_err());
        begin_request(temp.path(), &id, "manual_image_edit", "image", ModelIdentity::default(), 0).unwrap();
        let recovered = recover(temp.path(), &id).unwrap(); assert_eq!(recovered.status, "unknown");
        // Unknown requests remain unresolved on subsequent restarts as well.
        assert_eq!(recover(temp.path(), &id).unwrap().status, "unknown");
        assert!(begin_request(temp.path(), &id, "manual_image_edit", "image", ModelIdentity::default(), 0).is_err());
    }

    #[test]
    fn local_result_adoption_is_atomic_and_preserves_a_confirmed_svg_reference() {
        let temp=tempfile::tempdir().unwrap();let id="9".repeat(32);
        create(temp.path(),run(&id),Some(b"original")).unwrap();
        save_raster(temp.path(),&id,raster(b"original",None),b"original").unwrap();
        update(temp.path(),&id,|r|{r.status="image_ready".into();Ok(())}).unwrap();
        confirm_image(temp.path(),&id,&hash(b"original")).unwrap();
        let request=begin_request(temp.path(),&id,"manual_image_edit","image",ModelIdentity::default(),0).unwrap();
        let mut candidate=raster(b"returned",Some(hash(b"original")));candidate.parent_index=Some(1);candidate.request_id=Some(request.id.clone());
        update(temp.path(),&id,|r|{r.requests.last_mut().unwrap().status="completed".into();r.pending_raster_edit=Some(candidate.clone());r.status="draft".into();Ok(())}).unwrap();
        assert!(begin_request(temp.path(),&id,"manual_image_prompt","executor",ModelIdentity::default(),0).is_err());
        assert!(resolve_raster_edit(temp.path(),&id,&request.id,"stale","returned",Some((candidate.clone(),b"returned"))).is_err());
        // Simulate a interrupted application that wrote a different result
        // before committing the manifest. Neither artifact may be overwritten.
        crate::write_file_atomically(&directory(temp.path(),&id).unwrap().join("raster-002.image"),b"other orphan").unwrap();
        let adopted=resolve_raster_edit(temp.path(),&id,&request.id,&candidate.hash,"returned",Some((candidate.clone(),b"returned"))).unwrap();
        assert!(adopted.pending_raster_edit.is_none());assert_eq!(adopted.raster_versions.len(),2);assert_eq!(adopted.requests.len(),1);
        assert_eq!(source(temp.path(),&adopted).unwrap(),b"original");assert_eq!(adopted.source_raster,Some(1));
        assert_eq!(read_artifact(temp.path(),&id,"raster-002.image",100).unwrap(),b"other orphan");
        assert!(resolve_raster_edit(temp.path(),&id,&request.id,&candidate.hash,"returned",Some((candidate.clone(),b"returned"))).is_err());
        assert!(recover(temp.path(),&id).unwrap().pending_raster_edit.is_none());
    }
    #[test]
    fn delete_removes_only_the_named_task_and_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let (kept, gone) = ("c".repeat(32), "d".repeat(32));
        create(temp.path(), run(&kept), Some(b"source")).unwrap();
        create(temp.path(), run(&gone), Some(b"source")).unwrap();
        assert!(delete(temp.path(), "../../outside").is_err());
        delete(temp.path(), &gone).unwrap();
        delete(temp.path(), &gone).unwrap();
        let ids: Vec<_> = list(temp.path()).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![kept]);
        // A never-created task does not create the figure root.
        let empty = tempfile::tempdir().unwrap();
        delete(empty.path(), &gone).unwrap();
        assert!(!empty.path().join(".somniq").exists());
    }
    #[test]
    fn rejects_traversal_ids_and_stale_editor_hashes() {
        let temp = tempfile::tempdir().unwrap();
        assert!(directory(temp.path(), "../../outside").is_err());
        let id = "b".repeat(32);
        create(temp.path(), run(&id), None).unwrap();
        let version = FigureVersion {
            index: 0,
            parent_index: None,
            svg_edit_id: None,
            hash: String::new(),
            svg_path: String::new(),
            png_path: String::new(),
            png_hash: String::new(),
            pdf_path: String::new(),
            author: "user".into(),
            classification: "editable_vector".into(),
            text_count: 1,
            vector_count: 2,
            review_status: "visual_pending".into(),
            renderer: "test".into(),
            font_fingerprint: "test".into(),
            created_at: crate::now_iso8601(),
        };
        let first = save_version(
            temp.path(),
            &id,
            None,
            "<svg/>",
            b"png",
            b"pdf",
            version.clone(),
        )
        .unwrap();
        assert!(save_version(
            temp.path(),
            &id,
            None,
            "changed",
            b"png",
            b"pdf",
            version.clone()
        )
        .is_err());
        assert_eq!(load(temp.path(), &id).unwrap().versions.len(), 1);
        let second = save_version(
            temp.path(),
            &id,
            first.current_hash(),
            "<svg>new</svg>",
            b"png",
            b"pdf",
            version,
        )
        .unwrap();
        assert_eq!(second.versions.len(), 2);
        assert!(second.review.is_none());
    }

    #[test]
    fn automatic_budget_and_explicit_editor_review_have_separate_limits() {
        let temp = tempfile::tempdir().unwrap();
        let id = "c".repeat(32);
        create(temp.path(), run(&id), None).unwrap();
        for _ in 0..6 {
            let request = begin_request(
                temp.path(),
                &id,
                "auto",
                "executor",
                ModelIdentity::default(),
                8192,
            )
            .unwrap();
            update(temp.path(), &id, |r| {
                r.requests
                    .iter_mut()
                    .find(|v| v.id == request.id)
                    .unwrap()
                    .status = "completed".into();
                Ok(())
            })
            .unwrap();
        }
        assert!(begin_request(
            temp.path(),
            &id,
            "auto",
            "executor",
            ModelIdentity::default(),
            8192
        )
        .is_err());
        assert!(begin_request(
            temp.path(),
            &id,
            "manual_review",
            "reviewer",
            ModelIdentity::default(),
            2048
        )
        .is_ok());
        let mut changed = run(&id);
        changed.method = "different".into();
        assert!(create(temp.path(), changed, None).is_err());
    }
}
