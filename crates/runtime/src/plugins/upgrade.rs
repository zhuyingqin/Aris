//! Replacing an installed package with another version, as one transaction.
//!
//! Importing a package whose name is already installed previews an upgrade:
//! what the new version adds or drops (Skills, panels, MCP servers, the exact
//! commands they run and the environment keys they set) against the installed
//! version. Running it again needs this computer's approval of the new digest.
//!
//! Until the switch, the installed version and its approval stay in force:
//! the new snapshot is published next to the old one (snapshots are content
//! addressed and never touched in place), every check runs before anything
//! the old version depends on changes, and a failure after the approval moved
//! puts the old approval back. In-flight runs keep the version they froze.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Serialize;

use super::{package_files, InstalledPlugin, PackageFiles, PluginMcp, PluginPreview, PluginStore, Record};

/// A package preview, plus what installing it would replace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginImportPreview {
    #[serde(flatten)]
    pub package: PluginPreview,
    /// Present when a package of the same name is installed in this project.
    pub upgrade: Option<PluginUpgradePlan>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VersionChange {
    Upgrade,
    Downgrade,
    /// Same version string, different bytes.
    SameVersion,
    /// Exactly the installed snapshot; there is nothing to do.
    Identical,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpgradePlan {
    pub current_version: String,
    /// Pass back to [`PluginStore::upgrade`]: the upgrade is refused if the
    /// installed version changed after this preview.
    pub current_digest: String,
    /// The installed version is approved and enabled, so the next run gets it
    /// and the new version must be approved to keep the package running.
    pub current_enabled: bool,
    pub change: VersionChange,
    pub diff: CapabilityDiff,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListChange {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

impl ListChange {
    fn between(before: &BTreeSet<String>, after: &BTreeSet<String>) -> Self {
        Self {
            added: after.difference(before).cloned().collect(),
            removed: before.difference(after).cloned().collect(),
        }
    }

    fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServerChange {
    Added,
    Removed,
    Changed,
    Unchanged,
}

/// One MCP server across the two versions. Command lines show package files
/// as `./path`, so a new snapshot location alone is not a change. Environment
/// values are never shown, only which keys appear, disappear or change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDiff {
    pub name: String,
    pub change: ServerChange,
    pub before: Option<String>,
    pub after: Option<String>,
    pub env_added: Vec<String>,
    pub env_removed: Vec<String>,
    pub env_changed: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDiff {
    pub skills: ListChange,
    pub ui_panels: ListChange,
    pub mcp_servers: Vec<McpServerDiff>,
    /// Command lines this computer would start, across every server.
    pub commands: ListChange,
    /// Environment keys set for those commands, across every server.
    pub env_keys: ListChange,
    /// Anything above differs.
    pub changed: bool,
}

/// `value` with the snapshot directory written as `./`, as the package wrote it.
fn relative_to_snapshot(value: &str, root: &str) -> String {
    match value.strip_prefix(root) {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            format!(
                "./{}",
                rest.trim_start_matches(['/', '\\']).replace('\\', "/")
            )
        }
        _ => value.to_string(),
    }
}

fn command_line(server: &PluginMcp, root: &str) -> String {
    std::iter::once(&server.command)
        .chain(&server.args)
        .map(|part| relative_to_snapshot(part, root))
        .collect::<Vec<_>>()
        .join(" ")
}

fn diff(
    before: &PluginPreview,
    before_root: &str,
    after: &PluginPreview,
    after_root: &str,
) -> CapabilityDiff {
    let names = |package: &PluginPreview| -> BTreeSet<String> {
        package.capabilities.skills.iter().cloned().collect()
    };
    let panels = |package: &PluginPreview| -> BTreeSet<String> {
        package
            .capabilities
            .ui_panels
            .iter()
            // A panel gaining or losing its own page is a change to review.
            .map(|panel| match panel.page {
                Some(_) => format!("{} (page)", panel.id),
                None => panel.id.clone(),
            })
            .collect()
    };
    let servers = |package: &PluginPreview| -> BTreeMap<String, PluginMcp> {
        package
            .capabilities
            .mcp_servers
            .iter()
            .map(|server| (server.name.clone(), server.clone()))
            .collect()
    };
    let (old_servers, new_servers) = (servers(before), servers(after));
    let mut mcp_servers = vec![];
    let mut commands = (BTreeSet::new(), BTreeSet::new());
    let mut env_keys = (BTreeSet::new(), BTreeSet::new());
    let all: BTreeSet<&String> = old_servers.keys().chain(new_servers.keys()).collect();
    for name in all {
        let old = old_servers.get(name);
        let new = new_servers.get(name);
        let old_line = old.map(|server| command_line(server, before_root));
        let new_line = new.map(|server| command_line(server, after_root));
        commands.0.extend(old_line.clone());
        commands.1.extend(new_line.clone());
        let old_env = old.map(|server| &server.env);
        let new_env = new.map(|server| &server.env);
        env_keys
            .0
            .extend(old_env.into_iter().flat_map(BTreeMap::keys).cloned());
        env_keys
            .1
            .extend(new_env.into_iter().flat_map(BTreeMap::keys).cloned());
        let empty = BTreeMap::new();
        let (old_env, new_env) = (old_env.unwrap_or(&empty), new_env.unwrap_or(&empty));
        let env_changed: Vec<String> = old_env
            .iter()
            .filter(|(key, value)| new_env.get(*key).is_some_and(|next| next != *value))
            .map(|(key, _)| key.clone())
            .collect();
        let change = match (old, new) {
            (None, Some(_)) => ServerChange::Added,
            (Some(_), None) => ServerChange::Removed,
            (Some(old), Some(new))
                if old_line == new_line
                    && env_changed.is_empty()
                    && old.env.keys().eq(new.env.keys())
                    && old.request_timeout_secs == new.request_timeout_secs =>
            {
                ServerChange::Unchanged
            }
            _ => ServerChange::Changed,
        };
        mcp_servers.push(McpServerDiff {
            name: name.clone(),
            change,
            before: old_line,
            after: new_line,
            env_added: new_env
                .keys()
                .filter(|key| !old_env.contains_key(*key))
                .cloned()
                .collect(),
            env_removed: old_env
                .keys()
                .filter(|key| !new_env.contains_key(*key))
                .cloned()
                .collect(),
            env_changed,
        });
    }
    let mut diff = CapabilityDiff {
        skills: ListChange::between(&names(before), &names(after)),
        ui_panels: ListChange::between(&panels(before), &panels(after)),
        commands: ListChange::between(&commands.0, &commands.1),
        env_keys: ListChange::between(&env_keys.0, &env_keys.1),
        mcp_servers,
        changed: false,
    };
    diff.changed = !diff.skills.is_empty()
        || !diff.ui_panels.is_empty()
        || diff
            .mcp_servers
            .iter()
            .any(|server| server.change != ServerChange::Unchanged);
    diff
}

// Test-only fault injection: the named step of the next upgrade on this
// thread fails as if the disk had.
#[cfg(test)]
thread_local! {
    pub(super) static FAIL_UPGRADE_AT: std::cell::Cell<Option<&'static str>> =
        const { std::cell::Cell::new(None) };
}

fn failpoint(step: &'static str) -> Result<(), String> {
    #[cfg(test)]
    if FAIL_UPGRADE_AT.with(std::cell::Cell::get) == Some(step) {
        return Err(format!("injected failure at {step}"));
    }
    let _ = step;
    Ok(())
}

impl PluginStore {
    /// [`Self::preview`], plus the upgrade it would be if the name is installed.
    pub fn preview_import(&self, source: impl AsRef<Path>) -> Result<PluginImportPreview, String> {
        let package = self.preview(source)?;
        let upgrade = self
            .registry()?
            .packages
            .get(&package.name)
            .map(|record| self.upgrade_plan(record, &package));
        Ok(PluginImportPreview { package, upgrade })
    }

    fn upgrade_plan(&self, record: &Record, candidate: &PluginPreview) -> PluginUpgradePlan {
        let current = self.inspect_record(record);
        let change = if record.digest == candidate.digest {
            VersionChange::Identical
        } else {
            match (
                semver::Version::parse(&record.version),
                semver::Version::parse(&candidate.version),
            ) {
                (Ok(old), Ok(new)) if new > old => VersionChange::Upgrade,
                (Ok(old), Ok(new)) if new < old => VersionChange::Downgrade,
                _ => VersionChange::SameVersion,
            }
        };
        PluginUpgradePlan {
            current_version: record.version.clone(),
            current_digest: record.digest.clone(),
            current_enabled: current.enabled,
            change,
            diff: diff(
                &current.package,
                &self.snapshot_path(&record.digest).to_string_lossy(),
                candidate,
                &self.snapshot_path(&candidate.digest).to_string_lossy(),
            ),
        }
    }

    /// Replace the installed version of a package with the previewed bytes.
    ///
    /// `expected_current_digest` is the installed digest the preview's diff
    /// was computed against. With `approve`, the new digest is approved and
    /// the package stays enabled; without it, the new version is installed
    /// disabled and the old approval withdrawn. Either way nothing the old
    /// version runs from changes until every step that can fail has passed,
    /// and a failure after the approval moved restores it.
    pub fn upgrade(
        &self,
        source: impl AsRef<Path>,
        expected_digest: &str,
        expected_current_digest: &str,
        approve: bool,
    ) -> Result<InstalledPlugin, String> {
        let files = package_files(source.as_ref())?;
        let source = crate::canonicalize(source).map_err(|e| e.to_string())?;
        self.replace_with(&files, &source.to_string_lossy(), expected_digest, expected_current_digest, approve)
    }

    /// The transaction behind [`Self::upgrade`] and [`Self::rollback`]: make
    /// `files` (shown as coming from `source`) the installed version, keeping
    /// the one it replaces in the history.
    pub(super) fn replace_with(
        &self,
        files: &PackageFiles,
        source: &str,
        expected_digest: &str,
        expected_current_digest: &str,
        approve: bool,
    ) -> Result<InstalledPlugin, String> {
        let candidate = self.inspect(&files, source)?;
        if candidate.digest != expected_digest {
            return Err("Package changed after preview; preview the upgrade again".into());
        }
        if approve && !candidate.can_enable {
            return Err(
                "This version cannot be enabled; resolve its diagnostics or upgrade it without approval"
                    .into(),
            );
        }
        self.mutate(|| {
            let registry = self.registry()?;
            let record = registry
                .packages
                .get(&candidate.name)
                .ok_or("Plugin is not installed; install it instead of upgrading")?
                .clone();
            if record.digest != expected_current_digest {
                return Err(
                    "The installed version changed after preview; preview the upgrade again"
                        .into(),
                );
            }
            if record.digest == candidate.digest {
                return Err("This version is already installed".into());
            }
            if approve {
                if let Some(other) =
                    self.skill_conflict(&registry, &record.name, &candidate.capabilities)
                {
                    return Err(format!("Skill name conflicts with enabled plugin {other}"));
                }
            }
            // Read the approval before touching anything, so a damaged
            // approvals file stops the upgrade instead of half-applying it.
            let previous_approval = self.approved_digest(&record.name)?;

            // ── Stage: the new snapshot sits beside the old one ───────────
            self.publish_snapshot(&files, &candidate.digest)?;
            failpoint("published")?;

            // ── Switch: approval, then the registry ───────────────────────
            let next_approval = approve.then_some(candidate.digest.as_str());
            let moves_approval = previous_approval.as_deref() != next_approval;
            if moves_approval {
                self.set_approval(&record.name, next_approval)?;
            }
            let commit = failpoint("approved").and_then(|()| {
                let mut next = registry.clone();
                next.packages.insert(
                    record.name.clone(),
                    Record {
                        name: record.name.clone(),
                        version: candidate.version.clone(),
                        description: candidate.description.clone(),
                        source: candidate.source.clone(),
                        digest: candidate.digest.clone(),
                        enabled: approve,
                        history: super::versions::history_after(&record, &candidate.digest),
                        original: super::versions::original_of(&record),
                    },
                );
                self.save(&next)?;
                Ok(next)
            });
            match commit {
                Ok(next) => Ok(self.view(&next.packages[&record.name])),
                Err(error) => {
                    // ── Roll back: the old version and its approval stay ──
                    if moves_approval {
                        if let Err(restore) =
                            self.set_approval(&record.name, previous_approval.as_deref())
                        {
                            return Err(format!(
                                "{error}; restoring the previous approval also failed, so the package is stopped: {restore}"
                            ));
                        }
                    }
                    Err(error)
                }
            }
        })
    }
}
