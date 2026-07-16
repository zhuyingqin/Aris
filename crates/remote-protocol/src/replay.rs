use crate::{EnvelopeError, EnvelopeNonce, SecureEnvelope, SessionKey, SessionRoute};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

/// Bounds for accepting delayed encrypted messages. Rotate `SessionId` and its
/// session key whenever the desktop loses durable replay state (for example,
/// after a process restart).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayPolicy {
    /// Number of sequence numbers retained for out-of-order delivery.
    pub sequence_window_size: usize,
    /// Maximum age of a message. `None` is intended only for deterministic
    /// tests; production callers should use a finite value.
    pub max_message_age_ms: Option<u64>,
    /// Tolerated clock skew for a sender whose clock is ahead of the receiver.
    pub max_future_skew_ms: u64,
}

impl ReplayPolicy {
    /// Checks policy bounds before allocating replay state.
    pub fn validate(&self) -> Result<(), ReplayError> {
        if self.sequence_window_size == 0 {
            return Err(ReplayError::InvalidPolicy(
                "sequence_window_size must be at least one",
            ));
        }
        Ok(())
    }
}

impl Default for ReplayPolicy {
    fn default() -> Self {
        Self {
            sequence_window_size: 1_024,
            max_message_age_ms: Some(5 * 60 * 1_000),
            max_future_skew_ms: 30_000,
        }
    }
}

/// Per-session, per-direction anti-replay state. Keep one instance for each
/// incoming [`SessionRoute`].
#[derive(Debug)]
pub struct ReplayWindow {
    route: SessionRoute,
    policy: ReplayPolicy,
    highest_sequence: Option<u64>,
    accepted_sequences: BTreeMap<u64, EnvelopeNonce>,
    accepted_nonces: HashSet<EnvelopeNonce>,
}

impl ReplayWindow {
    /// Creates a replay window using the secure production defaults.
    #[must_use]
    pub fn new(route: SessionRoute) -> Self {
        Self {
            route,
            policy: ReplayPolicy::default(),
            highest_sequence: None,
            accepted_sequences: BTreeMap::new(),
            accepted_nonces: HashSet::new(),
        }
    }

    /// Creates a replay window with an explicit policy.
    pub fn with_policy(route: SessionRoute, policy: ReplayPolicy) -> Result<Self, ReplayError> {
        policy.validate()?;
        Ok(Self {
            route,
            policy,
            highest_sequence: None,
            accepted_sequences: BTreeMap::new(),
            accepted_nonces: HashSet::new(),
        })
    }

    /// Returns the only route this window accepts.
    #[must_use]
    pub const fn route(&self) -> &SessionRoute {
        &self.route
    }

    /// Returns the highest sequence accepted so far, if any.
    #[must_use]
    pub const fn highest_sequence(&self) -> Option<u64> {
        self.highest_sequence
    }

    /// Authenticates, decrypts, and records an envelope atomically with
    /// respect to replay state. Invalid ciphertext does not consume a nonce or
    /// sequence number, avoiding a trivial state-exhaustion attack.
    pub fn open_bytes(
        &mut self,
        envelope: &SecureEnvelope,
        session_key: &SessionKey,
        now_unix_ms: i64,
    ) -> Result<Vec<u8>, ReplayError> {
        self.preflight(envelope, now_unix_ms)?;
        let plaintext = envelope
            .open_bytes(session_key)
            .map_err(ReplayError::Envelope)?;
        self.record(envelope);
        Ok(plaintext)
    }

    /// Opens an encrypted JSON payload and records it only after decryption
    /// succeeds. It is the recommended entry point for [`ControlRequest`](crate::ControlRequest).
    pub fn open<T: DeserializeOwned>(
        &mut self,
        envelope: &SecureEnvelope,
        session_key: &SessionKey,
        now_unix_ms: i64,
    ) -> Result<T, ReplayError> {
        let plaintext = self.open_bytes(envelope, session_key, now_unix_ms)?;
        serde_json::from_slice(&plaintext).map_err(ReplayError::DeserializePayload)
    }

    /// Records an envelope after an external caller has independently
    /// authenticated it. Prefer [`Self::open_bytes`] so invalid ciphertext
    /// cannot consume replay state.
    pub fn accept(
        &mut self,
        envelope: &SecureEnvelope,
        now_unix_ms: i64,
    ) -> Result<(), ReplayError> {
        self.preflight(envelope, now_unix_ms)?;
        self.record(envelope);
        Ok(())
    }

    fn preflight(&self, envelope: &SecureEnvelope, now_unix_ms: i64) -> Result<(), ReplayError> {
        envelope.validate_header().map_err(ReplayError::Envelope)?;
        if envelope.route != self.route {
            return Err(ReplayError::WrongRoute);
        }
        self.validate_timestamp(envelope.sent_at_unix_ms, now_unix_ms)?;
        if self.accepted_nonces.contains(&envelope.nonce) {
            return Err(ReplayError::DuplicateNonce);
        }
        if self.accepted_sequences.contains_key(&envelope.sequence) {
            return Err(ReplayError::DuplicateSequence);
        }
        if let Some(highest_sequence) = self.highest_sequence {
            let minimum_sequence =
                minimum_sequence(highest_sequence, self.policy.sequence_window_size);
            if envelope.sequence < minimum_sequence {
                return Err(ReplayError::SequenceTooOld { minimum_sequence });
            }
        }
        Ok(())
    }

    fn validate_timestamp(
        &self,
        sent_at_unix_ms: i64,
        now_unix_ms: i64,
    ) -> Result<(), ReplayError> {
        if let Some(max_age_ms) = self.policy.max_message_age_ms {
            let age_bound = u64_to_i64_saturating(max_age_ms);
            if sent_at_unix_ms < now_unix_ms.saturating_sub(age_bound) {
                return Err(ReplayError::MessageExpired);
            }
        }
        let future_bound = u64_to_i64_saturating(self.policy.max_future_skew_ms);
        if sent_at_unix_ms > now_unix_ms.saturating_add(future_bound) {
            return Err(ReplayError::MessageFromFuture);
        }
        Ok(())
    }

    fn record(&mut self, envelope: &SecureEnvelope) {
        self.highest_sequence = Some(
            self.highest_sequence
                .map_or(envelope.sequence, |highest| highest.max(envelope.sequence)),
        );
        self.accepted_nonces.insert(envelope.nonce);
        self.accepted_sequences
            .insert(envelope.sequence, envelope.nonce);

        let highest_sequence = self.highest_sequence.unwrap_or(envelope.sequence);
        let minimum_sequence = minimum_sequence(highest_sequence, self.policy.sequence_window_size);
        let expired = self
            .accepted_sequences
            .range(..minimum_sequence)
            .map(|(sequence, nonce)| (*sequence, *nonce))
            .collect::<Vec<_>>();
        for (sequence, nonce) in expired {
            self.accepted_sequences.remove(&sequence);
            self.accepted_nonces.remove(&nonce);
        }
    }
}

/// Replay or freshness validation failure.
#[derive(Debug, thiserror::Error)]
pub enum ReplayError {
    #[error("invalid replay policy: {0}")]
    InvalidPolicy(&'static str),
    #[error("the envelope was malformed or could not be authenticated: {0}")]
    Envelope(#[source] EnvelopeError),
    #[error("the envelope does not belong to this incoming route")]
    WrongRoute,
    #[error("the envelope nonce has already been accepted")]
    DuplicateNonce,
    #[error("the envelope sequence has already been accepted")]
    DuplicateSequence,
    #[error(
        "the envelope sequence is older than the retained window starting at {minimum_sequence}"
    )]
    SequenceTooOld { minimum_sequence: u64 },
    #[error("the envelope timestamp is older than the allowed message age")]
    MessageExpired,
    #[error("the envelope timestamp is too far ahead of the local clock")]
    MessageFromFuture,
    #[error("the decrypted envelope JSON payload could not be deserialized: {0}")]
    DeserializePayload(#[source] serde_json::Error),
}

fn minimum_sequence(highest_sequence: u64, window_size: usize) -> u64 {
    let retained = u64::try_from(window_size.saturating_sub(1)).unwrap_or(u64::MAX);
    highest_sequence.saturating_sub(retained)
}

fn u64_to_i64_saturating(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DeviceId, SessionId};

    fn route() -> SessionRoute {
        SessionRoute::new(SessionId::new(), DeviceId::new(), DeviceId::new())
    }

    #[test]
    fn valid_envelope_is_accepted_once() {
        let route = route();
        let key = SessionKey::from_bytes([9_u8; 32]);
        let envelope =
            SecureEnvelope::seal(&key, route.clone(), 1, 1_000, &"hello").expect("seal envelope");
        let mut window = ReplayWindow::new(route);

        let value: String = window.open(&envelope, &key, 1_000).expect("first open");
        assert_eq!(value, "hello");
        assert!(matches!(
            window.open::<String>(&envelope, &key, 1_000),
            Err(ReplayError::DuplicateNonce)
        ));
    }

    #[test]
    fn invalid_ciphertext_does_not_consume_replay_state() {
        let route = route();
        let key = SessionKey::from_bytes([4_u8; 32]);
        let original = SecureEnvelope::seal_bytes(&key, route.clone(), 1, 1_000, b"hello")
            .expect("seal envelope");
        let mut tampered = original.clone();
        tampered.ciphertext = crate::Base64UrlBytes::new(b"invalid".to_vec());
        let mut window = ReplayWindow::new(route);

        assert!(matches!(
            window.open_bytes(&tampered, &key, 1_000),
            Err(ReplayError::Envelope(_))
        ));
        assert_eq!(
            window
                .open_bytes(&original, &key, 1_000)
                .expect("original remains acceptable"),
            b"hello"
        );
    }

    #[test]
    fn messages_outside_the_sequence_window_are_rejected() {
        let route = route();
        let key = SessionKey::from_bytes([5_u8; 32]);
        let mut window = ReplayWindow::with_policy(
            route.clone(),
            ReplayPolicy {
                sequence_window_size: 2,
                max_message_age_ms: None,
                max_future_skew_ms: 0,
            },
        )
        .expect("valid policy");
        let first = SecureEnvelope::seal_bytes(&key, route.clone(), 1, 1_000, b"first")
            .expect("first envelope");
        let third = SecureEnvelope::seal_bytes(&key, route.clone(), 3, 1_000, b"third")
            .expect("third envelope");
        window
            .open_bytes(&first, &key, 1_000)
            .expect("first accepted");
        window
            .open_bytes(&third, &key, 1_000)
            .expect("third accepted");

        let late_first = SecureEnvelope::seal_bytes(&key, route, 1, 1_000, b"late")
            .expect("late first envelope");
        assert!(matches!(
            window.open_bytes(&late_first, &key, 1_000),
            Err(ReplayError::SequenceTooOld {
                minimum_sequence: 2
            })
        ));
    }
}
