//! Strict, bounded WebRTC signaling payloads routed by a remote gateway.
//!
//! The gateway owns the outer WebSocket frame (`to`, `from`, and a fresh
//! `session_id`) and deliberately treats the payload as opaque. This module
//! owns only the payload shape both clients validate before passing anything
//! to a platform WebRTC implementation. SDP and ICE candidates are not
//! secrets, but they can contain local network metadata; callers must never
//! write them to the remote audit log.

use crate::ProtocolVersion;
#[cfg(test)]
use crate::CURRENT_PROTOCOL_VERSION;
use serde::{Deserialize, Serialize};

/// The only reliable, ordered WebRTC data-channel label accepted by P2.
///
/// Control frames carried through this channel remain wrapped in
/// [`SecureEnvelope`](crate::SecureEnvelope); opening the data channel alone
/// never grants any remote capability.
pub const WEBRTC_CONTROL_CHANNEL_LABEL: &str = "somniq-control-v1";

/// Bound SDP before it reaches a browser or native WebRTC stack. Candidates
/// are trickled separately, so a normal offer/answer should be substantially
/// smaller than this ceiling.
pub const MAX_WEBRTC_SDP_BYTES: usize = 64 * 1024;
/// A single ICE candidate is a one-line value and should remain small.
pub const MAX_WEBRTC_ICE_CANDIDATE_BYTES: usize = 4 * 1024;
pub const MAX_WEBRTC_ICE_MID_BYTES: usize = 256;
pub const MAX_WEBRTC_ICE_USERNAME_FRAGMENT_BYTES: usize = 256;
/// A native desktop advertises only a small set of literal socket addresses
/// for the LAN/direct-TCP fast path. The gateway merely routes this metadata.
pub const MAX_DIRECT_TCP_ADDRESSES: usize = 8;
pub const MAX_DIRECT_TCP_ADDRESS_BYTES: usize = 128;

/// A stable, metadata-only reason one endpoint stopped a direct P2P attempt.
/// This is useful to the peer for cleanup and locally for audit explanation;
/// it deliberately carries no free-form diagnostic text or network details.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum P2pFailureReason {
    IceTimeout,
    IceFailed,
    NegotiationFailed,
    DataChannelFailed,
    Cancelled,
}

/// A closed, platform-neutral payload for one gateway signal frame.
///
/// The enclosing gateway message must provide the fresh UUID `session_id`.
/// That ID is intentionally not duplicated here: a receiver parses it as a
/// [`SessionId`](crate::SessionId), reserves it before constructing a WebRTC
/// connection, then derives the end-to-end session key from that same ID.
/// A TCP fallback must use a *new* outer session ID rather than reusing the
/// failed direct attempt's ID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TransportSignal {
    /// Legacy native desktop-to-desktop LAN path retained for compatibility.
    /// New computer nodes use WebRTC/ICE traversal. Each legacy value must be
    /// a literal `SocketAddr` (never a hostname).
    DirectTcpOffer {
        protocol_version: ProtocolVersion,
        addresses: Vec<String>,
    },
    /// Initial SDP from the deterministic offerer: mobile for phone control,
    /// or the claimed ComputeNode for computer-to-computer execution.
    WebrtcOffer {
        protocol_version: ProtocolVersion,
        sdp: String,
    },
    /// SDP answer from the desktop.
    WebrtcAnswer {
        protocol_version: ProtocolVersion,
        sdp: String,
    },
    /// One trickled candidate. `sdp_mid` and `sdp_m_line_index` use the
    /// browser API's JSON names after serde's snake-case conversion.
    WebrtcIceCandidate {
        protocol_version: ProtocolVersion,
        candidate: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sdp_mid: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sdp_m_line_index: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        username_fragment: Option<String>,
    },
    /// Explicit end-of-candidates marker. Empty candidates are rejected so a
    /// platform never has to infer whether an empty string is data or a marker.
    WebrtcIceComplete { protocol_version: ProtocolVersion },
    /// One endpoint abandoned a direct attempt. It may subsequently send a
    /// `relay_offer` under a fresh session ID.
    P2pFailed {
        protocol_version: ProtocolVersion,
        reason: P2pFailureReason,
    },
    /// Request the existing encrypted WSS/TCP relay fallback. This preserves
    /// the exact P1 payload shape so a P2 mobile can still fall back to a P1
    /// desktop that has no WebRTC adapter.
    RelayOffer { protocol_version: ProtocolVersion },
}

impl TransportSignal {
    /// Returns the protocol version carried by this signal payload.
    #[must_use]
    pub const fn protocol_version(&self) -> ProtocolVersion {
        match self {
            Self::DirectTcpOffer {
                protocol_version, ..
            }
            | Self::WebrtcOffer {
                protocol_version, ..
            }
            | Self::WebrtcAnswer {
                protocol_version, ..
            }
            | Self::WebrtcIceCandidate {
                protocol_version, ..
            }
            | Self::WebrtcIceComplete {
                protocol_version, ..
            }
            | Self::P2pFailed {
                protocol_version, ..
            }
            | Self::RelayOffer {
                protocol_version, ..
            } => *protocol_version,
        }
    }

    /// Performs semantic and size validation before a platform WebRTC stack
    /// receives SDP or candidate strings.
    pub fn validate(&self) -> Result<(), TransportSignalError> {
        let protocol_version = self.protocol_version();
        if !protocol_version.is_supported() {
            return Err(TransportSignalError::UnsupportedProtocol {
                received: protocol_version,
            });
        }

        match self {
            Self::DirectTcpOffer { addresses, .. } => validate_direct_tcp_addresses(addresses),
            Self::WebrtcOffer { sdp, .. } | Self::WebrtcAnswer { sdp, .. } => validate_sdp(sdp),
            Self::WebrtcIceCandidate {
                candidate,
                sdp_mid,
                sdp_m_line_index,
                username_fragment,
                ..
            } => validate_ice_candidate(
                candidate,
                sdp_mid.as_deref(),
                *sdp_m_line_index,
                username_fragment.as_deref(),
            ),
            Self::WebrtcIceComplete { .. } | Self::P2pFailed { .. } | Self::RelayOffer { .. } => {
                Ok(())
            }
        }
    }
}

fn validate_direct_tcp_addresses(addresses: &[String]) -> Result<(), TransportSignalError> {
    if addresses.is_empty() {
        return Err(TransportSignalError::EmptyDirectTcpAddresses);
    }
    if addresses.len() > MAX_DIRECT_TCP_ADDRESSES {
        return Err(TransportSignalError::TooManyDirectTcpAddresses {
            maximum: MAX_DIRECT_TCP_ADDRESSES,
        });
    }
    for address in addresses {
        validate_maximum("direct_tcp_address", address, MAX_DIRECT_TCP_ADDRESS_BYTES)?;
        let socket = address
            .parse::<std::net::SocketAddr>()
            .map_err(|_| TransportSignalError::InvalidDirectTcpAddress)?;
        let ip = socket.ip();
        if socket.port() == 0 || ip.is_unspecified() || ip.is_multicast() {
            return Err(TransportSignalError::InvalidDirectTcpAddress);
        }
        if let std::net::IpAddr::V4(ip) = ip {
            if ip.is_broadcast() {
                return Err(TransportSignalError::InvalidDirectTcpAddress);
            }
        }
    }
    Ok(())
}

/// A validation failure for an unencrypted transport-negotiation payload.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TransportSignalError {
    #[error("unsupported remote protocol version {received}")]
    UnsupportedProtocol { received: ProtocolVersion },
    #[error("a direct TCP offer contains no addresses")]
    EmptyDirectTcpAddresses,
    #[error("a direct TCP offer exceeds {maximum} addresses")]
    TooManyDirectTcpAddresses { maximum: usize },
    #[error("a direct TCP offer contains an invalid socket address")]
    InvalidDirectTcpAddress,
    #[error("the {field} exceeds {maximum} bytes")]
    FieldTooLong { field: &'static str, maximum: usize },
    #[error("the SDP is empty")]
    EmptySdp,
    #[error("the SDP contains a disallowed character")]
    InvalidSdpCharacter,
    #[error("the ICE candidate is empty")]
    EmptyIceCandidate,
    #[error("the ICE candidate must start with candidate:")]
    InvalidIceCandidatePrefix,
    #[error("the ICE candidate contains a disallowed character")]
    InvalidIceCandidateCharacter,
    #[error("an ICE candidate needs sdp_mid or sdp_m_line_index")]
    MissingIceCandidateTarget,
    #[error("the {field} is empty")]
    EmptyField { field: &'static str },
    #[error("the {field} contains a disallowed character")]
    InvalidFieldCharacter { field: &'static str },
}

fn validate_sdp(sdp: &str) -> Result<(), TransportSignalError> {
    validate_maximum("sdp", sdp, MAX_WEBRTC_SDP_BYTES)?;
    if sdp.trim().is_empty() {
        return Err(TransportSignalError::EmptySdp);
    }
    if !sdp.bytes().all(is_sdp_byte) {
        return Err(TransportSignalError::InvalidSdpCharacter);
    }
    Ok(())
}

fn validate_ice_candidate(
    candidate: &str,
    sdp_mid: Option<&str>,
    sdp_m_line_index: Option<u16>,
    username_fragment: Option<&str>,
) -> Result<(), TransportSignalError> {
    validate_maximum("candidate", candidate, MAX_WEBRTC_ICE_CANDIDATE_BYTES)?;
    if candidate.is_empty() {
        return Err(TransportSignalError::EmptyIceCandidate);
    }
    if !candidate.starts_with("candidate:") {
        return Err(TransportSignalError::InvalidIceCandidatePrefix);
    }
    if !candidate.bytes().all(is_single_line_visible_ascii) {
        return Err(TransportSignalError::InvalidIceCandidateCharacter);
    }
    if sdp_mid.is_none() && sdp_m_line_index.is_none() {
        return Err(TransportSignalError::MissingIceCandidateTarget);
    }
    if let Some(sdp_mid) = sdp_mid {
        validate_single_line_field("sdp_mid", sdp_mid, MAX_WEBRTC_ICE_MID_BYTES)?;
    }
    if let Some(username_fragment) = username_fragment {
        validate_single_line_field(
            "username_fragment",
            username_fragment,
            MAX_WEBRTC_ICE_USERNAME_FRAGMENT_BYTES,
        )?;
    }
    Ok(())
}

fn validate_single_line_field(
    field: &'static str,
    value: &str,
    maximum: usize,
) -> Result<(), TransportSignalError> {
    validate_maximum(field, value, maximum)?;
    if value.is_empty() {
        return Err(TransportSignalError::EmptyField { field });
    }
    if !value.bytes().all(is_single_line_visible_ascii) {
        return Err(TransportSignalError::InvalidFieldCharacter { field });
    }
    Ok(())
}

fn validate_maximum(
    field: &'static str,
    value: &str,
    maximum: usize,
) -> Result<(), TransportSignalError> {
    if value.len() > maximum {
        return Err(TransportSignalError::FieldTooLong { field, maximum });
    }
    Ok(())
}

const fn is_sdp_byte(byte: u8) -> bool {
    byte == b'\r' || byte == b'\n' || byte == b'\t' || byte == b' ' || byte.is_ascii_graphic()
}

const fn is_single_line_visible_ascii(byte: u8) -> bool {
    byte == b' ' || byte.is_ascii_graphic()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_candidate() -> TransportSignal {
        TransportSignal::WebrtcIceCandidate {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 54400 typ host".into(),
            sdp_mid: Some("0".into()),
            sdp_m_line_index: Some(0),
            username_fragment: Some("uFr4g".into()),
        }
    }

    #[test]
    fn valid_offer_round_trips_with_a_closed_schema() {
        let signal = TransportSignal::WebrtcOffer {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n".into(),
        };
        signal.validate().expect("valid offer");
        let json = serde_json::to_value(&signal).expect("serialize offer");
        assert_eq!(json["kind"], "webrtc_offer");
        assert_eq!(
            serde_json::from_value::<TransportSignal>(json).expect("deserialize offer"),
            signal
        );
    }

    #[test]
    fn direct_tcp_offer_requires_bounded_literal_unicast_addresses() {
        let signal = TransportSignal::DirectTcpOffer {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            addresses: vec!["192.168.1.20:42100".into(), "[::1]:42100".into()],
        };
        signal.validate().expect("valid direct TCP offer");
        let json = serde_json::to_value(&signal).expect("serialize direct offer");
        assert_eq!(json["kind"], "direct_tcp_offer");
        assert_eq!(
            serde_json::from_value::<TransportSignal>(json).expect("deserialize direct offer"),
            signal
        );

        let hostname = TransportSignal::DirectTcpOffer {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            addresses: vec!["example.test:42100".into()],
        };
        assert_eq!(
            hostname.validate(),
            Err(TransportSignalError::InvalidDirectTcpAddress)
        );
    }

    #[test]
    fn p1_relay_offer_shape_remains_valid() {
        let signal: TransportSignal = serde_json::from_value(serde_json::json!({
            "kind": "relay_offer",
            "protocol_version": 1
        }))
        .expect("legacy relay offer must deserialize");
        signal.validate().expect("legacy relay offer must validate");
        assert_eq!(
            serde_json::to_value(signal).expect("serialize relay offer"),
            serde_json::json!({"kind": "relay_offer", "protocol_version": 1})
        );
    }

    #[test]
    fn rejects_unknown_fields_and_unknown_protocol_versions() {
        assert!(
            serde_json::from_value::<TransportSignal>(serde_json::json!({
                "kind": "webrtc_offer",
                "protocol_version": 1,
                "sdp": "v=0\r\n",
                "extra": true
            }))
            .is_err()
        );

        let signal: TransportSignal = serde_json::from_value(serde_json::json!({
            "kind": "webrtc_offer",
            "protocol_version": 99,
            "sdp": "v=0\r\n"
        }))
        .expect("shape is valid before semantic version check");
        assert!(matches!(
            signal.validate(),
            Err(TransportSignalError::UnsupportedProtocol { .. })
        ));
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_ice_candidates() {
        let mut signal = valid_candidate();
        signal.validate().expect("valid ICE candidate");

        if let TransportSignal::WebrtcIceCandidate { candidate, .. } = &mut signal {
            *candidate = "candidate:1\r\ninjected".into();
        }
        assert_eq!(
            signal.validate(),
            Err(TransportSignalError::InvalidIceCandidateCharacter)
        );

        let missing_target = TransportSignal::WebrtcIceCandidate {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            candidate: "candidate:1 1 UDP 1 192.0.2.1 9 typ host".into(),
            sdp_mid: None,
            sdp_m_line_index: None,
            username_fragment: None,
        };
        assert_eq!(
            missing_target.validate(),
            Err(TransportSignalError::MissingIceCandidateTarget)
        );
    }

    #[test]
    fn enforces_sdp_and_candidate_bounds() {
        let oversized_sdp = TransportSignal::WebrtcAnswer {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            sdp: "x".repeat(MAX_WEBRTC_SDP_BYTES + 1),
        };
        assert_eq!(
            oversized_sdp.validate(),
            Err(TransportSignalError::FieldTooLong {
                field: "sdp",
                maximum: MAX_WEBRTC_SDP_BYTES,
            })
        );

        let mut oversized_candidate = valid_candidate();
        if let TransportSignal::WebrtcIceCandidate { candidate, .. } = &mut oversized_candidate {
            *candidate = format!("candidate:{}", "x".repeat(MAX_WEBRTC_ICE_CANDIDATE_BYTES));
        }
        assert_eq!(
            oversized_candidate.validate(),
            Err(TransportSignalError::FieldTooLong {
                field: "candidate",
                maximum: MAX_WEBRTC_ICE_CANDIDATE_BYTES,
            })
        );
    }
}
