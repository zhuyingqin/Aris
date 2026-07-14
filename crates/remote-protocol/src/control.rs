use crate::{ProtocolVersion, RequestId, CURRENT_PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_CURSOR_BYTES: usize = 512;
const MAX_CHAT_MESSAGE_BYTES: usize = 16 * 1024;
/// A paired phone can render a useful full conversation picker without asking
/// the desktop to serialize an unbounded local session index.
const MAX_CHAT_SESSION_LIST_LIMIT: u16 = 200;
/// Transcript bodies are separately byte-bounded by the desktop adapter. This
/// count limit prevents one request from forcing it to inspect an arbitrary
/// number of stored turns.
const MAX_CHAT_TRANSCRIPT_LIMIT: u16 = 100;
const MAX_STOP_REASON_BYTES: usize = 1_024;
const MAX_TIMELINE_LIMIT: u16 = 200;

/// Explicit permission granted to a paired mobile device. The protocol has no
/// direct API for arbitrary terminal commands, file-system access, secrets, or
/// model-provider configuration. A chat message is instead executed inside a
/// selected desktop-owned conversation and remains subject to that session's
/// local tool and permission policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[repr(u8)]
#[serde(rename_all = "snake_case")]
pub enum DeviceScope {
    ReadProjectState = 1,
    ReadTaskTimeline = 2,
    SendChatMessages = 3,
    StopRuns = 4,
    ReadReviewConclusions = 5,
}

impl DeviceScope {
    pub(crate) const fn wire_code(self) -> u8 {
        self as u8
    }
}

/// Deterministic, duplicate-free set of [`DeviceScope`] values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(transparent)]
pub struct DeviceScopes(BTreeSet<DeviceScope>);

impl DeviceScopes {
    /// Returns an empty scope set. Pairing starts least-privileged by default.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns whether this set grants a particular operation.
    #[must_use]
    pub fn contains(&self, scope: DeviceScope) -> bool {
        self.0.contains(&scope)
    }

    /// Returns whether every scope in `other` is granted by this set.
    #[must_use]
    pub fn is_superset_of(&self, other: &Self) -> bool {
        self.0.is_superset(&other.0)
    }

    /// Returns whether this set is no more permissive than `other`.
    #[must_use]
    pub fn is_subset_of(&self, other: &Self) -> bool {
        self.0.is_subset(&other.0)
    }

    /// Returns scopes in stable wire order.
    pub fn iter(&self) -> impl Iterator<Item = DeviceScope> + '_ {
        self.0.iter().copied()
    }

    /// Number of granted scopes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Returns whether no permissions have been granted.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl<const LENGTH: usize> From<[DeviceScope; LENGTH]> for DeviceScopes {
    fn from(scopes: [DeviceScope; LENGTH]) -> Self {
        Self(scopes.into_iter().collect())
    }
}

impl FromIterator<DeviceScope> for DeviceScopes {
    fn from_iter<T: IntoIterator<Item = DeviceScope>>(iter: T) -> Self {
        Self(iter.into_iter().collect())
    }
}

/// Constrained remote actions supported by P1. Adding an action requires a new
/// enum variant, scope mapping, validation rule, and desktop-side handler.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlCommand {
    GetWorkspaceOverview,
    /// Switch the desktop's active workspace to one of its already registered
    /// projects. This never accepts a local path or creates a project.
    SetActiveProject {
        project_id: String,
    },
    GetProjectSummary {
        project_id: String,
    },
    GetTaskTimeline {
        project_id: String,
        after_event_id: Option<String>,
        limit: u16,
    },
    /// List desktop chat sessions for one project. This is deliberately under
    /// the explicit chat grant: titles are conversation-derived content.
    ListChatSessions {
        project_id: String,
        limit: u16,
    },
    /// Read the plaintext user/assistant projection of one desktop chat.
    /// Tool inputs, tool results, reasoning, attachments, and permissions are
    /// intentionally absent from this remote protocol surface.
    GetChatTranscript {
        project_id: String,
        session_id: String,
        limit: u16,
    },
    /// Read the verified model choices available to one desktop-owned chat.
    /// Provider credentials and configuration are intentionally absent.
    GetChatModelOptions {
        project_id: String,
        session_id: String,
    },
    /// Persist a verified model selection on one desktop-owned chat. This is
    /// a per-conversation override, not a mutation of the desktop default.
    SetChatSessionModel {
        project_id: String,
        session_id: String,
        model: String,
    },
    SendChatMessage {
        project_id: String,
        /// The selected desktop-owned chat session, never a new session
        /// created by a phone request.
        session_id: String,
        message: String,
        idempotency_key: String,
    },
    StopRun {
        run_id: String,
        reason: Option<String>,
    },
    GetReviewConclusion {
        project_id: String,
        review_id: Option<String>,
    },
}

impl ControlCommand {
    /// Returns the exact permission required to execute this command.
    #[must_use]
    pub const fn required_scope(&self) -> DeviceScope {
        match self {
            Self::GetWorkspaceOverview | Self::GetProjectSummary { .. } => {
                DeviceScope::ReadProjectState
            }
            Self::GetTaskTimeline { .. } => DeviceScope::ReadTaskTimeline,
            Self::SetActiveProject { .. }
            | Self::ListChatSessions { .. }
            | Self::GetChatTranscript { .. }
            | Self::GetChatModelOptions { .. }
            | Self::SetChatSessionModel { .. }
            | Self::SendChatMessage { .. } => DeviceScope::SendChatMessages,
            Self::StopRun { .. } => DeviceScope::StopRuns,
            Self::GetReviewConclusion { .. } => DeviceScope::ReadReviewConclusions,
        }
    }

    /// Validates bounded local-first request fields before a desktop agent acts.
    pub fn validate(&self) -> Result<(), ControlValidationError> {
        match self {
            Self::GetWorkspaceOverview => Ok(()),
            Self::SetActiveProject { project_id } => validate_identifier("project_id", project_id),
            Self::GetProjectSummary { project_id } => validate_identifier("project_id", project_id),
            Self::GetTaskTimeline {
                project_id,
                after_event_id,
                limit,
            } => {
                validate_identifier("project_id", project_id)?;
                if let Some(after_event_id) = after_event_id {
                    validate_bounded_text(
                        "after_event_id",
                        after_event_id,
                        MAX_CURSOR_BYTES,
                        false,
                    )?;
                }
                if *limit == 0 || *limit > MAX_TIMELINE_LIMIT {
                    return Err(ControlValidationError::InvalidTimelineLimit {
                        maximum: MAX_TIMELINE_LIMIT,
                    });
                }
                Ok(())
            }
            Self::ListChatSessions { project_id, limit } => {
                validate_identifier("project_id", project_id)?;
                validate_chat_limit("chat session list", *limit, MAX_CHAT_SESSION_LIST_LIMIT)
            }
            Self::GetChatTranscript {
                project_id,
                session_id,
                limit,
            } => {
                validate_identifier("project_id", project_id)?;
                validate_identifier("session_id", session_id)?;
                validate_chat_limit("chat transcript", *limit, MAX_CHAT_TRANSCRIPT_LIMIT)
            }
            Self::GetChatModelOptions {
                project_id,
                session_id,
            } => {
                validate_identifier("project_id", project_id)?;
                validate_identifier("session_id", session_id)
            }
            Self::SetChatSessionModel {
                project_id,
                session_id,
                model,
            } => {
                validate_identifier("project_id", project_id)?;
                validate_identifier("session_id", session_id)?;
                validate_identifier("model", model)
            }
            Self::SendChatMessage {
                project_id,
                session_id,
                message,
                idempotency_key,
            } => {
                validate_identifier("project_id", project_id)?;
                validate_identifier("session_id", session_id)?;
                validate_bounded_text("message", message, MAX_CHAT_MESSAGE_BYTES, true)?;
                validate_identifier("idempotency_key", idempotency_key)
            }
            Self::StopRun { run_id, reason } => {
                validate_identifier("run_id", run_id)?;
                if let Some(reason) = reason {
                    validate_bounded_text("reason", reason, MAX_STOP_REASON_BYTES, false)?;
                }
                Ok(())
            }
            Self::GetReviewConclusion {
                project_id,
                review_id,
            } => {
                validate_identifier("project_id", project_id)?;
                if let Some(review_id) = review_id {
                    validate_identifier("review_id", review_id)?;
                }
                Ok(())
            }
        }
    }
}

/// Versioned request encrypted inside a [`SecureEnvelope`](crate::SecureEnvelope).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlRequest {
    pub protocol_version: ProtocolVersion,
    pub request_id: RequestId,
    pub issued_at_unix_ms: i64,
    pub command: ControlCommand,
}

impl ControlRequest {
    /// Creates a new request with a fresh correlation and idempotency ID.
    #[must_use]
    pub fn new(command: ControlCommand, issued_at_unix_ms: i64) -> Self {
        Self {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            request_id: RequestId::new(),
            issued_at_unix_ms,
            command,
        }
    }

    /// Validates protocol compatibility, bounded fields, and the requested
    /// paired-device permission.
    pub fn validate_for(&self, scopes: &DeviceScopes) -> Result<(), ControlValidationError> {
        if !self.protocol_version.is_supported() {
            return Err(ControlValidationError::UnsupportedProtocol {
                received: self.protocol_version,
            });
        }
        self.command.validate()?;
        let required_scope = self.command.required_scope();
        if !scopes.contains(required_scope) {
            return Err(ControlValidationError::MissingScope { required_scope });
        }
        Ok(())
    }
}

/// Versioned response correlated to a [`ControlRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlResponse {
    pub protocol_version: ProtocolVersion,
    pub request_id: RequestId,
    pub responded_at_unix_ms: i64,
    pub outcome: ControlResponseOutcome,
}

impl ControlResponse {
    /// Builds a successful response using the current protocol version.
    #[must_use]
    pub fn success(
        request_id: RequestId,
        responded_at_unix_ms: i64,
        result: ControlResult,
    ) -> Self {
        Self {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            request_id,
            responded_at_unix_ms,
            outcome: ControlResponseOutcome::Success { result },
        }
    }

    /// Builds an error response using the current protocol version.
    #[must_use]
    pub fn error(request_id: RequestId, responded_at_unix_ms: i64, error: ControlError) -> Self {
        Self {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            request_id,
            responded_at_unix_ms,
            outcome: ControlResponseOutcome::Error { error },
        }
    }
}

/// Either the requested data/action acknowledgement or a reviewable error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ControlResponseOutcome {
    Success { result: ControlResult },
    Error { error: ControlError },
}

/// An explicitly advertised optional command that a paired mobile client may
/// use after receiving it in [`ControlResult::WorkspaceOverview`].
///
/// Protocol version one is intentionally feature-extensible: a newer mobile
/// client must treat a missing capability list as an older desktop and keep
/// using only the command surface that was already available. This avoids
/// sending an unknown tagged command to a legacy desktop, which would make it
/// reject the encrypted control frame before it can return an error response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteCapability {
    /// The desktop accepts [`ControlCommand::SetActiveProject`].
    SetActiveProject,
    /// The desktop accepts [`ControlCommand::GetChatModelOptions`].
    GetChatModelOptions,
    /// The desktop accepts [`ControlCommand::SetChatSessionModel`].
    SetChatSessionModel,
}

/// Successful payloads for the reviewed P1 command surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlResult {
    WorkspaceOverview {
        projects: Vec<ProjectSummary>,
        /// Optional command support advertised by this desktop build. The
        /// default preserves deserialization of workspace responses from
        /// earlier P1 desktop builds which did not include this field.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        capabilities: Vec<RemoteCapability>,
    },
    ProjectSummary {
        project: ProjectSummary,
    },
    TaskTimeline {
        project_id: String,
        events: Vec<TimelineEvent>,
        next_event_id: Option<String>,
    },
    /// Summaries of conversations that currently exist in the selected
    /// desktop project. The desktop sets `has_more` if the request limit was
    /// reached, so the phone never has to infer completeness from an empty
    /// title or a transport-size failure.
    ChatSessions {
        project_id: String,
        sessions: Vec<ChatSessionSummary>,
        has_more: bool,
    },
    /// Plain-text transcript projection for one desktop-owned session.
    ChatTranscript {
        project_id: String,
        session_id: String,
        title: String,
        updated_at_unix_ms: i64,
        messages: Vec<ChatTranscriptMessage>,
        has_more: bool,
    },
    /// The per-session model currently used for future mobile turns and its
    /// verified choices. A model label is presentation metadata only.
    ChatModelOptions {
        project_id: String,
        session_id: String,
        model: Option<String>,
        options: Vec<ChatModelOption>,
    },
    /// Confirmation after a per-session model choice was persisted.
    ChatSessionModelUpdated {
        project_id: String,
        session_id: String,
        model: Option<String>,
        options: Vec<ChatModelOption>,
    },
    ChatMessageAccepted {
        project_id: String,
        message_id: String,
    },
    /// A bounded remote chat turn completed by the selected desktop session.
    ///
    /// `ChatMessageAccepted` remains available for asynchronous clients, but
    /// the initial P2 mobile surface uses this synchronous result so a paired
    /// phone can render the assistant's answer without a second event stream.
    ChatMessageCompleted {
        project_id: String,
        session_id: String,
        message_id: String,
        text: String,
    },
    RunStopAccepted {
        run_id: String,
    },
    ReviewConclusion {
        review: ReviewSummary,
    },
}

/// Compact project status safe to render on the mobile control surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectSummary {
    pub project_id: String,
    pub title: String,
    pub phase: String,
    pub updated_at_unix_ms: i64,
    pub active_run_id: Option<String>,
    /// The currently selected desktop workspace. This is explicit so mobile
    /// clients never infer it from registry order.
    pub is_active: bool,
}

/// One audit-friendly progress item from the desktop task timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimelineEvent {
    pub event_id: String,
    pub occurred_at_unix_ms: i64,
    pub kind: String,
    pub summary: String,
}

/// A desktop chat record safe to show in the paired phone's conversation
/// picker. The session ID is an opaque desktop-owned handle; it is validated
/// again before a transcript read or message send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatSessionSummary {
    pub session_id: String,
    pub title: String,
    pub updated_at_unix_ms: i64,
    /// The session-local override, if the user selected one. Clients may use
    /// the desktop's current model when this is absent.
    pub model: Option<String>,
}

/// Safe presentation data for an executor model that has already been
/// configured and verified on the desktop. No provider URL, key, or account
/// identifier is present here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatModelOption {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

/// One displayed chat message. This intentionally carries only visible user
/// or assistant text, not internal model reasoning or any tool data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatTranscriptMessage {
    pub role: ChatTranscriptRole,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatTranscriptRole {
    User,
    Assistant,
}

/// Independent Reviewer conclusion exposed to the constrained remote client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewSummary {
    pub project_id: String,
    pub review_id: String,
    pub disposition: ReviewDisposition,
    pub summary: String,
    pub reviewed_at_unix_ms: i64,
}

/// Reviewer state retained as a distinct result rather than being collapsed
/// into the Executor's status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDisposition {
    Approved,
    NeedsRevision,
    Inconclusive,
}

/// Stable, non-sensitive failure categories returned to a paired device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ControlError {
    Unauthorized { required_scope: DeviceScope },
    InvalidRequest { reason: String },
    NotFound,
    Conflict,
    TemporarilyUnavailable { retry_after_ms: Option<u64> },
    Internal,
}

/// Local validation error that a desktop agent can convert to
/// [`ControlError::InvalidRequest`] or [`ControlError::Unauthorized`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ControlValidationError {
    #[error("unsupported remote protocol version {received}")]
    UnsupportedProtocol { received: ProtocolVersion },
    #[error("the paired device lacks required scope {required_scope:?}")]
    MissingScope { required_scope: DeviceScope },
    #[error("{field} must be non-empty and no longer than {maximum} bytes")]
    InvalidIdentifier { field: &'static str, maximum: usize },
    #[error("{field} must be no longer than {maximum} bytes")]
    TextTooLong { field: &'static str, maximum: usize },
    #[error("{field} must not be blank")]
    BlankText { field: &'static str },
    #[error("timeline limit must be between one and {maximum}")]
    InvalidTimelineLimit { maximum: u16 },
    #[error("{field} limit must be between one and {maximum}")]
    InvalidChatLimit { field: &'static str, maximum: u16 },
}

fn validate_identifier(field: &'static str, value: &str) -> Result<(), ControlValidationError> {
    if value.trim().is_empty() || value.len() > MAX_IDENTIFIER_BYTES {
        return Err(ControlValidationError::InvalidIdentifier {
            field,
            maximum: MAX_IDENTIFIER_BYTES,
        });
    }
    Ok(())
}

fn validate_bounded_text(
    field: &'static str,
    value: &str,
    maximum: usize,
    must_not_be_blank: bool,
) -> Result<(), ControlValidationError> {
    if value.len() > maximum {
        return Err(ControlValidationError::TextTooLong { field, maximum });
    }
    if must_not_be_blank && value.trim().is_empty() {
        return Err(ControlValidationError::BlankText { field });
    }
    Ok(())
}

fn validate_chat_limit(
    field: &'static str,
    value: u16,
    maximum: u16,
) -> Result<(), ControlValidationError> {
    if value == 0 || value > maximum {
        return Err(ControlValidationError::InvalidChatLimit { field, maximum });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_scope_and_validation_are_enforced() {
        let request = ControlRequest::new(
            ControlCommand::SendChatMessage {
                project_id: "project-1".to_string(),
                session_id: "chat-1".to_string(),
                message: "Please summarize the reviewer conclusion.".to_string(),
                idempotency_key: "mobile-message-1".to_string(),
            },
            100,
        );
        let denied = request.validate_for(&DeviceScopes::from([DeviceScope::ReadProjectState]));
        assert!(matches!(
            denied,
            Err(ControlValidationError::MissingScope {
                required_scope: DeviceScope::SendChatMessages
            })
        ));
        request
            .validate_for(&DeviceScopes::from([DeviceScope::SendChatMessages]))
            .expect("granted scope should validate");
    }

    #[test]
    fn unsafe_or_unbounded_command_fields_are_rejected() {
        let command = ControlCommand::SendChatMessage {
            project_id: "project-1".to_string(),
            session_id: "chat-1".to_string(),
            message: "   ".to_string(),
            idempotency_key: "mobile-message-1".to_string(),
        };
        assert!(matches!(
            command.validate(),
            Err(ControlValidationError::BlankText { field: "message" })
        ));

        let timeline = ControlCommand::GetTaskTimeline {
            project_id: "project-1".to_string(),
            after_event_id: None,
            limit: MAX_TIMELINE_LIMIT + 1,
        };
        assert!(matches!(
            timeline.validate(),
            Err(ControlValidationError::InvalidTimelineLimit { .. })
        ));

        let transcript = ControlCommand::GetChatTranscript {
            project_id: "project-1".to_string(),
            session_id: "chat-1".to_string(),
            limit: MAX_CHAT_TRANSCRIPT_LIMIT + 1,
        };
        assert!(matches!(
            transcript.validate(),
            Err(ControlValidationError::InvalidChatLimit { .. })
        ));
    }

    #[test]
    fn scope_sets_are_deterministic_and_deduplicated() {
        let scopes = DeviceScopes::from([
            DeviceScope::StopRuns,
            DeviceScope::ReadProjectState,
            DeviceScope::StopRuns,
        ]);
        assert_eq!(scopes.len(), 2);
        assert_eq!(
            scopes.iter().collect::<Vec<_>>(),
            vec![DeviceScope::ReadProjectState, DeviceScope::StopRuns]
        );
    }

    #[test]
    fn workspace_overview_capabilities_are_optional_for_legacy_responses() {
        let legacy = serde_json::json!({
            "type": "workspace_overview",
            "projects": [],
        });
        let parsed: ControlResult =
            serde_json::from_value(legacy).expect("legacy workspace result should deserialize");
        assert_eq!(
            parsed,
            ControlResult::WorkspaceOverview {
                projects: Vec::new(),
                capabilities: Vec::new(),
            }
        );

        let current = ControlResult::WorkspaceOverview {
            projects: Vec::new(),
            capabilities: vec![
                RemoteCapability::SetActiveProject,
                RemoteCapability::GetChatModelOptions,
                RemoteCapability::SetChatSessionModel,
            ],
        };
        assert_eq!(
            serde_json::to_value(current).expect("workspace result should serialize")
                ["capabilities"],
            serde_json::json!([
                "set_active_project",
                "get_chat_model_options",
                "set_chat_session_model",
            ])
        );
    }
}
