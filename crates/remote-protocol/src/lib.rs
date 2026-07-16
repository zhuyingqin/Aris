//! Versioned wire types and cryptographic primitives for `SomniQ` remote control.
//!
//! The gateway may inspect routing metadata, but it does not need access to
//! control payloads: [`SecureEnvelope`] encrypts and authenticates those
//! payloads end-to-end between paired devices. This crate intentionally
//! exposes only the small, reviewed remote-control command surface; it does
//! not model arbitrary terminal, file-system, or secret-store access.

#![forbid(unsafe_code)]

mod control;
mod crypto;
mod ids;
mod pairing;
mod replay;
mod signaling;
mod transport;
mod wire;

pub use control::{
    ChatModelOption, ChatSessionSummary, ChatTranscriptMessage, ChatTranscriptRole, ControlCommand,
    ControlError, ControlRequest, ControlResponse, ControlResponseOutcome, ControlResult,
    ControlValidationError, DeviceScope, DeviceScopes, ProjectSummary, RemoteCapability,
    ReviewDisposition, ReviewSummary, TimelineEvent,
};
pub use crypto::{
    CryptoError, DevicePublicKey, DeviceSignature, DeviceSigningKey, KeyAgreementPublicKey,
    KeyAgreementSecret, SessionKey, SessionKeyContext,
};
pub use ids::{DeviceId, PairingId, RequestId, SessionId};
pub use pairing::{
    DeviceDescriptor, DeviceKind, PairingApproval, PairingError, PairingInvitation, PairingRequest,
    PairingSecret, PairingSecretDigest,
};
pub use replay::{ReplayError, ReplayPolicy, ReplayWindow};
pub use signaling::{
    P2pFailureReason, TransportSignal, TransportSignalError, MAX_WEBRTC_ICE_CANDIDATE_BYTES,
    MAX_WEBRTC_ICE_MID_BYTES, MAX_WEBRTC_ICE_USERNAME_FRAGMENT_BYTES, MAX_WEBRTC_SDP_BYTES,
    WEBRTC_CONTROL_CHANNEL_LABEL,
};
pub use transport::{
    TransportCandidate, TransportCandidateState, TransportDecision, TransportFailureReason,
    TransportKind, TransportPreference, TransportSelector,
};
pub use wire::{
    Base64UrlBytes, EnvelopeError, EnvelopeNonce, ProtocolVersion, SecureEnvelope, SessionRoute,
    CURRENT_PROTOCOL_VERSION,
};
