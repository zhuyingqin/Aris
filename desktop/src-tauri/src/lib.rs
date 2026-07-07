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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    hide_stray_console();
    augment_path_for_desktop_tools();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(engine::ChatState::default())
        .manage(projects::ProjectState::default())
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
            sessions::chat_ui_sessions_load,
            sessions::chat_ui_sessions_save,
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
            engine::chat_reset,
            engine::chat_set_context,
            engine::chat_delete,
            engine::chat_cancel,
            usage_log::chat_usage_summary,
            files::file_list_dir,
            files::file_read_text,
            files::file_write_text,
            files::file_create_text,
            files::file_read_bytes,
            files::file_search,
            files::file_read,
            files::file_open,
            files::project_chat_starters,
            typeset::latex_compile,
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
mod tests {
    use super::{configure_bundled_tectonic_environment, tectonic_binary_name};
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn temp_resource_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("somniq-tectonic-env-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).expect("create temp resource bin");
        dir
    }

    fn restore_env(
        previous_somniq: Option<std::ffi::OsString>,
        previous_aris: Option<std::ffi::OsString>,
    ) {
        match previous_somniq {
            Some(value) => std::env::set_var("SOMNIQ_TECTONIC", value),
            None => std::env::remove_var("SOMNIQ_TECTONIC"),
        }
        match previous_aris {
            Some(value) => std::env::set_var("ARIS_TECTONIC", value),
            None => std::env::remove_var("ARIS_TECTONIC"),
        }
    }

    #[test]
    fn bundled_tectonic_sets_env_when_present() {
        let _guard = env_lock();
        let previous_somniq = std::env::var_os("SOMNIQ_TECTONIC");
        let previous_aris = std::env::var_os("ARIS_TECTONIC");
        std::env::remove_var("SOMNIQ_TECTONIC");
        std::env::remove_var("ARIS_TECTONIC");
        let dir = temp_resource_dir("sets");
        let bundled = dir.join("bin").join(tectonic_binary_name());
        std::fs::write(&bundled, b"tectonic").expect("write bundled tectonic marker");

        configure_bundled_tectonic_environment(&dir);

        assert_eq!(
            std::env::var_os("SOMNIQ_TECTONIC").as_deref(),
            Some(bundled.as_os_str())
        );
        assert_eq!(
            std::env::var_os("ARIS_TECTONIC").as_deref(),
            Some(bundled.as_os_str())
        );
        let _ = std::fs::remove_dir_all(dir);
        restore_env(previous_somniq, previous_aris);
    }

    #[test]
    fn bundled_tectonic_preserves_valid_override() {
        let _guard = env_lock();
        let previous_somniq = std::env::var_os("SOMNIQ_TECTONIC");
        let previous_aris = std::env::var_os("ARIS_TECTONIC");
        let dir = temp_resource_dir("preserves");
        let bundled = dir.join("bin").join(tectonic_binary_name());
        std::fs::write(&bundled, b"tectonic").expect("write bundled tectonic marker");
        let override_path = dir.join("custom-tectonic.exe");
        std::fs::write(&override_path, b"custom").expect("write override marker");
        std::env::set_var("SOMNIQ_TECTONIC", &override_path);
        std::env::remove_var("ARIS_TECTONIC");

        configure_bundled_tectonic_environment(&dir);

        assert_eq!(
            std::env::var_os("SOMNIQ_TECTONIC").as_deref(),
            Some(override_path.as_os_str())
        );
        assert!(std::env::var_os("ARIS_TECTONIC").is_none());
        let _ = std::fs::remove_dir_all(dir);
        restore_env(previous_somniq, previous_aris);
    }
}
