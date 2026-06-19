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
mod tests {
    use super::allowed_external_url;

    #[test]
    fn external_url_scheme_filter_allows_browser_links() {
        assert!(allowed_external_url("https://example.com/path"));
        assert!(allowed_external_url("http://example.com"));
        assert!(allowed_external_url("mailto:hello@example.com"));
        assert!(allowed_external_url("tel:+15551234567"));
    }

    #[test]
    fn external_url_scheme_filter_blocks_unsafe_links() {
        assert!(!allowed_external_url("javascript:alert(1)"));
        assert!(!allowed_external_url("data:text/html,<script></script>"));
        assert!(!allowed_external_url("/relative/path"));
        assert!(!allowed_external_url("https://example.com/\nnext"));
    }
}
