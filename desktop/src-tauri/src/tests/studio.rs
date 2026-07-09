use super::studio_html_at;

#[test]
fn reads_project_local_html_and_rejects_non_html() {
    let base = std::env::temp_dir().join(format!(
        "somniq-studio-html-{}-{}",
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

#[test]
fn inlines_project_relative_stylesheets_for_preview() {
    let base = std::env::temp_dir().join(format!(
        "somniq-studio-css-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(base.join("web/styles")).expect("styles");
    std::fs::write(
        base.join("web/index.html"),
        r#"<html><head><link rel="stylesheet" href="styles/app.css"></head><body>Ready</body></html>"#,
    )
    .expect("html");
    std::fs::write(base.join("web/styles/app.css"), "body { color: red; }").expect("css");

    let html = studio_html_at(&base, "web/index.html").expect("preview");
    assert!(html.contains(r#"<style data-somniq-inline="styles/app.css">"#));
    assert!(html.contains("body { color: red; }"));
    assert!(!html.contains(r#"<link rel="stylesheet" href="styles/app.css">"#));
    let _ = std::fs::remove_dir_all(base);
}
