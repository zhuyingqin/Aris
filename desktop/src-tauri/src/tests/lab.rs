use super::{is_within_project, list_notebooks_at};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_base(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let base =
        std::env::temp_dir().join(format!("somniq-lab-{name}-{}-{nonce}", std::process::id()));
    std::fs::create_dir_all(&base).expect("create temp lab dir");
    base
}

#[test]
fn list_notebooks_finds_canonical_nested_ipynb_files_case_insensitively() {
    let base = temp_base("notebooks");
    let nested = base.join("notebooks/a/b/c/d/e/f/g");
    std::fs::create_dir_all(&nested).expect("create nested notebook dir");
    std::fs::write(nested.join("deep.IPYNB"), "{}").expect("write notebook");

    let runs = base.join("experiments/runs/run-1");
    std::fs::create_dir_all(&runs).expect("create runs dir");
    std::fs::write(runs.join("ignored.ipynb"), "{}").expect("write ignored notebook");

    let found = list_notebooks_at(&base);

    assert_eq!(found, vec!["notebooks/a/b/c/d/e/f/g/deep.IPYNB"]);
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn sandbox_allows_in_project_and_blocks_escapes() {
    let base = PathBuf::from("workspace/proj");
    // In-project paths (relative or absolute-under-base) are allowed.
    assert!(is_within_project(&base, &base.join("notebooks/a.ipynb")));
    assert!(is_within_project(&base, &base.join("a.ipynb")));
    assert!(is_within_project(&base, &base));
    // `..` traversal that climbs out, and sibling/elsewhere paths, are blocked.
    assert!(!is_within_project(
        &base,
        &base.join("papers/../../etc/passwd")
    ));
    assert!(!is_within_project(
        &base,
        &base.join("../proj-evil/secret.ipynb")
    ));
    assert!(!is_within_project(
        &base,
        &PathBuf::from("somewhere/else.ipynb")
    ));
}
