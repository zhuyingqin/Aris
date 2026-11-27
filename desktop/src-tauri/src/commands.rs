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

#[tauri::command]
pub async fn local_environment_check(id: String) -> Result<LocalEnvironmentCheck, String> {
    crate::env::get_or_probe_one(&id).await
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

/// Run in every frame of the app's windows before the frame's own scripts:
/// a frame without an origin of its own (a plugin page, or a frame such a page
/// created) loses WebRTC, which its CSP cannot stop.
pub const OPAQUE_FRAME_GUARD: &str = include_str!("opaque_frame_guard.js");

/// What every app window is built with: new windows go to the system browser,
/// and frames without an origin of their own get no WebRTC.
pub fn harden_app_webview<R: tauri::Runtime>(
    builder: tauri::WebviewWindowBuilder<'_, R, tauri::AppHandle<R>>,
) -> tauri::WebviewWindowBuilder<'_, R, tauri::AppHandle<R>> {
    route_new_windows_to_browser(builder).initialization_script_for_all_frames(OPAQUE_FRAME_GUARD)
}

/// Every new-window request of an app webview (`target="_blank"`,
/// `window.open`, from the app or from a frame it embeds, such as a plugin's
/// web panel) goes to the system browser; the webview itself never opens a
/// second window. Without a handler WebView2 drops these requests silently.
pub fn route_new_windows_to_browser<R: tauri::Runtime>(
    builder: tauri::WebviewWindowBuilder<'_, R, tauri::AppHandle<R>>,
) -> tauri::WebviewWindowBuilder<'_, R, tauri::AppHandle<R>> {
    builder.on_new_window(|url, _features| {
        if let Err(error) = open_external_url(url.to_string()) {
            eprintln!("SomniQ refused to open a new window for {}: {error}", url.scheme());
        }
        tauri::webview::NewWindowResponse::Deny
    })
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
