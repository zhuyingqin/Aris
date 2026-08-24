import { useCallback, useEffect, useRef, useState } from "react";

import {
  isTauri,
  remoteControlApprovePairing,
  remoteControlCreateInvitation,
  remoteControlDiscardPairing,
  remoteControlPendingPairing,
} from "../api/tauri";
import type {
  RemoteInvitationResult,
  RemotePairingInvitation,
  RemotePendingPairing,
} from "../types";

/**
 * Phones and computers pair through the same four gateway commands, so the
 * ceremony lives here once instead of being reimplemented per surface. Before
 * this, the computer tab polled for a claim automatically while the phone tab
 * only had a manual "check for a request" button — the same protocol with a
 * worse experience on one side purely because it was written twice.
 */
const PAIRING_POLL_INTERVAL_MS = 1_250;

/** Gateway wording for an invitation that is no longer actionable. */
const INVITATION_GONE_PATTERN = /expired|no longer available/i;

export interface PairingCeremonyCallbacks {
  /** A peer submitted a claim and is now waiting for this desktop's approval. */
  onClaimArrived?: () => void;
  /** The invitation timed out before anyone claimed it. */
  onInvitationExpired?: () => void;
  onError: (error: unknown) => void;
}

export interface PairingCeremony {
  invitation: RemotePairingInvitation | null;
  pendingApproval: RemotePendingPairing | null;
  busy: boolean;
  /** Mints a one-time invitation. Rethrows so callers keep their own handling. */
  start: () => Promise<RemoteInvitationResult>;
  /** Grants the waiting claim. Resolves false when the gateway refused. */
  approve: () => Promise<boolean>;
  /** Refuses the waiting claim, or discards an unclaimed invitation. */
  decline: () => Promise<boolean>;
  /** Adopts an invitation produced elsewhere, such as a non-Tauri preview. */
  adopt: (invitation: RemotePairingInvitation | null) => void;
  reset: () => void;
}

export function usePairingCeremony(callbacks: PairingCeremonyCallbacks): PairingCeremony {
  const [invitation, setInvitation] = useState<RemotePairingInvitation | null>(null);
  const [pendingApproval, setPendingApproval] = useState<RemotePendingPairing | null>(null);
  const [busy, setBusy] = useState(false);

  // Callbacks are re-created on every render of the consuming component. Keep
  // them in a ref so the poll below restarts only when the pairing itself
  // changes, not on every keystroke elsewhere in the settings page.
  const handlers = useRef(callbacks);
  handlers.current = callbacks;

  // `start` must see the invitation it is replacing without taking it as a
  // dependency, which would hand every caller a new function each time a code
  // is minted.
  const supersededRef = useRef<RemotePairingInvitation | null>(null);
  supersededRef.current = invitation;

  useEffect(() => {
    if (!invitation || pendingApproval || !isTauri()) return;
    let disposed = false;
    let timer: number | null = null;
    const { pairingId, expiresAt } = invitation;

    const poll = async () => {
      try {
        const pending = await remoteControlPendingPairing(pairingId);
        if (disposed) return;
        if (pending) {
          setPendingApproval(pending);
          handlers.current.onClaimArrived?.();
          return;
        }
        if (Date.now() >= expiresAt) {
          setInvitation(null);
          handlers.current.onInvitationExpired?.();
          return;
        }
      } catch (error) {
        if (disposed) return;
        // An invitation the gateway has already dropped cannot be recovered by
        // polling harder; anything else may be a transient network blip.
        if (INVITATION_GONE_PATTERN.test(String(error))) {
          setInvitation(null);
          handlers.current.onError(error);
          return;
        }
      }
      timer = window.setTimeout(() => void poll(), PAIRING_POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [invitation, pendingApproval]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      // Retire the code being replaced. The desktop caps concurrent pending
      // pairings at a small number and an abandoned invitation holds its slot
      // for its full five-minute TTL, so a handful of "regenerate" clicks
      // would otherwise lock the user out with "too many pending pairings".
      const superseded = supersededRef.current?.pairingId;
      if (superseded) {
        try {
          await remoteControlDiscardPairing(superseded);
        } catch {
          // The gateway may have expired it already; minting the next one is
          // what matters and must not be blocked by the cleanup.
        }
      }
      const result = await remoteControlCreateInvitation();
      setInvitation(result.pairing);
      setPendingApproval(null);
      return result;
    } finally {
      setBusy(false);
    }
  }, []);

  const approve = useCallback(async () => {
    if (!pendingApproval) return false;
    setBusy(true);
    try {
      await remoteControlApprovePairing({ pairingId: pendingApproval.pairingId });
      setPendingApproval(null);
      setInvitation(null);
      return true;
    } catch (error) {
      handlers.current.onError(error);
      return false;
    } finally {
      setBusy(false);
    }
  }, [pendingApproval]);

  const decline = useCallback(async () => {
    const pairingId = pendingApproval?.pairingId ?? invitation?.pairingId;
    if (!pairingId) return false;
    setBusy(true);
    try {
      await remoteControlDiscardPairing(pairingId);
      setPendingApproval(null);
      setInvitation(null);
      return true;
    } catch (error) {
      handlers.current.onError(error);
      return false;
    } finally {
      setBusy(false);
    }
  }, [invitation, pendingApproval]);

  const adopt = useCallback((next: RemotePairingInvitation | null) => {
    setInvitation(next);
    setPendingApproval(null);
  }, []);

  const reset = useCallback(() => {
    setInvitation(null);
    setPendingApproval(null);
  }, []);

  return { invitation, pendingApproval, busy, start, approve, decline, adopt, reset };
}
