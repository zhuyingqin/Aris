use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use compute::{
    ComputeJobEvent, ComputeJobEventPayload, ComputeJobId, ComputeJobRecord, ComputeJobRequest,
    ComputeJobStatus, ComputeJobStore, ComputeLogStream, ComputeNodeCapabilities,
    ComputeResultManifest, ComputeRunner, ComputeTarget, ComputeWorkload, WorkerIdentity,
};
use futures_util::{SinkExt, StreamExt};
use keyring::{Entry as KeyringEntry, Error as KeyringError};
use remote_protocol::{
    Base64UrlBytes, ChatMessageEvent, ComputeWireMessage, ControlCommand, ControlError,
    ControlRequest, ControlResponse, ControlResponseOutcome, ControlResult, DeviceDescriptor,
    DeviceId, DeviceKind, DeviceScope, DeviceScopes, DeviceSigningKey, KeyAgreementSecret,
    P2pFailureReason, PairingInvitation, PairingRequest, SecureEnvelope, SessionId,
    SessionKeyContext, SessionRoute, TransportKind, TransportSignal,
    COMPUTE_MAX_ARTIFACT_CHUNK_BYTES, CURRENT_PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest,
        http::header::{HeaderValue, AUTHORIZATION},
        protocol::WebSocketConfig,
        Message,
    },
};

use crate::projects::{self, ProjectState};

pub const COMPUTE_JOB_EVENT: &str = "compute-job-event";
pub const COMPUTE_PEER_EVENT: &str = "compute-peer-event";
const COMPUTE_DIR: &str = "compute";
const NODE_CONFIG_FILE: &str = "compute-node.json";
const PEER_STORE_FILE: &str = "compute-peers.json";
const COMPUTE_KEYRING_SERVICE: &str = "SomniQ Studio Compute Nodes";
const DEFAULT_MAX_PARALLEL_JOBS: usize = 2;
const MAX_COMPUTE_TRANSPORT_FRAME_BYTES: usize = 262_144;
const COMPUTE_P2P_NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_COMPUTE_P2P_ICE_CANDIDATES: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeNodeConfig {
    pub node_id: DeviceId,
    pub display_name: String,
    pub accept_remote_jobs: bool,
    #[serde(default)]
    pub accept_remote_agent_chats: bool,
    pub max_parallel_jobs: usize,
}

impl Default for ComputeNodeConfig {
    fn default() -> Self {
        Self {
            node_id: DeviceId::new(),
            display_name: default_node_name(),
            accept_remote_jobs: false,
            accept_remote_agent_chats: false,
            max_parallel_jobs: DEFAULT_MAX_PARALLEL_JOBS,
        }
    }
}

pub struct ComputeState {
    config: Mutex<ComputeNodeConfig>,
    cancellations: Mutex<HashMap<ComputeJobId, Arc<AtomicBool>>>,
    peers: Mutex<ComputePeerStore>,
    pending_pairings: Mutex<HashMap<String, PendingComputePairing>>,
    peer_channels: Mutex<HashMap<String, ComputePeerChannel>>,
    claimed_p2p_sessions: Mutex<HashMap<String, Arc<ClaimedComputeP2pSession>>>,
    started_peers: Mutex<BTreeSet<String>>,
    transport_shutdown: Mutex<Option<watch::Sender<bool>>>,
    incoming_bundles: Mutex<HashMap<String, IncomingBundle>>,
    incoming_artifacts: Mutex<HashMap<String, IncomingArtifact>>,
    coordinator_jobs: Mutex<HashMap<ComputeJobId, PathBuf>>,
    peer_capabilities: Mutex<HashMap<String, ComputeNodeCapabilities>>,
    pending_agent_responses: Mutex<HashMap<String, PendingAgentResponse>>,
    active_agent_turns: Mutex<HashMap<String, ActiveRemoteAgentTurn>>,
}

impl Default for ComputeState {
    fn default() -> Self {
        Self {
            config: Mutex::new(ComputeNodeConfig::default()),
            cancellations: Mutex::new(HashMap::new()),
            peers: Mutex::new(load_peer_store()),
            pending_pairings: Mutex::new(HashMap::new()),
            peer_channels: Mutex::new(HashMap::new()),
            claimed_p2p_sessions: Mutex::new(HashMap::new()),
            started_peers: Mutex::new(BTreeSet::new()),
            transport_shutdown: Mutex::new(None),
            incoming_bundles: Mutex::new(HashMap::new()),
            incoming_artifacts: Mutex::new(HashMap::new()),
            coordinator_jobs: Mutex::new(HashMap::new()),
            peer_capabilities: Mutex::new(HashMap::new()),
            pending_agent_responses: Mutex::new(HashMap::new()),
            active_agent_turns: Mutex::new(HashMap::new()),
        }
    }
}

struct PendingAgentResponse {
    node_id: String,
    sender: mpsc::UnboundedSender<ControlResponse>,
}

#[derive(Debug, Clone)]
struct ActiveRemoteAgentTurn {
    node_id: String,
    project_id: String,
    remote_session_id: String,
    message_id: Option<String>,
    cancel_requested: bool,
}

struct ComputePeerChannel {
    session_id: String,
    sender: mpsc::UnboundedSender<ComputeWireMessage>,
}

struct ClaimedComputeP2pSession {
    peer_id: String,
    session_id: String,
    wire: Arc<crate::remote::RemoteWireSession>,
    signal_sender: mpsc::UnboundedSender<TransportSignal>,
    ready_sender: mpsc::UnboundedSender<bool>,
    done_sender: mpsc::UnboundedSender<()>,
    close_sender: watch::Sender<bool>,
    outbound_sender: mpsc::UnboundedSender<ComputeWireMessage>,
    outbound_receiver: Mutex<Option<mpsc::UnboundedReceiver<ComputeWireMessage>>>,
    ice_servers: Vec<String>,
    start_pending: AtomicBool,
    established: AtomicBool,
    pending_answer: Mutex<Option<crate::remote::RemoteP2pAnswerEvent>>,
    pending_candidates: Mutex<Vec<crate::remote::RemoteP2pIceCandidateEvent>>,
    ice_complete: AtomicBool,
}

struct IncomingBundle {
    path: PathBuf,
    expected_size: u64,
    expected_sha256: String,
    complete: bool,
}

struct IncomingArtifact {
    path: PathBuf,
    expected_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputePeerEvent {
    pub node_id: String,
    pub connected: bool,
    pub transport: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComputePeerStore {
    #[serde(default = "peer_store_version")]
    version: u32,
    #[serde(default)]
    peers: Vec<ComputePeerRecord>,
}

impl Default for ComputePeerStore {
    fn default() -> Self {
        Self {
            version: peer_store_version(),
            peers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComputePeerRecord {
    peer_id: DeviceId,
    display_name: String,
    gateway_url: String,
    #[serde(default = "default_compute_ice_servers")]
    ice_servers: Vec<String>,
    local_device_id: DeviceId,
    desktop: DeviceDescriptor,
    #[serde(default = "legacy_compute_scopes")]
    granted_scopes: DeviceScopes,
    paired_at_unix_ms: i64,
    last_seen_at_unix_ms: Option<i64>,
    last_transport: Option<String>,
}

#[derive(Debug)]
struct PendingComputePairing {
    invitation: PairingInvitation,
    local_device_id: DeviceId,
    local_descriptor: DeviceDescriptor,
    signing_secret: [u8; 32],
    agreement_secret: [u8; 32],
    claim_id: String,
    activation_token: String,
    completion_expires_at_unix_ms: i64,
    ice_servers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputePeerView {
    pub node_id: String,
    pub display_name: String,
    pub gateway_url: String,
    pub connected: bool,
    pub transport: Option<String>,
    pub paired_at_unix_ms: i64,
    pub last_seen_at_unix_ms: Option<i64>,
    pub direction: &'static str,
    pub agent_chat_authorized: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputePairingClaimView {
    pub pairing_id: String,
    pub desktop_name: String,
    pub status: &'static str,
    pub completion_expires_at_unix_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputePairingClaimInput {
    pub pairing_link: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentProjectView {
    pub project_id: String,
    pub title: String,
    pub phase: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentWorkspaceView {
    pub node_id: String,
    pub node_name: String,
    pub projects: Vec<RemoteAgentProjectView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentSessionView {
    pub node_id: String,
    pub node_name: String,
    pub project_id: String,
    pub project_name: String,
    pub session_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentSessionCreateInput {
    pub node_id: String,
    pub project_id: String,
    pub project_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentChatInput {
    pub node_id: String,
    pub local_session_id: String,
    pub project_id: String,
    pub remote_session_id: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct GatewayClaimResponse {
    claim_id: String,
    activation_token: String,
    completion_expires_at_unix_ms: i64,
    #[serde(default)]
    ice_servers: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct GatewayCompleteResponse {
    status: String,
    device: GatewayCompleteDevice,
    credential_kind: String,
}

#[derive(Debug, Deserialize)]
struct GatewayCompleteDevice {
    id: DeviceId,
    granted_scopes: DeviceScopes,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ComputeGatewaySignalFrame {
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
        payload: serde_json::Value,
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

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ComputeGatewaySignalOutbound<'a> {
    Signal {
        to: &'a str,
        session_id: &'a str,
        payload: TransportSignal,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ComputeGatewayRelayFrame {
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

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ComputeGatewayRelayOpen<'a> {
    Open {
        peer_id: &'a str,
        session_id: &'a str,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeSubmitInput {
    pub display_name: String,
    pub workload: ComputeWorkload,
    #[serde(default)]
    pub working_directory: String,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub artifact_globs: Vec<String>,
    pub timeout_secs: Option<u64>,
    pub max_output_bytes: Option<u64>,
    pub max_artifact_bytes: Option<u64>,
    pub target_node_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeEventsInput {
    pub job_id: ComputeJobId,
    #[serde(default)]
    pub after_sequence: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeLogInput {
    pub job_id: ComputeJobId,
    pub stream: ComputeLogStream,
    #[serde(default)]
    pub offset: u64,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeLogOutput {
    pub text: String,
    pub next_offset: u64,
}

pub fn init(app: AppHandle, state: &ComputeState, projects: &ProjectState) -> Result<(), String> {
    let config = load_or_create_node_config()?;
    *state
        .config
        .lock()
        .map_err(|_| "compute node config lock poisoned".to_string())? = config;
    *state
        .peers
        .lock()
        .map_err(|_| "compute peer store lock poisoned".to_string())? = load_peer_store();
    let store = store_for(projects)?;
    let recovered = store
        .recover_interrupted()
        .map_err(|error| error.to_string())?;
    if !recovered.is_empty() {
        eprintln!(
            "SomniQ compute: marked {} interrupted job(s) as lost",
            recovered.len()
        );
    }
    let workspace = projects::current_project_path(projects)?;
    for record in store.list().map_err(|error| error.to_string())? {
        if !record.status.is_terminal() && matches!(record.target, ComputeTarget::Remote { .. }) {
            state
                .coordinator_jobs
                .lock()
                .map_err(|_| "compute coordinator state poisoned".to_string())?
                .insert(record.request.job_id, workspace.clone());
        }
    }
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    *state
        .transport_shutdown
        .lock()
        .map_err(|_| "compute transport state poisoned".to_string())? = Some(shutdown_tx);
    let peers = state
        .peers
        .lock()
        .map_err(|_| "compute peer store lock poisoned".to_string())?
        .peers
        .clone();
    for peer in peers {
        start_claimed_peer_transport(app.clone(), peer, shutdown_rx.clone());
    }
    Ok(())
}

#[tauri::command]
pub fn compute_peers_list(app: AppHandle) -> Result<Vec<ComputePeerView>, String> {
    let state = app.state::<ComputeState>();
    let peers = state
        .peers
        .lock()
        .map_err(|_| "compute peer store lock poisoned".to_string())?;
    let claimed_channels = state
        .peer_channels
        .lock()
        .map_err(|_| "compute peer channel state poisoned".to_string())?;
    let mut views = peers
        .peers
        .iter()
        .map(|peer| ComputePeerView {
            node_id: peer.peer_id.to_string(),
            display_name: peer.display_name.clone(),
            gateway_url: peer.gateway_url.clone(),
            connected: claimed_channels.contains_key(&peer.peer_id.to_string()),
            transport: claimed_channels
                .contains_key(&peer.peer_id.to_string())
                .then(|| peer.last_transport.clone())
                .flatten(),
            paired_at_unix_ms: peer.paired_at_unix_ms,
            last_seen_at_unix_ms: peer.last_seen_at_unix_ms,
            direction: "claimed",
            agent_chat_authorized: peer.granted_scopes.contains(DeviceScope::ReadProjectState)
                && peer.granted_scopes.contains(DeviceScope::SendChatMessages),
        })
        .collect::<Vec<_>>();
    drop(claimed_channels);
    drop(peers);
    let remote_state = app.state::<crate::remote::RemoteAgentState>();
    for descriptor in crate::remote::paired_compute_devices(remote_state.inner())? {
        let node_id = descriptor.device_id.to_string();
        if views.iter().any(|peer| peer.node_id == node_id) {
            continue;
        }
        let transport = crate::remote::compute_device_transport(remote_state.inner(), &node_id)?;
        let scopes = crate::remote::compute_device_scopes(remote_state.inner(), &node_id)?;
        views.push(ComputePeerView {
            connected: crate::remote::compute_device_connected(remote_state.inner(), &node_id)?,
            node_id,
            display_name: descriptor.display_name,
            gateway_url: "managed".to_string(),
            transport,
            paired_at_unix_ms: 0,
            last_seen_at_unix_ms: None,
            direction: "invited",
            agent_chat_authorized: scopes.contains(DeviceScope::ReadProjectState)
                && scopes.contains(DeviceScope::SendChatMessages),
        });
    }
    Ok(views)
}

#[tauri::command]
pub async fn compute_pairing_claim(
    state: State<'_, ComputeState>,
    input: ComputePairingClaimInput,
) -> Result<ComputePairingClaimView, String> {
    let invitation = decode_pairing_link(&input.pairing_link)?;
    invitation
        .validate_at(now_unix_ms())
        .map_err(|error| format!("invalid computer pairing invitation: {error}"))?;
    let config = state
        .config
        .lock()
        .map_err(|_| "compute node config lock poisoned".to_string())?
        .clone();
    let local_device_id = DeviceId::new();
    let signing_key = DeviceSigningKey::generate();
    let agreement_key = KeyAgreementSecret::generate();
    let local_descriptor = DeviceDescriptor::new(
        local_device_id,
        DeviceKind::ComputeNode,
        config.display_name,
        signing_key.public_key(),
        agreement_key.public_key(),
    )
    .map_err(|error| format!("cannot create compute-node identity: {error}"))?;
    let pairing_request = PairingRequest::signed(
        &invitation,
        local_descriptor.clone(),
        DeviceScopes::from([
            DeviceScope::ComputeJobs,
            DeviceScope::ReadProjectState,
            DeviceScope::SendChatMessages,
        ]),
        now_unix_ms(),
        &signing_key,
    )
    .map_err(|error| format!("cannot sign compute-node pairing request: {error}"))?;
    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/v1/pairings/{}/claims",
            invitation.gateway_url.trim_end_matches('/'),
            invitation.pairing_id
        ))
        .json(&pairing_request)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("cannot reach compute pairing gateway: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "compute pairing gateway rejected the request ({})",
            response.status()
        ));
    }
    let claim: GatewayClaimResponse = response
        .json()
        .await
        .map_err(|error| format!("invalid compute pairing response: {error}"))?;
    let pairing_id = invitation.pairing_id.to_string();
    let view = ComputePairingClaimView {
        pairing_id: pairing_id.clone(),
        desktop_name: invitation.desktop.display_name.clone(),
        status: "awaiting_approval",
        completion_expires_at_unix_ms: claim.completion_expires_at_unix_ms,
    };
    state
        .pending_pairings
        .lock()
        .map_err(|_| "compute pairing state poisoned".to_string())?
        .insert(
            pairing_id,
            PendingComputePairing {
                invitation,
                local_device_id,
                local_descriptor,
                signing_secret: signing_key.to_bytes(),
                agreement_secret: agreement_key.to_bytes(),
                claim_id: claim.claim_id,
                activation_token: claim.activation_token,
                completion_expires_at_unix_ms: claim.completion_expires_at_unix_ms,
                ice_servers: claim.ice_servers,
            },
        );
    Ok(view)
}

#[tauri::command]
pub async fn compute_pairing_complete(
    app: AppHandle,
    state: State<'_, ComputeState>,
    pairing_id: String,
) -> Result<ComputePairingClaimView, String> {
    let pending = {
        let pending_pairings = state
            .pending_pairings
            .lock()
            .map_err(|_| "compute pairing state poisoned".to_string())?;
        let pending = pending_pairings
            .get(pairing_id.trim())
            .ok_or_else(|| "compute pairing request is no longer pending".to_string())?;
        PendingComputePairing {
            invitation: pending.invitation.clone(),
            local_device_id: pending.local_device_id,
            local_descriptor: pending.local_descriptor.clone(),
            signing_secret: pending.signing_secret,
            agreement_secret: pending.agreement_secret,
            claim_id: pending.claim_id.clone(),
            activation_token: pending.activation_token.clone(),
            completion_expires_at_unix_ms: pending.completion_expires_at_unix_ms,
            ice_servers: pending.ice_servers.clone(),
        }
    };
    if now_unix_ms() >= pending.completion_expires_at_unix_ms {
        return Err("compute pairing approval window expired".to_string());
    }
    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/v1/pairings/{}/claims/{}/complete",
            pending.invitation.gateway_url.trim_end_matches('/'),
            pending.invitation.pairing_id,
            pending.claim_id
        ))
        .bearer_auth(&pending.activation_token)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("cannot reach compute pairing gateway: {error}"))?;
    if response.status().as_u16() == 409 {
        return Ok(ComputePairingClaimView {
            pairing_id,
            desktop_name: pending.invitation.desktop.display_name,
            status: "awaiting_approval",
            completion_expires_at_unix_ms: pending.completion_expires_at_unix_ms,
        });
    }
    if !response.status().is_success() {
        return Err(format!(
            "compute pairing completion was rejected ({})",
            response.status()
        ));
    }
    let completed: GatewayCompleteResponse = response
        .json()
        .await
        .map_err(|error| format!("invalid compute pairing completion: {error}"))?;
    if completed.status != "completed" {
        return Err("compute pairing did not complete".to_string());
    }
    if completed.device.id != pending.local_device_id {
        return Err("compute pairing completed for a different device".to_string());
    }
    if completed.credential_kind != "activation_token" {
        return Err("compute pairing returned an unsupported credential".to_string());
    }
    store_compute_peer_secrets(
        pending.local_device_id,
        &pending.signing_secret,
        &pending.agreement_secret,
        &pending.activation_token,
    )?;
    let record = ComputePeerRecord {
        peer_id: pending.invitation.desktop.device_id,
        display_name: pending.invitation.desktop.display_name.clone(),
        gateway_url: pending.invitation.gateway_url.clone(),
        ice_servers: pending.ice_servers.clone(),
        local_device_id: pending.local_device_id,
        desktop: pending.invitation.desktop,
        granted_scopes: completed.device.granted_scopes,
        paired_at_unix_ms: now_unix_ms(),
        last_seen_at_unix_ms: None,
        last_transport: None,
    };
    {
        let mut peers = state
            .peers
            .lock()
            .map_err(|_| "compute peer store lock poisoned".to_string())?;
        peers.peers.retain(|peer| peer.peer_id != record.peer_id);
        peers.peers.push(record.clone());
        save_peer_store(&peers)?;
    }
    state
        .pending_pairings
        .lock()
        .map_err(|_| "compute pairing state poisoned".to_string())?
        .remove(pairing_id.trim());
    let shutdown = state
        .transport_shutdown
        .lock()
        .map_err(|_| "compute transport state poisoned".to_string())?
        .as_ref()
        .map(watch::Sender::subscribe)
        .unwrap_or_else(|| watch::channel(false).1);
    start_claimed_peer_transport(app, record.clone(), shutdown);
    Ok(ComputePairingClaimView {
        pairing_id,
        desktop_name: record.display_name,
        status: "completed",
        completion_expires_at_unix_ms: pending.completion_expires_at_unix_ms,
    })
}

#[tauri::command]
pub async fn compute_peer_revoke(
    app: AppHandle,
    state: State<'_, ComputeState>,
    node_id: String,
) -> Result<(), String> {
    let peer = state
        .peers
        .lock()
        .map_err(|_| "compute peer store lock poisoned".to_string())?
        .peers
        .iter()
        .find(|peer| peer.peer_id.to_string() == node_id)
        .cloned()
        .ok_or_else(|| "claimed compute peer was not found".to_string())?;
    let token = compute_peer_token(peer.local_device_id)?;
    let response = reqwest::Client::new()
        .delete(format!(
            "{}/v1/devices/self",
            peer.gateway_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("cannot reach compute pairing gateway: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "compute peer revocation was rejected ({})",
            response.status()
        ));
    }
    {
        let mut peers = state
            .peers
            .lock()
            .map_err(|_| "compute peer store lock poisoned".to_string())?;
        peers
            .peers
            .retain(|candidate| candidate.peer_id != peer.peer_id);
        save_peer_store(&peers)?;
    }
    for account in [
        compute_identity_account(peer.local_device_id),
        compute_token_account(peer.local_device_id),
    ] {
        match compute_keyring_entry(&account)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => {
                return Err(format!(
                    "pairing was revoked, but its local credential could not be removed: {error}"
                ));
            }
        }
    }
    remove_claimed_p2p_sessions_for_peer(&app, &node_id, true, true);
    remove_claimed_peer_channel(&app, &node_id, "");
    peer_disconnected(&app, &node_id, "");
    Ok(())
}

fn start_claimed_peer_transport(
    app: AppHandle,
    peer: ComputePeerRecord,
    shutdown: watch::Receiver<bool>,
) {
    let peer_id = peer.peer_id.to_string();
    let state = app.state::<ComputeState>();
    let Ok(mut started) = state.started_peers.lock() else {
        return;
    };
    if !started.insert(peer_id.clone()) {
        return;
    }
    drop(started);
    tauri::async_runtime::spawn(async move {
        let mut shutdown = shutdown;
        let mut retry_delay = Duration::from_secs(1);
        loop {
            if *shutdown.borrow() {
                break;
            }
            let outcome =
                run_claimed_signal_connection(app.clone(), peer.clone(), shutdown.clone()).await;
            let shutting_down = *shutdown.borrow();
            remove_claimed_p2p_sessions_for_peer(
                &app,
                &peer_id,
                true,
                !shutting_down && outcome.is_err(),
            );
            if shutting_down {
                break;
            }
            let still_paired = app.state::<ComputeState>().peers.lock().is_ok_and(|peers| {
                peers
                    .peers
                    .iter()
                    .any(|candidate| candidate.peer_id == peer.peer_id)
            });
            if !still_paired {
                break;
            }
            if outcome.is_err() {
                peer_disconnected(&app, &peer_id, "");
            }
            tokio::select! {
                () = tokio::time::sleep(retry_delay) => {}
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        break;
                    }
                }
            }
            retry_delay = (retry_delay * 2).min(Duration::from_secs(20));
        }
        if let Ok(mut started) = app.state::<ComputeState>().started_peers.lock() {
            started.remove(&peer_id);
        }
    });
}

async fn run_claimed_signal_connection(
    app: AppHandle,
    peer: ComputePeerRecord,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), String> {
    let token = compute_peer_token(peer.local_device_id)?;
    let request = compute_websocket_request(&peer.gateway_url, "/v1/signal", &token)?;
    let (socket, _) = connect_async_with_config(request, Some(compute_websocket_config()), false)
        .await
        .map_err(|_| "cannot connect compute-node signaling channel".to_string())?;
    let (mut sink, mut stream) = socket.split();
    let p2p_session_id = SessionId::new();
    let p2p_session_id_text = p2p_session_id.to_string();
    let peer_id_text = peer.peer_id.to_string();
    let mut p2p_attempted = false;
    let mut p2p_active = false;
    let mut relay_started = false;
    let (p2p_state_tx, mut p2p_state_rx) = mpsc::unbounded_channel::<bool>();
    let (transport_done_tx, mut transport_done_rx) = mpsc::unbounded_channel::<()>();
    let (browser_signal_tx, mut browser_signal_rx) = mpsc::unbounded_channel::<TransportSignal>();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = sink.close().await;
                    return Ok(());
                }
            }
            _ = heartbeat.tick() => {
                sink.send(Message::Ping(Vec::new().into())).await
                    .map_err(|_| "compute signal heartbeat failed".to_string())?;
            }
            Some(payload) = browser_signal_rx.recv(), if p2p_attempted => {
                let outbound = ComputeGatewaySignalOutbound::Signal {
                    to: &peer_id_text,
                    session_id: &p2p_session_id_text,
                    payload,
                };
                sink.send(Message::Text(
                    serde_json::to_string(&outbound)
                        .map_err(|_| "cannot encode compute WebRTC signal".to_string())?
                        .into(),
                ))
                .await
                .map_err(|_| "cannot send compute WebRTC signal".to_string())?;
            }
            Some(accepted) = p2p_state_rx.recv(), if p2p_attempted && !relay_started && !p2p_active => {
                if accepted {
                    p2p_active = true;
                } else {
                    let relay_session_id = SessionId::new();
                    let relay_session_id_text = relay_session_id.to_string();
                    let offer = ComputeGatewaySignalOutbound::Signal {
                        to: &peer_id_text,
                        session_id: &relay_session_id_text,
                        payload: TransportSignal::RelayOffer {
                            protocol_version: CURRENT_PROTOCOL_VERSION,
                        },
                    };
                    sink.send(Message::Text(
                        serde_json::to_string(&offer)
                            .map_err(|_| "cannot encode compute relay offer".to_string())?
                            .into(),
                    ))
                    .await
                    .map_err(|_| "cannot send compute relay offer".to_string())?;
                    relay_started = true;
                    let relay_app = app.clone();
                    let relay_peer = peer.clone();
                    let relay_shutdown = shutdown.clone();
                    let transport_done = transport_done_tx.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = run_claimed_relay(
                            relay_app,
                            relay_peer,
                            relay_session_id,
                            relay_shutdown,
                        )
                        .await;
                        let _ = transport_done.send(());
                    });
                }
            }
            Some(()) = transport_done_rx.recv(), if p2p_active || relay_started => {
                return Err("compute transport disconnected".to_string());
            }
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else {
                    return Err("compute signaling channel closed".to_string());
                };
                match message {
                    Message::Text(text) => {
                        let frame: ComputeGatewaySignalFrame = serde_json::from_str(text.as_str())
                            .map_err(|_| "compute gateway sent an invalid signal frame".to_string())?;
                        match frame {
                            ComputeGatewaySignalFrame::Ready { device_id } => {
                                if device_id != peer.local_device_id.to_string() {
                                    return Err("compute gateway authenticated the wrong node".to_string());
                                }
                                if !p2p_attempted {
                                    reserve_claimed_p2p_session(
                                        &app,
                                        &peer,
                                        p2p_session_id,
                                        browser_signal_tx.clone(),
                                        p2p_state_tx.clone(),
                                        transport_done_tx.clone(),
                                    )?;
                                    p2p_attempted = true;
                                }
                            }
                            ComputeGatewaySignalFrame::Presence { device_id, online } => {
                                if device_id == peer_id_text && !online && (p2p_active || relay_started) {
                                    return Err("paired compute desktop went offline".to_string());
                                }
                            }
                            ComputeGatewaySignalFrame::Signal { from, session_id, payload } => {
                                if from != peer_id_text || session_id != p2p_session_id_text {
                                    continue;
                                }
                                let signal = serde_json::from_value::<TransportSignal>(payload)
                                    .map_err(|_| "compute gateway sent an invalid WebRTC signal".to_string())?;
                                signal.validate()
                                    .map_err(|_| "compute gateway sent an unsafe WebRTC signal".to_string())?;
                                match signal {
                                    TransportSignal::WebrtcAnswer { sdp, .. } => {
                                        let event = crate::remote::RemoteP2pAnswerEvent {
                                            device_id: peer_id_text.clone(),
                                            session_id: p2p_session_id_text.clone(),
                                            sdp,
                                        };
                                        if let Ok(session) = claimed_p2p_session(
                                            &app,
                                            &peer_id_text,
                                            &p2p_session_id_text,
                                        ) {
                                            if let Ok(mut pending) = session.pending_answer.lock() {
                                                *pending = Some(event.clone());
                                            }
                                        }
                                        let _ = app.emit("remote-p2p-answer", event);
                                    }
                                    TransportSignal::WebrtcIceCandidate {
                                        candidate,
                                        sdp_mid,
                                        sdp_m_line_index,
                                        username_fragment,
                                        ..
                                    } => {
                                        let event = crate::remote::RemoteP2pIceCandidateEvent {
                                            device_id: peer_id_text.clone(),
                                            session_id: p2p_session_id_text.clone(),
                                            candidate,
                                            sdp_mid,
                                            sdp_m_line_index,
                                            username_fragment,
                                        };
                                        if let Ok(session) = claimed_p2p_session(
                                            &app,
                                            &peer_id_text,
                                            &p2p_session_id_text,
                                        ) {
                                            if let Ok(mut pending) = session.pending_candidates.lock() {
                                                if pending.len() < MAX_COMPUTE_P2P_ICE_CANDIDATES {
                                                    pending.push(event.clone());
                                                }
                                            }
                                        }
                                        let _ = app.emit("remote-p2p-ice-candidate", event);
                                    }
                                    TransportSignal::WebrtcIceComplete { .. } => {
                                        if let Ok(session) = claimed_p2p_session(
                                            &app,
                                            &peer_id_text,
                                            &p2p_session_id_text,
                                        ) {
                                            session.ice_complete.store(true, Ordering::SeqCst);
                                        }
                                        let _ = app.emit(
                                            "remote-p2p-ice-complete",
                                            crate::remote::RemoteP2pIceCompleteEvent {
                                                device_id: peer_id_text.clone(),
                                                session_id: p2p_session_id_text.clone(),
                                            },
                                        );
                                    }
                                    TransportSignal::P2pFailed { .. } => {
                                        let established = claimed_p2p_session(
                                            &app,
                                            &peer_id_text,
                                            &p2p_session_id_text,
                                        )
                                        .is_ok_and(|session| {
                                            session.established.load(Ordering::SeqCst)
                                        });
                                        remove_claimed_p2p_session(
                                            &app,
                                            &peer_id_text,
                                            &p2p_session_id_text,
                                            established,
                                        );
                                        if !established {
                                            let _ = p2p_state_tx.send(false);
                                        }
                                        let _ = app.emit(
                                            "remote-p2p-failed",
                                            crate::remote::RemoteP2pSessionInput {
                                                device_id: peer_id_text.clone(),
                                                session_id: p2p_session_id_text.clone(),
                                            },
                                        );
                                    }
                                    TransportSignal::DirectTcpOffer { .. }
                                    | TransportSignal::WebrtcOffer { .. }
                                    | TransportSignal::RelayOffer { .. } => {}
                                }
                            }
                            ComputeGatewaySignalFrame::Pong { nonce } => {
                                let _ = nonce;
                            }
                            ComputeGatewaySignalFrame::Error { code, message } => {
                                let _ = (code, message);
                                return Err("compute gateway rejected signaling".to_string());
                            }
                            ComputeGatewaySignalFrame::Revoked { device_id } => {
                                let _ = device_id;
                                return Err("compute-node pairing was revoked".to_string());
                            }
                        }
                    }
                    Message::Ping(payload) => {
                        sink.send(Message::Pong(payload)).await
                            .map_err(|_| "cannot answer compute signal ping".to_string())?;
                    }
                    Message::Close(_) => return Err("compute signaling channel closed".to_string()),
                    Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    }
}

fn claimed_p2p_key(peer_id: &str, session_id: &str) -> String {
    format!("{peer_id}:{session_id}")
}

fn reserve_claimed_p2p_session(
    app: &AppHandle,
    peer: &ComputePeerRecord,
    session_id: SessionId,
    signal_sender: mpsc::UnboundedSender<TransportSignal>,
    ready_sender: mpsc::UnboundedSender<bool>,
    done_sender: mpsc::UnboundedSender<()>,
) -> Result<(), String> {
    let peer_id = peer.peer_id.to_string();
    let session_id_text = session_id.to_string();
    let agreement_key = compute_peer_agreement_key(peer.local_device_id)?;
    let context = SessionKeyContext::new(session_id, peer.peer_id, peer.local_device_id)
        .map_err(|error| format!("cannot derive compute P2P context: {error}"))?;
    let session_key = agreement_key
        .derive_session_key(&peer.desktop.key_agreement_public_key, &context)
        .map_err(|error| format!("cannot derive compute P2P key: {error}"))?;
    let incoming = SessionRoute::new(session_id, peer.peer_id, peer.local_device_id);
    let wire = Arc::new(crate::remote::RemoteWireSession::new(
        peer_id.clone(),
        TransportKind::P2p,
        session_key,
        incoming,
    )?);
    let (outbound_sender, outbound_receiver) = mpsc::unbounded_channel();
    let (close_sender, _) = watch::channel(false);
    let session = Arc::new(ClaimedComputeP2pSession {
        peer_id: peer_id.clone(),
        session_id: session_id_text.clone(),
        wire,
        signal_sender,
        ready_sender,
        done_sender,
        close_sender,
        outbound_sender,
        outbound_receiver: Mutex::new(Some(outbound_receiver)),
        ice_servers: peer.ice_servers.clone(),
        start_pending: AtomicBool::new(true),
        established: AtomicBool::new(false),
        pending_answer: Mutex::new(None),
        pending_candidates: Mutex::new(Vec::new()),
        ice_complete: AtomicBool::new(false),
    });
    let key = claimed_p2p_key(&peer_id, &session_id_text);
    app.state::<ComputeState>()
        .claimed_p2p_sessions
        .lock()
        .map_err(|_| "compute P2P session state poisoned".to_string())?
        .insert(key, Arc::clone(&session));
    let _ = app.emit(
        "remote-p2p-start",
        crate::remote::RemoteP2pStartEvent {
            device_id: peer_id.clone(),
            session_id: session_id_text.clone(),
            ice_servers: peer.ice_servers.clone(),
        },
    );
    let timeout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(COMPUTE_P2P_NEGOTIATION_TIMEOUT).await;
        if !session.established.load(Ordering::SeqCst) {
            let _ = session.signal_sender.send(TransportSignal::P2pFailed {
                protocol_version: CURRENT_PROTOCOL_VERSION,
                reason: P2pFailureReason::IceTimeout,
            });
            remove_claimed_p2p_session(&timeout_app, &session.peer_id, &session.session_id, false);
            let _ = session.ready_sender.send(false);
            let _ = timeout_app.emit(
                "remote-p2p-failed",
                crate::remote::RemoteP2pSessionInput {
                    device_id: session.peer_id.clone(),
                    session_id: session.session_id.clone(),
                },
            );
        }
    });
    Ok(())
}

fn claimed_p2p_session(
    app: &AppHandle,
    device_id: &str,
    session_id: &str,
) -> Result<Arc<ClaimedComputeP2pSession>, String> {
    app.state::<ComputeState>()
        .claimed_p2p_sessions
        .lock()
        .map_err(|_| "compute P2P session state poisoned".to_string())?
        .get(&claimed_p2p_key(device_id, session_id))
        .cloned()
        .ok_or_else(|| "claimed compute P2P session is unavailable".to_string())
}

fn remove_claimed_p2p_session(
    app: &AppHandle,
    device_id: &str,
    session_id: &str,
    notify_done: bool,
) {
    let session = app
        .state::<ComputeState>()
        .claimed_p2p_sessions
        .lock()
        .ok()
        .and_then(|mut sessions| sessions.remove(&claimed_p2p_key(device_id, session_id)));
    remove_claimed_peer_channel(app, device_id, session_id);
    peer_disconnected(app, device_id, session_id);
    if let Some(session) = session {
        let _ = session.close_sender.send(true);
        if notify_done {
            let _ = session.done_sender.send(());
        }
    }
}

fn remove_claimed_p2p_sessions_for_peer(
    app: &AppHandle,
    device_id: &str,
    notify_done: bool,
    emit_failure: bool,
) {
    let session_ids = app
        .state::<ComputeState>()
        .claimed_p2p_sessions
        .lock()
        .map(|sessions| {
            sessions
                .values()
                .filter(|session| session.peer_id == device_id)
                .map(|session| session.session_id.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for session_id in session_ids {
        remove_claimed_p2p_session(app, device_id, &session_id, notify_done);
        if emit_failure {
            let _ = app.emit(
                "remote-p2p-failed",
                crate::remote::RemoteP2pSessionInput {
                    device_id: device_id.to_string(),
                    session_id,
                },
            );
        }
    }
}

pub(crate) fn claimed_p2p_starts(app: &AppHandle) -> Vec<crate::remote::RemoteP2pStartEvent> {
    app.state::<ComputeState>()
        .claimed_p2p_sessions
        .lock()
        .map(|sessions| {
            sessions
                .values()
                .filter(|session| session.start_pending.load(Ordering::SeqCst))
                .map(|session| crate::remote::RemoteP2pStartEvent {
                    device_id: session.peer_id.clone(),
                    session_id: session.session_id.clone(),
                    ice_servers: session.ice_servers.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn claimed_p2p_answers(app: &AppHandle) -> Vec<crate::remote::RemoteP2pAnswerEvent> {
    app.state::<ComputeState>()
        .claimed_p2p_sessions
        .lock()
        .map(|sessions| {
            sessions
                .values()
                .filter_map(|session| {
                    session
                        .pending_answer
                        .lock()
                        .ok()
                        .and_then(|answer| answer.clone())
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn claimed_p2p_candidates(
    app: &AppHandle,
) -> Vec<crate::remote::RemoteP2pIceCandidateEvent> {
    app.state::<ComputeState>()
        .claimed_p2p_sessions
        .lock()
        .map(|sessions| {
            sessions
                .values()
                .flat_map(|session| {
                    session
                        .pending_candidates
                        .lock()
                        .map(|candidates| candidates.clone())
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn claimed_p2p_ice_completes(
    app: &AppHandle,
) -> Vec<crate::remote::RemoteP2pIceCompleteEvent> {
    app.state::<ComputeState>()
        .claimed_p2p_sessions
        .lock()
        .map(|sessions| {
            sessions
                .values()
                .filter(|session| session.ice_complete.load(Ordering::SeqCst))
                .map(|session| crate::remote::RemoteP2pIceCompleteEvent {
                    device_id: session.peer_id.clone(),
                    session_id: session.session_id.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn claimed_p2p_signal(
    app: &AppHandle,
    device_id: &str,
    session_id: &str,
    signal: TransportSignal,
) -> Result<(), String> {
    signal
        .validate()
        .map_err(|_| "invalid compute WebRTC signal".to_string())?;
    let session = claimed_p2p_session(app, device_id, session_id)?;
    if matches!(signal, TransportSignal::WebrtcOffer { .. }) {
        session.start_pending.store(false, Ordering::SeqCst);
    }
    session
        .signal_sender
        .send(signal)
        .map_err(|_| "compute WebRTC signal transport is unavailable".to_string())
}

pub(crate) fn claimed_p2p_opened(
    app: &AppHandle,
    device_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let session = claimed_p2p_session(app, device_id, session_id)?;
    if session.established.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let mut outbound_receiver = session
        .outbound_receiver
        .lock()
        .map_err(|_| "compute P2P outbound state poisoned".to_string())?
        .take()
        .ok_or_else(|| "compute P2P outbound channel was already opened".to_string())?;
    app.state::<ComputeState>()
        .peer_channels
        .lock()
        .map_err(|_| "compute peer channel state poisoned".to_string())?
        .insert(
            device_id.to_string(),
            ComputePeerChannel {
                session_id: session_id.to_string(),
                sender: session.outbound_sender.clone(),
            },
        );
    peer_connected(app, device_id, session_id, "p2p_webrtc");
    let _ = session.ready_sender.send(true);
    let sender = session.outbound_sender.clone();
    let _ = sender.send(ComputeWireMessage::Capabilities {
        request_id: format!("webrtc-handshake-{session_id}"),
    });
    let output_app = app.clone();
    let output_session = Arc::clone(&session);
    let mut close_receiver = session.close_sender.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                changed = close_receiver.changed() => {
                    if changed.is_err() || *close_receiver.borrow() {
                        break;
                    }
                }
                message = outbound_receiver.recv() => {
                    let Some(message) = message else {
                        break;
                    };
                    let Ok(envelope) = output_session.wire.seal_compute(&message) else {
                        break;
                    };
                    let Ok(payload) = serde_json::to_vec(&envelope) else {
                        break;
                    };
                    if payload.len() > MAX_COMPUTE_TRANSPORT_FRAME_BYTES {
                        break;
                    }
                    if output_app
                        .emit(
                            "remote-p2p-frame",
                            crate::remote::RemoteP2pDataInput {
                                device_id: output_session.peer_id.clone(),
                                session_id: output_session.session_id.clone(),
                                data_base64: STANDARD.encode(payload),
                            },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
    Ok(())
}

pub(crate) fn claimed_p2p_frame(
    app: &AppHandle,
    device_id: &str,
    session_id: &str,
    envelope: &SecureEnvelope,
) -> Result<bool, String> {
    let Ok(session) = claimed_p2p_session(app, device_id, session_id) else {
        return Ok(false);
    };
    claimed_p2p_opened(app, device_id, session_id)?;
    let message = session.wire.open_compute(envelope)?;
    handle_peer_message(
        app.clone(),
        device_id.to_string(),
        message,
        session.outbound_sender.clone(),
    );
    Ok(true)
}

pub(crate) fn claimed_p2p_failed(
    app: &AppHandle,
    device_id: &str,
    session_id: &str,
    reason: P2pFailureReason,
) -> Result<bool, String> {
    let Ok(session) = claimed_p2p_session(app, device_id, session_id) else {
        return Ok(false);
    };
    let _ = session.signal_sender.send(TransportSignal::P2pFailed {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        reason,
    });
    let established = session.established.load(Ordering::SeqCst);
    remove_claimed_p2p_session(app, device_id, session_id, established);
    if !established {
        let _ = session.ready_sender.send(false);
    }
    Ok(true)
}

pub(crate) fn claimed_p2p_closed(app: &AppHandle, device_id: &str, session_id: &str) -> bool {
    let Ok(session) = claimed_p2p_session(app, device_id, session_id) else {
        return false;
    };
    let established = session.established.load(Ordering::SeqCst);
    remove_claimed_p2p_session(app, device_id, session_id, established);
    if !established {
        let _ = session.ready_sender.send(false);
    }
    true
}

async fn run_claimed_relay(
    app: AppHandle,
    peer: ComputePeerRecord,
    session_id: SessionId,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), String> {
    let token = compute_peer_token(peer.local_device_id)?;
    let agreement_key = compute_peer_agreement_key(peer.local_device_id)?;
    let context = SessionKeyContext::new(session_id, peer.peer_id, peer.local_device_id)
        .map_err(|error| format!("cannot derive compute transport context: {error}"))?;
    let session_key = agreement_key
        .derive_session_key(&peer.desktop.key_agreement_public_key, &context)
        .map_err(|error| format!("cannot derive compute transport key: {error}"))?;
    let incoming = SessionRoute::new(session_id, peer.peer_id, peer.local_device_id);
    let wire = Arc::new(crate::remote::RemoteWireSession::new(
        peer.peer_id.to_string(),
        TransportKind::TcpRelay,
        session_key,
        incoming,
    )?);
    let request = compute_websocket_request(&peer.gateway_url, "/v1/relay", &token)?;
    let (mut socket, _) =
        connect_async_with_config(request, Some(compute_websocket_config()), false)
            .await
            .map_err(|_| "cannot connect compute relay".to_string())?;
    let session_id_text = session_id.to_string();
    socket
        .send(Message::Text(
            serde_json::to_string(&ComputeGatewayRelayOpen::Open {
                peer_id: &peer.peer_id.to_string(),
                session_id: &session_id_text,
            })
            .map_err(|_| "cannot encode compute relay open frame".to_string())?
            .into(),
        ))
        .await
        .map_err(|_| "cannot open compute relay".to_string())?;
    let (mut sink, mut stream) = socket.split();
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<ComputeWireMessage>();
    let mut local_ready = false;
    let mut peer_ready = false;
    let peer_id = peer.peer_id.to_string();

    let result = loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = sink.close().await;
                    break Ok(());
                }
            }
            Some(message) = outbound_rx.recv(), if local_ready && peer_ready => {
                let envelope = wire.seal_compute(&message)?;
                let payload = serde_json::to_vec(&envelope)
                    .map_err(|_| "cannot encode encrypted compute message".to_string())?;
                if payload.len() > 262_144 {
                    break Err("encrypted compute message exceeds relay frame limit".to_string());
                }
                sink.send(Message::Binary(payload.into())).await
                    .map_err(|_| "cannot send encrypted compute message".to_string())?;
            }
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else {
                    break Err("compute relay closed".to_string());
                };
                match message {
                    Message::Text(text) => {
                        let frame: ComputeGatewayRelayFrame = serde_json::from_str(text.as_str())
                            .map_err(|_| "compute gateway sent an invalid relay frame".to_string())?;
                        match frame {
                            ComputeGatewayRelayFrame::Ready { session_id: received }
                                if received == session_id_text => {
                                    local_ready = true;
                                }
                            ComputeGatewayRelayFrame::PeerConnected { device_id, session_id: received }
                                if device_id == peer_id && received == session_id_text => {
                                    peer_ready = true;
                                    app.state::<ComputeState>()
                                        .peer_channels
                                        .lock()
                                        .map_err(|_| "compute peer channel state poisoned".to_string())?
                                        .insert(
                                            peer_id.clone(),
                                            ComputePeerChannel {
                                                session_id: session_id_text.clone(),
                                                sender: outbound_tx.clone(),
                                            },
                                        );
                                    peer_connected(&app, &peer_id, &session_id_text, "tcp_relay");
                                }
                            ComputeGatewayRelayFrame::PeerDisconnected { device_id, session_id: received }
                                if device_id == peer_id && received == session_id_text => {
                                    break Ok(());
                                }
                            ComputeGatewayRelayFrame::Pong { nonce } => {
                                let _ = nonce;
                            }
                            ComputeGatewayRelayFrame::Error { code, message } => {
                                let _ = (code, message);
                                break Err("compute gateway rejected relay session".to_string());
                            }
                            _ => break Err("compute gateway sent an unexpected relay frame".to_string()),
                        }
                    }
                    Message::Binary(payload) => {
                        if !local_ready || !peer_ready || payload.len() > 262_144 {
                            break Err("compute relay sent an unexpected binary frame".to_string());
                        }
                        let envelope: SecureEnvelope = serde_json::from_slice(&payload)
                            .map_err(|_| "compute relay sent an invalid envelope".to_string())?;
                        let message = wire.open_compute(&envelope)?;
                        handle_peer_message(
                            app.clone(),
                            peer_id.clone(),
                            message,
                            outbound_tx.clone(),
                        );
                    }
                    Message::Ping(payload) => {
                        sink.send(Message::Pong(payload)).await
                            .map_err(|_| "cannot answer compute relay ping".to_string())?;
                    }
                    Message::Close(_) => break Ok(()),
                    Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    };
    remove_claimed_peer_channel(&app, &peer_id, &session_id_text);
    peer_disconnected(&app, &peer_id, &session_id_text);
    result
}

fn compute_websocket_request(
    gateway_url: &str,
    path: &str,
    token: &str,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    let mut endpoint = reqwest::Url::parse(&format!("{}{path}", gateway_url.trim_end_matches('/')))
        .map_err(|_| "invalid compute gateway URL".to_string())?;
    let scheme = match endpoint.scheme() {
        "https" => "wss",
        "http"
            if endpoint.host_str().is_some_and(|host| {
                matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
            }) =>
        {
            "ws"
        }
        _ => return Err("compute gateway must use HTTPS".to_string()),
    };
    endpoint
        .set_scheme(scheme)
        .map_err(|_| "invalid compute gateway URL".to_string())?;
    let mut request = endpoint
        .as_str()
        .into_client_request()
        .map_err(|_| "cannot create compute WebSocket request".to_string())?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "stored compute credential is invalid".to_string())?,
    );
    Ok(request)
}

fn compute_websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(262_144))
        .max_frame_size(Some(262_144))
}

fn compute_peer_token(local_device_id: DeviceId) -> Result<String, String> {
    let token = read_compute_secret(&compute_token_account(local_device_id))?
        .ok_or_else(|| "compute peer credential is missing".to_string())?;
    String::from_utf8(token).map_err(|_| "compute peer credential is malformed".to_string())
}

fn compute_peer_agreement_key(local_device_id: DeviceId) -> Result<KeyAgreementSecret, String> {
    let identity = read_compute_secret(&compute_identity_account(local_device_id))?
        .ok_or_else(|| "compute peer identity is missing".to_string())?;
    if identity.len() != 64 {
        return Err("compute peer identity is malformed".to_string());
    }
    let agreement: [u8; 32] = identity[32..]
        .try_into()
        .map_err(|_| "compute peer agreement key is malformed".to_string())?;
    Ok(KeyAgreementSecret::from_bytes(agreement))
}

fn remove_claimed_peer_channel(app: &AppHandle, peer_id: &str, session_id: &str) {
    if let Ok(mut channels) = app.state::<ComputeState>().peer_channels.lock() {
        if channels
            .get(peer_id)
            .is_some_and(|channel| session_id.is_empty() || channel.session_id == session_id)
        {
            channels.remove(peer_id);
        }
    }
}

pub(crate) fn peer_connected(app: &AppHandle, node_id: &str, session_id: &str, transport: &str) {
    let state = app.state::<ComputeState>();
    if let Ok(mut peers) = state.peers.lock() {
        if let Some(peer) = peers
            .peers
            .iter_mut()
            .find(|peer| peer.peer_id.to_string() == node_id)
        {
            peer.last_seen_at_unix_ms = Some(now_unix_ms());
            peer.last_transport = Some(transport.to_string());
            let _ = save_peer_store(&peers);
        }
    }
    let _ = app.emit(
        COMPUTE_PEER_EVENT,
        ComputePeerEvent {
            node_id: node_id.to_string(),
            connected: true,
            transport: Some(transport.to_string()),
        },
    );
    let _ = session_id;
    let request_id = format!("capabilities-{}", now_unix_ms());
    let _ = send_peer_message(
        app,
        node_id,
        ComputeWireMessage::Capabilities { request_id },
    );
    if let Ok(jobs) = state.coordinator_jobs.lock() {
        for (job_id, workspace) in jobs.iter() {
            let store = store_at(workspace);
            if let Ok(record) = store.get(*job_id) {
                if !record.status.is_terminal()
                    && matches!(
                        &record.target,
                        ComputeTarget::Remote { node_id: target, .. } if target == node_id
                    )
                {
                    let _ = send_peer_message(
                        app,
                        node_id,
                        ComputeWireMessage::Subscribe {
                            job_id: *job_id,
                            after_sequence: record.last_sequence,
                        },
                    );
                }
            }
        }
    };
}

pub(crate) fn peer_disconnected(app: &AppHandle, node_id: &str, session_id: &str) {
    if let Ok(mut pending) = app.state::<ComputeState>().pending_agent_responses.lock() {
        pending.retain(|_, response| response.node_id != node_id);
    }
    if let Ok(mut turns) = app.state::<ComputeState>().active_agent_turns.lock() {
        turns.retain(|_, turn| turn.node_id != node_id);
    }
    let _ = app.emit(
        COMPUTE_PEER_EVENT,
        ComputePeerEvent {
            node_id: node_id.to_string(),
            connected: false,
            transport: None,
        },
    );
    let _ = session_id;
}

fn send_peer_message(
    app: &AppHandle,
    node_id: &str,
    message: ComputeWireMessage,
) -> Result<(), String> {
    if let Some(sender) = app
        .state::<ComputeState>()
        .peer_channels
        .lock()
        .map_err(|_| "compute peer channel state poisoned".to_string())?
        .get(node_id)
        .map(|channel| channel.sender.clone())
    {
        return sender
            .send(message)
            .map_err(|_| "compute peer disconnected".to_string());
    }
    crate::remote::send_compute_message(
        app.state::<crate::remote::RemoteAgentState>().inner(),
        node_id,
        message,
    )
}

pub(crate) fn handle_peer_message(
    app: AppHandle,
    peer_id: String,
    message: ComputeWireMessage,
    sender: mpsc::UnboundedSender<ComputeWireMessage>,
) {
    let result = match message {
        ComputeWireMessage::ControlRequest { request } => {
            let request_app = app.clone();
            let request_peer_id = peer_id.clone();
            let response_sender = sender.clone();
            tauri::async_runtime::spawn(async move {
                let stream_sender = response_sender.clone();
                let stream_sink: crate::remote::ControlResponseSink = Arc::new(move |response| {
                    let _ = stream_sender.send(ComputeWireMessage::ControlResponse { response });
                });
                let transport = peer_transport(&request_app, &request_peer_id);
                let response = crate::remote::execute_control_request(
                    request_app.clone(),
                    request_app
                        .state::<crate::remote::RemoteAgentState>()
                        .inner(),
                    crate::remote::RemoteRequestContext {
                        device_id: request_peer_id,
                        transport,
                    },
                    request,
                    Some(stream_sink),
                )
                .await;
                let _ = response_sender.send(ComputeWireMessage::ControlResponse { response });
            });
            Ok(())
        }
        ComputeWireMessage::ControlResponse { response } => app
            .state::<ComputeState>()
            .pending_agent_responses
            .lock()
            .map_err(|_| "remote Agent response state poisoned".to_string())
            .map(|pending| {
                if let Some(response_sender) = pending
                    .get(&response.request_id.to_string())
                    .map(|entry| entry.sender.clone())
                {
                    let _ = response_sender.send(response);
                }
            }),
        ComputeWireMessage::Capabilities { request_id } => {
            let config = app
                .state::<ComputeState>()
                .config
                .lock()
                .map(|config| config.clone())
                .map_err(|_| "compute node config lock poisoned".to_string());
            config.and_then(|config| {
                sender
                    .send(ComputeWireMessage::CapabilitiesResult {
                        request_id,
                        capabilities: capabilities_for(&config),
                    })
                    .map_err(|_| "compute peer disconnected".to_string())
            })
        }
        ComputeWireMessage::CapabilitiesResult {
            request_id,
            capabilities,
        } => {
            let _ = request_id;
            app.state::<ComputeState>()
                .peer_capabilities
                .lock()
                .map_err(|_| "compute capability state poisoned".to_string())
                .map(|mut capabilities_by_peer| {
                    capabilities_by_peer.insert(peer_id.clone(), capabilities);
                })
        }
        ComputeWireMessage::InputBundleStart {
            job_id,
            size_bytes,
            sha256,
        } => receive_bundle_start(&app, &peer_id, job_id, size_bytes, &sha256),
        ComputeWireMessage::InputBundleChunk {
            job_id,
            offset,
            data,
            eof,
        } => receive_bundle_chunk(&app, &peer_id, job_id, offset, data.as_bytes(), eof),
        ComputeWireMessage::Submit { request } => {
            let job_id = request.job_id;
            match start_remote_worker_job(app.clone(), peer_id.clone(), request, sender.clone()) {
                Ok(()) => Ok(()),
                Err(error) => {
                    let _ = sender.send(ComputeWireMessage::Error {
                        request_id: None,
                        job_id: Some(job_id),
                        code: "compute_job_rejected".to_string(),
                        message: error.clone(),
                    });
                    Ok(())
                }
            }
        }
        ComputeWireMessage::Accepted { job_id } => {
            let _ = job_id;
            Ok(())
        }
        ComputeWireMessage::Cancel { job_id } => {
            let state = app.state::<ComputeState>();
            let cancellation = state
                .cancellations
                .lock()
                .map_err(|_| "compute cancellation state poisoned".to_string())
                .and_then(|cancellations| {
                    cancellations
                        .get(&job_id)
                        .cloned()
                        .ok_or_else(|| "compute job is not running on this worker".to_string())
                });
            cancellation.map(|cancellation| cancellation.store(true, Ordering::SeqCst))
        }
        ComputeWireMessage::Subscribe {
            job_id,
            after_sequence,
        } => send_worker_events(&peer_id, job_id, after_sequence, &sender),
        ComputeWireMessage::Event { event } => {
            receive_coordinator_event(&app, &peer_id, event, &sender)
        }
        ComputeWireMessage::ArtifactRead {
            job_id,
            path,
            offset,
            max_bytes,
        } => send_artifact_chunk(&peer_id, job_id, &path, offset, max_bytes, &sender),
        ComputeWireMessage::ArtifactChunk {
            job_id,
            path,
            offset,
            data,
            eof,
            sha256,
        } => receive_artifact_chunk(
            &app,
            &peer_id,
            job_id,
            &path,
            offset,
            data.as_bytes(),
            eof,
            &sha256,
            &sender,
        ),
        ComputeWireMessage::Error {
            request_id,
            job_id,
            code,
            message,
        } => {
            let _ = (request_id, code);
            if let Some(job_id) = job_id {
                fail_coordinator_job(&app, job_id, message)
            } else {
                Err(message)
            }
        }
    };
    if let Err(error) = result {
        let _ = sender.send(ComputeWireMessage::Error {
            request_id: None,
            job_id: None,
            code: "compute_peer_error".to_string(),
            message: error,
        });
    }
}

fn receive_bundle_start(
    app: &AppHandle,
    peer_id: &str,
    job_id: ComputeJobId,
    size_bytes: u64,
    sha256: &str,
) -> Result<(), String> {
    if size_bytes > 512 * 1024 * 1024 {
        return Err("remote input bundle exceeds the 512 MiB limit".to_string());
    }
    validate_sha256(sha256)?;
    let path = remote_worker_root(peer_id)
        .join("incoming")
        .join(format!("{job_id}.zip"));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::File::create(&path).map_err(|error| error.to_string())?;
    app.state::<ComputeState>()
        .incoming_bundles
        .lock()
        .map_err(|_| "compute input bundle state poisoned".to_string())?
        .insert(
            bundle_key(peer_id, job_id),
            IncomingBundle {
                path,
                expected_size: size_bytes,
                expected_sha256: sha256.to_string(),
                complete: false,
            },
        );
    Ok(())
}

fn receive_bundle_chunk(
    app: &AppHandle,
    peer_id: &str,
    job_id: ComputeJobId,
    offset: u64,
    data: &[u8],
    eof: bool,
) -> Result<(), String> {
    if data.len() > COMPUTE_MAX_ARTIFACT_CHUNK_BYTES {
        return Err("remote input bundle chunk is too large".to_string());
    }
    let state = app.state::<ComputeState>();
    let mut bundles = state
        .incoming_bundles
        .lock()
        .map_err(|_| "compute input bundle state poisoned".to_string())?;
    let bundle = bundles
        .get_mut(&bundle_key(peer_id, job_id))
        .ok_or_else(|| "remote input bundle was not initialized".to_string())?;
    if bundle.complete {
        return Ok(());
    }
    let current_size = fs::metadata(&bundle.path)
        .map_err(|error| error.to_string())?
        .len();
    if current_size != offset {
        return Err(format!(
            "remote input bundle offset mismatch: expected {current_size}, received {offset}"
        ));
    }
    if current_size.saturating_add(data.len().try_into().unwrap_or(u64::MAX)) > bundle.expected_size
    {
        return Err("remote input bundle exceeded its declared size".to_string());
    }
    OpenOptions::new()
        .append(true)
        .open(&bundle.path)
        .and_then(|mut file| {
            file.write_all(data)?;
            file.flush()
        })
        .map_err(|error| error.to_string())?;
    if eof {
        let final_size = fs::metadata(&bundle.path)
            .map_err(|error| error.to_string())?
            .len();
        if final_size != bundle.expected_size {
            return Err("remote input bundle ended before its declared size".to_string());
        }
        if sha256_path(&bundle.path)? != bundle.expected_sha256 {
            return Err("remote input bundle digest does not match".to_string());
        }
        bundle.complete = true;
    }
    Ok(())
}

fn start_remote_worker_job(
    app: AppHandle,
    peer_id: String,
    request: ComputeJobRequest,
    sender: mpsc::UnboundedSender<ComputeWireMessage>,
) -> Result<(), String> {
    validate_wire_job_request(&request)?;
    let state = app.state::<ComputeState>();
    let config = state
        .config
        .lock()
        .map_err(|_| "compute node config lock poisoned".to_string())?
        .clone();
    if !config.accept_remote_jobs {
        return Err("this computer is not accepting remote compute jobs".to_string());
    }
    let active_jobs = state
        .cancellations
        .lock()
        .map_err(|_| "compute cancellation state poisoned".to_string())?
        .len();
    if active_jobs >= config.max_parallel_jobs {
        return Err("this compute worker has reached its parallel job limit".to_string());
    }
    let bundle_path = {
        let bundles = state
            .incoming_bundles
            .lock()
            .map_err(|_| "compute input bundle state poisoned".to_string())?;
        let bundle = bundles
            .get(&bundle_key(&peer_id, request.job_id))
            .ok_or_else(|| "remote job input bundle is missing".to_string())?;
        if !bundle.complete {
            return Err("remote job input bundle is incomplete".to_string());
        }
        if request.input_bundle_digest.as_deref() != Some(bundle.expected_sha256.as_str()) {
            return Err("remote job request does not bind the verified input bundle".to_string());
        }
        bundle.path.clone()
    };
    let workspace = remote_worker_root(&peer_id)
        .join("workspaces")
        .join(request.job_id.to_string());
    extract_compute_bundle(&bundle_path, &workspace)?;
    let store = remote_worker_store(&peer_id);
    store
        .create(
            request.clone(),
            ComputeTarget::Remote {
                node_id: peer_id.clone(),
                node_name: peer_id.clone(),
            },
        )
        .map_err(|error| error.to_string())?;
    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .cancellations
        .lock()
        .map_err(|_| "compute cancellation state poisoned".to_string())?
        .insert(request.job_id, Arc::clone(&cancelled));
    sender
        .send(ComputeWireMessage::Accepted {
            job_id: request.job_id,
        })
        .map_err(|_| "compute coordinator disconnected".to_string())?;
    let identity = WorkerIdentity {
        device_id: Some(config.node_id),
        display_name: Some(config.display_name),
        environment_fingerprint: Some(environment_fingerprint()),
    };
    let job_id = request.job_id;
    tauri::async_runtime::spawn_blocking(move || {
        let execution = if matches!(request.workload, ComputeWorkload::Notebook { .. }) {
            let result = run_notebook_job(&app, &store, &workspace, &request, cancelled, &identity);
            if result.is_ok() {
                if let Ok(events) = store.events_after(job_id, 0) {
                    for event in events {
                        let _ = sender.send(ComputeWireMessage::Event { event });
                    }
                }
            }
            result.map(|_| ())
        } else {
            let runner = ComputeRunner::new(store.clone(), workspace, identity);
            runner
                .run(&request, cancelled.as_ref(), |event| {
                    let _ = sender.send(ComputeWireMessage::Event {
                        event: event.clone(),
                    });
                })
                .map(|_| ())
                .map_err(|error| error.to_string())
        };
        if let Err(error) = execution {
            let result = failed_result(&request, error);
            if let Ok(event) = store.append(job_id, ComputeJobEventPayload::Completed { result }) {
                let _ = sender.send(ComputeWireMessage::Event { event });
            }
        }
        if let Ok(mut cancellations) = app.state::<ComputeState>().cancellations.lock() {
            cancellations.remove(&job_id);
        };
    });
    Ok(())
}

fn send_worker_events(
    peer_id: &str,
    job_id: ComputeJobId,
    after_sequence: u64,
    sender: &mpsc::UnboundedSender<ComputeWireMessage>,
) -> Result<(), String> {
    for event in remote_worker_store(peer_id)
        .events_after(job_id, after_sequence)
        .map_err(|error| error.to_string())?
    {
        sender
            .send(ComputeWireMessage::Event { event })
            .map_err(|_| "compute coordinator disconnected".to_string())?;
    }
    Ok(())
}

fn receive_coordinator_event(
    app: &AppHandle,
    peer_id: &str,
    event: ComputeJobEvent,
    sender: &mpsc::UnboundedSender<ComputeWireMessage>,
) -> Result<(), String> {
    let workspace = app
        .state::<ComputeState>()
        .coordinator_jobs
        .lock()
        .map_err(|_| "compute coordinator state poisoned".to_string())?
        .get(&event.job_id)
        .cloned()
        .ok_or_else(|| "remote compute event refers to an unknown local job".to_string())?;
    let store = store_at(&workspace);
    let record = store.get(event.job_id).map_err(|error| error.to_string())?;
    if event.sequence <= record.last_sequence {
        return Ok(());
    }
    if event.sequence != record.last_sequence.saturating_add(1) {
        sender
            .send(ComputeWireMessage::Subscribe {
                job_id: event.job_id,
                after_sequence: record.last_sequence,
            })
            .map_err(|_| "compute worker disconnected".to_string())?;
        return Ok(());
    }
    let completed_artifacts = match &event.payload {
        ComputeJobEventPayload::Completed { result } => Some(result.artifacts.clone()),
        _ => None,
    };
    let local_event = store
        .append(event.job_id, event.payload)
        .map_err(|error| error.to_string())?;
    app.emit(COMPUTE_JOB_EVENT, local_event)
        .map_err(|error| error.to_string())?;
    if let Some(artifacts) = completed_artifacts {
        for artifact in artifacts {
            validate_relative_job_path(&artifact.path)?;
            sender
                .send(ComputeWireMessage::ArtifactRead {
                    job_id: event.job_id,
                    path: artifact.path,
                    offset: 0,
                    max_bytes: u32::try_from(COMPUTE_MAX_ARTIFACT_CHUNK_BYTES)
                        .unwrap_or(128 * 1024),
                })
                .map_err(|_| "compute worker disconnected".to_string())?;
        }
    }
    let _ = peer_id;
    Ok(())
}

fn send_artifact_chunk(
    peer_id: &str,
    job_id: ComputeJobId,
    artifact_path: &str,
    offset: u64,
    max_bytes: u32,
    sender: &mpsc::UnboundedSender<ComputeWireMessage>,
) -> Result<(), String> {
    validate_relative_job_path(artifact_path)?;
    let path = remote_worker_store(peer_id)
        .artifacts_dir(job_id)
        .join(artifact_path);
    if !path.is_file() {
        return Err("requested compute artifact does not exist".to_string());
    }
    use std::io::{Seek, SeekFrom};
    let mut file = fs::File::open(&path).map_err(|error| error.to_string())?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    if offset > size {
        return Err("compute artifact offset is outside the file".to_string());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let limit = usize::try_from(max_bytes)
        .unwrap_or(COMPUTE_MAX_ARTIFACT_CHUNK_BYTES)
        .min(COMPUTE_MAX_ARTIFACT_CHUNK_BYTES);
    let mut data = vec![0_u8; limit];
    let read = file.read(&mut data).map_err(|error| error.to_string())?;
    data.truncate(read);
    let eof = offset.saturating_add(read.try_into().unwrap_or(u64::MAX)) >= size;
    sender
        .send(ComputeWireMessage::ArtifactChunk {
            job_id,
            path: artifact_path.to_string(),
            offset,
            data: Base64UrlBytes::new(data),
            eof,
            sha256: sha256_path(&path)?,
        })
        .map_err(|_| "compute coordinator disconnected".to_string())
}

#[allow(clippy::too_many_arguments)]
fn receive_artifact_chunk(
    app: &AppHandle,
    peer_id: &str,
    job_id: ComputeJobId,
    artifact_path: &str,
    offset: u64,
    data: &[u8],
    eof: bool,
    sha256: &str,
    sender: &mpsc::UnboundedSender<ComputeWireMessage>,
) -> Result<(), String> {
    validate_relative_job_path(artifact_path)?;
    validate_sha256(sha256)?;
    if data.len() > COMPUTE_MAX_ARTIFACT_CHUNK_BYTES {
        return Err("compute artifact chunk is too large".to_string());
    }
    let workspace = app
        .state::<ComputeState>()
        .coordinator_jobs
        .lock()
        .map_err(|_| "compute coordinator state poisoned".to_string())?
        .get(&job_id)
        .cloned()
        .ok_or_else(|| "compute artifact refers to an unknown local job".to_string())?;
    let destination = store_at(&workspace)
        .artifacts_dir(job_id)
        .join(artifact_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let key = format!("{peer_id}:{job_id}:{artifact_path}");
    let state = app.state::<ComputeState>();
    let mut incoming = state
        .incoming_artifacts
        .lock()
        .map_err(|_| "compute artifact state poisoned".to_string())?;
    if offset == 0 {
        fs::File::create(&destination).map_err(|error| error.to_string())?;
        incoming.insert(
            key.clone(),
            IncomingArtifact {
                path: destination.clone(),
                expected_sha256: sha256.to_string(),
            },
        );
    }
    let artifact = incoming
        .get(&key)
        .ok_or_else(|| "compute artifact transfer was not initialized".to_string())?;
    let current_size = fs::metadata(&artifact.path)
        .map_err(|error| error.to_string())?
        .len();
    if current_size != offset || artifact.expected_sha256 != sha256 {
        return Err("compute artifact chunk does not match the active transfer".to_string());
    }
    OpenOptions::new()
        .append(true)
        .open(&artifact.path)
        .and_then(|mut file| file.write_all(data))
        .map_err(|error| error.to_string())?;
    let next_offset = offset.saturating_add(data.len().try_into().unwrap_or(u64::MAX));
    if eof {
        if sha256_path(&artifact.path)? != artifact.expected_sha256 {
            return Err("compute artifact digest does not match".to_string());
        }
        incoming.remove(&key);
    } else {
        sender
            .send(ComputeWireMessage::ArtifactRead {
                job_id,
                path: artifact_path.to_string(),
                offset: next_offset,
                max_bytes: u32::try_from(COMPUTE_MAX_ARTIFACT_CHUNK_BYTES).unwrap_or(128 * 1024),
            })
            .map_err(|_| "compute worker disconnected".to_string())?;
    }
    Ok(())
}

fn fail_coordinator_job(
    app: &AppHandle,
    job_id: ComputeJobId,
    message: String,
) -> Result<(), String> {
    let workspace = app
        .state::<ComputeState>()
        .coordinator_jobs
        .lock()
        .map_err(|_| "compute coordinator state poisoned".to_string())?
        .get(&job_id)
        .cloned()
        .ok_or(message.clone())?;
    let store = store_at(&workspace);
    let request = store
        .get(job_id)
        .map_err(|error| error.to_string())?
        .request;
    let event = store
        .append(
            job_id,
            ComputeJobEventPayload::Completed {
                result: failed_result(&request, message),
            },
        )
        .map_err(|error| error.to_string())?;
    app.emit(COMPUTE_JOB_EVENT, event)
        .map_err(|error| error.to_string())
}

fn remote_worker_root(peer_id: &str) -> PathBuf {
    crate::state::desktop_runtime_dir()
        .join("remote-compute")
        .join(peer_id)
}

fn remote_worker_store(peer_id: &str) -> ComputeJobStore {
    ComputeJobStore::new(remote_worker_root(peer_id).join("store"))
}

fn bundle_key(peer_id: &str, job_id: ComputeJobId) -> String {
    format!("{peer_id}:{job_id}")
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("invalid SHA-256 digest".to_string())
    }
}

fn extract_compute_bundle(bundle_path: &Path, workspace: &Path) -> Result<(), String> {
    if workspace.exists() {
        return Err("remote compute workspace already exists".to_string());
    }
    fs::create_dir_all(workspace).map_err(|error| error.to_string())?;
    let file = fs::File::open(bundle_path).map_err(|error| error.to_string())?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("invalid compute bundle: {error}"))?;
    if archive.len() > 20_000 {
        return Err("compute bundle contains too many files".to_string());
    }
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("invalid compute bundle entry: {error}"))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| "compute bundle contains an unsafe path".to_string())?
            .to_path_buf();
        total = total.saturating_add(entry.size());
        if total > 1024 * 1024 * 1024 {
            return Err("expanded compute bundle exceeds 1 GiB".to_string());
        }
        let output = workspace.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output_file = fs::File::create(&output).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut output_file).map_err(|error| error.to_string())?;
    }
    Ok(())
}

struct ComputeBundle {
    path: PathBuf,
    size_bytes: u64,
    sha256: String,
}

fn create_compute_bundle(
    workspace: &Path,
    store: &ComputeJobStore,
    job_id: ComputeJobId,
) -> Result<ComputeBundle, String> {
    let output = store.root().join("outgoing").join(format!("{job_id}.zip"));
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let file = fs::File::create(&output).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o644);
    let mut files = 0_usize;
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    for entry in walkdir::WalkDir::new(workspace)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !bundle_entry_ignored(workspace, entry.path()))
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        let relative = entry
            .path()
            .strip_prefix(workspace)
            .map_err(|error| error.to_string())?;
        if bundle_file_ignored(relative) {
            continue;
        }
        files = files.saturating_add(1);
        if files > 20_000 {
            return Err("project contains more than 20,000 transferable files".to_string());
        }
        let size = fs::metadata(entry.path())
            .map_err(|error| error.to_string())?
            .len();
        total = total.saturating_add(size);
        if total > 256 * 1024 * 1024 {
            return Err("project input bundle exceeds the 256 MiB transfer limit".to_string());
        }
        let name = relative.to_string_lossy().replace('\\', "/");
        archive
            .start_file(name, options)
            .map_err(|error| format!("cannot add project file to compute bundle: {error}"))?;
        let mut input = fs::File::open(entry.path()).map_err(|error| error.to_string())?;
        loop {
            let read = input.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            archive
                .write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
        }
    }
    archive
        .finish()
        .map_err(|error| format!("cannot finish compute bundle: {error}"))?;
    let size_bytes = fs::metadata(&output)
        .map_err(|error| error.to_string())?
        .len();
    Ok(ComputeBundle {
        sha256: sha256_path(&output)?,
        path: output,
        size_bytes,
    })
}

fn bundle_entry_ignored(workspace: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(workspace) else {
        return true;
    };
    relative.components().any(|component| {
        let value = component.as_os_str().to_string_lossy();
        matches!(
            value.as_ref(),
            ".git"
                | ".hg"
                | ".svn"
                | ".somniq"
                | ".venv"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | "__pycache__"
                | ".cache"
                | ".ssh"
        )
    })
}

fn bundle_file_ignored(relative: &Path) -> bool {
    let name = relative
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    name == ".env"
        || name.starts_with(".env.")
        || matches!(
            name.as_str(),
            "credentials.json" | "secrets.json" | "id_rsa" | "id_ed25519"
        )
        || matches!(
            relative
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str(),
            "key" | "pem" | "p12" | "pfx"
        )
}

async fn send_remote_submission(
    app: &AppHandle,
    node_id: &str,
    request: &ComputeJobRequest,
    bundle: &ComputeBundle,
) -> Result<(), String> {
    send_peer_message(
        app,
        node_id,
        ComputeWireMessage::InputBundleStart {
            job_id: request.job_id,
            size_bytes: bundle.size_bytes,
            sha256: bundle.sha256.clone(),
        },
    )?;
    let mut file = fs::File::open(&bundle.path).map_err(|error| error.to_string())?;
    let mut offset = 0_u64;
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        let eof = read == 0
            || offset.saturating_add(read.try_into().unwrap_or(u64::MAX)) >= bundle.size_bytes;
        if read > 0 {
            send_peer_message(
                app,
                node_id,
                ComputeWireMessage::InputBundleChunk {
                    job_id: request.job_id,
                    offset,
                    data: Base64UrlBytes::new(buffer[..read].to_vec()),
                    eof,
                },
            )?;
            offset = offset.saturating_add(read.try_into().unwrap_or(u64::MAX));
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        if eof {
            break;
        }
    }
    if bundle.size_bytes == 0 {
        send_peer_message(
            app,
            node_id,
            ComputeWireMessage::InputBundleChunk {
                job_id: request.job_id,
                offset: 0,
                data: Base64UrlBytes::default(),
                eof: true,
            },
        )?;
    }
    send_peer_message(
        app,
        node_id,
        ComputeWireMessage::Submit {
            request: request.clone(),
        },
    )
}

fn compute_peer_name(app: &AppHandle, node_id: &str) -> Option<String> {
    let state = app.state::<ComputeState>();
    if let Ok(peers) = state.peers.lock() {
        if let Some(peer) = peers
            .peers
            .iter()
            .find(|peer| peer.peer_id.to_string() == node_id)
        {
            return Some(peer.display_name.clone());
        }
    }
    crate::remote::paired_compute_devices(app.state::<crate::remote::RemoteAgentState>().inner())
        .ok()?
        .into_iter()
        .find(|descriptor| descriptor.device_id.to_string() == node_id)
        .map(|descriptor| descriptor.display_name)
}

fn peer_transport(app: &AppHandle, node_id: &str) -> String {
    if let Ok(peers) = app.state::<ComputeState>().peers.lock() {
        if let Some(transport) = peers
            .peers
            .iter()
            .find(|peer| peer.peer_id.to_string() == node_id)
            .and_then(|peer| peer.last_transport.clone())
        {
            return transport;
        }
    }
    crate::remote::compute_device_transport(
        app.state::<crate::remote::RemoteAgentState>().inner(),
        node_id,
    )
    .ok()
    .flatten()
    .unwrap_or_else(|| "encrypted_computer_channel".to_string())
}

pub(crate) fn claimed_peer_scopes(app: &AppHandle, node_id: &str) -> Result<DeviceScopes, String> {
    app.state::<ComputeState>()
        .peers
        .lock()
        .map_err(|_| "compute peer store lock poisoned".to_string())?
        .peers
        .iter()
        .find(|peer| peer.peer_id.to_string() == node_id)
        .map(|peer| peer.granted_scopes.clone())
        .ok_or_else(|| "remote computer is not paired".to_string())
}

fn agent_peer_scopes(app: &AppHandle, node_id: &str) -> Result<DeviceScopes, String> {
    claimed_peer_scopes(app, node_id).or_else(|_| {
        crate::remote::compute_device_scopes(
            app.state::<crate::remote::RemoteAgentState>().inner(),
            node_id,
        )
    })
}

fn ensure_agent_peer_authorized(app: &AppHandle, node_id: &str) -> Result<(), String> {
    let scopes = agent_peer_scopes(app, node_id)?;
    if !scopes.contains(DeviceScope::ReadProjectState)
        || !scopes.contains(DeviceScope::SendChatMessages)
    {
        return Err(
            "this computer pairing does not include remote Agent access; revoke it and pair again"
                .to_string(),
        );
    }
    Ok(())
}

pub(crate) fn remote_agent_requests_enabled(app: &AppHandle) -> Result<bool, String> {
    app.state::<ComputeState>()
        .config
        .lock()
        .map(|config| config.accept_remote_agent_chats)
        .map_err(|_| "compute node config lock poisoned".to_string())
}

fn begin_agent_request(
    app: &AppHandle,
    node_id: &str,
    command: ControlCommand,
) -> Result<(String, mpsc::UnboundedReceiver<ControlResponse>), String> {
    ensure_agent_peer_authorized(app, node_id)?;
    let request = ControlRequest::new(command, now_unix_ms());
    let request_id = request.request_id.to_string();
    let (sender, receiver) = mpsc::unbounded_channel();
    app.state::<ComputeState>()
        .pending_agent_responses
        .lock()
        .map_err(|_| "remote Agent response state poisoned".to_string())?
        .insert(
            request_id.clone(),
            PendingAgentResponse {
                node_id: node_id.to_string(),
                sender,
            },
        );
    if let Err(error) =
        send_peer_message(app, node_id, ComputeWireMessage::ControlRequest { request })
    {
        if let Ok(mut pending) = app.state::<ComputeState>().pending_agent_responses.lock() {
            pending.remove(&request_id);
        }
        return Err(error);
    }
    Ok((request_id, receiver))
}

fn finish_agent_request(app: &AppHandle, request_id: &str) {
    if let Ok(mut pending) = app.state::<ComputeState>().pending_agent_responses.lock() {
        pending.remove(request_id);
    }
}

fn control_error_message(error: ControlError) -> String {
    match error {
        ControlError::Unauthorized { .. } => {
            "the remote computer rejected Agent access; enable it there or pair again".to_string()
        }
        ControlError::InvalidRequest { reason } => reason,
        ControlError::NotFound => {
            "the selected remote project or chat no longer exists".to_string()
        }
        ControlError::Conflict => {
            "the remote computer is busy or its active project changed".to_string()
        }
        ControlError::TemporarilyUnavailable { .. } => {
            "the remote Agent is temporarily unavailable".to_string()
        }
        ControlError::Internal => "the remote Agent returned an internal error".to_string(),
    }
}

async fn agent_request_result(
    app: &AppHandle,
    node_id: &str,
    command: ControlCommand,
) -> Result<ControlResult, String> {
    let (request_id, mut receiver) = begin_agent_request(app, node_id, command)?;
    let received = tokio::time::timeout(Duration::from_secs(30), receiver.recv()).await;
    finish_agent_request(app, &request_id);
    let response = received
        .map_err(|_| "the remote Agent did not respond in time".to_string())?
        .ok_or_else(|| "the remote computer disconnected".to_string())?;
    match response.outcome {
        ControlResponseOutcome::Success { result } => Ok(result),
        ControlResponseOutcome::Error { error } => Err(control_error_message(error)),
    }
}

#[tauri::command]
pub async fn remote_agent_workspace(
    app: AppHandle,
    node_id: String,
) -> Result<RemoteAgentWorkspaceView, String> {
    let node_id = node_id.trim();
    let node_name = compute_peer_name(&app, node_id)
        .ok_or_else(|| "remote computer is not paired".to_string())?;
    let result = agent_request_result(&app, node_id, ControlCommand::GetWorkspaceOverview).await?;
    let ControlResult::WorkspaceOverview { projects, .. } = result else {
        return Err("remote computer returned an unexpected workspace response".to_string());
    };
    Ok(RemoteAgentWorkspaceView {
        node_id: node_id.to_string(),
        node_name,
        projects: projects
            .into_iter()
            .map(|project| RemoteAgentProjectView {
                project_id: project.project_id,
                title: project.title,
                phase: project.phase,
                is_active: project.is_active,
            })
            .collect(),
    })
}

#[tauri::command]
pub async fn remote_agent_session_create(
    app: AppHandle,
    input: RemoteAgentSessionCreateInput,
) -> Result<RemoteAgentSessionView, String> {
    let node_id = input.node_id.trim();
    let project_id = input.project_id.trim();
    if node_id.is_empty() || project_id.is_empty() {
        return Err("remote computer and project are required".to_string());
    }
    let workspace = remote_agent_workspace(app.clone(), node_id.to_string()).await?;
    let project = workspace
        .projects
        .iter()
        .find(|project| project.project_id == project_id)
        .cloned()
        .ok_or_else(|| "the selected remote project no longer exists".to_string())?;
    if !project.is_active {
        let switched = agent_request_result(
            &app,
            node_id,
            ControlCommand::SetActiveProject {
                project_id: project_id.to_string(),
            },
        )
        .await?;
        if !matches!(switched, ControlResult::WorkspaceOverview { .. }) {
            return Err("remote computer returned an unexpected project response".to_string());
        }
    }
    let created = agent_request_result(
        &app,
        node_id,
        ControlCommand::CreateChatSession {
            project_id: project_id.to_string(),
        },
    )
    .await?;
    let ControlResult::ChatSessionCreated {
        project_id: created_project_id,
        session,
    } = created
    else {
        return Err("remote computer returned an unexpected chat response".to_string());
    };
    Ok(RemoteAgentSessionView {
        node_id: node_id.to_string(),
        node_name: workspace.node_name,
        project_id: created_project_id,
        project_name: if input.project_name.trim().is_empty() {
            project.title.clone()
        } else {
            input.project_name.trim().to_string()
        },
        session_id: session.session_id,
        title: session.title,
    })
}

fn emit_remote_agent_event(app: &AppHandle, local_session_id: &str, event: ChatMessageEvent) {
    match event {
        ChatMessageEvent::TextDelta { delta } => {
            let _ = app.emit(
                "chat-delta",
                serde_json::json!({ "sessionId": local_session_id, "text": delta }),
            );
        }
        ChatMessageEvent::ThinkingDelta { delta } => {
            let _ = app.emit(
                "chat-thinking-delta",
                serde_json::json!({ "sessionId": local_session_id, "thinking": delta }),
            );
        }
        ChatMessageEvent::ToolCall {
            tool_use_id,
            name,
            input,
        } => {
            let _ = app.emit(
                "chat-tool",
                serde_json::json!({
                    "sessionId": local_session_id,
                    "id": tool_use_id,
                    "name": name,
                    "input": input,
                }),
            );
        }
        ChatMessageEvent::ToolProgress {
            tool_use_id,
            name,
            progress,
        } => {
            let _ = app.emit(
                "chat-tool-progress",
                serde_json::json!({
                    "sessionId": local_session_id,
                    "id": tool_use_id,
                    "name": name,
                    "elapsedMs": progress.elapsed_ms,
                    "timeoutMs": progress.timeout_ms,
                    "pid": progress.pid,
                    "stdoutTail": progress.stdout_tail,
                    "stderrTail": progress.stderr_tail,
                    "nearTimeout": progress.near_timeout,
                    "message": progress.message,
                }),
            );
        }
        ChatMessageEvent::ToolResult {
            tool_use_id,
            name,
            output,
            is_error,
        } => {
            let _ = app.emit(
                "chat-tool-result",
                serde_json::json!({
                    "sessionId": local_session_id,
                    "id": tool_use_id,
                    "name": name,
                    "output": output,
                    "isError": is_error,
                }),
            );
        }
    }
}

async fn request_remote_agent_stop(
    app: &AppHandle,
    turn: ActiveRemoteAgentTurn,
) -> Result<(), String> {
    let Some(message_id) = turn.message_id else {
        return Ok(());
    };
    let result = agent_request_result(
        app,
        &turn.node_id,
        ControlCommand::StopChatMessage {
            project_id: turn.project_id,
            session_id: turn.remote_session_id,
            message_id,
        },
    )
    .await?;
    if matches!(result, ControlResult::ChatMessageStopRequested { .. }) {
        Ok(())
    } else {
        Err("remote computer returned an unexpected stop response".to_string())
    }
}

#[tauri::command]
pub async fn remote_agent_chat_send(
    app: AppHandle,
    input: RemoteAgentChatInput,
) -> Result<String, String> {
    if input.message.trim().is_empty() {
        return Err("remote Agent message cannot be blank".to_string());
    }
    let local_session_id = input.local_session_id.trim().to_string();
    let active_turn = ActiveRemoteAgentTurn {
        node_id: input.node_id.clone(),
        project_id: input.project_id.clone(),
        remote_session_id: input.remote_session_id.clone(),
        message_id: None,
        cancel_requested: false,
    };
    app.state::<ComputeState>()
        .active_agent_turns
        .lock()
        .map_err(|_| "remote Agent turn state poisoned".to_string())?
        .insert(local_session_id.clone(), active_turn);
    let command = ControlCommand::SendChatMessage {
        project_id: input.project_id,
        session_id: input.remote_session_id,
        message: input.message,
        idempotency_key: format!("desktop-agent-{}", SessionId::new()),
        stream: true,
        rich_stream: true,
    };
    let request = begin_agent_request(&app, &input.node_id, command);
    let result = match request {
        Err(error) => Err(error),
        Ok((request_id, mut receiver)) => {
            let result = loop {
                let Some(response) = receiver.recv().await else {
                    break Err("the remote computer disconnected during the Agent turn".to_string());
                };
                let result = match response.outcome {
                    ControlResponseOutcome::Success { result } => result,
                    ControlResponseOutcome::Error { error } => {
                        break Err(control_error_message(error));
                    }
                };
                match result {
                    ControlResult::ChatMessageAccepted { message_id, .. } => {
                        let cancel_turn = app
                            .state::<ComputeState>()
                            .active_agent_turns
                            .lock()
                            .ok()
                            .and_then(|mut turns| {
                                let turn = turns.get_mut(&local_session_id)?;
                                turn.message_id = Some(message_id);
                                turn.cancel_requested.then(|| turn.clone())
                            });
                        if let Some(turn) = cancel_turn {
                            let stop_app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = request_remote_agent_stop(&stop_app, turn).await;
                            });
                        }
                    }
                    ControlResult::ChatMessageEvent { event, .. } => {
                        emit_remote_agent_event(&app, &local_session_id, event);
                    }
                    ControlResult::ChatMessageDelta { delta, .. } => {
                        let _ = app.emit(
                            "chat-delta",
                            serde_json::json!({
                                "sessionId": &local_session_id,
                                "text": delta,
                            }),
                        );
                    }
                    ControlResult::ChatMessageCompleted { text, .. } => break Ok(text),
                    ControlResult::ChatMessageCancelled { .. } => {
                        break Err("cancelled by user".to_string());
                    }
                    ControlResult::ChatMessageActivity { .. } => {}
                    _ => {}
                }
            };
            finish_agent_request(&app, &request_id);
            result
        }
    };
    if let Ok(mut turns) = app.state::<ComputeState>().active_agent_turns.lock() {
        turns.remove(&local_session_id);
    }
    result
}

#[tauri::command]
pub async fn remote_agent_chat_cancel(
    app: AppHandle,
    local_session_id: String,
) -> Result<(), String> {
    let turn = {
        let state = app.state::<ComputeState>();
        let mut turns = state
            .active_agent_turns
            .lock()
            .map_err(|_| "remote Agent turn state poisoned".to_string())?;
        let Some(turn) = turns.get_mut(local_session_id.trim()) else {
            return Ok(());
        };
        if turn.message_id.is_none() {
            turn.cancel_requested = true;
            return Ok(());
        }
        turn.clone()
    };
    request_remote_agent_stop(&app, turn).await
}

#[tauri::command]
pub fn compute_node_config_get(state: State<ComputeState>) -> Result<ComputeNodeConfig, String> {
    state
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|_| "compute node config lock poisoned".to_string())
}

#[tauri::command]
pub fn compute_node_config_set(
    state: State<ComputeState>,
    display_name: String,
    accept_remote_jobs: bool,
    accept_remote_agent_chats: bool,
    max_parallel_jobs: usize,
) -> Result<ComputeNodeConfig, String> {
    let display_name = display_name.trim();
    if display_name.is_empty() || display_name.len() > 128 {
        return Err("compute node name must contain 1 to 128 characters".to_string());
    }
    if max_parallel_jobs == 0 || max_parallel_jobs > 64 {
        return Err("max parallel jobs must be between 1 and 64".to_string());
    }
    let mut config = state
        .config
        .lock()
        .map_err(|_| "compute node config lock poisoned".to_string())?;
    config.display_name = display_name.to_string();
    config.accept_remote_jobs = accept_remote_jobs;
    config.accept_remote_agent_chats = accept_remote_agent_chats;
    config.max_parallel_jobs = max_parallel_jobs;
    save_node_config(&config)?;
    Ok(config.clone())
}

#[tauri::command]
pub fn compute_capabilities(state: State<ComputeState>) -> Result<ComputeNodeCapabilities, String> {
    let config = state
        .config
        .lock()
        .map_err(|_| "compute node config lock poisoned".to_string())?
        .clone();
    Ok(capabilities_for(&config))
}

#[tauri::command]
pub fn compute_jobs_list(
    projects_state: State<ProjectState>,
) -> Result<Vec<ComputeJobRecord>, String> {
    store_for(&projects_state)?
        .list()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn compute_job_get(
    projects_state: State<ProjectState>,
    job_id: ComputeJobId,
) -> Result<ComputeJobRecord, String> {
    store_for(&projects_state)?
        .get(job_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn compute_events_after(
    projects_state: State<ProjectState>,
    input: ComputeEventsInput,
) -> Result<Vec<ComputeJobEvent>, String> {
    store_for(&projects_state)?
        .events_after(input.job_id, input.after_sequence)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn compute_read_log(
    projects_state: State<ProjectState>,
    input: ComputeLogInput,
) -> Result<ComputeLogOutput, String> {
    let bytes = store_for(&projects_state)?
        .read_log(
            input.job_id,
            input.stream,
            input.offset,
            input.max_bytes.unwrap_or(256 * 1024).min(1024 * 1024),
        )
        .map_err(|error| error.to_string())?;
    Ok(ComputeLogOutput {
        next_offset: input
            .offset
            .saturating_add(bytes.len().try_into().unwrap_or(u64::MAX)),
        text: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

#[tauri::command]
pub async fn compute_submit(
    app: AppHandle,
    _state: State<'_, ComputeState>,
    projects_state: State<'_, ProjectState>,
    input: ComputeSubmitInput,
) -> Result<ComputeJobRecord, String> {
    let workspace = projects::current_project_path(&projects_state)?;
    let project_id = projects::active_project_id(&projects_state)?;
    submit_job_at(app, workspace, project_id, input).await
}

async fn submit_job_at(
    app: AppHandle,
    workspace: PathBuf,
    project_id: String,
    input: ComputeSubmitInput,
) -> Result<ComputeJobRecord, String> {
    let state = app.state::<ComputeState>();
    validate_submit_input(&input, &workspace)?;
    let mut request = ComputeJobRequest::new(project_id, input.display_name, input.workload);
    request.protocol_version = CURRENT_PROTOCOL_VERSION;
    request.working_directory = input.working_directory;
    request.environment = input.environment;
    request.artifact_globs = input.artifact_globs;
    if let Some(timeout_secs) = input.timeout_secs {
        request.limits.timeout_secs = timeout_secs.clamp(1, 7 * 24 * 60 * 60);
    }
    if input.max_output_bytes.is_some() {
        request.limits.max_output_bytes = input.max_output_bytes;
    }
    if input.max_artifact_bytes.is_some() {
        request.limits.max_artifact_bytes = input.max_artifact_bytes;
    }

    let target_node_id = input
        .target_node_id
        .as_deref()
        .filter(|node_id| *node_id != "local")
        .map(str::to_string);
    let target = if let Some(node_id) = &target_node_id {
        ComputeTarget::Remote {
            node_id: node_id.clone(),
            node_name: compute_peer_name(&app, node_id).unwrap_or_else(|| node_id.clone()),
        }
    } else {
        ComputeTarget::Local
    };
    let store = store_at(&workspace);
    let record = store
        .create(request.clone(), target)
        .map_err(|error| error.to_string())?;
    if let Some(node_id) = target_node_id {
        state
            .coordinator_jobs
            .lock()
            .map_err(|_| "compute coordinator state poisoned".to_string())?
            .insert(request.job_id, workspace.clone());
        let bundle_workspace = workspace.clone();
        let bundle_store = store.clone();
        let job_id = request.job_id;
        let bundle = tauri::async_runtime::spawn_blocking(move || {
            create_compute_bundle(&bundle_workspace, &bundle_store, job_id)
        })
        .await
        .map_err(|error| error.to_string())??;
        request.input_bundle_digest = Some(bundle.sha256.clone());
        if let Err(error) = send_remote_submission(&app, &node_id, &request, &bundle).await {
            let _ = fail_coordinator_job(&app, request.job_id, error.clone());
            return Err(error);
        }
        return store.get(request.job_id).map_err(|error| error.to_string());
    }
    let max_parallel_jobs = state
        .config
        .lock()
        .map_err(|_| "compute node config lock poisoned".to_string())?
        .max_parallel_jobs;
    if state
        .cancellations
        .lock()
        .map_err(|_| "compute cancellation state poisoned".to_string())?
        .len()
        >= max_parallel_jobs
    {
        let error = "this compute worker has reached its parallel job limit".to_string();
        if let Ok(event) = store.append(
            request.job_id,
            ComputeJobEventPayload::Completed {
                result: failed_result(&request, error.clone()),
            },
        ) {
            let _ = app.emit(COMPUTE_JOB_EVENT, event);
        }
        return Err(error);
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .cancellations
        .lock()
        .map_err(|_| "compute cancellation state poisoned".to_string())?
        .insert(request.job_id, Arc::clone(&cancelled));
    let node_config = state
        .config
        .lock()
        .map_err(|_| "compute node config lock poisoned".to_string())?
        .clone();
    let identity = WorkerIdentity {
        device_id: Some(node_config.node_id),
        display_name: Some(node_config.display_name),
        environment_fingerprint: Some(environment_fingerprint()),
    };
    let job_id = request.job_id;
    tauri::async_runtime::spawn_blocking(move || {
        let execution = if matches!(request.workload, ComputeWorkload::Notebook { .. }) {
            run_notebook_job(
                &app,
                &store,
                &workspace,
                &request,
                Arc::clone(&cancelled),
                &identity,
            )
            .map(|_| ())
        } else {
            let runner = ComputeRunner::new(store.clone(), workspace, identity);
            runner
                .run(&request, cancelled.as_ref(), |event| {
                    let _ = app.emit(COMPUTE_JOB_EVENT, event);
                })
                .map(|_| ())
                .map_err(|error| error.to_string())
        };
        if let Err(error) = execution {
            let result = failed_result(&request, error.to_string());
            if let Ok(event) = store.append(
                job_id,
                ComputeJobEventPayload::Completed {
                    result: result.clone(),
                },
            ) {
                let _ = app.emit(COMPUTE_JOB_EVENT, event);
            }
        }
        let state = app.state::<ComputeState>();
        if let Ok(mut cancellations) = state.cancellations.lock() {
            cancellations.remove(&job_id);
        };
    });
    Ok(record)
}

pub(crate) fn submit_from_tool(
    app: AppHandle,
    workspace: PathBuf,
    project_id: String,
    input: ComputeSubmitInput,
) -> Result<ComputeJobRecord, String> {
    tauri::async_runtime::block_on(submit_job_at(app, workspace, project_id, input))
}

pub(crate) fn tool_nodes(app: &AppHandle) -> Result<serde_json::Value, String> {
    let local = app
        .state::<ComputeState>()
        .config
        .lock()
        .map_err(|_| "compute node config lock poisoned".to_string())
        .map(|config| capabilities_for(&config))?;
    let peers = compute_peers_list(app.clone())?;
    Ok(serde_json::json!({
        "local": local,
        "peers": peers,
        "routing": {
            "preferred": "p2p_webrtc",
            "fallback": "end_to_end_encrypted_server_relay"
        }
    }))
}

pub(crate) fn wait_for_tool_result(
    app: &AppHandle,
    workspace: &Path,
    job_id: ComputeJobId,
    cancelled: &AtomicBool,
) -> Result<serde_json::Value, String> {
    let store = store_at(workspace);
    loop {
        let record = store.get(job_id).map_err(|error| error.to_string())?;
        if record.status.is_terminal() {
            let stdout = store
                .read_log(job_id, ComputeLogStream::Stdout, 0, 128 * 1024)
                .map_err(|error| error.to_string())?;
            let stderr = store
                .read_log(job_id, ComputeLogStream::Stderr, 0, 128 * 1024)
                .map_err(|error| error.to_string())?;
            return Ok(serde_json::json!({
                "job": record,
                "stdout": String::from_utf8_lossy(&stdout),
                "stderr": String::from_utf8_lossy(&stderr),
                "logsTruncated": record.result.as_ref().is_some_and(|result| {
                    result.stdout_bytes > stdout.len() as u64 || result.stderr_bytes > stderr.len() as u64
                }),
            }));
        }
        if cancelled.load(Ordering::SeqCst) || runtime::is_interrupted() {
            match &record.target {
                ComputeTarget::Remote { node_id, .. } => {
                    let _ = send_peer_message(app, node_id, ComputeWireMessage::Cancel { job_id });
                }
                ComputeTarget::Local => {
                    if let Ok(cancellations) = app.state::<ComputeState>().cancellations.lock() {
                        if let Some(flag) = cancellations.get(&job_id) {
                            flag.store(true, Ordering::SeqCst);
                        }
                    }
                }
            }
            return Err("interrupted by user".to_string());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[tauri::command]
pub fn compute_cancel(
    app: AppHandle,
    state: State<ComputeState>,
    projects_state: State<ProjectState>,
    job_id: ComputeJobId,
) -> Result<ComputeJobRecord, String> {
    let record = store_for(&projects_state)?
        .get(job_id)
        .map_err(|error| error.to_string())?;
    if record.status.is_terminal() {
        return Ok(record);
    }
    match &record.target {
        ComputeTarget::Remote { node_id, .. } => {
            send_peer_message(&app, node_id, ComputeWireMessage::Cancel { job_id })?;
        }
        ComputeTarget::Local => {
            let cancellation = state
                .cancellations
                .lock()
                .map_err(|_| "compute cancellation state poisoned".to_string())?
                .get(&job_id)
                .cloned()
                .ok_or_else(|| "the job is not running on this desktop".to_string())?;
            cancellation.store(true, Ordering::SeqCst);
        }
    }
    Ok(record)
}

pub fn cancel_all(state: &ComputeState) {
    if let Ok(mut shutdown) = state.transport_shutdown.lock() {
        if let Some(sender) = shutdown.take() {
            let _ = sender.send(true);
        }
    }
    if let Ok(cancellations) = state.cancellations.lock() {
        for cancellation in cancellations.values() {
            cancellation.store(true, Ordering::SeqCst);
        }
    }
}

pub(crate) fn capabilities_for(config: &ComputeNodeConfig) -> ComputeNodeCapabilities {
    ComputeNodeCapabilities {
        node_id: config.node_id,
        display_name: config.display_name.clone(),
        platform: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        logical_cpus: std::thread::available_parallelism()
            .map(std::num::NonZeroUsize::get)
            .unwrap_or(1),
        supports_command: true,
        supports_python: true,
        supports_notebook: true,
        max_parallel_jobs: config.max_parallel_jobs,
        worker_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

fn store_for(projects: &ProjectState) -> Result<ComputeJobStore, String> {
    Ok(store_at(&projects::current_project_path(projects)?))
}

fn store_at(workspace: &Path) -> ComputeJobStore {
    ComputeJobStore::new(workspace.join(".somniq").join(COMPUTE_DIR))
}

fn validate_submit_input(input: &ComputeSubmitInput, workspace: &Path) -> Result<(), String> {
    if input.display_name.trim().is_empty() || input.display_name.len() > 256 {
        return Err("compute job name must contain 1 to 256 characters".to_string());
    }
    let working_directory = Path::new(&input.working_directory);
    if working_directory.is_absolute()
        || working_directory
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("compute working directory must stay inside the project".to_string());
    }
    let resolved = workspace.join(working_directory);
    if !resolved.is_dir() {
        return Err(format!(
            "compute working directory does not exist: {}",
            input.working_directory
        ));
    }
    validate_compute_payload(&input.workload, &input.environment, &input.artifact_globs)?;
    if input
        .max_output_bytes
        .is_some_and(|value| value == 0 || value > 1024 * 1024 * 1024)
    {
        return Err("compute output limit must be between 1 byte and 1 GiB".to_string());
    }
    if input
        .max_artifact_bytes
        .is_some_and(|value| value == 0 || value > 4 * 1024 * 1024 * 1024)
    {
        return Err("compute artifact limit must be between 1 byte and 4 GiB".to_string());
    }
    Ok(())
}

fn validate_wire_job_request(request: &ComputeJobRequest) -> Result<(), String> {
    if !request.protocol_version.is_supported() {
        return Err("unsupported compute protocol version".to_string());
    }
    if request.project_id.trim().is_empty() || request.project_id.len() > 256 {
        return Err("compute project id is invalid".to_string());
    }
    if request.display_name.trim().is_empty() || request.display_name.len() > 256 {
        return Err("compute job name must contain 1 to 256 characters".to_string());
    }
    validate_relative_job_path(&request.working_directory)?;
    validate_compute_payload(
        &request.workload,
        &request.environment,
        &request.artifact_globs,
    )?;
    if request.limits.timeout_secs == 0 || request.limits.timeout_secs > 7 * 24 * 60 * 60 {
        return Err("compute timeout is outside the supported range".to_string());
    }
    if request
        .limits
        .max_output_bytes
        .is_some_and(|value| value == 0 || value > 1024 * 1024 * 1024)
    {
        return Err("compute output limit must be between 1 byte and 1 GiB".to_string());
    }
    if request
        .limits
        .max_artifact_bytes
        .is_some_and(|value| value == 0 || value > 4 * 1024 * 1024 * 1024)
    {
        return Err("compute artifact limit must be between 1 byte and 4 GiB".to_string());
    }
    if let Some(digest) = &request.input_bundle_digest {
        validate_sha256(digest)?;
    }
    Ok(())
}

fn validate_compute_payload(
    workload: &ComputeWorkload,
    environment: &BTreeMap<String, String>,
    artifact_globs: &[String],
) -> Result<(), String> {
    if environment.len() > 64 {
        return Err("compute environment contains more than 64 variables".to_string());
    }
    let mut environment_bytes = 0_usize;
    for (name, value) in environment {
        if name.is_empty()
            || name.len() > 128
            || name.contains('=')
            || name.contains('\0')
            || name.chars().any(char::is_whitespace)
            || value.len() > 16 * 1024
        {
            return Err("compute environment contains an invalid variable".to_string());
        }
        environment_bytes = environment_bytes.saturating_add(name.len() + value.len());
    }
    if environment_bytes > 64 * 1024 {
        return Err("compute environment exceeds 64 KiB".to_string());
    }
    if artifact_globs.len() > 64
        || artifact_globs
            .iter()
            .any(|pattern| pattern.is_empty() || pattern.len() > 512)
    {
        return Err("compute artifact globs are invalid or exceed their limit".to_string());
    }
    let validate_args = |args: &[String]| {
        if args.len() > 1_024 || args.iter().any(|arg| arg.len() > 8 * 1024) {
            Err("compute command arguments exceed their limit".to_string())
        } else {
            Ok(())
        }
    };
    match workload {
        ComputeWorkload::Command { executable, args } => {
            if executable.trim().is_empty() || executable.len() > 4 * 1024 {
                return Err("compute executable is invalid".to_string());
            }
            validate_args(args)
        }
        ComputeWorkload::Python {
            entrypoint,
            args,
            interpreter,
        } => {
            validate_relative_job_path(entrypoint)?;
            if entrypoint.is_empty()
                || entrypoint.len() > 4 * 1024
                || interpreter
                    .as_ref()
                    .is_some_and(|value| value.len() > 4 * 1024)
            {
                return Err("compute Python workload is invalid".to_string());
            }
            validate_args(args)
        }
        ComputeWorkload::Notebook {
            notebook_path,
            kernel,
            parameters,
            ..
        } => {
            validate_relative_job_path(notebook_path)?;
            if notebook_path.is_empty()
                || notebook_path.len() > 4 * 1024
                || kernel.as_ref().is_some_and(|value| value.len() > 256)
                || serde_json::to_vec(parameters)
                    .map_err(|error| error.to_string())?
                    .len()
                    > 192 * 1024
            {
                return Err("compute notebook workload is invalid or too large".to_string());
            }
            Ok(())
        }
    }
}

fn failed_result(request: &ComputeJobRequest, error: String) -> ComputeResultManifest {
    ComputeResultManifest {
        job_id: request.job_id,
        status: ComputeJobStatus::Failed,
        exit_code: None,
        started_at_unix_ms: None,
        finished_at_unix_ms: now_unix_ms(),
        duration_ms: None,
        stdout_bytes: 0,
        stderr_bytes: 0,
        artifacts: Vec::new(),
        metrics: BTreeMap::new(),
        error: Some(error),
        worker_device_id: None,
        worker_name: None,
        environment_fingerprint: Some(environment_fingerprint()),
    }
}

fn run_notebook_job(
    app: &AppHandle,
    store: &ComputeJobStore,
    workspace: &Path,
    request: &ComputeJobRequest,
    cancelled: Arc<AtomicBool>,
    identity: &WorkerIdentity,
) -> Result<ComputeResultManifest, String> {
    let ComputeWorkload::Notebook {
        notebook_path,
        kernel,
        parameters,
        stop_on_error,
    } = &request.workload
    else {
        return Err("notebook adapter received a non-notebook workload".to_string());
    };
    validate_relative_job_path(notebook_path)?;
    validate_relative_job_path(&request.working_directory)?;
    let working_directory = workspace.join(&request.working_directory);
    let source = working_directory.join(notebook_path);
    if !source.is_file() {
        return Err(format!("notebook does not exist: {notebook_path}"));
    }
    let job_id = request.job_id;
    emit_compute_event(
        app,
        store,
        job_id,
        ComputeJobEventPayload::Status {
            status: ComputeJobStatus::Preparing,
            message: Some("preparing notebook execution".to_string()),
        },
    )?;
    let output = store.artifacts_dir(job_id).join("executed.ipynb");
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let started_at = now_unix_ms();
    let started = Instant::now();
    emit_compute_event(
        app,
        store,
        job_id,
        ComputeJobEventPayload::Status {
            status: ComputeJobStatus::Running,
            message: Some("notebook kernel started".to_string()),
        },
    )?;

    let session_id = format!("compute:{job_id}");
    let watcher_session = session_id.clone();
    let watcher_cancelled = Arc::clone(&cancelled);
    let watcher_finished = Arc::new(AtomicBool::new(false));
    let watcher_finished_thread = Arc::clone(&watcher_finished);
    let timed_out = Arc::new(AtomicBool::new(false));
    let timed_out_thread = Arc::clone(&timed_out);
    let timeout = Duration::from_secs(request.limits.timeout_secs.max(1));
    let watcher = std::thread::spawn(move || {
        let watcher_started = Instant::now();
        while !watcher_finished_thread.load(Ordering::SeqCst) {
            if watcher_cancelled.load(Ordering::SeqCst) {
                let _ = notebook::KernelManager::interrupt(&watcher_session);
                break;
            }
            if watcher_started.elapsed() >= timeout {
                timed_out_thread.store(true, Ordering::SeqCst);
                let _ = notebook::KernelManager::interrupt(&watcher_session);
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    let options = notebook::RunOptions {
        stop_on_error: *stop_on_error,
        timeout,
        kernel: kernel.clone(),
        parameters: if parameters.is_empty() {
            None
        } else {
            Some(
                parameters
                    .iter()
                    .map(|(name, value)| (name.clone(), value.clone()))
                    .collect(),
            )
        },
        write_to: Some(output.clone()),
    };
    let run = notebook::run_all(&session_id, &source, &options);
    watcher_finished.store(true, Ordering::SeqCst);
    let _ = watcher.join();
    let _ = notebook::KernelManager::shutdown(&session_id);
    let (reported_status, ran, run_error) = match run {
        Ok(report) => (Some(report.status), report.ran, None),
        Err(error) => (None, 0, Some(error.to_string())),
    };
    let (status, error) = if cancelled.load(Ordering::SeqCst) {
        (
            ComputeJobStatus::Cancelled,
            Some("cancelled by coordinator".to_string()),
        )
    } else if timed_out.load(Ordering::SeqCst) {
        (
            ComputeJobStatus::TimedOut,
            Some(format!(
                "notebook exceeded the {} second timeout",
                request.limits.timeout_secs
            )),
        )
    } else {
        match reported_status {
            None => (
                ComputeJobStatus::Failed,
                run_error.or_else(|| Some("notebook execution failed".to_string())),
            ),
            Some(notebook::ExecStatus::Ok) => (ComputeJobStatus::Succeeded, None),
            Some(notebook::ExecStatus::Error) => (
                ComputeJobStatus::Failed,
                Some("one or more notebook cells failed".to_string()),
            ),
            Some(notebook::ExecStatus::Timeout) => (
                ComputeJobStatus::TimedOut,
                Some("one or more notebook cells timed out".to_string()),
            ),
        }
    };
    let artifacts = if output.is_file() {
        let artifact = compute::ComputeArtifact {
            path: "executed.ipynb".to_string(),
            size_bytes: std::fs::metadata(&output)
                .map_err(|error| error.to_string())?
                .len(),
            sha256: sha256_path(&output)?,
            media_type: Some("application/x-ipynb+json".to_string()),
        };
        emit_compute_event(
            app,
            store,
            job_id,
            ComputeJobEventPayload::Artifact {
                artifact: artifact.clone(),
            },
        )?;
        vec![artifact]
    } else {
        Vec::new()
    };
    let summary = format!("Notebook completed: {ran} cell(s), status {status:?}\n");
    let offset = store
        .append_log(job_id, ComputeLogStream::Stdout, summary.as_bytes())
        .map_err(|error| error.to_string())?;
    emit_compute_event(
        app,
        store,
        job_id,
        ComputeJobEventPayload::Log {
            stream: ComputeLogStream::Stdout,
            text: summary,
            offset,
        },
    )?;
    let result = ComputeResultManifest {
        job_id,
        status,
        exit_code: None,
        started_at_unix_ms: Some(started_at),
        finished_at_unix_ms: now_unix_ms(),
        duration_ms: Some(started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)),
        stdout_bytes: store
            .read_log(job_id, ComputeLogStream::Stdout, 0, usize::MAX)
            .map(|bytes| bytes.len().try_into().unwrap_or(u64::MAX))
            .unwrap_or_default(),
        stderr_bytes: 0,
        artifacts,
        metrics: BTreeMap::from([("cellsRan".to_string(), serde_json::Value::from(ran))]),
        error,
        worker_device_id: identity.device_id,
        worker_name: identity.display_name.clone(),
        environment_fingerprint: identity.environment_fingerprint.clone(),
    };
    emit_compute_event(
        app,
        store,
        job_id,
        ComputeJobEventPayload::Completed {
            result: result.clone(),
        },
    )?;
    Ok(result)
}

fn emit_compute_event(
    app: &AppHandle,
    store: &ComputeJobStore,
    job_id: ComputeJobId,
    payload: ComputeJobEventPayload,
) -> Result<(), String> {
    let event = store
        .append(job_id, payload)
        .map_err(|error| error.to_string())?;
    app.emit(COMPUTE_JOB_EVENT, event)
        .map_err(|error| error.to_string())
}

fn validate_relative_job_path(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("job path must stay inside the project: {value}"));
    }
    Ok(())
}

fn sha256_path(path: &Path) -> Result<String, String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let size = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if size == 0 {
            break;
        }
        hasher.update(&buffer[..size]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn node_config_path() -> PathBuf {
    crate::state::desktop_runtime_dir().join(NODE_CONFIG_FILE)
}

fn peer_store_path() -> PathBuf {
    crate::state::desktop_runtime_dir().join(PEER_STORE_FILE)
}

const fn peer_store_version() -> u32 {
    1
}

fn legacy_compute_scopes() -> DeviceScopes {
    DeviceScopes::from([DeviceScope::ComputeJobs])
}

fn default_compute_ice_servers() -> Vec<String> {
    vec![crate::remote::MANAGED_REMOTE_STUN_SERVER.to_string()]
}

fn load_peer_store() -> ComputePeerStore {
    std::fs::read(peer_store_path())
        .ok()
        .and_then(|body| serde_json::from_slice::<ComputePeerStore>(&body).ok())
        .filter(|store| store.version == peer_store_version())
        .unwrap_or_default()
}

fn save_peer_store(store: &ComputePeerStore) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(store).map_err(|error| error.to_string())?;
    runtime::write_file_atomically(&peer_store_path(), body).map_err(|error| error.to_string())
}

fn decode_pairing_link(value: &str) -> Result<PairingInvitation, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 64 * 1024 {
        return Err("computer pairing link is empty or too large".to_string());
    }
    if value.starts_with('{') {
        return serde_json::from_str(value)
            .map_err(|_| "computer pairing JSON is malformed".to_string());
    }
    let parsed =
        reqwest::Url::parse(value).map_err(|_| "computer pairing link is malformed".to_string())?;
    let fragment = parsed
        .fragment()
        .and_then(|fragment| fragment.strip_prefix("p="))
        .ok_or_else(|| "computer pairing link does not contain an invitation".to_string())?;
    let payload = URL_SAFE_NO_PAD
        .decode(fragment.as_bytes())
        .map_err(|_| "computer pairing invitation is not valid base64url".to_string())?;
    serde_json::from_slice(&payload)
        .map_err(|_| "computer pairing invitation JSON is malformed".to_string())
}

fn compute_identity_account(device_id: DeviceId) -> String {
    format!("node-identity-{device_id}")
}

fn compute_token_account(device_id: DeviceId) -> String {
    format!("node-token-{device_id}")
}

fn compute_keyring_entry(account: &str) -> Result<KeyringEntry, String> {
    KeyringEntry::new(COMPUTE_KEYRING_SERVICE, account)
        .map_err(|error| format!("cannot access operating-system credential store: {error}"))
}

fn write_compute_secret(account: &str, secret: &[u8]) -> Result<(), String> {
    compute_keyring_entry(account)?
        .set_secret(secret)
        .map_err(|error| format!("cannot write operating-system credential store: {error}"))
}

fn read_compute_secret(account: &str) -> Result<Option<Vec<u8>>, String> {
    match compute_keyring_entry(account)?.get_secret() {
        Ok(secret) => Ok(Some(secret)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "cannot read operating-system credential store: {error}"
        )),
    }
}

fn store_compute_peer_secrets(
    local_device_id: DeviceId,
    signing_secret: &[u8; 32],
    agreement_secret: &[u8; 32],
    activation_token: &str,
) -> Result<(), String> {
    let mut identity = Vec::with_capacity(64);
    identity.extend_from_slice(signing_secret);
    identity.extend_from_slice(agreement_secret);
    write_compute_secret(&compute_identity_account(local_device_id), &identity)?;
    if let Err(error) = write_compute_secret(
        &compute_token_account(local_device_id),
        activation_token.as_bytes(),
    ) {
        let _ =
            compute_keyring_entry(&compute_identity_account(local_device_id)).and_then(|entry| {
                entry
                    .delete_credential()
                    .map_err(|delete_error| delete_error.to_string())
            });
        return Err(error);
    }
    Ok(())
}

fn load_or_create_node_config() -> Result<ComputeNodeConfig, String> {
    let path = node_config_path();
    if path.exists() {
        let body = std::fs::read(&path).map_err(|error| error.to_string())?;
        let config = serde_json::from_slice::<ComputeNodeConfig>(&body)
            .map_err(|error| error.to_string())?;
        return Ok(config);
    }
    let config = ComputeNodeConfig::default();
    save_node_config(&config)?;
    Ok(config)
}

fn save_node_config(config: &ComputeNodeConfig) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    runtime::write_file_atomically(&node_config_path(), bytes).map_err(|error| error.to_string())
}

fn default_node_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "SomniQ computer".to_string())
}

fn environment_fingerprint() -> String {
    format!(
        "{}-{}-somniq-{}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        env!("CARGO_PKG_VERSION")
    )
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_working_directory_escape() {
        let temp = tempfile::tempdir().expect("tempdir");
        let input = ComputeSubmitInput {
            display_name: "job".to_string(),
            workload: ComputeWorkload::Command {
                executable: "echo".to_string(),
                args: Vec::new(),
            },
            working_directory: "../outside".to_string(),
            environment: BTreeMap::new(),
            artifact_globs: Vec::new(),
            timeout_secs: None,
            max_output_bytes: None,
            max_artifact_bytes: None,
            target_node_id: None,
        };
        assert!(validate_submit_input(&input, temp.path()).is_err());
    }

    #[test]
    fn capabilities_reflect_worker_config() {
        let config = ComputeNodeConfig {
            display_name: "GPU box".to_string(),
            max_parallel_jobs: 4,
            ..ComputeNodeConfig::default()
        };
        let capabilities = capabilities_for(&config);
        assert_eq!(capabilities.display_name, "GPU box");
        assert_eq!(capabilities.max_parallel_jobs, 4);
        assert!(capabilities.supports_python);
    }

    #[test]
    fn source_bundle_excludes_credentials_and_dependency_caches() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(temp.path().join("run.py"), "print('ok')").expect("source");
        fs::write(temp.path().join(".env"), "TOKEN=secret").expect("env");
        fs::create_dir_all(temp.path().join("node_modules").join("package")).expect("cache");
        fs::write(
            temp.path()
                .join("node_modules")
                .join("package")
                .join("index.js"),
            "secret cache",
        )
        .expect("cached file");
        let store = ComputeJobStore::new(temp.path().join(".somniq").join("compute"));
        let bundle =
            create_compute_bundle(temp.path(), &store, ComputeJobId::new()).expect("bundle");
        let file = fs::File::open(bundle.path).expect("open bundle");
        let mut archive = zip::ZipArchive::new(file).expect("zip");
        let names = (0..archive.len())
            .map(|index| archive.by_index(index).expect("entry").name().to_string())
            .collect::<Vec<_>>();
        assert!(names.iter().any(|name| name == "run.py"));
        assert!(!names.iter().any(|name| name.contains(".env")));
        assert!(!names.iter().any(|name| name.contains("node_modules")));
        assert!(!names.iter().any(|name| name.contains(".somniq")));
    }
}
