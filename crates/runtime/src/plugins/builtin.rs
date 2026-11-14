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
    /// The agent tools this plugin contributes, with what the runtime needs
    /// to know about them. The runtime reads these declarations instead of
    /// keeping its own lists of module tool names.
    pub tools: &'static [BuiltinTool],
}

/// How a tool takes part in external retrieval (`retrieval_guard`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRetrievalRole {
    /// Finds candidate sources.
    Discovery,
    /// Opens a specific source to check it.
    Verification,
}

/// How a successful call's output can still report a failure (`tool_outcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFailureKind {
    /// A command's exit status line.
    Shell,
    /// A literature run where every source failed.
    LiteratureSearch,
}

/// One agent tool an official plugin contributes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltinTool {
    pub name: &'static str,
    pub retrieval: Option<ToolRetrievalRole>,
    pub output_failure: Option<OutputFailureKind>,
    /// Other official plugins the tool needs besides its own.
    pub requires: &'static [&'static str],
}

const fn tool(name: &'static str) -> BuiltinTool {
    BuiltinTool {
        name,
        retrieval: None,
        output_failure: None,
        requires: &[],
    }
}

const fn search_tool(name: &'static str) -> BuiltinTool {
    BuiltinTool {
        name,
        retrieval: Some(ToolRetrievalRole::Discovery),
        output_failure: Some(OutputFailureKind::LiteratureSearch),
        requires: &[],
    }
}

/// The Literature plugin's tools: external search, protocol runs and PDF
/// acquisition. Local evidence (`LibraryRetrieve`, `Retrieval*`,
/// `ProjectEvidenceSearch`, knowledge) is core and is not listed here. The
/// protocol writer and preview, library upsert and the browser download task
/// open no connection, so they have no retrieval role.
const LITERATURE_TOOLS: &[BuiltinTool] = &[
    search_tool("LiteratureSearch"),
    search_tool("LiteratureCitations"),
    tool("LiteratureSearchProtocolCreate"),
    tool("LiteratureSearchPreview"),
    search_tool("LiteratureSearchExecute"),
    tool("LiteratureLibraryUpsert"),
    BuiltinTool {
        retrieval: Some(ToolRetrievalRole::Verification),
        ..tool("LiteraturePdfDownload")
    },
    tool("LiteratureBrowserDownloadTask"),
];

const LATEX_TOOLS: &[BuiltinTool] = &[
    BuiltinTool {
        output_failure: Some(OutputFailureKind::Shell),
        ..tool("LaTeXCompile")
    },
    tool("LaTeXRender"),
];

const MAIL_TOOLS: &[BuiltinTool] = &[
    tool("mail_accounts"),
    tool("mail_folders"),
    tool("mail_search"),
    tool("mail_read"),
    tool("mail_send"),
    tool("mail_mark"),
    tool("mail_move"),
    // Catching up on paper alerts searches and downloads through Literature.
    BuiltinTool {
        requires: &[BUILTIN_LITERATURE],
        ..tool("mail_literature_catch_up")
    },
];

/// The official plugin that contributes `tool_name`, and its declaration.
#[must_use]
pub fn builtin_tool(tool_name: &str) -> Option<(&'static BuiltinManifest, &'static BuiltinTool)> {
    BUILTIN_PLUGINS.iter().find_map(|manifest| {
        manifest
            .tools
            .iter()
            .find(|tool| tool.name == tool_name)
            .map(|tool| (manifest, tool))
    })
}

/// Every official plugin, in the order their tools and prompt sections are
/// assembled. Turning one off removes one contiguous run of that order.
pub const BUILTIN_PLUGINS: &[BuiltinManifest] = &[
    BuiltinManifest {
        id: BUILTIN_LITERATURE,
        scope: BuiltinScope::Project,
        toggleable: true,
        default_enabled: true,
        tools: LITERATURE_TOOLS,
    },
    BuiltinManifest {
        id: BUILTIN_LATEX,
        scope: BuiltinScope::Project,
        toggleable: true,
        default_enabled: true,
        tools: LATEX_TOOLS,
    },
    BuiltinManifest {
        id: BUILTIN_FIGURES,
        scope: BuiltinScope::Project,
        toggleable: true,
        default_enabled: true,
        tools: &[],
    },
    BuiltinManifest {
        id: BUILTIN_MAIL,
        scope: BuiltinScope::User,
        toggleable: true,
        // A fresh profile has no mailbox; the desktop seeds the first value
        // from the accounts it finds (`seed_builtin_global`).
        default_enabled: false,
        tools: MAIL_TOOLS,
    },
];

#[must_use]
pub fn builtin_manifest(id: &str) -> Option<&'static BuiltinManifest> {
    BUILTIN_PLUGINS.iter().find(|manifest| manifest.id == id)
}

/// The official plugin a skill compiled into the app works through, if any.
/// The skill is listed and invocable only while that plugin is on; a user's
/// own skill of the same name is theirs and is never hidden.
#[must_use]
pub fn bundled_skill_plugin(name: &str) -> Option<&'static str> {
    match name.to_ascii_lowercase().as_str() {
        "literature-search" | "literature-screen" | "literature-evidence" => {
            Some(BUILTIN_LITERATURE)
        }
        "latex-diagrams" | "paper-compile" => Some(BUILTIN_LATEX),
        _ => None,
    }
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
    /// What following the global switch gives: its choice or the default.
    pub global_enabled: bool,
    /// This project's override on this computer, if one was made.
    pub project: Option<bool>,
    /// The project itself asks for this plugin to be off
    /// (`.somniq/plugins/official.json`). A local project override still wins.
    pub workspace_off: bool,
}

/// What a project may say about official plugins in its own `.somniq`: only
/// that it does not need some. Project content can never turn one on.
#[derive(Debug, Clone, Default, Deserialize)]
struct WorkspaceRequest {
    #[serde(default)]
    disable: Vec<String>,
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

    /// This computer's project override, then the project's own request to
    /// switch it off, then the global choice, then the default.
    fn effective(&self, manifest: &BuiltinManifest, project: &str, workspace_off: &[String]) -> bool {
        if !manifest.toggleable {
            return true;
        }
        if let Some(local) = self
            .projects
            .get(project)
            .and_then(|overrides| overrides.get(manifest.id))
        {
            return *local;
        }
        if workspace_off.iter().any(|id| id == manifest.id) {
            return false;
        }
        self.global
            .get(manifest.id)
            .copied()
            .unwrap_or(manifest.default_enabled)
    }
}

impl PluginStore {
    fn builtin_path(&self) -> PathBuf {
        self.user_root.join("builtin.json")
    }

    /// Official plugins this project asks to have off. A missing, unreadable
    /// or symlinked request is no request: it could only ever switch things off.
    fn workspace_builtin_off(&self) -> Vec<String> {
        let path = self.root.join("official.json");
        if Self::reject_symlinks([self.root.clone(), path.clone()]).is_err() {
            return Vec::new();
        }
        let Ok(bytes) = fs::read(&path) else {
            return Vec::new();
        };
        match serde_json::from_slice::<WorkspaceRequest>(&bytes) {
            Ok(request) => request
                .disable
                .into_iter()
                .filter(|id| builtin_manifest(id).is_some_and(|manifest| manifest.toggleable))
                .collect(),
            Err(error) => {
                eprintln!("SomniQ plugins: ignoring {}: {error}", path.display());
                Vec::new()
            }
        }
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
        let workspace_off = self.workspace_builtin_off();
        BUILTIN_PLUGINS
            .iter()
            .filter(|manifest| !toggles.effective(manifest, &project, &workspace_off))
            .map(|manifest| manifest.id.to_string())
            .collect()
    }

    /// The official plugins that are off here: inside a run, as the run froze
    /// them; otherwise as a run starting now would get them.
    #[must_use]
    pub fn builtin_disabled(&self) -> Vec<String> {
        match &self.frozen {
            Some(set) => set.builtin_disabled.clone(),
            None => self.builtin_disabled_now(),
        }
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
        let workspace_off = self.workspace_builtin_off();
        Ok(BUILTIN_PLUGINS
            .iter()
            .map(|manifest| BuiltinState {
                id: manifest.id.to_string(),
                scope: manifest.scope,
                toggleable: manifest.toggleable,
                enabled: toggles.effective(manifest, &project, &workspace_off),
                workspace_off: workspace_off.iter().any(|id| id == manifest.id),
                global: toggles.global.get(manifest.id).copied(),
                global_enabled: !manifest.toggleable
                    || toggles
                        .global
                        .get(manifest.id)
                        .copied()
                        .unwrap_or(manifest.default_enabled),
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
    fn a_project_can_ask_for_mail_off_but_never_on_and_the_user_has_the_last_word() {
        let (dir, store) = store();
        store
            .set_builtin(BUILTIN_MAIL, BuiltinTarget::Global, Some(true))
            .unwrap();
        let request = dir.path().join("project").join(".somniq").join("plugins");
        fs::create_dir_all(&request).unwrap();
        fs::write(
            request.join("official.json"),
            br#"{"disable": ["mail", "literature", "nonsense"]}"#,
        )
        .unwrap();
        assert!(!store.builtin_enabled(BUILTIN_MAIL));
        assert!(!store.builtin_enabled(BUILTIN_LITERATURE), "any switchable plugin can be asked off");
        assert!(store.builtin_enabled(BUILTIN_LATEX), "only the plugins it names");
        let mail = store
            .builtin_states()
            .unwrap()
            .into_iter()
            .find(|state| state.id == BUILTIN_MAIL)
            .unwrap();
        assert!(mail.workspace_off && !mail.enabled);

        // A local override for this project beats the project's request.
        store
            .set_builtin(BUILTIN_MAIL, BuiltinTarget::Project, Some(true))
            .unwrap();
        assert!(store.builtin_enabled(BUILTIN_MAIL));

        // A request can only switch off: an "enable" list does not exist, and
        // a broken file is ignored.
        store
            .set_builtin(BUILTIN_MAIL, BuiltinTarget::Project, None)
            .unwrap();
        store
            .set_builtin(BUILTIN_MAIL, BuiltinTarget::Global, Some(false))
            .unwrap();
        fs::write(request.join("official.json"), br#"{"enable": ["mail"]}"#).unwrap();
        assert!(!store.builtin_enabled(BUILTIN_MAIL));
        fs::write(request.join("official.json"), b"{broken").unwrap();
        assert!(!store.builtin_enabled(BUILTIN_MAIL));
    }

    #[test]
    fn every_official_plugin_can_now_be_switched_off() {
        let (_dir, store) = store();
        for manifest in BUILTIN_PLUGINS {
            assert!(manifest.toggleable, "{}", manifest.id);
            store
                .set_builtin(manifest.id, BuiltinTarget::Project, Some(false))
                .unwrap();
            assert!(!store.builtin_enabled(manifest.id), "{}", manifest.id);
        }
        assert!(store
            .set_builtin("no-such-plugin", BuiltinTarget::Global, Some(false))
            .is_err());
    }

    #[test]
    fn module_tools_are_declared_once_and_local_evidence_stays_core() {
        let mut seen = std::collections::BTreeSet::new();
        for manifest in BUILTIN_PLUGINS {
            for tool in manifest.tools {
                assert!(seen.insert(tool.name), "{} is declared twice", tool.name);
                for needed in tool.requires {
                    assert!(builtin_manifest(needed).is_some(), "{} needs unknown {needed}", tool.name);
                }
            }
        }
        for core in ["LibraryRetrieve", "RetrievalPlan", "RetrievalEvidence", "RetrievalLedger", "RetrievalCorpusSeal", "ProjectEvidenceSearch", "KnowledgeSearch", "WebSearch", "bash"] {
            assert!(builtin_tool(core).is_none(), "{core} must stay core");
        }
        let (plugin, search) = builtin_tool("LiteratureSearch").unwrap();
        assert_eq!(plugin.id, BUILTIN_LITERATURE);
        assert_eq!(search.retrieval, Some(ToolRetrievalRole::Discovery));
        assert_eq!(builtin_tool("LaTeXCompile").unwrap().1.output_failure, Some(OutputFailureKind::Shell));
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
    fn figures_is_on_by_default_and_switches_per_project() {
        let (dir, store) = store();
        assert!(store.builtin_enabled(BUILTIN_FIGURES));
        store
            .set_builtin(BUILTIN_FIGURES, BuiltinTarget::Project, Some(false))
            .unwrap();
        assert!(!store.builtin_enabled(BUILTIN_FIGURES));
        let other = dir.path().join("other");
        fs::create_dir_all(&other).unwrap();
        let other = PluginStore::with_user_root(&other, dir.path().join("user"));
        assert!(other.builtin_enabled(BUILTIN_FIGURES), "an override stays in its project");
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

    #[test]
    fn every_skill_tied_to_an_official_plugin_is_actually_bundled() {
        let tied = ["literature-search", "literature-screen", "literature-evidence", "latex-diagrams", "paper-compile"];
        for name in tied {
            assert!(bundled_skill_plugin(name).is_some(), "{name}");
            assert!(
                crate::BUNDLED_SKILLS.iter().any(|(bundled, _)| bundled.eq_ignore_ascii_case(name)),
                "{name} is mapped to an official plugin but is not a bundled skill"
            );
        }
        assert_eq!(bundled_skill_plugin("Literature-Search"), Some(BUILTIN_LITERATURE));
        assert_eq!(bundled_skill_plugin("mermaid-diagram"), None);
    }
}
