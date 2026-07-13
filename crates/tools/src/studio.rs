//! Shared Studio artifact index.
//!
//! Studio is a review surface for externally generated slides and posters.
//! Generation and rendering remain skill-owned; this module only discovers
//! results and maintains `studio/library.json` without overwriting user review
//! state.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};

use crate::{layout, read_json_file};

const USER_STATE_FIELDS: &[&str] = &["title", "pinned", "notes", "pageReviews"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioLibraryUpsertInput {
    pub artifacts: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioUpsertStats {
    pub added: usize,
    pub merged: usize,
    pub total: usize,
    pub library_path: String,
    pub studio_links: Vec<StudioArtifactLink>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioArtifactLink {
    pub id: String,
    pub title: String,
    pub href: String,
}

pub fn run_studio_library_upsert(input: StudioLibraryUpsertInput) -> Result<String, String> {
    let stats = library_upsert_at(
        &std::env::current_dir().map_err(|error| error.to_string())?,
        &input.artifacts,
    )?;
    serde_json::to_string_pretty(&stats).map_err(|error| error.to_string())
}

pub fn library_path_at(base: &Path) -> PathBuf {
    layout::studio_library_path_at(base)
}

#[must_use]
pub fn empty_library() -> Value {
    json!({ "version": 1, "artifacts": [] })
}

pub fn library_load_at(base: &Path) -> Result<Value, String> {
    let path = library_path_at(base);
    let backup = path.with_extension("json.bak");
    let mut library = if !path.exists() {
        if backup.exists() {
            read_json_file(&backup)?
        } else {
            empty_library()
        }
    } else {
        match read_json_file(&path) {
            Ok(library) => library,
            Err(primary_error) if backup.exists() => {
                read_json_file(&backup).map_err(|backup_error| {
                    format!("{primary_error}; backup recovery failed: {backup_error}")
                })?
            }
            Err(error) => return Err(error),
        }
    };
    if !library.is_object() {
        library = empty_library();
    }
    let discovered = discover_artifacts_at(base);
    if !discovered.is_empty() && add_discovered_artifacts(&mut library, &discovered)? > 0 {
        library_save_at(base, &library)?;
    }
    Ok(library)
}

pub fn library_save_at(base: &Path, library: &Value) -> Result<(), String> {
    if !library.is_object() {
        return Err("library must be a JSON object".to_string());
    }
    if !library["artifacts"].is_array() {
        return Err("library.artifacts must be an array".to_string());
    }
    let path = library_path_at(base);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let data = serde_json::to_vec_pretty(library).map_err(|error| error.to_string())?;
    std::fs::write(&tmp, data).map_err(|error| error.to_string())?;
    let had_existing = path.exists();
    if had_existing {
        std::fs::copy(&path, &backup).map_err(|error| error.to_string())?;
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    if let Err(error) = std::fs::rename(&tmp, &path) {
        if had_existing {
            let _ = std::fs::copy(&backup, &path);
        }
        return Err(format!("failed to replace studio/library.json: {error}"));
    }
    Ok(())
}

pub fn library_upsert_at(base: &Path, artifacts: &[Value]) -> Result<StudioUpsertStats, String> {
    let mut library = library_load_at(base)?;
    let (added, merged) = merge_artifacts(&mut library, artifacts)?;
    let total = library["artifacts"].as_array().map_or(0, Vec::len);
    library_save_at(base, &library)?;
    Ok(StudioUpsertStats {
        added,
        merged,
        total,
        library_path: format!("{}/{}", layout::STUDIO_DIR, layout::STUDIO_LIBRARY_FILE),
        studio_links: artifacts.iter().filter_map(studio_artifact_link).collect(),
    })
}

fn studio_artifact_link(artifact: &Value) -> Option<StudioArtifactLink> {
    if !valid_artifact(artifact) {
        return None;
    }
    let normalized = normalize_artifact(artifact);
    let id = normalized["id"].as_str()?.to_string();
    let title = normalized["title"].as_str().unwrap_or(&id).to_string();
    Some(StudioArtifactLink {
        href: format!("studio/artifact/{}", percent_encode_path_segment(&id)),
        id,
        title,
    })
}

fn percent_encode_path_segment(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn merge_artifacts(library: &mut Value, records: &[Value]) -> Result<(usize, usize), String> {
    let artifacts = library
        .as_object_mut()
        .expect("library is an object")
        .entry("artifacts")
        .or_insert_with(|| Value::Array(Vec::new()));
    let Value::Array(artifacts) = artifacts else {
        return Err("library.artifacts must be an array".to_string());
    };
    let mut added = 0;
    let mut merged = 0;
    for record in records {
        if !valid_artifact(record) {
            continue;
        }
        if let Some(existing) = artifacts
            .iter_mut()
            .find(|artifact| same_artifact(artifact, record))
        {
            merge_artifact(existing, record);
            merged += 1;
        } else {
            artifacts.insert(0, normalize_artifact(record));
            added += 1;
        }
    }
    Ok((added, merged))
}

fn add_discovered_artifacts(library: &mut Value, records: &[Value]) -> Result<usize, String> {
    let artifacts = library
        .as_object_mut()
        .expect("library is an object")
        .entry("artifacts")
        .or_insert_with(|| Value::Array(Vec::new()));
    let Value::Array(artifacts) = artifacts else {
        return Err("library.artifacts must be an array".to_string());
    };
    let mut added = 0;
    for record in records {
        if valid_artifact(record)
            && !artifacts
                .iter()
                .any(|artifact| same_artifact(artifact, record))
        {
            artifacts.insert(0, normalize_artifact(record));
            added += 1;
        }
    }
    Ok(added)
}

fn valid_artifact(artifact: &Value) -> bool {
    artifact["kind"]
        .as_str()
        .is_some_and(|kind| matches!(kind, "slides" | "poster" | "web"))
        && ["pdfPath", "pptxPath", "svgPath", "texPath", "htmlPath"]
            .into_iter()
            .any(|field| {
                artifact[field]
                    .as_str()
                    .is_some_and(|path| !path.trim().is_empty())
            })
}

fn same_artifact(left: &Value, right: &Value) -> bool {
    let left_id = left["id"].as_str().unwrap_or_default();
    let right_id = right["id"].as_str().unwrap_or_default();
    if !left_id.is_empty() && !right_id.is_empty() {
        return left_id == right_id;
    }
    left["kind"] == right["kind"]
        && ["pdfPath", "pptxPath", "svgPath", "texPath", "htmlPath"]
            .into_iter()
            .any(|field| {
                let left_path = left[field].as_str().unwrap_or_default();
                !left_path.is_empty() && left_path == right[field].as_str().unwrap_or_default()
            })
}

fn merge_artifact(existing: &mut Value, incoming: &Value) {
    let Some(existing) = existing.as_object_mut() else {
        *existing = normalize_artifact(incoming);
        return;
    };
    let Some(incoming) = incoming.as_object() else {
        return;
    };
    for (key, value) in incoming {
        if USER_STATE_FIELDS.contains(&key.as_str()) && existing.contains_key(key) {
            continue;
        }
        if !value.is_null() {
            existing.insert(key.clone(), value.clone());
        }
    }
}

fn normalize_artifact(record: &Value) -> Value {
    let mut artifact = record.as_object().cloned().unwrap_or_default();
    let kind = artifact
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("slides")
        .to_string();
    artifact
        .entry("id".to_string())
        .or_insert_with(|| Value::String(format!("{kind}:main")));
    artifact.entry("title".to_string()).or_insert_with(|| {
        Value::String(
            if kind == "poster" {
                "Poster"
            } else if kind == "web" {
                "Web"
            } else {
                "Slides"
            }
            .to_string(),
        )
    });
    artifact
        .entry("status".to_string())
        .or_insert_with(|| Value::String("ready".to_string()));
    artifact
        .entry("pinned".to_string())
        .or_insert(Value::Bool(false));
    artifact
        .entry("notes".to_string())
        .or_insert_with(|| Value::String(String::new()));
    artifact
        .entry("pageReviews".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    artifact
        .entry("generatedAt".to_string())
        .or_insert_with(|| Value::String(runtime::now_iso8601()));
    Value::Object(artifact)
}

fn discover_artifacts_at(base: &Path) -> Vec<Value> {
    let mut artifacts = Vec::new();
    artifacts.extend(discover_standard_artifacts_at(base, "slides"));
    artifacts.extend(discover_standard_artifacts_at(base, "poster"));
    artifacts.extend(discover_web_artifacts_at(base));
    artifacts
}

fn discover_standard_artifacts_at(base: &Path, kind: &str) -> Vec<Value> {
    let Some(directory) = layout::standard_artifact_dir_at(base, kind) else {
        return Vec::new();
    };
    if !directory.is_dir() {
        return Vec::new();
    }
    let mut artifacts = Vec::new();
    if let Some(artifact) =
        discover_artifact_in_dir(base, kind, &directory, "main", default_title(kind))
    {
        artifacts.push(artifact);
    }
    let mut children = std::fs::read_dir(&directory)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    children.sort();
    for path in children {
        if path.is_dir() {
            let Some(id_part) = file_id_part(&path, false) else {
                continue;
            };
            if id_part == "main" {
                continue;
            }
            if let Some(artifact) =
                discover_artifact_in_dir(base, kind, &path, &id_part, title_from_id_part(&id_part))
            {
                artifacts.push(artifact);
            }
        } else if is_studio_artifact_path(&path) {
            let Some(id_part) = file_id_part(&path, true) else {
                continue;
            };
            if id_part == "main" {
                continue;
            }
            if let Some(artifact) = artifact_from_single_file(base, kind, &path, &id_part) {
                artifacts.push(artifact);
            }
        }
    }
    artifacts
}

fn discover_artifact_in_dir(
    base: &Path,
    kind: &str,
    directory: &Path,
    id_part: &str,
    title: String,
) -> Option<Value> {
    if !directory.is_dir() {
        return None;
    }
    let tex = preferred_file_for_id(&directory, id_part, "main.tex", "tex");
    let pdf = preferred_file_for_id(&directory, id_part, "main.pdf", "pdf");
    let pptx = preferred_file_for_id(&directory, id_part, "main.pptx", "pptx");
    let svg = preferred_file_for_id(&directory, id_part, "main.svg", "svg");
    let html = preferred_file(&directory, "index.html", "html")
        .or_else(|| first_with_extension(&directory, "htm"));
    if tex.is_none() && pdf.is_none() && pptx.is_none() && svg.is_none() && html.is_none() {
        return None;
    }
    let mut artifact = json!({
        "id": format!("{kind}:{id_part}"),
        "kind": kind,
        "title": title,
        "status": if pdf.is_some() || html.is_some() { "ready" } else { "draft" },
        "generatedAt": runtime::now_iso8601(),
    });
    for (field, path) in [
        ("texPath", tex),
        ("pdfPath", pdf),
        ("pptxPath", pptx),
        ("svgPath", svg),
        ("htmlPath", html),
    ] {
        if let Some(path) = path {
            artifact[field] = Value::String(relative_display(base, &path));
        }
    }
    Some(artifact)
}

fn discover_web_artifacts_at(base: &Path) -> Vec<Value> {
    let directory = layout::web_dir_at(base);
    if !directory.is_dir() {
        return Vec::new();
    }
    let mut artifacts = Vec::new();
    if directory.join("index.html").is_file() || directory.join("index.htm").is_file() {
        if let Some(artifact) =
            discover_artifact_in_dir(base, "web", &directory, "main", default_title("web"))
        {
            artifacts.push(artifact);
        }
    }
    let mut children = std::fs::read_dir(&directory)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    children.sort();
    for path in children {
        if path.is_dir() {
            let Some(id_part) = file_id_part(&path, false) else {
                continue;
            };
            if id_part == "main" {
                continue;
            }
            if let Some(artifact) =
                discover_artifact_in_dir(base, "web", &path, &id_part, title_from_id_part(&id_part))
            {
                artifacts.push(artifact);
            }
        } else if is_html_path(&path) {
            let Some(id_part) = file_id_part(&path, true) else {
                continue;
            };
            if id_part == "index" || id_part == "main" {
                continue;
            }
            artifacts.push(json!({
                "id": format!("web:{id_part}"),
                "kind": "web",
                "title": title_from_id_part(&id_part),
                "status": "ready",
                "generatedAt": runtime::now_iso8601(),
                "htmlPath": relative_display(base, &path),
            }));
        }
    }
    artifacts
}

fn artifact_from_single_file(base: &Path, kind: &str, path: &Path, id_part: &str) -> Option<Value> {
    let field = artifact_field(path)?;
    let ready = matches!(field, "pdfPath" | "pptxPath" | "svgPath" | "htmlPath");
    let mut artifact = json!({
        "id": format!("{kind}:{id_part}"),
        "kind": kind,
        "title": title_from_id_part(id_part),
        "status": if ready { "ready" } else { "draft" },
        "generatedAt": runtime::now_iso8601(),
    });
    artifact[field] = Value::String(relative_display(base, path));
    Some(artifact)
}

fn artifact_field(path: &Path) -> Option<&'static str> {
    let extension = path.extension().and_then(|value| value.to_str())?;
    if extension.eq_ignore_ascii_case("tex") {
        Some("texPath")
    } else if extension.eq_ignore_ascii_case("pdf") {
        Some("pdfPath")
    } else if extension.eq_ignore_ascii_case("pptx") {
        Some("pptxPath")
    } else if extension.eq_ignore_ascii_case("svg") {
        Some("svgPath")
    } else if extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm") {
        Some("htmlPath")
    } else {
        None
    }
}

fn is_studio_artifact_path(path: &Path) -> bool {
    artifact_field(path).is_some()
}

fn default_title(kind: &str) -> String {
    if kind == "poster" {
        "Poster"
    } else if kind == "web" {
        "Web"
    } else {
        "Slides"
    }
    .to_string()
}

fn title_from_id_part(id_part: &str) -> String {
    id_part
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn file_id_part(path: &Path, use_stem: bool) -> Option<String> {
    let raw = if use_stem {
        path.file_stem()
    } else {
        path.file_name()
    }?
    .to_string_lossy();
    let mut id = String::new();
    let mut last_was_dash = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
            id.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            id.push('-');
            last_was_dash = true;
        }
    }
    let id = id.trim_matches('-').to_string();
    (!id.is_empty()).then_some(id)
}

fn is_html_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("html") || value.eq_ignore_ascii_case("htm")
        })
}

fn preferred_file(directory: &Path, preferred_name: &str, extension: &str) -> Option<PathBuf> {
    let preferred = directory.join(preferred_name);
    if preferred.is_file() {
        Some(preferred)
    } else {
        first_with_extension(directory, extension)
    }
}

fn preferred_file_for_id(
    directory: &Path,
    id_part: &str,
    preferred_name: &str,
    extension: &str,
) -> Option<PathBuf> {
    if id_part == "main" {
        let preferred = directory.join(preferred_name);
        preferred.is_file().then_some(preferred)
    } else {
        preferred_file(directory, preferred_name, extension)
    }
}

fn first_with_extension(directory: &Path, extension: &str) -> Option<PathBuf> {
    std::fs::read_dir(directory)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case(extension))
        })
        .min()
}

fn relative_display(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
#[path = "tests/studio.rs"]
mod tests;
