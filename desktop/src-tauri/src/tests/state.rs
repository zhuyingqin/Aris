use super::{desktop_runtime_dir, project_runtime_dir};

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
    let _lock = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
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

/// The retrieval protocol's four tools have to travel together.
///
/// Its refusals name the next tool by hand — "call RetrievalPlan", "call
/// RetrievalCorpusSeal" — so a caller given three of the four is told to do
/// something it cannot do. `RetrievalCorpusSeal` was the one missing here,
/// which left a sub-agent on a candidate turn with no reachable exit: fetching
/// is refused until the corpus is sealed, recording evidence is refused until
/// the corpus is sealed, and sealing was not on the menu.
#[test]
fn the_retrieval_protocol_tools_are_allowed_together() {
    for name in [
        "RetrievalPlan",
        "RetrievalCorpusSeal",
        "RetrievalEvidence",
        "RetrievalLedger",
    ] {
        assert!(
            super::DESKTOP_ALLOWED_AGENT_TOOLS.contains(&name),
            "{name} is named by a guard refusal but sub-agents may not call it"
        );
    }
}
