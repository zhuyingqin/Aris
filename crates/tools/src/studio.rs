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

const STUDIO_DIR: &str = "studio";
const LIBRARY_FILE: &str = "library.json";
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
    base.join(STUDIO_DIR).join(LIBRARY_FILE)
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
            read_library_json(&backup)?
        } else {
            empty_library()
        }
    } else {
        match read_library_json(&path) {
            Ok(library) => library,
            Err(primary_error) if backup.exists() => {
                read_library_json(&backup).map_err(|backup_error| {
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
        library_path: format!("{STUDIO_DIR}/{LIBRARY_FILE}"),
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

fn read_library_json(path: &Path) -> Result<Value, String> {
    let raw = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))
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
        .or_insert_with(|| Value::String(now_iso()));
    Value::Object(artifact)
}

fn discover_artifacts_at(base: &Path) -> Vec<Value> {
    ["slides", "poster", "web"]
        .into_iter()
        .filter_map(|kind| discover_artifact_at(base, kind))
        .collect()
}

fn discover_artifact_at(base: &Path, kind: &str) -> Option<Value> {
    let directory = base.join(kind);
    if !directory.is_dir() {
        return None;
    }
    let tex = preferred_file(&directory, "main.tex", "tex");
    let pdf = preferred_file(&directory, "main.pdf", "pdf");
    let pptx = first_with_extension(&directory, "pptx");
    let svg = first_with_extension(&directory, "svg");
    let html = preferred_file(&directory, "index.html", "html")
        .or_else(|| first_with_extension(&directory, "htm"));
    if tex.is_none() && pdf.is_none() && pptx.is_none() && svg.is_none() && html.is_none() {
        return None;
    }
    let mut artifact = json!({
        "id": format!("{kind}:main"),
        "kind": kind,
        "title": if kind == "poster" { "Poster" } else if kind == "web" { "Web" } else { "Slides" },
        "status": if pdf.is_some() || html.is_some() { "ready" } else { "draft" },
        "generatedAt": now_iso(),
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

fn preferred_file(directory: &Path, preferred_name: &str, extension: &str) -> Option<PathBuf> {
    let preferred = directory.join(preferred_name);
    if preferred.is_file() {
        Some(preferred)
    } else {
        first_with_extension(directory, extension)
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

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let of_day = secs % 86_400;
    format!(
        "{}T{:02}:{:02}:{:02}.000Z",
        runtime::today_iso(),
        of_day / 3600,
        (of_day % 3600) / 60,
        of_day % 60
    )
}

fn relative_display(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::{library_load_at, library_upsert_at};
    use serde_json::{json, Value};
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "aris-studio-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).expect("create temp");
        path
    }

    #[test]
    fn discovers_rendered_results_without_latex_sources() {
        let base = temp_dir("discover");
        std::fs::create_dir_all(base.join("slides")).expect("slides");
        std::fs::write(base.join("slides/main.pdf"), b"%PDF-1.7").expect("pdf");
        let discovered = library_load_at(&base).expect("library");
        assert_eq!(discovered["artifacts"][0]["kind"], "slides");
        assert_eq!(discovered["artifacts"][0]["pdfPath"], "slides/main.pdf");
        assert!(discovered["artifacts"][0]["texPath"].is_null());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn upsert_preserves_user_review_state() {
        let base = temp_dir("library");
        std::fs::create_dir_all(base.join("slides")).expect("slides");
        std::fs::write(base.join("slides/main.pdf"), b"%PDF-1.7").expect("pdf");
        let mut edited = library_load_at(&base).expect("library");
        edited["artifacts"][0]["title"] = Value::String("My talk".to_string());
        edited["artifacts"][0]["pinned"] = Value::Bool(true);
        edited["artifacts"][0]["notes"] = Value::String("Keep this".to_string());
        edited["artifacts"][0]["pageReviews"] = json!([{
            "id": "review-1",
            "page": 2,
            "body": "Clarify the claim",
            "status": "open",
            "createdAt": "2026-06-15T00:00:00.000Z",
            "updatedAt": "2026-06-15T00:00:00.000Z"
        }]);
        super::library_save_at(&base, &edited).expect("save");
        let stats = library_upsert_at(
            &base,
            &[json!({
                "id": "slides:main",
                "kind": "slides",
                "title": "Generated title",
                "pdfPath": "slides/revised.pdf",
                "status": "ready",
                "pinned": false,
                "notes": "overwrite",
                "pageReviews": []
            })],
        )
        .expect("upsert");
        assert_eq!(stats.merged, 1);
        let loaded = library_load_at(&base).expect("load");
        assert_eq!(loaded["artifacts"][0]["title"], "My talk");
        assert_eq!(loaded["artifacts"][0]["pinned"], true);
        assert_eq!(loaded["artifacts"][0]["notes"], "Keep this");
        assert_eq!(
            loaded["artifacts"][0]["pageReviews"][0]["body"],
            "Clarify the claim"
        );
        assert_eq!(loaded["artifacts"][0]["pdfPath"], "slides/revised.pdf");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn indexes_interactive_html_and_returns_direct_studio_link() {
        let base = temp_dir("web");
        std::fs::create_dir_all(base.join("web")).expect("web");
        std::fs::write(base.join("web/index.html"), "<h1>Interactive</h1>").expect("html");

        let discovered = library_load_at(&base).expect("library");
        assert_eq!(discovered["artifacts"][0]["kind"], "web");
        assert_eq!(discovered["artifacts"][0]["htmlPath"], "web/index.html");

        let stats = library_upsert_at(
            &base,
            &[json!({
                "id": "web:interactive-demo",
                "kind": "web",
                "title": "Interactive demo",
                "htmlPath": "web/index.html",
                "status": "ready"
            })],
        )
        .expect("upsert");
        assert_eq!(stats.studio_links.len(), 1);
        assert_eq!(
            stats.studio_links[0].href,
            "studio/artifact/web%3Ainteractive-demo"
        );
        let _ = std::fs::remove_dir_all(base);
    }
}
