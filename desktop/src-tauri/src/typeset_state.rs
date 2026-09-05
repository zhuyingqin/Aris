//! Durable local state for the Typeset editor.
//!
//! Recovery drafts, external-change proposals and source snapshots live under
//! `.somniq/typeset/` inside the active workspace. State follows a moved local
//! project, while the workspace watcher treats this directory as internal.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::{blocking::off_main_thread, files};

const TYPESET_STATE_DIR: &str = ".somniq/typeset";
const MAX_STATE_CONTENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROJECT_SEARCH_MATCHES: usize = 5_000;
const SEARCHABLE_EXTENSIONS: &[&str] = &["tex", "bib", "cls", "sty"];
const REVISION_LEDGER_VERSION: u32 = 1;
const REVISION_LEDGER_FILE: &str = "ledger.json";

/// Suffixes the LaTeX toolchain regenerates on every compile.
///
/// These carry no authored intent, and snapshotting them is what turned one
/// editing session into 299 review gates for 5 real source edits: every
/// recompile rewrote the outputs, each rewrite looked like an external change,
/// and the resulting PDF blobs dominated the ledger. They are excluded from
/// revisions entirely rather than merely hidden from review, so the drift check
/// also stops failing against output that was simply rebuilt.
const BUILD_ARTIFACT_SUFFIXES: &[&str] = &[
    // `epstopdf` rewrites every EPS figure into this fixed name during the
    // build. It is a PDF with no `.tex` beside it, so only the literal suffix
    // separates it from an authored figure.
    "-eps-converted-to.pdf",
    ".acn",
    ".acr",
    ".alg",
    ".aux",
    ".auxlock",
    ".bbl",
    ".bcf",
    ".blg",
    ".brf",
    ".dpth",
    ".dvi",
    ".fdb_latexmk",
    ".figlist",
    ".fls",
    ".glg",
    ".glo",
    ".gls",
    ".idx",
    ".ilg",
    ".ind",
    ".ist",
    ".loa",
    ".lof",
    ".log",
    ".lol",
    ".los",
    ".lot",
    ".makefile",
    ".md5",
    ".nav",
    ".out",
    ".run.xml",
    ".snm",
    ".synctex",
    ".synctex.gz",
    ".tdo",
    ".toc",
    ".upa",
    ".upb",
    ".vrb",
    ".xdv",
    ".xdy",
];

/// Output extensions that are only artifacts next to the source that produces
/// them. `figures/diagram.pdf` is an authored resource and must stay reviewable.
const DOCUMENT_OUTPUT_SUFFIXES: &[&str] = &[".pdf"];

static REVISION_STATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock_revision_state() -> Result<MutexGuard<'static, ()>, String> {
    REVISION_STATE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Typeset revision state lock is poisoned".to_string())
}

/// A content-addressed project revision. File bytes live separately in
/// `.somniq/typeset/revisions/blobs/<sha256>` so the ledger only ever stores
/// each identical resource once, including images and other binary inputs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetProjectRevision {
    id: String,
    parent_revision_id: Option<String>,
    label: Option<String>,
    reason: String,
    actor: String,
    origin: String,
    evidence: Option<String>,
    created_at_ms: u128,
    files: Vec<TypesetRevisionFile>,
    /// Comments are project metadata, not source files. They are captured in
    /// the same revision so restoring a manuscript also restores the review
    /// context that was present at that point in time.
    comments: Vec<TypesetRevisionFile>,
    operations: Vec<TypesetRevisionOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TypesetRevisionFile {
    path: String,
    content_hash: String,
    bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TypesetRevisionOperation {
    id: String,
    kind: String,
    path: String,
    previous_path: Option<String>,
    before_hash: Option<String>,
    after_hash: Option<String>,
    bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetProjectRevisionSummary {
    id: String,
    parent_revision_id: Option<String>,
    label: Option<String>,
    reason: String,
    actor: String,
    origin: String,
    evidence: Option<String>,
    created_at_ms: u128,
    file_count: usize,
    comment_count: usize,
    operation_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetRevisionComparison {
    base_revision_id: String,
    target_revision_id: String,
    operations: Vec<TypesetRevisionOperation>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetRevisionCaptureInput {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    actor: String,
    #[serde(default)]
    origin: String,
    #[serde(default)]
    evidence: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetChangeSet {
    id: String,
    base_revision_id: String,
    revision_id: String,
    actor: String,
    origin: String,
    evidence: Option<String>,
    status: String,
    decisions: Vec<TypesetChangeSetDecision>,
    resulting_revision_id: Option<String>,
    created_at_ms: u128,
    updated_at_ms: u128,
    /// The editing action this transaction belongs to.
    ///
    /// One Chat turn, one burst of external writes, or the drift a project-open
    /// scan discovers are each one action. Only writes from the same action
    /// extend a change set; see `typeset_changeset_create`. Empty for change
    /// sets recorded before actions were tracked, which keeps them mergeable.
    #[serde(default)]
    action_id: String,
    /// The change set this one left behind, if any, and the files it covered.
    ///
    /// A `carried` transaction was never answered and is not being applied — the
    /// workspace simply keeps what it already had — so the reviewer has to be
    /// told rather than left assuming the queue was empty.
    #[serde(default)]
    carried_from: Option<String>,
    #[serde(default)]
    carried_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetChangeSetDecision {
    operation_id: String,
    path: String,
    decision: String,
    #[serde(default)]
    resolved_hash: Option<String>,
    #[serde(default)]
    resolved_bytes: Option<u64>,
    #[serde(default)]
    hunk_decisions: Vec<String>,
    #[serde(default)]
    hunk_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetChangeSetCreateInput {
    revision_id: String,
    #[serde(default)]
    actor: String,
    #[serde(default)]
    origin: String,
    #[serde(default)]
    evidence: Option<String>,
    /// Identifies the action these writes belong to. Omitting it keeps the
    /// pre-action behaviour of extending whatever review is still open.
    #[serde(default)]
    action_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetChangeSetResolveInput {
    id: String,
    decisions: Vec<TypesetChangeSetDecision>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetChangeSetStageTextInput {
    id: String,
    operation_id: String,
    path: String,
    content: String,
    #[serde(default)]
    hunk_decisions: Vec<String>,
    #[serde(default)]
    hunk_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetChangeSetTextFile {
    operation_id: String,
    kind: String,
    path: String,
    previous_path: Option<String>,
    base_content: Option<String>,
    incoming_content: Option<String>,
    resolved_content: Option<String>,
    base_hash: Option<String>,
    incoming_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypesetRevisionLedger {
    version: u32,
    head_revision_id: Option<String>,
    revisions: Vec<TypesetProjectRevision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetRecoveryDraft {
    path: String,
    content: String,
    #[serde(default)]
    base_content: String,
    base_version: Option<String>,
    updated_at_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetChangeProposal {
    id: String,
    path: String,
    base_content: String,
    base_version: Option<String>,
    local_content: String,
    incoming_content: String,
    incoming_version: Option<String>,
    created_at_ms: u128,
    #[serde(default)]
    decisions: Vec<String>,
    #[serde(default)]
    hunk_ids: Vec<String>,
    #[serde(default)]
    actor: String,
    #[serde(default)]
    origin: String,
    #[serde(default)]
    evidence: Option<String>,
    #[serde(default)]
    too_large_to_chunk: bool,
    #[serde(default)]
    whole_file_decision: Option<String>,
    /// The reviewer's own edits to the proposed text, kept so an interrupted
    /// review resumes with the typing still in place. `None` means the review
    /// surface is still showing the untouched proposal.
    #[serde(default)]
    review_draft: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetHistoryEntry {
    id: String,
    path: String,
    content: String,
    version: String,
    label: Option<String>,
    reason: String,
    created_at_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetHistorySummary {
    id: String,
    path: String,
    version: String,
    label: Option<String>,
    reason: String,
    created_at_ms: u128,
    bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetProjectSearchMatch {
    path: String,
    line: usize,
    column: usize,
    preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetProjectReplaceResult {
    files_changed: usize,
    replacements: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetComment {
    id: String,
    path: String,
    from: usize,
    to: usize,
    selected_text: String,
    body: String,
    author: String,
    origin: String,
    resolved: bool,
    created_at_ms: u128,
    updated_at_ms: u128,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn validate_content(content: &str) -> Result<(), String> {
    if content.len() > MAX_STATE_CONTENT_BYTES {
        return Err(format!(
            "Typeset state is too large ({} bytes, limit {} bytes)",
            content.len(),
            MAX_STATE_CONTENT_BYTES
        ));
    }
    Ok(())
}

fn source_identity(path: &str) -> Result<(PathBuf, String, String), String> {
    let (root, target) = files::resolve_workspace_file(path)?;
    let relative = files::display_workspace_path(&target, &root);
    let key = format!("{:x}", Sha256::digest(relative.as_bytes()));
    Ok((root, relative, key))
}

fn state_path(root: &Path, area: &str, key: &str) -> PathBuf {
    root.join(TYPESET_STATE_DIR).join(area).join(key)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    runtime::write_file_atomically(path, &body).map_err(|error| error.to_string())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    match fs::read(path) {
        Ok(body) => serde_json::from_slice(&body)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn typeset_recovery_save(
    path: String,
    content: String,
    base_content: String,
    base_version: Option<String>,
) -> Result<TypesetRecoveryDraft, String> {
    validate_content(&content)?;
    validate_content(&base_content)?;
    let (root, relative, key) = source_identity(&path)?;
    let draft = TypesetRecoveryDraft {
        path: relative,
        content,
        base_content,
        base_version,
        updated_at_ms: now_ms(),
    };
    write_json(
        &state_path(&root, "recovery", &format!("{key}.json")),
        &draft,
    )?;
    Ok(draft)
}

#[tauri::command]
pub fn typeset_recovery_load(path: String) -> Result<Option<TypesetRecoveryDraft>, String> {
    let (root, _, key) = source_identity(&path)?;
    read_json(&state_path(&root, "recovery", &format!("{key}.json")))
}

#[tauri::command]
pub fn typeset_recovery_clear(path: String) -> Result<(), String> {
    let (root, _, key) = source_identity(&path)?;
    remove_if_present(state_path(&root, "recovery", &format!("{key}.json")))
}

fn remove_if_present(path: PathBuf) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn revision_directory(root: &Path) -> PathBuf {
    state_path(root, "revisions", "")
}

fn revision_ledger_path(root: &Path) -> PathBuf {
    revision_directory(root).join(REVISION_LEDGER_FILE)
}

fn revision_blob_path(root: &Path, content_hash: &str) -> Result<PathBuf, String> {
    if content_hash.len() != 64 || !content_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid Typeset revision content hash".to_string());
    }
    Ok(revision_directory(root).join("blobs").join(content_hash))
}

fn change_set_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_revision_id(id)?;
    Ok(change_set_directory(root).join(format!("{id}.json")))
}

fn change_set_directory(root: &Path) -> PathBuf {
    revision_directory(root).join("changesets")
}

/// Read a change set, dropping decisions about files a revision can no longer
/// contain: atomic-write scratch files and build output.
///
/// The counterpart to the ledger normalization: the reviewable operations are
/// recomputed from the cleaned ledger, and `typeset_changeset_resolve` requires
/// the submitted decisions to correspond exactly. A stale scratch decision left
/// in a stored change set would fail that check instead of the drift check.
/// Only the suffix rule applies here — there is no manifest at this level to
/// tell an output PDF from an authored figure, so that case is left to the
/// recomputing call sites.
fn read_change_set(path: &Path) -> Result<Option<TypesetChangeSet>, String> {
    let suffix_only = BTreeSet::new();
    Ok(read_json::<TypesetChangeSet>(path)?.map(|mut change_set| {
        change_set.decisions.retain(|decision| {
            !is_transient_revision_path(&decision.path)
                && !is_derived_artifact_path(&decision.path, &suffix_only)
        });
        change_set
    }))
}

fn stored_change_sets(root: &Path) -> Result<Vec<TypesetChangeSet>, String> {
    let directory = change_set_directory(root);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut change_sets = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .map(|entry| {
            read_change_set(&entry.path())?
                .ok_or_else(|| "Typeset change set disappeared while listing".to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    change_sets.sort_by(|left, right| {
        let left_pending = left.status == "pending";
        let right_pending = right.status == "pending";
        right_pending
            .cmp(&left_pending)
            .then_with(|| left.created_at_ms.cmp(&right.created_at_ms))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(change_sets)
}

fn validate_revision_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 180
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("invalid Typeset revision id".to_string());
    }
    Ok(())
}

fn normalize_revision_text(value: String, fallback: &str, limit: usize) -> String {
    let normalized = value.trim().chars().take(limit).collect::<String>();
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    }
}

fn normalize_revision_label(label: Option<String>) -> Option<String> {
    label.and_then(|value| {
        let normalized = value.trim().chars().take(120).collect::<String>();
        (!normalized.is_empty()).then_some(normalized)
    })
}

/// True for a path whose last segment is an atomic-write scratch file.
fn is_transient_revision_path(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(files::is_transient_temp_file)
}

/// Tectonic and SyncTeX append `(busy)` while a file is still being written.
/// `chapter.synctex(busy)` is the same artifact as `chapter.synctex`, and it
/// never matched a plain suffix comparison.
fn normalized_artifact_path(path: &str) -> String {
    let lowered = path.to_ascii_lowercase();
    lowered
        .strip_suffix("(busy)")
        .map(str::to_string)
        .unwrap_or(lowered)
}

/// Lowercased `foo/bar` keys for every document the toolchain builds in a
/// directory: either the `foo/bar.tex` source, or a `foo/bar.<artifact>` it
/// wrote there.
///
/// The artifact half is what covers `-output-directory` builds. Those leave no
/// `.tex` next to the PDF — only `main.aux`, `main.log`, `main.fls` — so a
/// source-only rule left every such `main.pdf` looking like an authored figure.
/// Classification is relative to the set it is given, so the same rule applies
/// whether that comes from a live walk or a stored ledger.
fn document_stems<'a>(paths: impl Iterator<Item = &'a str>) -> BTreeSet<String> {
    let mut stems = BTreeSet::new();
    for path in paths {
        let lowered = normalized_artifact_path(path);
        if let Some(stem) = lowered.strip_suffix(".tex") {
            stems.insert(stem.to_string());
            continue;
        }
        if let Some(stem) = BUILD_ARTIFACT_SUFFIXES
            .iter()
            .find_map(|suffix| lowered.strip_suffix(suffix))
        {
            stems.insert(stem.to_string());
        }
    }
    stems
}

/// True for a file the LaTeX toolchain regenerates from the project sources.
fn is_derived_artifact_path(path: &str, stems: &BTreeSet<String>) -> bool {
    let path = normalized_artifact_path(path);
    if BUILD_ARTIFACT_SUFFIXES
        .iter()
        .any(|suffix| path.ends_with(suffix))
    {
        return true;
    }
    DOCUMENT_OUTPUT_SUFFIXES.iter().any(|suffix| {
        path.strip_suffix(suffix)
            .is_some_and(|stem| stems.contains(stem))
    })
}

fn load_revision_ledger(root: &Path) -> Result<TypesetRevisionLedger, String> {
    let mut ledger: TypesetRevisionLedger =
        read_json(&revision_ledger_path(root))?.unwrap_or(TypesetRevisionLedger {
            version: REVISION_LEDGER_VERSION,
            head_revision_id: None,
            revisions: Vec::new(),
        });
    // A ledger written before scratch files and build output were filtered still
    // records them. Dropping them on load makes the repair retroactive: without
    // it, a revision holding a file that the live walk no longer reports can
    // never match the project, so its review stays unacceptable forever — and
    // every recorded artifact would surface as a phantom deletion.
    for revision in &mut ledger.revisions {
        let stems = document_stems(revision.files.iter().map(|file| file.path.as_str()));
        let excluded =
            |path: &str| is_transient_revision_path(path) || is_derived_artifact_path(path, &stems);
        revision.files.retain(|file| !excluded(&file.path));
        revision.operations.retain(|operation| {
            !excluded(&operation.path) && !operation.previous_path.as_deref().is_some_and(&excluded)
        });
    }
    Ok(ledger)
}

fn save_revision_ledger(root: &Path, ledger: &TypesetRevisionLedger) -> Result<(), String> {
    write_json(&revision_ledger_path(root), ledger)
}

fn revision_file_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn revision_relative_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|_| "Typeset revision path is outside the workspace".to_string())
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn is_revision_internal_directory(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".somniq" | "node_modules" | "target" | "__pycache__"
    )
}

/// Every workspace file a revision may contain.
///
/// This is also the sweep `apply_project_revision_manifest` uses to delete
/// files that a restored manifest does not list, so the exclusions here are
/// symmetric by construction: an excluded file is never snapshotted, never
/// diffed and never deleted by a restore.
fn project_revision_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            // `filter_entry` also visits the root, and rejecting the root yields an
            // empty walk. The workspace is in scope by definition, whatever it is
            // called, so only its contents are filtered.
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            // Atomic writes leave a short-lived `.tmpXXXXXX` sibling. Snapshotting
            // it records a file that the very next rename destroys, so review can
            // never reconcile the revision against the live project again.
            !is_revision_internal_directory(&name.to_ascii_lowercase())
                && !files::is_transient_temp_file(&name)
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    files.sort();
    // The `.tex` set has to be known before any output can be classified, so
    // build output is dropped in a second pass over the collected walk.
    let relative = files
        .iter()
        .map(|path| revision_relative_path(root, path))
        .collect::<Result<Vec<_>, String>>()?;
    let stems = document_stems(relative.iter().map(String::as_str));
    let mut kept = files
        .into_iter()
        .zip(relative)
        .filter(|(_, relative)| !is_derived_artifact_path(relative, &stems))
        .map(|(path, _)| path)
        .collect::<Vec<_>>();
    kept.sort();
    Ok(kept)
}

fn store_revision_blob(root: &Path, bytes: &[u8]) -> Result<String, String> {
    let content_hash = revision_file_hash(bytes);
    let path = revision_blob_path(root, &content_hash)?;
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        runtime::write_file_atomically(&path, bytes).map_err(|error| error.to_string())?;
    }
    Ok(content_hash)
}

fn snapshot_paths(
    root: &Path,
    paths: impl IntoIterator<Item = PathBuf>,
) -> Result<Vec<TypesetRevisionFile>, String> {
    let mut snapshot = Vec::new();
    for path in paths {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            // The walk and the read are not atomic. A file that another process
            // removed in between is simply absent from this revision; failing the
            // whole snapshot would abandon every other file's state.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        let content_hash = store_revision_blob(root, &bytes)?;
        snapshot.push(TypesetRevisionFile {
            path: revision_relative_path(root, &path)?,
            content_hash,
            bytes: bytes.len() as u64,
        });
    }
    snapshot.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(snapshot)
}

fn snapshot_project_files(root: &Path) -> Result<Vec<TypesetRevisionFile>, String> {
    snapshot_paths(root, project_revision_files(root)?)
}

fn snapshot_comments(root: &Path) -> Result<Vec<TypesetRevisionFile>, String> {
    let comments = root.join(TYPESET_STATE_DIR).join("comments");
    if !comments.exists() {
        return Ok(Vec::new());
    }
    let paths = WalkDir::new(&comments)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    snapshot_paths(root, paths)
}

fn revision_file_map(files: &[TypesetRevisionFile]) -> BTreeMap<String, TypesetRevisionFile> {
    files
        .iter()
        .cloned()
        .map(|file| (file.path.clone(), file))
        .collect()
}

fn revision_operations(
    before: &[TypesetRevisionFile],
    after: &[TypesetRevisionFile],
) -> Vec<TypesetRevisionOperation> {
    let before = revision_file_map(before);
    let after = revision_file_map(after);
    let mut removed = before
        .iter()
        .filter(|(path, _)| !after.contains_key(*path))
        .map(|(path, file)| (path.clone(), file.clone()))
        .collect::<Vec<_>>();
    let mut created = after
        .iter()
        .filter(|(path, _)| !before.contains_key(*path))
        .map(|(path, file)| (path.clone(), file.clone()))
        .collect::<Vec<_>>();
    removed.sort_by(|left, right| left.0.cmp(&right.0));
    created.sort_by(|left, right| left.0.cmp(&right.0));

    let mut operations = Vec::new();
    let mut moved_removed = BTreeSet::new();
    let mut moved_created = BTreeSet::new();
    for (old_path, old_file) in &removed {
        if let Some((new_path, new_file)) = created.iter().find(|(new_path, new_file)| {
            !moved_created.contains(new_path) && old_file.content_hash == new_file.content_hash
        }) {
            moved_removed.insert(old_path.clone());
            moved_created.insert(new_path.clone());
            operations.push(TypesetRevisionOperation {
                id: format!("move:{old_path}:{new_path}"),
                kind: "move".to_string(),
                path: new_path.clone(),
                previous_path: Some(old_path.clone()),
                before_hash: Some(old_file.content_hash.clone()),
                after_hash: Some(new_file.content_hash.clone()),
                bytes: new_file.bytes,
            });
        }
    }
    for (path, file) in before.iter() {
        if let Some(next) = after.get(path) {
            if file.content_hash != next.content_hash {
                operations.push(TypesetRevisionOperation {
                    id: format!("modify:{path}"),
                    kind: "modify".to_string(),
                    path: path.clone(),
                    previous_path: None,
                    before_hash: Some(file.content_hash.clone()),
                    after_hash: Some(next.content_hash.clone()),
                    bytes: next.bytes,
                });
            }
        }
    }
    for (path, file) in removed {
        if moved_removed.contains(&path) {
            continue;
        }
        operations.push(TypesetRevisionOperation {
            id: format!("delete:{path}"),
            kind: "delete".to_string(),
            path,
            previous_path: None,
            before_hash: Some(file.content_hash),
            after_hash: None,
            bytes: file.bytes,
        });
    }
    for (path, file) in created {
        if moved_created.contains(&path) {
            continue;
        }
        operations.push(TypesetRevisionOperation {
            id: format!("create:{path}"),
            kind: "create".to_string(),
            path,
            previous_path: None,
            before_hash: None,
            after_hash: Some(file.content_hash),
            bytes: file.bytes,
        });
    }
    operations.sort_by(|left, right| left.id.cmp(&right.id));
    operations
}

fn revision_operations_with_comments(
    before_files: &[TypesetRevisionFile],
    after_files: &[TypesetRevisionFile],
    before_comments: &[TypesetRevisionFile],
    after_comments: &[TypesetRevisionFile],
) -> Vec<TypesetRevisionOperation> {
    let mut operations = revision_operations(before_files, after_files);
    operations.extend(
        revision_operations(before_comments, after_comments)
            .into_iter()
            .map(|mut operation| {
                operation.id = format!("comment:{}", operation.id);
                operation.kind = format!("comment-{}", operation.kind);
                operation
            }),
    );
    operations.sort_by(|left, right| left.id.cmp(&right.id));
    operations
}

/// Build output no longer reaches a revision at all, so this is the safety net
/// for ledgers written before that exclusion — and the one place that decides
/// what a human is asked to confirm.
fn reviewable_change_operation(
    operation: &TypesetRevisionOperation,
    stems: &BTreeSet<String>,
) -> bool {
    if operation.kind.starts_with("comment-") {
        return true;
    }
    !is_derived_artifact_path(&operation.path, stems)
}

/// The `.tex` stems a change set is judged against: the union of both sides, so
/// an output whose source was added or deleted within the change set is still
/// classified as output rather than as an authored file.
fn change_stems(
    base: &TypesetProjectRevision,
    target: &TypesetProjectRevision,
) -> BTreeSet<String> {
    document_stems(
        base.files
            .iter()
            .chain(target.files.iter())
            .map(|file| file.path.as_str()),
    )
}

fn revision_summary(revision: &TypesetProjectRevision) -> TypesetProjectRevisionSummary {
    TypesetProjectRevisionSummary {
        id: revision.id.clone(),
        parent_revision_id: revision.parent_revision_id.clone(),
        label: revision.label.clone(),
        reason: revision.reason.clone(),
        actor: revision.actor.clone(),
        origin: revision.origin.clone(),
        evidence: revision.evidence.clone(),
        created_at_ms: revision.created_at_ms,
        file_count: revision.files.len(),
        comment_count: revision.comments.len(),
        operation_count: revision.operations.len(),
    }
}

fn find_revision<'a>(
    ledger: &'a TypesetRevisionLedger,
    id: &str,
) -> Result<&'a TypesetProjectRevision, String> {
    validate_revision_id(id)?;
    ledger
        .revisions
        .iter()
        .find(|revision| revision.id == id)
        .ok_or_else(|| "Typeset revision not found".to_string())
}

fn revision_is_ancestor(
    ledger: &TypesetRevisionLedger,
    ancestor_id: &str,
    revision_id: &str,
) -> bool {
    let mut current = Some(revision_id);
    let mut visited = BTreeSet::new();
    while let Some(id) = current {
        if id == ancestor_id {
            return true;
        }
        if !visited.insert(id.to_string()) {
            return false;
        }
        current = ledger
            .revisions
            .iter()
            .find(|revision| revision.id == id)
            .and_then(|revision| revision.parent_revision_id.as_deref());
    }
    false
}

/// True for a revision the person typed themselves in this app.
///
/// Git deliberately does not qualify: the person ran the command, but a tool
/// rewrote the working tree, which is exactly what review exists for. Nor does
/// `history`, whose restores are already blocked while a review is open.
fn is_self_authored_revision(revision: &TypesetProjectRevision) -> bool {
    revision.actor == "user"
        && matches!(
            revision.origin.as_str(),
            "editor" | "visual-editor" | "explorer"
        )
}

/// Paths whose only writer since `base_id` was the person themselves.
///
/// A pending review is about what somebody else did. Sweeping the user's own
/// saves into it asks them to confirm their own work — and because the
/// project-level "Reject change set" maps every decision to reject, answering
/// the agent would silently restore their file to its pre-save content. A path
/// that both they and someone else touched stays reviewable.
fn self_authored_paths(
    ledger: &TypesetRevisionLedger,
    base_id: &str,
    target_id: &str,
) -> BTreeSet<String> {
    let mut mine = BTreeSet::new();
    let mut theirs = BTreeSet::new();
    let mut current = Some(target_id);
    let mut visited = BTreeSet::new();
    while let Some(id) = current {
        if id == base_id || !visited.insert(id.to_string()) {
            break;
        }
        let Some(revision) = ledger.revisions.iter().find(|revision| revision.id == id) else {
            break;
        };
        let side = if is_self_authored_revision(revision) {
            &mut mine
        } else {
            &mut theirs
        };
        for operation in &revision.operations {
            side.insert(operation.path.clone());
        }
        current = revision.parent_revision_id.as_deref();
    }
    mine.retain(|path| !theirs.contains(path));
    mine
}

fn change_set_operations(
    ledger: &TypesetRevisionLedger,
    change_set: &TypesetChangeSet,
) -> Result<Vec<TypesetRevisionOperation>, String> {
    let base = find_revision(ledger, &change_set.base_revision_id)?;
    let target = find_revision(ledger, &change_set.revision_id)?;
    Ok(revision_operations_with_comments(
        &base.files,
        &target.files,
        &base.comments,
        &target.comments,
    ))
}

fn change_set_stems(
    ledger: &TypesetRevisionLedger,
    change_set: &TypesetChangeSet,
) -> Result<BTreeSet<String>, String> {
    Ok(change_stems(
        find_revision(ledger, &change_set.base_revision_id)?,
        find_revision(ledger, &change_set.revision_id)?,
    ))
}

/// Move a pending review forward along the same revision lineage. Decisions
/// are retained only for byte-for-byte identical operations; anything newly
/// introduced or changed while the review was open is deliberately returned to
/// `pending` so applying an old review can never overwrite it — except the
/// user's own edits, which are carried at their current content rather than
/// put up for review against themselves.
fn rebase_pending_change_set(
    ledger: &TypesetRevisionLedger,
    change_set: &mut TypesetChangeSet,
    target_id: &str,
) -> Result<bool, String> {
    if change_set.revision_id == target_id {
        return Ok(false);
    }
    if !revision_is_ancestor(ledger, &change_set.revision_id, target_id) {
        return Err(
            "the project revision history diverged and this ChangeSet cannot be safely rebased"
                .to_string(),
        );
    }

    let old_operations = change_set_operations(ledger, change_set)?
        .into_iter()
        .map(|operation| (operation.id.clone(), operation))
        .collect::<BTreeMap<_, _>>();
    let old_decisions = change_set
        .decisions
        .iter()
        .cloned()
        .map(|decision| (decision.operation_id.clone(), decision))
        .collect::<BTreeMap<_, _>>();
    let base = find_revision(ledger, &change_set.base_revision_id)?;
    let target = find_revision(ledger, target_id)?;
    let operations = revision_operations_with_comments(
        &base.files,
        &target.files,
        &base.comments,
        &target.comments,
    );
    let stems = change_stems(base, target);
    let mine = self_authored_paths(ledger, &change_set.base_revision_id, target_id);

    change_set.decisions = operations
        .iter()
        .filter(|operation| reviewable_change_operation(operation, &stems))
        .map(|operation| {
            if old_operations.get(&operation.id) == Some(operation) {
                if let Some(decision) = old_decisions.get(&operation.id) {
                    return decision.clone();
                }
            }
            TypesetChangeSetDecision {
                operation_id: operation.id.clone(),
                path: operation.path.clone(),
                // Accepting keeps the target content, which for the user's own
                // edit is the edit itself.
                decision: if mine.contains(&operation.path) {
                    "accept"
                } else {
                    "pending"
                }
                .to_string(),
                resolved_hash: None,
                resolved_bytes: None,
                hunk_decisions: Vec::new(),
                hunk_ids: Vec::new(),
            }
        })
        .collect();
    if change_set.decisions.is_empty() {
        change_set.status = "reverted".to_string();
    }
    change_set.revision_id = target_id.to_string();
    change_set.updated_at_ms = now_ms();
    Ok(true)
}

fn head_revision<'a>(ledger: &'a TypesetRevisionLedger) -> Option<&'a TypesetProjectRevision> {
    ledger
        .head_revision_id
        .as_deref()
        .and_then(|id| ledger.revisions.iter().find(|revision| revision.id == id))
}

fn manifest_identity(files: &[TypesetRevisionFile], comments: &[TypesetRevisionFile]) -> String {
    let mut body = String::new();
    for file in files.iter().chain(comments.iter()) {
        body.push_str(&file.path);
        body.push('\0');
        body.push_str(&file.content_hash);
        body.push('\n');
    }
    revision_file_hash(body.as_bytes())
}

fn capture_project_revision_at_unlocked(
    root: &Path,
    label: Option<String>,
    reason: String,
    actor: String,
    origin: String,
    evidence: Option<String>,
) -> Result<TypesetProjectRevision, String> {
    let files = snapshot_project_files(root)?;
    let comments = snapshot_comments(root)?;
    let mut ledger = load_revision_ledger(root)?;
    if ledger.version != REVISION_LEDGER_VERSION {
        return Err(format!(
            "unsupported Typeset revision ledger version {}",
            ledger.version
        ));
    }
    let label = normalize_revision_label(label);
    let reason = normalize_revision_text(reason, "save", 120);
    let actor = normalize_revision_text(actor, "user", 80);
    let origin = normalize_revision_text(origin, "manual", 80);
    let evidence = evidence.and_then(|value| {
        let value = value.trim().chars().take(2_000).collect::<String>();
        (!value.is_empty()).then_some(value)
    });
    if let Some(previous) = head_revision(&ledger) {
        if previous.files == files && previous.comments == comments && label.is_none() {
            return Ok(previous.clone());
        }
    }
    let parent = head_revision(&ledger).cloned();
    let manifest_hash = manifest_identity(&files, &comments);
    let created_at_ms = now_ms();
    let base_id = format!("rev-{created_at_ms}-{}", &manifest_hash[..12]);
    let mut id = base_id.clone();
    for suffix in 1..=10_000 {
        if !ledger.revisions.iter().any(|revision| revision.id == id) {
            break;
        }
        id = format!("{base_id}-{suffix}");
    }
    if ledger.revisions.iter().any(|revision| revision.id == id) {
        return Err("could not allocate a unique Typeset revision id".to_string());
    }
    let revision = TypesetProjectRevision {
        id: id.clone(),
        parent_revision_id: parent.as_ref().map(|revision| revision.id.clone()),
        label,
        reason,
        actor,
        origin,
        evidence,
        created_at_ms,
        operations: parent
            .as_ref()
            .map(|previous| {
                revision_operations_with_comments(
                    &previous.files,
                    &files,
                    &previous.comments,
                    &comments,
                )
            })
            .unwrap_or_default(),
        files,
        comments,
    };
    ledger.revisions.push(revision.clone());
    ledger.head_revision_id = Some(id);
    save_revision_ledger(root, &ledger)?;
    Ok(revision)
}

fn capture_project_revision_at(
    root: &Path,
    label: Option<String>,
    reason: String,
    actor: String,
    origin: String,
    evidence: Option<String>,
) -> Result<TypesetProjectRevision, String> {
    let _guard = lock_revision_state()?;
    capture_project_revision_at_unlocked(root, label, reason, actor, origin, evidence)
}

/// Ensure an initial complete project state exists before a mutating command
/// runs. This is intentionally public to the generic workspace file commands:
/// their succeeding write/rename/delete then becomes one durable revision.
pub(crate) fn ensure_project_revision(root: &Path) -> Result<TypesetProjectRevision, String> {
    let _guard = lock_revision_state()?;
    let ledger = load_revision_ledger(root)?;
    if let Some(revision) = head_revision(&ledger) {
        return Ok(revision.clone());
    }
    capture_project_revision_at_unlocked(
        root,
        None,
        "project-baseline".to_string(),
        "system".to_string(),
        "baseline".to_string(),
        None,
    )
}

/// Record the post-state of a mutation. A no-op does not create another
/// revision, which keeps autosave quiet while preserving every real change.
pub(crate) fn record_project_mutation(
    root: &Path,
    reason: &str,
    actor: &str,
    origin: &str,
    evidence: Option<String>,
) -> Result<TypesetProjectRevision, String> {
    let _guard = lock_revision_state()?;
    capture_project_revision_at_unlocked(
        root,
        None,
        reason.to_string(),
        actor.to_string(),
        origin.to_string(),
        evidence,
    )
}

/// Git operations can be meaningful audit events even when they leave the
/// working tree byte-for-byte unchanged (for example, staging or committing).
/// A labelled revision deliberately bypasses the normal no-op coalescing so
/// the project timeline remains an auditable transaction ledger.
pub(crate) fn record_project_event(
    root: &Path,
    reason: &str,
    actor: &str,
    origin: &str,
    evidence: Option<String>,
) -> Result<TypesetProjectRevision, String> {
    let _guard = lock_revision_state()?;
    capture_project_revision_at_unlocked(
        root,
        Some(format!("Event: {reason}")),
        reason.to_string(),
        actor.to_string(),
        origin.to_string(),
        evidence,
    )
}

// Every command below reads the revision ledger, and a capture also hashes the
// whole workspace. On a real project that is far too much work for the main
// thread, so they are `async` and run on the blocking pool — see
// `crate::blocking::off_main_thread`.

#[tauri::command]
pub async fn typeset_revision_capture(
    input: TypesetRevisionCaptureInput,
) -> Result<TypesetProjectRevision, String> {
    off_main_thread(move || {
        let root = files::workspace_root()?;
        capture_project_revision_at(
            &root,
            input.label,
            input.reason,
            input.actor,
            input.origin,
            input.evidence,
        )
    })
    .await
}

#[tauri::command]
pub async fn typeset_revision_list() -> Result<Vec<TypesetProjectRevisionSummary>, String> {
    off_main_thread(|| {
        let root = files::workspace_root()?;
        let ledger = load_revision_ledger(&root)?;
        Ok(ledger
            .revisions
            .iter()
            .rev()
            .map(revision_summary)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn typeset_revision_read(id: String) -> Result<TypesetProjectRevision, String> {
    off_main_thread(move || {
        let root = files::workspace_root()?;
        let ledger = load_revision_ledger(&root)?;
        Ok(find_revision(&ledger, &id)?.clone())
    })
    .await
}

#[tauri::command]
pub async fn typeset_revision_compare(
    base_revision_id: String,
    target_revision_id: String,
) -> Result<TypesetRevisionComparison, String> {
    off_main_thread(move || {
        let root = files::workspace_root()?;
        let ledger = load_revision_ledger(&root)?;
        let base = find_revision(&ledger, &base_revision_id)?;
        let target = find_revision(&ledger, &target_revision_id)?;
        Ok(TypesetRevisionComparison {
            base_revision_id: base_revision_id.clone(),
            target_revision_id: target_revision_id.clone(),
            operations: revision_operations_with_comments(
                &base.files,
                &target.files,
                &base.comments,
                &target.comments,
            ),
        })
    })
    .await
}

fn workspace_path_for_revision(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("invalid Typeset revision workspace path".to_string());
    }
    let target = root.join(path);
    if !target.starts_with(root) {
        return Err("Typeset revision workspace path is outside the project".to_string());
    }
    Ok(target)
}

fn revision_blob_bytes(root: &Path, content_hash: &str) -> Result<Vec<u8>, String> {
    fs::read(revision_blob_path(root, content_hash)?).map_err(|error| error.to_string())
}

/// True when the workspace file already holds exactly the bytes a manifest
/// wants there.
///
/// Applying a manifest means "make the project look like this", and it did so
/// by writing every file in it. That is not free: each write is a `sync_all`
/// plus a rename, so accepting a two-file review rewrote and fsynced the entire
/// manuscript — measured at 29s for a 483-file, 136MB project. Worse, it
/// restamps every mtime, so the watcher then wakes on all of them and starts
/// the capture cycle over. Content addressing already says which files differ.
fn revision_file_matches_disk(target: &Path, file: &TypesetRevisionFile) -> bool {
    // Length first: it settles almost every mismatch without reading the file.
    if fs::metadata(target).map_or(true, |metadata| metadata.len() != file.bytes) {
        return false;
    }
    fs::read(target)
        .map(|bytes| revision_file_hash(&bytes) == file.content_hash)
        .unwrap_or(false)
}

fn restore_revision_file_at(
    root: &Path,
    revision: &TypesetProjectRevision,
    path: &str,
) -> Result<(), String> {
    let target = workspace_path_for_revision(root, path)?;
    if let Some(file) = revision.files.iter().find(|file| file.path == path) {
        if revision_file_matches_disk(&target, file) {
            return Ok(());
        }
        let bytes = revision_blob_bytes(root, &file.content_hash)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        runtime::write_file_atomically(&target, &bytes).map_err(|error| error.to_string())
    } else {
        match fs::remove_file(&target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[tauri::command]
pub async fn typeset_revision_restore_file(
    revision_id: String,
    path: String,
) -> Result<TypesetProjectRevision, String> {
    off_main_thread(move || {
        let _guard = lock_revision_state()?;
        let root = files::workspace_root()?;
        // A state-changing restore always gets a fresh pre-restore revision first,
        // including external edits that arrived since the last UI operation.
        let before = capture_project_revision_at_unlocked(
            &root,
            None,
            "before-restore".to_string(),
            "user".to_string(),
            "history".to_string(),
            None,
        )?;
        let ledger = load_revision_ledger(&root)?;
        let revision = find_revision(&ledger, &revision_id)?.clone();
        if let Err(error) = restore_revision_file_at(&root, &revision, &path) {
            let _ = restore_revision_file_at(&root, &before, &path);
            return Err(error);
        }
        capture_project_revision_at_unlocked(
            &root,
            None,
            "restore-file".to_string(),
            "user".to_string(),
            "history".to_string(),
            Some(revision_id),
        )
    })
    .await
}

fn restore_revision_comments(root: &Path, revision: &TypesetProjectRevision) -> Result<(), String> {
    let comments_root = root.join(TYPESET_STATE_DIR).join("comments");
    let existing = if comments_root.exists() {
        WalkDir::new(&comments_root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| entry.into_path())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let desired = revision
        .comments
        .iter()
        .map(|file| (file.path.clone(), file.clone()))
        .collect::<BTreeMap<_, _>>();
    for path in existing {
        let relative = revision_relative_path(root, &path)?;
        if !desired.contains_key(&relative) {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    for file in desired.values() {
        let target = workspace_path_for_revision(root, &file.path)?;
        if revision_file_matches_disk(&target, file) {
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let bytes = revision_blob_bytes(root, &file.content_hash)?;
        runtime::write_file_atomically(&target, &bytes).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn apply_project_revision_manifest(
    root: &Path,
    revision: &TypesetProjectRevision,
) -> Result<(), String> {
    let desired = revision_file_map(&revision.files);
    for current in project_revision_files(root)? {
        let relative = revision_relative_path(root, &current)?;
        if !desired.contains_key(&relative) {
            fs::remove_file(&current).map_err(|error| error.to_string())?;
        }
    }
    for file in desired.values() {
        restore_revision_file_at(root, revision, &file.path)?;
    }
    restore_revision_comments(root, revision)
}

#[tauri::command]
pub async fn typeset_revision_restore_project(
    revision_id: String,
) -> Result<TypesetProjectRevision, String> {
    off_main_thread(move || {
        let _guard = lock_revision_state()?;
        let root = files::workspace_root()?;
        let before = capture_project_revision_at_unlocked(
            &root,
            None,
            "before-project-restore".to_string(),
            "user".to_string(),
            "history".to_string(),
            None,
        )?;
        let ledger = load_revision_ledger(&root)?;
        let revision = find_revision(&ledger, &revision_id)?.clone();
        if let Err(restore_error) = apply_project_revision_manifest(&root, &revision) {
            let rollback = apply_project_revision_manifest(&root, &before);
            return Err(match rollback {
                Ok(()) => format!(
                    "could not restore project revision; project was rolled back: {restore_error}"
                ),
                Err(rollback_error) => format!(
                    "could not restore project revision ({restore_error}); rollback also failed ({rollback_error})"
                ),
            });
        }
        capture_project_revision_at_unlocked(
            &root,
            None,
            "restore-project".to_string(),
            "user".to_string(),
            "history".to_string(),
            Some(revision_id),
        )
    })
    .await
}

#[tauri::command]
pub async fn typeset_revision_export_zip(
    revision_id: String,
    destination_path: String,
) -> Result<String, String> {
    off_main_thread(move || {
        let root = files::workspace_root()?;
        let ledger = load_revision_ledger(&root)?;
        let revision = find_revision(&ledger, &revision_id)?;
        let destination = PathBuf::from(destination_path.trim());
        if destination.as_os_str().is_empty() {
            return Err("history ZIP destination is empty".to_string());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temporary = destination.with_extension("history-part");
        let file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for entry in &revision.files {
            zip.start_file(&entry.path, options)
                .map_err(|error| error.to_string())?;
            zip.write_all(&revision_blob_bytes(&root, &entry.content_hash)?)
                .map_err(|error| error.to_string())?;
        }
        // Keep the review context portable with the source tree. These are the
        // project-local comment documents captured by this revision, not current
        // live comments.
        for comment in &revision.comments {
            zip.start_file(&comment.path, options)
                .map_err(|error| error.to_string())?;
            zip.write_all(&revision_blob_bytes(&root, &comment.content_hash)?)
                .map_err(|error| error.to_string())?;
        }
        zip.start_file(".somniq-history-revision.json", options)
            .map_err(|error| error.to_string())?;
        zip.write_all(
            serde_json::to_vec_pretty(revision)
                .map_err(|error| error.to_string())?
                .as_slice(),
        )
        .map_err(|error| error.to_string())?;
        zip.finish().map_err(|error| error.to_string())?;
        if destination.exists() {
            fs::remove_file(&destination).map_err(|error| error.to_string())?;
        }
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        Ok(destination.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
pub async fn typeset_changeset_create(
    input: TypesetChangeSetCreateInput,
) -> Result<TypesetChangeSet, String> {
    off_main_thread(move || {
        let _guard = lock_revision_state()?;
        let root = files::workspace_root()?;
        create_change_set_at(&root, input)
    })
    .await
}

/// The body of `typeset_changeset_create`, against an explicit workspace.
///
/// Aggregation, carrying and base selection are the whole contract of a review
/// queue, and none of it is reachable through the command itself — that reads
/// the process-wide workspace root. Callers other than tests must go through
/// the command so the revision lock is held.
fn create_change_set_at(
    root: &Path,
    input: TypesetChangeSetCreateInput,
) -> Result<TypesetChangeSet, String> {
    {
        let root = root.to_path_buf();
        let ledger = load_revision_ledger(&root)?;
        let revision = find_revision(&ledger, &input.revision_id)?;
        let base_revision_id = revision.parent_revision_id.clone().ok_or_else(|| {
            "the initial project baseline cannot be reviewed as a change set".to_string()
        })?;
        let id = format!("changeset-{}", revision.id);
        let path = change_set_path(&root, &id)?;
        if let Some(existing) = read_change_set(&path)? {
            return Ok(existing);
        }
        let actor = normalize_revision_text(input.actor, "external", 80);
        let origin = normalize_revision_text(input.origin, "watcher", 80);
        let evidence = input.evidence.and_then(|value| {
            let value = value.trim().chars().take(2_000).collect::<String>();
            (!value.is_empty()).then_some(value)
        });
        let action_id = input
            .action_id
            .map(|value| value.trim().chars().take(120).collect::<String>())
            .filter(|value| !value.is_empty());
        let target_id = revision.id.clone();

        // A second watcher burst while review is pending extends the same durable
        // transaction. Separate parent-based ChangeSets would be impossible to
        // resolve once the ledger HEAD advanced, and would split one Chat action
        // into arbitrary per-file confirmations.
        let mut candidates = stored_change_sets(&root)?
            .into_iter()
            .filter(|change_set| {
                change_set.status == "pending"
                    && revision_is_ancestor(&ledger, &change_set.base_revision_id, &target_id)
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| left.created_at_ms.cmp(&right.created_at_ms));

        // A review answers for one action. Extending a *finished* action's
        // transaction with the next one's writes is what made the two
        // indistinguishable: the span then covered both, so a later removal of
        // text the earlier one introduced cancelled inside it and the reviewer
        // was never shown — and could never reject — what the newer action
        // actually did. It also aimed the blanket "reject" at a base from before
        // an action nobody was asking about.
        //
        // So an unanswered transaction from a different action is *carried*: the
        // workspace keeps exactly what it already holds, the record stays as an
        // auditable `carried` entry naming its files, and the new action starts
        // from that state. An answered one is still extended — a rebase keeps
        // those answers, while carrying would silently turn a recorded `reject`
        // into "kept as-is", which is the opposite of what was asked.
        let extends_action = |change_set: &TypesetChangeSet| match action_id.as_deref() {
            None => true,
            // A stored transaction with no action of its own predates this
            // record and therefore predates the running session: it cannot be
            // part of the action writing now, so it is carried like any other
            // finished one.
            Some(id) => {
                change_set.action_id == id
                    // Already covering this exact revision means these are the
                    // same writes reported twice — a Chat completion event
                    // arriving after the watcher captured its last write, say —
                    // not a new action. Carrying then sets the new base to the
                    // target it already holds, leaving an empty review and
                    // discarding a real one.
                    || change_set.revision_id == target_id
                    || change_set
                        .decisions
                        .iter()
                        .any(|decision| decision.decision != "pending")
            }
        };
        let carried = if candidates.iter().any(extends_action) {
            Vec::new()
        } else {
            candidates
                .iter()
                .filter(|change_set| {
                    revision_is_ancestor(&ledger, &change_set.revision_id, &target_id)
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        let base_revision_id = carried
            .last()
            .map(|change_set| change_set.revision_id.clone())
            .unwrap_or(base_revision_id);
        let carried_from = carried.last().map(|change_set| change_set.id.clone());
        let carried_paths = carried
            .iter()
            .flat_map(|change_set| change_set.decisions.iter())
            .filter(|decision| !decision.operation_id.starts_with("comment:"))
            .map(|decision| decision.path.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        for mut change_set in carried {
            change_set.status = "carried".to_string();
            change_set.updated_at_ms = now_ms();
            write_json(&change_set_path(&root, &change_set.id)?, &change_set)?;
        }
        candidates.retain(extends_action);
        if let Some(mut aggregate) = candidates.first().cloned() {
            rebase_pending_change_set(&ledger, &mut aggregate, &target_id)?;
            if aggregate.actor != actor {
                aggregate.actor = if actor == "chat" || aggregate.actor == "chat" {
                    "chat".to_string()
                } else {
                    "multiple".to_string()
                };
            }
            if aggregate.origin != origin {
                aggregate.origin = if origin == "chat" || aggregate.origin == "chat" {
                    "chat".to_string()
                } else {
                    "multiple".to_string()
                };
            }
            if evidence.is_some() {
                aggregate.evidence = evidence;
            }
            // An answered transaction that the newer action extended now covers
            // both, so it belongs to the newer one: the writes still to come are
            // its continuation, not the finished action's.
            if let Some(id) = action_id.clone() {
                aggregate.action_id = id;
            }
            aggregate.updated_at_ms = now_ms();
            write_json(&change_set_path(&root, &aggregate.id)?, &aggregate)?;
            for mut superseded in candidates.into_iter().skip(1) {
                superseded.status = "superseded".to_string();
                superseded.updated_at_ms = aggregate.updated_at_ms;
                write_json(&change_set_path(&root, &superseded.id)?, &superseded)?;
            }
            return Ok(aggregate);
        }
        let base = find_revision(&ledger, &base_revision_id)?;
        let operations = revision_operations_with_comments(
            &base.files,
            &revision.files,
            &base.comments,
            &revision.comments,
        );
        let created_at_ms = now_ms();
        let stems = change_stems(base, revision);
        let decisions = operations
            .iter()
            .filter(|operation| reviewable_change_operation(operation, &stems))
            .map(|operation| TypesetChangeSetDecision {
                operation_id: operation.id.clone(),
                path: operation.path.clone(),
                decision: "pending".to_string(),
                resolved_hash: None,
                resolved_bytes: None,
                hunk_decisions: Vec::new(),
                hunk_ids: Vec::new(),
            })
            .collect::<Vec<_>>();
        let status = if decisions.is_empty() {
            "ignored"
        } else {
            "pending"
        };
        let change_set = TypesetChangeSet {
            id,
            base_revision_id,
            revision_id: revision.id.clone(),
            actor,
            origin,
            evidence,
            status: status.to_string(),
            decisions,
            resulting_revision_id: None,
            created_at_ms,
            updated_at_ms: created_at_ms,
            action_id: action_id.unwrap_or_default(),
            carried_from,
            carried_paths,
        };
        write_json(&path, &change_set)?;
        Ok(change_set)
    }
}

#[tauri::command]
pub async fn typeset_changeset_list() -> Result<Vec<TypesetChangeSet>, String> {
    off_main_thread(move || {
        let _guard = lock_revision_state()?;
        let root = files::workspace_root()?;
        stored_change_sets(&root)
    })
    .await
}

fn change_set_text_for_hash(
    root: &Path,
    content_hash: Option<&str>,
) -> Result<Option<String>, String> {
    content_hash
        .map(|hash| {
            let bytes = revision_blob_bytes(root, hash)?;
            files::decode_text_bytes(&bytes).map_err(|_| {
                "this ChangeSet operation is binary and cannot be reviewed as text".to_string()
            })
        })
        .transpose()
}

#[tauri::command]
pub async fn typeset_changeset_read_text(
    id: String,
    path: String,
) -> Result<TypesetChangeSetTextFile, String> {
    off_main_thread(move || {
        let _guard = lock_revision_state()?;
        let root = files::workspace_root()?;
        let change_set = read_change_set(&change_set_path(&root, &id)?)?
            .ok_or_else(|| "Typeset change set not found".to_string())?;
        let ledger = load_revision_ledger(&root)?;
        let operations = change_set_operations(&ledger, &change_set)?;
        let stems = change_set_stems(&ledger, &change_set)?;
        let operation = operations
            .iter()
            .find(|operation| {
                operation.path == path && reviewable_change_operation(operation, &stems)
            })
            .ok_or_else(|| "Typeset ChangeSet file operation not found".to_string())?;
        let decision = change_set
            .decisions
            .iter()
            .find(|decision| decision.operation_id == operation.id);
        Ok(TypesetChangeSetTextFile {
            operation_id: operation.id.clone(),
            kind: operation.kind.clone(),
            path: operation.path.clone(),
            previous_path: operation.previous_path.clone(),
            base_content: change_set_text_for_hash(&root, operation.before_hash.as_deref())?,
            incoming_content: change_set_text_for_hash(&root, operation.after_hash.as_deref())?,
            resolved_content: change_set_text_for_hash(
                &root,
                decision.and_then(|decision| decision.resolved_hash.as_deref()),
            )?,
            base_hash: operation.before_hash.clone(),
            incoming_hash: operation.after_hash.clone(),
        })
    })
    .await
}

#[tauri::command]
pub async fn typeset_changeset_stage_text(
    input: TypesetChangeSetStageTextInput,
) -> Result<TypesetChangeSet, String> {
    off_main_thread(move || {
        validate_content(&input.content)?;
        if input
            .hunk_decisions
            .iter()
            .any(|decision| !matches!(decision.as_str(), "accept" | "reject"))
        {
            return Err("invalid Typeset hunk decision".to_string());
        }
        if input.hunk_ids.len() != input.hunk_decisions.len() {
            return Err("Typeset hunk identities do not match the decisions".to_string());
        }
        let _guard = lock_revision_state()?;
        let root = files::workspace_root()?;
        let path = change_set_path(&root, &input.id)?;
        let mut change_set =
            read_change_set(&path)?.ok_or_else(|| "Typeset change set not found".to_string())?;
        if change_set.status != "pending" {
            return Err("this Typeset change set has already been resolved".to_string());
        }
        let ledger = load_revision_ledger(&root)?;
        let operations = change_set_operations(&ledger, &change_set)?;
        let operation = operations
            .iter()
            .find(|operation| operation.id == input.operation_id && operation.path == input.path)
            .ok_or_else(|| "Typeset ChangeSet operation not found".to_string())?;
        if !matches!(operation.kind.as_str(), "create" | "modify") {
            return Err("only created or modified text files can be reviewed by hunk".to_string());
        }
        let reference_hash = operation
            .after_hash
            .as_deref()
            .or(operation.before_hash.as_deref())
            .ok_or_else(|| "Typeset text operation has no encoding reference".to_string())?;
        let reference_bytes = revision_blob_bytes(&root, reference_hash)?;
        let resolved_bytes = files::encode_text_like_bytes(&input.content, &reference_bytes);
        let content_hash = store_revision_blob(&root, &resolved_bytes)?;
        let (decision, resolved_hash, resolved_bytes) =
            if operation.after_hash.as_deref() == Some(content_hash.as_str()) {
                ("accept", None, None)
            } else if operation.before_hash.as_deref() == Some(content_hash.as_str()) {
                ("reject", None, None)
            } else {
                (
                    "partial",
                    Some(content_hash),
                    Some(resolved_bytes.len() as u64),
                )
            };
        let staged = change_set
            .decisions
            .iter_mut()
            .find(|item| item.operation_id == operation.id)
            .ok_or_else(|| "Typeset ChangeSet decision not found".to_string())?;
        staged.decision = decision.to_string();
        staged.resolved_hash = resolved_hash;
        staged.resolved_bytes = resolved_bytes;
        staged.hunk_decisions = input.hunk_decisions;
        staged.hunk_ids = input.hunk_ids;
        change_set.updated_at_ms = now_ms();
        write_json(&path, &change_set)?;
        Ok(change_set)
    })
    .await
}

#[tauri::command]
pub async fn typeset_changeset_resolve(
    input: TypesetChangeSetResolveInput,
) -> Result<TypesetChangeSet, String> {
    off_main_thread(move || {
        let _guard = lock_revision_state()?;
        let root = files::workspace_root()?;
        let path = change_set_path(&root, &input.id)?;
        let mut change_set =
            read_change_set(&path)?.ok_or_else(|| "Typeset change set not found".to_string())?;
        if change_set.status != "pending" {
            return Ok(change_set);
        }
        let ledger = load_revision_ledger(&root)?;
        let review_target = find_revision(&ledger, &change_set.revision_id)?.clone();
        let base = find_revision(&ledger, &change_set.base_revision_id)?.clone();
        let operations = revision_operations_with_comments(
            &base.files,
            &review_target.files,
            &base.comments,
            &review_target.comments,
        );
        let stems = change_stems(&base, &review_target);
        let expected = operations
            .iter()
            .filter(|operation| reviewable_change_operation(operation, &stems))
            .map(|operation| (operation.id.as_str(), operation))
            .collect::<BTreeMap<_, _>>();
        // A change set stored before build output was excluded still carries
        // decisions for operations that are no longer reviewable. Dropping those
        // keeps the "every reviewable operation has exactly one decision" invariant
        // without leaving the change set permanently unresolvable.
        let mut decisions = input.decisions;
        decisions.retain(|decision| expected.contains_key(decision.operation_id.as_str()));
        let mut seen = BTreeSet::new();
        let invalid_decisions = decisions.len() != expected.len()
            || decisions.iter().any(|decision| {
                let Some(operation) = expected.get(decision.operation_id.as_str()) else {
                    return true;
                };
                if !seen.insert(decision.operation_id.as_str()) || decision.path != operation.path {
                    return true;
                }
                match decision.decision.as_str() {
                    "pending" | "accept" | "reject" => false,
                    "partial" => {
                        !matches!(operation.kind.as_str(), "create" | "modify")
                            || decision.resolved_hash.as_deref().is_none_or(|hash| {
                                revision_blob_path(&root, hash).map_or(true, |path| !path.is_file())
                            })
                            || decision.resolved_bytes.is_none()
                    }
                    _ => true,
                }
            });
        if invalid_decisions {
            return Err("invalid Typeset change set decisions".to_string());
        }
        change_set.decisions = decisions;
        change_set.updated_at_ms = now_ms();
        if change_set
            .decisions
            .iter()
            .any(|decision| decision.decision == "pending")
        {
            write_json(&path, &change_set)?;
            return Ok(change_set);
        }
        let head_id = ledger
            .head_revision_id
            .as_deref()
            .ok_or_else(|| "the project has no revision to rebase this ChangeSet onto".to_string())?;
        if rebase_pending_change_set(&ledger, &mut change_set, head_id)? {
            if change_set.status != "pending"
                || change_set
                    .decisions
                    .iter()
                    .any(|decision| decision.decision == "pending")
            {
                write_json(&path, &change_set)?;
                return Ok(change_set);
            }
        }
        let target = find_revision(&ledger, &change_set.revision_id)?.clone();
        let operations = revision_operations_with_comments(
            &base.files,
            &target.files,
            &base.comments,
            &target.comments,
        );
        // The watcher and ledger are asynchronous relative to another process. A
        // matching ledger HEAD is not enough: verify the live project manifest so
        // a just-arrived external write can never be overwritten by review.
        let live_files = snapshot_project_files(&root)?;
        let live_comments = snapshot_comments(&root)?;
        if live_files != target.files || live_comments != target.comments {
            let drift = capture_project_revision_at_unlocked(
                &root,
                None,
                "review-drift".to_string(),
                "external".to_string(),
                "review-verify".to_string(),
                Some(change_set.id.clone()),
            )?;
            let rebased_ledger = load_revision_ledger(&root)?;
            rebase_pending_change_set(&rebased_ledger, &mut change_set, &drift.id)?;
            write_json(&path, &change_set)?;
            return Ok(change_set);
        }
        if change_set
            .decisions
            .iter()
            .all(|decision| decision.decision == "accept")
        {
            let result = capture_project_revision_at_unlocked(
                &root,
                Some("Review accepted".to_string()),
                "changeset-review".to_string(),
                "user".to_string(),
                "review".to_string(),
                Some(change_set.id.clone()),
            )?;
            change_set.status = "accepted".to_string();
            change_set.resulting_revision_id = Some(result.id);
            write_json(&path, &change_set)?;
            return Ok(change_set);
        }
        let decision_by_operation = change_set
            .decisions
            .iter()
            .map(|decision| (decision.operation_id.as_str(), decision))
            .collect::<BTreeMap<_, _>>();
        let mut desired = revision_file_map(&base.files);
        let target_files = revision_file_map(&target.files);
        for operation in &operations {
            if operation.kind.starts_with("comment-") {
                continue;
            }
            let Some(decision) = decision_by_operation.get(operation.id.as_str()) else {
                continue;
            };
            match decision.decision.as_str() {
                "reject" => continue,
                "partial" => {
                    let Some(content_hash) = decision.resolved_hash.clone() else {
                        return Err("partial Typeset decision has no resolved content".to_string());
                    };
                    desired.insert(
                        operation.path.clone(),
                        TypesetRevisionFile {
                            path: operation.path.clone(),
                            content_hash,
                            bytes: decision.resolved_bytes.unwrap_or_default(),
                        },
                    );
                }
                "accept" => match operation.kind.as_str() {
                    "create" | "modify" => {
                        if let Some(file) = target_files.get(&operation.path) {
                            desired.insert(operation.path.clone(), file.clone());
                        }
                    }
                    "delete" => {
                        desired.remove(&operation.path);
                    }
                    "move" => {
                        if let Some(previous_path) = operation.previous_path.as_deref() {
                            desired.remove(previous_path);
                        }
                        if let Some(file) = target_files.get(&operation.path) {
                            desired.insert(operation.path.clone(), file.clone());
                        }
                    }
                    _ => return Err("unsupported Typeset change set operation".to_string()),
                },
                _ => return Err("unresolved Typeset change set decision".to_string()),
            }
        }
        let mut desired_comments = revision_file_map(&base.comments);
        let target_comments = revision_file_map(&target.comments);
        for operation in operations
            .iter()
            .filter(|operation| operation.kind.starts_with("comment-"))
        {
            let Some(decision) = decision_by_operation.get(operation.id.as_str()) else {
                continue;
            };
            let kind = operation.kind.trim_start_matches("comment-");
            match decision.decision.as_str() {
                "reject" => continue,
                "accept" => match kind {
                    "create" | "modify" => {
                        if let Some(file) = target_comments.get(&operation.path) {
                            desired_comments.insert(operation.path.clone(), file.clone());
                        }
                    }
                    "delete" => {
                        desired_comments.remove(&operation.path);
                    }
                    "move" => {
                        if let Some(previous_path) = operation.previous_path.as_deref() {
                            desired_comments.remove(previous_path);
                        }
                        if let Some(file) = target_comments.get(&operation.path) {
                            desired_comments.insert(operation.path.clone(), file.clone());
                        }
                    }
                    _ => return Err("unsupported Typeset comment change operation".to_string()),
                },
                _ => return Err("unresolved Typeset comment change decision".to_string()),
            }
        }
        let desired_revision = TypesetProjectRevision {
            files: desired.values().cloned().collect(),
            comments: desired_comments.values().cloned().collect(),
            ..target.clone()
        };
        if let Err(apply_error) = apply_project_revision_manifest(&root, &desired_revision) {
            let rollback = apply_project_revision_manifest(&root, &target);
            return Err(match rollback {
                Ok(()) => format!("could not apply Typeset ChangeSet; project was rolled back: {apply_error}"),
                Err(rollback_error) => format!(
                    "could not apply Typeset ChangeSet ({apply_error}); rollback also failed ({rollback_error})"
                ),
            });
        }
        let result = capture_project_revision_at_unlocked(
            &root,
            None,
            "changeset-review".to_string(),
            "user".to_string(),
            "review".to_string(),
            Some(change_set.id.clone()),
        )?;
        change_set.status = if change_set
            .decisions
            .iter()
            .all(|decision| decision.decision == "reject")
        {
            "rejected".to_string()
        } else {
            "partially-accepted".to_string()
        };
        change_set.resulting_revision_id = Some(result.id);
        write_json(&path, &change_set)?;
        Ok(change_set)
    })
    .await
}

#[tauri::command]
pub fn typeset_change_proposal_save(
    path: String,
    mut proposal: TypesetChangeProposal,
) -> Result<TypesetChangeProposal, String> {
    for content in [
        &proposal.base_content,
        &proposal.local_content,
        &proposal.incoming_content,
    ] {
        validate_content(content)?;
    }
    if let Some(draft) = proposal.review_draft.as_deref() {
        validate_content(draft)?;
    }
    if proposal
        .decisions
        .iter()
        .any(|decision| !matches!(decision.as_str(), "pending" | "accept" | "reject"))
    {
        return Err("invalid Typeset proposal decision".to_string());
    }
    if proposal.too_large_to_chunk {
        if !proposal.decisions.is_empty() || !proposal.hunk_ids.is_empty() {
            return Err("an oversized Typeset proposal cannot carry hunk decisions".to_string());
        }
    } else if proposal.hunk_ids.len() != proposal.decisions.len() {
        return Err("Typeset proposal hunk identities do not match the decisions".to_string());
    }
    if proposal
        .whole_file_decision
        .as_deref()
        .is_some_and(|decision| !matches!(decision, "incoming" | "local"))
    {
        return Err("invalid Typeset whole-file decision".to_string());
    }
    let (root, relative, key) = source_identity(&path)?;
    proposal.path = relative;
    if proposal.id.trim().is_empty() {
        proposal.id = format!("proposal-{}", now_ms());
    }
    if proposal.created_at_ms == 0 {
        proposal.created_at_ms = now_ms();
    }
    proposal.actor = normalize_revision_text(proposal.actor, "external", 80);
    proposal.origin = normalize_revision_text(proposal.origin, "watcher", 80);
    proposal.evidence = proposal.evidence.and_then(|value| {
        let value = value.trim().chars().take(2_000).collect::<String>();
        (!value.is_empty()).then_some(value)
    });
    write_json(
        &state_path(&root, "proposals", &format!("{key}.json")),
        &proposal,
    )?;
    Ok(proposal)
}

#[tauri::command]
pub fn typeset_change_proposal_load(path: String) -> Result<Option<TypesetChangeProposal>, String> {
    let (root, _, key) = source_identity(&path)?;
    read_json(&state_path(&root, "proposals", &format!("{key}.json")))
}

#[tauri::command]
pub fn typeset_change_proposal_clear(path: String) -> Result<(), String> {
    let (root, _, key) = source_identity(&path)?;
    remove_if_present(state_path(&root, "proposals", &format!("{key}.json")))
}

fn comments_path(root: &Path, key: &str) -> PathBuf {
    state_path(root, "comments", &format!("{key}.json"))
}

#[tauri::command]
pub fn typeset_comments_list(path: String) -> Result<Vec<TypesetComment>, String> {
    let (root, _, key) = source_identity(&path)?;
    Ok(read_json(&comments_path(&root, &key))?.unwrap_or_default())
}

#[tauri::command]
pub fn typeset_comment_upsert(
    path: String,
    mut comment: TypesetComment,
) -> Result<TypesetComment, String> {
    if comment.body.trim().is_empty() || comment.body.chars().count() > 4_000 {
        return Err("a Typeset comment must contain 1 to 4000 characters".to_string());
    }
    if comment.selected_text.chars().count() > 8_000 {
        return Err("the commented source range is too large".to_string());
    }
    let (root, relative, key) = source_identity(&path)?;
    ensure_project_revision(&root)?;
    let path = comments_path(&root, &key);
    let mut comments: Vec<TypesetComment> = read_json(&path)?.unwrap_or_default();
    let timestamp = now_ms();
    comment.path = relative;
    comment.body = comment.body.trim().to_string();
    comment.author = comment.author.trim().chars().take(120).collect();
    if comment.author.is_empty() {
        comment.author = "You".to_string();
    }
    comment.origin = comment.origin.trim().chars().take(80).collect();
    if comment.origin.is_empty() {
        comment.origin = "user".to_string();
    }
    if comment.id.trim().is_empty() {
        comment.id = format!("comment-{timestamp}");
        comment.created_at_ms = timestamp;
    }
    comment.updated_at_ms = timestamp;
    if let Some(index) = comments
        .iter()
        .position(|existing| existing.id == comment.id)
    {
        comment.created_at_ms = comments[index].created_at_ms;
        comments[index] = comment.clone();
    } else {
        comments.push(comment.clone());
    }
    comments.sort_by(|left, right| right.updated_at_ms.cmp(&left.updated_at_ms));
    write_json(&path, &comments)?;
    record_project_mutation(
        &root,
        "comment-update",
        &comment.author,
        &comment.origin,
        Some(comment.id.clone()),
    )?;
    Ok(comment)
}

#[tauri::command]
pub fn typeset_comment_delete(path: String, id: String) -> Result<(), String> {
    let (root, _, key) = source_identity(&path)?;
    ensure_project_revision(&root)?;
    let path = comments_path(&root, &key);
    let mut comments: Vec<TypesetComment> = read_json(&path)?.unwrap_or_default();
    comments.retain(|comment| comment.id != id);
    write_json(&path, &comments)?;
    record_project_mutation(&root, "comment-delete", "user", "comment", Some(id))?;
    Ok(())
}

fn history_summary(entry: &TypesetHistoryEntry) -> TypesetHistorySummary {
    TypesetHistorySummary {
        id: entry.id.clone(),
        path: entry.path.clone(),
        version: entry.version.clone(),
        label: entry.label.clone(),
        reason: entry.reason.clone(),
        created_at_ms: entry.created_at_ms,
        bytes: entry.content.len(),
    }
}

fn history_entries(directory: &Path) -> Result<Vec<(PathBuf, TypesetHistoryEntry)>, String> {
    let mut entries = Vec::new();
    let read = match fs::read_dir(directory) {
        Ok(read) => read,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
        Err(error) => return Err(error.to_string()),
    };
    for item in read {
        let path = item.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Some(entry) = read_json::<TypesetHistoryEntry>(&path)? {
            entries.push((path, entry));
        }
    }
    entries.sort_by(|left, right| right.1.created_at_ms.cmp(&left.1.created_at_ms));
    Ok(entries)
}

#[tauri::command]
pub fn typeset_history_create(
    path: String,
    content: String,
    label: Option<String>,
    reason: String,
) -> Result<TypesetHistorySummary, String> {
    validate_content(&content)?;
    let (root, relative, key) = source_identity(&path)?;
    create_history_at(&root, relative, key, content, label, reason)
}

fn create_history_at(
    root: &Path,
    relative: String,
    key: String,
    content: String,
    label: Option<String>,
    reason: String,
) -> Result<TypesetHistorySummary, String> {
    let version = format!("sha256:{:x}", Sha256::digest(content.as_bytes()));
    let directory = state_path(root, "history", &key);
    if let Some((_, existing)) = history_entries(&directory)?
        .into_iter()
        .find(|(_, entry)| entry.version == version && entry.label == label)
    {
        return Ok(history_summary(&existing));
    }
    let created_at_ms = now_ms();
    let id = format!("{created_at_ms}-{}", &version[7..19]);
    let entry = TypesetHistoryEntry {
        id: id.clone(),
        path: relative,
        content,
        version,
        label: label.and_then(|value| {
            let value = value.trim().chars().take(120).collect::<String>();
            (!value.is_empty()).then_some(value)
        }),
        reason: reason.trim().chars().take(80).collect(),
        created_at_ms,
    };
    write_json(&directory.join(format!("{id}.json")), &entry)?;
    Ok(history_summary(&entry))
}

#[tauri::command]
pub fn typeset_history_list(path: String) -> Result<Vec<TypesetHistorySummary>, String> {
    let (root, _, key) = source_identity(&path)?;
    Ok(history_entries(&state_path(&root, "history", &key))?
        .iter()
        .map(|(_, entry)| history_summary(entry))
        .collect())
}

#[tauri::command]
pub fn typeset_history_read(path: String, id: String) -> Result<TypesetHistoryEntry, String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("invalid Typeset history id".to_string());
    }
    let (root, _, key) = source_identity(&path)?;
    read_json(&state_path(&root, "history", &key).join(format!("{id}.json")))?
        .ok_or_else(|| "Typeset history entry not found".to_string())
}

fn searchable_project_files(root: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            !matches!(
                name.as_str(),
                ".git" | ".somniq" | "node_modules" | "target"
            )
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    SEARCHABLE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
                })
        })
}

fn literal_pattern(query: &str, case_sensitive: bool) -> Result<regex::Regex, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("project search query is empty".to_string());
    }
    if query.chars().count() > 500 {
        return Err("project search query is too long".to_string());
    }
    regex::RegexBuilder::new(&regex::escape(query))
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn typeset_project_search(
    query: String,
    case_sensitive: bool,
) -> Result<Vec<TypesetProjectSearchMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pattern = literal_pattern(&query, case_sensitive)?;
        let root = files::workspace_root()?;
        let mut matches = Vec::new();
        for path in searchable_project_files(&root) {
            let bytes = match fs::read(&path) {
                Ok(bytes) if bytes.len() <= MAX_STATE_CONTENT_BYTES => bytes,
                _ => continue,
            };
            let source = match files::decode_text_bytes(&bytes) {
                Ok(source) => source,
                Err(_) => continue,
            };
            for (line_index, line) in source.lines().enumerate() {
                for found in pattern.find_iter(line) {
                    matches.push(TypesetProjectSearchMatch {
                        path: files::display_workspace_path(&path, &root),
                        line: line_index + 1,
                        column: line[..found.start()].chars().count() + 1,
                        preview: line.trim().chars().take(240).collect(),
                    });
                    if matches.len() >= MAX_PROJECT_SEARCH_MATCHES {
                        return Ok(matches);
                    }
                }
            }
        }
        Ok(matches)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn typeset_project_replace(
    query: String,
    replacement: String,
    case_sensitive: bool,
) -> Result<TypesetProjectReplaceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pattern = literal_pattern(&query, case_sensitive)?;
        let root = files::workspace_root()?;
        ensure_project_revision(&root)?;
        let mut files_changed = 0;
        let mut replacements = 0;
        for path in searchable_project_files(&root) {
            let bytes = match fs::read(&path) {
                Ok(bytes) if bytes.len() <= MAX_STATE_CONTENT_BYTES => bytes,
                _ => continue,
            };
            let source = match files::decode_text_bytes(&bytes) {
                Ok(source) => source,
                Err(_) => continue,
            };
            let count = pattern.find_iter(&source).count();
            if count == 0 {
                continue;
            }
            let updated = pattern.replace_all(&source, regex::NoExpand(&replacement));
            runtime::write_file_atomically(&path, updated.as_bytes())
                .map_err(|error| error.to_string())?;
            files_changed += 1;
            replacements += count;
        }
        if files_changed > 0 {
            record_project_mutation(
                &root,
                "project-replace",
                "user",
                "bulk-replace",
                Some(query.trim().chars().take(500).collect()),
            )?;
        }
        Ok(TypesetProjectReplaceResult {
            files_changed,
            replacements,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Applying a manifest wrote every file it lists, each with its own
    /// `sync_all` and rename. Accepting a review that touches two files
    /// therefore rewrote the whole manuscript — 29s on a 483-file, 136MB
    /// project — and restamped every mtime, waking the watcher on all of them.
    ///
    /// The blob for the already-correct file is deliberately absent here: a
    /// rewrite has to read it, so this fails loudly the moment the skip is
    /// lost, instead of only getting slower.
    #[test]
    fn applying_a_manifest_leaves_files_that_already_match_alone() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(root.path().join("unchanged.tex"), "body\n").expect("unchanged");
        fs::write(root.path().join("stale.tex"), "old\n").expect("stale");
        let wanted = b"new\n";
        let stale_hash = store_revision_blob(root.path(), wanted).expect("blob");

        let revision = TypesetProjectRevision {
            id: "rev-1".to_string(),
            parent_revision_id: None,
            label: None,
            reason: "test".to_string(),
            actor: "user".to_string(),
            origin: "test".to_string(),
            evidence: None,
            created_at_ms: 1,
            files: vec![
                TypesetRevisionFile {
                    path: "unchanged.tex".to_string(),
                    content_hash: revision_file_hash(b"body\n"),
                    bytes: 5,
                },
                TypesetRevisionFile {
                    path: "stale.tex".to_string(),
                    content_hash: stale_hash,
                    bytes: wanted.len() as u64,
                },
            ],
            comments: Vec::new(),
            operations: Vec::new(),
        };

        apply_project_revision_manifest(root.path(), &revision).expect("apply");
        assert_eq!(
            fs::read_to_string(root.path().join("unchanged.tex")).expect("read"),
            "body\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("stale.tex")).expect("read"),
            "new\n"
        );
    }

    fn change_set_input(
        revision_id: &str,
        actor: &str,
        origin: &str,
        action_id: Option<&str>,
    ) -> TypesetChangeSetCreateInput {
        TypesetChangeSetCreateInput {
            revision_id: revision_id.to_string(),
            actor: actor.to_string(),
            origin: origin.to_string(),
            evidence: None,
            action_id: action_id.map(str::to_string),
        }
    }

    /// Drift found when the project opens is a finished action: it is
    /// everything that happened while this editor was not watching. Letting the
    /// next Chat turn extend its review made the span cover both, and a Chat
    /// turn that removes text the drift introduced then cancels against it and
    /// vanishes from the review entirely — the reviewer is never shown, and can
    /// never reject, what the turn actually did. The blanket "reject" aimed at
    /// that same span reverts a day of work nobody was asked about.
    #[test]
    fn an_unanswered_review_from_an_earlier_action_is_carried_not_extended() {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("main.tex");
        fs::write(&source, "settled\n").expect("settled");
        ensure_project_revision(root.path()).expect("baseline");

        fs::write(&source, "settled\ndrift\n").expect("drift");
        let drifted = record_project_mutation(root.path(), "external-change", "external", "project-open", None)
            .expect("drift revision");
        let drift_review = create_change_set_at(
            root.path(),
            change_set_input(&drifted.id, "external", "project-open", Some("open-1")),
        )
        .expect("drift review");
        assert_eq!(drift_review.status, "pending");

        fs::write(&source, "settled\n").expect("chat undoes the drift");
        let chatted = record_project_mutation(root.path(), "chat-change", "chat", "chat", None)
            .expect("chat revision");
        let chat_review = create_change_set_at(
            root.path(),
            change_set_input(&chatted.id, "chat", "chat", Some("chat-1")),
        )
        .expect("chat review");

        // The Chat turn is reviewed from where it started, so its removal is a
        // hunk to answer rather than a cancellation inside a wider span.
        assert_ne!(chat_review.id, drift_review.id);
        assert_eq!(chat_review.base_revision_id, drifted.id);
        assert_eq!(chat_review.carried_from.as_deref(), Some(drift_review.id.as_str()));
        assert_eq!(chat_review.carried_paths, vec!["main.tex".to_string()]);
        assert_eq!(chat_review.decisions.len(), 1);
        assert_eq!(chat_review.decisions[0].operation_id, "modify:main.tex");

        // The carried review is not applied and not silently dropped: the
        // workspace keeps what it already held, and the record says so.
        let stored = stored_change_sets(root.path()).expect("stored");
        let carried = stored
            .iter()
            .find(|change_set| change_set.id == drift_review.id)
            .expect("carried review");
        assert_eq!(carried.status, "carried");
        assert_eq!(
            fs::read_to_string(&source).expect("read"),
            "settled\n",
            "carrying a review must not write anything"
        );
    }

    /// Chat's completion event arrives after the watcher already captured the
    /// turn's last write, so it reports writes a transaction is holding under a
    /// fresh action. Carrying there would move the new base onto the target
    /// that transaction already covers — an empty review, with the real one
    /// filed away as skipped.
    #[test]
    fn a_completion_event_for_writes_already_under_review_keeps_that_review() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(root.path().join("main.tex"), "one\n").expect("write");
        ensure_project_revision(root.path()).expect("baseline");

        // Two notifications from the turn, so the transaction is rebased onto a
        // revision its own id does not name — the duplicate-id shortcut below
        // cannot catch the third call.
        fs::write(root.path().join("main.tex"), "two\n").expect("write");
        let first = record_project_mutation(root.path(), "external-change", "external", "watcher", None)
            .expect("first revision");
        let watched = create_change_set_at(
            root.path(),
            change_set_input(&first.id, "external", "watcher", Some("external-1")),
        )
        .expect("watcher review");
        fs::write(root.path().join("chapter.tex"), "new\n").expect("write");
        let second = record_project_mutation(root.path(), "external-change", "external", "watcher", None)
            .expect("second revision");
        create_change_set_at(
            root.path(),
            change_set_input(&second.id, "external", "watcher", Some("external-1")),
        )
        .expect("extended review");

        // Nothing changed since, so the capture hands back the same revision.
        let same = record_project_mutation(root.path(), "chat-change", "chat", "chat", None)
            .expect("chat revision");
        assert_eq!(same.id, second.id);
        let after_chat = create_change_set_at(
            root.path(),
            change_set_input(&same.id, "chat", "chat", Some("chat-1")),
        )
        .expect("chat review");

        assert_eq!(after_chat.id, watched.id);
        assert_eq!(after_chat.status, "pending");
        assert_eq!(after_chat.decisions.len(), 2);
        assert!(after_chat.carried_from.is_none());
    }

    #[test]
    fn a_second_burst_of_the_same_action_still_extends_one_transaction() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(root.path().join("main.tex"), "one\n").expect("write");
        ensure_project_revision(root.path()).expect("baseline");

        fs::write(root.path().join("main.tex"), "two\n").expect("write");
        let first = record_project_mutation(root.path(), "external-change", "external", "watcher", None)
            .expect("first");
        let opened = create_change_set_at(
            root.path(),
            change_set_input(&first.id, "external", "watcher", Some("action-1")),
        )
        .expect("open review");

        fs::write(root.path().join("chapter.tex"), "new file\n").expect("write");
        let second = record_project_mutation(root.path(), "chat-change", "chat", "chat", None)
            .expect("second");
        let extended = create_change_set_at(
            root.path(),
            change_set_input(&second.id, "chat", "chat", Some("action-1")),
        )
        .expect("extended review");

        assert_eq!(extended.id, opened.id);
        assert_eq!(extended.revision_id, second.id);
        assert_eq!(extended.actor, "chat");
        assert_eq!(extended.decisions.len(), 2);
        assert!(extended.carried_from.is_none());
    }

    /// Carrying a review keeps whatever is on disk, which for an answered
    /// operation would turn a recorded `reject` into "kept as-is" — the exact
    /// opposite of the answer. A review being worked on is extended instead,
    /// which is the existing rebase contract.
    #[test]
    fn an_answered_review_is_extended_by_the_next_action_rather_than_carried() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(root.path().join("main.tex"), "one\n").expect("write");
        ensure_project_revision(root.path()).expect("baseline");

        fs::write(root.path().join("main.tex"), "two\n").expect("write");
        let first = record_project_mutation(root.path(), "external-change", "external", "watcher", None)
            .expect("first");
        let mut answered = create_change_set_at(
            root.path(),
            change_set_input(&first.id, "external", "watcher", Some("action-1")),
        )
        .expect("open review");
        answered.decisions[0].decision = "reject".to_string();
        write_json(
            &change_set_path(root.path(), &answered.id).expect("path"),
            &answered,
        )
        .expect("store answer");

        fs::write(root.path().join("chapter.tex"), "new file\n").expect("write");
        let second = record_project_mutation(root.path(), "chat-change", "chat", "chat", None)
            .expect("second");
        let extended = create_change_set_at(
            root.path(),
            change_set_input(&second.id, "chat", "chat", Some("action-2")),
        )
        .expect("extended review");

        assert_eq!(extended.id, answered.id);
        assert_eq!(
            extended
                .decisions
                .iter()
                .find(|decision| decision.path == "main.tex")
                .map(|decision| decision.decision.as_str()),
            Some("reject"),
            "the answer already given has to survive the next action"
        );
    }

    #[test]
    fn history_is_sorted_newest_first() {
        let root = tempfile::tempdir().expect("tempdir");
        for (id, created_at_ms) in [("old", 1), ("new", 2)] {
            write_json(
                &root.path().join(format!("{id}.json")),
                &TypesetHistoryEntry {
                    id: id.to_string(),
                    path: "main.tex".to_string(),
                    content: id.to_string(),
                    version: id.to_string(),
                    label: None,
                    reason: "save".to_string(),
                    created_at_ms,
                },
            )
            .expect("write history");
        }
        let entries = history_entries(root.path()).expect("history");
        assert_eq!(entries[0].1.id, "new");
        assert_eq!(entries[1].1.id, "old");
    }

    #[test]
    fn project_ledger_keeps_binary_content_once_and_detects_moves() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(root.path().join("main.tex"), "first\n").expect("source");
        fs::create_dir_all(root.path().join("figures")).expect("figures");
        fs::write(root.path().join("figures/chart.png"), [0_u8, 127, 255]).expect("binary");

        let base = ensure_project_revision(root.path()).expect("baseline");
        assert_eq!(base.files.len(), 2);
        fs::write(root.path().join("main.tex"), "second\n").expect("updated source");
        fs::rename(
            root.path().join("figures/chart.png"),
            root.path().join("figures/chart-final.png"),
        )
        .expect("rename binary");

        let revision =
            record_project_mutation(root.path(), "save", "user", "editor", None).expect("revision");
        assert!(revision
            .operations
            .iter()
            .any(|operation| operation.kind == "modify" && operation.path == "main.tex"));
        assert!(revision.operations.iter().any(|operation| {
            operation.kind == "move"
                && operation.previous_path.as_deref() == Some("figures/chart.png")
                && operation.path == "figures/chart-final.png"
        }));

        let blobs = fs::read_dir(revision_directory(root.path()).join("blobs"))
            .expect("blob directory")
            .count();
        // two source states plus one binary state: the rename reuses its blob.
        assert_eq!(blobs, 3);
    }

    /// The editor's own write records a `user`/`editor` revision, and the file
    /// watcher then reports the very same write. Capturing that notification
    /// must find nothing new and hand back the user's revision unchanged — the
    /// desktop keys its "is this someone else's change?" gate on the returned
    /// actor, so minting a fresh `external`/`watcher` revision here is what
    /// would put a review gate in front of the user's own typing.
    #[test]
    fn a_watcher_capture_after_the_users_own_save_returns_that_save() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(root.path().join("main.tex"), "first\n").expect("source");
        ensure_project_revision(root.path()).expect("baseline");

        fs::write(root.path().join("main.tex"), "my own sentence\n").expect("user edit");
        let saved = record_project_mutation(root.path(), "save", "user", "editor", None)
            .expect("user revision");
        assert_eq!(saved.actor, "user");

        let watched = capture_project_revision_at(
            root.path(),
            None,
            "external-change".to_string(),
            "external".to_string(),
            "watcher".to_string(),
            Some("main.tex".to_string()),
        )
        .expect("watcher capture");
        assert_eq!(watched.id, saved.id);
        assert_eq!(watched.actor, "user");
        assert_eq!(watched.origin, "editor");

        let ledger = load_revision_ledger(root.path()).expect("ledger");
        assert_eq!(ledger.revisions.len(), 2, "no third revision was minted");
    }

    /// Build output must not be the thing that breaks the coalescing above: a
    /// compile fires the same watcher, and if its artifacts counted as project
    /// state the capture would mint an `external` revision every single time
    /// the user pressed Ctrl+S.
    #[test]
    fn a_compile_after_a_save_does_not_mint_an_external_revision() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(root.path().join("main.tex"), "first\n").expect("source");
        ensure_project_revision(root.path()).expect("baseline");
        fs::write(root.path().join("main.tex"), "my own sentence\n").expect("user edit");
        let saved = record_project_mutation(root.path(), "save", "user", "editor", None)
            .expect("user revision");

        for artifact in [
            "main.aux", "main.bbl", "main.blg", "main.fdb_latexmk", "main.fls", "main.log",
            "main.out", "main.toc", "main.pdf", "main.synctex.gz",
        ] {
            fs::write(root.path().join(artifact), "build").expect("artifact");
        }

        let watched = capture_project_revision_at(
            root.path(),
            None,
            "external-change".to_string(),
            "external".to_string(),
            "watcher".to_string(),
            None,
        )
        .expect("watcher capture");
        assert_eq!(watched.id, saved.id, "artifacts are not project state");
        assert_eq!(watched.actor, "user");
    }

    #[test]
    fn project_ledger_does_not_prune_revisions() {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("main.tex");
        fs::write(&source, "0").expect("source");
        ensure_project_revision(root.path()).expect("baseline");
        for index in 1..=24 {
            fs::write(&source, index.to_string()).expect("update");
            record_project_mutation(root.path(), "save", "user", "editor", None).expect("revision");
        }
        let ledger = load_revision_ledger(root.path()).expect("ledger");
        assert_eq!(ledger.revisions.len(), 25);
    }

    /// Pins the scratch-file predicate to what `tempfile` really names its
    /// files, so a change to the crate's naming fails here instead of quietly
    /// letting phantom entries back into review.
    #[test]
    fn the_scratch_file_predicate_matches_a_real_tempfile_name() {
        let root = tempfile::tempdir().expect("tempdir");
        let scratch = tempfile::NamedTempFile::new_in(root.path()).expect("scratch");
        let name = scratch
            .path()
            .file_name()
            .expect("file name")
            .to_string_lossy()
            .into_owned();
        assert!(
            files::is_transient_temp_file(&name),
            "tempfile produced {name}, which the filter no longer recognizes"
        );
    }

    #[test]
    fn atomic_write_scratch_files_never_enter_a_revision() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(root.path().join("main.tex"), "body\n").expect("source");
        // Exactly what `tempfile::NamedTempFile::new_in` leaves mid-write.
        fs::write(root.path().join(".tmpI7Xp4h"), "partial").expect("scratch");
        fs::write(root.path().join(".tmpfile.tex"), "real\n").expect("project file");

        let revision = ensure_project_revision(root.path()).expect("baseline");
        let paths = revision
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(paths, vec![".tmpfile.tex", "main.tex"]);
    }

    /// Reproduces "Accept does nothing". `typeset_changeset_resolve` refuses to
    /// apply a review when the live project no longer matches the revision it is
    /// reviewing. A scratch file captured into that revision is gone by the time
    /// the user clicks, so the comparison could never succeed again and every
    /// accept failed with "the project changed again before review was applied".
    #[test]
    fn an_in_flight_atomic_write_leaves_no_phantom_drift_for_review() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(root.path().join("main.tex"), "body\n").expect("source");
        let settled = snapshot_project_files(root.path()).expect("settled snapshot");

        // Another process is midway through an atomic write: the scratch sibling
        // exists, the rename has not landed yet. This is what the watcher wakes
        // the revision capture up for.
        let scratch = root.path().join(".tmpA1b2c3");
        fs::write(&scratch, "incoming\n").expect("scratch");
        let during = snapshot_project_files(root.path()).expect("mid-write snapshot");

        fs::remove_file(&scratch).expect("rename lands");
        let after = snapshot_project_files(root.path()).expect("post-write snapshot");

        // The revision under review must not contain the scratch file...
        assert_eq!(settled, during);
        // ...so the accept-time drift check still matches the live project.
        assert_eq!(during, after);
    }

    #[test]
    fn a_file_removed_mid_walk_is_skipped_instead_of_failing_the_snapshot() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(root.path().join("main.tex"), "body\n").expect("source");
        let snapshot = snapshot_paths(
            root.path(),
            [root.path().join("main.tex"), root.path().join("gone.tex")],
        )
        .expect("snapshot");
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].path, "main.tex");
    }

    /// A ledger written by an earlier build still records scratch files. Loading
    /// it must drop them, otherwise the workspace stays permanently unable to
    /// accept its pending review even after the capture path is fixed.
    #[test]
    fn a_ledger_polluted_with_scratch_files_heals_on_load() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(root.path().join("main.tex"), "body\n").expect("source");
        let live = snapshot_project_files(root.path()).expect("live");

        let polluted = TypesetProjectRevision {
            id: "rev-1".to_string(),
            parent_revision_id: None,
            label: None,
            reason: "external-change".to_string(),
            actor: "external".to_string(),
            origin: "watcher".to_string(),
            evidence: None,
            created_at_ms: 1,
            files: {
                let mut files = live.clone();
                files.push(TypesetRevisionFile {
                    path: ".tmpI7Xp4h".to_string(),
                    content_hash: "deadbeef".to_string(),
                    bytes: 7,
                });
                files.sort_by(|left, right| left.path.cmp(&right.path));
                files
            },
            comments: Vec::new(),
            operations: vec![TypesetRevisionOperation {
                id: "create:.tmpI7Xp4h".to_string(),
                kind: "create".to_string(),
                path: ".tmpI7Xp4h".to_string(),
                previous_path: None,
                before_hash: None,
                after_hash: Some("deadbeef".to_string()),
                bytes: 7,
            }],
        };
        save_revision_ledger(
            root.path(),
            &TypesetRevisionLedger {
                version: REVISION_LEDGER_VERSION,
                head_revision_id: Some(polluted.id.clone()),
                revisions: vec![polluted],
            },
        )
        .expect("write ledger");

        let ledger = load_revision_ledger(root.path()).expect("ledger");
        let head = head_revision(&ledger).expect("head");
        // This equality is exactly the drift check that blocked every accept.
        assert_eq!(head.files, live);
        assert!(head.operations.is_empty());
    }

    #[test]
    fn review_queue_ignores_latex_build_artifacts_but_keeps_project_resources() {
        let operation = |path: &str| TypesetRevisionOperation {
            id: format!("modify:{path}"),
            kind: "modify".to_string(),
            path: path.to_string(),
            previous_path: None,
            before_hash: Some("before".to_string()),
            after_hash: Some("after".to_string()),
            bytes: 1,
        };
        let stems = document_stems(["Final/main.tex", "Final/Ch2/chapter.tex"].into_iter());
        let reviewable = |path: &str| reviewable_change_operation(&operation(path), &stems);

        assert!(!reviewable("Final/Ch2/chapter.aux"));
        assert!(!reviewable("Final/Ch2/chapter.synctex.gz"));
        assert!(reviewable("Final/Ch2/chapter.tex"));
        assert!(reviewable("figures/result.png"));

        // The three shapes that produced 378 of one session's 383 review
        // entries: the compiled PDF, the SyncTeX file the engine is still
        // writing, and the same names in a different case.
        assert!(!reviewable("Final/main.pdf"));
        assert!(!reviewable("Final/Ch2/chapter.synctex(busy)"));
        assert!(!reviewable("Final/Ch2/CHAPTER.AUX"));

        // A PDF is only output next to the source that produces it.
        assert!(reviewable("figures/diagram.pdf"));
        assert!(reviewable("Final/appendix-scan.pdf"));

        // `epstopdf` rewrites EPS figures during the build under a fixed name,
        // with no `.tex` anywhere near them.
        assert!(!reviewable("Final/img/diagrama_h-eps-converted-to.pdf"));

        // A `-output-directory` build leaves its bookkeeping but no source, so
        // the stem has to be recognised from the artifacts themselves.
        let output_dir = document_stems(
            [
                "build/main.aux",
                "build/main.log",
                "build/main.fls",
                "figures/plot.pdf",
            ]
            .into_iter(),
        );
        assert!(!reviewable_change_operation(
            &operation("build/main.pdf"),
            &output_dir
        ));
        assert!(reviewable_change_operation(
            &operation("figures/plot.pdf"),
            &output_dir
        ));
    }

    #[test]
    fn build_output_never_enters_a_revision_and_a_restore_never_deletes_it() {
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("Final");
        fs::create_dir_all(&project).expect("project dir");
        for (name, body) in [
            ("main.tex", "\\documentclass{article}"),
            ("main.pdf", "%PDF-1.7 compiled"),
            ("main.aux", "\\relax"),
            ("main.synctex(busy)", "partial"),
            ("notes.md", "reviewable prose"),
        ] {
            fs::write(project.join(name), body).expect("write");
        }
        fs::create_dir_all(root.path().join("figures")).expect("figures dir");
        fs::write(root.path().join("figures/plot.pdf"), "%PDF authored").expect("write figure");

        let snapshot = snapshot_project_files(root.path()).expect("snapshot");
        let paths = snapshot
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec!["Final/main.tex", "Final/notes.md", "figures/plot.pdf"]
        );

        // `apply_project_revision_manifest` deletes whatever the manifest does
        // not list, so the exclusion has to be symmetric or a restore would
        // wipe the compiled PDF the user is reading.
        let revision = TypesetProjectRevision {
            id: "rev-test".to_string(),
            parent_revision_id: None,
            label: None,
            reason: "test".to_string(),
            actor: "user".to_string(),
            origin: "test".to_string(),
            evidence: None,
            created_at_ms: 0,
            operations: Vec::new(),
            files: snapshot,
            comments: Vec::new(),
        };
        apply_project_revision_manifest(root.path(), &revision).expect("restore");
        assert!(project.join("main.pdf").is_file());
        assert!(project.join("main.aux").is_file());
        assert!(root.path().join("figures/plot.pdf").is_file());
    }

    #[test]
    fn a_ledger_recorded_before_the_exclusion_does_not_report_phantom_deletions() {
        let root = tempfile::tempdir().expect("tempdir");
        let file = |path: &str| TypesetRevisionFile {
            path: path.to_string(),
            content_hash: "hash".to_string(),
            bytes: 1,
        };
        let polluted = TypesetProjectRevision {
            id: "rev-legacy".to_string(),
            parent_revision_id: None,
            label: None,
            reason: "test".to_string(),
            actor: "external".to_string(),
            origin: "watcher".to_string(),
            evidence: None,
            created_at_ms: 0,
            operations: vec![TypesetRevisionOperation {
                id: "modify:Final/main.pdf".to_string(),
                kind: "modify".to_string(),
                path: "Final/main.pdf".to_string(),
                previous_path: None,
                before_hash: Some("before".to_string()),
                after_hash: Some("after".to_string()),
                bytes: 1,
            }],
            files: vec![
                file("Final/main.tex"),
                file("Final/main.pdf"),
                file("Final/main.aux"),
            ],
            comments: Vec::new(),
        };
        save_revision_ledger(
            root.path(),
            &TypesetRevisionLedger {
                version: REVISION_LEDGER_VERSION,
                head_revision_id: Some(polluted.id.clone()),
                revisions: vec![polluted],
            },
        )
        .expect("write ledger");

        let ledger = load_revision_ledger(root.path()).expect("ledger");
        let head = head_revision(&ledger).expect("head");
        assert_eq!(
            head.files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["Final/main.tex"]
        );
        assert!(head.operations.is_empty());
    }

    #[test]
    fn project_operations_include_comment_changes_in_the_same_transaction() {
        let comment = |hash: &str| TypesetRevisionFile {
            path: ".somniq/typeset/comments/main.json".to_string(),
            content_hash: hash.to_string(),
            bytes: 10,
        };
        let operations =
            revision_operations_with_comments(&[], &[], &[comment("before")], &[comment("after")]);
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].kind, "comment-modify");
        assert!(operations[0].id.starts_with("comment:modify:"));
        assert!(reviewable_change_operation(
            &operations[0],
            &BTreeSet::new()
        ));
    }

    #[test]
    fn pending_change_set_rebases_from_its_original_base_to_the_latest_revision() {
        let file = |path: &str, hash: &str| TypesetRevisionFile {
            path: path.to_string(),
            content_hash: hash.to_string(),
            bytes: 1,
        };
        let revision =
            |id: &str, parent_revision_id: Option<&str>, files: Vec<TypesetRevisionFile>| {
                TypesetProjectRevision {
                    id: id.to_string(),
                    parent_revision_id: parent_revision_id.map(str::to_string),
                    label: None,
                    reason: "external-change".to_string(),
                    actor: "external".to_string(),
                    origin: "watcher".to_string(),
                    evidence: None,
                    created_at_ms: 1,
                    files,
                    comments: Vec::new(),
                    operations: Vec::new(),
                }
            };
        let ledger = TypesetRevisionLedger {
            version: REVISION_LEDGER_VERSION,
            head_revision_id: Some("latest".to_string()),
            revisions: vec![
                revision("base", None, vec![file("main.tex", "a")]),
                revision("middle", Some("base"), vec![file("main.tex", "b")]),
                revision(
                    "latest",
                    Some("middle"),
                    vec![file("main.tex", "b"), file("chapter.tex", "c")],
                ),
            ],
        };
        let change_set = TypesetChangeSet {
            id: "changeset-middle".to_string(),
            base_revision_id: "base".to_string(),
            revision_id: "middle".to_string(),
            actor: "external".to_string(),
            origin: "watcher".to_string(),
            evidence: None,
            status: "pending".to_string(),
            decisions: vec![TypesetChangeSetDecision {
                operation_id: "modify:main.tex".to_string(),
                path: "main.tex".to_string(),
                decision: "accept".to_string(),
                resolved_hash: None,
                resolved_bytes: None,
                hunk_decisions: Vec::new(),
                hunk_ids: Vec::new(),
            }],
            resulting_revision_id: None,
            created_at_ms: 1,
            updated_at_ms: 1,
            action_id: String::new(),
            carried_from: None,
            carried_paths: Vec::new(),
        };
        assert!(revision_is_ancestor(&ledger, "base", "latest"));
        let mut rebased = change_set;
        assert!(rebase_pending_change_set(&ledger, &mut rebased, "latest").expect("rebase"));
        assert_eq!(rebased.revision_id, "latest");
        assert_eq!(rebased.decisions.len(), 2);
        assert_eq!(rebased.decisions[0].operation_id, "create:chapter.tex");
        assert_eq!(rebased.decisions[0].decision, "pending");
        assert_eq!(rebased.decisions[1].operation_id, "modify:main.tex");
        assert_eq!(rebased.decisions[1].decision, "accept");
    }

    #[test]
    fn a_users_own_save_during_a_review_is_carried_forward_not_put_up_for_review() {
        let file = |path: &str, hash: &str| TypesetRevisionFile {
            path: path.to_string(),
            content_hash: hash.to_string(),
            bytes: 1,
        };
        let revision = |id: &str,
                        parent: Option<&str>,
                        actor: &str,
                        origin: &str,
                        files: Vec<TypesetRevisionFile>,
                        operations: Vec<TypesetRevisionOperation>| {
            TypesetProjectRevision {
                id: id.to_string(),
                parent_revision_id: parent.map(str::to_string),
                label: None,
                reason: "test".to_string(),
                actor: actor.to_string(),
                origin: origin.to_string(),
                evidence: None,
                created_at_ms: 1,
                files,
                comments: Vec::new(),
                operations,
            }
        };
        let modify = |path: &str, before: &str, after: &str| TypesetRevisionOperation {
            id: format!("modify:{path}"),
            kind: "modify".to_string(),
            path: path.to_string(),
            previous_path: None,
            before_hash: Some(before.to_string()),
            after_hash: Some(after.to_string()),
            bytes: 1,
        };
        // base -> agent rewrites chapter.tex -> the user saves their own notes.
        let ledger = TypesetRevisionLedger {
            version: REVISION_LEDGER_VERSION,
            head_revision_id: Some("user-save".to_string()),
            revisions: vec![
                revision(
                    "base",
                    None,
                    "user",
                    "editor",
                    vec![
                        file("chapter.tex", "chapter-base"),
                        file("notes.tex", "mine-1"),
                    ],
                    Vec::new(),
                ),
                revision(
                    "agent",
                    Some("base"),
                    "chat",
                    "chat",
                    vec![
                        file("chapter.tex", "chapter-agent"),
                        file("notes.tex", "mine-1"),
                    ],
                    vec![modify("chapter.tex", "chapter-base", "chapter-agent")],
                ),
                revision(
                    "user-save",
                    Some("agent"),
                    "user",
                    "editor",
                    vec![
                        file("chapter.tex", "chapter-agent"),
                        file("notes.tex", "mine-2"),
                    ],
                    vec![modify("notes.tex", "mine-1", "mine-2")],
                ),
            ],
        };
        let mut change_set = TypesetChangeSet {
            id: "changeset-agent".to_string(),
            base_revision_id: "base".to_string(),
            revision_id: "agent".to_string(),
            actor: "chat".to_string(),
            origin: "chat".to_string(),
            evidence: None,
            status: "pending".to_string(),
            decisions: vec![TypesetChangeSetDecision {
                operation_id: "modify:chapter.tex".to_string(),
                path: "chapter.tex".to_string(),
                decision: "reject".to_string(),
                resolved_hash: None,
                resolved_bytes: None,
                hunk_decisions: Vec::new(),
                hunk_ids: Vec::new(),
            }],
            resulting_revision_id: None,
            created_at_ms: 1,
            updated_at_ms: 1,
            action_id: String::new(),
            carried_from: None,
            carried_paths: Vec::new(),
        };

        assert!(rebase_pending_change_set(&ledger, &mut change_set, "user-save").expect("rebase"));
        let notes = change_set
            .decisions
            .iter()
            .find(|decision| decision.path == "notes.tex")
            .expect("the user's own save is still carried by the transaction");
        // "pending" would ask the user to confirm their own save, and the
        // project-level "Reject change set" maps every decision to reject —
        // which would restore notes.tex to its pre-save content.
        assert_eq!(notes.decision, "accept");
        // The agent's own change still needs its answer, and the one already
        // given is preserved.
        let chapter = change_set
            .decisions
            .iter()
            .find(|decision| decision.path == "chapter.tex")
            .expect("the reviewed operation survives the rebase");
        assert_eq!(chapter.decision, "reject");
    }

    #[test]
    fn a_git_checkout_during_a_review_still_needs_an_answer() {
        let file = |path: &str, hash: &str| TypesetRevisionFile {
            path: path.to_string(),
            content_hash: hash.to_string(),
            bytes: 1,
        };
        let operation = TypesetRevisionOperation {
            id: "modify:chapter.tex".to_string(),
            kind: "modify".to_string(),
            path: "chapter.tex".to_string(),
            previous_path: None,
            before_hash: Some("a".to_string()),
            after_hash: Some("b".to_string()),
            bytes: 1,
        };
        let revision = |id: &str,
                        parent: Option<&str>,
                        actor: &str,
                        origin: &str,
                        files: Vec<TypesetRevisionFile>,
                        operations: Vec<TypesetRevisionOperation>| {
            TypesetProjectRevision {
                id: id.to_string(),
                parent_revision_id: parent.map(str::to_string),
                label: None,
                reason: "test".to_string(),
                actor: actor.to_string(),
                origin: origin.to_string(),
                evidence: None,
                created_at_ms: 1,
                files,
                comments: Vec::new(),
                operations,
            }
        };
        let ledger = TypesetRevisionLedger {
            version: REVISION_LEDGER_VERSION,
            head_revision_id: Some("checkout".to_string()),
            revisions: vec![
                revision(
                    "base",
                    None,
                    "user",
                    "editor",
                    vec![file("chapter.tex", "a")],
                    Vec::new(),
                ),
                revision(
                    "checkout",
                    Some("base"),
                    // Git events are recorded as `user` because the person ran
                    // the command, but the working tree was rewritten by a tool
                    // — that is exactly what review exists for.
                    "user",
                    "git",
                    vec![file("chapter.tex", "b")],
                    vec![operation],
                ),
            ],
        };
        let mut change_set = TypesetChangeSet {
            id: "changeset-base".to_string(),
            base_revision_id: "base".to_string(),
            revision_id: "base".to_string(),
            actor: "external".to_string(),
            origin: "watcher".to_string(),
            evidence: None,
            status: "pending".to_string(),
            decisions: Vec::new(),
            resulting_revision_id: None,
            created_at_ms: 1,
            updated_at_ms: 1,
            action_id: String::new(),
            carried_from: None,
            carried_paths: Vec::new(),
        };
        assert!(rebase_pending_change_set(&ledger, &mut change_set, "checkout").expect("rebase"));
        assert_eq!(change_set.decisions.len(), 1);
        assert_eq!(change_set.decisions[0].decision, "pending");
    }
}
