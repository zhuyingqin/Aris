//! Append-only run log + fold. The log is the source of truth for *history*
//! (rewind to any state); the [`crate::store`] is the source of truth for *results*.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{FlowError, Result};
use crate::store::StepKey;

/// One thing that happened during a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum FlowEvent {
    /// The run began (fresh, resumed, or forked).
    RunStarted {
        /// This run's id.
        run_id: String,
        /// The flow name.
        flow_name: String,
        /// The run arguments.
        args: Value,
        /// The parent run id, when this is a fork.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
    },
    /// A step is about to execute (or be served from cache).
    StepStarted {
        /// Step id.
        step: String,
        /// The step's content address.
        key: StepKey,
        /// Role name.
        role: String,
        /// Model id.
        model: String,
    },
    /// A step finished successfully.
    StepCompleted {
        /// Step id.
        step: String,
        /// The step's content address.
        key: StepKey,
        /// True when the result was served from the store rather than the model.
        cached: bool,
        /// Length of the produced output, in chars.
        output_len: usize,
    },
    /// A step failed.
    StepFailed {
        /// Step id.
        step: String,
        /// Error message.
        error: String,
    },
    /// The run finished.
    RunFinished {
        /// The id of the terminal step whose output is the run result.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_step: Option<String>,
    },
    /// P4 (declared now): a controller chose the next step(s) at run time.
    ControllerEmitted {
        /// The controller step.
        from: String,
        /// The step ids it scheduled next.
        next: Vec<String>,
    },
}

/// A log line: a sequence number + timestamp wrapping a [`FlowEvent`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    /// 0-based position in the log.
    pub seq: usize,
    /// Unix-epoch milliseconds.
    pub ts_ms: u128,
    /// The event payload.
    #[serde(flatten)]
    pub event: FlowEvent,
}

/// Append-only JSONL writer for one run's `events.jsonl`.
pub struct FlowEventLog {
    path: std::path::PathBuf,
    next_seq: usize,
}

impl FlowEventLog {
    /// Open the log for appending, continuing the sequence after any existing lines.
    ///
    /// # Errors
    /// Returns [`FlowError::Io`] if the run directory cannot be created/read.
    pub fn open_append(run_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(run_dir)
            .map_err(|e| FlowError::io(run_dir.display().to_string(), e))?;
        let path = run_dir.join("events.jsonl");
        let next_seq = read_entries(&path)?.len();
        Ok(Self { path, next_seq })
    }

    /// Append an event, returning its assigned sequence number.
    ///
    /// # Errors
    /// Returns [`FlowError::Io`] / [`FlowError::Serde`] on failure.
    pub fn append(&mut self, event: FlowEvent) -> Result<usize> {
        let seq = self.next_seq;
        let entry = LogEntry {
            seq,
            ts_ms: now_ms(),
            event,
        };
        let mut line = serde_json::to_string(&entry)?;
        line.push('\n');
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| FlowError::io(self.path.display().to_string(), e))?;
        file.write_all(line.as_bytes())
            .map_err(|e| FlowError::io(self.path.display().to_string(), e))?;
        self.next_seq += 1;
        Ok(seq)
    }
}

/// Read every entry from a run's event log (empty if the log does not exist yet).
///
/// # Errors
/// Returns [`FlowError::Io`] / [`FlowError::Serde`].
pub fn read_entries(path: &Path) -> Result<Vec<LogEntry>> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(FlowError::io(path.display().to_string(), e)),
    };
    let mut out = Vec::new();
    for line in std::io::BufReader::new(file).lines() {
        let line = line.map_err(|e| FlowError::io(path.display().to_string(), e))?;
        if line.trim().is_empty() {
            continue;
        }
        out.push(serde_json::from_str(&line)?);
    }
    Ok(out)
}

/// The reconstructed state of a run after folding some prefix of its log.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RunState {
    /// The run id, once `RunStarted` is seen.
    pub run_id: Option<String>,
    /// The flow name.
    pub flow_name: Option<String>,
    /// The run arguments.
    pub args: Value,
    /// Parent run id, when forked.
    pub parent: Option<String>,
    /// Completed steps in completion order, mapped to their content address.
    pub completed: BTreeMap<String, StepKey>,
    /// Of the completed steps, which were served from cache.
    pub cached: BTreeSet<String>,
    /// The first failure, if any (`step`, `error`).
    pub failed: Option<(String, String)>,
    /// Whether `RunFinished` was reached.
    pub finished: bool,
    /// The terminal result step, if the run finished.
    pub result_step: Option<String>,
    /// How many events were folded to reach this state.
    pub events_folded: usize,
}

/// Fold a prefix of the log into a [`RunState`]. `up_to` caps the number of events
/// folded (None = all) — this is the "rewind to any state" primitive.
#[must_use]
pub fn fold(entries: &[LogEntry], up_to: Option<usize>) -> RunState {
    let limit = up_to.unwrap_or(entries.len()).min(entries.len());
    let mut state = RunState::default();
    for entry in &entries[..limit] {
        match &entry.event {
            FlowEvent::RunStarted {
                run_id,
                flow_name,
                args,
                parent,
            } => {
                state.run_id = Some(run_id.clone());
                state.flow_name = Some(flow_name.clone());
                state.args = args.clone();
                state.parent.clone_from(parent);
            }
            FlowEvent::StepCompleted {
                step, key, cached, ..
            } => {
                state.completed.insert(step.clone(), key.clone());
                if *cached {
                    state.cached.insert(step.clone());
                }
            }
            FlowEvent::StepFailed { step, error } => {
                if state.failed.is_none() {
                    state.failed = Some((step.clone(), error.clone()));
                }
            }
            FlowEvent::RunFinished { result_step } => {
                state.finished = true;
                state.result_step.clone_from(result_step);
            }
            FlowEvent::StepStarted { .. } | FlowEvent::ControllerEmitted { .. } => {}
        }
        state.events_folded += 1;
    }
    state
}

/// Unix-epoch milliseconds, saturating at 0 before the epoch.
#[must_use]
pub fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}
