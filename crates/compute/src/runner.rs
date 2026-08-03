use crate::{ComputeJobStore, ComputeStoreError};
use glob::Pattern;
use remote_protocol::{
    ComputeArtifact, ComputeJobEvent, ComputeJobEventPayload, ComputeJobRequest, ComputeJobStatus,
    ComputeLogStream, ComputeResultManifest, ComputeWorkload,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use walkdir::WalkDir;

#[derive(Debug, Clone, Default)]
pub struct WorkerIdentity {
    pub device_id: Option<remote_protocol::DeviceId>,
    pub display_name: Option<String>,
    pub environment_fingerprint: Option<String>,
}

#[derive(Debug, Error)]
pub enum ComputeRunnerError {
    #[error(transparent)]
    Store(#[from] ComputeStoreError),
    #[error("invalid compute request: {0}")]
    InvalidRequest(String),
    #[error("compute process failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("notebook workloads require a notebook worker adapter")]
    NotebookAdapterRequired,
}

#[derive(Debug, Clone)]
pub struct ComputeRunner {
    store: ComputeJobStore,
    workspace: PathBuf,
    identity: WorkerIdentity,
}

impl ComputeRunner {
    #[must_use]
    pub fn new(
        store: ComputeJobStore,
        workspace: impl Into<PathBuf>,
        identity: WorkerIdentity,
    ) -> Self {
        Self {
            store,
            workspace: workspace.into(),
            identity,
        }
    }

    // Keeping process startup, output draining, cancellation, and terminal
    // manifest emission together makes the job lifecycle auditable.
    #[allow(clippy::too_many_lines)]
    pub fn run(
        &self,
        request: &ComputeJobRequest,
        cancelled: &AtomicBool,
        mut on_event: impl FnMut(&ComputeJobEvent),
    ) -> Result<ComputeResultManifest, ComputeRunnerError> {
        Self::validate(request)?;
        let job_id = request.job_id;
        emit(
            &self.store,
            job_id,
            ComputeJobEventPayload::Status {
                status: ComputeJobStatus::Preparing,
                message: Some("preparing isolated job execution".to_string()),
            },
            &mut on_event,
        )?;
        let started_at = now_unix_ms();
        emit(
            &self.store,
            job_id,
            ComputeJobEventPayload::Status {
                status: ComputeJobStatus::Running,
                message: Some("worker process started".to_string()),
            },
            &mut on_event,
        )?;

        let working_directory = self.resolve_working_directory(request)?;
        let (program, args) = Self::command_line(request, &working_directory)?;
        let mut command = runtime::hidden_command(&program);
        command
            .args(&args)
            .current_dir(&working_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (name, value) in &request.environment {
            command.env(name, value);
        }
        let mut child = command.spawn()?;
        let pid = child.id();
        let _process_guard = runtime::register_managed_process(
            pid,
            format!("compute job {job_id}"),
            runtime::ManagedProcessKind::Foreground,
        );
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ComputeRunnerError::InvalidRequest("stdout pipe unavailable".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ComputeRunnerError::InvalidRequest("stderr pipe unavailable".into()))?;
        let (sender, receiver) = mpsc::channel();
        let stdout_reader = stream_reader(stdout, ComputeLogStream::Stdout, sender.clone());
        let stderr_reader = stream_reader(stderr, ComputeLogStream::Stderr, sender);
        let started = Instant::now();
        let timeout = Duration::from_secs(request.limits.timeout_secs.max(1));
        let output_limit = request.limits.max_output_bytes.unwrap_or(u64::MAX);
        let mut stdout_bytes = 0_u64;
        let mut stderr_bytes = 0_u64;
        let mut terminal_status = None;
        let mut terminal_error = None;
        let exit_code;

        loop {
            while let Ok(chunk) = receiver.try_recv() {
                let total = stdout_bytes
                    .saturating_add(stderr_bytes)
                    .saturating_add(chunk.bytes.len().try_into().unwrap_or(u64::MAX));
                if total > output_limit {
                    terminal_status = Some(ComputeJobStatus::Failed);
                    terminal_error = Some(format!(
                        "combined stdout/stderr exceeded the {output_limit} byte limit"
                    ));
                    runtime::terminate_managed_process_tree(pid);
                    break;
                }
                let offset = self.store.append_log(job_id, chunk.stream, &chunk.bytes)?;
                match chunk.stream {
                    ComputeLogStream::Stdout => {
                        stdout_bytes = stdout_bytes
                            .saturating_add(chunk.bytes.len().try_into().unwrap_or(u64::MAX));
                    }
                    ComputeLogStream::Stderr => {
                        stderr_bytes = stderr_bytes
                            .saturating_add(chunk.bytes.len().try_into().unwrap_or(u64::MAX));
                    }
                    ComputeLogStream::System => {}
                }
                emit(
                    &self.store,
                    job_id,
                    ComputeJobEventPayload::Log {
                        stream: chunk.stream,
                        text: String::from_utf8_lossy(&chunk.bytes).into_owned(),
                        offset,
                    },
                    &mut on_event,
                )?;
            }
            if terminal_status.is_some() {
                let status = child.wait()?;
                exit_code = status.code();
                break;
            }
            if let Some(status) = child.try_wait()? {
                exit_code = status.code();
                terminal_status = Some(if status.success() {
                    ComputeJobStatus::Succeeded
                } else {
                    ComputeJobStatus::Failed
                });
                if !status.success() {
                    terminal_error = Some(format!("process exited with status {status}"));
                }
                break;
            }
            if cancelled.load(Ordering::SeqCst) {
                terminal_status = Some(ComputeJobStatus::Cancelled);
                terminal_error = Some("cancelled by coordinator".to_string());
                runtime::terminate_managed_process_tree(pid);
                let status = child.wait()?;
                exit_code = status.code();
                break;
            }
            if started.elapsed() >= timeout {
                terminal_status = Some(ComputeJobStatus::TimedOut);
                terminal_error = Some(format!(
                    "execution exceeded the {} second timeout",
                    request.limits.timeout_secs
                ));
                runtime::terminate_managed_process_tree(pid);
                let status = child.wait()?;
                exit_code = status.code();
                break;
            }
            thread::sleep(Duration::from_millis(40));
        }

        let _ = stdout_reader.join();
        let _ = stderr_reader.join();
        while let Ok(chunk) = receiver.try_recv() {
            let total = stdout_bytes
                .saturating_add(stderr_bytes)
                .saturating_add(chunk.bytes.len().try_into().unwrap_or(u64::MAX));
            if total <= output_limit {
                let offset = self.store.append_log(job_id, chunk.stream, &chunk.bytes)?;
                match chunk.stream {
                    ComputeLogStream::Stdout => {
                        stdout_bytes = stdout_bytes
                            .saturating_add(chunk.bytes.len().try_into().unwrap_or(u64::MAX));
                    }
                    ComputeLogStream::Stderr => {
                        stderr_bytes = stderr_bytes
                            .saturating_add(chunk.bytes.len().try_into().unwrap_or(u64::MAX));
                    }
                    ComputeLogStream::System => {}
                }
                emit(
                    &self.store,
                    job_id,
                    ComputeJobEventPayload::Log {
                        stream: chunk.stream,
                        text: String::from_utf8_lossy(&chunk.bytes).into_owned(),
                        offset,
                    },
                    &mut on_event,
                )?;
            }
        }

        let status = terminal_status.unwrap_or(ComputeJobStatus::Failed);
        let artifacts = self.collect_artifacts(request, &working_directory, &mut on_event)?;
        let finished_at = now_unix_ms();
        let result = ComputeResultManifest {
            job_id,
            status,
            exit_code,
            started_at_unix_ms: Some(started_at),
            finished_at_unix_ms: finished_at,
            duration_ms: Some(duration_ms(started.elapsed())),
            stdout_bytes,
            stderr_bytes,
            artifacts,
            metrics: BTreeMap::<String, Value>::new(),
            error: terminal_error,
            worker_device_id: self.identity.device_id,
            worker_name: self.identity.display_name.clone(),
            environment_fingerprint: self.identity.environment_fingerprint.clone(),
        };
        emit(
            &self.store,
            job_id,
            ComputeJobEventPayload::Completed {
                result: result.clone(),
            },
            &mut on_event,
        )?;
        Ok(result)
    }

    fn validate(request: &ComputeJobRequest) -> Result<(), ComputeRunnerError> {
        if !request.protocol_version.is_supported() {
            return Err(ComputeRunnerError::InvalidRequest(
                "unsupported protocol version".to_string(),
            ));
        }
        if request.display_name.trim().is_empty() {
            return Err(ComputeRunnerError::InvalidRequest(
                "display name is empty".to_string(),
            ));
        }
        validate_relative_path(&request.working_directory)?;
        for name in request.environment.keys() {
            if name.is_empty()
                || name.contains('=')
                || name.contains('\0')
                || name.chars().any(char::is_whitespace)
            {
                return Err(ComputeRunnerError::InvalidRequest(format!(
                    "invalid environment variable name: {name}"
                )));
            }
        }
        match &request.workload {
            ComputeWorkload::Command { executable, .. } if executable.trim().is_empty() => Err(
                ComputeRunnerError::InvalidRequest("command executable is empty".to_string()),
            ),
            ComputeWorkload::Python { entrypoint, .. } => {
                validate_relative_path(entrypoint)?;
                if entrypoint.trim().is_empty() {
                    Err(ComputeRunnerError::InvalidRequest(
                        "Python entrypoint is empty".to_string(),
                    ))
                } else {
                    Ok(())
                }
            }
            ComputeWorkload::Notebook { notebook_path, .. } => {
                validate_relative_path(notebook_path)?;
                Err(ComputeRunnerError::NotebookAdapterRequired)
            }
            ComputeWorkload::Command { .. } => Ok(()),
        }
    }

    fn resolve_working_directory(
        &self,
        request: &ComputeJobRequest,
    ) -> Result<PathBuf, ComputeRunnerError> {
        let path = if request.working_directory.is_empty() {
            self.workspace.clone()
        } else {
            self.workspace.join(&request.working_directory)
        };
        if !path.is_dir() {
            return Err(ComputeRunnerError::InvalidRequest(format!(
                "working directory does not exist: {}",
                request.working_directory
            )));
        }
        Ok(path)
    }

    fn command_line(
        request: &ComputeJobRequest,
        working_directory: &Path,
    ) -> Result<(String, Vec<String>), ComputeRunnerError> {
        match &request.workload {
            ComputeWorkload::Command { executable, args } => Ok((executable.clone(), args.clone())),
            ComputeWorkload::Python {
                entrypoint,
                args,
                interpreter,
            } => {
                let entrypoint_path = working_directory.join(entrypoint);
                if !entrypoint_path.is_file() {
                    return Err(ComputeRunnerError::InvalidRequest(format!(
                        "Python entrypoint does not exist: {entrypoint}"
                    )));
                }
                let mut command_args = vec![entrypoint.clone()];
                command_args.extend(args.iter().cloned());
                Ok((
                    interpreter
                        .clone()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| {
                            if cfg!(windows) {
                                "python".to_string()
                            } else {
                                "python3".to_string()
                            }
                        }),
                    command_args,
                ))
            }
            ComputeWorkload::Notebook { .. } => Err(ComputeRunnerError::NotebookAdapterRequired),
        }
    }

    fn collect_artifacts(
        &self,
        request: &ComputeJobRequest,
        working_directory: &Path,
        on_event: &mut impl FnMut(&ComputeJobEvent),
    ) -> Result<Vec<ComputeArtifact>, ComputeRunnerError> {
        if request.artifact_globs.is_empty() {
            return Ok(Vec::new());
        }
        let patterns = request
            .artifact_globs
            .iter()
            .map(|value| {
                Pattern::new(value).map_err(|error| {
                    ComputeRunnerError::InvalidRequest(format!(
                        "invalid artifact glob {value:?}: {error}"
                    ))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let destination_root = self.store.artifacts_dir(request.job_id);
        fs::create_dir_all(&destination_root)?;
        let artifact_limit = request.limits.max_artifact_bytes.unwrap_or(u64::MAX);
        let mut total = 0_u64;
        let mut artifacts = Vec::new();
        for entry in WalkDir::new(working_directory)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
        {
            let relative = entry
                .path()
                .strip_prefix(working_directory)
                .map_err(|error| ComputeRunnerError::InvalidRequest(error.to_string()))?;
            let wire_path = relative.to_string_lossy().replace('\\', "/");
            if !patterns.iter().any(|pattern| pattern.matches(&wire_path)) {
                continue;
            }
            let size = fs::metadata(entry.path())?.len();
            total = total.saturating_add(size);
            if total > artifact_limit {
                return Err(ComputeRunnerError::InvalidRequest(format!(
                    "artifacts exceeded the {artifact_limit} byte limit"
                )));
            }
            let destination = destination_root.join(relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &destination)?;
            let artifact = ComputeArtifact {
                path: wire_path,
                size_bytes: size,
                sha256: sha256_file(&destination)?,
                media_type: media_type_for(&destination),
            };
            emit(
                &self.store,
                request.job_id,
                ComputeJobEventPayload::Artifact {
                    artifact: artifact.clone(),
                },
                on_event,
            )?;
            artifacts.push(artifact);
        }
        Ok(artifacts)
    }
}

struct StreamChunk {
    stream: ComputeLogStream,
    bytes: Vec<u8>,
}

fn stream_reader(
    mut reader: impl Read + Send + 'static,
    stream: ComputeLogStream,
    sender: mpsc::Sender<StreamChunk>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    if sender
                        .send(StreamChunk {
                            stream,
                            bytes: buffer[..size].to_vec(),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    })
}

fn emit(
    store: &ComputeJobStore,
    job_id: remote_protocol::ComputeJobId,
    payload: ComputeJobEventPayload,
    on_event: &mut impl FnMut(&ComputeJobEvent),
) -> Result<(), ComputeStoreError> {
    let event = store.append(job_id, payload)?;
    on_event(&event);
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<(), ComputeRunnerError> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(ComputeRunnerError::InvalidRequest(format!(
            "path must stay inside the project: {value}"
        )));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, std::io::Error> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    loop {
        let size = file.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn media_type_for(path: &Path) -> Option<String> {
    let value = match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "csv" => "text/csv",
        "json" => "application/json",
        "log" | "md" | "txt" => "text/plain",
        "html" => "text/html",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "pdf" => "application/pdf",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    Some(value.to_string())
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ComputeTarget;
    use remote_protocol::ComputeResourceLimits;

    fn echo_request() -> ComputeJobRequest {
        let workload = if cfg!(windows) {
            ComputeWorkload::Command {
                executable: "cmd".to_string(),
                args: vec!["/C".to_string(), "echo hello".to_string()],
            }
        } else {
            ComputeWorkload::Command {
                executable: "sh".to_string(),
                args: vec!["-c".to_string(), "printf hello".to_string()],
            }
        };
        ComputeJobRequest::new("project", "echo", workload)
    }

    #[test]
    fn runs_command_and_persists_result() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).expect("workspace");
        let store = ComputeJobStore::new(temp.path().join("compute"));
        let request = echo_request();
        store
            .create(request.clone(), ComputeTarget::Local)
            .expect("create");
        let runner = ComputeRunner::new(store.clone(), &workspace, WorkerIdentity::default());
        let result = runner
            .run(&request, &AtomicBool::new(false), |_| {})
            .expect("run");
        assert_eq!(result.status, ComputeJobStatus::Succeeded);
        assert!(result.stdout_bytes > 0);
        assert_eq!(
            store.get(request.job_id).expect("record").status,
            ComputeJobStatus::Succeeded
        );
    }

    #[test]
    fn rejects_project_escape() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = ComputeJobStore::new(temp.path().join("compute"));
        let mut request = echo_request();
        request.working_directory = "../outside".to_string();
        store
            .create(request.clone(), ComputeTarget::Local)
            .expect("create");
        let runner = ComputeRunner::new(store, temp.path(), WorkerIdentity::default());
        let error = runner
            .run(&request, &AtomicBool::new(false), |_| {})
            .expect_err("reject");
        assert!(error.to_string().contains("inside the project"));
    }

    #[test]
    fn times_out_long_process() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = ComputeJobStore::new(temp.path().join("compute"));
        let workload = if cfg!(windows) {
            ComputeWorkload::Command {
                executable: "cmd".to_string(),
                args: vec!["/C".to_string(), "ping 127.0.0.1 -n 10 >NUL".to_string()],
            }
        } else {
            ComputeWorkload::Command {
                executable: "sh".to_string(),
                args: vec!["-c".to_string(), "sleep 10".to_string()],
            }
        };
        let mut request = ComputeJobRequest::new("project", "timeout", workload);
        request.limits = ComputeResourceLimits {
            timeout_secs: 1,
            ..ComputeResourceLimits::default()
        };
        store
            .create(request.clone(), ComputeTarget::Local)
            .expect("create");
        let runner = ComputeRunner::new(store, temp.path(), WorkerIdentity::default());
        let result = runner
            .run(&request, &AtomicBool::new(false), |_| {})
            .expect("run");
        assert_eq!(result.status, ComputeJobStatus::TimedOut);
    }
}
