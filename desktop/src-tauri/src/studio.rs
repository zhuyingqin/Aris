//! Thin desktop commands over the shared Studio review index.

use std::path::Path;

use serde_json::Value;
use tauri::State;

use crate::projects::{self, ProjectState};

const MAX_STUDIO_HTML_BYTES: u64 = 10 * 1024 * 1024;

#[tauri::command]
pub fn studio_load(projects_state: State<ProjectState>) -> Result<Value, String> {
    tools::studio::library_load_at(&projects::current_project_path(&projects_state)?)
}

#[tauri::command]
pub fn studio_save(projects_state: State<ProjectState>, library: Value) -> Result<(), String> {
    tools::studio::library_save_at(&projects::current_project_path(&projects_state)?, &library)
}

#[tauri::command]
pub fn studio_html(
    projects_state: State<ProjectState>,
    relative_path: String,
) -> Result<String, String> {
    studio_html_at(
        &projects::current_project_path(&projects_state)?,
        &relative_path,
    )
}

fn studio_html_at(base: &Path, relative_path: &str) -> Result<String, String> {
    let relative = Path::new(relative_path.trim());
    if relative_path.trim().is_empty() || relative.is_absolute() {
        return Err("Studio HTML path must be a non-empty project-relative path".to_string());
    }
    let base = base.canonicalize().map_err(|error| error.to_string())?;
    let target = base
        .join(relative)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !target.starts_with(&base) {
        return Err("Studio HTML path must stay inside the current project".to_string());
    }
    if !matches!(
        target.extension().and_then(|value| value.to_str()),
        Some(extension) if extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
    ) {
        return Err("Studio web previews only support .html and .htm files".to_string());
    }
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_STUDIO_HTML_BYTES {
        return Err(format!(
            "Studio HTML preview exceeds the {} MB limit",
            MAX_STUDIO_HTML_BYTES / 1024 / 1024
        ));
    }
    std::fs::read_to_string(target).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::studio_html_at;

    #[test]
    fn reads_project_local_html_and_rejects_non_html() {
        let base = std::env::temp_dir().join(format!(
            "aris-studio-html-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("base");
        std::fs::write(base.join("preview.html"), "<h1>Ready</h1>").expect("html");
        std::fs::write(base.join("notes.txt"), "private").expect("text");

        assert_eq!(
            studio_html_at(&base, "preview.html").expect("preview"),
            "<h1>Ready</h1>"
        );
        assert!(studio_html_at(&base, "notes.txt")
            .expect_err("non-html rejected")
            .contains("only support"));
        let _ = std::fs::remove_dir_all(base);
    }
}
