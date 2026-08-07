//! Host port for the review-workflow controller.
//!
//! Controller code used to reach for `AppHandle` and `State<ProjectState>`
//! directly.  That made every path through it — lease handling, reviewer
//! dispatch, transcript bookkeeping, failure persistence — reachable only by
//! launching the desktop app and clicking through the Workflows tab, because a
//! `#[tauri::command]` body cannot be called without a live `tauri::App`.
//!
//! The controller now depends on this trait instead.  [`TauriCtx`] is the
//! production wiring; [`TestCtx`] runs the same controller under `cargo test`
//! with scripted model output and recorded side effects.  The trait is
//! deliberately narrow: it holds only the capabilities the controller cannot
//! obtain from `runtime::` on its own.

use std::path::PathBuf;

use serde_json::Value;

use crate::engine::{WorkflowSessionBinding, WorkflowTurnRequest};

#[async_trait::async_trait]
pub(crate) trait AppCtx: Send + Sync {
    /// Filesystem root of the active project.  Every ledger read and write is
    /// resolved against it.
    fn project_path(&self) -> Result<PathBuf, String>;

    /// Stable id of the active project, used to scope chat session storage.
    fn project_id(&self) -> Result<String, String>;

    /// Notify the frontend.  Delivery is best-effort by design: a dropped
    /// notification must never fail an already-committed ledger transition, so
    /// this returns nothing to report.
    fn emit(&self, event: &str, payload: Value);

    /// Append the committed ledger state to the workflow's Executor session so
    /// the next Executor turn sees the accepted value rather than its own raw
    /// output.
    fn append_ledger_transcript(
        &self,
        binding: &WorkflowSessionBinding,
        action_id: &str,
        stage_id: &str,
        text: &str,
    ) -> Result<(), String>;

    /// Append an independent reviewer verdict to the Executor session without
    /// ever giving the reviewer access to that session.
    fn append_reviewer_transcript(
        &self,
        binding: &WorkflowSessionBinding,
        action_id: &str,
        stage_id: &str,
        text: &str,
    ) -> Result<(), String>;

    /// Run one Executor turn inside the run's persistent workflow session.
    async fn run_workflow_turn(&self, request: WorkflowTurnRequest) -> Result<String, String>;

    /// Run one stateless independent reviewer call over a ledger-derived
    /// payload.  The reviewer never enters the Executor session.
    async fn run_reviewer_oneshot(
        &self,
        system: String,
        prompt: String,
        action_id: String,
    ) -> Result<String, String>;
}

/// Production implementation, backed by the live Tauri application.
///
/// It carries only the `AppHandle`: `ProjectState` and `ChatState` are managed
/// state and are resolved on demand, so command signatures no longer have to
/// thread them through by hand.
pub(crate) struct TauriCtx {
    app: tauri::AppHandle,
}

impl TauriCtx {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait::async_trait]
impl AppCtx for TauriCtx {
    fn project_path(&self) -> Result<PathBuf, String> {
        use tauri::Manager;
        crate::projects::current_project_path(&self.app.state::<crate::projects::ProjectState>())
    }

    fn project_id(&self) -> Result<String, String> {
        use tauri::Manager;
        crate::projects::active_project_id(&self.app.state::<crate::projects::ProjectState>())
    }

    fn emit(&self, event: &str, payload: Value) {
        use tauri::Emitter;
        let _ = self.app.emit(event, payload);
    }

    fn append_ledger_transcript(
        &self,
        binding: &WorkflowSessionBinding,
        action_id: &str,
        stage_id: &str,
        text: &str,
    ) -> Result<(), String> {
        use tauri::Manager;
        let chat_state = self.app.state::<crate::engine::ChatState>();
        crate::engine::append_workflow_ledger_transcript(
            chat_state.inner(),
            binding,
            action_id,
            stage_id,
            text,
        )
    }

    fn append_reviewer_transcript(
        &self,
        binding: &WorkflowSessionBinding,
        action_id: &str,
        stage_id: &str,
        text: &str,
    ) -> Result<(), String> {
        use tauri::Manager;
        let chat_state = self.app.state::<crate::engine::ChatState>();
        crate::engine::append_workflow_reviewer_transcript(
            chat_state.inner(),
            binding,
            action_id,
            stage_id,
            text,
        )
    }

    async fn run_workflow_turn(&self, request: WorkflowTurnRequest) -> Result<String, String> {
        crate::engine::run_workflow_turn(self.app.clone(), request).await
    }

    async fn run_reviewer_oneshot(
        &self,
        system: String,
        prompt: String,
        action_id: String,
    ) -> Result<String, String> {
        // The reviewer backend is blocking; keeping it off the async runtime's
        // worker threads preserves controller responsiveness during long calls.
        tauri::async_runtime::spawn_blocking(move || {
            crate::literature::run_review_oneshot_cancellable(&system, &prompt, Some(&action_id))
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

#[cfg(test)]
pub(crate) use test_support::TestCtx;

#[cfg(test)]
mod test_support {
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use serde_json::Value;
    use tempfile::TempDir;

    use super::AppCtx;
    use crate::engine::{WorkflowSessionBinding, WorkflowTurnRequest};

    /// One transcript append observed by [`TestCtx`].
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct RecordedTranscript {
        /// `"ledger"` or `"reviewer"`.
        pub kind: &'static str,
        pub session_id: String,
        pub action_id: String,
        pub stage_id: String,
        pub text: String,
    }

    /// In-process host for the controller.
    ///
    /// Model calls are answered from scripted queues rather than the network,
    /// and every side effect the controller performs through the port is
    /// recorded so a test can assert on it.  Running out of scripted responses
    /// is an error rather than a hang, so an unexpected extra model call fails
    /// the test loudly.
    pub(crate) struct TestCtx {
        workspace: TempDir,
        project_id: String,
        turns: Mutex<VecDeque<Result<String, String>>>,
        reviews: Mutex<VecDeque<Result<String, String>>>,
        events: Mutex<Vec<(String, Value)>>,
        transcripts: Mutex<Vec<RecordedTranscript>>,
        turn_requests: Mutex<Vec<WorkflowTurnRequest>>,
        reviewer_prompts: Mutex<Vec<String>>,
    }

    impl TestCtx {
        pub(crate) fn new() -> Self {
            Self {
                workspace: tempfile::tempdir().expect("temporary workspace"),
                project_id: "test-project".to_string(),
                turns: Mutex::new(VecDeque::new()),
                reviews: Mutex::new(VecDeque::new()),
                events: Mutex::new(Vec::new()),
                transcripts: Mutex::new(Vec::new()),
                turn_requests: Mutex::new(Vec::new()),
                reviewer_prompts: Mutex::new(Vec::new()),
            }
        }

        /// Queue the next Executor turn result.
        pub(crate) fn push_turn(&self, result: Result<&str, &str>) -> &Self {
            self.turns
                .lock()
                .expect("turn queue")
                .push_back(map_scripted(result));
            self
        }

        /// Queue the next independent reviewer result.
        pub(crate) fn push_review(&self, result: Result<&str, &str>) -> &Self {
            self.reviews
                .lock()
                .expect("review queue")
                .push_back(map_scripted(result));
            self
        }

        pub(crate) fn events(&self) -> Vec<(String, Value)> {
            self.events.lock().expect("events").clone()
        }

        pub(crate) fn transcripts(&self) -> Vec<RecordedTranscript> {
            self.transcripts.lock().expect("transcripts").clone()
        }

        pub(crate) fn turn_requests(&self) -> Vec<WorkflowTurnRequest> {
            self.turn_requests.lock().expect("turn requests").clone()
        }

        pub(crate) fn reviewer_prompts(&self) -> Vec<String> {
            self.reviewer_prompts.lock().expect("reviewer prompts").clone()
        }

        /// True once every scripted response has been consumed.
        pub(crate) fn scripts_drained(&self) -> bool {
            self.turns.lock().expect("turn queue").is_empty()
                && self.reviews.lock().expect("review queue").is_empty()
        }
    }

    fn map_scripted(result: Result<&str, &str>) -> Result<String, String> {
        result.map(str::to_string).map_err(str::to_string)
    }

    #[async_trait::async_trait]
    impl AppCtx for TestCtx {
        fn project_path(&self) -> Result<PathBuf, String> {
            Ok(self.workspace.path().to_path_buf())
        }

        fn project_id(&self) -> Result<String, String> {
            Ok(self.project_id.clone())
        }

        fn emit(&self, event: &str, payload: Value) {
            self.events
                .lock()
                .expect("events")
                .push((event.to_string(), payload));
        }

        fn append_ledger_transcript(
            &self,
            binding: &WorkflowSessionBinding,
            action_id: &str,
            stage_id: &str,
            text: &str,
        ) -> Result<(), String> {
            self.transcripts
                .lock()
                .expect("transcripts")
                .push(RecordedTranscript {
                    kind: "ledger",
                    session_id: binding.session_id.clone(),
                    action_id: action_id.to_string(),
                    stage_id: stage_id.to_string(),
                    text: text.to_string(),
                });
            Ok(())
        }

        fn append_reviewer_transcript(
            &self,
            binding: &WorkflowSessionBinding,
            action_id: &str,
            stage_id: &str,
            text: &str,
        ) -> Result<(), String> {
            self.transcripts
                .lock()
                .expect("transcripts")
                .push(RecordedTranscript {
                    kind: "reviewer",
                    session_id: binding.session_id.clone(),
                    action_id: action_id.to_string(),
                    stage_id: stage_id.to_string(),
                    text: text.to_string(),
                });
            Ok(())
        }

        async fn run_workflow_turn(
            &self,
            request: WorkflowTurnRequest,
        ) -> Result<String, String> {
            self.turn_requests
                .lock()
                .expect("turn requests")
                .push(request);
            self.turns
                .lock()
                .expect("turn queue")
                .pop_front()
                .unwrap_or_else(|| {
                    Err("TestCtx: unscripted executor turn".to_string())
                })
        }

        async fn run_reviewer_oneshot(
            &self,
            system: String,
            prompt: String,
            _action_id: String,
        ) -> Result<String, String> {
            self.reviewer_prompts
                .lock()
                .expect("reviewer prompts")
                .push(format!("{system}\n---\n{prompt}"));
            self.reviews
                .lock()
                .expect("review queue")
                .pop_front()
                .unwrap_or_else(|| {
                    Err("TestCtx: unscripted reviewer call".to_string())
                })
        }
    }
}
