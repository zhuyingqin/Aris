mod app_ctx;
mod blocking;
mod chat_events;
mod codebridge;
mod codeserver;
mod commands;
mod compute;
mod config;
/// Loopback HTTP host for the `AppCtx`-ported commands, used to drive the UI
/// from a plain browser. Compiled only for the `aris-devserver` binary.
#[cfg(feature = "devserver")]
pub mod devserver;
mod engine;
mod env;
mod files;
mod git;
mod image_assist;
mod knowledge;
mod literature;
mod mail;
mod mcp;
mod memory;
mod newapi;
mod oracle_web;
mod playwright_pdf;
mod process;
mod profile;
mod projects;
mod remote;
mod scheduled;
mod sessions;
mod slash_commands;
mod state;
mod system_prompt;
mod tencentdb_memory;
mod textdiff;
mod tool_output;
mod typeset;
mod typeset_state;
mod usage_log;
mod watcher;
mod workflow;

use semver::Version;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Mutex, Once, OnceLock};
use tauri::{image::Image, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

static SHUTDOWN_CLEANUP: Once = Once::new();
static CHAT_COMPANION_WINDOW_LOCK: Mutex<()> = Mutex::new(());
#[derive(Default)]
struct ChatCompanionHandoffState(Mutex<Option<serde_json::Value>>);
static PYTHON_ENVIRONMENT_PATH_LOCK: Mutex<()> = Mutex::new(());
static DESKTOP_TOOL_BASE_PATH: OnceLock<OsString> = OnceLock::new();

fn embedded_release_unix_timestamp() -> Option<i64> {
    option_env!("SOMNIQ_RELEASE_UNIX_TIMESTAMP").and_then(|value| value.parse().ok())
}

fn should_offer_update(
    current_version: &Version,
    remote_version: &Version,
    current_release_timestamp: Option<i64>,
    remote_release_timestamp: Option<i64>,
) -> bool {
    use std::cmp::Ordering;

    match remote_version.cmp(current_version) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => matches!(
            (current_release_timestamp, remote_release_timestamp),
            (Some(current), Some(remote)) if remote > current
        ),
    }
}

fn open_chat_companion_window(
    app: tauri::AppHandle,
    handoff: Option<serde_json::Value>,
) -> Result<(), String> {
    // Serialize rapid repeated clicks. Without this guard, two async command
    // workers can both observe a missing label before either finishes WebView2
    // creation, causing duplicate/rejected window builds.
    let _guard = CHAT_COMPANION_WINDOW_LOCK
        .lock()
        .map_err(|_| "chat companion window lock is poisoned".to_string())?;
    if let Some(window) = app.get_webview_window("chat-companion") {
        if let Some(handoff) = handoff {
            window
                .emit("chat-companion-handoff", handoff)
                .map_err(|error| error.to_string())?;
        }
        window.show().map_err(|error| error.to_string())?;
        let _ = window.unminimize();
        let _ = window.set_always_on_top(true);
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    if let Some(handoff) = handoff {
        let handoff_state = app.state::<ChatCompanionHandoffState>();
        let mut pending = handoff_state
            .0
            .lock()
            .map_err(|_| "chat companion handoff lock is poisoned".to_string())?;
        *pending = Some(handoff);
    }

    let window = WebviewWindowBuilder::new(
        &app,
        "chat-companion",
        // `WebviewUrl::App` accepts an asset path, not a URL-with-query. A
        // query here is escaped into the asset name and produces a blank
        // webview. The frontend identifies this surface by its window label.
        WebviewUrl::App("index.html".into()),
    )
    .title("SomniQ Writing Companion")
    .inner_size(560.0, 800.0)
    .min_inner_size(390.0, 520.0)
    .resizable(true)
    .decorations(false)
    .shadow(true)
    .always_on_top(true)
    .build()
    .map_err(|error| error.to_string())?;

    if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/icon.png")) {
        let _ = window.set_icon(icon);
    }
    apply_windows_taskbar_icon(&window);
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
async fn open_chat_companion(
    app: tauri::AppHandle,
    handoff: Option<serde_json::Value>,
) -> Result<(), String> {
    // A synchronous Tauri command runs on the webview IPC/main-event path on
    // Windows. `WebviewWindowBuilder::build` must wait for that same event loop
    // to create WebView2, so doing both synchronously deadlocks the app: the new
    // native surface stays white and even window controls stop dispatching.
    // Keep the event loop free while the builder performs its cross-thread work.
    tauri::async_runtime::spawn_blocking(move || open_chat_companion_window(app, handoff))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn take_chat_companion_handoff(
    state: tauri::State<'_, ChatCompanionHandoffState>,
) -> Result<Option<serde_json::Value>, String> {
    state
        .0
        .lock()
        .map(|mut handoff| handoff.take())
        .map_err(|_| "chat companion handoff lock is poisoned".to_string())
}

fn prepend_existing_path_entries(paths: impl IntoIterator<Item = PathBuf>) {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let existing_paths = std::env::split_paths(&existing).collect::<Vec<_>>();
    let mut extras = paths
        .into_iter()
        .filter(|path| path.exists() && !existing_paths.iter().any(|item| item == path))
        .collect::<Vec<_>>();
    if extras.is_empty() {
        return;
    }
    extras.extend(existing_paths);
    if let Ok(joined) = std::env::join_paths(extras) {
        std::env::set_var("PATH", joined);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PythonEnvironment {
    python: PathBuf,
    path_entries: Vec<PathBuf>,
}

fn resolve_python_environment(selected: &str) -> Result<Option<PythonEnvironment>, String> {
    let selected = selected.trim();
    if selected.is_empty() {
        return Ok(None);
    }

    let selected_path = PathBuf::from(selected);
    let python = if selected_path.is_file() {
        selected_path
    } else if selected_path.is_dir() {
        let candidates = if cfg!(windows) {
            vec![
                selected_path.join("python.exe"),
                selected_path.join("Scripts").join("python.exe"),
            ]
        } else {
            vec![
                selected_path.join("bin").join("python"),
                selected_path.join("bin").join("python3"),
            ]
        };
        candidates
            .into_iter()
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| {
                format!(
                    "No Python interpreter was found under `{}`",
                    selected_path.display()
                )
            })?
    } else {
        return Err(format!(
            "Python environment path does not exist: {}",
            selected_path.display()
        ));
    };

    let parent = python.parent().ok_or_else(|| {
        format!(
            "Python interpreter has no parent directory: {}",
            python.display()
        )
    })?;
    let environment_root = if parent
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("Scripts") || name == "bin")
    {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };

    let candidates = if cfg!(windows) {
        vec![
            python.parent().unwrap_or(environment_root).to_path_buf(),
            environment_root.to_path_buf(),
            environment_root.join("Scripts"),
            environment_root.join("Library").join("bin"),
            environment_root.join("condabin"),
        ]
    } else {
        vec![
            python.parent().unwrap_or(environment_root).to_path_buf(),
            environment_root.join("bin"),
        ]
    };
    let mut path_entries = Vec::new();
    for candidate in candidates {
        if candidate.is_dir() && !path_entries.iter().any(|entry| entry == &candidate) {
            path_entries.push(candidate);
        }
    }

    Ok(Some(PythonEnvironment {
        python,
        path_entries,
    }))
}

pub(crate) fn validate_python_environment_path(selected: &str) -> Result<(), String> {
    resolve_python_environment(selected).map(|_| ())
}

/// Apply the explicitly trusted Python/Conda environment to future desktop
/// subprocesses. The baseline is captured after bundled tool paths are ready,
/// so changing or clearing the selection cannot discard SomniQ's own helpers.
pub(crate) fn apply_python_environment_path(selected: Option<&str>) -> Result<(), String> {
    let _guard = PYTHON_ENVIRONMENT_PATH_LOCK
        .lock()
        .map_err(|_| "Python environment PATH lock is poisoned".to_string())?;
    let baseline = DESKTOP_TOOL_BASE_PATH
        .get_or_init(|| std::env::var_os("PATH").unwrap_or_default())
        .clone();
    let resolved = resolve_python_environment(selected.unwrap_or_default())?;

    let Some(environment) = resolved else {
        std::env::set_var("PATH", baseline);
        std::env::remove_var("SOMNIQ_PYTHON");
        return Ok(());
    };

    let mut entries = environment.path_entries;
    let inherited = std::env::split_paths(&baseline)
        .filter(|path| !entries.iter().any(|entry| entry == path))
        .collect::<Vec<_>>();
    entries.extend(inherited);
    let joined = std::env::join_paths(entries)
        .map_err(|error| format!("Could not build Python environment PATH: {error}"))?;
    std::env::set_var("PATH", joined);
    std::env::set_var("SOMNIQ_PYTHON", environment.python);
    Ok(())
}

fn apply_configured_python_environment() -> Result<(), String> {
    let obj = config::load_object();
    let selected = obj
        .get("python_environment_path")
        .and_then(serde_json::Value::as_str);
    apply_python_environment_path(selected)
}

/// Extend the process PATH with common user-installed tool directories so that
/// MCP stdio servers and Jupyter kernelspecs can find node, npx, uvx, python,
/// and helper scripts when the app is launched from a desktop shortcut on
/// Windows, which does not inherit the full shell PATH.
#[cfg(windows)]
fn augment_path_for_desktop_tools() {
    let home = runtime::home_dir();
    let candidates = [
        // Node.js via nvm-windows
        format!("{home}\\AppData\\Roaming\\nvm\\current"),
        // npm global prefix
        format!("{home}\\AppData\\Roaming\\npm"),
        // Node.js system-wide installer default
        "C:\\Program Files\\nodejs".to_string(),
        // uv / uvx (installed via `pip install uv` or standalone installer)
        format!("{home}\\AppData\\Local\\uv\\bin"),
        format!("{home}\\AppData\\Roaming\\uv\\bin"),
        // pipx
        format!("{home}\\AppData\\Local\\Packages\\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\\LocalCache\\local-packages\\Python312\\Scripts"),
        // Python Launcher / standard Python installs. Many kernelspecs use
        // "python" instead of an absolute interpreter path.
        format!("{home}\\AppData\\Local\\Programs\\Python\\Python313"),
        format!("{home}\\AppData\\Local\\Programs\\Python\\Python313\\Scripts"),
        format!("{home}\\AppData\\Local\\Programs\\Python\\Python312"),
        format!("{home}\\AppData\\Local\\Programs\\Python\\Python312\\Scripts"),
        format!("{home}\\AppData\\Local\\Programs\\Python\\Python311"),
        format!("{home}\\AppData\\Local\\Programs\\Python\\Python311\\Scripts"),
        format!("{home}\\AppData\\Local\\Programs\\Python\\Python310"),
        format!("{home}\\AppData\\Local\\Programs\\Python\\Python310\\Scripts"),
        // Scoop shims
        format!("{home}\\scoop\\shims"),
    ];
    prepend_existing_path_entries(candidates.into_iter().map(PathBuf::from));
}

#[cfg(not(windows))]
fn augment_path_for_desktop_tools() {}

#[cfg(windows)]
fn configure_webview2_user_data_dir() {
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
        return;
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(runtime::home_dir())
                .join("AppData")
                .join("Local")
        });
    let dir = base.join("com.aris.studio").join("webview2-v2");
    if std::fs::create_dir_all(&dir).is_ok() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dir);
    }
}

#[cfg(not(windows))]
fn configure_webview2_user_data_dir() {}

fn resource_dir(app: &tauri::App) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

/// Tauri keeps globbed `resources/**/*` entries under a `resources/` child in
/// Windows dev/release output, while some packaged layouts expose that child as
/// the resource directory itself. Normalize both shapes before any bundled
/// runtime (Playwright, Node, Tectonic, internal config) resolves a path.
fn normalized_bundled_resource_dir(resource_dir: &std::path::Path) -> PathBuf {
    let nested = resource_dir.join("resources");
    if !resource_dir.join("bin").is_dir() && nested.join("bin").is_dir() {
        nested
    } else {
        resource_dir.to_path_buf()
    }
}

/// Bundled resource directory, resolved from a handle rather than the one-shot
/// `&App` available at setup. Used by anything that reads shipped assets after
/// startup — the embedded VS Code bridge extension, for one.
pub(crate) fn bundled_resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| normalized_bundled_resource_dir(&dir))
}

fn augment_resource_path_for_mcp(resource_dir: &std::path::Path) {
    prepend_existing_path_entries([resource_dir.join("bin"), resource_dir.join("node")]);
    std::env::set_var("ARIS_RESOURCE_DIR", resource_dir);
    configure_bundled_tectonic_environment(resource_dir);
}

/// Point Tectonic's on-demand package cache at a user-writable directory. The
/// bundled `tectonic.exe` lives under the read-only install directory on
/// Windows, so its CTAN package downloads must land elsewhere. Mirrors the
/// `~/.config/SomniQ/cache` layout used for the extracted skill bundle.
fn configure_tectonic_environment() {
    if std::env::var_os("TECTONIC_CACHE_DIR").is_some() {
        return;
    }
    let cache = PathBuf::from(runtime::home_dir())
        .join(".config")
        .join("SomniQ")
        .join("cache")
        .join("tectonic");
    if std::fs::create_dir_all(&cache).is_ok() {
        std::env::set_var("TECTONIC_CACHE_DIR", &cache);
    }
}

fn configure_bundled_tectonic_environment(resource_dir: &std::path::Path) {
    let bundled = resource_dir.join("bin").join(tectonic_binary_name());
    if !bundled.is_file() || valid_tectonic_override_exists() {
        return;
    }
    std::env::set_var("SOMNIQ_TECTONIC", &bundled);
    std::env::set_var("ARIS_TECTONIC", bundled);
}

fn tectonic_binary_name() -> &'static str {
    if cfg!(windows) {
        "tectonic.exe"
    } else {
        "tectonic"
    }
}

fn valid_tectonic_override_exists() -> bool {
    std::env::var_os("SOMNIQ_TECTONIC")
        .or_else(|| std::env::var_os("ARIS_TECTONIC"))
        .is_some_and(|value| PathBuf::from(value).is_file())
}

/// Stop all work owned by this Desktop instance while leaving the application
/// itself and its paired-device transport available for a later resume.
///
/// This is deliberately broader than cancelling one chat session: a paused
/// project must not leave a background shell, local/remote compute job,
/// notebook kernel, or paired-device chat turn consuming resources.
pub(crate) fn stop_all_running_work(app_handle: &tauri::AppHandle) {
    let chat_state = app_handle.state::<engine::ChatState>();
    engine::cancel_all_running_turns(chat_state.inner());

    let remote_state = app_handle.state::<remote::RemoteAgentState>();
    remote::cancel_all_active_chat_messages(remote_state.inner());

    compute::cancel_all_active_work(app_handle);
    notebook::KernelManager::shutdown_all();
    runtime::terminate_all_managed_processes();
}

fn cleanup_before_exit(app_handle: &tauri::AppHandle) {
    SHUTDOWN_CLEANUP.call_once(|| {
        playwright_pdf::shutdown();
        stop_all_running_work(app_handle);
        // Application exit additionally tears down the transport; a project
        // pause intentionally keeps it available so a resumed project can use
        // its existing paired devices without a fresh connection ceremony.
        let compute_state = app_handle.state::<compute::ComputeState>();
        compute::cancel_all(compute_state.inner());
        // The VS Code server forks an extension host and a pty host; killing
        // only the parent would leave both orphaned.
        codeserver::shutdown_on_exit(&app_handle.state::<codeserver::CodeServerState>());
    });
}

/// Give the GUI process a single hidden console on Windows so the console
/// programs we spawn — including ones from third-party crates that don't set
/// `CREATE_NO_WINDOW` (e.g. Jupyter path discovery) — inherit it instead of each
/// flashing its own console window. No-op when a console already exists (e.g.
/// `tauri dev` launched from a terminal) or on non-Windows.
#[cfg(windows)]
fn hide_stray_console() {
    use windows_sys::Win32::System::Console::{AllocConsole, GetConsoleWindow};
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};

    // SAFETY: plain Win32 calls. We allocate a console only when the process has
    // none, then immediately hide its window so it never shows persistently.
    unsafe {
        if GetConsoleWindow().is_null() && AllocConsole() != 0 {
            let console = GetConsoleWindow();
            if !console.is_null() {
                ShowWindow(console, SW_HIDE);
            }
        }
    }
}

#[cfg(not(windows))]
fn hide_stray_console() {}

#[cfg(windows)]
fn apply_windows_taskbar_icon(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, ICON_SMALL2, IMAGE_ICON,
        LR_DEFAULTCOLOR, LR_SHARED, SM_CXICON, SM_CXSMICON, SM_CYICON, SM_CYSMICON, WM_SETICON,
    };

    const APP_ICON_RESOURCE_ID: usize = 32512;

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as HWND;

    unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        if module.is_null() {
            return;
        }

        set_window_icon_from_resource(
            hwnd,
            module,
            ICON_BIG,
            GetSystemMetrics(SM_CXICON),
            GetSystemMetrics(SM_CYICON),
        );
        set_window_icon_from_resource(
            hwnd,
            module,
            ICON_SMALL,
            GetSystemMetrics(SM_CXSMICON),
            GetSystemMetrics(SM_CYSMICON),
        );
        set_window_icon_from_resource(
            hwnd,
            module,
            ICON_SMALL2,
            GetSystemMetrics(SM_CXSMICON),
            GetSystemMetrics(SM_CYSMICON),
        );
    }

    unsafe fn set_window_icon_from_resource(
        hwnd: HWND,
        module: windows_sys::Win32::Foundation::HINSTANCE,
        icon_type: u32,
        width: i32,
        height: i32,
    ) {
        let icon = LoadImageW(
            module,
            APP_ICON_RESOURCE_ID as *const u16,
            IMAGE_ICON,
            width,
            height,
            LR_DEFAULTCOLOR | LR_SHARED,
        );
        if !icon.is_null() {
            SendMessageW(hwnd, WM_SETICON, icon_type as WPARAM, icon as LPARAM);
        }
    }
}

#[cfg(not(windows))]
fn apply_windows_taskbar_icon(_window: &tauri::WebviewWindow) {}

/// Register the executor's transport-verdict callback so a runtime endpoint
/// fallback (responses→chat or chat→responses) is persisted into the
/// verified-executor registry. This turns "learned once per process, re-probed
/// every launch" into a durable fact: the Settings badge and the next launch
/// reflect the endpoint actually used, killing the first-request-per-launch
/// fallback flip on gateways that only serve one endpoint for a model.
fn install_transport_verdict_hook() {
    aris_executor::set_transport_verdict_hook(Box::new(|base_url, model, verdict| {
        config::record_runtime_transport_verdict(base_url, model, verdict);
    }));
}

/// Run one prompt through the real Desktop Chat engine when explicitly
/// requested by an environment variable. This is intentionally opt-in and
/// headless-friendly so diagnostics can exercise SomniQ itself without a
/// second benchmark harness or a synthetic executor stack.
fn spawn_autorun_prompt(app: &tauri::AppHandle) {
    let Some(prompt_path) = std::env::var_os("SOMNIQ_AUTORUN_PROMPT_FILE") else {
        return;
    };
    let prompt_path = PathBuf::from(prompt_path);
    let output_path = std::env::var_os("SOMNIQ_AUTORUN_OUTPUT_FILE").map(PathBuf::from);
    let autorun_effort = std::env::var("SOMNIQ_AUTORUN_REASONING_EFFORT").ok();
    let previous_effort = autorun_effort.as_ref().map(|_| config::reasoning_effort());
    let session_id = std::env::var("SOMNIQ_AUTORUN_SESSION_ID").unwrap_or_else(|_| {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        format!("somni-autorun-{millis}")
    });
    let model = std::env::var("SOMNIQ_AUTORUN_MODEL").ok();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        if let Some(effort) = autorun_effort.as_deref() {
            if let Err(error) = config::set_reasoning_effort(effort) {
                eprintln!("SomniQ autorun: cannot set temporary reasoning effort: {error}");
            }
        }
        let result = match std::fs::read_to_string(&prompt_path) {
            Ok(prompt) => {
                engine::run_background_prompt(app.clone(), session_id.clone(), prompt, model, false)
                    .await
            }
            Err(error) => Err(format!(
                "cannot read autorun prompt {}: {error}",
                prompt_path.display()
            )),
        };
        if let Some(effort) = previous_effort.as_deref() {
            if let Err(error) = config::set_reasoning_effort(effort) {
                eprintln!("SomniQ autorun: cannot restore reasoning effort: {error}");
            }
        }
        let payload = serde_json::json!({
            "session_id": session_id,
            "elapsed_ms": started.elapsed().as_millis(),
            "result": result,
        });
        if let Some(output_path) = output_path {
            if let Err(error) = std::fs::write(
                &output_path,
                serde_json::to_string_pretty(&payload)
                    .unwrap_or_else(|serialization_error| serialization_error.to_string()),
            ) {
                eprintln!(
                    "SomniQ autorun: cannot write {}: {error}",
                    output_path.display()
                );
            }
        } else {
            println!("SomniQ autorun result: {payload}");
        }
        app.exit(0);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_webview2_user_data_dir();
    hide_stray_console();
    augment_path_for_desktop_tools();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .default_version_comparator(|current_version, remote_release| {
                    let remote_release_timestamp =
                        remote_release.pub_date.map(|date| date.unix_timestamp());
                    should_offer_update(
                        &current_version,
                        &remote_release.version,
                        embedded_release_unix_timestamp(),
                        remote_release_timestamp,
                    )
                })
                .build(),
        )
        .manage(engine::ChatState::default())
        .manage(memory::MemoryState::default())
        .manage(ChatCompanionHandoffState::default())
        .manage(compute::ComputeState::default())
        .manage(projects::ProjectState::default())
        .manage(remote::RemoteAgentState::default())
        .manage(codeserver::CodeServerState::default())
        .manage(codebridge::CodeBridgeState::default())
        .setup(|app| {
            let registered_projects = projects::registered_projects(
                app.state::<projects::ProjectState>().inner(),
            )
            .map(|(projects, _)| projects)
            .unwrap_or_default();
            app.state::<memory::MemoryState>()
                .configure(registered_projects);
            if let Some(resource_dir) = resource_dir(app) {
                let resource_dir = normalized_bundled_resource_dir(&resource_dir);
                augment_resource_path_for_mcp(&resource_dir);
                if let Err(error) = config::apply_bundled_internal_config(&resource_dir) {
                    eprintln!("SomniQ internal config import skipped: {error}");
                }
            }
            if let Err(error) = apply_configured_python_environment() {
                eprintln!("SomniQ Python environment configuration skipped: {error}");
            }
            configure_tectonic_environment();
            state::apply_bundle_cache_environment();
            // Export config-held keys (e.g. SCOPUS_API_KEY) before any
            // literature search runs; force=false keeps real env vars intact.
            config::apply_reviewer_environment(false);
            install_transport_verdict_hook();
            // Bound before the Code page can start a workbench: the bridge
            // address is handed to that process in its environment, so the
            // listener has to exist first.
            {
                let handle = app.handle().clone();
                let bridge = app.state::<codebridge::CodeBridgeState>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = codebridge::start(handle, bridge).await {
                        eprintln!("SomniQ code bridge unavailable: {error}");
                    }
                });
            }
            projects::init(&app.state::<projects::ProjectState>())
                .map_err(std::io::Error::other)?;
            let browser_project =
                projects::current_project_path(app.state::<projects::ProjectState>().inner())
                    .map_err(std::io::Error::other)?;
            if let Err(error) = playwright_pdf::initialize(&browser_project) {
                eprintln!("SomniQ Playwright browser startup skipped: {error}");
            }
            compute::init(
                app.handle().clone(),
                app.state::<compute::ComputeState>().inner(),
                app.state::<projects::ProjectState>().inner(),
            )
            .map_err(std::io::Error::other)?;
            remote::init(
                app.handle().clone(),
                app.state::<remote::RemoteAgentState>().inner(),
            )
            .map_err(std::io::Error::other)?;
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/icon.png")) {
                    let _ = window.set_icon(icon);
                }
                apply_windows_taskbar_icon(&window);
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        // The companion's close affordance intentionally hides
                        // it for fast reuse. Once the primary workspace is
                        // actually destroyed, tear the hidden singleton down so
                        // it cannot keep the desktop process alive invisibly.
                        if let Some(companion) = app_handle.get_webview_window("chat-companion") {
                            let _ = companion.destroy();
                        }
                    }
                });
            }
            watcher::spawn_event_watcher(app.handle().clone());
            watcher::spawn_workspace_file_watcher(app.handle().clone());
            mail::spawn_event_watchers(app.handle().clone());
            scheduled::spawn_runner(app.handle().clone());
            spawn_autorun_prompt(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_chat_companion,
            take_chat_companion_handoff,
            commands::skills_list,
            commands::skill_view,
            commands::state_dir,
            commands::local_environment_checks,
            commands::local_environment_check,
            engine::chat_builtin_tool_availability,
            engine::chat_research_provider_availability,
            engine::chat_running_turn_count,
            commands::open_external_url,
            process::background_processes_list,
            process::background_process_stop,
            projects::projects_get,
            projects::project_add,
            projects::project_set_current,
            projects::projects_reorder,
            projects::project_remove,
            git::git_status,
            git::local_review_status,
            git::git_initialize,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_branch_create,
            git::git_branch_switch,
            git::git_diff,
            textdiff::text_diff_lines,
            textdiff::text_three_way_merge,
            workflow::review_workflows_list,
            workflow::review_workflow_load,
            workflow::review_workflow_transcript,
            workflow::review_workflow_create,
            workflow::review_workflow_save,
            workflow::review_workflow_drive_once,
            workflow::review_workflow_submit_scope_plan,
            workflow::review_workflow_confirm_scope_plan,
            workflow::review_workflow_reset_scope_plan,
            workflow::review_workflow_executor_turn,
            workflow::review_workflow_discuss,
            workflow::review_workflow_reviewer_turn,
            workflow::review_workflow_lease_acquire,
            workflow::review_workflow_lease_release,
            workflow::review_workflow_rename,
            workflow::review_workflow_delete,
            compute::compute_node_config_get,
            compute::compute_node_config_set,
            image_assist::image_assist_publish,
            image_assist::image_assist_roster,
            image_assist::image_assist_decide,
            image_assist::image_assist_consent,
            compute::compute_peers_list,
            compute::compute_peer_connect,
            compute::compute_pairing_claim,
            compute::compute_pairing_complete,
            compute::compute_peer_revoke,
            compute::remote_agent_workspace,
            compute::remote_agent_session_create,
            compute::remote_agent_sessions,
            compute::remote_agent_session_open,
            compute::remote_agent_model_options,
            compute::remote_agent_model_set,
            compute::remote_agent_chat_send,
            compute::remote_agent_chat_cancel,
            compute::compute_capabilities,
            compute::compute_jobs_list,
            compute::compute_events_after,
            compute::compute_read_log,
            compute::compute_submit,
            compute::compute_cancel,
            remote::remote_control_status,
            remote::remote_control_create_invitation,
            remote::remote_control_reset_identity,
            remote::remote_control_set_device_name,
            remote::remote_control_disable,
            remote::remote_control_devices,
            remote::remote_control_pending_pairing,
            remote::remote_control_approve_pairing,
            remote::remote_control_discard_pairing,
            remote::remote_control_revoke_device,
            remote::remote_control_p2p_pending,
            remote::remote_control_p2p_offer,
            remote::remote_control_p2p_answer,
            remote::remote_control_p2p_ice_candidate,
            remote::remote_control_p2p_ice_complete,
            remote::remote_control_p2p_opened,
            remote::remote_control_p2p_failed,
            remote::remote_control_p2p_frame,
            remote::remote_control_p2p_closed,
            config::config_get,
            config::config_secret_get,
            config::config_secret_clear,
            config::config_set,
            config::config_test,
            config::web_search_provider_test,
            memory::memory_status,
            memory::memory_v2_status,
            memory::memory_v2_confirm_r3,
            memory::memory_v2_pending_r3,
            memory::memory_v2_wake,
            memory::memory_v2_history_preview,
            memory::memory_v2_import_history,
            memory::memory_v2_rescreen_rejected,
            memory::memory_v2_start_build,
            memory::memory_v2_build_progress,
            memory::memory_purge_legacy_derived,
            memory::memory_explorer_snapshot,
            memory::memory_recall_preview,
            memory::memory_governance_search,
            memory::memory_governance_read_scenario,
            memory::memory_governance_update,
            memory::memory_governance_delete,
            memory::memory_export,
            memory::memory_migration_preview,
            memory::memory_migration_progress,
            memory::memory_migration_execute,
            memory::memory_migration_cancel,
            memory::memory_dead_letters,
            memory::memory_dead_letter_retry,
            memory::memory_rebuild_derived,
            newapi::newapi_auth_status,
            newapi::newapi_logout,
            newapi::newapi_login,
            newapi::newapi_register,
            newapi::newapi_send_verification,
            newapi::newapi_models,
            newapi::newapi_bootstrap,
            newapi::newapi_groups,
            newapi::newapi_update_group,
            newapi::newapi_usage_logs,
            profile::profile_stats,
            scheduled::scheduled_tasks_list,
            scheduled::scheduled_task_create,
            scheduled::scheduled_task_update,
            scheduled::scheduled_task_set_status,
            scheduled::scheduled_task_delete,
            mcp::mcp_config_get,
            mcp::mcp_config_set,
            mcp::mcp_config_test,
            oracle_web::oracle_web_status,
            oracle_web::oracle_web_runtime_install,
            oracle_web::oracle_web_account_create,
            oracle_web::oracle_web_account_login,
            oracle_web::oracle_web_account_model_set,
            oracle_web::oracle_web_account_remove,
            oracle_web::oracle_web_role_set,
            mail::mail_accounts_get,
            mail::mail_connect,
            mail::mail_autoconfig,
            mail::mail_generic_test,
            mail::mail_generic_connect,
            mail::mail_disconnect,
            mail::mail_folders,
            mail::mail_list,
            mail::mail_read,
            mail::mail_modify,
            mail::mail_send,
            sessions::sessions_list,
            sessions::chat_ui_sessions_list,
            sessions::chat_ui_session_load,
            sessions::chat_ui_turn_load,
            sessions::chat_ui_session_save,
            sessions::chat_ui_session_delete,
            sessions::chat_ui_sessions_save,
            chat_events::chat_events_read,
            chat_events::chat_events_replay,
            literature::literature_load,
            literature::literature_library_relations,
            literature::literature_library_model,
            literature::literature_update_collections,
            literature::literature_preferences,
            literature::literature_set_preferences,
            literature::literature_rename_attachments,
            literature::literature_update_relations,
            literature::literature_update_item,
            literature::literature_create_item,
            literature::literature_trash_items,
            literature::literature_restore_items,
            literature::literature_permanently_delete_items,
            literature::literature_update_saved_searches,
            literature::literature_storage_status,
            literature::literature_storage_backup,
            literature::literature_full_text_search,
            literature::literature_search_protocol_create,
            literature::literature_search_protocol_preview,
            literature::literature_search_protocol_execute,
            literature::literature_duplicate_candidates,
            literature::literature_merge_duplicates,
            literature::literature_apply_delta,
            literature::literature_import_bibliography,
            literature::literature_export_bibliography,
            literature::literature_write_bibliography_export,
            literature::literature_import_pdf_as_record,
            literature::literature_import_attachment,
            literature::literature_add_identifier,
            literature::literature_download_pdf,
            literature::literature_llm,
            literature::literature_llm_stream,
            literature::literature_llm_cancel,
            literature::literature_search_cancel,
            literature::literature_review_llm,
            literature::literature_llm_vision,
            literature::literature_rag_index_pdf,
            literature::literature_rag_index_library,
            literature::literature_rag_search,
            literature::literature_rag_status,
            literature::literature_rag_cards,
            literature::literature_pdf_bytes,
            literature::literature_import_pdf,
            literature::literature_image_ocr,
            literature::literature_pdf_open,
            literature::literature_attachment_open,
            literature::literature_attachment_open_external,
            literature::literature_attachment_status,
            literature::literature_attachment_read_text,
            literature::literature_attachment_read_external_text,
            literature::literature_index_attachment_text,
            literature::literature_read_annotation_export,
            literature::literature_write_annotation_export,
            knowledge::knowledge_load,
            knowledge::knowledge_search,
            knowledge::knowledge_retrieval_cards_build,
            knowledge::project_rag_search,
            knowledge::project_rag_answer,
            knowledge::knowledge_upsert,
            knowledge::knowledge_confirm,
            knowledge::knowledge_reject,
            knowledge::knowledge_generate,
            codeserver::code_server_status,
            codeserver::code_server_ensure,
            codeserver::code_server_stop,
            codebridge::code_bridge_connected,
            codebridge::code_bridge_set_theme,
            codebridge::code_bridge_save_all,
            codebridge::code_bridge_reload,
            codebridge::code_bridge_open_file,
            codebridge::code_bridge_open_diff,
            engine::chat_status,
            engine::system_prompt_view,
            engine::user_prompt_view,
            engine::chat_model_options,
            engine::chat_model_set,
            engine::chat_reasoning_effort_get,
            engine::chat_reasoning_effort_set,
            engine::chat_permission_get,
            engine::chat_permission_set,
            engine::chat_permission_respond,
            engine::chat_question_respond,
            engine::chat_command_specs,
            engine::chat_run_command,
            engine::chat_send_rich,
            engine::chat_suggest_title,
            engine::project_brief_get,
            engine::project_brief_review,
            engine::project_intent_observe,
            engine::chat_rewind_to_user_message,
            engine::chat_context_tokens,
            engine::chat_tasks_get,
            engine::chat_set_context,
            engine::chat_delete,
            engine::chat_cancel,
            engine::chat_review_clear,
            engine::chat_change_revert,
            engine::chat_debug_zip_export,
            files::file_list_dir,
            files::typeset_list_documents,
            files::file_read_text,
            files::file_write_text,
            files::file_create_text,
            files::file_create_dir,
            files::file_rename,
            files::file_duplicate,
            files::file_delete,
            files::file_read_bytes,
            files::file_read_bytes_info,
            files::file_read_bytes_range,
            files::file_asset_path,
            files::file_search,
            files::file_read,
            files::chat_import_attachment,
            files::chat_import_attachment_data,
            files::typeset_import_image_data,
            files::file_open,
            files::file_reveal,
            typeset::latex_compile,
            typeset::typeset_export_file,
            typeset::typeset_export_project,
            typeset::typeset_output_files,
            typeset::typeset_import_file,
            typeset::latex_compile_cancel,
            typeset::latex_document_context,
            typeset::latex_forward_search,
            typeset::latex_inverse_search,
            typeset_state::typeset_recovery_save,
            typeset_state::typeset_recovery_load,
            typeset_state::typeset_recovery_clear,
            typeset_state::typeset_change_proposal_save,
            typeset_state::typeset_change_proposal_load,
            typeset_state::typeset_change_proposal_clear,
            typeset_state::typeset_comments_list,
            typeset_state::typeset_comment_upsert,
            typeset_state::typeset_comment_delete,
            typeset_state::typeset_history_create,
            typeset_state::typeset_history_list,
            typeset_state::typeset_history_read,
            typeset_state::typeset_revision_capture,
            typeset_state::typeset_revision_list,
            typeset_state::typeset_revision_read,
            typeset_state::typeset_revision_compare,
            typeset_state::typeset_revision_restore_file,
            typeset_state::typeset_revision_restore_project,
            typeset_state::typeset_revision_export_zip,
            typeset_state::typeset_changeset_create,
            typeset_state::typeset_changeset_list,
            typeset_state::typeset_changeset_read_text,
            typeset_state::typeset_changeset_stage_text,
            typeset_state::typeset_changeset_resolve,
            typeset_state::typeset_project_search,
            typeset_state::typeset_project_replace,
        ])
        .build(tauri::generate_context!())
        .expect("error while building SomniQ Studio")
        .run(|app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                cleanup_before_exit(app_handle);
            }
        });
}

/// The one lock for tests that repoint the process-global environment (`HOME`,
/// `ARIS_CONFIG_ROOT`, `ARIS_RUNTIME_ROOT`, …) or that resolve paths through it.
///
/// Path lookups fall back to those variables whenever a thread-local execution
/// context does not override the name, so a fixture that swaps them mid-run can
/// pull the ground out from under any test running in parallel. Per-module
/// locks only serialised each module against itself, which is why the config
/// and remote-session tests failed intermittently.
///
/// Deliberately not `engine::project_env_lock`: production code `try_lock`s that
/// one and reports "project busy" when it is held, so a test must never hold it
/// for the length of a test body.
#[cfg(test)]
pub(crate) fn test_env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
#[path = "tests/lib.rs"]
mod tests;
