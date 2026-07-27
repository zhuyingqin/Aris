use super::{canonical_notebook_path, papers_dir_at, root_display_rank, standard_artifact_dir_at};
use std::path::Path;

#[test]
fn notebook_names_default_to_internal_notebooks_dir() {
    assert_eq!(
        canonical_notebook_path("demo"),
        ".somniq/notebooks/demo.ipynb"
    );
    assert_eq!(
        canonical_notebook_path("demo.ipynb"),
        ".somniq/notebooks/demo.ipynb"
    );
    assert_eq!(
        canonical_notebook_path("experiments/old.ipynb"),
        "experiments/old.ipynb"
    );
}

#[test]
fn managed_artifacts_live_under_the_project_data_dir() {
    assert_eq!(
        papers_dir_at(Path::new("project")),
        Path::new("project/.somniq/papers")
    );
    assert_eq!(
        standard_artifact_dir_at(Path::new("project"), "report"),
        Some(Path::new("project/.somniq/reports").to_path_buf())
    );
}

#[test]
fn canonical_roots_sort_before_miscellaneous_dirs() {
    assert!(root_display_rank("slides") < root_display_rank("src"));
    assert!(root_display_rank("web") < root_display_rank("src"));
}
