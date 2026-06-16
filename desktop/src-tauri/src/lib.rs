mod commands;
mod config;
mod engine;
mod files;
mod im_bridge;
mod knowledge;
mod literature;
mod mcp;
mod process;
mod projects;
mod sessions;
mod state;
mod studio;
mod watcher;

use tauri::{image::Image, Manager};

/// Extend the process PATH with common user-installed tool directories so that
/// MCP stdio servers (node, npx, uvx, python, etc.) can be found when the app
/// is launched from a desktop shortcut on Windows, which does not inherit the
/// full shell PATH.
#[cfg(windows)]
fn augment_path_for_mcp() {
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
        // Python Launcher / standard Python installs
        format!("{home}\\AppData\\Local\\Programs\\Python\\Python312"),
        format!("{home}\\AppData\\Local\\Programs\\Python\\Python311"),
        format!("{home}\\AppData\\Local\\Programs\\Python\\Python310"),
        // Scoop shims
        format!("{home}\\scoop\\shims"),
    ];
    let existing = std::env::var("PATH").unwrap_or_default();
    let mut extras: Vec<String> = candidates
        .into_iter()
        .filter(|p| std::path::Path::new(p).exists() && !existing.contains(p.as_str()))
        .collect();
    if !extras.is_empty() {
        extras.push(existing);
        std::env::set_var("PATH", extras.join(";"));
    }
}

#[cfg(not(windows))]
fn augment_path_for_mcp() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    augment_path_for_mcp();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(engine::ChatState::default())
        .manage(projects::ProjectState::default())
        .setup(|app| {
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workflow_plan,
            commands::workflow_list,
            commands::workflow_inspect,
            commands::workflow_start,
            commands::workflow_control,
            commands::workflow_save,
            commands::workflow_discover,
            commands::team_list,
            commands::agent_supervisor,
            commands::skills_list,
            commands::skill_view,
            commands::state_dir,
            projects::projects_get,
            projects::project_add,
            projects::project_set_current,
            projects::projects_reorder,
            config::config_get,
            config::config_set,
            config::config_test,
            im_bridge::im_bridge_get,
            im_bridge::im_bridge_set,
            im_bridge::im_bridge_test_qq,
            im_bridge::im_bridge_start,
            im_bridge::im_bridge_stop,
            im_bridge::im_bridge_logs,
            mcp::mcp_config_get,
            mcp::mcp_config_set,
            mcp::mcp_config_test,
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
            engine::chat_status,
            engine::chat_model_options,
            engine::chat_model_set,
            engine::chat_permission_get,
            engine::chat_permission_set,
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
            files::file_search,
            files::file_read,
            files::file_open,
            files::project_chat_starters,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ARIS Studio");
}
