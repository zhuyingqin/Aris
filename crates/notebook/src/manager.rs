//! Process-wide registry of running [`KernelSession`]s, keyed by a caller-chosen
//! id (in practice, the notebook path). Sessions are stored behind `Arc` so an
//! execute clones a handle and releases the registry lock *before* blocking on
//! the kernel — one slow cell never stalls `start` / `list` / other kernels.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

use crate::backend::KernelHandle;
use crate::kernel::{CellOutput, ExecuteOutcome, KernelSession, OutputCallback};
use crate::matlab::{self, MatlabSession};
use crate::NotebookError;

/// Lightweight description of a running kernel (for the UI / tool replies).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelInfo {
    pub id: String,
    pub pid: u32,
    pub kernel_name: String,
}

/// An *available* kernel the user can pick (installed Jupyter kernelspec or the
/// native MATLAB backend), independent of whether one is currently running.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelspecInfo {
    pub name: String,
    pub display_name: String,
    pub language: String,
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<KernelHandle>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<KernelHandle>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Static facade over the session map.
pub struct KernelManager;

impl KernelManager {
    /// Start (or return the already-running) kernel for `id`.
    pub fn start(
        id: &str,
        kernel_name: Option<&str>,
        workdir: &Path,
    ) -> Result<KernelInfo, NotebookError> {
        if let Some(existing) = sessions().lock().unwrap().get(id) {
            return Ok(KernelInfo {
                id: id.to_string(),
                pid: existing.pid(),
                kernel_name: existing.kernel_name().to_string(),
            });
        }
        // Resolve the kernel: an explicit name wins; otherwise fall back to the
        // notebook's recorded `metadata.kernelspec` (the session id is the
        // notebook path) so a MATLAB notebook starts MATLAB even when the caller
        // — an LLM tool, the CLI — doesn't specify one. Failing both, auto-pick.
        let recorded = if kernel_name.is_none() {
            crate::NotebookDoc::load(std::path::Path::new(id))
                .ok()
                .and_then(|doc| doc.kernelspec_name())
        } else {
            None
        };
        let resolved = kernel_name.or(recorded.as_deref());

        // Start outside the lock: kernel boot + handshake can take seconds.
        let session = if resolved.is_some_and(matlab::is_matlab_kernel) {
            KernelHandle::Matlab(MatlabSession::start(workdir)?)
        } else {
            KernelHandle::Jupyter(KernelSession::start(resolved, workdir)?)
        };
        let info = KernelInfo {
            id: id.to_string(),
            pid: session.pid(),
            kernel_name: session.kernel_name().to_string(),
        };
        let mut map = sessions().lock().unwrap();
        // Lost a race? Keep the first winner, drop ours.
        if let Some(existing) = map.get(id) {
            let info = KernelInfo {
                id: id.to_string(),
                pid: existing.pid(),
                kernel_name: existing.kernel_name().to_string(),
            };
            drop(map);
            let _ = session.shutdown();
            return Ok(info);
        }
        map.insert(id.to_string(), Arc::new(session));
        Ok(info)
    }

    /// Execute a snippet against the kernel for `id`.
    pub fn execute(
        id: &str,
        code: &str,
        timeout: Duration,
    ) -> Result<ExecuteOutcome, NotebookError> {
        let session = sessions().lock().unwrap().get(id).cloned();
        let session = session.ok_or_else(|| NotebookError::NoSession(id.to_string()))?;
        session.execute(code, timeout)
    }

    /// Execute a snippet and stream every output as it arrives.
    pub fn execute_streaming<F>(
        id: &str,
        code: &str,
        timeout: Duration,
        on_output: F,
    ) -> Result<ExecuteOutcome, NotebookError>
    where
        F: Fn(CellOutput) + Send + 'static,
    {
        let session = sessions().lock().unwrap().get(id).cloned();
        let session = session.ok_or_else(|| NotebookError::NoSession(id.to_string()))?;
        session.execute_streaming(code, timeout, Box::new(on_output) as OutputCallback)
    }

    /// Interrupt the kernel for `id`, raising `KeyboardInterrupt` in the running
    /// cell. Errors if no kernel is running for `id`. Cloned + lock released
    /// before signalling so it never contends with an in-flight execute.
    pub fn interrupt(id: &str) -> Result<(), NotebookError> {
        let session = sessions().lock().unwrap().get(id).cloned();
        let session = session.ok_or_else(|| NotebookError::NoSession(id.to_string()))?;
        session.interrupt()
    }

    /// Stop and forget the kernel for `id`. No-op if not running.
    pub fn shutdown(id: &str) -> Result<(), NotebookError> {
        let session = sessions().lock().unwrap().remove(id);
        if let Some(session) = session {
            session.shutdown()?;
        }
        Ok(())
    }

    /// Stop and forget every running kernel. This is intended for app shutdown:
    /// clear the registry first so late UI/tool calls cannot keep reusing stale
    /// handles while the kernel processes are being torn down.
    pub fn shutdown_all() {
        let sessions = {
            let mut map = sessions().lock().unwrap();
            map.drain().map(|(_, session)| session).collect::<Vec<_>>()
        };
        for session in sessions {
            let _ = session.shutdown();
        }
    }

    /// All kernels the user can choose: installed Jupyter kernelspecs plus the
    /// native MATLAB backend when a MATLAB install is detected. Blocking (reads
    /// kernelspec dirs); call from a blocking context.
    pub fn available_kernels() -> Vec<KernelspecInfo> {
        let mut out: Vec<KernelspecInfo> = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map(|rt| {
                rt.block_on(jupyter_zmq_client::list_kernelspecs_with_jupyter_paths())
                    .into_iter()
                    .map(|spec| KernelspecInfo {
                        name: spec.kernel_name.clone(),
                        display_name: spec.kernelspec.display_name.clone(),
                        language: spec.kernelspec.language.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        if matlab::find_matlab().is_some() && !out.iter().any(|k| matlab::is_matlab_kernel(&k.name))
        {
            out.push(KernelspecInfo {
                name: matlab::KERNEL_NAME.to_string(),
                display_name: "MATLAB".to_string(),
                language: "matlab".to_string(),
            });
        }
        out
    }

    /// All currently running kernels.
    pub fn list() -> Vec<KernelInfo> {
        sessions()
            .lock()
            .unwrap()
            .iter()
            .map(|(id, s)| KernelInfo {
                id: id.clone(),
                pid: s.pid(),
                kernel_name: s.kernel_name().to_string(),
            })
            .collect()
    }

    pub fn is_running(id: &str) -> bool {
        sessions().lock().unwrap().contains_key(id)
    }

    /// Coarse language of the kernel for `id` (`"python"`, `"matlab"`, …), used
    /// to pick the right variable-inspection snippet. `None` if not running.
    pub fn language(id: &str) -> Option<String> {
        sessions()
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.language().to_string())
    }
}
