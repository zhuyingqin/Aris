//! Collection of plugin state nothing refers to any more: package snapshots
//! (`<plugins>/packages/<digest>`) and project-file copies (see
//! [`super::workspace_files`]).
//!
//! Snapshots are content-addressed and shared by every project on this
//! computer, but each project's registry lives in that project. So the trust
//! store keeps an index of the digests each known project's registry names
//! (`package-refs.json`): written with every registry change, and replaced as
//! a whole from the projects `SomniQ` knows ([`sync_known_projects`]) at
//! startup and when a project is added or removed. Until that has happened
//! once, no snapshot is collected: a project never seen could name any.
//!
//! A snapshot is in use while an indexed project names it (installed, an
//! earlier version or the original), the global list or an approval names
//! it, or a run in this process froze it. An unused one is not deleted at
//! once: it moves to `packages-retired/<digest>-<unix secs>`, and the next
//! look-up of that digest brings it back (a project `SomniQ` forgot and later
//! re-adds, a registry restored from version control). Retired snapshots are
//! deleted after [`RETIRED_SNAPSHOT_DAYS`].
//!
//! Collection runs after a change to what is installed or approved (enable,
//! disable, remove, upgrade, rollback), after a sync, and when a run ends that
//! held something collection had to leave.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError, RwLock, RwLockReadGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::{valid_digest, PluginStore, Record, Registry};

/// Days a retired snapshot can still come back before it is deleted.
pub const RETIRED_SNAPSHOT_DAYS: u64 = 30;

const RETIRED_DIR: &str = "packages-retired";

/// The digests each known project's registry names.
#[derive(Debug, Default, Serialize, Deserialize)]
struct PackageRefs {
    schema: u32,
    /// Replaced from the projects `SomniQ` knows at least once: before that,
    /// an unindexed project could name any snapshot.
    #[serde(default)]
    synced: bool,
    projects: BTreeMap<String, BTreeSet<String>>,
}

/// Read by a run from taking its set to registering it, written while unused
/// state is collected: what a starting run just froze is never collected
/// before the run is seen holding it.
fn collection_gate() -> &'static RwLock<()> {
    static GATE: OnceLock<RwLock<()>> = OnceLock::new();
    GATE.get_or_init(|| RwLock::new(()))
}

/// Keeps collection out while a run freezes and registers its set.
pub(super) fn hold_collection() -> RwLockReadGuard<'static, ()> {
    collection_gate().read().unwrap_or_else(PoisonError::into_inner)
}

/// Trust stores whose collection left something only a run still held.
fn deferred() -> &'static Mutex<BTreeSet<PathBuf>> {
    static DEFERRED: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();
    DEFERRED.get_or_init(|| Mutex::new(BTreeSet::new()))
}

/// When a run ends: collect again wherever collection waited for runs. On
/// threads of their own, because a run may end while its caller holds locks
/// collection takes.
pub(super) fn run_deferred_collections() {
    let roots = std::mem::take(&mut *deferred().lock().unwrap_or_else(PoisonError::into_inner));
    for root in roots {
        let _ = std::thread::Builder::new()
            .name("plugin-collection".into())
            .spawn(move || {
                let _ = PluginStore::collect_unused_at(&root);
            });
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs())
}

/// Every snapshot `record` keeps: the installed one, its earlier versions and
/// its original.
fn record_digests(record: &Record) -> impl Iterator<Item = String> + '_ {
    std::iter::once(record.digest.clone())
        .chain(record.history.iter().map(|version| version.digest.clone()))
        .chain(record.original.clone())
}

/// Tell the trust store which projects `SomniQ` knows (see the module docs),
/// then collect what none of them, nor anything else, uses.
pub fn sync_known_projects(projects: &[PathBuf]) -> Result<usize, String> {
    PluginStore::sync_known_projects_at(&crate::somniq_config_dir_from_env().join("plugins"), projects)
}

impl PluginStore {
    fn package_refs_path_at(user_root: &Path) -> PathBuf {
        user_root.join("package-refs.json")
    }

    fn read_package_refs_at(user_root: &Path) -> Result<PackageRefs, String> {
        let path = Self::package_refs_path_at(user_root);
        Self::reject_symlinks([user_root.to_path_buf(), path.clone()])?;
        match fs::read(&path) {
            Ok(bytes) => {
                let refs: PackageRefs =
                    serde_json::from_slice(&bytes).map_err(|e| format!("Plugin snapshot index is unreadable: {e}"))?;
                if refs.schema != 1 {
                    return Err("Unsupported plugin snapshot index".into());
                }
                Ok(refs)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PackageRefs { schema: 1, ..PackageRefs::default() }),
            Err(error) => Err(error.to_string()),
        }
    }

    /// Read, change and write the index under its cross-process lock.
    fn update_package_refs_at(user_root: &Path, change: impl FnOnce(&mut PackageRefs)) -> Result<(), String> {
        fs::create_dir_all(user_root).map_err(|e| e.to_string())?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(user_root.join("package-refs.lock"))
            .map_err(|e| e.to_string())?;
        lock.lock().map_err(|e| e.to_string())?;
        let mut refs = Self::read_package_refs_at(user_root)?;
        change(&mut refs);
        let bytes = serde_json::to_vec_pretty(&refs).map_err(|e| e.to_string())?;
        crate::atomic_file::write_replace_unlocked(&Self::package_refs_path_at(user_root), &bytes).map_err(|e| e.to_string())
    }

    /// Record what this project's registry names, after it was written. A
    /// failure is not the registry's: an under-counted snapshot is at worst
    /// retired, and comes back when looked up.
    pub(super) fn record_package_refs(&self, registry: &Registry) {
        let digests: BTreeSet<String> = registry.packages.values().flat_map(record_digests).collect();
        let key = self.project_key();
        let _ = Self::update_package_refs_at(&self.user_root, |refs| {
            if digests.is_empty() {
                refs.projects.remove(&key);
            } else {
                refs.projects.insert(key, digests);
            }
        });
    }

    /// [`sync_known_projects`] for the trust store at `user_root`. A project
    /// whose registry cannot be read stops the sync: what it names is unknown.
    pub fn sync_known_projects_at(user_root: &Path, projects: &[PathBuf]) -> Result<usize, String> {
        // Serialised with every plugin change in this process, so no registry
        // is read halfway through one.
        crate::with_path_lock(&user_root.join("approvals.json"), || {
            let mut indexed = BTreeMap::new();
            for project in projects {
                let store = Self::with_user_root(project, user_root);
                let registry = store.registry().map_err(|error| format!("{}: {error}", project.display()))?;
                let digests: BTreeSet<String> = registry.packages.values().flat_map(record_digests).collect();
                if !digests.is_empty() {
                    indexed.insert(store.project_key(), digests);
                }
            }
            Self::update_package_refs_at(user_root, |refs| {
                refs.projects = indexed;
                refs.synced = true;
            })
        })?;
        Self::collect_unused_at(user_root)
    }

    /// [`Self::collect_unused_at`] for this store's trust store. A failure is
    /// left for the next collection: it never fails the change that
    /// triggered it.
    pub(super) fn collect_unused(&self) {
        let _ = Self::collect_unused_at(&self.user_root);
    }

    /// Collect the project-file copies and package snapshots nothing uses any
    /// more. Returns how many entries were deleted or retired.
    ///
    /// Runs in another `SomniQ` process are not seen. A view one of them froze
    /// can be deleted, and a snapshot retired, when this process changes what
    /// is approved or installed; their servers then fail to read those files
    /// until their next run, which looks the snapshot up (bringing it back)
    /// and takes the approved view.
    pub(super) fn collect_unused_at(user_root: &Path) -> Result<usize, String> {
        // No run between taking a set and registering it, and no plugin change
        // in this process halfway through (an upgrade approves the new copies
        // before it knows whether it must restore the old ones).
        let _gate = collection_gate().write().unwrap_or_else(PoisonError::into_inner);
        crate::with_path_lock(&user_root.join("approvals.json"), || {
            let copies = Self::collect_file_copies_locked(user_root, &super::lifecycle::live_file_views());
            let snapshots = Self::collect_snapshots_locked(user_root);
            let (copies, copies_waiting) = copies?;
            let (snapshots, snapshots_waiting) = snapshots?;
            if copies_waiting || snapshots_waiting {
                deferred().lock().unwrap_or_else(PoisonError::into_inner).insert(user_root.to_path_buf());
            }
            Ok(copies + snapshots)
        })
    }

    /// Retire the snapshots nothing names, bring back retired ones named
    /// again, delete retired ones past their days. Returns how many it
    /// retired or deleted, and whether a run held one it would have retired.
    fn collect_snapshots_locked(user_root: &Path) -> Result<(usize, bool), String> {
        let packages = user_root.join("packages");
        let retired = user_root.join(RETIRED_DIR);
        Self::reject_symlinks([packages.clone(), retired.clone()])?;
        let refs = Self::read_package_refs_at(user_root)?;
        if !refs.synced || (fs::symlink_metadata(&packages).is_err() && fs::symlink_metadata(&retired).is_err()) {
            return Ok((0, false));
        }
        // Everything that names a snapshot; any of them unreadable, nothing goes.
        let store = Self::with_user_root(user_root, user_root);
        let mut named: BTreeSet<String> = refs.projects.into_values().flatten().collect();
        named.extend(store.global_plugins()?.packages.values().flat_map(record_digests));
        named.extend(store.approvals()?.projects.into_values().flat_map(BTreeMap::into_values));
        named.extend(store.approved_package_digests()?);
        let live = super::lifecycle::live_package_digests();

        let mut changed = 0;
        let mut waiting = false;
        // A retired snapshot named again comes back, unless it is back already.
        for (entry, digest, _) in retired_entries(&retired) {
            if (named.contains(&digest) || live.contains(&digest)) && fs::symlink_metadata(packages.join(&digest)).is_err() {
                let _ = fs::rename(&entry, packages.join(&digest));
            }
        }
        if let Ok(entries) = fs::read_dir(&packages) {
            let now = now_secs();
            for entry in entries.flatten() {
                let digest = entry.file_name().to_string_lossy().into_owned();
                if !valid_digest(&digest) || named.contains(&digest) {
                    continue;
                }
                if live.contains(&digest) {
                    waiting = true;
                    continue;
                }
                // A snapshot a server still has files open in cannot move on
                // Windows; it stays whole and is tried again next time.
                fs::create_dir_all(&retired).map_err(|e| e.to_string())?;
                if fs::rename(entry.path(), retired.join(format!("{digest}-{now}"))).is_ok() {
                    changed += 1;
                }
            }
        }
        let keep_for = RETIRED_SNAPSHOT_DAYS * 24 * 60 * 60;
        for (entry, digest, retired_at) in retired_entries(&retired) {
            // A copy of one that is back, or one nothing named for its days.
            let back = fs::symlink_metadata(packages.join(&digest)).is_ok();
            let expired = !named.contains(&digest)
                && !live.contains(&digest)
                && now_secs().saturating_sub(retired_at) > keep_for;
            if back || expired {
                // Out of reach of a look-up first, so nothing brings back a
                // half-deleted snapshot.
                let doomed = entry.with_extension("delete");
                if fs::rename(&entry, &doomed).is_ok() && super::workspace_files::remove_entry(&doomed).is_ok() {
                    changed += 1;
                }
            }
        }
        // What an interrupted deletion left.
        if let Ok(entries) = fs::read_dir(&retired) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|extension| extension == "delete") {
                    let _ = super::workspace_files::remove_entry(&entry.path());
                }
            }
        }
        Ok((changed, waiting))
    }

    /// Bring a retired snapshot of `digest` back into `packages/`, if there is
    /// one. Called when a look-up finds no snapshot.
    pub(super) fn restore_retired_snapshot(&self, digest: &str) {
        if !valid_digest(digest) {
            return;
        }
        let retired = self.user_root.join(RETIRED_DIR);
        if let Some((entry, _, _)) = retired_entries(&retired).into_iter().find(|(_, found, _)| found == digest) {
            let _ = fs::rename(entry, self.user_root.join("packages").join(digest));
        }
    }
}

/// The retired snapshots under `retired`: path, digest and when retired.
fn retired_entries(retired: &Path) -> Vec<(PathBuf, String, u64)> {
    let Ok(entries) = fs::read_dir(retired) else {
        return vec![];
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let (digest, secs) = name.split_once('-')?;
            let secs = secs.parse().ok()?;
            valid_digest(digest).then(|| (entry.path(), digest.to_string(), secs))
        })
        .collect()
}
