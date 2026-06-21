//! Process-wide registry of running [`KernelSession`]s, keyed by a caller-chosen
//! id (in practice, the notebook path). Sessions are stored behind `Arc` so an
//! execute clones a handle and releases the registry lock *before* blocking on
//! the kernel — one slow cell never stalls `start` / `list` / other kernels.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

use crate::kernel::{CellOutput, ExecuteOutcome, KernelSession, OutputCallback};
use crate::NotebookError;

/// Lightweight description of a running kernel (for the UI / tool replies).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelInfo {
    pub id: String,
    pub pid: u32,
    pub kernel_name: String,
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<KernelSession>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<KernelSession>>>> = OnceLock::new();
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
        // Start outside the lock: kernel boot + handshake can take seconds.
        let session = KernelSession::start(kernel_name, workdir)?;
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
}
