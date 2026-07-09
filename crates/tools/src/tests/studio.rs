use super::{library_load_at, library_upsert_at};
use serde_json::{json, Value};
use std::path::PathBuf;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "somniq-studio-{label}-{}-{}",
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

#[test]
fn discovers_multiple_web_entries_without_registration() {
    let base = temp_dir("web-multi");
    std::fs::create_dir_all(base.join("web/dashboard")).expect("dashboard");
    std::fs::write(base.join("web/index.html"), "<h1>Main</h1>").expect("main");
    std::fs::write(base.join("web/demo.html"), "<h1>Demo</h1>").expect("demo");
    std::fs::write(base.join("web/dashboard/index.html"), "<h1>Dashboard</h1>")
        .expect("dashboard html");

    let discovered = library_load_at(&base).expect("library");
    let artifacts = discovered["artifacts"].as_array().expect("artifacts");
    assert!(artifacts.iter().any(|artifact| {
        artifact["id"] == "web:main" && artifact["htmlPath"] == "web/index.html"
    }));
    assert!(artifacts.iter().any(|artifact| {
        artifact["id"] == "web:demo" && artifact["htmlPath"] == "web/demo.html"
    }));
    assert!(artifacts.iter().any(|artifact| {
        artifact["id"] == "web:dashboard" && artifact["htmlPath"] == "web/dashboard/index.html"
    }));
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn discovers_multiple_slide_outputs_without_registration() {
    let base = temp_dir("slides-multi");
    std::fs::create_dir_all(base.join("slides/deck-two")).expect("deck dir");
    std::fs::write(base.join("slides/main.pdf"), b"%PDF-1.7").expect("main pdf");
    std::fs::write(base.join("slides/research-talk.pptx"), b"pptx").expect("pptx");
    std::fs::write(base.join("slides/deck-two/main.pdf"), b"%PDF-1.7").expect("deck pdf");

    let discovered = library_load_at(&base).expect("library");
    let artifacts = discovered["artifacts"].as_array().expect("artifacts");
    assert!(artifacts.iter().any(|artifact| {
        artifact["id"] == "slides:main" && artifact["pdfPath"] == "slides/main.pdf"
    }));
    assert!(artifacts.iter().any(|artifact| {
        artifact["id"] == "slides:research-talk"
            && artifact["pptxPath"] == "slides/research-talk.pptx"
    }));
    assert!(artifacts.iter().any(|artifact| {
        artifact["id"] == "slides:deck-two" && artifact["pdfPath"] == "slides/deck-two/main.pdf"
    }));
    let _ = std::fs::remove_dir_all(base);
}
