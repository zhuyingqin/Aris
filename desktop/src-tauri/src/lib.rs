mod commands;
mod config;
mod engine;
mod files;
mod sessions;
mod state;
mod watcher;

use tauri::{image::Image, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(engine::ChatState::default())
        .setup(|app| {
            state::init_workspace_environment()?;
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
            config::config_get,
            config::config_set,
            config::config_test,
            sessions::sessions_list,
            sessions::session_get,
            sessions::chat_ui_sessions_load,
            sessions::chat_ui_sessions_save,
            engine::chat_status,
            engine::chat_send,
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
