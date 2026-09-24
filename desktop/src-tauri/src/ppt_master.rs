//! Managed PPT Master installation.
//!
//! PPT Master is intentionally kept out of the application binary: it is a
//! sizeable Python-backed Skill with its own release cadence.  This module
//! pins one audited upstream revision, installs it into SomniQ's existing user
//! Skill root, and gives it a private Python environment.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SKILL_NAME: &str = "ppt-master";
const VERSION: &str = "6.3.0";
const COMMIT: &str = "d3d81fe3cf4cc642de225159586308bbe98eeb4d";
const ARCHIVE_SHA256: &str = "60b8fc7c8c801c6aecc4fd3214360c9901024f66d5d8c7d17977424fc333ccc0";
const REPOSITORY: &str = "https://github.com/hugohe3/ppt-master";
const MAX_ARCHIVE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILES: usize = 20_000;
const MANIFEST_FILE: &str = ".somniq-managed.json";
const RUNTIME_FILE: &str = ".somniq-runtime.json";
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

/// Why an installer step failed, in a shape the UI can translate and act on.
///
/// The previous contract was a bare `String`, and it cost a debugging session:
/// a Chinese-Windows install died because pip decodes `requirements.txt` with
/// the process locale (cp936) and the pinned file is UTF-8 — but the operator
/// saw one untranslated sentence with a 2,000-character Python traceback glued
/// to it, so "it will not install" was all the information that survived to the
/// bug report.
///
/// The split here is deliberate: `code` carries the meaning (the frontend
/// switches on it to pick a localized sentence), `params` fills that sentence's
/// blanks, and `detail` is raw untranslated evidence shown as secondary text.
/// A reader who speaks no English still learns which step failed.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PptMasterError {
    pub code: PptMasterErrorCode,
    /// Named substitutions for the localized sentence. Keys are part of the
    /// wire contract — `desktop/src/extensions/i18n.ts` reads them by name.
    pub params: BTreeMap<String, String>,
    /// Untranslated evidence: a subprocess's stderr tail, an io error. May be
    /// empty. Never the sole carrier of meaning — anything the user must act
    /// on belongs in `code` + `params`.
    pub detail: String,
    /// What the user can do about it, when there is a single obvious action.
    pub fix: Option<PptMasterFix>,
}

/// Stable machine keys for [`PptMasterError`]. Adding a variant requires a
/// matching entry in the frontend copy table; `installer_error_codes_are_exhaustive`
/// pins the list so a silent addition fails the build's test run instead of
/// reaching a user as an untranslated fallback.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PptMasterErrorCode {
    /// A `ppt-master` Skill from another source is active; refuse to shadow it.
    Unmanaged,
    /// No Python interpreter on PATH (or at `SOMNIQ_PYTHON`).
    PythonMissing,
    /// `python -m venv` failed, or produced an incomplete environment.
    VenvFailed,
    /// `pip install -r requirements.txt` failed.
    DependenciesFailed,
    /// The upstream attribution / execution-gate check rejected the package.
    AttributionFailed,
    /// The pinned archive could not be fetched.
    DownloadFailed,
    /// The archive was fetched but its SHA-256 did not match the pin.
    ChecksumMismatch,
    /// The archive tripped a safety limit, or carried an unsafe entry.
    ArchiveRejected,
    /// The archive extracted, but the Skill tree is missing or misidentified.
    PackageIncomplete,
    /// A filesystem operation failed (create, rename, remove).
    FilesystemFailed,
    /// Every step reported success, yet the result is not a ready install.
    NotReady,
}

/// A single remediation the UI can offer as a button.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PptMasterFix {
    /// Send the user somewhere to install a prerequisite.
    OpenUrl { url: String },
    /// Reveal a path in the OS file manager (an unmanaged Skill to move aside).
    RevealPath { path: String },
    /// Nothing to configure — the step is worth attempting again (network).
    Retry,
}

impl PptMasterError {
    fn new(code: PptMasterErrorCode) -> Self {
        Self {
            code,
            params: BTreeMap::new(),
            detail: String::new(),
            fix: None,
        }
    }

    fn param(mut self, key: &str, value: impl Into<String>) -> Self {
        self.params.insert(key.to_string(), value.into());
        self
    }

    fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = detail.into();
        self
    }

    fn fix(mut self, fix: PptMasterFix) -> Self {
        self.fix = Some(fix);
        self
    }
}

/// Filesystem failures all reduce to "this operation, on this path, said this".
/// The path is a `param` (the localized sentence names it) and the OS message
/// is `detail`.
fn filesystem_error(operation: &str, path: &Path, error: impl std::fmt::Display) -> PptMasterError {
    PptMasterError::new(PptMasterErrorCode::FilesystemFailed)
        .param("operation", operation)
        .param("path", display(path))
        .detail(error.to_string())
}

/// One environment check, reported before the user commits to an install.
///
/// Modelled on a pre-flight rather than a post-mortem: the realistic failure on
/// a fresh machine is "no Python", and learning that after a 90 MB download and
/// a rolled-back staging directory is strictly worse than learning it up front.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PptMasterCheck {
    /// Stable key; the frontend maps it to a localized label.
    pub id: String,
    pub status: PptMasterCheckStatus,
    /// Free-text observation (an interpreter version, a path). May be empty.
    pub detail: String,
    pub fix: Option<PptMasterFix>,
}

/// No `Warn` today: every check either passes or blocks the install, and a
/// status nothing emits would be a shape the UI has to handle without ever
/// being exercised.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PptMasterCheckStatus {
    Pass,
    Fail,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PptMasterStatus {
    pub status: String,
    pub installed: bool,
    pub managed: bool,
    pub current: bool,
    pub dependencies_ready: bool,
    pub install_supported: bool,
    pub version: Option<String>,
    pub available_version: String,
    pub commit: Option<String>,
    pub skill_path: String,
    pub python_path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PptMasterSlide {
    pub number: usize,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PptMasterDeck {
    pub id: String,
    pub title: String,
    pub root_path: String,
    pub slides: Vec<PptMasterSlide>,
    pub export_path: Option<String>,
    pub modified_epoch_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManagedSkillManifest {
    schema_version: u32,
    name: String,
    version: String,
    commit: String,
    repository: String,
    installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SkillRuntimeManifest {
    schema_version: u32,
    python: String,
    artifact_root: String,
}

fn skill_path() -> PathBuf {
    runtime::aris_user_skills_dir().join(SKILL_NAME)
}

fn runtime_parent() -> PathBuf {
    PathBuf::from(runtime::home_dir())
        .join(".config")
        .join("SomniQ")
        .join("skill-runtimes")
        .join(SKILL_NAME)
}

fn runtime_path() -> PathBuf {
    runtime_parent().join(VERSION)
}

fn venv_python(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("Scripts").join("python.exe")
    } else {
        root.join("bin").join("python")
    }
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn read_manifest(root: &Path) -> Option<ManagedSkillManifest> {
    let raw = fs::read_to_string(root.join(MANIFEST_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn status_at(skill: &Path, runtime_root: &Path) -> PptMasterStatus {
    let manifest = read_manifest(skill);
    // Any same-name path counts as installed for overwrite protection. A
    // malformed directory must not be treated as empty space.
    let installed = skill.exists();
    let skill_ready = skill.join("SKILL.md").is_file();
    let managed = manifest
        .as_ref()
        .is_some_and(|value| value.name == SKILL_NAME && value.repository == REPOSITORY);
    let current = manifest
        .as_ref()
        .is_some_and(|value| value.version == VERSION && value.commit == COMMIT);
    let python = venv_python(runtime_root);
    let dependencies_ready = skill_ready && current && python.is_file();

    let (status, message) = if !installed && manifest.is_none() {
        (
            "missing",
            "PPT Master is not installed. Installation downloads the pinned upstream release and creates a private Python environment.",
        )
    } else if !managed {
        (
            "unmanaged",
            "A local ppt-master Skill already exists. SomniQ will not overwrite or remove an unmanaged Skill.",
        )
    } else if !current {
        (
            "updateAvailable",
            "A managed PPT Master installation is present, but it is not the version pinned by this SomniQ build.",
        )
    } else if !dependencies_ready {
        (
            "broken",
            "The managed Skill is present, but its private Python environment is missing or incomplete. Reinstall it to repair the runtime.",
        )
    } else {
        (
            "ready",
            "PPT Master and its private Python environment are ready.",
        )
    };

    PptMasterStatus {
        status: status.to_string(),
        installed,
        managed,
        current,
        dependencies_ready,
        install_supported: !installed || managed,
        version: manifest.as_ref().map(|value| value.version.clone()),
        available_version: VERSION.to_string(),
        commit: manifest.as_ref().map(|value| value.commit.clone()),
        skill_path: display(skill),
        python_path: dependencies_ready.then(|| display(&python)),
        message: message.to_string(),
    }
}

fn managed_status() -> PptMasterStatus {
    let destination = skill_path();
    let mut status = status_at(&destination, &runtime_path());
    if status.installed {
        return status;
    }
    let Some(existing) = tools::discover_skills()
        .into_iter()
        .find(|skill| skill.name.eq_ignore_ascii_case(SKILL_NAME))
    else {
        return status;
    };

    status.status = "unmanaged".to_string();
    status.installed = true;
    status.managed = false;
    status.current = false;
    status.install_supported = false;
    status.skill_path = display(&existing.path);
    status.message =
        "A ppt-master Skill from another source is already active. SomniQ will not shadow it with a managed installation."
            .to_string();
    status
}

#[tauri::command]
pub async fn ppt_master_status() -> Result<PptMasterStatus, String> {
    crate::blocking::off_main_thread(|| Ok(managed_status())).await
}

/// Environment checks the operator can read before committing to an install.
#[tauri::command]
pub async fn ppt_master_preflight() -> Result<Vec<PptMasterCheck>, String> {
    crate::blocking::off_main_thread(|| Ok(preflight_blocking())).await
}

#[tauri::command]
pub async fn ppt_master_install() -> Result<PptMasterStatus, PptMasterError> {
    crate::blocking::typed_off_main_thread(install_blocking, |detail| {
        PptMasterError::new(PptMasterErrorCode::NotReady).detail(detail)
    })
    .await
}

#[tauri::command]
pub async fn ppt_master_uninstall() -> Result<PptMasterStatus, PptMasterError> {
    crate::blocking::typed_off_main_thread(uninstall_blocking, |detail| {
        PptMasterError::new(PptMasterErrorCode::FilesystemFailed).detail(detail)
    })
    .await
}

#[tauri::command]
pub async fn ppt_master_decks_list() -> Result<Vec<PptMasterDeck>, String> {
    crate::blocking::off_main_thread(|| {
        let workspace = crate::files::workspace_root()?;
        list_decks_at(&workspace)
    })
    .await
}

fn install_blocking() -> Result<PptMasterStatus, PptMasterError> {
    let _guard = INSTALL_LOCK.lock().map_err(|_| {
        PptMasterError::new(PptMasterErrorCode::NotReady).detail("installer lock is poisoned")
    })?;
    let destination = skill_path();
    let runtime_destination = runtime_path();
    let existing = managed_status();
    if existing.installed && !existing.managed {
        return Err(
            PptMasterError::new(PptMasterErrorCode::Unmanaged)
                .param("path", existing.skill_path.clone())
                .fix(PptMasterFix::RevealPath {
                    path: existing.skill_path,
                }),
        );
    }

    let skills_root = runtime::aris_user_skills_dir();
    let runtime_root = runtime_parent();
    fs::create_dir_all(&skills_root)
        .map_err(|error| filesystem_error("create", &skills_root, error))?;
    fs::create_dir_all(&runtime_root)
        .map_err(|error| filesystem_error("create", &runtime_root, error))?;

    let skill_staging = skills_root.join(".ppt-master.staging");
    let runtime_staging = runtime_root.join(format!(".{VERSION}.staging"));
    remove_known_directory(&skill_staging, &skills_root, ".ppt-master.staging")?;
    remove_known_directory(
        &runtime_staging,
        &runtime_root,
        &format!(".{VERSION}.staging"),
    )?;
    fs::create_dir_all(&skill_staging)
        .map_err(|error| filesystem_error("create", &skill_staging, error))?;

    let result: Result<(), PptMasterError> = (|| {
        let archive = download_archive()?;
        extract_skill_archive(&archive, &skill_staging)?;
        validate_skill_tree(&skill_staging)?;

        create_private_python(&runtime_staging)?;
        let staged_python = venv_python(&runtime_staging);
        install_python_dependencies(&staged_python, &skill_staging.join("requirements.txt"))?;
        run_attribution_guard(&staged_python, &skill_staging)?;

        replace_directory(
            &runtime_staging,
            &runtime_destination,
            &runtime_root,
            &format!(".{VERSION}.backup"),
        )?;
        let final_python = venv_python(&runtime_destination);
        write_manifests(&skill_staging, &final_python)?;
        replace_directory(
            &skill_staging,
            &destination,
            &skills_root,
            ".ppt-master.backup",
        )?;
        Ok(())
    })();

    if result.is_err() {
        let _ = remove_known_directory(&skill_staging, &skills_root, ".ppt-master.staging");
        let _ = remove_known_directory(
            &runtime_staging,
            &runtime_root,
            &format!(".{VERSION}.staging"),
        );
    }
    result?;

    let status = status_at(&destination, &runtime_destination);
    if status.status != "ready" {
        // Every step reported success and the result is still not usable, so
        // there is no failing step to name. Carry the status probe's own
        // reading as evidence.
        return Err(PptMasterError::new(PptMasterErrorCode::NotReady)
            .param("state", status.status.clone())
            .detail(status.message));
    }
    Ok(status)
}

fn uninstall_blocking() -> Result<PptMasterStatus, PptMasterError> {
    let _guard = INSTALL_LOCK.lock().map_err(|_| {
        PptMasterError::new(PptMasterErrorCode::FilesystemFailed)
            .detail("installer lock is poisoned")
    })?;
    let destination = skill_path();
    let runtime_destination = runtime_path();
    let status = status_at(&destination, &runtime_destination);
    if status.installed && !status.managed {
        return Err(
            PptMasterError::new(PptMasterErrorCode::Unmanaged)
                .param("path", status.skill_path.clone())
                .fix(PptMasterFix::RevealPath {
                    path: status.skill_path,
                }),
        );
    }

    let skills_root = runtime::aris_user_skills_dir();
    let runtime_root = runtime_parent();
    remove_known_directory(&destination, &skills_root, SKILL_NAME)?;
    remove_known_directory(&runtime_destination, &runtime_root, VERSION)?;
    Ok(status_at(&destination, &runtime_destination))
}

fn archive_url() -> String {
    format!("https://codeload.github.com/hugohe3/ppt-master/zip/{COMMIT}")
}

/// A transport failure is worth another attempt; a size or checksum failure is
/// not, so only the former carries [`PptMasterFix::Retry`].
fn download_error(detail: impl std::fmt::Display) -> PptMasterError {
    PptMasterError::new(PptMasterErrorCode::DownloadFailed)
        .detail(detail.to_string())
        .fix(PptMasterFix::Retry)
}

fn oversize_archive_error() -> PptMasterError {
    PptMasterError::new(PptMasterErrorCode::ArchiveRejected)
        .param("reason", "size")
        .param("limitMb", (MAX_ARCHIVE_BYTES / (1024 * 1024)).to_string())
}

fn download_archive() -> Result<Vec<u8>, PptMasterError> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(10 * 60))
        .build()
        .map_err(download_error)?;
    let response = client
        .get(archive_url())
        .header(
            reqwest::header::USER_AGENT,
            "SomniQ-Studio/PPT-Master-Installer",
        )
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(download_error)?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_ARCHIVE_BYTES)
    {
        return Err(oversize_archive_error());
    }

    let mut bytes = Vec::new();
    response
        .take(MAX_ARCHIVE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(download_error)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_ARCHIVE_BYTES {
        return Err(oversize_archive_error());
    }
    let actual_sha256 = format!("{:x}", Sha256::digest(&bytes));
    if actual_sha256 != ARCHIVE_SHA256 {
        // Not offered as retryable: a byte-stable pinned URL that hashes
        // differently means the upstream artifact moved or something rewrote
        // the response, and repeating the fetch cannot fix either.
        return Err(PptMasterError::new(PptMasterErrorCode::ChecksumMismatch)
            .param("expected", ARCHIVE_SHA256)
            .param("actual", actual_sha256));
    }
    Ok(bytes)
}

/// The archive is well-formed but violates an installer invariant. `reason`
/// selects the localized sentence, so each rejection says which limit or which
/// unsafe construct tripped it rather than sharing one opaque message.
fn archive_rejected(reason: &str) -> PptMasterError {
    PptMasterError::new(PptMasterErrorCode::ArchiveRejected).param("reason", reason)
}

fn extract_skill_archive(bytes: &[u8], destination: &Path) -> Result<(), PptMasterError> {
    let reader = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|error| archive_rejected("unreadable").detail(error.to_string()))?;
    if archive.len() > MAX_ARCHIVE_FILES {
        return Err(archive_rejected("fileCount").param("limit", MAX_ARCHIVE_FILES.to_string()));
    }

    let mut extracted_bytes = 0_u64;
    let mut extracted_files = 0_usize;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| archive_rejected("unreadable").detail(error.to_string()))?;
        let Some(enclosed) = entry.enclosed_name() else {
            return Err(archive_rejected("unsafePath"));
        };
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170_000 == 0o120_000)
        {
            return Err(archive_rejected("symlink"));
        }
        let components = enclosed.components().collect::<Vec<_>>();
        let skill_marker = components
            .windows(2)
            .position(|pair| component_eq(pair[0], "skills") && component_eq(pair[1], SKILL_NAME));
        let Some(marker) = skill_marker else {
            continue;
        };
        let relative = components[(marker + 2)..].iter().collect::<PathBuf>();
        if relative.as_os_str().is_empty() {
            continue;
        }
        let output = destination.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| filesystem_error("create", &output, error))?;
            continue;
        }
        extracted_bytes = extracted_bytes.saturating_add(entry.size());
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err(archive_rejected("extractedSize")
                .param("limitMb", (MAX_EXTRACTED_BYTES / (1024 * 1024)).to_string()));
        }
        extracted_files += 1;
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| filesystem_error("create", parent, error))?;
        }
        let mut target =
            fs::File::create(&output).map_err(|error| filesystem_error("create", &output, error))?;
        std::io::copy(&mut entry, &mut target)
            .map_err(|error| filesystem_error("extract", &output, error))?;
    }
    if extracted_files == 0 {
        return Err(PptMasterError::new(PptMasterErrorCode::PackageIncomplete)
            .param("missing", format!("skills/{SKILL_NAME}")));
    }
    Ok(())
}

fn component_eq(component: Component<'_>, expected: &str) -> bool {
    matches!(component, Component::Normal(value) if value == expected)
}

fn validate_skill_tree(root: &Path) -> Result<(), PptMasterError> {
    for relative in [
        "SKILL.md",
        "LICENSE",
        "SPONSORS.md",
        "SPONSORS_CN.md",
        "requirements.txt",
        "scripts/attribution_guard.py",
        "workflows/routing.md",
    ] {
        if !root.join(relative).is_file() {
            return Err(PptMasterError::new(PptMasterErrorCode::PackageIncomplete)
                .param("missing", relative));
        }
    }
    let skill = fs::read_to_string(root.join("SKILL.md"))
        .map_err(|error| filesystem_error("read", &root.join("SKILL.md"), error))?;
    if !skill.contains("name: ppt-master")
        || !skill.contains(&format!("version: \"{VERSION}\""))
        || !skill.contains(&format!("official_repository: \"{REPOSITORY}\""))
    {
        return Err(PptMasterError::new(PptMasterErrorCode::PackageIncomplete)
            .param("missing", "identity")
            .param("expectedVersion", VERSION));
    }
    Ok(())
}

/// Every installer subprocess runs in Python's UTF-8 mode.
///
/// The pinned `requirements.txt` is UTF-8 and carries Chinese comments. Without
/// UTF-8 mode, `pip install -r` decodes it with `locale.getpreferredencoding()`
/// — cp936 on a Chinese Windows install — and dies on the first non-ASCII byte
/// before it resolves a single dependency.
fn python_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = crate::process::hidden_command(program);
    command.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
    command
}

fn bootstrap_python_command() -> Command {
    if let Some(python) = std::env::var_os("SOMNIQ_PYTHON").filter(|value| !value.is_empty()) {
        return python_command(python);
    }
    python_command(if cfg!(windows) { "python" } else { "python3" })
}

/// Where to send a user who has no Python at all.
const PYTHON_DOWNLOAD_URL: &str = "https://www.python.org/downloads/";

fn python_missing_error() -> PptMasterError {
    PptMasterError::new(PptMasterErrorCode::PythonMissing)
        .param(
            "command",
            if cfg!(windows) { "python" } else { "python3" },
        )
        .fix(PptMasterFix::OpenUrl {
            url: PYTHON_DOWNLOAD_URL.to_string(),
        })
}

fn create_private_python(destination: &Path) -> Result<(), PptMasterError> {
    let mut command = bootstrap_python_command();
    command.args(["-m", "venv"]).arg(destination);
    run_checked(command, PptMasterErrorCode::VenvFailed)?;
    if !venv_python(destination).is_file() {
        // `python -m venv` exited 0 without producing an interpreter. Reported
        // as its own case rather than folded into a generic failure: the exit
        // status is the usual evidence and here it is actively misleading.
        return Err(PptMasterError::new(PptMasterErrorCode::VenvFailed)
            .param("reason", "silentlyIncomplete")
            .param("path", display(&venv_python(destination))));
    }
    Ok(())
}

fn install_python_dependencies(python: &Path, requirements: &Path) -> Result<(), PptMasterError> {
    let mut command = python_command(python);
    command
        .args([
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "-r",
        ])
        .arg(requirements);
    run_checked(command, PptMasterErrorCode::DependenciesFailed)
}

fn run_attribution_guard(python: &Path, skill_root: &Path) -> Result<(), PptMasterError> {
    let mut command = python_command(python);
    command.arg(skill_root.join("scripts").join("attribution_guard.py"));
    run_checked(command, PptMasterErrorCode::AttributionFailed)
}

fn run_checked(mut command: Command, code: PptMasterErrorCode) -> Result<(), PptMasterError> {
    let output = match command.output() {
        Ok(output) => output,
        // "The interpreter is not on PATH" and "the interpreter ran and failed"
        // are different problems with different remedies, and only the first
        // one has an action the user can take from this dialog.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(python_missing_error().detail(error.to_string()))
        }
        Err(error) => return Err(PptMasterError::new(code).detail(error.to_string())),
    };
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    // 2,000 characters of a Python traceback is evidence, not an explanation.
    // It rides in `detail`; `code` is what the UI actually renders.
    Err(PptMasterError::new(code)
        .param("exitCode", exit_code_text(&output.status))
        .detail(tail(detail, 2_000)))
}

fn exit_code_text(status: &std::process::ExitStatus) -> String {
    status
        .code()
        .map_or_else(|| "signal".to_string(), |code| code.to_string())
}

fn tail(value: &str, max_chars: usize) -> String {
    let count = value.chars().count();
    if count <= max_chars {
        value.to_string()
    } else {
        value.chars().skip(count - max_chars).collect()
    }
}

fn write_manifests(skill_root: &Path, python: &Path) -> Result<(), PptMasterError> {
    let managed = ManagedSkillManifest {
        schema_version: 1,
        name: SKILL_NAME.to_string(),
        version: VERSION.to_string(),
        commit: COMMIT.to_string(),
        repository: REPOSITORY.to_string(),
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    let manifest_path = skill_root.join(MANIFEST_FILE);
    let managed_json = serde_json::to_vec_pretty(&managed)
        .map_err(|error| filesystem_error("write", &manifest_path, error))?;
    runtime::write_file_atomically(&manifest_path, managed_json)
        .map_err(|error| filesystem_error("write", &manifest_path, error))?;

    let runtime_manifest = SkillRuntimeManifest {
        schema_version: 1,
        python: display(python),
        artifact_root: ".somniq/slides/ppt-master".to_string(),
    };
    let runtime_path = skill_root.join(RUNTIME_FILE);
    let runtime_json = serde_json::to_vec_pretty(&runtime_manifest)
        .map_err(|error| filesystem_error("write", &runtime_path, error))?;
    runtime::write_file_atomically(&runtime_path, runtime_json)
        .map_err(|error| filesystem_error("write", &runtime_path, error))
}

fn replace_directory(
    staging: &Path,
    destination: &Path,
    parent: &Path,
    backup_name: &str,
) -> Result<(), PptMasterError> {
    let backup = parent.join(backup_name);
    remove_known_directory(&backup, parent, backup_name)?;
    let had_destination = destination.exists();
    if had_destination {
        fs::rename(destination, &backup)
            .map_err(|error| filesystem_error("backup", destination, error))?;
    }
    if let Err(error) = fs::rename(staging, destination) {
        if had_destination {
            let _ = fs::rename(&backup, destination);
        }
        return Err(filesystem_error("activate", destination, error));
    }
    if had_destination {
        remove_known_directory(&backup, parent, backup_name)?;
    }
    Ok(())
}

fn remove_known_directory(
    path: &Path,
    parent: &Path,
    expected_name: &str,
) -> Result<(), PptMasterError> {
    if !path.exists() {
        return Ok(());
    }
    if path.parent() != Some(parent)
        || path.file_name().and_then(|value| value.to_str()) != Some(expected_name)
    {
        return Err(filesystem_error("remove", path, "unexpected installer path"));
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|error| filesystem_error("inspect", path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(filesystem_error(
            "remove",
            path,
            "not a directory, or a symbolic link",
        ));
    }
    fs::remove_dir_all(path).map_err(|error| filesystem_error("remove", path, error))
}

/// Read the environment the installer will depend on, without touching it.
///
/// Runs before the 90 MB download rather than after it: on a machine with no
/// Python the install is doomed from the first step, and finding that out from
/// a rolled-back staging directory teaches the operator nothing they could not
/// have been told in advance.
fn preflight_blocking() -> Vec<PptMasterCheck> {
    vec![interpreter_check(), skill_slot_check(&managed_status())]
}

/// Probe the interpreter the installer would actually launch.
///
/// Genuinely reads the environment, so it is the one part of the preflight that
/// cannot be unit tested against a fixture — which is exactly why the decision
/// logic lives in [`skill_slot_check`] instead of being tangled in here.
fn interpreter_check() -> PptMasterCheck {
    let mut command = bootstrap_python_command();
    command.arg("--version");
    match command.output() {
        Ok(output) if output.status.success() => {
            let text = if output.stdout.trim_ascii().is_empty() {
                output.stderr
            } else {
                output.stdout
            };
            PptMasterCheck {
                id: "python".to_string(),
                status: PptMasterCheckStatus::Pass,
                detail: String::from_utf8_lossy(&text).trim().to_string(),
                fix: None,
            }
        }
        Ok(output) => PptMasterCheck {
            id: "python".to_string(),
            status: PptMasterCheckStatus::Fail,
            detail: tail(String::from_utf8_lossy(&output.stderr).trim(), 400),
            fix: Some(PptMasterFix::OpenUrl {
                url: PYTHON_DOWNLOAD_URL.to_string(),
            }),
        },
        Err(error) => PptMasterCheck {
            id: "python".to_string(),
            status: PptMasterCheckStatus::Fail,
            detail: error.to_string(),
            fix: Some(PptMasterFix::OpenUrl {
                url: PYTHON_DOWNLOAD_URL.to_string(),
            }),
        },
    }
}

/// Whether the install slot is free, given an already-taken status reading.
///
/// Takes the status rather than reading it, so the decision is testable against
/// a fixture instead of against whatever Skills the developer happens to have
/// installed. A same-name Skill from another source is a legitimate setup — it
/// is reported, not treated as user error.
fn skill_slot_check(status: &PptMasterStatus) -> PptMasterCheck {
    let occupied = status.installed && !status.managed;
    PptMasterCheck {
        id: "skillSlot".to_string(),
        status: if occupied {
            PptMasterCheckStatus::Fail
        } else {
            PptMasterCheckStatus::Pass
        },
        detail: status.skill_path.clone(),
        fix: occupied.then(|| PptMasterFix::RevealPath {
            path: status.skill_path.clone(),
        }),
    }
}

fn list_decks_at(workspace: &Path) -> Result<Vec<PptMasterDeck>, String> {
    let slides_root = tools::layout::slides_dir_at(workspace).join(SKILL_NAME);
    if !slides_root.is_dir() {
        return Ok(Vec::new());
    }

    let mut final_directories = Vec::new();
    collect_svg_final_directories(&slides_root, 0, &mut final_directories)?;
    let mut decks = Vec::new();
    for final_directory in final_directories.into_iter().take(100) {
        let Some(deck_root) = final_directory.parent() else {
            continue;
        };
        let mut slide_files = fs::read_dir(&final_directory)
            .map_err(|error| format!("Could not read {}: {error}", final_directory.display()))?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let metadata = entry.file_type().ok()?;
                let path = entry.path();
                (metadata.is_file()
                    && path
                        .extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|value| value.eq_ignore_ascii_case("svg")))
                .then_some(path)
            })
            .collect::<Vec<_>>();
        slide_files.sort_by(|left, right| {
            slide_sort_key(left)
                .cmp(&slide_sort_key(right))
                .then_with(|| left.file_name().cmp(&right.file_name()))
        });
        slide_files.truncate(500);
        if slide_files.is_empty() {
            continue;
        }

        let slides = slide_files
            .iter()
            .enumerate()
            .map(|(index, path)| PptMasterSlide {
                number: index + 1,
                name: path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("slide.svg")
                    .to_string(),
                path: crate::files::display_workspace_path(path, workspace),
            })
            .collect::<Vec<_>>();
        let export = latest_pptx(&deck_root.join("exports"));
        let modified_epoch_ms = slide_files
            .iter()
            .chain(export.iter())
            .filter_map(|path| fs::metadata(path).ok()?.modified().ok())
            .filter_map(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
            .max()
            .unwrap_or_default();
        let root_path = crate::files::display_workspace_path(deck_root, workspace);
        let title = deck_root
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("PPT Master")
            .to_string();
        decks.push(PptMasterDeck {
            id: root_path.clone(),
            title,
            root_path,
            slides,
            export_path: export
                .as_deref()
                .map(|path| crate::files::display_workspace_path(path, workspace)),
            modified_epoch_ms,
        });
    }
    decks.sort_by(|left, right| {
        right
            .modified_epoch_ms
            .cmp(&left.modified_epoch_ms)
            .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
            .then_with(|| left.root_path.cmp(&right.root_path))
    });
    Ok(decks)
}

fn collect_svg_final_directories(
    directory: &Path,
    depth: usize,
    output: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > 4 || output.len() >= 100 {
        return Ok(());
    }
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Could not scan {}: {error}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.eq_ignore_ascii_case("svg_final"))
        {
            output.push(path);
            if output.len() >= 100 {
                break;
            }
        } else {
            collect_svg_final_directories(&path, depth + 1, output)?;
        }
    }
    Ok(())
}

fn slide_sort_key(path: &Path) -> (usize, String) {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let digits = name
        .chars()
        .skip_while(|character| !character.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    (
        digits.parse::<usize>().unwrap_or(usize::MAX),
        name.to_lowercase(),
    )
}

fn latest_pptx(exports: &Path) -> Option<PathBuf> {
    fs::read_dir(exports)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            let path = entry.path();
            if !file_type.is_file()
                || !path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("pptx"))
            {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)))
        .map(|(_, path)| path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn unmanaged_skill_is_never_installable_or_removable() {
        let temp = tempfile::tempdir().expect("tempdir");
        let skill = temp.path().join(SKILL_NAME);
        fs::create_dir_all(&skill).expect("skill dir");
        fs::write(skill.join("SKILL.md"), "---\nname: ppt-master\n---\n").expect("skill");

        let status = status_at(&skill, &temp.path().join("runtime"));
        assert_eq!(status.status, "unmanaged");
        assert!(status.installed);
        assert!(!status.managed);
        assert!(!status.install_supported);
    }

    #[test]
    fn managed_status_requires_the_private_python() {
        let temp = tempfile::tempdir().expect("tempdir");
        let skill = temp.path().join(SKILL_NAME);
        fs::create_dir_all(&skill).expect("skill dir");
        fs::write(skill.join("SKILL.md"), "skill").expect("skill");
        let manifest = ManagedSkillManifest {
            schema_version: 1,
            name: SKILL_NAME.to_string(),
            version: VERSION.to_string(),
            commit: COMMIT.to_string(),
            repository: REPOSITORY.to_string(),
            installed_at: "now".to_string(),
        };
        fs::write(
            skill.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).expect("manifest"),
        )
        .expect("write manifest");

        let status = status_at(&skill, &temp.path().join("runtime"));
        assert_eq!(status.status, "broken");
        assert!(!status.dependencies_ready);
    }

    #[test]
    fn extraction_keeps_only_the_skill_subtree() {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut bytes);
            let options = zip::write::SimpleFileOptions::default();
            writer
                .start_file("repo/skills/ppt-master/SKILL.md", options)
                .expect("skill entry");
            writer.write_all(b"skill").expect("skill bytes");
            writer
                .start_file("repo/README.md", options)
                .expect("repo entry");
            writer.write_all(b"outside").expect("repo bytes");
            writer.finish().expect("finish zip");
        }
        let temp = tempfile::tempdir().expect("tempdir");
        extract_skill_archive(bytes.get_ref(), temp.path()).expect("extract");

        assert_eq!(
            fs::read_to_string(temp.path().join("SKILL.md")).unwrap(),
            "skill"
        );
        assert!(!temp.path().join("README.md").exists());
    }

    #[test]
    fn installer_python_runs_in_utf8_mode() {
        // pip decodes `-r requirements.txt` with the process locale encoding.
        // On a Chinese Windows install that is cp936, which cannot read the
        // pinned UTF-8 requirements file at all.
        let command = python_command("python");
        let utf8_mode = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PYTHONUTF8"))
            .and_then(|(_, value)| value);
        assert_eq!(utf8_mode, Some(std::ffi::OsStr::new("1")));
        assert!(bootstrap_python_command()
            .get_envs()
            .any(|(key, _)| key == std::ffi::OsStr::new("PYTHONUTF8")));
    }

    #[test]
    fn directory_removal_rejects_an_unexpected_target() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("keep");
        fs::create_dir_all(&target).expect("target");
        let error = remove_known_directory(&target, temp.path(), "other").unwrap_err();
        assert_eq!(error.code, PptMasterErrorCode::FilesystemFailed);
        assert_eq!(error.params.get("operation").map(String::as_str), Some("remove"));
        assert!(target.exists());
    }

    /// Every code the backend can emit must have a localized sentence, so the
    /// list is pinned here and mirrored by `pptMasterErrorCodes` in
    /// `desktop/src/extensions/i18n.ts`. Adding a variant without adding copy
    /// fails this test instead of shipping an untranslated fallback.
    #[test]
    fn installer_error_codes_are_exhaustive() {
        use PptMasterErrorCode::*;
        let all = [
            Unmanaged,
            PythonMissing,
            VenvFailed,
            DependenciesFailed,
            AttributionFailed,
            DownloadFailed,
            ChecksumMismatch,
            ArchiveRejected,
            PackageIncomplete,
            FilesystemFailed,
            NotReady,
        ];
        let wire = all
            .iter()
            .map(|code| serde_json::to_value(code).expect("serialize"))
            .map(|value| value.as_str().expect("string").to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            wire,
            [
                "unmanaged",
                "pythonMissing",
                "venvFailed",
                "dependenciesFailed",
                "attributionFailed",
                "downloadFailed",
                "checksumMismatch",
                "archiveRejected",
                "packageIncomplete",
                "filesystemFailed",
                "notReady",
            ]
        );
    }

    /// The whole point of the structured error: an operator reading a
    /// non-English UI learns which step failed and what to do, and the raw
    /// subprocess text is demoted to supporting evidence.
    #[test]
    fn a_missing_interpreter_names_the_step_and_offers_an_action() {
        let error = python_missing_error().detail("program not found");
        assert_eq!(error.code, PptMasterErrorCode::PythonMissing);
        assert!(error.params.contains_key("command"));
        assert!(matches!(
            error.fix,
            Some(PptMasterFix::OpenUrl { ref url }) if url.starts_with("https://")
        ));
        // `detail` never carries meaning on its own.
        assert_eq!(error.detail, "program not found");
    }

    /// A transport failure is worth retrying; a checksum mismatch never is.
    #[test]
    fn only_recoverable_download_failures_offer_a_retry() {
        assert!(matches!(
            download_error("connection reset").fix,
            Some(PptMasterFix::Retry)
        ));
        let mismatch = PptMasterError::new(PptMasterErrorCode::ChecksumMismatch);
        assert!(mismatch.fix.is_none());
    }

    /// The `reason` param is what lets one code carry several distinct
    /// sentences; without it every rejection would read the same.
    #[test]
    fn archive_rejections_distinguish_their_cause() {
        let count = archive_rejected("fileCount").param("limit", "20000");
        assert_eq!(count.code, PptMasterErrorCode::ArchiveRejected);
        assert_eq!(count.params.get("reason").map(String::as_str), Some("fileCount"));
        assert_eq!(
            archive_rejected("symlink").params.get("reason").map(String::as_str),
            Some("symlink")
        );
    }

    /// Builds a status without touching the developer's real Skill directory —
    /// `aris_user_skills_dir()` resolves through `HOME`, which no test may
    /// depend on or write to.
    fn status_fixture(temp: &Path, installed: bool, managed: bool) -> PptMasterStatus {
        let skill = temp.join(SKILL_NAME);
        fs::create_dir_all(&skill).expect("skill dir");
        if installed {
            fs::write(skill.join("SKILL.md"), "skill").expect("skill");
        }
        if managed {
            let manifest = ManagedSkillManifest {
                schema_version: 1,
                name: SKILL_NAME.to_string(),
                version: VERSION.to_string(),
                commit: COMMIT.to_string(),
                repository: REPOSITORY.to_string(),
                installed_at: "now".to_string(),
            };
            fs::write(
                skill.join(MANIFEST_FILE),
                serde_json::to_vec(&manifest).expect("manifest"),
            )
            .expect("write manifest");
        }
        status_at(&skill, &temp.join("runtime"))
    }

    #[test]
    fn a_free_skill_slot_passes_preflight_without_an_action() {
        let temp = tempfile::tempdir().expect("tempdir");
        let check = skill_slot_check(&status_fixture(temp.path(), true, true));
        assert_eq!(check.status, PptMasterCheckStatus::Pass);
        assert!(check.fix.is_none());
    }

    #[test]
    fn a_foreign_skill_fails_preflight_and_points_at_the_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let status = status_fixture(temp.path(), true, false);
        let check = skill_slot_check(&status);
        assert_eq!(check.status, PptMasterCheckStatus::Fail);
        assert!(matches!(
            check.fix,
            Some(PptMasterFix::RevealPath { ref path }) if path == &status.skill_path
        ));
    }

    /// The one invariant that has to hold across every check: a failure the
    /// user cannot act on is a dead end, so the preflight must never produce
    /// one. Reads the real environment by design (that is what a preflight is),
    /// but asserts only on structure, never on this machine's Python.
    #[test]
    fn every_failing_preflight_check_carries_an_action() {
        let checks = preflight_blocking();
        let ids = checks.iter().map(|check| check.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids, ["python", "skillSlot"]);
        for check in &checks {
            if check.status == PptMasterCheckStatus::Fail {
                assert!(check.fix.is_some(), "failing check {} has no fix", check.id);
            }
        }
    }

    #[test]
    fn deck_scan_orders_slides_and_selects_latest_export() {
        let temp = tempfile::tempdir().expect("tempdir");
        let deck = tools::layout::slides_dir_at(temp.path())
            .join(SKILL_NAME)
            .join("research-talk");
        let final_dir = deck.join("svg_final");
        let exports = deck.join("exports");
        fs::create_dir_all(&final_dir).expect("svg final");
        fs::create_dir_all(&exports).expect("exports");
        fs::write(final_dir.join("slide_10.svg"), "<svg/>").expect("slide 10");
        fs::write(final_dir.join("slide_2.svg"), "<svg/>").expect("slide 2");
        fs::write(exports.join("research-talk.pptx"), "pptx").expect("pptx");

        let decks = list_decks_at(temp.path()).expect("decks");
        assert_eq!(decks.len(), 1);
        assert_eq!(decks[0].title, "research-talk");
        assert_eq!(decks[0].slides[0].name, "slide_2.svg");
        assert_eq!(decks[0].slides[1].name, "slide_10.svg");
        assert_eq!(
            decks[0].export_path.as_deref(),
            Some(".somniq/slides/ppt-master/research-talk/exports/research-talk.pptx")
        );
    }
}
