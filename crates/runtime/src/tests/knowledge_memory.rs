use super::*;

fn entry(name: &str) -> KnowledgeMemoryEntry {
    KnowledgeMemoryEntry {
        name: name.to_string(),
        description: String::new(),
        path: PathBuf::from(format!("/memories/{name}.md")),
    }
}

#[test]
fn catalog_caps_entries_and_notes_overflow() {
    let dir = PathBuf::from("/memories");
    // Names are pre-sorted (n000..), mirroring load_knowledge_memory_catalog.
    let entries: Vec<_> = (0..KNOWLEDGE_CATALOG_LIMIT + 5)
        .map(|i| entry(&format!("n{i:03}")))
        .collect();
    let rendered = render_knowledge_catalog(&entries, &dir);

    // First cap entries listed, anything past the cap dropped from the inline list.
    assert!(rendered.contains("n000"));
    assert!(rendered.contains(&format!("n{:03}", KNOWLEDGE_CATALOG_LIMIT - 1)));
    assert!(!rendered.contains(&format!("n{:03}", KNOWLEDGE_CATALOG_LIMIT)));
    // Overflow note accounts for the remainder and points at read_file.
    assert!(rendered.contains("and 5 more reference notes"));
    assert!(rendered.contains("read_file"));
}

#[test]
fn catalog_under_cap_has_no_overflow_note() {
    let dir = PathBuf::from("/memories");
    let entries: Vec<_> = (0..3).map(|i| entry(&format!("n{i}"))).collect();
    let rendered = render_knowledge_catalog(&entries, &dir);
    assert!(rendered.contains("n0"));
    assert!(!rendered.contains("more reference notes"));
}

#[test]
fn empty_catalog_renders_guidance_only() {
    let dir = PathBuf::from("/memories");
    let rendered = render_knowledge_catalog(&[], &dir);
    assert!(rendered.contains("ARIS Knowledge Memory"));
    assert!(!rendered.contains("more reference notes"));
}

fn write_temp(label: &str, content: &str) -> PathBuf {
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path =
        std::env::temp_dir().join(format!("aris-fm-{}-{nanos}-{label}.md", std::process::id()));
    let mut file = fs::File::create(&path).unwrap();
    file.write_all(content.as_bytes()).unwrap();
    path
}

#[test]
fn read_frontmatter_extracts_without_consuming_body() {
    // A large body must not change what (or how much) we parse from the head.
    let body = "filler line\n".repeat(5_000);
    let content = format!("---\nname: Real Name\ndescription: 真实的中文描述\n---\n{body}");
    let path = write_temp("big-body", &content);
    let (name, description) = read_frontmatter(&path).unwrap();
    let _ = fs::remove_file(&path);
    assert_eq!(name.as_deref(), Some("Real Name"));
    assert_eq!(description.as_deref(), Some("真实的中文描述"));
}

#[test]
fn read_frontmatter_respects_line_cap() {
    // The `name:` and closing fence sit past the scan cap. If the cap is
    // honored we stop before reaching them and report no frontmatter; if the
    // whole file were read instead, the decoy name would leak through.
    let pad = "pad: x\n".repeat(MAX_FRONTMATTER_LINES);
    let content = format!("---\n{pad}name: SHOULD_NOT_APPEAR\n---\nbody\n");
    let path = write_temp("late-fence", &content);
    let (name, description) = read_frontmatter(&path).unwrap();
    let _ = fs::remove_file(&path);
    assert_eq!(name, None);
    assert_eq!(description, None);
}

#[test]
fn read_frontmatter_none_without_leading_fence() {
    let path = write_temp("no-fm", "# Heading\nname: not-frontmatter\nbody\n");
    let (name, description) = read_frontmatter(&path).unwrap();
    let _ = fs::remove_file(&path);
    assert_eq!(name, None);
    assert_eq!(description, None);
}

#[test]
fn read_frontmatter_missing_file_is_err() {
    let path = std::env::temp_dir().join("aris-fm-definitely-missing-xyz.md");
    assert!(read_frontmatter(&path).is_err());
}
