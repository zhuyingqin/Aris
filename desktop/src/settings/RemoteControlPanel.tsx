import { useCallback, useEffect, useMemo, useState } from "react";
import {
  computePeerConnect,
  computePeerRevoke,
  computePeersList,
  isTauri,
  onComputePeerEvent,
  remoteControlDevices,
  remoteControlDisable,
  remoteControlResetIdentity,
  remoteControlSetDeviceName,
  remoteControlRevokeDevice,
  remoteControlStatus,
} from "../api/tauri";
import type { Language } from "../store";
import { epochToDate } from "../timestamp";
import { SETTINGS_COPY } from "./i18n";
import { usePairingCeremony } from "./usePairingCeremony";
import type {
  ComputePeer,
  RemoteControlStatus,
  RemoteDevice,
  RemoteScope,
} from "../types";
import { SvgIcon } from "../SvgIcon";
import JoinDeviceForm from "./JoinDeviceForm";
import LocalDeviceCapabilities from "./LocalDeviceCapabilities";

interface RemoteControlPanelProps {
  language: Language;
  onError?: (message: string) => void;
}

const PREVIEW_STATUS: RemoteControlStatus = {
  enabled: false,
  gatewayUrl: null,
  deviceId: "desktop-preview",
  deviceName: "SomniQ Desktop",
  iceServers: [],
  pairedDeviceCount: 0,
  activeDeviceCount: 0,
};

const PREVIEW_QR_CODE_DATA_URL = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0id2hpdGUiLz48cGF0aCBkPSJNMCAwaDMwdjMwSDB6bTcwIDBoMzB2MzBINzB6TTAgNzBoMzB2MzBIMHoiIGZpbGw9ImJsYWNrIi8+PC9zdmc+";

function formatTimestamp(value: number | null | undefined, language: Language, fallback: string): string {
  const date = epochToDate(value);
  return date ? date.toLocaleString(language === "cn" ? "zh-CN" : "en-US") : fallback;
}

function deviceScopeLabel(scope: RemoteScope, language: Language): string {
  return SETTINGS_COPY[language].remote.scopeLabels[scope];
}

/**
 * One trusted-device surface. Phone and computer claims share the same signed
 * invitation; device type selects capabilities, not a separate identity UI.
 */
export default function RemoteControlPanel({
  language,
  onError,
}: RemoteControlPanelProps) {
  const copy = SETTINGS_COPY[language].remote;
  const [status, setStatus] = useState<RemoteControlStatus | null>(() => isTauri() ? null : PREVIEW_STATUS);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [computers, setComputers] = useState<ComputePeer[]>([]);
  const [loading, setLoading] = useState(() => isTauri());
  const [connectionAction, setConnectionAction] = useState<"connect" | "disable" | null>(null);
  const reportPairingError = useCallback((error: unknown) => {
    const detail = String(error);
    setMessage(detail);
    onError?.(detail);
  }, [onError]);
  const ceremony = usePairingCeremony({
    onClaimArrived: () => setMessage(copy.pairingRequestArrived),
    onInvitationExpired: () => setMessage(copy.pairingExpired),
    onError: reportPairingError,
  });
  const { invitation: pairing, pendingApproval: pendingPairing } = ceremony;
  const pairingBusy = ceremony.busy;
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [pendingRevokeDeviceId, setPendingRevokeDeviceId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [identityResetNeeded, setIdentityResetNeeded] = useState(false);
  /** Null while not renaming; the draft name while the field is open. */
  const [renamingTo, setRenamingTo] = useState<string | null>(null);

  const applyStatus = useCallback((next: RemoteControlStatus) => {
    setStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      if (!isTauri()) {
        setStatus((current) => current ?? PREVIEW_STATUS);
        setDevices([]);
        return;
      }
      const [nextStatus, nextDevices, nextComputers] = await Promise.all([
        remoteControlStatus(),
        remoteControlDevices(),
        computePeersList(),
      ]);
      applyStatus(nextStatus);
      setDevices(nextDevices);
      setComputers(nextComputers);
    } catch (error) {
      const detail = `${copy.loadFailed} ${String(error)}`;
      setMessage(detail);
      onError?.(detail);
    } finally {
      setLoading(false);
    }
  }, [applyStatus, copy.loadFailed, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onComputePeerEvent(() => {
      if (!disposed) void refresh();
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const addDevice = async () => {
    setConnectionAction("connect");
    setMessage("");
    try {
      if (!isTauri()) {
        applyStatus({
          ...PREVIEW_STATUS,
          enabled: true,
        });
        ceremony.adopt({
          pairingId: "preview-pairing",
          expiresAt: Date.now() + 5 * 60 * 1000,
          qrCodeDataUrl: PREVIEW_QR_CODE_DATA_URL,
        });
        setMessage(copy.enabledPreview);
        return;
      }
      applyStatus((await ceremony.start()).status);
    } catch (error) {
      const detail = String(error);
      // Recovering from a refused identity throws away every pairing, so the
      // backend refuses to do it silently and routes here for consent instead.
      if (detail.includes("remote identity was refused by the gateway")) {
        setIdentityResetNeeded(true);
        setMessage("");
        return;
      }
      setMessage(detail);
      onError?.(detail);
    } finally {
      setConnectionAction(null);
    }
  };

  const saveDeviceName = async () => {
    const name = renamingTo?.trim();
    if (!name) return;
    setConnectionAction("connect");
    setMessage("");
    try {
      if (isTauri()) applyStatus(await remoteControlSetDeviceName(name));
      setRenamingTo(null);
      setMessage(copy.renameDone);
    } catch (error) {
      const detail = String(error);
      setMessage(detail);
      onError?.(detail);
    } finally {
      setConnectionAction(null);
    }
  };

  const resetIdentity = async () => {
    setConnectionAction("connect");
    setMessage("");
    try {
      const result = await remoteControlResetIdentity();
      applyStatus(result.status);
      ceremony.adopt(result.pairing);
      setIdentityResetNeeded(false);
      setMessage(copy.identityResetDone);
      await refresh();
    } catch (error) {
      const detail = String(error);
      setMessage(detail);
      onError?.(detail);
    } finally {
      setConnectionAction(null);
    }
  };

  const disable = async () => {
    setConnectionAction("disable");
    setMessage("");
    try {
      if (!isTauri()) {
        applyStatus(PREVIEW_STATUS);
        ceremony.reset();
        setMessage(copy.enabledPreview);
        return;
      }
      applyStatus(await remoteControlDisable());
      ceremony.reset();
      await refresh();
    } catch (error) {
      const detail = String(error);
      setMessage(detail);
      onError?.(detail);
    } finally {
      setConnectionAction(null);
    }
  };

  // A browser on a computer has no camera to point at the QR. The same
  // one-time invitation is also a deep link, so copying it is a complete
  // substitute for scanning — explicit approval on this device is unchanged.
  const copyPairingCode = async () => {
    const code = pairing?.pairingLink?.trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setMessage(copy.pairingCodeCopied);
    } catch (error) {
      const detail = String(error);
      setMessage(detail);
      onError?.(detail);
    }
  };

  const approvePairing = async () => {
    setMessage("");
    if (!isTauri()) {
      setMessage(copy.pairingPreview);
      return;
    }
    if (await ceremony.approve()) await refresh();
  };

  const discardPairing = async () => {
    setMessage("");
    if (!isTauri()) {
      ceremony.reset();
      return;
    }
    await ceremony.decline();
  };

  const revoke = async (deviceId: string) => {
    setRevokingDeviceId(deviceId);
    setMessage("");
    try {
      if (isTauri()) await remoteControlRevokeDevice(deviceId);
      setDevices((current) => current.filter((device) => device.id !== deviceId));
      setPendingRevokeDeviceId(null);
      if (isTauri()) await refresh();
    } catch (error) {
      const detail = String(error);
      setMessage(detail);
      onError?.(detail);
    } finally {
      setRevokingDeviceId(null);
    }
  };

  const revokeComputer = async (peer: ComputePeer) => {
    setRevokingDeviceId(peer.endpointId);
    setMessage("");
    try {
      if (isTauri()) {
        if (peer.direction === "claimed") await computePeerRevoke(peer.nodeId);
        else await remoteControlRevokeDevice(peer.nodeId);
      }
      setComputers((current) => current.filter((candidate) => candidate.endpointId !== peer.endpointId));
      setPendingRevokeDeviceId(null);
      if (isTauri()) await refresh();
    } catch (error) {
      const detail = String(error);
      setMessage(detail);
      onError?.(detail);
    } finally {
      setRevokingDeviceId(null);
    }
  };

  const connectComputer = async (peer: ComputePeer) => {
    if (!isTauri() || peer.connected || peer.direction !== "claimed") return;
    setMessage("");
    try {
      await computePeerConnect(peer.nodeId);
      await refresh();
    } catch (error) {
      const detail = String(error);
      setMessage(detail);
      onError?.(detail);
    }
  };

  const activeDeviceCount = useMemo(
    () => devices.filter((device) => !device.revokedAt).length + computers.filter((peer) => peer.connected).length,
    [computers, devices],
  );
  const pairedDeviceCount = devices.length + computers.length;
  const isBusy = connectionAction !== null || loading || pairingBusy;

  return (
    <section className="sp-update-section sp-remote-section" aria-labelledby="remote-control-title">
      <div className="sp-section-head">
        <div className="sp-section-head-text">
          <div className="sp-section-title" id="remote-control-title">{copy.title}</div>
          <div className="sp-section-sub">{copy.subtitle}</div>
        </div>
      </div>

      <div className="sp-remote-pane sp-remote-unified-pane">
          <div className={`sp-remote-status-card${status?.enabled ? " is-enabled" : ""}`} aria-live="polite">
            <span className="sp-remote-status-dot" aria-hidden="true" />
            <div className="sp-remote-status-copy">
              <strong>{status?.enabled ? copy.enabled : copy.disabled}</strong>
              <span>{status?.enabled ? copy.enabledDescription : copy.disabledDescription}</span>
            </div>
            {status?.deviceName && (
              <div className="sp-remote-identity">
                <span>{copy.endpointIdentity}</span>
                {renamingTo === null ? (
                  <span className="sp-remote-identity-name">
                    <strong>{status.deviceName}</strong>
                    <button
                      className="sp-remote-rename-btn"
                      type="button"
                      onClick={() => setRenamingTo(status.deviceName ?? "")}
                      disabled={isBusy}
                    >
                      <SvgIcon name="edit" size={12} />
                      {copy.renameDevice}
                    </button>
                  </span>
                ) : (
                  <form
                    className="sp-remote-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveDeviceName();
                    }}
                  >
                    <input
                      aria-label={copy.endpointIdentity}
                      value={renamingTo}
                      autoFocus
                      maxLength={60}
                      onChange={(event) => setRenamingTo(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setRenamingTo(null);
                      }}
                    />
                    <button className="sp-btn sp-btn-primary" type="submit" disabled={isBusy || !renamingTo.trim()}>
                      {copy.renameSave}
                    </button>
                    <button className="sp-btn sp-btn-secondary" type="button" onClick={() => setRenamingTo(null)}>
                      {copy.renameCancel}
                    </button>
                  </form>
                )}
              </div>
            )}
            {renamingTo !== null && <p className="sp-remote-rename-hint">{copy.renameDeviceHint}</p>}
            <div className="sp-remote-actions">
              {status?.enabled && (
                <button className="sp-btn sp-btn-danger" type="button" onClick={() => void disable()} disabled={isBusy}>
                  <SvgIcon name={connectionAction === "disable" ? "spinner" : "stop"} size={13} />
                  {connectionAction === "disable" ? copy.disabling : copy.disable}
                </button>
              )}
            </div>
          </div>

          {message && <div className="sp-remote-message" role="status">{message}</div>}

          {identityResetNeeded && (
            <div className="sp-remote-identity-reset" role="alertdialog" aria-label={copy.identityResetTitle}>
              <strong>{copy.identityResetTitle}</strong>
              <p>{copy.identityResetBody(pairedDeviceCount)}</p>
              <div className="sp-remote-pairing-actions-row">
                <button className="sp-btn sp-btn-danger" type="button" onClick={() => void resetIdentity()} disabled={isBusy}>
                  <SvgIcon name={connectionAction === "connect" ? "spinner" : "refresh"} size={13} />
                  {copy.identityResetConfirm}
                </button>
                <button className="sp-btn sp-btn-secondary" type="button" onClick={() => setIdentityResetNeeded(false)} disabled={isBusy}>
                  <SvgIcon name="close" size={13} />
                  {copy.identityResetCancel}
                </button>
              </div>
            </div>
          )}

          <section className="sp-remote-add-device" aria-labelledby="remote-add-device-title">
            <div className="sp-remote-devices-head">
              <div>
                <div className="sp-section-title" id="remote-add-device-title">{copy.addDevice}</div>
                <div className="sp-section-sub">{copy.addDeviceDescription}</div>
              </div>
              <button className="sp-btn sp-btn-primary" type="button" onClick={() => void addDevice()} disabled={isBusy}>
                <SvgIcon name={connectionAction === "connect" ? "spinner" : "plus"} size={14} />
                {connectionAction === "connect"
                  ? (pairing ? copy.refreshingPairing : copy.creatingInvitation)
                  : (pairing ? copy.refreshPairing : copy.addDevice)}
              </button>
            </div>

          {pairing && (
            <section className="sp-remote-pairing-flow" aria-labelledby="remote-pairing-flow-title">
              <div className="sp-remote-pairing-card">
                <div className="sp-remote-qr-wrap">
                  <img className="sp-remote-qr" src={pairing.qrCodeDataUrl} alt={copy.addDevice} />
                </div>
                <div className="sp-remote-pairing-actions">
                  <div className="sp-section-title" id="remote-pairing-flow-title">{copy.pairingFlowTitle}</div>
                  {/* The claim arrives on its own now; nothing left to poll by hand. */}
                  <p className="sp-remote-pairing-watch">
                    <span className="sp-remote-pairing-pulse" aria-hidden="true" />
                    {copy.waitingForDevice}
                  </p>
                  <div>
                    <button className="sp-btn sp-btn-danger" type="button" onClick={() => void discardPairing()} disabled={pairingBusy}>
                      <SvgIcon name="close" size={13} />
                      {pairingBusy ? copy.discardingPairing : copy.discardPairing}
                    </button>
                  </div>
                  <p className="sp-remote-pairing-expiry">{copy.pairingExpires(formatTimestamp(pairing.expiresAt, language, ""))}</p>
                </div>

                {pairing.pairingLink && (
                  <div className="sp-remote-pairing-code-block">
                    <div className="sp-section-title">{copy.pairingCodeTitle}</div>
                    <p>{copy.pairingCodeDescription}</p>
                    <div className="sp-remote-pairing-code">
                      <SvgIcon name="copy" size={14} />
                      <textarea
                        className="sp-remote-pairing-textarea"
                        aria-label={copy.pairingCodeLabel}
                        readOnly
                        rows={2}
                        value={pairing.pairingLink}
                        title={pairing.pairingLink}
                      />
                      <button type="button" onClick={() => void copyPairingCode()}>
                        <SvgIcon name="copy" size={13} />
                        {copy.copyPairingCode}
                      </button>
                    </div>
                  </div>
                )}

                {pendingPairing && (
                  <div className="sp-remote-pairing-approval" role="region" aria-label={copy.pairingRequest}>
                    <div>
                      <strong>
                        {copy.pairingRequest}
                        {" · "}
                        {pendingPairing.kind === "compute_node" ? copy.computerDevice : copy.phoneDevice}
                      </strong>
                    </div>
                    {/* Both ends, named. Approving is a decision about a pair of
                        machines, and "which computer am I looking at" is not
                        obvious once a person owns more than one. */}
                    <p className="sp-remote-pairing-parties">
                      <span className="sp-remote-pairing-party">{pendingPairing.label}</span>
                      <span className="sp-remote-pairing-arrow" aria-hidden="true">→</span>
                      <span className="sp-remote-pairing-party is-target">
                        {status?.deviceName?.trim() || copy.thisDevice}
                      </span>
                    </p>
                    <dl className="sp-remote-device-details">
                      <div>
                        <dt>{copy.fingerprint}</dt>
                        <dd className="sp-remote-fingerprint">{pendingPairing.fingerprint}</dd>
                      </div>
                      <div>
                        <dt>{copy.requestedBy}</dt>
                        <dd>{pendingPairing.requestedScopes.map((scope) => deviceScopeLabel(scope, language)).join(" · ")}</dd>
                      </div>
                    </dl>
                    <div className="sp-remote-pairing-actions-row">
                      <button className="sp-btn sp-btn-primary" type="button" onClick={() => void approvePairing()} disabled={pairingBusy}>
                        <SvgIcon name={pairingBusy ? "spinner" : "check"} size={13} />
                        {pairingBusy ? copy.approvingPairing : copy.approvePairing}
                      </button>
                      <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void discardPairing()} disabled={pairingBusy}>
                        <SvgIcon name="close" size={13} />
                        {pairingBusy ? copy.discardingPairing : copy.discardPairing}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

            <JoinDeviceForm
              language={language}
              onError={onError}
              onMessage={setMessage}
              onDevicesChanged={refresh}
            />
          </section>

          <div className="sp-remote-devices" aria-labelledby="remote-devices-title">
            <div className="sp-remote-devices-head">
              <div>
                <div className="sp-section-title" id="remote-devices-title">{copy.devicesTitle}</div>
                <div className="sp-section-sub">{copy.devicesSummary(activeDeviceCount, pairedDeviceCount)}</div>
              </div>
            </div>

            {loading ? (
              <div className="sp-remote-empty">{copy.refreshing}</div>
            ) : devices.length === 0 && computers.length === 0 ? (
              <div className="sp-remote-empty">{copy.noDevices}</div>
            ) : (
              <div className="sp-remote-device-list">
                {devices.map((device) => {
                  const revoked = Boolean(device.revokedAt);
                  const confirmationOpen = pendingRevokeDeviceId === device.id;
                  return (
                    <article className={`sp-remote-device${revoked ? " is-revoked" : ""}`} key={device.id}>
                      <div className="sp-remote-device-head">
                        <div>
                          <strong>{device.label}</strong>
                          <span className={`sp-remote-device-state${revoked ? " is-revoked" : ""}`}>
                            {revoked ? copy.revoked : copy.paired}
                          </span>
                        </div>
                        {!confirmationOpen && (
                          <button className="sp-btn sp-btn-danger sp-remote-revoke-button" type="button" onClick={() => setPendingRevokeDeviceId(device.id)}>
                            <SvgIcon name="close" size={12} />
                            {copy.revoke}
                          </button>
                        )}
                      </div>
                      <dl className="sp-remote-device-details">
                        <div>
                          <dt>{copy.fingerprint}</dt>
                          <dd className="sp-remote-fingerprint">{device.fingerprint}</dd>
                        </div>
                        <div>
                          <dt>{copy.permissions}</dt>
                          <dd>{device.scopes.map((scope) => deviceScopeLabel(scope, language)).join(" · ") || "—"}</dd>
                        </div>
                        <div>
                          <dt>{copy.pairedAt}</dt>
                          <dd>{formatTimestamp(device.pairedAt, language, "—")}</dd>
                        </div>
                        <div>
                          <dt>{copy.lastSeen}</dt>
                          <dd>{formatTimestamp(device.lastSeenAt, language, copy.never)}</dd>
                        </div>
                      </dl>
                      {confirmationOpen && (
                        <div className="sp-remote-revoke-confirm" role="alert">
                          <span>{copy.revokePrompt}</span>
                          <div>
                            <button className="sp-btn sp-btn-secondary" type="button" onClick={() => setPendingRevokeDeviceId(null)} disabled={revokingDeviceId === device.id}>
                              <SvgIcon name="close" size={12} />
                              {copy.cancel}
                            </button>
                            <button className="sp-btn sp-btn-danger" type="button" onClick={() => void revoke(device.id)} disabled={revokingDeviceId === device.id}>
                              <SvgIcon name={revokingDeviceId === device.id ? "spinner" : "warning"} size={13} />
                              {revokingDeviceId === device.id ? copy.revoking : copy.revokeConfirm}
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
                {computers.map((peer) => {
                  const confirmationOpen = pendingRevokeDeviceId === peer.endpointId;
                  return (
                    <article className="sp-remote-device" key={peer.endpointId}>
                      <div className="sp-remote-device-head">
                        <div>
                          <span className="sp-remote-device-kind">
                            <SvgIcon name="desktop" size={14} />
                            {copy.computerDevice}
                          </span>
                          <strong>{peer.displayName}</strong>
                          <span className={`sp-remote-device-state${peer.connected ? "" : " is-revoked"}`}>
                            {peer.connected ? copy.online : copy.offline}
                          </span>
                        </div>
                        <div className="sp-remote-device-actions">
                          {!peer.connected && peer.direction === "claimed" && (
                            <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void connectComputer(peer)}>
                              <SvgIcon name="desktop" size={12} />
                              {copy.connect}
                            </button>
                          )}
                          {!confirmationOpen && (
                            <button className="sp-btn sp-btn-danger sp-remote-revoke-button" type="button" onClick={() => setPendingRevokeDeviceId(peer.endpointId)}>
                              <SvgIcon name="close" size={12} />
                              {copy.revoke}
                            </button>
                          )}
                        </div>
                      </div>
                      <dl className="sp-remote-device-details">
                        <div>
                          <dt>{copy.endpointIdentity}</dt>
                          <dd className="sp-remote-fingerprint">{peer.endpointId}</dd>
                        </div>
                        <div>
                          <dt>{copy.permissions}</dt>
                          <dd>
                            {deviceScopeLabel("compute_jobs", language)}
                            {peer.agentChatAuthorized ? ` · ${deviceScopeLabel("send_chat_messages", language)}` : ""}
                          </dd>
                        </div>
                        <div>
                          <dt>{copy.systemColumnHeader}</dt>
                          <dd>{peer.platform && peer.architecture ? `${peer.platform} ${peer.architecture}` : "—"}</dd>
                        </div>
                        <div>
                          <dt>{copy.statusColumnHeader}</dt>
                          <dd>{peer.transport ?? copy.transportSecureFallback}</dd>
                        </div>
                        <div>
                          <dt>{copy.lastSeen}</dt>
                          <dd>{formatTimestamp(peer.lastSeenAtUnixMs, language, copy.never)}</dd>
                        </div>
                      </dl>
                      {confirmationOpen && (
                        <div className="sp-remote-revoke-confirm" role="alert">
                          <span>{copy.revokePrompt}</span>
                          <div>
                            <button className="sp-btn sp-btn-secondary" type="button" onClick={() => setPendingRevokeDeviceId(null)} disabled={revokingDeviceId === peer.endpointId}>
                              <SvgIcon name="close" size={12} />
                              {copy.cancel}
                            </button>
                            <button className="sp-btn sp-btn-danger" type="button" onClick={() => void revokeComputer(peer)} disabled={revokingDeviceId === peer.endpointId}>
                              <SvgIcon name={revokingDeviceId === peer.endpointId ? "spinner" : "warning"} size={13} />
                              {revokingDeviceId === peer.endpointId ? copy.revoking : copy.revokeConfirm}
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          <LocalDeviceCapabilities language={language} onError={onError} />

          <aside className="sp-remote-pairing-notice" aria-label={copy.pairingTitle}>
            <span className="sp-remote-notice-icon"><SvgIcon name="info" size={16} /></span>
            <div>
              <strong>{copy.pairingTitle}</strong>
              <p>{copy.pairingDescription}</p>
            </div>
          </aside>
      </div>
    </section>
  );
}
