//! The desktop half of official plugins (`runtime::plugins::builtin`): which
//! host tools each one owns, the switches' commands, and the background
//! services a switch starts and stops.
//!
//! A run sees the switches it froze (`PluginSet::builtin_disabled`): the tool
//! list a turn offers and the tools it may execute both come from that set,
//! so a click on the plugins page changes the next turn, never the current one.

use runtime::plugins::{builtin_tool, BuiltinState, BuiltinTarget, PluginStore, BUILTIN_MAIL};
use tauri::{AppHandle, Emitter, State};

use crate::blocking::off_main_thread;
use crate::projects::{current_project_path, ProjectState};

pub(crate) const OFFICIAL_PLUGINS_CHANGED_EVENT: &str = "official-plugins-changed";
const MAIN_WINDOW_LABEL: &str = "main";

/// The official plugin that owns a tool, from the plugins' manifests
/// (`runtime::plugins::builtin`). Tools no manifest lists are core.
pub(crate) fn tool_owner(tool_name: &str) -> Option<&'static str> {
    builtin_tool(tool_name).map(|(manifest, _)| manifest.id)
}

/// Other official plugins a tool needs besides its owner.
fn tool_requires(tool_name: &str) -> &'static [&'static str] {
    builtin_tool(tool_name).map_or(&[], |(_, tool)| tool.requires)
}

/// Whether `tool_name` is usable when `enabled` says which official plugins
/// are on: its owner and everything it requires.
pub(crate) fn tool_allowed(tool_name: &str, enabled: impl Fn(&str) -> bool) -> bool {
    tool_owner(tool_name).is_none_or(&enabled) && tool_requires(tool_name).iter().all(|id| enabled(id))
}

/// [`tool_allowed`] inside `context`: the set its run froze, or the live
/// switches outside a run.
pub(crate) fn tool_allowed_in(context: &runtime::ProjectExecutionContext, tool_name: &str) -> bool {
    if tool_owner(tool_name).is_none() && tool_requires(tool_name).is_empty() {
        return true;
    }
    runtime::with_project_execution_context(context, || {
        let Ok(cwd) = runtime::execution_current_dir() else {
            return false;
        };
        let store = PluginStore::for_execution(cwd);
        tool_allowed(tool_name, |id| store.builtin_enabled(id))
    })
}

/// The official plugins that are off where this call runs: the frozen set
/// inside a run, the live switches outside one.
pub(crate) fn disabled_in_current_execution() -> Vec<String> {
    runtime::execution_current_dir()
        .map(|cwd| PluginStore::for_execution(cwd).builtin_disabled())
        .unwrap_or_default()
}

pub(crate) fn disabled_tool_message(tool_name: &str) -> String {
    let needs = tool_owner(tool_name)
        .into_iter()
        .chain(tool_requires(tool_name).iter().copied())
        .map(|id| format!("`{id}`"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "`{tool_name}` is unavailable: it needs the official plugin(s) {needs}, and one of them \
         is turned off for this turn. The user can turn it on in Plugins; do not retry this tool now."
    )
}

/// Refuse a module action in `workspace` while its official plugin is off
/// there. The page is hidden then; this keeps a stale page or a scripted call
/// from spending the user's credits anyway.
pub(crate) fn require_in(workspace: &std::path::Path, id: &str) -> Result<(), String> {
    if PluginStore::for_workspace(workspace).builtin_enabled(id) {
        Ok(())
    } else {
        Err(format!(
            "The official `{id}` plugin is turned off for this project. Turn it on in Plugins to continue."
        ))
    }
}

/// Whether `id` is on for the project the app currently shows.
pub(crate) fn enabled_for_current_project(app: &AppHandle, id: &str) -> bool {
    use tauri::Manager;
    enabled_in_project(current_project_path(&app.state::<ProjectState>()).ok().as_deref(), id)
}

/// Whether `id` is on for `project`; with no project open nothing is switched off.
pub(crate) fn enabled_in_project(project: Option<&std::path::Path>, id: &str) -> bool {
    project
        .map(|path| PluginStore::for_workspace(path).builtin_enabled(id))
        .unwrap_or(true)
}

/// The `somniq-figure` scheme: serve the asset only while Figures is on for
/// `project`, else a bare 404 without touching the asset at all.
pub(crate) fn figure_scheme_response(
    project: Option<&std::path::Path>,
    serve: impl FnOnce() -> tauri::http::Response<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    if enabled_in_project(project, runtime::plugins::BUILTIN_FIGURES) {
        serve()
    } else {
        tauri::http::Response::builder()
            .status(404)
            .header("Content-Type", "text/plain")
            .body(Vec::new())
            .unwrap_or_default()
    }
}

/// A store for switches that belong to no project (the global ones). The
/// workspace only keys project overrides, which these calls never read.
fn global_store() -> PluginStore {
    PluginStore::for_workspace(runtime::somniq_config_dir_from_env())
}

/// Whether mail's background services may run: its global switch.
pub(crate) fn mail_services_enabled() -> bool {
    global_store().builtin_globally_enabled(BUILTIN_MAIL)
}

/// At startup: give mail its first global value if it never had one (on
/// when a mailbox is connected, so an upgrade never stops a mailbox in use),
/// then start its watchers when it is on.
pub(crate) fn start_services(app: AppHandle) {
    let store = global_store();
    let enabled = store
        .seed_builtin_global(BUILTIN_MAIL, crate::mail::has_accounts())
        .unwrap_or_else(|error| {
            eprintln!("SomniQ official plugins: {error}");
            store.builtin_globally_enabled(BUILTIN_MAIL)
        });
    if enabled {
        crate::mail::spawn_event_watchers(app);
    }
}

fn apply_services(app: &AppHandle, id: &str) {
    if id != BUILTIN_MAIL {
        return;
    }
    if mail_services_enabled() {
        crate::mail::spawn_event_watchers(app.clone());
    } else {
        crate::mail::stop_event_watchers();
    }
}

#[tauri::command]
pub async fn official_plugins_list(
    projects: State<'_, ProjectState>,
    project_path: String,
) -> Result<Vec<BuiltinState>, String> {
    let store = crate::plugins::bound_store(&current_project_path(&projects)?, &project_path)?;
    off_main_thread(move || store.builtin_states()).await
}

/// Set or clear one switch. Only a click in the main window gets here; no
/// model tool can switch an official plugin.
#[tauri::command]
pub async fn official_plugins_set(
    app: AppHandle,
    window: tauri::Window,
    projects: State<'_, ProjectState>,
    project_path: String,
    id: String,
    target: BuiltinTarget,
    value: Option<bool>,
) -> Result<Vec<BuiltinState>, String> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err("Official plugins can only be switched in SomniQ's main window.".into());
    }
    let store = crate::plugins::bound_store(&current_project_path(&projects)?, &project_path)?;
    let states = off_main_thread({
        let id = id.clone();
        move || store.set_builtin(&id, target, value)
    })
    .await?;
    apply_services(&app, &id);
    let _ = app.emit(OFFICIAL_PLUGINS_CHANGED_EVENT, &states);
    Ok(states)
}
