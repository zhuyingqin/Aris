//! Native Jupyter notebook execution for Aris.
//!
//! Two layers, both transport-owned in Rust (no Python server, no MCP bridge):
//! - [`NotebookDoc`]: a `serde_json`-backed `.ipynb` document with structured,
//!   cell-level edits (insert / replace / delete by index, write back outputs).
//!   `.ipynb` is JSON, so the document model is JSON; `nbformat` validates it on
//!   load. This is what keeps the LLM off raw-JSON surgery.
//! - [`KernelSession`] / [`KernelManager`]: drive a real Jupyter kernel over
//!   `ZeroMQ` (`jupyter-zmq-client`). Each session owns a dedicated runtime thread
//!   so the async kernel can be driven from Aris's synchronous tool layer.
#![allow(clippy::must_use_candidate, clippy::missing_panics_doc)]

mod backend;
mod doc;
mod kernel;
mod manager;
mod matlab;
mod run;

pub use backend::KernelHandle;
pub use doc::{CellSummary, NotebookDoc};
pub use kernel::{
    CellOutput, CompleteOutcome, ExecStatus, ExecuteOutcome, InspectOutcome, KernelSession,
};
pub use manager::{KernelInfo, KernelManager, KernelspecInfo};
pub use matlab::{find_matlab, MatlabSession, VAR_INSPECT_CODE as MATLAB_VAR_INSPECT_CODE};
pub use run::{run_all, CellRun, RunOptions, RunReport};

/// Errors surfaced by the notebook document and kernel layers.
#[derive(Debug, thiserror::Error)]
pub enum NotebookError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("notebook format error: {0}")]
    Format(String),
    #[error("cell index {index} out of range (notebook has {len} cell(s))")]
    CellIndex { index: usize, len: usize },
    #[error("kernel error: {0}")]
    Kernel(String),
    #[error("no running kernel session '{0}'")]
    NoSession(String),
}
