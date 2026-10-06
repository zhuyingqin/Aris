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

static WRITES: Mutex<()> = Mutex::new(());
pub const MAX_SVG_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_SOURCE_BYTES: usize = 10 * 1024 * 1024;

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
    pub output_limit: u32,
    pub executor: ModelIdentity,
    pub reviewer: ModelIdentity,
    #[serde(default)]
    pub image_identity: Option<ModelIdentity>,
    pub executor_vision: bool,
    pub reviewer_vision: bool,
    pub revision_used: bool,
    pub versions: Vec<FigureVersion>,
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
            7
        } else {
            6
        }
    }
    pub fn can_start(&self) -> bool {
        self.status == "ready" && self.requests.is_empty()
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
    if !matches!(run.output_limit, 8192 | 16384 | 32768 | 50000) {
        return Err("Unsupported output budget".into());
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

pub fn recover(workspace: &Path, id: &str) -> Result<FigureRun, String> {
    update(workspace, id, |run| {
        if run.requests.iter().any(|r| r.status == "submitted") {
            for request in &mut run.requests {
                if request.status == "submitted" { request.status = "unknown".into(); }
            }
            run.status = "unknown".into();
            run.error = Some("A submitted request has no recorded result. Check usage before creating a new task; it will not be sent again automatically.".into());
        } else if matches!(run.status.as_str(), "probing" | "generating" | "reconstructing" | "reviewing" | "revising") {
            run.status = "draft".into();
            run.error = Some("Processing stopped. Saved artifacts remain available; no request is repeated automatically.".into());
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
        if (kind != "manual_review"
            && run
                .requests
                .iter()
                .filter(|r| r.kind != "manual_review")
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
    let bytes = read_artifact(workspace, &run.id, "figure.source", MAX_SOURCE_BYTES)?;
    if run.source_hash.as_deref() != Some(hash(&bytes).as_str()) {
        return Err("Source image changed".into());
    }
    Ok(bytes)
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
    fn run(id: &str) -> FigureRun {
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
            executor_vision: false,
            reviewer_vision: false,
            revision_used: false,
            versions: vec![],
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
    #[test]
    fn rejects_traversal_ids_and_stale_editor_hashes() {
        let temp = tempfile::tempdir().unwrap();
        assert!(directory(temp.path(), "../../outside").is_err());
        let id = "b".repeat(32);
        create(temp.path(), run(&id), None).unwrap();
        let version = FigureVersion {
            index: 0,
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
