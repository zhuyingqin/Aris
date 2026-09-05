//! Versioned wire types and cryptographic primitives for `SomniQ` remote control.
//!
//! The gateway may inspect routing metadata, but it does not need access to
//! control payloads: [`SecureEnvelope`] encrypts and authenticates those
//! payloads end-to-end between paired devices. This crate intentionally
//! exposes a small, reviewed remote-control surface plus an explicit Compute
//! Job protocol. Compute execution is separately scoped, durably recorded,
//! bounded, and accepted only by a worker the user has enabled; it is never
//! smuggled through chat-control commands or granted secret-store access.

#![forbid(unsafe_code)]

mod code_bridge;
mod compute;
mod control;
mod crypto;
mod ids;
mod image_assist;
mod pairing;
mod replay;
mod signaling;
mod transport;
mod wire;

pub use code_bridge::{
    truncate_utf8, BridgeToHost, HostToBridge, CODE_BRIDGE_MAX_FRAME_BYTES,
    CODE_BRIDGE_MAX_SELECTION_BYTES, CODE_BRIDGE_PROTOCOL_VERSION, CODE_BRIDGE_TOKEN_ENV,
    CODE_BRIDGE_URL_ENV,
};
pub use compute::{
    ComputeArtifact, ComputeJobEvent, ComputeJobEventPayload, ComputeJobRequest, ComputeJobStatus,
    ComputeLogStream, ComputeNodeCapabilities, ComputeResourceLimits, ComputeResultManifest,
    ComputeWireMessage, ComputeWorkload, COMPUTE_MAX_ARTIFACT_CHUNK_BYTES,
    COMPUTE_MAX_LOG_CHUNK_BYTES,
};
pub use control::{
    ChatMessageActivity, ChatMessageEvent, ChatModelOption, ChatSessionEvent, ChatSessionSummary,
    ChatToolProgress, ChatTranscriptBlock, ChatTranscriptMessage, ChatTranscriptRole,
    ControlCommand, ControlError, ControlRequest, ControlResponse, ControlResponseOutcome,
    ControlResult, ControlValidationError, DeviceScope, DeviceScopes, ProjectSummary,
    RemoteCapability, ReviewDisposition, ReviewSummary, TimelineEvent,
};
pub use crypto::{
    CryptoError, DevicePublicKey, DeviceSignature, DeviceSigningKey, KeyAgreementPublicKey,
    KeyAgreementSecret, PreviewKeyContext, SessionKey, SessionKeyContext,
};
pub use ids::{ComputeJobId, DeviceId, MatchId, PairingId, RequestId, SessionId};
pub use image_assist::{
    validate_artifact_manifest, validate_artifact_name, ImageArtifactEntry, ImageAssistClientFrame,
    ImageAssistError, ImageAssistFailure, ImageAssistLocation, ImageAssistRosterEntry,
    ImageAssistServerFrame, ImageAssistTranscript, ImageAssistWireMessage, MatchFailure, P2pRole,
    IMAGE_ASSIST_MAX_ARTIFACTS, IMAGE_ASSIST_MAX_ARTIFACT_BYTES,
    IMAGE_ASSIST_MAX_ARTIFACT_CHUNK_BYTES, IMAGE_ASSIST_MAX_ARTIFACT_NAME_BYTES,
    IMAGE_ASSIST_MAX_ASPECT_RATIO_BYTES, IMAGE_ASSIST_MAX_ICE_SERVERS,
    IMAGE_ASSIST_MAX_PROMPT_BYTES, IMAGE_ASSIST_MAX_TOTAL_ARTIFACT_BYTES,
};
pub use pairing::{
    DeviceDescriptor, DeviceKind, PairingApproval, PairingError, PairingInvitation, PairingRequest,
    PairingSecret, PairingSecretDigest, PeerRelationship,
};
pub use replay::{ReplayError, ReplayPolicy, ReplayWindow};
pub use signaling::{
    P2pFailureReason, TransportSignal, TransportSignalError, MAX_DIRECT_TCP_ADDRESSES,
    MAX_DIRECT_TCP_ADDRESS_BYTES, MAX_WEBRTC_ICE_CANDIDATE_BYTES, MAX_WEBRTC_ICE_MID_BYTES,
    MAX_WEBRTC_ICE_USERNAME_FRAGMENT_BYTES, MAX_WEBRTC_SDP_BYTES, WEBRTC_CONTROL_CHANNEL_LABEL,
};
pub use transport::{
    TransportCandidate, TransportCandidateState, TransportDecision, TransportFailureReason,
    TransportKind, TransportPreference, TransportSelector,
};
pub use wire::{
    Base64UrlBytes, EnvelopeError, EnvelopeNonce, ProtocolVersion, SecureEnvelope, SessionRoute,
    CURRENT_PROTOCOL_VERSION,
};
