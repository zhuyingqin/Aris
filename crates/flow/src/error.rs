//! Error type shared across the flow runtime.

use thiserror::Error;

/// Errors raised by the flow runtime.
#[derive(Debug, Error)]
pub enum FlowError {
    /// A referenced step id does not exist in the flow definition.
    #[error("unknown step id: {0}")]
    UnknownStep(String),

    /// The flow's steps do not form a runnable DAG (cycle or dangling ref).
    #[error("invalid flow graph: {0}")]
    InvalidGraph(String),

    /// An input reference could not be resolved at run time.
    #[error("cannot resolve input {reference} for step {step}: {reason}")]
    UnresolvedInput {
        /// The step whose input failed to resolve.
        step: String,
        /// A human description of the reference (e.g. `step:survey`).
        reference: String,
        /// Why resolution failed.
        reason: String,
    },

    /// A step kind that P0 does not execute yet (Agent/Map/Reduce/Gate/Controller).
    #[error("step kind not implemented in P0: {0}")]
    NotImplemented(String),

    /// The model provider call failed.
    #[error("provider error: {0}")]
    Provider(String),

    /// A required environment variable (e.g. `MINIMAX_API_KEY`) is missing.
    #[error("missing environment variable: {0}")]
    MissingEnv(String),

    /// Filesystem / persistence failure.
    #[error("io error at {path}: {source}")]
    Io {
        /// The path being operated on.
        path: String,
        /// The underlying error.
        source: std::io::Error,
    },

    /// (De)serialization failure.
    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),

    /// The named run could not be found on disk.
    #[error("run not found: {0}")]
    RunNotFound(String),
}

/// Convenience result alias.
pub type Result<T> = std::result::Result<T, FlowError>;

impl FlowError {
    /// Build an [`FlowError::Io`] tagged with the offending path.
    pub fn io(path: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}
