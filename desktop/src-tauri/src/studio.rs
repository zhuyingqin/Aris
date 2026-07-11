//! Thin desktop commands over the shared Studio review index.

use std::path::Path;

use serde_json::Value;
use tauri::State;

use crate::projects::{self, ProjectState};

const MAX_STUDIO_HTML_BYTES: u64 = 10 * 1024 * 1024;
const MAX_STUDIO_CSS_BYTES: u64 = 2 * 1024 * 1024;

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
    let html = std::fs::read_to_string(&target).map_err(|error| error.to_string())?;
    Ok(inline_local_stylesheets(&base, &target, html))
}

fn inline_local_stylesheets(base: &Path, html_path: &Path, html: String) -> String {
    let mut output = String::with_capacity(html.len());
    let mut cursor = 0;
    while let Some(offset) = find_ascii_case_insensitive(&html[cursor..], "<link") {
        let start = cursor + offset;
        let Some(tag_end_offset) = html[start..].find('>') else {
            break;
        };
        let end = start + tag_end_offset + 1;
        let tag = &html[start..end];
        if is_stylesheet_link(tag) {
            if let Some(href) = tag_attr(tag, "href") {
                if let Some(css) = read_local_stylesheet(base, html_path, &href) {
                    output.push_str(&html[cursor..start]);
                    output.push_str("<style data-somniq-inline=\"");
                    output.push_str(&escape_html_attr(&href));
                    output.push_str("\">\n");
                    output.push_str(&css.replace("</style", "<\\/style"));
                    output.push_str("\n</style>");
                    cursor = end;
                    continue;
                }
            }
        }
        output.push_str(&html[cursor..end]);
        cursor = end;
    }
    output.push_str(&html[cursor..]);
    output
}

fn is_stylesheet_link(tag: &str) -> bool {
    tag_attr(tag, "rel").is_some_and(|rel| {
        rel.split_ascii_whitespace()
            .any(|part| part.eq_ignore_ascii_case("stylesheet"))
    })
}

fn read_local_stylesheet(base: &Path, html_path: &Path, href: &str) -> Option<String> {
    let href = href.split(['?', '#']).next().unwrap_or_default().trim();
    if href.is_empty() || is_external_resource(href) {
        return None;
    }
    let relative = Path::new(href);
    if relative.is_absolute() || href.starts_with('/') || href.starts_with('\\') {
        return None;
    }
    let target = html_path.parent()?.join(relative).canonicalize().ok()?;
    if !target.starts_with(base) {
        return None;
    }
    if !target
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("css"))
    {
        return None;
    }
    if std::fs::metadata(&target).ok()?.len() > MAX_STUDIO_CSS_BYTES {
        return None;
    }
    std::fs::read_to_string(target).ok()
}

fn is_external_resource(href: &str) -> bool {
    let value = href.to_ascii_lowercase();
    value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("//")
        || value.starts_with("data:")
        || value.starts_with("blob:")
        || value.starts_with("javascript:")
}

fn tag_attr(tag: &str, name: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        while index < bytes.len() && !is_attr_name_byte(bytes[index]) {
            index += 1;
        }
        let key_start = index;
        while index < bytes.len() && is_attr_name_byte(bytes[index]) {
            index += 1;
        }
        if key_start == index {
            break;
        }
        let key = &tag[key_start..index];
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] != b'=' {
            continue;
        }
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        let value;
        if bytes[index] == b'"' || bytes[index] == b'\'' {
            let quote = bytes[index];
            index += 1;
            let value_start = index;
            while index < bytes.len() && bytes[index] != quote {
                index += 1;
            }
            value = &tag[value_start..index];
            if index < bytes.len() {
                index += 1;
            }
        } else {
            let value_start = index;
            while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'>'
            {
                index += 1;
            }
            value = &tag[value_start..index];
        }
        if key.eq_ignore_ascii_case(name) {
            return Some(value.to_string());
        }
    }
    None
}

fn is_attr_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-')
}

fn find_ascii_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn escape_html_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
#[path = "tests/studio.rs"]
mod tests;
