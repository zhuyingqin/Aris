use super::{desktop_runtime_dir, project_runtime_dir};
use std::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[test]
fn project_runtime_dir_uses_stable_desktop_base() {
    let _lock = ENV_LOCK.lock().expect("env lock");
    let stale_current_project_runtime = desktop_runtime_dir()
        .join("projects")
        .join("project-aaaaaaaaaaaaaaaa");
    let _guard = EnvGuard::set("ARIS_RUNTIME_ROOT", &stale_current_project_runtime);

    assert_eq!(project_runtime_dir("default"), desktop_runtime_dir());
    assert_eq!(
        project_runtime_dir("project-bbbbbbbbbbbbbbbb"),
        desktop_runtime_dir()
            .join("projects")
            .join("project-bbbbbbbbbbbbbbbb")
    );
}
