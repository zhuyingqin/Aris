use std::ffi::OsString;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{
    collect_typeset_library, file_read, import_chat_attachment_at, import_chat_attachment_bytes_at,
    normalize_open_reference, reanchor_to_workspace, resolve_existing_path_within,
    strip_location_suffix, TypesetScan,
};

#[test]
fn chat_attachment_import_copies_external_files_to_a_durable_workspace_path() {
    let workspace = temp_path("chat-attachment-workspace");
    let source_dir = temp_path("chat-attachment-source");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    std::fs::create_dir_all(&source_dir).expect("create source directory");
    let source = source_dir.join("notes.md");
    std::fs::write(&source, "durable chat context").expect("write source");

    let imported = import_chat_attachment_at(&workspace, &source).expect("import attachment");
    assert!(imported.path.starts_with(".somniq/uploads/"));
    assert_eq!(imported.name, "notes.md");
    assert_eq!(
        std::fs::read_to_string(workspace.join(&imported.path)).expect("read staged attachment"),
        "durable chat context"
    );

    let _ = std::fs::remove_dir_all(workspace);
    let _ = std::fs::remove_dir_all(source_dir);
}

#[test]
fn pathless_chat_attachment_bytes_are_persisted_to_a_durable_workspace_path() {
    let workspace = temp_path("pathless-chat-attachment-workspace");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let pdf = b"%PDF-1.4\npathless attachment";

    let imported = import_chat_attachment_bytes_at(&workspace, "third paper.pdf", pdf)
        .expect("import pathless attachment");

    assert!(imported.path.starts_with(".somniq/uploads/"));
    assert!(imported.path.ends_with(".pdf"));
    assert_eq!(imported.name, "third paper.pdf");
    assert_eq!(imported.bytes, pdf.len() as u64);
    assert_eq!(
        std::fs::read(workspace.join(&imported.path)).expect("read staged attachment"),
        pdf
    );

    let _ = std::fs::remove_dir_all(workspace);
}

struct EnvGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvGuard {
    fn unset(key: &'static str) -> Self {
        let previous = std::env::var_os(key);
        std::env::remove_var(key);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.as_ref() {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

fn temp_path(name: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    std::env::temp_dir().join(format!("somniq-desktop-{name}-{unique}"))
}

#[test]
fn file_read_defaults_to_first_200_lines() {
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("long-lines.txt");
    let content = (1..=250)
        .map(|line| format!("line-{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&path, content).expect("write file");

    let output = file_read(path.display().to_string(), None).expect("file_read should work");

    assert!(output.contains("line-1"));
    assert!(output.contains("line-200"));
    assert!(!output.contains("line-201"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn file_read_truncates_very_long_single_line() {
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("long-single-line.json");
    std::fs::write(&path, "x".repeat(210_000)).expect("write file");

    let output = file_read(path.display().to_string(), Some(1)).expect("file_read should work");

    assert!(output.len() < 210_000);
    assert!(output.contains("[read_file truncated:"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn local_file_links_may_include_line_and_column_locations() {
    assert_eq!(strip_location_suffix("src/main.rs:42"), "src/main.rs");
    assert_eq!(strip_location_suffix("src/main.rs:42:7"), "src/main.rs");
    assert_eq!(
        strip_location_suffix(r"C:\Project\src\main.rs:42"),
        r"C:\Project\src\main.rs"
    );
}

#[test]
fn generated_file_link_formats_normalize_before_opening() {
    assert_eq!(
        normalize_open_reference("file:///C:/Research/My%20Paper/main.tex#L42C7")
            .expect("file URI"),
        "C:/Research/My Paper/main.tex"
    );
    assert_eq!(
        normalize_open_reference("vscode://file/C:/Research/main.tex:42:7").expect("VS Code URI"),
        "C:/Research/main.tex:42:7"
    );
    assert_eq!(
        normalize_open_reference("../papers/main.tex?line=42&column=7").expect("relative path"),
        "../papers/main.tex"
    );
    assert_eq!(
        normalize_open_reference("<C%3A/研究%20项目/main.tex>").expect("encoded path"),
        "C:/研究 项目/main.tex"
    );
}

#[test]
fn reveal_allows_workspace_root_while_mutations_reject_it() {
    let root_dir = temp_path("workspace-root");
    std::fs::create_dir_all(&root_dir).expect("create workspace root");
    let child = root_dir.join("paper.tex");
    std::fs::write(&child, "content").expect("write child");
    let root = root_dir.canonicalize().expect("canonicalize root");

    // Read-only reveal (the "Open Workspace" button) may target the root itself.
    let (_, revealed) =
        resolve_existing_path_within(&root, ".", true).expect("reveal root allowed");
    assert_eq!(revealed, root);

    // Mutating actions still refuse to touch the workspace root.
    let error = resolve_existing_path_within(&root, ".", false)
        .expect_err("mutation on root should be rejected");
    assert!(
        error.contains("workspace root"),
        "unexpected error: {error}"
    );

    // A real child entry resolves regardless of the allow_root flag.
    let (_, child_target) =
        resolve_existing_path_within(&root, "paper.tex", false).expect("child resolves");
    assert_eq!(
        child_target,
        child.canonicalize().expect("canonicalize child")
    );

    let _ = std::fs::remove_dir_all(&root_dir);
}

#[test]
fn stale_absolute_links_reanchor_onto_the_current_workspace() {
    let workspace = Path::new("C:/Users/wt/.config/SomniQ/desktop-workspace");

    // Wrong drive and prefix, but the workspace-relative tail is still valid —
    // exactly the "file does not exist: F:/Config/SomniQ/..." symptom.
    assert_eq!(
        reanchor_to_workspace(
            "F:/Config/SomniQ/desktop-workspace/papers/cartpole-swingup/main.tex",
            workspace,
        ),
        Some(workspace.join("papers/cartpole-swingup/main.tex")),
    );

    // Backslash-separated stale prefix.
    assert_eq!(
        reanchor_to_workspace(
            r"F:\Config\SomniQ\desktop-workspace\papers\door-deadlock-hitl\main.tex",
            workspace,
        ),
        Some(workspace.join("papers/door-deadlock-hitl/main.tex")),
    );

    // Legacy `aris` config dir that was migrated to `SomniQ`.
    assert_eq!(
        reanchor_to_workspace(
            "C:/Users/wt/.config/aris/desktop-workspace/library.json",
            workspace,
        ),
        Some(workspace.join("library.json")),
    );

    // No workspace anchor in the path — nothing to re-anchor.
    assert_eq!(
        reanchor_to_workspace("F:/some/other/place/main.tex", workspace),
        None,
    );
}

#[test]
fn typeset_document_discovery_includes_explicitly_scanned_internal_artifacts() {
    let root_dir = temp_path("typeset-managed-artifacts");
    let managed_dir = root_dir.join(".somniq/papers");
    std::fs::create_dir_all(&managed_dir).expect("create managed papers directory");
    std::fs::write(
        managed_dir.join("main.tex"),
        "\\documentclass{article}\n\\begin{document}\nManaged document\n\\end{document}",
    )
    .expect("write managed tex source");

    let mut scan = TypesetScan::default();
    collect_typeset_library(&managed_dir, &root_dir, &mut scan).expect("collect managed documents");

    assert_eq!(scan.documents.len(), 1);
    assert_eq!(scan.documents[0].path, ".somniq/papers/main.tex");
    // Loose sources of a library root belong to a project standing for that root.
    assert_eq!(scan.documents[0].project_path, ".somniq/papers");
    assert_eq!(scan.projects.len(), 1);
    assert_eq!(scan.projects[0].path, ".somniq/papers");
    assert_eq!(scan.projects[0].tex_file_count, 1);
    let _ = std::fs::remove_dir_all(root_dir);
}

#[test]
fn typeset_projects_stop_at_the_first_folder_level() {
    let root_dir = temp_path("typeset-first-level-projects");
    let chapter_dir = root_dir.join("Final/Ch2");
    std::fs::create_dir_all(&chapter_dir).expect("create nested chapter directory");
    std::fs::write(
        root_dir.join("Final/main.tex"),
        "\\documentclass{article}\n\\begin{document}\n\\input{Ch2/ch2}\n\\end{document}",
    )
    .expect("write project root tex source");
    std::fs::write(
        chapter_dir.join("ch2.tex"),
        "\\documentclass{report}\n\\begin{document}\nChapter two\n\\end{document}",
    )
    .expect("write nested root tex source");
    // An include-only chapter raises the `.tex` count without becoming a document.
    std::fs::write(
        chapter_dir.join("section.tex"),
        "Section body without a class",
    )
    .expect("write include-only tex source");
    std::fs::write(
        root_dir.join("standalone.tex"),
        "\\documentclass{article}\n",
    )
    .expect("write workspace root tex source");
    // A first-level folder without any `.tex` file is not a LaTeX project.
    std::fs::create_dir_all(root_dir.join("data")).expect("create non-latex directory");
    std::fs::write(root_dir.join("data/notes.md"), "no tex here").expect("write markdown file");

    let mut scan = TypesetScan::default();
    collect_typeset_library(&root_dir, &root_dir, &mut scan).expect("collect workspace library");

    let mut projects: Vec<_> = scan
        .projects
        .iter()
        .map(|project| (project.path.as_str(), project.tex_file_count))
        .collect();
    projects.sort();
    // `Final/Ch2` stays inside `Final`, and the loose root source gets its own entry.
    assert_eq!(projects, vec![("", 1), ("Final", 3)]);

    let mut documents: Vec<_> = scan
        .documents
        .iter()
        .map(|document| (document.path.as_str(), document.project_path.as_str()))
        .collect();
    documents.sort();
    assert_eq!(
        documents,
        vec![
            ("Final/Ch2/ch2.tex", "Final"),
            ("Final/main.tex", "Final"),
            ("standalone.tex", ""),
        ],
    );
    let _ = std::fs::remove_dir_all(root_dir);
}
