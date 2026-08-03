use remote_protocol::{
    ComputeJobEvent, ComputeJobEventPayload, ComputeJobId, ComputeJobRequest, ComputeJobStatus,
    ComputeResultManifest, ProtocolVersion, CURRENT_PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

const JOBS_DIR: &str = "jobs";
const JOB_FILE: &str = "job.json";
const EVENTS_FILE: &str = "events.jsonl";
const STDOUT_FILE: &str = "stdout.log";
const STDERR_FILE: &str = "stderr.log";
const ARTIFACTS_DIR: &str = "artifacts";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComputeTarget {
    #[default]
    Local,
    Remote {
        node_id: String,
        node_name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeJobRecord {
    pub protocol_version: ProtocolVersion,
    pub request: ComputeJobRequest,
    pub target: ComputeTarget,
    pub status: ComputeJobStatus,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
    pub started_at_unix_ms: Option<i64>,
    pub finished_at_unix_ms: Option<i64>,
    pub last_sequence: u64,
    pub result: Option<ComputeResultManifest>,
}

#[derive(Debug, Error)]
pub enum ComputeStoreError {
    #[error("compute store I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("compute store JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("compute job {0} was not found")]
    NotFound(ComputeJobId),
    #[error("compute store lock was poisoned")]
    Poisoned,
}

#[derive(Debug, Clone)]
pub struct ComputeJobStore {
    root: PathBuf,
    mutation_lock: Arc<Mutex<()>>,
}

impl ComputeJobStore {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            mutation_lock: Arc::new(Mutex::new(())),
        }
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn create(
        &self,
        request: ComputeJobRequest,
        target: ComputeTarget,
    ) -> Result<ComputeJobRecord, ComputeStoreError> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| ComputeStoreError::Poisoned)?;
        let now = now_unix_ms();
        let record = ComputeJobRecord {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            request,
            target,
            status: ComputeJobStatus::Queued,
            created_at_unix_ms: now,
            updated_at_unix_ms: now,
            started_at_unix_ms: None,
            finished_at_unix_ms: None,
            last_sequence: 0,
            result: None,
        };
        let dir = self.job_dir(record.request.job_id);
        fs::create_dir_all(dir.join(ARTIFACTS_DIR))?;
        write_json(&dir.join(JOB_FILE), &record)?;
        Ok(record)
    }

    pub fn get(&self, job_id: ComputeJobId) -> Result<ComputeJobRecord, ComputeStoreError> {
        let path = self.job_dir(job_id).join(JOB_FILE);
        if !path.exists() {
            return Err(ComputeStoreError::NotFound(job_id));
        }
        let body = fs::read(path)?;
        serde_json::from_slice(&body).map_err(Into::into)
    }

    pub fn list(&self) -> Result<Vec<ComputeJobRecord>, ComputeStoreError> {
        let jobs_root = self.root.join(JOBS_DIR);
        if !jobs_root.exists() {
            return Ok(Vec::new());
        }
        let mut records = fs::read_dir(jobs_root)?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter_map(|entry| fs::read(entry.path().join(JOB_FILE)).ok())
            .filter_map(|body| serde_json::from_slice::<ComputeJobRecord>(&body).ok())
            .collect::<Vec<_>>();
        records.sort_by_key(|record| std::cmp::Reverse(record.created_at_unix_ms));
        Ok(records)
    }

    pub fn append(
        &self,
        job_id: ComputeJobId,
        payload: ComputeJobEventPayload,
    ) -> Result<ComputeJobEvent, ComputeStoreError> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| ComputeStoreError::Poisoned)?;
        let mut record = self.get(job_id)?;
        let now = now_unix_ms();
        record.last_sequence = record.last_sequence.saturating_add(1);
        record.updated_at_unix_ms = now;
        apply_event_to_record(&mut record, &payload, now);
        let event = ComputeJobEvent {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            job_id,
            sequence: record.last_sequence,
            emitted_at_unix_ms: now,
            payload,
        };
        let event_path = self.job_dir(job_id).join(EVENTS_FILE);
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(event_path)?;
        serde_json::to_writer(&mut file, &event)?;
        file.write_all(b"\n")?;
        file.flush()?;
        write_json(&self.job_dir(job_id).join(JOB_FILE), &record)?;
        Ok(event)
    }

    pub fn events_after(
        &self,
        job_id: ComputeJobId,
        after_sequence: u64,
    ) -> Result<Vec<ComputeJobEvent>, ComputeStoreError> {
        let path = self.job_dir(job_id).join(EVENTS_FILE);
        if !path.exists() {
            self.get(job_id)?;
            return Ok(Vec::new());
        }
        let file = fs::File::open(path)?;
        let mut events = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            let event: ComputeJobEvent = serde_json::from_str(&line)?;
            if event.sequence > after_sequence {
                events.push(event);
            }
        }
        Ok(events)
    }

    pub fn append_log(
        &self,
        job_id: ComputeJobId,
        stream: remote_protocol::ComputeLogStream,
        bytes: &[u8],
    ) -> Result<u64, ComputeStoreError> {
        let filename = match stream {
            remote_protocol::ComputeLogStream::Stdout => STDOUT_FILE,
            remote_protocol::ComputeLogStream::Stderr => STDERR_FILE,
            remote_protocol::ComputeLogStream::System => EVENTS_FILE,
        };
        let path = self.job_dir(job_id).join(filename);
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        let offset = file.metadata()?.len();
        file.write_all(bytes)?;
        file.flush()?;
        Ok(offset)
    }

    pub fn read_log(
        &self,
        job_id: ComputeJobId,
        stream: remote_protocol::ComputeLogStream,
        offset: u64,
        max_bytes: usize,
    ) -> Result<Vec<u8>, ComputeStoreError> {
        use std::io::{Read, Seek, SeekFrom};

        let filename = match stream {
            remote_protocol::ComputeLogStream::Stdout => STDOUT_FILE,
            remote_protocol::ComputeLogStream::Stderr => STDERR_FILE,
            remote_protocol::ComputeLogStream::System => EVENTS_FILE,
        };
        let path = self.job_dir(job_id).join(filename);
        if !path.exists() {
            self.get(job_id)?;
            return Ok(Vec::new());
        }
        let mut file = fs::File::open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut output = Vec::new();
        file.take(max_bytes.try_into().unwrap_or(u64::MAX))
            .read_to_end(&mut output)?;
        Ok(output)
    }

    #[must_use]
    pub fn artifacts_dir(&self, job_id: ComputeJobId) -> PathBuf {
        self.job_dir(job_id).join(ARTIFACTS_DIR)
    }

    pub fn recover_interrupted(&self) -> Result<Vec<ComputeJobRecord>, ComputeStoreError> {
        let mut recovered = Vec::new();
        for record in self.list()? {
            if matches!(record.target, ComputeTarget::Local)
                && matches!(
                    record.status,
                    ComputeJobStatus::Preparing | ComputeJobStatus::Running
                )
            {
                self.append(
                    record.request.job_id,
                    ComputeJobEventPayload::Status {
                        status: ComputeJobStatus::Lost,
                        message: Some("worker restarted before the process completed".to_string()),
                    },
                )?;
                recovered.push(self.get(record.request.job_id)?);
            }
        }
        Ok(recovered)
    }

    fn job_dir(&self, job_id: ComputeJobId) -> PathBuf {
        self.root.join(JOBS_DIR).join(job_id.to_string())
    }
}

fn apply_event_to_record(
    record: &mut ComputeJobRecord,
    payload: &ComputeJobEventPayload,
    now: i64,
) {
    match payload {
        ComputeJobEventPayload::Status { status, .. } => {
            record.status = *status;
            if matches!(status, ComputeJobStatus::Running) && record.started_at_unix_ms.is_none() {
                record.started_at_unix_ms = Some(now);
            }
            if status.is_terminal() {
                record.finished_at_unix_ms = Some(now);
            }
        }
        ComputeJobEventPayload::Completed { result } => {
            record.status = result.status;
            record.started_at_unix_ms = result.started_at_unix_ms;
            record.finished_at_unix_ms = Some(result.finished_at_unix_ms);
            record.result = Some(result.clone());
        }
        ComputeJobEventPayload::Log { .. }
        | ComputeJobEventPayload::Metric { .. }
        | ComputeJobEventPayload::Artifact { .. } => {}
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), ComputeStoreError> {
    let bytes = serde_json::to_vec_pretty(value)?;
    runtime::write_file_atomically(path, bytes)?;
    Ok(())
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use remote_protocol::{ComputeLogStream, ComputeWorkload};

    #[test]
    fn persists_jobs_events_and_logs() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = ComputeJobStore::new(temp.path());
        let request = ComputeJobRequest::new(
            "p",
            "echo",
            ComputeWorkload::Command {
                executable: "echo".to_string(),
                args: vec!["hello".to_string()],
            },
        );
        let job_id = request.job_id;
        store.create(request, ComputeTarget::Local).expect("create");
        store
            .append(
                job_id,
                ComputeJobEventPayload::Status {
                    status: ComputeJobStatus::Running,
                    message: None,
                },
            )
            .expect("status");
        let offset = store
            .append_log(job_id, ComputeLogStream::Stdout, b"hello")
            .expect("log");
        assert_eq!(offset, 0);
        assert_eq!(
            store
                .read_log(job_id, ComputeLogStream::Stdout, 0, 10)
                .expect("read"),
            b"hello"
        );
        assert_eq!(store.events_after(job_id, 0).expect("events").len(), 1);
        assert_eq!(
            store.list().expect("list")[0].status,
            ComputeJobStatus::Running
        );
    }

    #[test]
    fn recovers_interrupted_jobs_as_lost() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = ComputeJobStore::new(temp.path());
        let request = ComputeJobRequest::new(
            "p",
            "job",
            ComputeWorkload::Command {
                executable: "echo".to_string(),
                args: Vec::new(),
            },
        );
        let job_id = request.job_id;
        store.create(request, ComputeTarget::Local).expect("create");
        store
            .append(
                job_id,
                ComputeJobEventPayload::Status {
                    status: ComputeJobStatus::Running,
                    message: None,
                },
            )
            .expect("running");
        assert_eq!(store.recover_interrupted().expect("recover").len(), 1);
        assert_eq!(
            store.get(job_id).expect("job").status,
            ComputeJobStatus::Lost
        );
    }
}
