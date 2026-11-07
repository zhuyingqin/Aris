//! What a package is actually doing, not just how it is configured.
//!
//! "Enabled" only says the next run gets a package. This module keeps the
//! other states apart, after DeepSeek Harness's plugin manager (ideas only):
//!
//! - **installed**: on the list, not approved here, runs nowhere.
//! - **approval-required**: the project asks for it, this computer has not
//!   approved this digest, so it still runs nowhere.
//! - **blocked**: diagnostics or a damaged snapshot keep it from running.
//! - **enabled**: approved and enabled; the next run gets it.
//! - **running**: in-flight runs use exactly the version that is enabled.
//! - **failed**: the last real discovery of one of its MCP servers failed.
//! - **needs-restart**: some in-flight run uses a different set than the next
//!   run will get (an older version, a package since disabled, or one enabled
//!   after the run started). The change reaches a run when it next starts.
//!
//! "Running" and "needs restart" come from [`PluginRun`]: every Chat turn and
//! WorkTask run freezes its plugin set (name and digest) when it starts and
//! resolves plugins only from that set until it ends.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{mcp_entries, InstalledPlugin, PluginStore};

/// Names the [`PluginRun`] an execution belongs to. Only this process can
/// resolve it; a token it did not issue resolves to no plugins.
pub const ARIS_PLUGIN_RUN_ENV: &str = "ARIS_PLUGIN_RUN";

/// One package in a frozen set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenPlugin {
    pub name: String,
    pub version: String,
    pub digest: String,
}

/// The packages one run may use, fixed when it started. Recorded in the run's
/// audit trail (the Chat session's event log, the WorkTask record).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSet {
    /// Canonical path of the project the set was frozen for.
    pub project: String,
    /// Sorted by name.
    pub plugins: Vec<FrozenPlugin>,
    /// SHA-256 over the sorted `name@digest` lines: equal sets, equal value.
    pub fingerprint: String,
    pub frozen_at_ms: u64,
    /// Why the set is empty when it could not be read; the run then uses no
    /// plugins rather than whatever the registry says later.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

impl PluginSet {
    fn new(project: String, mut plugins: Vec<FrozenPlugin>, error: Option<String>) -> Self {
        plugins.sort_by(|a, b| a.name.cmp(&b.name));
        let mut hash = Sha256::new();
        for plugin in &plugins {
            hash.update(plugin.name.as_bytes());
            hash.update(b"@");
            hash.update(plugin.digest.as_bytes());
            hash.update(b"\n");
        }
        Self {
            project,
            plugins,
            fingerprint: format!("{:x}", hash.finalize()),
            frozen_at_ms: now_ms(),
            error,
        }
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&FrozenPlugin> {
        self.plugins.iter().find(|plugin| plugin.name == name)
    }

    #[must_use]
    pub fn contains(&self, name: &str, digest: &str) -> bool {
        self.get(name).is_some_and(|plugin| plugin.digest == digest)
    }
}

impl PluginStore {
    /// The set a run starting now gets: approved, enabled and intact packages.
    ///
    /// Taken under the registry's in-process lock, which every mutation holds
    /// for its whole read/modify/write, so a run never freezes a half-applied
    /// upgrade. Inside a run, the run's own set (a nested run stays within it).
    pub fn freeze(&self) -> Result<PluginSet, String> {
        if let Some(set) = &self.frozen {
            return Ok((**set).clone());
        }
        crate::with_path_lock(&self.registry_path(), || {
            let plugins = self
                .running()?
                .into_iter()
                .map(|plugin| FrozenPlugin {
                    name: plugin.package.name,
                    version: plugin.package.version,
                    digest: plugin.package.digest,
                })
                .collect();
            Ok(PluginSet::new(self.project_key(), plugins, None))
        })
    }
}

struct RunEntry {
    label: String,
    started_at_ms: u64,
    set: Arc<PluginSet>,
    snapshot_dirs: Arc<[PathBuf]>,
}

fn runs() -> &'static Mutex<BTreeMap<String, RunEntry>> {
    static RUNS: OnceLock<Mutex<BTreeMap<String, RunEntry>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn lock_runs() -> std::sync::MutexGuard<'static, BTreeMap<String, RunEntry>> {
    runs()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn new_token() -> String {
    static FALLBACK: AtomicU64 = AtomicU64::new(0);
    let mut bytes = [0_u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // Uniqueness is what matters in-process; lookups never cross it.
        let count = FALLBACK.fetch_add(1, Ordering::Relaxed);
        bytes[..8].copy_from_slice(&count.to_le_bytes());
        bytes[8..].copy_from_slice(&now_ms().to_le_bytes());
    }
    format!("{:032x}", u128::from_le_bytes(bytes))
}

/// One in-flight run's hold on the plugin set it started with.
///
/// Created when a Chat turn or WorkTask run starts and dropped when it ends.
/// While it lives, every [`PluginStore::for_execution`] inside a context bound
/// with [`Self::bind`] resolves plugins from the frozen set, so enabling,
/// disabling, upgrading or removing a package cannot change what the run (or
/// its review) can use. Snapshots are content-addressed and never deleted, so
/// the frozen digests stay readable for the whole run.
pub struct PluginRun {
    token: String,
    set: Arc<PluginSet>,
    snapshot_dirs: Arc<[PathBuf]>,
}

impl std::fmt::Debug for PluginRun {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PluginRun")
            .field("set", &self.set)
            .finish_non_exhaustive()
    }
}

impl PluginRun {
    /// Freeze `store`'s current set for a run called `label`. A registry that
    /// cannot be read freezes an empty set with the reason, so the run uses no
    /// plugins (as an unreadable registry always has) instead of later ones.
    #[must_use]
    pub fn begin(store: &PluginStore, label: impl Into<String>) -> Self {
        let set = store
            .freeze()
            .unwrap_or_else(|error| PluginSet::new(store.project_key(), Vec::new(), Some(error)));
        let snapshot_dirs: Arc<[PathBuf]> = set
            .plugins
            .iter()
            .map(|plugin| store.snapshot_path(&plugin.digest))
            .collect();
        let set = Arc::new(set);
        let token = new_token();
        lock_runs().insert(
            token.clone(),
            RunEntry {
                label: label.into(),
                started_at_ms: now_ms(),
                set: set.clone(),
                snapshot_dirs: snapshot_dirs.clone(),
            },
        );
        Self {
            token,
            set,
            snapshot_dirs,
        }
    }

    #[must_use]
    pub fn set(&self) -> &PluginSet {
        &self.set
    }

    /// Snapshot directories of the frozen packages: the run's read-only roots.
    #[must_use]
    pub fn snapshot_dirs(&self) -> &[PathBuf] {
        &self.snapshot_dirs
    }

    /// `context`, resolving plugins from this run's frozen set.
    #[must_use]
    pub fn bind(&self, context: crate::ProjectExecutionContext) -> crate::ProjectExecutionContext {
        self.binding().bind(context)
    }

    /// A non-owning handle that binds further contexts to this run.
    #[must_use]
    pub fn binding(&self) -> PluginRunBinding {
        PluginRunBinding {
            token: self.token.clone(),
            snapshot_dirs: self.snapshot_dirs.clone(),
        }
    }

    /// Run `action` bound to this run's set, keeping the rest of the active
    /// execution context (or the process's) as it is.
    pub fn enter<T>(&self, action: impl FnOnce() -> T) -> T {
        let base = crate::active_project_execution_context().or_else(|| {
            crate::execution_current_dir()
                .ok()
                .map(crate::ProjectExecutionContext::new)
        });
        match base {
            Some(base) => crate::with_project_execution_context(&self.bind(base), action),
            None => action(),
        }
    }
}

/// What binds a context to a run, without keeping the run alive.
#[derive(Debug, Clone)]
pub struct PluginRunBinding {
    token: String,
    snapshot_dirs: Arc<[PathBuf]>,
}

impl PluginRunBinding {
    /// The frozen packages' snapshot directories; empty once the run ended.
    #[must_use]
    pub fn snapshot_dirs(&self) -> &[PathBuf] {
        &self.snapshot_dirs
    }

    #[must_use]
    pub fn bind(&self, context: crate::ProjectExecutionContext) -> crate::ProjectExecutionContext {
        context.with_env(ARIS_PLUGIN_RUN_ENV, self.token.as_str())
    }
}

/// The run the current execution belongs to, for code that builds a fresh
/// context for part of it (a Desktop tool call re-binds its project). Work
/// nested in a run stays in that run. A token no live run holds still binds,
/// to nothing, so work left over from an ended run never reaches the live set.
#[must_use]
pub fn current_plugin_run() -> Option<PluginRunBinding> {
    let token =
        crate::execution_env_var_os(ARIS_PLUGIN_RUN_ENV).filter(|value| !value.is_empty())?;
    let token = token.to_string_lossy().into_owned();
    let snapshot_dirs = lock_runs().get(&token).map_or_else(
        || Arc::from(Vec::new()),
        |entry| entry.snapshot_dirs.clone(),
    );
    Some(PluginRunBinding {
        token,
        snapshot_dirs,
    })
}

impl Drop for PluginRun {
    fn drop(&mut self) {
        lock_runs().remove(&self.token);
    }
}

/// A run's frozen set, or an empty one when the token is unknown here (never
/// issued, or its run ended) or names another project's run.
pub(super) fn resolve_run(token: &str, project: &str) -> Arc<PluginSet> {
    let found = lock_runs().get(token).map(|entry| entry.set.clone());
    match found {
        Some(set) if set.project == project => set,
        Some(_) => Arc::new(PluginSet::new(
            project.to_string(),
            Vec::new(),
            Some("This run's plugin set belongs to another project".into()),
        )),
        None => Arc::new(PluginSet::new(
            project.to_string(),
            Vec::new(),
            Some("This run's plugin set is no longer registered".into()),
        )),
    }
}

/// The frozen sets of this project's in-flight runs.
pub(super) fn project_runs(project: &str) -> Vec<Arc<PluginSet>> {
    lock_runs()
        .values()
        .filter(|entry| entry.set.project == project)
        .map(|entry| entry.set.clone())
        .collect()
}

/// An in-flight run as diagnostics see it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InFlightPluginRun {
    pub label: String,
    pub started_at_ms: u64,
    pub set: PluginSet,
}

/// Every in-flight run in this process, oldest first.
#[must_use]
pub fn in_flight_plugin_runs() -> Vec<InFlightPluginRun> {
    let mut runs: Vec<_> = lock_runs()
        .values()
        .map(|entry| InFlightPluginRun {
            label: entry.label.clone(),
            started_at_ms: entry.started_at_ms,
            set: (*entry.set).clone(),
        })
        .collect();
    runs.sort_by_key(|run| run.started_at_ms);
    runs
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginState {
    #[default]
    Installed,
    ApprovalRequired,
    Blocked,
    Enabled,
    Running,
    Failed,
    NeedsRestart,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpHealthState {
    /// No discovery of this exact configuration has run in this process.
    #[default]
    Unchecked,
    Connected,
    Failed,
}

/// One declared MCP server and what its last real discovery saw.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpStatus {
    /// As the package declares it.
    pub name: String,
    /// As Chat and the MCP settings list it.
    pub runtime_name: String,
    pub health: McpHealthState,
    pub tool_count: usize,
    pub message: Option<String>,
    pub checked_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLifecycle {
    pub state: PluginState,
    /// In-flight runs of this project that froze this package, any version.
    pub active_runs: usize,
    /// In-flight runs whose frozen copy differs from what the next run gets.
    pub stale_runs: usize,
    pub mcp_servers: Vec<PluginMcpStatus>,
}

/// Where `view` stands given this project's in-flight `runs`.
pub(super) fn assess(view: &InstalledPlugin, runs: &[Arc<PluginSet>]) -> PluginLifecycle {
    let name = &view.package.name;
    let digest = &view.package.digest;
    let runs_next = view.enabled && view.package.can_enable;
    let active_runs = runs.iter().filter(|set| set.get(name).is_some()).count();
    let stale_runs = if runs_next {
        runs.iter()
            .filter(|set| !set.contains(name, digest))
            .count()
    } else {
        active_runs
    };
    let mcp_servers: Vec<_> = mcp_entries(&view.package)
        .into_iter()
        .map(|entry| {
            let health = crate::mcp_server_health(
                &entry.runtime_name,
                &crate::scoped_mcp_config_hash(&entry.config),
            );
            PluginMcpStatus {
                name: entry.declared,
                runtime_name: entry.runtime_name,
                health: match &health {
                    None => McpHealthState::Unchecked,
                    Some(health) if health.ok => McpHealthState::Connected,
                    Some(_) => McpHealthState::Failed,
                },
                tool_count: health.as_ref().map_or(0, |health| health.tool_count),
                message: health.as_ref().and_then(|health| health.message.clone()),
                checked_at_ms: health.map(|health| health.checked_at_ms),
            }
        })
        .collect();
    let state = if !view.package.can_enable {
        PluginState::Blocked
    } else if !runs_next {
        if stale_runs > 0 {
            PluginState::NeedsRestart
        } else if view
            .package
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "approval-required")
        {
            PluginState::ApprovalRequired
        } else {
            PluginState::Installed
        }
    } else if mcp_servers
        .iter()
        .any(|server| server.health == McpHealthState::Failed)
    {
        PluginState::Failed
    } else if stale_runs > 0 {
        PluginState::NeedsRestart
    } else if active_runs > 0 {
        PluginState::Running
    } else {
        PluginState::Enabled
    };
    PluginLifecycle {
        state,
        active_runs,
        stale_runs,
        mcp_servers,
    }
}
