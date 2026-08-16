use super::{
    configure_bundled_tectonic_environment, resolve_python_environment, should_offer_update,
    tectonic_binary_name,
};
use semver::Version;

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn temp_resource_dir(name: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("somniq-tectonic-env-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("bin")).expect("create temp resource bin");
    dir
}

fn restore_env(
    previous_somniq: Option<std::ffi::OsString>,
    previous_aris: Option<std::ffi::OsString>,
) {
    match previous_somniq {
        Some(value) => std::env::set_var("SOMNIQ_TECTONIC", value),
        None => std::env::remove_var("SOMNIQ_TECTONIC"),
    }
    match previous_aris {
        Some(value) => std::env::set_var("ARIS_TECTONIC", value),
        None => std::env::remove_var("ARIS_TECTONIC"),
    }
}

#[test]
fn bundled_tectonic_sets_env_when_present() {
    let _guard = env_lock();
    let previous_somniq = std::env::var_os("SOMNIQ_TECTONIC");
    let previous_aris = std::env::var_os("ARIS_TECTONIC");
    std::env::remove_var("SOMNIQ_TECTONIC");
    std::env::remove_var("ARIS_TECTONIC");
    let dir = temp_resource_dir("sets");
    let bundled = dir.join("bin").join(tectonic_binary_name());
    std::fs::write(&bundled, b"tectonic").expect("write bundled tectonic marker");

    configure_bundled_tectonic_environment(&dir);

    assert_eq!(
        std::env::var_os("SOMNIQ_TECTONIC").as_deref(),
        Some(bundled.as_os_str())
    );
    assert_eq!(
        std::env::var_os("ARIS_TECTONIC").as_deref(),
        Some(bundled.as_os_str())
    );
    let _ = std::fs::remove_dir_all(dir);
    restore_env(previous_somniq, previous_aris);
}

#[test]
fn bundled_tectonic_preserves_valid_override() {
    let _guard = env_lock();
    let previous_somniq = std::env::var_os("SOMNIQ_TECTONIC");
    let previous_aris = std::env::var_os("ARIS_TECTONIC");
    let dir = temp_resource_dir("preserves");
    let bundled = dir.join("bin").join(tectonic_binary_name());
    std::fs::write(&bundled, b"tectonic").expect("write bundled tectonic marker");
    let override_path = dir.join("custom-tectonic.exe");
    std::fs::write(&override_path, b"custom").expect("write override marker");
    std::env::set_var("SOMNIQ_TECTONIC", &override_path);
    std::env::remove_var("ARIS_TECTONIC");

    configure_bundled_tectonic_environment(&dir);

    assert_eq!(
        std::env::var_os("SOMNIQ_TECTONIC").as_deref(),
        Some(override_path.as_os_str())
    );
    assert!(std::env::var_os("ARIS_TECTONIC").is_none());
    let _ = std::fs::remove_dir_all(dir);
    restore_env(previous_somniq, previous_aris);
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
