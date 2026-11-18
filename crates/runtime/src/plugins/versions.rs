//! Versions of an installed package, for changing a plugin by conversation.
//!
//! - **History**: every upgrade keeps the version it replaced (its snapshot is
//!   content addressed and stays on this computer), so the user can go back
//!   to any of them, including the original.
//! - **Checkout**: the installed bytes, written into the project's draft
//!   directory, so the agent edits exactly what runs instead of guessing.
//! - **Review**: what an upgrade card shows besides the capability diff:
//!   every file that changes, and the draft's own page to try out before
//!   anything is approved.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::{
    digest_files, package_files, InstalledPlugin, PackageFiles, PluginStore, Record, UiPage,
    UiPanel, PLUGIN_DRAFTS_DIR,
};

/// How many replaced versions a package keeps. The oldest (the original) is
/// always one of them.
pub const MAX_PLUGIN_HISTORY: usize = 20;
/// A file larger than this is listed as changed without its text.
const MAX_DIFF_TEXT_BYTES: usize = 256 * 1024;

/// A version an upgrade replaced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginVersion {
    pub version: String,
    pub digest: String,
    pub source: String,
    /// Unix seconds when a newer version replaced it.
    pub replaced_at: u64,
}

/// The original of a package being replaced: recorded at install, or, for a
/// package installed before that was recorded and never upgraded since, the
/// version being replaced now.
pub(super) fn original_of(record: &Record) -> Option<String> {
    record
        .original
        .clone()
        .or_else(|| record.history.is_empty().then(|| record.digest.clone()))
}

/// The history once `record` is replaced by `next_digest`: the record first,
/// then what it had replaced, without `next_digest` (a rollback brings that
/// one back) or repeats, capped while keeping the original.
pub(super) fn history_after(record: &Record, next_digest: &str) -> Vec<PluginVersion> {
    let replaced_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let mut seen = BTreeSet::new();
    let mut history: Vec<PluginVersion> = std::iter::once(PluginVersion {
        version: record.version.clone(),
        digest: record.digest.clone(),
        source: record.source.clone(),
        replaced_at,
    })
    .chain(record.history.iter().cloned())
    .filter(|version| version.digest != next_digest && seen.insert(version.digest.clone()))
    .collect();
    if history.len() > MAX_PLUGIN_HISTORY {
        // Keep the original (or, unknown, the oldest) past the cap.
        let original = original_of(record);
        let at = history
            .iter()
            .position(|version| Some(&version.digest) == original.as_ref())
            .unwrap_or(history.len() - 1);
        let kept = history.remove(at);
        history.truncate(MAX_PLUGIN_HISTORY - 1);
        history.push(kept);
    }
    history
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileChangeKind {
    Added,
    Removed,
    Changed,
}

/// One file that differs between the installed version and a draft.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageFileChange {
    pub path: String,
    pub change: FileChangeKind,
    /// Not UTF-8 text, or too large to show: only the sizes are given.
    pub binary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    pub before_bytes: usize,
    pub after_bytes: usize,
}

/// A draft panel's page with the declarations the frame needs to run it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftPage {
    pub page: UiPage,
    pub panel: UiPanel,
    /// The panel whose data the page shows (its `dataPanel`), if another.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store: Option<UiPanel>,
}

/// The installed bytes, written as a draft the agent can edit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCheckout {
    /// `checked-out`, `unchanged` (the draft already holds exactly these
    /// bytes) or `exists` (the draft holds other edits; nothing was written).
    pub status: &'static str,
    /// Workspace-relative, with forward slashes.
    pub directory: String,
    pub version: String,
    pub digest: String,
    pub files: Vec<String>,
    /// For `exists`: the digest of what the draft holds now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_digest: Option<String>,
    /// Where an edited draft was moved before the checkout replaced it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_aside: Option<String>,
}

fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn text(bytes: &[u8]) -> Option<String> {
    (bytes.len() <= MAX_DIFF_TEXT_BYTES)
        .then(|| std::str::from_utf8(bytes).ok().map(str::to_string))
        .flatten()
}

fn changes(before: &PackageFiles, after: &PackageFiles) -> Vec<PackageFileChange> {
    let paths: BTreeSet<_> = before.keys().chain(after.keys()).collect();
    paths
        .into_iter()
        .filter_map(|path| {
            let (old, new) = (before.get(path), after.get(path));
            let change = match (old, new) {
                (None, Some(_)) => FileChangeKind::Added,
                (Some(_), None) => FileChangeKind::Removed,
                (Some(old), Some(new)) if old.bytes != new.bytes || old.executable != new.executable => {
                    FileChangeKind::Changed
                }
                _ => return None,
            };
            let (before_text, after_text) = (old.map(|f| text(&f.bytes)), new.map(|f| text(&f.bytes)));
            let binary = matches!(before_text, Some(None)) || matches!(after_text, Some(None));
            Some(PackageFileChange {
                path: slash(path),
                change,
                binary,
                before: if binary { None } else { before_text.flatten() },
                after: if binary { None } else { after_text.flatten() },
                before_bytes: old.map_or(0, |f| f.bytes.len()),
                after_bytes: new.map_or(0, |f| f.bytes.len()),
            })
        })
        .collect()
}

impl PluginStore {
    /// The installed record of `name` and its snapshot, checked intact.
    fn installed_files(&self, name: &str) -> Result<(Record, PackageFiles), String> {
        let record = self
            .registry()?
            .packages
            .get(name)
            .cloned()
            .ok_or("Plugin is not installed")?;
        let files = self.snapshot_files(&record.digest)?;
        Ok((record, files))
    }

    fn snapshot_files(&self, digest: &str) -> Result<PackageFiles, String> {
        let files = package_files(&self.snapshot_path(digest))
            .map_err(|_| "That version's snapshot is not on this computer".to_string())?;
        if digest_files(&files) != digest {
            return Err("That version's snapshot was modified on this computer".into());
        }
        Ok(files)
    }

    /// A draft's files, exactly as they were when `expected_digest` was shown.
    fn draft_files(source: &Path, expected_digest: &str) -> Result<PackageFiles, String> {
        let files = package_files(source)?;
        if digest_files(&files) != expected_digest {
            return Err("The draft changed after this card was shown; ask for the upgrade again".into());
        }
        Ok(files)
    }

    /// Every file that differs between the installed version of the draft's
    /// package and the draft, with the text of each side when it is text.
    pub fn draft_changes(
        &self,
        source: impl AsRef<Path>,
        expected_digest: &str,
    ) -> Result<Vec<PackageFileChange>, String> {
        let source = source.as_ref();
        let files = Self::draft_files(source, expected_digest)?;
        let candidate = self.inspect(&files, &slash(source))?;
        let installed = match self.registry()?.packages.contains_key(&candidate.name) {
            true => self.installed_files(&candidate.name)?.1,
            false => BTreeMap::new(),
        };
        Ok(changes(&installed, &files))
    }

    /// A draft panel's page, to try before approving: the same files the
    /// approved version would run, read from the draft and checked against
    /// the digest the card shows.
    pub fn draft_page(
        &self,
        source: impl AsRef<Path>,
        expected_digest: &str,
        panel_id: &str,
    ) -> Result<DraftPage, String> {
        let source = source.as_ref();
        let files = Self::draft_files(source, expected_digest)?;
        let candidate = self.inspect(&files, &slash(source))?;
        let panels = &candidate.capabilities.ui_panels;
        let panel = panels
            .iter()
            .find(|panel| panel.id == panel_id)
            .cloned()
            .ok_or("The draft declares no such panel, or its ui.json has errors")?;
        let file = panel.page.clone().ok_or("This panel has no page")?;
        let store = panel
            .data_panel
            .as_ref()
            .and_then(|id| panels.iter().find(|other| &other.id == id).cloned());
        Ok(DraftPage {
            page: super::ui::page_from_files(&files, &file, expected_digest)?,
            panel,
            store,
        })
    }

    /// Make an earlier version of `name` the installed one again. The same
    /// transaction as an upgrade: with `approve` it keeps running (the user
    /// clicked for exactly this version), and the version it replaces joins
    /// the history.
    pub fn rollback(
        &self,
        name: &str,
        digest: &str,
        expected_current_digest: &str,
        approve: bool,
    ) -> Result<InstalledPlugin, String> {
        let record = self
            .registry()?
            .packages
            .get(name)
            .cloned()
            .ok_or("Plugin is not installed")?;
        let entry = record
            .history
            .iter()
            .find(|version| version.digest == digest)
            .ok_or("That is not an earlier version of this plugin")?;
        let files = self.snapshot_files(digest)?;
        self.replace_with(&files, &entry.source, digest, expected_current_digest, approve)
    }

    /// Write the installed version of `name` into the project's draft
    /// directory, `<drafts>/<package name without scope>`. A draft holding
    /// other edits is left alone unless `replace`, which moves it aside
    /// (never deletes it) before writing.
    pub fn checkout(&self, name: &str, replace: bool) -> Result<PluginCheckout, String> {
        let (record, files) = self.installed_files(name)?;
        let short = name.rsplit('/').next().unwrap_or(name);
        let drafts = self.workspace.join(PLUGIN_DRAFTS_DIR);
        let target = drafts.join(short);
        Self::reject_symlinks([
            crate::somniq_project_dir(&self.workspace),
            drafts.clone(),
            target.clone(),
        ])?;
        let relative = |path: &Path| slash(path.strip_prefix(&self.workspace).unwrap_or(path));
        let mut result = PluginCheckout {
            status: "checked-out",
            directory: relative(&target),
            version: record.version.clone(),
            digest: record.digest.clone(),
            files: files.keys().map(|path| slash(path)).collect(),
            draft_digest: None,
            moved_aside: None,
        };
        if fs::symlink_metadata(&target).is_ok() {
            let current = package_files(&target).map(|existing| digest_files(&existing));
            if current.as_deref() == Ok(record.digest.as_str()) {
                result.status = "unchanged";
                return Ok(result);
            }
            if !replace {
                result.status = "exists";
                result.draft_digest = current.ok();
                return Ok(result);
            }
            let aside = (1..)
                .map(|n| drafts.join(format!("{short}-previous-{n}")))
                .find(|path| fs::symlink_metadata(path).is_err())
                .unwrap();
            fs::rename(&target, &aside).map_err(|e| e.to_string())?;
            result.moved_aside = Some(relative(&aside));
        }
        fs::create_dir_all(&drafts).map_err(|e| e.to_string())?;
        let staging = tempfile::tempdir_in(&drafts).map_err(|e| e.to_string())?;
        for (path, file) in &files {
            let destination = staging.path().join(path);
            fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::write(&destination, &file.bytes).map_err(|e| e.to_string())?;
        }
        fs::rename(staging.keep(), &target).map_err(|e| e.to_string())?;
        Ok(result)
    }
}
