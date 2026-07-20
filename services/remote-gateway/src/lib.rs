//! Single-instance P0/P2 gateway for SomniQ's remote-control transport.
//!
//! The service durably retains only completed device metadata and bearer-token
//! hashes. Presence and signal/relay frames are ephemeral; project content and
//! relay payloads never enter durable state.

use std::{
    collections::{HashMap, HashSet},
    env, fmt,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{
        header::{AUTHORIZATION, SEC_WEBSOCKET_PROTOCOL},
        HeaderMap, StatusCode, Uri,
    },
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use rand_core::{OsRng, RngCore};
use remote_protocol::PairingSecretDigest;
pub use remote_protocol::{
    DeviceDescriptor, DeviceKind, DeviceScopes, DeviceSignature, PairingApproval, PairingId,
    PairingInvitation, PairingRequest, ProtocolVersion,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{sync::mpsc, time::timeout};
use uuid::Uuid;

pub type DeviceId = String;

const SIGNAL_OUTBOUND_CAPACITY: usize = 64;
const RELAY_OUTBOUND_CAPACITY: usize = 64;
const RELAY_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
/// The only WebSocket subprotocol selected for browser/PWA connections. The
/// one-time browser ticket is offered beside this value, but is never selected
/// as the negotiated application subprotocol.
pub const BROWSER_WEBSOCKET_SUBPROTOCOL: &str = "somniq-remote-v1";
const BROWSER_WEBSOCKET_TICKET_PREFIX: &str = "somniq-ticket-";
const BROWSER_WEBSOCKET_TICKET_MAX_LEN: usize = 128;
/// A normal browser needs at most one signal and one relay ticket while a
/// connection is opening. Bound unconsumed tickets so a paired client cannot
/// turn the short-lived credential endpoint into unbounded in-memory growth.
const MAX_BROWSER_WEBSOCKET_TICKETS_PER_DEVICE: usize = 16;
const MAX_BROWSER_WEBSOCKET_TICKETS_TOTAL: usize = 1_024;
const MAX_ICE_SERVERS: usize = 8;
const MAX_ICE_SERVER_BYTES: usize = 512;
/// Completed device identities are deliberately the only durable gateway
/// state. Pairing invitations, activation claims, browser tickets, presence,
/// and relay sessions are all short-lived and remain process-local.
const DEVICE_STATE_FILE_NAME: &str = "device-state-v1.json";
const DEVICE_STATE_SCHEMA_VERSION: u32 = 1;
const MAX_DEVICE_STATE_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PERSISTED_DEVICES: usize = 4_096;
/// Pairing state is intentionally transient. Bound it independently from the
/// durable device graph so anonymous first-use registrations cannot retain an
/// unbounded amount of process memory while their QR invitations are alive.
const DEFAULT_MAX_PENDING_PAIRINGS: usize = 64;
const MAX_PENDING_PAIRINGS_LIMIT: usize = 1_024;
/// A desktop with no completed phone pairing is the only durable identity an
/// anonymous first-use request can create. Keep that subset bounded so
/// abandoned QR ceremonies cannot consume every durable device slot.
const DEFAULT_MAX_UNPAIRED_DESKTOPS: usize = 128;
const MAX_UNPAIRED_DESKTOPS_LIMIT: usize = 1_024;

/// Runtime settings. `from_env` intentionally refuses to run without a
/// bootstrap secret so a development server is not accidentally opened with a
/// published default credential.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub bootstrap_token: String,
    pub pairing_ttl: Duration,
    /// Maximum time a claimed activation credential may wait for the phone's
    /// final `/complete` call. This is intentionally much shorter than a QR
    /// invitation lifetime: the credential is material a phone holds, even
    /// though it cannot authenticate until desktop approval.
    pub activation_completion_ttl: Duration,
    /// Short-lived one-time credential that lets a browser establish a
    /// WebSocket without putting its long-lived device bearer token in a URL
    /// or browser-inaccessible Authorization header.
    pub browser_websocket_ticket_ttl: Duration,
    pub max_ws_message_bytes: usize,
    /// Maximum number of concurrent QR ceremonies. This is a server-side
    /// backstop behind edge rate limiting for anonymous first-use pairing.
    pub max_pending_pairings: usize,
    /// Maximum number of registered desktops that have never completed a
    /// phone pairing and are therefore only useful to an abandoned QR flow.
    pub max_unpaired_desktops: usize,
    /// Directory containing the durable device credential and pairing graph.
    /// This is optional for local development, but Docker deployments set it
    /// to a named-volume mount so completed pairings survive restarts.
    pub state_dir: Option<PathBuf>,
}

impl GatewayConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let bootstrap_token = env::var("SOMNIQ_GATEWAY_BOOTSTRAP_TOKEN").map_err(|_| {
            ConfigError(
                "SOMNIQ_GATEWAY_BOOTSTRAP_TOKEN is required; use a long random secret".into(),
            )
        })?;
        if bootstrap_token.len() < 16 {
            return Err(ConfigError(
                "SOMNIQ_GATEWAY_BOOTSTRAP_TOKEN must be at least 16 characters".into(),
            ));
        }

        let pairing_ttl = parse_env_u64("SOMNIQ_GATEWAY_PAIRING_TTL_SECS", 300)?;
        if !(30..=3600).contains(&pairing_ttl) {
            return Err(ConfigError(
                "SOMNIQ_GATEWAY_PAIRING_TTL_SECS must be between 30 and 3600".into(),
            ));
        }

        let activation_completion_ttl =
            parse_env_u64("SOMNIQ_GATEWAY_ACTIVATION_COMPLETION_TTL_SECS", 60)?;
        if !(10..=300).contains(&activation_completion_ttl) {
            return Err(ConfigError(
                "SOMNIQ_GATEWAY_ACTIVATION_COMPLETION_TTL_SECS must be between 10 and 300".into(),
            ));
        }

        let browser_websocket_ticket_ttl =
            parse_env_u64("SOMNIQ_GATEWAY_BROWSER_WS_TICKET_TTL_SECS", 60)?;
        if !(10..=300).contains(&browser_websocket_ticket_ttl) {
            return Err(ConfigError(
                "SOMNIQ_GATEWAY_BROWSER_WS_TICKET_TTL_SECS must be between 10 and 300".into(),
            ));
        }

        let max_ws_message_bytes = parse_env_u64("SOMNIQ_GATEWAY_MAX_WS_BYTES", 262_144)?;
        if !(1_024..=4_194_304).contains(&max_ws_message_bytes) {
            return Err(ConfigError(
                "SOMNIQ_GATEWAY_MAX_WS_BYTES must be between 1024 and 4194304".into(),
            ));
        }

        let max_pending_pairings = parse_env_u64(
            "SOMNIQ_GATEWAY_MAX_PENDING_PAIRINGS",
            DEFAULT_MAX_PENDING_PAIRINGS as u64,
        )?;
        if !(1..=MAX_PENDING_PAIRINGS_LIMIT as u64).contains(&max_pending_pairings) {
            return Err(ConfigError(format!(
                "SOMNIQ_GATEWAY_MAX_PENDING_PAIRINGS must be between 1 and {MAX_PENDING_PAIRINGS_LIMIT}"
            )));
        }

        let max_unpaired_desktops = parse_env_u64(
            "SOMNIQ_GATEWAY_MAX_UNPAIRED_DESKTOPS",
            DEFAULT_MAX_UNPAIRED_DESKTOPS as u64,
        )?;
        if !(1..=MAX_UNPAIRED_DESKTOPS_LIMIT as u64).contains(&max_unpaired_desktops) {
            return Err(ConfigError(format!(
                "SOMNIQ_GATEWAY_MAX_UNPAIRED_DESKTOPS must be between 1 and {MAX_UNPAIRED_DESKTOPS_LIMIT}"
            )));
        }

        Ok(Self {
            bootstrap_token,
            pairing_ttl: Duration::from_secs(pairing_ttl),
            activation_completion_ttl: Duration::from_secs(activation_completion_ttl),
            browser_websocket_ticket_ttl: Duration::from_secs(browser_websocket_ticket_ttl),
            max_ws_message_bytes: max_ws_message_bytes as usize,
            max_pending_pairings: max_pending_pairings as usize,
            max_unpaired_desktops: max_unpaired_desktops as usize,
            state_dir: state_dir_from_env()?,
        })
    }

    #[cfg(test)]
    fn test_config() -> Self {
        Self {
            bootstrap_token: "test-bootstrap-token-which-is-long-enough".into(),
            pairing_ttl: Duration::from_secs(300),
            activation_completion_ttl: Duration::from_secs(60),
            browser_websocket_ticket_ttl: Duration::from_secs(60),
            max_ws_message_bytes: 64 * 1024,
            max_pending_pairings: DEFAULT_MAX_PENDING_PAIRINGS,
            max_unpaired_desktops: DEFAULT_MAX_UNPAIRED_DESKTOPS,
            state_dir: None,
        }
    }
}

fn state_dir_from_env() -> Result<Option<PathBuf>, ConfigError> {
    match env::var("SOMNIQ_GATEWAY_STATE_DIR") {
        Ok(value) => {
            let value = value.trim();
            if value.is_empty() {
                return Ok(None);
            }
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(ConfigError(
                    "SOMNIQ_GATEWAY_STATE_DIR must be an absolute path".into(),
                ));
            }
            Ok(Some(path))
        }
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(ConfigError(
            "SOMNIQ_GATEWAY_STATE_DIR is not Unicode".into(),
        )),
    }
}

fn parse_env_u64(name: &str, default: u64) -> Result<u64, ConfigError> {
    match env::var(name) {
        Ok(value) => value
            .parse()
            .map_err(|_| ConfigError(format!("{name} must be an unsigned integer when supplied"))),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(env::VarError::NotUnicode(_)) => Err(ConfigError(format!("{name} is not Unicode"))),
    }
}

#[derive(Debug, Clone)]
pub struct ConfigError(String);

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceSummary {
    pub id: DeviceId,
    pub name: String,
    pub role: DeviceKind,
    pub granted_scopes: DeviceScopes,
    pub active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PairingStatus {
    Pending,
    AwaitingApproval,
    Approved,
    Completed,
    Revoked,
    Expired,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StartPairingRequest {
    /// Created on the desktop and encoded into the QR payload. The gateway
    /// records only its secret digest, never the invitation's raw secret.
    pub invitation: PairingInvitation,
    /// Public STUN/STUNS endpoints used only for the P2 direct transport
    /// probe. TURN credentials are deliberately not accepted in a QR pairing
    /// request or stored by this gateway.
    #[serde(default)]
    pub ice_servers: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StartPairingResponse {
    pub pairing_id: String,
    pub expires_at_unix_ms: i64,
    /// Present only while the bootstrap credential provisions a new desktop.
    /// The desktop must store it in its OS credential store.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(transparent)]
pub struct ClaimPairingRequest(pub PairingRequest);

#[derive(Debug, Serialize)]
pub struct ClaimPairingResponse {
    pub claim_id: String,
    /// Inactive before desktop approval, then becomes the phone's bearer
    /// credential. Kept only on the phone; the service stores its hash.
    pub activation_token: String,
    pub status: PairingStatus,
    /// The phone must call `/complete` before this deadline. It is capped by
    /// the invitation expiry and is deliberately independent of the QR TTL.
    pub completion_expires_at_unix_ms: i64,
    pub expires_at_unix_ms: i64,
    /// The desktop-supplied public STUN/STUNS list after strict validation.
    pub ice_servers: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ApprovePairingRequest {
    pub claim_id: String,
    /// Signed by the desktop only after its local confirmation UI has shown
    /// the mobile descriptor and requested scope set.
    pub approval: PairingApproval,
}

#[derive(Debug, Serialize)]
pub struct PendingPairingClaim {
    pub claim_id: String,
    /// The desktop combines this non-secret transcript with the pairing secret
    /// in its locally retained QR invitation to recreate the exact
    /// `PairingRequest` passed to `PairingApproval::approve`.
    pub protocol_version: ProtocolVersion,
    pub pairing_id: PairingId,
    pub mobile: DeviceDescriptor,
    pub requested_scopes: DeviceScopes,
    pub requested_at_unix_ms: i64,
    pub proof: DeviceSignature,
}

#[derive(Debug, Serialize)]
pub struct ApprovePairingResponse {
    pub status: PairingStatus,
    pub device: DeviceSummary,
}

#[derive(Debug, Serialize)]
pub struct CompletePairingResponse {
    pub status: PairingStatus,
    pub device: DeviceSummary,
    pub credential_kind: &'static str,
}

#[derive(Debug, Serialize)]
pub struct MeResponse {
    pub device: DeviceSummary,
    pub paired_devices: Vec<DeviceSummary>,
}

#[derive(Debug, Serialize)]
pub struct RevokeDeviceResponse {
    pub revoked_device_id: DeviceId,
}

/// The two browser-only WebSocket endpoints. A ticket minted for one endpoint
/// cannot be replayed against the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserWebSocketEndpoint {
    Signal,
    Relay,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateBrowserWebSocketTicketRequest {
    pub endpoint: BrowserWebSocketEndpoint,
}

#[derive(Debug, Serialize)]
pub struct CreateBrowserWebSocketTicketResponse {
    /// Opaque, random, single-use value. The gateway retains only its digest.
    /// Browser clients may send it only as an offered WebSocket subprotocol.
    pub ticket: String,
    pub endpoint: BrowserWebSocketEndpoint,
    pub expires_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientSignalFrame {
    Signal {
        to: DeviceId,
        session_id: String,
        /// The gateway treats the signaling payload as opaque JSON and never
        /// writes it to state, disk, logs, or errors.
        payload: Value,
    },
    Ping {
        #[serde(default)]
        nonce: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerSignalFrame {
    Ready {
        device_id: DeviceId,
    },
    Presence {
        device_id: DeviceId,
        online: bool,
    },
    Signal {
        from: DeviceId,
        session_id: String,
        payload: Value,
    },
    Pong {
        #[serde(skip_serializing_if = "Option::is_none")]
        nonce: Option<String>,
    },
    Error {
        code: &'static str,
        message: &'static str,
    },
    Revoked {
        device_id: DeviceId,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RelayOpenFrame {
    Open {
        peer_id: DeviceId,
        session_id: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RelayClientControlFrame {
    Ping {
        #[serde(default)]
        nonce: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RelayServerControlFrame {
    Ready {
        session_id: String,
    },
    PeerConnected {
        device_id: DeviceId,
        session_id: String,
    },
    PeerDisconnected {
        device_id: DeviceId,
        session_id: String,
    },
    Pong {
        #[serde(skip_serializing_if = "Option::is_none")]
        nonce: Option<String>,
    },
    Error {
        code: &'static str,
        message: &'static str,
    },
}

#[derive(Debug, Clone)]
struct DeviceRecord {
    descriptor: DeviceDescriptor,
    /// The signed desktop grant retained for audit/routing authorization. The
    /// desktop itself has no remote-mobile scope grant.
    granted_scopes: DeviceScopes,
    credential_hash: String,
    active: bool,
    /// A revoked phone may complete a brand-new signed pairing ceremony, but
    /// an inactive phone that is still awaiting completion must remain
    /// protected from replacement.
    revoked: bool,
    paired_with: HashSet<DeviceId>,
    /// A first-use desktop needs an in-memory credential so it can inspect
    /// and approve the QR claim it just created. It is not durable until a
    /// phone finishes that ceremony, which prevents anonymous abandoned
    /// registrations from consuming the persistent device-state budget.
    provisional: bool,
}

impl DeviceRecord {
    fn summary(&self) -> DeviceSummary {
        DeviceSummary {
            id: self.descriptor.device_id.to_string(),
            name: self.descriptor.display_name.clone(),
            role: self.descriptor.kind,
            granted_scopes: self.granted_scopes.clone(),
            active: self.active,
        }
    }
}

/// Versioned, intentionally narrow persistence format. It contains no raw
/// bearer credential, pairing secret, activation token, browser cookie,
/// WebSocket ticket, signaling frame, or relay payload.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedDeviceState {
    schema_version: u32,
    /// Binds this state to the deployment bootstrap secret without retaining
    /// the secret itself. This prevents a copied volume from silently making
    /// device credentials valid on an unrelated gateway deployment.
    bootstrap_fingerprint: String,
    devices: Vec<PersistedDeviceRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedDeviceRecord {
    id: DeviceId,
    descriptor: DeviceDescriptor,
    granted_scopes: DeviceScopes,
    credential_hash: String,
    active: bool,
    revoked: bool,
    paired_with: Vec<DeviceId>,
    /// Older gateway state files included the NewAPI-derived owner digest.
    /// Keep accepting it during the capability-only migration, but never write
    /// or use it again so existing Docker volumes remain loadable.
    #[serde(rename = "owner_hash", default, skip_serializing)]
    legacy_owner_hash: Option<String>,
}

impl PersistedDeviceRecord {
    fn from_record(id: &str, record: &DeviceRecord, durable_ids: &HashSet<DeviceId>) -> Self {
        let mut paired_with: Vec<_> = record
            .paired_with
            .iter()
            .filter(|peer_id| durable_ids.contains(*peer_id))
            .cloned()
            .collect();
        paired_with.sort();
        Self {
            id: id.to_owned(),
            descriptor: record.descriptor.clone(),
            granted_scopes: record.granted_scopes.clone(),
            credential_hash: record.credential_hash.clone(),
            active: record.active,
            revoked: record.revoked,
            paired_with,
            legacy_owner_hash: None,
        }
    }

    fn into_record(self) -> DeviceRecord {
        DeviceRecord {
            descriptor: self.descriptor,
            granted_scopes: self.granted_scopes,
            credential_hash: self.credential_hash,
            active: self.active,
            revoked: self.revoked,
            paired_with: self.paired_with.into_iter().collect(),
            provisional: false,
        }
    }
}

#[derive(Debug)]
pub struct DeviceStateError(String);

impl fmt::Display for DeviceStateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for DeviceStateError {}

/// A small single-process state store. Every replacement is written to a
/// unique file in the same directory, synced, and atomically renamed over the
/// previous checkpoint. The directory is a private Docker named volume in
/// deployed configurations.
#[derive(Debug)]
struct DeviceStateStore {
    directory: PathBuf,
    path: PathBuf,
    bootstrap_fingerprint: String,
}

impl DeviceStateStore {
    fn open(directory: &FsPath, bootstrap_token: &str) -> Result<Self, DeviceStateError> {
        fs::create_dir_all(directory).map_err(|error| {
            DeviceStateError(format!(
                "cannot create gateway state directory {}: {error}",
                directory.display()
            ))
        })?;
        let metadata = fs::metadata(directory).map_err(|error| {
            DeviceStateError(format!(
                "cannot inspect gateway state directory {}: {error}",
                directory.display()
            ))
        })?;
        if !metadata.is_dir() {
            return Err(DeviceStateError(format!(
                "gateway state path {} is not a directory",
                directory.display()
            )));
        }
        Ok(Self {
            directory: directory.to_owned(),
            path: directory.join(DEVICE_STATE_FILE_NAME),
            bootstrap_fingerprint: state_bootstrap_fingerprint(bootstrap_token),
        })
    }

    fn load(&self) -> Result<HashMap<DeviceId, DeviceRecord>, DeviceStateError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(error) => {
                return Err(DeviceStateError(format!(
                    "cannot read gateway device state {}: {error}",
                    self.path.display()
                )))
            }
        };
        if bytes.len() > MAX_DEVICE_STATE_FILE_BYTES {
            return Err(DeviceStateError(format!(
                "gateway device state {} exceeds the {MAX_DEVICE_STATE_FILE_BYTES}-byte limit",
                self.path.display()
            )));
        }
        let persisted: PersistedDeviceState = serde_json::from_slice(&bytes).map_err(|error| {
            DeviceStateError(format!(
                "gateway device state {} is invalid JSON: {error}",
                self.path.display()
            ))
        })?;
        if persisted.schema_version != DEVICE_STATE_SCHEMA_VERSION {
            return Err(DeviceStateError(format!(
                "gateway device state schema {} is unsupported",
                persisted.schema_version
            )));
        }
        if persisted.bootstrap_fingerprint != self.bootstrap_fingerprint {
            return Err(DeviceStateError(
                "gateway device state belongs to a different bootstrap secret".into(),
            ));
        }
        if persisted.devices.len() > MAX_PERSISTED_DEVICES {
            return Err(DeviceStateError(format!(
                "gateway device state exceeds the {MAX_PERSISTED_DEVICES}-device limit"
            )));
        }

        let mut devices = HashMap::with_capacity(persisted.devices.len());
        for record in persisted.devices {
            validate_persisted_device_record(&record)?;
            if devices
                .insert(record.id.clone(), record.into_record())
                .is_some()
            {
                return Err(DeviceStateError(
                    "gateway device state contains a duplicate device ID".into(),
                ));
            }
        }
        validate_persisted_pairing_graph(&devices)?;
        Ok(devices)
    }

    fn save(&self, devices: &HashMap<DeviceId, DeviceRecord>) -> Result<(), DeviceStateError> {
        let durable_ids: HashSet<_> = devices
            .iter()
            // Provisional, not-yet-completed mobile claims deliberately stay
            // in memory only. A restart requires a new explicit approval.
            .filter(|(_, record)| !record.provisional && (record.active || record.revoked))
            .map(|(id, _)| id.clone())
            .collect();
        if durable_ids.len() > MAX_PERSISTED_DEVICES {
            return Err(DeviceStateError(format!(
                "gateway has more than {MAX_PERSISTED_DEVICES} durable devices"
            )));
        }
        let mut persisted_devices: Vec<_> = devices
            .iter()
            .filter(|(id, _)| durable_ids.contains(*id))
            .map(|(id, record)| PersistedDeviceRecord::from_record(id, record, &durable_ids))
            .collect();
        persisted_devices.sort_by(|left, right| left.id.cmp(&right.id));
        let state = PersistedDeviceState {
            schema_version: DEVICE_STATE_SCHEMA_VERSION,
            bootstrap_fingerprint: self.bootstrap_fingerprint.clone(),
            devices: persisted_devices,
        };
        let serialized = serde_json::to_vec(&state).map_err(|error| {
            DeviceStateError(format!("cannot serialize gateway device state: {error}"))
        })?;
        if serialized.len() > MAX_DEVICE_STATE_FILE_BYTES {
            return Err(DeviceStateError(format!(
                "serialized gateway device state exceeds the {MAX_DEVICE_STATE_FILE_BYTES}-byte limit"
            )));
        }
        self.write_atomically(&serialized)
    }

    fn write_atomically(&self, bytes: &[u8]) -> Result<(), DeviceStateError> {
        let temporary_path = self
            .directory
            .join(format!(".{DEVICE_STATE_FILE_NAME}.{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary_path).map_err(|error| {
                DeviceStateError(format!(
                    "cannot create temporary gateway device state {}: {error}",
                    temporary_path.display()
                ))
            })?;
            file.write_all(bytes).map_err(|error| {
                DeviceStateError(format!(
                    "cannot write temporary gateway device state {}: {error}",
                    temporary_path.display()
                ))
            })?;
            file.write_all(b"\n").map_err(|error| {
                DeviceStateError(format!(
                    "cannot finalize temporary gateway device state {}: {error}",
                    temporary_path.display()
                ))
            })?;
            file.sync_all().map_err(|error| {
                DeviceStateError(format!(
                    "cannot sync temporary gateway device state {}: {error}",
                    temporary_path.display()
                ))
            })?;
            fs::rename(&temporary_path, &self.path).map_err(|error| {
                DeviceStateError(format!(
                    "cannot replace gateway device state {}: {error}",
                    self.path.display()
                ))
            })?;
            #[cfg(unix)]
            {
                fs::File::open(&self.directory)
                    .and_then(|directory| directory.sync_all())
                    .map_err(|error| {
                        DeviceStateError(format!(
                            "cannot sync gateway state directory {}: {error}",
                            self.directory.display()
                        ))
                    })?;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        result
    }
}

fn state_bootstrap_fingerprint(bootstrap_token: &str) -> String {
    hash_secret(&format!("somniq-remote/device-state/v1\0{bootstrap_token}"))
}

fn validate_persisted_device_record(
    record: &PersistedDeviceRecord,
) -> Result<(), DeviceStateError> {
    if record.id != record.descriptor.device_id.to_string() {
        return Err(DeviceStateError(
            "gateway device state has a device ID/descriptor mismatch".into(),
        ));
    }
    record.descriptor.validate().map_err(|_| {
        DeviceStateError("gateway device state has an invalid device descriptor".into())
    })?;
    if !is_persisted_secret_digest(&record.credential_hash)
        || record
            .legacy_owner_hash
            .as_deref()
            .is_some_and(|hash| !is_persisted_secret_digest(hash))
    {
        return Err(DeviceStateError(
            "gateway device state has an invalid credential digest".into(),
        ));
    }
    if record.active && record.revoked {
        return Err(DeviceStateError(
            "gateway device state marks a device as both active and revoked".into(),
        ));
    }
    if !record.active && !record.revoked {
        return Err(DeviceStateError(
            "gateway device state contains a provisional device".into(),
        ));
    }
    if record.descriptor.kind == DeviceKind::Desktop && (!record.active || record.revoked) {
        return Err(DeviceStateError(
            "gateway device state contains an inactive desktop".into(),
        ));
    }
    if record.revoked && !record.paired_with.is_empty() {
        return Err(DeviceStateError(
            "gateway device state keeps pairing edges for a revoked device".into(),
        ));
    }
    Ok(())
}

fn validate_persisted_pairing_graph(
    devices: &HashMap<DeviceId, DeviceRecord>,
) -> Result<(), DeviceStateError> {
    for (device_id, device) in devices {
        for peer_id in &device.paired_with {
            if peer_id == device_id {
                return Err(DeviceStateError(
                    "gateway device state contains a self pairing edge".into(),
                ));
            }
            let peer = devices.get(peer_id).ok_or_else(|| {
                DeviceStateError("gateway device state references an unknown paired device".into())
            })?;
            if !device.active
                || !peer.active
                || device.descriptor.kind == peer.descriptor.kind
                || !peer.paired_with.contains(device_id)
            {
                return Err(DeviceStateError(
                    "gateway device state contains an invalid pairing graph".into(),
                ));
            }
        }
    }
    Ok(())
}

fn is_persisted_secret_digest(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Debug, Clone)]
struct PairingClaim {
    id: String,
    protocol_version: ProtocolVersion,
    mobile: DeviceDescriptor,
    requested_scopes: DeviceScopes,
    requested_at_unix_ms: i64,
    proof: DeviceSignature,
    activation_token_hash: String,
    completion_expires_at_unix_ms: i64,
}

#[derive(Debug, Clone)]
struct PairingRecord {
    desktop_id: DeviceId,
    desktop: DeviceDescriptor,
    protocol_pairing_id: PairingId,
    pairing_secret_digest: PairingSecretDigest,
    /// Public, bounded direct-transport configuration supplied by the desktop
    /// before the QR is rendered. It has no credential-bearing TURN entries.
    ice_servers: Vec<String>,
    expires_at_unix_ms: i64,
    status: PairingStatus,
    claim: Option<PairingClaim>,
    /// Signed evidence for a future audit-store adapter. It contains no
    /// pairing secret or control payload.
    #[allow(dead_code)]
    approval: Option<PairingApproval>,
}

impl PairingRecord {
    fn is_expired_at(&self, now_unix_ms: i64) -> bool {
        let invitation_expired = matches!(
            self.status,
            PairingStatus::Pending | PairingStatus::AwaitingApproval | PairingStatus::Approved
        ) && now_unix_ms >= self.expires_at_unix_ms;
        let completion_expired = matches!(
            self.status,
            PairingStatus::AwaitingApproval | PairingStatus::Approved
        ) && self
            .claim
            .as_ref()
            .is_some_and(|claim| now_unix_ms >= claim.completion_expires_at_unix_ms);

        invitation_expired || completion_expired
    }

    fn expire_if_needed_at(&mut self, now_unix_ms: i64) -> bool {
        if self.is_expired_at(now_unix_ms) {
            self.status = PairingStatus::Expired;
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Clone)]
struct AuthenticatedDevice {
    id: DeviceId,
    role: DeviceKind,
}

#[derive(Debug, Clone)]
enum CredentialSubject {
    Bootstrap,
    Device(AuthenticatedDevice),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum GatewayError {
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Expired,
    Invalid,
    PeerOffline,
    StateUnavailable,
    CapacityExceeded,
}

impl GatewayError {
    fn code(&self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::Expired => "expired",
            Self::Invalid => "invalid_request",
            Self::PeerOffline => "peer_offline",
            Self::StateUnavailable => "durable_state_unavailable",
            Self::CapacityExceeded => "pairing_capacity_reached",
        }
    }

    fn message(&self) -> &'static str {
        match self {
            Self::Unauthorized => "authentication failed",
            Self::Forbidden => "the requested device route is not permitted",
            Self::NotFound => "resource not found",
            Self::Conflict => "the requested state transition is not available",
            Self::Expired => "the pairing, activation credential, or browser ticket has expired",
            Self::Invalid => "invalid request",
            Self::PeerOffline => "paired peer is not connected",
            Self::StateUnavailable => "the gateway durable state is unavailable",
            Self::CapacityExceeded => {
                "the gateway is temporarily limiting new pairing registrations"
            }
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Conflict => StatusCode::CONFLICT,
            Self::Expired => StatusCode::GONE,
            Self::Invalid => StatusCode::BAD_REQUEST,
            Self::PeerOffline => StatusCode::CONFLICT,
            Self::StateUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::CapacityExceeded => StatusCode::TOO_MANY_REQUESTS,
        }
    }
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: &'static str,
}

struct ApiError(GatewayError);

impl From<GatewayError> for ApiError {
    fn from(value: GatewayError) -> Self {
        Self(value)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let error = self.0;
        (
            error.status(),
            Json(ErrorBody {
                code: error.code(),
                message: error.message(),
            }),
        )
            .into_response()
    }
}

type SignalSender = mpsc::Sender<ServerSignalFrame>;

#[derive(Debug)]
enum RelayOutbound {
    Control(RelayServerControlFrame),
    Binary(Vec<u8>),
}

type RelaySender = mpsc::Sender<RelayOutbound>;

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct RelayKey {
    first: DeviceId,
    second: DeviceId,
    session_id: String,
}

impl RelayKey {
    fn new(a: &str, b: &str, session_id: &str) -> Self {
        if a <= b {
            Self {
                first: a.to_owned(),
                second: b.to_owned(),
                session_id: session_id.to_owned(),
            }
        } else {
            Self {
                first: b.to_owned(),
                second: a.to_owned(),
                session_id: session_id.to_owned(),
            }
        }
    }
}

#[derive(Debug)]
struct RelayEndpoint {
    connection_id: Uuid,
    sender: RelaySender,
}

#[derive(Debug, Default)]
struct RelaySession {
    endpoints: HashMap<DeviceId, RelayEndpoint>,
}

/// Stored by digest so an in-memory diagnostic dump cannot recover a usable
/// browser credential. A browser ticket is deliberately much shorter-lived
/// than a device credential and removed atomically when consumed.
#[derive(Debug, Clone)]
struct BrowserWebSocketTicket {
    device_id: DeviceId,
    endpoint: BrowserWebSocketEndpoint,
    expires_at_unix_ms: i64,
}

#[derive(Default)]
struct GatewayInner {
    devices: HashMap<DeviceId, DeviceRecord>,
    pairings: HashMap<String, PairingRecord>,
    browser_websocket_tickets: HashMap<String, BrowserWebSocketTicket>,
    signal_connections: HashMap<DeviceId, HashMap<Uuid, SignalSender>>,
    relay_sessions: HashMap<RelayKey, RelaySession>,
}

/// Lazily expires abandoned pairings whenever state is touched. An approved
/// but uncompleted phone is intentionally inactive, so removing its
/// provisional record does not disconnect a live device. Removing it also
/// lets the same phone start a fresh, explicitly approved ceremony instead of
/// being permanently blocked by a stale activation-token hash.
fn expire_stale_pairings(inner: &mut GatewayInner, now_unix_ms: i64) {
    let expired_pairings: Vec<_> = inner
        .pairings
        .values_mut()
        .filter_map(|pairing| {
            if !pairing.expire_if_needed_at(now_unix_ms) {
                return None;
            }
            Some((
                pairing.desktop_id.clone(),
                pairing
                    .claim
                    .as_ref()
                    .map(|claim| claim.mobile.device_id.to_string()),
            ))
        })
        .collect();

    for (desktop_id, mobile_id) in &expired_pairings {
        if let Some(mobile_id) = mobile_id {
            if inner
                .devices
                .get(mobile_id)
                .is_some_and(|device| !device.active)
            {
                inner.devices.remove(mobile_id);
                for device in inner.devices.values_mut() {
                    device.paired_with.remove(mobile_id);
                }
            }
        }

        // An initial desktop registration is useful only if its QR ceremony
        // progresses. Once its last ceremony expires, reclaim the transient
        // identity so unauthenticated start requests cannot accumulate in
        // memory. Durable desktops remain available for later phone pairs.
        if inner.devices.get(desktop_id).is_some_and(|device| {
            device.descriptor.kind == DeviceKind::Desktop
                && device.active
                && !device.revoked
                && device.paired_with.is_empty()
                && device.provisional
        }) {
            let has_live_pairing = inner.pairings.values().any(|pairing| {
                pairing.desktop_id == *desktop_id
                    && !matches!(
                        pairing.status,
                        PairingStatus::Expired | PairingStatus::Completed | PairingStatus::Revoked
                    )
            });
            if !has_live_pairing {
                inner.devices.remove(desktop_id);
            }
        }
    }
}

/// Keep short-lived terminal records long enough to return an accurate status
/// to the caller that triggered expiry, but discard them before accepting a
/// new ceremony. Active pairing capacity therefore remains bounded even if a
/// public caller repeatedly opens and abandons QR invitations.
fn prune_terminal_pairings(inner: &mut GatewayInner) {
    inner.pairings.retain(|_, pairing| {
        !matches!(
            pairing.status,
            PairingStatus::Expired | PairingStatus::Completed | PairingStatus::Revoked
        )
    });
}

fn expire_stale_browser_websocket_tickets(inner: &mut GatewayInner, now_unix_ms: i64) {
    inner
        .browser_websocket_tickets
        .retain(|_, ticket| now_unix_ms < ticket.expires_at_unix_ms);
}

/// Cloneable application state. Completed device credentials and their pairing
/// graph may be checkpointed to a local state volume; pairing ceremonies and
/// all transport state remain intentionally in-memory.
#[derive(Clone)]
pub struct GatewayState {
    config: Arc<GatewayConfig>,
    inner: Arc<Mutex<GatewayInner>>,
    device_state_store: Option<Arc<DeviceStateStore>>,
}

impl GatewayState {
    /// Creates an explicitly in-memory state for tests and local development.
    pub fn new(config: Arc<GatewayConfig>) -> Self {
        Self {
            config,
            inner: Arc::new(Mutex::new(GatewayInner::default())),
            device_state_store: None,
        }
    }

    /// Loads completed device credentials from the configured state directory.
    /// When the directory is not configured, this deliberately behaves like
    /// [`Self::new`] so local development does not create hidden state.
    pub fn load(config: Arc<GatewayConfig>) -> Result<Self, DeviceStateError> {
        let device_state_store = config
            .state_dir
            .as_deref()
            .map(|directory| DeviceStateStore::open(directory, &config.bootstrap_token))
            .transpose()?
            .map(Arc::new);
        let devices = match &device_state_store {
            Some(store) => store.load()?,
            None => HashMap::new(),
        };
        Ok(Self {
            config,
            inner: Arc::new(Mutex::new(GatewayInner {
                devices,
                ..GatewayInner::default()
            })),
            device_state_store,
        })
    }

    fn persist_durable_devices(&self, inner: &GatewayInner) -> Result<(), GatewayError> {
        let Some(store) = &self.device_state_store else {
            return Ok(());
        };
        store.save(&inner.devices).map_err(|error| {
            tracing::error!(error = %error, "failed to persist gateway device state");
            GatewayError::StateUnavailable
        })
    }

    fn authenticate_credential(&self, credential: &str) -> Result<CredentialSubject, GatewayError> {
        if credential == self.config.bootstrap_token {
            return Ok(CredentialSubject::Bootstrap);
        }

        let credential_hash = hash_secret(credential);
        let mut inner = lock(&self.inner);
        let now = now_unix_ms();
        expire_stale_pairings(&mut inner, now);
        expire_stale_browser_websocket_tickets(&mut inner, now);
        inner
            .devices
            .values()
            .find(|device| device.active && device.credential_hash == credential_hash)
            .map(|device| {
                CredentialSubject::Device(AuthenticatedDevice {
                    id: device.descriptor.device_id.to_string(),
                    role: device.descriptor.kind,
                })
            })
            .ok_or(GatewayError::Unauthorized)
    }

    fn authenticate_device_header(
        &self,
        headers: &HeaderMap,
    ) -> Result<AuthenticatedDevice, GatewayError> {
        let credential = bearer_credential(headers)?;
        match self.authenticate_credential(credential)? {
            CredentialSubject::Device(device) => Ok(device),
            CredentialSubject::Bootstrap => Err(GatewayError::Forbidden),
        }
    }

    fn create_browser_websocket_ticket(
        &self,
        device: AuthenticatedDevice,
        endpoint: BrowserWebSocketEndpoint,
    ) -> Result<CreateBrowserWebSocketTicketResponse, GatewayError> {
        // Browser/PWA sessions are a mobile-client adapter. Refusing desktop
        // credentials here prevents an accidental frontend integration from
        // ever copying a desktop bearer token into browser-managed storage.
        if device.role != DeviceKind::Mobile {
            return Err(GatewayError::Forbidden);
        }

        let now = now_unix_ms();
        let expires_at_unix_ms = now.saturating_add(
            i64::try_from(self.config.browser_websocket_ticket_ttl.as_millis()).unwrap_or(i64::MAX),
        );
        let mut inner = lock(&self.inner);
        expire_stale_pairings(&mut inner, now);
        expire_stale_browser_websocket_tickets(&mut inner, now);
        let record = active_device(&inner, &device.id)?;
        if record.descriptor.kind != DeviceKind::Mobile {
            return Err(GatewayError::Forbidden);
        }
        if inner.browser_websocket_tickets.len() >= MAX_BROWSER_WEBSOCKET_TICKETS_TOTAL
            || inner
                .browser_websocket_tickets
                .values()
                .filter(|ticket| ticket.device_id == device.id)
                .count()
                >= MAX_BROWSER_WEBSOCKET_TICKETS_PER_DEVICE
        {
            return Err(GatewayError::Conflict);
        }

        // A hash collision from 256 bits of OS entropy is not realistically
        // reachable, but avoiding overwrite keeps the single-use invariant
        // explicit even under a broken random source.
        for _ in 0..3 {
            let ticket = random_browser_websocket_ticket();
            let ticket_hash = hash_secret(&ticket);
            if inner.browser_websocket_tickets.contains_key(&ticket_hash) {
                continue;
            }
            inner.browser_websocket_tickets.insert(
                ticket_hash,
                BrowserWebSocketTicket {
                    device_id: device.id.clone(),
                    endpoint,
                    expires_at_unix_ms,
                },
            );
            return Ok(CreateBrowserWebSocketTicketResponse {
                ticket,
                endpoint,
                expires_at_unix_ms,
            });
        }

        Err(GatewayError::Conflict)
    }

    /// Consume a browser WebSocket ticket atomically. A wrong endpoint does
    /// not burn the ticket, while a matching endpoint removes it before the
    /// socket is upgraded so it cannot be replayed by a second handshake.
    fn consume_browser_websocket_ticket(
        &self,
        ticket: &str,
        endpoint: BrowserWebSocketEndpoint,
    ) -> Result<AuthenticatedDevice, GatewayError> {
        if !is_valid_browser_websocket_ticket(ticket) {
            return Err(GatewayError::Unauthorized);
        }

        let now = now_unix_ms();
        let ticket_hash = hash_secret(ticket);
        let mut inner = lock(&self.inner);
        expire_stale_pairings(&mut inner, now);
        // Do this explicitly rather than relying only on retain so a caller
        // holding an expired ticket receives the useful 410 response.
        let stored = inner
            .browser_websocket_tickets
            .get(&ticket_hash)
            .cloned()
            .ok_or(GatewayError::Unauthorized)?;
        if now >= stored.expires_at_unix_ms {
            inner.browser_websocket_tickets.remove(&ticket_hash);
            return Err(GatewayError::Expired);
        }
        if stored.endpoint != endpoint {
            return Err(GatewayError::Forbidden);
        }

        // Remove first: a simultaneous handshake can retrieve the record but
        // only one of them can claim it. Revocation after issuance is still
        // enforced by the active-device lookup below.
        let stored = inner
            .browser_websocket_tickets
            .remove(&ticket_hash)
            .expect("ticket was read while holding the same lock");
        let record = active_device(&inner, &stored.device_id)?;
        if record.descriptor.kind != DeviceKind::Mobile {
            return Err(GatewayError::Forbidden);
        }
        Ok(AuthenticatedDevice {
            id: stored.device_id,
            role: DeviceKind::Mobile,
        })
    }

    fn start_pairing(
        &self,
        credential: Option<&str>,
        request: StartPairingRequest,
    ) -> Result<StartPairingResponse, GatewayError> {
        let StartPairingRequest {
            invitation,
            ice_servers,
        } = request;
        let ice_servers = validate_ice_servers(&ice_servers)?;
        let now = now_unix_ms();
        // The desktop's clock is not authoritative. A small clock skew used
        // to make a perfectly normal five-minute invitation appear to extend
        // beyond this gateway's configured TTL, which rejected the request
        // before authentication. Retain all invitation shape checks, but run
        // them with the expiry this gateway is about to issue and persist.
        let expires_at_unix_ms = now
            .saturating_add(i64::try_from(self.config.pairing_ttl.as_millis()).unwrap_or(i64::MAX));
        let mut invitation_for_validation = invitation.clone();
        invitation_for_validation.expires_at_unix_ms = expires_at_unix_ms;
        invitation_for_validation
            .validate_at(now)
            .map_err(|_| GatewayError::Invalid)?;
        if invitation.desktop.kind != DeviceKind::Desktop {
            return Err(GatewayError::Invalid);
        }
        let subject = credential
            .map(|credential| self.authenticate_credential(credential))
            .transpose()?;
        let mut inner = lock(&self.inner);
        expire_stale_pairings(&mut inner, now);
        prune_terminal_pairings(&mut inner);
        let desktop_id = invitation.desktop.device_id.to_string();
        let desktop_descriptor = invitation.desktop.clone();
        let protocol_pairing_id = invitation.pairing_id;
        let pairing_id = protocol_pairing_id.to_string();
        let pairing_secret_digest = invitation.pairing_secret.digest();

        // Reject duplicate IDs and global pressure before registering a new
        // desktop identity. This keeps anonymous first-use registration from
        // creating a durable record when its invitation cannot be retained.
        if inner.pairings.contains_key(&pairing_id) {
            return Err(GatewayError::Conflict);
        }
        if inner.pairings.len() >= self.config.max_pending_pairings {
            return Err(GatewayError::CapacityExceeded);
        }

        let desktop_token = match subject {
            // A desktop has no network-issued identity before its first QR
            // ceremony. The signed invitation is held locally and its 256-bit
            // secret is required again in the phone's signed claim; the
            // desktop must then explicitly approve that exact claim before
            // the resulting mobile credential becomes active.
            None | Some(CredentialSubject::Bootstrap) => {
                if inner.devices.contains_key(&desktop_id) {
                    return Err(GatewayError::Conflict);
                }
                if inner.devices.len() >= MAX_PERSISTED_DEVICES
                    || inner
                        .devices
                        .values()
                        .filter(|record| {
                            record.descriptor.kind == DeviceKind::Desktop
                                && record.active
                                && !record.revoked
                                && record.paired_with.is_empty()
                                && record.provisional
                        })
                        .count()
                        >= self.config.max_unpaired_desktops
                {
                    return Err(GatewayError::CapacityExceeded);
                }
                let token = random_secret();
                inner.devices.insert(
                    desktop_id.clone(),
                    DeviceRecord {
                        descriptor: desktop_descriptor.clone(),
                        granted_scopes: DeviceScopes::new(),
                        credential_hash: hash_secret(&token),
                        active: true,
                        revoked: false,
                        paired_with: HashSet::new(),
                        provisional: true,
                    },
                );
                Some(token)
            }
            Some(CredentialSubject::Device(device)) => {
                if device.role != DeviceKind::Desktop || device.id != desktop_id {
                    return Err(GatewayError::Forbidden);
                }
                if inner
                    .devices
                    .get(&device.id)
                    .is_none_or(|record| record.descriptor != desktop_descriptor)
                {
                    return Err(GatewayError::Forbidden);
                }
                None
            }
        };

        inner.pairings.insert(
            pairing_id.clone(),
            PairingRecord {
                desktop_id,
                desktop: desktop_descriptor,
                protocol_pairing_id,
                pairing_secret_digest,
                ice_servers,
                expires_at_unix_ms,
                status: PairingStatus::Pending,
                claim: None,
                approval: None,
            },
        );

        Ok(StartPairingResponse {
            pairing_id,
            expires_at_unix_ms,
            desktop_token,
        })
    }

    fn claim_pairing(
        &self,
        pairing_id: &str,
        request: ClaimPairingRequest,
    ) -> Result<ClaimPairingResponse, GatewayError> {
        let request = request.0;
        let now = now_unix_ms();
        let mut inner = lock(&self.inner);
        expire_stale_pairings(&mut inner, now);
        let mobile_id = request.mobile.device_id.to_string();
        let replace_revoked_device = match inner.devices.get(&mobile_id) {
            Some(device) if !device.active && device.revoked => true,
            Some(_) => return Err(GatewayError::Conflict),
            None => false,
        };

        let pairing_expires_at_unix_ms = {
            let pairing = inner
                .pairings
                .get(pairing_id)
                .ok_or(GatewayError::NotFound)?;
            if pairing.status == PairingStatus::Expired {
                return Err(GatewayError::Expired);
            }
            if pairing.status != PairingStatus::Pending || pairing.claim.is_some() {
                return Err(GatewayError::Conflict);
            }
            if pairing.desktop_id == mobile_id {
                return Err(GatewayError::Forbidden);
            }
            request
                .verify_against_registered_invitation(
                    pairing.protocol_pairing_id,
                    &pairing.pairing_secret_digest,
                )
                .map_err(|_| GatewayError::Forbidden)?;
            pairing.expires_at_unix_ms
        };

        if replace_revoked_device {
            inner.devices.remove(&mobile_id);
            for device in inner.devices.values_mut() {
                device.paired_with.remove(&mobile_id);
            }
        }

        let activation_token = random_secret();
        let claim_id = Uuid::new_v4().to_string();
        let completion_expires_at_unix_ms = now
            .saturating_add(
                i64::try_from(self.config.activation_completion_ttl.as_millis())
                    .unwrap_or(i64::MAX),
            )
            .min(pairing_expires_at_unix_ms);
        let pairing = inner
            .pairings
            .get_mut(pairing_id)
            .expect("pairing was validated while holding the same lock");
        pairing.claim = Some(PairingClaim {
            id: claim_id.clone(),
            protocol_version: request.protocol_version,
            mobile: request.mobile,
            requested_scopes: request.requested_scopes,
            requested_at_unix_ms: request.requested_at_unix_ms,
            proof: request.proof,
            activation_token_hash: hash_secret(&activation_token),
            completion_expires_at_unix_ms,
        });
        pairing.status = PairingStatus::AwaitingApproval;
        let ice_servers = pairing.ice_servers.clone();

        Ok(ClaimPairingResponse {
            claim_id,
            activation_token,
            status: PairingStatus::AwaitingApproval,
            completion_expires_at_unix_ms,
            expires_at_unix_ms: pairing_expires_at_unix_ms,
            ice_servers,
        })
    }

    fn pending_claim(
        &self,
        pairing_id: &str,
        desktop: AuthenticatedDevice,
    ) -> Result<PendingPairingClaim, GatewayError> {
        if desktop.role != DeviceKind::Desktop {
            return Err(GatewayError::Forbidden);
        }
        let mut inner = lock(&self.inner);
        expire_stale_pairings(&mut inner, now_unix_ms());
        let pairing = inner
            .pairings
            .get_mut(pairing_id)
            .ok_or(GatewayError::NotFound)?;
        if pairing.status == PairingStatus::Expired {
            return Err(GatewayError::Expired);
        }
        if pairing.desktop_id != desktop.id {
            return Err(GatewayError::Forbidden);
        }
        let claim = pairing.claim.as_ref().ok_or(GatewayError::NotFound)?;
        Ok(PendingPairingClaim {
            claim_id: claim.id.clone(),
            protocol_version: claim.protocol_version,
            pairing_id: pairing.protocol_pairing_id,
            mobile: claim.mobile.clone(),
            requested_scopes: claim.requested_scopes.clone(),
            requested_at_unix_ms: claim.requested_at_unix_ms,
            proof: claim.proof,
        })
    }

    fn approve_pairing(
        &self,
        pairing_id: &str,
        desktop: AuthenticatedDevice,
        request: ApprovePairingRequest,
    ) -> Result<ApprovePairingResponse, GatewayError> {
        if desktop.role != DeviceKind::Desktop {
            return Err(GatewayError::Forbidden);
        }

        let mut inner = lock(&self.inner);
        expire_stale_pairings(&mut inner, now_unix_ms());
        let (desktop_id, desktop_descriptor, claim, approval, granted_scopes) = {
            let pairing = inner
                .pairings
                .get_mut(pairing_id)
                .ok_or(GatewayError::NotFound)?;
            if pairing.status == PairingStatus::Expired {
                return Err(GatewayError::Expired);
            }
            if pairing.status != PairingStatus::AwaitingApproval || pairing.desktop_id != desktop.id
            {
                return Err(GatewayError::Forbidden);
            }
            let claim = pairing.claim.clone().ok_or(GatewayError::Conflict)?;
            if claim.id != request.claim_id {
                return Err(GatewayError::Conflict);
            }
            if request.approval.pairing_id.to_string() != pairing_id
                || request.approval.desktop_device_id.to_string() != pairing.desktop_id
                || request.approval.mobile != claim.mobile
            {
                return Err(GatewayError::Forbidden);
            }
            request
                .approval
                .verify_proof(&pairing.desktop)
                .map_err(|_| GatewayError::Forbidden)?;
            if !request
                .approval
                .granted_scopes
                .is_subset_of(&claim.requested_scopes)
            {
                return Err(GatewayError::Forbidden);
            }
            let granted_scopes = request.approval.granted_scopes.clone();
            (
                pairing.desktop_id.clone(),
                pairing.desktop.clone(),
                claim,
                request.approval,
                granted_scopes,
            )
        };

        if inner
            .devices
            .contains_key(&claim.mobile.device_id.to_string())
        {
            return Err(GatewayError::Conflict);
        }
        let mobile_id = claim.mobile.device_id.to_string();
        let mobile = DeviceRecord {
            descriptor: claim.mobile,
            granted_scopes,
            credential_hash: claim.activation_token_hash,
            // The signed desktop grant establishes the identity binding, but
            // the phone cannot use its transport credential until it completes
            // the pairing ceremony with that credential.
            active: false,
            revoked: false,
            paired_with: HashSet::from([desktop_id.clone()]),
            provisional: true,
        };
        let summary = mobile.summary();
        inner.devices.insert(mobile_id.clone(), mobile);
        let desktop_record = inner
            .devices
            .get_mut(&desktop_id)
            .ok_or(GatewayError::Unauthorized)?;
        desktop_record.paired_with.insert(mobile_id);
        // A first-use desktop is already provisional until its first phone
        // completes. A desktop with an established durable pairing must stay
        // durable while a later phone waits to complete; otherwise an
        // unrelated revocation checkpoint could omit its bearer credential.
        let pairing = inner
            .pairings
            .get_mut(pairing_id)
            .ok_or(GatewayError::NotFound)?;
        debug_assert_eq!(pairing.desktop, desktop_descriptor);
        pairing.approval = Some(approval);
        pairing.status = PairingStatus::Approved;

        Ok(ApprovePairingResponse {
            status: PairingStatus::Approved,
            device: summary,
        })
    }

    fn complete_pairing(
        &self,
        pairing_id: &str,
        claim_id: &str,
        activation_token: &str,
    ) -> Result<CompletePairingResponse, GatewayError> {
        let mut inner = lock(&self.inner);
        expire_stale_pairings(&mut inner, now_unix_ms());
        let mobile_id = {
            let pairing = inner
                .pairings
                .get(pairing_id)
                .ok_or(GatewayError::NotFound)?;
            if pairing.status == PairingStatus::Expired {
                return Err(GatewayError::Expired);
            }
            if pairing.status != PairingStatus::Approved {
                return Err(GatewayError::Conflict);
            }
            let claim = pairing.claim.as_ref().ok_or(GatewayError::Conflict)?;
            if claim.id != claim_id || claim.activation_token_hash != hash_secret(activation_token)
            {
                return Err(GatewayError::Unauthorized);
            }
            claim.mobile.device_id.to_string()
        };
        let device = inner
            .devices
            .get_mut(&mobile_id)
            .ok_or(GatewayError::Conflict)?;
        device.active = true;
        device.provisional = false;
        let desktop_id = inner
            .pairings
            .get(pairing_id)
            .expect("pairing was read while holding the same lock")
            .desktop_id
            .clone();
        let desktop = inner
            .devices
            .get_mut(&desktop_id)
            .expect("approved pairing keeps its desktop record");
        let desktop_was_provisional = desktop.provisional;
        desktop.provisional = false;
        inner
            .pairings
            .get_mut(pairing_id)
            .expect("pairing was read while holding the same lock")
            .status = PairingStatus::Completed;
        if let Err(error) = self.persist_durable_devices(&inner) {
            inner
                .devices
                .get_mut(&mobile_id)
                .expect("mobile was validated before persistence")
                .active = false;
            inner
                .devices
                .get_mut(&mobile_id)
                .expect("mobile was validated before persistence")
                .provisional = true;
            inner
                .devices
                .get_mut(&desktop_id)
                .expect("desktop was validated before persistence")
                .provisional = desktop_was_provisional;
            inner
                .pairings
                .get_mut(pairing_id)
                .expect("pairing was validated before persistence")
                .status = PairingStatus::Approved;
            return Err(error);
        }
        let device = inner
            .devices
            .get(&mobile_id)
            .expect("mobile was validated before persistence")
            .summary();
        // The completed pairing transcript no longer authorizes anything:
        // retain only the durable device graph and free the transient slot.
        inner.pairings.remove(pairing_id);

        Ok(CompletePairingResponse {
            status: PairingStatus::Completed,
            device,
            credential_kind: "activation_token",
        })
    }

    fn me(&self, caller: AuthenticatedDevice) -> Result<MeResponse, GatewayError> {
        let inner = lock(&self.inner);
        let device = active_device(&inner, &caller.id)?.summary();
        let mut paired_devices: Vec<_> = active_device(&inner, &caller.id)?
            .paired_with
            .iter()
            .filter_map(|peer_id| inner.devices.get(peer_id))
            .filter(|peer| peer.active)
            .map(DeviceRecord::summary)
            .collect();
        paired_devices.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(MeResponse {
            device,
            paired_devices,
        })
    }

    fn revoke_device(
        &self,
        caller: AuthenticatedDevice,
        target_id: &str,
    ) -> Result<RevokeDeviceResponse, GatewayError> {
        if caller.role != DeviceKind::Desktop {
            return Err(GatewayError::Forbidden);
        }

        {
            let inner = lock(&self.inner);
            if !are_paired(&inner, &caller.id, target_id) {
                return Err(GatewayError::Forbidden);
            }
            let target = inner.devices.get(target_id).ok_or(GatewayError::NotFound)?;
            if !target.active || target.descriptor.kind != DeviceKind::Mobile {
                return Err(GatewayError::Forbidden);
            }
        }

        self.revoke_mobile(target_id, "a paired desktop revoked this device")
    }

    /// A mobile bearer may revoke only the mobile device that bearer already
    /// authenticated as. It cannot select a desktop or another phone ID.
    fn revoke_self(
        &self,
        caller: AuthenticatedDevice,
    ) -> Result<RevokeDeviceResponse, GatewayError> {
        if caller.role != DeviceKind::Mobile {
            return Err(GatewayError::Forbidden);
        }
        self.revoke_mobile(&caller.id, "this mobile device revoked itself")
    }

    /// Deactivates one active mobile and tears down every transient transport
    /// capability. Callers must have performed their own authorization first.
    fn revoke_mobile(
        &self,
        target_id: &str,
        relay_message: &'static str,
    ) -> Result<RevokeDeviceResponse, GatewayError> {
        let (target_signal_senders, paired_revocation_senders, relay_senders) = {
            let mut inner = lock(&self.inner);
            // A failed checkpoint must not report a revocation that will be
            // lost on restart. Device/pairing metadata is small and cloneable;
            // restore it before returning the persistence error.
            let previous_devices = inner.devices.clone();
            let previous_pairings = inner.pairings.clone();
            let paired_devices: Vec<_> = active_device(&inner, target_id)?
                .paired_with
                .iter()
                .cloned()
                .collect();
            let target = inner
                .devices
                .get_mut(target_id)
                .ok_or(GatewayError::NotFound)?;
            if target.descriptor.kind != DeviceKind::Mobile {
                return Err(GatewayError::Forbidden);
            }
            target.active = false;
            target.revoked = true;
            target.paired_with.clear();

            for device in inner.devices.values_mut() {
                device.paired_with.remove(target_id);
            }
            for pairing in inner.pairings.values_mut() {
                if pairing.desktop_id == target_id
                    || pairing
                        .claim
                        .as_ref()
                        .is_some_and(|claim| claim.mobile.device_id.to_string() == target_id)
                {
                    pairing.status = PairingStatus::Revoked;
                }
            }
            if let Err(error) = self.persist_durable_devices(&inner) {
                inner.devices = previous_devices;
                inner.pairings = previous_pairings;
                return Err(error);
            }

            // A ticket is a delegated one-time browser credential, so both a
            // desktop revocation and self-revocation invalidate it immediately.
            inner
                .browser_websocket_tickets
                .retain(|_, ticket| ticket.device_id != target_id);

            let target_signal_senders: Vec<_> = inner
                .signal_connections
                .remove(target_id)
                .into_iter()
                .flat_map(|connections| connections.into_values())
                .collect();
            // A direct WebRTC DataChannel does not traverse the gateway once
            // negotiation completes. Detach paired desktop signal sockets
            // after queueing an explicit revocation. If an outbound queue is
            // already full, dropping its last sender still closes that socket;
            // the desktop treats loss of its authenticated signal control
            // plane as a hard P2P-session boundary. This avoids a best-effort
            // notification leaving a direct channel alive indefinitely.
            let paired_revocation_senders: Vec<SignalSender> = paired_devices
                .iter()
                .flat_map(|peer_id| {
                    inner
                        .signal_connections
                        .remove(peer_id)
                        .into_iter()
                        .flat_map(|connections| connections.into_values())
                })
                .collect();

            let mut relay_senders = Vec::new();
            let keys: Vec<_> = inner
                .relay_sessions
                .keys()
                .filter(|key| key.first == target_id || key.second == target_id)
                .cloned()
                .collect();
            for key in keys {
                if let Some(session) = inner.relay_sessions.remove(&key) {
                    relay_senders.extend(
                        session
                            .endpoints
                            .into_values()
                            .map(|endpoint| endpoint.sender),
                    );
                }
            }
            (
                target_signal_senders,
                paired_revocation_senders,
                relay_senders,
            )
        };

        for sender in target_signal_senders
            .into_iter()
            .chain(paired_revocation_senders)
        {
            let _ = sender.try_send(ServerSignalFrame::Revoked {
                device_id: target_id.to_owned(),
            });
        }
        for sender in relay_senders {
            let _ = sender.try_send(RelayOutbound::Control(RelayServerControlFrame::Error {
                code: "revoked",
                message: relay_message,
            }));
        }

        Ok(RevokeDeviceResponse {
            revoked_device_id: target_id.to_owned(),
        })
    }

    fn attach_signal(
        &self,
        device_id: &str,
        connection_id: Uuid,
        sender: SignalSender,
    ) -> Result<Vec<ServerSignalFrame>, GatewayError> {
        let (initial_presence, notify_senders) = {
            let mut inner = lock(&self.inner);
            let peers: Vec<_> = active_device(&inner, device_id)?
                .paired_with
                .iter()
                .cloned()
                .collect();
            let was_online = inner
                .signal_connections
                .get(device_id)
                .is_some_and(|connections| !connections.is_empty());
            inner
                .signal_connections
                .entry(device_id.to_owned())
                .or_default()
                .insert(connection_id, sender);

            let initial_presence = peers
                .iter()
                .filter_map(|peer_id| {
                    inner
                        .devices
                        .get(peer_id)
                        .filter(|peer| peer.active)
                        .map(|_| ServerSignalFrame::Presence {
                            device_id: peer_id.clone(),
                            online: inner
                                .signal_connections
                                .get(peer_id)
                                .is_some_and(|connections| !connections.is_empty()),
                        })
                })
                .collect();
            let notify_senders = if was_online {
                Vec::new()
            } else {
                peers
                    .iter()
                    .flat_map(|peer_id| signal_senders_for(&inner, peer_id))
                    .collect()
            };
            (initial_presence, notify_senders)
        };

        for sender in notify_senders {
            let _ = sender.try_send(ServerSignalFrame::Presence {
                device_id: device_id.to_owned(),
                online: true,
            });
        }
        Ok(initial_presence)
    }

    fn detach_signal(&self, device_id: &str, connection_id: Uuid) {
        let notify_senders = {
            let mut inner = lock(&self.inner);
            let Some(connections) = inner.signal_connections.get_mut(device_id) else {
                return;
            };
            if connections.remove(&connection_id).is_none() || !connections.is_empty() {
                return;
            }
            inner.signal_connections.remove(device_id);
            let peers: Vec<_> = inner
                .devices
                .get(device_id)
                .map(|device| device.paired_with.iter().cloned().collect())
                .unwrap_or_default();
            peers
                .iter()
                .flat_map(|peer_id| signal_senders_for(&inner, peer_id))
                .collect::<Vec<_>>()
        };

        for sender in notify_senders {
            let _ = sender.try_send(ServerSignalFrame::Presence {
                device_id: device_id.to_owned(),
                online: false,
            });
        }
    }

    fn route_signal(
        &self,
        from: &str,
        to: &str,
        session_id: &str,
        payload: Value,
    ) -> Result<(), GatewayError> {
        validate_session_id(session_id)?;
        if serde_json::to_vec(&payload)
            .map_err(|_| GatewayError::Invalid)?
            .len()
            > self.config.max_ws_message_bytes
        {
            return Err(GatewayError::Invalid);
        }
        let senders = {
            let inner = lock(&self.inner);
            active_device(&inner, from)?;
            active_device(&inner, to)?;
            if !are_paired(&inner, from, to) {
                return Err(GatewayError::Forbidden);
            }
            signal_senders_for(&inner, to)
        };
        if senders.is_empty() {
            return Err(GatewayError::PeerOffline);
        }

        let frame = ServerSignalFrame::Signal {
            from: from.to_owned(),
            session_id: session_id.to_owned(),
            payload,
        };
        let delivered = senders
            .into_iter()
            .filter(|sender| sender.try_send(frame.clone()).is_ok())
            .count();
        if delivered == 0 {
            return Err(GatewayError::PeerOffline);
        }
        Ok(())
    }

    fn bind_relay(
        &self,
        device_id: &str,
        peer_id: &str,
        session_id: &str,
        connection_id: Uuid,
        sender: RelaySender,
    ) -> Result<bool, GatewayError> {
        validate_session_id(session_id)?;
        let (peer_was_connected, peer_senders) = {
            let mut inner = lock(&self.inner);
            active_device(&inner, device_id)?;
            active_device(&inner, peer_id)?;
            if !are_paired(&inner, device_id, peer_id) {
                return Err(GatewayError::Forbidden);
            }
            let key = RelayKey::new(device_id, peer_id, session_id);
            let session = inner.relay_sessions.entry(key).or_default();
            if session.endpoints.contains_key(device_id) {
                return Err(GatewayError::Conflict);
            }
            let peer_was_connected = session.endpoints.contains_key(peer_id);
            let peer_senders = session
                .endpoints
                .get(peer_id)
                .map(|endpoint| vec![endpoint.sender.clone()])
                .unwrap_or_default();
            session.endpoints.insert(
                device_id.to_owned(),
                RelayEndpoint {
                    connection_id,
                    sender,
                },
            );
            (peer_was_connected, peer_senders)
        };

        for sender in peer_senders {
            let _ = sender.try_send(RelayOutbound::Control(
                RelayServerControlFrame::PeerConnected {
                    device_id: device_id.to_owned(),
                    session_id: session_id.to_owned(),
                },
            ));
        }
        Ok(peer_was_connected)
    }

    fn forward_relay(
        &self,
        from: &str,
        peer_id: &str,
        session_id: &str,
        payload: Vec<u8>,
    ) -> Result<(), GatewayError> {
        if payload.len() > self.config.max_ws_message_bytes {
            return Err(GatewayError::Invalid);
        }
        let sender = {
            let inner = lock(&self.inner);
            active_device(&inner, from)?;
            active_device(&inner, peer_id)?;
            if !are_paired(&inner, from, peer_id) {
                return Err(GatewayError::Forbidden);
            }
            let key = RelayKey::new(from, peer_id, session_id);
            inner
                .relay_sessions
                .get(&key)
                .and_then(|session| session.endpoints.get(peer_id))
                .map(|endpoint| endpoint.sender.clone())
                .ok_or(GatewayError::PeerOffline)?
        };
        sender
            .try_send(RelayOutbound::Binary(payload))
            .map_err(|_| GatewayError::PeerOffline)
    }

    fn detach_relay(&self, device_id: &str, peer_id: &str, session_id: &str, connection_id: Uuid) {
        let peer_sender = {
            let mut inner = lock(&self.inner);
            let key = RelayKey::new(device_id, peer_id, session_id);
            let Some(session) = inner.relay_sessions.get_mut(&key) else {
                return;
            };
            let is_same_connection = session
                .endpoints
                .get(device_id)
                .is_some_and(|endpoint| endpoint.connection_id == connection_id);
            if !is_same_connection {
                return;
            }
            session.endpoints.remove(device_id);
            let peer_sender = session
                .endpoints
                .get(peer_id)
                .map(|endpoint| endpoint.sender.clone());
            if session.endpoints.is_empty() {
                inner.relay_sessions.remove(&key);
            }
            peer_sender
        };

        if let Some(sender) = peer_sender {
            let _ = sender.try_send(RelayOutbound::Control(
                RelayServerControlFrame::PeerDisconnected {
                    device_id: device_id.to_owned(),
                    session_id: session_id.to_owned(),
                },
            ));
        }
    }
}

fn lock(inner: &Arc<Mutex<GatewayInner>>) -> std::sync::MutexGuard<'_, GatewayInner> {
    inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn active_device<'a>(
    inner: &'a GatewayInner,
    device_id: &str,
) -> Result<&'a DeviceRecord, GatewayError> {
    inner
        .devices
        .get(device_id)
        .filter(|device| device.active)
        .ok_or(GatewayError::Unauthorized)
}

fn are_paired(inner: &GatewayInner, first: &str, second: &str) -> bool {
    inner
        .devices
        .get(first)
        .is_some_and(|device| device.active && device.paired_with.contains(second))
        && inner
            .devices
            .get(second)
            .is_some_and(|device| device.active && device.paired_with.contains(first))
}

fn signal_senders_for(inner: &GatewayInner, device_id: &str) -> Vec<SignalSender> {
    inner
        .signal_connections
        .get(device_id)
        .map(|connections| connections.values().cloned().collect())
        .unwrap_or_default()
}

fn bearer_credential(headers: &HeaderMap) -> Result<&str, GatewayError> {
    optional_bearer_credential(headers)?.ok_or(GatewayError::Unauthorized)
}

/// Pairing registration is capability-based on first use: a desktop that has
/// no gateway credential may register a short-lived invitation and receives a
/// new desktop credential in the response. Every other protected route still
/// requires a bearer credential, and a malformed Authorization header never
/// silently downgrades to this bootstrap path.
fn optional_bearer_credential(headers: &HeaderMap) -> Result<Option<&str>, GatewayError> {
    let Some(value) = headers.get(AUTHORIZATION) else {
        return Ok(None);
    };
    let value = value.to_str().map_err(|_| GatewayError::Unauthorized)?;
    let credential = value
        .strip_prefix("Bearer ")
        .filter(|credential| !credential.is_empty())
        .ok_or(GatewayError::Unauthorized)?;
    Ok(Some(credential))
}

fn validate_ice_servers(servers: &[String]) -> Result<Vec<String>, GatewayError> {
    if servers.len() > MAX_ICE_SERVERS {
        return Err(GatewayError::Invalid);
    }
    let mut validated = Vec::with_capacity(servers.len());
    for server in servers {
        let server = server.trim();
        if !valid_public_stun_uri(server) || validated.iter().any(|known| known == server) {
            return Err(GatewayError::Invalid);
        }
        validated.push(server.to_owned());
    }
    Ok(validated)
}

fn valid_public_stun_uri(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_ICE_SERVER_BYTES
        || value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return false;
    }
    let Some((scheme, endpoint)) = value.split_once(':') else {
        return false;
    };
    if !matches!(scheme, "stun" | "stuns")
        || endpoint.is_empty()
        || endpoint.contains(['@', '/', '?', '#', '[', ']'])
    {
        return false;
    }
    let (host, port) = match endpoint.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (endpoint, None),
    };
    let valid_host = match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(address)) => valid_public_ipv4_address(address),
        Ok(std::net::IpAddr::V6(_)) => false,
        Err(_) => valid_public_dns_name(host),
    };
    if !valid_host {
        return false;
    }
    port.is_none_or(|port| !port.is_empty() && port.parse::<u16>().is_ok_and(|port| port != 0))
}

fn valid_public_ipv4_address(address: std::net::Ipv4Addr) -> bool {
    let [first, second, third, _] = address.octets();
    if first == 0
        || first == 10
        || first == 127
        || first >= 224
        || (first == 100 && (64..=127).contains(&second))
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 0 && third == 0)
        || (first == 192 && second == 0 && third == 2)
        || (first == 192 && second == 168)
        || (first == 198 && (second == 18 || second == 19))
        || (first == 198 && second == 51 && third == 100)
        || (first == 203 && second == 0 && third == 113)
    {
        return false;
    }
    true
}

fn valid_public_dns_name(host: &str) -> bool {
    if host.len() > 253
        || !host.contains('.')
        || host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".local")
    {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

/// Extract an opaque ticket from the browser's offered subprotocol list.
/// Browser WebSocket APIs cannot set Authorization headers, and accepting
/// credentials in URLs would leak them through browser history and many proxy
/// logs. Require exactly the fixed application subprotocol plus one ticket.
fn browser_websocket_ticket_from_protocols(headers: &HeaderMap) -> Result<String, GatewayError> {
    if headers.contains_key(AUTHORIZATION) {
        // Browser endpoints intentionally never accept a raw device bearer
        // credential. This also catches accidental non-browser integrations.
        return Err(GatewayError::Invalid);
    }

    let protocol_headers: Vec<_> = headers.get_all(SEC_WEBSOCKET_PROTOCOL).iter().collect();
    if protocol_headers.len() != 1 {
        return Err(GatewayError::Unauthorized);
    }
    let protocols = protocol_headers[0]
        .to_str()
        .map_err(|_| GatewayError::Unauthorized)?;
    let offered: Vec<_> = protocols.split(',').map(str::trim).collect();
    if offered.len() != 2 || offered.iter().any(|protocol| protocol.is_empty()) {
        return Err(GatewayError::Unauthorized);
    }

    let has_fixed_subprotocol = offered.contains(&BROWSER_WEBSOCKET_SUBPROTOCOL);
    let ticket = offered
        .iter()
        .copied()
        .find(|protocol| is_valid_browser_websocket_ticket(protocol))
        .ok_or(GatewayError::Unauthorized)?;
    if !has_fixed_subprotocol {
        return Err(GatewayError::Unauthorized);
    }

    // `offered.len() == 2` plus the checks above means the remaining value is
    // exactly the expected fixed subprotocol, rather than an arbitrary token.
    if offered
        .iter()
        .any(|protocol| *protocol != BROWSER_WEBSOCKET_SUBPROTOCOL && *protocol != ticket)
    {
        return Err(GatewayError::Unauthorized);
    }
    Ok(ticket.to_owned())
}

fn validate_browser_websocket_uri(uri: &Uri) -> Result<(), GatewayError> {
    // These routes have no query parameters. Rejecting all queries makes an
    // accidental `?ticket=...` integration fail closed before it can become a
    // supported or silently accepted credential channel.
    uri.query()
        .is_none()
        .then_some(())
        .ok_or(GatewayError::Invalid)
}

fn random_browser_websocket_ticket() -> String {
    format!("{BROWSER_WEBSOCKET_TICKET_PREFIX}{}", random_secret())
}

fn is_valid_browser_websocket_ticket(ticket: &str) -> bool {
    ticket
        .strip_prefix(BROWSER_WEBSOCKET_TICKET_PREFIX)
        .is_some_and(|secret| {
            !secret.is_empty()
                && ticket.len() <= BROWSER_WEBSOCKET_TICKET_MAX_LEN
                && secret
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
}

fn validate_session_id(session_id: &str) -> Result<(), GatewayError> {
    let valid = !session_id.is_empty()
        && session_id.len() <= 128
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    valid.then_some(()).ok_or(GatewayError::Invalid)
}

fn random_secret() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_secret(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

pub fn router(state: GatewayState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/pairings", post(start_pairing))
        .route(
            "/v1/pairings/{pairing_id}/claims",
            get(pending_claim).post(claim_pairing),
        )
        .route("/v1/pairings/{pairing_id}/approve", post(approve_pairing))
        .route(
            "/v1/pairings/{pairing_id}/claims/{claim_id}/complete",
            post(complete_pairing),
        )
        .route("/v1/me", get(me))
        .route("/v1/devices/self", delete(revoke_self))
        .route("/v1/devices/{device_id}", delete(revoke_device))
        .route(
            "/v1/browser-ws-tickets",
            post(create_browser_websocket_ticket),
        )
        .route("/v1/signal", get(signal_websocket))
        .route("/v1/relay", get(relay_websocket))
        .route("/v1/browser-signal", get(browser_signal_websocket))
        .route("/v1/browser-relay", get(browser_relay_websocket))
        .with_state(state)
}

async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn start_pairing(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<StartPairingRequest>,
) -> Result<Json<StartPairingResponse>, ApiError> {
    let credential = optional_bearer_credential(&headers)?;
    Ok(Json(state.start_pairing(credential, request)?))
}

async fn claim_pairing(
    State(state): State<GatewayState>,
    Path(pairing_id): Path<String>,
    Json(request): Json<ClaimPairingRequest>,
) -> Result<Json<ClaimPairingResponse>, ApiError> {
    Ok(Json(state.claim_pairing(&pairing_id, request)?))
}

async fn pending_claim(
    State(state): State<GatewayState>,
    Path(pairing_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<PendingPairingClaim>, ApiError> {
    Ok(Json(state.pending_claim(
        &pairing_id,
        state.authenticate_device_header(&headers)?,
    )?))
}

async fn approve_pairing(
    State(state): State<GatewayState>,
    Path(pairing_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ApprovePairingRequest>,
) -> Result<Json<ApprovePairingResponse>, ApiError> {
    let desktop = state.authenticate_device_header(&headers)?;
    Ok(Json(state.approve_pairing(
        &pairing_id,
        desktop,
        request,
    )?))
}

async fn complete_pairing(
    State(state): State<GatewayState>,
    Path((pairing_id, claim_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<CompletePairingResponse>, ApiError> {
    let activation_token = bearer_credential(&headers)?;
    Ok(Json(state.complete_pairing(
        &pairing_id,
        &claim_id,
        activation_token,
    )?))
}

async fn me(
    State(state): State<GatewayState>,
    headers: HeaderMap,
) -> Result<Json<MeResponse>, ApiError> {
    Ok(Json(state.me(state.authenticate_device_header(&headers)?)?))
}

async fn revoke_device(
    State(state): State<GatewayState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<RevokeDeviceResponse>, ApiError> {
    Ok(Json(state.revoke_device(
        state.authenticate_device_header(&headers)?,
        &device_id,
    )?))
}

async fn revoke_self(
    State(state): State<GatewayState>,
    headers: HeaderMap,
) -> Result<Json<RevokeDeviceResponse>, ApiError> {
    Ok(Json(state.revoke_self(
        state.authenticate_device_header(&headers)?,
    )?))
}

async fn create_browser_websocket_ticket(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<CreateBrowserWebSocketTicketRequest>,
) -> Result<Json<CreateBrowserWebSocketTicketResponse>, ApiError> {
    let device = state.authenticate_device_header(&headers)?;
    Ok(Json(state.create_browser_websocket_ticket(
        device,
        request.endpoint,
    )?))
}

async fn signal_websocket(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let device = state.authenticate_device_header(&headers)?;
    let max_message_size = state.config.max_ws_message_bytes;
    Ok(websocket
        .max_message_size(max_message_size)
        .on_upgrade(move |socket| run_signal_socket(state, device.id, socket)))
}

async fn relay_websocket(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let device = state.authenticate_device_header(&headers)?;
    let max_message_size = state.config.max_ws_message_bytes;
    Ok(websocket
        .max_message_size(max_message_size)
        .on_upgrade(move |socket| run_relay_socket(state, device.id, socket)))
}

async fn browser_signal_websocket(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    uri: Uri,
    websocket: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    validate_browser_websocket_uri(&uri)?;
    let ticket = browser_websocket_ticket_from_protocols(&headers)?;
    let device =
        state.consume_browser_websocket_ticket(&ticket, BrowserWebSocketEndpoint::Signal)?;
    let max_message_size = state.config.max_ws_message_bytes;
    Ok(websocket
        .protocols([BROWSER_WEBSOCKET_SUBPROTOCOL])
        .max_message_size(max_message_size)
        .on_upgrade(move |socket| run_signal_socket(state, device.id, socket)))
}

async fn browser_relay_websocket(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    uri: Uri,
    websocket: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    validate_browser_websocket_uri(&uri)?;
    let ticket = browser_websocket_ticket_from_protocols(&headers)?;
    let device =
        state.consume_browser_websocket_ticket(&ticket, BrowserWebSocketEndpoint::Relay)?;
    let max_message_size = state.config.max_ws_message_bytes;
    Ok(websocket
        .protocols([BROWSER_WEBSOCKET_SUBPROTOCOL])
        .max_message_size(max_message_size)
        .on_upgrade(move |socket| run_relay_socket(state, device.id, socket)))
}

async fn run_signal_socket(state: GatewayState, device_id: DeviceId, socket: WebSocket) {
    let connection_id = Uuid::new_v4();
    let (outbound_sender, mut outbound_receiver) = mpsc::channel(SIGNAL_OUTBOUND_CAPACITY);
    let initial_presence = match state.attach_signal(&device_id, connection_id, outbound_sender) {
        Ok(initial_presence) => initial_presence,
        Err(_) => return,
    };
    let (mut sender, mut receiver) = socket.split();

    if send_signal_frame(
        &mut sender,
        ServerSignalFrame::Ready {
            device_id: device_id.clone(),
        },
    )
    .await
    .is_err()
    {
        state.detach_signal(&device_id, connection_id);
        return;
    }
    for frame in initial_presence {
        if send_signal_frame(&mut sender, frame).await.is_err() {
            state.detach_signal(&device_id, connection_id);
            return;
        }
    }

    loop {
        tokio::select! {
            outbound = outbound_receiver.recv() => {
                let Some(frame) = outbound else { break; };
                if send_signal_frame(&mut sender, frame).await.is_err() {
                    break;
                }
            }
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else { break; };
                match message {
                    Message::Text(text) => match serde_json::from_str::<ClientSignalFrame>(&text) {
                        Ok(ClientSignalFrame::Signal { to, session_id, payload }) => {
                            if let Err(error) = state.route_signal(&device_id, &to, &session_id, payload) {
                                if send_signal_frame(&mut sender, signal_error(&error)).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Ok(ClientSignalFrame::Ping { nonce }) => {
                            if send_signal_frame(&mut sender, ServerSignalFrame::Pong { nonce }).await.is_err() {
                                break;
                            }
                        }
                        Err(_) => {
                            if send_signal_frame(&mut sender, signal_error(&GatewayError::Invalid)).await.is_err() {
                                break;
                            }
                        }
                    },
                    Message::Ping(payload) => {
                        if sender.send(Message::Pong(payload)).await.is_err() { break; }
                    }
                    Message::Close(_) => break,
                    Message::Binary(_) => {
                        if send_signal_frame(&mut sender, signal_error(&GatewayError::Invalid)).await.is_err() {
                            break;
                        }
                    }
                    Message::Pong(_) => {}
                }
            }
        }
    }
    state.detach_signal(&device_id, connection_id);
}

async fn run_relay_socket(state: GatewayState, device_id: DeviceId, socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    let opening = timeout(RELAY_OPEN_TIMEOUT, receiver.next()).await;
    let Some(Ok(Message::Text(text))) = opening.ok().flatten() else {
        let _ = send_relay_frame(
            &mut sender,
            RelayServerControlFrame::Error {
                code: "invalid_request",
                message: "the first relay frame must be open",
            },
        )
        .await;
        return;
    };
    let Ok(RelayOpenFrame::Open {
        peer_id,
        session_id,
    }) = serde_json::from_str::<RelayOpenFrame>(&text)
    else {
        let _ = send_relay_frame(
            &mut sender,
            RelayServerControlFrame::Error {
                code: "invalid_request",
                message: "the first relay frame must be open",
            },
        )
        .await;
        return;
    };

    let connection_id = Uuid::new_v4();
    let (outbound_sender, mut outbound_receiver) = mpsc::channel(RELAY_OUTBOUND_CAPACITY);
    let peer_was_connected = match state.bind_relay(
        &device_id,
        &peer_id,
        &session_id,
        connection_id,
        outbound_sender,
    ) {
        Ok(result) => result,
        Err(error) => {
            let _ = send_relay_frame(&mut sender, relay_error(&error)).await;
            return;
        }
    };

    if send_relay_frame(
        &mut sender,
        RelayServerControlFrame::Ready {
            session_id: session_id.clone(),
        },
    )
    .await
    .is_err()
    {
        state.detach_relay(&device_id, &peer_id, &session_id, connection_id);
        return;
    }
    if peer_was_connected
        && send_relay_frame(
            &mut sender,
            RelayServerControlFrame::PeerConnected {
                device_id: peer_id.clone(),
                session_id: session_id.clone(),
            },
        )
        .await
        .is_err()
    {
        state.detach_relay(&device_id, &peer_id, &session_id, connection_id);
        return;
    }

    loop {
        tokio::select! {
            outbound = outbound_receiver.recv() => {
                let Some(frame) = outbound else { break; };
                let result = match frame {
                    RelayOutbound::Control(frame) => send_relay_frame(&mut sender, frame).await,
                    RelayOutbound::Binary(payload) => sender.send(Message::Binary(payload.into())).await,
                };
                if result.is_err() { break; }
            }
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else { break; };
                match message {
                    Message::Binary(payload) => {
                        if let Err(error) = state.forward_relay(&device_id, &peer_id, &session_id, payload.to_vec()) {
                            if send_relay_frame(&mut sender, relay_error(&error)).await.is_err() {
                                break;
                            }
                        }
                    }
                    Message::Text(text) => match serde_json::from_str::<RelayClientControlFrame>(&text) {
                        Ok(RelayClientControlFrame::Ping { nonce }) => {
                            if send_relay_frame(&mut sender, RelayServerControlFrame::Pong { nonce }).await.is_err() {
                                break;
                            }
                        }
                        Err(_) => {
                            if send_relay_frame(&mut sender, relay_error(&GatewayError::Invalid)).await.is_err() {
                                break;
                            }
                        }
                    },
                    Message::Ping(payload) => {
                        if sender.send(Message::Pong(payload)).await.is_err() { break; }
                    }
                    Message::Close(_) => break,
                    Message::Pong(_) => {}
                }
            }
        }
    }
    state.detach_relay(&device_id, &peer_id, &session_id, connection_id);
}

fn signal_error(error: &GatewayError) -> ServerSignalFrame {
    ServerSignalFrame::Error {
        code: error.code(),
        message: error.message(),
    }
}

fn relay_error(error: &GatewayError) -> RelayServerControlFrame {
    RelayServerControlFrame::Error {
        code: error.code(),
        message: error.message(),
    }
}

async fn send_signal_frame(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    frame: ServerSignalFrame,
) -> Result<(), axum::Error> {
    sender.send(json_message(&frame)).await
}

async fn send_relay_frame(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    frame: RelayServerControlFrame,
) -> Result<(), axum::Error> {
    sender.send(json_message(&frame)).await
}

fn json_message<T: Serialize>(value: &T) -> Message {
    // These are server-owned, bounded control frames. A serialization failure
    // is impossible for the static wire structs above.
    Message::Text(
        serde_json::to_string(value)
            .expect("gateway control frame serializes")
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path as TestPath, PathBuf},
        sync::Arc,
    };

    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use futures_util::StreamExt;
    use serde::de::DeserializeOwned;
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{
        client_async,
        tungstenite::{
            client::IntoClientRequest, Error as TungsteniteError, Message as TungsteniteMessage,
        },
    };
    use tower::ServiceExt;

    use super::*;

    use remote_protocol::{
        DeviceId as ProtocolDeviceId, DeviceScope, DeviceSigningKey, KeyAgreementSecret, SessionId,
        SessionKey, SessionRoute, SecureEnvelope,
    };

    struct TestDevice {
        descriptor: DeviceDescriptor,
        signing_key: DeviceSigningKey,
    }

    impl TestDevice {
        fn new(kind: DeviceKind, name: &str) -> Self {
            let signing_key = DeviceSigningKey::generate();
            let agreement_key = KeyAgreementSecret::generate();
            let descriptor = DeviceDescriptor::new(
                ProtocolDeviceId::new(),
                kind,
                name,
                signing_key.public_key(),
                agreement_key.public_key(),
            )
            .expect("valid protocol descriptor");
            Self {
                descriptor,
                signing_key,
            }
        }

        fn id(&self) -> String {
            self.descriptor.device_id.to_string()
        }
    }

    fn requested_scopes() -> DeviceScopes {
        DeviceScopes::from([DeviceScope::ReadProjectState, DeviceScope::ReadTaskTimeline])
    }

    fn invitation(desktop: &TestDevice) -> PairingInvitation {
        PairingInvitation::new(
            desktop.descriptor.clone(),
            "http://localhost:8787",
            now_unix_ms() + 300_000,
        )
        .expect("valid short-lived invitation")
    }

    fn rehydrate_pairing_request(
        invitation: &PairingInvitation,
        claim: &PendingPairingClaim,
    ) -> PairingRequest {
        PairingRequest {
            protocol_version: claim.protocol_version,
            pairing_id: claim.pairing_id,
            pairing_secret: invitation.pairing_secret.clone(),
            mobile: claim.mobile.clone(),
            requested_scopes: claim.requested_scopes.clone(),
            requested_at_unix_ms: claim.requested_at_unix_ms,
            proof: claim.proof,
        }
    }

    fn state() -> GatewayState {
        GatewayState::new(Arc::new(GatewayConfig::test_config()))
    }

    struct TemporaryStateDirectory {
        path: PathBuf,
    }

    impl TemporaryStateDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "somniq-remote-gateway-device-state-{}",
                Uuid::new_v4()
            ));
            fs::create_dir_all(&path).expect("create temporary gateway state directory");
            Self { path }
        }

        fn path(&self) -> &TestPath {
            &self.path
        }
    }

    impl Drop for TemporaryStateDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn durable_test_config(directory: &TestPath) -> Arc<GatewayConfig> {
        let mut config = GatewayConfig::test_config();
        config.state_dir = Some(directory.to_owned());
        Arc::new(config)
    }

    fn bootstrap_pairing(
        state: &GatewayState,
        desktop: &TestDevice,
    ) -> (StartPairingResponse, PairingInvitation) {
        let invitation = invitation(desktop);
        let response = state
            .start_pairing(
                Some(&state.config.bootstrap_token),
                StartPairingRequest {
                    invitation: invitation.clone(),
                    ice_servers: Vec::new(),
                },
            )
            .expect("desktop bootstrap pairing starts");
        (response, invitation)
    }

    fn pair_mobile(
        state: &GatewayState,
        desktop: &TestDevice,
        desktop_token: &str,
        mobile: &TestDevice,
    ) -> String {
        let invitation = invitation(desktop);
        let start = state
            .start_pairing(
                Some(desktop_token),
                StartPairingRequest {
                    invitation: invitation.clone(),
                    ice_servers: Vec::new(),
                },
            )
            .expect("existing desktop starts pairing");
        let scopes = requested_scopes();
        let pairing_request = PairingRequest::signed(
            &invitation,
            mobile.descriptor.clone(),
            scopes.clone(),
            now_unix_ms(),
            &mobile.signing_key,
        )
        .expect("mobile proof is signed");
        let claim = state
            .claim_pairing(
                &start.pairing_id,
                ClaimPairingRequest(pairing_request.clone()),
            )
            .expect("mobile claims the signed invitation");
        let desktop_identity = match state.authenticate_credential(desktop_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => panic!("desktop token must not be bootstrap"),
        };
        let pending = state
            .pending_claim(&start.pairing_id, desktop_identity.clone())
            .expect("desktop reads the authenticated claim transcript");
        let approval_request = rehydrate_pairing_request(&invitation, &pending);
        let approval = PairingApproval::approve(
            &invitation,
            &approval_request,
            SessionId::new(),
            scopes,
            now_unix_ms(),
            &desktop.signing_key,
        )
        .expect("desktop approval is signed after local confirmation");
        state
            .approve_pairing(
                &start.pairing_id,
                desktop_identity,
                ApprovePairingRequest {
                    claim_id: claim.claim_id.clone(),
                    approval,
                },
            )
            .expect("desktop approves pairing");
        state
            .complete_pairing(&start.pairing_id, &claim.claim_id, &claim.activation_token)
            .expect("mobile completes pairing");
        claim.activation_token
    }

    #[test]
    fn completed_pairing_survives_gateway_restart_without_persisting_short_lived_credentials() {
        let temporary_directory = TemporaryStateDirectory::new();
        let config = durable_test_config(temporary_directory.path());
        let state = GatewayState::load(config.clone()).expect("load an empty durable state");
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let mobile_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        let mobile_identity = match state.authenticate_credential(&mobile_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        let ticket = state
            .create_browser_websocket_ticket(mobile_identity, BrowserWebSocketEndpoint::Signal)
            .expect("short-lived browser ticket");

        let state_file = temporary_directory.path().join(DEVICE_STATE_FILE_NAME);
        let serialized = fs::read_to_string(&state_file).expect("durable state is written");
        assert!(serialized.contains("credential_hash"));
        assert!(!serialized.contains(&desktop_token));
        assert!(!serialized.contains(&mobile_token));
        assert!(!serialized.contains(&ticket.ticket));
        assert!(!serialized.contains("pairings"));
        assert!(!serialized.contains("browser_websocket_tickets"));
        drop(state);

        let reloaded = GatewayState::load(config).expect("restart loads completed devices");
        let desktop_identity = match reloaded.authenticate_credential(&desktop_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        assert!(matches!(
            reloaded.authenticate_credential(&mobile_token),
            Ok(CredentialSubject::Device(AuthenticatedDevice { id, role: DeviceKind::Mobile })) if id == mobile.id()
        ));
        let overview = reloaded
            .me(desktop_identity)
            .expect("desktop remains paired");
        assert_eq!(overview.paired_devices.len(), 1);
        assert_eq!(overview.paired_devices[0].id, mobile.id());
        assert!(matches!(
            reloaded
                .consume_browser_websocket_ticket(&ticket.ticket, BrowserWebSocketEndpoint::Signal),
            Err(GatewayError::Unauthorized)
        ));
    }

    #[test]
    fn durable_device_state_accepts_a_legacy_newapi_owner_digest() {
        let temporary_directory = TemporaryStateDirectory::new();
        let config = durable_test_config(temporary_directory.path());
        let state = GatewayState::load(config.clone()).expect("load an empty durable state");
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let initial_mobile = TestDevice::new(DeviceKind::Mobile, "Initial research phone");
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let _ = pair_mobile(&state, &desktop, &desktop_token, &initial_mobile);
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let _mobile_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        let state_file = temporary_directory.path().join(DEVICE_STATE_FILE_NAME);
        let mut persisted: Value = serde_json::from_str(
            &fs::read_to_string(&state_file).expect("durable state is written"),
        )
        .expect("durable state is JSON");
        persisted["devices"][0]["owner_hash"] = Value::String(hash_secret("legacy-owner"));
        fs::write(
            &state_file,
            serde_json::to_vec(&persisted).expect("legacy state serializes"),
        )
        .expect("replace durable state with legacy schema");
        drop(state);

        let reloaded = GatewayState::load(config).expect("legacy owner digest remains readable");
        assert!(matches!(
            reloaded.authenticate_credential(&desktop_token),
            Ok(CredentialSubject::Device(AuthenticatedDevice { id, role: DeviceKind::Desktop })) if id == desktop.id()
        ));
        let serialized = fs::read_to_string(&state_file).expect("state remains readable");
        assert!(serialized.contains("owner_hash"));

        drop(reloaded);

        // Write a new durable state through a second completed pairing, then
        // ensure the deprecated field is not preserved indefinitely.
        let state = GatewayState::load(durable_test_config(temporary_directory.path()))
            .expect("legacy state reloads for migration");
        let second_mobile = TestDevice::new(DeviceKind::Mobile, "Second research phone");
        let mobile_token = pair_mobile(&state, &desktop, &desktop_token, &second_mobile);
        assert!(matches!(
            state.authenticate_credential(&mobile_token),
            Ok(CredentialSubject::Device(AuthenticatedDevice {
                role: DeviceKind::Mobile,
                ..
            }))
        ));
        let migrated = fs::read_to_string(&state_file).expect("completed pairing rewrites state");
        assert!(!migrated.contains("owner_hash"));
    }

    #[test]
    fn revoked_mobile_remains_revoked_after_gateway_restart() {
        let temporary_directory = TemporaryStateDirectory::new();
        let config = durable_test_config(temporary_directory.path());
        let state = GatewayState::load(config.clone()).expect("load an empty durable state");
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let mobile_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        let desktop_identity = match state.authenticate_credential(&desktop_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        state
            .revoke_device(desktop_identity, &mobile.id())
            .expect("desktop revokes mobile");
        drop(state);

        let reloaded = GatewayState::load(config).expect("restart loads revocation state");
        assert!(matches!(
            reloaded.authenticate_credential(&mobile_token),
            Err(GatewayError::Unauthorized)
        ));
        let desktop_identity = match reloaded.authenticate_credential(&desktop_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        assert!(reloaded
            .me(desktop_identity)
            .expect("desktop remains valid")
            .paired_devices
            .is_empty());
    }

    #[test]
    fn durable_desktop_survives_revocation_while_another_phone_is_awaiting_completion() {
        let temporary_directory = TemporaryStateDirectory::new();
        let config = durable_test_config(temporary_directory.path());
        let state = GatewayState::load(config.clone()).expect("load an empty durable state");
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let first_mobile = TestDevice::new(DeviceKind::Mobile, "First research phone");
        let second_mobile = TestDevice::new(DeviceKind::Mobile, "Second research phone");
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let first_mobile_token = pair_mobile(&state, &desktop, &desktop_token, &first_mobile);

        let second_invitation = invitation(&desktop);
        let second_start = state
            .start_pairing(
                Some(&desktop_token),
                StartPairingRequest {
                    invitation: second_invitation.clone(),
                    ice_servers: Vec::new(),
                },
            )
            .expect("durable desktop starts a second pairing");
        let scopes = requested_scopes();
        let second_claim = state
            .claim_pairing(
                &second_start.pairing_id,
                ClaimPairingRequest(
                    PairingRequest::signed(
                        &second_invitation,
                        second_mobile.descriptor.clone(),
                        scopes.clone(),
                        now_unix_ms(),
                        &second_mobile.signing_key,
                    )
                    .expect("second mobile claim is signed"),
                ),
            )
            .expect("second mobile claims pairing");
        let desktop_identity = match state.authenticate_credential(&desktop_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        let pending = state
            .pending_claim(&second_start.pairing_id, desktop_identity.clone())
            .expect("desktop reads the second pending claim");
        let approval = PairingApproval::approve(
            &second_invitation,
            &rehydrate_pairing_request(&second_invitation, &pending),
            SessionId::new(),
            scopes,
            now_unix_ms(),
            &desktop.signing_key,
        )
        .expect("desktop approval is signed");
        state
            .approve_pairing(
                &second_start.pairing_id,
                desktop_identity.clone(),
                ApprovePairingRequest {
                    claim_id: second_claim.claim_id.clone(),
                    approval,
                },
            )
            .expect("second phone is approved but not yet complete");

        state
            .revoke_device(desktop_identity, &first_mobile.id())
            .expect("desktop revokes its first paired phone");
        drop(state);

        let reloaded = GatewayState::load(config).expect("restart loads durable state");
        assert!(matches!(
            reloaded.authenticate_credential(&desktop_token),
            Ok(CredentialSubject::Device(AuthenticatedDevice { id, role: DeviceKind::Desktop })) if id == desktop.id()
        ));
        assert!(matches!(
            reloaded.authenticate_credential(&first_mobile_token),
            Err(GatewayError::Unauthorized)
        ));
        assert!(matches!(
            reloaded.authenticate_credential(&second_claim.activation_token),
            Err(GatewayError::Unauthorized)
        ));
    }

    #[test]
    fn unfinished_pairing_and_activation_token_do_not_survive_gateway_restart() {
        let temporary_directory = TemporaryStateDirectory::new();
        let config = durable_test_config(temporary_directory.path());
        let state = GatewayState::load(config.clone()).expect("load an empty durable state");
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let initial_mobile = TestDevice::new(DeviceKind::Mobile, "Initial research phone");
        let _ = pair_mobile(&state, &desktop, &desktop_token, &initial_mobile);
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let first_invitation = invitation(&desktop);
        let started = state
            .start_pairing(
                Some(&desktop_token),
                StartPairingRequest {
                    invitation: first_invitation.clone(),
                    ice_servers: Vec::new(),
                },
            )
            .expect("desktop starts a second pairing");
        let request = PairingRequest::signed(
            &first_invitation,
            mobile.descriptor.clone(),
            requested_scopes(),
            now_unix_ms(),
            &mobile.signing_key,
        )
        .expect("mobile signs claim");
        let claim = state
            .claim_pairing(&started.pairing_id, ClaimPairingRequest(request))
            .expect("mobile claims pairing");
        let serialized =
            fs::read_to_string(temporary_directory.path().join(DEVICE_STATE_FILE_NAME))
                .expect("desktop state is written");
        assert!(!serialized.contains(&claim.activation_token));
        assert!(!serialized.contains(&hash_secret(&claim.activation_token)));
        assert!(!serialized.contains(&started.pairing_id));
        drop(state);

        let reloaded = GatewayState::load(config).expect("restart loads durable device only");
        let desktop_identity = match reloaded.authenticate_credential(&desktop_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        assert!(matches!(
            reloaded.pending_claim(&started.pairing_id, desktop_identity),
            Err(GatewayError::NotFound)
        ));
        assert!(matches!(
            reloaded.authenticate_credential(&claim.activation_token),
            Err(GatewayError::Unauthorized)
        ));
    }

    #[test]
    fn durable_device_state_rejects_a_different_bootstrap_secret() {
        let temporary_directory = TemporaryStateDirectory::new();
        let config = durable_test_config(temporary_directory.path());
        let state = GatewayState::load(config.clone()).expect("load durable state");
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let _ = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        drop(state);

        let mut changed_config = GatewayConfig::test_config();
        changed_config.bootstrap_token =
            "different-test-bootstrap-token-that-is-long-enough".into();
        changed_config.state_dir = Some(temporary_directory.path().to_owned());
        assert!(GatewayState::load(Arc::new(changed_config)).is_err());
    }

    #[test]
    fn approval_activates_only_the_claimed_mobile_credential() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let (start, invitation) = bootstrap_pairing(&state, &desktop);
        let desktop_token = start
            .desktop_token
            .clone()
            .expect("bootstrap returns desktop token");
        let requested_scopes = requested_scopes();
        let pairing_request = PairingRequest::signed(
            &invitation,
            mobile.descriptor.clone(),
            requested_scopes.clone(),
            now_unix_ms(),
            &mobile.signing_key,
        )
        .expect("mobile proof is valid");
        let claim = state
            .claim_pairing(
                &start.pairing_id,
                ClaimPairingRequest(pairing_request.clone()),
            )
            .expect("phone can claim a signed invitation");

        assert!(
            matches!(
                state.authenticate_credential(&claim.activation_token),
                Err(GatewayError::Unauthorized)
            ),
            "a claimed token must remain inactive before physical desktop approval"
        );

        let desktop_identity = match state.authenticate_credential(&desktop_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        let pending = state
            .pending_claim(&start.pairing_id, desktop_identity.clone())
            .expect("only the paired desktop can view the pending request");
        assert_eq!(pending.pairing_id, invitation.pairing_id);
        assert_eq!(pending.mobile, mobile.descriptor);
        assert_eq!(pending.requested_scopes, requested_scopes);
        let approval_request = rehydrate_pairing_request(&invitation, &pending);
        assert_eq!(approval_request, pairing_request);
        let approval = PairingApproval::approve(
            &invitation,
            &approval_request,
            SessionId::new(),
            requested_scopes,
            now_unix_ms(),
            &desktop.signing_key,
        )
        .expect("desktop signing key approves the exact request");
        let approved = state
            .approve_pairing(
                &start.pairing_id,
                desktop_identity,
                ApprovePairingRequest {
                    claim_id: claim.claim_id.clone(),
                    approval,
                },
            )
            .expect("desktop approval succeeds");
        assert_eq!(approved.status, PairingStatus::Approved);
        assert!(!approved.device.active);
        assert!(matches!(
            state.authenticate_credential(&claim.activation_token),
            Err(GatewayError::Unauthorized)
        ));

        let completed = state
            .complete_pairing(&start.pairing_id, &claim.claim_id, &claim.activation_token)
            .expect("the approved phone can activate");
        assert_eq!(completed.status, PairingStatus::Completed);
        assert!(matches!(
            state.authenticate_credential(&claim.activation_token),
            Ok(CredentialSubject::Device(AuthenticatedDevice { id, role: DeviceKind::Mobile })) if id == mobile.id()
        ));
    }

    #[test]
    fn revoked_mobile_can_complete_a_fresh_pairing_ceremony() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let first_phone_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);

        let desktop_identity = match state.authenticate_credential(&desktop_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        state
            .revoke_device(desktop_identity, &mobile.id())
            .expect("desktop revokes phone");
        assert!(matches!(
            state.authenticate_credential(&first_phone_token),
            Err(GatewayError::Unauthorized)
        ));

        let repaired_phone_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        assert_ne!(first_phone_token, repaired_phone_token);
        assert!(matches!(
            state.authenticate_credential(&repaired_phone_token),
            Ok(CredentialSubject::Device(AuthenticatedDevice { id, role: DeviceKind::Mobile })) if id == mobile.id()
        ));
    }

    #[tokio::test]
    async fn mobile_self_revoke_clears_its_transport_state_without_widening_device_revoke() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let desktop_id = desktop.id();
        let mobile_id = mobile.id();
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let mobile_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        let mobile_identity = match state.authenticate_credential(&mobile_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        let ticket = state
            .create_browser_websocket_ticket(
                mobile_identity.clone(),
                BrowserWebSocketEndpoint::Signal,
            )
            .expect("active mobile receives a browser ticket");

        let (desktop_signal_sender, mut desktop_signal_receiver) = mpsc::channel(4);
        state
            .attach_signal(&desktop_id, Uuid::new_v4(), desktop_signal_sender)
            .expect("desktop signal connection attaches");
        let (mobile_signal_sender, mut mobile_signal_receiver) = mpsc::channel(4);
        state
            .attach_signal(&mobile_id, Uuid::new_v4(), mobile_signal_sender)
            .expect("mobile signal connection attaches");
        // The mobile connection announces its initial online presence. It is
        // not the offline notification asserted after revocation below.
        while desktop_signal_receiver.try_recv().is_ok() {}

        let relay_session_id = "self-revoke-relay-session";
        let (desktop_relay_sender, mut desktop_relay_receiver) = mpsc::channel(4);
        state
            .bind_relay(
                &desktop_id,
                &mobile_id,
                relay_session_id,
                Uuid::new_v4(),
                desktop_relay_sender,
            )
            .expect("desktop relay endpoint attaches");
        let (mobile_relay_sender, mut mobile_relay_receiver) = mpsc::channel(4);
        state
            .bind_relay(
                &mobile_id,
                &desktop_id,
                relay_session_id,
                Uuid::new_v4(),
                mobile_relay_sender,
            )
            .expect("mobile relay endpoint attaches");
        while desktop_relay_receiver.try_recv().is_ok() {}

        let app = router(state.clone());
        let mobile_cannot_select_desktop = app
            .clone()
            .oneshot(
                Request::delete(format!("/v1/devices/{desktop_id}"))
                    .header("authorization", format!("Bearer {mobile_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("gateway responds");
        assert_eq!(
            mobile_cannot_select_desktop.status(),
            StatusCode::FORBIDDEN,
            "the desktop ID-based revoke route remains desktop-only"
        );

        let desktop_cannot_self_revoke = app
            .clone()
            .oneshot(
                Request::delete("/v1/devices/self")
                    .header("authorization", format!("Bearer {desktop_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("gateway responds");
        assert_eq!(desktop_cannot_self_revoke.status(), StatusCode::FORBIDDEN);

        let revoked = app
            .oneshot(
                Request::delete("/v1/devices/self")
                    .header("authorization", format!("Bearer {mobile_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("gateway responds");
        assert_eq!(revoked.status(), StatusCode::OK);

        assert!(matches!(
            state.authenticate_credential(&mobile_token),
            Err(GatewayError::Unauthorized)
        ));
        assert!(matches!(
            state
                .consume_browser_websocket_ticket(&ticket.ticket, BrowserWebSocketEndpoint::Signal),
            Err(GatewayError::Unauthorized)
        ));
        assert!(matches!(
            mobile_signal_receiver.try_recv(),
            Ok(ServerSignalFrame::Revoked { device_id }) if device_id == mobile_id
        ));
        assert!(matches!(
            desktop_signal_receiver.try_recv(),
            Ok(ServerSignalFrame::Revoked { device_id }) if device_id == mobile_id
        ));
        assert!(desktop_signal_receiver.try_recv().is_err());
        assert!(matches!(
            desktop_relay_receiver.try_recv(),
            Ok(RelayOutbound::Control(RelayServerControlFrame::Error {
                code: "revoked",
                ..
            }))
        ));
        assert!(matches!(
            mobile_relay_receiver.try_recv(),
            Ok(RelayOutbound::Control(RelayServerControlFrame::Error {
                code: "revoked",
                ..
            }))
        ));

        let inner = lock(&state.inner);
        let mobile_record = inner
            .devices
            .get(&mobile_id)
            .expect("mobile remains revocable history");
        assert!(!mobile_record.active);
        assert!(mobile_record.revoked);
        assert!(!inner.signal_connections.contains_key(&mobile_id));
        assert!(inner
            .browser_websocket_tickets
            .values()
            .all(|stored| stored.device_id != mobile_id));
        assert!(inner
            .relay_sessions
            .keys()
            .all(|key| key.first != mobile_id && key.second != mobile_id));
        assert!(!inner.devices[&desktop_id].paired_with.contains(&mobile_id));
    }

    #[test]
    fn browser_websocket_ticket_is_endpoint_scoped_and_single_use() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let mobile_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        let mobile_identity = match state.authenticate_credential(&mobile_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => panic!("mobile token cannot authenticate as bootstrap"),
        };

        let issued = state
            .create_browser_websocket_ticket(mobile_identity, BrowserWebSocketEndpoint::Signal)
            .expect("active mobile can mint a signal ticket");
        assert_eq!(issued.endpoint, BrowserWebSocketEndpoint::Signal);
        assert!(issued.ticket.starts_with(BROWSER_WEBSOCKET_TICKET_PREFIX));
        assert!(issued.expires_at_unix_ms > now_unix_ms());

        assert!(
            matches!(
                state.consume_browser_websocket_ticket(
                    &issued.ticket,
                    BrowserWebSocketEndpoint::Relay
                ),
                Err(GatewayError::Forbidden)
            ),
            "a signal ticket must not work at the browser relay endpoint"
        );
        let consumed = state
            .consume_browser_websocket_ticket(&issued.ticket, BrowserWebSocketEndpoint::Signal)
            .expect("the matching endpoint consumes the ticket");
        assert_eq!(consumed.id, mobile.id());
        assert!(matches!(
            state
                .consume_browser_websocket_ticket(&issued.ticket, BrowserWebSocketEndpoint::Signal),
            Err(GatewayError::Unauthorized)
        ));
    }

    #[test]
    fn browser_websocket_tickets_are_bounded_per_mobile_device() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let mobile_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        let mobile_identity = match state.authenticate_credential(&mobile_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };

        for _ in 0..MAX_BROWSER_WEBSOCKET_TICKETS_PER_DEVICE {
            state
                .create_browser_websocket_ticket(
                    mobile_identity.clone(),
                    BrowserWebSocketEndpoint::Signal,
                )
                .expect("bounded outstanding browser ticket");
        }
        assert!(matches!(
            state.create_browser_websocket_ticket(mobile_identity, BrowserWebSocketEndpoint::Relay),
            Err(GatewayError::Conflict)
        ));
    }

    #[test]
    fn browser_websocket_ticket_expiry_and_revocation_are_enforced() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let mobile_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        let mobile_identity = match state.authenticate_credential(&mobile_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        let expired_ticket = state
            .create_browser_websocket_ticket(
                mobile_identity.clone(),
                BrowserWebSocketEndpoint::Signal,
            )
            .expect("ticket is issued");
        {
            let mut inner = lock(&state.inner);
            inner
                .browser_websocket_tickets
                .get_mut(&hash_secret(&expired_ticket.ticket))
                .expect("ticket is retained by digest")
                .expires_at_unix_ms = now_unix_ms().saturating_sub(1);
        }
        assert!(matches!(
            state.consume_browser_websocket_ticket(
                &expired_ticket.ticket,
                BrowserWebSocketEndpoint::Signal
            ),
            Err(GatewayError::Expired)
        ));

        let revoked_ticket = state
            .create_browser_websocket_ticket(mobile_identity, BrowserWebSocketEndpoint::Relay)
            .expect("fresh ticket is issued");
        let desktop_identity = match state.authenticate_credential(&desktop_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        state
            .revoke_device(desktop_identity, &mobile.id())
            .expect("desktop revokes paired mobile");
        assert!(matches!(
            state.consume_browser_websocket_ticket(
                &revoked_ticket.ticket,
                BrowserWebSocketEndpoint::Relay
            ),
            Err(GatewayError::Unauthorized)
        ));
    }

    #[test]
    fn browser_websocket_protocol_requires_fixed_subprotocol_and_ticket() {
        let ticket = random_browser_websocket_ticket();
        let mut headers = HeaderMap::new();
        headers.insert(
            SEC_WEBSOCKET_PROTOCOL,
            format!("{BROWSER_WEBSOCKET_SUBPROTOCOL}, {ticket}")
                .parse()
                .expect("valid protocol header"),
        );
        assert_eq!(
            browser_websocket_ticket_from_protocols(&headers),
            Ok(ticket.clone())
        );

        let mut missing_fixed = HeaderMap::new();
        missing_fixed.insert(SEC_WEBSOCKET_PROTOCOL, ticket.parse().unwrap());
        assert!(matches!(
            browser_websocket_ticket_from_protocols(&missing_fixed),
            Err(GatewayError::Unauthorized)
        ));

        let mut with_bearer = headers;
        with_bearer.insert(AUTHORIZATION, "Bearer mobile-token".parse().unwrap());
        assert!(matches!(
            browser_websocket_ticket_from_protocols(&with_bearer),
            Err(GatewayError::Invalid)
        ));
        assert!(matches!(
            validate_browser_websocket_uri(
                &"/v1/browser-signal?ticket=not-allowed".parse().unwrap()
            ),
            Err(GatewayError::Invalid)
        ));
    }

    #[tokio::test]
    async fn browser_websocket_routes_select_fixed_protocol_and_consume_tickets() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let mobile_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        let mobile_identity = match state.authenticate_credential(&mobile_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        let signal_ticket = state
            .create_browser_websocket_ticket(
                mobile_identity.clone(),
                BrowserWebSocketEndpoint::Signal,
            )
            .expect("signal ticket is issued");

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener binds");
        let address = listener.local_addr().expect("listener has an address");
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, router(server_state))
                .await
                .expect("test server stays healthy");
        });
        let browser_request = |path: &str, ticket: &str| {
            let mut request = format!("ws://{address}{path}")
                .into_client_request()
                .expect("browser websocket URL is valid");
            request.headers_mut().insert(
                SEC_WEBSOCKET_PROTOCOL,
                format!("{BROWSER_WEBSOCKET_SUBPROTOCOL}, {ticket}")
                    .parse()
                    .expect("subprotocol header is valid"),
            );
            request
        };

        let (mut socket, response) = client_async(
            browser_request("/v1/browser-signal", &signal_ticket.ticket),
            TcpStream::connect(address)
                .await
                .expect("connects to gateway"),
        )
        .await
        .expect("matching browser signal ticket upgrades");
        assert_eq!(
            response
                .headers()
                .get(SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok()),
            Some(BROWSER_WEBSOCKET_SUBPROTOCOL)
        );
        let ready = socket
            .next()
            .await
            .expect("gateway emits ready frame")
            .expect("ready frame is valid")
            .into_text()
            .expect("ready is a text frame");
        assert!(ready.to_string().contains("\"type\":\"ready\""));

        let replay = client_async(
            browser_request("/v1/browser-signal", &signal_ticket.ticket),
            TcpStream::connect(address)
                .await
                .expect("connects for replay attempt"),
        )
        .await;
        assert!(matches!(
            replay,
            Err(TungsteniteError::Http(response)) if response.status() == StatusCode::UNAUTHORIZED
        ));
        let _ = socket.close(None).await;

        let endpoint_scoped_ticket = state
            .create_browser_websocket_ticket(mobile_identity, BrowserWebSocketEndpoint::Signal)
            .expect("second signal ticket is issued");
        let wrong_endpoint = client_async(
            browser_request("/v1/browser-relay", &endpoint_scoped_ticket.ticket),
            TcpStream::connect(address)
                .await
                .expect("connects for scope attempt"),
        )
        .await;
        assert!(matches!(
            wrong_endpoint,
            Err(TungsteniteError::Http(response)) if response.status() == StatusCode::FORBIDDEN
        ));
        let (_, response) = client_async(
            browser_request("/v1/browser-signal", &endpoint_scoped_ticket.ticket),
            TcpStream::connect(address)
                .await
                .expect("connects after scope attempt"),
        )
        .await
        .expect("scope mismatch did not consume the ticket");
        assert_eq!(
            response
                .headers()
                .get(SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok()),
            Some(BROWSER_WEBSOCKET_SUBPROTOCOL)
        );
        server.abort();
    }

    #[tokio::test]
    async fn remote_flow_pairs_desktop_and_mobile_then_syncs_over_relay_after_p2p_failure() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let desktop_id = desktop.id();
        let mobile_id = mobile.id();
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let mobile_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        let mobile_identity = match state.authenticate_credential(&mobile_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };

        let mobile_signal_ticket = state
            .create_browser_websocket_ticket(
                mobile_identity.clone(),
                BrowserWebSocketEndpoint::Signal,
            )
            .expect("mobile signal ticket");
        let mobile_relay_ticket = state
            .create_browser_websocket_ticket(mobile_identity, BrowserWebSocketEndpoint::Relay)
            .expect("mobile relay ticket");

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener binds");
        let address = listener.local_addr().expect("listener address");
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, router(server_state))
                .await
                .expect("test gateway stays healthy");
        });
        let native_request = |path: &str, token: &str| {
            let mut request = format!("ws://{address}{path}")
                .into_client_request()
                .expect("native websocket URL is valid");
            request.headers_mut().insert(
                AUTHORIZATION,
                format!("Bearer {token}")
                    .parse()
                    .expect("valid bearer header"),
            );
            request
        };
        let browser_request = |path: &str, ticket: &str| {
            let mut request = format!("ws://{address}{path}")
                .into_client_request()
                .expect("browser websocket URL is valid");
            request.headers_mut().insert(
                SEC_WEBSOCKET_PROTOCOL,
                format!("{BROWSER_WEBSOCKET_SUBPROTOCOL}, {ticket}")
                    .parse()
                    .expect("valid browser subprotocol header"),
            );
            request
        };

        let (mut desktop_signal, _) = client_async(
            native_request("/v1/signal", &desktop_token),
            TcpStream::connect(address)
                .await
                .expect("desktop connects to signal endpoint"),
        )
        .await
        .expect("desktop signal endpoint upgrades");
        let (mut mobile_signal, _) = client_async(
            browser_request("/v1/browser-signal", &mobile_signal_ticket.ticket),
            TcpStream::connect(address)
                .await
                .expect("mobile connects to signal endpoint"),
        )
        .await
        .expect("mobile signal endpoint upgrades");

        let desktop_ready = desktop_signal
            .next()
            .await
            .expect("desktop signal ready frame")
            .expect("desktop signal ready is valid")
            .into_text()
            .expect("desktop signal ready is text");
        assert!(desktop_ready.contains("\"type\":\"ready\""));
        let mobile_ready = mobile_signal
            .next()
            .await
            .expect("mobile signal ready frame")
            .expect("mobile signal ready is valid")
            .into_text()
            .expect("mobile signal ready is text");
        assert!(mobile_ready.contains("\"type\":\"ready\""));

        let p2p_session_id = SessionId::new().to_string();
        mobile_signal
            .send(TungsteniteMessage::text(
                serde_json::json!({
                    "type": "signal",
                    "to": desktop_id,
                    "session_id": p2p_session_id,
                    "payload": {
                        "kind": "p2p_failed",
                        "reason": "ice_timeout",
                    },
                })
                .to_string(),
            ))
            .await
            .expect("mobile reports the failed direct attempt");

        let desktop_p2p_failure = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let frame = desktop_signal
                    .next()
                    .await
                    .expect("desktop signal frame")
                    .expect("desktop signal frame is valid")
                    .into_text()
                    .expect("desktop signal frame is text");
                let frame: Value = serde_json::from_str(&frame).expect("gateway signal is JSON");
                if frame["type"] == "signal" {
                    break frame;
                }
            }
        })
        .await
        .expect("gateway routes the P2P failure");
        assert_eq!(desktop_p2p_failure["from"], mobile_id);
        assert_eq!(desktop_p2p_failure["session_id"], p2p_session_id);
        assert_eq!(desktop_p2p_failure["payload"]["kind"], "p2p_failed");
        assert_eq!(desktop_p2p_failure["payload"]["reason"], "ice_timeout");

        let relay_session_id = SessionId::new().to_string();
        mobile_signal
            .send(TungsteniteMessage::text(
                serde_json::json!({
                    "type": "signal",
                    "to": desktop_id,
                    "session_id": relay_session_id,
                    "payload": {
                        "kind": "relay_offer",
                        "protocol_version": 1,
                    },
                })
                .to_string(),
            ))
            .await
            .expect("mobile sends the fresh relay offer");

        let desktop_offer = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let frame = desktop_signal
                    .next()
                    .await
                    .expect("desktop signal frame")
                    .expect("desktop signal frame is valid")
                    .into_text()
                    .expect("desktop signal frame is text");
                let frame: Value = serde_json::from_str(&frame).expect("gateway signal is JSON");
                if frame["type"] == "signal" {
                    break frame;
                }
            }
        })
        .await
        .expect("gateway routes the mobile relay offer");
        assert_eq!(desktop_offer["from"], mobile_id);
        assert_eq!(desktop_offer["session_id"], relay_session_id);
        assert_eq!(
            desktop_offer["payload"],
            serde_json::json!({"kind": "relay_offer", "protocol_version": 1})
        );

        let (mut desktop_relay, _) = client_async(
            native_request("/v1/relay", &desktop_token),
            TcpStream::connect(address)
                .await
                .expect("desktop connects to relay endpoint"),
        )
        .await
        .expect("desktop relay endpoint upgrades");
        desktop_relay
            .send(TungsteniteMessage::text(
                serde_json::json!({
                    "type": "open",
                    "peer_id": mobile_id,
                    "session_id": relay_session_id,
                })
                .to_string(),
            ))
            .await
            .expect("desktop opens relay session");
        let desktop_relay_ready = desktop_relay
            .next()
            .await
            .expect("desktop relay ready frame")
            .expect("desktop relay ready is valid")
            .into_text()
            .expect("desktop relay ready is text");
        assert!(desktop_relay_ready.contains("\"type\":\"ready\""));

        let (mut mobile_relay, _) = client_async(
            browser_request("/v1/browser-relay", &mobile_relay_ticket.ticket),
            TcpStream::connect(address)
                .await
                .expect("mobile connects to relay endpoint"),
        )
        .await
        .expect("mobile relay endpoint upgrades");
        mobile_relay
            .send(TungsteniteMessage::text(
                serde_json::json!({
                    "type": "open",
                    "peer_id": desktop_id,
                    "session_id": relay_session_id,
                })
                .to_string(),
            ))
            .await
            .expect("mobile opens relay session");

        let mobile_relay_ready = mobile_relay
            .next()
            .await
            .expect("mobile relay ready frame")
            .expect("mobile relay ready is valid")
            .into_text()
            .expect("mobile relay ready is text");
        assert!(mobile_relay_ready.contains("\"type\":\"ready\""));
        let mobile_peer_connected = mobile_relay
            .next()
            .await
            .expect("mobile relay peer frame")
            .expect("mobile relay peer frame is valid")
            .into_text()
            .expect("mobile relay peer frame is text");
        assert!(mobile_peer_connected.contains("\"type\":\"peer_connected\""));

        let desktop_peer_connected = desktop_relay
            .next()
            .await
            .expect("desktop relay peer frame")
            .expect("desktop relay peer frame is valid")
            .into_text()
            .expect("desktop relay peer frame is text");
        assert!(desktop_peer_connected.contains("\"type\":\"peer_connected\""));

        // The gateway sees only serialized SecureEnvelope bytes. The test
        // opens them at each endpoint to prove that relay forwarding and the
        // protocol route/sequence metadata preserve an end-to-end session,
        // rather than merely forwarding arbitrary plaintext.
        let session_key = SessionKey::from_bytes([9_u8; 32]);
        let mobile_to_desktop = SessionRoute::new(
            SessionId::new(),
            mobile.descriptor.device_id,
            desktop.descriptor.device_id,
        );
        let mobile_envelope = SecureEnvelope::seal(
            &session_key,
            mobile_to_desktop.clone(),
            1,
            now_unix_ms(),
            &serde_json::json!({
                "kind": "chat_event_sync",
                "session_id": relay_session_id,
                "sequence": 1,
                "role": "user",
                "content": "Continue the desktop research turn",
            }),
        )
        .expect("mobile seals a synchronized chat event");
        mobile_relay
            .send(TungsteniteMessage::Binary(
                serde_json::to_vec(&mobile_envelope)
                    .expect("serialize mobile envelope")
                    .into(),
            ))
            .await
            .expect("mobile sends opaque ciphertext");
        let desktop_ciphertext = desktop_relay
            .next()
            .await
            .expect("desktop relay ciphertext")
            .expect("desktop relay ciphertext is valid")
            .into_data();
        let received_mobile: SecureEnvelope =
            serde_json::from_slice(&desktop_ciphertext).expect("desktop receives an envelope");
        let mobile_event: Value = received_mobile
            .open(&session_key)
            .expect("desktop opens the mobile event");
        assert_eq!(mobile_event["kind"], "chat_event_sync");
        assert_eq!(mobile_event["sequence"], 1);
        assert_eq!(received_mobile.route, mobile_to_desktop);

        let desktop_response = SecureEnvelope::seal(
            &session_key,
            mobile_to_desktop.reversed(),
            2,
            now_unix_ms(),
            &serde_json::json!({
                "kind": "chat_event_sync",
                "session_id": relay_session_id,
                "sequence": 2,
                "role": "assistant",
                "content": "Desktop accepted the synchronized message",
            }),
        )
        .expect("desktop seals the synchronized response");
        desktop_relay
            .send(TungsteniteMessage::Binary(
                serde_json::to_vec(&desktop_response)
                    .expect("serialize desktop envelope")
                    .into(),
            ))
            .await
            .expect("desktop returns opaque ciphertext");
        let mobile_response = mobile_relay
            .next()
            .await
            .expect("mobile relay ciphertext")
            .expect("mobile relay ciphertext is valid")
            .into_data();
        let received_desktop: SecureEnvelope =
            serde_json::from_slice(&mobile_response).expect("mobile receives an envelope");
        let desktop_event: Value = received_desktop
            .open(&session_key)
            .expect("mobile opens the desktop event");
        assert_eq!(desktop_event["kind"], "chat_event_sync");
        assert_eq!(desktop_event["sequence"], 2);
        assert_eq!(received_desktop.route, mobile_to_desktop.reversed());

        let _ = mobile_relay.close(None).await;
        let _ = desktop_relay.close(None).await;
        let _ = mobile_signal.close(None).await;
        let _ = desktop_signal.close(None).await;
        server.abort();
    }

    #[test]
    fn expired_activation_token_cannot_complete_pairing() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let (start, invitation) = bootstrap_pairing(&state, &desktop);
        let desktop_token = start.desktop_token.expect("desktop token");
        let scopes = requested_scopes();
        let pairing_request = PairingRequest::signed(
            &invitation,
            mobile.descriptor.clone(),
            scopes.clone(),
            now_unix_ms(),
            &mobile.signing_key,
        )
        .expect("mobile proof is valid");
        let claim = state
            .claim_pairing(&start.pairing_id, ClaimPairingRequest(pairing_request))
            .expect("phone claims the invitation");
        assert!(
            claim.completion_expires_at_unix_ms <= claim.expires_at_unix_ms,
            "the short completion deadline must never exceed the QR expiry"
        );

        let desktop_identity = match state.authenticate_credential(&desktop_token).unwrap() {
            CredentialSubject::Device(device) => device,
            CredentialSubject::Bootstrap => unreachable!(),
        };
        let pending = state
            .pending_claim(&start.pairing_id, desktop_identity.clone())
            .expect("desktop reads the pending claim");
        let approval = PairingApproval::approve(
            &invitation,
            &rehydrate_pairing_request(&invitation, &pending),
            SessionId::new(),
            scopes,
            now_unix_ms(),
            &desktop.signing_key,
        )
        .expect("desktop approval is signed");
        state
            .approve_pairing(
                &start.pairing_id,
                desktop_identity,
                ApprovePairingRequest {
                    claim_id: claim.claim_id.clone(),
                    approval,
                },
            )
            .expect("desktop approves before the deadline");

        {
            let mut inner = lock(&state.inner);
            let pairing = inner
                .pairings
                .get_mut(&start.pairing_id)
                .expect("pairing is retained until cleanup");
            pairing
                .claim
                .as_mut()
                .expect("approved pairing has a claim")
                .completion_expires_at_unix_ms = now_unix_ms().saturating_sub(1);
        }

        assert!(
            matches!(
                state.complete_pairing(&start.pairing_id, &claim.claim_id, &claim.activation_token),
                Err(GatewayError::Expired)
            ),
            "an expired activation credential must not activate the phone"
        );
        assert!(matches!(
            state.authenticate_credential(&claim.activation_token),
            Err(GatewayError::Unauthorized)
        ));
        let inner = lock(&state.inner);
        assert_eq!(
            inner.pairings[&start.pairing_id].status,
            PairingStatus::Expired
        );
        assert!(
            !inner.devices.contains_key(&mobile.id()),
            "expiration removes the inactive provisional device so a fresh pairing can begin"
        );
    }

    #[test]
    fn abandoned_first_use_registration_is_not_persisted_and_is_reclaimed() {
        let temporary_directory = TemporaryStateDirectory::new();
        let config = durable_test_config(temporary_directory.path());
        let state = GatewayState::load(config.clone()).expect("load empty durable state");
        let desktop = TestDevice::new(DeviceKind::Desktop, "Abandoned workstation");
        let invitation = invitation(&desktop);
        let started = state
            .start_pairing(
                None,
                StartPairingRequest {
                    invitation,
                    ice_servers: Vec::new(),
                },
            )
            .expect("first-use registration starts");
        let desktop_token = started
            .desktop_token
            .expect("desktop receives temporary credential");
        let state_file = temporary_directory.path().join(DEVICE_STATE_FILE_NAME);
        assert!(
            !state_file.exists(),
            "an abandoned first-use registration must not write durable state"
        );

        {
            let mut inner = lock(&state.inner);
            inner
                .pairings
                .get_mut(&started.pairing_id)
                .expect("pairing is retained while pending")
                .expires_at_unix_ms = now_unix_ms().saturating_sub(1);
        }
        assert!(matches!(
            state.authenticate_credential(&desktop_token),
            Err(GatewayError::Unauthorized)
        ));
        let inner = lock(&state.inner);
        assert!(!inner.devices.contains_key(&desktop.id()));
        assert_eq!(
            inner.pairings[&started.pairing_id].status,
            PairingStatus::Expired
        );
        drop(inner);
        drop(state);
        let reloaded = GatewayState::load(config).expect("restart has no abandoned registration");
        assert!(matches!(
            reloaded.authenticate_credential(&desktop_token),
            Err(GatewayError::Unauthorized)
        ));
    }

    #[test]
    fn pending_pairing_limit_rejects_new_anonymous_registration() {
        let mut config = GatewayConfig::test_config();
        config.max_pending_pairings = 1;
        let state = GatewayState::new(Arc::new(config));
        let first = TestDevice::new(DeviceKind::Desktop, "First workstation");
        let second = TestDevice::new(DeviceKind::Desktop, "Second workstation");
        state
            .start_pairing(
                None,
                StartPairingRequest {
                    invitation: invitation(&first),
                    ice_servers: Vec::new(),
                },
            )
            .expect("first pairing fits capacity");
        assert!(matches!(
            state.start_pairing(
                None,
                StartPairingRequest {
                    invitation: invitation(&second),
                    ice_servers: Vec::new(),
                },
            ),
            Err(GatewayError::CapacityExceeded)
        ));
    }

    #[test]
    fn expired_anonymous_registration_is_pruned_before_the_next_start() {
        let mut config = GatewayConfig::test_config();
        config.max_pending_pairings = 1;
        config.max_unpaired_desktops = 1;
        let state = GatewayState::new(Arc::new(config));
        let first = TestDevice::new(DeviceKind::Desktop, "Expired workstation");
        let second = TestDevice::new(DeviceKind::Desktop, "Fresh workstation");
        let first_start = state
            .start_pairing(
                None,
                StartPairingRequest {
                    invitation: invitation(&first),
                    ice_servers: Vec::new(),
                },
            )
            .expect("first anonymous registration fits capacity");

        {
            let mut inner = lock(&state.inner);
            inner
                .pairings
                .get_mut(&first_start.pairing_id)
                .expect("first pairing is pending")
                .expires_at_unix_ms = now_unix_ms().saturating_sub(1);
        }

        let second_start = state
            .start_pairing(
                None,
                StartPairingRequest {
                    invitation: invitation(&second),
                    ice_servers: Vec::new(),
                },
            )
            .expect("expired anonymous registration is reclaimed before capacity checks");

        let inner = lock(&state.inner);
        assert!(
            !inner.devices.contains_key(&first.id()),
            "the expired provisional desktop must not consume an unpaired slot"
        );
        assert!(
            !inner.pairings.contains_key(&first_start.pairing_id),
            "the expired terminal pairing must not consume a pending slot"
        );
        assert!(inner.devices.contains_key(&second.id()));
        assert!(inner.pairings.contains_key(&second_start.pairing_id));
    }

    #[test]
    fn tampered_signed_pairing_request_is_rejected_before_state_changes() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let (start, invitation) = bootstrap_pairing(&state, &desktop);
        let mut request = PairingRequest::signed(
            &invitation,
            mobile.descriptor.clone(),
            requested_scopes(),
            now_unix_ms(),
            &mobile.signing_key,
        )
        .expect("valid request before tampering");
        request.requested_at_unix_ms = request.requested_at_unix_ms.saturating_add(1);

        assert!(
            matches!(
                state.claim_pairing(&start.pairing_id, ClaimPairingRequest(request)),
                Err(GatewayError::Forbidden)
            ),
            "the gateway must reject a request whose signed transcript no longer verifies"
        );
    }

    #[tokio::test]
    async fn signal_routing_is_private_to_paired_online_devices() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let desktop_id = desktop.id();
        let mobile_id = mobile.id();
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let phone_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        let (phone_sender, mut phone_receiver) = mpsc::channel(4);
        let phone_connection = Uuid::new_v4();
        state
            .attach_signal(&mobile_id, phone_connection, phone_sender)
            .expect("paired phone connects");

        state
            .route_signal(
                &desktop_id,
                &mobile_id,
                "relay-attempt-1",
                serde_json::json!({"candidate": "opaque"}),
            )
            .expect("paired devices can signal");
        assert_eq!(
            phone_receiver.recv().await,
            Some(ServerSignalFrame::Signal {
                from: desktop_id.clone(),
                session_id: "relay-attempt-1".into(),
                payload: serde_json::json!({"candidate": "opaque"}),
            })
        );

        assert_eq!(
            state.route_signal(
                &desktop_id,
                "unknown-phone",
                "relay-attempt-1",
                serde_json::json!({}),
            ),
            Err(GatewayError::Unauthorized),
            "an endpoint cannot use the gateway to enumerate or signal arbitrary devices"
        );

        state.detach_signal(&mobile_id, phone_connection);
        assert_eq!(
            state.route_signal(
                &desktop_id,
                &mobile_id,
                "relay-attempt-1",
                serde_json::json!({}),
            ),
            Err(GatewayError::PeerOffline)
        );
        drop(phone_token);
    }

    #[tokio::test]
    async fn relay_forwards_opaque_binary_only_after_both_paired_peers_bind() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let desktop_id = desktop.id();
        let mobile_id = mobile.id();
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        pair_mobile(&state, &desktop, &desktop_token, &mobile);

        let desktop_connection = Uuid::new_v4();
        let phone_connection = Uuid::new_v4();
        let (desktop_sender, mut desktop_receiver) = mpsc::channel(4);
        let (phone_sender, mut phone_receiver) = mpsc::channel(4);
        assert!(!state
            .bind_relay(
                &desktop_id,
                &mobile_id,
                "fallback-session-1",
                desktop_connection,
                desktop_sender,
            )
            .expect("first peer binds"));
        assert!(state
            .bind_relay(
                &mobile_id,
                &desktop_id,
                "fallback-session-1",
                phone_connection,
                phone_sender,
            )
            .expect("paired second peer binds"));
        assert!(matches!(
            desktop_receiver.recv().await,
            Some(RelayOutbound::Control(RelayServerControlFrame::PeerConnected { device_id, .. })) if device_id == mobile_id
        ));

        state
            .forward_relay(
                &desktop_id,
                &mobile_id,
                "fallback-session-1",
                vec![0x01, 0x02, 0x03],
            )
            .expect("relay forwards an opaque binary frame");
        assert!(matches!(
            phone_receiver.recv().await,
            Some(RelayOutbound::Binary(payload)) if payload == vec![0x01, 0x02, 0x03]
        ));

        state.detach_relay(
            &mobile_id,
            &desktop_id,
            "fallback-session-1",
            phone_connection,
        );
        assert!(matches!(
            desktop_receiver.recv().await,
            Some(RelayOutbound::Control(RelayServerControlFrame::PeerDisconnected { device_id, .. })) if device_id == mobile_id
        ));
    }

    #[tokio::test]
    async fn browser_ticket_http_endpoint_requires_an_active_mobile_bearer_credential() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let (bootstrap, _) = bootstrap_pairing(&state, &desktop);
        let desktop_token = bootstrap.desktop_token.expect("desktop token");
        let mobile_token = pair_mobile(&state, &desktop, &desktop_token, &mobile);
        let app = router(state.clone());
        let ticket_request = Body::from(r#"{"endpoint":"signal"}"#);

        let unauthenticated = app
            .clone()
            .oneshot(
                Request::post("/v1/browser-ws-tickets")
                    .header("content-type", "application/json")
                    .body(ticket_request)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

        let desktop_forbidden = app
            .clone()
            .oneshot(
                Request::post("/v1/browser-ws-tickets")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {desktop_token}"))
                    .body(Body::from(r#"{"endpoint":"signal"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(desktop_forbidden.status(), StatusCode::FORBIDDEN);

        let issued = app
            .oneshot(
                Request::post("/v1/browser-ws-tickets")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {mobile_token}"))
                    .body(Body::from(r#"{"endpoint":"relay"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(issued.status(), StatusCode::OK);
        let issued: serde_json::Value = response_json(issued).await;
        assert_eq!(issued["endpoint"], "relay");
        assert!(issued["ticket"]
            .as_str()
            .is_some_and(is_valid_browser_websocket_ticket));
    }

    #[test]
    fn public_stun_servers_are_carried_to_the_claim_and_private_or_turn_values_fail() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let mobile = TestDevice::new(DeviceKind::Mobile, "Research phone");
        let pairing_invitation = invitation(&desktop);
        let ice_servers = vec![
            "stun:106.53.28.124:3478".to_owned(),
            "stun:stun.example.com:3478".to_owned(),
            "stuns:stun.example.org:5349".to_owned(),
        ];
        let start = state
            .start_pairing(
                Some(&state.config.bootstrap_token),
                StartPairingRequest {
                    invitation: pairing_invitation.clone(),
                    ice_servers: ice_servers.clone(),
                },
            )
            .expect("valid public STUN list");
        let claim = PairingRequest::signed(
            &pairing_invitation,
            mobile.descriptor.clone(),
            requested_scopes(),
            now_unix_ms(),
            &mobile.signing_key,
        )
        .expect("mobile proof");
        let response = state
            .claim_pairing(&start.pairing_id, ClaimPairingRequest(claim))
            .expect("claim receives public ICE list");
        assert_eq!(response.ice_servers, ice_servers);

        for invalid in [
            "turn:turn.example.com:3478",
            "stun:10.0.0.1:3478",
            "stun:127.0.0.1:3478",
            "stun:192.0.2.1:3478",
            "stun:localhost:3478",
            "stun:stun.example.com:0",
            "stun:stun.example.com?transport=udp",
        ] {
            let pairing_invitation = invitation(&desktop);
            assert!(
                matches!(
                    state.start_pairing(
                        Some(&state.config.bootstrap_token),
                        StartPairingRequest {
                            invitation: pairing_invitation,
                            ice_servers: vec![invalid.to_owned()],
                        },
                    ),
                    Err(GatewayError::Invalid)
                ),
                "{invalid} must not become QR-visible configuration"
            );
        }
    }

    fn assert_server_authoritative_pairing_expiry(
        state: &GatewayState,
        response: &StartPairingResponse,
        observed_before_start: i64,
        observed_after_start: i64,
    ) {
        // The test configuration deliberately remains the normal five-minute
        // QR lifetime. The assertion derives its window from configuration so
        // the behavior remains correct for every deployed TTL.
        assert_eq!(state.config.pairing_ttl, Duration::from_secs(300));
        let ttl_ms = i64::try_from(state.config.pairing_ttl.as_millis()).unwrap();
        assert!(
            response.expires_at_unix_ms >= observed_before_start.saturating_add(ttl_ms)
                && response.expires_at_unix_ms <= observed_after_start.saturating_add(ttl_ms),
            "gateway response expiry must be derived from its own clock and configured TTL"
        );
        let inner = lock(&state.inner);
        let stored = inner
            .pairings
            .get(&response.pairing_id)
            .expect("started pairing is stored");
        assert_eq!(stored.expires_at_unix_ms, response.expires_at_unix_ms);
    }

    #[test]
    fn server_expiry_overrides_a_client_clock_substantially_ahead() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Ahead-clock workstation");
        let mut client_invitation = invitation(&desktop);
        client_invitation.expires_at_unix_ms = now_unix_ms().saturating_add(86_400_000);
        let client_expiry = client_invitation.expires_at_unix_ms;
        let observed_before_start = now_unix_ms();
        let response = state
            .start_pairing(
                Some(&state.config.bootstrap_token),
                StartPairingRequest {
                    invitation: client_invitation,
                    ice_servers: Vec::new(),
                },
            )
            .expect("a far-ahead client clock does not reject a valid pairing shape");
        let observed_after_start = now_unix_ms();

        assert_ne!(response.expires_at_unix_ms, client_expiry);
        assert_server_authoritative_pairing_expiry(
            &state,
            &response,
            observed_before_start,
            observed_after_start,
        );
    }

    #[test]
    fn server_expiry_overrides_a_client_clock_substantially_behind() {
        let state = state();
        let desktop = TestDevice::new(DeviceKind::Desktop, "Behind-clock workstation");
        let mut client_invitation = invitation(&desktop);
        client_invitation.expires_at_unix_ms = now_unix_ms().saturating_sub(86_400_000);
        let client_expiry = client_invitation.expires_at_unix_ms;
        let observed_before_start = now_unix_ms();
        let response = state
            .start_pairing(
                Some(&state.config.bootstrap_token),
                StartPairingRequest {
                    invitation: client_invitation,
                    ice_servers: Vec::new(),
                },
            )
            .expect("a far-behind client clock does not reject a valid pairing shape");
        let observed_after_start = now_unix_ms();

        assert_ne!(response.expires_at_unix_ms, client_expiry);
        assert_server_authoritative_pairing_expiry(
            &state,
            &response,
            observed_before_start,
            observed_after_start,
        );
    }

    #[tokio::test]
    async fn http_pairing_bootstraps_a_desktop_without_a_login_or_bearer() {
        let state = state();
        let app = router(state.clone());
        let desktop = TestDevice::new(DeviceKind::Desktop, "Research workstation");
        let first_invitation = invitation(&desktop);
        let first_registration = app
            .clone()
            .oneshot(
                Request::post("/v1/pairings")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&StartPairingRequest {
                            invitation: first_invitation.clone(),
                            ice_servers: Vec::new(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first_registration.status(), StatusCode::OK);
        let first: StartPairingResponse = response_json(first_registration).await;
        let desktop_token = first
            .desktop_token
            .expect("capability-only first registration issues a desktop token");
        assert_eq!(first.pairing_id, first_invitation.pairing_id.to_string());
        assert!(matches!(
            state.authenticate_credential(&desktop_token),
            Ok(CredentialSubject::Device(AuthenticatedDevice { id, role: DeviceKind::Desktop })) if id == desktop.id()
        ));

        let duplicate_without_bearer = app
            .clone()
            .oneshot(
                Request::post("/v1/pairings")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&StartPairingRequest {
                            invitation: first_invitation.clone(),
                            ice_servers: Vec::new(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(duplicate_without_bearer.status(), StatusCode::CONFLICT);

        let authenticated_follow_up = app
            .oneshot(
                Request::post("/v1/pairings")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {desktop_token}"))
                    .body(Body::from(
                        serde_json::to_vec(&StartPairingRequest {
                            invitation: invitation(&desktop),
                            ice_servers: Vec::new(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(authenticated_follow_up.status(), StatusCode::OK);
        let response: StartPairingResponse = response_json(authenticated_follow_up).await;
        assert!(response.desktop_token.is_none());
    }

    async fn response_json<T: DeserializeOwned>(response: Response) -> T {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }
}
