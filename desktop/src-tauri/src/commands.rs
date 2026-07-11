//! Small Tauri command surface for app-level metadata.

pub use crate::env::LocalEnvironmentCheck;

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

#[tauri::command]
pub async fn local_environment_checks(
    force_refresh: Option<bool>,
) -> Result<Vec<LocalEnvironmentCheck>, String> {
    crate::env::get_or_probe(force_refresh.unwrap_or(false)).await
}

fn allowed_external_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return false;
    }
    let Some((scheme, _)) = trimmed.split_once(':') else {
        return false;
    };
    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "mailto" | "tel"
    )
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !allowed_external_url(trimmed) {
        return Err("unsupported external URL scheme".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut command = crate::process::hidden_command("rundll32");
    #[cfg(target_os = "windows")]
    command.args(["url.dll,FileProtocolHandler", trimmed]);

    #[cfg(target_os = "macos")]
    let mut command = crate::process::hidden_command("open");
    #[cfg(target_os = "macos")]
    command.arg(trimmed);

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = crate::process::hidden_command("xdg-open");
    #[cfg(all(unix, not(target_os = "macos")))]
    command.arg(trimmed);

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "tests/commands.rs"]
mod tests;
