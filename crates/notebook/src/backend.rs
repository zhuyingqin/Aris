//! A uniform handle over the two kernel backends the Lab can drive:
//!   - [`KernelSession`]: a real Jupyter kernel over `ZeroMQ` (Python, etc.).
//!   - [`MatlabSession`]: a native MATLAB process over a file-based REPL.
//!
//! [`crate::KernelManager`] stores one `KernelHandle` per notebook and never
//! cares which backend it is — every method dispatches to the active variant.

use std::time::Duration;

use crate::kernel::{
    CompleteOutcome, ExecuteOutcome, InspectOutcome, KernelSession, OutputCallback,
};
use crate::matlab::MatlabSession;
use crate::NotebookError;

/// One running kernel, either Jupyter (ZMQ) or native MATLAB.
pub enum KernelHandle {
    Jupyter(KernelSession),
    Matlab(MatlabSession),
}

impl KernelHandle {
    pub fn pid(&self) -> u32 {
        match self {
            KernelHandle::Jupyter(k) => k.pid(),
            KernelHandle::Matlab(m) => m.pid(),
        }
    }

    pub fn kernel_name(&self) -> &str {
        match self {
            KernelHandle::Jupyter(k) => k.kernel_name(),
            KernelHandle::Matlab(m) => m.kernel_name(),
        }
    }

    /// Coarse language id used to pick the right variable-inspection snippet:
    /// `"matlab"`, `"python"`, or the kernelspec name for anything else.
    pub fn language(&self) -> &str {
        match self {
            KernelHandle::Matlab(_) => "matlab",
            KernelHandle::Jupyter(k) => {
                let name = k.kernel_name();
                if name.to_lowercase().contains("python") {
                    "python"
                } else {
                    name
                }
            }
        }
    }

    pub fn execute(&self, code: &str, timeout: Duration) -> Result<ExecuteOutcome, NotebookError> {
        match self {
            KernelHandle::Jupyter(k) => k.execute(code, timeout),
            KernelHandle::Matlab(m) => m.execute(code, timeout),
        }
    }

    pub fn execute_streaming(
        &self,
        code: &str,
        timeout: Duration,
        on_output: OutputCallback,
    ) -> Result<ExecuteOutcome, NotebookError> {
        match self {
            KernelHandle::Jupyter(k) => k.execute_streaming(code, timeout, on_output),
            KernelHandle::Matlab(m) => m.execute_streaming(code, timeout, on_output),
        }
    }

    /// Tab-completion. Only the Jupyter backend supports it; MATLAB returns
    /// nothing rather than erroring, so the editor just shows no suggestions.
    pub fn complete(
        &self,
        code: &str,
        cursor_pos: usize,
    ) -> Result<CompleteOutcome, NotebookError> {
        match self {
            KernelHandle::Jupyter(k) => k.complete(code, cursor_pos),
            KernelHandle::Matlab(_) => Ok(CompleteOutcome::default()),
        }
    }

    /// Object introspection (Shift+Tab docs). Jupyter-only; MATLAB returns empty.
    pub fn inspect(&self, code: &str, cursor_pos: usize) -> Result<InspectOutcome, NotebookError> {
        match self {
            KernelHandle::Jupyter(k) => k.inspect(code, cursor_pos),
            KernelHandle::Matlab(_) => Ok(InspectOutcome::default()),
        }
    }

    pub fn interrupt(&self) -> Result<(), NotebookError> {
        match self {
            KernelHandle::Jupyter(k) => k.interrupt(),
            KernelHandle::Matlab(m) => m.interrupt(),
        }
    }

    pub fn shutdown(&self) -> Result<(), NotebookError> {
        match self {
            KernelHandle::Jupyter(k) => k.shutdown(),
            KernelHandle::Matlab(m) => m.shutdown(),
        }
    }
}
