mod commands;
mod config;
mod engine;
mod sessions;
mod state;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(engine::ChatState::default())
        .setup(|app| {
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
            sessions::sessions_list,
            sessions::session_get,
            engine::chat_status,
            engine::chat_send,
            engine::chat_reset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ARIS Studio");
}
