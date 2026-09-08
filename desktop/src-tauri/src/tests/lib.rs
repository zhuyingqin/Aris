use super::{normalized_bundled_resource_dir, resolve_python_environment, should_offer_update};
use semver::Version;

fn temp_resource_dir(name: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("somniq-resource-env-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("bin")).expect("create temp resource bin");
    dir
}

#[test]
fn normalizes_tauri_nested_resource_layout() {
    let parent =
        std::env::temp_dir().join(format!("somniq-nested-resources-{}", std::process::id()));
    let nested = parent.join("resources");
    let _ = std::fs::remove_dir_all(&parent);
    std::fs::create_dir_all(nested.join("bin")).expect("create nested resource bin");

    assert_eq!(normalized_bundled_resource_dir(&parent), nested);
    let _ = std::fs::remove_dir_all(parent);
}

#[test]
fn preserves_direct_resource_layout() {
    let direct = temp_resource_dir("direct-layout");

    assert_eq!(normalized_bundled_resource_dir(&direct), direct);
    let _ = std::fs::remove_dir_all(direct);
}

#[test]
fn updater_prefers_a_newer_version_regardless_of_release_time() {
    assert!(should_offer_update(
        &Version::parse("0.4.33").unwrap(),
        &Version::parse("0.4.34").unwrap(),
        Some(200),
        Some(100),
    ));
}

#[test]
fn updater_accepts_a_newer_upload_of_the_same_version() {
    assert!(should_offer_update(
        &Version::parse("0.4.33").unwrap(),
        &Version::parse("0.4.33").unwrap(),
        Some(100),
        Some(101),
    ));
}

#[test]
fn updater_rejects_older_versions_and_non_newer_same_version_uploads() {
    let current = Version::parse("0.4.33").unwrap();

    assert!(!should_offer_update(
        &current,
        &Version::parse("0.4.32").unwrap(),
        Some(100),
        Some(200),
    ));
    assert!(!should_offer_update(
        &current,
        &current,
        Some(100),
        Some(100),
    ));
    assert!(!should_offer_update(&current, &current, Some(100), None));
    assert!(!should_offer_update(&current, &current, None, Some(200)));
}

#[test]
fn resolves_explicit_python_environment_without_copying_it() {
    let dir = temp_resource_dir("python-environment");
    let environment = dir.join("research-env");
    let python = if cfg!(windows) {
        environment.join("python.exe")
    } else {
        environment.join("bin").join("python")
    };
    std::fs::create_dir_all(python.parent().expect("python parent"))
        .expect("create interpreter directory");
    std::fs::write(&python, b"python").expect("write interpreter marker");
    if cfg!(windows) {
        std::fs::create_dir_all(environment.join("Scripts")).expect("create Scripts");
        std::fs::create_dir_all(environment.join("Library").join("bin"))
            .expect("create Library bin");
    }

    let resolved = resolve_python_environment(&environment.display().to_string())
        .expect("resolve environment")
        .expect("configured environment");

    assert_eq!(resolved.python, python);
    assert!(resolved
        .path_entries
        .iter()
        .any(|entry| entry == &environment || entry == &environment.join("bin")));
    if cfg!(windows) {
        assert!(resolved
            .path_entries
            .iter()
            .any(|entry| entry == &environment.join("Scripts")));
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn rejects_python_environment_without_an_interpreter() {
    let dir = temp_resource_dir("missing-python");
    let error = resolve_python_environment(&dir.display().to_string())
        .expect_err("missing interpreter should be rejected");

    assert!(error.contains("No Python interpreter"));
    let _ = std::fs::remove_dir_all(dir);
}
