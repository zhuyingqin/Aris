use serde::{Deserialize, Serialize};

/// Route type used after gateway signaling has completed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportKind {
    /// A direct, end-to-end WebRTC data-channel path selected through ICE.
    P2p,
    /// An end-to-end encrypted payload carried through a TLS TCP/WebSocket
    /// relay. The relay may route it but cannot read the [`SecureEnvelope`](crate::SecureEnvelope).
    TcpRelay,
}

/// Policy controlling whether the client tries P2P before the TCP relay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TransportPreference {
    /// Try P2P first and fall back to the relay when direct connectivity fails.
    #[default]
    PreferP2p,
    /// Never use the relay. Useful only for deliberate local-network testing.
    P2pOnly,
    /// Skip ICE and use the TLS TCP relay immediately.
    TcpRelayOnly,
}

/// Result reported by a transport probe. P2P timeouts are retained separately
/// so remote audit logs can explain why the relay was selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportCandidateState {
    Reachable,
    TimedOut,
    Unreachable,
}

/// One route that a platform transport implementation has probed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransportCandidate {
    pub candidate_id: String,
    pub kind: TransportKind,
    /// Larger values win before latency is considered.
    pub priority: u32,
    pub state: TransportCandidateState,
    pub round_trip_time_ms: Option<u32>,
}

impl TransportCandidate {
    /// Returns a reachable P2P candidate.
    #[must_use]
    pub fn p2p(
        candidate_id: impl Into<String>,
        priority: u32,
        round_trip_time_ms: Option<u32>,
    ) -> Self {
        Self {
            candidate_id: candidate_id.into(),
            kind: TransportKind::P2p,
            priority,
            state: TransportCandidateState::Reachable,
            round_trip_time_ms,
        }
    }

    /// Returns a reachable TLS TCP relay candidate.
    #[must_use]
    pub fn tcp_relay(
        candidate_id: impl Into<String>,
        priority: u32,
        round_trip_time_ms: Option<u32>,
    ) -> Self {
        Self {
            candidate_id: candidate_id.into(),
            kind: TransportKind::TcpRelay,
            priority,
            state: TransportCandidateState::Reachable,
            round_trip_time_ms,
        }
    }
}

/// Explainable reason a direct choice could not be made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportFailureReason {
    P2pProbeTimedOut,
    P2pUnavailable,
    TcpRelayUnavailable,
}

/// Chosen path or a reason no permitted path is available.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TransportDecision {
    P2p {
        candidate_id: String,
    },
    TcpRelay {
        candidate_id: String,
        /// Present only when TCP is a fallback from a P2P-first policy.
        fallback_reason: Option<TransportFailureReason>,
    },
    Unavailable {
        reason: TransportFailureReason,
    },
}

/// Deterministic P2P-first route selector. The platform-specific WebRTC and
/// WSS clients report [`TransportCandidate`] values; this type contains no
/// socket implementation and can therefore be shared by desktop and gateway.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransportSelector {
    pub preference: TransportPreference,
    /// The connection owner should mark a still-pending P2P probe as timed out
    /// after this bound, then call [`Self::select`] again to pick the relay.
    pub p2p_probe_timeout_ms: u64,
}

impl TransportSelector {
    /// Builds a selector with a caller-controlled P2P probe deadline.
    #[must_use]
    pub const fn new(preference: TransportPreference, p2p_probe_timeout_ms: u64) -> Self {
        Self {
            preference,
            p2p_probe_timeout_ms,
        }
    }

    /// Selects a candidate using priority, then lower round-trip time, then ID
    /// as deterministic tie-breakers.
    #[must_use]
    pub fn select(&self, candidates: &[TransportCandidate]) -> TransportDecision {
        match self.preference {
            TransportPreference::PreferP2p => {
                if let Some(candidate) = best_reachable(candidates, TransportKind::P2p) {
                    return TransportDecision::P2p {
                        candidate_id: candidate.candidate_id.clone(),
                    };
                }
                let p2p_reason = p2p_failure_reason(candidates);
                if let Some(candidate) = best_reachable(candidates, TransportKind::TcpRelay) {
                    return TransportDecision::TcpRelay {
                        candidate_id: candidate.candidate_id.clone(),
                        fallback_reason: Some(p2p_reason),
                    };
                }
                TransportDecision::Unavailable { reason: p2p_reason }
            }
            TransportPreference::P2pOnly => best_reachable(candidates, TransportKind::P2p)
                .map_or_else(
                    || TransportDecision::Unavailable {
                        reason: p2p_failure_reason(candidates),
                    },
                    |candidate| TransportDecision::P2p {
                        candidate_id: candidate.candidate_id.clone(),
                    },
                ),
            TransportPreference::TcpRelayOnly => {
                best_reachable(candidates, TransportKind::TcpRelay).map_or_else(
                    || TransportDecision::Unavailable {
                        reason: TransportFailureReason::TcpRelayUnavailable,
                    },
                    |candidate| TransportDecision::TcpRelay {
                        candidate_id: candidate.candidate_id.clone(),
                        fallback_reason: None,
                    },
                )
            }
        }
    }
}

impl Default for TransportSelector {
    fn default() -> Self {
        Self::new(TransportPreference::PreferP2p, 7_000)
    }
}

fn best_reachable(
    candidates: &[TransportCandidate],
    kind: TransportKind,
) -> Option<&TransportCandidate> {
    candidates
        .iter()
        .filter(|candidate| {
            candidate.kind == kind
                && candidate.state == TransportCandidateState::Reachable
                && !candidate.candidate_id.trim().is_empty()
        })
        .max_by(|left, right| {
            left.priority
                .cmp(&right.priority)
                .then_with(|| {
                    // Lower measured RTT is better; a missing measurement loses
                    // to a concrete RTT at equal priority.
                    right
                        .round_trip_time_ms
                        .unwrap_or(u32::MAX)
                        .cmp(&left.round_trip_time_ms.unwrap_or(u32::MAX))
                })
                .then_with(|| right.candidate_id.cmp(&left.candidate_id))
        })
}

fn p2p_failure_reason(candidates: &[TransportCandidate]) -> TransportFailureReason {
    if candidates.iter().any(|candidate| {
        candidate.kind == TransportKind::P2p && candidate.state == TransportCandidateState::TimedOut
    }) {
        TransportFailureReason::P2pProbeTimedOut
    } else {
        TransportFailureReason::P2pUnavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p2p_is_selected_before_a_relay() {
        let selector = TransportSelector::default();
        let decision = selector.select(&[
            TransportCandidate::tcp_relay("relay-a", 100, Some(20)),
            TransportCandidate::p2p("direct-a", 10, Some(50)),
        ]);
        assert_eq!(
            decision,
            TransportDecision::P2p {
                candidate_id: "direct-a".to_string()
            }
        );
    }

    #[test]
    fn timed_out_p2p_falls_back_to_tcp_relay() {
        let selector = TransportSelector::default();
        let decision = selector.select(&[
            TransportCandidate {
                candidate_id: "direct-a".to_string(),
                kind: TransportKind::P2p,
                priority: 100,
                state: TransportCandidateState::TimedOut,
                round_trip_time_ms: None,
            },
            TransportCandidate::tcp_relay("relay-a", 10, Some(30)),
        ]);
        assert_eq!(
            decision,
            TransportDecision::TcpRelay {
                candidate_id: "relay-a".to_string(),
                fallback_reason: Some(TransportFailureReason::P2pProbeTimedOut),
            }
        );
    }

    #[test]
    fn selector_tie_breaking_is_deterministic() {
        let selector = TransportSelector::default();
        let decision = selector.select(&[
            TransportCandidate::tcp_relay("relay-b", 20, Some(30)),
            TransportCandidate::tcp_relay("relay-a", 20, Some(30)),
        ]);
        assert_eq!(
            decision,
            TransportDecision::TcpRelay {
                candidate_id: "relay-a".to_string(),
                fallback_reason: Some(TransportFailureReason::P2pUnavailable),
            }
        );
    }
}
