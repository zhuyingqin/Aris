//! Project-local, opt-in capability packages shared by Desktop and CLI.
//!
//! Installation snapshots bytes before activation. Neither installation nor
//! enablement executes package scripts, loads JavaScript, or connects to MCP.
//! MCP execution still goes through the normal runtime permission checks.

mod dsh;
mod ui;

pub use ui::*;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

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
    /// Requested enablement; `status` also accounts for current integrity.
    pub enabled: bool,
    /// enabled means configured for the next run, never a process health check.
    pub status: String,
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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    schema: u32,
    packages: BTreeMap<String, Record>,
}

pub struct PluginStore {
    root: PathBuf,
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
        Self {
            root: crate::somniq_project_dir(workspace).join("plugins"),
        }
    }

    fn registry_path(&self) -> PathBuf {
        self.root.join("registry.json")
    }
    fn snapshot_path(&self, digest: &str) -> PathBuf {
        self.root.join("packages").join(digest)
    }

    fn registry(&self) -> Result<Registry, String> {
        for path in [
            self.root.parent().unwrap().to_path_buf(),
            self.root.clone(),
            self.root.join("packages"),
            self.root.join("quarantine"),
            self.root.join("registry.lock"),
            self.registry_path(),
        ] {
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err("Plugin state directories and registry must not be symlinks".into())
                }
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.to_string()),
            }
        }
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

    fn mutate<T>(&self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        crate::with_path_lock(&self.registry_path(), || {
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
                    "Package already installed; remove it before installing a different version"
                        .into(),
                );
            }
            let target = self.snapshot_path(&preview.digest);
            let target_exists = fs::symlink_metadata(&target).is_ok();
            let intact = target_exists
                && package_files(&target).is_ok_and(|files| digest_files(&files) == preview.digest);
            if target_exists && !intact {
                // Keep the modified bytes for inspection, then restore the
                // reviewed snapshot. Never recursively delete package trees.
                let quarantine = self.root.join("quarantine");
                fs::create_dir_all(&quarantine).map_err(|e| e.to_string())?;
                let archive = tempfile::Builder::new()
                    .prefix("modified-")
                    .tempdir_in(quarantine)
                    .map_err(|e| e.to_string())?
                    .keep();
                fs::rename(&target, archive.join("package")).map_err(|e| e.to_string())?;
            }
            if !intact {
                fs::create_dir_all(self.root.join("packages")).map_err(|e| e.to_string())?;
                let staging =
                    tempfile::tempdir_in(self.root.join("packages")).map_err(|e| e.to_string())?;
                for (path, file) in &files {
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
                fs::rename(staging.path(), &target).map_err(|e| e.to_string())?;
            }
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
            Ok(Self::installed(preview, record.enabled))
        })
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
        }
    }

    fn inspect_record(&self, record: &Record) -> InstalledPlugin {
        let inspection = package_files(&self.snapshot_path(&record.digest)).and_then(|files| {
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
        let package = inspection.unwrap_or_else(|error| PluginPreview {
            name: record.name.clone(),
            version: record.version.clone(),
            description: record.description.clone(),
            source: record.source.clone(),
            digest: record.digest.clone(),
            capabilities: PluginCapabilities::default(),
            diagnostics: vec![Diagnostic::error("integrity", error)],
            can_enable: false,
        });
        Self::installed(package, record.enabled)
    }

    pub fn list(&self) -> Result<Vec<InstalledPlugin>, String> {
        Ok(self
            .registry()?
            .packages
            .values()
            .map(|record| self.inspect_record(record))
            .collect())
    }

    pub fn set_enabled(&self, name: &str, enabled: bool) -> Result<InstalledPlugin, String> {
        self.mutate(|| {
            let mut registry = self.registry()?;
            let record = registry
                .packages
                .get(name)
                .ok_or("Plugin is not installed")?;
            let mut view = self.inspect_record(record);
            if enabled {
                if !view.package.can_enable {
                    return Err(
                        "Resolve the plugin compatibility or integrity diagnostics before enabling"
                            .into(),
                    );
                }
                let names: BTreeSet<_> = view
                    .package
                    .capabilities
                    .skills
                    .iter()
                    .map(|v| v.to_ascii_lowercase())
                    .collect();
                for other in registry
                    .packages
                    .values()
                    .filter(|r| r.enabled && r.name != name)
                {
                    let other = self.inspect_record(other);
                    if other.package.can_enable
                        && other
                            .package
                            .capabilities
                            .skills
                            .iter()
                            .any(|v| names.contains(&v.to_ascii_lowercase()))
                    {
                        return Err(format!(
                            "Skill name conflicts with enabled plugin {}",
                            other.package.name
                        ));
                    }
                }
            }
            registry.packages.get_mut(name).unwrap().enabled = enabled;
            self.save(&registry)?;
            view.enabled = enabled;
            view.status = if !view.package.can_enable {
                "blocked"
            } else if enabled {
                "enabled"
            } else {
                "disabled"
            }
            .into();
            Ok(view)
        })
    }

    /// Detach the package. Snapshots remain cached so existing runs keep valid paths.
    pub fn remove(&self, name: &str) -> Result<(), String> {
        self.mutate(|| {
            let mut registry = self.registry()?;
            if registry.packages.remove(name).is_none() {
                return Err("Plugin is not installed".into());
            }
            self.save(&registry)
        })
    }

    pub fn active_skill_roots(&self) -> Result<Vec<PathBuf>, String> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|p| p.enabled && p.package.can_enable)
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
        let mut servers = BTreeMap::new();
        for plugin in self
            .list()?
            .into_iter()
            .filter(|p| p.enabled && p.package.can_enable)
        {
            let hash = format!("{:x}", Sha256::digest(plugin.package.name.as_bytes()));
            for server in plugin.package.capabilities.mcp_servers {
                let name = format!("p{}_{}", &hash[..8], server.name);
                servers.insert(
                    name,
                    ScopedMcpServerConfig {
                        scope: ConfigSource::Project,
                        config: McpServerConfig::Stdio(McpStdioServerConfig {
                            command: server.command,
                            args: server.args,
                            env: server.env,
                            request_timeout_secs: server.request_timeout_secs,
                        }),
                    },
                );
            }
        }
        Ok(servers)
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
