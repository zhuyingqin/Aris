//! Brokered Image Assist peer handling.
//!
//! This module owns every frame that arrives from a brokered stranger. It is
//! deliberately separate from `compute`: a brokered peer has no pairing edge,
//! no persisted record, and no scope grant beyond `ImageAssist`, so it must
//! never reach `compute::handle_peer_message` or
//! `remote::execute_control_request`.
//!
//! Two boundaries here carry untrusted data in opposite directions, and both
//! are enforced rather than trusted:
//!
//! - outbound, the helper must not leak its own account identity, ChatGPT
//!   session, or local paths into the manifest it returns;
//! - inbound, the requester must treat returned image bytes as arbitrary input
//!   from an unknown party.
//!
//! See `docs/development-logic/image-assist-network.md`.

use crate::remote::RemoteWireSession;
use chrono::Datelike as _;
use remote_protocol::{
    validate_artifact_manifest, validate_artifact_name, DeviceDescriptor, DeviceId,
    DeviceSignature, ImageArtifactEntry, ImageAssistClientFrame, ImageAssistFailure,
    ImageAssistLocation, ImageAssistServerFrame, ImageAssistTranscript, ImageAssistWireMessage,
    MatchFailure, MatchId, RequestId, SessionId, CURRENT_PROTOCOL_VERSION,
    IMAGE_ASSIST_MAX_ARTIFACTS, IMAGE_ASSIST_MAX_ARTIFACT_BYTES,
    IMAGE_ASSIST_MAX_ARTIFACT_CHUNK_BYTES, IMAGE_ASSIST_MAX_ICE_SERVERS,
    IMAGE_ASSIST_MAX_TOTAL_ARTIFACT_BYTES,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// Image types a brokered helper may return, paired with the extension used to
/// build a safe name and the magic bytes that must confirm it.
const ALLOWED_IMAGE_TYPES: [(&str, &str); 3] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/webp", "webp"),
];

/// What the helper's local user approved, kept until the request arrives.
///
/// The digest is the whole point: approval happened over the sealed preview at
/// the gateway stage, and the request that later arrives over the peer channel
/// must be the same one. Without this binding, a requester could preview a
/// harmless prompt and then send a different one.
#[derive(Debug, Clone)]
pub(crate) struct ApprovedRequest {
    pub(crate) request_id: RequestId,
    pub(crate) request_digest: [u8; 32],
    /// Set while holding the runtime mutex before a generation worker is
    /// spawned. This is the one-shot boundary for an approved match.
    pub(crate) consumed: bool,
    /// The global daily allowance reservation follows the approval until the
    /// one permitted request either completes or fails before producing an
    /// image. It must not be committed merely because the gateway accepted the
    /// match.
    allowance_reserved: bool,
}

/// Images generated for one request, held for the requester to read in chunks.
#[derive(Debug, Clone)]
struct ServedArtifacts {
    /// The transport session the approved match is being served over. Reads
    /// are answered only on that session, so a second brokered channel cannot
    /// name someone else's request id and pull their images.
    session_id: String,
    entries: Vec<ImageArtifactEntry>,
    bytes: Vec<(String, Vec<u8>)>,
}

/// The helper's own policy. Off by default: serving strangers is opt-in.
#[derive(Debug, Clone)]
pub(crate) struct HelperPolicy {
    pub(crate) accept_image_help: bool,
    pub(crate) daily_limit: u32,
}

impl Default for HelperPolicy {
    fn default() -> Self {
        Self {
            accept_image_help: false,
            daily_limit: 10,
        }
    }
}

/// Daily allowance, counted against the helper's own local day.
///
/// The boundary is the helper's local date rather than UTC: the limit exists to
/// protect a person's account and attention, and "today" for that person is
/// their own calendar day.
#[derive(Debug, Clone, Default)]
pub(crate) struct DailyAllowance {
    day: Option<i64>,
    committed: u32,
    reserved: u32,
}

impl DailyAllowance {
    /// Holds one unit while a matched request is being accepted.
    ///
    /// Reserving rather than counting at acceptance time is what stops two
    /// concurrent matches from both reading the same remaining allowance.
    pub(crate) fn reserve(&mut self, limit: u32, local_day: i64) -> bool {
        if self.day != Some(local_day) {
            self.day = Some(local_day);
            self.committed = 0;
            self.reserved = 0;
        }
        if self.committed.saturating_add(self.reserved) >= limit {
            return false;
        }
        self.reserved += 1;
        true
    }

    pub(crate) fn commit(&mut self) {
        self.reserved = self.reserved.saturating_sub(1);
        self.committed = self.committed.saturating_add(1);
    }

    pub(crate) fn release(&mut self) {
        self.reserved = self.reserved.saturating_sub(1);
    }

    pub(crate) fn remaining(&self, limit: u32, local_day: i64) -> u32 {
        if self.day != Some(local_day) {
            return limit;
        }
        limit.saturating_sub(self.committed.saturating_add(self.reserved))
    }
}

/// Why a brokered request was refused before it ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RefusalReason {
    /// The helper's local user has not opted in.
    NotAccepting,
    /// The peer has not proved it is the party the gateway introduced.
    PeerUnverified,
    /// The request does not correspond to anything this session approved.
    NotApproved,
    /// The requester changed the identifier sealed into the approved preview.
    RequestIdMismatch,
    /// The one request authorized by this approval already started.
    AlreadyConsumed,
    /// The delivered request differs from the approved preview.
    DigestMismatch,
    /// The daily allowance is spent.
    QuotaExhausted,
}

impl RefusalReason {
    pub(crate) fn failure(self) -> ImageAssistFailure {
        match self {
            Self::NotAccepting | Self::QuotaExhausted => ImageAssistFailure::HelperUnavailable,
            Self::PeerUnverified
            | Self::NotApproved
            | Self::RequestIdMismatch
            | Self::AlreadyConsumed
            | Self::DigestMismatch => ImageAssistFailure::RequestMismatch,
        }
    }
}

/// Decides whether a delivered request may run.
///
/// Pure, so the security-relevant decision can be tested without an Oracle
/// runtime, a browser, or a live peer.
pub(crate) fn authorize_request(
    policy: &HelperPolicy,
    peer_verified: bool,
    approved: Option<&ApprovedRequest>,
    request_id: RequestId,
    prompt: &str,
    aspect_ratio: Option<&str>,
    allowance_available: bool,
) -> Result<(), RefusalReason> {
    if !policy.accept_image_help {
        return Err(RefusalReason::NotAccepting);
    }
    // Separate from the Settings consent: the local user approved this
    // capability, and the
    // transcript is what proves the channel delivering this request belongs to
    // the peer that match introduced.
    if !peer_verified {
        return Err(RefusalReason::PeerUnverified);
    }
    let Some(approved) = approved else {
        return Err(RefusalReason::NotApproved);
    };
    if approved.request_id != request_id {
        return Err(RefusalReason::RequestIdMismatch);
    }
    if approved.consumed {
        return Err(RefusalReason::AlreadyConsumed);
    }
    if request_digest(prompt, aspect_ratio) != approved.request_digest {
        return Err(RefusalReason::DigestMismatch);
    }
    if !allowance_available {
        return Err(RefusalReason::QuotaExhausted);
    }
    Ok(())
}

/// Serves one bounded slice of one already-generated image.
///
/// A read is answered only for an artifact this request actually produced, so
/// a peer cannot use the chunk protocol to probe for other files.
fn read_artifact_chunk(
    served: &ServedArtifacts,
    name: &str,
    offset: u64,
    max_bytes: u32,
) -> Result<(Vec<u8>, bool), String> {
    validate_artifact_name(name).map_err(|error| error.to_string())?;
    let Some((_, bytes)) = served.bytes.iter().find(|(entry, _)| entry == name) else {
        return Err("no such artifact in this request".to_string());
    };
    let offset =
        usize::try_from(offset).map_err(|_| "artifact offset is out of range".to_string())?;
    if offset > bytes.len() {
        return Err("artifact offset is past the end".to_string());
    }
    let limit = (max_bytes as usize).min(IMAGE_ASSIST_MAX_ARTIFACT_CHUNK_BYTES);
    let end = bytes.len().min(offset.saturating_add(limit));
    Ok((bytes[offset..end].to_vec(), end == bytes.len()))
}

/// Generates images for one approved request.
///
/// The executor is injected so the decision path, the sanitization, and the
/// failure handling can be exercised without an Oracle runtime, a browser, or a
/// signed-in ChatGPT account. In production this is
/// `oracle_web::execute_bound_image_tool`.
#[cfg(test)]
pub(crate) type ImageExecutor<'a> =
    &'a dyn Fn(&str, Option<&str>) -> Result<Vec<(PathBuf, String)>, String>;

/// The outcome of serving one brokered request, as frames to send back.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ServeOutcome {
    Completed { artifacts: Vec<ImageArtifactEntry> },
    Failed { reason: ImageAssistFailure },
}

/// Runs one brokered request end to end on the helper's machine.
///
/// Ordering matters and is deliberate: authorization happens before the
/// allowance is spent, and the allowance is spent before any browser work
/// starts, so a refused request never consumes the helper's ChatGPT quota and
/// never appears in their ChatGPT history.
#[cfg(test)]
pub(crate) fn serve_request(
    policy: &HelperPolicy,
    peer_verified: bool,
    allowance: &mut DailyAllowance,
    local_day: i64,
    request_id: RequestId,
    approved: Option<&mut ApprovedRequest>,
    prompt: &str,
    aspect_ratio: Option<&str>,
    execute: ImageExecutor<'_>,
) -> ServeOutcome {
    let reserved = allowance.reserve(policy.daily_limit, local_day);
    if let Err(reason) = authorize_request(
        policy,
        peer_verified,
        approved.as_deref(),
        request_id,
        prompt,
        aspect_ratio,
        reserved,
    ) {
        if reserved {
            allowance.release();
        }
        return ServeOutcome::Failed {
            reason: reason.failure(),
        };
    }
    // The pure/testable path observes the same one-shot contract as the live
    // runtime. Production performs this transition atomically under the
    // runtime mutex before it spawns a worker.
    if let Some(approved) = approved {
        approved.consumed = true;
    }

    // The canonical form is what was approved and digest-bound, so it is also
    // what runs. Passing the raw text would reintroduce the mismatch the
    // digest exists to prevent.
    let canonical = canonical_prompt(prompt);
    let ratio = canonical_aspect_ratio(aspect_ratio);
    let generated = match execute(&canonical, ratio.as_deref()) {
        Ok(generated) => generated,
        Err(error) => {
            allowance.release();
            eprintln!("SomniQ Image Assist generation failed: {error}");
            return ServeOutcome::Failed {
                reason: ImageAssistFailure::GenerationFailed,
            };
        }
    };

    match build_manifest(&generated) {
        Ok(artifacts) => {
            allowance.commit();
            ServeOutcome::Completed { artifacts }
        }
        Err(error) => {
            // The images exist but cannot be shared safely. Commit anyway: the
            // helper's account already did the work and their quota is spent
            // whether or not the bytes reach the requester.
            allowance.commit();
            eprintln!("SomniQ Image Assist refused to share a generated image: {error}");
            ServeOutcome::Failed {
                reason: ImageAssistFailure::GenerationFailed,
            }
        }
    }
}

/// Events the desktop UI listens for while a brokered match is being set up.
///
/// Named separately from the wire frames because the UI must never be handed a
/// frame it could echo back: the sealed preview, the peer descriptor, and the
/// transport identifiers stay in Rust.
pub(crate) const IMAGE_ASSIST_ROSTER_EVENT: &str = "image-assist-roster";
pub(crate) const IMAGE_ASSIST_MATCH_EVENT: &str = "image-assist-match";
pub(crate) const IMAGE_ASSIST_CONSENT_EVENT: &str = "image-assist-consent";
pub(crate) const IMAGE_ASSIST_ERROR_EVENT: &str = "image-assist-error";

/// Shown to the requester before their prompt leaves this computer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageAssistConsentPrompt {
    pub(crate) consent_id: String,
    pub(crate) prompt: String,
    pub(crate) aspect_ratio: Option<String>,
}

/// Progress the requester's UI shows while a match is being brokered.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageAssistMatchUpdate {
    pub(crate) match_id: Option<String>,
    pub(crate) stage: &'static str,
    pub(crate) detail: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) images: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) transfer_received_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) transfer_total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) transfer_completed_artifacts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) transfer_artifact_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) transfer_direction: Option<&'static str>,
}

fn emit_match_update(
    app: &AppHandle,
    match_id: Option<MatchId>,
    stage: &'static str,
    detail: Option<String>,
) {
    emit_match_update_with_images(app, match_id, stage, detail, Vec::new());
}

fn emit_match_update_with_images(
    app: &AppHandle,
    match_id: Option<MatchId>,
    stage: &'static str,
    detail: Option<String>,
    images: Vec<String>,
) {
    let _ = app.emit(
        IMAGE_ASSIST_MATCH_EVENT,
        ImageAssistMatchUpdate {
            match_id: match_id.map(|id| id.to_string()),
            stage,
            detail,
            images,
            transfer_received_bytes: None,
            transfer_total_bytes: None,
            transfer_completed_artifacts: None,
            transfer_artifact_count: None,
            transfer_direction: None,
        },
    );
}

fn emit_transfer_progress(
    app: &AppHandle,
    match_id: Option<MatchId>,
    direction: &'static str,
    received_bytes: u64,
    total_bytes: u64,
    completed_artifacts: usize,
    artifact_count: usize,
) {
    let _ = app.emit(
        IMAGE_ASSIST_MATCH_EVENT,
        ImageAssistMatchUpdate {
            match_id: match_id.map(|id| id.to_string()),
            stage: "transferring",
            detail: Some(if direction == "sending" {
                "正在通过加密通道回传图片给请求方".to_string()
            } else {
                "正在通过加密通道接收图片".to_string()
            }),
            images: Vec::new(),
            transfer_received_bytes: Some(received_bytes),
            transfer_total_bytes: Some(total_bytes),
            transfer_completed_artifacts: Some(completed_artifacts as u32),
            transfer_artifact_count: Some(artifact_count as u32),
            transfer_direction: Some(direction),
        },
    );
}

/// The plaintext a requester seals for the helper to read before deciding.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewPayload {
    request_id: RequestId,
    prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    aspect_ratio: Option<String>,
}

/// A request this machine started and is waiting to have brokered.
#[derive(Debug, Clone)]
struct PendingRequest {
    request_id: RequestId,
    prompt: String,
    aspect_ratio: Option<String>,
}

/// A request awaiting this machine's local approval.
#[derive(Debug, Clone)]
struct PendingApproval {
    payload: PreviewPayload,
    reserved: bool,
}

/// One approved request that has atomically crossed the one-shot boundary and
/// may have an Oracle browser task in flight.
#[derive(Debug, Clone)]
struct RunningRequest {
    match_id: MatchId,
    cancelled: Arc<AtomicBool>,
    allowance_reserved: bool,
}

/// Optional public metadata remembered independently of a renderer heartbeat.
///
/// The authenticated Rust signal loop renews the lease even while WebView
/// timers are throttled in the background. The renderer updates this profile
/// only when the user changes location sharing.
#[derive(Debug, Clone, Default)]
struct HelperPublication {
    display_name: Option<String>,
    location: Option<ImageAssistLocation>,
}

/// Everything one match's transcript covers, captured when the gateway
/// approved it and before any channel exists.
///
/// Held so both peers can rebuild byte-identical transcripts independently:
/// verification is an equality check against what this machine was told, not a
/// re-derivation from what the peer sent.
#[derive(Debug, Clone)]
struct MatchTransport {
    session_id: SessionId,
    offerer: DeviceId,
    /// Sorted and deduplicated, as the transcript encoding requires.
    ice_servers: Vec<String>,
    expires_at_unix_ms: i64,
    request_digest: [u8; 32],
    /// Which side this machine is. Derived from what this machine actually did
    /// — approved a request, or asked for one — rather than from the role the
    /// gateway assigned, so the two can be checked against each other.
    local_is_helper: bool,
    /// True while this match is trying its initial brokered WebRTC path.
    ///
    /// Once direct negotiation fails, only the requester may mint the relay
    /// fallback. Keeping this transition in the match state makes duplicate
    /// browser timeout/close signals harmless and lets renderer recovery avoid
    /// restarting a direct attempt that has already fallen back.
    direct_attempt: bool,
    /// Set once the peer's transcript matched this machine's own and its proof
    /// verified. Nothing but a transcript is served or sent before this.
    peer_verified: bool,
    /// Set once this machine has done its part: the requester wrote every
    /// image, or the helper served the last slice of the last one.
    ///
    /// Everything about a transport closing looks the same from the transport
    /// layer, so without this a match that just succeeded reports the peer
    /// hanging up as a failure — cancelling a completed match at the gateway
    /// and, on the requester, replacing a delivered result with an error.
    settled: bool,
}

/// Process-local brokering state. Never persisted: a restart cancels in-flight
/// matches rather than resuming a consent decision made before it.
#[derive(Default)]
struct Runtime {
    outbound: HashMap<RequestId, PendingRequest>,
    matches: HashMap<MatchId, RequestId>,
    approvals: HashMap<MatchId, PendingApproval>,
    approved: HashMap<String, ApprovedRequest>,
    /// Finished brokered results, collected by the waiting tool call.
    results: HashMap<RequestId, Result<String, String>>,
    /// Consent dialogs currently open on this machine.
    consents: HashMap<String, std::sync::mpsc::Sender<bool>>,
    /// Peer descriptors for live matches. Held only until the match ends and
    /// never merged into the persisted device store.
    peers: HashMap<MatchId, DeviceDescriptor>,
    /// Requester side: in-flight retrieval of each generated image.
    pulls: HashMap<RequestId, PullState>,
    /// Transport session opened per match, so it can be torn down on close.
    sessions: HashMap<MatchId, String>,
    /// Signed-transcript parameters per match, captured on approval.
    transports: HashMap<MatchId, MatchTransport>,
    /// Transport session id to match, so the channel and frame paths can find
    /// a match without threading one through the P2P layer.
    session_matches: HashMap<String, MatchId>,
    /// Helper side: images generated for a request, held for chunk reads.
    served: HashMap<RequestId, ServedArtifacts>,
    /// Helper side: waits until the requester has actually received the
    /// manifest before claiming that image bytes are being returned.
    result_receipts: HashMap<RequestId, std::sync::mpsc::Sender<()>>,
    /// Helper side: cancellation and quota ownership for the single request
    /// consumed from an approved match.
    running: HashMap<RequestId, RunningRequest>,
    allowance: DailyAllowance,
    helper_publication: HelperPublication,
}

static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();

fn runtime() -> &'static Mutex<Runtime> {
    RUNTIME.get_or_init(|| {
        #[allow(unused_mut)]
        let mut state = Runtime::default();
        #[cfg(not(test))]
        match load_daily_allowance() {
            Ok(allowance) => state.allowance = allowance,
            Err(error) => {
                eprintln!("SomniQ Image Assist could not load its daily allowance: {error}");
            }
        }
        Mutex::new(state)
    })
}

/// The helper's own local day, which is the boundary the daily allowance uses.
fn local_day() -> i64 {
    i64::from(chrono::Local::now().date_naive().num_days_from_ce())
}

const DAILY_ALLOWANCE_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedDailyAllowance {
    version: u32,
    day: Option<i64>,
    committed: u32,
}

#[cfg(not(test))]
fn daily_allowance_path() -> PathBuf {
    crate::state::config_dir().join("image-assist-allowance.json")
}

fn load_daily_allowance_from(path: &Path) -> Result<DailyAllowance, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(DailyAllowance::default()),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let persisted: PersistedDailyAllowance = serde_json::from_slice(&bytes)
        .map_err(|error| format!("cannot parse {}: {error}", path.display()))?;
    if persisted.version != DAILY_ALLOWANCE_VERSION {
        return Err(format!(
            "{} uses unsupported allowance version {}",
            path.display(),
            persisted.version
        ));
    }
    Ok(DailyAllowance {
        day: persisted.day,
        committed: persisted.committed,
        // A process restart cancels every in-flight match, so reservations are
        // deliberately never restored.
        reserved: 0,
    })
}

#[cfg(not(test))]
fn load_daily_allowance() -> Result<DailyAllowance, String> {
    load_daily_allowance_from(&daily_allowance_path())
}

fn persist_daily_allowance_to(path: &Path, allowance: &DailyAllowance) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(&PersistedDailyAllowance {
        version: DAILY_ALLOWANCE_VERSION,
        day: allowance.day,
        committed: allowance.committed,
    })
    .map_err(|error| format!("cannot encode the daily allowance: {error}"))?;
    runtime::write_file_atomically(path, bytes)
        .map_err(|error| format!("cannot persist {}: {error}", path.display()))
}

#[cfg(not(test))]
fn persist_daily_allowance(allowance: &DailyAllowance) {
    if let Err(error) = persist_daily_allowance_to(&daily_allowance_path(), allowance) {
        eprintln!("SomniQ Image Assist could not persist its daily allowance: {error}");
    }
}

#[cfg(test)]
fn persist_daily_allowance(_allowance: &DailyAllowance) {}

/// Registers a request this machine is about to ask the gateway to broker.
///
/// At most one may be outstanding. `on_candidate` has no way to tell which
/// request a candidate belongs to — the gateway's `Candidate` frame carries a
/// match, not a request — so it takes the one that is waiting. With two
/// waiting, it can seal one request's prompt into the other's match, and the
/// prompt the user confirmed is not the one that travels. The gateway also
/// refuses a second concurrent request, but by then the local state is already
/// wrong, so the invariant is enforced where it is created.
pub(crate) fn begin_request(
    request_id: RequestId,
    prompt: &str,
    aspect_ratio: Option<&str>,
) -> Result<(), String> {
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "image assist runtime poisoned".to_string())?;
    if !runtime.outbound.is_empty() {
        return Err(
            "This computer is already waiting on another brokered image request. \
             Try again once it finishes."
                .to_string(),
        );
    }
    runtime.outbound.insert(
        request_id,
        PendingRequest {
            request_id,
            // Canonicalized once, here, so the text that is previewed, signed,
            // digest-bound, and executed is the same text throughout.
            prompt: canonical_prompt(prompt),
            aspect_ratio: canonical_aspect_ratio(aspect_ratio),
        },
    );
    Ok(())
}

/// Forgets a request that failed or completed, and every match it opened.
///
/// A request can be offered to several helpers before one accepts, so dropping
/// only the request would leave each declined candidate's descriptor — and any
/// transport parameters — held for the life of the process.
///
/// The transports go with it. A finished request holds an open relay socket and
/// one of a small number of transport slots; waiting for the peer to hang up
/// first leaks both for as long as that peer stays connected.
pub(crate) fn end_request(app: &AppHandle, request_id: RequestId) {
    let (matches, pull): (Vec<(MatchId, bool)>, Option<PullState>) = {
        let Ok(mut runtime) = runtime().lock() else {
            return;
        };
        runtime.outbound.remove(&request_id);
        let pull = runtime.pulls.remove(&request_id);
        runtime.results.remove(&request_id);
        (
            runtime
                .matches
                .iter()
                .filter(|(_, id)| **id == request_id)
                .map(|(match_id, _)| {
                    (
                        *match_id,
                        runtime
                            .transports
                            .get(match_id)
                            .is_some_and(|transport| transport.settled),
                    )
                })
                .collect(),
            pull,
        )
    };
    if let Some(pull) = pull {
        discard_pull_files(&pull);
    }
    let state = app.state::<crate::remote::RemoteAgentState>();
    for (match_id, settled) in matches {
        let session = brokered_session_for(match_id);
        let _ = crate::remote::send_image_assist_frame(
            state.inner(),
            if settled {
                ImageAssistClientFrame::Closed { match_id }
            } else {
                ImageAssistClientFrame::Cancel { match_id }
            },
        );
        forget_match(match_id);
        if let Some(session) = session {
            crate::remote::release_image_assist_p2p_session(state.inner(), &session);
        }
    }
}

/// Handles one brokering frame from the gateway.
///
/// The gateway is a trusted introducer, not an authority over this machine.
/// The Settings opt-in is the local user's standing consent to spend the
/// configured daily allowance for image assistance; once enabled, matching
/// offers proceed without a second per-request dialog.
pub(crate) fn handle_gateway_frame(app: &AppHandle, frame: ImageAssistServerFrame) {
    match frame {
        ImageAssistServerFrame::Roster { entries } => {
            HELPERS_ONLINE.store(
                entries.iter().any(|entry| entry.available),
                Ordering::Relaxed,
            );
            let _ = app.emit(IMAGE_ASSIST_ROSTER_EVENT, entries);
        }
        ImageAssistServerFrame::MatchFailed { request_id, reason } => {
            // Terminal: the gateway sends this only once no candidate is left,
            // so the waiting tool call ends here instead of sitting out its
            // whole timeout. A decline on its own is not terminal — that
            // arrives as `MatchClosed`, and the next candidate follows it.
            emit_match_update(
                app,
                None,
                "failed",
                Some(format!("{request_id}:{reason:?}")),
            );
            let _ = app.emit(
                IMAGE_ASSIST_ERROR_EVENT,
                unmatched_message(reason).to_string(),
            );
            finish_request(request_id, Err(unmatched_message(reason).to_string()));
        }
        ImageAssistServerFrame::MatchClosed { match_id, reason } => {
            // Both sides release the transport and everything held for the
            // match, whether it completed or died.
            let state = app.state::<crate::remote::RemoteAgentState>();
            let session = brokered_session_for(match_id);
            // A match that never reached approval is one candidate of several:
            // the gateway follows this frame with the next candidate, or with a
            // terminal `MatchFailed`, so the request continues. Past approval
            // there is no next candidate and no further frame, so this is the
            // only chance to tell a waiting tool call that its helper is gone.
            let abandoned = {
                let runtime = runtime().lock().ok();
                runtime.and_then(|runtime| {
                    runtime
                        .transports
                        .contains_key(&match_id)
                        .then(|| runtime.matches.get(&match_id).copied())
                        .flatten()
                })
            };
            let settled = match_settled(match_id);
            forget_match(match_id);
            if let Some(session) = session {
                crate::remote::release_image_assist_p2p_session(state.inner(), &session);
            }
            emit_match_update(app, Some(match_id), "closed", Some(format!("{reason:?}")));
            if let Some(request_id) = abandoned {
                if !settled {
                    let _ = app.emit(
                        IMAGE_ASSIST_ERROR_EVENT,
                        unmatched_message(reason).to_string(),
                    );
                    finish_request(request_id, Err(unmatched_message(reason).to_string()));
                }
            }
        }
        ImageAssistServerFrame::Completed { match_id } => {
            let state = app.state::<crate::remote::RemoteAgentState>();
            let session = brokered_session_for(match_id);
            forget_match(match_id);
            if let Some(session) = session {
                crate::remote::release_image_assist_p2p_session(state.inner(), &session);
            }
            emit_match_update(app, Some(match_id), "completed", None);
        }
        ImageAssistServerFrame::Error { message } => {
            // Surfaced, not just logged. A gateway that refuses brokering is
            // the most likely reason a user sees an empty roster, and stderr is
            // not somewhere they can look.
            eprintln!("SomniQ Image Assist gateway error: {message}");
            HELPERS_ONLINE.store(false, Ordering::Relaxed);
            let _ = app.emit(
                IMAGE_ASSIST_ROSTER_EVENT,
                Vec::<remote_protocol::ImageAssistRosterEntry>::new(),
            );
            let pending: Vec<_> = runtime()
                .lock()
                .map(|runtime| runtime.outbound.keys().copied().collect())
                .unwrap_or_default();
            for request_id in pending {
                finish_request(request_id, Err(message.clone()));
            }
            let _ = app.emit(IMAGE_ASSIST_ERROR_EVENT, message);
        }
        // The remaining frames drive the match itself. They are handled here
        // rather than surfaced to the UI, so a renderer can never be the thing
        // that accepts a stranger or opens a transport.
        ImageAssistServerFrame::Candidate {
            match_id,
            peer,
            expires_at_unix_ms,
        } => {
            if let Err(error) = on_candidate(app, match_id, &peer, expires_at_unix_ms) {
                eprintln!("SomniQ Image Assist could not seal a preview: {error}");
            }
        }
        ImageAssistServerFrame::Offered {
            match_id,
            peer,
            sealed,
            expires_at_unix_ms,
        } => {
            if let Err(error) =
                on_offered(app, match_id, &peer, sealed.as_bytes(), expires_at_unix_ms)
            {
                // Declining on failure is the safe direction: the requester is
                // re-matched to someone else instead of waiting on a dialog
                // this machine could not raise.
                //
                // Surfaced as well as logged. Every path here ends with no
                // dialog appearing, which is indistinguishable from "nothing
                // arrived" unless the reason is shown.
                eprintln!("SomniQ Image Assist declined an offer: {error}");
                let _ = app.emit(
                    IMAGE_ASSIST_ERROR_EVENT,
                    format!("收到一个代出图请求，但本机拒绝了：{error}"),
                );
                decline_locally(app, match_id);
            }
        }
        ImageAssistServerFrame::Approved {
            match_id,
            offerer,
            session_id,
            ice_servers,
            expires_at_unix_ms,
        } => {
            emit_match_update(app, Some(match_id), "accepted", None);
            if let Err(error) = on_approved(
                app,
                match_id,
                offerer,
                session_id,
                &ice_servers,
                expires_at_unix_ms,
            ) {
                eprintln!("SomniQ Image Assist could not open a transport: {error}");
                fail_match(app, match_id, "transport setup failed");
            }
        }
        ImageAssistServerFrame::RelaySessionGranted {
            match_id,
            relay_session_id,
        } => {
            if let Err(error) = on_relay_granted(app, match_id, relay_session_id) {
                eprintln!("SomniQ Image Assist could not open its relay fallback: {error}");
                fail_match(app, match_id, "relay transport setup failed");
            }
        }
    }
}

/// Opens the brokered transport once both users have consented.
///
/// This is the first point at which any connection exists. The peer descriptor
/// comes from the match that was just approved, never from the persisted device
/// store, and the temporary direct or relay session is torn down with the match.
fn on_approved(
    app: &AppHandle,
    match_id: MatchId,
    offerer: DeviceId,
    session_id: SessionId,
    ice_servers: &[String],
    expires_at_unix_ms: i64,
) -> Result<(), String> {
    let state = app.state::<crate::remote::RemoteAgentState>();
    let local_id = crate::remote::local_device_descriptor(state.inner())?.device_id;
    let (peer, transport) = {
        let runtime = runtime()
            .lock()
            .map_err(|_| "image assist runtime poisoned".to_string())?;
        let peer = runtime
            .peers
            .get(&match_id)
            .cloned()
            .ok_or_else(|| "no peer descriptor for this match".to_string())?;
        // Which side this machine is on follows from what it did: it either
        // approved a preview or asked for a helper, never both.
        let approved_here = runtime.approved.get(&match_id.to_string());
        let requested_here = runtime.matches.get(&match_id);
        let (local_is_helper, request_digest) = match (approved_here, requested_here) {
            (Some(approved), None) => (true, approved.request_digest),
            (None, Some(request_id)) => {
                let pending = runtime
                    .outbound
                    .get(request_id)
                    .ok_or_else(|| "the approved request is no longer pending".to_string())?;
                (
                    false,
                    request_digest(&pending.prompt, pending.aspect_ratio.as_deref()),
                )
            }
            _ => return Err("this machine is not a party to that match".to_string()),
        };
        // The gateway makes the helper the offerer. An assignment that
        // contradicts the local role is not something to negotiate around: it
        // would put both peers on the same side of the negotiation.
        if local_is_helper != (offerer == local_id) {
            return Err(
                "the gateway assigned a transport role this machine did not take".to_string(),
            );
        }
        (
            peer,
            MatchTransport {
                session_id,
                offerer,
                ice_servers: normalized_ice_servers(ice_servers),
                expires_at_unix_ms,
                request_digest,
                local_is_helper,
                direct_attempt: true,
                peer_verified: false,
                settled: false,
            },
        )
    };
    let local_is_helper = transport.local_is_helper;
    let p2p_start = brokered_p2p_start_for(&peer, &transport);
    if let Ok(mut runtime) = runtime().lock() {
        runtime.sessions.insert(match_id, session_id.to_string());
        runtime.transports.insert(match_id, transport);
        runtime
            .session_matches
            .insert(session_id.to_string(), match_id);
    }

    let p2p_session = crate::remote::reserve_image_assist_p2p_session(
        state.inner(),
        &match_id.to_string(),
        peer,
        session_id,
    )?;
    crate::remote::schedule_image_assist_p2p_expiry(app.clone(), p2p_session);
    eprintln!("SomniQ Image Assist is opening brokered P2P transport for match {match_id}");
    emit_match_update(
        app,
        Some(match_id),
        "connecting",
        Some("对方已接受，正在尝试建立点对点加密通道".to_string()),
    );
    // The gateway assigns the helper as the deterministic offerer. The
    // requester reserves the same brokered session but waits for this offer
    // over the authenticated signal channel.
    if local_is_helper {
        let p2p_session_id = p2p_start.session_id.clone();
        if let Err(error) = app.emit("remote-p2p-start", p2p_start) {
            eprintln!("SomniQ Image Assist could not start brokered P2P: {error}");
            let _ = brokered_direct_failed(app, state.inner(), &p2p_session_id);
        }
    }
    Ok(())
}

fn brokered_p2p_start_for(
    peer: &DeviceDescriptor,
    transport: &MatchTransport,
) -> crate::remote::RemoteP2pStartEvent {
    crate::remote::RemoteP2pStartEvent {
        device_id: peer.device_id.to_string(),
        session_id: transport.session_id.to_string(),
        ice_servers: transport.ice_servers.clone(),
        brokered: true,
    }
}

/// Returns an offerer start event for a direct attempt that survived a
/// renderer reload before the WebRTC bridge had consumed the original event.
pub(crate) fn brokered_p2p_starts(
    state: &crate::remote::RemoteAgentState,
) -> Vec<crate::remote::RemoteP2pStartEvent> {
    let Ok(runtime) = runtime().lock() else {
        return Vec::new();
    };
    runtime
        .transports
        .iter()
        .filter_map(|(match_id, transport)| {
            if !transport.local_is_helper || !transport.direct_attempt {
                return None;
            }
            let session_id = runtime.sessions.get(match_id)?;
            if *session_id != transport.session_id.to_string() {
                return None;
            }
            if !crate::remote::image_assist_p2p_session_is_pending(state, session_id) {
                return None;
            }
            let peer = runtime.peers.get(match_id)?;
            Some(brokered_p2p_start_for(peer, transport))
        })
        .collect()
}

/// The ICE server list in the form both peers must sign.
///
/// Sorted and deduplicated so the two sides produce identical transcript bytes
/// regardless of the order the gateway delivered them in, and bounded so a
/// gateway cannot make the transcript unsignable by sending more than the
/// protocol allows.
fn normalized_ice_servers(ice_servers: &[String]) -> Vec<String> {
    let mut servers: Vec<String> = ice_servers.to_vec();
    servers.sort();
    servers.dedup();
    servers.truncate(IMAGE_ASSIST_MAX_ICE_SERVERS);
    servers
}

/// Builds the transcript this machine expects for one brokered channel.
///
/// Both peers run this over the same gateway introduction, so the result is the
/// yardstick the peer's copy is measured against as well as the thing this
/// machine signs.
fn expected_transcript(
    state: &crate::remote::RemoteAgentState,
    session_id: &str,
) -> Result<(MatchId, DeviceId, ImageAssistTranscript), String> {
    let local = crate::remote::local_device_descriptor(state)?;
    let runtime = runtime()
        .lock()
        .map_err(|_| "image assist runtime poisoned".to_string())?;
    let match_id = *runtime
        .session_matches
        .get(session_id)
        .ok_or_else(|| "no image assist match owns that transport session".to_string())?;
    let transport = runtime
        .transports
        .get(&match_id)
        .ok_or_else(|| "the image assist match has no transport parameters".to_string())?;
    let peer = runtime
        .peers
        .get(&match_id)
        .cloned()
        .ok_or_else(|| "no peer descriptor for this match".to_string())?;
    let peer_id = peer.device_id;
    Ok((
        match_id,
        peer_id,
        build_transcript(match_id, local, peer, transport),
    ))
}

/// Places the two descriptors on the sides the transcript names.
///
/// Separated from the lookup because this is the one step that differs between
/// the two peers, and it must not: a transcript built with the roles the other
/// way round produces different signed bytes, which would fail every brokered
/// channel closed for a reason no log would explain.
fn build_transcript(
    match_id: MatchId,
    local: DeviceDescriptor,
    peer: DeviceDescriptor,
    transport: &MatchTransport,
) -> ImageAssistTranscript {
    let (requester, helper) = if transport.local_is_helper {
        (peer, local)
    } else {
        (local, peer)
    };
    ImageAssistTranscript {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        match_id,
        requester,
        helper,
        offerer: transport.offerer,
        session_id: transport.session_id,
        ice_servers: transport.ice_servers.clone(),
        expires_at_unix_ms: transport.expires_at_unix_ms,
        request_digest: transport.request_digest,
    }
}

/// Sends this machine's signed transcript as the first frame on a brokered
/// channel.
///
/// Called for both roles the moment the data channel opens. Until the peer's
/// own transcript arrives and matches, this is the only frame either side will
/// send or accept.
pub(crate) fn brokered_channel_opened(
    app: &AppHandle,
    state: &crate::remote::RemoteAgentState,
    device_id: &str,
    session_id: &str,
    wire: Arc<RemoteWireSession>,
) -> Result<(), String> {
    let app_for_sink = app.clone();
    let device_id = device_id.to_string();
    let session_id_for_sink = session_id.to_string();
    let sink: ImageAssistFrameSink = Arc::new(move |message| {
        send_wire(
            &app_for_sink,
            &device_id,
            &session_id_for_sink,
            &wire,
            &message,
        )
    });
    brokered_transport_opened(app, state, session_id, sink)
}

fn on_relay_granted(
    app: &AppHandle,
    match_id: MatchId,
    relay_session_id: SessionId,
) -> Result<(), String> {
    let state = app.state::<crate::remote::RemoteAgentState>();
    let (peer, previous_session) = {
        let mut runtime = runtime()
            .lock()
            .map_err(|_| "image assist runtime poisoned".to_string())?;
        let peer = runtime
            .peers
            .get(&match_id)
            .cloned()
            .ok_or_else(|| "the relay match has no peer descriptor".to_string())?;
        let previous_session = runtime
            .sessions
            .insert(match_id, relay_session_id.to_string());
        if let Some(previous) = previous_session.as_ref() {
            runtime.session_matches.remove(previous);
        }
        runtime
            .session_matches
            .insert(relay_session_id.to_string(), match_id);
        let transport = runtime
            .transports
            .get_mut(&match_id)
            .ok_or_else(|| "the relay match has no transport parameters".to_string())?;
        transport.session_id = relay_session_id;
        transport.direct_attempt = false;
        transport.peer_verified = false;
        (peer, previous_session)
    };
    if let Some(previous_session) = previous_session {
        crate::remote::release_image_assist_p2p_session(state.inner(), &previous_session);
        let _ = app.emit(
            "remote-p2p-failed",
            crate::remote::RemoteP2pSessionInput {
                device_id: peer.device_id.to_string(),
                session_id: previous_session,
            },
        );
    }
    crate::remote::start_image_assist_relay_session(
        app,
        state.inner(),
        peer,
        relay_session_id,
        &match_id.to_string(),
    )?;
    emit_match_update(
        app,
        Some(match_id),
        "connecting",
        Some("已建立端到端加密中继回传通道".to_string()),
    );
    Ok(())
}

/// Handles a failed direct attempt. Both sides discard the WebRTC session, but
/// only the requester asks the gateway to mint the single relay fallback.
pub(crate) fn brokered_direct_failed(
    app: &AppHandle,
    state: &crate::remote::RemoteAgentState,
    session_id: &str,
) -> Result<bool, String> {
    let (match_id, local_is_helper, should_request_relay) = {
        let mut runtime = runtime()
            .lock()
            .map_err(|_| "image assist runtime poisoned".to_string())?;
        let Some(match_id) = runtime.session_matches.get(session_id).copied() else {
            return Ok(false);
        };
        let transport = runtime
            .transports
            .get(&match_id)
            .ok_or_else(|| "the image assist match has no transport parameters".to_string())?;
        let local_is_helper = transport.local_is_helper;
        let should_request_relay = transport.direct_attempt && !transport.settled;
        if let Some(transport) = runtime.transports.get_mut(&match_id) {
            transport.direct_attempt = false;
        }
        (match_id, local_is_helper, should_request_relay)
    };
    crate::remote::release_image_assist_p2p_session(state, session_id);
    if !should_request_relay {
        return Ok(true);
    }
    emit_match_update(
        app,
        Some(match_id),
        "connecting",
        Some("直连未成功，正在申请加密中继".to_string()),
    );
    if !local_is_helper {
        crate::remote::send_image_assist_frame(
            state,
            ImageAssistClientFrame::RelaySession { match_id },
        )?;
    }
    Ok(true)
}

pub(crate) type ImageAssistFrameSink =
    Arc<dyn Fn(ImageAssistWireMessage) -> Result<(), String> + Send + Sync>;

/// Starts the signed transcript exchange over either WebRTC or the encrypted
/// relay fallback.
pub(crate) fn brokered_transport_opened(
    app: &AppHandle,
    state: &crate::remote::RemoteAgentState,
    session_id: &str,
    sink: ImageAssistFrameSink,
) -> Result<(), String> {
    let match_id = runtime()
        .lock()
        .ok()
        .and_then(|runtime| runtime.session_matches.get(session_id).copied());
    emit_match_update(
        app,
        match_id,
        "connected",
        Some("安全连接已建立，正在校验临时会话".to_string()),
    );
    match send_local_transcript(state, session_id, &sink) {
        Ok(()) => {
            eprintln!("SomniQ Image Assist sent its match transcript on session {session_id}");
            Ok(())
        }
        Err(error) => {
            // Returning the error also tears the channel down, which is the
            // right direction: a channel whose transcript never left is not
            // one to keep open.
            brokered_send_failed(app, session_id, &error);
            Err(error)
        }
    }
}

fn direct_attempt_for_session(session_id: &str) -> bool {
    runtime()
        .lock()
        .ok()
        .and_then(|runtime| {
            runtime
                .session_matches
                .get(session_id)
                .and_then(|match_id| runtime.transports.get(match_id))
                .map(|transport| {
                    transport.direct_attempt && transport.session_id.to_string() == session_id
                })
        })
        .unwrap_or(false)
}

/// Handles a write failure on the direct attempt without treating it as a
/// terminal Image Assist failure. Relay sessions use the terminal path below;
/// only the still-current P2P session may trigger the one-shot fallback.
fn brokered_send_failed(app: &AppHandle, session_id: &str, reason: &str) {
    if direct_attempt_for_session(session_id) {
        let state = app.state::<crate::remote::RemoteAgentState>();
        if brokered_direct_failed(app, state.inner(), session_id).unwrap_or(false) {
            return;
        }
    }
    brokered_transport_failed(app, session_id, reason);
}

fn send_local_transcript(
    state: &crate::remote::RemoteAgentState,
    session_id: &str,
    sink: &ImageAssistFrameSink,
) -> Result<(), String> {
    let (_, _, transcript) = expected_transcript(state, session_id)?;
    let proof = crate::remote::sign_image_assist_transcript(state, &transcript)?;
    sink(ImageAssistWireMessage::Transcript {
        transcript: Box::new(transcript),
        proof,
    })
}

/// Verifies the peer's copy of the match transcript against this machine's own.
///
/// Equality is the check. Both peers build their copy from the same gateway
/// introduction, so any difference — a relabelled display name, a swapped role,
/// a session id from another match, a digest that is not what was approved —
/// means one side was told something the other was not. The proof is verified
/// afterwards against the peer's signing key as it appears in the descriptor the
/// gateway introduced, which is what forces a substituting gateway from passive
/// relabelling into active forgery.
///
/// Returns the request to send when this machine is the requester: the approved
/// prompt travels only after the peer has been verified.
fn accept_peer_transcript(
    app: &AppHandle,
    session_id: &str,
    received: &ImageAssistTranscript,
    proof: &DeviceSignature,
) -> Result<Option<ImageAssistWireMessage>, String> {
    let state = app.state::<crate::remote::RemoteAgentState>();
    let (match_id, peer_id, expected) = expected_transcript(state.inner(), session_id)?;
    if *received != expected {
        return Err(format!(
            "the peer's match transcript does not match this machine's ({})",
            transcript_mismatch(&expected, received)
        ));
    }
    received
        .verify(peer_id, proof)
        .map_err(|error| format!("the peer's transcript proof did not verify: {error}"))?;
    eprintln!("SomniQ Image Assist verified its peer on session {session_id}");

    let mut runtime = runtime()
        .lock()
        .map_err(|_| "image assist runtime poisoned".to_string())?;
    let local_is_helper = {
        let transport = runtime
            .transports
            .get_mut(&match_id)
            .ok_or_else(|| "the image assist match has no transport parameters".to_string())?;
        transport.peer_verified = true;
        transport.local_is_helper
    };
    if local_is_helper {
        // The helper answers a request, it does not initiate one.
        return Ok(None);
    }
    let request_id = *runtime
        .matches
        .get(&match_id)
        .ok_or_else(|| "no local request is waiting on this match".to_string())?;
    let pending = runtime
        .outbound
        .get(&request_id)
        .cloned()
        .ok_or_else(|| "the approved request is no longer pending".to_string())?;
    drop(runtime);

    let _ = app.emit(
        IMAGE_ASSIST_MATCH_EVENT,
        ImageAssistMatchUpdate {
            match_id: Some(match_id.to_string()),
            stage: "requesting",
            detail: None,
            images: Vec::new(),
            transfer_received_bytes: None,
            transfer_total_bytes: None,
            transfer_completed_artifacts: None,
            transfer_artifact_count: None,
            transfer_direction: None,
        },
    );
    Ok(Some(ImageAssistWireMessage::Request {
        request_id: pending.request_id,
        prompt: pending.prompt,
        aspect_ratio: pending.aspect_ratio,
    }))
}

/// Names the first transcript field that differs, for the local log only.
///
/// A brokered channel that fails closed is otherwise indistinguishable from one
/// that never connected, and the two have entirely different causes. The peer is
/// told nothing beyond the failure itself.
fn transcript_mismatch(
    expected: &ImageAssistTranscript,
    received: &ImageAssistTranscript,
) -> &'static str {
    if expected.protocol_version != received.protocol_version {
        "protocol version"
    } else if expected.match_id != received.match_id {
        "match id"
    } else if expected.requester != received.requester {
        "requester descriptor"
    } else if expected.helper != received.helper {
        "helper descriptor"
    } else if expected.offerer != received.offerer {
        "assigned role"
    } else if expected.session_id != received.session_id {
        "transport session"
    } else if expected.ice_servers != received.ice_servers {
        "ICE servers"
    } else if expected.expires_at_unix_ms != received.expires_at_unix_ms {
        "expiry"
    } else if expected.request_digest != received.request_digest {
        "request digest"
    } else {
        "an unknown field"
    }
}

/// The ICE servers the gateway assigned to the match behind one session.
///
/// The answerer needs these to configure its own connection, and taking them
/// from the match rather than from local paired configuration is what keeps
/// both ends on the endpoints the transcript covers.
pub(crate) fn brokered_ice_servers(session_id: &str) -> Option<Vec<String>> {
    let runtime = runtime().lock().ok()?;
    let match_id = runtime.session_matches.get(session_id)?;
    runtime
        .transports
        .get(match_id)
        .map(|transport| transport.ice_servers.clone())
}

/// Whether the peer on one brokered session has been verified.
fn peer_verified(session_id: &str) -> bool {
    let Ok(runtime) = runtime().lock() else {
        return false;
    };
    runtime
        .session_matches
        .get(session_id)
        .and_then(|match_id| runtime.transports.get(match_id))
        .is_some_and(|transport| transport.peer_verified)
}

/// Records that this machine finished its half of a match.
///
/// Called by the requester once every image is on disk and by the helper once
/// the last slice of the last image has gone out. After this the transport
/// closing is the expected end of the exchange, not a fault to report.
fn mark_settled(match_id: MatchId) {
    if let Ok(mut runtime) = runtime().lock() {
        if let Some(transport) = runtime.transports.get_mut(&match_id) {
            transport.settled = true;
        }
    }
}

fn match_settled(match_id: MatchId) -> bool {
    runtime()
        .lock()
        .ok()
        .and_then(|runtime| {
            runtime
                .transports
                .get(&match_id)
                .map(|transport| transport.settled)
        })
        .unwrap_or(false)
}

/// Ends the match behind one brokered session and tells the waiting tool call.
///
/// A transport that closes after the exchange finished is the peer tidying up,
/// not a failure. Reporting it as one would raise an error banner on a request
/// whose images are already on disk and cancel a match the gateway is about to
/// complete, so a settled match only releases its transport here.
pub(crate) fn brokered_transport_failed(app: &AppHandle, session_id: &str, reason: &str) {
    let match_id = runtime()
        .lock()
        .ok()
        .and_then(|runtime| runtime.session_matches.get(session_id).copied());
    let Some(match_id) = match_id else {
        return;
    };
    if match_settled(match_id) {
        eprintln!(
            "SomniQ Image Assist closed the transport for completed match {match_id}: {reason}"
        );
        forget_match(match_id);
        let state = app.state::<crate::remote::RemoteAgentState>();
        crate::remote::release_image_assist_p2p_session(state.inner(), session_id);
        return;
    }
    fail_match(app, match_id, reason);
}

/// Seals one frame for a brokered peer and hands it to the transport bridge.
fn send_wire(
    app: &AppHandle,
    device_id: &str,
    session_id: &str,
    wire: &RemoteWireSession,
    message: &ImageAssistWireMessage,
) -> Result<(), String> {
    let envelope = wire.seal_image_assist(message)?;
    app.emit(
        "remote-p2p-frame",
        serde_json::json!({
            "deviceId": device_id,
            "sessionId": session_id,
            "dataBase64": base64_of(&envelope),
        }),
    )
    .map_err(|error| format!("cannot deliver an image assist frame: {error}"))
}

/// Ends a match locally and tells the waiting tool call.
///
/// Everything after approval is otherwise invisible: the dialog is gone, the
/// channel closes on its own, and the only trace is a stderr line nobody
/// running a packaged build can see. A brokered attempt that dies silently is
/// indistinguishable from one that never started, so every end states its
/// reason where the user already looks.
fn fail_match(app: &AppHandle, match_id: MatchId, reason: &str) {
    if match_settled(match_id) {
        // The exchange already delivered. Cancelling now would turn a completed
        // match into a cancelled one at the gateway and overwrite a result the
        // requester has already written to disk.
        eprintln!(
            "SomniQ Image Assist ignored a late failure on settled match {match_id}: {reason}"
        );
        return;
    }
    eprintln!("SomniQ Image Assist ended match {match_id}: {reason}");
    let _ = app.emit(
        IMAGE_ASSIST_ERROR_EVENT,
        format!("代出图请求中断：{reason}"),
    );
    let request_id = runtime()
        .lock()
        .ok()
        .and_then(|runtime| runtime.matches.get(&match_id).copied());
    if let Some(request_id) = request_id {
        finish_request(request_id, Err(reason.to_string()));
    }
    emit_match_update(app, Some(match_id), "failed", Some(reason.to_string()));
    let state = app.state::<crate::remote::RemoteAgentState>();
    let session = brokered_session_for(match_id);
    let _ = crate::remote::send_image_assist_frame(
        state.inner(),
        ImageAssistClientFrame::Cancel { match_id },
    );
    // Cancellation is local first: the gateway signal can itself be the thing
    // that failed, so cleanup cannot depend on a later MatchClosed frame.
    forget_match(match_id);
    if let Some(session) = session {
        crate::remote::release_image_assist_p2p_session(state.inner(), &session);
    }
}

/// Requester side: seal the prompt for the helper the gateway chose.
fn on_candidate(
    app: &AppHandle,
    match_id: MatchId,
    peer: &DeviceDescriptor,
    expires_at_unix_ms: i64,
) -> Result<(), String> {
    let pending = {
        let mut runtime = runtime()
            .lock()
            .map_err(|_| "image assist runtime poisoned".to_string())?;
        // Exactly one outstanding request per machine, so the candidate belongs
        // to whichever request is waiting.
        let Some(pending) = runtime.outbound.values().next().cloned() else {
            return Err("no local request is waiting for a helper".to_string());
        };
        runtime.matches.insert(match_id, pending.request_id);
        runtime.peers.insert(match_id, peer.clone());
        pending
    };
    let payload = PreviewPayload {
        request_id: pending.request_id,
        prompt: pending.prompt.clone(),
        aspect_ratio: pending.aspect_ratio.clone(),
    };
    let plaintext = serde_json::to_vec(&payload)
        .map_err(|error| format!("cannot encode the image assist preview: {error}"))?;
    let state = app.state::<crate::remote::RemoteAgentState>();
    let sealed =
        crate::remote::seal_image_assist_preview(state.inner(), match_id, peer, &plaintext)?;
    crate::remote::send_image_assist_frame(
        state.inner(),
        ImageAssistClientFrame::Preview {
            match_id,
            sealed: remote_protocol::Base64UrlBytes::new(sealed),
        },
    )?;
    emit_match_update(
        app,
        Some(match_id),
        "sent",
        Some(format!(
            "已发送给 {}（设备 {}），等待对方查看并接受",
            if peer.display_name.trim().is_empty() {
                "在线互助用户"
            } else {
                peer.display_name.trim()
            },
            peer_fingerprint(&peer.device_id.to_string())
        )),
    );
    let _ = expires_at_unix_ms;
    Ok(())
}

/// Helper side: open the preview and apply the standing Settings consent.
fn on_offered(
    app: &AppHandle,
    match_id: MatchId,
    peer: &DeviceDescriptor,
    sealed: &[u8],
    _expires_at_unix_ms: i64,
) -> Result<(), String> {
    let policy = crate::compute::image_help_policy(app)?;
    if !policy.accept_image_help {
        return Err("「为其他用户生成图片」开关未打开（设置 → 远程控制 → 电脑）".to_string());
    }
    if !crate::oracle_web::image_tool_available() {
        // The gateway matched on a stale advertisement: this machine said it
        // could help, and by the time the offer arrived it could not.
        return Err(
            "本机的 ChatGPT Web 账号当前不可用（未绑定、Oracle 运行时未就绪，或账号浏览器窗口开着）"
                .to_string(),
        );
    }
    let state = app.state::<crate::remote::RemoteAgentState>();
    let plaintext =
        crate::remote::open_image_assist_preview(state.inner(), match_id, peer, sealed)?;
    let payload: PreviewPayload = serde_json::from_slice(&plaintext)
        .map_err(|_| "the image assist preview is malformed".to_string())?;
    if payload.prompt.trim().is_empty()
        || payload.prompt.len() > remote_protocol::IMAGE_ASSIST_MAX_PROMPT_BYTES
    {
        return Err("the image assist preview carries an unusable prompt".to_string());
    }

    let reserved = {
        let mut runtime = runtime()
            .lock()
            .map_err(|_| "image assist runtime poisoned".to_string())?;
        let day = local_day();
        // Hold a unit while the matched request is being accepted so two
        // concurrent offers cannot both spend the last one.
        let reserved = runtime.allowance.reserve(policy.daily_limit, day);
        if reserved {
            runtime.peers.insert(match_id, peer.clone());
            runtime.approvals.insert(
                match_id,
                PendingApproval {
                    payload: payload.clone(),
                    reserved,
                },
            );
        }
        reserved
    };
    if !reserved {
        return Err("the daily image-help limit is already spent".to_string());
    }

    // The Settings toggle is the standing consent. Keep the full prompt in
    // the local runtime for digest binding, but do not surface a second
    // approval dialog for every request.
    approve_locally(app, match_id)?;
    emit_match_update(
        app,
        Some(match_id),
        "accepted",
        Some(format!(
            "已按设置自动接受设备 {} 的图片请求",
            peer_fingerprint(&peer.device_id.to_string())
        )),
    );
    Ok(())
}

/// Releases a held allowance and tells the gateway this machine declined.
fn decline_locally(app: &AppHandle, match_id: MatchId) {
    release_approval(match_id);
    let state = app.state::<crate::remote::RemoteAgentState>();
    let _ = crate::remote::send_image_assist_frame(
        state.inner(),
        ImageAssistClientFrame::Decision {
            match_id,
            accept: false,
        },
    );
}

/// The transport session opened for one match, if it got that far.
fn brokered_session_for(match_id: MatchId) -> Option<String> {
    let runtime = runtime().lock().ok()?;
    runtime.sessions.get(&match_id).cloned()
}

/// Forgets everything held for one match once it ends.
///
/// A transfer that never completes — the peer disconnects, the match expires,
/// either side cancels — would otherwise leave both the held image bytes and
/// the peer descriptor in memory for the life of the process.
fn forget_match(match_id: MatchId) {
    let Ok(mut runtime) = runtime().lock() else {
        return;
    };
    runtime.peers.remove(&match_id);
    if runtime
        .approvals
        .remove(&match_id)
        .is_some_and(|approval| approval.reserved)
    {
        runtime.allowance.release();
    }
    if runtime
        .approved
        .remove(&match_id.to_string())
        .is_some_and(|approval| approval.allowance_reserved)
    {
        runtime.allowance.release();
    }
    let running_ids: Vec<_> = runtime
        .running
        .iter()
        .filter_map(|(request_id, running)| (running.match_id == match_id).then_some(*request_id))
        .collect();
    for request_id in running_ids {
        if let Some(running) = runtime.running.remove(&request_id) {
            running.cancelled.store(true, Ordering::SeqCst);
            if running.allowance_reserved {
                runtime.allowance.release();
            }
        }
        runtime.result_receipts.remove(&request_id);
        runtime.served.remove(&request_id);
    }
    runtime.transports.remove(&match_id);
    if let Some(session_id) = runtime.sessions.remove(&match_id) {
        runtime.session_matches.remove(&session_id);
        // A helper holds its generated images in memory keyed by the
        // requester's request id, which it has no other index for. Without
        // dropping them by session, a transfer cut short would keep every
        // served image alive for the life of the process.
        runtime
            .served
            .retain(|_, served| served.session_id != session_id);
    }
    if let Some(request_id) = runtime.matches.remove(&match_id) {
        runtime.served.remove(&request_id);
        if let Some(pull) = runtime.pulls.remove(&request_id) {
            discard_pull_files(&pull);
        }
    }
}

/// Returns the quota reservation owned by an approval that did not proceed.
fn release_approval(match_id: MatchId) -> Option<PendingApproval> {
    let mut runtime = runtime().lock().ok()?;
    let approval = runtime.approvals.remove(&match_id)?;
    if approval.reserved {
        runtime.allowance.release();
    }
    Some(approval)
}

/// Atomically consumes the one request sealed into an approved preview.
///
/// The transition happens before a worker is spawned. Replaying the same frame
/// or substituting a new request id therefore cannot create a second browser
/// job, even when duplicate frames arrive concurrently.
fn claim_approved_request(
    session_id: &str,
    policy: &HelperPolicy,
    request_id: RequestId,
    prompt: &str,
    aspect_ratio: Option<&str>,
) -> Result<Arc<AtomicBool>, RefusalReason> {
    let mut runtime = runtime().lock().map_err(|_| RefusalReason::NotApproved)?;
    let match_id = runtime
        .session_matches
        .get(session_id)
        .copied()
        .ok_or(RefusalReason::NotApproved)?;
    let peer_verified = runtime
        .transports
        .get(&match_id)
        .is_some_and(|transport| transport.peer_verified);
    let key = match_id.to_string();
    let approval = runtime.approved.get(&key).cloned();
    let allowance_available = approval
        .as_ref()
        .is_some_and(|approved| approved.allowance_reserved);
    authorize_request(
        policy,
        peer_verified,
        approval.as_ref(),
        request_id,
        prompt,
        aspect_ratio,
        allowance_available,
    )?;
    if runtime.running.contains_key(&request_id) {
        return Err(RefusalReason::AlreadyConsumed);
    }
    let approved = runtime
        .approved
        .get_mut(&key)
        .ok_or(RefusalReason::NotApproved)?;
    approved.consumed = true;
    let allowance_reserved = std::mem::take(&mut approved.allowance_reserved);
    let cancelled = Arc::new(AtomicBool::new(false));
    runtime.running.insert(
        request_id,
        RunningRequest {
            match_id,
            cancelled: cancelled.clone(),
            allowance_reserved,
        },
    );
    Ok(cancelled)
}

/// Settles the global reservation after the only permitted browser job.
///
/// A generated image spends quota even if its manifest cannot be shared. A
/// browser failure that produced nothing returns the reservation.
fn settle_running_request(request_id: RequestId, generated: bool) {
    let allowance = {
        let Ok(mut runtime) = runtime().lock() else {
            return;
        };
        let Some(running) = runtime.running.remove(&request_id) else {
            return;
        };
        if running.allowance_reserved {
            if generated {
                runtime.allowance.commit();
            } else {
                runtime.allowance.release();
            }
        }
        runtime.allowance.clone()
    };
    if generated {
        persist_daily_allowance(&allowance);
    }
}

/// Commits the standing image-help consent for one matched request and sends
/// the gateway decision. The preview was already opened and validated by the
/// offer handler, so the transport remains gated by the same digest check.
fn approve_locally(app: &AppHandle, match_id: MatchId) -> Result<(), String> {
    {
        let mut runtime = runtime()
            .lock()
            .map_err(|_| "image assist runtime poisoned".to_string())?;
        let approval = runtime
            .approvals
            .get_mut(&match_id)
            .ok_or_else(|| "this image request is no longer awaiting acceptance".to_string())?;
        let payload = approval.payload.clone();
        let allowance_reserved = std::mem::take(&mut approval.reserved);
        let digest = request_digest(&payload.prompt, payload.aspect_ratio.as_deref());
        runtime.approved.insert(
            match_id.to_string(),
            ApprovedRequest {
                request_id: payload.request_id,
                request_digest: digest,
                consumed: false,
                allowance_reserved,
            },
        );
    }
    let state = app.state::<crate::remote::RemoteAgentState>();
    let sent = crate::remote::send_image_assist_frame(
        state.inner(),
        ImageAssistClientFrame::Decision {
            match_id,
            accept: true,
        },
    );
    if let Err(error) = sent {
        if let Ok(mut runtime) = runtime().lock() {
            if runtime
                .approved
                .remove(&match_id.to_string())
                .is_some_and(|approval| approval.allowance_reserved)
            {
                runtime.allowance.release();
            }
            runtime.approvals.remove(&match_id);
        }
        return Err(error);
    }
    runtime()
        .lock()
        .ok()
        .and_then(|mut runtime| runtime.approvals.remove(&match_id))
        .ok_or_else(|| "this image request is no longer awaiting acceptance".to_string())?;
    Ok(())
}

/// Publishes or withdraws this computer's willingness to generate images.
///
/// Reads the authoritative policy rather than trusting a flag from the UI, so
/// a renderer cannot advertise a machine whose user never opted in.
pub(crate) fn current_helper_advertisement(app: &AppHandle) -> ImageAssistClientFrame {
    let policy = match crate::compute::image_help_policy(app) {
        Ok(policy) => policy,
        Err(_) => return ImageAssistClientFrame::HelperStopped,
    };
    let (publication, allowance_available) = runtime()
        .lock()
        .map(|runtime| {
            (
                runtime.helper_publication.clone(),
                runtime.allowance.remaining(policy.daily_limit, local_day()) > 0,
            )
        })
        .unwrap_or_default();
    if policy.accept_image_help && allowance_available && crate::oracle_web::image_tool_available()
    {
        ImageAssistClientFrame::HelperReady {
            lease_ms: HELPER_LEASE_MS,
            display_name: publication.display_name,
            location: publication.location,
        }
    } else {
        ImageAssistClientFrame::HelperStopped
    }
}

/// Metadata-free lease renewal used by the authenticated Rust signal loop.
pub(crate) fn current_helper_heartbeat(app: &AppHandle) -> ImageAssistClientFrame {
    match current_helper_advertisement(app) {
        ImageAssistClientFrame::HelperReady { .. } => ImageAssistClientFrame::HelperRenew {
            lease_ms: HELPER_LEASE_MS,
        },
        _ => ImageAssistClientFrame::HelperStopped,
    }
}

#[tauri::command]
pub async fn image_assist_publish(
    app: AppHandle,
    state: tauri::State<'_, crate::remote::RemoteAgentState>,
    display_name: Option<String>,
    location: Option<ImageAssistLocation>,
) -> Result<bool, String> {
    {
        let mut runtime = runtime()
            .lock()
            .map_err(|_| "image assist runtime poisoned".to_string())?;
        runtime.helper_publication = HelperPublication {
            // Naming is opt-in: volunteering to help is not consent to publish
            // a device name, which frequently contains a real person's name.
            display_name: display_name.filter(|name| !name.trim().is_empty()),
            // The renderer only supplies this after an explicit geolocation
            // permission grant. Validate again at the trust boundary.
            location: location.and_then(|value| value.coarsened().ok()),
        };
    }
    let frame = current_helper_advertisement(&app);
    let available = matches!(frame, ImageAssistClientFrame::HelperReady { .. });
    crate::remote::send_image_assist_frame(state.inner(), frame)?;
    Ok(available)
}

/// Asks the gateway for the current online-helper roster.
#[tauri::command]
pub async fn image_assist_roster(
    state: tauri::State<'_, crate::remote::RemoteAgentState>,
) -> Result<(), String> {
    crate::remote::send_image_assist_frame(state.inner(), ImageAssistClientFrame::RequestRoster)
}

/// Answers one approval prompt on the helper's computer.
///
/// The decision travels to the gateway, which is the only party that can turn
/// it into a transport. Declining is terminal for this match: the gateway will
/// offer the request to a different helper rather than asking again.
#[tauri::command]
pub async fn image_assist_decide(
    app: AppHandle,
    state: tauri::State<'_, crate::remote::RemoteAgentState>,
    match_id: String,
    accept: bool,
) -> Result<(), String> {
    let match_id = match_id
        .trim()
        .parse::<MatchId>()
        .map_err(|_| "invalid image assist match identifier".to_string())?;
    if accept {
        approve_locally(&app, match_id)?;
    } else {
        release_approval(match_id)
            .ok_or_else(|| "this image request is no longer awaiting a decision".to_string())?;
        crate::remote::send_image_assist_frame(
            state.inner(),
            ImageAssistClientFrame::Decision {
                match_id,
                accept: false,
            },
        )?;
    }
    emit_match_update(
        &app,
        Some(match_id),
        if accept { "accepted" } else { "declined" },
        Some(if accept {
            "已接受请求，正在创建图片互助临时会话".to_string()
        } else {
            "已拒绝该图片请求".to_string()
        }),
    );
    Ok(())
}

/// How long a helper advertisement stays valid without renewal. Matches the
/// gateway's own lease default.
const HELPER_LEASE_MS: u32 = 60_000;

/// How long a brokered request may take before the requester gives up.
///
/// Includes matching, browser-side image generation, and a cross-region return
/// transfer. Once image generation has begun, five minutes is routinely too
/// short for a result to be both created and returned.
const BROKERED_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Once the result manifest arrives, data should continue to move even across
/// a high-latency route. Waiting for the full request timeout after a transport
/// stops moving leaves both users with no actionable diagnosis.
const IMAGE_ASSIST_TRANSFER_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// A transport write is only local buffering. The helper waits until the
/// requester asks for the first artifact slice before it considers the result
/// manifest delivered.
const IMAGE_ASSIST_RESULT_RECEIPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// Runs the image tool by asking another user to generate it.
///
/// Reached only when this machine has no ChatGPT account bound. The prompt
/// leaves this computer, so the local user is asked first: the Chat model can
/// reach this tool on its own initiative, which is exactly why the consent gate
/// lives here rather than in the tool schema.
pub(crate) fn execute_brokered_image_tool(
    app: AppHandle,
    input: &str,
    cancelled: Option<Arc<std::sync::atomic::AtomicBool>>,
) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BrokeredInput {
        prompt: String,
        #[serde(default)]
        files: Vec<String>,
        aspect_ratio: Option<String>,
        model: Option<String>,
    }

    let parsed: BrokeredInput = serde_json::from_str(input)
        .map_err(|error| format!("Invalid ChatGptWebImage input: {error}"))?;

    // Both are refused rather than dropped. Silently ignoring them would let a
    // request succeed while doing something other than what was asked.
    if !parsed.files.is_empty() {
        return Err(
            "Reference files cannot be sent to another user's computer. \
             Remove `files`, or bind a ChatGPT Web account on this computer."
                .to_string(),
        );
    }
    if parsed.model.is_some() {
        return Err(
            "A specific model cannot be requested from another user's computer; \
             their account default is used. Remove `model`, or bind a ChatGPT Web account here."
                .to_string(),
        );
    }

    let prompt = canonical_prompt(&parsed.prompt);
    if prompt.is_empty() {
        return Err("The image prompt is empty.".to_string());
    }
    // Bytes, not characters: the tool schema allows 120,000 characters, which
    // for CJK text is far past the frame limit.
    if prompt.len() > remote_protocol::IMAGE_ASSIST_MAX_PROMPT_BYTES {
        return Err(format!(
            "This prompt is {} UTF-8 bytes; a brokered request allows at most {}.",
            prompt.len(),
            remote_protocol::IMAGE_ASSIST_MAX_PROMPT_BYTES
        ));
    }
    let aspect_ratio = canonical_aspect_ratio(parsed.aspect_ratio.as_deref());

    if !helper_online() {
        return Err(
            "No other user is currently available to generate images. Try again later, \
             or bind a ChatGPT Web account in Settings."
                .to_string(),
        );
    }

    // The consent gate. Nothing has left this machine yet.
    if !confirm_send_to_stranger(&app, &prompt, aspect_ratio.as_deref(), cancelled.as_ref())? {
        return Err(
            "The request was cancelled: the prompt was not sent to another user.".to_string(),
        );
    }

    let request_id = RequestId::new();
    begin_request(request_id, &prompt, aspect_ratio.as_deref())?;
    let state = app.state::<crate::remote::RemoteAgentState>();
    if let Err(error) = crate::remote::send_image_assist_frame(
        state.inner(),
        ImageAssistClientFrame::RequestHelper { request_id },
    ) {
        end_request(&app, request_id);
        return Err(error);
    }
    emit_match_update(
        &app,
        None,
        "matching",
        Some(format!("请求 {} 已提交，正在匹配在线互助用户", request_id)),
    );

    let outcome = await_request(&app, request_id, cancelled);
    end_request(&app, request_id);
    outcome
}

/// Asks the local user before their prompt leaves this computer.
///
/// End-to-end encryption cannot address what this dialog is for: the helper has
/// to read the prompt in order to serve it, and the resulting image lands in
/// that person's ChatGPT history. Only the user can decide whether that is
/// acceptable for a given prompt, so this is per request with no blanket
/// approval.
fn confirm_send_to_stranger(
    app: &AppHandle,
    prompt: &str,
    aspect_ratio: Option<&str>,
    cancelled: Option<&Arc<std::sync::atomic::AtomicBool>>,
) -> Result<bool, String> {
    let consent_id = RequestId::new().to_string();
    let (sender, receiver) = std::sync::mpsc::channel::<bool>();
    {
        let mut runtime = runtime()
            .lock()
            .map_err(|_| "image assist runtime poisoned".to_string())?;
        runtime.consents.insert(consent_id.clone(), sender);
    }
    let cleanup = |id: &str| {
        if let Ok(mut runtime) = runtime().lock() {
            runtime.consents.remove(id);
        }
    };

    let _ = app.emit(
        IMAGE_ASSIST_CONSENT_EVENT,
        ImageAssistConsentPrompt {
            consent_id: consent_id.clone(),
            prompt: prompt.to_string(),
            aspect_ratio: aspect_ratio.map(str::to_string),
        },
    );

    loop {
        match receiver.recv_timeout(std::time::Duration::from_millis(200)) {
            Ok(approved) => {
                cleanup(&consent_id);
                return Ok(approved);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                    cleanup(&consent_id);
                    return Ok(false);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                cleanup(&consent_id);
                // A dismissed dialog is a refusal. Defaulting to "send" would
                // publish the prompt on a UI accident.
                return Ok(false);
            }
        }
    }
}

/// Answers the "send this prompt to another user?" dialog.
#[tauri::command]
pub async fn image_assist_consent(consent_id: String, approve: bool) -> Result<(), String> {
    let sender = {
        let mut runtime = runtime()
            .lock()
            .map_err(|_| "image assist runtime poisoned".to_string())?;
        runtime.consents.remove(consent_id.trim())
    };
    let Some(sender) = sender else {
        return Err("this image request is no longer waiting for confirmation".to_string());
    };
    let _ = sender.send(approve);
    Ok(())
}

/// Waits for a brokered request to finish, or for the user to stop the turn.
fn await_request(
    app: &AppHandle,
    request_id: RequestId,
    cancelled: Option<Arc<std::sync::atomic::AtomicBool>>,
) -> Result<String, String> {
    let deadline = std::time::Instant::now() + BROKERED_REQUEST_TIMEOUT;
    loop {
        if cancelled
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
        {
            return Err("The image request was cancelled.".to_string());
        }
        if let Some(result) = take_result(request_id)? {
            return result;
        }
        if let Some(match_id) = stalled_transfer_match(request_id)? {
            let reason = "图片回传在 45 秒内没有进展，请检查双方网络后重试";
            fail_match(app, match_id, reason);
            return Err(reason.to_string());
        }
        if std::time::Instant::now() >= deadline {
            return Err(
                "No other user completed this image request in time. Try again later.".to_string(),
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

/// Returns the live match only after its established return transfer has made
/// no byte-level progress for the bounded recovery window.
fn stalled_transfer_match(request_id: RequestId) -> Result<Option<MatchId>, String> {
    let runtime = runtime()
        .lock()
        .map_err(|_| "image assist runtime poisoned".to_string())?;
    let Some(pull) = runtime.pulls.get(&request_id) else {
        return Ok(None);
    };
    if pull.last_progress_at.elapsed() < IMAGE_ASSIST_TRANSFER_STALL_TIMEOUT {
        return Ok(None);
    }
    Ok(runtime
        .matches
        .iter()
        .find_map(|(match_id, candidate)| (*candidate == request_id).then_some(*match_id)))
}

/// Removes a finished result, if one has arrived.
fn take_result(request_id: RequestId) -> Result<Option<Result<String, String>>, String> {
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "image assist runtime poisoned".to_string())?;
    Ok(runtime.results.remove(&request_id))
}

/// Whether the last roster the gateway sent contained anyone able to help.
///
/// Used only to decide whether the image tool is worth offering to the model.
/// It is a hint, not an authorization: a stale "yes" costs one clear
/// "no helper is available" result, which is better than hiding the capability
/// from a user who does have somewhere to route.
static HELPERS_ONLINE: AtomicBool = AtomicBool::new(false);

pub(crate) fn helper_online() -> bool {
    HELPERS_ONLINE.load(Ordering::Relaxed)
}

/// Short, non-identifying label for a peer, matching the roster form.
pub(crate) fn peer_fingerprint(device_id: &str) -> String {
    device_id
        .chars()
        .filter(char::is_ascii_hexdigit)
        .take(8)
        .collect()
}

/// Handles one decoded frame from a brokered Image Assist peer.
///
/// The signature takes an already-decoded [`ImageAssistWireMessage`]: the
/// caller has proven the frame belongs to a registered brokered session and
/// decoded it with the closed Image Assist decoder, so no other protocol can
/// reach this function.
pub(crate) fn handle_peer_frame(
    app: AppHandle,
    device_id: String,
    session_id: String,
    message: ImageAssistWireMessage,
    wire: Arc<RemoteWireSession>,
) {
    let app_for_sink = app.clone();
    let device_id_for_sink = device_id.clone();
    let session_id_for_sink = session_id.clone();
    let sink: ImageAssistFrameSink = Arc::new(move |message| {
        send_wire(
            &app_for_sink,
            &device_id_for_sink,
            &session_id_for_sink,
            &wire,
            &message,
        )
    });
    handle_transport_frame(app, session_id, message, sink);
}

/// Registers the helper-side receipt waiter before the manifest is put on the
/// wire. Registering first means a fast relay acknowledgement cannot race past
/// the worker that is waiting for it.
fn register_result_receipt(request_id: RequestId) -> Result<std::sync::mpsc::Receiver<()>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "image assist runtime poisoned".to_string())?;
    if runtime.result_receipts.insert(request_id, sender).is_some() {
        return Err("a result receipt is already pending for this request".to_string());
    }
    Ok(receiver)
}

fn clear_result_receipt(request_id: RequestId) {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.result_receipts.remove(&request_id);
    }
}

fn acknowledge_result_receipt(request_id: RequestId) {
    let sender = runtime()
        .lock()
        .ok()
        .and_then(|mut runtime| runtime.result_receipts.remove(&request_id));
    if let Some(sender) = sender {
        let _ = sender.send(());
    }
}

fn match_for_session(session_id: &str) -> Option<MatchId> {
    runtime()
        .lock()
        .ok()
        .and_then(|runtime| runtime.session_matches.get(session_id).copied())
}

/// Handles a verified Image Assist frame independently of the transport that
/// carried it. The relay path calls this directly and therefore cannot fall
/// through to general Agent or compute dispatch.
pub(crate) fn handle_transport_frame(
    app: AppHandle,
    session_id: String,
    message: ImageAssistWireMessage,
    sink: ImageAssistFrameSink,
) {
    // A reply that cannot be written is the end of the exchange, not a line in
    // a log: the peer is waiting for a frame that will never arrive, and the
    // only other thing that would end it is a stall timer minutes later. This
    // covers every direction — the transcript, the request, a chunk request,
    // and a chunk that turned out to exceed the relay frame limit.
    let reply = |message: ImageAssistWireMessage| {
        if let Err(error) = sink(message) {
            eprintln!("SomniQ Image Assist could not send a reply: {error}");
            brokered_send_failed(&app, &session_id, &error);
        }
    };

    match message {
        ImageAssistWireMessage::Transcript { transcript, proof } => {
            match accept_peer_transcript(&app, &session_id, &transcript, &proof) {
                Ok(Some(request)) => reply(request),
                Ok(None) => {}
                Err(error) => {
                    // Fail closed on both sides rather than continuing with an
                    // unverified peer, and say why: a channel that opens and
                    // then goes quiet is otherwise indistinguishable from one
                    // that never connected.
                    eprintln!("SomniQ Image Assist rejected a match transcript: {error}");
                    brokered_transport_failed(&app, &session_id, &error);
                }
            }
        }
        ImageAssistWireMessage::Request {
            request_id,
            prompt,
            aspect_ratio,
        } => {
            if !peer_verified(&session_id) {
                // The transcript is the first frame on the channel. A request
                // that arrives before one has verified is not an ordering
                // accident to tolerate.
                eprintln!("SomniQ Image Assist refused a request from an unverified peer");
                let _ = app.emit(
                    IMAGE_ASSIST_ERROR_EVENT,
                    "收到一个代出图请求，但对方尚未通过身份校验，已拒绝。".to_string(),
                );
                reply(ImageAssistWireMessage::Failed {
                    request_id,
                    reason: ImageAssistFailure::RequestMismatch,
                });
                return;
            }
            let policy = match crate::compute::image_help_policy(&app) {
                Ok(policy) => policy,
                Err(error) => {
                    eprintln!("SomniQ Image Assist could not read its policy: {error}");
                    reply(ImageAssistWireMessage::Failed {
                        request_id,
                        reason: ImageAssistFailure::HelperUnavailable,
                    });
                    return;
                }
            };
            let cancelled = match claim_approved_request(
                &session_id,
                &policy,
                request_id,
                &prompt,
                aspect_ratio.as_deref(),
            ) {
                Ok(cancelled) => cancelled,
                Err(reason) => {
                    eprintln!("SomniQ Image Assist refused request {request_id}: {reason:?}");
                    reply(ImageAssistWireMessage::Failed {
                        request_id,
                        reason: reason.failure(),
                    });
                    return;
                }
            };
            eprintln!("SomniQ Image Assist accepted request {request_id}; generating");
            // Serving happens on a worker: generation drives a browser and can
            // take minutes, and this runs on the frame path.
            let app = app.clone();
            let session_id = session_id.clone();
            let sink = sink.clone();
            std::thread::spawn(move || {
                // The requester is waiting on a bounded 15-minute budget with no other
                // signal, so say that generation started before starting it. A channel
                // that cannot carry this frame cannot carry the images either, and
                // finding that out before spending the helper's ChatGPT quota is
                // strictly better than after.
                if let Err(error) = sink(ImageAssistWireMessage::Accepted { request_id }) {
                    eprintln!("SomniQ Image Assist could not acknowledge a request: {error}");
                    brokered_send_failed(&app, &session_id, &error);
                    return;
                }
                let outcome = serve_peer_request(
                    &app,
                    &session_id,
                    request_id,
                    &prompt,
                    aspect_ratio.as_deref(),
                    cancelled,
                );
                match outcome {
                    Ok(artifacts) => {
                        let receipt = match register_result_receipt(request_id) {
                            Ok(receipt) => receipt,
                            Err(error) => {
                                eprintln!(
                                    "SomniQ Image Assist could not await a result receipt: {error}"
                                );
                                release_served(request_id);
                                return;
                            }
                        };
                        if let Err(error) = sink(ImageAssistWireMessage::Result {
                            request_id,
                            artifacts,
                        }) {
                            eprintln!("SomniQ Image Assist could not return a result: {error}");
                            clear_result_receipt(request_id);
                            release_served(request_id);
                            if let Some(match_id) = match_for_session(&session_id) {
                                fail_match(&app, match_id, "无法发送图片回传清单");
                            }
                            return;
                        }
                        let match_id = match_for_session(&session_id);
                        emit_match_update(
                            &app,
                            match_id,
                            "generating",
                            Some("图片清单已发出，等待请求方确认接收".to_string()),
                        );
                        match receipt.recv_timeout(IMAGE_ASSIST_RESULT_RECEIPT_TIMEOUT) {
                            Ok(()) => {
                                // The first ArtifactRead is the existing
                                // protocol's delivery acknowledgement. The
                                // frame handler reports progress only after it
                                // has actually written a chunk to the relay.
                            }
                            Err(error) => {
                                clear_result_receipt(request_id);
                                release_served(request_id);
                                eprintln!("SomniQ Image Assist result receipt timed out: {error}");
                                if let Some(match_id) = match_id {
                                    fail_match(
                                        &app,
                                        match_id,
                                        "请求方未确认图片清单，请检查双方网络后重试",
                                    );
                                }
                            }
                        }
                    }
                    Err(reason) => {
                        if let Err(error) =
                            sink(ImageAssistWireMessage::Failed { request_id, reason })
                        {
                            eprintln!(
                                "SomniQ Image Assist could report generation failure: {error}"
                            );
                        }
                    }
                }
            });
        }
        ImageAssistWireMessage::ArtifactRead {
            request_id,
            name,
            offset,
            max_bytes,
        } => {
            // Image bytes are as much of this machine's output as the manifest
            // is, so they are gated on the same proof the request was.
            if !peer_verified(&session_id) {
                eprintln!("SomniQ Image Assist refused an artifact read from an unverified peer");
                reply(ImageAssistWireMessage::Failed {
                    request_id,
                    reason: ImageAssistFailure::RequestMismatch,
                });
                return;
            }
            acknowledge_result_receipt(request_id);
            match serve_chunk(&session_id, request_id, &name, offset, max_bytes) {
                Ok((data, eof, sha256, last, progress)) => {
                    reply(ImageAssistWireMessage::ArtifactChunk {
                        request_id,
                        name,
                        offset,
                        data: remote_protocol::Base64UrlBytes::new(data),
                        eof,
                        sha256,
                    });
                    let match_id = match_for_session(&session_id);
                    emit_transfer_progress(
                        &app, match_id, "sending", progress.0, progress.1, progress.2, progress.3,
                    );
                    // The final slice of the final image ends the transfer, so the
                    // held bytes are no longer needed.
                    if eof && last {
                        release_served(request_id);
                        if let Some(match_id) = match_id {
                            mark_settled(match_id);
                            emit_match_update(
                                &app,
                                Some(match_id),
                                "completed",
                                Some("图片已全部回传给请求方".to_string()),
                            );
                        }
                    }
                }
                Err(error) => {
                    eprintln!("SomniQ Image Assist refused an artifact read: {error}");
                    reply(ImageAssistWireMessage::Failed {
                        request_id,
                        reason: ImageAssistFailure::RequestMismatch,
                    });
                }
            }
        }
        // Requester-side frames drive the pull of each generated image.
        ImageAssistWireMessage::Result {
            request_id,
            artifacts,
        } => {
            if !peer_verified(&session_id) {
                // Untrusted bytes are about to be written to disk on the
                // strength of this manifest. Nothing arriving before the
                // transcript verified has earned that.
                eprintln!("SomniQ Image Assist refused a result from an unverified peer");
                brokered_transport_failed(
                    &app,
                    &session_id,
                    "对方在通过身份校验前就发回了图片清单",
                );
                return;
            }
            match begin_pull(&app, &session_id, request_id, artifacts) {
                Ok(Some(read)) => reply(read),
                Ok(None) => {}
                Err(error) => finish_request(request_id, Err(error)),
            }
        }
        ImageAssistWireMessage::ArtifactChunk {
            request_id,
            name,
            offset,
            data,
            eof,
            ..
        } => {
            if !peer_verified(&session_id) {
                eprintln!("SomniQ Image Assist refused an image chunk from an unverified peer");
                return;
            }
            match advance_pull(
                &app,
                &session_id,
                request_id,
                &name,
                offset,
                data.as_bytes(),
                eof,
            ) {
                Ok(Some(next)) => reply(next),
                Ok(None) => {}
                Err(error) => fail_pull(request_id, error),
            }
        }
        ImageAssistWireMessage::Failed { request_id, reason } => {
            let match_id = runtime()
                .lock()
                .ok()
                .and_then(|runtime| runtime.session_matches.get(&session_id).copied());
            emit_match_update(
                &app,
                match_id,
                "failed",
                Some(served_failure(reason).to_string()),
            );
            fail_pull(request_id, brokered_failure_message(reason));
        }
        ImageAssistWireMessage::Accepted { .. } => {
            // Progress only. The request is already bound by its digest, so
            // this changes nothing but what the requester is shown.
            let match_id = runtime()
                .lock()
                .ok()
                .and_then(|runtime| runtime.session_matches.get(&session_id).copied());
            emit_match_update(
                &app,
                match_id,
                "generating",
                Some("对方已接受，正在执行图片生成".to_string()),
            );
        }
    }
}

/// A brokered failure, phrased for the helper who agreed to serve it.
fn served_failure(reason: ImageAssistFailure) -> &'static str {
    match reason {
        ImageAssistFailure::Declined => "本机拒绝",
        ImageAssistFailure::HelperUnavailable => {
            "本机的 ChatGPT Web 账号不可用，或当日代出图额度已用完"
        }
        ImageAssistFailure::RequestMismatch => "送达的请求与你批准的那份不一致",
        ImageAssistFailure::GenerationFailed => "生成失败",
        ImageAssistFailure::Cancelled => "已取消",
        ImageAssistFailure::Expired => "已超时",
    }
}

/// A brokered failure, phrased for the person who asked rather than as a code.
/// Why a request never reached anyone, phrased for the person who asked.
///
/// Distinct from [`brokered_failure_message`]: that one explains a failure a
/// helper reported, this one explains that the pool ran out. Naming the reason
/// matters because "everyone declined" and "nobody was online" call for
/// different next steps.
fn unmatched_message(reason: MatchFailure) -> &'static str {
    match reason {
        MatchFailure::Declined => {
            "Every available user declined this request. Try again later, or bind a ChatGPT Web account in Settings."
        }
        MatchFailure::Timeout => {
            "No available user answered in time. Try again later, or bind a ChatGPT Web account in Settings."
        }
        MatchFailure::RateLimited => {
            "This computer has asked for too much help in the past hour. Try again later."
        }
        MatchFailure::Busy => "This computer already has a brokered image request in flight.",
        MatchFailure::Cancelled => "The image request was cancelled.",
        MatchFailure::NoHelper => {
            "No other user is currently available to generate images. Try again later, or bind a ChatGPT Web account in Settings."
        }
    }
}

fn brokered_failure_message(reason: ImageAssistFailure) -> String {
    match reason {
        ImageAssistFailure::Declined => "The other user declined this request.".to_string(),
        ImageAssistFailure::HelperUnavailable => {
            "The other user's ChatGPT account was not available.".to_string()
        }
        ImageAssistFailure::RequestMismatch => {
            "The request did not match what the other user approved.".to_string()
        }
        ImageAssistFailure::GenerationFailed => {
            "Image generation failed on the other user's computer.".to_string()
        }
        ImageAssistFailure::Cancelled => "The image request was cancelled.".to_string(),
        ImageAssistFailure::Expired => "The image request expired.".to_string(),
    }
}

/// In-flight retrieval of one brokered request's images.
#[derive(Debug, Clone)]
struct PullState {
    session_id: String,
    entries: Vec<ImageArtifactEntry>,
    index: usize,
    buffer: Vec<u8>,
    written: Vec<PathBuf>,
    staging_dir: PathBuf,
    received_bytes: u64,
    total_bytes: u64,
    last_progress_at: std::time::Instant,
}

/// Validates the manifest and asks for the first slice.
fn begin_pull(
    app: &AppHandle,
    session_id: &str,
    request_id: RequestId,
    artifacts: Vec<ImageArtifactEntry>,
) -> Result<Option<ImageAssistWireMessage>, String> {
    validate_artifact_manifest(&artifacts)
        .map_err(|error| format!("the other user returned an invalid manifest: {error}"))?;
    let first = artifacts[0].name.clone();
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "image assist runtime poisoned".to_string())?;
    let total_bytes = artifacts.iter().map(|artifact| artifact.size_bytes).sum();
    let artifact_count = artifacts.len();
    // The channel that delivers a result must be the channel this machine
    // asked on. Searching by request id alone would let a peer on one match
    // answer a request that belongs to another.
    let match_id = runtime.session_matches.get(session_id).copied();
    if match_id.and_then(|id| runtime.matches.get(&id).copied()) != Some(request_id) {
        return Err("the other user answered a request this session does not own".to_string());
    }
    if runtime.pulls.contains_key(&request_id) {
        return Err("the other user sent a duplicate result manifest".to_string());
    }
    let staging_dir = remote_artifact_staging_dir(&crate::state::workspace_dir(), request_id);
    if staging_dir.exists() {
        fs::remove_dir_all(&staging_dir)
            .map_err(|error| format!("could not clear an incomplete image transfer: {error}"))?;
    }
    runtime.pulls.insert(
        request_id,
        PullState {
            session_id: session_id.to_string(),
            entries: artifacts,
            index: 0,
            buffer: Vec::new(),
            written: Vec::new(),
            staging_dir,
            received_bytes: 0,
            total_bytes,
            last_progress_at: std::time::Instant::now(),
        },
    );
    drop(runtime);
    emit_transfer_progress(
        app,
        match_id,
        "receiving",
        0,
        total_bytes,
        0,
        artifact_count,
    );
    Ok(Some(ImageAssistWireMessage::ArtifactRead {
        request_id,
        name: first,
        offset: 0,
        max_bytes: IMAGE_ASSIST_MAX_ARTIFACT_CHUNK_BYTES as u32,
    }))
}

/// Accumulates one slice, writing and advancing when an image completes.
fn advance_pull(
    app: &AppHandle,
    session_id: &str,
    request_id: RequestId,
    name: &str,
    offset: u64,
    data: &[u8],
    eof: bool,
) -> Result<Option<ImageAssistWireMessage>, String> {
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "image assist runtime poisoned".to_string())?;
    let match_id = runtime
        .matches
        .iter()
        .find_map(|(match_id, candidate)| (*candidate == request_id).then_some(*match_id));
    let Some(pull) = runtime.pulls.get_mut(&request_id) else {
        return Ok(None);
    };
    if pull.session_id != session_id {
        return Err(
            "the image chunk arrived on a session that does not own this request".to_string(),
        );
    }
    let entry = pull
        .entries
        .get(pull.index)
        .cloned()
        .ok_or_else(|| "unexpected artifact chunk".to_string())?;
    // A peer that answers with a different artifact, or at the wrong offset, is
    // not something to reassemble optimistically.
    if entry.name != name || pull.buffer.len() as u64 != offset {
        return Err("the other user sent an out-of-order image chunk".to_string());
    }
    if pull.buffer.len().saturating_add(data.len()) as u64 > entry.size_bytes {
        return Err("the other user sent more data than the manifest declared".to_string());
    }
    if data.is_empty() && !eof {
        return Err("the other user sent an empty non-terminal image chunk".to_string());
    }
    pull.buffer.extend_from_slice(data);
    pull.received_bytes = pull.received_bytes.saturating_add(data.len() as u64);
    pull.last_progress_at = std::time::Instant::now();

    if !eof {
        let next_offset = pull.buffer.len() as u64;
        let next = ImageAssistWireMessage::ArtifactRead {
            request_id,
            name: entry.name,
            offset: next_offset,
            max_bytes: IMAGE_ASSIST_MAX_ARTIFACT_CHUNK_BYTES as u32,
        };
        let progress = (
            pull.received_bytes,
            pull.total_bytes,
            pull.written.len(),
            pull.entries.len(),
        );
        drop(runtime);
        emit_transfer_progress(
            app,
            match_id,
            "receiving",
            progress.0,
            progress.1,
            progress.2,
            progress.3,
        );
        return Ok(Some(next));
    }

    // Every image is validated into a request-scoped staging directory. None
    // become visible at their final paths until the whole manifest succeeds.
    let written = import_remote_artifact(&pull.staging_dir, &entry, &pull.buffer)?;
    pull.written.push(written);
    pull.buffer.clear();
    pull.index += 1;

    if let Some(next) = pull.entries.get(pull.index).cloned() {
        let next = ImageAssistWireMessage::ArtifactRead {
            request_id,
            name: next.name,
            offset: 0,
            max_bytes: IMAGE_ASSIST_MAX_ARTIFACT_CHUNK_BYTES as u32,
        };
        let progress = (
            pull.received_bytes,
            pull.total_bytes,
            pull.written.len(),
            pull.entries.len(),
        );
        drop(runtime);
        emit_transfer_progress(
            app,
            match_id,
            "receiving",
            progress.0,
            progress.1,
            progress.2,
            progress.3,
        );
        return Ok(Some(next));
    }

    let final_directory = remote_artifact_dir(&crate::state::workspace_dir(), request_id);
    if final_directory.exists() {
        return Err(
            "the remote image request would replace an existing result directory".to_string(),
        );
    }
    fs::rename(&pull.staging_dir, &final_directory)
        .map_err(|error| format!("could not finalize the received images: {error}"))?;
    let paths: Vec<_> = pull
        .entries
        .iter()
        .map(|entry| final_directory.join(&entry.name).display().to_string())
        .collect();
    let progress = (
        pull.received_bytes,
        pull.total_bytes,
        pull.written.len(),
        pull.entries.len(),
    );
    runtime.pulls.remove(&request_id);
    let match_id = runtime
        .matches
        .iter()
        .find_map(|(match_id, candidate)| (*candidate == request_id).then_some(*match_id));
    drop(runtime);

    emit_transfer_progress(
        app,
        match_id,
        "receiving",
        progress.0,
        progress.1,
        progress.2,
        progress.3,
    );

    // Settled before the result is published: the tool call polls every 250 ms
    // and the peer may hang up first, and whichever happens first must not be
    // read as this request failing.
    if let Some(match_id) = match_id {
        mark_settled(match_id);
    }
    let summary = serde_json::json!({
        "status": "completed",
        "source": "image-assist",
        "images": paths,
    })
    .to_string();
    finish_request(request_id, Ok(summary));
    emit_match_update_with_images(
        app,
        match_id,
        "completed",
        Some(format!("已接收 {} 张图片", paths.len())),
        paths,
    );
    Ok(None)
}

fn discard_pull_files(pull: &PullState) {
    if pull.staging_dir.exists() {
        let _ = fs::remove_dir_all(&pull.staging_dir);
    }
}

fn fail_pull(request_id: RequestId, error: String) {
    let pull = runtime()
        .lock()
        .ok()
        .and_then(|mut runtime| runtime.pulls.remove(&request_id));
    if let Some(pull) = pull {
        discard_pull_files(&pull);
    }
    finish_request(request_id, Err(error));
}

fn base64_of(envelope: &remote_protocol::SecureEnvelope) -> String {
    use base64::Engine as _;
    let bytes = serde_json::to_vec(envelope).unwrap_or_default();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Helper side: authorize, generate, and sanitize one brokered request.
fn serve_peer_request(
    app: &AppHandle,
    session_id: &str,
    request_id: RequestId,
    prompt: &str,
    aspect_ratio: Option<&str>,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<ImageArtifactEntry>, ImageAssistFailure> {
    let match_id = runtime()
        .lock()
        .ok()
        .and_then(|runtime| runtime.session_matches.get(session_id).copied());
    emit_match_update(
        app,
        match_id,
        "generating",
        Some("临时会话已验证，正在使用本机 ChatGPT 生成图片".to_string()),
    );
    let canonical = canonical_prompt(prompt);
    let ratio = canonical_aspect_ratio(aspect_ratio);
    let sources = match run_local_generation(&canonical, ratio.as_deref(), cancelled.clone()) {
        Ok(sources) => sources,
        Err(error) => {
            settle_running_request(request_id, false);
            let reason = if cancelled.load(Ordering::SeqCst) {
                ImageAssistFailure::Cancelled
            } else {
                eprintln!("SomniQ Image Assist generation failed: {error}");
                ImageAssistFailure::GenerationFailed
            };
            let _ = app.emit(
                IMAGE_ASSIST_ERROR_EVENT,
                format!(
                    "本机拒绝了一个已批准的代出图请求：{}",
                    served_failure(reason)
                ),
            );
            emit_match_update(
                app,
                match_id,
                "failed",
                Some(served_failure(reason).to_string()),
            );
            return Err(reason);
        }
    };
    if cancelled.load(Ordering::SeqCst) {
        discard_local_copies(&sources);
        settle_running_request(request_id, false);
        return Err(ImageAssistFailure::Cancelled);
    }
    let artifacts = match build_manifest(&sources) {
        Ok(artifacts) => artifacts,
        Err(error) => {
            // The account already generated the images, so this spends quota
            // even though the result cannot be shared safely.
            settle_running_request(request_id, true);
            discard_local_copies(&sources);
            eprintln!("SomniQ Image Assist refused to share a generated image: {error}");
            let _ = app.emit(
                IMAGE_ASSIST_ERROR_EVENT,
                format!("图片已生成，但无法安全传回：{error}"),
            );
            emit_match_update(
                app,
                match_id,
                "failed",
                Some(served_failure(ImageAssistFailure::GenerationFailed).to_string()),
            );
            return Err(ImageAssistFailure::GenerationFailed);
        }
    };
    settle_running_request(request_id, true);
    if let Err(error) = stash_served(session_id, request_id, &artifacts, &sources) {
        discard_local_copies(&sources);
        eprintln!("SomniQ Image Assist could not prepare a transfer: {error}");
        let _ = app.emit(
            IMAGE_ASSIST_ERROR_EVENT,
            format!("图片已生成，但无法安全传回：{error}"),
        );
        return Err(ImageAssistFailure::GenerationFailed);
    }
    emit_match_update(
        app,
        match_id,
        "generating",
        Some(format!(
            "已生成 {} 张图片，正在投递加密回传清单",
            artifacts.len()
        )),
    );
    Ok(artifacts)
}

/// Runs the local ChatGPT account and returns only local paths plus types.
fn run_local_generation(
    prompt: &str,
    aspect_ratio: Option<&str>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
) -> Result<Vec<(PathBuf, String)>, String> {
    let input = serde_json::json!({
        "prompt": prompt,
        "aspectRatio": aspect_ratio,
    })
    .to_string();
    let raw = crate::oracle_web::execute_bound_image_tool(&input, cancelled)?;
    let view: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("could not read the local image result: {error}"))?;
    let images = view
        .get("images")
        .and_then(|images| images.as_array())
        .ok_or_else(|| "the local image result carried no images".to_string())?;
    Ok(images
        .iter()
        .filter_map(|image| {
            let path = image.get("path")?.as_str()?;
            let mime = image.get("mimeType")?.as_str()?;
            Some((PathBuf::from(path), mime.to_string()))
        })
        .collect())
}

/// Removes images generated for a stranger from the helper's own project.
///
/// The shared Oracle path imports every generated image into the *active
/// project's* artifact directory, which is right when the local user asked for
/// the image and wrong when a stranger did: the helper never asked for these
/// files, they accumulate, and a tracked project would carry them into version
/// control. The bytes needed for transfer are already held in memory by then,
/// so the on-disk copy is pure residue.
///
/// Only the per-run directory Oracle just created is removed, never the shared
/// `oracle-images` root, so a local user's own images are untouched.
fn discard_local_copies(sources: &[(PathBuf, String)]) {
    let mut directories: Vec<&Path> = Vec::new();
    for (path, _) in sources {
        if let Err(error) = fs::remove_file(path) {
            if error.kind() != ErrorKind::NotFound {
                eprintln!("SomniQ Image Assist could not remove a brokered image copy: {error}");
            }
        }
        if let Some(parent) = path.parent() {
            if parent.file_name().is_some() && !directories.contains(&parent) {
                directories.push(parent);
            }
        }
    }
    for directory in directories {
        // Only succeeds when empty, so a directory holding anything else is
        // deliberately left alone.
        let _ = fs::remove_dir(directory);
    }
}

/// Holds the generated bytes so the requester can read them in chunks.
///
/// The manifest names are generated by index, so pairing them with the sources
/// in the same order is what maps a requested name back to a file. Reading here
/// rather than on each chunk request also means a later local change to the
/// generated file cannot alter what a verified digest refers to.
fn stash_served(
    session_id: &str,
    request_id: RequestId,
    artifacts: &[ImageArtifactEntry],
    sources: &[(PathBuf, String)],
) -> Result<(), String> {
    if artifacts.len() != sources.len() {
        return Err("the generated manifest does not match its sources".to_string());
    }
    let mut bytes = Vec::with_capacity(artifacts.len());
    for (entry, (path, _)) in artifacts.iter().zip(sources) {
        let content = fs::read(path)
            .map_err(|error| format!("could not read a generated image for transfer: {error}"))?;
        // The digest was taken over these exact bytes when the manifest was
        // built; refuse rather than serve something the requester will reject.
        if hex_digest(&content) != entry.sha256 {
            return Err("a generated image changed after it was hashed".to_string());
        }
        bytes.push((entry.name.clone(), content));
    }
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "image assist runtime poisoned".to_string())?;
    runtime.served.insert(
        request_id,
        ServedArtifacts {
            session_id: session_id.to_string(),
            entries: artifacts.to_vec(),
            bytes,
        },
    );
    drop(runtime);
    // The bytes are held in memory for the transfer, so the copy Oracle left in
    // the helper's active project is residue they never asked for.
    discard_local_copies(sources);
    Ok(())
}

/// Frees the bytes held for one brokered request.
///
/// Held images are bounded per request but unbounded across requests, so a
/// helper that served several would otherwise accumulate every one of them for
/// the life of the process.
fn release_served(request_id: RequestId) {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.served.remove(&request_id);
    }
}

/// Returns one slice plus whether it ends the last artifact of the request.
///
/// The held images stay where they are: a 16 MiB image is read 128 slices at a
/// time, so copying the whole set per request would move gigabytes to send
/// megabytes.
fn serve_chunk(
    session_id: &str,
    request_id: RequestId,
    name: &str,
    offset: u64,
    max_bytes: u32,
) -> Result<(Vec<u8>, bool, String, bool, (u64, u64, usize, usize)), String> {
    let runtime = runtime()
        .lock()
        .map_err(|_| "image assist runtime poisoned".to_string())?;
    let served = runtime
        .served
        .get(&request_id)
        .ok_or_else(|| "no such brokered request".to_string())?;
    if served.session_id != session_id {
        return Err("that request is not being served on this session".to_string());
    }
    let index = served
        .entries
        .iter()
        .position(|entry| entry.name == name)
        .ok_or_else(|| "no such artifact in this request".to_string())?;
    let entry = &served.entries[index];
    let last = index + 1 == served.entries.len();
    let (data, eof) = read_artifact_chunk(served, name, offset, max_bytes)?;
    let sent_before = served
        .entries
        .iter()
        .take(index)
        .map(|entry| entry.size_bytes)
        .sum::<u64>();
    let total_bytes = served.entries.iter().map(|entry| entry.size_bytes).sum();
    let sent_bytes = sent_before
        .saturating_add(offset)
        .saturating_add(data.len() as u64);
    let completed_artifacts = index + usize::from(eof);
    let artifact_count = served.entries.len();
    Ok((
        data,
        eof,
        entry.sha256.clone(),
        last,
        (sent_bytes, total_bytes, completed_artifacts, artifact_count),
    ))
}

/// Records the outcome of one brokered request, first answer wins.
///
/// Several paths can end a request at nearly the same moment — the last image
/// lands, the peer hangs up, the gateway closes the match — and the waiting
/// tool call only polls every 250 ms. Overwriting would let a transport that
/// closed right after a successful transfer replace images already on disk with
/// an error, which is both wrong and unrecoverable for the caller.
fn finish_request(request_id: RequestId, result: Result<String, String>) {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.results.entry(request_id).or_insert(result);
    }
}

/// The canonical form of a prompt, fixed before consent.
///
/// The Oracle path trims the prompt immediately before execution, so a digest
/// taken over the raw text would not describe what actually runs. Canonicalizing
/// here — before the requester confirms, before the preview is sealed, and
/// before the digest is computed — is what makes "the helper executes exactly
/// what it approved" true rather than approximately true.
pub(crate) fn canonical_prompt(prompt: &str) -> String {
    prompt.trim().to_string()
}

/// The canonical form of an aspect-ratio label, fixed before consent.
pub(crate) fn canonical_aspect_ratio(aspect_ratio: Option<&str>) -> Option<String> {
    aspect_ratio
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

/// The digest both peers bind the approved request to.
pub(crate) fn request_digest(prompt: &str, aspect_ratio: Option<&str>) -> [u8; 32] {
    let mut hasher = Sha256::new();
    // Length-prefixed so a prompt ending in the ratio cannot collide with the
    // same text split differently across the two fields.
    let prompt = canonical_prompt(prompt);
    hasher.update((prompt.len() as u64).to_be_bytes());
    hasher.update(prompt.as_bytes());
    match canonical_aspect_ratio(aspect_ratio) {
        Some(ratio) => {
            hasher.update((ratio.len() as u64).to_be_bytes());
            hasher.update(ratio.as_bytes());
        }
        None => hasher.update(u64::MAX.to_be_bytes()),
    }
    hasher.finalize().into()
}

/// Turns one locally generated image into a manifest entry a stranger may see.
///
/// Everything identifying is dropped rather than filtered: the name is built
/// from an index and the detected type, never from the source path, the Oracle
/// account, or the ChatGPT session.
fn manifest_entry(index: usize, path: &Path, mime: &str) -> Result<ImageArtifactEntry, String> {
    let extension = ALLOWED_IMAGE_TYPES
        .iter()
        .find(|(allowed, _)| *allowed == mime)
        .map(|(_, extension)| *extension)
        .ok_or_else(|| format!("refusing to share an unsupported image type: {mime}"))?;
    let bytes = fs::read(path)
        .map_err(|error| format!("could not read a generated image for sharing: {error}"))?;
    let size_bytes = bytes.len() as u64;
    if size_bytes == 0 {
        return Err("refusing to share an empty generated image".to_string());
    }
    if size_bytes > IMAGE_ASSIST_MAX_ARTIFACT_BYTES {
        return Err("a generated image exceeds the brokered size limit".to_string());
    }
    if !magic_bytes_match(mime, &bytes) {
        return Err("a generated image does not match its declared type".to_string());
    }
    Ok(ImageArtifactEntry {
        name: format!("image-{:02}.{extension}", index + 1),
        size_bytes,
        mime: mime.to_string(),
        sha256: hex_digest(&bytes),
    })
}

/// Builds the manifest a helper returns, from Oracle's local image list.
///
/// The input is the already-imported local artifact list. Oracle's own
/// structured result additionally carries `account_id`, `session_id`, prose
/// `output`, and absolute paths; none of that is accepted here, so it cannot be
/// forwarded by accident.
pub(crate) fn build_manifest(
    images: &[(PathBuf, String)],
) -> Result<Vec<ImageArtifactEntry>, String> {
    if images.is_empty() {
        return Err("image generation produced no images".to_string());
    }
    if images.len() > IMAGE_ASSIST_MAX_ARTIFACTS {
        return Err("image generation produced more images than may be shared".to_string());
    }
    let mut entries = Vec::with_capacity(images.len());
    let mut total = 0_u64;
    for (index, (path, mime)) in images.iter().enumerate() {
        let entry = manifest_entry(index, path, mime)?;
        total = total.saturating_add(entry.size_bytes);
        if total > IMAGE_ASSIST_MAX_TOTAL_ARTIFACT_BYTES {
            return Err("the generated images exceed the brokered total size limit".to_string());
        }
        entries.push(entry);
    }
    validate_artifact_manifest(&entries).map_err(|error| error.to_string())?;
    Ok(entries)
}

/// Where a requester stores images that came from another user's computer.
///
/// Deliberately separate from the local `oracle-images` directory so provenance
/// is visible in the path itself rather than only in an audit record.
pub(crate) fn remote_artifact_dir(workspace: &Path, request_id: RequestId) -> PathBuf {
    workspace
        .join(".somniq")
        .join("artifacts")
        .join("remote-images")
        .join(request_id.to_string())
}

fn remote_artifact_staging_dir(workspace: &Path, request_id: RequestId) -> PathBuf {
    workspace
        .join(".somniq")
        .join("artifacts")
        .join("remote-images")
        .join(format!(".{request_id}.partial"))
}

/// Writes one received image after validating it as untrusted input.
///
/// Every check is applied before the bytes reach their final path, and the file
/// is created with `create_new` so an existing path is never overwritten.
pub(crate) fn import_remote_artifact(
    directory: &Path,
    entry: &ImageArtifactEntry,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    entry.validate().map_err(|error| error.to_string())?;
    validate_artifact_name(&entry.name).map_err(|error| error.to_string())?;
    if bytes.len() as u64 != entry.size_bytes {
        return Err("a received image does not match its declared size".to_string());
    }
    if !magic_bytes_match(&entry.mime, bytes) {
        return Err("a received image does not match its declared type".to_string());
    }
    if hex_digest(bytes) != entry.sha256 {
        return Err("a received image does not match its declared digest".to_string());
    }

    let path = directory.join(&entry.name);
    // The name is already known to contain no separator or parent reference,
    // so this join cannot escape. Re-check the parent anyway: a symlinked
    // directory would otherwise redirect the write outside the artifact tree.
    if path.parent() != Some(directory) {
        return Err("a received image name would escape the artifact directory".to_string());
    }
    if fs::symlink_metadata(&path).is_ok() {
        return Err("a received image would replace an existing path".to_string());
    }
    fs::create_dir_all(directory)
        .map_err(|error| format!("could not prepare the remote image directory: {error}"))?;
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => {
            use std::io::Write as _;
            file.write_all(bytes)
                .map_err(|error| format!("could not write a received image: {error}"))?;
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            return Err("a received image would replace an existing path".to_string());
        }
        Err(error) => return Err(format!("could not write a received image: {error}")),
    }
    Ok(path)
}

fn magic_bytes_match(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("somniq-image-assist-{name}-{}", RequestId::new()));
        fs::create_dir_all(&path).expect("temp dir");
        path
    }

    fn png_bytes() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&[0_u8; 64]);
        bytes
    }

    fn entry_for(name: &str, bytes: &[u8]) -> ImageArtifactEntry {
        ImageArtifactEntry {
            name: name.to_string(),
            size_bytes: bytes.len() as u64,
            mime: "image/png".to_string(),
            sha256: hex_digest(bytes),
        }
    }

    #[test]
    fn the_manifest_never_carries_a_local_path_account_or_session() {
        let directory = temp_dir("manifest");
        let source = directory.join("oracle-session-9f3-account-42.png");
        fs::write(&source, png_bytes()).expect("write source");

        let manifest =
            build_manifest(&[(source.clone(), "image/png".to_string())]).expect("manifest builds");

        assert_eq!(manifest.len(), 1);
        let entry = &manifest[0];
        // The name is generated, not derived from the file it came from.
        assert_eq!(entry.name, "image-01.png");
        let encoded = serde_json::to_string(entry).expect("entry encodes");
        for leak in ["oracle", "session", "account", "9f3", "42"] {
            assert!(
                !encoded.contains(leak),
                "the manifest must not carry {leak}: {encoded}"
            );
        }
        assert!(!encoded.contains(&source.display().to_string()));
        assert_eq!(entry.sha256, hex_digest(&png_bytes()));
    }

    #[test]
    fn a_generated_image_that_contradicts_its_declared_type_is_not_shared() {
        let directory = temp_dir("mismatch");
        let source = directory.join("not-really.png");
        fs::write(&source, b"this is not a png").expect("write source");

        assert!(build_manifest(&[(source, "image/png".to_string())]).is_err());
    }

    #[test]
    fn a_received_image_must_match_its_size_type_and_digest() {
        let directory = temp_dir("inbound");
        let bytes = png_bytes();
        let entry = entry_for("image-01.png", &bytes);

        let mut wrong_size = entry.clone();
        wrong_size.size_bytes += 1;
        assert!(import_remote_artifact(&directory, &wrong_size, &bytes).is_err());

        let mut wrong_digest = entry.clone();
        wrong_digest.sha256 = "b".repeat(64);
        assert!(import_remote_artifact(&directory, &wrong_digest, &bytes).is_err());

        let mut wrong_type = entry.clone();
        wrong_type.mime = "image/jpeg".to_string();
        assert!(import_remote_artifact(&directory, &wrong_type, &bytes).is_err());

        let written = import_remote_artifact(&directory, &entry, &bytes).expect("valid image");
        assert_eq!(fs::read(&written).expect("read back"), bytes);
    }

    #[test]
    fn a_received_image_never_overwrites_an_existing_file() {
        let directory = temp_dir("no-overwrite");
        let bytes = png_bytes();
        let entry = entry_for("image-01.png", &bytes);

        fs::create_dir_all(&directory).expect("dir");
        fs::write(directory.join("image-01.png"), b"existing").expect("pre-existing file");

        assert!(import_remote_artifact(&directory, &entry, &bytes).is_err());
        assert_eq!(
            fs::read(directory.join("image-01.png")).expect("read"),
            b"existing"
        );
    }

    #[test]
    fn a_received_name_cannot_escape_the_artifact_directory() {
        let directory = temp_dir("traversal");
        let bytes = png_bytes();
        for name in ["../escape.png", "nested/image.png", "..\\escape.png"] {
            let entry = entry_for(name, &bytes);
            assert!(
                import_remote_artifact(&directory, &entry, &bytes).is_err(),
                "name must be refused: {name}"
            );
        }
    }

    #[test]
    fn the_request_digest_is_taken_over_the_canonical_form() {
        // The Oracle path trims before executing, so an untrimmed prompt must
        // produce the same digest as the text that actually runs.
        assert_eq!(
            request_digest("  a wind turbine  ", None),
            request_digest("a wind turbine", None)
        );
        assert_eq!(
            request_digest("a wind turbine", Some(" 16:9 ")),
            request_digest("a wind turbine", Some("16:9"))
        );
        // Different requests stay distinguishable, including across the field
        // boundary.
        assert_ne!(
            request_digest("a wind turbine", Some("16:9")),
            request_digest("a wind turbine16:9", None)
        );
        assert_ne!(
            request_digest("a wind turbine", None),
            request_digest("a wind turbine", Some("16:9"))
        );
    }

    fn descriptor(name: &str) -> (DeviceDescriptor, remote_protocol::DeviceSigningKey) {
        let signing = remote_protocol::DeviceSigningKey::generate();
        let agreement = remote_protocol::KeyAgreementSecret::generate();
        let descriptor = DeviceDescriptor::new(
            DeviceId::new(),
            remote_protocol::DeviceKind::Desktop,
            name,
            signing.public_key(),
            agreement.public_key(),
        )
        .expect("valid descriptor");
        (descriptor, signing)
    }

    fn transport(offerer: DeviceId, local_is_helper: bool) -> MatchTransport {
        MatchTransport {
            session_id: SessionId::new(),
            offerer,
            ice_servers: normalized_ice_servers(&[
                "stun:b.example.test:3478".to_string(),
                "stun:a.example.test:3478".to_string(),
            ]),
            expires_at_unix_ms: 1_800_000_000_000,
            request_digest: request_digest("a wind turbine at dusk", Some("16:9")),
            local_is_helper,
            direct_attempt: true,
            peer_verified: false,
            settled: false,
        }
    }

    #[test]
    fn brokered_transport_start_is_a_p2p_offer_from_the_helper() {
        let (requester, _) = descriptor("requester laptop");
        let session_id = SessionId::new();
        let mut transport = transport(DeviceId::new(), true);
        transport.session_id = session_id;

        let start = brokered_p2p_start_for(&requester, &transport);

        assert_eq!(start.device_id, requester.device_id.to_string());
        assert_eq!(start.session_id, session_id.to_string());
        assert_eq!(start.ice_servers, transport.ice_servers);
        assert!(start.brokered);
    }

    #[test]
    fn both_peers_build_the_same_transcript_from_opposite_sides() {
        // The transcript is verified by equality, so a role-dependent field
        // ordering would fail every brokered channel closed rather than
        // degrading gracefully.
        let (requester, _) = descriptor("requester laptop");
        let (helper, helper_signing) = descriptor("helper workstation");

        let mut helper_side = transport(helper.device_id, true);
        let mut requester_side = transport(helper.device_id, false);
        // The two peers share one match: everything but the local role is the
        // same value delivered to both.
        requester_side.session_id = helper_side.session_id;
        helper_side.peer_verified = true;

        let match_id = MatchId::new();
        let built_by_helper =
            build_transcript(match_id, helper.clone(), requester.clone(), &helper_side);
        let built_by_requester =
            build_transcript(match_id, requester, helper.clone(), &requester_side);

        assert_eq!(built_by_helper, built_by_requester);
        assert_eq!(
            built_by_helper
                .signature_transcript()
                .expect("helper-side bytes"),
            built_by_requester
                .signature_transcript()
                .expect("requester-side bytes")
        );
        // And the signature one side makes verifies against the other's copy.
        let proof = built_by_helper.sign(&helper_signing).expect("helper signs");
        assert!(built_by_requester.verify(helper.device_id, &proof).is_ok());
    }

    #[test]
    fn ice_servers_are_normalized_into_a_signable_order() {
        // The gateway may deliver these in any order to either peer, and an
        // unsorted or duplicated list is not signable at all.
        let servers = normalized_ice_servers(&[
            "stun:b.example.test:3478".to_string(),
            "stun:a.example.test:3478".to_string(),
            "stun:b.example.test:3478".to_string(),
        ]);
        assert_eq!(
            servers,
            vec![
                "stun:a.example.test:3478".to_string(),
                "stun:b.example.test:3478".to_string()
            ]
        );

        let flooded: Vec<String> = (0..IMAGE_ASSIST_MAX_ICE_SERVERS + 4)
            .map(|index| format!("stun:{index:02}.example.test:3478"))
            .collect();
        assert_eq!(
            normalized_ice_servers(&flooded).len(),
            IMAGE_ASSIST_MAX_ICE_SERVERS
        );

        let (requester, _) = descriptor("requester laptop");
        let (helper, _) = descriptor("helper workstation");
        let mut side = transport(helper.device_id, false);
        side.ice_servers = normalized_ice_servers(&flooded);
        assert!(build_transcript(MatchId::new(), requester, helper, &side)
            .validate()
            .is_ok());
    }

    #[test]
    fn a_mismatched_transcript_names_the_field_that_differs() {
        let (requester, _) = descriptor("requester laptop");
        let (helper, _) = descriptor("helper workstation");
        let side = transport(helper.device_id, false);
        let match_id = MatchId::new();
        let expected = build_transcript(match_id, requester.clone(), helper.clone(), &side);

        let mut relabelled = expected.clone();
        relabelled.helper = DeviceDescriptor::new(
            helper.device_id,
            helper.kind,
            "someone you trust",
            helper.signing_public_key,
            helper.key_agreement_public_key,
        )
        .expect("valid descriptor");
        assert_eq!(
            transcript_mismatch(&expected, &relabelled),
            "helper descriptor"
        );

        let mut reassigned = expected.clone();
        reassigned.offerer = requester.device_id;
        assert_eq!(transcript_mismatch(&expected, &reassigned), "assigned role");

        let mut substituted = expected.clone();
        substituted.request_digest = request_digest("something else entirely", None);
        assert_eq!(
            transcript_mismatch(&expected, &substituted),
            "request digest"
        );
    }

    fn approved(prompt: &str, aspect_ratio: Option<&str>) -> ApprovedRequest {
        ApprovedRequest {
            request_id: RequestId::new(),
            request_digest: request_digest(prompt, aspect_ratio),
            consumed: false,
            allowance_reserved: true,
        }
    }

    fn accepting() -> HelperPolicy {
        HelperPolicy {
            accept_image_help: true,
            daily_limit: 10,
        }
    }

    #[test]
    fn a_request_that_differs_from_the_approved_preview_is_refused() {
        let policy = accepting();
        let approval = approved("a wind turbine at dusk", Some("16:9"));

        // The approved request runs.
        assert_eq!(
            authorize_request(
                &policy,
                true,
                Some(&approval),
                approval.request_id,
                "a wind turbine at dusk",
                Some("16:9"),
                true
            ),
            Ok(())
        );
        // Whitespace and case differences are canonicalized, not treated as a
        // different request, because Oracle trims before it executes.
        assert_eq!(
            authorize_request(
                &policy,
                true,
                Some(&approval),
                approval.request_id,
                "  a wind turbine at dusk  ",
                Some(" 16:9 "),
                true
            ),
            Ok(())
        );
        // A substituted prompt is a bait-and-switch, not a recoverable error.
        assert_eq!(
            authorize_request(
                &policy,
                true,
                Some(&approval),
                approval.request_id,
                "something the user never saw",
                Some("16:9"),
                true
            ),
            Err(RefusalReason::DigestMismatch)
        );
        // So is a changed aspect ratio.
        assert_eq!(
            authorize_request(
                &policy,
                true,
                Some(&approval),
                approval.request_id,
                "a wind turbine at dusk",
                Some("1:1"),
                true
            ),
            Err(RefusalReason::DigestMismatch)
        );
    }

    #[test]
    fn an_approval_is_bound_to_one_request_id_and_consumed_once() {
        let policy = accepting();
        let mut approval = approved("a wind turbine at dusk", Some("16:9"));
        assert_eq!(
            authorize_request(
                &policy,
                true,
                Some(&approval),
                RequestId::new(),
                "a wind turbine at dusk",
                Some("16:9"),
                true,
            ),
            Err(RefusalReason::RequestIdMismatch)
        );

        approval.consumed = true;
        assert_eq!(
            authorize_request(
                &policy,
                true,
                Some(&approval),
                approval.request_id,
                "a wind turbine at dusk",
                Some("16:9"),
                true,
            ),
            Err(RefusalReason::AlreadyConsumed)
        );
    }

    #[test]
    fn a_request_is_refused_when_the_helper_did_not_opt_in_or_approve() {
        let approval = approved("a wind turbine", None);
        assert_eq!(
            authorize_request(
                &HelperPolicy::default(),
                true,
                Some(&approval),
                approval.request_id,
                "a wind turbine",
                None,
                true
            ),
            Err(RefusalReason::NotAccepting),
            "serving strangers must be opt-in"
        );
        assert_eq!(
            authorize_request(
                &accepting(),
                true,
                None,
                RequestId::new(),
                "a wind turbine",
                None,
                true,
            ),
            Err(RefusalReason::NotApproved),
            "a request with no matching approval never runs"
        );
        assert_eq!(
            authorize_request(
                &accepting(),
                true,
                Some(&approval),
                approval.request_id,
                "a wind turbine",
                None,
                false
            ),
            Err(RefusalReason::QuotaExhausted)
        );
    }

    #[test]
    fn the_daily_allowance_reserves_before_it_commits() {
        let mut allowance = DailyAllowance::default();
        let day = 20_318;

        // Two dialogs open at once must not both see the last unit.
        assert!(allowance.reserve(2, day));
        assert!(allowance.reserve(2, day));
        assert!(!allowance.reserve(2, day));
        assert_eq!(allowance.remaining(2, day), 0);

        // A declined dialog returns its hold, freeing one unit again.
        allowance.release();
        assert_eq!(allowance.remaining(2, day), 1);
        // Committing the surviving hold spends exactly one of the two units.
        allowance.commit();
        assert_eq!(allowance.remaining(2, day), 1);
        // And that one is spent for good, unlike a release.
        assert!(allowance.reserve(2, day));
        assert_eq!(allowance.remaining(2, day), 0);

        // The next local day starts fresh.
        assert_eq!(allowance.remaining(2, day + 1), 2);
        assert!(allowance.reserve(2, day + 1));
    }

    #[test]
    fn committed_daily_allowance_survives_a_restart_but_reservations_do_not() {
        let directory = temp_dir("allowance");
        let path = directory.join("allowance.json");
        let day = 20_318;
        let mut allowance = DailyAllowance::default();
        assert!(allowance.reserve(3, day));
        allowance.commit();
        assert!(allowance.reserve(3, day));

        persist_daily_allowance_to(&path, &allowance).expect("allowance persists");
        let restored = load_daily_allowance_from(&path).expect("allowance restores");
        assert_eq!(
            restored.remaining(3, day),
            2,
            "one committed unit remains spent"
        );
        assert_eq!(
            restored.reserved, 0,
            "in-flight work is cancelled by restart"
        );
    }

    #[test]
    fn brokered_images_do_not_stay_in_the_helpers_own_project() {
        let directory = temp_dir("discard");
        let run_dir = directory.join("oracle-images").join("run-01");
        fs::create_dir_all(&run_dir).expect("run dir");
        let first = run_dir.join("image-01.png");
        let second = run_dir.join("image-02.png");
        fs::write(&first, png_bytes()).expect("write");
        fs::write(&second, png_bytes()).expect("write");

        discard_local_copies(&[
            (first.clone(), "image/png".to_string()),
            (second.clone(), "image/png".to_string()),
        ]);

        // The helper never asked for these files; leaving them would grow their
        // project and could carry a stranger's image into version control.
        assert!(!first.exists());
        assert!(!second.exists());
        assert!(
            !run_dir.exists(),
            "the emptied per-run directory is removed"
        );
        // The shared parent is never touched.
        assert!(directory.join("oracle-images").exists());
    }

    #[test]
    fn a_run_directory_holding_anything_else_is_left_alone() {
        let directory = temp_dir("discard-shared");
        let run_dir = directory.join("run-02");
        fs::create_dir_all(&run_dir).expect("run dir");
        let generated = run_dir.join("image-01.png");
        fs::write(&generated, png_bytes()).expect("write");
        fs::write(run_dir.join("notes.txt"), b"something else").expect("write");

        discard_local_copies(&[(generated.clone(), "image/png".to_string())]);

        assert!(!generated.exists());
        assert!(
            run_dir.exists(),
            "a directory with other files is preserved"
        );
    }

    #[test]
    fn chunk_reads_are_bounded_and_scoped_to_the_request() {
        let bytes = png_bytes();
        let served = ServedArtifacts {
            session_id: SessionId::new().to_string(),
            entries: vec![entry_for("image-01.png", &bytes)],
            bytes: vec![("image-01.png".to_string(), bytes.clone())],
        };

        let (chunk, eof) = read_artifact_chunk(&served, "image-01.png", 0, 8).expect("first chunk");
        assert_eq!(chunk.len(), 8);
        assert!(!eof);

        let (rest, eof) =
            read_artifact_chunk(&served, "image-01.png", 8, u32::MAX).expect("remainder");
        assert_eq!(rest.len(), bytes.len() - 8);
        assert!(eof);

        // A peer cannot use the chunk protocol to reach anything else.
        assert!(read_artifact_chunk(&served, "image-02.png", 0, 16).is_err());
        assert!(read_artifact_chunk(&served, "../secret.png", 0, 16).is_err());
        assert!(read_artifact_chunk(&served, "image-01.png", 9_999, 16).is_err());
    }

    #[test]
    fn images_are_served_only_on_the_session_the_match_approved() {
        // Held images are keyed by request, and a request id travels on the
        // wire. Without binding them to the channel that was approved, another
        // brokered peer could name someone else's request and be handed their
        // images.
        let bytes = png_bytes();
        let request_id = RequestId::new();
        let session_id = SessionId::new().to_string();
        let other_session = SessionId::new().to_string();
        runtime().lock().expect("runtime").served.insert(
            request_id,
            ServedArtifacts {
                session_id: session_id.clone(),
                entries: vec![entry_for("image-01.png", &bytes)],
                bytes: vec![("image-01.png".to_string(), bytes.clone())],
            },
        );

        let (data, eof, _, last, _) =
            serve_chunk(&session_id, request_id, "image-01.png", 0, 4_096)
                .expect("the approved session reads its own images");
        assert_eq!(data, bytes);
        assert!(eof && last);
        assert!(
            serve_chunk(&other_session, request_id, "image-01.png", 0, 4_096).is_err(),
            "another brokered session must not read this request's images"
        );

        release_served(request_id);
    }

    #[test]
    fn a_delivered_result_survives_a_transport_that_closes_right_after_it() {
        // The waiting tool call polls every 250 ms, so a peer hanging up
        // immediately after the last chunk lands races the poll. Losing that
        // race must not turn images already on disk into an error.
        let request_id = RequestId::new();
        finish_request(request_id, Ok("{\"status\":\"completed\"}".to_string()));
        finish_request(request_id, Err("对方已关闭加密中继通道".to_string()));

        let result = take_result(request_id)
            .expect("runtime is readable")
            .expect("a result was recorded");
        assert_eq!(result.as_deref(), Ok("{\"status\":\"completed\"}"));
    }

    #[test]
    fn a_settled_match_treats_the_transport_closing_as_expected() {
        let match_id = MatchId::new();
        let (peer, _) = descriptor("peer");
        assert!(
            !match_settled(match_id),
            "a match with no transport has not settled"
        );

        runtime()
            .lock()
            .expect("runtime")
            .transports
            .insert(match_id, transport(peer.device_id, false));
        assert!(!match_settled(match_id), "an open match has not settled");

        mark_settled(match_id);
        assert!(match_settled(match_id));

        runtime()
            .lock()
            .expect("runtime")
            .transports
            .remove(&match_id);
    }

    #[test]
    fn a_refused_request_never_reaches_the_helpers_chatgpt_account() {
        let mut allowance = DailyAllowance::default();
        let mut approval = approved("a wind turbine", None);
        let ran = std::cell::Cell::new(false);
        let execute = |_: &str, _: Option<&str>| {
            ran.set(true);
            Ok(Vec::new())
        };

        // A substituted prompt must be rejected before any browser work, so the
        // helper's quota and ChatGPT history stay untouched.
        let outcome = serve_request(
            &accepting(),
            true,
            &mut allowance,
            20_318,
            approval.request_id,
            Some(&mut approval),
            "a completely different prompt",
            None,
            &execute,
        );

        assert_eq!(
            outcome,
            ServeOutcome::Failed {
                reason: ImageAssistFailure::RequestMismatch
            }
        );
        assert!(
            !ran.get(),
            "generation must not start for a refused request"
        );
        assert_eq!(allowance.remaining(10, 20_318), 10, "no allowance is spent");
    }

    #[test]
    fn a_request_from_an_unverified_peer_never_reaches_the_helpers_account() {
        // The transcript is the first frame on the channel. A request that
        // arrives before one has verified is not an ordering accident to
        // tolerate: the approval was for the peer the gateway introduced, and
        // nothing yet proves this channel carries that peer.
        let mut allowance = DailyAllowance::default();
        let mut approval = approved("a wind turbine", None);
        let ran = std::cell::Cell::new(false);
        let execute = |_: &str, _: Option<&str>| {
            ran.set(true);
            Ok(Vec::new())
        };

        assert_eq!(
            authorize_request(
                &accepting(),
                false,
                Some(&approval),
                approval.request_id,
                "a wind turbine",
                None,
                true
            ),
            Err(RefusalReason::PeerUnverified)
        );

        let outcome = serve_request(
            &accepting(),
            false,
            &mut allowance,
            20_318,
            approval.request_id,
            Some(&mut approval),
            "a wind turbine",
            None,
            &execute,
        );

        assert_eq!(
            outcome,
            ServeOutcome::Failed {
                reason: ImageAssistFailure::RequestMismatch
            }
        );
        assert!(!ran.get(), "an unverified peer must not drive the browser");
        assert_eq!(allowance.remaining(10, 20_318), 10, "no allowance is spent");
    }

    #[test]
    fn a_served_request_runs_the_canonical_prompt_and_returns_a_clean_manifest() {
        let directory = temp_dir("serve");
        let source = directory.join("oracle-account-77.png");
        fs::write(&source, png_bytes()).expect("write source");

        let mut allowance = DailyAllowance::default();
        let mut approval = approved("a wind turbine", Some("16:9"));
        let seen = std::cell::RefCell::new(None);
        let execute = |prompt: &str, ratio: Option<&str>| {
            *seen.borrow_mut() = Some((prompt.to_string(), ratio.map(str::to_string)));
            Ok(vec![(source.clone(), "image/png".to_string())])
        };

        let outcome = serve_request(
            &accepting(),
            true,
            &mut allowance,
            20_318,
            approval.request_id,
            Some(&mut approval),
            "  a wind turbine  ",
            Some(" 16:9 "),
            &execute,
        );

        // The canonical form is what was approved, so it is what runs.
        assert_eq!(
            seen.into_inner(),
            Some(("a wind turbine".to_string(), Some("16:9".to_string())))
        );
        let ServeOutcome::Completed { artifacts } = outcome else {
            panic!("expected a completed request, got {outcome:?}");
        };
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].name, "image-01.png");
        let encoded = serde_json::to_string(&artifacts).expect("encode");
        assert!(!encoded.contains("account"), "manifest leaked: {encoded}");
        assert_eq!(allowance.remaining(10, 20_318), 9, "one unit is spent");
    }

    #[test]
    fn a_failed_generation_returns_the_allowance() {
        let mut allowance = DailyAllowance::default();
        let mut approval = approved("a wind turbine", None);
        let execute = |_: &str, _: Option<&str>| Err("the browser session expired".to_string());

        let outcome = serve_request(
            &accepting(),
            true,
            &mut allowance,
            20_318,
            approval.request_id,
            Some(&mut approval),
            "a wind turbine",
            None,
            &execute,
        );

        assert_eq!(
            outcome,
            ServeOutcome::Failed {
                reason: ImageAssistFailure::GenerationFailed
            }
        );
        assert_eq!(
            allowance.remaining(10, 20_318),
            10,
            "a request that produced nothing must not consume the daily allowance"
        );
    }

    #[test]
    fn a_peer_fingerprint_identifies_a_row_without_identifying_a_person() {
        let device_id = "9f3a1c7e-4b2d-4a51-8e6f-0d5c2b7a1e94";
        let fingerprint = peer_fingerprint(device_id);

        assert_eq!(fingerprint.len(), 8);
        assert!(!fingerprint.contains('-'));
        // Enough to tell two rows apart and to match an audit record...
        assert_ne!(
            fingerprint,
            peer_fingerprint("1a2b3c4d-0000-0000-0000-000000000000")
        );
        // ...but never the full identity.
        assert!(!device_id.starts_with(&fingerprint) || fingerprint.len() < device_id.len());
        assert!(fingerprint.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn remote_images_are_stored_apart_from_locally_generated_ones() {
        let workspace = PathBuf::from("C:").join("workspace");
        let request_id = RequestId::new();
        let directory = remote_artifact_dir(&workspace, request_id);
        let rendered = directory.display().to_string().replace('\\', "/");

        assert!(rendered.contains("/.somniq/artifacts/remote-images/"));
        assert!(rendered.ends_with(&request_id.to_string()));
        // Provenance is visible in the path, not only in an audit record.
        assert!(!rendered.contains("oracle-images"));
    }

    #[test]
    fn an_incomplete_multi_image_transfer_leaves_no_final_or_staged_files() {
        let workspace = temp_dir("partial-transfer");
        let request_id = RequestId::new();
        let staging = remote_artifact_staging_dir(&workspace, request_id);
        let final_directory = remote_artifact_dir(&workspace, request_id);
        let bytes = png_bytes();
        let entry = entry_for("image-01.png", &bytes);
        let written =
            import_remote_artifact(&staging, &entry, &bytes).expect("first staged artifact");
        let pull = PullState {
            session_id: SessionId::new().to_string(),
            entries: vec![entry],
            index: 1,
            buffer: Vec::new(),
            written: vec![written],
            staging_dir: staging.clone(),
            received_bytes: bytes.len() as u64,
            total_bytes: bytes.len() as u64,
            last_progress_at: std::time::Instant::now(),
        };

        discard_pull_files(&pull);
        assert!(!staging.exists());
        assert!(!final_directory.exists());
    }
}
