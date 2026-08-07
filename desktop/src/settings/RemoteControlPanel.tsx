import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isTauri,
  remoteControlConnectPhone,
  remoteControlDevices,
  remoteControlDisable,
  remoteControlApprovePairing,
  remoteControlDiscardPairing,
  remoteControlPendingPairing,
  remoteControlRevokeDevice,
  remoteControlStatus,
} from "../api/tauri";
import type { Language } from "../store";
import { SETTINGS_COPY } from "./i18n";
import type {
  RemoteControlStatus,
  RemoteDevice,
  RemotePairingInvitation,
  RemotePendingPairing,
  RemoteScope,
} from "../types";
import { SvgIcon } from "../SvgIcon";
import ComputeNodeSettings from "./ComputeNodeSettings";

interface RemoteControlPanelProps {
  language: Language;
  onError?: (message: string) => void;
  initialTab?: RemoteTab;
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
  if (!value) return fallback;
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString(language === "cn" ? "zh-CN" : "en-US");
}

function deviceScopeLabel(scope: RemoteScope, language: Language): string {
  return SETTINGS_COPY[language].remote.scopeLabels[scope];
}

type RemoteTab = "phones" | "computers";

/**
 * Desktop-only settings surface for the constrained Remote Agent. Device
 * grants intentionally do not appear here: pairing is approved by the local
 * pairing flow after its cryptographic checks complete.
 *
 * Phone remote control and computer compute nodes are two independent pairing
 * mechanics (QR vs one-time code), so they live behind a sub-tab instead of
 * stacking two full feature surfaces on one scroll.
 */
export default function RemoteControlPanel({
  language,
  onError,
  initialTab = "phones",
}: RemoteControlPanelProps) {
  const copy = SETTINGS_COPY[language].remote;
  const [tab, setTab] = useState<RemoteTab>(initialTab);
  const [computeRefreshToken, setComputeRefreshToken] = useState(0);
  const [status, setStatus] = useState<RemoteControlStatus | null>(() => isTauri() ? null : PREVIEW_STATUS);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [loading, setLoading] = useState(() => isTauri());
  const [connectionAction, setConnectionAction] = useState<"connect" | "disable" | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairing, setPairing] = useState<RemotePairingInvitation | null>(null);
  const [pendingPairing, setPendingPairing] = useState<RemotePendingPairing | null>(null);
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [pendingRevokeDeviceId, setPendingRevokeDeviceId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

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
      const [nextStatus, nextDevices] = await Promise.all([
        remoteControlStatus(),
        remoteControlDevices(),
      ]);
      applyStatus(nextStatus);
      setDevices(nextDevices);
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

  const connectPhone = async () => {
    setConnectionAction("connect");
    setMessage("");
    try {
      if (!isTauri()) {
        applyStatus({
          ...PREVIEW_STATUS,
          enabled: true,
        });
        setPairing({
          pairingId: "preview-pairing",
          expiresAt: Date.now() + 5 * 60 * 1000,
          qrCodeDataUrl: PREVIEW_QR_CODE_DATA_URL,
        });
        setPendingPairing(null);
        setMessage(copy.enabledPreview);
        return;
      }
      const result = await remoteControlConnectPhone();
      applyStatus(result.status);
      setPairing(result.pairing);
      setPendingPairing(null);
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
        setPairing(null);
        setPendingPairing(null);
        setMessage(copy.enabledPreview);
        return;
      }
      applyStatus(await remoteControlDisable());
      setPairing(null);
      setPendingPairing(null);
      await refresh();
    } catch (error) {
      const detail = String(error);
      setMessage(detail);
      onError?.(detail);
    } finally {
      setConnectionAction(null);
    }
  };

  const checkPairingRequest = async () => {
    if (!pairing) return;
    setPairingBusy(true);
    setMessage("");
    try {
      if (!isTauri()) {
        setMessage(copy.pairingPreview);
        return;
      }
      const nextPendingPairing = await remoteControlPendingPairing(pairing.pairingId);
      setPendingPairing(nextPendingPairing);
      if (!nextPendingPairing) setMessage(copy.waitingForPhone);
    } catch (error) {
      const detail = String(error);
      setMessage(detail);
      onError?.(detail);
    } finally {
      setPairingBusy(false);
    }
  };

  const approvePairing = async () => {
    if (!pendingPairing) return;
    setPairingBusy(true);
    setMessage("");
    try {
      if (!isTauri()) {
        setMessage(copy.pairingPreview);
        return;
      }
      await remoteControlApprovePairing({
        pairingId: pendingPairing.pairingId,
      });
      setPairing(null);
      setPendingPairing(null);
      await refresh();
    } catch (error) {
      const detail = String(error);
      setMessage(detail);
      onError?.(detail);
    } finally {
      setPairingBusy(false);
    }
  };

  const discardPairing = async () => {
    if (!pairing) return;
    setPairingBusy(true);
    setMessage("");
    try {
      if (isTauri()) await remoteControlDiscardPairing(pairing.pairingId);
      setPairing(null);
      setPendingPairing(null);
    } catch (error) {
      const detail = String(error);
      setMessage(detail);
      onError?.(detail);
    } finally {
      setPairingBusy(false);
    }
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

  const activeDeviceCount = useMemo(
    () => status?.activeDeviceCount ?? devices.filter((device) => !device.revokedAt).length,
    [devices, status?.activeDeviceCount],
  );
  const pairedDeviceCount = status?.pairedDeviceCount ?? devices.length;
  const isBusy = connectionAction !== null || loading || pairingBusy;

  const tabs: { id: RemoteTab; label: string; hint: string }[] = [
    { id: "phones", label: copy.tabPhones, hint: copy.tabPhonesHint },
    { id: "computers", label: copy.tabComputers, hint: copy.tabComputersHint },
  ];

  /** One header control refreshes whichever surface is on screen. */
  const refreshActiveTab = () => {
    if (tab === "computers") setComputeRefreshToken((token) => token + 1);
    else void refresh();
  };

  return (
    <section className="sp-update-section sp-remote-section" aria-labelledby="remote-control-title">
      <div className="sp-section-head">
        <div className="sp-section-head-text">
          <div className="sp-section-title" id="remote-control-title">{copy.title}</div>
          <div className="sp-section-sub">{copy.subtitle}</div>
        </div>
        <button className="sp-btn sp-btn-secondary sp-remote-refresh" type="button" onClick={refreshActiveTab} disabled={isBusy}>
          <SvgIcon name={loading && tab === "phones" ? "spinner" : "refresh"} size={13} />
          {loading && tab === "phones" ? copy.refreshing : copy.refresh}
        </button>
      </div>

      <div className="sp-remote-tabs" role="tablist" aria-label={copy.title}>
        {tabs.map((entry) => (
          <button
            key={entry.id}
            className={`sp-remote-tab${tab === entry.id ? " is-active" : ""}`}
            type="button"
            role="tab"
            id={`remote-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`remote-pane-${entry.id}`}
            onClick={() => setTab(entry.id)}
          >
            <span className="sp-remote-tab-icon">
              <SvgIcon name={entry.id === "phones" ? "phone" : "desktop"} size={24} />
            </span>
            <span className="sp-remote-tab-copy">
              <strong>{entry.label}</strong>
              <small>{entry.hint}</small>
            </span>
            {tab === entry.id && (
              <span className="sp-remote-tab-check"><SvgIcon name="check" size={13} /></span>
            )}
          </button>
        ))}
      </div>

      {tab === "computers" ? (
        <div className="sp-remote-pane" role="tabpanel" id="remote-pane-computers" aria-labelledby="remote-tab-computers">
          <ComputeNodeSettings language={language} onError={onError} refreshToken={computeRefreshToken} />
        </div>
      ) : (
        <div className="sp-remote-pane" role="tabpanel" id="remote-pane-phones" aria-labelledby="remote-tab-phones">
          <div className={`sp-remote-status-card${status?.enabled ? " is-enabled" : ""}`} aria-live="polite">
            <span className="sp-remote-status-dot" aria-hidden="true" />
            <div className="sp-remote-status-copy">
              <strong>{status?.enabled ? copy.enabled : copy.disabled}</strong>
              <span>{status?.enabled ? copy.enabledDescription : copy.disabledDescription}</span>
            </div>
            {status?.deviceName && (
              <div className="sp-remote-identity">
                <span>{copy.desktopIdentity}</span>
                <strong>{status.deviceName}</strong>
              </div>
            )}
            <div className="sp-remote-actions">
              <button className="sp-btn sp-btn-primary" type="button" onClick={() => void connectPhone()} disabled={isBusy}>
                <SvgIcon name={connectionAction === "connect" ? "spinner" : "phone"} size={14} />
                {connectionAction === "connect"
                  ? (pairing ? copy.refreshingPairing : copy.connectingPhone)
                  : (pairing ? copy.refreshPairing : copy.connectPhone)}
              </button>
              {status?.enabled && (
                <button className="sp-btn sp-btn-danger" type="button" onClick={() => void disable()} disabled={isBusy}>
                  <SvgIcon name={connectionAction === "disable" ? "spinner" : "stop"} size={13} />
                  {connectionAction === "disable" ? copy.disabling : copy.disable}
                </button>
              )}
            </div>
          </div>

          {message && <div className="sp-remote-message" role="status">{message}</div>}

          {pairing && (
            <section className="sp-remote-pairing-flow" aria-labelledby="remote-pairing-flow-title">
              <div className="sp-remote-pairing-card">
                <div className="sp-remote-qr-wrap">
                  <img className="sp-remote-qr" src={pairing.qrCodeDataUrl} alt={copy.connectPhone} />
                </div>
                <div className="sp-remote-pairing-actions">
                  <div className="sp-section-title" id="remote-pairing-flow-title">{copy.pairingFlowTitle}</div>
                  <p>{copy.waitingForPhone}</p>
                  <div>
                    <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void checkPairingRequest()} disabled={pairingBusy}>
                      <SvgIcon name={pairingBusy ? "spinner" : "refresh"} size={13} />
                      {pairingBusy ? copy.checkingPairingRequest : copy.checkPairingRequest}
                    </button>
                    <button className="sp-btn sp-btn-danger" type="button" onClick={() => void discardPairing()} disabled={pairingBusy}>
                      <SvgIcon name="close" size={13} />
                      {pairingBusy ? copy.discardingPairing : copy.discardPairing}
                    </button>
                  </div>
                  <p className="sp-remote-pairing-expiry">{copy.pairingExpires(formatTimestamp(pairing.expiresAt, language, ""))}</p>
                </div>

                {pendingPairing && (
                  <div className="sp-remote-pairing-approval" role="region" aria-label={copy.pairingRequest}>
                    <div>
                      <strong>{copy.pairingRequest}</strong>
                      <span>{pendingPairing.label}</span>
                    </div>
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

          <div className="sp-remote-devices" aria-labelledby="remote-devices-title">
            <div className="sp-remote-devices-head">
              <div>
                <div className="sp-section-title" id="remote-devices-title">{copy.devicesTitle}</div>
                <div className="sp-section-sub">{copy.devicesSummary(activeDeviceCount, pairedDeviceCount)}</div>
              </div>
            </div>

            {loading ? (
              <div className="sp-remote-empty">{copy.refreshing}</div>
            ) : devices.length === 0 ? (
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
              </div>
            )}
          </div>

          <aside className="sp-remote-pairing-notice" aria-label={copy.pairingTitle}>
            <span className="sp-remote-notice-icon"><SvgIcon name="info" size={16} /></span>
            <div>
              <strong>{copy.pairingTitle}</strong>
              <p>{copy.pairingDescription}</p>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
