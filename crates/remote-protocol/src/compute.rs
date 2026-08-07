use crate::{
    Base64UrlBytes, ComputeJobId, ControlRequest, ControlResponse, DeviceId, ProtocolVersion,
    CURRENT_PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const COMPUTE_MAX_LOG_CHUNK_BYTES: usize = 64 * 1024;
pub const COMPUTE_MAX_ARTIFACT_CHUNK_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputeJobStatus {
    Queued,
    Preparing,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    Lost,
}

impl ComputeJobStatus {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::TimedOut | Self::Lost
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputeLogStream {
    Stdout,
    Stderr,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeResourceLimits {
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    #[serde(default)]
    pub max_output_bytes: Option<u64>,
    #[serde(default)]
    pub max_artifact_bytes: Option<u64>,
}

impl Default for ComputeResourceLimits {
    fn default() -> Self {
        Self {
            timeout_secs: default_timeout_secs(),
            max_output_bytes: Some(64 * 1024 * 1024),
            max_artifact_bytes: Some(512 * 1024 * 1024),
        }
    }
}

const fn default_timeout_secs() -> u64 {
    30 * 60
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComputeWorkload {
    Command {
        executable: String,
        #[serde(default)]
        args: Vec<String>,
    },
    Python {
        entrypoint: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        interpreter: Option<String>,
    },
    Notebook {
        notebook_path: String,
        #[serde(default)]
        kernel: Option<String>,
        #[serde(default)]
        parameters: BTreeMap<String, Value>,
        #[serde(default = "default_true")]
        stop_on_error: bool,
    },
}

const fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeJobRequest {
    pub protocol_version: ProtocolVersion,
    pub job_id: ComputeJobId,
    pub project_id: String,
    pub display_name: String,
    pub workload: ComputeWorkload,
    #[serde(default)]
    pub working_directory: String,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub artifact_globs: Vec<String>,
    #[serde(default)]
    pub limits: ComputeResourceLimits,
    #[serde(default)]
    pub source_digest: Option<String>,
    #[serde(default)]
    pub input_bundle_digest: Option<String>,
}

impl ComputeJobRequest {
    #[must_use]
    pub fn new(
        project_id: impl Into<String>,
        display_name: impl Into<String>,
        workload: ComputeWorkload,
    ) -> Self {
        Self {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            job_id: ComputeJobId::new(),
            project_id: project_id.into(),
            display_name: display_name.into(),
            workload,
            working_directory: String::new(),
            environment: BTreeMap::new(),
            artifact_globs: Vec::new(),
            limits: ComputeResourceLimits::default(),
            source_digest: None,
            input_bundle_digest: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeArtifact {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
    #[serde(default)]
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeResultManifest {
    pub job_id: ComputeJobId,
    pub status: ComputeJobStatus,
    pub exit_code: Option<i32>,
    pub started_at_unix_ms: Option<i64>,
    pub finished_at_unix_ms: i64,
    pub duration_ms: Option<u64>,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub artifacts: Vec<ComputeArtifact>,
    #[serde(default)]
    pub metrics: BTreeMap<String, Value>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub worker_device_id: Option<DeviceId>,
    #[serde(default)]
    pub worker_name: Option<String>,
    #[serde(default)]
    pub environment_fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComputeJobEventPayload {
    Status {
        status: ComputeJobStatus,
        #[serde(default)]
        message: Option<String>,
    },
    Log {
        stream: ComputeLogStream,
        text: String,
        offset: u64,
    },
    Metric {
        name: String,
        value: Value,
    },
    Artifact {
        artifact: ComputeArtifact,
    },
    Completed {
        result: ComputeResultManifest,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeJobEvent {
    pub protocol_version: ProtocolVersion,
    pub job_id: ComputeJobId,
    pub sequence: u64,
    pub emitted_at_unix_ms: i64,
    pub payload: ComputeJobEventPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeNodeCapabilities {
    pub node_id: DeviceId,
    pub display_name: String,
    pub platform: String,
    pub architecture: String,
    pub logical_cpus: usize,
    pub supports_command: bool,
    pub supports_python: bool,
    pub supports_notebook: bool,
    pub max_parallel_jobs: usize,
    pub worker_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ComputeWireMessage {
    /// A constrained Agent request carried over the same encrypted
    /// computer-to-computer transport as compute jobs.
    ControlRequest {
        request: ControlRequest,
    },
    /// One correlated Agent progress or terminal response.
    ControlResponse {
        response: ControlResponse,
    },
    Capabilities {
        request_id: String,
    },
    CapabilitiesResult {
        request_id: String,
        capabilities: ComputeNodeCapabilities,
    },
    InputBundleStart {
        job_id: ComputeJobId,
        size_bytes: u64,
        sha256: String,
    },
    InputBundleChunk {
        job_id: ComputeJobId,
        offset: u64,
        data: Base64UrlBytes,
        eof: bool,
    },
    Submit {
        request: ComputeJobRequest,
    },
    Accepted {
        job_id: ComputeJobId,
    },
    Cancel {
        job_id: ComputeJobId,
    },
    Subscribe {
        job_id: ComputeJobId,
        after_sequence: u64,
    },
    Event {
        event: ComputeJobEvent,
    },
    ArtifactRead {
        job_id: ComputeJobId,
        path: String,
        offset: u64,
        max_bytes: u32,
    },
    ArtifactChunk {
        job_id: ComputeJobId,
        path: String,
        offset: u64,
        data: Base64UrlBytes,
        eof: bool,
        sha256: String,
    },
    Error {
        request_id: Option<String>,
        job_id: Option<ComputeJobId>,
        code: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_request_round_trips() {
        let request = ComputeJobRequest::new(
            "project-a",
            "train",
            ComputeWorkload::Python {
                entrypoint: "train.py".to_string(),
                args: vec!["--epochs".to_string(), "2".to_string()],
                interpreter: None,
            },
        );
        let encoded = serde_json::to_string(&request).expect("serialize");
        let decoded: ComputeJobRequest = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(decoded, request);
    }

    #[test]
    fn terminal_statuses_are_explicit() {
        assert!(!ComputeJobStatus::Running.is_terminal());
        assert!(ComputeJobStatus::Succeeded.is_terminal());
        assert!(ComputeJobStatus::TimedOut.is_terminal());
    }

    #[test]
    fn computer_transport_round_trips_agent_control_messages() {
        let message = ComputeWireMessage::ControlRequest {
            request: ControlRequest::new(crate::ControlCommand::GetWorkspaceOverview, 1_000),
        };
        let encoded = serde_json::to_string(&message).expect("serialize");
        let decoded: ComputeWireMessage = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(decoded, message);
    }

    #[test]
    fn wire_log_event_round_trips() {
        let job_id = ComputeJobId::new();
        let message = ComputeWireMessage::Event {
            event: ComputeJobEvent {
                protocol_version: CURRENT_PROTOCOL_VERSION,
                job_id,
                sequence: 4,
                emitted_at_unix_ms: 12,
                payload: ComputeJobEventPayload::Log {
                    stream: ComputeLogStream::Stdout,
                    text: "hello".to_string(),
                    offset: 0,
                },
            },
        };
        let value = serde_json::to_value(&message).expect("serialize");
        let decoded: ComputeWireMessage = serde_json::from_value(value).expect("deserialize");
        assert_eq!(decoded, message);
    }
}
