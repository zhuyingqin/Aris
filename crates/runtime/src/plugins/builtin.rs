//! Official plugins: modules compiled into SomniQ that register through the
//! same plugin model as user packages, without their execution model.
//!
//! A user package runs as an approved MCP process or a sandboxed page. An
//! official plugin is in-process host code that ships with the signed app, so
//! it needs no approval; what it shares with user packages is the switch, the
//! freeze into a run's [`super::PluginSet`] and the place on the plugins page.
//! See `docs/development-logic/official-plugins.md`.
//!
//! Switches live in `<SomniQ config>/plugins/builtin.json`, beside the
//! approvals, never in the workspace: turning on mail lets the model act as the
//! user, so project content must not be able to do it.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::PluginStore;

pub const BUILTIN_MAIL: &str = "mail";
pub const BUILTIN_FIGURES: &str = "figures";
pub const BUILTIN_LITERATURE: &str = "literature";
pub const BUILTIN_LATEX: &str = "latex";

/// Whose choice a switch is by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinScope {
    /// The module's data belongs to the user (mail accounts): one global
    /// switch, which a project may override.
    User,
    /// The module works on project content: a global default, per-project
    /// overrides.
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltinManifest {
    pub id: &'static str,
    pub scope: BuiltinScope,
    /// Whether this version lets the user turn it off. A module whose seams
    /// have not been moved behind the registry yet stays on.
    pub toggleable: bool,
    /// The state when nothing has been chosen.
    pub default_enabled: bool,
}

/// Every official plugin, in the order their tools and prompt sections are
/// assembled. Turning one off removes one contiguous run of that order.
pub const BUILTIN_PLUGINS: &[BuiltinManifest] = &[
    BuiltinManifest {
        id: BUILTIN_LITERATURE,
        scope: BuiltinScope::Project,
        toggleable: false,
        default_enabled: true,
    },
    BuiltinManifest {
        id: BUILTIN_LATEX,
        scope: BuiltinScope::Project,
        toggleable: false,
        default_enabled: true,
    },
    BuiltinManifest {
        id: BUILTIN_FIGURES,
        scope: BuiltinScope::Project,
        toggleable: false,
        default_enabled: true,
    },
    BuiltinManifest {
        id: BUILTIN_MAIL,
        scope: BuiltinScope::User,
        toggleable: true,
        // A fresh profile has no mailbox; the desktop seeds the first value
        // from the accounts it finds (`seed_builtin_global`).
        default_enabled: false,
    },
];

#[must_use]
pub fn builtin_manifest(id: &str) -> Option<&'static BuiltinManifest> {
    BUILTIN_PLUGINS.iter().find(|manifest| manifest.id == id)
}

/// Every official plugin that can be switched off, in registry order: what an
/// unknown run token resolves to, failing closed like its packages do.
pub(super) fn toggleable_ids() -> Vec<String> {
    BUILTIN_PLUGINS
        .iter()
        .filter(|manifest| manifest.toggleable)
        .map(|manifest| manifest.id.to_string())
        .collect()
}

/// Where a switch is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinTarget {
    Global,
    Project,
}

/// One official plugin as the plugins page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinState {
    pub id: String,
    pub scope: BuiltinScope,
    pub toggleable: bool,
    /// What a run starting now in this project gets.
    pub enabled: bool,
    /// The global choice, if one was made.
    pub global: Option<bool>,
    /// This project's override, if one was made.
    pub project: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct BuiltinToggles {
    schema: u32,
    #[serde(default)]
    global: BTreeMap<String, bool>,
    /// Canonical project path → plugin id → override.
    #[serde(default)]
    projects: BTreeMap<String, BTreeMap<String, bool>>,
}

impl BuiltinToggles {
    fn empty() -> Self {
        Self {
            schema: 1,
            ..Self::default()
        }
    }

    fn effective(&self, manifest: &BuiltinManifest, project: &str) -> bool {
        if !manifest.toggleable {
            return true;
        }
        self.projects
            .get(project)
            .and_then(|overrides| overrides.get(manifest.id))
            .or_else(|| self.global.get(manifest.id))
            .copied()
            .unwrap_or(manifest.default_enabled)
    }
}

impl PluginStore {
    fn builtin_path(&self) -> PathBuf {
        self.user_root.join("builtin.json")
    }

    fn builtin_toggles(&self) -> Result<BuiltinToggles, String> {
        Self::reject_symlinks([self.user_root.clone(), self.builtin_path()])?;
        let toggles: BuiltinToggles = match fs::read(self.builtin_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
                format!(
                    "Official plugin switches {} are unreadable: {e}",
                    self.builtin_path().display()
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BuiltinToggles::empty(),
            Err(error) => return Err(error.to_string()),
        };
        if toggles.schema != 1 {
            return Err("Unsupported official plugin switches file".into());
        }
        Ok(toggles)
    }

    /// Read, change and write the switches under an in-process path lock and
    /// a cross-process lock file beside them.
    fn mutate_builtin_toggles(
        &self,
        change: impl FnOnce(&mut BuiltinToggles) -> Result<(), String>,
    ) -> Result<(), String> {
        let path = self.builtin_path();
        crate::with_path_lock(&path, || {
            self.builtin_toggles()?;
            fs::create_dir_all(&self.user_root).map_err(|e| e.to_string())?;
            let lock = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(self.user_root.join("builtin.lock"))
                .map_err(|e| e.to_string())?;
            lock.lock().map_err(|e| e.to_string())?;
            let mut toggles = self.builtin_toggles()?;
            change(&mut toggles)?;
            let bytes = serde_json::to_vec_pretty(&toggles).map_err(|e| e.to_string())?;
            crate::atomic_file::write_replace_unlocked(&path, &bytes).map_err(|e| e.to_string())
        })
    }

    /// Ids of the official plugins that are off for a run starting now, in
    /// [`BUILTIN_PLUGINS`] order. An unreadable switches file falls back to
    /// the defaults: modules that cannot be switched off stay on, and mail,
    /// which acts as the user, stays off until the file is readable again.
    #[must_use]
    pub fn builtin_disabled_now(&self) -> Vec<String> {
        let toggles = self.builtin_toggles().unwrap_or_else(|error| {
            eprintln!("SomniQ plugins: {error}");
            BuiltinToggles::empty()
        });
        let project = self.project_key();
        BUILTIN_PLUGINS
            .iter()
            .filter(|manifest| !toggles.effective(manifest, &project))
            .map(|manifest| manifest.id.to_string())
            .collect()
    }

    /// Whether `id` is on here: inside a run, as the run froze it; otherwise
    /// as a run starting now would get it. Unknown ids are off.
    #[must_use]
    pub fn builtin_enabled(&self, id: &str) -> bool {
        if builtin_manifest(id).is_none() {
            return false;
        }
        match &self.frozen {
            Some(set) => set.builtin_enabled(id),
            None => !self.builtin_disabled_now().iter().any(|off| off == id),
        }
    }

    /// The global choice for `id`, ignoring project overrides: what decides a
    /// user-scoped module's background services (mail watchers), which do not
    /// belong to any one project.
    #[must_use]
    pub fn builtin_globally_enabled(&self, id: &str) -> bool {
        let Some(manifest) = builtin_manifest(id) else {
            return false;
        };
        if !manifest.toggleable {
            return true;
        }
        self.builtin_toggles()
            .ok()
            .and_then(|toggles| toggles.global.get(id).copied())
            .unwrap_or(manifest.default_enabled)
    }

    /// Every official plugin with this project's view of its switches.
    pub fn builtin_states(&self) -> Result<Vec<BuiltinState>, String> {
        let toggles = self.builtin_toggles()?;
        let project = self.project_key();
        Ok(BUILTIN_PLUGINS
            .iter()
            .map(|manifest| BuiltinState {
                id: manifest.id.to_string(),
                scope: manifest.scope,
                toggleable: manifest.toggleable,
                enabled: toggles.effective(manifest, &project),
                global: toggles.global.get(manifest.id).copied(),
                project: toggles
                    .projects
                    .get(&project)
                    .and_then(|overrides| overrides.get(manifest.id))
                    .copied(),
            })
            .collect())
    }

    /// Set (`Some`) or clear (`None`) a switch. Only the desktop's main window
    /// calls this; no model tool reaches it.
    pub fn set_builtin(
        &self,
        id: &str,
        target: BuiltinTarget,
        value: Option<bool>,
    ) -> Result<Vec<BuiltinState>, String> {
        let manifest =
            builtin_manifest(id).ok_or_else(|| format!("Unknown official plugin `{id}`"))?;
        if !manifest.toggleable {
            return Err(format!(
                "The official plugin `{id}` cannot be turned off in this version"
            ));
        }
        let project = self.project_key();
        self.mutate_builtin_toggles(|toggles| {
            let map = match target {
                BuiltinTarget::Global => &mut toggles.global,
                BuiltinTarget::Project => toggles.projects.entry(project.clone()).or_default(),
            };
            match value {
                Some(value) => {
                    map.insert(id.to_string(), value);
                }
                None => {
                    map.remove(id);
                }
            }
            toggles.projects.retain(|_, overrides| !overrides.is_empty());
            Ok(())
        })?;
        self.builtin_states()
    }

    /// Record the first global value for `id` unless one was ever chosen, and
    /// return the global value now in force. The desktop seeds mail from the
    /// accounts it finds, so an upgrade never switches off a mailbox in use.
    pub fn seed_builtin_global(&self, id: &str, value: bool) -> Result<bool, String> {
        builtin_manifest(id).ok_or_else(|| format!("Unknown official plugin `{id}`"))?;
        let mut current = value;
        self.mutate_builtin_toggles(|toggles| {
            current = *toggles.global.entry(id.to_string()).or_insert(value);
            Ok(())
        })?;
        Ok(current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, PluginStore) {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        let store = PluginStore::with_user_root(&workspace, dir.path().join("user"));
        (dir, store)
    }

    #[test]
    fn defaults_keep_every_module_but_unseeded_mail() {
        let (_dir, store) = store();
        assert_eq!(store.builtin_disabled_now(), vec![BUILTIN_MAIL.to_string()]);
        assert!(store.builtin_enabled(BUILTIN_LITERATURE));
        assert!(!store.builtin_enabled(BUILTIN_MAIL));
        assert!(!store.builtin_enabled("no-such-plugin"));
    }

    #[test]
    fn seeding_never_overrides_a_choice() {
        let (_dir, store) = store();
        assert!(store.seed_builtin_global(BUILTIN_MAIL, true).unwrap());
        assert!(store.builtin_enabled(BUILTIN_MAIL));
        store
            .set_builtin(BUILTIN_MAIL, BuiltinTarget::Global, Some(false))
            .unwrap();
        assert!(!store.seed_builtin_global(BUILTIN_MAIL, true).unwrap());
        assert!(!store.builtin_globally_enabled(BUILTIN_MAIL));
    }

    #[test]
    fn a_project_override_wins_and_clears_back_to_global() {
        let (_dir, store) = store();
        store
            .set_builtin(BUILTIN_MAIL, BuiltinTarget::Global, Some(true))
            .unwrap();
        let states = store
            .set_builtin(BUILTIN_MAIL, BuiltinTarget::Project, Some(false))
            .unwrap();
        let mail = states.iter().find(|state| state.id == BUILTIN_MAIL).unwrap();
        assert_eq!((mail.enabled, mail.global, mail.project), (false, Some(true), Some(false)));
        assert!(store.builtin_globally_enabled(BUILTIN_MAIL));
        store
            .set_builtin(BUILTIN_MAIL, BuiltinTarget::Project, None)
            .unwrap();
        assert!(store.builtin_enabled(BUILTIN_MAIL));
    }

    #[test]
    fn modules_not_yet_behind_the_registry_cannot_be_turned_off() {
        let (_dir, store) = store();
        for id in [BUILTIN_LITERATURE, BUILTIN_LATEX, BUILTIN_FIGURES] {
            assert!(store
                .set_builtin(id, BuiltinTarget::Global, Some(false))
                .is_err());
            assert!(store.builtin_enabled(id));
        }
    }

    #[test]
    fn an_unreadable_file_falls_back_to_defaults_and_refuses_writes() {
        let (dir, store) = store();
        fs::create_dir_all(dir.path().join("user")).unwrap();
        fs::write(dir.path().join("user").join("builtin.json"), b"{not json").unwrap();
        assert_eq!(store.builtin_disabled_now(), vec![BUILTIN_MAIL.to_string()]);
        assert!(store.builtin_enabled(BUILTIN_LITERATURE));
        assert!(store
            .set_builtin(BUILTIN_MAIL, BuiltinTarget::Global, Some(true))
            .is_err());
    }

    #[test]
    fn a_run_keeps_the_switches_it_started_with() {
        let (_dir, store) = store();
        store
            .set_builtin(BUILTIN_MAIL, BuiltinTarget::Global, Some(true))
            .unwrap();
        let run = super::super::PluginRun::begin(&store, "test run");
        assert!(run.set().builtin_enabled(BUILTIN_MAIL));
        store
            .set_builtin(BUILTIN_MAIL, BuiltinTarget::Global, Some(false))
            .unwrap();
        assert!(run.set().builtin_enabled(BUILTIN_MAIL));
        assert!(!store.builtin_enabled(BUILTIN_MAIL));
        let next = super::super::PluginRun::begin(&store, "next run");
        assert!(!next.set().builtin_enabled(BUILTIN_MAIL));
    }

    #[test]
    fn a_set_with_every_official_plugin_on_keeps_its_old_shape() {
        let (_dir, store) = store();
        store.seed_builtin_global(BUILTIN_MAIL, true).unwrap();
        let set = store.freeze().unwrap();
        // SHA-256 of nothing: the fingerprint an empty set always had.
        assert_eq!(
            set.fingerprint,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let json = serde_json::to_value(&set).unwrap();
        assert!(json.get("builtinDisabled").is_none());

        store
            .set_builtin(BUILTIN_MAIL, BuiltinTarget::Global, Some(false))
            .unwrap();
        let off = store.freeze().unwrap();
        assert_ne!(off.fingerprint, set.fingerprint);
        assert_eq!(off.builtin_disabled, vec![BUILTIN_MAIL.to_string()]);
    }
}
