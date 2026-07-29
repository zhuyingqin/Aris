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
  remoteControlDiscardPairing,
  remoteControlPendingPairing,
  remoteControlRevokeDevice,
} from "../api/tauri";
import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
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
  acceptRemoteAgentChats: false,
  maxParallelJobs: 2,
};

const PAIRING_POLL_INTERVAL_MS = 1_250;

function transportLabel(transport: string | null | undefined, cn: boolean): string {
  if (transport === "p2p_webrtc" || transport === "p2p") return "WebRTC P2P";
  if (transport === "tcp_relay") return cn ? "服务器加密中继" : "Encrypted server relay";
  if (transport === "p2p_tcp") return cn ? "局域网直连（旧版）" : "LAN direct (legacy)";
  return transport ?? (cn ? "安全连接" : "Secure");
}

function formatPeerTimestamp(value: number | null | undefined, cn: boolean): string {
  if (!value) return cn ? "从未连接" : "Never";
  const date = new Date(value > 10_000_000_000 ? value : value * 1000);
  if (Number.isNaN(date.getTime())) return cn ? "未知" : "Unknown";
  return date.toLocaleString(cn ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ComputeNodeSettings({ language, onError, refreshToken = 0 }: ComputeNodeSettingsProps) {
  const cn = language === "cn";
  const [config, setConfig] = useState<ComputeNodeConfig | null>(() => isTauri() ? null : PREVIEW_CONFIG);
  const [capabilities, setCapabilities] = useState<ComputeNodeCapabilities | null>(null);
  const [peers, setPeers] = useState<ComputePeer[]>([]);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [revokingNodeId, setRevokingNodeId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [pairingLink, setPairingLink] = useState("");
  const [outgoingInvitation, setOutgoingInvitation] = useState<RemotePairingInvitation | null>(null);
  const [incomingClaim, setIncomingClaim] = useState<ComputePairingClaim | null>(null);
  const [pendingApproval, setPendingApproval] = useState<RemotePendingPairing | null>(null);
  const approvalButtonRef = useRef<HTMLButtonElement | null>(null);
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
          setMessage(cn
            ? "已收到另一台电脑的配对请求，请在弹窗中确认。"
            : "A computer pairing request arrived. Confirm it in the dialog.");
          return;
        }
        if (Date.now() >= expiresAt) {
          setOutgoingInvitation(null);
          setMessage(cn
            ? "一次性连接码已过期，请重新生成。"
            : "The one-time connection code expired. Create a new one.");
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
  }, [cn, outgoingInvitation, pendingApproval, reportError]);

  useEffect(() => {
    if (!pendingApproval) return;
    const frame = window.requestAnimationFrame(() => approvalButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [pendingApproval]);

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
          setMessage(cn
            ? "电脑配对完成，正在建立安全连接。"
            : "Computer pairing completed. Establishing a secure connection.");
          await refreshPeers();
          return;
        }
        if (Date.now() >= expiresAt) {
          setIncomingClaim(null);
          setMessage(cn
            ? "配对批准等待已过期，请重新提交连接码。"
            : "Pairing approval expired. Submit a new connection code.");
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
  }, [cn, incomingClaim, refreshPeers, reportError]);

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
        ? "复制一次性连接码到另一台电脑。正在自动等待对方提交，收到后会弹出确认。"
        : "Copy the one-time connection code to the other computer. Waiting automatically; a confirmation dialog will appear when they submit it.");
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
        ? "已允许连接。另一台电脑会自动完成配对。"
        : "Connection allowed. The other computer will complete pairing automatically.");
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
      setMessage(cn
        ? "已拒绝连接，本次一次性连接码已作废。"
        : "Connection declined. This one-time connection code is no longer valid.");
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
        ? "请求已发送，正在等待邀请方确认；批准后会自动完成配对。"
        : "Request sent. Waiting for the inviting computer; pairing will complete automatically after approval.");
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
        <div className="sp-compute-node-card">
          <span className="sp-compute-node-card-label">{cn ? "节点名称" : "Node name"}</span>
          <input
            className="sp-compute-node-name-input"
            aria-label={cn ? "节点名称" : "Node name"}
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
              title={cn ? "复制节点 ID" : "Copy node ID"}
              aria-label={cn ? "复制节点 ID" : "Copy node ID"}
              onClick={() => {
                void navigator.clipboard.writeText(config.nodeId)
                  .then(() => setMessage(cn ? "节点 ID 已复制。" : "Node ID copied."))
                  .catch(reportError);
              }}
            >
              <SvgIcon name="copy" size={12} />
            </button>
          </span>
        </div>
        <div className="sp-compute-node-card sp-compute-node-capacity-card">
          <label>
            <span className="sp-compute-node-card-label">{cn ? "最大并行任务" : "Maximum parallel jobs"}</span>
            <input
              className="sp-compute-parallel-input"
              aria-label={cn ? "最大并行任务" : "Maximum parallel jobs"}
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
              : (cn ? "正在检测本机能力" : "Detecting local capabilities")}
          </small>
          <SvgIcon name="edit" size={14} className="sp-compute-card-edit" />
        </div>
      </div>

      <label className="sp-compute-node-toggle">
        <span className="sp-compute-toggle-icon"><SvgIcon name="shieldCheck" size={18} /></span>
        <span className="sp-compute-toggle-copy">
          <strong>{cn ? "接受已配对电脑的远程代码任务" : "Accept remote code jobs from paired computers"}</strong>
          <small>
            {cn
              ? "关闭后仍可在本机运行持久化 Compute Job，但所有远端提交都会被拒绝。"
              : "When disabled, local durable Compute Jobs remain available and all remote submissions are rejected."}
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
            {cn
              ? "允许已配对电脑与本机 Agent 对话"
              : "Allow paired computers to talk to this Agent"}
          </strong>
          <small>
            {cn
              ? "远程电脑会使用本机项目、模型和工具，并继续遵守本机权限策略；可与远程代码任务分别开关。"
              : "Remote computers use this computer's projects, models, and tools under its local permission policy. This is independent from code jobs."}
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
            <button className="sp-btn sp-btn-primary" type="button" disabled={pairingBusy} onClick={() => void createInvitation()}>
              <SvgIcon name={pairingBusy ? "spinner" : "plus"} size={13} />
              {cn ? "生成一次性连接码" : "Create connection code"}
            </button>
            {outgoingInvitation && (
              <>
                <textarea className="sp-compute-pairing-link" readOnly value={outgoingInvitation.pairingLink ?? ""} />
                <div className="sp-detail-actions">
                  <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void copyConnectionCode()}>
                    <SvgIcon name="copy" size={13} />
                    {cn ? "复制连接码" : "Copy code"}
                  </button>
                </div>
                <div className="sp-compute-pairing-wait" role="status">
                  <span aria-hidden="true" />
                  {cn ? "正在等待另一台电脑提交…" : "Waiting for the other computer to submit…"}
                </div>
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
              <button className="sp-btn sp-btn-primary" type="button" disabled={pairingBusy || !pairingLink.trim()} onClick={() => void claimInvitation()}>
                <SvgIcon name={pairingBusy ? "spinner" : "send"} size={13} />
                {cn ? "提交配对声明" : "Claim invitation"}
              </button>
            </div>
            {incomingClaim && (
              <div className="sp-compute-pairing-wait" role="status">
                <span aria-hidden="true" />
                {cn ? "等待邀请方确认，之后将自动完成…" : "Waiting for approval, then pairing will finish automatically…"}
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
                {cn ? "允许这台电脑连接吗？" : "Allow this computer to connect?"}
              </h3>
              <p id="compute-approval-description">
                {cn
                  ? `${pendingApproval.label} 已提交刚才生成的一次性连接码。请核对设备指纹后决定。`
                  : `${pendingApproval.label} submitted the one-time connection code. Verify its fingerprint before deciding.`}
              </p>
            </div>
            <dl className="sp-compute-approval-details">
              <div>
                <dt>{cn ? "设备" : "Device"}</dt>
                <dd>{pendingApproval.label}</dd>
              </div>
              <div>
                <dt>{cn ? "设备指纹" : "Device fingerprint"}</dt>
                <dd><code>{pendingApproval.fingerprint}</code></dd>
              </div>
              <div>
                <dt>{cn ? "请求权限" : "Requested access"}</dt>
                <dd>
                  {cn
                    ? "远程 Agent 对话、读取项目列表、提交计算任务"
                    : "Remote Agent chat, project list, and compute jobs"}
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
                {cn ? "拒绝" : "Decline"}
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
                  ? (cn ? "处理中…" : "Working…")
                  : (cn ? "允许连接" : "Allow connection")}
              </button>
            </div>
          </section>
        </div>
      )}

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
          <div className="sp-compute-peer-table" role="table" aria-label={cn ? "已配对计算节点" : "Paired compute nodes"}>
            <div className="sp-compute-peer sp-compute-peer-head" role="row">
              <span role="columnheader">{cn ? "节点名称" : "Node"}</span>
              <span role="columnheader">{cn ? "状态" : "Status"}</span>
              <span role="columnheader">{cn ? "系统" : "System"}</span>
              <span role="columnheader">CPU</span>
              <span role="columnheader">{cn ? "最后在线" : "Last online"}</span>
              <span role="columnheader">{cn ? "操作" : "Action"}</span>
            </div>
            {peers.map((peer) => (
              <article
                className="sp-compute-peer"
                role="row"
                key={peer.nodeId}
                title={peer.agentChatAuthorized
                  ? (cn ? "可执行远程任务和 Agent 对话" : "Remote jobs and Agent chat enabled")
                  : (cn ? "仅允许计算任务" : "Compute jobs only")}
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
                  <span>{peer.connected ? (cn ? "在线" : "Online") : (cn ? "离线" : "Offline")}</span>
                  <small>{transportLabel(peer.transport, cn)}</small>
                </div>
                <span role="cell">
                  {peer.platform && peer.architecture
                    ? `${peer.platform} ${peer.architecture}`
                    : "—"}
                </span>
                <span role="cell">{peer.logicalCpus ? `${peer.logicalCpus} CPU` : "—"}</span>
                <span role="cell">{formatPeerTimestamp(peer.lastSeenAtUnixMs, cn)}</span>
                <button
                  className="sp-compute-peer-action"
                  type="button"
                  disabled={revokingNodeId === peer.nodeId}
                  aria-label={revokingNodeId === peer.nodeId
                    ? (cn ? `正在撤销 ${peer.displayName}` : `Revoking ${peer.displayName}`)
                    : (cn ? `撤销 ${peer.displayName}` : `Revoke ${peer.displayName}`)}
                  onClick={() => void revokePeer(peer)}
                >
                  <SvgIcon name={revokingNodeId === peer.nodeId ? "spinner" : "moreHorizontal"} size={15} />
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
