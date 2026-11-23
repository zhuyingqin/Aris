//! Packages switched on for every project on this computer.
//!
//! A project-scoped package is listed in the workspace and approved per
//! project. A global one is listed in `<SomniQ config>/plugins/global.json`,
//! next to the approvals and outside every workspace, so nothing a model or a
//! cloned repository writes can make a package global. Being on that list IS
//! the approval: the user turned the package on for all projects, for exactly
//! the digest recorded there.
//!
//! Every project sees the global packages. A project may switch one off for
//! itself (`optOut`, also kept here, keyed like approvals), and a package the
//! project installed under the same name shadows the global one. Upgrading or
//! removing a global package happens in a project: turning "all projects" off
//! moves it back into the project it was switched from, as an ordinary
//! enabled package there.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use serde::{Deserialize, Serialize};

use super::{valid_digest, valid_package_name, InstalledPlugin, PluginStore, Record, Registry};

/// Refusal for a version change that has to happen in one project.
pub const GLOBAL_PLUGIN_CHANGE_IN_PROJECT: &str =
    "This plugin is on for all projects. Turn off \"All projects\" first; it then belongs to this project, where it can be upgraded, rolled back or removed";

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct GlobalPlugins {
    schema: u32,
    pub(super) packages: BTreeMap<String, Record>,
    /// Project key -> global packages that project switched off.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    opt_out: BTreeMap<String, BTreeSet<String>>,
}

impl PluginStore {
    pub(super) fn global_path(&self) -> std::path::PathBuf {
        self.user_root.join("global.json")
    }

    pub(super) fn global_plugins(&self) -> Result<GlobalPlugins, String> {
        Self::reject_symlinks([
            self.user_root.clone(),
            self.user_root.join("global.lock"),
            self.global_path(),
        ])?;
        let global: GlobalPlugins = match fs::read(self.global_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
                format!("Global plugin list {} is unreadable: {e}", self.global_path().display())
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => GlobalPlugins {
                schema: 1,
                ..GlobalPlugins::default()
            },
            Err(error) => return Err(error.to_string()),
        };
        if global.schema != 1
            || global.packages.iter().any(|(name, record)| {
                name != &record.name || !valid_package_name(name) || !valid_digest(&record.digest)
            })
        {
            return Err("Invalid or unsupported global plugin list".into());
        }
        Ok(global)
    }

    /// Read, change and write the global list under its cross-process lock.
    /// Called inside [`Self::mutate`], which holds the in-process lock.
    fn update_global<T>(
        &self,
        change: impl FnOnce(&mut GlobalPlugins) -> Result<T, String>,
    ) -> Result<T, String> {
        self.global_plugins()?;
        fs::create_dir_all(&self.user_root).map_err(|e| e.to_string())?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.user_root.join("global.lock"))
            .map_err(|e| e.to_string())?;
        lock.lock().map_err(|e| e.to_string())?;
        let mut global = self.global_plugins()?;
        let value = change(&mut global)?;
        let bytes = serde_json::to_vec_pretty(&global).map_err(|e| e.to_string())?;
        crate::atomic_file::write_replace_unlocked(&self.global_path(), &bytes)
            .map_err(|e| e.to_string())?;
        Ok(value)
    }

    /// The records this project sees: its own, then every global one it does
    /// not shadow. A global record's `enabled` is "this project did not
    /// switch it off".
    pub(super) fn effective_records(&self) -> Result<Vec<Record>, String> {
        let registry = self.registry()?;
        self.effective_records_of(&registry)
    }

    pub(super) fn effective_records_of(&self, registry: &Registry) -> Result<Vec<Record>, String> {
        let global = self.global_plugins()?;
        let key = self.project_key();
        let off = global.opt_out.get(&key);
        let mut records: Vec<Record> = registry.packages.values().cloned().collect();
        for (name, record) in global.packages {
            if registry.packages.contains_key(&name) {
                continue;
            }
            let enabled = !off.is_some_and(|names| names.contains(&name));
            records.push(Record { enabled, global: true, ..record });
        }
        Ok(records)
    }

    pub(super) fn effective_record(&self, name: &str) -> Result<Option<Record>, String> {
        Ok(self.effective_records()?.into_iter().find(|record| record.name == name))
    }

    /// Refuse a version change of a package this project only sees globally.
    pub(super) fn reject_global_only(&self, name: &str) -> Result<(), String> {
        if !self.registry()?.packages.contains_key(name)
            && self.global_plugins()?.packages.contains_key(name)
        {
            return Err(GLOBAL_PLUGIN_CHANGE_IN_PROJECT.into());
        }
        Ok(())
    }

    /// A global package stands down where an enabled project package already
    /// provides one of its skills: the project's own choice wins, and two
    /// packages never serve one skill name.
    pub(super) fn resolve_global_conflicts(views: &mut [InstalledPlugin]) {
        let project_skills: BTreeMap<String, String> = views
            .iter()
            .filter(|view| !view.global && view.enabled && view.package.can_enable)
            .flat_map(|view| {
                view.package
                    .capabilities
                    .skills
                    .iter()
                    .map(|skill| (skill.to_ascii_lowercase(), view.package.name.clone()))
            })
            .collect();
        for view in views.iter_mut().filter(|view| view.global && view.enabled) {
            let Some(owner) = view
                .package
                .capabilities
                .skills
                .iter()
                .find_map(|skill| project_skills.get(&skill.to_ascii_lowercase()))
                .cloned()
            else {
                continue;
            };
            view.enabled = false;
            if view.status == "enabled" {
                view.status = "disabled".into();
            }
            view.package.diagnostics.push(super::Diagnostic {
                severity: "warning".into(),
                ..super::Diagnostic::error(
                    "global-skill-conflict",
                    format!("Off in this project: its skills overlap the project's plugin {owner}"),
                )
            });
        }
    }

    /// Switch a global package on or off for this project only.
    pub(super) fn set_global_opt_out(&self, name: &str, off: bool) -> Result<(), String> {
        let key = self.project_key();
        self.update_global(|global| {
            if !global.packages.contains_key(name) {
                return Err("Plugin is not installed".into());
            }
            let names = global.opt_out.entry(key.clone()).or_default();
            if off {
                names.insert(name.to_string());
            } else {
                names.remove(name);
            }
            if names.is_empty() {
                global.opt_out.remove(&key);
            }
            Ok(())
        })
    }

    /// Turn "all projects" on (move this project's enabled package to the
    /// global list) or off (move the global package into this project, still
    /// enabled here; other projects lose it).
    pub fn set_global(&self, name: &str, global: bool) -> Result<InstalledPlugin, String> {
        self.set_global_checked(name, global, None)
    }

    /// [`Self::set_global`] for exactly the version the user's view showed.
    pub fn set_global_shown(
        &self,
        name: &str,
        global: bool,
        shown_digest: &str,
    ) -> Result<InstalledPlugin, String> {
        self.set_global_checked(name, global, Some(shown_digest))
    }

    fn set_global_checked(
        &self,
        name: &str,
        global: bool,
        shown_digest: Option<&str>,
    ) -> Result<InstalledPlugin, String> {
        self.mutate(|| {
            if let Some(shown) = shown_digest {
                let current = self.effective_record(name)?.ok_or("Plugin is not installed")?;
                if current.digest != shown {
                    return Err(super::PACKAGE_CHANGED_SINCE_SHOWN.into());
                }
            }
            let mut registry = self.registry()?;
            if global {
                let record = registry
                    .packages
                    .get(name)
                    .ok_or("Plugin is not installed in this project")?
                    .clone();
                let view = self.inspect_record(&record);
                if !view.enabled || !view.package.can_enable {
                    return Err("Turn the plugin on in this project before enabling it for all projects".into());
                }
                self.update_global(|list| {
                    if list.packages.contains_key(name) {
                        return Err("A plugin with this name is already on for all projects".into());
                    }
                    list.packages.insert(name.to_string(), Record { enabled: true, global: false, ..record });
                    for names in list.opt_out.values_mut() {
                        names.remove(name);
                    }
                    list.opt_out.retain(|_, names| !names.is_empty());
                    Ok(())
                })?;
                // The global entry now runs here too; the project copy goes.
                self.set_approval(name, None)?;
                registry.packages.remove(name);
                self.save(&registry)?;
            } else {
                if registry.packages.contains_key(name) {
                    return Err("This project's own copy of the plugin is not the global one".into());
                }
                let record = self
                    .global_plugins()?
                    .packages
                    .get(name)
                    .cloned()
                    .ok_or("Plugin is not on for all projects")?;
                // Approval first, so the package never runs here unapproved.
                self.set_approval(name, Some(&record.digest))?;
                registry
                    .packages
                    .insert(name.to_string(), Record { enabled: true, global: false, ..record });
                self.save(&registry)?;
                self.update_global(|list| {
                    list.packages.remove(name);
                    for names in list.opt_out.values_mut() {
                        names.remove(name);
                    }
                    list.opt_out.retain(|_, names| !names.is_empty());
                    Ok(())
                })?;
            }
            let record = self
                .effective_record(name)?
                .ok_or("Plugin is not installed")?;
            Ok(self.view(&record))
        })
    }
}
