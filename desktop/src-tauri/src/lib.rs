mod commands;
mod config;
mod engine;
mod files;
mod literature;
mod process;
mod projects;
mod sessions;
mod state;
mod watcher;

use tauri::{image::Image, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            sessions::sessions_list,
            sessions::session_get,
            sessions::chat_ui_sessions_load,
            sessions::chat_ui_sessions_save,
            literature::literature_load,
            literature::literature_save,
            literature::literature_search,
            literature::literature_download_pdf,
            literature::literature_llm,
            literature::literature_pdf_text,
            engine::chat_status,
            engine::chat_command_specs,
            engine::chat_run_command,
            engine::chat_send,
            engine::chat_send_rich,
            engine::literature_agent_send_rich,
            engine::chat_reset,
            engine::chat_set_context,
            engine::chat_delete,
            engine::chat_cancel,
            files::file_search,
            files::file_read,
            files::project_chat_starters,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ARIS Studio");
}
