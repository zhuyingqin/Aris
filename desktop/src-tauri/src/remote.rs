//! Constrained desktop-side remote-control boundary.
//!
//! The built-in outbound WSS relay runner and a future P2P adapter both use
//! the same authenticated wire-session boundary in this module. It owns the
//! local allow-list, persistent pairing grants, replay protection, and the
//! metadata-only audit log.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use futures_util::{SinkExt, StreamExt};
use keyring::{Entry as KeyringEntry, Error as KeyringError};
use qrcode::{render::svg, QrCode};
use remote_protocol::{
    ChatModelOption, ChatSessionSummary, ChatTranscriptMessage, ChatTranscriptRole, ControlCommand,
    ControlError, ControlRequest, ControlResponse, ControlResult, DeviceDescriptor, DeviceId,
    DeviceKind, DeviceScope, DeviceScopes, DeviceSignature, DeviceSigningKey, KeyAgreementSecret,
    P2pFailureReason, PairingApproval, PairingId, PairingInvitation, PairingRequest,
    ProjectSummary, ProtocolVersion, RemoteCapability, ReplayWindow, RequestId, SecureEnvelope,
    SessionId, SessionKey, SessionKeyContext, SessionRoute, TransportKind, TransportSignal,
    CURRENT_PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    sync::{mpsc, watch, Mutex as AsyncMutex},
    time::{interval, timeout, Instant, MissedTickBehavior},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest,
        http::header::{HeaderValue, AUTHORIZATION},
        protocol::WebSocketConfig,
        Message,
    },
};

const STORE_VERSION: u32 = 2;
const MAX_AUDIT_READ: usize = 200;
const MAX_PENDING_PAIRINGS: usize = 8;
const MAX_ACTIVE_RELAY_SESSIONS: usize = 16;
const MAX_ACTIVE_P2P_SESSIONS: usize = 16;
const MAX_P2P_ICE_CANDIDATES_PER_SESSION: usize = 64;
/// Session IDs are inputs to the shared-key derivation.  Never evict one
/// while the underlying desktop/mobile pairing keys remain valid, or an old
/// ID could recreate its old encryption key and a fresh replay window.
///
/// This is intentionally a per-device bound: one revoked/compromised phone
/// must not consume the anti-replay history of every other explicitly paired
/// phone. Once a phone reaches the bound, it must be revoked and paired again
/// with a new key-agreement identity.
const MAX_USED_TRANSPORT_SESSIONS_PER_DEVICE: usize = 4_096;
/// Version 1 evicted the oldest entry once this many records existed. A
/// migration must treat a full legacy list as potentially incomplete.
const LEGACY_EVICTING_TRANSPORT_HISTORY_CAP: usize = 4_096;
const MAX_RELAY_FRAME_BYTES: usize = 262_144;
const MAX_PENDING_GATEWAY_SIGNALS: usize = 32;
const MAX_P2P_BASE64_FRAME_BYTES: usize = MAX_RELAY_FRAME_BYTES * 2;
/// Keep a completed answer comfortably below the encrypted relay frame cap.
/// JSON escaping plus the SecureEnvelope overhead can grow the wire payload.
const MAX_REMOTE_CHAT_RESPONSE_BYTES: usize = 48 * 1024;
const MAX_REMOTE_CHAT_IDEMPOTENCY_ENTRIES: usize = 128;
const REMOTE_CHAT_IDEMPOTENCY_TTL_MILLIS: u64 = 10 * 60 * 1_000;
const PAIRING_TTL_MILLIS: u64 = 5 * 60 * 1_000;
const REMOTE_GATEWAY_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const REMOTE_GATEWAY_RECONNECT_DELAY: Duration = Duration::from_secs(3);
const REMOTE_SIGNAL_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const REMOTE_SIGNAL_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
/// A half-open TCP write can otherwise block the signal lease watchdog behind
/// the WebSocket sink's flush. This is deliberately shorter than the lease.
const REMOTE_SIGNAL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const REMOTE_RELAY_PEER_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REMOTE_P2P_NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(20);
const REMOTE_KEYRING_SERVICE: &str = "SomniQ Studio Remote Agent";
/// The managed SomniQ Remote deployment is deliberately a non-secret profile:
/// people should not have to paste a gateway URL, STUN server, bootstrap
/// credential, or account login before they can pair a phone. The first signed
/// QR ceremony obtains a desktop credential that stays only in the operating
/// system credential store.
const MANAGED_REMOTE_GATEWAY_URL: &str = "https://106.53.28.124:8443";
/// The managed gateway publishes this STUN-only endpoint alongside the HTTPS
/// control plane. It supplies public ICE discovery for a direct WebRTC probe;
/// an unavailable direct route still falls back to the encrypted TCP relay.
const MANAGED_REMOTE_STUN_SERVER: &str = "stun:106.53.28.124:3478";
const DEFAULT_REMOTE_DESKTOP_NAME: &str = "SomniQ Desktop";
const REMOTE_WORKSPACE_CAPABILITIES: &[RemoteCapability] = &[
    RemoteCapability::SetActiveProject,
    RemoteCapability::GetChatModelOptions,
    RemoteCapability::SetChatSessionModel,
];

/// Shared, protocol-versioned capabilities a paired device may receive. The
/// protocol intentionally exposes no direct filesystem, terminal, settings,
/// permission-response, or mail endpoint; chat work remains governed by the
/// selected desktop session's tool and permission policy.
pub type RemoteScope = DeviceScope;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDevice {
    pub id: String,
    pub label: String,
    pub fingerprint: String,
    pub scopes: BTreeSet<RemoteScope>,
    pub paired_at: u64,
    pub last_seen_at: Option<u64>,
    pub revoked_at: Option<u64>,
    /// Public pairing metadata retained only for reconstructing an
    /// end-to-end session key. It is stored locally with the grant, but is
    /// omitted from the frontend DTO; the fingerprint is the reviewable UI
    /// representation instead.
    #[serde(default)]
    descriptor: Option<DeviceDescriptor>,
    #[serde(default)]
    session_id: Option<String>,
}

/// Deliberately small renderer-facing representation of a paired device.
/// Keeping the full public descriptor out of the WebView avoids accidentally
/// treating a protocol key as ordinary application state while still letting
/// the desktop persist it for future end-to-end key derivation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeviceView {
    pub id: String,
    pub label: String,
    pub fingerprint: String,
    pub scopes: BTreeSet<RemoteScope>,
    pub paired_at: u64,
    pub last_seen_at: Option<u64>,
    pub revoked_at: Option<u64>,
}

impl From<&RemoteDevice> for RemoteDeviceView {
    fn from(device: &RemoteDevice) -> Self {
        Self {
            id: device.id.clone(),
            label: device.label.clone(),
            fingerprint: device.fingerprint.clone(),
            scopes: device.scopes.clone(),
            paired_at: device.paired_at,
            last_seen_at: device.last_seen_at,
            revoked_at: device.revoked_at,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlStatus {
    pub enabled: bool,
    pub gateway_url: Option<String>,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    /// Explicit STUN endpoints used only for P2P candidate gathering. TURN is
    /// intentionally not accepted here: P2 falls back to the audited WSS/TCP
    /// relay instead of silently taking a separate media-relay path.
    pub ice_servers: Vec<String>,
    pub paired_device_count: usize,
    pub active_device_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlEnableInput {
    pub gateway_url: String,
    pub device_name: Option<String>,
    /// Optional STUN URLs such as `stun:stun.example.com:3478`. They are
    /// public routing metadata, not credentials, and are supplied to both
    /// browser WebRTC stacks only when a P2P attempt begins.
    #[serde(default)]
    pub ice_servers: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAuditEntry {
    pub timestamp: u64,
    pub device_id: String,
    pub request_id: String,
    pub action: String,
    pub transport: String,
    pub project_id: Option<String>,
    pub outcome: String,
    pub error_code: Option<String>,
}

/// QR material for one short-lived, locally held pairing ceremony. The QR
/// opens the same-origin mobile PWA and carries the invitation (including its
/// QR secret) only in the URL fragment. It must only be rendered in this local
/// desktop UI and is never persisted in the audit log.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairingInvitationView {
    pub pairing_id: String,
    pub expires_at: u64,
    pub qr_code_data_url: String,
}

/// Result of the one-click, managed remote-connect flow. Keeping status and
/// the QR together avoids a misleading intermediate state where the UI says
/// "enabled" even though the desktop has not been enrolled with the gateway.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectPhoneView {
    pub status: RemoteControlStatus,
    pub pairing: RemotePairingInvitationView,
}

/// Sanitized pending claim presented for a local desktop user's approval.
/// It deliberately omits the QR secret and the full signed request body.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePendingPairing {
    pub pairing_id: String,
    pub claim_id: String,
    pub device_id: String,
    pub label: String,
    pub fingerprint: String,
    pub requested_scopes: BTreeSet<RemoteScope>,
    pub requested_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairingApprovalInput {
    pub pairing_id: String,
    /// Retained for wire compatibility with older desktop renderers. Pairing
    /// approval now grants every supported scope that the scanned phone
    /// requested, so callers cannot accidentally omit chat capability.
    #[serde(default, rename = "grantedScopes")]
    pub legacy_granted_scopes: Vec<RemoteScope>,
}

/// In-memory retry record.  It intentionally never enters `RemoteStore` or
/// the audit log because it holds an assistant answer.  The desktop chat
/// session remains the durable transcript; this cache only prevents a
/// reconnect from running the same prompt twice while the desktop is alive.
#[derive(Debug, Clone)]
struct RemoteChatIdempotencyEntry {
    device_id: String,
    project_id: String,
    idempotency_key: String,
    request_digest: String,
    message_id: String,
    created_at: u64,
    completed_text: Option<String>,
}

enum RemoteChatReservation {
    New { message_id: String },
    Completed { message_id: String, text: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingPairingRecord {
    pairing_id: String,
    expires_at: u64,
    created_at: u64,
}

/// Persisted one-time transport-session reservation. A fresh session ID is
/// negotiated for each relay connection, then retained so a replayed signal
/// cannot recreate a new replay window with the same session key after a
/// reconnect or desktop restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsedTransportSession {
    session_id: String,
    device_id: String,
    used_at: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct RemoteRequestContext {
    pub device_id: String,
    /// Either `p2p` or `tcp_relay`; adapters may use `unknown` while testing.
    pub transport: String,
}

/// One authenticated, end-to-end encrypted wire session. The P2P WebRTC
/// adapter and the TCP/WSS relay adapter both hand their binary frames to this
/// type, so their authorization and anti-replay behavior cannot diverge.
pub(crate) struct RemoteWireSession {
    device_id: String,
    transport: String,
    session_key: SessionKey,
    incoming: Mutex<ReplayWindow>,
    outgoing_route: SessionRoute,
    outgoing_sequence: AtomicU64,
}

impl RemoteWireSession {
    /// Builds the desktop end of a paired session. The remote device identity
    /// stored in the local grant must match the cryptographic envelope route.
    pub(crate) fn new(
        device_id: String,
        transport: TransportKind,
        session_key: SessionKey,
        incoming_route: SessionRoute,
    ) -> Result<Self, String> {
        if device_id != incoming_route.sender_device_id.to_string() {
            return Err("remote device identity does not match encrypted route".to_string());
        }
        Ok(Self {
            device_id,
            transport: match transport {
                TransportKind::P2p => "p2p".to_string(),
                TransportKind::TcpRelay => "tcp_relay".to_string(),
            },
            session_key,
            incoming: Mutex::new(ReplayWindow::new(incoming_route.clone())),
            outgoing_route: incoming_route.reversed(),
            outgoing_sequence: AtomicU64::new(1),
        })
    }

    /// Opens, validates, dispatches, and encrypts a control response. The
    /// caller merely writes the returned binary frame to its chosen transport.
    pub(crate) async fn handle_envelope(
        &self,
        app: AppHandle,
        state: &RemoteAgentState,
        envelope: &SecureEnvelope,
    ) -> Result<SecureEnvelope, String> {
        let request = self
            .incoming
            .lock()
            .map_err(|_| "remote replay state poisoned".to_string())?
            .open::<ControlRequest>(envelope, &self.session_key, protocol_now_millis())
            .map_err(|error| format!("rejected remote envelope: {error}"))?;
        let context = RemoteRequestContext {
            device_id: self.device_id.clone(),
            transport: self.transport.clone(),
        };
        let response = execute_control_request(app, state, context, request).await;
        let sequence = self.outgoing_sequence.fetch_add(1, Ordering::SeqCst);
        SecureEnvelope::seal(
            &self.session_key,
            self.outgoing_route.clone(),
            sequence,
            protocol_now_millis(),
            &response,
        )
        .map_err(|error| format!("failed to encrypt remote response: {error}"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteStore {
    #[serde(default = "store_version")]
    version: u32,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    gateway_url: Option<String>,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    device_name: Option<String>,
    #[serde(default)]
    ice_servers: Vec<String>,
    #[serde(default)]
    devices: Vec<RemoteDevice>,
    /// Non-secret metadata lets the local UI recover a pending QR flow after
    /// a restart. The invitation itself (and its QR secret) lives only in the
    /// OS credential store under the pairing ID.
    #[serde(default)]
    pending_pairings: Vec<PendingPairingRecord>,
    /// Local revocation always takes effect immediately. This queue records a
    /// best-effort gateway delete that could not be delivered while offline.
    #[serde(default)]
    pending_gateway_revocations: Vec<String>,
    #[serde(default)]
    used_transport_sessions: Vec<UsedTransportSession>,
}

impl Default for RemoteStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            enabled: false,
            gateway_url: None,
            device_id: None,
            device_name: None,
            ice_servers: Vec::new(),
            devices: Vec::new(),
            pending_pairings: Vec::new(),
            pending_gateway_revocations: Vec::new(),
            used_transport_sessions: Vec::new(),
        }
    }
}

fn store_version() -> u32 {
    STORE_VERSION
}

/// Managed local state for the Remote Agent. Device private keys belong in the
/// platform keychain and are intentionally not serialized into this file.
pub struct RemoteAgentState {
    store_path: PathBuf,
    audit_path: PathBuf,
    store: Mutex<RemoteStore>,
    audit_lock: Mutex<()>,
    transport_shutdown: Mutex<Option<watch::Sender<bool>>>,
    /// Monotonic ownership token for the outbound signal runner. A stopped
    /// runner can finish a pending TCP/TLS connect after its replacement has
    /// started, so shutdown alone is not enough to let it mutate shared P2P
    /// state safely.
    transport_generation: AtomicU64,
    /// Renderer-facing WebRTC negotiation is deliberately kept on a small
    /// outbound queue. The WebView never receives the gateway credential; it
    /// can only ask this state to forward a validated answer or ICE candidate
    /// for a session the Rust side already reserved.
    signal_outbound: Mutex<Option<mpsc::Sender<GatewayOutboundSignalFrame>>>,
    active_relay_sessions: Mutex<BTreeSet<String>>,
    active_p2p_sessions: Mutex<BTreeMap<String, Arc<ReservedP2pSession>>>,
    pending_p2p_negotiations: Mutex<BTreeMap<String, PendingP2pNegotiation>>,
    gateway_revocation_retry_active: Mutex<bool>,
    /// Bounded per-process replay protection for remote chat retry requests.
    /// Never persist answers in the remote-agent store.
    chat_idempotency: Mutex<Vec<RemoteChatIdempotencyEntry>>,
    /// Serializes gateway credential deletion with a fresh pairing approval so
    /// an offline-retry delete can never race and revoke a new credential for
    /// the same stable phone identity.
    gateway_mutation_lock: AsyncMutex<()>,
}

impl Default for RemoteAgentState {
    fn default() -> Self {
        Self::at_paths(remote_store_path(), remote_audit_path())
    }
}

impl RemoteAgentState {
    fn at_paths(store_path: PathBuf, audit_path: PathBuf) -> Self {
        Self {
            store: Mutex::new(load_store(&store_path)),
            store_path,
            audit_path,
            audit_lock: Mutex::new(()),
            transport_shutdown: Mutex::new(None),
            transport_generation: AtomicU64::new(0),
            signal_outbound: Mutex::new(None),
            active_relay_sessions: Mutex::new(BTreeSet::new()),
            active_p2p_sessions: Mutex::new(BTreeMap::new()),
            pending_p2p_negotiations: Mutex::new(BTreeMap::new()),
            gateway_revocation_retry_active: Mutex::new(false),
            chat_idempotency: Mutex::new(Vec::new()),
            gateway_mutation_lock: AsyncMutex::new(()),
        }
    }

    #[cfg(test)]
    fn at_path(path: PathBuf) -> Self {
        let audit_path = path.with_file_name("audit.jsonl");
        Self::at_paths(path, audit_path)
    }
}

fn remote_store_path() -> PathBuf {
    crate::state::config_dir().join("remote").join("agent.json")
}

fn remote_audit_path() -> PathBuf {
    crate::state::desktop_runtime_dir()
        .join("remote")
        .join("audit.jsonl")
}

fn load_store(path: &Path) -> RemoteStore {
    let mut store = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<RemoteStore>(&raw).ok())
        .filter(|store| store.version <= STORE_VERSION)
        .unwrap_or_default();
    migrate_store(&mut store);
    store
}

/// Handles the one security-sensitive migration introduced with P2. Version
/// 1 discarded the oldest session ID after its fixed history reached capacity.
/// A full v1 history therefore cannot prove that an old session ID was never
/// used. Keep local authorization fail-closed until those phones complete a
/// fresh, explicitly approved pairing; startup will propagate the queued
/// gateway revocations when connectivity is available.
fn migrate_store(store: &mut RemoteStore) {
    if store.version >= STORE_VERSION {
        return;
    }
    if store.version < 2
        && store.used_transport_sessions.len() >= LEGACY_EVICTING_TRANSPORT_HISTORY_CAP
    {
        let revoked_at = now_epoch_millis();
        let revoked_ids = store
            .devices
            .iter_mut()
            .filter(|device| device.revoked_at.is_none())
            .map(|device| {
                device.revoked_at = Some(revoked_at);
                device.id.clone()
            })
            .collect::<Vec<_>>();
        for device_id in revoked_ids {
            if !store
                .pending_gateway_revocations
                .iter()
                .any(|pending| pending == &device_id)
            {
                store.pending_gateway_revocations.push(device_id);
            }
        }
    }
    store.version = STORE_VERSION;
}

fn save_store(path: &Path, store: &RemoteStore) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(store).map_err(|error| error.to_string())?;
    runtime::write_file_atomically(path, body).map_err(|error| error.to_string())
}

fn now_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or_default()
}

/// Reserves one globally unique transport session ID for the lifetime of the
/// current pairing material. A session ID appears in the key-derivation
/// context, so retaining it is part of replay protection rather than cache
/// bookkeeping. Do not prune this list without rotating the paired key.
fn record_transport_session(
    store: &mut RemoteStore,
    device_id: &str,
    session_id: &str,
) -> Result<(), String> {
    if store
        .used_transport_sessions
        .iter()
        .any(|used| used.session_id == session_id)
    {
        return Err("remote transport session was already used".to_string());
    }
    if store
        .used_transport_sessions
        .iter()
        .filter(|used| used.device_id == device_id)
        .count()
        >= MAX_USED_TRANSPORT_SESSIONS_PER_DEVICE
    {
        return Err(
            "remote transport session history is full for this phone; revoke and pair it again with a new phone identity"
                .to_string(),
        );
    }
    store.used_transport_sessions.push(UsedTransportSession {
        session_id: session_id.to_string(),
        device_id: device_id.to_string(),
        used_at: now_epoch_millis(),
    });
    Ok(())
}

fn new_desktop_device_id() -> String {
    DeviceId::new().to_string()
}

fn normalize_gateway_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() || value.len() > 2_048 || value.contains(char::is_whitespace) {
        return Err("invalid remote gateway URL".to_string());
    }
    let parsed =
        reqwest::Url::parse(value).map_err(|_| "invalid remote gateway URL".to_string())?;
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "remote gateway URL must not contain credentials, a query, or a fragment".to_string(),
        );
    }
    let exact_loopback_host = matches!(
        parsed.host_str(),
        Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
    );
    let local_dev = parsed.scheme() == "http" && exact_loopback_host;
    if parsed.scheme() != "https" && !local_dev {
        return Err(
            "remote gateway must use https (http is allowed only for localhost development)"
                .to_string(),
        );
    }
    Ok(value.to_string())
}

/// Validates the deliberately small ICE configuration surface. We accept only
/// STUN/STUNS URLs; TURN credentials must not be copied into a desktop setting
/// or bundled mobile PWA, and P2's defined non-direct fallback is the existing
/// end-to-end encrypted WSS/TCP relay.
fn normalize_ice_servers(values: Vec<String>) -> Result<Vec<String>, String> {
    if values.len() > 8 {
        return Err("configure at most eight STUN servers".to_string());
    }
    let mut normalized = BTreeSet::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if value.len() > 512 || value.contains(char::is_whitespace) {
            return Err("invalid STUN server URL".to_string());
        }
        let Some((scheme, authority)) = value.split_once(':') else {
            return Err("invalid STUN server URL".to_string());
        };
        if !matches!(scheme.to_ascii_lowercase().as_str(), "stun" | "stuns")
            || authority.is_empty()
            || authority.contains(['/', '?', '#', '@'])
        {
            return Err(
                "STUN server URLs must use stun: or stuns: without credentials".to_string(),
            );
        }
        normalized.insert(format!("{}:{authority}", scheme.to_ascii_lowercase()));
    }
    Ok(normalized.into_iter().collect())
}

struct DesktopIdentity {
    descriptor: DeviceDescriptor,
    signing_key: DeviceSigningKey,
    agreement_key: KeyAgreementSecret,
}

#[derive(Serialize)]
struct GatewayStartPairingRequest<'a> {
    invitation: &'a PairingInvitation,
    /// Public STUN/STUNS endpoints configured on this desktop. The gateway
    /// only returns these after a phone proves possession of the one-time QR
    /// secret, so the mobile PWA never asks a person to type transport data.
    ice_servers: &'a [String],
}

#[derive(Deserialize)]
struct GatewayStartPairingResponse {
    pairing_id: String,
    expires_at_unix_ms: i64,
    #[serde(default)]
    desktop_token: Option<String>,
}

#[derive(Deserialize)]
struct GatewayPendingClaim {
    claim_id: String,
    protocol_version: ProtocolVersion,
    pairing_id: PairingId,
    mobile: DeviceDescriptor,
    requested_scopes: DeviceScopes,
    requested_at_unix_ms: i64,
    proof: DeviceSignature,
}

#[derive(Serialize)]
struct GatewayApprovePairingRequest<'a> {
    claim_id: &'a str,
    approval: &'a PairingApproval,
}

#[derive(Deserialize)]
struct GatewayDeviceSummary {
    id: String,
}

#[derive(Deserialize)]
struct GatewayApprovePairingResponse {
    device: GatewayDeviceSummary,
}

#[derive(Deserialize)]
struct GatewayRevokeDeviceResponse {
    revoked_device_id: String,
}

#[derive(Deserialize)]
struct GatewayErrorResponse {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum GatewaySignalFrame {
    Ready {
        device_id: String,
    },
    Presence {
        device_id: String,
        online: bool,
    },
    Signal {
        from: String,
        session_id: String,
        payload: Value,
    },
    Pong {
        nonce: Option<String>,
    },
    Error {
        code: String,
        message: String,
    },
    Revoked {
        device_id: String,
    },
}

/// The only gateway-frame shape the desktop writes after authenticating its
/// outbound signal WebSocket. Payloads remain opaque to the gateway, but this
/// local type prevents the WebView from choosing arbitrary gateway commands.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum GatewayOutboundSignalFrame {
    Signal {
        to: String,
        session_id: String,
        payload: Value,
    },
}

/// WebRTC signaling stays separate from the encrypted control protocol. SDP
/// and ICE metadata are necessarily visible to the signaling gateway, while
/// every command sent after the data channel opens remains a `SecureEnvelope`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteP2pAnswerInput {
    pub device_id: String,
    pub session_id: String,
    pub sdp: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteP2pIceCandidateInput {
    pub device_id: String,
    pub session_id: String,
    pub candidate: String,
    #[serde(default)]
    pub sdp_mid: Option<String>,
    #[serde(default)]
    pub sdp_m_line_index: Option<u16>,
    #[serde(default)]
    pub username_fragment: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteP2pSessionInput {
    pub device_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteP2pFailureInput {
    pub device_id: String,
    pub session_id: String,
    pub reason: P2pFailureReason,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteP2pDataInput {
    pub device_id: String,
    pub session_id: String,
    /// Standard base64 rather than an unbounded renderer-to-Rust byte array.
    /// The encoded and decoded lengths are both capped before deserialization.
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteP2pOfferEvent {
    device_id: String,
    session_id: String,
    sdp: String,
    ice_servers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteP2pIceCandidateEvent {
    device_id: String,
    session_id: String,
    candidate: String,
    sdp_mid: Option<String>,
    sdp_m_line_index: Option<u16>,
    username_fragment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteP2pIceCompleteEvent {
    device_id: String,
    session_id: String,
}

/// Renderer recovery snapshot for a negotiation that arrived before the
/// WebView finished registering Tauri listeners (or during a renderer reload).
/// It contains WebRTC metadata only; session keys and encrypted control frames
/// remain Rust-owned.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteP2pPendingSnapshot {
    offers: Vec<RemoteP2pOfferEvent>,
    candidates: Vec<RemoteP2pIceCandidateEvent>,
    ice_completes: Vec<RemoteP2pIceCompleteEvent>,
}

#[derive(Debug, Clone)]
struct PendingP2pNegotiation {
    offer: RemoteP2pOfferEvent,
    candidates: Vec<RemoteP2pIceCandidateEvent>,
    ice_complete: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum GatewayRelayFrame {
    Ready {
        session_id: String,
    },
    PeerConnected {
        device_id: String,
        session_id: String,
    },
    PeerDisconnected {
        device_id: String,
        session_id: String,
    },
    Pong {
        nonce: Option<String>,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum GatewayRelayOpenFrame<'a> {
    Open {
        peer_id: &'a str,
        session_id: &'a str,
    },
}

fn keyring_entry(account: &str) -> Result<KeyringEntry, String> {
    KeyringEntry::new(REMOTE_KEYRING_SERVICE, account)
        .map_err(|error| format!("cannot access the operating-system credential store: {error}"))
}

fn read_keyring_secret(account: &str) -> Result<Option<Vec<u8>>, String> {
    match keyring_entry(account)?.get_secret() {
        Ok(secret) => Ok(Some(secret)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "cannot read the operating-system credential store: {error}"
        )),
    }
}

fn write_keyring_secret(account: &str, secret: &[u8]) -> Result<(), String> {
    keyring_entry(account)?
        .set_secret(secret)
        .map_err(|error| format!("cannot write the operating-system credential store: {error}"))
}

fn delete_keyring_secret(account: &str) -> Result<(), String> {
    match keyring_entry(account)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "cannot update the operating-system credential store: {error}"
        )),
    }
}

fn secret_account(prefix: &str, value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let fingerprint = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}-{fingerprint}")
}

fn identity_secret_account(device_id: &DeviceId) -> String {
    format!("desktop-identity-{device_id}")
}

fn gateway_token_secret_account(gateway_url: &str) -> String {
    secret_account("gateway-token", gateway_url)
}

fn pairing_invitation_secret_account(pairing_id: &PairingId) -> String {
    format!("pairing-invitation-{pairing_id}")
}

fn device_fingerprint(descriptor: &DeviceDescriptor) -> String {
    Sha256::digest(descriptor.signing_public_key.as_bytes())
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn identity_from_secret(
    device_id: DeviceId,
    device_name: &str,
    secret: &[u8],
) -> Result<DesktopIdentity, String> {
    if secret.len() != 64 {
        return Err(
            "stored remote desktop identity is malformed; reset remote control before pairing"
                .to_string(),
        );
    }
    let signing_bytes: [u8; 32] = secret[..32]
        .try_into()
        .map_err(|_| "stored remote signing key is malformed".to_string())?;
    let agreement_bytes: [u8; 32] = secret[32..]
        .try_into()
        .map_err(|_| "stored remote key-agreement key is malformed".to_string())?;
    let signing_key = DeviceSigningKey::from_bytes(signing_bytes);
    let agreement_key = KeyAgreementSecret::from_bytes(agreement_bytes);
    let descriptor = DeviceDescriptor::new(
        device_id,
        DeviceKind::Desktop,
        device_name,
        signing_key.public_key(),
        agreement_key.public_key(),
    )
    .map_err(|error| format!("stored remote desktop identity is invalid: {error}"))?;
    Ok(DesktopIdentity {
        descriptor,
        signing_key,
        agreement_key,
    })
}

fn desktop_identity(state: &RemoteAgentState) -> Result<DesktopIdentity, String> {
    let (device_id, device_name) = {
        let store = state
            .store
            .lock()
            .map_err(|_| "remote agent state poisoned".to_string())?;
        if !store.enabled {
            return Err("enable remote control before starting a pairing".to_string());
        }
        (
            store
                .device_id
                .clone()
                .ok_or_else(|| "remote desktop identity is unavailable".to_string())?,
            store
                .device_name
                .clone()
                .ok_or_else(|| "remote desktop name is unavailable".to_string())?,
        )
    };
    let device_id = DeviceId::from_str(&device_id).map_err(|_| {
        "remote desktop identity is invalid; disable and re-enable remote control".to_string()
    })?;
    let account = identity_secret_account(&device_id);
    let secret = match read_keyring_secret(&account)? {
        Some(secret) => secret,
        None => {
            let signing_key = DeviceSigningKey::generate();
            let agreement_key = KeyAgreementSecret::generate();
            let mut secret = Vec::with_capacity(64);
            secret.extend_from_slice(&signing_key.to_bytes());
            secret.extend_from_slice(&agreement_key.to_bytes());
            write_keyring_secret(&account, &secret)?;
            secret
        }
    };
    identity_from_secret(device_id, &device_name, &secret)
}

fn store_gateway_token(gateway_url: &str, token: &str) -> Result<(), String> {
    let token = token.trim();
    if token.len() < 16 || token.len() > 4_096 || token.chars().any(char::is_whitespace) {
        return Err("gateway device credential is invalid".to_string());
    }
    write_keyring_secret(&gateway_token_secret_account(gateway_url), token.as_bytes())
}

fn delete_gateway_token(gateway_url: &str) -> Result<(), String> {
    delete_keyring_secret(&gateway_token_secret_account(gateway_url))
}

fn gateway_token(gateway_url: &str) -> Result<String, String> {
    let account = gateway_token_secret_account(gateway_url);
    let Some(token) = read_keyring_secret(&account)? else {
        return Err("start a phone pairing to register this desktop with the gateway".to_string());
    };
    String::from_utf8(token).map_err(|_| {
        "stored gateway device credential is invalid; start a new phone pairing".to_string()
    })
}

fn store_pairing_invitation(invitation: &PairingInvitation) -> Result<(), String> {
    let bytes = serde_json::to_vec(invitation)
        .map_err(|error| format!("cannot encode pairing invitation: {error}"))?;
    write_keyring_secret(
        &pairing_invitation_secret_account(&invitation.pairing_id),
        &bytes,
    )
}

fn load_pairing_invitation(pairing_id: PairingId) -> Result<PairingInvitation, String> {
    let account = pairing_invitation_secret_account(&pairing_id);
    let Some(bytes) = read_keyring_secret(&account)? else {
        return Err("the pairing invitation is no longer available on this desktop".to_string());
    };
    serde_json::from_slice(&bytes)
        .map_err(|_| "the locally stored pairing invitation is malformed".to_string())
}

fn delete_pairing_invitation(pairing_id: PairingId) -> Result<(), String> {
    delete_keyring_secret(&pairing_invitation_secret_account(&pairing_id))
}

/// Keep the one-time invitation out of the HTTP request, proxy access logs,
/// and server-side routing. The mobile app consumes and removes this fragment
/// before it makes its first gateway call.
fn pairing_qr_deep_link(invitation: &PairingInvitation) -> Result<String, String> {
    let payload = serde_json::to_vec(invitation)
        .map_err(|error| format!("cannot encode pairing QR payload: {error}"))?;
    Ok(format!(
        "{}/pair#p={}",
        invitation.gateway_url.trim_end_matches('/'),
        URL_SAFE_NO_PAD.encode(payload)
    ))
}

fn pairing_qr_data_url(invitation: &PairingInvitation) -> Result<String, String> {
    let deep_link = pairing_qr_deep_link(invitation)?;
    let code = QrCode::new(deep_link.as_bytes())
        .map_err(|error| format!("cannot generate pairing QR code: {error}"))?;
    let svg = code
        .render::<svg::Color>()
        // Pairing invitations carry a signed desktop descriptor, so their QR
        // codes have more modules than a typical URL. Render a large square
        // and let the settings surface scale it down without shrinking the
        // modules below what phone cameras can reliably resolve.
        .min_dimensions(512, 512)
        .quiet_zone(true)
        .build();
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        STANDARD.encode(svg)
    ))
}

fn remove_expired_pending_pairings(store: &mut RemoteStore, now: u64) {
    store
        .pending_pairings
        .retain(|pairing| pairing.expires_at > now);
}

async fn gateway_response_json<T: DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, String> {
    let response = request
        .timeout(REMOTE_GATEWAY_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("cannot reach remote gateway: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("cannot read remote gateway response: {error}"))?;
    if !status.is_success() {
        let message = serde_json::from_slice::<GatewayErrorResponse>(&bytes)
            .ok()
            .map(|body| body.message)
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| "request rejected".to_string());
        return Err(format!(
            "remote gateway request failed ({status}): {message}"
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "remote gateway returned an invalid response".to_string())
}

fn gateway_credential_was_rejected(error: &str) -> bool {
    error.contains("remote gateway request failed (401")
        // The P0/P1 gateway intentionally keeps issued desktop credentials
        // in memory.  After a gateway restart, an otherwise-valid credential
        // is unknown and the current endpoint reports its resource as absent.
        // Treat only that precise route-level outcome as an enrollment retry;
        // unrelated 404s must remain visible instead of silently retrying.
        || (error.contains("remote gateway request failed (404")
            && error.contains(": resource not found"))
}

async fn gateway_pending_claim(
    gateway_url: &str,
    token: &str,
    pairing_id: &str,
) -> Result<Option<GatewayPendingClaim>, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{gateway_url}/v1/pairings/{pairing_id}/claims"))
        .bearer_auth(token)
        .timeout(REMOTE_GATEWAY_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("cannot reach remote gateway: {error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("cannot read remote gateway response: {error}"))?;
    if !status.is_success() {
        let message = serde_json::from_slice::<GatewayErrorResponse>(&bytes)
            .ok()
            .map(|body| body.message)
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| "request rejected".to_string());
        return Err(format!(
            "remote gateway request failed ({status}): {message}"
        ));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "remote gateway returned an invalid pairing claim".to_string())
}

/// Retries only the metadata-only deletion requests left behind by an offline
/// local unpair. The local pairing record is already gone; a successful retry
/// merely removes the corresponding gateway credential.
async fn retry_pending_gateway_revocations(app: &AppHandle) {
    let pending_device_ids = {
        let state = app.state::<RemoteAgentState>();
        let store = match state.store.lock() {
            Ok(store) => store,
            Err(_) => return,
        };
        store.pending_gateway_revocations.clone()
    };
    for device_id in pending_device_ids {
        retry_one_pending_gateway_revocation(app, &device_id).await;
    }
}

async fn retry_one_pending_gateway_revocation(app: &AppHandle, device_id: &str) {
    let state = app.state::<RemoteAgentState>();
    let _gateway_mutation = state.gateway_mutation_lock.lock().await;
    if DeviceId::from_str(device_id).is_err() {
        let _ = with_store(state.inner(), |store| {
            store
                .pending_gateway_revocations
                .retain(|pending| pending != device_id);
            Ok(())
        });
        return;
    }

    let gateway_url = {
        let store = match state.store.lock() {
            Ok(store) => store,
            Err(_) => return,
        };
        let still_pending = store
            .pending_gateway_revocations
            .iter()
            .any(|pending| pending == device_id);
        if !still_pending {
            None
        } else {
            store.gateway_url.clone()
        }
    };
    let Some(gateway_url) = gateway_url else {
        let _ = with_store(state.inner(), |store| {
            store
                .pending_gateway_revocations
                .retain(|pending| pending != device_id);
            Ok(())
        });
        return;
    };
    let Ok(token) = gateway_token(&gateway_url) else {
        return;
    };
    let client = reqwest::Client::new();
    let result: Result<GatewayRevokeDeviceResponse, String> = gateway_response_json(
        client
            .delete(format!("{gateway_url}/v1/devices/{device_id}"))
            .bearer_auth(&token),
    )
    .await;
    if matches!(result, Ok(response) if response.revoked_device_id == device_id) {
        let _ = with_store(state.inner(), |store| {
            store
                .pending_gateway_revocations
                .retain(|pending| pending != device_id);
            Ok(())
        });
    }
}

fn schedule_pending_gateway_revocations(app: AppHandle) {
    let state = app.state::<RemoteAgentState>();
    let has_pending = state
        .store
        .lock()
        .is_ok_and(|store| !store.pending_gateway_revocations.is_empty());
    if !has_pending {
        return;
    }
    let mut active = match state.gateway_revocation_retry_active.lock() {
        Ok(active) => active,
        Err(_) => return,
    };
    if *active {
        return;
    }
    *active = true;
    drop(active);
    drop(state);
    tauri::async_runtime::spawn(async move {
        retry_pending_gateway_revocations(&app).await;
        if let Ok(mut active) = app
            .state::<RemoteAgentState>()
            .gateway_revocation_retry_active
            .lock()
        {
            *active = false;
        }
    });
}

fn websocket_endpoint(gateway_url: &str, path: &str) -> Result<String, String> {
    let mut endpoint = reqwest::Url::parse(&format!("{gateway_url}{path}"))
        .map_err(|_| "invalid remote gateway URL".to_string())?;
    let scheme = match endpoint.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => return Err("invalid remote gateway URL".to_string()),
    };
    endpoint
        .set_scheme(scheme)
        .map_err(|_| "invalid remote gateway URL".to_string())?;
    Ok(endpoint.into())
}

fn authenticated_websocket_request(
    gateway_url: &str,
    path: &str,
    token: &str,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    let endpoint = websocket_endpoint(gateway_url, path)?;
    let mut request = endpoint
        .into_client_request()
        .map_err(|_| "cannot create a remote gateway WebSocket request".to_string())?;
    let authorization = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "stored gateway credential is invalid".to_string())?;
    request.headers_mut().insert(AUTHORIZATION, authorization);
    Ok(request)
}

fn remote_websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_RELAY_FRAME_BYTES))
        .max_frame_size(Some(MAX_RELAY_FRAME_BYTES))
}

fn transport_configuration(app: &AppHandle) -> Result<(String, String), String> {
    let state = app.state::<RemoteAgentState>();
    let gateway_url = configured_gateway_url(state.inner())?;
    let token = gateway_token(&gateway_url)?;
    Ok((gateway_url, token))
}

fn transport_generation_is_current(app: &AppHandle, generation: u64) -> bool {
    app.state::<RemoteAgentState>()
        .transport_generation
        .load(Ordering::SeqCst)
        == generation
}

fn start_transport(app: AppHandle, state: &RemoteAgentState) {
    // A missing credential is normal before a first enrollment. The settings
    // UI will surface it when the user starts pairing; startup itself must not
    // make the desktop fail to open.
    if configured_gateway_url(state)
        .and_then(|gateway_url| gateway_token(&gateway_url).map(|_| ()))
        .is_err()
    {
        return;
    }
    schedule_pending_gateway_revocations(app.clone());
    let mut guard = match state.transport_shutdown.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if guard.is_some() {
        return;
    }
    let (shutdown, receiver) = watch::channel(false);
    let (signal_outbound, signal_inbound) = mpsc::channel(MAX_PENDING_GATEWAY_SIGNALS);
    let generation = state
        .transport_generation
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1);
    *guard = Some(shutdown);
    if let Ok(mut outbound) = state.signal_outbound.lock() {
        *outbound = Some(signal_outbound);
    } else {
        // The runner must not outlive an unusable state lock. Drop the just
        // installed shutdown sender before returning so a later enable can
        // retry cleanly.
        *guard = None;
        return;
    }
    tauri::async_runtime::spawn(async move {
        run_signal_transport(app, receiver, signal_inbound, generation).await;
    });
}

fn stop_transport(app: &AppHandle, state: &RemoteAgentState) {
    // Invalidate before signalling shutdown. A runner can otherwise complete
    // a pending connect and clear a newer runner's P2P sessions during its
    // delayed cleanup.
    state.transport_generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = state.transport_shutdown.lock() {
        if let Some(shutdown) = guard.take() {
            let _ = shutdown.send(true);
        }
    }
    if let Ok(mut sessions) = state.active_relay_sessions.lock() {
        sessions.clear();
    }
    // Emit the same event used for signal-lease loss before removing the Rust
    // sessions. Otherwise a disabled/restarted desktop would reject later
    // frames but leave the browser DataChannel visibly open in both clients.
    close_p2p_sessions_for_signal_disconnect(app);
    if let Ok(mut outbound) = state.signal_outbound.lock() {
        *outbound = None;
    }
}

async fn run_signal_transport(
    app: AppHandle,
    mut shutdown: watch::Receiver<bool>,
    mut outbound: mpsc::Receiver<GatewayOutboundSignalFrame>,
    generation: u64,
) {
    loop {
        if *shutdown.borrow() || !transport_generation_is_current(&app, generation) {
            return;
        }
        let (gateway_url, token) = match transport_configuration(&app) {
            Ok(configuration) => configuration,
            Err(_) => return,
        };
        let request = match authenticated_websocket_request(&gateway_url, "/v1/signal", &token) {
            Ok(request) => request,
            Err(_) => return,
        };
        match connect_async_with_config(request, Some(remote_websocket_config()), false).await {
            Ok((mut socket, _)) => {
                if *shutdown.borrow() || !transport_generation_is_current(&app, generation) {
                    let _ = socket.close(None).await;
                    return;
                }
                // A confirmed gateway connection is a safe opportunity to
                // retry any local revoke that previously could not reach it.
                schedule_pending_gateway_revocations(app.clone());
                run_signal_connection(
                    app.clone(),
                    socket,
                    shutdown.clone(),
                    &mut outbound,
                    generation,
                )
                .await;
                if !*shutdown.borrow() && transport_generation_is_current(&app, generation) {
                    close_p2p_sessions_for_signal_disconnect(&app);
                }
            }
            Err(_) => {
                // Network state is expected to change while a laptop sleeps or
                // roams. Do not log endpoint/token data or spin aggressively.
            }
        }
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
            () = tokio::time::sleep(REMOTE_GATEWAY_RECONNECT_DELAY) => {}
        }
    }
}

async fn run_signal_connection(
    app: AppHandle,
    mut socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    mut shutdown: watch::Receiver<bool>,
    outbound: &mut mpsc::Receiver<GatewayOutboundSignalFrame>,
    generation: u64,
) {
    // A TCP/WebSocket connection can remain locally "open" after a NAT,
    // laptop sleep, or proxy black-hole. Direct WebRTC is only authorized
    // while this control plane is demonstrably alive, so require a matching
    // application pong rather than relying on socket state alone.
    let mut heartbeat = interval(REMOTE_SIGNAL_HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_pong = Instant::now();
    let mut expected_pong = None::<String>;
    let mut heartbeat_counter = 0_u64;
    loop {
        if !transport_generation_is_current(&app, generation) {
            return;
        }
        tokio::select! {
            _ = heartbeat.tick() => {
                if last_pong.elapsed() >= REMOTE_SIGNAL_HEARTBEAT_TIMEOUT {
                    return;
                }
                // Keep one outstanding challenge. Replacing it on every tick
                // would allow a delayed old pong to look like fresh liveness.
                if expected_pong.is_none() {
                    heartbeat_counter = heartbeat_counter.wrapping_add(1);
                    let nonce = format!("p2-signal-{generation}-{heartbeat_counter}");
                    let ping = serde_json::json!({
                        "type": "ping",
                        "nonce": nonce.clone(),
                    });
                    let Ok(ping) = serde_json::to_string(&ping) else { return; };
                    let write_timeout = REMOTE_SIGNAL_WRITE_TIMEOUT.min(
                        REMOTE_SIGNAL_HEARTBEAT_TIMEOUT.saturating_sub(last_pong.elapsed()),
                    );
                    if write_timeout.is_zero()
                        || !matches!(
                            timeout(write_timeout, socket.send(Message::text(ping))).await,
                            Ok(Ok(()))
                        )
                    {
                        return;
                    }
                    expected_pong = Some(nonce);
                }
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
            outgoing = outbound.recv() => {
                let Some(outgoing) = outgoing else { return; };
                if !transport_generation_is_current(&app, generation) {
                    return;
                }
                let Ok(outgoing) = serde_json::to_string(&outgoing) else { continue; };
                let write_timeout = REMOTE_SIGNAL_WRITE_TIMEOUT.min(
                    REMOTE_SIGNAL_HEARTBEAT_TIMEOUT.saturating_sub(last_pong.elapsed()),
                );
                if outgoing.len() > MAX_RELAY_FRAME_BYTES
                    || write_timeout.is_zero()
                    || !matches!(
                        timeout(write_timeout, socket.send(Message::text(outgoing))).await,
                        Ok(Ok(()))
                    )
                {
                    return;
                }
            }
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { return; };
                if !transport_generation_is_current(&app, generation) {
                    return;
                }
                match message {
                    Message::Text(text) => {
                        if text.len() > MAX_RELAY_FRAME_BYTES {
                            return;
                        }
                        let Ok(frame) = serde_json::from_str::<GatewaySignalFrame>(text.as_str()) else {
                            // Gateway control text has a closed schema. An
                            // unexpected frame cannot be treated as a relay offer.
                            continue;
                        };
                        match frame {
                            GatewaySignalFrame::Signal { from, session_id, payload } => {
                                schedule_signal_payload(
                                    app.clone(),
                                    from,
                                    session_id,
                                    payload,
                                    shutdown.clone(),
                                );
                            }
                            GatewaySignalFrame::Ready { device_id } => {
                                let _ = device_id;
                            }
                            GatewaySignalFrame::Revoked { device_id } => {
                                handle_gateway_device_revoked(&app, &device_id);
                            }
                            GatewaySignalFrame::Presence { device_id, online } => {
                                let _ = (device_id, online);
                            }
                            GatewaySignalFrame::Pong { nonce } => {
                                if nonce.as_deref() == expected_pong.as_deref() {
                                    last_pong = Instant::now();
                                    expected_pong = None;
                                }
                            }
                            GatewaySignalFrame::Error { code, message } => {
                                let _ = (code, message);
                            }
                        }
                    }
                    Message::Ping(payload) => {
                        let write_timeout = REMOTE_SIGNAL_WRITE_TIMEOUT.min(
                            REMOTE_SIGNAL_HEARTBEAT_TIMEOUT.saturating_sub(last_pong.elapsed()),
                        );
                        if write_timeout.is_zero()
                            || !matches!(
                                timeout(write_timeout, socket.send(Message::Pong(payload))).await,
                                Ok(Ok(()))
                            )
                        {
                            return;
                        }
                    }
                    Message::Close(_) => return,
                    Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    }
}

struct ReservedRelaySession {
    active_key: String,
    device_id: String,
    session_id: SessionId,
    wire: RemoteWireSession,
}

/// The gateway sends `ready` to each relay endpoint before it announces the
/// peer. Do not process application ciphertext until both signals have been
/// observed: a browser can receive a stale queued binary frame while its new
/// relay WebSocket is still completing the opening handshake.
#[derive(Default)]
struct RelayConnectionReadiness {
    local_ready: bool,
    peer_connected: bool,
}

impl RelayConnectionReadiness {
    fn accepts_ciphertext(&self) -> bool {
        self.local_ready && self.peer_connected
    }
}

/// A direct WebRTC attempt whose encrypted control channel is still owned by
/// Rust. The renderer only operates browser WebRTC objects and forwards
/// bounded ciphertext frames; it never gets a pairing private key or a
/// gateway bearer credential.
struct ReservedP2pSession {
    device_id: String,
    session_id: SessionId,
    wire: Arc<RemoteWireSession>,
    established: AtomicBool,
    received_ice_candidates: AtomicUsize,
}

fn reserve_p2p_session(
    state: &RemoteAgentState,
    mobile_id: DeviceId,
    session_id: SessionId,
) -> Result<Arc<ReservedP2pSession>, String> {
    let device_id = mobile_id.to_string();
    let session_id_text = session_id.to_string();
    // Reject overload before consuming a durable anti-replay slot. This is a
    // cheap preflight only; the final check below still closes concurrent
    // same-session races before the WebRTC object can exist.
    {
        let active = state
            .active_p2p_sessions
            .lock()
            .map_err(|_| "remote P2P state poisoned".to_string())?;
        if active.contains_key(&session_id_text) {
            return Err("remote transport session is already active".to_string());
        }
        if active.len() >= MAX_ACTIVE_P2P_SESSIONS {
            return Err("too many active P2P transport sessions".to_string());
        }
    }
    let (desktop_id, mobile) = with_store(state, |store| {
        if !store.enabled {
            return Err("remote control is disabled".to_string());
        }
        let desktop_id = store
            .device_id
            .as_deref()
            .ok_or_else(|| "remote desktop identity is unavailable".to_string())
            .and_then(|id| {
                DeviceId::from_str(id).map_err(|_| "remote desktop identity is invalid".to_string())
            })?;
        let device = store
            .devices
            .iter()
            .find(|device| device.id == device_id)
            .ok_or_else(|| "remote device is not paired".to_string())?;
        if device.revoked_at.is_some() {
            return Err("remote device has been revoked".to_string());
        }
        if device.session_id.as_deref() == Some(session_id_text.as_str()) {
            return Err(
                "transport session must be fresh and cannot reuse the pairing session".to_string(),
            );
        }
        let descriptor = device
            .descriptor
            .clone()
            .ok_or_else(|| "paired device is missing its key-agreement descriptor".to_string())?;
        // Record before deriving/activating so a concurrent relay offer can
        // never reserve the same key-derivation context under another
        // transport. Failed post-reservation work may consume a slot, but it
        // cannot reopen a replay window.
        record_transport_session(store, &device_id, &session_id_text)?;
        Ok((desktop_id, descriptor))
    })?;
    let identity = desktop_identity(state)?;
    if identity.descriptor.device_id != desktop_id {
        return Err(
            "remote desktop identity changed while opening a transport session".to_string(),
        );
    }
    let context = SessionKeyContext::new(session_id, desktop_id, mobile_id)
        .map_err(|error| format!("cannot derive remote transport context: {error}"))?;
    let key = identity
        .agreement_key
        .derive_session_key(&mobile.key_agreement_public_key, &context)
        .map_err(|error| format!("cannot derive remote transport key: {error}"))?;
    let incoming = SessionRoute::new(session_id, mobile_id, desktop_id);
    let wire = Arc::new(RemoteWireSession::new(
        device_id.clone(),
        TransportKind::P2p,
        key,
        incoming,
    )?);
    let session = Arc::new(ReservedP2pSession {
        device_id,
        session_id,
        wire,
        established: AtomicBool::new(false),
        received_ice_candidates: AtomicUsize::new(0),
    });
    let mut active = state
        .active_p2p_sessions
        .lock()
        .map_err(|_| "remote P2P state poisoned".to_string())?;
    if active.contains_key(&session_id_text) {
        return Err("remote transport session is already active".to_string());
    }
    if active.len() >= MAX_ACTIVE_P2P_SESSIONS {
        return Err("too many active P2P transport sessions".to_string());
    }
    active.insert(session_id_text, session.clone());
    Ok(session)
}

fn p2p_session(
    state: &RemoteAgentState,
    device_id: &str,
    session_id: &str,
) -> Result<Arc<ReservedP2pSession>, String> {
    DeviceId::from_str(device_id).map_err(|_| "invalid remote device identity".to_string())?;
    SessionId::from_str(session_id).map_err(|_| "invalid remote transport session".to_string())?;
    let sessions = state
        .active_p2p_sessions
        .lock()
        .map_err(|_| "remote P2P state poisoned".to_string())?;
    let session = sessions
        .get(session_id)
        .cloned()
        .ok_or_else(|| "remote P2P transport session is unavailable".to_string())?;
    if session.device_id != device_id {
        return Err("remote P2P device does not match the transport session".to_string());
    }
    Ok(session)
}

fn remove_p2p_session(state: &RemoteAgentState, device_id: &str, session_id: &str) {
    let Ok(mut sessions) = state.active_p2p_sessions.lock() else {
        return;
    };
    if sessions
        .get(session_id)
        .is_some_and(|session| session.device_id == device_id)
    {
        sessions.remove(session_id);
    }
    if let Ok(mut pending) = state.pending_p2p_negotiations.lock() {
        pending.remove(session_id);
    }
}

fn retain_pending_p2p_offer(
    state: &RemoteAgentState,
    offer: RemoteP2pOfferEvent,
) -> Result<(), String> {
    let mut pending = state
        .pending_p2p_negotiations
        .lock()
        .map_err(|_| "remote P2P recovery state poisoned".to_string())?;
    pending.insert(
        offer.session_id.clone(),
        PendingP2pNegotiation {
            offer,
            candidates: Vec::new(),
            ice_complete: false,
        },
    );
    Ok(())
}

fn retain_pending_p2p_candidate(state: &RemoteAgentState, candidate: RemoteP2pIceCandidateEvent) {
    let Ok(mut pending) = state.pending_p2p_negotiations.lock() else {
        return;
    };
    let Some(negotiation) = pending.get_mut(&candidate.session_id) else {
        return;
    };
    // Gateway signaling is ordered per WebSocket, but a renderer-recovery
    // snapshot may overlap a live event. Preserve only one exact candidate so
    // the browser is never asked to add it twice after recovery.
    if !negotiation.candidates.iter().any(|existing| {
        existing.candidate == candidate.candidate
            && existing.sdp_mid == candidate.sdp_mid
            && existing.sdp_m_line_index == candidate.sdp_m_line_index
            && existing.username_fragment == candidate.username_fragment
    }) {
        negotiation.candidates.push(candidate);
    }
}

fn retain_pending_p2p_ice_complete(state: &RemoteAgentState, session_id: &str) {
    if let Ok(mut pending) = state.pending_p2p_negotiations.lock() {
        if let Some(negotiation) = pending.get_mut(session_id) {
            negotiation.ice_complete = true;
        }
    }
}

fn discard_pending_p2p_negotiation(state: &RemoteAgentState, session_id: &str) {
    if let Ok(mut pending) = state.pending_p2p_negotiations.lock() {
        pending.remove(session_id);
    }
}

fn pending_p2p_snapshot(state: &RemoteAgentState) -> Result<RemoteP2pPendingSnapshot, String> {
    let pending = state
        .pending_p2p_negotiations
        .lock()
        .map_err(|_| "remote P2P recovery state poisoned".to_string())?;
    let mut offers = Vec::with_capacity(pending.len());
    let mut candidates = Vec::new();
    let mut ice_completes = Vec::new();
    for negotiation in pending.values() {
        offers.push(negotiation.offer.clone());
        candidates.extend(negotiation.candidates.iter().cloned());
        if negotiation.ice_complete {
            ice_completes.push(RemoteP2pIceCompleteEvent {
                device_id: negotiation.offer.device_id.clone(),
                session_id: negotiation.offer.session_id.clone(),
            });
        }
    }
    Ok(RemoteP2pPendingSnapshot {
        offers,
        candidates,
        ice_completes,
    })
}

/// Applies a revocation already confirmed by the gateway. In particular, this
/// closes the local authorization gap left by a live WebRTC DataChannel: that
/// channel no longer visits the gateway after negotiation, so deleting its
/// Rust-side session and marking the local grant revoked must happen here.
/// The returned events are emitted by the Tauri-facing wrapper below.
fn mark_gateway_revoked_device(
    state: &RemoteAgentState,
    device_id: &str,
) -> Vec<RemoteP2pSessionInput> {
    if DeviceId::from_str(device_id).is_err() {
        return Vec::new();
    }

    // `with_store` mutates the in-memory state before its atomic persistence
    // attempt. Even a transient disk failure therefore fails closed for the
    // currently running desktop; the gateway already revoked its credential.
    let _ = with_store(state, |store| {
        if let Some(device) = store
            .devices
            .iter_mut()
            .find(|device| device.id == device_id)
        {
            device.revoked_at.get_or_insert_with(now_epoch_millis);
        }
        // This is a confirmation from the gateway, not a local revoke that
        // still needs retrying. Avoid a later stale delete racing a new,
        // explicitly approved pairing for this same stable device ID.
        store
            .pending_gateway_revocations
            .retain(|pending| pending != device_id);
        Ok(())
    });

    let removed_p2p = match state.active_p2p_sessions.lock() {
        Ok(mut sessions) => {
            let removed = sessions
                .iter()
                .filter(|(_, session)| session.device_id == device_id)
                .map(|(session_id, _)| RemoteP2pSessionInput {
                    device_id: device_id.to_string(),
                    session_id: session_id.clone(),
                })
                .collect::<Vec<_>>();
            sessions.retain(|_, session| session.device_id != device_id);
            removed
        }
        Err(_) => Vec::new(),
    };
    if let Ok(mut relays) = state.active_relay_sessions.lock() {
        let prefix = format!("{device_id}:");
        relays.retain(|active| !active.starts_with(&prefix));
    }
    if let Ok(mut pending) = state.pending_p2p_negotiations.lock() {
        pending.retain(|_, negotiation| negotiation.offer.device_id != device_id);
    }
    removed_p2p
}

fn handle_gateway_device_revoked(app: &AppHandle, device_id: &str) {
    let state = app.state::<RemoteAgentState>();
    for session in mark_gateway_revoked_device(state.inner(), device_id) {
        let _ = app.emit("remote-p2p-failed", session);
    }
}

/// A direct P2P channel is authorized only while the desktop retains its
/// authenticated gateway signal control plane. On a signal disconnect, drop
/// every direct session before reconnecting: this turns a missed/buffer-full
/// revocation notification into a bounded connection loss instead of leaving
/// a gateway-bypassing DataChannel alive indefinitely.
fn clear_p2p_sessions_for_control_lease_loss(
    state: &RemoteAgentState,
) -> Vec<RemoteP2pSessionInput> {
    let removed = match state.active_p2p_sessions.lock() {
        Ok(mut sessions) => std::mem::take(&mut *sessions)
            .into_iter()
            .map(|(session_id, session)| RemoteP2pSessionInput {
                device_id: session.device_id.clone(),
                session_id,
            })
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };
    if let Ok(mut pending) = state.pending_p2p_negotiations.lock() {
        pending.clear();
    }
    removed
}

fn close_p2p_sessions_for_signal_disconnect(app: &AppHandle) {
    let state = app.state::<RemoteAgentState>();
    let removed = clear_p2p_sessions_for_control_lease_loss(state.inner());
    for session in removed {
        let _ = app.emit("remote-p2p-failed", session);
    }
}

fn queue_gateway_signal(
    state: &RemoteAgentState,
    device_id: &str,
    session_id: &str,
    payload: TransportSignal,
) -> Result<(), String> {
    payload
        .validate()
        .map_err(|_| "invalid remote WebRTC signaling payload".to_string())?;
    let payload = serde_json::to_value(payload)
        .map_err(|_| "cannot encode remote WebRTC signaling payload".to_string())?;
    let outbound = state
        .signal_outbound
        .lock()
        .map_err(|_| "remote signal state poisoned".to_string())?
        .clone()
        .ok_or_else(|| "remote signal transport is unavailable".to_string())?;
    outbound
        .try_send(GatewayOutboundSignalFrame::Signal {
            to: device_id.to_string(),
            session_id: session_id.to_string(),
            payload,
        })
        .map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => {
                "remote signal transport is busy; try again".to_string()
            }
            mpsc::error::TrySendError::Closed(_) => {
                "remote signal transport is unavailable".to_string()
            }
        })
}

fn schedule_p2p_attempt_expiry(app: AppHandle, session: Arc<ReservedP2pSession>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REMOTE_P2P_NEGOTIATION_TIMEOUT).await;
        if !session.established.load(Ordering::SeqCst) {
            let state = app.state::<RemoteAgentState>();
            remove_p2p_session(
                state.inner(),
                &session.device_id,
                &session.session_id.to_string(),
            );
        }
    });
}

fn schedule_p2p_signal(app: AppHandle, from: String, session_id: String, signal: TransportSignal) {
    if signal.validate().is_err() {
        return;
    }
    let Ok(mobile_id) = DeviceId::from_str(&from) else {
        return;
    };
    let Ok(parsed_session_id) = SessionId::from_str(&session_id) else {
        return;
    };
    match signal {
        TransportSignal::WebrtcOffer { sdp, .. } => {
            let state = app.state::<RemoteAgentState>();
            let Ok(session) = reserve_p2p_session(state.inner(), mobile_id, parsed_session_id)
            else {
                return;
            };
            let ice_servers = state
                .store
                .lock()
                .map(|store| store.ice_servers.clone())
                .unwrap_or_default();
            let event = RemoteP2pOfferEvent {
                device_id: from,
                session_id,
                sdp,
                ice_servers,
            };
            if retain_pending_p2p_offer(state.inner(), event.clone()).is_err() {
                remove_p2p_session(
                    state.inner(),
                    &session.device_id,
                    &session.session_id.to_string(),
                );
                return;
            }
            if app.emit("remote-p2p-offer", event).is_err() {
                remove_p2p_session(
                    state.inner(),
                    &session.device_id,
                    &session.session_id.to_string(),
                );
                return;
            }
            schedule_p2p_attempt_expiry(app, session);
        }
        TransportSignal::WebrtcIceCandidate {
            candidate,
            sdp_mid,
            sdp_m_line_index,
            username_fragment,
            ..
        } => {
            let state = app.state::<RemoteAgentState>();
            let Ok(session) = p2p_session(state.inner(), &from, &session_id) else {
                return;
            };
            if session
                .received_ice_candidates
                .fetch_add(1, Ordering::SeqCst)
                >= MAX_P2P_ICE_CANDIDATES_PER_SESSION
            {
                let _ = queue_gateway_signal(
                    state.inner(),
                    &from,
                    &session_id,
                    TransportSignal::P2pFailed {
                        protocol_version: CURRENT_PROTOCOL_VERSION,
                        reason: P2pFailureReason::NegotiationFailed,
                    },
                );
                remove_p2p_session(state.inner(), &from, &session_id);
                let _ = app.emit(
                    "remote-p2p-failed",
                    RemoteP2pSessionInput {
                        device_id: from,
                        session_id,
                    },
                );
                return;
            }
            let event = RemoteP2pIceCandidateEvent {
                device_id: from,
                session_id,
                candidate,
                sdp_mid,
                sdp_m_line_index,
                username_fragment,
            };
            retain_pending_p2p_candidate(state.inner(), event.clone());
            let _ = app.emit("remote-p2p-ice-candidate", event);
        }
        TransportSignal::WebrtcIceComplete { .. } => {
            let state = app.state::<RemoteAgentState>();
            if p2p_session(state.inner(), &from, &session_id).is_err() {
                return;
            }
            let event = RemoteP2pIceCompleteEvent {
                device_id: from,
                session_id,
            };
            retain_pending_p2p_ice_complete(state.inner(), &event.session_id);
            let _ = app.emit("remote-p2p-ice-complete", event);
        }
        TransportSignal::P2pFailed { .. } => {
            let state = app.state::<RemoteAgentState>();
            remove_p2p_session(state.inner(), &from, &session_id);
            let _ = app.emit(
                "remote-p2p-failed",
                RemoteP2pSessionInput {
                    device_id: from,
                    session_id,
                },
            );
        }
        // P2 has exactly one mobile offerer. An answer sent to desktop is a
        // protocol violation rather than a renegotiation opportunity.
        TransportSignal::WebrtcAnswer { .. } | TransportSignal::RelayOffer { .. } => {}
    }
}

fn reserve_relay_session(
    state: &RemoteAgentState,
    mobile_id: DeviceId,
    session_id: SessionId,
) -> Result<ReservedRelaySession, String> {
    let device_id = mobile_id.to_string();
    let session_id_text = session_id.to_string();
    let active_key = format!("{device_id}:{session_id_text}");
    {
        let mut active = state
            .active_relay_sessions
            .lock()
            .map_err(|_| "remote relay state poisoned".to_string())?;
        if active.contains(&active_key) {
            return Err("remote transport session is already active".to_string());
        }
        if active.len() >= MAX_ACTIVE_RELAY_SESSIONS {
            return Err("too many active remote transport sessions".to_string());
        }
        active.insert(active_key.clone());
    }
    let pairing = with_store(state, |store| {
        if !store.enabled {
            return Err("remote control is disabled".to_string());
        }
        let desktop_id = store
            .device_id
            .as_deref()
            .ok_or_else(|| "remote desktop identity is unavailable".to_string())
            .and_then(|id| {
                DeviceId::from_str(id).map_err(|_| "remote desktop identity is invalid".to_string())
            })?;
        let device = store
            .devices
            .iter()
            .find(|device| device.id == device_id)
            .ok_or_else(|| "remote device is not paired".to_string())?;
        if device.revoked_at.is_some() {
            return Err("remote device has been revoked".to_string());
        }
        if device.session_id.as_deref() == Some(session_id_text.as_str()) {
            return Err(
                "transport session must be fresh and cannot reuse the pairing session".to_string(),
            );
        }
        let descriptor = device
            .descriptor
            .clone()
            .ok_or_else(|| "paired device is missing its key-agreement descriptor".to_string())?;
        record_transport_session(store, &device_id, &session_id_text)?;
        Ok((desktop_id, descriptor))
    });
    let (desktop_id, mobile) = match pairing {
        Ok(pairing) => pairing,
        Err(error) => {
            if let Ok(mut active) = state.active_relay_sessions.lock() {
                active.remove(&active_key);
            }
            return Err(error);
        }
    };
    let result = (|| {
        let identity = desktop_identity(state)?;
        if identity.descriptor.device_id != desktop_id {
            return Err(
                "remote desktop identity changed while opening a transport session".to_string(),
            );
        }
        let context = SessionKeyContext::new(session_id, desktop_id, mobile_id)
            .map_err(|error| format!("cannot derive remote transport context: {error}"))?;
        let key = identity
            .agreement_key
            .derive_session_key(&mobile.key_agreement_public_key, &context)
            .map_err(|error| format!("cannot derive remote transport key: {error}"))?;
        let incoming = SessionRoute::new(session_id, mobile_id, desktop_id);
        let wire =
            RemoteWireSession::new(device_id.clone(), TransportKind::TcpRelay, key, incoming)?;
        Ok(ReservedRelaySession {
            active_key: active_key.clone(),
            device_id: device_id.clone(),
            session_id,
            wire,
        })
    })();
    if result.is_err() {
        if let Ok(mut active) = state.active_relay_sessions.lock() {
            active.remove(&active_key);
        }
    }
    result
}

fn schedule_signal_payload(
    app: AppHandle,
    from: String,
    session_id: String,
    payload: Value,
    shutdown: watch::Receiver<bool>,
) {
    let Ok(signal) = serde_json::from_value::<TransportSignal>(payload) else {
        return;
    };
    if signal.validate().is_err() {
        return;
    }
    match signal {
        // Keep the legacy P1 fallback byte-for-byte compatible: a P2 mobile
        // creates a *new* outer session ID and sends this established offer.
        TransportSignal::RelayOffer { .. } => {
            schedule_relay_offer(app, from, session_id, shutdown);
        }
        signal => schedule_p2p_signal(app, from, session_id, signal),
    }
}

fn schedule_relay_offer(
    app: AppHandle,
    from: String,
    session_id: String,
    shutdown: watch::Receiver<bool>,
) {
    let Ok(mobile_id) = DeviceId::from_str(&from) else {
        return;
    };
    let Ok(session_id) = SessionId::from_str(&session_id) else {
        return;
    };
    let state = app.state::<RemoteAgentState>();
    let Ok(session) = reserve_relay_session(state.inner(), mobile_id, session_id) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        run_relay_session(app, session, shutdown).await;
    });
}

async fn run_relay_session(
    app: AppHandle,
    session: ReservedRelaySession,
    mut shutdown: watch::Receiver<bool>,
) {
    let session_id = session.session_id.to_string();
    let result = run_relay_connection(&app, &session, &mut shutdown).await;
    if result.is_err() {
        // This is deliberately metadata-only. Relay ciphertext, signals, and
        // decrypted control inputs never reach logs or the audit file.
        eprintln!("SomniQ remote relay session ended before completion");
    }
    if let Ok(mut active) = app.state::<RemoteAgentState>().active_relay_sessions.lock() {
        active.remove(&session.active_key);
    }
    let _ = session_id;
}

async fn run_relay_connection(
    app: &AppHandle,
    session: &ReservedRelaySession,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let (gateway_url, token) = transport_configuration(app)?;
    let request = authenticated_websocket_request(&gateway_url, "/v1/relay", &token)?;
    let (mut socket, _) =
        connect_async_with_config(request, Some(remote_websocket_config()), false)
            .await
            .map_err(|_| "cannot connect to remote relay".to_string())?;
    let session_id = session.session_id.to_string();
    let open = serde_json::to_string(&GatewayRelayOpenFrame::Open {
        peer_id: &session.device_id,
        session_id: &session_id,
    })
    .map_err(|_| "cannot create remote relay opening frame".to_string())?;
    socket
        .send(Message::text(open))
        .await
        .map_err(|_| "cannot open remote relay session".to_string())?;
    let mut readiness = RelayConnectionReadiness::default();
    let peer_connect_timeout = tokio::time::sleep(REMOTE_RELAY_PEER_CONNECT_TIMEOUT);
    tokio::pin!(peer_connect_timeout);
    loop {
        tokio::select! {
            () = &mut peer_connect_timeout, if !readiness.peer_connected => {
                return Err("remote relay peer did not connect before the timeout".to_string());
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = socket.close(None).await;
                    return Ok(());
                }
            }
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else {
                    return Ok(());
                };
                match message {
                    Message::Text(text) => {
                        if text.len() > MAX_RELAY_FRAME_BYTES {
                            return Err("remote relay sent an oversized control frame".to_string());
                        }
                        let frame = serde_json::from_str::<GatewayRelayFrame>(text.as_str())
                            .map_err(|_| "remote relay sent an invalid control frame".to_string())?;
                        match frame {
                            GatewayRelayFrame::Ready { session_id: received } if received == session_id => {
                                readiness.local_ready = true;
                            }
                            GatewayRelayFrame::PeerConnected { device_id, session_id: received }
                                if device_id == session.device_id && received == session_id => {
                                    readiness.peer_connected = true;
                                }
                            GatewayRelayFrame::PeerDisconnected { device_id, session_id: received }
                                if device_id == session.device_id && received == session_id => return Ok(()),
                            GatewayRelayFrame::Pong { nonce } => { let _ = nonce; }
                            GatewayRelayFrame::Error { code, message } => {
                                let _ = (code, message);
                                return Err("remote relay rejected the session".to_string());
                            }
                            _ => return Err("remote relay sent an unexpected control frame".to_string()),
                        }
                    }
                    Message::Binary(payload) => {
                        if !readiness.accepts_ciphertext() || payload.len() > MAX_RELAY_FRAME_BYTES {
                            return Err("remote relay sent an unexpected binary frame".to_string());
                        }
                        let envelope = serde_json::from_slice::<SecureEnvelope>(&payload)
                            .map_err(|_| "remote relay sent an invalid encrypted frame".to_string())?;
                        let state = app.state::<RemoteAgentState>();
                        let response = session
                            .wire
                            .handle_envelope(app.clone(), state.inner(), &envelope)
                            .await?;
                        let response = serde_json::to_vec(&response)
                            .map_err(|_| "cannot encode encrypted remote response".to_string())?;
                        if response.len() > MAX_RELAY_FRAME_BYTES {
                            return Err("encrypted remote response exceeds relay frame limit".to_string());
                        }
                        socket
                            .send(Message::binary(response))
                            .await
                            .map_err(|_| "cannot send encrypted remote response".to_string())?;
                    }
                    Message::Ping(payload) => {
                        socket.send(Message::Pong(payload)).await
                            .map_err(|_| "cannot answer remote relay ping".to_string())?;
                    }
                    Message::Close(_) => return Ok(()),
                    Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    }
}

fn status_from_store(store: &RemoteStore) -> RemoteControlStatus {
    RemoteControlStatus {
        enabled: store.enabled,
        gateway_url: store.gateway_url.clone(),
        device_id: store.device_id.clone(),
        device_name: store.device_name.clone(),
        ice_servers: store.ice_servers.clone(),
        paired_device_count: store.devices.len(),
        active_device_count: store
            .devices
            .iter()
            .filter(|device| device.revoked_at.is_none())
            .count(),
    }
}

fn with_store<T>(
    state: &RemoteAgentState,
    mutate: impl FnOnce(&mut RemoteStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut store = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?;
    let value = mutate(&mut store)?;
    save_store(&state.store_path, &store)?;
    Ok(value)
}

pub fn init(app: AppHandle, state: &RemoteAgentState) -> Result<(), String> {
    // `Default` eagerly loads the store. The network runner is outbound-only:
    // it authenticates to the configured gateway and never opens a desktop
    // listening port. Missing first-time credentials are handled by Settings.
    start_transport(app, state);
    Ok(())
}

#[tauri::command]
pub fn remote_control_status(
    state: State<RemoteAgentState>,
) -> Result<RemoteControlStatus, String> {
    let store = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?;
    Ok(status_from_store(&store))
}

#[tauri::command]
pub fn remote_control_enable(
    app: AppHandle,
    state: State<RemoteAgentState>,
    input: RemoteControlEnableInput,
) -> Result<RemoteControlStatus, String> {
    let gateway_url = normalize_gateway_url(&input.gateway_url)?;
    let ice_servers = input.ice_servers.map(normalize_ice_servers).transpose()?;
    let device_name = input
        .device_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "SomniQ Desktop".to_string());
    if device_name.chars().count() > 120 {
        return Err("desktop device name is too long".to_string());
    }
    let status = with_store(&state, |store| {
        store.enabled = true;
        store.gateway_url = Some(gateway_url);
        store.device_name = Some(device_name);
        if let Some(ice_servers) = ice_servers {
            store.ice_servers = ice_servers;
        }
        if store
            .device_id
            .as_deref()
            .and_then(|device_id| DeviceId::from_str(device_id).ok())
            .is_none()
        {
            store.device_id = Some(new_desktop_device_id());
        }
        Ok(status_from_store(store))
    })?;
    start_transport(app, state.inner());
    Ok(status)
}

/// Enables the managed deployment without exposing deployment-only values in
/// Settings. The previous store is retained by the caller so a failed first
/// enrollment cannot leave a desktop that merely appears enabled.
fn enable_managed_remote(state: &RemoteAgentState) -> Result<(RemoteStore, String), String> {
    let previous = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?
        .clone();
    let gateway_url = normalize_gateway_url(MANAGED_REMOTE_GATEWAY_URL)?;
    with_store(state, |store| {
        store.enabled = true;
        store.gateway_url = Some(gateway_url.clone());
        store
            .device_name
            .get_or_insert_with(|| DEFAULT_REMOTE_DESKTOP_NAME.to_string());
        store.ice_servers = vec![MANAGED_REMOTE_STUN_SERVER.to_string()];
        if store
            .device_id
            .as_deref()
            .and_then(|device_id| DeviceId::from_str(device_id).ok())
            .is_none()
        {
            store.device_id = Some(new_desktop_device_id());
        }
        Ok(())
    })?;
    Ok((previous, gateway_url))
}

fn restore_remote_store(state: &RemoteAgentState, previous: RemoteStore) {
    let _ = with_store(state, |store| {
        *store = previous;
        Ok(())
    });
}

#[tauri::command]
pub fn remote_control_disable(
    app: AppHandle,
    state: State<RemoteAgentState>,
) -> Result<RemoteControlStatus, String> {
    let status = with_store(&state, |store| {
        store.enabled = false;
        Ok(status_from_store(store))
    })?;
    stop_transport(&app, state.inner());
    Ok(status)
}

#[tauri::command]
pub fn remote_control_devices(
    state: State<RemoteAgentState>,
) -> Result<Vec<RemoteDeviceView>, String> {
    let store = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?;
    Ok(store.devices.iter().map(RemoteDeviceView::from).collect())
}

fn configured_gateway_url(state: &RemoteAgentState) -> Result<String, String> {
    let store = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?;
    if !store.enabled {
        return Err("enable remote control before starting a pairing".to_string());
    }
    store
        .gateway_url
        .clone()
        .ok_or_else(|| "remote gateway is not configured".to_string())
}

fn invitation_expiry() -> Result<i64, String> {
    let expires_at = now_epoch_millis()
        .checked_add(PAIRING_TTL_MILLIS)
        .ok_or_else(|| "pairing expiry overflow".to_string())?;
    i64::try_from(expires_at).map_err(|_| "pairing expiry overflow".to_string())
}

/// Applies the gateway's expiry to the already-created invitation before it is
/// exposed to the phone. The desktop proposes an expiry so the gateway can
/// validate the initial request, but the gateway's clock and policy are
/// authoritative once it accepts the pairing.
fn apply_gateway_pairing_expiry(
    invitation: &mut PairingInvitation,
    response: &GatewayStartPairingResponse,
) -> Result<(), String> {
    if response.pairing_id != invitation.pairing_id.to_string() {
        return Err("remote gateway returned a mismatched pairing identifier".to_string());
    }
    if response.expires_at_unix_ms <= 0 {
        return Err("remote gateway returned an invalid pairing expiry".to_string());
    }

    invitation.expires_at_unix_ms = response.expires_at_unix_ms;
    Ok(())
}

fn pending_pairing_view(
    invitation: &PairingInvitation,
    claim: &GatewayPendingClaim,
) -> Result<RemotePendingPairing, String> {
    if claim.protocol_version != invitation.protocol_version
        || claim.pairing_id != invitation.pairing_id
    {
        return Err("remote gateway returned a claim for a different pairing".to_string());
    }
    let request = PairingRequest {
        protocol_version: claim.protocol_version,
        pairing_id: claim.pairing_id,
        pairing_secret: invitation.pairing_secret.clone(),
        mobile: claim.mobile.clone(),
        requested_scopes: claim.requested_scopes.clone(),
        requested_at_unix_ms: claim.requested_at_unix_ms,
        proof: claim.proof,
    };
    request
        .verify_against_invitation(invitation, protocol_now_millis())
        .map_err(|_| "remote gateway returned an invalid signed pairing claim".to_string())?;
    let requested_at = u64::try_from(claim.requested_at_unix_ms)
        .map_err(|_| "remote gateway returned an invalid pairing timestamp".to_string())?;
    Ok(RemotePendingPairing {
        pairing_id: invitation.pairing_id.to_string(),
        claim_id: claim.claim_id.clone(),
        device_id: claim.mobile.device_id.to_string(),
        label: claim.mobile.display_name.clone(),
        fingerprint: device_fingerprint(&claim.mobile),
        requested_scopes: claim.requested_scopes.iter().collect(),
        requested_at,
    })
}

fn reconstruct_pairing_request(
    invitation: &PairingInvitation,
    claim: &GatewayPendingClaim,
) -> Result<PairingRequest, String> {
    let _view = pending_pairing_view(invitation, claim)?;
    Ok(PairingRequest {
        protocol_version: claim.protocol_version,
        pairing_id: claim.pairing_id,
        pairing_secret: invitation.pairing_secret.clone(),
        mobile: claim.mobile.clone(),
        requested_scopes: claim.requested_scopes.clone(),
        requested_at_unix_ms: claim.requested_at_unix_ms,
        proof: claim.proof,
    })
}

/// P2 adds bounded chat turns that execute inside a selected desktop-owned
/// session. Broader direct run control remains out of scope until it has its
/// own desktop-owned resource mapping.
fn is_supported_remote_scope(scope: RemoteScope) -> bool {
    matches!(
        scope,
        RemoteScope::ReadProjectState
            | RemoteScope::ReadTaskTimeline
            | RemoteScope::SendChatMessages
            | RemoteScope::ReadReviewConclusions
    )
}

/// A pairing approval is deliberately one local confirmation. Preserve the
/// phone's requested least-privilege boundary while granting every operation
/// the currently shipped remote surface can actually honor. This prevents a
/// stale desktop checkbox UI from pairing a phone without chat capability.
fn supported_requested_scopes(requested: &DeviceScopes) -> DeviceScopes {
    requested
        .iter()
        .filter(|scope| is_supported_remote_scope(*scope))
        .collect()
}

/// Records a freshly signed pairing approval. A prior local revocation is not
/// permanent: the same phone can only regain access by completing a new QR
/// ceremony and receiving a new explicit desktop approval.
fn record_approved_device(store: &mut RemoteStore, device: RemoteDevice) -> Result<(), String> {
    if !store.enabled {
        return Err("remote control was disabled while the pairing was pending".to_string());
    }
    if let Some(index) = store
        .devices
        .iter()
        .position(|existing| existing.id == device.id)
    {
        if store.devices[index].revoked_at.is_none() {
            return Err(
                "that mobile device is already paired; revoke it before pairing again".to_string(),
            );
        }
        store.devices.remove(index);
    }
    // The gateway removes a revoked record during the freshly signed claim.
    // Retrying an earlier delete after that point would otherwise revoke this
    // new device credential, so the new explicit approval supersedes it.
    store
        .pending_gateway_revocations
        .retain(|pending| pending != &device.id);
    store.devices.push(device);
    Ok(())
}

/// Removes a local pairing record while retaining the gateway deletion in the
/// durable retry queue. The queue is cleared by a newly approved pairing for
/// the same stable phone identity, under the gateway mutation lock.
fn remove_paired_device(store: &mut RemoteStore, device_id: &str) -> Result<(), String> {
    let index = store
        .devices
        .iter()
        .position(|device| device.id == device_id)
        .ok_or_else(|| "remote device was not found".to_string())?;
    store.devices.remove(index);
    if !store
        .pending_gateway_revocations
        .iter()
        .any(|pending| pending == device_id)
    {
        store
            .pending_gateway_revocations
            .push(device_id.to_string());
    }
    Ok(())
}

/// Starts a short-lived pairing ceremony and returns a local-only QR image.
/// The initial expiry is provisional; after the gateway accepts it, its
/// server-authoritative expiry is written into the QR and local pairing state.
/// The QR secret is persisted only in the OS credential store until approval
/// or discard; the public `agent.json` receives only an expiry and UUID.
async fn start_pairing(
    app: AppHandle,
    state: &RemoteAgentState,
) -> Result<RemotePairingInvitationView, String> {
    let gateway_url = configured_gateway_url(state)?;
    let token = gateway_token(&gateway_url).ok();
    let identity = desktop_identity(state)?;
    let expires_at_unix_ms = invitation_expiry()?;
    let mut invitation =
        PairingInvitation::new(identity.descriptor, gateway_url.clone(), expires_at_unix_ms)
            .map_err(|error| format!("cannot create pairing invitation: {error}"))?;
    // Fail early instead of registering a QR that cannot be retained locally.
    with_store(state, |store| {
        remove_expired_pending_pairings(store, now_epoch_millis());
        if store.pending_pairings.len() >= MAX_PENDING_PAIRINGS {
            return Err(
                "too many pending pairings; discard or wait for an existing code to expire"
                    .to_string(),
            );
        }
        Ok(())
    })?;
    let ice_servers = with_store(state, |store| Ok(store.ice_servers.clone()))?;
    let client = reqwest::Client::new();
    let mut request =
        client
            .post(format!("{gateway_url}/v1/pairings"))
            .json(&GatewayStartPairingRequest {
                invitation: &invitation,
                ice_servers: &ice_servers,
            });
    if let Some(token) = token.as_deref() {
        request = request.bearer_auth(token);
    }
    let response: GatewayStartPairingResponse = gateway_response_json(request).await?;
    apply_gateway_pairing_expiry(&mut invitation, &response)?;
    if let Some(desktop_token) = response.desktop_token.as_deref() {
        store_gateway_token(&gateway_url, desktop_token)?;
    }
    start_transport(app, state);
    store_pairing_invitation(&invitation)?;
    let expires_at = u64::try_from(invitation.expires_at_unix_ms)
        .map_err(|_| "pairing expiry overflow".to_string())?;
    if let Err(error) = with_store(state, |store| {
        store.pending_pairings.push(PendingPairingRecord {
            pairing_id: invitation.pairing_id.to_string(),
            expires_at,
            created_at: now_epoch_millis(),
        });
        Ok(())
    }) {
        let _ = delete_pairing_invitation(invitation.pairing_id);
        return Err(error);
    }
    Ok(RemotePairingInvitationView {
        pairing_id: invitation.pairing_id.to_string(),
        expires_at,
        qr_code_data_url: pairing_qr_data_url(&invitation)?,
    })
}

#[tauri::command]
pub async fn remote_control_start_pairing(
    app: AppHandle,
    state: State<'_, RemoteAgentState>,
) -> Result<RemotePairingInvitationView, String> {
    start_pairing(app, state.inner()).await
}

/// One-click mobile connection for the managed SomniQ deployment. The first
/// QR registration returns a dedicated desktop credential that is retained
/// only in the OS keyring; a browser or desktop account login is not required.
#[tauri::command]
pub async fn remote_control_connect_phone(
    app: AppHandle,
    state: State<'_, RemoteAgentState>,
) -> Result<RemoteConnectPhoneView, String> {
    let state = state.inner();
    let (previous, gateway_url) = enable_managed_remote(state)?;
    let previous_was_enabled = previous.enabled;
    if previous_was_enabled {
        stop_transport(&app, state);
    }

    let pairing = match start_pairing(app.clone(), state).await {
        Ok(pairing) => pairing,
        Err(error) if gateway_credential_was_rejected(&error) => {
            // If durable gateway state was reset, drop the rejected local
            // credential and establish a new capability-only desktop record.
            delete_gateway_token(&gateway_url)?;
            start_pairing(app.clone(), state).await?
        }
        Err(error) => {
            // The managed profile is applied atomically for a successful QR
            // ceremony. Do not leave the desktop pointed at it when initial
            // enrollment fails before a gateway credential exists.
            if !previous_was_enabled {
                restore_remote_store(state, previous);
            }
            return Err(error);
        }
    };
    let status = {
        let store = state
            .store
            .lock()
            .map_err(|_| "remote agent state poisoned".to_string())?;
        status_from_store(&store)
    };
    Ok(RemoteConnectPhoneView { status, pairing })
}

/// Gets a verified pending mobile claim for an existing locally-held QR code.
/// `None` means no mobile device has claimed it yet.
#[tauri::command]
pub async fn remote_control_pending_pairing(
    state: State<'_, RemoteAgentState>,
    pairing_id: String,
) -> Result<Option<RemotePendingPairing>, String> {
    let pairing_id = PairingId::from_str(pairing_id.trim())
        .map_err(|_| "invalid pairing identifier".to_string())?;
    let invitation = load_pairing_invitation(pairing_id)?;
    let gateway_url = configured_gateway_url(&state)?;
    if invitation.gateway_url != gateway_url {
        return Err("the pairing invitation belongs to a different gateway".to_string());
    }
    let token = gateway_token(&gateway_url)?;
    let Some(claim) = gateway_pending_claim(&gateway_url, &token, &pairing_id.to_string()).await?
    else {
        return Ok(None);
    };
    pending_pairing_view(&invitation, &claim).map(Some)
}

/// Applies an explicit local approval to a verified pending phone claim. The
/// request is reconstructed with the QR secret stored in the platform
/// credential store, then signed by the desktop identity before it reaches the
/// gateway.
#[tauri::command]
pub async fn remote_control_approve_pairing(
    state: State<'_, RemoteAgentState>,
    input: RemotePairingApprovalInput,
) -> Result<RemoteDeviceView, String> {
    let pairing_id = PairingId::from_str(input.pairing_id.trim())
        .map_err(|_| "invalid pairing identifier".to_string())?;
    let invitation = load_pairing_invitation(pairing_id)?;
    let gateway_url = configured_gateway_url(&state)?;
    if invitation.gateway_url != gateway_url {
        return Err("the pairing invitation belongs to a different gateway".to_string());
    }
    let token = gateway_token(&gateway_url)?;
    let Some(claim) = gateway_pending_claim(&gateway_url, &token, &pairing_id.to_string()).await?
    else {
        return Err("there is no pending pairing claim to approve".to_string());
    };
    let pairing_request = reconstruct_pairing_request(&invitation, &claim)?;
    // This input is intentionally ignored. The approval action is a single
    // desktop confirmation, and all compatible requested capabilities travel
    // together so an outdated UI cannot accidentally leave chat disabled.
    let _legacy_granted_scopes = input.legacy_granted_scopes;
    let granted_scopes = supported_requested_scopes(&pairing_request.requested_scopes);
    if granted_scopes.is_empty() {
        return Err("this phone did not request a supported remote permission".to_string());
    }
    // Serialize this gateway-side credential creation with a deferred delete
    // from an earlier revoke of the same stable phone ID.
    let _gateway_mutation = state.gateway_mutation_lock.lock().await;
    let identity = desktop_identity(&state)?;
    let approval = PairingApproval::approve(
        &invitation,
        &pairing_request,
        SessionId::new(),
        granted_scopes.clone(),
        protocol_now_millis(),
        &identity.signing_key,
    )
    .map_err(|error| format!("cannot sign pairing approval: {error}"))?;
    let client = reqwest::Client::new();
    let response: GatewayApprovePairingResponse = gateway_response_json(
        client
            .post(format!("{gateway_url}/v1/pairings/{pairing_id}/approve"))
            .bearer_auth(&token)
            .json(&GatewayApprovePairingRequest {
                claim_id: &claim.claim_id,
                approval: &approval,
            }),
    )
    .await?;
    if response.device.id != pairing_request.mobile.device_id.to_string() {
        return Err("remote gateway approved a different mobile device".to_string());
    }
    let device = RemoteDevice {
        id: pairing_request.mobile.device_id.to_string(),
        label: pairing_request.mobile.display_name.clone(),
        fingerprint: device_fingerprint(&pairing_request.mobile),
        scopes: granted_scopes.iter().collect(),
        paired_at: now_epoch_millis(),
        last_seen_at: None,
        revoked_at: None,
        descriptor: Some(pairing_request.mobile),
        session_id: Some(approval.session_id.to_string()),
    };
    let view = RemoteDeviceView::from(&device);
    with_store(&state, |store| {
        record_approved_device(store, device)?;
        store
            .pending_pairings
            .retain(|pending| pending.pairing_id != pairing_id.to_string());
        Ok(())
    })?;
    if let Err(error) = delete_pairing_invitation(pairing_id) {
        eprintln!("SomniQ remote pairing secret cleanup failed: {error}");
    }
    let audit = RemoteAuditEntry {
        timestamp: now_epoch_millis(),
        device_id: view.id.clone(),
        request_id: claim.claim_id,
        action: "pairing_approved".to_string(),
        transport: "local".to_string(),
        project_id: None,
        outcome: "allowed".to_string(),
        error_code: None,
    };
    if let Err(error) = append_audit(&state, &audit) {
        eprintln!("SomniQ remote audit write failed: {error}");
    }
    Ok(view)
}

/// Cancels the local side of a pending pairing. The gateway's registration is
/// intentionally allowed to expire rather than accepting a public cancel call.
#[tauri::command]
pub fn remote_control_discard_pairing(
    state: State<RemoteAgentState>,
    pairing_id: String,
) -> Result<(), String> {
    let pairing_id = PairingId::from_str(pairing_id.trim())
        .map_err(|_| "invalid pairing identifier".to_string())?;
    with_store(&state, |store| {
        store
            .pending_pairings
            .retain(|pending| pending.pairing_id != pairing_id.to_string());
        Ok(())
    })?;
    delete_pairing_invitation(pairing_id)
}

#[tauri::command]
pub async fn remote_control_revoke_device(
    app: AppHandle,
    state: State<'_, RemoteAgentState>,
    device_id: String,
) -> Result<(), String> {
    let device_id = device_id.trim().to_string();
    if DeviceId::from_str(&device_id).is_err() {
        return Err("invalid remote device identity".to_string());
    }
    with_store(&state, |store| remove_paired_device(store, &device_id))?;
    // Attempt propagation before restarting the signal runner. The helper
    // serializes this delete with a fresh approval for the same phone.
    retry_pending_gateway_revocations(&app).await;
    // Close all existing relay sessions, then reconnect a fresh signal channel
    // for any other still-authorized paired devices.
    stop_transport(&app, state.inner());
    start_transport(app, state.inner());
    Ok(())
}

/// Forwards the desktop browser WebRTC answer only after verifying the
/// renderer is referring to a P2P session reserved from a signed mobile
/// offer. No gateway token is ever exposed to the renderer.
#[tauri::command]
pub fn remote_control_p2p_pending(
    state: State<RemoteAgentState>,
) -> Result<RemoteP2pPendingSnapshot, String> {
    pending_p2p_snapshot(&state)
}

/// Forwards the desktop browser WebRTC answer only after verifying the
/// renderer is referring to a P2P session reserved from a signed mobile
/// offer. No gateway token is ever exposed to the renderer.
#[tauri::command]
pub fn remote_control_p2p_answer(
    state: State<RemoteAgentState>,
    input: RemoteP2pAnswerInput,
) -> Result<(), String> {
    let _session = p2p_session(&state, &input.device_id, &input.session_id)?;
    let result = queue_gateway_signal(
        &state,
        &input.device_id,
        &input.session_id,
        TransportSignal::WebrtcAnswer {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            sdp: input.sdp,
        },
    );
    if result.is_ok() {
        discard_pending_p2p_negotiation(&state, &input.session_id);
    }
    result
}

/// Forwards one bounded desktop ICE candidate on an existing P2P attempt.
#[tauri::command]
pub fn remote_control_p2p_ice_candidate(
    state: State<RemoteAgentState>,
    input: RemoteP2pIceCandidateInput,
) -> Result<(), String> {
    let _session = p2p_session(&state, &input.device_id, &input.session_id)?;
    queue_gateway_signal(
        &state,
        &input.device_id,
        &input.session_id,
        TransportSignal::WebrtcIceCandidate {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            candidate: input.candidate,
            sdp_mid: input.sdp_mid,
            sdp_m_line_index: input.sdp_m_line_index,
            username_fragment: input.username_fragment,
        },
    )
}

/// Tells the mobile peer that the desktop WebRTC implementation has gathered
/// all currently available candidates. It does not claim that a data channel
/// has opened.
#[tauri::command]
pub fn remote_control_p2p_ice_complete(
    state: State<RemoteAgentState>,
    input: RemoteP2pSessionInput,
) -> Result<(), String> {
    let _session = p2p_session(&state, &input.device_id, &input.session_id)?;
    queue_gateway_signal(
        &state,
        &input.device_id,
        &input.session_id,
        TransportSignal::WebrtcIceComplete {
            protocol_version: CURRENT_PROTOCOL_VERSION,
        },
    )
}

/// Marks a successfully opened data channel so the negotiation-timeout task
/// cannot remove a live session. The encrypted-frame command also performs
/// this mark as a defensive backstop.
#[tauri::command]
pub fn remote_control_p2p_opened(
    state: State<RemoteAgentState>,
    input: RemoteP2pSessionInput,
) -> Result<(), String> {
    let session = p2p_session(&state, &input.device_id, &input.session_id)?;
    session.established.store(true, Ordering::SeqCst);
    discard_pending_p2p_negotiation(&state, &input.session_id);
    Ok(())
}

/// Terminates the desktop half of a P2P attempt. The caller should then use a
/// freshly generated session ID for the legacy relay offer; this function
/// deliberately does not start a relay under the failed ID.
#[tauri::command]
pub fn remote_control_p2p_failed(
    state: State<RemoteAgentState>,
    input: RemoteP2pFailureInput,
) -> Result<(), String> {
    let _session = p2p_session(&state, &input.device_id, &input.session_id)?;
    let result = queue_gateway_signal(
        &state,
        &input.device_id,
        &input.session_id,
        TransportSignal::P2pFailed {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            reason: input.reason,
        },
    );
    remove_p2p_session(&state, &input.device_id, &input.session_id);
    result
}

/// Opens one end-to-end encrypted phone frame and returns the equally
/// encrypted response. The input is bounded standard base64 so a renderer
/// cannot use this command as an arbitrary large-memory bridge.
#[tauri::command]
pub async fn remote_control_p2p_frame(
    app: AppHandle,
    state: State<'_, RemoteAgentState>,
    input: RemoteP2pDataInput,
) -> Result<String, String> {
    if input.data_base64.len() > MAX_P2P_BASE64_FRAME_BYTES {
        return Err("encrypted P2P frame exceeds the maximum size".to_string());
    }
    let session = p2p_session(&state, &input.device_id, &input.session_id)?;
    let payload = STANDARD
        .decode(input.data_base64.as_bytes())
        .map_err(|_| "encrypted P2P frame is not valid base64".to_string())?;
    if payload.len() > MAX_RELAY_FRAME_BYTES {
        return Err("encrypted P2P frame exceeds the maximum size".to_string());
    }
    let envelope = serde_json::from_slice::<SecureEnvelope>(&payload)
        .map_err(|_| "encrypted P2P frame is invalid".to_string())?;
    session.established.store(true, Ordering::SeqCst);
    discard_pending_p2p_negotiation(&state, &input.session_id);
    let response = session
        .wire
        .handle_envelope(app, state.inner(), &envelope)
        .await?;
    let response = serde_json::to_vec(&response)
        .map_err(|_| "cannot encode encrypted P2P response".to_string())?;
    if response.len() > MAX_RELAY_FRAME_BYTES {
        return Err("encrypted P2P response exceeds the maximum size".to_string());
    }
    Ok(STANDARD.encode(response))
}

/// Removes local P2P session state when a browser WebRTC data channel closes.
/// A normal close needs no new gateway signal; the mobile transport owner is
/// responsible for issuing an explicit fresh-ID relay offer when it needs a
/// fallback.
#[tauri::command]
pub fn remote_control_p2p_closed(
    state: State<RemoteAgentState>,
    input: RemoteP2pSessionInput,
) -> Result<(), String> {
    let _session = p2p_session(&state, &input.device_id, &input.session_id)?;
    remove_p2p_session(&state, &input.device_id, &input.session_id);
    Ok(())
}

#[tauri::command]
pub fn remote_control_audit(
    state: State<RemoteAgentState>,
    limit: Option<usize>,
) -> Result<Vec<RemoteAuditEntry>, String> {
    read_audit(&state.audit_path, limit.unwrap_or(100).min(MAX_AUDIT_READ))
}

fn read_audit(path: &Path, limit: usize) -> Result<Vec<RemoteAuditEntry>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut entries = raw
        .lines()
        .filter_map(|line| serde_json::from_str::<RemoteAuditEntry>(line).ok())
        .collect::<Vec<_>>();
    let skip = entries.len().saturating_sub(limit);
    Ok(entries.drain(skip..).collect())
}

fn append_audit(state: &RemoteAgentState, entry: &RemoteAuditEntry) -> Result<(), String> {
    let _guard = state
        .audit_lock
        .lock()
        .map_err(|_| "remote audit state poisoned".to_string())?;
    if let Some(parent) = state.audit_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.audit_path)
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut file, entry).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())
}

fn authenticated_device_scopes(
    state: &RemoteAgentState,
    device_id: &str,
) -> Result<DeviceScopes, String> {
    if DeviceId::from_str(device_id).is_err() {
        return Err("invalid remote device identity".to_string());
    }
    let mut store = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?;
    if !store.enabled {
        return Err("remote control is disabled".to_string());
    }
    let device = store
        .devices
        .iter_mut()
        .find(|device| device.id == device_id)
        .ok_or_else(|| "remote device is not paired".to_string())?;
    if device.revoked_at.is_some() {
        return Err("remote device has been revoked".to_string());
    }
    device.last_seen_at = Some(now_epoch_millis());
    let scopes = device.scopes.iter().copied().collect::<DeviceScopes>();
    save_store(&state.store_path, &store)?;
    Ok(scopes)
}

fn active_project_id(app: &AppHandle) -> Result<String, String> {
    let projects = app.state::<crate::projects::ProjectState>();
    crate::projects::active_project_id(projects.inner())
}

fn protocol_now_millis() -> i64 {
    i64::try_from(now_epoch_millis()).unwrap_or(i64::MAX)
}

fn control_error_code(error: &ControlError) -> &'static str {
    match error {
        ControlError::Unauthorized { .. } => "unauthorized",
        ControlError::InvalidRequest { .. } => "invalid_request",
        ControlError::NotFound => "not_found",
        ControlError::Conflict => "conflict",
        ControlError::TemporarilyUnavailable { .. } => "temporarily_unavailable",
        ControlError::Internal => "internal",
    }
}

fn project_summary(project: &crate::projects::DesktopProject, is_active: bool) -> ProjectSummary {
    let path = PathBuf::from(&project.path);
    let phase = runtime::project_brief(&path)
        .ok()
        .and_then(|brief| brief.goal)
        .map_or_else(
            || "active".to_string(),
            |goal| goal.status.as_str().to_string(),
        );
    ProjectSummary {
        project_id: project.id.clone(),
        title: project.name.trim().to_string(),
        phase,
        updated_at_unix_ms: protocol_now_millis(),
        active_run_id: None,
        is_active,
    }
}

fn workspace_project_summaries(app: &AppHandle) -> Result<Vec<ProjectSummary>, String> {
    let projects = app.state::<crate::projects::ProjectState>();
    let (registered, current_id) = crate::projects::registered_projects(projects.inner())?;
    Ok(registered
        .iter()
        .map(|project| project_summary(project, project.id == current_id))
        .collect())
}

fn current_project_summary(app: &AppHandle) -> Result<ProjectSummary, String> {
    workspace_project_summaries(app)?
        .into_iter()
        .find(|project| project.is_active)
        .ok_or_else(|| "current desktop project is missing".to_string())
}

fn remote_chat_model_selection_result(
    project_id: String,
    session_id: String,
    selection: crate::engine::RemoteChatModelSelection,
    updated: bool,
) -> ControlResult {
    let options = selection
        .options
        .into_iter()
        .map(|option| ChatModelOption {
            value: option.value,
            label: option.label,
            description: option.description,
        })
        .collect();
    if updated {
        ControlResult::ChatSessionModelUpdated {
            project_id,
            session_id,
            model: selection.model,
            options,
        }
    } else {
        ControlResult::ChatModelOptions {
            project_id,
            session_id,
            model: selection.model,
            options,
        }
    }
}

fn control_response_from_result(
    request: &ControlRequest,
    result: Result<ControlResult, ControlError>,
) -> ControlResponse {
    match result {
        Ok(result) => ControlResponse::success(request.request_id, protocol_now_millis(), result),
        Err(error) => ControlResponse::error(request.request_id, protocol_now_millis(), error),
    }
}

fn remote_chat_request_digest(session_id: &str, message: &str) -> String {
    // Bind a retry key to its chosen desktop conversation as well as its
    // message body. Reusing an idempotency key for a different conversation
    // must be a conflict, never an accidental reply replay into that chat.
    let mut digest = Sha256::new();
    digest.update(session_id.as_bytes());
    digest.update([0]);
    digest.update(message.as_bytes());
    URL_SAFE_NO_PAD.encode(digest.finalize())
}

fn truncate_remote_chat_response(text: String) -> String {
    if text.len() <= MAX_REMOTE_CHAT_RESPONSE_BYTES {
        return text;
    }
    let mut end = MAX_REMOTE_CHAT_RESPONSE_BYTES;
    loop {
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        let omitted = text.len().saturating_sub(end);
        let suffix = format!(
            "\n\n[SomniQ truncated {omitted} bytes from this remote reply. Open this conversation on the desktop for the full transcript.]"
        );
        if end.saturating_add(suffix.len()) <= MAX_REMOTE_CHAT_RESPONSE_BYTES {
            return format!("{}{}", &text[..end], suffix);
        }
        let overflow = end
            .saturating_add(suffix.len())
            .saturating_sub(MAX_REMOTE_CHAT_RESPONSE_BYTES);
        end = end.saturating_sub(overflow.max(1));
    }
}

fn reserve_remote_chat_idempotency(
    state: &RemoteAgentState,
    device_id: &str,
    project_id: &str,
    idempotency_key: &str,
    request_digest: &str,
) -> Result<RemoteChatReservation, ControlError> {
    let now = now_epoch_millis();
    let mut entries = state
        .chat_idempotency
        .lock()
        .map_err(|_| ControlError::Internal)?;
    entries
        .retain(|entry| now.saturating_sub(entry.created_at) <= REMOTE_CHAT_IDEMPOTENCY_TTL_MILLIS);
    if let Some(entry) = entries.iter().find(|entry| {
        entry.device_id == device_id
            && entry.project_id == project_id
            && entry.idempotency_key == idempotency_key
    }) {
        if entry.request_digest != request_digest {
            return Err(ControlError::Conflict);
        }
        return match &entry.completed_text {
            Some(text) => Ok(RemoteChatReservation::Completed {
                message_id: entry.message_id.clone(),
                text: text.clone(),
            }),
            None => Err(ControlError::TemporarilyUnavailable {
                retry_after_ms: Some(500),
            }),
        };
    }
    while entries.len() >= MAX_REMOTE_CHAT_IDEMPOTENCY_ENTRIES {
        let Some((oldest, _)) = entries
            .iter()
            .enumerate()
            .min_by_key(|(_, entry)| entry.created_at)
        else {
            break;
        };
        entries.remove(oldest);
    }
    let message_id = RequestId::new().to_string();
    entries.push(RemoteChatIdempotencyEntry {
        device_id: device_id.to_string(),
        project_id: project_id.to_string(),
        idempotency_key: idempotency_key.to_string(),
        request_digest: request_digest.to_string(),
        message_id: message_id.clone(),
        created_at: now,
        completed_text: None,
    });
    Ok(RemoteChatReservation::New { message_id })
}

fn complete_remote_chat_idempotency(
    state: &RemoteAgentState,
    device_id: &str,
    project_id: &str,
    idempotency_key: &str,
    request_digest: &str,
    text: String,
) -> Result<(), ControlError> {
    let mut entries = state
        .chat_idempotency
        .lock()
        .map_err(|_| ControlError::Internal)?;
    let entry = entries
        .iter_mut()
        .find(|entry| {
            entry.device_id == device_id
                && entry.project_id == project_id
                && entry.idempotency_key == idempotency_key
                && entry.request_digest == request_digest
        })
        .ok_or(ControlError::Internal)?;
    entry.completed_text = Some(text);
    Ok(())
}

fn release_remote_chat_idempotency(
    state: &RemoteAgentState,
    device_id: &str,
    project_id: &str,
    idempotency_key: &str,
    request_digest: &str,
) {
    if let Ok(mut entries) = state.chat_idempotency.lock() {
        entries.retain(|entry| {
            !(entry.device_id == device_id
                && entry.project_id == project_id
                && entry.idempotency_key == idempotency_key
                && entry.request_digest == request_digest
                && entry.completed_text.is_none())
        });
    }
}

fn ensure_remote_chat_project(app: &AppHandle, project_id: &str) -> Result<(), ControlError> {
    let active_project =
        active_project_id(app).map_err(|_| ControlError::TemporarilyUnavailable {
            retry_after_ms: Some(1_000),
        })?;
    if active_project == project_id {
        Ok(())
    } else {
        Err(ControlError::Conflict)
    }
}

fn remote_chat_sessions_result(
    app: &AppHandle,
    project_id: String,
    limit: u16,
) -> Result<ControlResult, ControlError> {
    ensure_remote_chat_project(app, &project_id)?;
    let list = crate::engine::remote_chat_sessions_list(&project_id, limit).map_err(|_| {
        ControlError::TemporarilyUnavailable {
            retry_after_ms: Some(1_000),
        }
    })?;
    Ok(ControlResult::ChatSessions {
        project_id,
        sessions: list
            .sessions
            .into_iter()
            .map(|session| ChatSessionSummary {
                session_id: session.id,
                title: session.title,
                updated_at_unix_ms: session.updated_at_unix_ms,
                model: session.model,
            })
            .collect(),
        has_more: list.has_more,
    })
}

fn remote_chat_transcript_result(
    app: &AppHandle,
    project_id: String,
    session_id: String,
    limit: u16,
) -> Result<ControlResult, ControlError> {
    ensure_remote_chat_project(app, &project_id)?;
    let transcript = crate::engine::remote_chat_session_transcript(&project_id, &session_id, limit)
        .map_err(|_| ControlError::NotFound)?;
    let mut messages = Vec::with_capacity(transcript.messages.len());
    for message in transcript.messages {
        let role = match message.role.as_str() {
            "user" => ChatTranscriptRole::User,
            "assistant" => ChatTranscriptRole::Assistant,
            _ => return Err(ControlError::Internal),
        };
        messages.push(ChatTranscriptMessage {
            role,
            text: message.text,
        });
    }
    Ok(ControlResult::ChatTranscript {
        project_id,
        session_id: transcript.id,
        title: transcript.title,
        updated_at_unix_ms: transcript.updated_at_unix_ms,
        messages,
        has_more: transcript.has_more,
    })
}

async fn execute_remote_chat_message(
    app: &AppHandle,
    state: &RemoteAgentState,
    device_id: &str,
    request_id: String,
    transport: String,
    project_id: String,
    session_id: String,
    message: String,
    idempotency_key: String,
) -> Result<ControlResult, ControlError> {
    ensure_remote_chat_project(app, &project_id)?;
    crate::engine::remote_chat_session_validate(&project_id, &session_id)
        .map_err(|_| ControlError::NotFound)?;
    let request_digest = remote_chat_request_digest(&session_id, &message);
    let message_id = match reserve_remote_chat_idempotency(
        state,
        device_id,
        &project_id,
        &idempotency_key,
        &request_digest,
    )? {
        RemoteChatReservation::Completed { message_id, text } => {
            return Ok(ControlResult::ChatMessageCompleted {
                project_id,
                session_id,
                message_id,
                text,
            });
        }
        RemoteChatReservation::New { message_id } => message_id,
    };

    // Long tool-enabled turns may outlive the synchronous mobile response
    // timeout. Record their receipt before entering the chat runtime so the
    // local audit can distinguish an in-flight request from one that never
    // reached the desktop.
    let started_audit = RemoteAuditEntry {
        timestamp: now_epoch_millis(),
        device_id: device_id.to_string(),
        request_id,
        action: "send_chat_message".to_string(),
        transport,
        project_id: Some(project_id.clone()),
        outcome: "started".to_string(),
        error_code: None,
    };
    if let Err(error) = append_audit(state, &started_audit) {
        eprintln!("SomniQ remote audit write failed: {error}");
    }

    let chat_state = app.state::<crate::engine::ChatState>();
    let response = crate::engine::remote_chat_send_paired(
        app.clone(),
        chat_state.inner(),
        session_id.clone(),
        project_id.clone(),
        message.clone(),
    )
    .await;
    match response {
        Ok(full_text) => {
            // The mobile response is independently bounded for the encrypted
            // relay frame. Persist that same visible projection in the Chat
            // UI store so a later phone refresh and the desktop sidebar agree
            // on what was delivered. Tool execution remains in the runtime
            // session and its durable event log; the remote transcript is
            // deliberately text-only.
            let text = truncate_remote_chat_response(full_text);
            match crate::sessions::remote_chat_append_text_turn(
                &project_id,
                &session_id,
                &message_id,
                &message,
                &text,
            ) {
                Ok(()) => {
                    if let Err(error) = app.emit(
                        "remote-chat-session-updated",
                        serde_json::json!({ "sessionId": &session_id }),
                    ) {
                        eprintln!(
                            "SomniQ remote: could not notify the desktop chat UI after a remote turn: {error}"
                        );
                    }
                }
                // Never turn an already-completed model request into an error:
                // doing so would invite a user retry with a new idempotency
                // key and duplicate the turn in the model's durable context.
                Err(error) => eprintln!(
                    "SomniQ remote: could not persist the completed remote chat UI projection: {error}"
                ),
            }
            complete_remote_chat_idempotency(
                state,
                device_id,
                &project_id,
                &idempotency_key,
                &request_digest,
                text.clone(),
            )?;
            Ok(ControlResult::ChatMessageCompleted {
                project_id,
                session_id,
                message_id,
                text,
            })
        }
        Err(_) => {
            release_remote_chat_idempotency(
                state,
                device_id,
                &project_id,
                &idempotency_key,
                &request_digest,
            );
            Err(ControlError::TemporarilyUnavailable {
                retry_after_ms: Some(1_000),
            })
        }
    }
}

/// Adapter from the shared, encrypted control protocol to the desktop's
/// constrained execution surface. Its caller is responsible for opening the
/// [`remote_protocol::SecureEnvelope`] and accepting its sequence in a
/// [`remote_protocol::ReplayWindow`] before invoking this function.
///
/// Remote chat returns a bounded final response for a desktop-owned selected
/// conversation. It runs with that session's local tool and permission policy;
/// its text-only projection is persisted atomically and announced to the
/// desktop UI with a dedicated session-refresh event.
pub(crate) async fn execute_control_request(
    app: AppHandle,
    state: &RemoteAgentState,
    context: RemoteRequestContext,
    request: ControlRequest,
) -> ControlResponse {
    let action = match &request.command {
        ControlCommand::GetWorkspaceOverview => "workspace_overview",
        ControlCommand::SetActiveProject { .. } => "set_active_project",
        ControlCommand::GetProjectSummary { .. } => "project_summary",
        ControlCommand::GetTaskTimeline { .. } => "task_timeline",
        ControlCommand::ListChatSessions { .. } => "list_chat_sessions",
        ControlCommand::GetChatTranscript { .. } => "get_chat_transcript",
        ControlCommand::GetChatModelOptions { .. } => "get_chat_model_options",
        ControlCommand::SetChatSessionModel { .. } => "set_chat_session_model",
        ControlCommand::SendChatMessage { .. } => "send_chat_message",
        ControlCommand::StopRun { .. } => "stop_run",
        ControlCommand::GetReviewConclusion { .. } => "review_conclusion",
    };
    let project_id = active_project_id(&app).ok();
    let result = match authenticated_device_scopes(state, &context.device_id) {
        Err(_) => Err(ControlError::Unauthorized {
            required_scope: request.command.required_scope(),
        }),
        Ok(_scopes) if !request.protocol_version.is_supported() => {
            Err(ControlError::InvalidRequest {
                reason: "unsupported remote protocol version".to_string(),
            })
        }
        Ok(scopes) if !scopes.contains(request.command.required_scope()) => {
            Err(ControlError::Unauthorized {
                required_scope: request.command.required_scope(),
            })
        }
        Ok(_) if request.command.validate().is_err() => Err(ControlError::InvalidRequest {
            reason: "invalid constrained remote command".to_string(),
        }),
        Ok(_) => match request.command.clone() {
            ControlCommand::GetWorkspaceOverview => workspace_project_summaries(&app)
                .map(|projects| ControlResult::WorkspaceOverview {
                    projects,
                    capabilities: REMOTE_WORKSPACE_CAPABILITIES.to_vec(),
                })
                .map_err(|_| ControlError::TemporarilyUnavailable {
                    retry_after_ms: Some(1_000),
                }),
            ControlCommand::SetActiveProject {
                project_id: requested,
            } => {
                let chat_state = app.state::<crate::engine::ChatState>();
                match crate::engine::remote_chat_has_running_turns(chat_state.inner()) {
                    Err(_) => Err(ControlError::Internal),
                    Ok(true) => Err(ControlError::Conflict),
                    Ok(false) => {
                        let projects = app.state::<crate::projects::ProjectState>();
                        match crate::projects::switch_registered_project(
                            projects.inner(),
                            &requested,
                        ) {
                            Err(error) if error == "project not found" => {
                                Err(ControlError::NotFound)
                            }
                            Err(_) => Err(ControlError::Conflict),
                            Ok(_) => match app.emit("project-changed", ()) {
                                Err(_) => Err(ControlError::Internal),
                                Ok(()) => workspace_project_summaries(&app)
                                    .map(|projects| ControlResult::WorkspaceOverview {
                                        projects,
                                        capabilities: REMOTE_WORKSPACE_CAPABILITIES.to_vec(),
                                    })
                                    .map_err(|_| ControlError::TemporarilyUnavailable {
                                        retry_after_ms: Some(1_000),
                                    }),
                            },
                        }
                    }
                }
            }
            ControlCommand::GetProjectSummary {
                project_id: requested,
            } => match current_project_summary(&app) {
                Ok(project) if project.project_id == requested => {
                    Ok(ControlResult::ProjectSummary { project })
                }
                Ok(_) => Err(ControlError::Conflict),
                Err(_) => Err(ControlError::TemporarilyUnavailable {
                    retry_after_ms: Some(1_000),
                }),
            },
            ControlCommand::GetTaskTimeline {
                project_id: requested,
                after_event_id: _,
                limit: _,
            } => match current_project_summary(&app) {
                Ok(project) if project.project_id == requested => Ok(ControlResult::TaskTimeline {
                    project_id: requested,
                    // P1 has no cross-session event feed yet. Returning an
                    // empty, bounded feed is preferable to leaking raw chat
                    // logs or synthesizing a Reviewer conclusion.
                    events: Vec::new(),
                    next_event_id: None,
                }),
                Ok(_) => Err(ControlError::Conflict),
                Err(_) => Err(ControlError::TemporarilyUnavailable {
                    retry_after_ms: Some(1_000),
                }),
            },
            ControlCommand::ListChatSessions { project_id, limit } => {
                remote_chat_sessions_result(&app, project_id, limit)
            }
            ControlCommand::GetChatTranscript {
                project_id,
                session_id,
                limit,
            } => remote_chat_transcript_result(&app, project_id, session_id, limit),
            ControlCommand::GetChatModelOptions {
                project_id,
                session_id,
            } => match ensure_remote_chat_project(&app, &project_id) {
                Err(error) => Err(error),
                Ok(()) => crate::engine::remote_chat_model_options(&project_id, &session_id)
                    .map(|selection| {
                        remote_chat_model_selection_result(project_id, session_id, selection, false)
                    })
                    .map_err(|_| ControlError::NotFound),
            },
            ControlCommand::SetChatSessionModel {
                project_id,
                session_id,
                model,
            } => match ensure_remote_chat_project(&app, &project_id) {
                Err(error) => Err(error),
                Ok(()) => {
                    crate::engine::remote_chat_set_session_model(&project_id, &session_id, &model)
                        .map(|selection| {
                            remote_chat_model_selection_result(
                                project_id, session_id, selection, true,
                            )
                        })
                        .map_err(|_| ControlError::InvalidRequest {
                            reason: "the selected model is unavailable for this desktop chat"
                                .to_string(),
                        })
                }
            },
            ControlCommand::SendChatMessage {
                project_id,
                session_id,
                message,
                idempotency_key,
            } => {
                execute_remote_chat_message(
                    &app,
                    state,
                    &context.device_id,
                    request.request_id.to_string(),
                    context.transport.clone(),
                    project_id,
                    session_id,
                    message,
                    idempotency_key,
                )
                .await
            }
            // Run identifiers are intentionally not mapped to arbitrary local
            // process IDs in P1. Workflow-run control is added only after it
            // has an opaque, device-owned run mapping like chat sessions.
            ControlCommand::StopRun { .. } => Err(ControlError::NotFound),
            // Preserve the Executor/Reviewer separation: do not fabricate a
            // reviewer result from a chat transcript or executor status.
            ControlCommand::GetReviewConclusion { .. } => {
                Err(ControlError::TemporarilyUnavailable {
                    retry_after_ms: Some(1_000),
                })
            }
        },
    };
    let succeeded = result.is_ok();
    let error_code = result
        .as_ref()
        .err()
        .map(control_error_code)
        .map(str::to_string);
    let response = control_response_from_result(&request, result);
    let audit = RemoteAuditEntry {
        timestamp: now_epoch_millis(),
        device_id: context.device_id,
        request_id: request.request_id.to_string(),
        action: action.to_string(),
        transport: context.transport,
        project_id,
        outcome: if succeeded { "allowed" } else { "rejected" }.to_string(),
        error_code,
    };
    if let Err(error) = append_audit(state, &audit) {
        eprintln!("SomniQ remote audit write failed: {error}");
    }
    response
}

#[cfg(test)]
#[path = "tests/remote.rs"]
mod tests;
