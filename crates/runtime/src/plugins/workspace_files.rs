//! Project files a plugin's server declared (`workspaceFiles`), handed over
//! as the copies the user approved.
//!
//! At approval the host copies each file's current bytes into a store keyed
//! by content (`<plugins>/files/<sha256>`) and lays out a read-only view of
//! them at their project-relative paths (`<plugins>/file-views/<set digest>/`).
//! The plugin reads that view (`SOMNIQ_PLUGIN_FILES`), so what runs is what was
//! approved, whatever happens to the originals afterwards. When an original
//! changes, the plugin keeps the approved copy; the Plugins page shows the
//! new version with its diff, and a new approval switches to it.
//!
//! The approved sets live beside `approvals.json`, in `approved-files.json`,
//! per project and package, bound to the package digest they were approved
//! with. Both files are in the plugin trust store.
//!
//! Copies and views nothing refers to any more are deleted by
//! [`super::collect`]: a copy is kept while any project's approved set names
//! it or a run in this process froze it.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{PackageFile, PackageFileChange, PluginStore};

#[derive(Debug, Default, Serialize, Deserialize)]
struct ApprovedFiles {
    schema: u32,
    projects: BTreeMap<String, BTreeMap<String, ApprovedFileSet>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ApprovedFileSet {
    /// The package digest these copies were approved with.
    pub digest: String,
    /// Project-relative path to the sha256 of the approved bytes.
    pub files: BTreeMap<String, String>,
}

/// One declared workspace file: the approved copy and the original now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileState {
    pub path: String,
    /// sha256 of the approved copy, when this version has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved: Option<String>,
    /// sha256 of the original in the project now; absent when it is gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
}

/// One digest for a set of files: what a view shows and a click approves.
#[must_use]
pub fn files_digest(files: &BTreeMap<String, String>) -> String {
    let mut hash = Sha256::new();
    for (path, sha) in files {
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update(sha.as_bytes());
        hash.update([b'\n']);
    }
    format!("{:x}", hash.finalize())
}

/// Shown when a click approves other file contents than its view showed.
pub const WORKSPACE_FILES_CHANGED_SINCE_SHOWN: &str =
    "The project files this plugin is handed changed after they were shown; look at them again before approving";

impl PluginStore {
    fn approved_files_path(&self) -> PathBuf {
        self.user_root.join("approved-files.json")
    }

    fn read_approved_files(&self) -> Result<ApprovedFiles, String> {
        Self::read_approved_files_at(&self.user_root)
    }

    fn read_approved_files_at(user_root: &Path) -> Result<ApprovedFiles, String> {
        let path = user_root.join("approved-files.json");
        Self::reject_symlinks([user_root.to_path_buf(), path.clone()])?;
        match fs::read(&path) {
            Ok(bytes) => {
                let parsed: ApprovedFiles = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("Plugin approved-files record is unreadable: {e}"))?;
                if parsed.schema != 1 {
                    return Err("Unsupported plugin approved-files record".into());
                }
                Ok(parsed)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ApprovedFiles { schema: 1, projects: BTreeMap::new() }),
            Err(error) => Err(error.to_string()),
        }
    }

    /// The lock over the approved sets and the copies they name, across
    /// processes; released when the returned file closes.
    fn lock_approved_files_at(user_root: &Path) -> Result<fs::File, String> {
        fs::create_dir_all(user_root).map_err(|e| e.to_string())?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(user_root.join("approved-files.lock"))
            .map_err(|e| e.to_string())?;
        lock.lock().map_err(|e| e.to_string())?;
        Ok(lock)
    }

    fn write_approved_files(&self, change: impl FnOnce(&mut BTreeMap<String, ApprovedFileSet>)) -> Result<(), String> {
        let _lock = Self::lock_approved_files_at(&self.user_root)?;
        self.write_approved_files_locked(change)
    }

    /// [`Self::write_approved_files`] for a caller already holding the lock.
    fn write_approved_files_locked(&self, change: impl FnOnce(&mut BTreeMap<String, ApprovedFileSet>)) -> Result<(), String> {
        let mut record = self.read_approved_files()?;
        let key = self.project_key();
        let packages = record.projects.entry(key.clone()).or_default();
        change(packages);
        if packages.is_empty() {
            record.projects.remove(&key);
        }
        let bytes = serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?;
        crate::atomic_file::write_replace_unlocked(&self.approved_files_path(), &bytes).map_err(|e| e.to_string())
    }

    /// The approved copies of `name`'s workspace files, when they were
    /// approved with package digest `digest` in this project.
    pub(super) fn approved_file_set(&self, name: &str, digest: &str) -> Result<Option<ApprovedFileSet>, String> {
        Ok(self
            .read_approved_files()?
            .projects
            .get(&self.project_key())
            .and_then(|packages| packages.get(name))
            .filter(|set| set.digest == digest)
            .cloned())
    }

    pub(super) fn previous_file_set(&self, name: &str) -> Result<Option<ApprovedFileSet>, String> {
        Ok(self.read_approved_files()?.projects.get(&self.project_key()).and_then(|packages| packages.get(name)).cloned())
    }

    /// Put back exactly `set` (or nothing) for `name`: an upgrade that fails
    /// after approving restores what was there.
    pub(super) fn restore_file_set(&self, name: &str, set: Option<ApprovedFileSet>) -> Result<(), String> {
        self.write_approved_files(|packages| match set {
            Some(set) => {
                packages.insert(name.to_string(), set);
            }
            None => {
                packages.remove(name);
            }
        })
    }

    /// The approved copies are the ones that will be handed over.
    pub(super) fn file_set_present(&self, set: &ApprovedFileSet) -> bool {
        set.files.values().all(|sha| self.user_root.join("files").join(sha).is_file())
            && self.files_view_dir(set).is_dir()
    }

    /// The read-only view of `set`, at the files' project-relative paths.
    pub(super) fn files_view_dir(&self, set: &ApprovedFileSet) -> PathBuf {
        self.user_root.join("file-views").join(files_digest(&set.files))
    }

    /// The originals as they are now: each declared file's sha256, or `None`
    /// when it is gone or is not a regular file.
    fn current_files(&self, declared: &[String]) -> BTreeMap<String, Option<(String, Vec<u8>)>> {
        declared
            .iter()
            .map(|path| {
                let file = self.workspace.join(path);
                let read = fs::symlink_metadata(&file)
                    .ok()
                    .filter(|meta| meta.is_file())
                    .and_then(|_| fs::read(&file).ok())
                    .map(|bytes| (format!("{:x}", Sha256::digest(&bytes)), bytes));
                (path.clone(), read)
            })
            .collect()
    }

    /// The digest of the declared files as they are now: what a view shows,
    /// and what a click on it approves.
    #[must_use]
    pub fn current_files_digest(&self, declared: &[String]) -> Option<String> {
        let mut shas = BTreeMap::new();
        for (path, read) in self.current_files(declared) {
            shas.insert(path, read?.0);
        }
        Some(files_digest(&shas))
    }

    /// Copy the declared files' current bytes and record them as approved
    /// with package digest `digest`. With `expected`, refused when the files
    /// are no longer what the user was shown.
    pub(super) fn approve_workspace_files(
        &self,
        name: &str,
        digest: &str,
        declared: &[String],
        expected: Option<&str>,
    ) -> Result<(), String> {
        let problems = super::capabilities::check_workspace_files(&self.workspace, declared);
        if let Some(problem) = problems.first() {
            return Err(problem.message.clone());
        }
        // From the first copy written to the record naming them: collection
        // elsewhere never sees copies that are about to be approved.
        let _lock = Self::lock_approved_files_at(&self.user_root)?;
        let current = self.current_files(declared);
        let mut shas = BTreeMap::new();
        let store = self.user_root.join("files");
        fs::create_dir_all(&store).map_err(|e| e.to_string())?;
        for (path, read) in &current {
            let (sha, bytes) = read.as_ref().ok_or_else(|| format!("{path} does not exist in the project"))?;
            let blob = store.join(sha);
            if !blob.is_file() {
                crate::atomic_file::write_replace_unlocked(&blob, bytes).map_err(|e| e.to_string())?;
            }
            shas.insert(path.clone(), sha.clone());
        }
        if expected.is_some_and(|expected| expected != files_digest(&shas)) {
            return Err(WORKSPACE_FILES_CHANGED_SINCE_SHOWN.into());
        }
        let set = ApprovedFileSet { digest: digest.to_string(), files: shas };
        self.build_view(&set)?;
        self.write_approved_files_locked(|packages| {
            packages.insert(name.to_string(), set);
        })
    }

    /// The package digests the approved sets were approved with, in every
    /// project: each keeps its snapshot.
    pub(super) fn approved_package_digests(&self) -> Result<BTreeSet<String>, String> {
        Ok(Self::read_approved_files_at(&self.user_root)?
            .projects
            .into_values()
            .flat_map(BTreeMap::into_values)
            .map(|set| set.digest)
            .collect())
    }

    /// Delete the copies and views nothing refers to any more: no project's
    /// approved set on this computer names them, and no run in this process
    /// (`live_views`) froze them. Returns how many entries were deleted, and
    /// whether a run held a view that would otherwise have gone. The caller
    /// holds [`super::collect`]'s gate and the approvals path lock.
    pub(super) fn collect_file_copies_locked(user_root: &Path, live_views: &BTreeSet<String>) -> Result<(usize, bool), String> {
        let blobs = user_root.join("files");
        let views = user_root.join("file-views");
        if fs::symlink_metadata(&blobs).is_err() && fs::symlink_metadata(&views).is_err() {
            return Ok((0, false));
        }
        let _lock = Self::lock_approved_files_at(user_root)?;
        Self::reject_symlinks([blobs.clone(), views.clone()])?;
        let record = Self::read_approved_files_at(user_root)?;
        let mut keep_views = BTreeSet::new();
        let mut keep_blobs = BTreeSet::new();
        for set in record.projects.values().flat_map(BTreeMap::values) {
            keep_views.insert(files_digest(&set.files));
            keep_blobs.extend(set.files.values().cloned());
        }
        let waiting = live_views.iter().any(|view| !keep_views.contains(view) && views.join(view).exists());
        keep_views.extend(live_views.iter().cloned());
        Ok((remove_unlisted(&views, &keep_views)? + remove_unlisted(&blobs, &keep_blobs)?, waiting))
    }

    /// Lay out the view of `set` from the content store, once.
    fn build_view(&self, set: &ApprovedFileSet) -> Result<(), String> {
        let view = self.files_view_dir(set);
        if view.is_dir() {
            return Ok(());
        }
        let staging = view.with_extension("tmp");
        let _ = fs::remove_dir_all(&staging);
        for (path, sha) in &set.files {
            let target = staging.join(path);
            fs::create_dir_all(target.parent().unwrap_or(&staging)).map_err(|e| e.to_string())?;
            fs::copy(self.user_root.join("files").join(sha), &target).map_err(|e| e.to_string())?;
            let mut permissions = fs::metadata(&target).map_err(|e| e.to_string())?.permissions();
            permissions.set_readonly(true);
            fs::set_permissions(&target, permissions).map_err(|e| e.to_string())?;
        }
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        fs::rename(&staging, &view).map_err(|e| e.to_string())
    }

    /// Withdraw the approved copies of `name` with its approval.
    pub(super) fn withdraw_workspace_files(&self, name: &str) -> Result<(), String> {
        if !self.approved_files_path().exists() {
            return Ok(());
        }
        self.write_approved_files(|packages| {
            packages.remove(name);
        })
    }

    /// Each declared file with its approved copy and its original now.
    pub(super) fn workspace_file_states(&self, name: &str, digest: &str, declared: &[String]) -> Vec<WorkspaceFileState> {
        let approved = self.approved_file_set(name, digest).ok().flatten();
        self.current_files(declared)
            .into_iter()
            .map(|(path, read)| WorkspaceFileState {
                approved: approved.as_ref().and_then(|set| set.files.get(&path).cloned()),
                current: read.map(|(sha, _)| sha),
                path,
            })
            .collect()
    }

    /// What changed in the originals since the approved copies of the
    /// installed `name`: the diff a re-approval would take.
    pub fn workspace_file_changes(&self, name: &str) -> Result<Vec<PackageFileChange>, String> {
        let record = self.effective_record(name)?.ok_or("Plugin is not installed")?;
        let package = self.inspect_record(&record).package;
        let declared = super::capabilities::declared_workspace_files(&package.capabilities);
        let approved = self.approved_file_set(name, &record.digest)?;
        let to_files = |entries: Vec<(String, Vec<u8>)>| -> super::PackageFiles {
            entries
                .into_iter()
                .map(|(path, bytes)| (PathBuf::from(path), PackageFile { bytes, executable: false }))
                .collect()
        };
        let before = to_files(
            approved
                .iter()
                .flat_map(|set| set.files.iter())
                .filter_map(|(path, sha)| fs::read(self.user_root.join("files").join(sha)).ok().map(|bytes| (path.clone(), bytes)))
                .collect(),
        );
        let after = to_files(
            self.current_files(&declared)
                .into_iter()
                .filter_map(|(path, read)| read.map(|(_, bytes)| (path, bytes)))
                .collect(),
        );
        Ok(super::versions::changes(&before, &after))
    }
}

/// Delete the entries of `dir` this module wrote (a sha256 or set digest,
/// or a view's `.tmp` staging directory) that `keep` does not name. An entry
/// that cannot be deleted now (a file a server has open on Windows) is left
/// for the next collection.
fn remove_unlisted(dir: &Path, keep: &BTreeSet<String>) -> Result<usize, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let stem = name.strip_suffix(".tmp").unwrap_or(&name);
        if stem.len() != 64 || !stem.bytes().all(|byte| byte.is_ascii_hexdigit()) || keep.contains(&name) {
            continue;
        }
        if remove_entry(&entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Delete a file, link or directory tree without following links, clearing
/// the read-only flag the view files carry.
#[allow(clippy::permissions_set_readonly_false, reason = "the trust store's own view files, deleted next")]
pub(super) fn remove_entry(path: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        // A link to a directory is a directory entry on Windows.
        return fs::remove_file(path).or_else(|_| fs::remove_dir(path));
    }
    if meta.is_dir() {
        for entry in fs::read_dir(path)? {
            remove_entry(&entry?.path())?;
        }
        return fs::remove_dir(path);
    }
    let mut permissions = meta.permissions();
    if permissions.readonly() {
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions)?;
    }
    fs::remove_file(path)
}
