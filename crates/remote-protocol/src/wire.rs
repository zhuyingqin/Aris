use crate::{DeviceId, SessionId, SessionKey};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand_core::{OsRng, RngCore};
use serde::{
    de::DeserializeOwned, de::Error as _, Deserialize, Deserializer, Serialize, Serializer,
};
use std::fmt;

const ENVELOPE_NONCE_LENGTH: usize = 24;
const AEAD_TAG_LENGTH: usize = 16;
const ENVELOPE_AAD_LABEL: &[u8] = b"somniq-remote/envelope/v1\0";

/// The only protocol version accepted by this crate.
pub const CURRENT_PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion(1);

/// Version carried by every pairing, control, and encrypted-envelope message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProtocolVersion(u16);

impl ProtocolVersion {
    /// Returns the numeric version for logs and cross-platform implementations.
    #[must_use]
    pub const fn as_u16(self) -> u16 {
        self.0
    }

    /// Returns whether this build understands this exact wire version.
    #[must_use]
    pub const fn is_supported(self) -> bool {
        self.0 == CURRENT_PROTOCOL_VERSION.0
    }
}

impl Default for ProtocolVersion {
    fn default() -> Self {
        CURRENT_PROTOCOL_VERSION
    }
}

impl fmt::Display for ProtocolVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Binary data represented as unpadded base64url in JSON wire messages.
#[derive(Clone, PartialEq, Eq, Hash, Default)]
pub struct Base64UrlBytes(Vec<u8>);

impl Base64UrlBytes {
    /// Creates a wire byte container from binary data.
    #[must_use]
    pub fn new(bytes: impl Into<Vec<u8>>) -> Self {
        Self(bytes.into())
    }

    /// Views the contained bytes without copying them.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    /// Consumes the container and returns the contained bytes.
    #[must_use]
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}

impl fmt::Debug for Base64UrlBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("Base64UrlBytes")
            .field(&format_args!("{} bytes", self.0.len()))
            .finish()
    }
}

impl Serialize for Base64UrlBytes {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&URL_SAFE_NO_PAD.encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for Base64UrlBytes {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = String::deserialize(deserializer)?;
        URL_SAFE_NO_PAD
            .decode(encoded.as_bytes())
            .map(Self)
            .map_err(D::Error::custom)
    }
}

/// Random 192-bit `XChaCha20` nonce. It is not secret, but it must never be
/// reused with the same [`SessionKey`].
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct EnvelopeNonce([u8; ENVELOPE_NONCE_LENGTH]);

impl EnvelopeNonce {
    fn generate() -> Self {
        let mut bytes = [0_u8; ENVELOPE_NONCE_LENGTH];
        OsRng.fill_bytes(&mut bytes);
        Self(bytes)
    }

    /// Returns nonce bytes for diagnostics or a native crypto bridge.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; ENVELOPE_NONCE_LENGTH] {
        &self.0
    }
}

impl fmt::Debug for EnvelopeNonce {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("EnvelopeNonce")
            .field(&URL_SAFE_NO_PAD.encode(self.0))
            .finish()
    }
}

impl Serialize for EnvelopeNonce {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&URL_SAFE_NO_PAD.encode(self.0))
    }
}

impl<'de> Deserialize<'de> for EnvelopeNonce {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = String::deserialize(deserializer)?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded.as_bytes())
            .map_err(D::Error::custom)?;
        bytes.try_into().map(Self).map_err(|_: Vec<u8>| {
            D::Error::custom(format!("expected {ENVELOPE_NONCE_LENGTH} nonce bytes"))
        })
    }
}

/// Fixed routing metadata authenticated as AEAD associated data. The relay may
/// use it to forward a ciphertext but cannot alter it undetected.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRoute {
    pub session_id: SessionId,
    pub sender_device_id: DeviceId,
    pub recipient_device_id: DeviceId,
}

impl SessionRoute {
    /// Creates a route for one direction of a paired session.
    #[must_use]
    pub const fn new(
        session_id: SessionId,
        sender_device_id: DeviceId,
        recipient_device_id: DeviceId,
    ) -> Self {
        Self {
            session_id,
            sender_device_id,
            recipient_device_id,
        }
    }

    /// Returns the same session in the opposite direction.
    #[must_use]
    pub const fn reversed(&self) -> Self {
        Self::new(
            self.session_id,
            self.recipient_device_id,
            self.sender_device_id,
        )
    }
}

/// Error while validating or opening an encrypted envelope.
#[derive(Debug, thiserror::Error)]
pub enum EnvelopeError {
    #[error("unsupported remote protocol version {received}")]
    UnsupportedProtocol { received: ProtocolVersion },
    #[error("an envelope route must use two distinct devices")]
    InvalidRoute,
    #[error("an envelope sequence must start at one")]
    InvalidSequence,
    #[error("an envelope ciphertext is shorter than an AEAD authentication tag")]
    TruncatedCiphertext,
    #[error("unable to encrypt the remote envelope")]
    EncryptionFailed,
    #[error("the remote envelope could not be authenticated or decrypted")]
    DecryptionFailed,
    #[error("the envelope JSON payload could not be serialized: {0}")]
    SerializePayload(#[source] serde_json::Error),
    #[error("the envelope JSON payload could not be deserialized: {0}")]
    DeserializePayload(#[source] serde_json::Error),
}

/// End-to-end encrypted control payload. Its public header is authenticated;
/// its payload is encrypted with XChaCha20-Poly1305.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecureEnvelope {
    pub protocol_version: ProtocolVersion,
    pub route: SessionRoute,
    pub sequence: u64,
    pub sent_at_unix_ms: i64,
    pub nonce: EnvelopeNonce,
    pub ciphertext: Base64UrlBytes,
}

impl SecureEnvelope {
    /// Encrypts raw bytes and authenticates all envelope metadata.
    pub fn seal_bytes(
        session_key: &SessionKey,
        route: SessionRoute,
        sequence: u64,
        sent_at_unix_ms: i64,
        plaintext: &[u8],
    ) -> Result<Self, EnvelopeError> {
        let mut envelope = Self {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            route,
            sequence,
            sent_at_unix_ms,
            nonce: EnvelopeNonce::generate(),
            ciphertext: Base64UrlBytes::default(),
        };
        envelope.validate_header()?;

        let cipher = XChaCha20Poly1305::new_from_slice(session_key.as_bytes())
            .map_err(|_| EnvelopeError::EncryptionFailed)?;
        let encrypted = cipher
            .encrypt(
                XNonce::from_slice(&envelope.nonce.0),
                Payload {
                    msg: plaintext,
                    aad: &envelope.authenticated_data(),
                },
            )
            .map_err(|_| EnvelopeError::EncryptionFailed)?;
        envelope.ciphertext = Base64UrlBytes::new(encrypted);
        Ok(envelope)
    }

    /// Serializes a payload as JSON, then encrypts it end-to-end.
    pub fn seal<T: Serialize>(
        session_key: &SessionKey,
        route: SessionRoute,
        sequence: u64,
        sent_at_unix_ms: i64,
        payload: &T,
    ) -> Result<Self, EnvelopeError> {
        let payload = serde_json::to_vec(payload).map_err(EnvelopeError::SerializePayload)?;
        Self::seal_bytes(session_key, route, sequence, sent_at_unix_ms, &payload)
    }

    /// Decrypts an envelope into raw bytes. Callers should pass the envelope to
    /// [`ReplayWindow`](crate::ReplayWindow) after a successful open, or use
    /// [`ReplayWindow::open_bytes`](crate::ReplayWindow::open_bytes).
    pub fn open_bytes(&self, session_key: &SessionKey) -> Result<Vec<u8>, EnvelopeError> {
        self.validate_header()?;
        let cipher = XChaCha20Poly1305::new_from_slice(session_key.as_bytes())
            .map_err(|_| EnvelopeError::DecryptionFailed)?;
        cipher
            .decrypt(
                XNonce::from_slice(&self.nonce.0),
                Payload {
                    msg: self.ciphertext.as_bytes(),
                    aad: &self.authenticated_data(),
                },
            )
            .map_err(|_| EnvelopeError::DecryptionFailed)
    }

    /// Decrypts and deserializes a JSON payload.
    pub fn open<T: DeserializeOwned>(&self, session_key: &SessionKey) -> Result<T, EnvelopeError> {
        let bytes = self.open_bytes(session_key)?;
        serde_json::from_slice(&bytes).map_err(EnvelopeError::DeserializePayload)
    }

    pub(crate) fn validate_header(&self) -> Result<(), EnvelopeError> {
        if !self.protocol_version.is_supported() {
            return Err(EnvelopeError::UnsupportedProtocol {
                received: self.protocol_version,
            });
        }
        if self.route.sender_device_id == self.route.recipient_device_id {
            return Err(EnvelopeError::InvalidRoute);
        }
        if self.sequence == 0 {
            return Err(EnvelopeError::InvalidSequence);
        }
        if self.ciphertext.as_bytes().len() < AEAD_TAG_LENGTH
            && !self.ciphertext.as_bytes().is_empty()
        {
            return Err(EnvelopeError::TruncatedCiphertext);
        }
        Ok(())
    }

    fn authenticated_data(&self) -> Vec<u8> {
        let mut data = Vec::with_capacity(ENVELOPE_AAD_LABEL.len() + 2 + 16 * 3 + 8 + 8);
        data.extend_from_slice(ENVELOPE_AAD_LABEL);
        data.extend_from_slice(&self.protocol_version.as_u16().to_be_bytes());
        data.extend_from_slice(self.route.session_id.as_uuid().as_bytes());
        data.extend_from_slice(self.route.sender_device_id.as_uuid().as_bytes());
        data.extend_from_slice(self.route.recipient_device_id.as_uuid().as_bytes());
        data.extend_from_slice(&self.sequence.to_be_bytes());
        data.extend_from_slice(&self.sent_at_unix_ms.to_be_bytes());
        data
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips_and_header_tampering_fails() {
        let route = SessionRoute::new(SessionId::new(), DeviceId::new(), DeviceId::new());
        let key = SessionKey::from_bytes([7_u8; 32]);
        let envelope =
            SecureEnvelope::seal(&key, route.clone(), 1, 42, &"hello").expect("seal envelope");
        let value: String = envelope.open(&key).expect("open envelope");
        assert_eq!(value, "hello");

        let mut tampered = envelope;
        tampered.route = route.reversed();
        assert!(tampered.open::<String>(&key).is_err());
    }

    #[test]
    fn envelope_json_uses_strings_for_binary_values() {
        let envelope = SecureEnvelope::seal_bytes(
            &SessionKey::from_bytes([3_u8; 32]),
            SessionRoute::new(SessionId::new(), DeviceId::new(), DeviceId::new()),
            1,
            1,
            b"payload",
        )
        .expect("seal envelope");
        let value = serde_json::to_value(&envelope).expect("serialize envelope");
        assert!(value["nonce"].is_string());
        assert!(value["ciphertext"].is_string());
    }

    #[test]
    fn zero_sequence_is_rejected() {
        let error = SecureEnvelope::seal_bytes(
            &SessionKey::from_bytes([3_u8; 32]),
            SessionRoute::new(SessionId::new(), DeviceId::new(), DeviceId::new()),
            0,
            1,
            b"payload",
        )
        .expect_err("zero sequence should fail");
        assert!(matches!(error, EnvelopeError::InvalidSequence));
    }
}
