import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  computeCapabilities,
  computeNodeConfigGet,
  computeNodeConfigSet,
  computePeerConnect,
  computePairingClaim,
  computePairingComplete,
  computePeerRevoke,
  computePeersList,
  isTauri,
  onComputePeerEvent,
  remoteControlApprovePairing,
  remoteControlConnectPhone,
  remoteControlDiscardPairing,
  remoteControlPendingPairing,
  remoteControlRevokeDevice,
} from "../api/tauri";
import type { Language } from "../store";
import { epochToDate } from "../timestamp";
import { SvgIcon } from "../SvgIcon";
import { SETTINGS_COPY, type SettingsComputeNodeCopy } from "./i18n";
import type {
  ComputeNodeCapabilities,
  ComputeNodeConfig,
  ComputePairingClaim,
  ComputePeer,
  RemotePairingInvitation,
  RemotePendingPairing,
} from "../types";

interface ComputeNodeSettingsProps {
  language: Language;
  onError?: (message: string) => void;
}

const PREVIEW_CONFIG: ComputeNodeConfig = {
  nodeId: "preview-compute-node",
  displayName: "SomniQ computer",
  acceptRemoteJobs: false,
  acceptRemoteAgentChats: false,
  maxParallelJobs: 2,
};

const PAIRING_POLL_INTERVAL_MS = 1_250;
const PAIRING_FIELD_MIN_HEIGHT = 64;

function fitPairingField(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.max(PAIRING_FIELD_MIN_HEIGHT, element.scrollHeight)}px`;
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

function transportLabel(transport: string | null | undefined, copy: SettingsComputeNodeCopy): string {
  if (transport === "p2p_webrtc" || transport === "p2p") return "WebRTC P2P";
  if (transport === "tcp_relay") return copy.transportRelay;
  if (transport === "p2p_tcp") return copy.transportLan;
  return transport ?? copy.transportSecureFallback;
}

function formatPeerTimestamp(value: number | null | undefined, language: Language, copy: SettingsComputeNodeCopy): string {
  if (!value) return copy.peerNeverConnected;
  const date = epochToDate(value);
  if (!date) return copy.peerTimestampUnknown;
  return date.toLocaleString(language === "cn" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ComputeNodeSettings({ language, onError }: ComputeNodeSettingsProps) {
  const copy = SETTINGS_COPY[language].computeNode;
  const [config, setConfig] = useState<ComputeNodeConfig | null>(() => isTauri() ? null : PREVIEW_CONFIG);
  const [capabilities, setCapabilities] = useState<ComputeNodeCapabilities | null>(null);
  const [peers, setPeers] = useState<ComputePeer[]>([]);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [connectingNodeId, setConnectingNodeId] = useState<string | null>(null);
  const [revokingNodeId, setRevokingNodeId] = useState<string | null>(null);
  const [peerMenuNodeId, setPeerMenuNodeId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [pairingLink, setPairingLink] = useState("");
  const [outgoingInvitation, setOutgoingInvitation] = useState<RemotePairingInvitation | null>(null);
  const [incomingClaim, setIncomingClaim] = useState<ComputePairingClaim | null>(null);
  const [pendingApproval, setPendingApproval] = useState<RemotePendingPairing | null>(null);
  const outgoingPairingLink = outgoingInvitation?.pairingLink ?? "";
  const outgoingPairingFieldRef = useAutoSizePairingField(outgoingPairingLink);
  const incomingPairingFieldRef = useAutoSizePairingField(pairingLink);
  const approvalButtonRef = useRef<HTMLButtonElement | null>(null);
  const peerMenuRef = useRef<HTMLDivElement | null>(null);
  const latestConfigRef = useRef<ComputeNodeConfig | null>(config);
  const configWriteChainRef = useRef<Promise<void>>(Promise.resolve());

  const reportError = useCallback((reason: unknown) => {
    const detail = String(reason);
    setMessage(detail);
    onError?.(detail);
  }, [onError]);

  const refreshPeers = useCallback(async () => {
    if (!isTauri()) return;
    setPeers(await computePeersList());
  }, []);

  const updateConfigDraft = (patch: Partial<ComputeNodeConfig>) => {
    setConfig((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      latestConfigRef.current = next;
      return next;
    });
  };

  const persistConfig = useCallback((next: ComputeNodeConfig) => {
    latestConfigRef.current = next;
    setConfig(next);
    if (!isTauri()) return;
    configWriteChainRef.current = configWriteChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const saved = await computeNodeConfigSet(
          next.displayName,
          next.acceptRemoteJobs,
          next.acceptRemoteAgentChats,
          next.maxParallelJobs,
        );
        const latest = latestConfigRef.current;
        if (
          latest?.displayName === next.displayName
          && latest.acceptRemoteJobs === next.acceptRemoteJobs
          && latest.acceptRemoteAgentChats === next.acceptRemoteAgentChats
          && latest.maxParallelJobs === next.maxParallelJobs
        ) {
          latestConfigRef.current = saved;
          setConfig(saved);
        }
      })
      .catch(reportError);
  }, [reportError]);

  useEffect(() => {
    if (!isTauri()) return;
    void Promise.all([computeNodeConfigGet(), computeCapabilities(), computePeersList()])
      .then(([nextConfig, nextCapabilities, nextPeers]) => {
        latestConfigRef.current = nextConfig;
        setConfig(nextConfig);
        setCapabilities(nextCapabilities);
        setPeers(nextPeers);
      })
      .catch(reportError);
  }, [reportError]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onComputePeerEvent(() => {
      if (!disposed) void refreshPeers().catch(reportError);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshPeers, reportError]);

  useEffect(() => {
    if (!outgoingInvitation || pendingApproval || !isTauri()) return;
    let disposed = false;
    let timer: number | null = null;
    const pairingId = outgoingInvitation.pairingId;
    const expiresAt = outgoingInvitation.expiresAt;

    const poll = async () => {
      try {
        const pending = await remoteControlPendingPairing(pairingId);
        if (disposed) return;
        if (pending) {
          setPendingApproval(pending);
          setMessage(copy.pairingRequestArrived);
          return;
        }
        if (Date.now() >= expiresAt) {
          setOutgoingInvitation(null);
          setMessage(copy.connectionCodeExpired);
          return;
        }
      } catch (error) {
        if (disposed) return;
        const detail = String(error);
        if (/expired|no longer available/i.test(detail)) {
          setOutgoingInvitation(null);
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
  }, [copy, outgoingInvitation, pendingApproval, reportError]);

  useEffect(() => {
    if (!pendingApproval) return;
    const frame = window.requestAnimationFrame(() => approvalButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [pendingApproval]);

  useEffect(() => {
    if (!peerMenuNodeId) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!peerMenuRef.current?.contains(event.target as Node)) setPeerMenuNodeId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPeerMenuNodeId(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [peerMenuNodeId]);

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
          setIncomingClaim(null);
          setPairingLink("");
          setMessage(copy.computerPairingCompleted);
          await refreshPeers();
          return;
        }
        if (Date.now() >= expiresAt) {
          setIncomingClaim(null);
          setMessage(copy.pairingApprovalExpired);
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
  }, [copy, incomingClaim, refreshPeers, reportError]);

  const createInvitation = async () => {
    setPairingBusy(true);
    setMessage("");
    try {
      if (!isTauri()) {
        setMessage(copy.previewNoRealInvitation);
        return;
      }
      const result = await remoteControlConnectPhone();
      setOutgoingInvitation(result.pairing);
      setPendingApproval(null);
      setMessage(copy.invitationCreatedMessage);
    } catch (error) {
      reportError(error);
    } finally {
      setPairingBusy(false);
    }
  };

  const copyConnectionCode = async () => {
    const code = outgoingInvitation?.pairingLink?.trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setMessage(copy.connectionCodeCopied);
    } catch (error) {
      reportError(error);
    }
  };

  const approveIncomingComputer = async () => {
    if (!pendingApproval || !isTauri()) return;
    setPairingBusy(true);
    setMessage("");
    try {
      await remoteControlApprovePairing({ pairingId: pendingApproval.pairingId });
      setPendingApproval(null);
      setOutgoingInvitation(null);
      setPairingLink("");
      setMessage(copy.connectionAllowedMessage);
      await refreshPeers();
    } catch (error) {
      reportError(error);
    } finally {
      setPairingBusy(false);
    }
  };

  const rejectIncomingComputer = async () => {
    if (!pendingApproval || !isTauri()) return;
    setPairingBusy(true);
    setMessage("");
    try {
      await remoteControlDiscardPairing(pendingApproval.pairingId);
      setPendingApproval(null);
      setOutgoingInvitation(null);
      setMessage(copy.connectionDeclinedMessage);
    } catch (error) {
      reportError(error);
    } finally {
      setPairingBusy(false);
    }
  };

  const claimInvitation = async () => {
    if (!pairingLink.trim()) return;
    setPairingBusy(true);
    setMessage("");
    try {
      if (!isTauri()) {
        setMessage(copy.previewNoRealClaim);
        return;
      }
      const claim = await computePairingClaim(pairingLink.trim());
      setIncomingClaim(claim);
      setMessage(copy.claimSentMessage);
    } catch (error) {
      reportError(error);
    } finally {
      setPairingBusy(false);
    }
  };

  const revokePeer = async (peer: ComputePeer) => {
    if (!isTauri()) return;
    setRevokingNodeId(peer.nodeId);
    setMessage("");
    try {
      if (peer.direction === "claimed") {
        await computePeerRevoke(peer.nodeId);
      } else {
        await remoteControlRevokeDevice(peer.nodeId);
      }
      await refreshPeers();
      setMessage(copy.pairingRevokedMessage);
    } catch (error) {
      reportError(error);
    } finally {
      setRevokingNodeId(null);
    }
  };

  const connectPeer = async (peer: ComputePeer) => {
    if (!isTauri() || peer.connected || peer.direction !== "claimed") return;
    setConnectingNodeId(peer.nodeId);
    setMessage("");
    try {
      await computePeerConnect(peer.nodeId);
      setMessage(copy.establishingConnection);
    } catch (error) {
      reportError(error);
    } finally {
      setConnectingNodeId(null);
    }
  };

  if (!config) {
    return <div className="sp-remote-empty">{copy.loadingComputeNode}</div>;
  }

  return (
    <section className="sp-compute-node-settings" aria-labelledby="compute-node-settings-title">
      <div className="sp-section-head">
        <div className="sp-section-head-text">
          <div className="sp-section-title" id="compute-node-settings-title">
            {copy.title}
          </div>
          <div className="sp-section-sub">
            {copy.subtitle}
          </div>
        </div>
        <span className={`sp-compute-node-badge${config.acceptRemoteJobs ? " enabled" : ""}`}>
          {config.acceptRemoteJobs ? copy.badgeAccepting : copy.badgeLocalOnly}
        </span>
      </div>

      {message && <span className="sp-remote-message" role="status">{message}</span>}

      <div className="sp-compute-node-grid">
        <div className="sp-compute-node-card">
          <span className="sp-compute-node-card-label">{copy.nodeNameLabel}</span>
          <input
            className="sp-compute-node-name-input"
            aria-label={copy.nodeNameLabel}
            value={config.displayName}
            maxLength={128}
            onChange={(event) => updateConfigDraft({ displayName: event.target.value })}
            onBlur={() => persistConfig(config)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span className="sp-compute-node-id">
            <code>{config.nodeId}</code>
            <button
              type="button"
              title={copy.copyNodeId}
              aria-label={copy.copyNodeId}
              onClick={() => {
                void navigator.clipboard.writeText(config.nodeId)
                  .then(() => setMessage(copy.nodeIdCopied))
                  .catch(reportError);
              }}
            >
              <SvgIcon name="copy" size={12} />
            </button>
          </span>
        </div>
        <div className="sp-compute-node-card sp-compute-node-capacity-card">
          <label>
            <span className="sp-compute-node-card-label">{copy.maxParallelJobsLabel}</span>
            <input
              className="sp-compute-parallel-input"
              aria-label={copy.maxParallelJobsLabel}
              type="number"
              min={1}
              max={64}
              value={config.maxParallelJobs}
              onChange={(event) => updateConfigDraft({
                maxParallelJobs: Math.max(1, Math.min(64, Number(event.target.value) || 1)),
              })}
              onBlur={() => persistConfig(config)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
          <small>
            {capabilities
              ? `${capabilities.logicalCpus} CPU · ${capabilities.platform} ${capabilities.architecture}`
              : copy.detectingCapabilities}
          </small>
          <SvgIcon name="edit" size={14} className="sp-compute-card-edit" />
        </div>
      </div>

      <label className="sp-compute-node-toggle">
        <span className="sp-compute-toggle-icon"><SvgIcon name="shieldCheck" size={18} /></span>
        <span className="sp-compute-toggle-copy">
          <strong>{copy.acceptRemoteJobsTitle}</strong>
          <small>
            {copy.acceptRemoteJobsDesc}
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={config.acceptRemoteJobs}
          onChange={(event) => persistConfig({ ...config, acceptRemoteJobs: event.target.checked })}
        />
      </label>

      <label className="sp-compute-node-toggle">
        <span className="sp-compute-toggle-icon"><SvgIcon name="user" size={18} /></span>
        <span className="sp-compute-toggle-copy">
          <strong>
            {copy.acceptRemoteAgentChatsTitle}
          </strong>
          <small>
            {copy.acceptRemoteAgentChatsDesc}
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={config.acceptRemoteAgentChats}
          onChange={(event) => persistConfig({
            ...config,
            acceptRemoteAgentChats: event.target.checked,
          })}
        />
      </label>

      <div className="sp-compute-pairing">
        <div className="sp-remote-devices-head">
          <div>
            <div className="sp-section-title">{copy.pairComputersTitle}</div>
            <div className="sp-section-sub">
              {copy.pairComputersDesc}
            </div>
          </div>
        </div>

        <div className="sp-compute-pairing-grid">
          <div className="sp-compute-pairing-card">
            <div className="sp-compute-pairing-step-head">
              <span className="sp-compute-pairing-step-icon"><SvgIcon name="plus" size={16} /></span>
              <div>
                <strong>{copy.inviteFromThisComputer}</strong>
                <p>{copy.inviteFromThisComputerDesc}</p>
              </div>
            </div>
            {!outgoingInvitation ? (
              <button className="sp-btn sp-btn-primary" type="button" disabled={pairingBusy} onClick={() => void createInvitation()}>
                <SvgIcon name={pairingBusy ? "spinner" : "plus"} size={13} />
                {copy.createConnectionCode}
              </button>
            ) : (
              <>
                <div className="sp-compute-pairing-code">
                  <SvgIcon name="copy" size={14} />
                  <textarea
                    ref={outgoingPairingFieldRef}
                    className="sp-compute-pairing-textarea"
                    aria-label={copy.oneTimeConnectionCode}
                    readOnly
                    rows={2}
                    value={outgoingPairingLink}
                    title={outgoingPairingLink}
                  />
                  <button type="button" onClick={() => void copyConnectionCode()}>
                    <SvgIcon name="copy" size={13} />
                    {copy.copyCode}
                  </button>
                </div>
                <div className="sp-compute-pairing-foot">
                  <div className="sp-compute-pairing-wait" role="status">
                    <span aria-hidden="true" />
                    {copy.waitingForOtherComputer}
                  </div>
                  <button
                    className="sp-compute-pairing-regenerate"
                    type="button"
                    disabled={pairingBusy}
                    onClick={() => void createInvitation()}
                  >
                    <SvgIcon name={pairingBusy ? "spinner" : "refresh"} size={12} />
                    {copy.regenerate}
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="sp-compute-pairing-card">
            <div className="sp-compute-pairing-step-head">
              <span className="sp-compute-pairing-step-icon"><SvgIcon name="send" size={16} /></span>
              <div>
                <strong>{copy.joinAnotherComputer}</strong>
                <p>{copy.joinAnotherComputerDesc}</p>
              </div>
            </div>
            <div className="sp-compute-pairing-entry">
              <textarea
                ref={incomingPairingFieldRef}
                className="sp-compute-pairing-textarea"
                rows={2}
                value={pairingLink}
                placeholder={copy.pasteConnectionCodeHere}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setPairingLink(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !pairingBusy && pairingLink.trim()) {
                    event.preventDefault();
                    void claimInvitation();
                  }
                }}
              />
              <button className="sp-btn sp-btn-primary" type="button" disabled={pairingBusy || !pairingLink.trim()} onClick={() => void claimInvitation()}>
                <SvgIcon name={pairingBusy ? "spinner" : "send"} size={13} />
                {copy.claimInvitation}
              </button>
            </div>
            {incomingClaim && (
              <div className="sp-compute-pairing-wait" role="status">
                <span aria-hidden="true" />
                {copy.waitingForApprovalThenAuto}
              </div>
            )}
          </div>
        </div>
      </div>

      {pendingApproval && (
        <div className="sp-compute-approval-backdrop" role="presentation">
          <section
            className="sp-compute-approval-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="compute-approval-title"
            aria-describedby="compute-approval-description"
          >
            <div className="sp-compute-approval-icon"><SvgIcon name="helpCircle" size={22} /></div>
            <div>
              <h3 id="compute-approval-title">
                {copy.allowThisComputerTitle}
              </h3>
              <p id="compute-approval-description">
                {copy.approvalDescription(pendingApproval.label)}
              </p>
            </div>
            <dl className="sp-compute-approval-details">
              <div>
                <dt>{copy.deviceLabel}</dt>
                <dd>{pendingApproval.label}</dd>
              </div>
              <div>
                <dt>{copy.deviceFingerprintLabel}</dt>
                <dd><code>{pendingApproval.fingerprint}</code></dd>
              </div>
              <div>
                <dt>{copy.requestedAccessLabel}</dt>
                <dd>
                  {copy.requestedAccessDesc}
                </dd>
              </div>
            </dl>
            <div className="sp-compute-approval-actions">
              <button
                className="sp-btn sp-btn-secondary"
                type="button"
                disabled={pairingBusy}
                onClick={() => void rejectIncomingComputer()}
              >
                <SvgIcon name="close" size={13} />
                {copy.decline}
              </button>
              <button
                ref={approvalButtonRef}
                className="sp-btn sp-btn-primary"
                type="button"
                disabled={pairingBusy}
                onClick={() => void approveIncomingComputer()}
              >
                <SvgIcon name={pairingBusy ? "spinner" : "check"} size={13} />
                {pairingBusy
                  ? copy.workingEllipsis
                  : copy.allowConnection}
              </button>
            </div>
          </section>
        </div>
      )}

      <div className="sp-compute-peers">
        <div className="sp-remote-devices-head">
          <div>
            <div className="sp-section-title">{copy.pairedComputeNodesTitle}</div>
            <div className="sp-section-sub">{copy.computersCount(peers.length)}</div>
          </div>
        </div>
        {peers.length === 0 ? (
          <div className="sp-remote-empty">{copy.noOtherComputersPaired}</div>
        ) : (
          <div className="sp-compute-peer-table" role="table" aria-label={copy.pairedComputeNodesTitle}>
            <div className="sp-compute-peer sp-compute-peer-head" role="row">
              <span role="columnheader">{copy.nodeColumnHeader}</span>
              <span role="columnheader">{copy.statusColumnHeader}</span>
              <span role="columnheader">{copy.systemColumnHeader}</span>
              <span role="columnheader">CPU</span>
              <span role="columnheader">{copy.lastOnlineColumnHeader}</span>
              <span role="columnheader">{copy.actionColumnHeader}</span>
            </div>
            {peers.map((peer) => (
              <article
                className="sp-compute-peer"
                role="row"
                key={peer.nodeId}
                title={peer.agentChatAuthorized
                  ? copy.canRemoteJobsAndChat
                  : copy.computeJobsOnly}
              >
                <div className="sp-compute-peer-identity" role="cell">
                  <span className="sp-compute-peer-monitor" aria-hidden="true">
                    <SvgIcon name="desktop" size={21} />
                  </span>
                  <span>
                    <strong>{peer.displayName}</strong>
                    <small>{peer.nodeId.slice(0, 18)}</small>
                  </span>
                </div>
                <div className="sp-compute-peer-status" role="cell">
                  <span className={`sp-compute-peer-dot${peer.connected ? " online" : ""}`} />
                  <span>{peer.connected ? copy.online : copy.offline}</span>
                  <small>{transportLabel(peer.transport, copy)}</small>
                </div>
                <span role="cell">
                  {peer.platform && peer.architecture
                    ? `${peer.platform} ${peer.architecture}`
                    : "—"}
                </span>
                <span role="cell">{peer.logicalCpus ? `${peer.logicalCpus} CPU` : "—"}</span>
                <span role="cell">{formatPeerTimestamp(peer.lastSeenAtUnixMs, language, copy)}</span>
                <div
                  className="sp-compute-peer-menu-wrap"
                  role="cell"
                  ref={peerMenuNodeId === peer.nodeId ? peerMenuRef : undefined}
                >
                  <button
                    className="sp-compute-peer-action"
                    type="button"
                    disabled={revokingNodeId === peer.nodeId || connectingNodeId === peer.nodeId}
                    aria-haspopup="menu"
                    aria-expanded={peerMenuNodeId === peer.nodeId}
                    aria-label={connectingNodeId === peer.nodeId
                      ? copy.connectingAriaLabel(peer.displayName)
                      : revokingNodeId === peer.nodeId
                      ? copy.revokingAriaLabel(peer.displayName)
                      : copy.moreActionsAriaLabel(peer.displayName)}
                    onClick={() => setPeerMenuNodeId((current) => current === peer.nodeId ? null : peer.nodeId)}
                  >
                    <SvgIcon name={revokingNodeId === peer.nodeId || connectingNodeId === peer.nodeId ? "spinner" : "moreHorizontal"} size={15} />
                  </button>
                  {peerMenuNodeId === peer.nodeId && (
                    <div className="sp-compute-peer-menu" role="menu">
                      {!peer.connected && peer.direction === "claimed" && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setPeerMenuNodeId(null);
                            void connectPeer(peer);
                          }}
                        >
                          <SvgIcon name="desktop" size={14} />
                          <span>
                            <strong>{copy.connect}</strong>
                            <small>{copy.connectKeychainHint}</small>
                          </span>
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setPeerMenuNodeId(null);
                          void revokePeer(peer);
                        }}
                      >
                        <SvgIcon name="warning" size={14} />
                        <span>
                          <strong>{copy.revokePairing}</strong>
                          <small>{copy.revokePairingHint}</small>
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
