//! Image Assist match brokering.
//!
//! The gateway introduces two desktops that have never paired so one can
//! generate an image on the other's ChatGPT account. Everything here is
//! process-local: no match, helper advertisement, or preview is ever written to
//! the durable device state, and a restart cancels in-flight matches rather
//! than resuming them.
//!
//! The state machine is deliberately a plain, side-effect-free type with
//! compare-and-swap transitions. Every transition names its single valid
//! predecessor, so a late, duplicated, or replayed frame is rejected rather
//! than racing. See `docs/development-logic/image-assist-network.md`.

use remote_protocol::{
    DeviceId as ProtocolDeviceId, ImageAssistLocation, MatchId, RequestId, SessionId,
};
use std::collections::HashMap;

/// Wall-clock lifetime of a match from creation to approval.
pub const MATCH_TTL_MS: i64 = 180_000;

/// Lifetime of an approved temporary session. It is longer than the offer TTL
/// because browser image generation plus cross-region transfer can legitimately
/// exceed the time needed for a helper to accept a preview.
pub const APPROVED_MATCH_TTL_MS: i64 = 15 * 60 * 1_000;

/// How long a helper advertisement survives without renewal.
pub const HELPER_LEASE_MS: i64 = 60_000;

/// Maximum lease a helper may request, so a client cannot pin itself online.
pub const HELPER_MAX_LEASE_MS: i64 = 300_000;

/// Maximum brokered requests one requester device may start per hour.
pub const REQUESTER_HOURLY_LIMIT: u32 = 12;

/// Rolling window for [`REQUESTER_HOURLY_LIMIT`].
pub const REQUESTER_RATE_WINDOW_MS: i64 = 3_600_000;

/// Maximum sealed preview size the gateway will relay, well under the signal
/// frame cap so preview traffic cannot be used to probe the frame limit.
pub const MAX_SEALED_PREVIEW_BYTES: usize = 32 * 1024;

type DeviceId = String;

/// Lifecycle of one brokered match.
///
/// `Approved` is the first state in which any transport session identifier
/// exists: consent strictly precedes connectivity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchState {
    /// A helper was selected; the requester has not sealed its preview yet.
    Offered,
    /// The sealed preview is available for the helper to open and display.
    Previewed,
    /// The helper's local user approved. Transport identifiers now exist.
    Approved,
    /// A transport channel has bound at least once.
    Active,
    Closed,
}

/// Why a brokered attempt ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchOutcome {
    Declined,
    Expired,
    Cancelled,
    Completed,
    HelperLost,
}

/// Rejected transitions. These are protocol violations or races, never
/// recoverable conditions the caller should retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchError {
    UnknownMatch,
    NotAParty,
    WrongState,
    Expired,
    RelayAlreadyGranted,
    PreviewTooLarge,
    NotTheRequester,
    NotTheHelper,
}

impl MatchError {
    /// Fixed, non-identifying wire text, matching the gateway's existing error
    /// convention. It never names the peer, the match, or the state.
    pub fn message(self) -> &'static str {
        match self {
            Self::UnknownMatch => "no such match",
            Self::NotAParty => "the device is not a party to this match",
            Self::WrongState => "the match does not allow this transition",
            Self::Expired => "the match has expired",
            Self::RelayAlreadyGranted => "a relay session was already granted",
            Self::PreviewTooLarge => "the sealed preview is too large",
            Self::NotTheRequester => "only the requester may seal the preview",
            Self::NotTheHelper => "only the helper may decide on this match",
        }
    }
}

impl std::fmt::Display for MatchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for MatchError {}

/// One brokered match. Never persisted.
#[derive(Debug, Clone)]
pub struct ImageMatch {
    pub match_id: MatchId,
    pub request_id: RequestId,
    pub requester: DeviceId,
    pub helper: DeviceId,
    pub state: MatchState,
    /// Minted only on approval, so `image_match_allows` can authorize nothing
    /// before the helper has consented.
    pub p2p_session_id: Option<SessionId>,
    /// Minted at most once, on the first fallback request.
    pub relay_session_id: Option<SessionId>,
    /// Opaque ciphertext. The gateway relays it and never inspects it.
    pub sealed_preview: Option<Vec<u8>>,
    pub expires_at_unix_ms: i64,
    pub outcome: Option<MatchOutcome>,
}

impl ImageMatch {
    fn new(request_id: RequestId, requester: DeviceId, helper: DeviceId, now_unix_ms: i64) -> Self {
        Self {
            match_id: MatchId::new(),
            request_id,
            requester,
            helper,
            state: MatchState::Offered,
            p2p_session_id: None,
            relay_session_id: None,
            sealed_preview: None,
            expires_at_unix_ms: now_unix_ms.saturating_add(MATCH_TTL_MS),
            outcome: None,
        }
    }

    fn is_party(&self, device_id: &str) -> bool {
        self.requester == device_id || self.helper == device_id
    }

    fn expired_at(&self, now_unix_ms: i64) -> bool {
        now_unix_ms >= self.expires_at_unix_ms
    }

    /// Returns whether this match authorizes one signaling or relay operation.
    ///
    /// The session identifier is checked, not just the device pair. Without it
    /// one brokered image request would become a durable open channel between
    /// two strangers for any session they chose to name.
    pub fn allows(&self, first: &str, second: &str, session_id: &str, now_unix_ms: i64) -> bool {
        if !matches!(self.state, MatchState::Approved | MatchState::Active) {
            return false;
        }
        if self.expired_at(now_unix_ms) {
            return false;
        }
        let pair_matches = (self.requester == first && self.helper == second)
            || (self.requester == second && self.helper == first);
        if !pair_matches {
            return false;
        }
        self.p2p_session_id
            .is_some_and(|session| session.to_string() == session_id)
            || self
                .relay_session_id
                .is_some_and(|session| session.to_string() == session_id)
    }
}

/// A helper's transient willingness to serve.
///
/// There is deliberately no slot count: the desktop serializes every Oracle job
/// behind one global lock, so effective concurrency is one and advertising any
/// other number would be a claim the gateway would then act on.
#[derive(Debug, Clone)]
pub struct HelperLease {
    pub device_id: DeviceId,
    /// Opt-in. Absent means the roster shows only a short fingerprint.
    pub display_name: Option<String>,
    /// Present only after the helper explicitly approved coarse location
    /// sharing on its own desktop.
    pub location: Option<ImageAssistLocation>,
    pub expires_at_unix_ms: i64,
    /// Drives least-recently-matched selection so a permanently online helper
    /// is not disturbed repeatedly while others idle.
    pub last_matched_at_unix_ms: Option<i64>,
    /// Set while this helper is committed to a match.
    pub busy_with: Option<MatchId>,
}

impl HelperLease {
    fn available(&self, now_unix_ms: i64) -> bool {
        self.busy_with.is_none() && now_unix_ms < self.expires_at_unix_ms
    }
}

/// One roster row shown in the desktop's online-helpers list.
///
/// Anonymous by default: a helper opting in to serve strangers has not thereby
/// agreed to publish its device name, which frequently contains a real name.
#[derive(Debug, Clone, PartialEq)]
pub struct RosterEntry {
    /// First 8 hex characters of the device id. Enough to disambiguate rows and
    /// to match against an audit record, not enough to identify a person.
    pub fingerprint: String,
    pub display_name: Option<String>,
    pub location: Option<ImageAssistLocation>,
    pub available: bool,
}

/// Process-local brokering state.
#[derive(Debug, Default)]
pub struct ImageAssistState {
    helpers: HashMap<DeviceId, HelperLease>,
    matches: HashMap<MatchId, ImageMatch>,
    /// Candidates already tried for one request — declined, timed out, or gone
    /// — so advancing never offers the same request to the same helper twice.
    attempted: HashMap<RequestId, Vec<DeviceId>>,
    /// Start timestamps per requester for the rolling rate limit.
    recent_requests: HashMap<DeviceId, Vec<i64>>,
}

impl ImageAssistState {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Records or renews a helper advertisement.
    pub fn advertise(
        &mut self,
        device_id: &str,
        display_name: Option<String>,
        location: Option<ImageAssistLocation>,
        lease_ms: i64,
        now_unix_ms: i64,
    ) {
        let lease_ms = lease_ms.clamp(1_000, HELPER_MAX_LEASE_MS);
        let expires_at_unix_ms = now_unix_ms.saturating_add(lease_ms);
        self.helpers
            .entry(device_id.to_string())
            .and_modify(|helper| {
                helper.display_name = display_name.clone();
                helper.location = location.clone();
                helper.expires_at_unix_ms = expires_at_unix_ms;
            })
            .or_insert_with(|| HelperLease {
                device_id: device_id.to_string(),
                display_name,
                location,
                expires_at_unix_ms,
                last_matched_at_unix_ms: None,
                busy_with: None,
            });
    }

    /// Renews helper presence without changing its optional public metadata.
    ///
    /// Presence is process-local, so the first renewal after a gateway restart
    /// recreates an anonymous row. A later explicit HelperReady can restore
    /// metadata the user chose to publish.
    pub fn renew(&mut self, device_id: &str, lease_ms: i64, now_unix_ms: i64) {
        let lease_ms = lease_ms.clamp(1_000, HELPER_MAX_LEASE_MS);
        let expires_at_unix_ms = now_unix_ms.saturating_add(lease_ms);
        if let Some(helper) = self.helpers.get_mut(device_id) {
            helper.expires_at_unix_ms = expires_at_unix_ms;
        } else {
            self.helpers.insert(
                device_id.to_string(),
                HelperLease {
                    device_id: device_id.to_string(),
                    display_name: None,
                    location: None,
                    expires_at_unix_ms,
                    last_matched_at_unix_ms: None,
                    busy_with: None,
                },
            );
        }
    }

    /// Drops a device that is no longer reachable, with everything it holds.
    ///
    /// A lease is a promise to answer, and a device whose signal connection is
    /// gone cannot keep it. Without this, a helper that closes the app stays
    /// matchable for the rest of its lease and, worse, keeps any match it was
    /// already committed to alive until that match's own deadline — so the
    /// requester waits out the full TTL for a dialog that will never appear.
    /// Broader than [`Self::withdraw`]: it also ends matches this device is the
    /// requester of, which no lease covers.
    pub fn disconnect(&mut self, device_id: &str) -> Vec<ImageMatch> {
        self.helpers.remove(device_id);
        let affected: Vec<MatchId> = self
            .matches
            .values()
            .filter(|record| record.state != MatchState::Closed && record.is_party(device_id))
            .map(|record| record.match_id)
            .collect();
        let mut closed = Vec::new();
        for match_id in affected {
            if let Some(record) = self.matches.get_mut(&match_id) {
                record.state = MatchState::Closed;
                record.outcome = Some(if record.helper == device_id {
                    MatchOutcome::HelperLost
                } else {
                    MatchOutcome::Cancelled
                });
                closed.push(record.clone());
            }
        }
        for record in &closed {
            self.release_helper(record.helper.as_str(), record.match_id);
            // A helper that vanished is a candidate that was tried, so the
            // request advances past it rather than being offered to the same
            // dead machine again.
            self.mark_attempted(record.request_id, &record.helper);
            self.matches.remove(&record.match_id);
        }
        closed
    }

    /// Withdraws a helper. Any match it is committed to is closed, because a
    /// helper that stopped advertising cannot be relied on to answer.
    pub fn withdraw(&mut self, device_id: &str) -> Vec<ImageMatch> {
        let Some(helper) = self.helpers.remove(device_id) else {
            return Vec::new();
        };
        let Some(match_id) = helper.busy_with else {
            return Vec::new();
        };
        let mut closed = Vec::new();
        if let Some(record) = self.matches.get_mut(&match_id) {
            if record.state != MatchState::Closed {
                record.state = MatchState::Closed;
                record.outcome = Some(MatchOutcome::HelperLost);
                closed.push(record.clone());
            }
        }
        for record in &closed {
            self.mark_attempted(record.request_id, &record.helper);
        }
        closed
    }

    /// Drops expired helper leases and expired matches.
    ///
    /// Called before every read so a caller never observes a helper or match
    /// that has already timed out.
    pub fn expire(&mut self, now_unix_ms: i64) -> Vec<ImageMatch> {
        let stale: Vec<_> = self
            .helpers
            .values()
            .filter(|helper| now_unix_ms >= helper.expires_at_unix_ms)
            .map(|helper| helper.device_id.clone())
            .collect();
        let mut closed = Vec::new();
        for device_id in stale {
            closed.extend(self.withdraw(&device_id));
        }

        for record in self.matches.values_mut() {
            if record.state != MatchState::Closed && record.expired_at(now_unix_ms) {
                record.state = MatchState::Closed;
                record.outcome = Some(MatchOutcome::Expired);
                closed.push(record.clone());
            }
        }
        for record in &closed {
            self.release_helper(record.helper.as_str(), record.match_id);
            // An unanswered dialog and a helper that went offline are both
            // "this candidate was tried". Recording them here is what lets the
            // request advance instead of being re-offered to the same machine.
            self.mark_attempted(record.request_id, &record.helper);
        }
        self.matches
            .retain(|_, record| record.state != MatchState::Closed);
        closed
    }

    /// Returns the roster shown to one requester.
    ///
    /// An advertised viewer remains visible so the desktop can verify its own
    /// presence and label that row locally. `available` means available to
    /// other requesters; [`Self::open_match`] still excludes the requester and
    /// can never match a device to itself.
    pub fn roster(
        &mut self,
        viewer: &str,
        now_unix_ms: i64,
        connected: &dyn Fn(&str) -> bool,
    ) -> Vec<RosterEntry> {
        self.expire(now_unix_ms);
        let mut rows: Vec<_> = self
            .helpers
            .values()
            .map(|helper| RosterEntry {
                fingerprint: fingerprint(&helper.device_id),
                display_name: helper.display_name.clone(),
                location: helper.location.clone(),
                // Matching applies the same liveness test. Its separate
                // requester-id guard prevents this row from self-matching.
                available: helper.available(now_unix_ms) && connected(&helper.device_id),
            })
            .collect();
        let viewer_fingerprint = fingerprint(viewer);
        rows.sort_by(|a, b| {
            (a.fingerprint != viewer_fingerprint)
                .cmp(&(b.fingerprint != viewer_fingerprint))
                .then_with(|| a.fingerprint.cmp(&b.fingerprint))
        });
        rows
    }

    /// Whether a requester is within its rolling request budget.
    pub fn rate_limit_allows(&mut self, requester: &str, now_unix_ms: i64) -> bool {
        let window_start = now_unix_ms.saturating_sub(REQUESTER_RATE_WINDOW_MS);
        let entries = self
            .recent_requests
            .entry(requester.to_string())
            .or_default();
        entries.retain(|started| *started > window_start);
        (entries.len() as u32) < REQUESTER_HOURLY_LIMIT
    }

    /// Whether this requester already has a brokered match in flight.
    pub fn has_active_request(&self, requester: &str) -> bool {
        self.matches
            .values()
            .any(|record| record.requester == requester && record.state != MatchState::Closed)
    }

    /// Selects the least-recently-matched available helper and opens a match.
    ///
    /// Returns `None` when no candidate remains, which the caller reports
    /// immediately rather than queueing: telling the user nobody is available
    /// is more honest than an indefinite wait.
    ///
    /// Spends one unit of the requester's rolling budget. Advancing an existing
    /// request to another candidate goes through [`Self::rematch`] instead, so
    /// a request that several helpers decline costs its budget once rather than
    /// once per candidate.
    pub fn open_match(
        &mut self,
        request_id: RequestId,
        requester: &str,
        now_unix_ms: i64,
        connected: &dyn Fn(&str) -> bool,
    ) -> Option<ImageMatch> {
        let record = self.select_candidate(request_id, requester, now_unix_ms, connected)?;
        self.recent_requests
            .entry(requester.to_string())
            .or_default()
            .push(now_unix_ms);
        Some(record)
    }

    /// Advances a request that has not been approved to its next candidate.
    ///
    /// A decline, an unanswered dialog, or a helper that goes offline is a
    /// property of that helper, not of the request: the requester asked once
    /// and should not have to ask again. Every candidate already attempted is
    /// excluded, so the pool drains rather than cycling, and the requester's
    /// own timeout bounds the whole sequence.
    pub fn rematch(
        &mut self,
        request_id: RequestId,
        requester: &str,
        now_unix_ms: i64,
        connected: &dyn Fn(&str) -> bool,
    ) -> Option<ImageMatch> {
        self.select_candidate(request_id, requester, now_unix_ms, connected)
    }

    /// Picks a candidate.
    ///
    /// `connected` reports whether a device currently has a live signal
    /// connection. A lease alone is not enough: it survives up to a minute
    /// after the app closed, and every frame the gateway addresses to a device
    /// with no connection is dropped silently, so matching on a stale lease
    /// spends the whole match TTL waiting for a dialog nobody can see.
    fn select_candidate(
        &mut self,
        request_id: RequestId,
        requester: &str,
        now_unix_ms: i64,
        connected: &dyn Fn(&str) -> bool,
    ) -> Option<ImageMatch> {
        self.expire(now_unix_ms);
        let attempted = self.attempted.get(&request_id).cloned().unwrap_or_default();
        let chosen = self
            .helpers
            .values()
            .filter(|helper| helper.available(now_unix_ms))
            .filter(|helper| helper.device_id != requester)
            .filter(|helper| !attempted.contains(&helper.device_id))
            .filter(|helper| connected(&helper.device_id))
            .min_by(|a, b| {
                a.last_matched_at_unix_ms
                    .unwrap_or(i64::MIN)
                    .cmp(&b.last_matched_at_unix_ms.unwrap_or(i64::MIN))
                    .then_with(|| a.device_id.cmp(&b.device_id))
            })
            .map(|helper| helper.device_id.clone())?;

        let record = ImageMatch::new(
            request_id,
            requester.to_string(),
            chosen.clone(),
            now_unix_ms,
        );
        if let Some(helper) = self.helpers.get_mut(&chosen) {
            helper.busy_with = Some(record.match_id);
            helper.last_matched_at_unix_ms = Some(now_unix_ms);
        }
        self.matches.insert(record.match_id, record.clone());
        Some(record)
    }

    /// Records that one candidate has been tried for one request.
    ///
    /// Called for every close that did not reach approval, not only for an
    /// explicit decline: a helper whose dialog simply timed out must not be
    /// re-offered the same request, or a single unattended machine would
    /// absorb every attempt until the requester's own deadline.
    fn mark_attempted(&mut self, request_id: RequestId, helper: &str) {
        let entry = self.attempted.entry(request_id).or_default();
        if !entry.iter().any(|tried| tried == helper) {
            entry.push(helper.to_string());
        }
    }

    /// Drops the attempt history for a request that has ended.
    ///
    /// Without this the map grows by one entry per brokered request for the
    /// life of the process, which for a long-running gateway is a slow leak of
    /// device identifiers.
    pub fn forget_request(&mut self, request_id: RequestId) {
        self.attempted.remove(&request_id);
    }

    /// `Offered` -> `Previewed`. Only the requester may seal.
    pub fn attach_preview(
        &mut self,
        match_id: MatchId,
        sender: &str,
        sealed_preview: Vec<u8>,
        now_unix_ms: i64,
    ) -> Result<ImageMatch, MatchError> {
        if sealed_preview.len() > MAX_SEALED_PREVIEW_BYTES {
            return Err(MatchError::PreviewTooLarge);
        }
        let record = self.party_match_mut(match_id, sender, now_unix_ms)?;
        if record.requester != sender {
            return Err(MatchError::NotTheRequester);
        }
        if record.state != MatchState::Offered {
            return Err(MatchError::WrongState);
        }
        record.state = MatchState::Previewed;
        record.sealed_preview = Some(sealed_preview);
        Ok(record.clone())
    }

    /// `Previewed` -> `Approved`, minting the P2P session identifier.
    ///
    /// A decision arriving in any other state is rejected: a late approval must
    /// never revive an expired or already-declined match.
    pub fn decide(
        &mut self,
        match_id: MatchId,
        sender: &str,
        accept: bool,
        now_unix_ms: i64,
    ) -> Result<ImageMatch, MatchError> {
        let record = self.party_match_mut(match_id, sender, now_unix_ms)?;
        if record.helper != sender {
            return Err(MatchError::NotTheHelper);
        }
        if record.state != MatchState::Previewed {
            return Err(MatchError::WrongState);
        }
        if !accept {
            record.state = MatchState::Closed;
            record.outcome = Some(MatchOutcome::Declined);
            let closed = record.clone();
            self.mark_attempted(closed.request_id, &closed.helper);
            self.release_helper(&closed.helper.clone(), match_id);
            self.matches.remove(&match_id);
            return Ok(closed);
        }
        record.state = MatchState::Approved;
        record.p2p_session_id = Some(SessionId::new());
        record.expires_at_unix_ms = now_unix_ms.saturating_add(APPROVED_MATCH_TTL_MS);
        Ok(record.clone())
    }

    /// `Approved` -> `Active` on the first channel bind. Idempotent afterwards.
    pub fn mark_active(&mut self, match_id: MatchId, now_unix_ms: i64) -> Result<(), MatchError> {
        let record = self
            .matches
            .get_mut(&match_id)
            .ok_or(MatchError::UnknownMatch)?;
        if record.expired_at(now_unix_ms) {
            return Err(MatchError::Expired);
        }
        match record.state {
            MatchState::Approved => {
                record.state = MatchState::Active;
                Ok(())
            }
            MatchState::Active => Ok(()),
            _ => Err(MatchError::WrongState),
        }
    }

    /// Mints the single relay fallback session.
    ///
    /// Valid from `Approved` as well as `Active`: a direct attempt can fail
    /// during offer creation, before any frame binds a channel, and that case
    /// still needs the fallback.
    pub fn grant_relay_session(
        &mut self,
        match_id: MatchId,
        sender: &str,
        now_unix_ms: i64,
    ) -> Result<SessionId, MatchError> {
        let record = self.party_match_mut(match_id, sender, now_unix_ms)?;
        if record.requester != sender {
            return Err(MatchError::NotTheRequester);
        }
        if !matches!(record.state, MatchState::Approved | MatchState::Active) {
            return Err(MatchError::WrongState);
        }
        if record.relay_session_id.is_some() {
            return Err(MatchError::RelayAlreadyGranted);
        }
        let session = SessionId::new();
        record.relay_session_id = Some(session);
        Ok(session)
    }

    /// Closes a match. Idempotent: a duplicate close is a no-op, never a
    /// reopen, and an unknown match is not an error for a best-effort cleanup
    /// frame that raced its own expiry.
    pub fn close(
        &mut self,
        match_id: MatchId,
        sender: &str,
        outcome: MatchOutcome,
    ) -> Option<ImageMatch> {
        let record = self.matches.get_mut(&match_id)?;
        if !record.is_party(sender) {
            return None;
        }
        record.state = MatchState::Closed;
        record.outcome = Some(outcome);
        let closed = record.clone();
        self.release_helper(&closed.helper.clone(), match_id);
        self.matches.remove(&match_id);
        Some(closed)
    }

    /// Whether any live match authorizes one signaling or relay operation.
    pub fn allows(
        &self,
        first: &str,
        second: &str,
        session_id: &str,
        now_unix_ms: i64,
    ) -> Option<MatchId> {
        self.matches
            .values()
            .find(|record| record.allows(first, second, session_id, now_unix_ms))
            .map(|record| record.match_id)
    }

    #[must_use]
    pub fn get(&self, match_id: MatchId) -> Option<&ImageMatch> {
        self.matches.get(&match_id)
    }

    fn party_match_mut(
        &mut self,
        match_id: MatchId,
        sender: &str,
        now_unix_ms: i64,
    ) -> Result<&mut ImageMatch, MatchError> {
        let record = self
            .matches
            .get_mut(&match_id)
            .ok_or(MatchError::UnknownMatch)?;
        if !record.is_party(sender) {
            return Err(MatchError::NotAParty);
        }
        if record.expired_at(now_unix_ms) {
            return Err(MatchError::Expired);
        }
        Ok(record)
    }

    fn release_helper(&mut self, helper: &str, match_id: MatchId) {
        if let Some(record) = self.helpers.get_mut(helper) {
            if record.busy_with == Some(match_id) {
                record.busy_with = None;
            }
        }
    }
}

/// Short, stable, non-identifying label for roster rows and lifecycle logs.
pub(crate) fn fingerprint(device_id: &str) -> String {
    device_id
        .chars()
        .filter(char::is_ascii_hexdigit)
        .take(8)
        .collect()
}

/// Parses a protocol device id, rejecting anything that is not one.
pub fn valid_device_id(value: &str) -> bool {
    value.parse::<ProtocolDeviceId>().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(seed: u8) -> String {
        ProtocolDeviceId::from_uuid(uuid::Uuid::from_bytes([seed; 16])).to_string()
    }

    /// Connection state for tests that are not about connection state.
    fn online(_device_id: &str) -> bool {
        true
    }

    fn state_with_helpers(now: i64, seeds: &[u8]) -> ImageAssistState {
        let mut state = ImageAssistState::new();
        for seed in seeds {
            state.advertise(&device(*seed), None, None, HELPER_LEASE_MS, now);
        }
        state
    }

    fn approved(now: i64) -> (ImageAssistState, ImageMatch) {
        let requester = device(1);
        let mut state = state_with_helpers(now, &[2]);
        let opened = state
            .open_match(RequestId::new(), &requester, now, &online)
            .expect("a helper is available");
        state
            .attach_preview(opened.match_id, &requester, vec![1, 2, 3], now)
            .expect("requester seals the preview");
        let record = state
            .decide(opened.match_id, &device(2), true, now)
            .expect("helper approves");
        (state, record)
    }

    #[test]
    fn no_session_identifier_exists_before_the_helper_approves() {
        let now = 1_800_000_000_000;
        let requester = device(1);
        let mut state = state_with_helpers(now, &[2]);
        let opened = state
            .open_match(RequestId::new(), &requester, now, &online)
            .expect("a helper is available");

        assert_eq!(opened.state, MatchState::Offered);
        assert!(opened.p2p_session_id.is_none());
        assert!(opened.relay_session_id.is_none());

        let previewed = state
            .attach_preview(opened.match_id, &requester, vec![9], now)
            .expect("preview attaches");
        assert_eq!(previewed.state, MatchState::Previewed);
        assert!(previewed.p2p_session_id.is_none());

        // Nothing is routable yet, for any session id the parties might name.
        assert!(state
            .allows(&requester, &device(2), &SessionId::new().to_string(), now)
            .is_none());

        let approved = state
            .decide(opened.match_id, &device(2), true, now)
            .expect("helper approves");
        assert_eq!(approved.state, MatchState::Approved);
        let session = approved.p2p_session_id.expect("session minted on approval");
        assert!(state
            .allows(&requester, &device(2), &session.to_string(), now)
            .is_some());
    }

    #[test]
    fn a_match_authorizes_only_the_session_identifiers_it_minted() {
        let now = 1_800_000_000_000;
        let (state, record) = approved(now);
        let minted = record.p2p_session_id.expect("session");

        assert!(state
            .allows(&record.requester, &record.helper, &minted.to_string(), now)
            .is_some());
        // A session id the gateway never minted for this match is not a channel
        // between these two strangers.
        assert!(state
            .allows(
                &record.requester,
                &record.helper,
                &SessionId::new().to_string(),
                now
            )
            .is_none());
    }

    #[test]
    fn an_approved_session_outlives_the_offer_deadline_but_remains_bounded() {
        let now = 1_800_000_000_000;
        let (state, record) = approved(now);
        let session = record.p2p_session_id.expect("session").to_string();

        assert!(state
            .allows(
                &record.requester,
                &record.helper,
                &session,
                now + MATCH_TTL_MS + 1,
            )
            .is_some());
        assert!(state
            .allows(
                &record.requester,
                &record.helper,
                &session,
                now + APPROVED_MATCH_TTL_MS + 1,
            )
            .is_none());
    }

    #[test]
    fn a_third_device_is_never_authorized_by_someone_elses_match() {
        let now = 1_800_000_000_000;
        let (state, record) = approved(now);
        let minted = record.p2p_session_id.expect("session").to_string();

        assert!(state
            .allows(&record.requester, &device(9), &minted, now)
            .is_none());
        assert!(state
            .allows(&device(9), &record.helper, &minted, now)
            .is_none());
    }

    #[test]
    fn a_late_decision_cannot_revive_an_expired_match() {
        let now = 1_800_000_000_000;
        let requester = device(1);
        let mut state = state_with_helpers(now, &[2]);
        let opened = state
            .open_match(RequestId::new(), &requester, now, &online)
            .expect("a helper is available");
        state
            .attach_preview(opened.match_id, &requester, vec![1], now)
            .expect("preview attaches");

        let late = now + MATCH_TTL_MS + 1;
        assert_eq!(
            state
                .decide(opened.match_id, &device(2), true, late)
                .unwrap_err(),
            MatchError::Expired
        );
    }

    #[test]
    fn a_decision_is_rejected_outside_the_previewed_state() {
        let now = 1_800_000_000_000;
        let requester = device(1);
        let mut state = state_with_helpers(now, &[2]);
        let opened = state
            .open_match(RequestId::new(), &requester, now, &online)
            .expect("a helper is available");

        // Before the preview exists there is nothing for the helper to have
        // seen, so approval is meaningless.
        assert_eq!(
            state
                .decide(opened.match_id, &device(2), true, now)
                .unwrap_err(),
            MatchError::WrongState
        );

        state
            .attach_preview(opened.match_id, &requester, vec![1], now)
            .expect("preview attaches");
        state
            .decide(opened.match_id, &device(2), true, now)
            .expect("first approval");
        assert_eq!(
            state
                .decide(opened.match_id, &device(2), true, now)
                .unwrap_err(),
            MatchError::WrongState
        );
    }

    #[test]
    fn only_the_helper_decides_and_only_the_requester_previews() {
        let now = 1_800_000_000_000;
        let requester = device(1);
        let mut state = state_with_helpers(now, &[2]);
        let opened = state
            .open_match(RequestId::new(), &requester, now, &online)
            .expect("a helper is available");

        assert_eq!(
            state
                .attach_preview(opened.match_id, &device(2), vec![1], now)
                .unwrap_err(),
            MatchError::NotTheRequester
        );
        state
            .attach_preview(opened.match_id, &requester, vec![1], now)
            .expect("requester seals");
        assert_eq!(
            state
                .decide(opened.match_id, &requester, true, now)
                .unwrap_err(),
            MatchError::NotTheHelper
        );
    }

    #[test]
    fn relay_is_granted_once_and_from_approved_as_well_as_active() {
        let now = 1_800_000_000_000;
        let (mut state, record) = approved(now);

        assert_eq!(
            state.grant_relay_session(record.match_id, &record.helper, now),
            Err(MatchError::NotTheRequester)
        );

        // A direct attempt can fail before any frame binds a channel, so the
        // fallback must be reachable straight from Approved.
        let relay = state
            .grant_relay_session(record.match_id, &record.requester, now)
            .expect("relay granted from Approved");
        assert!(state
            .allows(&record.requester, &record.helper, &relay.to_string(), now)
            .is_some());
        assert_eq!(
            state.grant_relay_session(record.match_id, &record.requester, now),
            Err(MatchError::RelayAlreadyGranted)
        );
    }

    #[test]
    fn closing_is_idempotent_and_never_reopens() {
        let now = 1_800_000_000_000;
        let (mut state, record) = approved(now);

        assert!(state
            .close(record.match_id, &record.requester, MatchOutcome::Completed)
            .is_some());
        assert!(state
            .close(record.match_id, &record.requester, MatchOutcome::Completed)
            .is_none());
        assert!(state.get(record.match_id).is_none());
    }

    #[test]
    fn a_declined_helper_is_not_offered_the_same_request_again() {
        let now = 1_800_000_000_000;
        let requester = device(1);
        let request_id = RequestId::new();
        let mut state = state_with_helpers(now, &[2, 3]);

        let first = state
            .open_match(request_id, &requester, now, &online)
            .expect("first candidate");
        state
            .attach_preview(first.match_id, &requester, vec![1], now)
            .expect("preview");
        state
            .decide(first.match_id, &first.helper, false, now)
            .expect("first declines");

        let second = state
            .open_match(request_id, &requester, now, &online)
            .expect("second candidate");
        assert_ne!(second.helper, first.helper);

        state
            .attach_preview(second.match_id, &requester, vec![1], now)
            .expect("preview");
        state
            .decide(second.match_id, &second.helper, false, now)
            .expect("second declines");

        // Pool exhausted rather than re-offering to someone who said no.
        assert!(state.open_match(request_id, &requester, now, &online).is_none());
    }

    #[test]
    fn a_helper_that_never_answered_is_not_offered_the_same_request_again() {
        // An unattended machine is the common case, not the exception: without
        // recording a timeout as an attempt, one idle helper would absorb every
        // advance until the requester's own deadline.
        let now = 1_800_000_000_000;
        let requester = device(1);
        let request_id = RequestId::new();
        let mut state = state_with_helpers(now, &[2, 3]);

        let first = state
            .open_match(request_id, &requester, now, &online)
            .expect("first candidate");
        let later = now + MATCH_TTL_MS + 1;
        state.advertise(&device(2), None, None, HELPER_LEASE_MS * 10, later);
        state.advertise(&device(3), None, None, HELPER_LEASE_MS * 10, later);

        let second = state
            .rematch(request_id, &requester, later, &online)
            .expect("second candidate");
        assert_ne!(
            second.helper, first.helper,
            "a helper that let the dialog time out must not be asked again"
        );
        assert!(
            state.rematch(request_id, &requester, later, &online).is_none(),
            "both candidates have now been tried"
        );
    }

    #[test]
    fn advancing_a_request_does_not_spend_the_budget_again() {
        // The requester asked once. Charging every candidate would let a few
        // unattended helpers burn an hour of someone else's budget.
        let now = 1_800_000_000_000;
        let requester = device(1);
        let request_id = RequestId::new();
        let mut state = state_with_helpers(now, &[2, 3]);

        state
            .open_match(request_id, &requester, now, &online)
            .expect("first candidate");
        for _ in 0..REQUESTER_HOURLY_LIMIT * 2 {
            state.rematch(request_id, &requester, now, &online);
        }
        assert!(
            state.rate_limit_allows(&requester, now),
            "advancing one request must not consume the rolling budget"
        );
    }

    #[test]
    fn a_finished_request_drops_its_attempt_history() {
        // One entry per request would otherwise accumulate device identifiers
        // for the life of the gateway process.
        let now = 1_800_000_000_000;
        let requester = device(1);
        let request_id = RequestId::new();
        let mut state = state_with_helpers(now, &[2, 3]);

        let first = state
            .open_match(request_id, &requester, now, &online)
            .expect("first candidate");
        state
            .attach_preview(first.match_id, &requester, vec![1], now)
            .expect("preview");
        state
            .decide(first.match_id, &first.helper, false, now)
            .expect("declines");
        assert!(state.attempted.contains_key(&request_id));

        state.forget_request(request_id);
        assert!(state.attempted.is_empty());
    }

    #[test]
    fn the_roster_lists_the_viewer_but_the_matcher_still_excludes_it() {
        let now = 1_800_000_000_000;
        let mut state = state_with_helpers(now, &[2, 3]);

        let seen_by_two = state.roster(&device(2), now, &online);
        assert_eq!(seen_by_two.len(), 2);
        assert!(seen_by_two
            .iter()
            .any(|entry| entry.fingerprint == fingerprint(&device(2))));

        let match_record = state
            .open_match(RequestId::new(), &device(2), now, &online)
            .expect("the other helper can be selected");
        assert_eq!(match_record.helper, device(3));

        let seen_by_outsider = state.roster(&device(1), now, &online);
        assert_eq!(seen_by_outsider.len(), 2);
    }

    #[test]
    fn a_metadata_free_renewal_preserves_profile_and_recovers_anonymous_presence() {
        let now = 1_800_000_000_000;
        let helper = device(2);
        let viewer = device(1);
        let location = ImageAssistLocation {
            label: "Mexico City".to_string(),
            latitude: 19.4,
            longitude: -99.1,
        };
        let mut state = ImageAssistState::new();
        state.advertise(
            &helper,
            Some("lab workstation".to_string()),
            Some(location.clone()),
            HELPER_LEASE_MS,
            now,
        );
        state.renew(&helper, HELPER_LEASE_MS, now + 30_000);
        let roster = state.roster(&viewer, now + HELPER_LEASE_MS, &online);
        assert_eq!(roster.len(), 1);
        assert_eq!(roster[0].display_name.as_deref(), Some("lab workstation"));
        assert_eq!(roster[0].location.as_ref(), Some(&location));

        let recovered = device(3);
        state.renew(&recovered, HELPER_LEASE_MS, now);
        let recovered = state
            .roster(&viewer, now, &online)
            .into_iter()
            .find(|entry| entry.fingerprint == fingerprint(&recovered))
            .expect("renewal recreates anonymous process-local presence");
        assert!(recovered.display_name.is_none());
        assert!(recovered.location.is_none());
    }

    #[test]
    fn selection_is_least_recently_matched_not_arbitrary() {
        let now = 1_800_000_000_000;
        let requester = device(1);
        let mut state = state_with_helpers(now, &[2, 3]);

        let first = state
            .open_match(RequestId::new(), &requester, now, &online)
            .expect("first pick");
        state
            .close(first.match_id, &requester, MatchOutcome::Completed)
            .expect("close");

        let second = state
            .open_match(RequestId::new(), &requester, now + 1, &online)
            .expect("second pick");
        assert_ne!(
            second.helper, first.helper,
            "a helper that just served must not be picked again while another idles"
        );
    }

    #[test]
    fn a_requester_is_never_matched_to_its_own_device() {
        let now = 1_800_000_000_000;
        let requester = device(2);
        let mut state = state_with_helpers(now, &[2]);
        assert!(state
            .open_match(RequestId::new(), &requester, now, &online)
            .is_none());
    }

    #[test]
    fn an_expired_helper_lease_closes_its_match_and_stops_matching() {
        let now = 1_800_000_000_000;
        let (mut state, record) = approved(now);
        let later = now + HELPER_LEASE_MS + 1;

        let closed = state.expire(later);
        assert!(closed.iter().any(|entry| entry.match_id == record.match_id));
        assert!(state
            .allows(
                &record.requester,
                &record.helper,
                &record.p2p_session_id.expect("session").to_string(),
                later
            )
            .is_none());
        assert!(state.roster(&device(1), later, &online).is_empty());
    }

    #[test]
    fn the_roster_is_anonymous_unless_a_helper_opts_in() {
        let now = 1_800_000_000_000;
        let mut state = ImageAssistState::new();
        state.advertise(&device(2), None, None, HELPER_LEASE_MS, now);
        state.advertise(
            &device(3),
            Some("lab workstation".to_string()),
            None,
            HELPER_LEASE_MS,
            now,
        );

        let roster = state.roster(&device(1), now, &online);
        assert_eq!(roster.len(), 2);
        let anonymous = roster
            .iter()
            .find(|entry| entry.display_name.is_none())
            .expect("an anonymous helper");
        assert_eq!(anonymous.fingerprint.len(), 8);
        assert!(!anonymous.fingerprint.contains('-'));
        assert!(roster
            .iter()
            .any(|entry| entry.display_name.as_deref() == Some("lab workstation")));
    }

    #[test]
    fn a_requester_may_only_have_one_match_in_flight() {
        let now = 1_800_000_000_000;
        let requester = device(1);
        let mut state = state_with_helpers(now, &[2, 3]);

        let opened = state
            .open_match(RequestId::new(), &requester, now, &online)
            .expect("first match");
        assert!(state.has_active_request(&requester));
        state
            .close(opened.match_id, &requester, MatchOutcome::Completed)
            .expect("close");
        assert!(!state.has_active_request(&requester));
    }

    #[test]
    fn the_requester_budget_counts_real_requests_and_rolls() {
        let now = 1_800_000_000_000;
        let requester = device(1);
        let mut state = state_with_helpers(now, &[2, 3]);

        // Driven entirely through the public path, so the budget is spent by
        // the same call the gateway makes rather than by a test shortcut.
        for index in 0..REQUESTER_HOURLY_LIMIT {
            let at = now + i64::from(index);
            assert!(
                state.rate_limit_allows(&requester, at),
                "request {index} must be inside the budget"
            );
            let opened = state
                .open_match(RequestId::new(), &requester, at, &online)
                .expect("a helper is available");
            state
                .close(opened.match_id, &requester, MatchOutcome::Completed)
                .expect("close");
        }
        assert!(!state.rate_limit_allows(&requester, now + 1_000));
        // The window rolls rather than latching.
        assert!(state.rate_limit_allows(&requester, now + REQUESTER_RATE_WINDOW_MS + 1));
    }

    #[test]
    fn a_helper_with_no_live_connection_is_never_matched_or_listed() {
        // A lease outlives the app that took it by up to a minute, and every
        // frame addressed to a disconnected device is dropped silently, so
        // matching on the lease alone spends the whole match TTL waiting for a
        // dialog nobody can see.
        let now = 1_800_000_000_000;
        let requester = device(1);
        let mut state = state_with_helpers(now, &[2]);
        let gone = device(2);
        let nobody_connected = |_: &str| false;

        assert!(state
            .open_match(RequestId::new(), &requester, now, &nobody_connected)
            .is_none());
        let roster = state.roster(&requester, now, &nobody_connected);
        assert_eq!(roster.len(), 1);
        assert!(
            !roster[0].available,
            "a helper the matcher would skip must not be shown as available"
        );
        assert_eq!(roster[0].fingerprint, fingerprint(&gone));
    }

    #[test]
    fn a_disconnected_device_loses_its_lease_and_every_match_it_is_in() {
        let now = 1_800_000_000_000;
        let (mut state, record) = approved(now);

        let closed = state.disconnect(&record.helper);
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].match_id, record.match_id);
        assert_eq!(closed[0].outcome, Some(MatchOutcome::HelperLost));
        // Nothing the vanished helper held survives: no lease, no reservation,
        // and no session the transport paths would still authorize.
        assert!(state.roster(&device(1), now, &online).is_empty());
        assert!(state
            .allows(
                &record.requester,
                &record.helper,
                &record.p2p_session_id.expect("session").to_string(),
                now
            )
            .is_none());
        assert!(!state.has_active_request(&record.requester));
    }

    #[test]
    fn a_disconnected_requester_frees_the_helper_it_was_holding() {
        // Otherwise a requester that closed its app keeps a helper reserved for
        // the whole approved TTL, and that helper is invisible to everyone else
        // for fifteen minutes.
        let now = 1_800_000_000_000;
        let (mut state, record) = approved(now);

        let closed = state.disconnect(&record.requester);
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].outcome, Some(MatchOutcome::Cancelled));

        let other = device(7);
        state.advertise(&record.helper, None, None, HELPER_LEASE_MS, now);
        assert!(state
            .open_match(RequestId::new(), &other, now, &online)
            .is_some());
    }

    #[test]
    fn an_oversized_sealed_preview_is_refused() {
        let now = 1_800_000_000_000;
        let requester = device(1);
        let mut state = state_with_helpers(now, &[2]);
        let opened = state
            .open_match(RequestId::new(), &requester, now, &online)
            .expect("a helper is available");

        assert_eq!(
            state
                .attach_preview(
                    opened.match_id,
                    &requester,
                    vec![0; MAX_SEALED_PREVIEW_BYTES + 1],
                    now
                )
                .unwrap_err(),
            MatchError::PreviewTooLarge
        );
    }
}
