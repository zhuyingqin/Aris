//! Small Tauri command surface for app-level metadata.

use crate::state;

#[tauri::command]
pub fn skills_list() -> Vec<tools::SkillMeta> {
    tools::discover_skills()
}

#[tauri::command]
pub fn skill_view(name: String) -> Result<String, String> {
    tools::skill_markdown(&name).ok_or_else(|| format!("skill not found: {name}"))
}

#[tauri::command]
pub fn state_dir() -> String {
    state::state_root().display().to_string()
}
