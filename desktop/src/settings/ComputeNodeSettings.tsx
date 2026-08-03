import { useCallback, useEffect, useRef, useState } from "react";

import {
  computeCapabilities,
  computeNodeConfigGet,
  computeNodeConfigSet,
  computePairingClaim,
  computePairingComplete,
  computePeerRevoke,
  computePeersList,
  isTauri,
  onComputePeerEvent,
  remoteControlApprovePairing,
  remoteControlConnectPhone,
  remoteControlPendingPairing,
  remoteControlRevokeDevice,
} from "../api/tauri";
import type { Language } from "../store";
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
  /** Bumped by the parent's single Refresh control; re-reads the peer list. */
  refreshToken?: number;
}

const PREVIEW_CONFIG: ComputeNodeConfig = {
  nodeId: "preview-compute-node",
  displayName: "SomniQ computer",
  acceptRemoteJobs: false,
  maxParallelJobs: 2,
};

function transportLabel(transport: string | null | undefined, cn: boolean): string {
  if (transport === "p2p_webrtc" || transport === "p2p") return "WebRTC P2P";
  if (transport === "tcp_relay") return cn ? "服务器加密中继" : "Encrypted server relay";
  if (transport === "p2p_tcp") return cn ? "局域网直连（旧版）" : "LAN direct (legacy)";
  return transport ?? (cn ? "安全连接" : "Secure");
}

export default function ComputeNodeSettings({ language, onError, refreshToken = 0 }: ComputeNodeSettingsProps) {
  const cn = language === "cn";
  const [config, setConfig] = useState<ComputeNodeConfig | null>(() => isTauri() ? null : PREVIEW_CONFIG);
  const [capabilities, setCapabilities] = useState<ComputeNodeCapabilities | null>(null);
  const [peers, setPeers] = useState<ComputePeer[]>([]);
  const [saving, setSaving] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [revokingNodeId, setRevokingNodeId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [pairingLink, setPairingLink] = useState("");
  const [outgoingInvitation, setOutgoingInvitation] = useState<RemotePairingInvitation | null>(null);
  const [incomingClaim, setIncomingClaim] = useState<ComputePairingClaim | null>(null);
  const [pendingApproval, setPendingApproval] = useState<RemotePendingPairing | null>(null);

  const reportError = useCallback((reason: unknown) => {
    const detail = String(reason);
    setMessage(detail);
    onError?.(detail);
  }, [onError]);

  const refreshPeers = useCallback(async () => {
    if (!isTauri()) return;
    setPeers(await computePeersList());
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void Promise.all([computeNodeConfigGet(), computeCapabilities(), computePeersList()])
      .then(([nextConfig, nextCapabilities, nextPeers]) => {
        setConfig(nextConfig);
        setCapabilities(nextCapabilities);
        setPeers(nextPeers);
      })
      .catch(reportError);
  }, [reportError]);

  const mountedRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken === mountedRefreshToken.current) return;
    void refreshPeers().catch(reportError);
  }, [refreshToken, refreshPeers, reportError]);

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

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setMessage("");
    try {
      if (isTauri()) {
        setConfig(await computeNodeConfigSet(
          config.displayName,
          config.acceptRemoteJobs,
          config.maxParallelJobs,
        ));
      }
      setMessage(cn ? "Worker 设置已保存。" : "Worker settings saved.");
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(false);
    }
  };

  const createInvitation = async () => {
    setPairingBusy(true);
    setMessage("");
    try {
      if (!isTauri()) {
        setMessage(cn ? "预览模式不会创建真实邀请。" : "Preview mode does not create a real invitation.");
        return;
      }
      const result = await remoteControlConnectPhone();
      setOutgoingInvitation(result.pairing);
      setPendingApproval(null);
      setMessage(cn
        ? "复制一次性连接码到另一台电脑，无需扫码。对方提交后，在这里检查并批准。"
        : "Copy the one-time connection code to the other computer—no QR scan required. Then check and approve its claim here.");
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
      setMessage(cn ? "一次性连接码已复制。" : "One-time connection code copied.");
    } catch (error) {
      reportError(error);
    }
  };

  const checkIncomingComputer = async () => {
    if (!outgoingInvitation || !isTauri()) return;
    setPairingBusy(true);
    setMessage("");
    try {
      const pending = await remoteControlPendingPairing(outgoingInvitation.pairingId);
      setPendingApproval(pending);
      setMessage(pending
        ? (cn ? "已收到电脑声明。请核对指纹后批准。" : "Computer claim received. Verify the fingerprint before approving.")
        : (cn ? "尚未收到另一台电脑的声明。" : "The other computer has not claimed this invitation yet."));
    } catch (error) {
      reportError(error);
    } finally {
      setPairingBusy(false);
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
      setMessage(cn
        ? "已批准。请在另一台电脑上点击“完成配对”。"
        : "Approved. Click “Complete pairing” on the other computer.");
      await refreshPeers();
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
        setMessage(cn ? "预览模式不会提交真实配对。" : "Preview mode does not submit a real pairing.");
        return;
      }
      const claim = await computePairingClaim(pairingLink.trim());
      setIncomingClaim(claim);
      setMessage(cn
        ? "声明已发送。请在邀请方电脑上核对并批准。"
        : "Claim sent. Verify and approve it on the inviting computer.");
    } catch (error) {
      reportError(error);
    } finally {
      setPairingBusy(false);
    }
  };

  const completePairing = async () => {
    if (!incomingClaim || !isTauri()) return;
    setPairingBusy(true);
    setMessage("");
    try {
      const claim = await computePairingComplete(incomingClaim.pairingId);
      setIncomingClaim(claim);
      if (claim.status === "completed") {
        setIncomingClaim(null);
        setPairingLink("");
        setMessage(cn ? "电脑配对完成，正在建立安全连接。" : "Computer pairing completed. Establishing a secure connection.");
        await refreshPeers();
      } else {
        setMessage(cn ? "邀请方尚未批准。" : "The inviting computer has not approved the claim yet.");
      }
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
      setMessage(cn ? "计算节点配对已撤销。" : "Compute-node pairing revoked.");
    } catch (error) {
      reportError(error);
    } finally {
      setRevokingNodeId(null);
    }
  };

  if (!config) {
    return <div className="sp-remote-empty">{cn ? "正在加载计算节点…" : "Loading compute node…"}</div>;
  }

  return (
    <section className="sp-compute-node-settings" aria-labelledby="compute-node-settings-title">
      <div className="sp-section-head">
        <div className="sp-section-head-text">
          <div className="sp-section-title" id="compute-node-settings-title">
            {cn ? "电脑计算节点" : "Computer compute node"}
          </div>
          <div className="sp-section-sub">
            {cn
              ? "让已配对电脑互相提交代码任务。任务在独立进程中运行，日志、退出状态和产物清单都会持久化并回传。"
              : "Let paired computers submit code jobs to each other. Jobs run in separate processes with durable logs, exit status, and returned artifact manifests."}
          </div>
        </div>
        <span className={`sp-compute-node-badge${config.acceptRemoteJobs ? " enabled" : ""}`}>
          {config.acceptRemoteJobs ? (cn ? "接收任务" : "Accepting jobs") : (cn ? "仅本机" : "Local only")}
        </span>
      </div>

      {message && <span className="sp-remote-message" role="status">{message}</span>}

      <div className="sp-compute-node-grid">
        <label className="sp-remote-field">
          <span>{cn ? "节点名称" : "Node name"}</span>
          <input
            value={config.displayName}
            maxLength={128}
            onChange={(event) => setConfig({ ...config, displayName: event.target.value })}
          />
          <small>{config.nodeId}</small>
        </label>
        <label className="sp-remote-field">
          <span>{cn ? "最大并行任务" : "Maximum parallel jobs"}</span>
          <input
            type="number"
            min={1}
            max={64}
            value={config.maxParallelJobs}
            onChange={(event) => setConfig({
              ...config,
              maxParallelJobs: Math.max(1, Math.min(64, Number(event.target.value) || 1)),
            })}
          />
          <small>
            {capabilities
              ? `${capabilities.logicalCpus} CPU · ${capabilities.platform}/${capabilities.architecture}`
              : (cn ? "正在检测本机能力" : "Detecting local capabilities")}
          </small>
        </label>
      </div>

      <label className="sp-compute-node-toggle">
        <input
          type="checkbox"
          role="switch"
          checked={config.acceptRemoteJobs}
          onChange={(event) => setConfig({ ...config, acceptRemoteJobs: event.target.checked })}
        />
        <span>
          <strong>{cn ? "接受已配对电脑的远程代码任务" : "Accept remote code jobs from paired computers"}</strong>
          <small>
            {cn
              ? "关闭后仍可在本机运行持久化 Compute Job，但所有远端提交都会被拒绝。"
              : "When disabled, local durable Compute Jobs remain available and all remote submissions are rejected."}
          </small>
        </span>
      </label>

      <div className="sp-detail-actions">
        <button className="sp-btn sp-btn-primary" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? (cn ? "保存中…" : "Saving…") : (cn ? "保存 Worker 设置" : "Save worker settings")}
        </button>
      </div>

      <div className="sp-compute-pairing">
        <div className="sp-remote-devices-head">
          <div>
            <div className="sp-section-title">{cn ? "电脑配对" : "Pair computers"}</div>
            <div className="sp-section-sub">
              {cn
                ? "手机网关负责配对与 ICE 打洞信令；优先 WebRTC P2P，失败后自动切换到端到端加密的服务器中继。"
                : "The mobile gateway coordinates pairing and ICE traversal; WebRTC P2P is preferred, with automatic end-to-end encrypted server relay fallback."}
            </div>
          </div>
        </div>

        <div className="sp-compute-pairing-grid">
          <div className="sp-compute-pairing-card">
            <strong>{cn ? "A. 从本机邀请" : "A. Invite from this computer"}</strong>
            <p>{cn ? "生成并复制一次性连接码；电脑之间不使用二维码。" : "Generate and copy a one-time connection code; computer pairing does not use QR codes."}</p>
            <button className="sp-btn sp-btn-secondary" type="button" disabled={pairingBusy} onClick={() => void createInvitation()}>
              {cn ? "生成一次性连接码" : "Create connection code"}
            </button>
            {outgoingInvitation && (
              <>
                <textarea className="sp-compute-pairing-link" readOnly value={outgoingInvitation.pairingLink ?? ""} />
                <div className="sp-detail-actions">
                  <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void copyConnectionCode()}>
                    {cn ? "复制连接码" : "Copy code"}
                  </button>
                  <button className="sp-btn sp-btn-secondary" type="button" disabled={pairingBusy} onClick={() => void checkIncomingComputer()}>
                    {cn ? "检查电脑声明" : "Check computer claim"}
                  </button>
                  {pendingApproval && (
                    <button className="sp-btn sp-btn-primary" type="button" disabled={pairingBusy} onClick={() => void approveIncomingComputer()}>
                      {cn ? "核对并批准" : "Verify and approve"}
                    </button>
                  )}
                </div>
                {pendingApproval && (
                  <code className="sp-compute-fingerprint">{pendingApproval.label} · {pendingApproval.fingerprint}</code>
                )}
              </>
            )}
          </div>

          <div className="sp-compute-pairing-card">
            <strong>{cn ? "B. 加入另一台电脑" : "B. Join another computer"}</strong>
            <p>{cn ? "粘贴另一台电脑生成的一次性连接码。" : "Paste the one-time connection code created on the other computer."}</p>
            <textarea
              className="sp-compute-pairing-link"
              value={pairingLink}
              placeholder={cn ? "在这里粘贴连接码" : "Paste connection code here"}
              onChange={(event) => setPairingLink(event.target.value)}
            />
            <div className="sp-detail-actions">
              <button className="sp-btn sp-btn-secondary" type="button" disabled={pairingBusy || !pairingLink.trim()} onClick={() => void claimInvitation()}>
                {cn ? "提交配对声明" : "Claim invitation"}
              </button>
              {incomingClaim && (
                <button className="sp-btn sp-btn-primary" type="button" disabled={pairingBusy} onClick={() => void completePairing()}>
                  {cn ? "完成配对" : "Complete pairing"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="sp-compute-peers">
        <div className="sp-remote-devices-head">
          <div>
            <div className="sp-section-title">{cn ? "已配对计算节点" : "Paired compute nodes"}</div>
            <div className="sp-section-sub">{cn ? `${peers.length} 台电脑` : `${peers.length} computers`}</div>
          </div>
        </div>
        {peers.length === 0 ? (
          <div className="sp-remote-empty">{cn ? "尚未配对其他电脑。" : "No other computers paired yet."}</div>
        ) : (
          <div className="sp-compute-peer-list">
            {peers.map((peer) => (
              <article className="sp-compute-peer" key={peer.nodeId}>
                <span className={`sp-compute-peer-dot${peer.connected ? " online" : ""}`} />
                <div>
                  <strong>{peer.displayName}</strong>
                  <small>{peer.connected
                    ? `${cn ? "在线" : "Online"} · ${transportLabel(peer.transport, cn)}`
                    : (cn ? "离线；重连后会补传任务事件" : "Offline; job events replay after reconnect")}</small>
                </div>
                <code>{peer.nodeId.slice(0, 8)}</code>
                <button
                  className="sp-btn sp-btn-danger"
                  type="button"
                  disabled={revokingNodeId === peer.nodeId}
                  onClick={() => void revokePeer(peer)}
                >
                  {revokingNodeId === peer.nodeId
                    ? (cn ? "撤销中…" : "Revoking…")
                    : (cn ? "撤销" : "Revoke")}
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
