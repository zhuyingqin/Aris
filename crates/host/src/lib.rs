//! Host-independent research execution state.
//!
//! The desktop and Android service need different process and UI hosts while
//! sharing durable run state. Reviewed runs keep the Executor -> independent
//! Reviewer gate; explicitly configured mobile runs can finish after the
//! Executor output. Network clients, tool executors, Android services, and
//! Tauri remain outside this crate.

use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const HOST_PROTOCOL_VERSION: u32 = 1;
const MAX_IDENTIFIER_BYTES: usize = 160;
const MAX_OBJECTIVE_BYTES: usize = 4_000;
const MAX_ARTIFACT_BYTES: usize = 4 * 1024 * 1024;
const MAX_SUMMARY_BYTES: usize = 8_000;
const MAX_FEEDBACK_BYTES: usize = 64_000;
const MAX_EVIDENCE_ITEMS: usize = 64;
const MAX_EVIDENCE_BYTES: usize = 8_000;
const MAX_EVENTS: usize = 2_000;
const MAX_DURABLE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Ready,
    Executing,
    AwaitingReview,
    RevisionRequired,
    Completed,
    Paused,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    ExecutorOnly,
    #[default]
    Reviewed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDisposition {
    Approved,
    ChangesRequested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorOutput {
    pub executor_id: String,
    pub artifact_id: String,
    pub artifact_content: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewerVerdict {
    pub reviewer_id: String,
    pub disposition: ReviewDisposition,
    pub feedback: String,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewerRequest {
    pub run_id: String,
    pub project_id: String,
    pub objective: String,
    pub revision: u32,
    pub artifact_id: String,
    pub artifact_content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub sequence: u64,
    pub kind: String,
    pub revision: u32,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchRun {
    pub protocol_version: u32,
    #[serde(default)]
    pub mode: RunMode,
    pub run_id: String,
    pub project_id: String,
    pub objective: String,
    pub revision: u32,
    pub status: RunStatus,
    pub executor_output: Option<ExecutorOutput>,
    pub reviewer_verdict: Option<ReviewerVerdict>,
    pub paused_from: Option<RunStatus>,
    pub events: Vec<RunEvent>,
}

#[derive(Debug, Error)]
pub enum HostError {
    #[error("invalid run identifier or project identifier")]
    InvalidIdentifier,
    #[error("invalid research objective")]
    InvalidObjective,
    #[error("invalid or oversized run payload: {0}")]
    InvalidPayload(&'static str),
    #[error("run {run_id} cannot perform {operation} while in {status:?}")]
    InvalidTransition {
        run_id: String,
        status: RunStatus,
        operation: &'static str,
    },
    #[error("reviewer {reviewer_id} must be independent from executor {executor_id}")]
    ReviewerNotIndependent {
        reviewer_id: String,
        executor_id: String,
    },
    #[error("reviewer feedback is required when changes are requested")]
    MissingReviewerFeedback,
    #[error("cannot approve a run without reviewer evidence")]
    MissingReviewerEvidence,
    #[error("run event history reached its limit")]
    EventLimitReached,
    #[error("could not read durable run: {0}")]
    Read(#[source] std::io::Error),
    #[error("could not write durable run: {0}")]
    Write(#[source] std::io::Error),
    #[error("could not encode durable run: {0}")]
    Encode(#[source] serde_json::Error),
    #[error("could not decode durable run: {0}")]
    Decode(#[source] serde_json::Error),
    #[error("durable run failed invariant validation: {0}")]
    InvalidDurableState(String),
}

impl ResearchRun {
    pub fn new(
        run_id: impl Into<String>,
        project_id: impl Into<String>,
        objective: impl Into<String>,
    ) -> Result<Self, HostError> {
        Self::new_with_mode(run_id, project_id, objective, RunMode::Reviewed)
    }

    pub fn new_executor_only(
        run_id: impl Into<String>,
        project_id: impl Into<String>,
        objective: impl Into<String>,
    ) -> Result<Self, HostError> {
        Self::new_with_mode(run_id, project_id, objective, RunMode::ExecutorOnly)
    }

    fn new_with_mode(
        run_id: impl Into<String>,
        project_id: impl Into<String>,
        objective: impl Into<String>,
        mode: RunMode,
    ) -> Result<Self, HostError> {
        let run_id = normalize_identifier(run_id.into())?;
        let project_id = normalize_identifier(project_id.into())?;
        let objective = normalize_objective(objective.into())?;
        Ok(Self {
            protocol_version: HOST_PROTOCOL_VERSION,
            mode,
            run_id,
            project_id,
            objective,
            revision: 0,
            status: RunStatus::Ready,
            executor_output: None,
            reviewer_verdict: None,
            paused_from: None,
            events: vec![RunEvent {
                sequence: 0,
                kind: "run_created".to_string(),
                revision: 0,
                detail: match mode {
                    RunMode::ExecutorOnly => "executor-only research run created".to_string(),
                    RunMode::Reviewed => "reviewed research run created".to_string(),
                },
            }],
        })
    }

    pub fn start_executor(&mut self) -> Result<(), HostError> {
        self.ensure_status(
            "start_executor",
            &[RunStatus::Ready, RunStatus::RevisionRequired],
        )?;
        self.ensure_event_capacity()?;
        if self.status == RunStatus::RevisionRequired {
            self.revision = self.revision.saturating_add(1);
            self.reviewer_verdict = None;
            self.executor_output = None;
        }
        self.status = RunStatus::Executing;
        self.push_event("executor_started", "Executor turn started");
        Ok(())
    }

    pub fn record_executor_output(&mut self, output: ExecutorOutput) -> Result<(), HostError> {
        self.ensure_status("record_executor_output", &[RunStatus::Executing])?;
        validate_executor_output(&output)?;
        self.ensure_event_capacity()?;
        self.executor_output = Some(output);
        match self.mode {
            RunMode::ExecutorOnly => {
                self.status = RunStatus::Completed;
                self.push_event("executor_completed", "Executor output completed the run");
            }
            RunMode::Reviewed => {
                self.status = RunStatus::AwaitingReview;
                self.push_event("executor_completed", "Executor output is awaiting review");
            }
        }
        Ok(())
    }

    /// Builds the bounded Reviewer input. It intentionally exposes the
    /// objective and produced artifact only; Executor-private context does not
    /// cross the role boundary.
    pub fn reviewer_request(&self) -> Result<ReviewerRequest, HostError> {
        self.ensure_status("reviewer_request", &[RunStatus::AwaitingReview])?;
        let output = self
            .executor_output
            .as_ref()
            .ok_or(HostError::InvalidTransition {
                run_id: self.run_id.clone(),
                status: self.status,
                operation: "reviewer_request",
            })?;
        Ok(ReviewerRequest {
            run_id: self.run_id.clone(),
            project_id: self.project_id.clone(),
            objective: self.objective.clone(),
            revision: self.revision,
            artifact_id: output.artifact_id.clone(),
            artifact_content: output.artifact_content.clone(),
        })
    }

    pub fn record_reviewer_verdict(&mut self, verdict: ReviewerVerdict) -> Result<(), HostError> {
        self.ensure_status("record_reviewer_verdict", &[RunStatus::AwaitingReview])?;
        let output = self
            .executor_output
            .as_ref()
            .ok_or(HostError::InvalidTransition {
                run_id: self.run_id.clone(),
                status: self.status,
                operation: "record_reviewer_verdict",
            })?;
        validate_reviewer_verdict(&verdict)?;
        if verdict.reviewer_id == output.executor_id {
            return Err(HostError::ReviewerNotIndependent {
                reviewer_id: verdict.reviewer_id,
                executor_id: output.executor_id.clone(),
            });
        }
        match verdict.disposition {
            ReviewDisposition::Approved if verdict.evidence.is_empty() => {
                return Err(HostError::MissingReviewerEvidence);
            }
            ReviewDisposition::ChangesRequested if verdict.feedback.trim().is_empty() => {
                return Err(HostError::MissingReviewerFeedback);
            }
            _ => {}
        }
        self.ensure_event_capacity()?;
        self.status = match verdict.disposition {
            ReviewDisposition::Approved => RunStatus::Completed,
            ReviewDisposition::ChangesRequested => RunStatus::RevisionRequired,
        };
        let detail = match verdict.disposition {
            ReviewDisposition::Approved => "independent Reviewer approved the artifact",
            ReviewDisposition::ChangesRequested => "independent Reviewer requested changes",
        };
        self.reviewer_verdict = Some(verdict);
        self.push_event("reviewer_recorded", detail);
        Ok(())
    }

    pub fn pause(&mut self) -> Result<(), HostError> {
        self.ensure_status(
            "pause",
            &[
                RunStatus::Ready,
                RunStatus::Executing,
                RunStatus::AwaitingReview,
                RunStatus::RevisionRequired,
            ],
        )?;
        self.ensure_event_capacity()?;
        self.paused_from = Some(self.status);
        self.status = RunStatus::Paused;
        self.push_event("run_paused", "research run paused");
        Ok(())
    }

    pub fn resume(&mut self) -> Result<(), HostError> {
        self.ensure_status("resume", &[RunStatus::Paused])?;
        self.ensure_event_capacity()?;
        self.status = self.paused_from.take().unwrap_or(RunStatus::Ready);
        self.push_event("run_resumed", "research run resumed");
        Ok(())
    }

    pub fn save(&self, path: &Path) -> Result<(), HostError> {
        self.validate()?;
        let body = serde_json::to_vec_pretty(self).map_err(HostError::Encode)?;
        if body.len() as u64 > MAX_DURABLE_BYTES {
            return Err(HostError::InvalidDurableState(
                "durable run exceeds its size bound".to_string(),
            ));
        }
        runtime::write_file_atomically(path, body).map_err(HostError::Write)
    }

    pub fn load(path: &Path) -> Result<Self, HostError> {
        let metadata = std::fs::metadata(path).map_err(HostError::Read)?;
        if metadata.len() > MAX_DURABLE_BYTES {
            return Err(HostError::InvalidDurableState(
                "durable run exceeds its size bound".to_string(),
            ));
        }
        let body = std::fs::read(path).map_err(HostError::Read)?;
        let run: Self = serde_json::from_slice(&body).map_err(HostError::Decode)?;
        run.validate()?;
        Ok(run)
    }

    pub fn validate(&self) -> Result<(), HostError> {
        if self.protocol_version != HOST_PROTOCOL_VERSION {
            return Err(HostError::InvalidDurableState(format!(
                "unsupported host protocol version {}",
                self.protocol_version
            )));
        }
        normalize_identifier(self.run_id.clone())?;
        normalize_identifier(self.project_id.clone())?;
        normalize_objective(self.objective.clone())?;
        if self.events.is_empty() || self.events.len() > MAX_EVENTS {
            return Err(HostError::InvalidDurableState(
                "event history is empty or exceeds its bound".to_string(),
            ));
        }
        for (expected, event) in self.events.iter().enumerate() {
            if event.sequence != expected as u64
                || event.revision > self.revision
                || event.kind.trim().is_empty()
                || event.detail.len() > MAX_FEEDBACK_BYTES
            {
                return Err(HostError::InvalidDurableState(
                    "event history is not monotonic or contains an invalid entry".to_string(),
                ));
            }
        }
        if let Some(output) = &self.executor_output {
            validate_executor_output(output)?;
        }
        if let Some(verdict) = &self.reviewer_verdict {
            if self.mode == RunMode::ExecutorOnly {
                return Err(HostError::InvalidDurableState(
                    "executor-only run cannot contain a reviewer verdict".to_string(),
                ));
            }
            validate_reviewer_verdict(verdict)?;
            if let Some(output) = &self.executor_output {
                if verdict.reviewer_id == output.executor_id {
                    return Err(HostError::InvalidDurableState(
                        "reviewer and executor identities are equal".to_string(),
                    ));
                }
            }
        }
        match self.status {
            RunStatus::Ready | RunStatus::Executing => {
                if self.executor_output.is_some() || self.reviewer_verdict.is_some() {
                    return Err(HostError::InvalidDurableState(
                        "an active executor run cannot already have output or a reviewer verdict"
                            .to_string(),
                    ));
                }
            }
            RunStatus::AwaitingReview => {
                if self.mode != RunMode::Reviewed
                    || self.executor_output.is_none()
                    || self.reviewer_verdict.is_some()
                {
                    return Err(HostError::InvalidDurableState(
                        "awaiting review requires reviewed mode and exactly an executor output"
                            .to_string(),
                    ));
                }
            }
            RunStatus::RevisionRequired => {
                if self.mode != RunMode::Reviewed
                    || self.executor_output.is_none()
                    || self.reviewer_verdict.as_ref().is_none_or(|verdict| {
                        verdict.disposition != ReviewDisposition::ChangesRequested
                    })
                {
                    return Err(HostError::InvalidDurableState(
                        "revision required needs a change-request verdict".to_string(),
                    ));
                }
            }
            RunStatus::Completed => {
                let valid_completion = self.executor_output.is_some()
                    && match self.mode {
                        RunMode::ExecutorOnly => self.reviewer_verdict.is_none(),
                        RunMode::Reviewed => {
                            self.reviewer_verdict.as_ref().is_some_and(|verdict| {
                                verdict.disposition == ReviewDisposition::Approved
                            })
                        }
                    };
                if !valid_completion {
                    return Err(HostError::InvalidDurableState(
                        "completed run does not satisfy its completion mode".to_string(),
                    ));
                }
            }
            RunStatus::Paused => {
                let Some(paused_from) = self.paused_from else {
                    return Err(HostError::InvalidDurableState(
                        "paused run must record its prior status".to_string(),
                    ));
                };
                if paused_from == RunStatus::Paused {
                    return Err(HostError::InvalidDurableState(
                        "paused run must record a non-paused prior status".to_string(),
                    ));
                }
                match paused_from {
                    RunStatus::Ready | RunStatus::Executing => {
                        if self.executor_output.is_some() || self.reviewer_verdict.is_some() {
                            return Err(HostError::InvalidDurableState(
                                "paused active run contains output or a reviewer verdict"
                                    .to_string(),
                            ));
                        }
                    }
                    RunStatus::AwaitingReview => {
                        if self.mode != RunMode::Reviewed
                            || self.executor_output.is_none()
                            || self.reviewer_verdict.is_some()
                        {
                            return Err(HostError::InvalidDurableState(
                                "paused review run has an invalid payload".to_string(),
                            ));
                        }
                    }
                    RunStatus::RevisionRequired => {
                        if self.mode != RunMode::Reviewed
                            || self.executor_output.is_none()
                            || self.reviewer_verdict.as_ref().map_or(true, |verdict| {
                                verdict.disposition != ReviewDisposition::ChangesRequested
                            })
                        {
                            return Err(HostError::InvalidDurableState(
                                "paused revision run has an invalid payload".to_string(),
                            ));
                        }
                    }
                    RunStatus::Completed | RunStatus::Paused => unreachable!(),
                }
            }
        }
        Ok(())
    }

    fn ensure_status(
        &self,
        operation: &'static str,
        allowed: &[RunStatus],
    ) -> Result<(), HostError> {
        if allowed.contains(&self.status) {
            Ok(())
        } else {
            Err(HostError::InvalidTransition {
                run_id: self.run_id.clone(),
                status: self.status,
                operation,
            })
        }
    }

    fn ensure_event_capacity(&self) -> Result<(), HostError> {
        if self.events.len() >= MAX_EVENTS {
            Err(HostError::EventLimitReached)
        } else {
            Ok(())
        }
    }

    fn push_event(&mut self, kind: &str, detail: &str) {
        let sequence = self.events.last().map_or(0, |event| event.sequence + 1);
        self.events.push(RunEvent {
            sequence,
            kind: kind.to_string(),
            revision: self.revision,
            detail: detail.to_string(),
        });
    }
}

fn normalize_identifier(value: String) -> Result<String, HostError> {
    let value = value.trim().to_string();
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(HostError::InvalidIdentifier);
    }
    Ok(value)
}

fn normalize_objective(value: String) -> Result<String, HostError> {
    let value = value.trim().to_string();
    if value.is_empty() || value.len() > MAX_OBJECTIVE_BYTES || value.chars().any(char::is_control)
    {
        return Err(HostError::InvalidObjective);
    }
    Ok(value)
}

fn validate_executor_output(output: &ExecutorOutput) -> Result<(), HostError> {
    normalize_identifier(output.executor_id.clone())?;
    normalize_identifier(output.artifact_id.clone())?;
    if output.artifact_content.trim().is_empty()
        || output.artifact_content.len() > MAX_ARTIFACT_BYTES
    {
        return Err(HostError::InvalidPayload(
            "artifact content is empty or oversized",
        ));
    }
    if output.summary.len() > MAX_SUMMARY_BYTES {
        return Err(HostError::InvalidPayload("executor summary is oversized"));
    }
    Ok(())
}

fn validate_reviewer_verdict(verdict: &ReviewerVerdict) -> Result<(), HostError> {
    normalize_identifier(verdict.reviewer_id.clone())?;
    if verdict.feedback.len() > MAX_FEEDBACK_BYTES || verdict.evidence.len() > MAX_EVIDENCE_ITEMS {
        return Err(HostError::InvalidPayload(
            "reviewer feedback or evidence is oversized",
        ));
    }
    if verdict
        .evidence
        .iter()
        .any(|item| item.len() > MAX_EVIDENCE_BYTES || item.trim().is_empty())
    {
        return Err(HostError::InvalidPayload(
            "reviewer evidence item is empty or oversized",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn output() -> ExecutorOutput {
        ExecutorOutput {
            executor_id: "executor-a".to_string(),
            artifact_id: "artifact-1".to_string(),
            artifact_content: "result with source evidence".to_string(),
            summary: "draft result".to_string(),
        }
    }

    fn approved() -> ReviewerVerdict {
        ReviewerVerdict {
            reviewer_id: "reviewer-b".to_string(),
            disposition: ReviewDisposition::Approved,
            feedback: "evidence is sufficient".to_string(),
            evidence: vec!["artifact-1 contains the cited result".to_string()],
        }
    }

    #[test]
    fn rejects_blank_reviewer_evidence() {
        let mut run = ResearchRun::new("project-1", "session-1", "question").expect("run");
        run.start_executor().expect("start");
        run.record_executor_output(output()).expect("output");
        let mut verdict = approved();
        verdict.evidence = vec!["   ".to_string()];

        let error = run
            .record_reviewer_verdict(verdict)
            .expect_err("blank evidence");
        assert!(matches!(error, HostError::InvalidPayload(_)));
    }

    #[test]
    fn independent_review_is_required_before_completion() {
        let mut run = ResearchRun::new("run-1", "project-1", "test a research question").unwrap();
        run.start_executor().unwrap();
        run.record_executor_output(output()).unwrap();
        assert_eq!(run.status, RunStatus::AwaitingReview);
        assert_eq!(run.reviewer_request().unwrap().artifact_id, "artifact-1");
        run.record_reviewer_verdict(approved()).unwrap();
        assert_eq!(run.status, RunStatus::Completed);
    }

    #[test]
    fn executor_only_run_completes_after_executor_output() {
        let mut run =
            ResearchRun::new_executor_only("run-1", "project-1", "finish one mobile task").unwrap();
        assert_eq!(run.mode, RunMode::ExecutorOnly);
        run.start_executor().unwrap();
        run.record_executor_output(output()).unwrap();

        assert_eq!(run.status, RunStatus::Completed);
        assert!(run.reviewer_verdict.is_none());
        assert!(matches!(
            run.reviewer_request(),
            Err(HostError::InvalidTransition { .. })
        ));
        run.validate().unwrap();
    }

    #[test]
    fn missing_mode_deserializes_as_reviewed_for_existing_runs() {
        let run = ResearchRun::new("run-1", "project-1", "existing run").unwrap();
        let mut value = serde_json::to_value(run).unwrap();
        value.as_object_mut().unwrap().remove("mode");

        let decoded: ResearchRun = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.mode, RunMode::Reviewed);
        decoded.validate().unwrap();
    }

    #[test]
    fn executor_cannot_supply_its_own_reviewer_verdict() {
        let mut run = ResearchRun::new("run-1", "project-1", "test a research question").unwrap();
        run.start_executor().unwrap();
        run.record_executor_output(output()).unwrap();
        let mut verdict = approved();
        verdict.reviewer_id = "executor-a".to_string();
        assert!(matches!(
            run.record_reviewer_verdict(verdict),
            Err(HostError::ReviewerNotIndependent { .. })
        ));
        assert_eq!(run.status, RunStatus::AwaitingReview);
    }

    #[test]
    fn requested_changes_start_a_new_revision_and_clear_old_verdict() {
        let mut run = ResearchRun::new("run-1", "project-1", "test a research question").unwrap();
        run.start_executor().unwrap();
        run.record_executor_output(output()).unwrap();
        run.record_reviewer_verdict(ReviewerVerdict {
            reviewer_id: "reviewer-b".to_string(),
            disposition: ReviewDisposition::ChangesRequested,
            feedback: "add a reproducible input description".to_string(),
            evidence: vec!["artifact-1".to_string()],
        })
        .unwrap();
        assert_eq!(run.status, RunStatus::RevisionRequired);
        run.start_executor().unwrap();
        assert_eq!(run.revision, 1);
        assert!(run.reviewer_verdict.is_none());
    }

    #[test]
    fn durable_state_round_trips_atomically() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("run.json");
        let mut run = ResearchRun::new("run-1", "project-1", "test a research question").unwrap();
        run.start_executor().unwrap();
        run.record_executor_output(output()).unwrap();
        run.save(&path).unwrap();
        assert_eq!(ResearchRun::load(&path).unwrap(), run);
    }

    #[test]
    fn identifiers_cannot_be_used_as_path_segments() {
        assert!(matches!(
            ResearchRun::new("../run", "project-1", "objective"),
            Err(HostError::InvalidIdentifier)
        ));
        assert!(matches!(
            ResearchRun::new("run-1", "project/1", "objective"),
            Err(HostError::InvalidIdentifier)
        ));
    }

    #[test]
    fn durable_state_validation_rejects_a_forged_completed_run() {
        let mut run = ResearchRun::new("run-1", "project-1", "objective").unwrap();
        run.status = RunStatus::Completed;
        assert!(matches!(
            run.validate(),
            Err(HostError::InvalidDurableState(_))
        ));
    }

    #[test]
    fn event_limit_rejects_a_new_mutation_without_overflowing_history() {
        let mut run = ResearchRun::new("run-1", "project-1", "objective").unwrap();
        run.events = (0..MAX_EVENTS)
            .map(|sequence| RunEvent {
                sequence: sequence as u64,
                kind: "checkpoint".to_string(),
                revision: 0,
                detail: "checkpoint".to_string(),
            })
            .collect();

        assert!(matches!(
            run.start_executor(),
            Err(HostError::EventLimitReached)
        ));
        assert_eq!(run.status, RunStatus::Ready);
        assert_eq!(run.events.len(), MAX_EVENTS);
    }

    #[test]
    fn oversized_durable_state_is_rejected_before_decode() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("oversized-run.json");
        std::fs::write(&path, vec![b'0'; MAX_DURABLE_BYTES as usize + 1]).unwrap();

        assert!(matches!(
            ResearchRun::load(&path),
            Err(HostError::InvalidDurableState(_))
        ));
    }
}
