use crate::{DeviceId, SessionId, CURRENT_PROTOCOL_VERSION};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use hkdf::Hkdf;
use rand_core::OsRng;
use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use sha2::Sha256;
use std::fmt;
use subtle::ConstantTimeEq;
use x25519_dalek::{PublicKey, StaticSecret};

const KEY_LENGTH: usize = 32;
const SIGNATURE_LENGTH: usize = 64;
const SESSION_KEY_LABEL: &[u8] = b"somniq-remote/session-key/v1";

/// Cryptographic validation or key-agreement failure.
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("the Ed25519 public key is invalid")]
    InvalidSigningPublicKey,
    #[error("the Ed25519 signature did not verify")]
    SignatureVerificationFailed,
    #[error("a session key requires two distinct devices")]
    SameDeviceKeyAgreement,
    #[error("the X25519 shared secret was non-contributory")]
    NonContributorySharedSecret,
    #[error("the HKDF output length was rejected")]
    KeyDerivationFailed,
}

/// Public Ed25519 key used to identify and authenticate a paired device.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DevicePublicKey([u8; KEY_LENGTH]);

impl DevicePublicKey {
    /// Parses and validates a raw Ed25519 public key.
    pub fn from_bytes(bytes: [u8; KEY_LENGTH]) -> Result<Self, CryptoError> {
        VerifyingKey::from_bytes(&bytes).map_err(|_| CryptoError::InvalidSigningPublicKey)?;
        Ok(Self(bytes))
    }

    /// Returns the raw key bytes for a trusted keyring or native crypto bridge.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; KEY_LENGTH] {
        &self.0
    }

    /// Verifies a signature made by this device key.
    pub fn verify(&self, message: &[u8], signature: &DeviceSignature) -> Result<(), CryptoError> {
        let verifying_key =
            VerifyingKey::from_bytes(&self.0).map_err(|_| CryptoError::InvalidSigningPublicKey)?;
        let signature = Signature::from_bytes(&signature.0);
        verifying_key
            .verify(message, &signature)
            .map_err(|_| CryptoError::SignatureVerificationFailed)
    }
}

impl fmt::Debug for DevicePublicKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("DevicePublicKey")
            .field(&URL_SAFE_NO_PAD.encode(self.0))
            .finish()
    }
}

impl Serialize for DevicePublicKey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&URL_SAFE_NO_PAD.encode(self.0))
    }
}

impl<'de> Deserialize<'de> for DevicePublicKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let bytes = decode_fixed::<KEY_LENGTH, D>(deserializer)?;
        Self::from_bytes(bytes).map_err(D::Error::custom)
    }
}

/// Ed25519 signature encoded as unpadded base64url on the wire.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct DeviceSignature([u8; SIGNATURE_LENGTH]);

impl DeviceSignature {
    /// Returns the raw signature bytes for a native crypto bridge.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; SIGNATURE_LENGTH] {
        &self.0
    }
}

impl fmt::Debug for DeviceSignature {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("DeviceSignature")
            .field(&URL_SAFE_NO_PAD.encode(self.0))
            .finish()
    }
}

impl Serialize for DeviceSignature {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&URL_SAFE_NO_PAD.encode(self.0))
    }
}

impl<'de> Deserialize<'de> for DeviceSignature {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(Self(decode_fixed::<SIGNATURE_LENGTH, D>(deserializer)?))
    }
}

/// Long-lived Ed25519 secret key. Store its byte representation only in an OS
/// credential store; it is deliberately not serializable or printable.
#[derive(Clone)]
pub struct DeviceSigningKey(SigningKey);

impl DeviceSigningKey {
    /// Generates a new device signing key using the operating system CSPRNG.
    #[must_use]
    pub fn generate() -> Self {
        Self(SigningKey::generate(&mut OsRng))
    }

    /// Restores a key from a 32-byte seed stored in an OS credential store.
    #[must_use]
    pub fn from_bytes(bytes: [u8; KEY_LENGTH]) -> Self {
        Self(SigningKey::from_bytes(&bytes))
    }

    /// Returns the secret seed for storage in an OS credential store.
    #[must_use]
    pub fn to_bytes(&self) -> [u8; KEY_LENGTH] {
        self.0.to_bytes()
    }

    /// Returns the public identity key to include in a [`DeviceDescriptor`](crate::DeviceDescriptor).
    #[must_use]
    pub fn public_key(&self) -> DevicePublicKey {
        DevicePublicKey(self.0.verifying_key().to_bytes())
    }

    /// Signs bytes which have a protocol-defined, stable representation.
    #[must_use]
    pub fn sign(&self, message: &[u8]) -> DeviceSignature {
        DeviceSignature(self.0.sign(message).to_bytes())
    }
}

impl fmt::Debug for DeviceSigningKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DeviceSigningKey(REDACTED)")
    }
}

/// Public X25519 key used during the end-to-end session-key agreement.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct KeyAgreementPublicKey([u8; KEY_LENGTH]);

impl KeyAgreementPublicKey {
    /// Creates a public key wrapper from its 32-byte wire representation.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; KEY_LENGTH]) -> Self {
        Self(bytes)
    }

    /// Returns the raw public key bytes for a native crypto bridge.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; KEY_LENGTH] {
        &self.0
    }
}

impl fmt::Debug for KeyAgreementPublicKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("KeyAgreementPublicKey")
            .field(&URL_SAFE_NO_PAD.encode(self.0))
            .finish()
    }
}

impl Serialize for KeyAgreementPublicKey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&URL_SAFE_NO_PAD.encode(self.0))
    }
}

impl<'de> Deserialize<'de> for KeyAgreementPublicKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(Self(decode_fixed::<KEY_LENGTH, D>(deserializer)?))
    }
}

/// Long-lived X25519 secret key. Its public half is authenticated by the
/// device's Ed25519 signature during pairing.
pub struct KeyAgreementSecret(StaticSecret);

impl KeyAgreementSecret {
    /// Generates a new X25519 secret using the operating system CSPRNG.
    #[must_use]
    pub fn generate() -> Self {
        Self(StaticSecret::random_from_rng(OsRng))
    }

    /// Restores an X25519 secret from an OS credential store.
    #[must_use]
    pub fn from_bytes(bytes: [u8; KEY_LENGTH]) -> Self {
        Self(StaticSecret::from(bytes))
    }

    /// Returns the secret bytes for storage in an OS credential store.
    #[must_use]
    pub fn to_bytes(&self) -> [u8; KEY_LENGTH] {
        self.0.to_bytes()
    }

    /// Returns the matching public X25519 key.
    #[must_use]
    pub fn public_key(&self) -> KeyAgreementPublicKey {
        KeyAgreementPublicKey(PublicKey::from(&self.0).to_bytes())
    }

    /// Derives an AEAD session key using X25519 followed by HKDF-SHA256.
    pub fn derive_session_key(
        &self,
        peer: &KeyAgreementPublicKey,
        context: &SessionKeyContext,
    ) -> Result<SessionKey, CryptoError> {
        let shared_secret = self.0.diffie_hellman(&PublicKey::from(peer.0));
        if bool::from(
            shared_secret
                .as_bytes()
                .as_slice()
                .ct_eq(&[0_u8; KEY_LENGTH]),
        ) {
            return Err(CryptoError::NonContributorySharedSecret);
        }

        let hkdf = Hkdf::<Sha256>::new(None, shared_secret.as_bytes());
        let mut output = [0_u8; KEY_LENGTH];
        hkdf.expand(&context.info_bytes(), &mut output)
            .map_err(|_| CryptoError::KeyDerivationFailed)?;
        Ok(SessionKey(output))
    }
}

impl fmt::Debug for KeyAgreementSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("KeyAgreementSecret(REDACTED)")
    }
}

/// Symmetric 256-bit key used to authenticate and encrypt a remote session.
/// It is intentionally not serializable or printable.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionKey([u8; KEY_LENGTH]);

impl SessionKey {
    /// Restores a session key from a protected in-memory or OS-keystore value.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; KEY_LENGTH]) -> Self {
        Self(bytes)
    }

    /// Returns the session key bytes. Callers must not log or persist them in
    /// ordinary project data.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; KEY_LENGTH] {
        &self.0
    }
}

impl fmt::Debug for SessionKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionKey(REDACTED)")
    }
}

/// Context bound into HKDF so a shared secret cannot be reused across remote
/// sessions or different device pairs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionKeyContext {
    pub protocol_version: crate::ProtocolVersion,
    pub session_id: SessionId,
    pub first_device_id: DeviceId,
    pub second_device_id: DeviceId,
}

impl SessionKeyContext {
    /// Creates a canonical context. The two device IDs are sorted so both
    /// peers derive the same key even though they call this in opposite roles.
    pub fn new(
        session_id: SessionId,
        first_device_id: DeviceId,
        second_device_id: DeviceId,
    ) -> Result<Self, CryptoError> {
        if first_device_id == second_device_id {
            return Err(CryptoError::SameDeviceKeyAgreement);
        }
        let (first_device_id, second_device_id) = if first_device_id < second_device_id {
            (first_device_id, second_device_id)
        } else {
            (second_device_id, first_device_id)
        };
        Ok(Self {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            session_id,
            first_device_id,
            second_device_id,
        })
    }

    fn info_bytes(&self) -> Vec<u8> {
        format!(
            "{}\0{}\0{}\0{}\0{}",
            String::from_utf8_lossy(SESSION_KEY_LABEL),
            self.protocol_version.as_u16(),
            self.session_id,
            self.first_device_id,
            self.second_device_id
        )
        .into_bytes()
    }
}

fn decode_fixed<'de, const LENGTH: usize, D>(deserializer: D) -> Result<[u8; LENGTH], D::Error>
where
    D: Deserializer<'de>,
{
    let encoded = String::deserialize(deserializer)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(D::Error::custom)?;
    decoded
        .try_into()
        .map_err(|_: Vec<u8>| D::Error::custom(format!("expected {LENGTH} bytes")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::RngCore;

    #[test]
    fn paired_devices_derive_the_same_session_key() {
        let desktop_id = DeviceId::new();
        let mobile_id = DeviceId::new();
        let context = SessionKeyContext::new(SessionId::new(), desktop_id, mobile_id)
            .expect("distinct devices");
        let desktop_secret = KeyAgreementSecret::generate();
        let mobile_secret = KeyAgreementSecret::generate();

        let desktop_key = desktop_secret
            .derive_session_key(&mobile_secret.public_key(), &context)
            .expect("desktop derivation");
        let mobile_key = mobile_secret
            .derive_session_key(&desktop_secret.public_key(), &context)
            .expect("mobile derivation");

        assert_eq!(desktop_key, mobile_key);
    }

    #[test]
    fn device_signatures_are_verified_by_the_public_key() {
        let signing_key = DeviceSigningKey::generate();
        let signature = signing_key.sign(b"pairing-proof");
        signing_key
            .public_key()
            .verify(b"pairing-proof", &signature)
            .expect("signature should verify");
        assert!(signing_key
            .public_key()
            .verify(b"different-proof", &signature)
            .is_err());
    }

    #[test]
    fn public_keys_round_trip_as_base64url() {
        let public_key = DeviceSigningKey::generate().public_key();
        let json = serde_json::to_string(&public_key).expect("serialize key");
        let decoded: DevicePublicKey = serde_json::from_str(&json).expect("deserialize key");
        assert_eq!(decoded, public_key);
    }

    #[test]
    fn random_generation_uses_distinct_values() {
        let mut left = [0_u8; KEY_LENGTH];
        let mut right = [0_u8; KEY_LENGTH];
        OsRng.fill_bytes(&mut left);
        OsRng.fill_bytes(&mut right);
        assert_ne!(left, right);
    }
}
