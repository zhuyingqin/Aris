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

#[test]
fn project_bound_state_directories_ignore_the_active_project() {
    let _lock = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let temp = tempfile::tempdir().unwrap();
    let active = temp.path().join("active");
    let bound = temp.path().join("bound");
    let _runtime = EnvGuard::set("ARIS_RUNTIME_ROOT", &active);
    let _sessions = EnvGuard::set("ARIS_SESSIONS_DIR", active.join("sessions"));
    let _run_state = EnvGuard::set("ARIS_RUN_STATE_DIR", active.join("run-state"));
    let context = runtime::ProjectExecutionContext::new(&bound)
        .with_env("ARIS_RUNTIME_ROOT", bound.as_os_str())
        .with_env("ARIS_SESSIONS_DIR", bound.join("sessions").into_os_string())
        .with_env("ARIS_RUN_STATE_DIR", bound.join("run-state").into_os_string());

    runtime::with_project_execution_context(&context, || {
        assert_eq!(super::runtime_dir(), bound);
        assert_eq!(super::sessions_dir(), bound.join("sessions"));
        assert_eq!(super::state_root(), bound.join("run-state"));
    });
    assert_eq!(super::sessions_dir(), active.join("sessions"));
    assert_eq!(super::state_root(), active.join("run-state"));
}

/// A sub-agent's full report is written to this project's agent store
/// (`agents/agent-*.md`). The parent agent kept getting "outside the isolated
/// workspace" when it read that report (12 re-learning events across 4
/// projects), so the store is a read-only root of the project's own turns.
/// Another project's store and the session logs stay out of reach, and the
/// store is still not writable.
#[test]
fn project_turns_read_their_own_sub_agent_reports_only() {
    let _lock = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let temp = tempfile::tempdir().unwrap();
    let _config = EnvGuard::set("ARIS_CONFIG_ROOT", temp.path().join("config"));
    let workspace = temp.path().join("workspace");
    let own = "project-cccccccccccccccc";
    let other = "project-dddddddddddddddd";
    let context = super::project_execution_context(&workspace, own).unwrap();
    let own_report = project_runtime_dir(own).join("agents").join("agent-1.md");
    let other_report = project_runtime_dir(other).join("agents").join("agent-2.md");
    let session_log = project_runtime_dir(own)
        .join("sessions")
        .join("chat-1.events.jsonl");
    for (path, text) in [
        (&own_report, "own sub-agent report"),
        (&other_report, "other project's report"),
        (&session_log, "{}"),
    ] {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    runtime::with_project_execution_context(&context, || {
        let read = runtime::read_file(&own_report.to_string_lossy(), None, None)
            .expect("this project's sub-agent report is readable");
        assert!(read.file.content.contains("own sub-agent report"));
        for denied in [&other_report, &session_log] {
            let error = runtime::read_file(&denied.to_string_lossy(), None, None)
                .expect_err("only this project's agent store was opened");
            assert!(
                error.to_string().contains("outside the isolated workspace"),
                "{error}"
            );
        }
        let error = runtime::write_file(&own_report.to_string_lossy(), "overwritten")
            .expect_err("the agent store is read-only");
        assert!(
            error.to_string().contains("outside the isolated workspace"),
            "{error}"
        );
    });
    assert_eq!(
        std::fs::read_to_string(&own_report).unwrap(),
        "own sub-agent report"
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
