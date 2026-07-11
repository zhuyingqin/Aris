use super::{configure_bundled_tectonic_environment, tectonic_binary_name};
use std::sync::{Mutex, OnceLock};

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
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
