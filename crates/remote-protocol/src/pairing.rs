use crate::{
    CryptoError, DeviceId, DevicePublicKey, DeviceScope, DeviceScopes, DeviceSignature,
    DeviceSigningKey, KeyAgreementPublicKey, PairingId, SessionId, CURRENT_PROTOCOL_VERSION,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand_core::{OsRng, RngCore};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest as _, Sha256};
use std::fmt;
use subtle::ConstantTimeEq;
use url::Url;

const PAIRING_SECRET_LENGTH: usize = 32;
const PAIRING_REQUEST_LABEL: &[u8] = b"somniq-remote/pairing-request/v1\0";
const PAIRING_APPROVAL_LABEL: &[u8] = b"somniq-remote/pairing-approval/v1\0";
const MAX_DEVICE_NAME_BYTES: usize = 128;
const MAX_GATEWAY_URL_BYTES: usize = 2_048;

/// Kind of endpoint taking part in device pairing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Desktop,
    Mobile,
    ComputeNode,
}

impl DeviceKind {
    const fn wire_code(self) -> u8 {
        match self {
            Self::Desktop => 1,
            Self::Mobile => 2,
            Self::ComputeNode => 3,
        }
    }
}

/// Public device identity advertised during a pairing ceremony. Its X25519
/// key is authenticated by the device's Ed25519 proof in [`PairingRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceDescriptor {
    pub device_id: DeviceId,
    pub kind: DeviceKind,
    pub display_name: String,
    pub signing_public_key: DevicePublicKey,
    pub key_agreement_public_key: KeyAgreementPublicKey,
}

impl DeviceDescriptor {
    /// Creates a validated descriptor suitable for pairing and local audit logs.
    pub fn new(
        device_id: DeviceId,
        kind: DeviceKind,
        display_name: impl Into<String>,
        signing_public_key: DevicePublicKey,
        key_agreement_public_key: KeyAgreementPublicKey,
    ) -> Result<Self, PairingError> {
        let descriptor = Self {
            device_id,
            kind,
            display_name: display_name.into(),
            signing_public_key,
            key_agreement_public_key,
        };
        descriptor.validate()?;
        Ok(descriptor)
    }

    /// Validates limits that keep signed pairing transcripts deterministic and
    /// bounded before a server or desktop allocates state for them.
    pub fn validate(&self) -> Result<(), PairingError> {
        let name = self.display_name.trim();
        if name.is_empty() {
            return Err(PairingError::InvalidDeviceDescriptor(
                "the display name is empty",
            ));
        }
        if self.display_name.len() > MAX_DEVICE_NAME_BYTES {
            return Err(PairingError::InvalidDeviceDescriptor(
                "the display name is too long",
            ));
        }
        if self.display_name.chars().any(char::is_control) {
            return Err(PairingError::InvalidDeviceDescriptor(
                "the display name contains a control character",
            ));
        }
        Ok(())
    }

    fn append_signature_bytes(&self, output: &mut Vec<u8>) -> Result<(), PairingError> {
        self.validate()?;
        output.extend_from_slice(self.device_id.as_uuid().as_bytes());
        output.push(self.kind.wire_code());
        append_string(output, &self.display_name)?;
        output.extend_from_slice(self.signing_public_key.as_bytes());
        output.extend_from_slice(self.key_agreement_public_key.as_bytes());
        Ok(())
    }
}

/// One high-entropy, single-use QR secret. Gateways should only persist its
/// [`PairingSecretDigest`], not this value.
#[derive(Clone, PartialEq, Eq)]
pub struct PairingSecret([u8; PAIRING_SECRET_LENGTH]);

impl PairingSecret {
    /// Generates a 256-bit pairing secret with the operating-system CSPRNG.
    #[must_use]
    pub fn generate() -> Self {
        let mut bytes = [0_u8; PAIRING_SECRET_LENGTH];
        OsRng.fill_bytes(&mut bytes);
        Self(bytes)
    }

    /// Hashes the secret for short-lived gateway-side lookup and comparison.
    #[must_use]
    pub fn digest(&self) -> PairingSecretDigest {
        PairingSecretDigest(Sha256::digest(self.0).into())
    }

    /// Constant-time comparison against a digest held by the gateway.
    #[must_use]
    pub fn matches_digest(&self, expected: &PairingSecretDigest) -> bool {
        bool::from(self.digest().0.ct_eq(&expected.0))
    }
}

impl fmt::Debug for PairingSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PairingSecret(REDACTED)")
    }
}

impl Serialize for PairingSecret {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&URL_SAFE_NO_PAD.encode(self.0))
    }
}

impl<'de> Deserialize<'de> for PairingSecret {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        decode_pairing_secret(deserializer).map(Self)
    }
}

/// SHA-256 digest of a [`PairingSecret`]. It is safe to store for the brief
/// life of the pairing invitation because the original secret is 256-bit.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct PairingSecretDigest([u8; PAIRING_SECRET_LENGTH]);

impl PairingSecretDigest {
    /// Returns digest bytes for a gateway persistence adapter.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; PAIRING_SECRET_LENGTH] {
        &self.0
    }
}

impl fmt::Debug for PairingSecretDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("PairingSecretDigest")
            .field(&URL_SAFE_NO_PAD.encode(self.0))
            .finish()
    }
}

impl Serialize for PairingSecretDigest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&URL_SAFE_NO_PAD.encode(self.0))
    }
}

impl<'de> Deserialize<'de> for PairingSecretDigest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        decode_pairing_secret(deserializer).map(Self)
    }
}

/// QR-shareable invitation. The desktop must register its secret digest with
/// the gateway before showing this to a mobile device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairingInvitation {
    pub protocol_version: crate::ProtocolVersion,
    pub pairing_id: PairingId,
    pub desktop: DeviceDescriptor,
    pub gateway_url: String,
    pub pairing_secret: PairingSecret,
    pub expires_at_unix_ms: i64,
}

impl PairingInvitation {
    /// Generates a new pairing ID and secret for a short-lived QR invitation.
    pub fn new(
        desktop: DeviceDescriptor,
        gateway_url: impl Into<String>,
        expires_at_unix_ms: i64,
    ) -> Result<Self, PairingError> {
        let invitation = Self {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            pairing_id: PairingId::new(),
            desktop,
            gateway_url: gateway_url.into(),
            pairing_secret: PairingSecret::generate(),
            expires_at_unix_ms,
        };
        invitation.validate_shape()?;
        Ok(invitation)
    }

    /// Returns whether the invitation may no longer be used at the given time.
    #[must_use]
    pub const fn is_expired_at(&self, now_unix_ms: i64) -> bool {
        now_unix_ms >= self.expires_at_unix_ms
    }

    /// Checks version, endpoint, and expiry before creating pairing state.
    pub fn validate_at(&self, now_unix_ms: i64) -> Result<(), PairingError> {
        self.validate_shape()?;
        if self.is_expired_at(now_unix_ms) {
            return Err(PairingError::InvitationExpired);
        }
        Ok(())
    }

    fn validate_shape(&self) -> Result<(), PairingError> {
        if !self.protocol_version.is_supported() {
            return Err(PairingError::UnsupportedProtocol {
                received: self.protocol_version,
            });
        }
        self.desktop.validate()?;
        if self.desktop.kind != DeviceKind::Desktop {
            return Err(PairingError::InvalidDeviceDescriptor(
                "a pairing invitation must identify a desktop device",
            ));
        }
        let gateway_url = self.gateway_url.trim();
        if gateway_url.is_empty() || gateway_url.len() > MAX_GATEWAY_URL_BYTES {
            return Err(PairingError::InvalidGatewayUrl);
        }
        let parsed = Url::parse(gateway_url).map_err(|_| PairingError::InvalidGatewayUrl)?;
        if parsed.username() != ""
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(PairingError::InvalidGatewayUrl);
        }
        let is_exact_loopback_host = matches!(
            parsed.host(),
            Some(
                url::Host::Domain("localhost")
                    | url::Host::Ipv4(std::net::Ipv4Addr::LOCALHOST)
                    | url::Host::Ipv6(std::net::Ipv6Addr::LOCALHOST)
            )
        );
        let is_loopback_development =
            is_exact_loopback_host && matches!(parsed.scheme(), "http" | "ws");
        if !matches!(parsed.scheme(), "https" | "wss") && !is_loopback_development {
            return Err(PairingError::InvalidGatewayUrl);
        }
        Ok(())
    }
}

/// Mobile device's signed request to join a pairing invitation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairingRequest {
    pub protocol_version: crate::ProtocolVersion,
    pub pairing_id: PairingId,
    pub pairing_secret: PairingSecret,
    pub mobile: DeviceDescriptor,
    pub requested_scopes: DeviceScopes,
    pub requested_at_unix_ms: i64,
    pub proof: DeviceSignature,
}

impl PairingRequest {
    /// Creates a request whose proof binds the invitation, the complete mobile
    /// descriptor, requested scopes, and request time.
    pub fn signed(
        invitation: &PairingInvitation,
        mobile: DeviceDescriptor,
        requested_scopes: DeviceScopes,
        requested_at_unix_ms: i64,
        mobile_signing_key: &DeviceSigningKey,
    ) -> Result<Self, PairingError> {
        invitation.validate_at(requested_at_unix_ms)?;
        mobile.validate()?;
        if !matches!(mobile.kind, DeviceKind::Mobile | DeviceKind::ComputeNode) {
            return Err(PairingError::InvalidDeviceDescriptor(
                "a pairing request must identify a mobile or compute-node device",
            ));
        }
        validate_scope_profile(mobile.kind, &requested_scopes)?;
        if mobile.device_id == invitation.desktop.device_id {
            return Err(PairingError::SameDevicePairing);
        }
        if mobile.signing_public_key != mobile_signing_key.public_key() {
            return Err(PairingError::MobileSigningKeyMismatch);
        }

        let mut request = Self {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            pairing_id: invitation.pairing_id,
            pairing_secret: invitation.pairing_secret.clone(),
            mobile,
            requested_scopes,
            requested_at_unix_ms,
            proof: mobile_signing_key.sign(b"placeholder"),
        };
        request.proof = mobile_signing_key.sign(&request.signature_transcript()?);
        Ok(request)
    }

    /// Verifies the mobile's identity proof without creating durable state.
    pub fn verify_proof(&self) -> Result<(), PairingError> {
        if !self.protocol_version.is_supported() {
            return Err(PairingError::UnsupportedProtocol {
                received: self.protocol_version,
            });
        }
        self.mobile.validate()?;
        if !matches!(
            self.mobile.kind,
            DeviceKind::Mobile | DeviceKind::ComputeNode
        ) {
            return Err(PairingError::InvalidDeviceDescriptor(
                "a pairing request must identify a mobile or compute-node device",
            ));
        }
        validate_scope_profile(self.mobile.kind, &self.requested_scopes)?;
        self.mobile
            .signing_public_key
            .verify(&self.signature_transcript()?, &self.proof)
            .map_err(PairingError::InvalidRequestProof)
    }

    /// Verifies a request against the original QR invitation. The gateway can
    /// use this after checking a stored digest, and the desktop can use it
    /// before presenting its local approval prompt.
    pub fn verify_against_invitation(
        &self,
        invitation: &PairingInvitation,
        now_unix_ms: i64,
    ) -> Result<(), PairingError> {
        invitation.validate_at(now_unix_ms)?;
        self.verify_proof()?;
        if self.pairing_id != invitation.pairing_id {
            return Err(PairingError::PairingIdMismatch);
        }
        if !self
            .pairing_secret
            .matches_digest(&invitation.pairing_secret.digest())
        {
            return Err(PairingError::PairingSecretMismatch);
        }
        if self.mobile.device_id == invitation.desktop.device_id {
            return Err(PairingError::SameDevicePairing);
        }
        Ok(())
    }

    /// Verifies a request using only the pairing record fields a gateway should
    /// retain: its ID and SHA-256 secret digest. The gateway remains
    /// responsible for checking the record's expiry and single-use state.
    pub fn verify_against_registered_invitation(
        &self,
        pairing_id: PairingId,
        expected_secret_digest: &PairingSecretDigest,
    ) -> Result<(), PairingError> {
        self.verify_proof()?;
        if self.pairing_id != pairing_id {
            return Err(PairingError::PairingIdMismatch);
        }
        if !self.pairing_secret.matches_digest(expected_secret_digest) {
            return Err(PairingError::PairingSecretMismatch);
        }
        Ok(())
    }

    fn signature_transcript(&self) -> Result<Vec<u8>, PairingError> {
        let mut output = Vec::with_capacity(256);
        output.extend_from_slice(PAIRING_REQUEST_LABEL);
        output.extend_from_slice(&self.protocol_version.as_u16().to_be_bytes());
        output.extend_from_slice(self.pairing_id.as_uuid().as_bytes());
        output.extend_from_slice(self.pairing_secret.digest().as_bytes());
        self.mobile.append_signature_bytes(&mut output)?;
        append_scopes(&mut output, &self.requested_scopes)?;
        output.extend_from_slice(&self.requested_at_unix_ms.to_be_bytes());
        Ok(output)
    }
}

/// Desktop's explicit, signed grant of a constrained scope set to a mobile
/// device. The approval itself is not a bearer token; the gateway should bind
/// it to a registered paired-device record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairingApproval {
    pub protocol_version: crate::ProtocolVersion,
    pub pairing_id: PairingId,
    pub desktop_device_id: DeviceId,
    pub mobile: DeviceDescriptor,
    pub session_id: SessionId,
    pub granted_scopes: DeviceScopes,
    pub approved_at_unix_ms: i64,
    pub proof: DeviceSignature,
}

impl PairingApproval {
    /// Creates a signed approval after the desktop has shown the local user a
    /// reviewable confirmation UI.
    pub fn approve(
        invitation: &PairingInvitation,
        request: &PairingRequest,
        session_id: SessionId,
        granted_scopes: DeviceScopes,
        approved_at_unix_ms: i64,
        desktop_signing_key: &DeviceSigningKey,
    ) -> Result<Self, PairingError> {
        request.verify_against_invitation(invitation, approved_at_unix_ms)?;
        if invitation.desktop.signing_public_key != desktop_signing_key.public_key() {
            return Err(PairingError::DesktopSigningKeyMismatch);
        }
        if !granted_scopes.is_subset_of(&request.requested_scopes) {
            return Err(PairingError::ScopeEscalation);
        }
        validate_scope_profile(request.mobile.kind, &granted_scopes)?;
        let mut approval = Self {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            pairing_id: invitation.pairing_id,
            desktop_device_id: invitation.desktop.device_id,
            mobile: request.mobile.clone(),
            session_id,
            granted_scopes,
            approved_at_unix_ms,
            proof: desktop_signing_key.sign(b"placeholder"),
        };
        approval.proof = desktop_signing_key.sign(&approval.signature_transcript()?);
        Ok(approval)
    }

    /// Verifies that the trusted desktop issued this exact constrained grant.
    pub fn verify_proof(&self, desktop: &DeviceDescriptor) -> Result<(), PairingError> {
        if !self.protocol_version.is_supported() {
            return Err(PairingError::UnsupportedProtocol {
                received: self.protocol_version,
            });
        }
        desktop.validate()?;
        self.mobile.validate()?;
        if desktop.kind != DeviceKind::Desktop {
            return Err(PairingError::InvalidDeviceDescriptor(
                "a pairing approval must be verified against a desktop device",
            ));
        }
        if self.desktop_device_id != desktop.device_id {
            return Err(PairingError::DesktopIdentityMismatch);
        }
        if !matches!(
            self.mobile.kind,
            DeviceKind::Mobile | DeviceKind::ComputeNode
        ) {
            return Err(PairingError::InvalidDeviceDescriptor(
                "a pairing approval must identify a mobile or compute-node device",
            ));
        }
        validate_scope_profile(self.mobile.kind, &self.granted_scopes)?;
        desktop
            .signing_public_key
            .verify(&self.signature_transcript()?, &self.proof)
            .map_err(PairingError::InvalidApprovalProof)
    }

    fn signature_transcript(&self) -> Result<Vec<u8>, PairingError> {
        let mut output = Vec::with_capacity(256);
        output.extend_from_slice(PAIRING_APPROVAL_LABEL);
        output.extend_from_slice(&self.protocol_version.as_u16().to_be_bytes());
        output.extend_from_slice(self.pairing_id.as_uuid().as_bytes());
        output.extend_from_slice(self.desktop_device_id.as_uuid().as_bytes());
        self.mobile.append_signature_bytes(&mut output)?;
        output.extend_from_slice(self.session_id.as_uuid().as_bytes());
        append_scopes(&mut output, &self.granted_scopes)?;
        output.extend_from_slice(&self.approved_at_unix_ms.to_be_bytes());
        Ok(output)
    }
}

/// Pairing validation failure. A caller should audit the stable error category
/// but never log a [`PairingSecret`] or encrypted control payload.
#[derive(Debug, thiserror::Error)]
pub enum PairingError {
    #[error("unsupported remote protocol version {received}")]
    UnsupportedProtocol { received: crate::ProtocolVersion },
    #[error("the pairing invitation has expired")]
    InvitationExpired,
    #[error("the pairing gateway URL is invalid")]
    InvalidGatewayUrl,
    #[error("the device descriptor is invalid: {0}")]
    InvalidDeviceDescriptor(&'static str),
    #[error("the mobile descriptor does not match its signing key")]
    MobileSigningKeyMismatch,
    #[error("the desktop descriptor does not match its signing key")]
    DesktopSigningKeyMismatch,
    #[error("a device cannot pair with itself")]
    SameDevicePairing,
    #[error("the pairing request refers to a different invitation")]
    PairingIdMismatch,
    #[error("the pairing secret does not match the invitation")]
    PairingSecretMismatch,
    #[error("the desktop identity in the approval is not the expected desktop")]
    DesktopIdentityMismatch,
    #[error("the request proof is invalid: {0}")]
    InvalidRequestProof(#[source] CryptoError),
    #[error("the approval proof is invalid: {0}")]
    InvalidApprovalProof(#[source] CryptoError),
    #[error("the desktop cannot grant a scope that the mobile did not request")]
    ScopeEscalation,
    #[error("the requested scopes do not match the device kind")]
    InvalidScopeProfile,
    #[error("a signed transcript field is too long")]
    TranscriptFieldTooLong,
}

fn validate_scope_profile(kind: DeviceKind, scopes: &DeviceScopes) -> Result<(), PairingError> {
    match kind {
        DeviceKind::Mobile if scopes.contains(DeviceScope::ComputeJobs) => {
            Err(PairingError::InvalidScopeProfile)
        }
        DeviceKind::ComputeNode
            if scopes.len() != 1 || !scopes.contains(DeviceScope::ComputeJobs) =>
        {
            Err(PairingError::InvalidScopeProfile)
        }
        DeviceKind::Desktop => Err(PairingError::InvalidScopeProfile),
        DeviceKind::Mobile | DeviceKind::ComputeNode => Ok(()),
    }
}

fn append_string(output: &mut Vec<u8>, value: &str) -> Result<(), PairingError> {
    let length = u16::try_from(value.len()).map_err(|_| PairingError::TranscriptFieldTooLong)?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn append_scopes(output: &mut Vec<u8>, scopes: &DeviceScopes) -> Result<(), PairingError> {
    output.push(u8::try_from(scopes.len()).map_err(|_| PairingError::TranscriptFieldTooLong)?);
    for scope in scopes.iter() {
        output.push(scope.wire_code());
    }
    Ok(())
}

fn decode_pairing_secret<'de, D>(deserializer: D) -> Result<[u8; PAIRING_SECRET_LENGTH], D::Error>
where
    D: Deserializer<'de>,
{
    let encoded = String::deserialize(deserializer)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(D::Error::custom)?;
    decoded.try_into().map_err(|_: Vec<u8>| {
        D::Error::custom(format!(
            "expected {PAIRING_SECRET_LENGTH} pairing-secret bytes"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DeviceScope, KeyAgreementSecret};

    fn descriptor(
        device_id: DeviceId,
        kind: DeviceKind,
        name: &str,
        signing: &DeviceSigningKey,
        agreement: &KeyAgreementSecret,
    ) -> DeviceDescriptor {
        DeviceDescriptor::new(
            device_id,
            kind,
            name,
            signing.public_key(),
            agreement.public_key(),
        )
        .expect("valid device descriptor")
    }

    #[test]
    fn pairing_request_and_approval_verify_end_to_end() {
        let desktop_signing = DeviceSigningKey::generate();
        let desktop_agreement = KeyAgreementSecret::generate();
        let desktop = descriptor(
            DeviceId::new(),
            DeviceKind::Desktop,
            "Research workstation",
            &desktop_signing,
            &desktop_agreement,
        );
        let invitation =
            PairingInvitation::new(desktop.clone(), "https://remote.example.test", 2_000)
                .expect("invitation");

        let mobile_signing = DeviceSigningKey::generate();
        let mobile_agreement = KeyAgreementSecret::generate();
        let mobile = descriptor(
            DeviceId::new(),
            DeviceKind::Mobile,
            "My phone",
            &mobile_signing,
            &mobile_agreement,
        );
        let requested = DeviceScopes::from([DeviceScope::ReadProjectState, DeviceScope::StopRuns]);
        let request = PairingRequest::signed(
            &invitation,
            mobile,
            requested.clone(),
            1_000,
            &mobile_signing,
        )
        .expect("request");
        request
            .verify_against_invitation(&invitation, 1_001)
            .expect("request proof");
        request
            .verify_against_registered_invitation(
                invitation.pairing_id,
                &invitation.pairing_secret.digest(),
            )
            .expect("gateway digest verification");

        let approval = PairingApproval::approve(
            &invitation,
            &request,
            SessionId::new(),
            requested,
            1_500,
            &desktop_signing,
        )
        .expect("approval");
        approval.verify_proof(&desktop).expect("approval proof");
    }

    #[test]
    fn approvals_cannot_escalate_requested_scopes() {
        let desktop_signing = DeviceSigningKey::generate();
        let desktop_agreement = KeyAgreementSecret::generate();
        let desktop = descriptor(
            DeviceId::new(),
            DeviceKind::Desktop,
            "Desktop",
            &desktop_signing,
            &desktop_agreement,
        );
        let invitation = PairingInvitation::new(desktop, "https://remote.example.test", 2_000)
            .expect("invitation");
        let mobile_signing = DeviceSigningKey::generate();
        let mobile_agreement = KeyAgreementSecret::generate();
        let mobile = descriptor(
            DeviceId::new(),
            DeviceKind::Mobile,
            "Phone",
            &mobile_signing,
            &mobile_agreement,
        );
        let request = PairingRequest::signed(
            &invitation,
            mobile,
            DeviceScopes::from([DeviceScope::ReadProjectState]),
            1_000,
            &mobile_signing,
        )
        .expect("request");
        let error = PairingApproval::approve(
            &invitation,
            &request,
            SessionId::new(),
            DeviceScopes::from([DeviceScope::StopRuns]),
            1_500,
            &desktop_signing,
        )
        .expect_err("scope escalation must fail");
        assert!(matches!(error, PairingError::ScopeEscalation));
    }

    #[test]
    fn compute_nodes_can_request_only_the_compute_jobs_scope() {
        let desktop_signing = DeviceSigningKey::generate();
        let desktop_agreement = KeyAgreementSecret::generate();
        let desktop = descriptor(
            DeviceId::new(),
            DeviceKind::Desktop,
            "Desktop",
            &desktop_signing,
            &desktop_agreement,
        );
        let invitation = PairingInvitation::new(desktop, "https://remote.example.test", 2_000)
            .expect("invitation");
        let node_signing = DeviceSigningKey::generate();
        let node_agreement = KeyAgreementSecret::generate();
        let node = descriptor(
            DeviceId::new(),
            DeviceKind::ComputeNode,
            "GPU node",
            &node_signing,
            &node_agreement,
        );
        PairingRequest::signed(
            &invitation,
            node.clone(),
            DeviceScopes::from([DeviceScope::ComputeJobs]),
            1_000,
            &node_signing,
        )
        .expect("compute-only request");
        assert!(matches!(
            PairingRequest::signed(
                &invitation,
                node,
                DeviceScopes::from([DeviceScope::ReadProjectState]),
                1_000,
                &node_signing,
            ),
            Err(PairingError::InvalidScopeProfile)
        ));
    }

    #[test]
    fn pairing_secret_is_compared_by_digest() {
        let secret = PairingSecret::generate();
        assert!(secret.matches_digest(&secret.digest()));
        assert!(!secret.matches_digest(&PairingSecret::generate().digest()));
    }

    #[test]
    fn development_gateway_urls_require_an_exact_loopback_host() {
        let signing = DeviceSigningKey::generate();
        let agreement = KeyAgreementSecret::generate();
        let desktop = descriptor(
            DeviceId::new(),
            DeviceKind::Desktop,
            "Desktop",
            &signing,
            &agreement,
        );
        for allowed in [
            "https://remote.example.test",
            "wss://remote.example.test",
            "http://localhost:8787",
            "ws://127.0.0.1:8787",
            "http://[::1]:8787",
        ] {
            assert!(
                PairingInvitation::new(desktop.clone(), allowed, 2_000).is_ok(),
                "{allowed}"
            );
        }
        for rejected in [
            "http://localhost.evil.test",
            "http://localhost@evil.test",
            "http://127.0.0.1.evil.test",
            "https://remote.example.test?token=secret",
            "file:///tmp/remote",
        ] {
            assert!(
                PairingInvitation::new(desktop.clone(), rejected, 2_000).is_err(),
                "{rejected}"
            );
        }
    }
}
