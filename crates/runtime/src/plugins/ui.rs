//! Declarative SomniQ UI contributions. The host owns rendering and all actions;
//! packages never receive an invoke handle, filesystem access or executable UI.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{Diagnostic, PackageFiles, PluginCapabilities, PluginStore};

const MAX_UI_REVISION: u64 = 9_007_199_254_740_991;
const MAX_UI_STATE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UiText {
    Plain(String),
    Localized(UiLocales),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiLocales {
    pub en: String,
    pub cn: String,
}

impl UiText {
    fn validate(&self, max: usize) -> Result<(), String> {
        let valid = |s: &str| !s.trim().is_empty() && s.chars().count() <= max;
        if match self {
            Self::Plain(s) => valid(s),
            Self::Localized(UiLocales { en, cn }) => valid(en) && valid(cn),
        } {
            Ok(())
        } else {
            Err(format!(
                "UI text must contain 1..{max} characters per language"
            ))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiPanel {
    pub id: String,
    pub slot: String,
    pub title: UiText,
    #[serde(default)]
    pub order: i32,
    pub widgets: Vec<UiWidget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum UiWidget {
    TodoList { id: String, title: UiText },
    Notes { id: String, title: UiText },
    AgentPlan { id: String, title: UiText },
    Text { id: String, text: UiText },
}

impl UiWidget {
    fn id(&self) -> &str {
        match self {
            Self::TodoList { id, .. }
            | Self::Notes { id, .. }
            | Self::AgentPlan { id, .. }
            | Self::Text { id, .. } => id,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UiManifest {
    manifest_version: u32,
    ui: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UiDocument {
    schema_version: u32,
    panels: Vec<UiPanel>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

pub(super) fn inspect_ui(
    files: &PackageFiles,
    manifest: &serde_json::Value,
    capabilities: &mut PluginCapabilities,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let Some(value) = manifest.get("somniq") else {
        return;
    };
    let parsed = (|| -> Result<Vec<UiPanel>, String> {
        let header: UiManifest =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        if header.manifest_version != 1 {
            return Err("Only somniq.manifestVersion 1 is supported".into());
        }
        let path = super::dsh::relative_path(&header.ui)?;
        let file = files.get(&path).ok_or("Missing somniq.ui document")?;
        let document: UiDocument =
            serde_json::from_slice(&file.bytes).map_err(|e| e.to_string())?;
        if document.schema_version != 1 || document.panels.is_empty() || document.panels.len() > 12
        {
            return Err("UI schemaVersion must be 1, with 1..12 panels".into());
        }
        let mut panels = BTreeSet::new();
        for panel in &document.panels {
            if !valid_id(&panel.id) || !panels.insert(&panel.id) {
                return Err("UI panel ids must be unique and match [A-Za-z0-9_-]{1,64}".into());
            }
            if panel.slot != "chat.sidebar" {
                return Err(format!("Unsupported UI slot: {}", panel.slot));
            }
            panel.title.validate(80)?;
            if panel.widgets.is_empty() || panel.widgets.len() > 16 {
                return Err("Each UI panel must contain 1..16 widgets".into());
            }
            let mut widgets = BTreeSet::new();
            for widget in &panel.widgets {
                if !valid_id(widget.id()) || !widgets.insert(widget.id()) {
                    return Err("UI widget ids must be valid and unique within the panel".into());
                }
                match widget {
                    UiWidget::Text { text, .. } => text.validate(4000)?,
                    UiWidget::TodoList { title, .. }
                    | UiWidget::Notes { title, .. }
                    | UiWidget::AgentPlan { title, .. } => title.validate(80)?,
                }
            }
        }
        Ok(document.panels)
    })();
    match parsed {
        Ok(panels) => capabilities.ui_panels = panels,
        Err(error) => diagnostics.push(Diagnostic::error("ui", error)),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveUiPanel {
    pub plugin_name: String,
    pub package_digest: String,
    #[serde(flatten)]
    pub panel: UiPanel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiTodo {
    pub id: String,
    pub text: String,
    pub completed: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiPanelState {
    pub revision: u64,
    pub todo_lists: BTreeMap<String, Vec<UiTodo>>,
    pub notes: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredState {
    schema_version: u32,
    plugin_name: String,
    panel_id: String,
    session_id: String,
    state: UiPanelState,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum UiAction {
    TodoAdd {
        widget_id: String,
        text: String,
    },
    TodoSetCompleted {
        widget_id: String,
        item_id: String,
        completed: bool,
    },
    TodoRemove {
        widget_id: String,
        item_id: String,
    },
    NotesSet {
        widget_id: String,
        text: String,
    },
}

impl PluginStore {
    pub fn active_ui_panels(&self) -> Result<Vec<ActiveUiPanel>, String> {
        let mut panels = vec![];
        for plugin in self
            .list()?
            .into_iter()
            .filter(|p| p.enabled && p.package.can_enable)
        {
            for panel in plugin.package.capabilities.ui_panels {
                panels.push(ActiveUiPanel {
                    plugin_name: plugin.package.name.clone(),
                    package_digest: plugin.package.digest.clone(),
                    panel,
                });
            }
        }
        // Stable ordering, as in DSH's list slots; ids are namespaced by package.
        panels.sort_by_key(|p| p.panel.order);
        Ok(panels)
    }

    fn ui_panel(&self, name: &str, panel_id: &str) -> Result<UiPanel, String> {
        let registry = self.registry()?;
        let record = registry
            .packages
            .get(name)
            .ok_or("UI plugin is not installed")?;
        let plugin = self.inspect_record(record);
        if !plugin.enabled || !plugin.package.can_enable {
            return Err("UI plugin is disabled or blocked; reload the plugin panels".into());
        }
        plugin
            .package
            .capabilities
            .ui_panels
            .into_iter()
            .find(|p| p.id == panel_id)
            .ok_or("UI panel is not declared by this plugin".into())
    }

    fn ui_state_path(
        &self,
        name: &str,
        panel_id: &str,
        session_id: &str,
    ) -> Result<PathBuf, String> {
        if session_id.trim().is_empty()
            || session_id.len() > 256
            || session_id.chars().any(char::is_control)
        {
            return Err("A valid local session id is required".into());
        }
        // Scope strings are data, never path components. The stored identity is
        // checked as well so files cannot accidentally be exchanged across scopes.
        let key = serde_json::to_vec(&(name, panel_id, session_id)).map_err(|e| e.to_string())?;
        let path = self
            .root
            .join("ui-state")
            .join(format!("{:x}.json", Sha256::digest(key)));
        for (target, directory) in [(path.parent().unwrap(), true), (path.as_path(), false)] {
            match fs::symlink_metadata(target) {
                Ok(meta)
                    if meta.file_type().is_symlink()
                        || if directory {
                            !meta.is_dir()
                        } else {
                            !meta.is_file()
                        } =>
                {
                    return Err(
                        "Plugin UI state must use regular local files and directories".into(),
                    );
                }
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(path)
    }

    fn read_ui_state(
        &self,
        path: &Path,
        name: &str,
        panel: &UiPanel,
        session: &str,
    ) -> Result<UiPanelState, String> {
        let mut state = match fs::File::open(path) {
            Ok(file) => {
                use std::io::Read;
                let mut bytes = vec![];
                file.take((MAX_UI_STATE_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() > MAX_UI_STATE_BYTES {
                    return Err("Plugin UI state exceeds 2 MiB".into());
                }
                let saved: StoredState =
                    serde_json::from_slice(&bytes).map_err(|e| format!("Plugin UI state: {e}"))?;
                if saved.schema_version != 1
                    || saved.plugin_name != name
                    || saved.panel_id != panel.id
                    || saved.session_id != session
                {
                    return Err("Plugin UI state identity does not match this panel/session".into());
                }
                saved.state
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => UiPanelState::default(),
            Err(error) => return Err(error.to_string()),
        };
        // Ignore obsolete widget data after an author revises their package.
        state.todo_lists.retain(|id, _| {
            panel
                .widgets
                .iter()
                .any(|w| matches!(w, UiWidget::TodoList { id: key, .. } if key == id))
        });
        state.notes.retain(|id, _| {
            panel
                .widgets
                .iter()
                .any(|w| matches!(w, UiWidget::Notes { id: key, .. } if key == id))
        });
        if state.revision > MAX_UI_REVISION {
            return Err("UI revision limit reached".into());
        }
        for todos in state.todo_lists.values() {
            let mut ids = BTreeSet::new();
            if todos.len() > 200
                || todos.iter().any(|t| {
                    !valid_id(&t.id)
                        || !ids.insert(&t.id)
                        || t.text.trim().is_empty()
                        || t.text.chars().count() > 500
                })
            {
                return Err("Invalid plugin Todo state".into());
            }
        }
        if state.notes.values().any(|s| s.chars().count() > 32000) {
            return Err("Plugin notes exceed 32000 characters".into());
        }
        Ok(state)
    }

    pub fn ui_state_get(
        &self,
        name: &str,
        panel_id: &str,
        session_id: &str,
    ) -> Result<UiPanelState, String> {
        self.mutate(|| {
            let panel = self.ui_panel(name, panel_id)?;
            let path = self.ui_state_path(name, panel_id, session_id)?;
            self.read_ui_state(&path, name, &panel, session_id)
        })
    }

    pub fn ui_state_update(
        &self,
        name: &str,
        panel_id: &str,
        session_id: &str,
        expected_revision: u64,
        action: UiAction,
    ) -> Result<UiPanelState, String> {
        // The same cross-process lock covers enablement, integrity validation,
        // read/modify/write and atomic publication; disabling wins before later actions.
        self.mutate(|| {
            let panel = self.ui_panel(name, panel_id)?;
            let path = self.ui_state_path(name, panel_id, session_id)?;
            let mut state = self.read_ui_state(&path, name, &panel, session_id)?;
            if state.revision != expected_revision {
                return Err(
                    "Plugin UI state changed in another window; reload before saving".into(),
                );
            }
            let next_revision = state
                .revision
                .checked_add(1)
                .filter(|r| *r <= MAX_UI_REVISION)
                .ok_or("UI revision limit reached")?;
            let (widget_id, todo) = match &action {
                UiAction::TodoAdd { widget_id, .. }
                | UiAction::TodoSetCompleted { widget_id, .. }
                | UiAction::TodoRemove { widget_id, .. } => (widget_id, true),
                UiAction::NotesSet { widget_id, .. } => (widget_id, false),
            };
            if !panel.widgets.iter().any(|w| {
                if todo {
                    matches!(w, UiWidget::TodoList { id, .. } if id == widget_id)
                } else {
                    matches!(w, UiWidget::Notes { id, .. } if id == widget_id)
                }
            }) {
                return Err("Action is not allowed for this UI widget".into());
            }
            match action {
                UiAction::TodoAdd { widget_id, text } => {
                    let text = text.trim();
                    if text.is_empty() || text.chars().count() > 500 {
                        return Err("Todo text must contain 1..500 characters".into());
                    }
                    let todos = state.todo_lists.entry(widget_id).or_default();
                    if todos.len() >= 200 {
                        return Err("A Todo list can contain at most 200 items".into());
                    }
                    todos.push(UiTodo {
                        id: format!("t{next_revision}"),
                        text: text.into(),
                        completed: false,
                    });
                }
                UiAction::TodoSetCompleted {
                    widget_id,
                    item_id,
                    completed,
                } => {
                    let todo = state
                        .todo_lists
                        .entry(widget_id)
                        .or_default()
                        .iter_mut()
                        .find(|t| t.id == item_id)
                        .ok_or("Todo item no longer exists")?;
                    todo.completed = completed;
                }
                UiAction::TodoRemove { widget_id, item_id } => {
                    let todos = state.todo_lists.entry(widget_id).or_default();
                    let index = todos
                        .iter()
                        .position(|t| t.id == item_id)
                        .ok_or("Todo item no longer exists")?;
                    todos.remove(index);
                }
                UiAction::NotesSet { widget_id, text } => {
                    if text.chars().count() > 32000 {
                        return Err("Plugin notes exceed 32000 characters".into());
                    }
                    state.notes.insert(widget_id, text);
                }
            }
            state.revision = next_revision;
            let saved = StoredState {
                schema_version: 1,
                plugin_name: name.into(),
                panel_id: panel_id.into(),
                session_id: session_id.into(),
                state: state.clone(),
            };
            fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            let bytes = serde_json::to_vec(&saved).map_err(|e| e.to_string())?;
            if bytes.len() > MAX_UI_STATE_BYTES {
                return Err("Plugin UI state exceeds 2 MiB".into());
            }
            crate::atomic_file::write_replace_unlocked(&path, &bytes).map_err(|e| e.to_string())?;
            Ok(state)
        })
    }
}
