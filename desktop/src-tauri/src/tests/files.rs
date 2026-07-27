use std::ffi::OsString;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{
    file_read, normalize_open_reference, reanchor_to_workspace, resolve_existing_path_within,
    strip_location_suffix,
};

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
