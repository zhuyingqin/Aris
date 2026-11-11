//! Native commands delegate to the same project capability store as chat/CLI.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use runtime::plugins::{
    ActiveUiPanel, CapabilityDiff, InstalledPlugin, PluginImportPreview, PluginPreview,
    PluginStore, UiAction, UiPanelState, VersionChange,
};
use runtime::{PermissionMode, ToolError};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::blocking::off_main_thread;
use crate::projects::{current_project_path, ProjectState};

pub(crate) fn bound_store(workspace: &Path, project_path: &str) -> Result<PluginStore, String> {
    let workspace = runtime::canonicalize(workspace).map_err(|e| e.to_string())?;
    let requested = runtime::canonicalize(project_path).map_err(|e| e.to_string())?;
    if workspace != requested {
        return Err("Project changed; reload the plugin panel before continuing".into());
    }
    Ok(PluginStore::for_workspace(workspace))
}

#[tauri::command]
pub async fn plugins_list(
    projects: State<'_, ProjectState>,
    project_path: String,
) -> Result<Vec<InstalledPlugin>, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.list()).await
}

/// The package at `source`, and the upgrade it would be when its name is
/// already installed here.
#[tauri::command]
pub async fn plugins_preview(
    projects: State<'_, ProjectState>,
    project_path: String,
    source: String,
) -> Result<PluginImportPreview, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.preview_import(source)).await
}

#[tauri::command]
pub async fn plugins_install(
    projects: State<'_, ProjectState>,
    project_path: String,
    source: String,
    expected_digest: String,
) -> Result<InstalledPlugin, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.install(source, &expected_digest)).await
}

/// Replace the installed version with the previewed one, as one transaction.
#[tauri::command]
pub async fn plugins_upgrade(
    projects: State<'_, ProjectState>,
    project_path: String,
    source: String,
    expected_digest: String,
    expected_current_digest: String,
    approve: bool,
) -> Result<InstalledPlugin, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || {
        store.upgrade(source, &expected_digest, &expected_current_digest, approve)
    })
    .await
}

/// Put an earlier version of a package back. The click is the user's, so
/// `approve` keeps a running package running on the version they chose.
#[tauri::command]
pub async fn plugins_rollback(
    projects: State<'_, ProjectState>,
    project_path: String,
    name: String,
    digest: String,
    expected_current_digest: String,
    approve: bool,
) -> Result<InstalledPlugin, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.rollback(&name, &digest, &expected_current_digest, approve)).await
}

/// Every file an upgrade card's draft changes, with both sides' text.
#[tauri::command]
pub async fn plugins_draft_changes(
    projects: State<'_, ProjectState>,
    project_path: String,
    source: String,
    digest: String,
) -> Result<Vec<runtime::plugins::PackageFileChange>, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.draft_changes(source, &digest)).await
}

/// A draft panel's page, to try on the upgrade card before approving it.
#[tauri::command]
pub async fn plugins_draft_page(
    projects: State<'_, ProjectState>,
    project_path: String,
    source: String,
    digest: String,
    panel_id: String,
) -> Result<runtime::plugins::DraftPage, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.draft_page(source, &digest, &panel_id)).await
}

/// Connect to an approved package's MCP servers now, the same discovery a
/// Chat turn runs, so its card shows their real health.
#[tauri::command]
pub async fn plugins_check_mcp(
    projects: State<'_, ProjectState>,
    project_path: String,
    name: String,
) -> Result<InstalledPlugin, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    check_mcp(store, name).await
}

/// Shared by the Tauri command and the devserver route.
pub(crate) async fn check_mcp(store: PluginStore, name: String) -> Result<InstalledPlugin, String> {
    let store = std::sync::Arc::new(store);
    let servers = {
        let (store, name) = (store.clone(), name.clone());
        off_main_thread(move || store.package_mcp_servers(&name)).await?
    };
    if servers.is_empty() {
        return Err("This package has no approved MCP servers to check; enable it first".into());
    }
    let mut manager = runtime::McpServerManager::from_servers(&servers);
    // The manager records each server's outcome for the plugin page.
    let _ = manager
        .discover_tools_resilient_with_timeout(std::time::Duration::from_secs(45))
        .await;
    let _ = manager.shutdown().await;
    // A cached failure from an earlier turn would otherwise outlive the fix.
    aris_chat::clear_mcp_discovery_cache();
    off_main_thread(move || {
        store
            .list()?
            .into_iter()
            .find(|plugin| plugin.package.name == name)
            .ok_or_else(|| "Plugin is not installed".to_string())
    })
    .await
}

#[tauri::command]
pub async fn plugins_set_enabled(
    projects: State<'_, ProjectState>,
    project_path: String,
    name: String,
    enabled: bool,
) -> Result<InstalledPlugin, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.set_enabled(&name, enabled)).await
}

#[tauri::command]
pub async fn plugins_remove(
    projects: State<'_, ProjectState>,
    project_path: String,
    name: String,
) -> Result<(), String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.remove(&name)).await
}

#[tauri::command]
pub async fn plugins_ui_list(
    projects: State<'_, ProjectState>,
    project_path: String,
) -> Result<Vec<ActiveUiPanel>, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.active_ui_panels()).await
}

#[tauri::command]
pub async fn plugins_ui_state_get(
    projects: State<'_, ProjectState>,
    project_path: String,
    name: String,
    panel_id: String,
    session_id: String,
) -> Result<UiPanelState, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.ui_state_get(&name, &panel_id, &session_id)).await
}

#[tauri::command]
pub async fn plugins_ui_state_update(
    projects: State<'_, ProjectState>,
    project_path: String,
    name: String,
    panel_id: String,
    session_id: String,
    expected_revision: u64,
    action: UiAction,
) -> Result<UiPanelState, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || {
        store.ui_state_update(&name, &panel_id, &session_id, expected_revision, action)
    })
    .await
}

/// The HTML of a page panel, from the reviewed snapshot. The frontend puts it
/// in a sandboxed frame; it is never evaluated in the app's own document.
#[tauri::command]
pub async fn plugins_ui_page(
    projects: State<'_, ProjectState>,
    project_path: String,
    name: String,
    panel_id: String,
) -> Result<runtime::plugins::UiPage, String> {
    let store = bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.ui_page(&name, &panel_id)).await
}

/// Tells every view that a project's plugins changed outside the view's own
/// API calls: an agent's `PluginManager` call or a click on an approval card.
/// The frontend re-dispatches it as the `somniq:plugins-changed` window event,
/// so the Plugins page and the Chat sidebar refresh the same way they do after
/// their own changes.
pub(crate) const PLUGINS_CHANGED_EVENT: &str = "plugins-changed";

pub(crate) fn emit_plugins_changed(app: &AppHandle, plugin_root: &Path) {
    let _ = app.emit(
        PLUGINS_CHANGED_EVENT,
        json!({ "projectPath": plugin_root.to_string_lossy() }),
    );
}

// ── The `PluginManager` agent tool ─────────────────────────────────────────
//
// The same `PluginStore` operations the Plugins page calls, for an agent that
// is writing a package itself. The agent can read the rules, take a template,
// preview, install (disabled) and upgrade a draft, disable and check packages.
// It can never make a package run: enabling, upgrading a running package and
// removing all wait on a card in the Chat, and only the user's click in the
// main window (`chat_plugin_approval_respond`) writes the approval. Runs with
// nobody present (work tasks, scheduled runs, review workflows) and Plan mode
// get the read-only actions only.

pub(crate) const PLUGIN_MANAGER_TOOL: &str = "PluginManager";

/// Only this window may answer an approval card: it is the one the user is
/// sitting in front of. Other windows (screenshot overlay, popouts) and every
/// remote surface are refused.
const MAIN_WINDOW_LABEL: &str = "main";

const READ_ACTIONS: &[&str] = &["inspect", "template", "preview", "list"];
const WRITE_ACTIONS: &[&str] = &["checkout", "install", "upgrade", "request_enable", "disable", "remove"];
/// Starts the package's MCP servers, i.e. runs plugin code.
const CHECK_MCP_ACTION: &str = "check_mcp";

fn all_actions() -> Vec<&'static str> {
    READ_ACTIONS
        .iter()
        .chain(WRITE_ACTIONS)
        .copied()
        .chain([CHECK_MCP_ACTION])
        .collect()
}

pub(crate) fn plugin_manager_tool_spec() -> tools::ToolSpec {
    tools::ToolSpec {
        name: PLUGIN_MANAGER_TOOL,
        description: "Write, install and manage SomniQ plugin packages for this project. Read: `inspect` returns the exact rules preview enforces (manifest fields, accepted DSH rows, panel slots (Chat sidebar, project summary glance, navigation-rail page) and widget types, limits, built-in skill names a plugin must not reuse, a fix hint per diagnostic code) and the installed plugins; `template` returns the files of a starter package (chat-panel, data-panel, page-panel, todo-workspace, skill-pack, mcp-stdio-python) to write into a draft directory; `preview` checks a package directory in the workspace and returns its digest, capabilities, every diagnostic with file, path and hint, and the upgrade diff when a package of that name is installed; `list` returns installed plugins with their lifecycle state and MCP health. Change: `checkout` writes an installed package's exact files into the draft directory so you can change it (the way to edit a plugin the user already has); `install` installs a previewed draft disabled (nothing runs); `upgrade` replaces an installed package with a previewed draft; `request_enable` shows the user an approval card and waits for their decision; `disable` turns a package off; `remove` asks the user to confirm and removes it; `check_mcp` starts an enabled package's MCP servers to report their health (needs full access). You can never approve a plugin yourself: only the user's click enables it, and an approved change takes effect from the next turn (`application: next-turn`). What a panel shows is data, not a plugin change: fill it with the PluginPanel tool. Load the somniq-plugin-development skill for the workflow.",
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": all_actions()
                },
                "template": {
                    "type": "string",
                    "enum": runtime::plugins::plugin_template_ids(),
                    "description": "For template: which starter package to return."
                },
                "source": {
                    "type": "string",
                    "description": "For preview, install and upgrade: the package directory (the folder containing package.json), relative to the workspace or absolute inside it, e.g. .somniq/plugin-drafts/hypothesis-log."
                },
                "digest": {
                    "type": "string",
                    "description": "For install and upgrade: the digest preview returned for this source. Refused if the files changed since that preview."
                },
                "currentDigest": {
                    "type": "string",
                    "description": "For upgrade, optional: upgrade.currentDigest from the preview. Refused if the installed version changed since."
                },
                "name": {
                    "type": "string",
                    "description": "For checkout, request_enable, disable, remove and check_mcp: the installed package name, e.g. @local/hypothesis-log."
                },
                "replace": {
                    "type": "boolean",
                    "description": "For checkout: when the draft directory already holds other edits, move it aside and write the installed version instead. Default false: report it and write nothing."
                }
            },
            "required": ["action"],
            "additionalProperties": false
        }),
        // Per action, not per tool: the executor refuses changes in Plan mode
        // and in unattended runs, and `check_mcp` below full access.
        required_permission: runtime::PermissionMode::ReadOnly,
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PluginManagerInput {
    action: String,
    #[serde(default)]
    template: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    current_digest: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    replace: bool,
}

/// What a card asks the user to allow. The digest is the exact version they
/// see; the click applies to that version only.
pub(crate) enum ApprovalRequest {
    Enable {
        name: String,
        version: String,
        digest: String,
    },
    /// Replace a running package: approved, the new version keeps running.
    Upgrade {
        name: String,
        version: String,
        digest: String,
        current_digest: String,
        source: PathBuf,
    },
    Remove {
        name: String,
        version: String,
        digest: String,
    },
}

impl ApprovalRequest {
    fn kind(&self) -> &'static str {
        match self {
            Self::Enable { .. } => "enable",
            Self::Upgrade { .. } => "upgrade",
            Self::Remove { .. } => "remove",
        }
    }

    fn name(&self) -> &str {
        match self {
            Self::Enable { name, .. } | Self::Upgrade { name, .. } | Self::Remove { name, .. } => name,
        }
    }

    fn version(&self) -> &str {
        match self {
            Self::Enable { version, .. }
            | Self::Upgrade { version, .. }
            | Self::Remove { version, .. } => version,
        }
    }

    fn digest(&self) -> &str {
        match self {
            Self::Enable { digest, .. }
            | Self::Upgrade { digest, .. }
            | Self::Remove { digest, .. } => digest,
        }
    }
}

pub(crate) enum ApprovalOutcome {
    /// The change was applied; `None` once a package is removed.
    Approved(Option<InstalledPlugin>),
    Rejected,
    /// The user approved, but the change could not be applied.
    Failed(String),
}

/// A `PluginManager` call blocked on its card, keyed by tool-use id.
pub(crate) struct PluginApprovalHandle {
    session_id: String,
    plugin_root: PathBuf,
    request: ApprovalRequest,
    sender: Sender<ApprovalOutcome>,
}

pub(crate) type PluginApprovalRegistry = Arc<Mutex<HashMap<String, PluginApprovalHandle>>>;

/// One `PluginManager` call and everything about its turn it depends on.
pub(crate) struct PluginToolCall<'a> {
    pub workspace: &'a Path,
    /// The registered project the plugins belong to; differs from `workspace`
    /// only for a work task in its own worktree.
    pub plugin_root: &'a Path,
    pub session_id: &'a str,
    pub tool_use_id: &'a str,
    pub permission_mode: PermissionMode,
    /// Why nobody can click a card in this run (a work task, a review
    /// workflow); write actions are refused rather than left waiting.
    pub unattended: Option<&'static str>,
    pub approvals: &'a PluginApprovalRegistry,
    pub cancelled: &'a AtomicBool,
    /// Render the approval card. Called after the card is registered, so the
    /// UI can answer as soon as it sees it.
    pub show_card: &'a (dyn Fn(Value) + Sync),
    /// The project's plugin state changed.
    pub changed: &'a (dyn Fn() + Sync),
}

/// Run one `PluginManager` call.
pub(crate) fn run_plugin_manager_tool(
    call: &PluginToolCall<'_>,
    input: &str,
) -> Result<String, ToolError> {
    let input: PluginManagerInput = serde_json::from_str(input)
        .map_err(|error| ToolError::new(format!("invalid PluginManager input: {error}")))?;
    let action = input.action.as_str();
    if WRITE_ACTIONS.contains(&action) {
        ensure_can_change(call, action)?;
    }
    let store = PluginStore::for_workspace(call.plugin_root);
    let output = match action {
        "inspect" => json!({
            "action": "inspect",
            "contract": runtime::plugins::authoring_contract(),
            // An unreadable registry is reported, not shown as "nothing installed".
            "installed": match store.list() {
                Ok(plugins) => json!(plugins.iter().map(|plugin| json!({
                    "name": plugin.package.name,
                    "version": plugin.package.version,
                    "state": plugin.lifecycle.state,
                })).collect::<Vec<_>>()),
                Err(error) => json!({ "error": error }),
            },
        }),
        "template" => {
            let id = required(&input.template, "template", "template")?;
            let files = runtime::plugins::plugin_template(id).ok_or_else(|| {
                ToolError::new(format!(
                    "unknown template {id}; use one of {}",
                    runtime::plugins::plugin_template_ids().join(", ")
                ))
            })?;
            json!({
                "action": "template",
                "template": id,
                "draftDirectory": format!("{}/<short-name>", runtime::plugins::PLUGIN_DRAFTS_DIR),
                "files": files,
                "nextStep": "Write each file at its path under the draft directory, replace the template's names, ids, description and text with the user's plugin, then preview the directory.",
            })
        }
        "preview" => {
            let source = draft_source(call, required(&input.source, "preview", "source")?)?;
            match store.preview_import(&source) {
                Ok(preview) => preview_output(&source, &preview),
                Err(error) => json!({
                    "action": "preview",
                    "source": source.to_string_lossy(),
                    "canEnable": false,
                    "diagnostics": [runtime::plugins::preview_failure(&error)],
                }),
            }
        }
        "list" => {
            let plugins = store.list().map_err(ToolError::new)?;
            json!({
                "action": "list",
                "plugins": plugins.iter().map(installed_output).collect::<Vec<_>>(),
            })
        }
        "checkout" => checkout(&store, &input)?,
        "install" => install(call, &store, &input)?,
        "upgrade" => upgrade(call, &store, &input)?,
        "request_enable" => request_enable(call, &store, &input)?,
        "disable" => disable(call, &store, &input)?,
        "remove" => remove(call, &store, &input)?,
        CHECK_MCP_ACTION => check_mcp_action(call, &input)?,
        other => {
            return Err(ToolError::new(format!(
                "unknown PluginManager action {other}; use one of {}",
                all_actions().join(", ")
            )))
        }
    };
    serde_json::to_string_pretty(&output).map_err(|error| ToolError::new(error.to_string()))
}

fn required<'a>(
    value: &'a Option<String>,
    action: &str,
    field: &str,
) -> Result<&'a str, ToolError> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolError::new(format!("{action} requires `{field}`")))
}

fn ensure_can_change(call: &PluginToolCall<'_>, action: &str) -> Result<(), ToolError> {
    if let Some(run) = call.unattended {
        return Err(ToolError::new(format!(
            "PluginManager {action} is not available in a {run}: nobody is here to approve plugin changes. \
             Use inspect, list, preview or check_mcp, and leave the change for an interactive chat (say what you would install and why)."
        )));
    }
    if call.permission_mode == PermissionMode::ReadOnly {
        return Err(ToolError::new(format!(
            "PluginManager {action} changes this project's plugins, which read-only (Plan) mode does not allow. \
             Describe the change, or ask the user to switch the permission mode."
        )));
    }
    Ok(())
}

/// A package directory the turn can write: inside the workspace, and not the
/// plugin store itself.
fn draft_source(call: &PluginToolCall<'_>, source: &str) -> Result<PathBuf, ToolError> {
    let candidate = Path::new(source);
    let candidate = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        call.workspace.join(candidate)
    };
    let resolved = runtime::canonicalize(&candidate).map_err(|error| {
        ToolError::new(format!("cannot open package directory {}: {error}", candidate.display()))
    })?;
    let workspace =
        runtime::canonicalize(call.workspace).map_err(|error| ToolError::new(error.to_string()))?;
    if !resolved.starts_with(&workspace) {
        return Err(ToolError::new(format!(
            "PluginManager only reads packages inside the workspace ({}); copy the package into {} first",
            workspace.display(),
            runtime::plugins::PLUGIN_DRAFTS_DIR
        )));
    }
    let plugin_root = runtime::canonicalize(call.plugin_root)
        .unwrap_or_else(|_| call.plugin_root.to_path_buf());
    for root in [&workspace, &plugin_root] {
        if resolved.starts_with(root.join(".somniq").join("plugins")) {
            return Err(ToolError::new(
                "that is SomniQ's plugin store, not a package; use the package's own directory",
            ));
        }
    }
    Ok(resolved)
}

fn installed(store: &PluginStore, name: &str) -> Result<InstalledPlugin, ToolError> {
    store
        .list()
        .map_err(ToolError::new)?
        .into_iter()
        .find(|plugin| plugin.package.name == name)
        .ok_or_else(|| {
            ToolError::new(format!(
                "{name} is not installed in this project; `list` shows what is"
            ))
        })
}

/// The installed version of a package, written into the draft directory so
/// a change starts from exactly what runs.
fn checkout(
    store: &PluginStore,
    input: &PluginManagerInput,
) -> Result<Value, ToolError> {
    let name = required(&input.name, "checkout", "name")?;
    // The draft lives in the project the plugins belong to.
    let out = store.checkout(name, input.replace).map_err(ToolError::new)?;
    let next = match out.status {
        "exists" => "The draft directory already holds other edits (draftDigest), so nothing was written. If they are yours from this conversation, keep editing them; to start over from the installed version, call checkout again with replace: true (the old draft is moved aside, not deleted).",
        _ => "Edit the files in this directory for the change the user asked for, raise the version in package.json, preview it, fix every diagnostic, then upgrade. The user approves on a card that lets them try the new page and see every changed file; until then the installed version keeps running unchanged.",
    };
    Ok(json!({
        "action": "checkout",
        "name": name,
        "status": out.status,
        "draftDirectory": out.directory,
        "version": out.version,
        "digest": out.digest,
        "files": out.files,
        "draftDigest": out.draft_digest,
        "movedAside": out.moved_aside,
        "nextStep": next,
    }))
}

fn install(
    call: &PluginToolCall<'_>,
    store: &PluginStore,
    input: &PluginManagerInput,
) -> Result<Value, ToolError> {
    let source = draft_source(call, required(&input.source, "install", "source")?)?;
    let digest = required(&input.digest, "install", "digest")?;
    let plugin = store.install(&source, digest).map_err(ToolError::new)?;
    (call.changed)();
    let next = if plugin.package.can_enable {
        "Installed disabled: nothing from it runs yet. Call request_enable with this name so the user can approve it."
    } else {
        "Installed disabled, but its diagnostics block enabling. Fix them in the draft, preview, then upgrade."
    };
    Ok(change_output("install", &plugin, "none", next))
}

fn upgrade(
    call: &PluginToolCall<'_>,
    store: &PluginStore,
    input: &PluginManagerInput,
) -> Result<Value, ToolError> {
    let source = draft_source(call, required(&input.source, "upgrade", "source")?)?;
    let digest = required(&input.digest, "upgrade", "digest")?;
    let preview = store.preview_import(&source).map_err(ToolError::new)?;
    if preview.package.digest != digest {
        return Err(ToolError::new(
            "The draft changed after preview; preview it again and pass the new digest",
        ));
    }
    let plan = preview.upgrade.as_ref().ok_or_else(|| {
        ToolError::new(format!(
            "{} is not installed in this project; use install",
            preview.package.name
        ))
    })?;
    if input
        .current_digest
        .as_deref()
        .is_some_and(|expected| expected != plan.current_digest)
    {
        return Err(ToolError::new(
            "The installed version changed after preview; preview the upgrade again",
        ));
    }
    if plan.change == VersionChange::Identical {
        return Ok(json!({
            "action": "upgrade",
            "name": preview.package.name,
            "version": preview.package.version,
            "digest": preview.package.digest,
            "application": "none",
            "nextStep": "This is exactly the installed version; there is nothing to upgrade.",
        }));
    }
    if !plan.current_enabled {
        let plugin = store
            .upgrade(&source, digest, &plan.current_digest, false)
            .map_err(ToolError::new)?;
        (call.changed)();
        let next = if plugin.package.can_enable {
            "Upgraded and disabled. Call request_enable so the user can approve this version."
        } else {
            "Upgraded and disabled, but this version's diagnostics block enabling. Fix them in the draft, preview, then upgrade again."
        };
        return Ok(change_output("upgrade", &plugin, "none", next));
    }
    // The installed version is running. Replacing it is approved as one step,
    // so an approved upgrade never stops the package in between and a
    // rejected one leaves it exactly as it was.
    if !preview.package.can_enable {
        return Err(blocked("upgrade", &preview.package));
    }
    let mut card = approval_card(
        "upgrade",
        &preview.package,
        Some((&plan.current_version, &plan.diff)),
    );
    // What the user reviews besides capabilities: each changed file, and the
    // new version's pages to try before the click.
    card["files"] = json!(store
        .draft_changes(&source, &preview.package.digest)
        .unwrap_or_default()
        .iter()
        .map(|file| json!({
            "path": file.path,
            "change": file.change,
            "binary": file.binary,
            "beforeBytes": file.before_bytes,
            "afterBytes": file.after_bytes,
        }))
        .collect::<Vec<_>>());
    card["pagePanels"] = json!(preview
        .package
        .capabilities
        .ui_panels
        .iter()
        .filter(|panel| panel.page.is_some())
        .map(|panel| json!({ "id": panel.id, "slot": panel.slot, "title": panel.title }))
        .collect::<Vec<_>>());
    approval_result(
        call,
        "upgrade",
        ApprovalRequest::Upgrade {
            name: preview.package.name.clone(),
            version: preview.package.version.clone(),
            digest: preview.package.digest.clone(),
            current_digest: plan.current_digest.clone(),
            source,
        },
        card,
        "Approved: the new version replaces the running one from the next turn. End this turn now; verify in the next one.",
    )
}

fn request_enable(
    call: &PluginToolCall<'_>,
    store: &PluginStore,
    input: &PluginManagerInput,
) -> Result<Value, ToolError> {
    let name = required(&input.name, "request_enable", "name")?;
    let plugin = installed(store, name)?;
    if plugin.enabled {
        return Ok(change_output(
            "request_enable",
            &plugin,
            "none",
            "Already approved and enabled; every new turn gets it.",
        ));
    }
    if !plugin.package.can_enable {
        return Err(blocked("request_enable", &plugin.package));
    }
    let card = approval_card("enable", &plugin.package, None);
    approval_result(
        call,
        "request_enable",
        ApprovalRequest::Enable {
            name: plugin.package.name.clone(),
            version: plugin.package.version.clone(),
            digest: plugin.package.digest.clone(),
        },
        card,
        "Approved: the plugin is available from the next turn. End this turn now and tell the user what to check; verify it in the next turn.",
    )
}

fn disable(
    call: &PluginToolCall<'_>,
    store: &PluginStore,
    input: &PluginManagerInput,
) -> Result<Value, ToolError> {
    let name = required(&input.name, "disable", "name")?;
    let plugin = store.set_enabled(name, false).map_err(ToolError::new)?;
    (call.changed)();
    Ok(change_output(
        "disable",
        &plugin,
        "next-turn",
        "Disabled and its approval withdrawn; from the next turn it no longer runs. Turning it back on needs request_enable.",
    ))
}

fn remove(
    call: &PluginToolCall<'_>,
    store: &PluginStore,
    input: &PluginManagerInput,
) -> Result<Value, ToolError> {
    let name = required(&input.name, "remove", "name")?;
    let plugin = installed(store, name)?;
    let card = approval_card("remove", &plugin.package, None);
    approval_result(
        call,
        "remove",
        ApprovalRequest::Remove {
            name: plugin.package.name.clone(),
            version: plugin.package.version.clone(),
            digest: plugin.package.digest.clone(),
        },
        card,
        "Removed from this project; from the next turn it no longer runs. Its draft directory is untouched.",
    )
}

fn check_mcp_action(
    call: &PluginToolCall<'_>,
    input: &PluginManagerInput,
) -> Result<Value, ToolError> {
    if !matches!(
        call.permission_mode,
        PermissionMode::DangerFullAccess | PermissionMode::Allow
    ) {
        return Err(ToolError::new(
            "check_mcp starts the package's MCP servers, which runs plugin code and needs full access. \
             Ask the user to press Check connection on the Plugins page, or to switch to full access.",
        ));
    }
    let name = required(&input.name, CHECK_MCP_ACTION, "name")?;
    let store = PluginStore::for_workspace(call.plugin_root);
    let plugin = tauri::async_runtime::block_on(check_mcp(store, name.to_string()))
        .map_err(ToolError::new)?;
    (call.changed)();
    Ok(json!({
        "action": CHECK_MCP_ACTION,
        "name": plugin.package.name,
        "version": plugin.package.version,
        "lifecycle": plugin.lifecycle,
        "application": "none",
        "nextStep": "lifecycle.mcpServers holds each server's health from this real connection. In a turn that has the plugin, call its mcp__ tools to verify them.",
    }))
}

/// Diagnostics that stop a package from being enabled are a real failure of
/// the call, not a decision: the agent has to fix the package first.
fn blocked(action: &str, package: &PluginPreview) -> ToolError {
    ToolError::new(
        serde_json::to_string_pretty(&json!({
            "action": action,
            "name": package.name,
            "digest": package.digest,
            "application": "blocked",
            "diagnostics": package.diagnostics,
            "nextStep": "Fix every diagnostic (each has file, path and hint) in the draft, preview, then upgrade.",
        }))
        .unwrap_or_default(),
    )
}

fn change_output(action: &str, plugin: &InstalledPlugin, application: &str, next: &str) -> Value {
    json!({
        "action": action,
        "name": plugin.package.name,
        "version": plugin.package.version,
        "digest": plugin.package.digest,
        "status": plugin.status,
        "lifecycle": plugin.lifecycle,
        "application": application,
        "nextStep": next,
        "diagnostics": plugin.package.diagnostics,
    })
}

/// What the user decides on. Built here, never from model input, so the card
/// shows what the click would actually allow.
fn approval_card(
    kind: &str,
    package: &PluginPreview,
    current: Option<(&String, &CapabilityDiff)>,
) -> Value {
    json!({
        "kind": kind,
        "name": package.name,
        "version": package.version,
        "description": package.description,
        "digest": package.digest,
        "source": package.source,
        "capabilities": capabilities_output(&package.capabilities),
        "currentVersion": current.map(|(version, _)| version),
        "diff": current.map(|(_, diff)| diff),
        // Nothing this computer would start, or the keys it passes, changes:
        // the card can be one line.
        "executionUnchanged": current.map(|(_, diff)| {
            diff.commands.added.is_empty()
                && diff.commands.removed.is_empty()
                && diff.env_keys.added.is_empty()
                && diff.env_keys.removed.is_empty()
                // A page's code can change with nothing declared changing.
                && !package.capabilities.ui_panels.iter().any(|panel| panel.page.is_some())
        }),
        // Approvals are this computer's; a phone shows the card without buttons.
        "approveOn": "desktop",
    })
}

fn approval_result(
    call: &PluginToolCall<'_>,
    action: &str,
    request: ApprovalRequest,
    card: Value,
    approved_next: &str,
) -> Result<Value, ToolError> {
    let (name, digest) = (request.name().to_string(), request.digest().to_string());
    match await_approval(call, request, card)? {
        ApprovalOutcome::Approved(Some(plugin)) => {
            Ok(change_output(action, &plugin, "next-turn", approved_next))
        }
        ApprovalOutcome::Approved(None) => Ok(json!({
            "action": action,
            "name": name,
            "digest": digest,
            "status": "removed",
            "application": "next-turn",
            "nextStep": approved_next,
        })),
        // A decision, not a failure: it must not count toward runaway guards.
        ApprovalOutcome::Rejected => Ok(json!({
            "action": action,
            "name": name,
            "digest": digest,
            "application": "rejected",
            "nextStep": "The user declined. Do not ask again in this turn; explain what the plugin would do and ask what they want changed.",
        })),
        ApprovalOutcome::Failed(error) => Err(ToolError::new(format!(
            "The user approved, but the change could not be applied: {error}"
        ))),
    }
}

/// Register the card, show it, and wait for the user's decision. Mirrors the
/// permission prompt: poll so a stopped turn gives up instead of hanging.
fn await_approval(
    call: &PluginToolCall<'_>,
    request: ApprovalRequest,
    card: Value,
) -> Result<ApprovalOutcome, ToolError> {
    if call.tool_use_id.is_empty() {
        return Err(ToolError::new(
            "PluginManager cannot ask for approval: the tool call has no id to answer",
        ));
    }
    let (sender, receiver) = mpsc::channel();
    call.approvals
        .lock()
        .map_err(|_| ToolError::new("plugin approval registry is unavailable"))?
        .insert(
            call.tool_use_id.to_string(),
            PluginApprovalHandle {
                session_id: call.session_id.to_string(),
                plugin_root: call.plugin_root.to_path_buf(),
                request,
                sender,
            },
        );
    (call.show_card)(card);
    let cleanup = || {
        if let Ok(mut pending) = call.approvals.lock() {
            pending.remove(call.tool_use_id);
        }
    };
    loop {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(outcome) => {
                cleanup();
                return Ok(outcome);
            }
            Err(RecvTimeoutError::Timeout) => {
                if call.cancelled.load(Ordering::SeqCst) || runtime::is_interrupted() {
                    cleanup();
                    return Err(ToolError::interrupted_by_user());
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                cleanup();
                return Err(ToolError::new("the approval card was dismissed"));
            }
        }
    }
}

/// What answering a card did, for the command to record and announce.
pub(crate) struct ApprovalResponse {
    pub session_id: String,
    /// The `plugin_approval` session event: who decided what about which bytes.
    pub audit: Value,
    /// The project whose plugins changed, when they did.
    pub changed_root: Option<PathBuf>,
    /// The user approved but applying failed; the card shows it.
    pub error: Option<String>,
}

/// Apply the user's decision on a card. The only caller is the main window's
/// click, through [`chat_plugin_approval_respond`]; nothing a model can call
/// reaches this.
pub(crate) fn respond_to_plugin_approval(
    registry: &PluginApprovalRegistry,
    window_label: &str,
    tool_use_id: &str,
    digest: &str,
    approve: bool,
) -> Result<ApprovalResponse, String> {
    if window_label != MAIN_WINDOW_LABEL {
        return Err("Plugins can only be approved in SomniQ's main window.".into());
    }
    let handle = {
        let mut pending = registry
            .lock()
            .map_err(|_| "plugin approval state poisoned".to_string())?;
        match pending.get(tool_use_id) {
            None => return Err("This plugin request is no longer waiting for an answer.".into()),
            // The card is left waiting: a mismatched answer is not a decision.
            Some(handle) if handle.request.digest() != digest => {
                return Err("This card no longer matches the package it asks about.".into())
            }
            Some(_) => pending
                .remove(tool_use_id)
                .ok_or("This plugin request is no longer waiting for an answer.")?,
        }
    };
    let PluginApprovalHandle {
        session_id,
        plugin_root,
        request,
        sender,
    } = handle;
    let mut audit = json!({
        "sessionId": session_id,
        "toolUseId": tool_use_id,
        "kind": request.kind(),
        "name": request.name(),
        "version": request.version(),
        "digest": request.digest(),
        "decision": if approve { "approve" } else { "reject" },
    });
    if !approve {
        let _ = sender.send(ApprovalOutcome::Rejected);
        return Ok(ApprovalResponse {
            session_id,
            audit,
            changed_root: None,
            error: None,
        });
    }
    let store = PluginStore::for_workspace(&plugin_root);
    let applied = match &request {
        ApprovalRequest::Enable { name, digest, .. } => {
            store.enable_approved(name, digest).map(Some)
        }
        ApprovalRequest::Upgrade {
            source,
            digest,
            current_digest,
            ..
        } => store.upgrade(source, digest, current_digest, true).map(Some),
        ApprovalRequest::Remove { name, digest, .. } => {
            store.remove_confirmed(name, digest).map(|()| None)
        }
    };
    let (outcome, changed_root, error) = match applied {
        Ok(plugin) => (ApprovalOutcome::Approved(plugin), Some(plugin_root), None),
        Err(error) => (ApprovalOutcome::Failed(error.clone()), None, Some(error)),
    };
    audit["result"] = json!(if error.is_none() { "applied" } else { "failed" });
    if let Some(error) = &error {
        audit["error"] = json!(error);
    }
    // The tool may have stopped waiting (the turn was stopped); the change the
    // user clicked for stands either way.
    let _ = sender.send(outcome);
    Ok(ApprovalResponse {
        session_id,
        audit,
        changed_root,
        error,
    })
}

/// The user's click on a plugin approval card in the Chat.
#[tauri::command]
pub async fn chat_plugin_approval_respond(
    app: AppHandle,
    window: tauri::Window,
    chat: State<'_, crate::engine::ChatState>,
    tool_use_id: String,
    digest: String,
    approve: bool,
) -> Result<(), String> {
    let registry = chat.plugin_approvals();
    let label = window.label().to_string();
    let response = off_main_thread(move || {
        let response =
            respond_to_plugin_approval(&registry, &label, &tool_use_id, &digest, approve)?;
        crate::chat_events::record_event(
            &response.session_id,
            "plugin_approval",
            response.audit.clone(),
        );
        Ok(response)
    })
    .await?;
    if let Some(root) = &response.changed_root {
        emit_plugins_changed(&app, root);
    }
    match response.error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// What a package would contribute. MCP environment variables are listed by
/// name only: their values may be credentials and must not enter the
/// conversation.
fn capabilities_output(capabilities: &runtime::plugins::PluginCapabilities) -> Value {
    json!({
        "skills": capabilities.skills,
        "uiPanels": capabilities.ui_panels.iter().map(|panel| json!({
            "id": panel.id,
            "slot": panel.slot,
            "icon": panel.icon,
            "title": panel.title,
            "widgets": panel.widgets.len(),
            // The panel runs the package's own HTML and JavaScript (sandboxed).
            "page": panel.page.is_some(),
            "dataPanel": panel.data_panel,
        })).collect::<Vec<_>>(),
        "mcpServers": capabilities.mcp_servers.iter().map(|server| json!({
            "name": server.name,
            "command": server.command,
            "args": server.args,
            "envKeys": server.env.keys().collect::<Vec<_>>(),
            "requestTimeoutSecs": server.request_timeout_secs,
        })).collect::<Vec<_>>(),
    })
}

fn preview_output(source: &Path, preview: &PluginImportPreview) -> Value {
    let package = &preview.package;
    let clean = package.can_enable && package.diagnostics.is_empty();
    json!({
        "action": "preview",
        "source": source.to_string_lossy(),
        "name": package.name,
        "version": package.version,
        "description": package.description,
        "digest": package.digest,
        "canEnable": package.can_enable,
        "capabilities": capabilities_output(&package.capabilities),
        "diagnostics": package.diagnostics,
        "upgrade": preview.upgrade,
        "nextStep": match (clean, preview.upgrade.is_some()) {
            (false, _) => "Fix every diagnostic (each has file, path and hint) and preview again.",
            (true, false) => "Ready. Call install with this source and digest, then request_enable.",
            (true, true) => "Ready. A version is installed: call upgrade with this source and digest.",
        },
    })
}

fn installed_output(plugin: &InstalledPlugin) -> Value {
    let package = &plugin.package;
    json!({
        "name": package.name,
        "version": package.version,
        "description": package.description,
        "source": package.source,
        "digest": package.digest,
        "enabled": plugin.enabled,
        "status": plugin.status,
        "lifecycle": plugin.lifecycle,
        "capabilities": capabilities_output(&package.capabilities),
        "diagnostics": package.diagnostics,
    })
}

// ── The `PluginPanel` agent tool ───────────────────────────────────────────
//
// The other half of a declarative panel: the package says what the panel
// looks like, the agent says what is in it. Every write is one widget's value,
// checked against that widget's shape by the same store the panel's own
// commands use. This is data, not a plugin change: nothing is installed,
// enabled or run, so no approval card is involved and unattended runs may
// write too (a scheduled run filling a project board is the point).

pub(crate) const PLUGIN_PANEL_TOOL: &str = "PluginPanel";

/// Tells open panels that an agent wrote one of them.
pub(crate) const PLUGIN_PANEL_CHANGED_EVENT: &str = "plugin-panel-changed";

pub(crate) fn emit_plugin_panel_changed(app: &AppHandle, plugin_root: &Path, change: &PanelChange) {
    let _ = app.emit(
        PLUGIN_PANEL_CHANGED_EVENT,
        json!({
            "projectPath": plugin_root.to_string_lossy(),
            "pluginName": change.plugin,
            "panelId": change.panel,
        }),
    );
}

/// The panel a `PluginPanel` write changed.
pub(crate) struct PanelChange {
    pub plugin: String,
    pub panel: String,
}

pub(crate) fn plugin_panel_tool_spec() -> tools::ToolSpec {
    tools::ToolSpec {
        name: PLUGIN_PANEL_TOOL,
        description: "Read and fill the panels that enabled plugins add to this project: tabs in the Chat sidebar and pages in the navigation rail (`slot`). `list` returns every panel with its scope and widgets: each widget's type, title, who fills it, and for a widget you can write, `value`: the exact JSON shape it takes. `read` returns what a panel holds now. `write` replaces the whole value of one widget (a table's rows, metric tiles, a list, Markdown, a progress bar, a chart's series, a to-do list, notes); to change part of it, read first and write the full new value. A session-scoped panel belongs to this conversation; a project-scoped panel is one board every conversation of the project shares. Writes are data only: they never install, enable or run anything, and the user sees them in the panel at once. Use it when the user asks to update, fill or refresh a plugin panel, or when a panel's button or form sent you here.",
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["list", "read", "write"] },
                "plugin": {
                    "type": "string",
                    "description": "For read and write: the package name from list, e.g. @local/experiment-board."
                },
                "panel": { "type": "string", "description": "For read and write: the panel id from list." },
                "widget": { "type": "string", "description": "For write: the widget id from list." },
                "value": {
                    "description": "For write: the widget's new value, as JSON in the shape list gives for it (not a JSON-encoded string)."
                }
            },
            "required": ["action"],
            "additionalProperties": false
        }),
        // Per action: the executor refuses `write` in read-only (Plan) mode.
        required_permission: PermissionMode::ReadOnly,
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PluginPanelInput {
    action: String,
    #[serde(default)]
    plugin: Option<String>,
    #[serde(default)]
    panel: Option<String>,
    #[serde(default)]
    widget: Option<String>,
    #[serde(default)]
    value: Option<Value>,
}

fn panel_widgets(panel: &runtime::plugins::UiPanel) -> Vec<Value> {
    // The declaration as written (title, columns, fields, action), plus what
    // the agent needs to know to write it.
    let contract = runtime::plugins::authoring_contract();
    panel
        .widgets
        .iter()
        .map(|widget| {
            let mut entry = serde_json::to_value(widget).unwrap_or_default();
            let filled_by = contract
                .ui
                .widgets
                .iter()
                .find(|rule| rule.kind == widget.type_name())
                .map(|rule| rule.filled_by);
            entry["filledBy"] = json!(filled_by);
            entry["writable"] = json!(widget.data_shape().is_some());
            if let Some(shape) = widget.data_shape() {
                entry["value"] = json!(shape);
            }
            entry
        })
        .collect()
}

/// Run one `PluginPanel` call. Returns the output and, for a write, the panel
/// it changed so the caller can tell open views.
pub(crate) fn run_plugin_panel_tool(
    plugin_root: &Path,
    session_id: &str,
    permission_mode: PermissionMode,
    input: &str,
) -> Result<(String, Option<PanelChange>), ToolError> {
    let input: PluginPanelInput = serde_json::from_str(input)
        .map_err(|error| ToolError::new(format!("invalid PluginPanel input: {error}")))?;
    let store = PluginStore::for_workspace(plugin_root);
    let action = input.action.as_str();
    let mut change = None;
    let output = match action {
        "list" => {
            let panels = store.active_ui_panels().map_err(ToolError::new)?;
            json!({
                "action": "list",
                "panels": panels.iter().map(|active| json!({
                    "plugin": active.plugin_name,
                    "panel": active.panel.id,
                    "title": active.panel.title,
                    "slot": active.panel.slot,
                    "scope": active.panel.scope,
                    "page": active.panel.page,
                    // This panel shows that panel's data: read and write that one.
                    "dataPanel": active.panel.data_panel,
                    "widgets": panel_widgets(&active.panel),
                })).collect::<Vec<_>>(),
                "note": if panels.is_empty() {
                    "No enabled plugin adds a panel to this project. A panel comes from a plugin package (somniq.ui); the somniq-plugin-development skill covers writing one."
                } else {
                    "Write one widget at a time with action write; each write replaces that widget's whole value."
                },
            })
        }
        "read" => {
            let plugin = required(&input.plugin, "read", "plugin")?;
            let panel_id = required(&input.panel, "read", "panel")?;
            let panel = store.ui_panel(plugin, panel_id).map_err(ToolError::new)?;
            let state = store
                .ui_state_get(plugin, panel_id, session_id)
                .map_err(ToolError::new)?;
            let values: serde_json::Map<String, Value> = panel
                .widgets
                .iter()
                .filter(|widget| widget.data_shape().is_some())
                .map(|widget| {
                    let id = widget.id();
                    let value = state
                        .todo_lists
                        .get(id)
                        .map(|todos| json!(todos))
                        .or_else(|| state.notes.get(id).map(|text| json!(text)))
                        .or_else(|| state.data.get(id).cloned())
                        .unwrap_or(Value::Null);
                    (id.to_string(), value)
                })
                .collect();
            json!({
                "action": "read",
                "plugin": plugin,
                "panel": panel_id,
                "scope": panel.scope,
                "revision": state.revision,
                // null: nothing has been written to that widget yet.
                "values": values,
            })
        }
        "write" => {
            if permission_mode == PermissionMode::ReadOnly {
                return Err(ToolError::new(
                    "PluginPanel write changes what a panel shows, which read-only (Plan) mode does not allow. \
                     Describe the update, or ask the user to switch the permission mode.",
                ));
            }
            let plugin = required(&input.plugin, "write", "plugin")?;
            let panel_id = required(&input.panel, "write", "panel")?;
            let widget = required(&input.widget, "write", "widget")?;
            let value = input
                .value
                .clone()
                .ok_or_else(|| ToolError::new("write requires `value`"))?;
            let state = store
                .ui_widget_set(plugin, panel_id, session_id, widget, value)
                .map_err(|error| {
                    ToolError::new(format!(
                        "{error}. Call PluginPanel list for this project's panels, widget ids and value shapes."
                    ))
                })?;
            change = Some(PanelChange {
                plugin: plugin.to_string(),
                panel: panel_id.to_string(),
            });
            json!({
                "action": "write",
                "plugin": plugin,
                "panel": panel_id,
                "widget": widget,
                "revision": state.revision,
                "shown": "The panel shows the new value now.",
            })
        }
        other => {
            return Err(ToolError::new(format!(
                "unknown PluginPanel action {other}; use list, read or write"
            )))
        }
    };
    let text = serde_json::to_string_pretty(&output).map_err(|error| ToolError::new(error.to_string()))?;
    Ok((text, change))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, file: &str, content: &str) {
        let path = dir.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    /// One turn's view of the tool: its workspace, mode, cards and changes.
    struct Turn {
        workspace: PathBuf,
        mode: PermissionMode,
        unattended: Option<&'static str>,
        approvals: PluginApprovalRegistry,
        cancelled: AtomicBool,
        cards: Mutex<Vec<(String, Value)>>,
        changes: std::sync::atomic::AtomicUsize,
    }

    impl Turn {
        fn new(workspace: &Path) -> Self {
            std::fs::create_dir_all(workspace).unwrap();
            Self {
                workspace: workspace.to_path_buf(),
                mode: PermissionMode::DangerFullAccess,
                unattended: None,
                approvals: Arc::default(),
                cancelled: AtomicBool::new(false),
                cards: Mutex::default(),
                changes: Default::default(),
            }
        }

        fn call_with_id(&self, id: &str, input: Value) -> Result<Value, String> {
            let show_card = |card: Value| self.cards.lock().unwrap().push((id.to_string(), card));
            let changed = || {
                self.changes.fetch_add(1, Ordering::SeqCst);
            };
            let call = PluginToolCall {
                workspace: &self.workspace,
                plugin_root: &self.workspace,
                session_id: "session-1",
                tool_use_id: id,
                permission_mode: self.mode,
                unattended: self.unattended,
                approvals: &self.approvals,
                cancelled: &self.cancelled,
                show_card: &show_card,
                changed: &changed,
            };
            run_plugin_manager_tool(&call, &input.to_string())
                .map(|text| serde_json::from_str(&text).unwrap())
                .map_err(|error| error.to_string())
        }

        fn call(&self, input: Value) -> Result<Value, String> {
            self.call_with_id("tool-1", input)
        }

        /// Wait until the call with `id` shows its card.
        fn card(&self, id: &str) -> Value {
            for _ in 0..500 {
                if let Some((_, card)) = self.cards.lock().unwrap().iter().find(|(card_id, _)| card_id == id) {
                    return card.clone();
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("no approval card for {id}");
        }

        fn respond(&self, id: &str, digest: &str, approve: bool) -> Result<ApprovalResponse, String> {
            respond_to_plugin_approval(&self.approvals, MAIN_WINDOW_LABEL, id, digest, approve)
        }

        fn plugin(&self, name: &str) -> Option<InstalledPlugin> {
            PluginStore::for_workspace(&self.workspace)
                .list()
                .unwrap()
                .into_iter()
                .find(|plugin| plugin.package.name == name)
        }

        /// Write a template into a draft and preview it.
        fn draft(&self, template: &str, dir: &str) -> Value {
            let draft = self.workspace.join(dir);
            for file in runtime::plugins::plugin_template(template).unwrap() {
                write(&draft, file.path, &file.content);
            }
            self.call(json!({"action": "preview", "source": dir})).unwrap()
        }

        /// Draft, install and enable the way a user would on the Plugins page.
        fn installed_and_enabled(&self, template: &str, dir: &str) -> Value {
            let preview = self.draft(template, dir);
            let store = PluginStore::for_workspace(&self.workspace);
            store.install(self.workspace.join(dir), preview["digest"].as_str().unwrap()).unwrap();
            store.set_enabled(preview["name"].as_str().unwrap(), true).unwrap();
            preview
        }
    }

    /// Snapshots and approvals go to the test's own config dir.
    struct ConfigRoot {
        previous: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl ConfigRoot {
        fn set(path: &Path) -> Self {
            let lock = crate::test_env_lock()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let previous = std::env::var_os("ARIS_CONFIG_ROOT");
            std::env::set_var("ARIS_CONFIG_ROOT", path);
            Self { previous, _lock: lock }
        }
    }

    impl Drop for ConfigRoot {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("ARIS_CONFIG_ROOT", value),
                None => std::env::remove_var("ARIS_CONFIG_ROOT"),
            }
        }
    }

    #[test]
    fn the_plugin_panel_tool_lists_fills_and_reads_the_shipped_board() {
        let temp = tempfile::tempdir().unwrap();
        let _config = ConfigRoot::set(&temp.path().join("config"));
        let turn = Turn::new(&temp.path().join("project"));
        let panel = |session: &str, mode: PermissionMode, input: Value| {
            run_plugin_panel_tool(&turn.workspace, session, mode, &input.to_string())
                .map(|(text, change)| {
                    (serde_json::from_str::<Value>(&text).unwrap(), change.map(|c| (c.plugin, c.panel)))
                })
                .map_err(|error| error.to_string())
        };
        let full = PermissionMode::DangerFullAccess;

        // No panel yet: the tool says where panels come from.
        let (empty, _) = panel("s1", full, json!({"action": "list"})).unwrap();
        assert_eq!(empty["panels"], json!([]));
        assert!(empty["note"].as_str().unwrap().contains("somniq-plugin-development"));

        let name = turn.installed_and_enabled("data-panel", ".somniq/plugin-drafts/board")["name"]
            .as_str()
            .unwrap()
            .to_string();
        let (list, change) = panel("s1", full, json!({"action": "list"})).unwrap();
        assert!(change.is_none());
        let board = &list["panels"][0];
        assert_eq!(board["plugin"], name);
        assert_eq!(board["scope"], "project");
        let widgets = board["widgets"].as_array().unwrap();
        let id = board["panel"].as_str().unwrap();
        // Every widget the agent can write comes with the shape it takes;
        // forms and buttons are declared, not written.
        for widget in widgets {
            let writable = widget["writable"].as_bool().unwrap();
            assert_eq!(writable, widget["value"].is_string(), "{widget}");
            assert_eq!(writable, !matches!(widget["type"].as_str().unwrap(), "form" | "button" | "text" | "agent-plan"));
        }
        let table = widgets.iter().find(|w| w["type"] == "table").unwrap();
        let key = table["columns"][0]["key"].as_str().unwrap();
        let write = |session: &str, mode, value: Value| {
            panel(session, mode, json!({"action": "write", "plugin": name, "panel": id, "widget": table["id"], "value": value}))
        };

        // Plan mode reads but does not write.
        let refused = write("s1", PermissionMode::ReadOnly, json!([{ key: "run-1" }])).unwrap_err();
        assert!(refused.contains("read-only"), "{refused}");
        let (read, _) = panel("s1", PermissionMode::ReadOnly, json!({"action": "read", "plugin": name, "panel": id})).unwrap();
        assert_eq!(read["revision"], 0);
        assert_eq!(read["values"][table["id"].as_str().unwrap()], Value::Null);

        // A value outside the widget's shape is refused with the way back.
        let wrong = write("s1", full, json!([{ "not-a-column": 1 }])).unwrap_err();
        assert!(wrong.contains("PluginPanel list"), "{wrong}");
        let (written, change) = write("s1", full, json!([{ key: "run-1" }])).unwrap();
        assert_eq!(written["revision"], 1);
        assert_eq!(change, Some((name.clone(), id.to_string())));
        // A project board: another conversation reads the same rows.
        let (read, _) = panel("s2", full, json!({"action": "read", "plugin": name, "panel": id})).unwrap();
        assert_eq!(read["values"][table["id"].as_str().unwrap()], json!([{ key: "run-1" }]));

        for input in [
            json!({"action": "write", "plugin": name, "panel": id, "widget": table["id"]}),
            json!({"action": "read", "plugin": name}),
            json!({"action": "read", "plugin": "@local/none", "panel": id}),
            json!({"action": "enable", "plugin": name}),
            json!({"action": "list", "approve": true}),
        ] {
            assert!(panel("s1", full, input.clone()).is_err(), "{input}");
        }
    }

    #[test]
    fn the_plugin_manager_tool_takes_a_template_from_draft_to_clean_preview() {
        let temp = tempfile::tempdir().unwrap();
        let _config = ConfigRoot::set(&temp.path().join("config"));
        let turn = Turn::new(&temp.path().join("project"));

        let inspect = turn.call(json!({"action": "inspect"})).unwrap();
        assert_eq!(inspect["contract"]["ui"]["slots"], json!(["chat.sidebar", "nav.page", "chat.brief"]));
        assert_eq!(inspect["installed"], json!([]));

        let template = turn
            .call(json!({"action": "template", "template": "mcp-stdio-python"}))
            .unwrap();
        let draft = turn.workspace.join(".somniq/plugin-drafts/doi-tools");
        for file in template["files"].as_array().unwrap() {
            write(&draft, file["path"].as_str().unwrap(), file["content"].as_str().unwrap());
        }
        let preview = turn
            .call(json!({"action": "preview", "source": ".somniq/plugin-drafts/doi-tools"}))
            .unwrap();
        assert_eq!(preview["canEnable"], true, "{preview}");
        assert_eq!(preview["diagnostics"], json!([]));
        assert_eq!(preview["capabilities"]["mcpServers"][0]["name"], "example");
        assert!(preview["upgrade"].is_null());
        assert!(preview["nextStep"].as_str().unwrap().contains("install"));

        // A broken draft comes back as diagnostics the agent can act on.
        write(&draft, "cordis.patch.yml", "- insert:\n    - id: mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: http\n        serverName: example\n        command: python\n");
        let broken = turn
            .call(json!({"action": "preview", "source": draft.to_string_lossy()}))
            .unwrap();
        assert_eq!(broken["canEnable"], false);
        let diagnostic = &broken["diagnostics"][0];
        assert_eq!(diagnostic["code"], "capability");
        assert_eq!(diagnostic["path"], "mcp");
        assert!(diagnostic["hint"].as_str().is_some());

        // A directory that is not a package is a diagnostic, not a tool error.
        std::fs::create_dir_all(turn.workspace.join("empty")).unwrap();
        let empty = turn.call(json!({"action": "preview", "source": "empty"})).unwrap();
        assert_eq!(empty["diagnostics"][0]["code"], "package");
        assert!(temp.path().join("config").join("plugins").read_dir().is_err(),
            "read-only actions must not create plugin state");
        assert_eq!(turn.changes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_plugin_manager_tool_reads_only_inside_the_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let _config = ConfigRoot::set(&temp.path().join("config"));
        let turn = Turn::new(&temp.path().join("project"));
        let outside = temp.path().join("outside");
        for file in runtime::plugins::plugin_template("chat-panel").unwrap() {
            write(&outside, file.path, &file.content);
        }
        std::fs::create_dir_all(turn.workspace.join(".somniq/plugins")).unwrap();

        for action in ["preview", "install", "upgrade"] {
            for source in [outside.to_string_lossy().to_string(), "../outside".to_string()] {
                let error = turn
                    .call(json!({"action": action, "source": source, "digest": "sha256:x"}))
                    .unwrap_err();
                assert!(error.contains("inside the workspace"), "{action}: {error}");
            }
            let error = turn
                .call(json!({"action": action, "source": ".somniq/plugins", "digest": "sha256:x"}))
                .unwrap_err();
            assert!(error.contains("plugin store"), "{action}: {error}");
        }
        for action in ["enable", "approve"] {
            let error = turn.call(json!({"action": action})).unwrap_err();
            assert!(error.contains("unknown PluginManager action"), "{action}: {error}");
        }
        let error = turn
            .call(json!({"action": "preview", "source": "x", "approve": true}))
            .unwrap_err();
        assert!(error.contains("unknown field"), "{error}");
        assert_eq!(turn.call(json!({"action": "list"})).unwrap()["plugins"], json!([]));
    }

    #[test]
    fn listed_and_previewed_mcp_servers_never_show_environment_values() {
        let temp = tempfile::tempdir().unwrap();
        let _config = ConfigRoot::set(&temp.path().join("config"));
        let turn = Turn::new(&temp.path().join("project"));
        let draft = turn.workspace.join(".somniq/plugin-drafts/keyed");
        for file in runtime::plugins::plugin_template("mcp-stdio-python").unwrap() {
            write(&draft, file.path, &file.content);
        }
        let patch = std::fs::read_to_string(draft.join("cordis.patch.yml")).unwrap();
        write(
            &draft,
            "cordis.patch.yml",
            &format!("{patch}        env:\n          SERVICE_TOKEN: secret-value-123\n"),
        );
        let preview = turn
            .call(json!({"action": "preview", "source": ".somniq/plugin-drafts/keyed"}))
            .unwrap();
        assert_eq!(preview["canEnable"], true, "{preview}");
        assert_eq!(
            preview["capabilities"]["mcpServers"][0]["envKeys"],
            json!(["SERVICE_TOKEN"])
        );
        let install = turn
            .call(json!({"action": "install", "source": ".somniq/plugin-drafts/keyed", "digest": preview["digest"]}))
            .unwrap();
        let name = preview["name"].as_str().unwrap().to_string();
        let asking = {
            let turn = &turn;
            let name = name.clone();
            std::thread::scope(|scope| {
                let waiting = scope.spawn(move || turn.call_with_id("ask", json!({"action": "request_enable", "name": name})));
                let card = turn.card("ask");
                turn.respond("ask", card["digest"].as_str().unwrap(), false).unwrap();
                (card, waiting.join().unwrap().unwrap())
            })
        };
        for output in [
            preview.to_string(),
            install.to_string(),
            asking.0.to_string(),
            asking.1.to_string(),
            turn.call(json!({"action": "list"})).unwrap().to_string(),
        ] {
            assert!(!output.contains("secret-value-123"), "{output}");
        }
        assert_eq!(asking.0["capabilities"]["mcpServers"][0]["envKeys"], json!(["SERVICE_TOKEN"]));
    }

    #[test]
    fn only_the_users_click_enables_what_the_agent_installed() {
        let temp = tempfile::tempdir().unwrap();
        let _config = ConfigRoot::set(&temp.path().join("config"));
        let turn = Turn::new(&temp.path().join("project"));
        let preview = turn.draft("chat-panel", ".somniq/plugin-drafts/hypotheses");
        let name = preview["name"].as_str().unwrap().to_string();

        let install = turn
            .call(json!({"action": "install", "source": ".somniq/plugin-drafts/hypotheses", "digest": preview["digest"]}))
            .unwrap();
        assert_eq!(install["application"], "none");
        assert_eq!(install["status"], "disabled");
        assert!(!turn.plugin(&name).unwrap().enabled);
        assert_eq!(turn.changes.load(Ordering::SeqCst), 1);

        std::thread::scope(|scope| {
            let request = {
                let name = name.clone();
                let turn = &turn;
                scope.spawn(move || turn.call_with_id("enable-1", json!({"action": "request_enable", "name": name})))
            };
            let card = turn.card("enable-1");
            assert_eq!(card["kind"], "enable");
            assert_eq!(card["digest"], preview["digest"]);
            assert_eq!(card["approveOn"], "desktop");
            assert_eq!(card["capabilities"]["uiPanels"].as_array().unwrap().len(), 1);
            // Waiting is not approving.
            assert!(!turn.plugin(&name).unwrap().enabled);

            // Another window, or a card for other bytes, cannot answer.
            let error = respond_to_plugin_approval(&turn.approvals, "screenshot-overlay", "enable-1", card["digest"].as_str().unwrap(), true)
                .err()
                .unwrap();
            assert!(error.contains("main window"), "{error}");
            let error = turn.respond("enable-1", "sha256:other", true).err().unwrap();
            assert!(error.contains("no longer matches"), "{error}");
            let error = turn.respond("missing", card["digest"].as_str().unwrap(), true).err().unwrap();
            assert!(error.contains("no longer waiting"), "{error}");
            assert!(!turn.plugin(&name).unwrap().enabled);

            let response = turn.respond("enable-1", card["digest"].as_str().unwrap(), true).unwrap();
            assert_eq!(response.audit["decision"], "approve");
            assert_eq!(response.audit["result"], "applied");
            assert_eq!(response.session_id, "session-1");
            assert!(response.changed_root.is_some());
            let result = request.join().unwrap().unwrap();
            assert_eq!(result["application"], "next-turn");
            assert_eq!(result["status"], "enabled");
        });
        assert!(turn.plugin(&name).unwrap().enabled);
        assert!(turn.approvals.lock().unwrap().is_empty());

        // Asking again is a no-op, and disabling needs no card.
        assert_eq!(turn.call(json!({"action": "request_enable", "name": name})).unwrap()["application"], "none");
        let disabled = turn.call(json!({"action": "disable", "name": name})).unwrap();
        assert_eq!(disabled["application"], "next-turn");
        assert!(!turn.plugin(&name).unwrap().enabled);
    }

    #[test]
    fn a_rejected_stopped_or_stale_card_leaves_the_plugin_off() {
        let temp = tempfile::tempdir().unwrap();
        let _config = ConfigRoot::set(&temp.path().join("config"));
        let turn = Turn::new(&temp.path().join("project"));
        let dir = ".somniq/plugin-drafts/hypotheses";
        let preview = turn.draft("chat-panel", dir);
        let name = preview["name"].as_str().unwrap().to_string();
        turn.call(json!({"action": "install", "source": dir, "digest": preview["digest"]})).unwrap();

        std::thread::scope(|scope| {
            // Rejected: a normal result, not an error.
            let request = {
                let (turn, name) = (&turn, name.clone());
                scope.spawn(move || turn.call_with_id("reject", json!({"action": "request_enable", "name": name})))
            };
            let card = turn.card("reject");
            let response = turn.respond("reject", card["digest"].as_str().unwrap(), false).unwrap();
            assert_eq!(response.audit["decision"], "reject");
            assert!(response.changed_root.is_none());
            assert_eq!(request.join().unwrap().unwrap()["application"], "rejected");

            // Stopped: the turn gives up and the card can no longer be answered.
            let request = {
                let (turn, name) = (&turn, name.clone());
                scope.spawn(move || turn.call_with_id("stop", json!({"action": "request_enable", "name": name})))
            };
            let card = turn.card("stop");
            turn.cancelled.store(true, Ordering::SeqCst);
            let error = request.join().unwrap().unwrap_err();
            assert!(error.to_lowercase().contains("interrupt"), "{error}");
            assert!(turn.respond("stop", card["digest"].as_str().unwrap(), true).is_err());
            turn.cancelled.store(false, Ordering::SeqCst);

            // Stale: the package was replaced while the card was up.
            let request = {
                let (turn, name) = (&turn, name.clone());
                scope.spawn(move || turn.call_with_id("stale", json!({"action": "request_enable", "name": name})))
            };
            let card = turn.card("stale");
            let mut manifest: Value = serde_json::from_str(&std::fs::read_to_string(turn.workspace.join(dir).join("package.json")).unwrap()).unwrap();
            manifest["version"] = json!("0.2.0");
            write(&turn.workspace.join(dir), "package.json", &manifest.to_string());
            let replacement = PluginStore::for_workspace(&turn.workspace).preview(turn.workspace.join(dir)).unwrap();
            PluginStore::for_workspace(&turn.workspace)
                .upgrade(turn.workspace.join(dir), &replacement.digest, card["digest"].as_str().unwrap(), false)
                .unwrap();
            let response = turn.respond("stale", card["digest"].as_str().unwrap(), true).unwrap();
            assert_eq!(response.audit["result"], "failed");
            assert!(response.error.unwrap().contains("changed"));
            let error = request.join().unwrap().unwrap_err();
            assert!(error.contains("could not be applied"), "{error}");
        });
        assert!(!turn.plugin(&name).unwrap().enabled);
        assert!(turn.approvals.lock().unwrap().is_empty());
    }

    #[test]
    fn upgrading_a_running_plugin_asks_once_with_the_diff() {
        let temp = tempfile::tempdir().unwrap();
        let _config = ConfigRoot::set(&temp.path().join("config"));
        let turn = Turn::new(&temp.path().join("project"));
        let dir = ".somniq/plugin-drafts/tools";
        let v1 = turn.installed_and_enabled("mcp-stdio-python", dir);
        let name = v1["name"].as_str().unwrap().to_string();

        // A text-only change: commands and environment keys are the same.
        let draft = turn.workspace.join(dir);
        let mut manifest: Value = serde_json::from_str(&std::fs::read_to_string(draft.join("package.json")).unwrap()).unwrap();
        manifest["version"] = json!("0.2.0");
        manifest["description"] = json!("Research tools, second draft");
        write(&draft, "package.json", &manifest.to_string());
        let v2 = turn.call(json!({"action": "preview", "source": dir})).unwrap();
        assert_eq!(v2["upgrade"]["currentEnabled"], true);
        assert!(v2["nextStep"].as_str().unwrap().contains("upgrade"));

        std::thread::scope(|scope| {
            let request = {
                let turn = &turn;
                let digest = v2["digest"].clone();
                scope.spawn(move || turn.call_with_id("up-1", json!({"action": "upgrade", "source": dir, "digest": digest})))
            };
            let card = turn.card("up-1");
            assert_eq!(card["kind"], "upgrade");
            assert_eq!(card["currentVersion"], v1["version"]);
            assert_eq!(card["executionUnchanged"], true);
            // Until the click, the running version is untouched.
            assert_eq!(turn.plugin(&name).unwrap().package.digest, v1["digest"].as_str().unwrap());
            turn.respond("up-1", card["digest"].as_str().unwrap(), true).unwrap();
            assert_eq!(request.join().unwrap().unwrap()["application"], "next-turn");
        });
        let running = turn.plugin(&name).unwrap();
        assert!(running.enabled);
        assert_eq!(running.package.version, "0.2.0");

        // A changed command line is not a one-line card, and rejecting keeps the old version.
        let patch = std::fs::read_to_string(draft.join("cordis.patch.yml")).unwrap();
        write(&draft, "cordis.patch.yml", &patch.replace("./server.py", "./server.py\n          - --verbose"));
        manifest["version"] = json!("0.3.0");
        write(&draft, "package.json", &manifest.to_string());
        let v3 = turn.call(json!({"action": "preview", "source": dir})).unwrap();
        assert_eq!(v3["canEnable"], true, "{v3}");
        std::thread::scope(|scope| {
            let request = {
                let turn = &turn;
                let digest = v3["digest"].clone();
                scope.spawn(move || turn.call_with_id("up-2", json!({"action": "upgrade", "source": dir, "digest": digest})))
            };
            let card = turn.card("up-2");
            assert_eq!(card["executionUnchanged"], false, "{card}");
            assert!(!card["diff"]["commands"]["added"].as_array().unwrap().is_empty());
            turn.respond("up-2", card["digest"].as_str().unwrap(), false).unwrap();
            assert_eq!(request.join().unwrap().unwrap()["application"], "rejected");
        });
        let running = turn.plugin(&name).unwrap();
        assert!(running.enabled);
        assert_eq!(running.package.version, "0.2.0");
    }

    #[test]
    fn changing_an_installed_page_starts_from_a_checkout_and_shows_its_files() {
        let temp = tempfile::tempdir().unwrap();
        let _config = ConfigRoot::set(&temp.path().join("config"));
        let turn = Turn::new(&temp.path().join("project"));
        // Installed from a draft elsewhere; the edit starts from what runs.
        let v1 = turn.installed_and_enabled("todo-workspace", ".somniq/plugin-drafts/original");
        let name = v1["name"].as_str().unwrap().to_string();

        let out = turn.call(json!({"action": "checkout", "name": name})).unwrap();
        assert_eq!(out["status"], "checked-out");
        assert_eq!(out["draftDirectory"], ".somniq/plugin-drafts/project-tasks");
        assert!(out["files"].as_array().unwrap().iter().any(|file| file == "todo/glance.html"));
        let dir = ".somniq/plugin-drafts/project-tasks";
        let draft = turn.workspace.join(dir);
        let css = std::fs::read_to_string(draft.join("todo/todo.css")).unwrap();
        write(&draft, "todo/todo.css", &css.replace("--radius: 10px;", "--radius: 4px;"));
        let manifest = std::fs::read_to_string(draft.join("package.json")).unwrap();
        write(&draft, "package.json", &manifest.replace("\"0.1.0\"", "\"0.1.1\""));
        // Edits are never overwritten by another checkout.
        assert_eq!(turn.call(json!({"action": "checkout", "name": name})).unwrap()["status"], "exists");

        let v2 = turn.call(json!({"action": "preview", "source": dir})).unwrap();
        std::thread::scope(|scope| {
            let request = {
                let turn = &turn;
                let digest = v2["digest"].clone();
                scope.spawn(move || turn.call_with_id("edit-1", json!({"action": "upgrade", "source": dir, "digest": digest})))
            };
            let card = turn.card("edit-1");
            let files: Vec<_> = card["files"].as_array().unwrap().iter().map(|f| (f["path"].as_str().unwrap().to_string(), f["change"].as_str().unwrap().to_string())).collect();
            assert_eq!(files, [("package.json".to_string(), "changed".to_string()), ("todo/todo.css".to_string(), "changed".to_string())]);
            let pages: Vec<_> = card["pagePanels"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
            assert_eq!(pages, ["tasks", "glance"]);
            assert_eq!(card["executionUnchanged"], false);
            turn.respond("edit-1", card["digest"].as_str().unwrap(), true).unwrap();
            request.join().unwrap().unwrap();
        });
        let running = turn.plugin(&name).unwrap();
        assert_eq!(running.package.version, "0.1.1");
        assert_eq!(running.history.len(), 1);
        assert_eq!(running.history[0].digest, v1["digest"].as_str().unwrap());
        // A checkout is a change to the project: not in Plan mode.
        let mut plan = Turn::new(&temp.path().join("project"));
        plan.mode = PermissionMode::ReadOnly;
        assert!(plan.call(json!({"action": "checkout", "name": name})).unwrap_err().contains("read-only"));
    }

    #[test]
    fn upgrading_a_stopped_plugin_needs_no_card_and_remove_asks_first() {
        let temp = tempfile::tempdir().unwrap();
        let _config = ConfigRoot::set(&temp.path().join("config"));
        let turn = Turn::new(&temp.path().join("project"));
        let dir = ".somniq/plugin-drafts/notes";
        let v1 = turn.draft("chat-panel", dir);
        let name = v1["name"].as_str().unwrap().to_string();
        turn.call(json!({"action": "install", "source": dir, "digest": v1["digest"]})).unwrap();

        let identical = turn.call(json!({"action": "upgrade", "source": dir, "digest": v1["digest"]})).unwrap();
        assert_eq!(identical["application"], "none");

        let draft = turn.workspace.join(dir);
        let mut manifest: Value = serde_json::from_str(&std::fs::read_to_string(draft.join("package.json")).unwrap()).unwrap();
        manifest["version"] = json!("0.2.0");
        write(&draft, "package.json", &manifest.to_string());
        let v2 = turn.call(json!({"action": "preview", "source": dir})).unwrap();
        let error = turn
            .call(json!({"action": "upgrade", "source": dir, "digest": v2["digest"], "currentDigest": "sha256:old"}))
            .unwrap_err();
        assert!(error.contains("changed after preview"), "{error}");
        let upgraded = turn.call(json!({"action": "upgrade", "source": dir, "digest": v2["digest"]})).unwrap();
        assert_eq!(upgraded["version"], "0.2.0");
        assert_eq!(upgraded["status"], "disabled");
        assert!(turn.cards.lock().unwrap().is_empty());

        std::thread::scope(|scope| {
            let request = {
                let (turn, name) = (&turn, name.clone());
                scope.spawn(move || turn.call_with_id("rm", json!({"action": "remove", "name": name})))
            };
            let card = turn.card("rm");
            assert_eq!(card["kind"], "remove");
            assert!(turn.plugin(&name).is_some(), "nothing is removed before the click");
            turn.respond("rm", card["digest"].as_str().unwrap(), true).unwrap();
            let result = request.join().unwrap().unwrap();
            assert_eq!(result["status"], "removed");
            assert_eq!(result["application"], "next-turn");
        });
        assert!(turn.plugin(&name).is_none());
        assert!(draft.join("package.json").exists(), "the draft stays");
    }

    #[test]
    fn unattended_and_plan_mode_turns_only_read_plugins() {
        let temp = tempfile::tempdir().unwrap();
        let _config = ConfigRoot::set(&temp.path().join("config"));
        let mut turn = Turn::new(&temp.path().join("project"));
        let dir = ".somniq/plugin-drafts/notes";
        let preview = turn.draft("chat-panel", dir);
        let name = preview["name"].as_str().unwrap().to_string();
        let writes = [
            json!({"action": "install", "source": dir, "digest": preview["digest"]}),
            json!({"action": "upgrade", "source": dir, "digest": preview["digest"]}),
            json!({"action": "request_enable", "name": name}),
            json!({"action": "disable", "name": name}),
            json!({"action": "remove", "name": name}),
        ];

        turn.unattended = Some("work task");
        for input in &writes {
            let error = turn.call(input.clone()).unwrap_err();
            assert!(error.contains("work task") && error.contains("interactive chat"), "{input}: {error}");
        }
        for action in ["inspect", "list"] {
            turn.call(json!({"action": action})).unwrap();
        }
        turn.call(json!({"action": "preview", "source": dir})).unwrap();

        turn.unattended = None;
        turn.mode = PermissionMode::ReadOnly;
        for input in &writes {
            let error = turn.call(input.clone()).unwrap_err();
            assert!(error.contains("read-only"), "{input}: {error}");
        }
        for mode in [PermissionMode::ReadOnly, PermissionMode::WorkspaceWrite, PermissionMode::Prompt] {
            turn.mode = mode;
            let error = turn.call(json!({"action": "check_mcp", "name": name})).unwrap_err();
            assert!(error.contains("full access"), "{mode:?}: {error}");
        }
        assert!(turn.plugin(&name).is_none());
        assert!(turn.cards.lock().unwrap().is_empty());
        assert_eq!(turn.changes.load(Ordering::SeqCst), 0);
    }

    /// A plugin page runs the package's own script in a sandboxed frame. The
    /// page's realm has no native transport, but it can create a child frame
    /// whose fresh realm still has WebView2's `chrome.webview`. What stops a
    /// command sent from there is Tauri refusing custom commands from an
    /// origin that is not the app's (`about:srcdoc` here) unless a capability
    /// lists `remote` URLs. So no capability may: it would hand every command
    /// to plugin pages.
    #[test]
    fn no_capability_opens_commands_to_remote_origins() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut checked = 0;
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let capability: Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert!(
                capability.get("remote").is_none(),
                "{} opens commands to remote origins",
                path.display()
            );
            checked += 1;
        }
        assert!(checked > 0);
    }

    #[test]
    fn plugin_commands_refuse_a_stale_project_binding() {
        let temp = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        assert!(bound_store(temp.path(), other.path().to_str().unwrap()).is_err());
        assert!(bound_store(temp.path(), temp.path().to_str().unwrap()).is_ok());
    }
}
