//! Constrained desktop-side remote-control boundary.
//!
//! The built-in outbound WSS relay runner and the browser P2P adapter both use
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
    ChatMessageActivity, ChatMessageEvent, ChatModelOption, ChatSessionEvent, ChatSessionSummary,
    ChatToolProgress, ChatTranscriptMessage, ChatTranscriptRole, ComputeWireMessage,
    ControlCommand, ControlError, ControlRequest, ControlResponse, ControlResult, DeviceDescriptor,
    DeviceId, DeviceKind, DeviceScope, DeviceScopes, DeviceSignature, DeviceSigningKey,
    ImageAssistClientFrame, ImageAssistServerFrame, ImageAssistTranscript, ImageAssistWireMessage,
    KeyAgreementSecret, MatchId, P2pFailureReason, PairingApproval, PairingId, PairingInvitation,
    PairingRequest, PreviewKeyContext, ProjectSummary, ProtocolVersion, RemoteCapability,
    ReplayWindow, RequestId, SecureEnvelope, SessionId, SessionKey, SessionKeyContext,
    SessionRoute, TransportKind, TransportSignal, CURRENT_PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{tcp::OwnedReadHalf, tcp::OwnedWriteHalf, TcpStream},
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
const COMPUTE_DIRECT_CONNECT_TIMEOUT: Duration = Duration::from_millis(900);
const MAX_PENDING_GATEWAY_SIGNALS: usize = 32;
const MAX_P2P_BASE64_FRAME_BYTES: usize = MAX_RELAY_FRAME_BYTES * 2;
/// Keep a completed answer comfortably below the encrypted relay frame cap.
/// JSON escaping plus the SecureEnvelope overhead can grow the wire payload.
/// This is deliberately much larger than a UI preview: ordinary long-form
/// answers must not disappear merely because they originated on a phone.
const MAX_REMOTE_CHAT_RESPONSE_BYTES: usize = 128 * 1024;
/// Each live encrypted control response remains small enough for both the
/// relay and a WebRTC data channel. A turn can contain many ordered fragments.
const MAX_REMOTE_CHAT_DELTA_BYTES: usize = 24 * 1024;
/// Protect the paired-control channel from an unexpectedly unbounded provider
/// stream while allowing substantially more content than the terminal replay
/// frame. The desktop still retains the complete local Chat session.
const MAX_REMOTE_CHAT_STREAM_BYTES: usize = 1024 * 1024;
/// Thinking and visible tool cards have their own budget so a verbose tool
/// cannot consume the final-answer text stream budget.
const MAX_REMOTE_CHAT_RICH_STREAM_BYTES: usize = 1024 * 1024;
/// One durable desktop event must always fit in a bounded sync batch. This
/// prevents a single unusually large provider delta from pinning the cursor.
const MAX_REMOTE_CHAT_EVENT_CONTENT_BYTES: usize = 64 * 1024;
/// Tool cards are rendered in the mobile browser on every progress batch.
/// Keep their previews substantially smaller than prose so a research turn
/// with many large fetch results cannot stall the paired client.
const MAX_REMOTE_CHAT_TOOL_INPUT_BYTES: usize = 16 * 1024;
const MAX_REMOTE_CHAT_TOOL_OUTPUT_BYTES: usize = 12 * 1024;
/// Secure envelopes encode ciphertext as JSON/base64. Keep plaintext event
/// batches well below the 256 KiB relay and WebRTC frame ceiling.
const MAX_REMOTE_CHAT_EVENT_BATCH_BYTES: usize = 160 * 1024;
const MAX_REMOTE_CHAT_EVENT_ERROR_BYTES: usize = 8 * 1024;
const REMOTE_CHAT_TOOL_OUTPUT_TRUNCATION_NOTICE: &str =
    "\n\n[Remote preview truncated; full tool output remains available on Desktop.]";
const MAX_REMOTE_CHAT_IDEMPOTENCY_ENTRIES: usize = 128;
const REMOTE_CHAT_IDEMPOTENCY_TTL_MILLIS: u64 = 10 * 60 * 1_000;
const PAIRING_TTL_MILLIS: u64 = 5 * 60 * 1_000;
const REMOTE_GATEWAY_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const REMOTE_GATEWAY_RECONNECT_DELAY: Duration = Duration::from_secs(3);
const REMOTE_SIGNAL_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const REMOTE_SIGNAL_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
const REMOTE_CONTROL_DISABLED_ERROR: &str = "enable remote control before starting a pairing";
/// A half-open TCP write can otherwise block the signal lease watchdog behind
/// the WebSocket sink's flush. This is deliberately shorter than the lease.
const REMOTE_SIGNAL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const REMOTE_RELAY_PEER_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REMOTE_P2P_NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(20);
const REMOTE_KEYRING_SERVICE: &str = "SomniQ Studio Remote Agent";

const REMOTE_ACCOUNT_PAIRING_STARTED_EVENT: &str = "remote-account-pairing-started";
const REMOTE_ACCOUNT_PAIRING_FAILED_EVENT: &str = "remote-account-pairing-failed";
/// The managed SomniQ Remote deployment is deliberately a non-secret profile:
/// people should not have to paste a gateway URL, STUN server, bootstrap
/// credential, or account login before they can pair a phone. The first signed
/// QR ceremony obtains a desktop credential that stays only in the operating
/// system credential store.
const MANAGED_REMOTE_GATEWAY_URL: &str = "https://somni.chat";
/// The managed gateway publishes this STUN-only endpoint alongside the HTTPS
/// control plane. It supplies public ICE discovery for a direct WebRTC probe;
/// an unavailable direct route still falls back to the encrypted TCP relay.
pub(crate) const MANAGED_REMOTE_STUN_SERVER: &str = "stun:106.53.28.124:3478";
const DEFAULT_REMOTE_DESKTOP_NAME: &str = "SomniQ Desktop";
const MAX_DEFAULT_REMOTE_DESKTOP_NAME_BYTES: usize = 120;
const REMOTE_WORKSPACE_CAPABILITIES: &[RemoteCapability] = &[
    RemoteCapability::SetActiveProject,
    RemoteCapability::CreateChatSession,
    RemoteCapability::GetChatModelOptions,
    RemoteCapability::SetChatSessionModel,
    RemoteCapability::StopChatMessage,
    RemoteCapability::RichChatProgress,
    RemoteCapability::ChatEventSync,
    RemoteCapability::AnswerChatQuestion,
];

/// Shared, protocol-versioned capabilities a paired device may receive. The
/// protocol intentionally exposes no direct filesystem, terminal, settings,
/// permission-response, or mail endpoint; chat work remains governed by the
/// selected desktop session's tool and permission policy.
pub type RemoteScope = DeviceScope;

fn normalized_system_desktop_name(value: &str) -> Option<String> {
    let name = value.trim();
    if name.is_empty()
        || name.as_bytes().len() > MAX_DEFAULT_REMOTE_DESKTOP_NAME_BYTES
        || name.chars().any(char::is_control)
    {
        return None;
    }
    Some(name.to_string())
}

fn default_remote_desktop_name() -> String {
    ["COMPUTERNAME", "HOSTNAME"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .find_map(|value| normalized_system_desktop_name(&value))
        .unwrap_or_else(|| DEFAULT_REMOTE_DESKTOP_NAME.to_string())
}

/// Replaces the generic placeholder name with this machine's host name.
///
/// The name is what the owner reads in the web device list to decide which
/// computer they are connecting to, so leaving every install called
/// "SomniQ Desktop" makes a multi-machine list useless. Installs that predate
/// host-name detection are stuck on the placeholder because the name was only
/// ever filled in when absent. A name the user actually chose is never
/// touched — only the placeholder is.
fn store_device_name(state: &RemoteAgentState) -> Option<String> {
    state
        .store
        .lock()
        .ok()
        .and_then(|store| store.device_name.clone())
}

fn upgrade_placeholder_desktop_name(store: &mut RemoteStore) {
    let is_placeholder = store
        .device_name
        .as_deref()
        .is_none_or(|name| name.trim().is_empty() || name == DEFAULT_REMOTE_DESKTOP_NAME);
    if !is_placeholder {
        return;
    }
    store.device_name = Some(default_remote_desktop_name());
}

/// Reads the identity fields written by releases where Compute owned a second
/// local node identity. They are migration input only; the Compute config is
/// rewritten without them after startup.
fn legacy_compute_identity() -> (Option<DeviceId>, Option<String>) {
    let path = crate::state::desktop_runtime_dir().join("compute-node.json");
    let Some(value) = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    else {
        return (None, None);
    };
    let id = value
        .get("nodeId")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| DeviceId::from_str(value).ok());
    let name = value
        .get("displayName")
        .and_then(serde_json::Value::as_str)
        .and_then(normalized_system_desktop_name);
    (id, name)
}

fn name_is_generated(value: &str) -> bool {
    value == DEFAULT_REMOTE_DESKTOP_NAME
        || value == "SomniQ computer"
        || value == default_remote_desktop_name()
}

/// Establishes the one installation identity now shared by remote control,
/// remote Agent, Compute capabilities, and worker results.
///
/// Compute was the only editable name in released builds, so a customized
/// legacy Compute label wins only when the remote label is still generated.
/// Existing remote IDs always win: gateway credentials and phone pairings are
/// already bound to them.
fn strip_legacy_compute_identity() -> Result<(), String> {
    let path = crate::state::desktop_runtime_dir().join("compute-node.json");
    let Some(mut value) = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    else {
        return Ok(());
    };
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    let changed = object.remove("nodeId").is_some() | object.remove("displayName").is_some();
    if changed {
        let body = serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?;
        runtime::write_file_atomically(&path, body).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn migrate_local_endpoint(store: &mut RemoteStore) -> Result<(), String> {
    let (legacy_compute_id, legacy_compute_name) = legacy_compute_identity();
    merge_local_endpoint_identity(store, legacy_compute_id, legacy_compute_name);
    strip_legacy_compute_identity()
}

fn merge_local_endpoint_identity(
    store: &mut RemoteStore,
    legacy_compute_id: Option<DeviceId>,
    legacy_compute_name: Option<String>,
) {
    if store
        .device_id
        .as_deref()
        .and_then(|value| DeviceId::from_str(value).ok())
        .is_none()
    {
        store.device_id = Some(legacy_compute_id.unwrap_or_else(DeviceId::new).to_string());
    }
    let remote_is_generated = store
        .device_name
        .as_deref()
        .is_none_or(|name| name.trim().is_empty() || name_is_generated(name));
    if remote_is_generated {
        if let Some(name) = legacy_compute_name.filter(|name| !name_is_generated(name)) {
            store.device_name = Some(name);
        } else {
            upgrade_placeholder_desktop_name(store);
        }
    } else {
        upgrade_placeholder_desktop_name(store);
    }
}

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
    pub kind: DeviceKind,
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
            kind: remote_device_kind(device),
            label: device.label.clone(),
            fingerprint: device.fingerprint.clone(),
            scopes: device.scopes.clone(),
            paired_at: device.paired_at,
            last_seen_at: device.last_seen_at,
            revoked_at: device.revoked_at,
        }
    }
}

fn remote_device_kind(device: &RemoteDevice) -> DeviceKind {
    device
        .descriptor
        .as_ref()
        .map(|descriptor| descriptor.kind)
        // Stores written before endpoint kinds were persisted contain only
        // phones unless they carry the compute-only permission.
        .unwrap_or_else(|| {
            if device.scopes.contains(&DeviceScope::ComputeJobs) {
                DeviceKind::ComputeNode
            } else {
                DeviceKind::Mobile
            }
        })
}

fn is_mobile_remote_device(device: &RemoteDevice) -> bool {
    remote_device_kind(device) == DeviceKind::Mobile
}

fn mobile_device_views(store: &RemoteStore) -> Vec<RemoteDeviceView> {
    store
        .devices
        .iter()
        .filter(|device| is_mobile_remote_device(device))
        .map(RemoteDeviceView::from)
        .collect()
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
    /// Copyable equivalent of the QR content for pairing another desktop.
    pub pairing_link: String,
}

/// Result of the one-click, managed remote-connect flow. Keeping status and
/// the QR together avoids a misleading intermediate state where the UI says
/// "enabled" even though the desktop has not been enrolled with the gateway.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInvitationResultView {
    pub status: RemoteControlStatus,
    pub pairing: RemotePairingInvitationView,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteAccountPairingStartedEvent {
    request_id: String,
    client_label: String,
    pairing_id: String,
    expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteAccountPairingFailedEvent {
    request_id: String,
    client_label: String,
    message: String,
}

/// Sanitized pending claim presented for a local desktop user's approval.
/// It deliberately omits the QR secret and the full signed request body.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePendingPairing {
    pub pairing_id: String,
    pub claim_id: String,
    pub device_id: String,
    pub kind: DeviceKind,
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
    session_id: String,
    idempotency_key: String,
    request_digest: String,
    message_id: String,
    created_at: u64,
    completed_text: Option<String>,
    cancelled: Arc<AtomicBool>,
}

enum RemoteChatReservation {
    New {
        message_id: String,
        cancelled: Arc<AtomicBool>,
    },
    Completed {
        message_id: String,
        text: String,
    },
}

/// The terminal decision for a remote message is made while the idempotency
/// entry is locked, so an accepted Stop cannot race a later completion frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RemoteChatTerminalDecision {
    Completed,
    Cancelled,
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

pub(crate) type ControlResponseSink = Arc<dyn Fn(ControlResponse) + Send + Sync + 'static>;

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

    fn seal_response(&self, response: &ControlResponse) -> Result<SecureEnvelope, String> {
        self.seal_payload(response)
    }

    pub(crate) fn seal_compute(
        &self,
        message: &ComputeWireMessage,
    ) -> Result<SecureEnvelope, String> {
        self.seal_payload(message)
    }

    fn seal_payload(&self, payload: &impl Serialize) -> Result<SecureEnvelope, String> {
        let sequence = self.outgoing_sequence.fetch_add(1, Ordering::SeqCst);
        SecureEnvelope::seal(
            &self.session_key,
            self.outgoing_route.clone(),
            sequence,
            protocol_now_millis(),
            payload,
        )
        .map_err(|error| format!("failed to encrypt remote response: {error}"))
    }

    pub(crate) fn open_compute(
        &self,
        envelope: &SecureEnvelope,
    ) -> Result<ComputeWireMessage, String> {
        self.incoming
            .lock()
            .map_err(|_| "remote replay state poisoned".to_string())?
            .open::<ComputeWireMessage>(envelope, &self.session_key, protocol_now_millis())
            .map_err(|error| format!("rejected compute envelope: {error}"))
    }

    /// Opens one frame from a brokered Image Assist peer.
    ///
    /// This is the only decoder an Image Assist session ever uses. It can
    /// produce nothing but [`ImageAssistWireMessage`], so a compute or control
    /// payload from a stranger cannot be turned into a value that the compute
    /// or Agent dispatchers accept, independently of any routing check.
    pub(crate) fn open_image_assist(
        &self,
        envelope: &SecureEnvelope,
    ) -> Result<ImageAssistWireMessage, String> {
        let message = self
            .incoming
            .lock()
            .map_err(|_| "remote replay state poisoned".to_string())?
            .open::<ImageAssistWireMessage>(envelope, &self.session_key, protocol_now_millis())
            .map_err(|error| format!("rejected image assist envelope: {error}"))?;
        message
            .validate()
            .map_err(|error| format!("rejected image assist frame: {error}"))?;
        Ok(message)
    }

    pub(crate) fn seal_image_assist(
        &self,
        message: &ImageAssistWireMessage,
    ) -> Result<SecureEnvelope, String> {
        self.seal_payload(message)
    }

    /// Opens, validates, and dispatches one request. The transport seals the
    /// returned terminal response and any streamed progress with this same
    /// wire session so sequence and replay rules stay shared.
    pub(crate) async fn handle_envelope(
        &self,
        app: AppHandle,
        state: &RemoteAgentState,
        envelope: &SecureEnvelope,
        stream_sink: Option<ControlResponseSink>,
    ) -> Result<ControlResponse, String> {
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
        Ok(execute_control_request(app, state, context, request, stream_sink).await)
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
    compute_channels: Mutex<BTreeMap<String, RemoteComputeChannel>>,
    /// Transport sessions belonging to a brokered Image Assist match, keyed by
    /// transport session id.
    ///
    /// A brokered peer is a stranger, never paired, and deliberately absent
    /// from the persisted device store. That absence is precisely why this map
    /// must exist: `p2p_device_is_compute` consults the store, so an unknown
    /// peer would otherwise fall through to the Agent control path and have its
    /// frames dispatched as `ControlRequest`. Registering the session here lets
    /// `classify_p2p_frame` route it to the closed Image Assist protocol before
    /// either general path is considered. Entries are process-local and are
    /// never written to the store or the OS keyring.
    image_assist_sessions: Mutex<BTreeMap<String, ImageAssistSession>>,
    image_assist_relay_shutdowns: Mutex<BTreeMap<String, watch::Sender<bool>>>,
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
            compute_channels: Mutex::new(BTreeMap::new()),
            image_assist_sessions: Mutex::new(BTreeMap::new()),
            image_assist_relay_shutdowns: Mutex::new(BTreeMap::new()),
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
#[allow(dead_code)]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    account_connect_request_id: Option<&'a str>,
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
struct GatewayMeResponse {
    paired_devices: Vec<GatewayDeviceSummary>,
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
    AccountConnectRequested {
        request_id: String,
        client_label: String,
    },
    /// Brokered Image Assist traffic.
    ///
    /// This mirror carries `deny_unknown_fields`, so the variant must exist
    /// here or a single brokering frame would fail to parse and drop the whole
    /// signal connection. Only the wrapper is mirrored: the frame body is the
    /// shared protocol type, so the two ends cannot drift on its contents.
    ImageAssist {
        frame: ImageAssistServerFrame,
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
    ImageAssist {
        frame: ImageAssistClientFrame,
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
pub struct RemoteP2pOfferInput {
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
pub(crate) struct RemoteP2pOfferEvent {
    pub(crate) device_id: String,
    pub(crate) session_id: String,
    pub(crate) sdp: String,
    pub(crate) ice_servers: Vec<String>,
    /// Whether this session was brokered between two users who never paired.
    ///
    /// The renderer suppresses host and mDNS candidates for these, so a
    /// stranger never learns this machine's internal network. Paired sessions
    /// keep every candidate: both machines belong to one person, and dropping
    /// host candidates there would push same-LAN peers onto STUN or the relay
    /// for no privacy gain.
    #[serde(default)]
    pub(crate) brokered: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteP2pStartEvent {
    pub(crate) device_id: String,
    pub(crate) session_id: String,
    pub(crate) ice_servers: Vec<String>,
    /// See [`RemoteP2pOfferEvent::brokered`].
    #[serde(default)]
    pub(crate) brokered: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteP2pAnswerEvent {
    pub(crate) device_id: String,
    pub(crate) session_id: String,
    pub(crate) sdp: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteP2pIceCandidateEvent {
    pub(crate) device_id: String,
    pub(crate) session_id: String,
    pub(crate) candidate: String,
    pub(crate) sdp_mid: Option<String>,
    pub(crate) sdp_m_line_index: Option<u16>,
    pub(crate) username_fragment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteP2pIceCompleteEvent {
    pub(crate) device_id: String,
    pub(crate) session_id: String,
}

/// Renderer recovery snapshot for a negotiation that arrived before the
/// WebView finished registering Tauri listeners (or during a renderer reload).
/// It contains WebRTC metadata only; session keys and encrypted control frames
/// remain Rust-owned.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteP2pPendingSnapshot {
    pub(crate) starts: Vec<RemoteP2pStartEvent>,
    pub(crate) offers: Vec<RemoteP2pOfferEvent>,
    pub(crate) answers: Vec<RemoteP2pAnswerEvent>,
    pub(crate) candidates: Vec<RemoteP2pIceCandidateEvent>,
    pub(crate) ice_completes: Vec<RemoteP2pIceCompleteEvent>,
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
        "{}/remote/pair#p={}",
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

async fn reconcile_paired_devices_with_gateway(
    app: &AppHandle,
    gateway_url: &str,
    token: &str,
) -> Result<(), String> {
    let paired_ids = gateway_paired_device_ids(gateway_url, token).await?;
    let stale_ids = {
        let state = app.state::<RemoteAgentState>();
        let store = state
            .store
            .lock()
            .map_err(|_| "remote agent state poisoned".to_string())?;
        store
            .devices
            .iter()
            .filter(|device| device.revoked_at.is_none() && !paired_ids.contains(&device.id))
            .map(|device| device.id.clone())
            .collect::<Vec<_>>()
    };
    for device_id in stale_ids {
        handle_gateway_device_revoked(app, &device_id);
    }
    Ok(())
}

async fn gateway_paired_device_ids(
    gateway_url: &str,
    token: &str,
) -> Result<BTreeSet<String>, String> {
    let overview: GatewayMeResponse = gateway_response_json(
        reqwest::Client::new()
            .get(format!("{gateway_url}/v1/me"))
            .bearer_auth(token),
    )
    .await?;
    Ok(overview
        .paired_devices
        .into_iter()
        .map(|device| device.id)
        .collect())
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

/// Whether the gateway still remembers this desktop ID while we no longer hold
/// a credential proving we own it.
///
/// `POST /v1/pairings` answers 409 when an anonymous caller presents a device
/// ID the gateway already has a record for — a correct refusal, since
/// otherwise anyone could seize a known desktop's identity. But the desktop
/// keeps its ID across a credential loss, so once the pair
/// (known ID, no credential) exists, every retry returns the same conflict and
/// the desktop can never enroll again. The missing-token half of the check
/// matters: with a working credential a 409 means something else entirely, and
/// rotating identity would then throw away live pairings for no reason.
fn gateway_rejected_desktop_identity(error: &str, gateway_url: &str) -> bool {
    error.contains("remote gateway request failed (409") && gateway_token(gateway_url).is_err()
}

/// Tells the gateway which account owns this desktop, so the account's own web
/// surfaces can discover it.
///
/// Without this the binding only ever happened as a side effect of a browser
/// pairing, so a freshly enrolled desktop stayed invisible to its owner until
/// someone scanned its QR — and a desktop that had to re-enroll disappeared
/// from the list until it was paired again.
///
/// Best effort by design. Not being signed in, an offline gateway, or an older
/// gateway without the route are all ordinary states: remote control still
/// works through pairing, so none of them may fail the caller.
async fn announce_account_ownership(gateway_url: &str, display_name: Option<String>) {
    let Ok(token) = gateway_token(gateway_url) else {
        return;
    };
    let credential = match crate::newapi::account_ownership_credential().await {
        Ok(Some(credential)) => credential,
        Ok(None) => return,
        Err(error) => {
            eprintln!("SomniQ remote: no account credential to announce: {error}");
            return;
        }
    };
    // The label travels with the announcement so a rename reaches the
    // account's web surfaces without waiting for another pairing.
    let response = reqwest::Client::new()
        .post(format!("{gateway_url}/v1/account/desktops"))
        .json(&serde_json::json!({ "display_name": display_name }))
        .bearer_auth(token)
        .header(
            "X-Somniq-Account-Authorization",
            format!("Bearer {}", credential.access_token),
        )
        .header("X-Somniq-Account-User", credential.user_id.to_string())
        .timeout(REMOTE_GATEWAY_REQUEST_TIMEOUT)
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => {}
        // Status only: the account token must never reach a log.
        Ok(response) => eprintln!(
            "SomniQ remote: gateway declined this desktop's account announcement ({})",
            response.status()
        ),
        Err(error) => {
            eprintln!("SomniQ remote: cannot announce account ownership: {error}")
        }
    }
}

/// Sentinel returned instead of resetting the identity on the user's behalf.
///
/// Recovering from a refused identity means discarding every existing pairing,
/// which cannot be undone — the desktop's old private keys are gone with it. An
/// automatic reset once wiped a populated device list without asking, so this
/// path now stops and hands the decision back.
pub(crate) const IDENTITY_RESET_REQUIRED: &str =
    "remote identity was refused by the gateway: this desktop's credential no longer matches its \
     registration, and reconnecting requires a new identity. Resetting discards every existing \
     pairing (each device must be paired again) and cannot be undone.";

/// Issues a new desktop identity after the gateway has refused the old one.
///
/// Everything derived from the previous ID dies with it: its keyring secret,
/// any gateway token, the phones paired to it, and pending QR codes that
/// advertise it. Clearing them here keeps the devices list from showing
/// pairings that can never connect again.
///
/// Destructive and irreversible: only call this from an explicit user action.
fn rotate_desktop_identity(state: &RemoteAgentState, gateway_url: &str) -> Result<(), String> {
    let previous_device_id = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?
        .device_id
        .clone();

    with_store(state, |store| {
        store.device_id = Some(new_desktop_device_id());
        store.devices.clear();
        store.pending_pairings.clear();
        Ok(())
    })?;

    if let Some(device_id) = previous_device_id
        .as_deref()
        .and_then(|id| DeviceId::from_str(id).ok())
    {
        // Best effort: a stranded secret is inert once nothing references it.
        let _ = delete_keyring_secret(&identity_secret_account(&device_id));
    }
    let _ = delete_gateway_token(gateway_url);
    Ok(())
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
    let confirmed = matches!(result, Ok(response) if response.revoked_device_id == device_id)
        || matches!(
            gateway_paired_device_ids(&gateway_url, &token).await,
            Ok(paired_ids) if !paired_ids.contains(device_id)
        );
    if confirmed {
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

fn schedule_account_connect_pairing(
    app: AppHandle,
    request_id: String,
    client_label: String,
) {
    tauri::async_runtime::spawn(async move {
        let result = {
            let state = app.state::<RemoteAgentState>();
            start_pairing_for_account_request(
                app.clone(),
                state.inner(),
                Some(&request_id),
            )
            .await
        };
        match result {
            Ok(pairing) => {
                let _ = app.emit(
                    REMOTE_ACCOUNT_PAIRING_STARTED_EVENT,
                    RemoteAccountPairingStartedEvent {
                        request_id,
                        client_label,
                        pairing_id: pairing.pairing_id,
                        expires_at: pairing.expires_at,
                    },
                );
            }
            Err(message) => {
                let _ = app.emit(
                    REMOTE_ACCOUNT_PAIRING_FAILED_EVENT,
                    RemoteAccountPairingFailedEvent {
                        request_id,
                        client_label,
                        message,
                    },
                );
            }
        }
    });
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
                // Revocations can happen while this desktop is offline. The
                // gateway inventory is authoritative, so remove stale local
                // phone/compute grants before accepting fresh transport work.
                let _ = reconcile_paired_devices_with_gateway(&app, &gateway_url, &token).await;
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
    // Presence belongs to the authenticated Rust connection, not a renderer
    // timer. This metadata-free renewal survives minimized-window timer
    // throttling and laptop resume without re-sending a user's optional public
    // name or location.
    let mut image_assist_heartbeat = interval(Duration::from_secs(30));
    image_assist_heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_pong = Instant::now();
    let mut expected_pong = None::<String>;
    let mut heartbeat_counter = 0_u64;
    loop {
        if !transport_generation_is_current(&app, generation) {
            return;
        }
        tokio::select! {
            _ = image_assist_heartbeat.tick() => {
                let frames = [
                    crate::image_assist::current_helper_heartbeat(&app),
                    ImageAssistClientFrame::RequestRoster,
                ];
                for frame in frames {
                    let outgoing = GatewayOutboundSignalFrame::ImageAssist { frame };
                    let Ok(outgoing) = serde_json::to_string(&outgoing) else { return; };
                    let write_timeout = REMOTE_SIGNAL_WRITE_TIMEOUT.min(
                        REMOTE_SIGNAL_HEARTBEAT_TIMEOUT.saturating_sub(last_pong.elapsed()),
                    );
                    if write_timeout.is_zero()
                        || !matches!(
                            timeout(write_timeout, socket.send(Message::text(outgoing))).await,
                            Ok(Ok(()))
                        )
                    {
                        return;
                    }
                }
            }
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
                            GatewaySignalFrame::AccountConnectRequested {
                                request_id,
                                client_label,
                            } => {
                                schedule_account_connect_pairing(
                                    app.clone(),
                                    request_id,
                                    client_label,
                                );
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
                            GatewaySignalFrame::ImageAssist { frame } => {
                                crate::image_assist::handle_gateway_frame(&app, frame);
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
    wire: Arc<RemoteWireSession>,
    image_assist_match_id: Option<String>,
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
pub(crate) struct ReservedP2pSession {
    device_id: String,
    session_id: SessionId,
    pub(crate) wire: Arc<RemoteWireSession>,
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

/// Whether a brokered session is still waiting for the renderer to establish
/// its direct channel. Established sessions must not be replayed as new offers
/// after a renderer recovery.
pub(crate) fn image_assist_p2p_session_is_pending(
    state: &RemoteAgentState,
    session_id: &str,
) -> bool {
    state
        .active_p2p_sessions
        .lock()
        .ok()
        .and_then(|sessions| {
            sessions
                .get(session_id)
                .map(|session| !session.established.load(Ordering::SeqCst))
        })
        .unwrap_or(false)
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
        starts: Vec::new(),
        offers,
        answers: Vec::new(),
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
    let was_compute_node = p2p_device_is_compute(state.inner(), device_id).unwrap_or(false);
    for session in mark_gateway_revoked_device(state.inner(), device_id) {
        let _ = app.emit("remote-p2p-failed", session);
    }
    if was_compute_node {
        // The computer settings, Chat target picker, and Lab target picker
        // all refresh from this shared event.
        crate::compute::peer_disconnected(app, device_id, "");
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
        let brokered =
            crate::image_assist::brokered_direct_failed(app, state.inner(), &session.session_id)
                .unwrap_or(false);
        if !brokered {
            unregister_compute_channel(state.inner(), &session.device_id, &session.session_id);
            crate::compute::peer_disconnected(app, &session.device_id, &session.session_id);
        }
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

/// Seals a brokered preview to the helper's introduced key.
///
/// Kept here rather than in `image_assist` so the desktop signing and
/// key-agreement material never leaves this module. The gateway relays the
/// result as opaque bytes; it is a trusted introducer for the key, which is the
/// documented limit of the brokered trust model.
pub(crate) fn seal_image_assist_preview(
    state: &RemoteAgentState,
    match_id: MatchId,
    peer: &DeviceDescriptor,
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let identity = desktop_identity(state)?;
    let local_id = identity.descriptor.device_id;
    let context = PreviewKeyContext::new(match_id, local_id, peer.device_id)
        .map_err(|error| format!("cannot derive image assist preview context: {error}"))?;
    let key = identity
        .agreement_key
        .derive_preview_key(&peer.key_agreement_public_key, &context)
        .map_err(|error| format!("cannot derive image assist preview key: {error}"))?;
    let route = SessionRoute::new(
        SessionId::from_uuid(match_id.as_uuid()),
        local_id,
        peer.device_id,
    );
    let envelope = SecureEnvelope::seal_bytes(&key, route, 1, protocol_now_millis(), plaintext)
        .map_err(|error| format!("cannot seal the image assist preview: {error}"))?;
    serde_json::to_vec(&envelope)
        .map_err(|error| format!("cannot encode the image assist preview: {error}"))
}

/// Opens a brokered preview sealed to this machine.
pub(crate) fn open_image_assist_preview(
    state: &RemoteAgentState,
    match_id: MatchId,
    peer: &DeviceDescriptor,
    sealed: &[u8],
) -> Result<Vec<u8>, String> {
    let identity = desktop_identity(state)?;
    let local_id = identity.descriptor.device_id;
    let context = PreviewKeyContext::new(match_id, local_id, peer.device_id)
        .map_err(|error| format!("cannot derive image assist preview context: {error}"))?;
    let key = identity
        .agreement_key
        .derive_preview_key(&peer.key_agreement_public_key, &context)
        .map_err(|error| format!("cannot derive image assist preview key: {error}"))?;
    let envelope: SecureEnvelope = serde_json::from_slice(sealed)
        .map_err(|_| "the image assist preview is malformed".to_string())?;
    // The route binds the ciphertext to this exact match and direction, so a
    // preview from another match cannot be replayed into this dialog.
    let expected = SessionRoute::new(
        SessionId::from_uuid(match_id.as_uuid()),
        peer.device_id,
        local_id,
    );
    if envelope.route != expected {
        return Err("the image assist preview is for a different match".to_string());
    }
    envelope
        .open_bytes(&key)
        .map_err(|error| format!("cannot open the image assist preview: {error}"))
}

/// This desktop's own descriptor, as a brokered peer receives it.
///
/// The peer is handed this same descriptor by the gateway introduction and
/// signs it into the match transcript. Any drift between the two — a device
/// renamed since it registered, a regenerated key — therefore fails the
/// brokered channel closed instead of quietly weakening what the match binds.
pub(crate) fn local_device_descriptor(
    state: &RemoteAgentState,
) -> Result<DeviceDescriptor, String> {
    Ok(desktop_identity(state)?.descriptor)
}

/// Signs a brokered match transcript with this desktop's device signing key.
///
/// Kept beside the preview helpers for the same reason: the signing key never
/// leaves this module, so `image_assist` handles transcripts without ever
/// holding the material that authenticates them.
pub(crate) fn sign_image_assist_transcript(
    state: &RemoteAgentState,
    transcript: &ImageAssistTranscript,
) -> Result<DeviceSignature, String> {
    transcript
        .sign(&desktop_identity(state)?.signing_key)
        .map_err(|error| format!("cannot sign the image assist match transcript: {error}"))
}

/// Sends one brokering frame to the gateway.
///
/// Shares the same bounded outbound queue as WebRTC signaling, so brokering
/// traffic cannot starve or outrank the transport it depends on.
pub(crate) fn send_image_assist_frame(
    state: &RemoteAgentState,
    frame: ImageAssistClientFrame,
) -> Result<(), String> {
    let outbound = state
        .signal_outbound
        .lock()
        .map_err(|_| "remote signal state poisoned".to_string())?
        .clone()
        .ok_or_else(|| "remote signal transport is unavailable".to_string())?;
    outbound
        .try_send(GatewayOutboundSignalFrame::ImageAssist { frame })
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
            let brokered = crate::image_assist::brokered_direct_failed(
                &app,
                state.inner(),
                &session.session_id.to_string(),
            )
            .unwrap_or(false);
            remove_p2p_session(
                state.inner(),
                &session.device_id,
                &session.session_id.to_string(),
            );
            if brokered {
                let _ = app.emit(
                    "remote-p2p-failed",
                    RemoteP2pSessionInput {
                        device_id: session.device_id.clone(),
                        session_id: session.session_id.to_string(),
                    },
                );
            }
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
            // A brokered match already reserved its own session when the
            // gateway approved it, and it must not be resolved through the
            // paired store: a stranger has no entry there, and its answerer
            // has to suppress the host candidates the paired path forwards.
            let brokered = classify_p2p_frame(state.inner(), &from, &session_id)
                .is_ok_and(|route| route == P2pFrameRoute::ImageAssist);
            let session = if brokered {
                let Ok(session) = p2p_session(state.inner(), &from, &session_id) else {
                    return;
                };
                session
            } else {
                let Ok(session) = reserve_p2p_session(state.inner(), mobile_id, parsed_session_id)
                else {
                    return;
                };
                session
            };
            let ice_servers = if brokered {
                // The gateway assigned these to the match, so both ends agree
                // without either consulting its own paired configuration.
                crate::image_assist::brokered_ice_servers(&session_id).unwrap_or_default()
            } else {
                state
                    .store
                    .lock()
                    .map(|store| store.ice_servers.clone())
                    .unwrap_or_default()
            };
            let event = RemoteP2pOfferEvent {
                device_id: from,
                session_id,
                sdp,
                ice_servers,
                brokered,
            };
            if retain_pending_p2p_offer(state.inner(), event.clone()).is_err() {
                let _ = crate::image_assist::brokered_direct_failed(
                    &app,
                    state.inner(),
                    &event.session_id,
                );
                remove_p2p_session(
                    state.inner(),
                    &session.device_id,
                    &session.session_id.to_string(),
                );
                return;
            }
            if app.emit("remote-p2p-offer", event).is_err() {
                let _ = crate::image_assist::brokered_direct_failed(
                    &app,
                    state.inner(),
                    &session.session_id.to_string(),
                );
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
                let _ =
                    crate::image_assist::brokered_direct_failed(&app, state.inner(), &session_id);
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
            let brokered =
                crate::image_assist::brokered_direct_failed(&app, state.inner(), &session_id)
                    .unwrap_or(false);
            remove_p2p_session(state.inner(), &from, &session_id);
            if !brokered {
                unregister_compute_channel(state.inner(), &from, &session_id);
                crate::compute::peer_disconnected(&app, &from, &session_id);
            }
            let _ = app.emit(
                "remote-p2p-failed",
                RemoteP2pSessionInput {
                    device_id: from,
                    session_id,
                },
            );
        }
        // The inviting desktop is the deterministic answerer for both mobile
        // and claimed-compute offers. An answer sent back to it is therefore
        // a protocol violation rather than a renegotiation opportunity.
        TransportSignal::DirectTcpOffer { .. }
        | TransportSignal::WebrtcAnswer { .. }
        | TransportSignal::RelayOffer { .. } => {}
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
        let wire = Arc::new(RemoteWireSession::new(
            device_id.clone(),
            TransportKind::TcpRelay,
            key,
            incoming,
        )?);
        Ok(ReservedRelaySession {
            active_key: active_key.clone(),
            device_id: device_id.clone(),
            session_id,
            wire,
            image_assist_match_id: None,
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
        TransportSignal::DirectTcpOffer { addresses, .. } => {
            schedule_compute_direct_offer(app, from, session_id, addresses, shutdown);
        }
        // Keep the legacy P1 fallback byte-for-byte compatible: a P2 mobile
        // creates a *new* outer session ID and sends this established offer.
        TransportSignal::RelayOffer { .. } => {
            schedule_relay_offer(app, from, session_id, shutdown);
        }
        signal => schedule_p2p_signal(app, from, session_id, signal),
    }
}

fn schedule_compute_direct_offer(
    app: AppHandle,
    from: String,
    session_id: String,
    addresses: Vec<String>,
    shutdown: watch::Receiver<bool>,
) {
    let Ok(peer_id) = DeviceId::from_str(&from) else {
        return;
    };
    let Ok(parsed_session_id) = SessionId::from_str(&session_id) else {
        return;
    };
    let is_compute =
        app.state::<RemoteAgentState>()
            .store
            .lock()
            .ok()
            .and_then(|store| {
                store
                    .devices
                    .iter()
                    .find(|device| device.id == from && device.revoked_at.is_none())
                    .map(|device| {
                        device.scopes.contains(&DeviceScope::ComputeJobs)
                            && device.descriptor.as_ref().is_some_and(|descriptor| {
                                descriptor.kind == DeviceKind::ComputeNode
                            })
                    })
            })
            .unwrap_or(false);
    if !is_compute {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut connected = None;
        for address in addresses {
            let Ok(address) = address.parse::<std::net::SocketAddr>() else {
                continue;
            };
            if let Ok(Ok(stream)) =
                timeout(COMPUTE_DIRECT_CONNECT_TIMEOUT, TcpStream::connect(address)).await
            {
                connected = Some(stream);
                break;
            }
        }
        let Some(stream) = connected else {
            return;
        };
        let state = app.state::<RemoteAgentState>();
        let Ok(session) = reserve_p2p_session(state.inner(), peer_id, parsed_session_id) else {
            return;
        };
        let _ = run_compute_direct_connection(&app, &session, stream, shutdown).await;
        remove_p2p_session(app.state::<RemoteAgentState>().inner(), &from, &session_id);
        unregister_compute_channel(app.state::<RemoteAgentState>().inner(), &from, &session_id);
        crate::compute::peer_disconnected(&app, &from, &session_id);
    });
}

async fn read_compute_direct_envelope(
    reader: &mut OwnedReadHalf,
) -> Result<Option<SecureEnvelope>, String> {
    let length = match reader.read_u32().await {
        Ok(length) => length as usize,
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(_) => return Err("compute P2P frame header failed".to_string()),
    };
    if length == 0 || length > MAX_RELAY_FRAME_BYTES {
        return Err("compute P2P frame exceeds the transport limit".to_string());
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .await
        .map_err(|_| "compute P2P frame was truncated".to_string())?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|_| "compute P2P frame is not a secure envelope".to_string())
}

async fn write_compute_direct_envelope(
    writer: &mut OwnedWriteHalf,
    envelope: &SecureEnvelope,
) -> Result<(), String> {
    let payload = serde_json::to_vec(envelope)
        .map_err(|_| "cannot encode compute P2P envelope".to_string())?;
    if payload.is_empty() || payload.len() > MAX_RELAY_FRAME_BYTES {
        return Err("encrypted compute P2P frame exceeds the transport limit".to_string());
    }
    writer
        .write_u32(payload.len() as u32)
        .await
        .map_err(|_| "cannot write compute P2P frame header".to_string())?;
    writer
        .write_all(&payload)
        .await
        .map_err(|_| "cannot write compute P2P frame".to_string())?;
    writer
        .flush()
        .await
        .map_err(|_| "cannot flush compute P2P frame".to_string())
}

async fn run_compute_direct_connection(
    app: &AppHandle,
    session: &Arc<ReservedP2pSession>,
    stream: TcpStream,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), String> {
    stream
        .set_nodelay(true)
        .map_err(|_| "cannot configure compute P2P socket".to_string())?;
    let (mut reader, mut writer) = stream.into_split();
    let (compute_tx, mut compute_rx) = mpsc::unbounded_channel::<ComputeWireMessage>();
    let session_id = session.session_id.to_string();
    let handshake = session
        .wire
        .seal_compute(&ComputeWireMessage::Capabilities {
            request_id: format!("direct-handshake-{session_id}"),
        })?;
    write_compute_direct_envelope(&mut writer, &handshake).await?;
    let first_envelope = timeout(
        Duration::from_millis(1_500),
        read_compute_direct_envelope(&mut reader),
    )
    .await
    .map_err(|_| "compute P2P authentication timed out".to_string())??
    .ok_or_else(|| "compute P2P peer closed before authentication".to_string())?;
    let first_message = session.wire.open_compute(&first_envelope)?;
    session.established.store(true, Ordering::SeqCst);
    app.state::<RemoteAgentState>()
        .compute_channels
        .lock()
        .map_err(|_| "remote compute channel state poisoned".to_string())?
        .insert(
            session.device_id.clone(),
            RemoteComputeChannel {
                session_id: session_id.clone(),
                transport: "p2p_tcp",
                sender: compute_tx.clone(),
            },
        );
    crate::compute::peer_connected(app, &session.device_id, &session_id, "p2p_tcp");
    crate::compute::handle_peer_message(
        app.clone(),
        session.device_id.clone(),
        first_message,
        compute_tx.clone(),
    );

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return Ok(());
                }
            }
            Some(message) = compute_rx.recv() => {
                let envelope = session.wire.seal_compute(&message)?;
                write_compute_direct_envelope(&mut writer, &envelope).await?;
            }
            incoming = read_compute_direct_envelope(&mut reader) => {
                let Some(envelope) = incoming? else {
                    return Ok(());
                };
                let message = session.wire.open_compute(&envelope)?;
                crate::compute::handle_peer_message(
                    app.clone(),
                    session.device_id.clone(),
                    message,
                    compute_tx.clone(),
                );
            }
        }
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
    if session.image_assist_match_id.is_some() {
        if let Ok(mut shutdowns) = app
            .state::<RemoteAgentState>()
            .image_assist_relay_shutdowns
            .lock()
        {
            shutdowns.remove(&session_id);
        }
        // A clean close is not the same failure as a broken one: after a
        // completed transfer it is the peer tidying up, and before one it means
        // the peer left. Image Assist decides which by whether the match has
        // settled; both cases still need the session released.
        crate::image_assist::brokered_transport_failed(
            &app,
            &session_id,
            result
                .as_ref()
                .err()
                .map(String::as_str)
                .unwrap_or("对方已关闭加密中继通道"),
        );
        remove_image_assist_session(app.state::<RemoteAgentState>().inner(), &session_id);
        return;
    }
    unregister_compute_channel(
        app.state::<RemoteAgentState>().inner(),
        &session.device_id,
        &session_id,
    );
    crate::compute::peer_disconnected(&app, &session.device_id, &session_id);
    let _ = session_id;
}

fn unregister_compute_channel(state: &RemoteAgentState, device_id: &str, session_id: &str) {
    if let Ok(mut channels) = state.compute_channels.lock() {
        if channels
            .get(device_id)
            .is_some_and(|channel| channel.session_id == session_id)
        {
            channels.remove(device_id);
        }
    }
}

fn encode_remote_control_response(
    wire: &RemoteWireSession,
    response: &ControlResponse,
) -> Result<Vec<u8>, String> {
    let envelope = wire.seal_response(response)?;
    let payload = serde_json::to_vec(&envelope)
        .map_err(|_| "cannot encode encrypted remote response".to_string())?;
    if payload.len() > MAX_RELAY_FRAME_BYTES {
        return Err("encrypted remote response exceeds relay frame limit".to_string());
    }
    Ok(payload)
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
    let (mut socket_sink, mut socket_stream) = socket.split();
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Result<Vec<u8>, String>>();
    let (compute_tx, mut compute_rx) = mpsc::unbounded_channel::<ComputeWireMessage>();
    let is_compute = {
        let state = app.state::<RemoteAgentState>();
        paired_compute_devices(state.inner())?
            .iter()
            .any(|descriptor| descriptor.device_id.to_string() == session.device_id)
    };
    let image_sink: Option<crate::image_assist::ImageAssistFrameSink> =
        session.image_assist_match_id.as_ref().map(|_| {
            let wire = session.wire.clone();
            let outbound = outbound_tx.clone();
            Arc::new(move |message: ImageAssistWireMessage| {
                let envelope = wire.seal_image_assist(&message)?;
                let payload = serde_json::to_vec(&envelope)
                    .map_err(|_| "cannot encode encrypted image assist frame".to_string())?;
                if payload.len() > MAX_RELAY_FRAME_BYTES {
                    return Err("encrypted image assist frame exceeds relay limit".to_string());
                }
                outbound
                    .send(Ok(payload))
                    .map_err(|_| "image assist relay is closed".to_string())
            }) as crate::image_assist::ImageAssistFrameSink
        });
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
                    let _ = socket_sink.close().await;
                    return Ok(());
                }
            }
            Some(outbound) = outbound_rx.recv() => {
                let payload = outbound?;
                socket_sink
                    .send(Message::binary(payload))
                    .await
                    .map_err(|_| "cannot send encrypted remote response".to_string())?;
            }
            Some(message) = compute_rx.recv(), if is_compute => {
                let envelope = session.wire.seal_compute(&message)?;
                let payload = serde_json::to_vec(&envelope)
                    .map_err(|_| "cannot encode encrypted compute frame".to_string())?;
                if payload.len() > MAX_RELAY_FRAME_BYTES {
                    return Err("encrypted compute frame exceeds relay frame limit".to_string());
                }
                socket_sink
                    .send(Message::binary(payload))
                    .await
                    .map_err(|_| "cannot send encrypted compute frame".to_string())?;
            }
            incoming = socket_stream.next() => {
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
                                    let first_connection = !readiness.peer_connected;
                                    readiness.peer_connected = true;
                                    if first_connection {
                                        if let Some(sink) = image_sink.clone() {
                                            crate::image_assist::brokered_transport_opened(
                                                app,
                                                app.state::<RemoteAgentState>().inner(),
                                                &session_id,
                                                sink,
                                            )?;
                                        }
                                    }
                                    if is_compute {
                                        app.state::<RemoteAgentState>()
                                            .compute_channels
                                            .lock()
                                            .map_err(|_| "remote compute channel state poisoned".to_string())?
                                            .insert(
                                                session.device_id.clone(),
                                                RemoteComputeChannel {
                                                    session_id: session_id.clone(),
                                                    transport: "tcp_relay",
                                                    sender: compute_tx.clone(),
                                                },
                                            );
                                        crate::compute::peer_connected(
                                            app,
                                            &session.device_id,
                                            &session_id,
                                            "tcp_relay",
                                        );
                                    }
                                }
                            GatewayRelayFrame::PeerDisconnected { device_id, session_id: received }
                                if device_id == session.device_id && received == session_id => return Ok(()),
                            GatewayRelayFrame::Pong { nonce } => { let _ = nonce; }
                            GatewayRelayFrame::Error { code, message } => {
                                // Gateway control-frame errors are fixed protocol text, not
                                // peer-provided data. Preserve them so recovery guidance can
                                // distinguish a transient peer conflict from an authorization
                                // or expiry failure without exposing ciphertext or credentials.
                                return Err(format!(
                                    "remote relay rejected the session ({code}): {message}"
                                ));
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
                        if let Some(sink) = image_sink.clone() {
                            let message = session.wire.open_image_assist(&envelope)?;
                            crate::image_assist::handle_transport_frame(
                                app.clone(),
                                session_id.clone(),
                                message,
                                sink,
                            );
                            continue;
                        }
                        if is_compute {
                            let message = session.wire.open_compute(&envelope)?;
                            crate::compute::handle_peer_message(
                                app.clone(),
                                session.device_id.clone(),
                                message,
                                compute_tx.clone(),
                            );
                            continue;
                        }
                        let wire = session.wire.clone();
                        let task_app = app.clone();
                        let task_outbound = outbound_tx.clone();
                        let dispatch_lock = Arc::new(Mutex::new(()));
                        let stream_wire = wire.clone();
                        let stream_outbound = task_outbound.clone();
                        let stream_dispatch_lock = dispatch_lock.clone();
                        let stream_sink: ControlResponseSink = Arc::new(move |response| {
                            let result = stream_dispatch_lock
                                .lock()
                                .map_err(|_| "remote response dispatch state poisoned".to_string())
                                .and_then(|_guard| encode_remote_control_response(&stream_wire, &response));
                            let _ = stream_outbound.send(result);
                        });
                        tauri::async_runtime::spawn(async move {
                            let state = task_app.state::<RemoteAgentState>();
                            match wire
                                .handle_envelope(
                                    task_app.clone(),
                                    state.inner(),
                                    &envelope,
                                    Some(stream_sink.clone()),
                                )
                                .await
                            {
                                Ok(response) => stream_sink(response),
                                Err(error) => {
                                    let _ = task_outbound.send(Err(error));
                                }
                            }
                        });
                    }
                    Message::Ping(payload) => {
                        socket_sink.send(Message::Pong(payload)).await
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
    let mobile_devices = store
        .devices
        .iter()
        .filter(|device| is_mobile_remote_device(device));
    RemoteControlStatus {
        enabled: store.enabled,
        gateway_url: store.gateway_url.clone(),
        device_id: store.device_id.clone(),
        device_name: store.device_name.clone(),
        ice_servers: store.ice_servers.clone(),
        paired_device_count: mobile_devices.clone().count(),
        active_device_count: mobile_devices
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
    with_store(state, |store| migrate_local_endpoint(store))?;
    // `Default` eagerly loads the store. The network runner is outbound-only:
    // it authenticates to the configured gateway and never opens a desktop
    // listening port. Missing first-time credentials are handled by Settings.
    start_transport(app, state);
    // Re-announce the owning account on every launch. This is what makes an
    // enrolled desktop discoverable from the web without another pairing, and
    // it is also how a desktop that was signed in *after* enrolling catches up.
    // `configured_gateway_url` already refuses when remote control is off.
    if let Ok(gateway_url) = configured_gateway_url(state) {
        let display_name = store_device_name(state);
        tauri::async_runtime::spawn(async move {
            announce_account_ownership(&gateway_url, display_name).await;
        });
    }
    Ok(())
}

/// Stable installation identity used by every trusted-device surface. Pairing
/// transports may retain legacy route aliases, but they never own a second
/// user-visible node identity.
pub(crate) fn local_endpoint_identity(
    state: &RemoteAgentState,
) -> Result<(DeviceId, String), String> {
    let store = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?;
    let id = store
        .device_id
        .as_deref()
        .ok_or_else(|| "local device identity is unavailable".to_string())
        .and_then(|value| {
            DeviceId::from_str(value).map_err(|_| "local device identity is invalid".to_string())
        })?;
    let name = store
        .device_name
        .clone()
        .ok_or_else(|| "local device name is unavailable".to_string())?;
    Ok((id, name))
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
        upgrade_placeholder_desktop_name(store);
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

/// A first managed enrollment can be rolled back after the gateway refuses the
/// desktop's existing identity. The UI still has an explicit reset action in
/// that state, so restore the managed profile before the destructive rotation
/// instead of making the reset command fail its own enabled-state check.
fn gateway_url_for_identity_reset(state: &RemoteAgentState) -> Result<String, String> {
    match configured_gateway_url(state) {
        Ok(gateway_url) => Ok(gateway_url),
        Err(error) if error == REMOTE_CONTROL_DISABLED_ERROR => {
            let (_, gateway_url) = enable_managed_remote(state)?;
            Ok(gateway_url)
        }
        Err(error) => Err(error),
    }
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
    Ok(mobile_device_views(&store))
}

pub(crate) fn paired_compute_devices(
    state: &RemoteAgentState,
) -> Result<Vec<DeviceDescriptor>, String> {
    let store = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?;
    Ok(store
        .devices
        .iter()
        .filter(|device| {
            device.revoked_at.is_none() && device.scopes.contains(&DeviceScope::ComputeJobs)
        })
        .filter_map(|device| device.descriptor.clone())
        .filter(|descriptor| descriptor.kind == DeviceKind::ComputeNode)
        .collect())
}

/// Persists the latest name sent over an authenticated Compute capability
/// channel. The signed pairing descriptor remains the immutable audit
/// snapshot; this mutable label is what device pickers should show after a
/// trusted peer is renamed.
pub(crate) fn update_paired_device_label(
    state: &RemoteAgentState,
    device_id: &str,
    label: &str,
) -> Result<(), String> {
    let label = normalized_system_desktop_name(label)
        .ok_or_else(|| "peer device name is invalid".to_string())?;
    with_store(state, |store| {
        if let Some(device) = store
            .devices
            .iter_mut()
            .find(|device| device.id == device_id && device.revoked_at.is_none())
        {
            device.label = label;
        }
        Ok(())
    })
}

pub(crate) fn compute_device_connected(
    state: &RemoteAgentState,
    device_id: &str,
) -> Result<bool, String> {
    state
        .compute_channels
        .lock()
        .map(|channels| channels.contains_key(device_id))
        .map_err(|_| "remote compute channel state poisoned".to_string())
}

pub(crate) fn compute_device_transport(
    state: &RemoteAgentState,
    device_id: &str,
) -> Result<Option<String>, String> {
    state
        .compute_channels
        .lock()
        .map(|channels| {
            channels
                .get(device_id)
                .map(|channel| channel.transport.to_string())
        })
        .map_err(|_| "remote compute channel state poisoned".to_string())
}

pub(crate) fn compute_device_scopes(
    state: &RemoteAgentState,
    device_id: &str,
) -> Result<DeviceScopes, String> {
    let store = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?;
    store
        .devices
        .iter()
        .find(|device| device.id == device_id && device.revoked_at.is_none())
        .map(|device| device.scopes.iter().copied().collect())
        .ok_or_else(|| "remote computer is not paired".to_string())
}

pub(crate) fn send_compute_message(
    state: &RemoteAgentState,
    device_id: &str,
    message: ComputeWireMessage,
) -> Result<(), String> {
    let sender = state
        .compute_channels
        .lock()
        .map_err(|_| "remote compute channel state poisoned".to_string())?
        .get(device_id)
        .map(|channel| channel.sender.clone())
        .ok_or_else(|| "the selected compute node is offline".to_string())?;
    sender
        .send(message)
        .map_err(|_| "the selected compute node disconnected".to_string())
}

fn configured_gateway_url(state: &RemoteAgentState) -> Result<String, String> {
    let store = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?;
    if !store.enabled {
        return Err(REMOTE_CONTROL_DISABLED_ERROR.to_string());
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
        kind: claim.mobile.kind,
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
            | RemoteScope::ComputeJobs
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
    start_pairing_for_account_request(app, state, None).await
}

async fn start_pairing_for_account_request(
    app: AppHandle,
    state: &RemoteAgentState,
    account_connect_request_id: Option<&str>,
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
                account_connect_request_id,
            });
    if let Some(token) = token.as_deref() {
        request = request.bearer_auth(token);
    }
    let response: GatewayStartPairingResponse = gateway_response_json(request).await?;
    apply_gateway_pairing_expiry(&mut invitation, &response)?;
    if let Some(desktop_token) = response.desktop_token.as_deref() {
        store_gateway_token(&gateway_url, desktop_token)?;
        // A first enrollment has just minted the credential this announcement
        // needs, so bind the owner now rather than at the next launch.
        announce_account_ownership(&gateway_url, store_device_name(state)).await;
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
        pairing_link: pairing_qr_deep_link(&invitation)?,
    })
}

struct RemoteComputeChannel {
    session_id: String,
    transport: &'static str,
    sender: mpsc::UnboundedSender<ComputeWireMessage>,
}

/// One brokered Image Assist transport session.
///
/// Deliberately minimal and process-local: the brokered peer's descriptor,
/// role, and verified transcript live here for the lifetime of the match and
/// are never persisted to `compute-peers.json`, the remote store, or the OS
/// keyring.
#[derive(Debug, Clone)]
pub(crate) struct ImageAssistSession {
    pub(crate) device_id: String,
    /// Correlates this transport session with its brokered match.
    #[allow(dead_code, reason = "consumed by the Image Assist match state machine")]
    pub(crate) match_id: String,
    /// The peer descriptor the gateway introduced. Held only for the lifetime
    /// of the match; it is never merged into the paired-device store.
    #[allow(dead_code, reason = "consumed by the Image Assist match state machine")]
    pub(crate) peer: DeviceDescriptor,
}

/// Which protocol a decoded P2P frame belongs to.
///
/// Extracting this decision from `remote_control_p2p_frame` makes the ordering
/// explicit and testable. The order matters: Image Assist is checked first so a
/// brokered stranger can never reach the compute or Agent dispatchers, and the
/// remaining two arms keep their existing behavior for paired devices.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum P2pFrameRoute {
    ImageAssist,
    Compute,
    Control,
}

pub(crate) fn register_image_assist_session(
    state: &RemoteAgentState,
    session_id: &str,
    session: ImageAssistSession,
) -> Result<(), String> {
    SessionId::from_str(session_id)
        .map_err(|_| "invalid image assist transport session".to_string())?;
    DeviceId::from_str(&session.device_id)
        .map_err(|_| "invalid image assist device identity".to_string())?;
    if session.peer.device_id.to_string() != session.device_id {
        return Err("image assist descriptor does not match its device identity".to_string());
    }
    if p2p_device_is_compute(state, &session.device_id)? {
        return Err(
            "a paired compute device cannot be brokered as an Image Assist peer".to_string(),
        );
    }
    state
        .image_assist_sessions
        .lock()
        .map_err(|_| "image assist session state poisoned".to_string())?
        .insert(session_id.to_string(), session);
    Ok(())
}

/// Opens a transport session with a brokered stranger.
///
/// Parallel to [`reserve_p2p_session`] but deliberately not a variant of it.
/// That path resolves the peer from the persisted device store and calls
/// `record_transport_session`, which writes to it. A brokered peer has no
/// store entry and must never gain one: its descriptor comes from the gateway
/// introduction, lives in memory for the length of the match, and disappears
/// with it. The two paths therefore share the key-derivation and wire-session
/// construction but not the storage or authorization model.
pub(crate) fn reserve_image_assist_p2p_session(
    state: &RemoteAgentState,
    match_id: &str,
    peer: DeviceDescriptor,
    session_id: SessionId,
) -> Result<Arc<ReservedP2pSession>, String> {
    let device_id = peer.device_id.to_string();
    let session_id_text = session_id.to_string();
    {
        let active = state
            .active_p2p_sessions
            .lock()
            .map_err(|_| "remote P2P state poisoned".to_string())?;
        if active.contains_key(&session_id_text) {
            return Err("remote transport session is already active".to_string());
        }
        if active.len() >= MAX_ACTIVE_P2P_SESSIONS {
            return Err("too many active remote transport sessions".to_string());
        }
    }
    // A brokered peer must not shadow, or be shadowed by, a paired one.
    if p2p_device_is_compute(state, &device_id)? {
        return Err(
            "a paired compute device cannot be brokered as an Image Assist peer".to_string(),
        );
    }
    if with_store(state, |store| {
        Ok(store.devices.iter().any(|device| device.id == device_id))
    })? {
        return Err("a paired device cannot be brokered as an Image Assist peer".to_string());
    }

    let identity = desktop_identity(state)?;
    let local_id = identity.descriptor.device_id;
    let context = SessionKeyContext::new(session_id, local_id, peer.device_id)
        .map_err(|error| format!("cannot derive image assist transport context: {error}"))?;
    let key = identity
        .agreement_key
        .derive_session_key(&peer.key_agreement_public_key, &context)
        .map_err(|error| format!("cannot derive image assist transport key: {error}"))?;
    let incoming = SessionRoute::new(session_id, peer.device_id, local_id);
    let wire = Arc::new(RemoteWireSession::new(
        device_id.clone(),
        TransportKind::P2p,
        key,
        incoming,
    )?);
    let session = Arc::new(ReservedP2pSession {
        device_id: device_id.clone(),
        session_id,
        wire,
        established: AtomicBool::new(false),
        received_ice_candidates: AtomicUsize::new(0),
    });
    {
        let mut active = state
            .active_p2p_sessions
            .lock()
            .map_err(|_| "remote P2P state poisoned".to_string())?;
        if active.contains_key(&session_id_text) {
            return Err("remote transport session is already active".to_string());
        }
        active.insert(session_id_text.clone(), session.clone());
    }
    if let Err(error) = register_image_assist_session(
        state,
        &session_id_text,
        ImageAssistSession {
            device_id,
            match_id: match_id.to_string(),
            peer,
        },
    ) {
        remove_p2p_session(state, &session.device_id, &session_id_text);
        return Err(error);
    }
    Ok(session)
}

/// Arms the bounded negotiation timeout for an Image Assist direct attempt.
///
/// Both desktops call this after approval. The transition is idempotent, so a
/// timeout racing a browser failure still produces at most one relay request.
pub(crate) fn schedule_image_assist_p2p_expiry(app: AppHandle, session: Arc<ReservedP2pSession>) {
    schedule_p2p_attempt_expiry(app, session);
}

/// Tears down a brokered transport session and forgets the peer.
pub(crate) fn release_image_assist_p2p_session(state: &RemoteAgentState, session_id: &str) {
    if let Ok(mut shutdowns) = state.image_assist_relay_shutdowns.lock() {
        if let Some(shutdown) = shutdowns.remove(session_id) {
            let _ = shutdown.send(true);
        }
    }
    let device_id = state
        .image_assist_sessions
        .lock()
        .ok()
        .and_then(|sessions| {
            sessions
                .get(session_id)
                .map(|entry| entry.device_id.clone())
        });
    if let Some(device_id) = device_id {
        remove_p2p_session(state, &device_id, session_id);
    }
    remove_image_assist_session(state, session_id);
}

/// Starts the encrypted WSS relay fallback for a brokered Image Assist match.
/// The relay session uses the same gateway-minted identifier and key context
/// as the direct attempt, but never enters the paired-device store.
pub(crate) fn start_image_assist_relay_session(
    app: &AppHandle,
    state: &RemoteAgentState,
    peer: DeviceDescriptor,
    session_id: SessionId,
    match_id: &str,
) -> Result<(), String> {
    let session = reserve_image_assist_relay_session(state, match_id, peer, session_id)?;
    let mut global_shutdown = state
        .transport_shutdown
        .lock()
        .map_err(|_| "remote transport state poisoned".to_string())?
        .as_ref()
        .map(|sender| sender.subscribe())
        .ok_or_else(|| "remote transport is not running".to_string())?;
    let (local_shutdown, mut local_shutdown_rx) = watch::channel(false);
    state
        .image_assist_relay_shutdowns
        .lock()
        .map_err(|_| "image assist relay state poisoned".to_string())?
        .insert(session_id.to_string(), local_shutdown);
    let (combined_shutdown, combined_shutdown_rx) = watch::channel(false);
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = global_shutdown.changed() => {}
            _ = local_shutdown_rx.changed() => {}
        }
        let _ = combined_shutdown.send(true);
    });
    tauri::async_runtime::spawn(run_relay_session(
        app.clone(),
        session,
        combined_shutdown_rx,
    ));
    Ok(())
}

fn reserve_image_assist_relay_session(
    state: &RemoteAgentState,
    match_id: &str,
    peer: DeviceDescriptor,
    session_id: SessionId,
) -> Result<ReservedRelaySession, String> {
    let device_id = peer.device_id.to_string();
    let session_id_text = session_id.to_string();
    let active_key = format!("image-assist:{match_id}:{session_id_text}");
    {
        let mut active = state
            .active_relay_sessions
            .lock()
            .map_err(|_| "remote relay state poisoned".to_string())?;
        if active.len() >= MAX_ACTIVE_RELAY_SESSIONS || !active.insert(active_key.clone()) {
            return Err("remote relay session is already active or the relay is busy".to_string());
        }
    }
    let result = (|| {
        let identity = desktop_identity(state)?;
        let context =
            SessionKeyContext::new(session_id, identity.descriptor.device_id, peer.device_id)
                .map_err(|error| format!("cannot derive image assist relay context: {error}"))?;
        let key = identity
            .agreement_key
            .derive_session_key(&peer.key_agreement_public_key, &context)
            .map_err(|error| format!("cannot derive image assist relay key: {error}"))?;
        let incoming = SessionRoute::new(session_id, peer.device_id, identity.descriptor.device_id);
        let wire = Arc::new(RemoteWireSession::new(
            device_id.clone(),
            TransportKind::TcpRelay,
            key,
            incoming,
        )?);
        let session = ReservedRelaySession {
            active_key: active_key.clone(),
            device_id: device_id.clone(),
            session_id,
            wire,
            image_assist_match_id: Some(match_id.to_string()),
        };
        register_image_assist_session(
            state,
            &session_id_text,
            ImageAssistSession {
                device_id,
                match_id: match_id.to_string(),
                peer,
            },
        )?;
        Ok(session)
    })();
    if result.is_err() {
        if let Ok(mut active) = state.active_relay_sessions.lock() {
            active.remove(&active_key);
        }
    }
    result
}

#[allow(dead_code, reason = "called by the match state machine on close")]
pub(crate) fn remove_image_assist_session(state: &RemoteAgentState, session_id: &str) {
    if let Ok(mut sessions) = state.image_assist_sessions.lock() {
        sessions.remove(session_id);
    }
}

fn image_assist_session(
    state: &RemoteAgentState,
    device_id: &str,
    session_id: &str,
) -> Result<Option<ImageAssistSession>, String> {
    let sessions = state
        .image_assist_sessions
        .lock()
        .map_err(|_| "image assist session state poisoned".to_string())?;
    let Some(session) = sessions.get(session_id) else {
        return Ok(None);
    };
    if session.device_id != device_id {
        return Err("image assist device does not match the transport session".to_string());
    }
    Ok(Some(session.clone()))
}

/// Decides which protocol owns one incoming P2P frame.
///
/// A brokered session is matched on both device and transport session, so a
/// stranger cannot present a session id that belongs to someone else. Note that
/// the fall-through arm is [`P2pFrameRoute::Control`]: an unknown peer would
/// otherwise have its frames dispatched as an Agent `ControlRequest`, which is
/// exactly why the Image Assist arm must be evaluated first and must return.
pub(crate) fn classify_p2p_frame(
    state: &RemoteAgentState,
    device_id: &str,
    session_id: &str,
) -> Result<P2pFrameRoute, String> {
    if image_assist_session(state, device_id, session_id)?.is_some() {
        return Ok(P2pFrameRoute::ImageAssist);
    }
    if p2p_device_is_compute(state, device_id)? {
        return Ok(P2pFrameRoute::Compute);
    }
    Ok(P2pFrameRoute::Control)
}

fn p2p_device_is_compute(state: &RemoteAgentState, device_id: &str) -> Result<bool, String> {
    let store = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?;
    Ok(store.devices.iter().any(|device| {
        device.id == device_id
            && device.revoked_at.is_none()
            && device.scopes.contains(&DeviceScope::ComputeJobs)
            && device
                .descriptor
                .as_ref()
                .is_some_and(|descriptor| descriptor.kind == DeviceKind::ComputeNode)
    }))
}

fn ensure_remote_compute_p2p_channel(
    app: &AppHandle,
    state: &RemoteAgentState,
    session: &Arc<ReservedP2pSession>,
) -> Result<mpsc::UnboundedSender<ComputeWireMessage>, String> {
    if let Some(sender) = state
        .compute_channels
        .lock()
        .map_err(|_| "remote compute channel state poisoned".to_string())?
        .get(&session.device_id)
        .filter(|channel| channel.session_id == session.session_id.to_string())
        .map(|channel| channel.sender.clone())
    {
        return Ok(sender);
    }

    let (sender, mut receiver) = mpsc::unbounded_channel::<ComputeWireMessage>();
    let session_id = session.session_id.to_string();
    state
        .compute_channels
        .lock()
        .map_err(|_| "remote compute channel state poisoned".to_string())?
        .insert(
            session.device_id.clone(),
            RemoteComputeChannel {
                session_id: session_id.clone(),
                transport: "p2p_webrtc",
                sender: sender.clone(),
            },
        );
    crate::compute::peer_connected(app, &session.device_id, &session_id, "p2p_webrtc");

    let output_app = app.clone();
    let output_session = Arc::clone(session);
    tauri::async_runtime::spawn(async move {
        while let Some(message) = receiver.recv().await {
            let Ok(envelope) = output_session.wire.seal_compute(&message) else {
                break;
            };
            let Ok(payload) = serde_json::to_vec(&envelope) else {
                break;
            };
            if payload.len() > MAX_RELAY_FRAME_BYTES {
                break;
            }
            if output_app
                .emit(
                    "remote-p2p-frame",
                    RemoteP2pDataInput {
                        device_id: output_session.device_id.clone(),
                        session_id: output_session.session_id.to_string(),
                        data_base64: STANDARD.encode(payload),
                    },
                )
                .is_err()
            {
                break;
            }
        }
    });
    let _ = sender.send(ComputeWireMessage::Capabilities {
        request_id: format!("webrtc-handshake-{session_id}"),
    });
    Ok(sender)
}

/// Creates one managed invitation that may be scanned by a phone or pasted on
/// another computer. First use returns a dedicated endpoint credential kept
/// only in the OS keyring; an account login is not required.
#[tauri::command]
pub async fn remote_control_create_invitation(
    app: AppHandle,
    state: State<'_, RemoteAgentState>,
) -> Result<RemoteInvitationResultView, String> {
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
            match start_pairing(app.clone(), state).await {
                Ok(pairing) => pairing,
                Err(retry_error)
                    if gateway_rejected_desktop_identity(&retry_error, &gateway_url) =>
                {
                    if !previous_was_enabled {
                        restore_remote_store(state, previous);
                    }
                    return Err(IDENTITY_RESET_REQUIRED.to_string());
                }
                Err(retry_error) => {
                    if !previous_was_enabled {
                        restore_remote_store(state, previous);
                    }
                    return Err(retry_error);
                }
            }
        }
        // A desktop left in that collided state by an earlier attempt fails
        // here on every subsequent click, without a 401 to precede it.
        Err(error) if gateway_rejected_desktop_identity(&error, &gateway_url) => {
            if !previous_was_enabled {
                restore_remote_store(state, previous);
            }
            return Err(IDENTITY_RESET_REQUIRED.to_string());
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
    Ok(RemoteInvitationResultView { status, pairing })
}

/// Renames this computer as it appears to every paired device and on the web.
///
/// The name was previously decided once, by detection, and could never be
/// corrected — so installs that predate host-name detection all showed the
/// same placeholder. The gateway is updated in the same call: its copy is what
/// the account's web surfaces read, so a purely local rename would not show up
/// anywhere the owner is actually looking.
#[tauri::command]
pub async fn remote_control_set_device_name(
    state: State<'_, RemoteAgentState>,
    device_name: String,
) -> Result<RemoteControlStatus, String> {
    let state = state.inner();
    let name = normalized_system_desktop_name(&device_name)
        .ok_or_else(|| "device name must be 1-120 bytes of printable text".to_string())?;
    let status = with_store(state, |store| {
        store.device_name = Some(name.clone());
        Ok(status_from_store(store))
    })?;
    if let Ok(gateway_url) = configured_gateway_url(state) {
        announce_account_ownership(&gateway_url, Some(name)).await;
    }
    Ok(status)
}

/// Discards this desktop's remote identity and enrolls a new one.
///
/// The counterpart to [`IDENTITY_RESET_REQUIRED`]: the caller must have shown
/// the user what is lost and obtained consent, because every existing pairing
/// is discarded and no backup of the old identity is kept.
#[tauri::command]
pub async fn remote_control_reset_identity(
    app: AppHandle,
    state: State<'_, RemoteAgentState>,
) -> Result<RemoteInvitationResultView, String> {
    let state = state.inner();
    let gateway_url = gateway_url_for_identity_reset(state)?;
    stop_transport(&app, state);
    rotate_desktop_identity(state, &gateway_url)?;
    let pairing = start_pairing(app.clone(), state).await?;
    let status = {
        let store = state
            .store
            .lock()
            .map_err(|_| "remote agent state poisoned".to_string())?;
        status_from_store(&store)
    };
    Ok(RemoteInvitationResultView { status, pairing })
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
    app: AppHandle,
    state: State<RemoteAgentState>,
) -> Result<RemoteP2pPendingSnapshot, String> {
    let mut snapshot = pending_p2p_snapshot(&state)?;
    snapshot.starts = crate::compute::claimed_p2p_starts(&app);
    snapshot
        .starts
        .extend(crate::image_assist::brokered_p2p_starts(state.inner()));
    snapshot.answers = crate::compute::claimed_p2p_answers(&app);
    snapshot
        .candidates
        .extend(crate::compute::claimed_p2p_candidates(&app));
    snapshot
        .ice_completes
        .extend(crate::compute::claimed_p2p_ice_completes(&app));
    Ok(snapshot)
}

/// Sends the browser-generated WebRTC offer for a claimed computer node or a
/// brokered Image Assist match.
/// Mobile sessions remain offerer-owned and never use this desktop command.
#[tauri::command]
pub fn remote_control_p2p_offer(
    app: AppHandle,
    state: State<RemoteAgentState>,
    input: RemoteP2pOfferInput,
) -> Result<(), String> {
    let offer = TransportSignal::WebrtcOffer {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        sdp: input.sdp,
    };
    // The gateway makes the helper the offerer, and a brokered helper has no
    // claimed compute session to signal through. Classified rather than
    // inferred from a lookup failure, so the paired path keeps its exact
    // behavior.
    if classify_p2p_frame(&state, &input.device_id, &input.session_id)?
        == P2pFrameRoute::ImageAssist
    {
        let _session = p2p_session(&state, &input.device_id, &input.session_id)?;
        return queue_gateway_signal(&state, &input.device_id, &input.session_id, offer);
    }
    crate::compute::claimed_p2p_signal(&app, &input.device_id, &input.session_id, offer)
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
    app: AppHandle,
    state: State<RemoteAgentState>,
    input: RemoteP2pIceCandidateInput,
) -> Result<(), String> {
    let signal = TransportSignal::WebrtcIceCandidate {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        candidate: input.candidate,
        sdp_mid: input.sdp_mid,
        sdp_m_line_index: input.sdp_m_line_index,
        username_fragment: input.username_fragment,
    };
    if p2p_session(&state, &input.device_id, &input.session_id).is_ok() {
        queue_gateway_signal(&state, &input.device_id, &input.session_id, signal)
    } else {
        crate::compute::claimed_p2p_signal(&app, &input.device_id, &input.session_id, signal)
    }
}

/// Tells the mobile peer that the desktop WebRTC implementation has gathered
/// all currently available candidates. It does not claim that a data channel
/// has opened.
#[tauri::command]
pub fn remote_control_p2p_ice_complete(
    app: AppHandle,
    state: State<RemoteAgentState>,
    input: RemoteP2pSessionInput,
) -> Result<(), String> {
    let signal = TransportSignal::WebrtcIceComplete {
        protocol_version: CURRENT_PROTOCOL_VERSION,
    };
    if p2p_session(&state, &input.device_id, &input.session_id).is_ok() {
        queue_gateway_signal(&state, &input.device_id, &input.session_id, signal)
    } else {
        crate::compute::claimed_p2p_signal(&app, &input.device_id, &input.session_id, signal)
    }
}

/// Marks a successfully opened data channel so the negotiation-timeout task
/// cannot remove a live session. The encrypted-frame command also performs
/// this mark as a defensive backstop.
#[tauri::command]
pub fn remote_control_p2p_opened(
    app: AppHandle,
    state: State<RemoteAgentState>,
    input: RemoteP2pSessionInput,
) -> Result<(), String> {
    if let Ok(session) = p2p_session(&state, &input.device_id, &input.session_id) {
        session.established.store(true, Ordering::SeqCst);
        discard_pending_p2p_negotiation(&state, &input.session_id);
        // A brokered channel opens with the signed match transcript and nothing
        // else. Classified first, so a stranger's channel never reaches the
        // compute path below.
        if classify_p2p_frame(&state, &input.device_id, &input.session_id)?
            == P2pFrameRoute::ImageAssist
        {
            return crate::image_assist::brokered_channel_opened(
                &app,
                &state,
                &input.device_id,
                &input.session_id,
                session.wire.clone(),
            );
        }
        if p2p_device_is_compute(&state, &input.device_id)? {
            ensure_remote_compute_p2p_channel(&app, &state, &session)?;
        }
        Ok(())
    } else {
        crate::compute::claimed_p2p_opened(&app, &input.device_id, &input.session_id)
    }
}

/// Terminates the desktop half of a P2P attempt. For Image Assist, this
/// releases the failed ID and lets the requester ask the gateway for its fresh
/// relay session; paired sessions keep their existing signaling behavior.
#[tauri::command]
pub fn remote_control_p2p_failed(
    app: AppHandle,
    state: State<RemoteAgentState>,
    input: RemoteP2pFailureInput,
) -> Result<(), String> {
    if crate::image_assist::brokered_direct_failed(&app, state.inner(), &input.session_id)? {
        let _ = app.emit(
            "remote-p2p-failed",
            RemoteP2pSessionInput {
                device_id: input.device_id,
                session_id: input.session_id,
            },
        );
        return Ok(());
    }
    if crate::compute::claimed_p2p_failed(&app, &input.device_id, &input.session_id, input.reason)?
    {
        return Ok(());
    }
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
    unregister_compute_channel(&state, &input.device_id, &input.session_id);
    crate::compute::peer_disconnected(&app, &input.device_id, &input.session_id);
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
) -> Result<(), String> {
    if input.data_base64.len() > MAX_P2P_BASE64_FRAME_BYTES {
        return Err("encrypted P2P frame exceeds the maximum size".to_string());
    }
    let payload = STANDARD
        .decode(input.data_base64.as_bytes())
        .map_err(|_| "encrypted P2P frame is not valid base64".to_string())?;
    if payload.len() > MAX_RELAY_FRAME_BYTES {
        return Err("encrypted P2P frame exceeds the maximum size".to_string());
    }
    let envelope = serde_json::from_slice::<SecureEnvelope>(&payload)
        .map_err(|_| "encrypted P2P frame is invalid".to_string())?;
    // A brokered Image Assist peer is a stranger with no pairing edge and no
    // persisted record, so it must be classified before any general path is
    // tried, including the claimed-compute path below.
    if classify_p2p_frame(&state, &input.device_id, &input.session_id)?
        == P2pFrameRoute::ImageAssist
    {
        let session = p2p_session(&state, &input.device_id, &input.session_id)?;
        session.established.store(true, Ordering::SeqCst);
        discard_pending_p2p_negotiation(&state, &input.session_id);
        let message = session.wire.open_image_assist(&envelope)?;
        crate::image_assist::handle_peer_frame(
            app,
            input.device_id,
            input.session_id,
            message,
            session.wire.clone(),
        );
        return Ok(());
    }
    if crate::compute::claimed_p2p_frame(&app, &input.device_id, &input.session_id, &envelope)? {
        return Ok(());
    }
    let session = p2p_session(&state, &input.device_id, &input.session_id)?;
    session.established.store(true, Ordering::SeqCst);
    discard_pending_p2p_negotiation(&state, &input.session_id);
    if p2p_device_is_compute(&state, &input.device_id)? {
        let sender = ensure_remote_compute_p2p_channel(&app, &state, &session)?;
        let message = session.wire.open_compute(&envelope)?;
        crate::compute::handle_peer_message(app, input.device_id, message, sender);
        return Ok(());
    }
    let dispatch_lock = Arc::new(Mutex::new(()));
    let stream_dispatch_lock = dispatch_lock.clone();
    let stream_wire = session.wire.clone();
    let stream_app = app.clone();
    let stream_device_id = input.device_id.clone();
    let stream_session_id = input.session_id.clone();
    let stream_sink: ControlResponseSink = Arc::new(move |response| {
        let result = stream_dispatch_lock
            .lock()
            .map_err(|_| "remote response dispatch state poisoned".to_string())
            .and_then(|_guard| encode_remote_control_response(&stream_wire, &response));
        let Ok(payload) = result else {
            return;
        };
        let _ = stream_app.emit(
            "remote-p2p-frame",
            RemoteP2pDataInput {
                device_id: stream_device_id.clone(),
                session_id: stream_session_id.clone(),
                data_base64: STANDARD.encode(payload),
            },
        );
    });
    // The renderer owns only the browser WebRTC object. Once a bounded frame
    // has crossed into Rust, release the Tauri invoke immediately and let the
    // background task own request execution. Progress and the terminal frame
    // use the same ordered event path back to the data channel.
    let worker_app = app.clone();
    let worker_wire = session.wire.clone();
    let terminal_app = app;
    let terminal_wire = session.wire.clone();
    let terminal_device_id = input.device_id;
    let terminal_session_id = input.session_id;
    tauri::async_runtime::spawn(async move {
        let state = worker_app.state::<RemoteAgentState>();
        let response = worker_wire
            .handle_envelope(
                worker_app.clone(),
                state.inner(),
                &envelope,
                Some(stream_sink),
            )
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                eprintln!("SomniQ desktop: rejected an encrypted P2P control frame: {error}");
                remove_p2p_session(state.inner(), &terminal_device_id, &terminal_session_id);
                let _ = worker_app.emit(
                    "remote-p2p-failed",
                    RemoteP2pSessionInput {
                        device_id: terminal_device_id,
                        session_id: terminal_session_id,
                    },
                );
                return;
            }
        };
        let encoded = dispatch_lock
            .lock()
            .map_err(|_| "remote response dispatch state poisoned".to_string())
            .and_then(|_guard| encode_remote_control_response(&terminal_wire, &response));
        let Ok(encoded) = encoded else {
            return;
        };
        let _ = terminal_app.emit(
            "remote-p2p-frame",
            RemoteP2pDataInput {
                device_id: terminal_device_id,
                session_id: terminal_session_id,
                data_base64: STANDARD.encode(encoded),
            },
        );
    });
    Ok(())
}

/// Removes local P2P session state when a browser WebRTC data channel closes.
/// A direct Image Assist close is a failed P2P attempt: the requester asks the
/// gateway for the relay fallback, while paired sessions keep their existing
/// close behavior.
#[tauri::command]
pub fn remote_control_p2p_closed(
    app: AppHandle,
    state: State<RemoteAgentState>,
    input: RemoteP2pSessionInput,
) -> Result<(), String> {
    if crate::image_assist::brokered_direct_failed(&app, state.inner(), &input.session_id)? {
        return Ok(());
    }
    if crate::compute::claimed_p2p_closed(&app, &input.device_id, &input.session_id) {
        return Ok(());
    }
    let _session = p2p_session(&state, &input.device_id, &input.session_id)?;
    remove_p2p_session(&state, &input.device_id, &input.session_id);
    unregister_compute_channel(&state, &input.device_id, &input.session_id);
    crate::compute::peer_disconnected(&app, &input.device_id, &input.session_id);
    Ok(())
}

#[allow(dead_code)]
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

fn authenticated_request_scopes(
    app: &AppHandle,
    state: &RemoteAgentState,
    device_id: &str,
) -> Result<DeviceScopes, String> {
    let is_remote_store_device = state
        .store
        .lock()
        .map_err(|_| "remote agent state poisoned".to_string())?
        .devices
        .iter()
        .any(|device| device.id == device_id);
    if is_remote_store_device {
        authenticated_device_scopes(state, device_id)
    } else {
        crate::compute::claimed_peer_scopes(app, device_id)
    }
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
    session_id: &str,
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
    let cancelled = Arc::new(AtomicBool::new(false));
    entries.push(RemoteChatIdempotencyEntry {
        device_id: device_id.to_string(),
        project_id: project_id.to_string(),
        session_id: session_id.to_string(),
        idempotency_key: idempotency_key.to_string(),
        request_digest: request_digest.to_string(),
        message_id: message_id.clone(),
        created_at: now,
        completed_text: None,
        cancelled: cancelled.clone(),
    });
    Ok(RemoteChatReservation::New {
        message_id,
        cancelled,
    })
}

fn complete_remote_chat_idempotency(
    state: &RemoteAgentState,
    device_id: &str,
    project_id: &str,
    idempotency_key: &str,
    request_digest: &str,
    text: String,
) -> Result<RemoteChatTerminalDecision, ControlError> {
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
    if entry.cancelled.load(Ordering::SeqCst) {
        return Ok(RemoteChatTerminalDecision::Cancelled);
    }
    entry.completed_text = Some(text);
    Ok(RemoteChatTerminalDecision::Completed)
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

/// Mark only the paired device's own in-flight chat message as cancelled.
/// The message id is generated by the desktop and never maps to an arbitrary
/// local process or another phone's request.
fn request_remote_chat_cancellation(
    state: &RemoteAgentState,
    device_id: &str,
    project_id: &str,
    session_id: &str,
    message_id: &str,
) -> Result<bool, ControlError> {
    let now = now_epoch_millis();
    let mut entries = state
        .chat_idempotency
        .lock()
        .map_err(|_| ControlError::Internal)?;
    entries
        .retain(|entry| now.saturating_sub(entry.created_at) <= REMOTE_CHAT_IDEMPOTENCY_TTL_MILLIS);
    let entry = entries
        .iter_mut()
        .find(|entry| {
            entry.device_id == device_id
                && entry.project_id == project_id
                && entry.session_id == session_id
                && entry.message_id == message_id
        })
        .ok_or(ControlError::NotFound)?;
    let active = entry.completed_text.is_none();
    if active {
        entry.cancelled.store(true, Ordering::SeqCst);
    }
    Ok(active)
}

/// Mark every incomplete paired-device chat turn as cancelled.
///
/// Project pause is a local, user-authorized lifecycle boundary. Unlike the
/// device-scoped StopChatMessage command, it intentionally applies to all
/// active paired turns so no provider request can keep running after the
/// project is paused.
pub(crate) fn cancel_all_active_chat_messages(state: &RemoteAgentState) {
    if let Ok(entries) = state.chat_idempotency.lock() {
        for entry in entries
            .iter()
            .filter(|entry| entry.completed_text.is_none())
        {
            entry.cancelled.store(true, Ordering::SeqCst);
        }
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

fn remote_chat_session_created_result(
    app: &AppHandle,
    project_id: String,
) -> Result<ControlResult, ControlError> {
    ensure_remote_chat_project(app, &project_id)?;
    let created = crate::engine::remote_chat_session_create(&project_id).map_err(|_| {
        ControlError::TemporarilyUnavailable {
            retry_after_ms: Some(1_000),
        }
    })?;
    let session = ChatSessionSummary {
        session_id: created.id,
        title: created.title,
        updated_at_unix_ms: created.updated_at_unix_ms,
        model: created.model,
    };
    if let Err(error) = app.emit(
        "remote-chat-session-updated",
        serde_json::json!({
            "sessionId": &session.session_id,
            "phase": "created",
        }),
    ) {
        eprintln!("SomniQ remote: could not notify the desktop about a new chat: {error}");
    }
    Ok(ControlResult::ChatSessionCreated {
        project_id,
        session,
    })
}

/// Stop the active paired-device turn identified by the desktop-issued message
/// id. The encrypted control command is deliberately narrower than the legacy
/// `StopRun`: a phone cannot use it to interrupt an arbitrary local process.
fn remote_chat_stop_result(
    app: &AppHandle,
    state: &RemoteAgentState,
    device_id: &str,
    project_id: String,
    session_id: String,
    message_id: String,
) -> Result<ControlResult, ControlError> {
    ensure_remote_chat_project(app, &project_id)?;
    let active =
        request_remote_chat_cancellation(state, device_id, &project_id, &session_id, &message_id)?;
    if active {
        let chat_state = app.state::<crate::engine::ChatState>();
        crate::engine::cancel_chat_turn(chat_state.inner(), &session_id)
            .map_err(|_| ControlError::Internal)?;
    }
    Ok(ControlResult::ChatMessageStopRequested {
        project_id,
        session_id,
        message_id,
    })
}

/// Unblocks a desktop turn that is waiting on an `AskUserQuestion` tool call.
///
/// The phone already sees the question through the ordinary visible event
/// stream; this only delivers the label it chose. The engine re-checks that
/// the blocked call belongs to `session_id`, so a paired device cannot answer
/// a question raised by a conversation it is not viewing.
fn remote_chat_question_answer_result(
    app: &AppHandle,
    project_id: String,
    session_id: String,
    tool_use_id: String,
    answer: String,
) -> Result<ControlResult, ControlError> {
    ensure_remote_chat_project(app, &project_id)?;
    let chat_state = app.state::<crate::engine::ChatState>();
    let delivered = crate::engine::respond_to_chat_question(
        chat_state.inner(),
        &tool_use_id,
        answer,
        Some(&session_id),
    )
    .map_err(|_| ControlError::Internal)?;
    if !delivered {
        // The question may have been answered on the desktop, cancelled, or
        // belong to another conversation. A stale answer is a conflict, not a
        // fault, and the phone re-reads the turn's real state from its stream.
        return Err(ControlError::Conflict);
    }
    Ok(ControlResult::ChatQuestionAnswered {
        project_id,
        session_id,
        tool_use_id,
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
            blocks: message.blocks,
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

fn remote_chat_delta_text(payload: &str, session_id: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(payload).ok()?;
    let object = value.as_object()?;
    if object.get("sessionId")?.as_str()? != session_id {
        return None;
    }
    let delta = object.get("text")?.as_str()?;
    (!delta.is_empty()).then(|| delta.to_string())
}

fn remote_chat_event_session(payload: &str) -> Option<String> {
    serde_json::from_str::<Value>(payload)
        .ok()?
        .get("sessionId")?
        .as_str()
        .map(str::to_string)
}

fn remote_chat_user_text(payload: &Value) -> Option<String> {
    let blocks = payload.get("message")?.get("blocks")?.as_array()?;
    let text = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if !text.is_empty() {
        return Some(text);
    }
    blocks
        .iter()
        .any(|block| block.get("type").and_then(Value::as_str) == Some("image"))
        .then(|| "（桌面发送了图片）".to_string())
}

fn truncate_remote_chat_event_text(text: &str, maximum: usize) -> String {
    if text.len() <= maximum {
        return text.to_string();
    }
    let mut end = maximum;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn truncate_remote_chat_tool_output(text: &str) -> String {
    if text.len() <= MAX_REMOTE_CHAT_TOOL_OUTPUT_BYTES {
        return text.to_string();
    }
    let preview_bytes = MAX_REMOTE_CHAT_TOOL_OUTPUT_BYTES
        .saturating_sub(REMOTE_CHAT_TOOL_OUTPUT_TRUNCATION_NOTICE.len());
    format!(
        "{}{}",
        truncate_remote_chat_event_text(text, preview_bytes),
        REMOTE_CHAT_TOOL_OUTPUT_TRUNCATION_NOTICE
    )
}

fn bounded_remote_chat_session_message_event(event: ChatMessageEvent) -> ChatMessageEvent {
    match event {
        ChatMessageEvent::TextDelta { delta } => ChatMessageEvent::TextDelta {
            delta: truncate_remote_chat_event_text(&delta, MAX_REMOTE_CHAT_EVENT_CONTENT_BYTES),
        },
        ChatMessageEvent::ThinkingDelta { delta } => ChatMessageEvent::ThinkingDelta {
            delta: truncate_remote_chat_event_text(&delta, MAX_REMOTE_CHAT_EVENT_CONTENT_BYTES),
        },
        ChatMessageEvent::ToolCall {
            tool_use_id,
            name,
            input,
        } => ChatMessageEvent::ToolCall {
            tool_use_id: tool_use_id.map(|value| {
                truncate_remote_chat_event_text(&value, MAX_REMOTE_CHAT_EVENT_ERROR_BYTES)
            }),
            name: truncate_remote_chat_event_text(&name, MAX_REMOTE_CHAT_EVENT_ERROR_BYTES),
            input: truncate_remote_chat_event_text(&input, MAX_REMOTE_CHAT_TOOL_INPUT_BYTES),
        },
        ChatMessageEvent::ToolProgress {
            tool_use_id,
            name,
            progress,
        } => ChatMessageEvent::ToolProgress {
            tool_use_id: tool_use_id.map(|value| {
                truncate_remote_chat_event_text(&value, MAX_REMOTE_CHAT_EVENT_ERROR_BYTES)
            }),
            name: truncate_remote_chat_event_text(&name, MAX_REMOTE_CHAT_EVENT_ERROR_BYTES),
            progress: ChatToolProgress {
                elapsed_ms: progress.elapsed_ms,
                timeout_ms: progress.timeout_ms,
                pid: progress.pid,
                stdout_tail: progress.stdout_tail.map(|value| {
                    truncate_remote_chat_event_text(&value, MAX_REMOTE_CHAT_EVENT_ERROR_BYTES)
                }),
                stderr_tail: progress.stderr_tail.map(|value| {
                    truncate_remote_chat_event_text(&value, MAX_REMOTE_CHAT_EVENT_ERROR_BYTES)
                }),
                near_timeout: progress.near_timeout,
                message: truncate_remote_chat_event_text(
                    &progress.message,
                    MAX_REMOTE_CHAT_EVENT_ERROR_BYTES,
                ),
            },
        },
        ChatMessageEvent::ToolResult {
            tool_use_id,
            name,
            output,
            is_error,
        } => ChatMessageEvent::ToolResult {
            tool_use_id: tool_use_id.map(|value| {
                truncate_remote_chat_event_text(&value, MAX_REMOTE_CHAT_EVENT_ERROR_BYTES)
            }),
            name: truncate_remote_chat_event_text(&name, MAX_REMOTE_CHAT_EVENT_ERROR_BYTES),
            output: truncate_remote_chat_tool_output(&output),
            is_error,
        },
    }
}

fn remote_chat_review_status(payload: &Value) -> Option<String> {
    let phase = payload.get("phase")?.as_str()?;
    let attempt = payload.get("attempt").and_then(Value::as_u64);
    let max_revisions = payload.get("maxRevisions").and_then(Value::as_u64);
    let round = match (attempt, max_revisions) {
        (Some(attempt), Some(max_revisions)) if attempt > 0 && max_revisions > 0 => {
            format!(" (round {attempt}/{max_revisions})")
        }
        _ => String::new(),
    };
    let status = match phase {
        "reviewing" => format!("Independent review in progress{round}."),
        "result" => "Independent review returned findings; preparing the next step.".to_string(),
        "revising" => "Applying independent-review findings.".to_string(),
        "complete" => "Independent review complete; preparing the final response.".to_string(),
        _ => return None,
    };
    Some(status)
}

fn remote_chat_session_event(
    entry: &crate::chat_events::ChatEventLogEntry,
    session_id: &str,
) -> Option<ChatSessionEvent> {
    match entry.kind.as_str() {
        "user_message" => Some(ChatSessionEvent::UserMessage {
            seq: entry.seq,
            text: truncate_remote_chat_event_text(
                &remote_chat_user_text(&entry.payload)?,
                MAX_REMOTE_CHAT_EVENT_CONTENT_BYTES,
            ),
        }),
        "assistant_delta"
        | "assistant_thinking_delta"
        | "tool_call"
        | "tool_progress"
        | "tool_result" => {
            let kind = match entry.kind.as_str() {
                "assistant_delta" => "text_delta",
                "assistant_thinking_delta" => "thinking_delta",
                "tool_call" => "tool_call",
                "tool_progress" => "tool_progress",
                "tool_result" => "tool_result",
                _ => unreachable!(),
            };
            let payload = serde_json::json!({
                "sessionId": session_id,
                "kind": kind,
                "payload": &entry.payload,
            })
            .to_string();
            Some(ChatSessionEvent::Assistant {
                seq: entry.seq,
                event: bounded_remote_chat_session_message_event(remote_chat_render_event(
                    &payload, session_id,
                )?),
            })
        }
        "done" => Some(ChatSessionEvent::Done {
            seq: entry.seq,
            text: truncate_remote_chat_event_text(
                entry
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                MAX_REMOTE_CHAT_EVENT_CONTENT_BYTES,
            ),
        }),
        "error" => Some(ChatSessionEvent::Error {
            seq: entry.seq,
            message: truncate_remote_chat_event_text(
                entry
                    .payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Desktop Chat failed."),
                MAX_REMOTE_CHAT_EVENT_ERROR_BYTES,
            ),
        }),
        // The full review payload may include private evidence and internal
        // instructions. Remote clients receive only an activity-style status
        // so a long independent review is visibly alive without widening the
        // paired-device data surface.
        "independent_review" => Some(ChatSessionEvent::Assistant {
            seq: entry.seq,
            event: ChatMessageEvent::ThinkingDelta {
                delta: remote_chat_review_status(&entry.payload)?,
            },
        }),
        "reset" => Some(ChatSessionEvent::Reset { seq: entry.seq }),
        _ => None,
    }
}

fn remote_chat_event_batch(
    entries: &[crate::chat_events::ChatEventLogEntry],
    session_id: &str,
    after_seq: Option<u64>,
    limit: u16,
) -> (Vec<ChatSessionEvent>, u64) {
    let last_seq = entries.last().map(|entry| entry.seq).unwrap_or_default();
    let (start_index, mut next_seq) = if let Some(after_seq) = after_seq {
        (
            entries.partition_point(|entry| entry.seq <= after_seq),
            after_seq,
        )
    } else {
        let latest_turn_start = entries
            .iter()
            .rposition(|entry| entry.kind == "user_message");
        match latest_turn_start {
            Some(index)
                if !entries[index + 1..]
                    .iter()
                    .any(|entry| entry.kind == "reset") =>
            {
                // Reconcile the latest turn even when it has already reached
                // a terminal event. Otherwise a very fast desktop response
                // can finish between transcript loading and subscription.
                (
                    index,
                    entries[..index]
                        .last()
                        .map(|entry| entry.seq)
                        .unwrap_or_default(),
                )
            }
            _ => return (Vec::new(), last_seq),
        }
    };

    let mut events = Vec::new();
    let mut event_bytes = 0usize;
    for entry in &entries[start_index..] {
        if let Some(event) = remote_chat_session_event(entry, session_id) {
            // `limit` is the requested number of visible events. Durable
            // session snapshots are intentionally invisible to the paired
            // device, so they must not consume the page and strand `done`
            // behind an empty reconnect response.
            if events.len() >= usize::from(limit) {
                break;
            }
            let serialized_bytes =
                serde_json::to_vec(&event).map_or(usize::MAX, |value| value.len());
            if serialized_bytes > MAX_REMOTE_CHAT_EVENT_BATCH_BYTES.saturating_sub(event_bytes) {
                break;
            }
            event_bytes = event_bytes.saturating_add(serialized_bytes);
            events.push(event);
        }
        // Invisible entries (for example permission prompts) still advance
        // the durable cursor without exposing their content to the phone.
        next_seq = entry.seq;
    }
    (events, next_seq)
}

fn remote_chat_events_snapshot(
    project_id: &str,
    session_id: &str,
    after_seq: Option<u64>,
    limit: u16,
) -> Result<ControlResult, ControlError> {
    let entries = crate::engine::remote_chat_session_events(project_id, session_id)
        .map_err(|_| ControlError::NotFound)?;
    let (events, next_seq) = remote_chat_event_batch(&entries, session_id, after_seq, limit);
    Ok(ControlResult::ChatEvents {
        project_id: project_id.to_string(),
        session_id: session_id.to_string(),
        events,
        next_seq,
    })
}

async fn remote_chat_events_result(
    app: &AppHandle,
    project_id: String,
    session_id: String,
    after_seq: Option<u64>,
    limit: u16,
    wait_ms: u32,
) -> Result<ControlResult, ControlError> {
    ensure_remote_chat_project(app, &project_id)?;
    crate::engine::remote_chat_session_validate(&project_id, &session_id)
        .map_err(|_| ControlError::NotFound)?;

    let (wake_tx, mut wake_rx) = mpsc::channel::<()>(1);
    let mut listeners = Vec::new();
    if after_seq.is_some() && wait_ms > 0 {
        for event_name in [
            "chat-user-message-recorded",
            "chat-delta",
            "chat-thinking-delta",
            "chat-tool",
            "chat-tool-progress",
            "chat-tool-result",
            "chat-review",
            "chat-done",
            "chat-error",
        ] {
            let wake_tx = wake_tx.clone();
            let target_session_id = session_id.clone();
            listeners.push(app.listen_any(event_name, move |event| {
                if remote_chat_event_session(event.payload()).as_deref()
                    == Some(target_session_id.as_str())
                {
                    let _ = wake_tx.try_send(());
                }
            }));
        }
    }

    let initial = remote_chat_events_snapshot(&project_id, &session_id, after_seq, limit);
    let should_wait = matches!(
        (&initial, after_seq),
        (
            Ok(ControlResult::ChatEvents {
                events,
                next_seq,
                ..
            }),
            Some(after_seq)
        ) if events.is_empty() && *next_seq == after_seq && wait_ms > 0
    );
    let result = if should_wait {
        let _ = timeout(Duration::from_millis(u64::from(wait_ms)), wake_rx.recv()).await;
        // Coalesce token-sized provider events into one encrypted response.
        tokio::time::sleep(Duration::from_millis(35)).await;
        remote_chat_events_snapshot(&project_id, &session_id, after_seq, limit)
    } else {
        initial
    };
    for listener in listeners {
        app.unlisten(listener);
    }
    result
}

fn remote_chat_activity(payload: &str, session_id: &str) -> Option<ChatMessageActivity> {
    let value = serde_json::from_str::<Value>(payload).ok()?;
    let object = value.as_object()?;
    if object.get("sessionId")?.as_str()? != session_id {
        return None;
    }
    match object.get("activity")?.as_str()? {
        "preparing" => Some(ChatMessageActivity::Preparing),
        "compacting" => Some(ChatMessageActivity::Compacting),
        "thinking" => Some(ChatMessageActivity::Thinking),
        "tool" => Some(ChatMessageActivity::Tool),
        _ => None,
    }
}

fn remote_chat_render_event(payload: &str, session_id: &str) -> Option<ChatMessageEvent> {
    let value = serde_json::from_str::<Value>(payload).ok()?;
    let object = value.as_object()?;
    if object.get("sessionId")?.as_str()? != session_id {
        return None;
    }
    let kind = object.get("kind")?.as_str()?;
    let event = object.get("payload")?.as_object()?;
    if event.get("sessionId")?.as_str()? != session_id {
        return None;
    }
    let tool_use_id = || {
        event
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
    };
    match kind {
        "text_delta" => Some(ChatMessageEvent::TextDelta {
            delta: event.get("text")?.as_str()?.to_string(),
        }),
        "thinking_delta" => Some(ChatMessageEvent::ThinkingDelta {
            delta: event.get("thinking")?.as_str()?.to_string(),
        }),
        "tool_call" => Some(ChatMessageEvent::ToolCall {
            tool_use_id: tool_use_id(),
            name: event.get("name")?.as_str()?.to_string(),
            input: event.get("input")?.as_str()?.to_string(),
        }),
        "tool_progress" => Some(ChatMessageEvent::ToolProgress {
            tool_use_id: tool_use_id(),
            name: event.get("name")?.as_str()?.to_string(),
            progress: ChatToolProgress {
                elapsed_ms: event.get("elapsedMs")?.as_u64()?,
                timeout_ms: event.get("timeoutMs").and_then(Value::as_u64),
                pid: event
                    .get("pid")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok()),
                stdout_tail: event
                    .get("stdoutTail")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                stderr_tail: event
                    .get("stderrTail")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                near_timeout: event
                    .get("nearTimeout")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                message: event
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            },
        }),
        "tool_result" => Some(ChatMessageEvent::ToolResult {
            tool_use_id: tool_use_id(),
            name: event.get("name")?.as_str()?.to_string(),
            output: event.get("output")?.as_str()?.to_string(),
            is_error: event.get("isError")?.as_bool()?,
        }),
        _ => None,
    }
}

fn remote_chat_was_cancelled(cancelled: &AtomicBool, error: &str) -> bool {
    cancelled.load(Ordering::SeqCst) || error.trim().eq_ignore_ascii_case("interrupted by user")
}

fn bounded_remote_chat_delta(delta: String, delivered_bytes: &mut usize) -> Vec<String> {
    bounded_remote_chat_stream_text(delta, delivered_bytes, MAX_REMOTE_CHAT_STREAM_BYTES)
}

fn bounded_remote_chat_stream_text(
    delta: String,
    delivered_bytes: &mut usize,
    maximum_bytes: usize,
) -> Vec<String> {
    let remaining = maximum_bytes.saturating_sub(*delivered_bytes);
    if remaining == 0 || delta.is_empty() {
        return Vec::new();
    }
    let limit = delta.len().min(remaining);
    let mut end = limit;
    while end > 0 && !delta.is_char_boundary(end) {
        end -= 1;
    }
    if end == 0 {
        return Vec::new();
    }

    let visible = &delta[..end];
    let mut fragments = Vec::with_capacity((visible.len() / MAX_REMOTE_CHAT_DELTA_BYTES) + 1);
    let mut start = 0;
    while start < visible.len() {
        let mut fragment_end = (start + MAX_REMOTE_CHAT_DELTA_BYTES).min(visible.len());
        while fragment_end > start && !visible.is_char_boundary(fragment_end) {
            fragment_end -= 1;
        }
        if fragment_end == start {
            break;
        }
        fragments.push(visible[start..fragment_end].to_string());
        start = fragment_end;
    }
    *delivered_bytes += start;
    fragments
}

fn bounded_remote_chat_render_events(
    event: ChatMessageEvent,
    delivered_text_bytes: &mut usize,
    delivered_rich_bytes: &mut usize,
) -> Vec<ChatMessageEvent> {
    match event {
        ChatMessageEvent::TextDelta { delta } => {
            bounded_remote_chat_delta(delta, delivered_text_bytes)
                .into_iter()
                .map(|delta| ChatMessageEvent::TextDelta { delta })
                .collect()
        }
        ChatMessageEvent::ThinkingDelta { delta } => bounded_remote_chat_stream_text(
            delta,
            delivered_rich_bytes,
            MAX_REMOTE_CHAT_RICH_STREAM_BYTES,
        )
        .into_iter()
        .map(|delta| ChatMessageEvent::ThinkingDelta { delta })
        .collect(),
        event => {
            let event_bytes = serde_json::to_vec(&event).map_or(usize::MAX, |value| value.len());
            let remaining = MAX_REMOTE_CHAT_RICH_STREAM_BYTES.saturating_sub(*delivered_rich_bytes);
            if event_bytes > remaining {
                Vec::new()
            } else {
                *delivered_rich_bytes = (*delivered_rich_bytes).saturating_add(event_bytes);
                vec![event]
            }
        }
    }
}

async fn execute_remote_chat_message(
    app: &AppHandle,
    state: &RemoteAgentState,
    device_id: &str,
    request_id: RequestId,
    transport: String,
    project_id: String,
    session_id: String,
    message: String,
    idempotency_key: String,
    rich_stream: bool,
    stream_sink: Option<ControlResponseSink>,
) -> Result<ControlResult, ControlError> {
    ensure_remote_chat_project(app, &project_id)?;
    crate::engine::remote_chat_session_validate(&project_id, &session_id)
        .map_err(|_| ControlError::NotFound)?;
    let request_digest = remote_chat_request_digest(&session_id, &message);
    let (message_id, cancelled) = match reserve_remote_chat_idempotency(
        state,
        device_id,
        &project_id,
        &session_id,
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
        RemoteChatReservation::New {
            message_id,
            cancelled,
        } => (message_id, cancelled),
    };

    // Long tool-enabled turns may outlive the synchronous mobile response
    // timeout. Record their receipt before entering the chat runtime so the
    // local audit can distinguish an in-flight request from one that never
    // reached the desktop.
    let started_audit = RemoteAuditEntry {
        timestamp: now_epoch_millis(),
        device_id: device_id.to_string(),
        request_id: request_id.to_string(),
        action: "send_chat_message".to_string(),
        transport,
        project_id: Some(project_id.clone()),
        outcome: "started".to_string(),
        error_code: None,
    };
    if let Err(error) = append_audit(state, &started_audit) {
        eprintln!("SomniQ remote audit write failed: {error}");
    }

    let _ = app.emit(
        "remote-chat-session-updated",
        serde_json::json!({
            "sessionId": &session_id,
            "messageId": &message_id,
            "phase": "started",
            "message": &message,
            "desktopMirrored": true,
        }),
    );
    if let Some(sink) = stream_sink.as_ref() {
        sink(ControlResponse::success(
            request_id,
            protocol_now_millis(),
            ControlResult::ChatMessageAccepted {
                project_id: project_id.clone(),
                message_id: message_id.clone(),
            },
        ));
    }

    let delta_app = app.clone();
    let delta_sink = if rich_stream {
        None
    } else {
        stream_sink.clone()
    };
    let delta_project_id = project_id.clone();
    let delta_session_id = session_id.clone();
    let delta_message_id = message_id.clone();
    let delivered_delta_bytes = Arc::new(Mutex::new(0_usize));
    let delta_delivered_bytes = delivered_delta_bytes.clone();
    let last_activity = Arc::new(Mutex::new(None::<ChatMessageActivity>));
    let delta_last_activity = last_activity.clone();
    let delta_listener = app.listen_any("remote-chat-delta", move |event| {
        let Some(delta) = remote_chat_delta_text(event.payload(), &delta_session_id) else {
            return;
        };
        let deltas = if delta_sink.is_some() {
            delta_delivered_bytes
                .lock()
                .ok()
                .map(|mut delivered| bounded_remote_chat_delta(delta, &mut *delivered))
                .unwrap_or_default()
        } else {
            vec![delta]
        };
        if deltas.is_empty() {
            return;
        }
        if let Ok(mut activity) = delta_last_activity.lock() {
            *activity = None;
        }
        for delta in deltas {
            if let Some(sink) = delta_sink.as_ref() {
                sink(ControlResponse::success(
                    request_id,
                    protocol_now_millis(),
                    ControlResult::ChatMessageDelta {
                        project_id: delta_project_id.clone(),
                        session_id: delta_session_id.clone(),
                        message_id: delta_message_id.clone(),
                        delta: delta.clone(),
                    },
                ));
            }
            let _ = delta_app.emit(
                "remote-chat-session-updated",
                serde_json::json!({
                    "sessionId": &delta_session_id,
                    "messageId": &delta_message_id,
                    "phase": "delta",
                    "delta": delta,
                    "desktopMirrored": true,
                }),
            );
        }
    });

    let activity_app = app.clone();
    // Activity frames carry the pre-execution stages (preparing/compacting)
    // that do not have a corresponding rich render event. Rich clients still
    // receive the ordered thinking/tool blocks separately.
    let activity_sink = stream_sink.clone();
    let activity_project_id = project_id.clone();
    let activity_session_id = session_id.clone();
    let activity_message_id = message_id.clone();
    let activity_last = last_activity.clone();
    let activity_listener = app.listen_any("remote-chat-activity", move |event| {
        let Some(activity) = remote_chat_activity(event.payload(), &activity_session_id) else {
            return;
        };
        let should_deliver = activity_last
            .lock()
            .map(|mut last| {
                if *last == Some(activity) {
                    false
                } else {
                    *last = Some(activity);
                    true
                }
            })
            .unwrap_or(false);
        if !should_deliver {
            return;
        }
        if let Some(sink) = activity_sink.as_ref() {
            sink(ControlResponse::success(
                request_id,
                protocol_now_millis(),
                ControlResult::ChatMessageActivity {
                    project_id: activity_project_id.clone(),
                    session_id: activity_session_id.clone(),
                    message_id: activity_message_id.clone(),
                    activity,
                },
            ));
        }
        let activity = match activity {
            ChatMessageActivity::Preparing => "preparing",
            ChatMessageActivity::Compacting => "compacting",
            ChatMessageActivity::Thinking => "thinking",
            ChatMessageActivity::Tool => "tool",
        };
        let _ = activity_app.emit(
            "remote-chat-session-updated",
            serde_json::json!({
                "sessionId": &activity_session_id,
                "messageId": &activity_message_id,
                "phase": "activity",
                "activity": activity,
                "desktopMirrored": true,
            }),
        );
    });

    let rich_listener = if rich_stream {
        let rich_sink = stream_sink.clone();
        let rich_project_id = project_id.clone();
        let rich_session_id = session_id.clone();
        let rich_message_id = message_id.clone();
        let rich_delivered_text_bytes = delivered_delta_bytes.clone();
        let delivered_rich_bytes = Arc::new(Mutex::new(0_usize));
        Some(app.listen_any("remote-chat-render-event", move |event| {
            let Some(render_event) = remote_chat_render_event(event.payload(), &rich_session_id)
            else {
                return;
            };
            let render_events = match (
                rich_delivered_text_bytes.lock(),
                delivered_rich_bytes.lock(),
            ) {
                (Ok(mut delivered_text), Ok(mut delivered_rich)) => {
                    bounded_remote_chat_render_events(
                        render_event,
                        &mut delivered_text,
                        &mut delivered_rich,
                    )
                }
                _ => Vec::new(),
            };
            let Some(sink) = rich_sink.as_ref() else {
                return;
            };
            for event in render_events {
                sink(ControlResponse::success(
                    request_id,
                    protocol_now_millis(),
                    ControlResult::ChatMessageEvent {
                        project_id: rich_project_id.clone(),
                        session_id: rich_session_id.clone(),
                        message_id: rich_message_id.clone(),
                        event,
                    },
                ));
            }
        }))
    } else {
        None
    };

    let chat_state = app.state::<crate::engine::ChatState>();
    let response = crate::engine::remote_chat_send_paired(
        app.clone(),
        chat_state.inner(),
        session_id.clone(),
        project_id.clone(),
        message.clone(),
        cancelled.clone(),
    )
    .await;
    app.unlisten(delta_listener);
    app.unlisten(activity_listener);
    if let Some(listener) = rich_listener {
        app.unlisten(listener);
    }
    match response {
        Ok(full_text) => {
            // A stop can race a provider's final frame. Prefer the requested
            // cancellation over persisting/sending a late completion.
            if cancelled.load(Ordering::SeqCst) {
                let _ = app.emit(
                    "remote-chat-session-updated",
                    serde_json::json!({
                        "sessionId": &session_id,
                        "messageId": &message_id,
                        "phase": "cancelled",
                        "desktopMirrored": true,
                    }),
                );
                release_remote_chat_idempotency(
                    state,
                    device_id,
                    &project_id,
                    &idempotency_key,
                    &request_digest,
                );
                return Ok(ControlResult::ChatMessageCancelled {
                    project_id,
                    session_id,
                    message_id,
                });
            }
            // The mobile response is independently bounded for the encrypted
            // relay frame. Persist that same visible projection in the Chat
            // UI store so a later phone refresh and the desktop sidebar agree
            // on what was delivered. Existing visible thinking/tool blocks
            // saved by the ordinary desktop renderer are preserved.
            let text = truncate_remote_chat_response(full_text);
            match complete_remote_chat_idempotency(
                state,
                device_id,
                &project_id,
                &idempotency_key,
                &request_digest,
                text.clone(),
            )? {
                // Completion and Stop contend on the same idempotency lock.
                // If Stop reached that lock first, never persist or emit a
                // late completion after the phone was told it was stopping.
                RemoteChatTerminalDecision::Cancelled => {
                    let _ = app.emit(
                        "remote-chat-session-updated",
                        serde_json::json!({
                            "sessionId": &session_id,
                            "messageId": &message_id,
                            "phase": "cancelled",
                            "desktopMirrored": true,
                        }),
                    );
                    release_remote_chat_idempotency(
                        state,
                        device_id,
                        &project_id,
                        &idempotency_key,
                        &request_digest,
                    );
                    return Ok(ControlResult::ChatMessageCancelled {
                        project_id,
                        session_id,
                        message_id,
                    });
                }
                RemoteChatTerminalDecision::Completed => {}
            }
            let persisted = match crate::sessions::remote_chat_append_text_turn(
                &project_id,
                &session_id,
                &message_id,
                &message,
                &text,
            ) {
                Ok(()) => true,
                // Never turn an already-completed model request into an error:
                // doing so would invite a user retry with a new idempotency
                // key and duplicate the turn in the model's durable context.
                Err(error) => {
                    eprintln!(
                        "SomniQ remote: could not persist the completed remote chat UI projection: {error}"
                    );
                    false
                }
            };
            if let Err(error) = app.emit(
                "remote-chat-session-updated",
                serde_json::json!({
                    "sessionId": &session_id,
                    "messageId": &message_id,
                    "phase": "completed",
                    "text": &text,
                    "persisted": persisted,
                    "desktopMirrored": true,
                }),
            ) {
                eprintln!(
                    "SomniQ remote: could not notify the desktop chat UI after a remote turn: {error}"
                );
            }
            Ok(ControlResult::ChatMessageCompleted {
                project_id,
                session_id,
                message_id,
                text,
            })
        }
        Err(error) => {
            if remote_chat_was_cancelled(&cancelled, &error) {
                let _ = app.emit(
                    "remote-chat-session-updated",
                    serde_json::json!({
                        "sessionId": &session_id,
                        "messageId": &message_id,
                        "phase": "cancelled",
                        "desktopMirrored": true,
                    }),
                );
                release_remote_chat_idempotency(
                    state,
                    device_id,
                    &project_id,
                    &idempotency_key,
                    &request_digest,
                );
                return Ok(ControlResult::ChatMessageCancelled {
                    project_id,
                    session_id,
                    message_id,
                });
            }
            let _ = app.emit(
                "remote-chat-session-updated",
                serde_json::json!({
                    "sessionId": &session_id,
                    "messageId": &message_id,
                    "phase": "error",
                    "error": &error,
                    "desktopMirrored": true,
                }),
            );
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
/// Remote chat can emit bounded accepted/delta progress for opted-in clients,
/// followed by one authoritative final response. It runs with the selected
/// session's local tool and permission policy; its bounded visible projection
/// is mirrored live and persisted at completion.
pub(crate) async fn execute_control_request(
    app: AppHandle,
    state: &RemoteAgentState,
    context: RemoteRequestContext,
    request: ControlRequest,
    stream_sink: Option<ControlResponseSink>,
) -> ControlResponse {
    let action = match &request.command {
        ControlCommand::GetWorkspaceOverview => "workspace_overview",
        ControlCommand::SetActiveProject { .. } => "set_active_project",
        ControlCommand::GetProjectSummary { .. } => "project_summary",
        ControlCommand::GetTaskTimeline { .. } => "task_timeline",
        ControlCommand::ListChatSessions { .. } => "list_chat_sessions",
        ControlCommand::CreateChatSession { .. } => "create_chat_session",
        ControlCommand::GetChatTranscript { .. } => "get_chat_transcript",
        ControlCommand::GetChatEvents { .. } => "get_chat_events",
        ControlCommand::GetChatModelOptions { .. } => "get_chat_model_options",
        ControlCommand::SetChatSessionModel { .. } => "set_chat_session_model",
        ControlCommand::SendChatMessage { .. } => "send_chat_message",
        ControlCommand::StopChatMessage { .. } => "stop_chat_message",
        ControlCommand::AnswerChatQuestion { .. } => "answer_chat_question",
        ControlCommand::StopRun { .. } => "stop_run",
        ControlCommand::GetReviewConclusion { .. } => "review_conclusion",
    };
    let project_id = active_project_id(&app).ok();
    let result = match authenticated_request_scopes(&app, state, &context.device_id) {
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
        Ok(scopes)
            if scopes.contains(DeviceScope::ComputeJobs)
                && matches!(
                    request.command.required_scope(),
                    DeviceScope::ReadProjectState | DeviceScope::SendChatMessages
                )
                && !crate::compute::remote_agent_requests_enabled(&app).unwrap_or(false) =>
        {
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
                let projects = app.state::<crate::projects::ProjectState>();
                match crate::projects::switch_registered_project(
                    projects.inner(),
                    &requested,
                    chat_state.inner(),
                )
                .await
                {
                    Err(error) if error == "project not found" => Err(ControlError::NotFound),
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
            ControlCommand::CreateChatSession { project_id } => {
                remote_chat_session_created_result(&app, project_id)
            }
            ControlCommand::GetChatTranscript {
                project_id,
                session_id,
                limit,
            } => remote_chat_transcript_result(&app, project_id, session_id, limit),
            ControlCommand::GetChatEvents {
                project_id,
                session_id,
                after_seq,
                limit,
                wait_ms,
            } => {
                remote_chat_events_result(&app, project_id, session_id, after_seq, limit, wait_ms)
                    .await
            }
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
                stream,
                rich_stream,
            } => {
                execute_remote_chat_message(
                    &app,
                    state,
                    &context.device_id,
                    request.request_id,
                    context.transport.clone(),
                    project_id,
                    session_id,
                    message,
                    idempotency_key,
                    rich_stream,
                    if stream { stream_sink.clone() } else { None },
                )
                .await
            }
            ControlCommand::StopChatMessage {
                project_id,
                session_id,
                message_id,
            } => remote_chat_stop_result(
                &app,
                state,
                &context.device_id,
                project_id,
                session_id,
                message_id,
            ),
            ControlCommand::AnswerChatQuestion {
                project_id,
                session_id,
                tool_use_id,
                answer,
            } => remote_chat_question_answer_result(
                &app,
                project_id,
                session_id,
                tool_use_id,
                answer,
            ),
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
