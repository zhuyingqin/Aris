import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  computePairingClaim,
  computePairingComplete,
  isTauri,
} from "../api/tauri";
import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import type { ComputePairingClaim } from "../types";
import { SETTINGS_COPY } from "./i18n";

interface JoinDeviceFormProps {
  language: Language;
  onError?: (message: string) => void;
  onMessage: (message: string) => void;
  onDevicesChanged: () => void | Promise<void>;
}

const PAIRING_POLL_INTERVAL_MS = 1_250;
const PAIRING_FIELD_MIN_HEIGHT = 64;

function fitPairingField(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = Math.max(PAIRING_FIELD_MIN_HEIGHT, element.scrollHeight) + "px";
}

function useAutoSizePairingField(value: string) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    fitPairingField(fieldRef.current);
  }, [value]);

  useEffect(() => {
    const resize = () => fitPairingField(fieldRef.current);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  return fieldRef;
}

export default function JoinDeviceForm({
  language,
  onError,
  onMessage,
  onDevicesChanged,
}: JoinDeviceFormProps) {
  const copy = SETTINGS_COPY[language].remote;
  const [pairingLink, setPairingLink] = useState("");
  const [claimBusy, setClaimBusy] = useState(false);
  const [incomingClaim, setIncomingClaim] = useState<ComputePairingClaim | null>(null);
  const pairingFieldRef = useAutoSizePairingField(pairingLink);

  const reportError = useCallback((reason: unknown) => {
    const detail = String(reason);
    onMessage(detail);
    onError?.(detail);
  }, [onError, onMessage]);

  useEffect(() => {
    if (!incomingClaim || incomingClaim.status !== "awaiting_approval" || !isTauri()) return;
    let disposed = false;
    let timer: number | null = null;
    const pairingId = incomingClaim.pairingId;
    const expiresAt = incomingClaim.completionExpiresAtUnixMs;

    const poll = async () => {
      try {
        const claim = await computePairingComplete(pairingId);
        if (disposed) return;
        if (claim.status === "completed") {
          await onDevicesChanged();
          if (disposed) return;
          setIncomingClaim(null);
          setPairingLink("");
          onMessage(copy.connectionCompleted);
          return;
        }
        if (Date.now() >= expiresAt) {
          setIncomingClaim(null);
          onMessage(copy.joinApprovalExpired);
          return;
        }
      } catch (error) {
        if (disposed) return;
        const detail = String(error);
        if (/expired|no longer pending|rejected/i.test(detail)) {
          setIncomingClaim(null);
          reportError(error);
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
  }, [copy.connectionCompleted, copy.joinApprovalExpired, incomingClaim, onDevicesChanged, onMessage, reportError]);

  const claimInvitation = async () => {
    if (!pairingLink.trim()) return;
    setClaimBusy(true);
    onMessage("");
    try {
      if (!isTauri()) {
        onMessage(copy.joinPreviewOnly);
        return;
      }
      const claim = await computePairingClaim(pairingLink.trim());
      setIncomingClaim(claim);
      onMessage(copy.joinRequestSent);
    } catch (error) {
      reportError(error);
    } finally {
      setClaimBusy(false);
    }
  };

  return (
    <div className="sp-remote-join-card">
      <div className="sp-remote-join-head">
        <span className="sp-remote-join-icon"><SvgIcon name="send" size={16} /></span>
        <div>
          <strong>{copy.joinDeviceTitle}</strong>
          <p>{copy.joinDeviceDescription}</p>
        </div>
      </div>
      <div className="sp-remote-join-entry">
        <textarea
          ref={pairingFieldRef}
          className="sp-remote-pairing-textarea"
          aria-label={copy.pasteConnectionCodeHere}
          rows={2}
          value={pairingLink}
          placeholder={copy.pasteConnectionCodeHere}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setPairingLink(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !claimBusy && pairingLink.trim()) {
              event.preventDefault();
              void claimInvitation();
            }
          }}
        />
        <button
          className="sp-btn sp-btn-primary sp-remote-device-action"
          type="button"
          disabled={claimBusy || !pairingLink.trim()}
          onClick={() => void claimInvitation()}
        >
          <SvgIcon name={claimBusy ? "spinner" : "send"} size={14} />
          {copy.claimInvitation}
        </button>
      </div>
      {incomingClaim && (
        <div className="sp-remote-join-wait" role="status">
          <span aria-hidden="true" />
          {copy.waitingForApprovalThenAuto}
        </div>
      )}
    </div>
  );
}
