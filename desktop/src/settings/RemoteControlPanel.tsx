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
import type {
  RemoteControlStatus,
  RemoteDevice,
  RemotePairingInvitation,
  RemotePendingPairing,
  RemoteScope,
} from "../types";

interface RemoteControlPanelProps {
  language: Language;
  onError?: (message: string) => void;
}

type RemoteCopy = {
  title: string;
  subtitle: string;
  refresh: string;
  refreshing: string;
  enabled: string;
  disabled: string;
  enabledDescription: string;
  disabledDescription: string;
  connectPhone: string;
  connectingPhone: string;
  refreshPairing: string;
  refreshingPairing: string;
  disable: string;
  disabling: string;
  desktopIdentity: string;
  pairingTitle: string;
  pairingDescription: string;
  pairingExpires: (time: string) => string;
  waitingForPhone: string;
  checkPairingRequest: string;
  checkingPairingRequest: string;
  pairingRequest: string;
  requestedBy: string;
  approvePairing: string;
  approvingPairing: string;
  discardPairing: string;
  discardingPairing: string;
  noSupportedScope: string;
  pairingPreview: string;
  devicesTitle: string;
  devicesSummary: (active: number, paired: number) => string;
  noDevices: string;
  paired: string;
  revoked: string;
  fingerprint: string;
  permissions: string;
  pairedAt: string;
  lastSeen: string;
  never: string;
  revoke: string;
  revokePrompt: string;
  revokeConfirm: string;
  cancel: string;
  revoking: string;
  loadFailed: string;
  enabledPreview: string;
};

const REMOTE_COPY: Record<Language, RemoteCopy> = {
  cn: {
    title: "远程控制",
    subtitle: "让已配对的手机查看研究状态和桌面对话，并按该对话的本机权限继续执行任务；项目内容仍保留在此电脑上。",
    refresh: "刷新",
    refreshing: "刷新中…",
    enabled: "已启用",
    disabled: "未启用",
    enabledDescription: "远程控制已启用。扫描下方二维码即可在手机上继续配对。",
    disabledDescription: "连接手机后会自动启用远程控制并显示一次性二维码。",
    connectPhone: "连接手机",
    connectingPhone: "正在准备二维码…",
    refreshPairing: "刷新二维码",
    refreshingPairing: "正在刷新二维码…",
    disable: "停用远程控制",
    disabling: "正在停用…",
    desktopIdentity: "桌面设备",
    pairingTitle: "配对需要本机明确批准",
    pairingDescription: "此页面不会手动授予任何设备权限。新的手机配对请求必须在这台电脑上经过验证并由你明确批准后，才会获得受限访问权限。",
    pairingExpires: (time) => `此配对二维码将在 ${time} 过期。`,
    waitingForPhone: "使用受信任的手机扫描二维码，然后在此检查请求。",
    checkPairingRequest: "检查手机请求",
    checkingPairingRequest: "正在检查…",
    pairingRequest: "等待批准的手机",
    requestedBy: "请求的权限",
    approvePairing: "批准配对",
    approvingPairing: "正在批准…",
    discardPairing: "作废二维码",
    discardingPairing: "正在作废…",
    noSupportedScope: "这台手机没有请求 P1 可批准的只读权限。",
    pairingPreview: "浏览器预览会显示示例二维码，不会建立真实连接。",
    devicesTitle: "已配对设备",
    devicesSummary: (active, paired) => `${active} 台可用 / ${paired} 条配对记录`,
    noDevices: "尚无已配对设备。连接手机后，用受信任的手机扫描二维码，并在此电脑上明确批准。",
    paired: "已配对",
    revoked: "已撤销",
    fingerprint: "设备指纹",
    permissions: "允许的操作",
    pairedAt: "配对时间",
    lastSeen: "最近连接",
    never: "从未连接",
    revoke: "撤销",
    revokePrompt: "撤销后，这台设备会立即失去远程访问权限。",
    revokeConfirm: "确认撤销设备",
    cancel: "取消",
    revoking: "正在撤销…",
    loadFailed: "无法加载远程控制状态。",
    enabledPreview: "浏览器预览：远程代理状态仅为模拟，不会建立连接。",
  },
  en: {
    title: "Remote Control",
    subtitle: "Let paired phones view desktop conversations and continue tasks under that chat's local permission policy while project data remains on this desktop.",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    enabled: "Enabled",
    disabled: "Disabled",
    enabledDescription: "Remote control is enabled. Scan the QR code below to continue pairing on your phone.",
    disabledDescription: "Connect a phone to automatically enable remote control and show a one-time QR code.",
    connectPhone: "Connect phone",
    connectingPhone: "Preparing QR code…",
    refreshPairing: "Refresh pairing QR code",
    refreshingPairing: "Refreshing QR code…",
    disable: "Disable remote control",
    disabling: "Disabling…",
    desktopIdentity: "Desktop device",
    pairingTitle: "Pairing requires explicit desktop approval",
    pairingDescription: "This screen never grants a device manually. A new phone pairing request must be verified and explicitly approved on this desktop before it receives constrained access.",
    pairingExpires: (time) => `This pairing QR code expires ${time}.`,
    waitingForPhone: "Scan the code with a trusted phone, then check for its request here.",
    checkPairingRequest: "Check for phone request",
    checkingPairingRequest: "Checking…",
    pairingRequest: "Phone awaiting approval",
    requestedBy: "Requested permissions",
    approvePairing: "Approve pairing",
    approvingPairing: "Approving…",
    discardPairing: "Discard QR code",
    discardingPairing: "Discarding…",
    noSupportedScope: "This phone did not request a remote permission that can be approved.",
    pairingPreview: "Browser preview shows a sample QR code and does not create a real connection.",
    devicesTitle: "Paired devices",
    devicesSummary: (active, paired) => `${active} active / ${paired} pairing records`,
    noDevices: "No devices are paired yet. Connect a phone, scan the QR code with a trusted device, then explicitly approve its request on this desktop.",
    paired: "Paired",
    revoked: "Revoked",
    fingerprint: "Device fingerprint",
    permissions: "Allowed actions",
    pairedAt: "Paired",
    lastSeen: "Last seen",
    never: "Never connected",
    revoke: "Revoke",
    revokePrompt: "Revoking immediately removes this device's remote access.",
    revokeConfirm: "Confirm device revocation",
    cancel: "Cancel",
    revoking: "Revoking…",
    loadFailed: "Unable to load remote-control status.",
    enabledPreview: "Browser preview: remote-agent state is simulated and no connection is opened.",
  },
};

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

const SCOPE_LABELS: Record<RemoteScope, string> = {
  read_project_state: "Project status",
  read_task_timeline: "Task timeline",
  send_chat_messages: "Desktop conversations and tasks",
  stop_runs: "Stop runs",
  read_review_conclusions: "Review conclusions",
};

function formatTimestamp(value: number | null | undefined, language: Language, fallback: string): string {
  if (!value) return fallback;
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString(language === "cn" ? "zh-CN" : "en-US");
}

function deviceScopeLabel(scope: RemoteScope, language: Language): string {
  if (language === "cn") {
    const labels: Record<RemoteScope, string> = {
      read_project_state: "查看项目状态",
      read_task_timeline: "查看任务时间线",
      send_chat_messages: "查看、继续并执行桌面对话任务",
      stop_runs: "停止运行",
      read_review_conclusions: "查看审核结论",
    };
    return labels[scope];
  }
  return SCOPE_LABELS[scope];
}

/**
 * Desktop-only settings surface for the constrained Remote Agent. Device
 * grants intentionally do not appear here: pairing is approved by the local
 * pairing flow after its cryptographic checks complete.
 */
export default function RemoteControlPanel({ language, onError }: RemoteControlPanelProps) {
  const copy = REMOTE_COPY[language];
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

  return (
    <section className="sp-update-section sp-remote-section" aria-labelledby="remote-control-title">
      <div className="sp-section-head">
        <div className="sp-section-head-text">
          <div className="sp-section-title" id="remote-control-title">{copy.title}</div>
          <div className="sp-section-sub">{copy.subtitle}</div>
        </div>
        <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void refresh()} disabled={isBusy}>
          {loading ? copy.refreshing : copy.refresh}
        </button>
      </div>

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
      </div>

      <div className="sp-remote-gateway-form">
        <button className="sp-btn sp-btn-primary" type="button" onClick={() => void connectPhone()} disabled={isBusy}>
          {connectionAction === "connect"
            ? (pairing ? copy.refreshingPairing : copy.connectingPhone)
            : (pairing ? copy.refreshPairing : copy.connectPhone)}
        </button>
        {status?.enabled && (
          <button className="sp-btn sp-btn-danger" type="button" onClick={() => void disable()} disabled={isBusy}>
            {connectionAction === "disable" ? copy.disabling : copy.disable}
          </button>
        )}
      </div>

      {message && <div className="sp-remote-message" role="status">{message}</div>}

      <aside className="sp-remote-pairing-notice" aria-label={copy.pairingTitle}>
        <span className="sp-remote-notice-icon" aria-hidden="true">!</span>
        <div>
          <strong>{copy.pairingTitle}</strong>
          <p>{copy.pairingDescription}</p>
        </div>
      </aside>

      {pairing && (
        <section className="sp-remote-pairing-flow" aria-labelledby="remote-pairing-flow-title">
          <div className="sp-remote-devices-head">
            <div>
              <div className="sp-section-title" id="remote-pairing-flow-title">{copy.pairingTitle}</div>
              <div className="sp-section-sub">{copy.pairingDescription}</div>
            </div>
          </div>

          <div className="sp-remote-pairing-card">
            <div className="sp-remote-qr-wrap">
              <img className="sp-remote-qr" src={pairing.qrCodeDataUrl} alt={copy.connectPhone} />
            </div>
            <div className="sp-remote-pairing-actions">
              <p>{copy.pairingExpires(formatTimestamp(pairing.expiresAt, language, ""))}</p>
              <p>{copy.waitingForPhone}</p>
              <div>
                <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void checkPairingRequest()} disabled={pairingBusy}>
                  {pairingBusy ? copy.checkingPairingRequest : copy.checkPairingRequest}
                </button>
                <button className="sp-btn sp-btn-danger" type="button" onClick={() => void discardPairing()} disabled={pairingBusy}>
                  {pairingBusy ? copy.discardingPairing : copy.discardPairing}
                </button>
              </div>
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
                    {pairingBusy ? copy.approvingPairing : copy.approvePairing}
                  </button>
                  <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void discardPairing()} disabled={pairingBusy}>
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
                          {copy.cancel}
                        </button>
                        <button className="sp-btn sp-btn-danger" type="button" onClick={() => void revoke(device.id)} disabled={revokingDeviceId === device.id}>
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
    </section>
  );
}
