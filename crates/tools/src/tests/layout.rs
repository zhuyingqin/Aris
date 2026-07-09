use super::{canonical_notebook_path, root_display_rank};

#[test]
fn notebook_names_default_to_notebooks_dir() {
    assert_eq!(canonical_notebook_path("demo"), "notebooks/demo.ipynb");
    assert_eq!(
        canonical_notebook_path("demo.ipynb"),
        "notebooks/demo.ipynb"
    );
    assert_eq!(
        canonical_notebook_path("experiments/old.ipynb"),
        "experiments/old.ipynb"
    );
}

#[test]
fn canonical_roots_sort_before_miscellaneous_dirs() {
    assert!(root_display_rank("slides") < root_display_rank("src"));
    assert!(root_display_rank("web") < root_display_rank("src"));
}
