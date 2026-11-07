//! Project-scoped, opt-in capability packages shared by Desktop and CLI.
//!
//! Installation snapshots bytes before activation. Neither installation nor
//! enablement executes package scripts, loads JavaScript, or connects to MCP.
//! MCP execution still goes through the normal runtime permission checks.
//!
//! Trust lives outside the project. The workspace's `.somniq/plugins` only
//! lists packages and asks for them; anything in a workspace can be written by
//! the model's file tools or arrive with a cloned repository. The reviewed
//! snapshots and this computer's approvals live under the SomniQ config
//! directory, and a package runs only when the project asks for it AND the
//! approval recorded here names the digest of the snapshot that would run.
//!
//! Lifecycle ([`lifecycle`]) keeps "installed", "approved and enabled",
//! "running", "failed" and "needs restart" apart: a run freezes the set it
//! starts with, so the page can say which runs still use what. Upgrades
//! ([`upgrade`]) replace an installed version as one transaction.

mod dsh;
mod lifecycle;
mod ui;
mod upgrade;

pub use lifecycle::*;
pub use ui::*;
pub use upgrade::*;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{ConfigSource, McpServerConfig, McpStdioServerConfig, ScopedMcpServerConfig};

const MAX_FILES: usize = 2048;
const MAX_BYTES: usize = 32 * 1024 * 1024;
struct PackageFile {
    bytes: Vec<u8>,
    executable: bool,
}
type PackageFiles = BTreeMap<PathBuf, PackageFile>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub severity: String,
}

impl Diagnostic {
    fn error(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            severity: "error".into(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCapabilities {
    pub skills: Vec<String>,
    pub skill_roots: Vec<PathBuf>,
    pub mcp_servers: Vec<PluginMcp>,
    #[serde(default)]
    pub ui_panels: Vec<UiPanel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcp {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub request_timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPreview {
    pub name: String,
    pub version: String,
    pub description: String,
    pub source: String,
    pub digest: String,
    pub capabilities: PluginCapabilities,
    pub diagnostics: Vec<Diagnostic>,
    pub can_enable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    #[serde(flatten)]
    pub package: PluginPreview,
    /// The project asks for it AND this computer approved this digest, so the
    /// next run gets it. Configuration only; `lifecycle` says what runs.
    pub enabled: bool,
    /// `enabled`, `disabled` or `blocked`: configuration and integrity only.
    pub status: String,
    /// What is actually happening: in-flight runs, MCP health, restarts.
    pub lifecycle: PluginLifecycle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    name: String,
    version: String,
    description: String,
    source: String,
    digest: String,
    enabled: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    schema: u32,
    packages: BTreeMap<String, Record>,
}

/// This computer's approvals: project key -> package name -> approved digest.
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Approvals {
    schema: u32,
    projects: BTreeMap<String, BTreeMap<String, String>>,
}

/// Execution-scoped project whose plugins apply to a run.
///
/// A work task runs in its own worktree, which has no `.somniq/plugins` of its
/// own (or a copy the task itself may have edited). The task still belongs to
/// its registered project, so Desktop names that project here and every
/// consumer resolves plugins through [`PluginStore::for_execution`].
pub const ARIS_PLUGIN_PROJECT_ROOT_ENV: &str = "ARIS_PLUGIN_PROJECT_ROOT";

pub struct PluginStore {
    /// `<project>/.somniq/plugins`: the install list and requested state.
    root: PathBuf,
    /// The project directory; approvals are keyed by its canonical path.
    workspace: PathBuf,
    /// `<SomniQ config>/plugins`: reviewed snapshots and approvals.
    user_root: PathBuf,
    /// The set the current run froze when it started ([`PluginRun`]). When
    /// present, what runs comes from here, not from the live registry, so
    /// enabling or disabling a package mid-run cannot change an in-flight run.
    frozen: Option<Arc<PluginSet>>,
}

pub(super) fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

fn valid_package_name(name: &str) -> bool {
    let segment = |s: &str| {
        !s.is_empty()
            && !matches!(s, "." | "..")
            && s.bytes().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_' | b'.')
            })
    };
    if let Some(scoped) = name.strip_prefix('@') {
        scoped
            .split_once('/')
            .is_some_and(|(scope, package)| segment(scope) && segment(package))
    } else {
        segment(name)
    }
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn package_files(source: &Path) -> Result<PackageFiles, String> {
    let metadata = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Select a regular local package directory".into());
    }
    let mut files = BTreeMap::new();
    let mut total = 0;
    for entry in walkdir::WalkDir::new(source)
        .follow_links(false)
        .max_depth(32)
        .sort_by_file_name()
    {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_symlink() {
            return Err(format!(
                "Package symlinks are not supported: {}",
                entry.path().display()
            ));
        }
        if entry.file_type().is_dir() {
            if entry.depth() >= 32 {
                return Err("Package directory depth exceeds 32".into());
            }
            continue;
        }
        if !entry.file_type().is_file() {
            return Err("Package contains a non-regular file".into());
        }
        if files.len() >= MAX_FILES {
            return Err(format!("Package exceeds {MAX_FILES} files"));
        }
        let size = entry.metadata().map_err(|e| e.to_string())?.len();
        if size > (MAX_BYTES - total) as u64 {
            return Err("Package exceeds 32 MiB".into());
        }
        let mut bytes = vec![];
        fs::File::open(entry.path())
            .map_err(|e| e.to_string())?
            .take((MAX_BYTES - total) as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        total += bytes.len();
        if total > MAX_BYTES {
            return Err("Package exceeds 32 MiB".into());
        }
        let path = entry
            .path()
            .strip_prefix(source)
            .map_err(|e| e.to_string())?
            .to_path_buf();
        if path.to_str().is_none() {
            return Err("Package paths must be UTF-8".into());
        }
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            entry
                .metadata()
                .map_err(|e| e.to_string())?
                .permissions()
                .mode()
                & 0o111
                != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        files.insert(path, PackageFile { bytes, executable });
    }
    Ok(files)
}

fn digest_files(files: &PackageFiles) -> String {
    let mut hash = Sha256::new();
    for (path, file) in files {
        let bytes = &file.bytes;
        let name = path.to_string_lossy().replace('\\', "/");
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
        hash.update([u8::from(file.executable)]);
    }
    format!("{:x}", hash.finalize())
}

impl PluginStore {
    #[must_use]
    pub fn for_workspace(workspace: impl AsRef<Path>) -> Self {
        Self::with_user_root(
            workspace,
            crate::somniq_config_dir_from_env().join("plugins"),
        )
    }

    /// The store for `workspace` with snapshots and approvals under
    /// `user_root`. [`Self::for_workspace`] uses the SomniQ config directory;
    /// tests pass a temporary one so they never write the user's approvals.
    #[must_use]
    pub fn with_user_root(workspace: impl AsRef<Path>, user_root: impl Into<PathBuf>) -> Self {
        let workspace = workspace.as_ref().to_path_buf();
        Self {
            root: crate::somniq_project_dir(&workspace).join("plugins"),
            workspace,
            user_root: user_root.into(),
            frozen: None,
        }
    }

    /// The store whose plugins apply to the current execution: the project
    /// named by [`ARIS_PLUGIN_PROJECT_ROOT_ENV`] when the run has one (a work
    /// task in a worktree), otherwise `cwd`.
    ///
    /// Inside a run bound by [`PluginRun`] the packages that run are the ones
    /// it froze. A run token this process did not issue, or one whose run has
    /// ended, resolves to no plugins at all.
    #[must_use]
    pub fn for_execution(cwd: impl AsRef<Path>) -> Self {
        let project = crate::execution_env_var_os(ARIS_PLUGIN_PROJECT_ROOT_ENV)
            .filter(|value| !value.is_empty())
            .map_or_else(|| cwd.as_ref().to_path_buf(), PathBuf::from);
        let mut store = Self::for_workspace(project);
        if let Some(token) =
            crate::execution_env_var_os(ARIS_PLUGIN_RUN_ENV).filter(|value| !value.is_empty())
        {
            let key = store.project_key();
            store.frozen = Some(lifecycle::resolve_run(&token.to_string_lossy(), &key));
        }
        store
    }

    fn registry_path(&self) -> PathBuf {
        self.root.join("registry.json")
    }
    fn snapshot_path(&self, digest: &str) -> PathBuf {
        self.user_root.join("packages").join(digest)
    }
    fn approvals_path(&self) -> PathBuf {
        self.user_root.join("approvals.json")
    }

    /// Approvals are per project. A canonical path keys them so the Extensions
    /// page, Chat and a work task bound to the same project agree.
    fn project_key(&self) -> String {
        crate::canonicalize(&self.workspace)
            .unwrap_or_else(|_| self.workspace.clone())
            .to_string_lossy()
            .into_owned()
    }

    fn reject_symlinks(paths: impl IntoIterator<Item = PathBuf>) -> Result<(), String> {
        for path in paths {
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err("Plugin state directories and registry must not be symlinks".into())
                }
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(())
    }

    fn approvals(&self) -> Result<Approvals, String> {
        Self::reject_symlinks([
            self.user_root.clone(),
            self.user_root.join("approvals.lock"),
            self.approvals_path(),
        ])?;
        let approvals: Approvals = match fs::read(self.approvals_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
                format!(
                    "Plugin approvals file {} is unreadable: {e}",
                    self.approvals_path().display()
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Approvals {
                schema: 1,
                projects: BTreeMap::new(),
            },
            Err(error) => return Err(error.to_string()),
        };
        if approvals.schema != 1
            || approvals
                .projects
                .values()
                .flat_map(BTreeMap::values)
                .any(|digest| !valid_digest(digest))
        {
            return Err("Invalid or unsupported plugin approvals file".into());
        }
        Ok(approvals)
    }

    /// The digest this computer approved for `name` in this project, if any.
    fn approved_digest(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self
            .approvals()?
            .projects
            .get(&self.project_key())
            .and_then(|packages| packages.get(name))
            .cloned())
    }

    /// Record (`Some`) or withdraw (`None`) this computer's approval.
    ///
    /// The approvals file is shared by every project, so the read/modify/write
    /// holds a cross-process lock beside it. Called inside [`Self::mutate`],
    /// which already holds the in-process locks of both files; the OS lock
    /// order (registry, then approvals) is fixed.
    fn set_approval(&self, name: &str, digest: Option<&str>) -> Result<(), String> {
        let path = self.approvals_path();
        {
            self.approvals()?;
            fs::create_dir_all(&self.user_root).map_err(|e| e.to_string())?;
            let lock = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(self.user_root.join("approvals.lock"))
                .map_err(|e| e.to_string())?;
            lock.lock().map_err(|e| e.to_string())?;
            let mut approvals = self.approvals()?;
            let key = self.project_key();
            match digest {
                Some(digest) => {
                    approvals
                        .projects
                        .entry(key)
                        .or_default()
                        .insert(name.to_string(), digest.to_string());
                }
                None => {
                    if let Some(packages) = approvals.projects.get_mut(&key) {
                        packages.remove(name);
                        if packages.is_empty() {
                            approvals.projects.remove(&key);
                        }
                    }
                }
            }
            let bytes = serde_json::to_vec_pretty(&approvals).map_err(|e| e.to_string())?;
            crate::atomic_file::write_replace_unlocked(&path, &bytes).map_err(|e| e.to_string())
        }
    }

    fn registry(&self) -> Result<Registry, String> {
        Self::reject_symlinks([
            self.root.parent().unwrap().to_path_buf(),
            self.root.clone(),
            self.root.join("registry.lock"),
            self.registry_path(),
            self.user_root.clone(),
            self.user_root.join("packages"),
            self.user_root.join("quarantine"),
        ])?;
        let registry: Registry = match fs::read(self.registry_path()) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|e| format!("Plugin registry: {e}"))?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Registry {
                schema: 1,
                packages: BTreeMap::new(),
            },
            Err(error) => return Err(error.to_string()),
        };
        if registry.schema != 1
            || registry.packages.iter().any(|(name, record)| {
                name != &record.name || !valid_package_name(name) || !valid_digest(&record.digest)
            })
        {
            return Err("Invalid or unsupported plugin registry".into());
        }
        Ok(registry)
    }

    fn save(&self, registry: &Registry) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(registry).map_err(|e| e.to_string())?;
        // The caller holds the registry path lock for the whole read/modify/write.
        crate::atomic_file::write_replace_unlocked(&self.registry_path(), &bytes)
            .map_err(|e| e.to_string())
    }

    /// Run `action` holding this project's registry locks.
    ///
    /// The in-process locks of the registry AND the approvals file are taken
    /// together, up front: they are striped by path hash, so taking the second
    /// inside the first deadlocks whenever both paths land on one stripe.
    /// [`Self::freeze`] takes the registry stripe too, so a run never starts
    /// from a half-applied mutation.
    fn mutate<T>(&self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let paths = [self.registry_path(), self.approvals_path()];
        crate::atomic_file::with_paths_locked(&paths, || {
            // Validate state paths before creating or opening anything there.
            self.registry()?;
            fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
            let lock = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(self.root.join("registry.lock"))
                .map_err(|e| e.to_string())?;
            // Desktop and CLI may mutate the same project from different
            // processes. The OS releases this advisory lock on close/crash.
            lock.try_lock()
                .map_err(|e| format!("Plugin registry is busy; retry the operation: {e}"))?;
            action()
        })
    }

    fn inspect(&self, files: &PackageFiles, source: &str) -> Result<PluginPreview, String> {
        let manifest: serde_json::Value = serde_json::from_slice(
            files
                .get(Path::new("package.json"))
                .ok_or("Missing package.json")?
                .bytes
                .as_slice(),
        )
        .map_err(|e| e.to_string())?;
        let name = manifest["name"]
            .as_str()
            .filter(|v| valid_package_name(v))
            .ok_or("Package requires a valid npm name")?;
        let version = manifest["version"]
            .as_str()
            .ok_or("Package requires a version")?;
        semver::Version::parse(version).map_err(|e| format!("Package version: {e}"))?;
        let digest = digest_files(files);
        let snapshot = self.snapshot_path(&digest);
        let mut diagnostics = vec![];
        let mut capabilities = if manifest.get("dsh").is_some() {
            dsh::capabilities(files, &manifest, &snapshot, &mut diagnostics)
        } else {
            PluginCapabilities::default()
        };
        ui::inspect_ui(files, &manifest, &mut capabilities, &mut diagnostics);
        let mut skills = BTreeSet::new();
        let mut servers = BTreeSet::new();
        if capabilities
            .skills
            .iter()
            .any(|name| !skills.insert(name.to_ascii_lowercase()))
            || capabilities
                .mcp_servers
                .iter()
                .any(|server| !servers.insert(server.name.clone()))
        {
            diagnostics.push(Diagnostic::error(
                "duplicate-capability",
                "A package must not contribute duplicate skill or MCP names",
            ));
        }
        if capabilities.skills.is_empty()
            && capabilities.mcp_servers.is_empty()
            && capabilities.ui_panels.is_empty()
        {
            diagnostics.push(Diagnostic::error(
                "empty",
                "Package contains no supported Skills, MCP servers or UI panels",
            ));
        }
        if capabilities.skills.iter().any(|name| {
            crate::activated_canonical_skill_name(name)
                .is_some_and(|canonical| !canonical.eq_ignore_ascii_case(name))
        }) {
            diagnostics.push(Diagnostic::error(
                "skill-alias",
                "A skill name is reserved by the activated SomniQ skill alias registry",
            ));
        }
        // A plugin adds skills; it never replaces one SomniQ ships, the review
        // and audit workflows included. Checked on every inspection, so an app
        // update that adds a built-in of the same name blocks the package
        // rather than letting it shadow the new built-in.
        let builtin: Vec<&str> = capabilities
            .skills
            .iter()
            .filter(|name| {
                crate::BUNDLED_SKILLS
                    .iter()
                    .any(|(bundled, _)| bundled.eq_ignore_ascii_case(name))
            })
            .map(String::as_str)
            .collect();
        if !builtin.is_empty() {
            diagnostics.push(Diagnostic::error(
                "skill-builtin",
                format!(
                    "Built-in SomniQ skills cannot be replaced by a plugin: {}",
                    builtin.join(", ")
                ),
            ));
        }
        Ok(PluginPreview {
            name: name.into(),
            version: version.into(),
            description: manifest["description"].as_str().unwrap_or_default().into(),
            source: source.into(),
            digest,
            capabilities,
            can_enable: !diagnostics.iter().any(|d| d.severity == "error"),
            diagnostics,
        })
    }

    pub fn preview(&self, source: impl AsRef<Path>) -> Result<PluginPreview, String> {
        let source = source.as_ref();
        let files = package_files(source)?;
        let absolute = crate::canonicalize(source).map_err(|e| e.to_string())?;
        self.inspect(&files, &absolute.to_string_lossy())
    }

    /// Install exactly the bytes reviewed in preview. New packages start disabled.
    pub fn install(
        &self,
        source: impl AsRef<Path>,
        expected_digest: &str,
    ) -> Result<InstalledPlugin, String> {
        let files = package_files(source.as_ref())?;
        let source = crate::canonicalize(source).map_err(|e| e.to_string())?;
        let preview = self.inspect(&files, &source.to_string_lossy())?;
        if preview.digest != expected_digest {
            return Err(
                "Package changed after preview; preview it again before installation".into(),
            );
        }
        self.mutate(|| {
            let mut registry = self.registry()?;
            if registry.packages.contains_key(&preview.name) {
                return Err(
                    "Package already installed; preview it again to upgrade the installed version"
                        .into(),
                );
            }
            self.publish_snapshot(&files, &preview.digest)?;
            let record = Record {
                name: preview.name.clone(),
                version: preview.version.clone(),
                description: preview.description.clone(),
                source: preview.source.clone(),
                digest: preview.digest.clone(),
                enabled: false,
            };
            registry
                .packages
                .insert(record.name.clone(), record.clone());
            self.save(&registry)?;
            Ok(self.view(&record))
        })
    }

    /// Make `packages/<digest>` hold exactly `files`.
    ///
    /// Snapshots are content-addressed and never modified in place, so this
    /// leaves every other version, and every run using one, untouched. An
    /// existing snapshot that no longer matches its digest is moved to
    /// quarantine for inspection, never recursively deleted.
    fn publish_snapshot(&self, files: &PackageFiles, digest: &str) -> Result<(), String> {
        let target = self.snapshot_path(digest);
        let target_exists = fs::symlink_metadata(&target).is_ok();
        let intact = target_exists
            && package_files(&target).is_ok_and(|files| digest_files(&files) == digest);
        if intact {
            return Ok(());
        }
        if target_exists {
            let quarantine = self.user_root.join("quarantine");
            fs::create_dir_all(&quarantine).map_err(|e| e.to_string())?;
            let archive = tempfile::Builder::new()
                .prefix("modified-")
                .tempdir_in(quarantine)
                .map_err(|e| e.to_string())?
                .keep();
            fs::rename(&target, archive.join("package")).map_err(|e| e.to_string())?;
        }
        // Another project may publish the same digest concurrently.
        let packages = self.user_root.join("packages");
        fs::create_dir_all(&packages).map_err(|e| e.to_string())?;
        let staging = tempfile::tempdir_in(&packages).map_err(|e| e.to_string())?;
        for (path, file) in files {
            let destination = staging.path().join(path);
            fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::write(&destination, &file.bytes).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    &destination,
                    fs::Permissions::from_mode(if file.executable { 0o755 } else { 0o644 }),
                )
                .map_err(|e| e.to_string())?;
            }
        }
        if let Err(error) = fs::rename(staging.path(), &target) {
            let published =
                package_files(&target).is_ok_and(|files| digest_files(&files) == digest);
            if !published {
                return Err(error.to_string());
            }
        }
        Ok(())
    }

    fn installed(package: PluginPreview, enabled: bool) -> InstalledPlugin {
        let status = if !package.can_enable {
            "blocked"
        } else if enabled {
            "enabled"
        } else {
            "disabled"
        };
        InstalledPlugin {
            package,
            enabled,
            status: status.into(),
            lifecycle: PluginLifecycle::default(),
        }
    }

    /// The package as it would run here. `enabled` is the project's request
    /// AND this computer's approval of exactly this digest; a request alone —
    /// workspace content the model or a cloned repository can write — never
    /// starts anything.
    fn inspect_record(&self, record: &Record) -> InstalledPlugin {
        let mut package = self.inspect_snapshot(record);
        let approval = self.approved_digest(&record.name);
        let approved = matches!(&approval, Ok(Some(digest)) if digest == &record.digest);
        match approval {
            Err(error) => {
                package.can_enable = false;
                package.diagnostics.push(Diagnostic::error("approvals", error));
            }
            Ok(_) if record.enabled && !approved => package.diagnostics.push(Diagnostic {
                code: "approval-required".into(),
                message: "This project asks to run this package, but this computer has not approved this version. Turn it on to review and approve it.".into(),
                severity: "warning".into(),
            }),
            Ok(_) => (),
        }
        Self::installed(package, record.enabled && approved)
    }

    fn inspect_snapshot(&self, record: &Record) -> PluginPreview {
        let snapshot = self.snapshot_path(&record.digest);
        if fs::symlink_metadata(&snapshot).is_err() {
            return Self::unavailable(
                record,
                "The reviewed snapshot of this package is not on this computer; remove it and install it again",
            );
        }
        let inspection = package_files(&snapshot).and_then(|files| {
            if digest_files(&files) != record.digest {
                return Err(
                    "Installed package snapshot was modified; disable and reinstall it".into(),
                );
            }
            let preview = self.inspect(&files, &record.source)?;
            if preview.name != record.name || preview.version != record.version {
                return Err("Registry identity does not match the installed snapshot".into());
            }
            Ok(preview)
        });
        inspection.unwrap_or_else(|error| Self::unavailable(record, error))
    }

    fn unavailable(record: &Record, error: impl Into<String>) -> PluginPreview {
        PluginPreview {
            name: record.name.clone(),
            version: record.version.clone(),
            description: record.description.clone(),
            source: record.source.clone(),
            digest: record.digest.clone(),
            capabilities: PluginCapabilities::default(),
            diagnostics: vec![Diagnostic::error("integrity", error)],
            can_enable: false,
        }
    }

    /// Every installed package with its configuration AND lifecycle state.
    pub fn list(&self) -> Result<Vec<InstalledPlugin>, String> {
        let runs = lifecycle::project_runs(&self.project_key());
        Ok(self
            .registry()?
            .packages
            .values()
            .map(|record| self.assessed(record, &runs))
            .collect())
    }

    /// One package as the plugin page shows it.
    fn view(&self, record: &Record) -> InstalledPlugin {
        self.assessed(record, &lifecycle::project_runs(&self.project_key()))
    }

    fn assessed(&self, record: &Record, runs: &[Arc<PluginSet>]) -> InstalledPlugin {
        let mut view = self.inspect_record(record);
        view.lifecycle = lifecycle::assess(&view, runs);
        view
    }

    /// The enabled package (other than `name`) whose skills collide with
    /// `capabilities`, if any.
    fn skill_conflict(
        &self,
        registry: &Registry,
        name: &str,
        capabilities: &PluginCapabilities,
    ) -> Option<String> {
        let names: BTreeSet<_> = capabilities
            .skills
            .iter()
            .map(|v| v.to_ascii_lowercase())
            .collect();
        registry
            .packages
            .values()
            .filter(|r| r.name != name)
            .map(|other| self.inspect_record(other))
            .find(|other| {
                other.enabled
                    && other.package.can_enable
                    && other
                        .package
                        .capabilities
                        .skills
                        .iter()
                        .any(|v| names.contains(&v.to_ascii_lowercase()))
            })
            .map(|other| other.package.name)
    }

    pub fn set_enabled(&self, name: &str, enabled: bool) -> Result<InstalledPlugin, String> {
        self.mutate(|| {
            let mut registry = self.registry()?;
            let record = registry
                .packages
                .get(name)
                .ok_or("Plugin is not installed")?;
            let view = self.inspect_record(record);
            let digest = record.digest.clone();
            if enabled {
                if !view.package.can_enable {
                    return Err(
                        "Resolve the plugin compatibility or integrity diagnostics before enabling"
                            .into(),
                    );
                }
                if let Some(other) =
                    self.skill_conflict(&registry, name, &view.package.capabilities)
                {
                    return Err(format!("Skill name conflicts with enabled plugin {other}"));
                }
            }
            // The approval is what lets a package run, so it is written first
            // when enabling and withdrawn first when disabling: a failure in
            // between leaves the package stopped, never running unrequested.
            self.set_approval(name, enabled.then_some(digest.as_str()))?;
            registry.packages.get_mut(name).unwrap().enabled = enabled;
            self.save(&registry)?;
            Ok(self.view(&registry.packages[name]))
        })
    }

    /// Detach the package. Snapshots remain cached so existing runs keep valid paths.
    pub fn remove(&self, name: &str) -> Result<(), String> {
        self.mutate(|| {
            let mut registry = self.registry()?;
            if !registry.packages.contains_key(name) {
                return Err("Plugin is not installed".into());
            }
            // A later install of the same name starts unapproved.
            self.set_approval(name, None)?;
            registry.packages.remove(name);
            self.save(&registry)
        })
    }

    /// The packages that run here: the frozen set inside a [`PluginRun`],
    /// otherwise what the registry and this computer's approvals allow now.
    /// Snapshot integrity is checked either way.
    fn running(&self) -> Result<Vec<InstalledPlugin>, String> {
        match &self.frozen {
            Some(set) => Ok(set
                .plugins
                .iter()
                .map(|plugin| self.inspect_frozen(plugin))
                .filter(|p| p.package.can_enable)
                .collect()),
            None => Ok(self
                .registry()?
                .packages
                .values()
                .map(|record| self.inspect_record(record))
                .filter(|p| p.enabled && p.package.can_enable)
                .collect()),
        }
    }

    fn inspect_frozen(&self, plugin: &FrozenPlugin) -> InstalledPlugin {
        let record = Record {
            name: plugin.name.clone(),
            version: plugin.version.clone(),
            description: String::new(),
            source: String::new(),
            digest: plugin.digest.clone(),
            enabled: true,
        };
        Self::installed(self.inspect_snapshot(&record), true)
    }

    /// Snapshot directories of the packages that would run here, for callers
    /// that must let the model read a plugin skill's own files.
    pub fn active_snapshot_dirs(&self) -> Result<Vec<PathBuf>, String> {
        Ok(self
            .running()?
            .into_iter()
            .map(|p| self.snapshot_path(&p.package.digest))
            .collect())
    }

    pub fn active_skill_roots(&self) -> Result<Vec<PathBuf>, String> {
        Ok(self
            .running()?
            .into_iter()
            .flat_map(|p| {
                let root = self.snapshot_path(&p.package.digest);
                p.package
                    .capabilities
                    .skill_roots
                    .into_iter()
                    .map(move |path| root.join(path))
            })
            .collect())
    }

    pub fn active_mcp_servers(&self) -> Result<BTreeMap<String, ScopedMcpServerConfig>, String> {
        Ok(self
            .running()?
            .iter()
            .flat_map(|plugin| mcp_entries(&plugin.package))
            .map(|entry| (entry.runtime_name, entry.config))
            .collect())
    }

    /// The MCP servers `name` would start here, keyed by runtime name; empty
    /// unless the package is approved, enabled and intact.
    pub fn package_mcp_servers(
        &self,
        name: &str,
    ) -> Result<BTreeMap<String, ScopedMcpServerConfig>, String> {
        Ok(self
            .running()?
            .iter()
            .filter(|plugin| plugin.package.name == name)
            .flat_map(|plugin| mcp_entries(&plugin.package))
            .map(|entry| (entry.runtime_name, entry.config))
            .collect())
    }
}

/// One MCP server a package declares, as the runtime names and starts it.
struct McpEntry {
    declared: String,
    runtime_name: String,
    config: ScopedMcpServerConfig,
}

/// Each package gets a stable MCP name prefix, so its servers never collide
/// with another package's or a manually configured one.
fn mcp_entries(package: &PluginPreview) -> Vec<McpEntry> {
    let hash = format!("{:x}", Sha256::digest(package.name.as_bytes()));
    package
        .capabilities
        .mcp_servers
        .iter()
        .map(|server| McpEntry {
            declared: server.name.clone(),
            runtime_name: format!("p{}_{}", &hash[..8], server.name),
            config: ScopedMcpServerConfig {
                scope: ConfigSource::Project,
                config: McpServerConfig::Stdio(McpStdioServerConfig {
                    command: server.command.clone(),
                    args: server.args.clone(),
                    env: server.env.clone(),
                    request_timeout_secs: server.request_timeout_secs,
                }),
            },
        })
        .collect()
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
