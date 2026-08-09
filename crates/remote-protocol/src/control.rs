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
const MAX_CHAT_EVENT_LIST_LIMIT: u16 = 200;
const MAX_CHAT_EVENT_WAIT_MILLIS: u32 = 25_000;
const MAX_STOP_REASON_BYTES: usize = 1_024;
/// An answer is one of the labels the desktop itself offered, so it needs far
/// less room than a free-form chat message. Keeping it small also keeps the
/// tool result the model finally sees close to what the user actually chose.
const MAX_CHAT_QUESTION_ANSWER_BYTES: usize = 2 * 1024;
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
    ComputeJobs = 6,
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
    /// Create an empty desktop-owned chat in the active project. The desktop
    /// chooses the opaque session id and persists both runtime and UI state.
    CreateChatSession {
        project_id: String,
    },
    /// Read the visible user/assistant projection of one desktop chat. Current
    /// clients also receive the same bounded thinking and tool cards rendered
    /// by Desktop; attachments and permission decisions remain desktop-only.
    GetChatTranscript {
        project_id: String,
        session_id: String,
        limit: u16,
    },
    /// Wait for visible changes to one selected desktop chat. `after_seq =
    /// None` returns the latest visible turn plus its current cursor so a turn
    /// completed while the phone loaded history cannot fall through the gap;
    /// subsequent calls use that cursor for lossless long polling.
    GetChatEvents {
        project_id: String,
        session_id: String,
        after_seq: Option<u64>,
        limit: u16,
        wait_ms: u32,
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
        /// The selected desktop-owned chat session.
        session_id: String,
        message: String,
        idempotency_key: String,
        /// Opt-in for correlated `accepted` and `delta` responses before the
        /// terminal completion. Missing means false for older mobile clients.
        #[serde(default)]
        stream: bool,
        /// Opt in to the ordered visible Desktop event stream (text, thinking,
        /// tool call/progress/result). It is sent only when the desktop first
        /// advertised [`RemoteCapability::RichChatProgress`].
        #[serde(default)]
        rich_stream: bool,
    },
    /// Stop one active message that this paired device started in a selected
    /// desktop-owned conversation. The opaque message id binds cancellation to
    /// the phone's own remote turn rather than an arbitrary local process.
    StopChatMessage {
        project_id: String,
        session_id: String,
        message_id: String,
    },
    /// Answer an `AskUserQuestion` tool call that is blocking a desktop turn.
    ///
    /// The tool announces itself through the ordinary visible event stream, so
    /// a phone can already see that a turn is waiting; without this command it
    /// could only watch it wait forever. `tool_use_id` binds the answer to the
    /// exact blocked call, and the desktop re-checks that the call belongs to
    /// `session_id` so a paired device cannot answer another conversation's
    /// question. The answer is one of the labels the desktop itself offered.
    AnswerChatQuestion {
        project_id: String,
        session_id: String,
        tool_use_id: String,
        answer: String,
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
            | Self::CreateChatSession { .. }
            | Self::GetChatTranscript { .. }
            | Self::GetChatEvents { .. }
            | Self::GetChatModelOptions { .. }
            | Self::SetChatSessionModel { .. }
            | Self::SendChatMessage { .. }
            | Self::StopChatMessage { .. }
            // Answering is strictly narrower than sending: the phone picks one
            // of the labels the desktop already offered, so it needs no
            // privilege beyond the chat grant it must already hold.
            | Self::AnswerChatQuestion { .. } => DeviceScope::SendChatMessages,
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
            Self::CreateChatSession { project_id } => validate_identifier("project_id", project_id),
            Self::GetChatTranscript {
                project_id,
                session_id,
                limit,
            } => {
                validate_identifier("project_id", project_id)?;
                validate_identifier("session_id", session_id)?;
                validate_chat_limit("chat transcript", *limit, MAX_CHAT_TRANSCRIPT_LIMIT)
            }
            Self::GetChatEvents {
                project_id,
                session_id,
                after_seq: _,
                limit,
                wait_ms,
            } => {
                validate_identifier("project_id", project_id)?;
                validate_identifier("session_id", session_id)?;
                validate_chat_limit("chat event list", *limit, MAX_CHAT_EVENT_LIST_LIMIT)?;
                if *wait_ms > MAX_CHAT_EVENT_WAIT_MILLIS {
                    return Err(ControlValidationError::InvalidChatEventWait {
                        maximum: MAX_CHAT_EVENT_WAIT_MILLIS,
                    });
                }
                Ok(())
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
                stream: _,
                rich_stream: _,
            } => {
                validate_identifier("project_id", project_id)?;
                validate_identifier("session_id", session_id)?;
                validate_bounded_text("message", message, MAX_CHAT_MESSAGE_BYTES, true)?;
                validate_identifier("idempotency_key", idempotency_key)
            }
            Self::StopChatMessage {
                project_id,
                session_id,
                message_id,
            } => {
                validate_identifier("project_id", project_id)?;
                validate_identifier("session_id", session_id)?;
                validate_identifier("message_id", message_id)
            }
            Self::AnswerChatQuestion {
                project_id,
                session_id,
                tool_use_id,
                answer,
            } => {
                validate_identifier("project_id", project_id)?;
                validate_identifier("session_id", session_id)?;
                validate_identifier("tool_use_id", tool_use_id)?;
                validate_bounded_text("answer", answer, MAX_CHAT_QUESTION_ANSWER_BYTES, true)
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
    /// The desktop accepts [`ControlCommand::CreateChatSession`].
    CreateChatSession,
    /// The desktop accepts [`ControlCommand::GetChatModelOptions`].
    GetChatModelOptions,
    /// The desktop accepts [`ControlCommand::SetChatSessionModel`].
    SetChatSessionModel,
    /// The desktop accepts [`ControlCommand::StopChatMessage`].
    StopChatMessage,
    /// The desktop accepts `rich_stream` and emits ordered visible Chat events.
    RichChatProgress,
    /// The desktop supports cursor-based long polling for desktop-originated
    /// visible chat changes.
    ChatEventSync,
    /// The desktop accepts [`ControlCommand::AnswerChatQuestion`], so a phone
    /// can unblock a turn that is waiting on an `AskUserQuestion` tool call
    /// instead of watching it wait until the turn is cancelled.
    AnswerChatQuestion,
}

/// Backward-compatible, non-content-bearing execution stage for paired-device
/// clients that do not opt in to the visible rich event stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatMessageActivity {
    Preparing,
    Compacting,
    Thinking,
    Tool,
}

/// Bounded tool progress already prepared for the Desktop UI. Network
/// addresses, provider credentials, permission controls, and raw wire traces
/// are never represented here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatToolProgress {
    pub elapsed_ms: u64,
    pub timeout_ms: Option<u64>,
    pub pid: Option<u32>,
    pub stdout_tail: Option<String>,
    pub stderr_tail: Option<String>,
    pub near_timeout: bool,
    pub message: String,
}

/// One event in the exact visible order produced by the desktop Chat runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChatMessageEvent {
    TextDelta {
        delta: String,
    },
    ThinkingDelta {
        delta: String,
    },
    ToolCall {
        tool_use_id: Option<String>,
        name: String,
        input: String,
    },
    ToolProgress {
        tool_use_id: Option<String>,
        name: String,
        progress: ChatToolProgress,
    },
    ToolResult {
        tool_use_id: Option<String>,
        name: String,
        output: String,
        is_error: bool,
    },
}

/// A durable visible block reconstructed from the Desktop Chat UI store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChatTranscriptBlock {
    Text {
        text: String,
    },
    Thinking {
        thinking: String,
    },
    Tool {
        tool_use_id: Option<String>,
        name: String,
        input: String,
        output: Option<String>,
        is_error: Option<bool>,
        progress: Option<ChatToolProgress>,
    },
}

/// A visible desktop-originated change in one selected Chat session. Sequence
/// numbers are durable event-log cursors, not filesystem or process ids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChatSessionEvent {
    UserMessage { seq: u64, text: String },
    Assistant { seq: u64, event: ChatMessageEvent },
    Done { seq: u64, text: String },
    Error { seq: u64, message: String },
    Reset { seq: u64 },
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
    /// Confirmation containing the desktop-owned conversation created for the
    /// paired phone. Empty chats may not appear in the normal recent-chat
    /// index until their first message, so this summary is authoritative.
    ChatSessionCreated {
        project_id: String,
        session: ChatSessionSummary,
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
    /// One bounded batch from the selected desktop Chat's durable visible
    /// event stream. Empty batches are normal long-poll heartbeats.
    ChatEvents {
        project_id: String,
        session_id: String,
        events: Vec<ChatSessionEvent>,
        next_seq: u64,
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
    /// A non-terminal, safe execution-status update for a paired chat turn.
    ChatMessageActivity {
        project_id: String,
        session_id: String,
        message_id: String,
        activity: ChatMessageActivity,
    },
    /// Ordered rich event used only by clients that requested `rich_stream`.
    ChatMessageEvent {
        project_id: String,
        session_id: String,
        message_id: String,
        event: ChatMessageEvent,
    },
    /// One ordered text fragment produced by an in-flight remote chat turn.
    /// The response keeps the originating request id, while `message_id`
    /// identifies the durable user/assistant turn pair across retries.
    ChatMessageDelta {
        project_id: String,
        session_id: String,
        message_id: String,
        delta: String,
    },
    /// A bounded remote chat turn completed by the selected desktop session.
    ///
    /// This remains the authoritative terminal value for both legacy
    /// synchronous clients and clients that opted into accepted/delta frames.
    ChatMessageCompleted {
        project_id: String,
        session_id: String,
        message_id: String,
        text: String,
    },
    /// The selected remote chat turn was interrupted before a final response.
    ChatMessageCancelled {
        project_id: String,
        session_id: String,
        message_id: String,
    },
    /// The desktop accepted a request to interrupt the selected remote turn.
    /// The original `send_chat_message` request receives the authoritative
    /// `chat_message_cancelled` terminal response once cleanup has finished.
    ChatMessageStopRequested {
        project_id: String,
        session_id: String,
        message_id: String,
    },
    /// The blocked `AskUserQuestion` tool call received the phone's answer and
    /// the desktop turn resumed. The tool result itself arrives through the
    /// ordinary visible event stream, like any other tool.
    ChatQuestionAnswered {
        project_id: String,
        session_id: String,
        tool_use_id: String,
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

/// One displayed chat message. `text` remains the backward-compatible plain
/// projection; `blocks` carries the bounded visible Desktop rendering for
/// clients that support rich transcript recovery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatTranscriptMessage {
    pub role: ChatTranscriptRole,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<ChatTranscriptBlock>,
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
    #[error("chat event wait exceeds maximum {maximum} ms")]
    InvalidChatEventWait { maximum: u32 },
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
                stream: true,
                rich_stream: true,
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
            stream: true,
            rich_stream: true,
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
    fn answering_a_question_needs_the_chat_grant_and_a_real_answer() {
        let request = ControlRequest::new(
            ControlCommand::AnswerChatQuestion {
                project_id: "project-1".to_string(),
                session_id: "chat-1".to_string(),
                tool_use_id: "toolu-1".to_string(),
                answer: "Staging".to_string(),
            },
            100,
        );
        // Reading project state is not enough to unblock a waiting turn.
        assert!(matches!(
            request.validate_for(&DeviceScopes::from([DeviceScope::ReadProjectState])),
            Err(ControlValidationError::MissingScope {
                required_scope: DeviceScope::SendChatMessages
            })
        ));
        request
            .validate_for(&DeviceScopes::from([DeviceScope::SendChatMessages]))
            .expect("the chat grant should already cover answering");

        // A blank answer would resolve the tool call with nothing at all.
        let blank = ControlCommand::AnswerChatQuestion {
            project_id: "project-1".to_string(),
            session_id: "chat-1".to_string(),
            tool_use_id: "toolu-1".to_string(),
            answer: "   ".to_string(),
        };
        assert!(matches!(
            blank.validate(),
            Err(ControlValidationError::BlankText { field: "answer" })
        ));

        let unbounded = ControlCommand::AnswerChatQuestion {
            project_id: "project-1".to_string(),
            session_id: "chat-1".to_string(),
            tool_use_id: "toolu-1".to_string(),
            answer: "a".repeat(MAX_CHAT_QUESTION_ANSWER_BYTES + 1),
        };
        assert!(matches!(
            unbounded.validate(),
            Err(ControlValidationError::TextTooLong { field: "answer", .. })
        ));

        let unidentified = ControlCommand::AnswerChatQuestion {
            project_id: "project-1".to_string(),
            session_id: "chat-1".to_string(),
            tool_use_id: String::new(),
            answer: "Staging".to_string(),
        };
        assert!(matches!(
            unidentified.validate(),
            Err(ControlValidationError::InvalidIdentifier {
                field: "tool_use_id",
                ..
            })
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
                RemoteCapability::CreateChatSession,
                RemoteCapability::GetChatModelOptions,
                RemoteCapability::SetChatSessionModel,
                RemoteCapability::StopChatMessage,
                RemoteCapability::RichChatProgress,
                RemoteCapability::ChatEventSync,
            ],
        };
        assert_eq!(
            serde_json::to_value(current).expect("workspace result should serialize")
                ["capabilities"],
            serde_json::json!([
                "set_active_project",
                "create_chat_session",
                "get_chat_model_options",
                "set_chat_session_model",
                "stop_chat_message",
                "rich_chat_progress",
                "chat_event_sync",
            ])
        );
    }

    #[test]
    fn create_chat_session_is_bounded_and_serializes_stably() {
        let command = ControlCommand::CreateChatSession {
            project_id: "project-1".to_string(),
        };
        assert_eq!(command.required_scope(), DeviceScope::SendChatMessages);
        command.validate().expect("valid create command");
        assert_eq!(
            serde_json::to_value(command).expect("create command should serialize"),
            serde_json::json!({
                "type": "create_chat_session",
                "project_id": "project-1",
            })
        );

        let result = ControlResult::ChatSessionCreated {
            project_id: "project-1".to_string(),
            session: ChatSessionSummary {
                session_id: "chat-1".to_string(),
                title: "New chat".to_string(),
                updated_at_unix_ms: 42,
                model: None,
            },
        };
        assert_eq!(
            serde_json::to_value(result).expect("create result should serialize")["type"],
            "chat_session_created"
        );
    }

    #[test]
    fn chat_event_sync_is_bounded_and_serializes_visible_events() {
        let command = ControlCommand::GetChatEvents {
            project_id: "project-1".to_string(),
            session_id: "chat-1".to_string(),
            after_seq: Some(41),
            limit: 200,
            wait_ms: 20_000,
        };
        assert_eq!(command.required_scope(), DeviceScope::SendChatMessages);
        command.validate().expect("valid chat event long poll");
        assert_eq!(
            serde_json::to_value(command).expect("chat event command should serialize"),
            serde_json::json!({
                "type": "get_chat_events",
                "project_id": "project-1",
                "session_id": "chat-1",
                "after_seq": 41,
                "limit": 200,
                "wait_ms": 20_000,
            })
        );

        let result = ControlResult::ChatEvents {
            project_id: "project-1".to_string(),
            session_id: "chat-1".to_string(),
            events: vec![ChatSessionEvent::Assistant {
                seq: 42,
                event: ChatMessageEvent::ThinkingDelta {
                    delta: "checking".to_string(),
                },
            }],
            next_seq: 42,
        };
        assert_eq!(
            serde_json::to_value(result).expect("chat events should serialize")["events"][0],
            serde_json::json!({
                "kind": "assistant",
                "seq": 42,
                "event": { "kind": "thinking_delta", "delta": "checking" },
            })
        );

        let excessive_wait = ControlCommand::GetChatEvents {
            project_id: "project-1".to_string(),
            session_id: "chat-1".to_string(),
            after_seq: None,
            limit: 1,
            wait_ms: MAX_CHAT_EVENT_WAIT_MILLIS + 1,
        };
        assert!(matches!(
            excessive_wait.validate(),
            Err(ControlValidationError::InvalidChatEventWait { .. })
        ));
    }

    #[test]
    fn chat_delta_serializes_as_a_correlated_stream_result() {
        let value = serde_json::to_value(ControlResult::ChatMessageDelta {
            project_id: "project-1".to_string(),
            session_id: "chat-1".to_string(),
            message_id: "message-1".to_string(),
            delta: "partial".to_string(),
        })
        .expect("chat delta should serialize");

        assert_eq!(
            value,
            serde_json::json!({
                "type": "chat_message_delta",
                "project_id": "project-1",
                "session_id": "chat-1",
                "message_id": "message-1",
                "delta": "partial",
            })
        );

        let legacy_command: ControlCommand = serde_json::from_value(serde_json::json!({
            "type": "send_chat_message",
            "project_id": "project-1",
            "session_id": "chat-1",
            "message": "legacy request",
            "idempotency_key": "legacy-message-1",
        }))
        .expect("a pre-stream mobile request should remain valid");
        assert!(matches!(
            legacy_command,
            ControlCommand::SendChatMessage {
                stream: false,
                rich_stream: false,
                ..
            }
        ));
    }

    #[test]
    fn stop_chat_message_is_scoped_and_serializes_with_safe_progress() {
        let command = ControlCommand::StopChatMessage {
            project_id: "project-1".to_string(),
            session_id: "chat-1".to_string(),
            message_id: "message-1".to_string(),
        };
        assert_eq!(command.required_scope(), DeviceScope::SendChatMessages);
        command.validate().expect("valid stop command");
        assert_eq!(
            serde_json::to_value(command).expect("stop command should serialize"),
            serde_json::json!({
                "type": "stop_chat_message",
                "project_id": "project-1",
                "session_id": "chat-1",
                "message_id": "message-1",
            })
        );

        let activity = ControlResult::ChatMessageActivity {
            project_id: "project-1".to_string(),
            session_id: "chat-1".to_string(),
            message_id: "message-1".to_string(),
            activity: ChatMessageActivity::Thinking,
        };
        assert_eq!(
            serde_json::to_value(activity).expect("activity should serialize"),
            serde_json::json!({
                "type": "chat_message_activity",
                "project_id": "project-1",
                "session_id": "chat-1",
                "message_id": "message-1",
                "activity": "thinking",
            })
        );

        let cancelled = ControlResult::ChatMessageCancelled {
            project_id: "project-1".to_string(),
            session_id: "chat-1".to_string(),
            message_id: "message-1".to_string(),
        };
        assert_eq!(
            serde_json::to_value(cancelled).expect("cancelled should serialize"),
            serde_json::json!({
                "type": "chat_message_cancelled",
                "project_id": "project-1",
                "session_id": "chat-1",
                "message_id": "message-1",
            })
        );
    }
}
