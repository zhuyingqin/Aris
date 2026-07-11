use super::{initialize_repo, render_init_agents_md};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir() -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time should be after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("somniq-init-{nanos}"))
}

#[test]
fn initialize_repo_creates_agents_and_local_state_ignore() {
    let root = temp_dir();
    fs::create_dir_all(root.join("rust")).expect("create rust dir");
    fs::write(root.join("rust").join("Cargo.toml"), "[workspace]\n").expect("write cargo");

    let report = initialize_repo(&root).expect("init should succeed");
    let rendered = report.render();
    assert!(rendered.contains(".gitignore       created"));
    assert!(rendered.contains("AGENTS.md        created"));
    assert!(root.join("AGENTS.md").is_file());
    assert!(!root.join("CLAUDE.md").exists());
    assert!(!root.join(".claude.json").exists());
    let gitignore = fs::read_to_string(root.join(".gitignore")).expect("read gitignore");
    assert!(gitignore.contains(".somniq/"));
    assert!(!gitignore.contains(".claude"));
    let agents_md = fs::read_to_string(root.join("AGENTS.md")).expect("read agents md");
    assert!(agents_md.contains("## Project mission"));
    assert!(agents_md.contains("Languages: Rust."));
    assert!(agents_md.contains("cargo clippy --workspace --all-targets -- -D warnings"));

    fs::remove_dir_all(root).expect("cleanup temp dir");
}

#[test]
fn initialize_repo_is_idempotent_and_preserves_existing_agents() {
    let root = temp_dir();
    fs::create_dir_all(&root).expect("create root");
    fs::write(root.join("AGENTS.md"), "custom guidance\n").expect("write existing agents");
    fs::write(root.join(".gitignore"), ".somniq/\n").expect("write gitignore");

    let first = initialize_repo(&root).expect("first init should succeed");
    assert!(first
        .render()
        .contains("AGENTS.md        skipped (already exists)"));
    let second = initialize_repo(&root).expect("second init should succeed");
    let second_rendered = second.render();
    assert!(second_rendered.contains(".gitignore       skipped (already exists)"));
    assert!(second_rendered.contains("AGENTS.md        skipped (already exists)"));
    assert_eq!(
        fs::read_to_string(root.join("AGENTS.md")).expect("read existing agents"),
        "custom guidance\n"
    );
    let gitignore = fs::read_to_string(root.join(".gitignore")).expect("read gitignore");
    assert_eq!(gitignore.matches(".somniq/").count(), 1);

    fs::remove_dir_all(root).expect("cleanup temp dir");
}

#[test]
fn render_init_template_mentions_detected_python_and_nextjs_markers() {
    let root = temp_dir();
    fs::create_dir_all(&root).expect("create root");
    fs::write(root.join("pyproject.toml"), "[project]\nname = \"demo\"\n")
        .expect("write pyproject");
    fs::write(
        root.join("package.json"),
        r#"{"dependencies":{"next":"14.0.0","react":"18.0.0"},"devDependencies":{"typescript":"5.0.0"}}"#,
    )
    .expect("write package json");

    let rendered = render_init_agents_md(Path::new(&root));
    assert!(rendered.contains("# Project guidance"));
    assert!(rendered.contains("Languages: Python, TypeScript."));
    assert!(rendered.contains("Frameworks/tooling markers: Next.js, React."));
    assert!(rendered.contains("pyproject.toml"));
    assert!(rendered.contains("Next.js detected"));

    fs::remove_dir_all(root).expect("cleanup temp dir");
}
