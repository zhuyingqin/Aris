mod chat_events;
mod commands;
mod config;
mod connectors;
mod engine;
mod env;
mod files;
mod knowledge;
mod lab;
mod literature;
mod mail;
mod mcp;
mod newapi;
mod process;
mod projects;
mod scheduled;
mod sessions;
mod state;
mod studio;
mod terminal;
mod typeset;
mod usage_log;
mod watcher;

use std::path::PathBuf;
use std::sync::Once;
use tauri::{image::Image, Manager};

static SHUTDOWN_CLEANUP: Once = Once::new();

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

fn cleanup_before_exit(app_handle: &tauri::AppHandle) {
    SHUTDOWN_CLEANUP.call_once(|| {
        let chat_state = app_handle.state::<engine::ChatState>();
        engine::cancel_all_running_turns(chat_state.inner());
        notebook::KernelManager::shutdown_all();
        runtime::terminate_all_managed_processes();
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_webview2_user_data_dir();
    hide_stray_console();
    augment_path_for_desktop_tools();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(engine::ChatState::default())
        .manage(projects::ProjectState::default())
        .manage(terminal::TerminalState::default())
        .setup(|app| {
            if let Some(resource_dir) = resource_dir(app) {
                augment_resource_path_for_mcp(&resource_dir);
                if let Err(error) = config::apply_bundled_internal_config(&resource_dir) {
                    eprintln!("SomniQ internal config import skipped: {error}");
                }
            }
            configure_tectonic_environment();
            state::apply_bundle_cache_environment();
            // Export config-held keys (e.g. SCOPUS_API_KEY) before any
            // literature search runs; force=false keeps real env vars intact.
            config::apply_reviewer_environment(false);
            projects::init(&app.state::<projects::ProjectState>())
                .map_err(std::io::Error::other)?;
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/icon.png")) {
                    let _ = window.set_icon(icon);
                }
                apply_windows_taskbar_icon(&window);
            }
            watcher::spawn_event_watcher(app.handle().clone());
            mail::spawn_event_watchers(app.handle().clone());
            scheduled::spawn_runner(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::skills_list,
            commands::skill_view,
            commands::state_dir,
            commands::local_environment_checks,
            commands::open_external_url,
            projects::projects_get,
            projects::project_add,
            projects::project_set_current,
            projects::projects_reorder,
            config::config_get,
            config::config_secret_get,
            config::config_set,
            config::config_test,
            config::provider_test,
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
            connectors::connector_plugins_list,
            connectors::connector_connect,
            scheduled::scheduled_tasks_list,
            scheduled::scheduled_task_create,
            scheduled::scheduled_task_update,
            scheduled::scheduled_task_set_status,
            scheduled::scheduled_task_delete,
            mcp::mcp_config_get,
            mcp::mcp_config_set,
            mcp::mcp_config_test,
            mail::mail_accounts_get,
            mail::mail_oauth_config_get,
            mail::mail_oauth_config_set,
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
            sessions::session_get,
            sessions::chat_ui_sessions_list,
            sessions::chat_ui_session_load,
            sessions::chat_ui_turn_load,
            sessions::chat_ui_session_save,
            sessions::chat_ui_session_delete,
            sessions::chat_ui_sessions_load,
            sessions::chat_ui_sessions_save,
            chat_events::chat_events_read,
            chat_events::chat_events_export,
            chat_events::chat_events_replay,
            chat_events::chat_events_restore,
            literature::literature_load,
            literature::literature_save,
            literature::literature_search,
            literature::literature_library_upsert,
            literature::literature_download_pdf,
            literature::literature_llm,
            literature::literature_review_llm,
            literature::literature_llm_vision,
            literature::literature_pdf_text,
            literature::literature_pdf_bytes,
            literature::literature_import_pdf,
            literature::literature_image_ocr,
            literature::literature_pdf_open,
            studio::studio_load,
            studio::studio_save,
            studio::studio_html,
            knowledge::knowledge_load,
            knowledge::knowledge_search,
            knowledge::knowledge_upsert,
            knowledge::knowledge_confirm,
            knowledge::knowledge_reject,
            knowledge::knowledge_generate,
            lab::lab_list_kernels,
            lab::lab_list_kernelspecs,
            lab::lab_list_notebooks,
            lab::lab_load_notebook,
            lab::lab_create_notebook,
            lab::lab_save_notebook,
            lab::lab_edit_cell,
            lab::lab_set_kernelspec,
            lab::lab_start_kernel,
            lab::lab_execute_cell,
            lab::lab_complete,
            lab::lab_inspect,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            lab::lab_shutdown_kernel,
            lab::lab_interrupt_kernel,
            lab::lab_start_file_kernel,
            lab::lab_execute_file,
            lab::lab_interrupt_file_kernel,
            lab::lab_shutdown_file_kernel,
            lab::lab_inspect_file_vars,
            lab::lab_inspect_vars,
            lab::lab_run_all,
            lab::runs_load,
            lab::runs_save,
            lab::lab_run_sweep,
            lab::lab_export_sweep_manifest,
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
            engine::project_permission_get,
            engine::project_permission_set,
            engine::chat_command_specs,
            engine::chat_run_command,
            engine::chat_send,
            engine::chat_send_rich,
            engine::literature_agent_send_rich,
            engine::studio_agent_send_rich,
            engine::chat_suggest_title,
            engine::project_brief_get,
            engine::project_intent_observe,
            engine::project_goal_progress,
            engine::chat_reset,
            engine::chat_rewind_to_user_message,
            engine::chat_set_context,
            engine::chat_delete,
            engine::chat_cancel,
            engine::chat_change_revert,
            engine::chat_debug_zip_export,
            usage_log::chat_usage_summary,
            files::file_list_dir,
            files::file_read_text,
            files::file_write_text,
            files::file_create_text,
            files::file_create_dir,
            files::file_rename,
            files::file_duplicate,
            files::file_delete,
            files::file_read_bytes,
            files::file_search,
            files::file_read,
            files::file_open,
            files::file_reveal,
            files::project_chat_starters,
            typeset::latex_compile,
            typeset::latex_forward_search,
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

#[cfg(test)]
#[path = "tests/lib.rs"]
mod tests;
