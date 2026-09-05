import { useCallback, useEffect, useMemo, useState } from "react";

import {
  computeCancel,
  computeCapabilities,
  computeEventsAfter,
  computeJobsList,
  computePeersList,
  computeReadLog,
  computeSubmit,
  isTauri,
  onComputeJobEvent,
  onComputePeerEvent,
} from "../api/tauri";
import type { Language } from "../store";
import "./ComputePanel.css";
import type {
  ComputeJobEvent,
  ComputeJobRecord,
  ComputeJobStatus,
  ComputeNodeCapabilities,
  ComputePeer,
  ComputeWorkload,
} from "../types";

interface ComputePanelProps {
  language: Language;
  projectId: string | null;
  projectPath: string | null;
  activePath: string | null;
  activeKind: "notebook" | "file" | null;
  kernel?: string | null;
}

const TERMINAL = new Set<ComputeJobStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
]);

function relativeProjectPath(path: string, projectPath: string | null): string {
  const normalized = path.replace(/\\/g, "/");
  const root = projectPath?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized.replace(/^\.?\//, "");
}

function statusLabel(status: ComputeJobStatus, language: Language): string {
  const labels: Record<ComputeJobStatus, [string, string]> = {
    queued: ["排队", "Queued"],
    preparing: ["准备", "Preparing"],
    running: ["运行中", "Running"],
    succeeded: ["成功", "Succeeded"],
    failed: ["失败", "Failed"],
    cancelled: ["已取消", "Cancelled"],
    timed_out: ["超时", "Timed out"],
    lost: ["已中断", "Interrupted"],
  };
  return labels[status][language === "cn" ? 0 : 1];
}

function formatDuration(job: ComputeJobRecord): string {
  const end = job.finishedAtUnixMs ?? Date.now();
  const start = job.startedAtUnixMs ?? job.createdAtUnixMs;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function transportLabel(transport: string, language: Language): string {
  if (transport === "p2p_webrtc" || transport === "p2p") return "WebRTC P2P";
  if (transport === "tcp_relay") {
    return language === "cn" ? "服务器加密中继" : "Encrypted server relay";
  }
  if (transport === "p2p_tcp") {
    return language === "cn" ? "局域网直连（旧版）" : "LAN direct (legacy)";
  }
  return transport;
}

export default function ComputePanel({
  language,
  projectId,
  projectPath,
  activePath,
  activeKind,
  kernel,
}: ComputePanelProps) {
  const cn = language === "cn";
  const [capabilities, setCapabilities] = useState<ComputeNodeCapabilities | null>(null);
  const [peers, setPeers] = useState<ComputePeer[]>([]);
  const [targetNodeId, setTargetNodeId] = useState("local");
  const [jobs, setJobs] = useState<ComputeJobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [timeoutSecs, setTimeoutSecs] = useState(1800);
  const [artifactGlobs, setArtifactGlobs] = useState("outputs/**,results/**,*.csv,*.json,*.png,*.pdf");

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const [nextCapabilities, nextJobs, nextPeers] = await Promise.all([
        computeCapabilities(),
        computeJobsList(),
        computePeersList(),
      ]);
      setCapabilities(nextCapabilities);
      setJobs(nextJobs);
      setPeers(nextPeers);
      setTargetNodeId((current) => (
        current === "local" || nextPeers.some((peer) => peer.nodeId === current)
          ? current
          : "local"
      ));
      setSelectedJobId((current) => current ?? nextJobs[0]?.request.jobId ?? null);
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  useEffect(() => {
    setJobs([]);
    setSelectedJobId(null);
    setStdout("");
    setStderr("");
    void refresh();
  }, [projectId, refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onComputeJobEvent((event) => {
      if (disposed) return;
      const payload = event.payload;
      setJobs((current) => {
        const found = current.some((job) => job.request.jobId === event.jobId);
        if (!found) {
          void refresh();
          return current;
        }
        return current.map((job) => applyEvent(job, event));
      });
      if (event.jobId === selectedJobId && payload.kind === "log") {
        if (payload.stream === "stderr") {
          setStderr((current) => current + payload.text);
        } else if (payload.stream === "stdout") {
          setStdout((current) => current + payload.text);
        }
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh, selectedJobId]);

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

  useEffect(() => {
    if (!selectedJobId || !isTauri()) {
      setStdout("");
      setStderr("");
      return;
    }
    let disposed = false;
    void Promise.all([
      computeReadLog(selectedJobId, "stdout", 0, 1024 * 1024),
      computeReadLog(selectedJobId, "stderr", 0, 1024 * 1024),
      computeEventsAfter(selectedJobId, 0),
    ]).then(([out, err]) => {
      if (!disposed) {
        setStdout(out.text);
        setStderr(err.text);
      }
    }).catch((reason) => {
      if (!disposed) setError(String(reason));
    });
    return () => {
      disposed = true;
    };
  }, [selectedJobId]);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.request.jobId === selectedJobId) ?? null,
    [jobs, selectedJobId],
  );
  const selectedPeer = peers.find((peer) => peer.nodeId === targetNodeId) ?? null;
  const targetAvailable = targetNodeId === "local" || Boolean(selectedPeer?.connected);
  const activeRelativePath = activePath ? relativeProjectPath(activePath, projectPath) : null;
  const runnable = activeRelativePath
    && (activeKind === "notebook" || activeRelativePath.toLowerCase().endsWith(".py"));

  const submitCurrent = async () => {
    if (!activeRelativePath || !activeKind) return;
    setBusy(true);
    setError("");
    try {
      let workload: ComputeWorkload;
      if (activeKind === "notebook") {
        workload = {
          kind: "notebook",
          notebook_path: activeRelativePath,
          kernel: kernel ?? null,
          parameters: {},
          stop_on_error: true,
        };
      } else {
        workload = {
          kind: "python",
          entrypoint: activeRelativePath,
          args: [],
          interpreter: null,
        };
      }
      const filename = activeRelativePath.split("/").pop() ?? activeRelativePath;
      const record = await computeSubmit({
        displayName: `${activeKind === "notebook" ? "Notebook" : "Python"} · ${filename}`,
        workload,
        timeoutSecs,
        artifactGlobs: artifactGlobs.split(",").map((item) => item.trim()).filter(Boolean),
        targetNodeId,
      });
      setJobs((current) => [record, ...current.filter((job) => job.request.jobId !== record.request.jobId)]);
      setSelectedJobId(record.request.jobId);
      setStdout("");
      setStderr("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const cancelSelected = async () => {
    if (!selectedJob) return;
    setBusy(true);
    setError("");
    try {
      await computeCancel(selectedJob.request.jobId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="compute-panel compute-runtime-panel compute-node">
        <div className="compute-panel-head">
          <h3>{cn ? "计算目标" : "Compute target"}</h3>
          <button className="compute-btn ghost" type="button" onClick={() => void refresh()}>
            {cn ? "刷新" : "Refresh"}
          </button>
        </div>
        <select
          className="compute-select compute-target-select"
          value={targetNodeId}
          onChange={(event) => setTargetNodeId(event.target.value)}
        >
          <option value="local">
            {capabilities
              ? `${capabilities.displayName} · ${capabilities.logicalCpus} CPU`
              : (cn ? "本机 Worker" : "Local worker")}
          </option>
          {peers.map((peer) => (
            <option key={peer.nodeId} value={peer.nodeId} disabled={!peer.connected}>
              {peer.displayName} · {peer.connected ? (cn ? "在线" : "online") : (cn ? "离线" : "offline")}
            </option>
          ))}
        </select>
        <div className="compute-target-meta">
          <span className={`compute-online-dot${targetAvailable ? "" : " offline"}`} />
          <span>
            {targetNodeId === "local"
              ? (cn ? "本机在线" : "Local online")
              : (targetAvailable ? (cn ? "远端在线" : "Remote online") : (cn ? "远端离线" : "Remote offline"))}
          </span>
          {targetNodeId === "local" && capabilities && <em>{capabilities.platform}/{capabilities.architecture}</em>}
          {selectedPeer?.transport && <em>{transportLabel(selectedPeer.transport, language)}</em>}
        </div>
        <label className="compute-field">
          <span>{cn ? "超时（秒）" : "Timeout (seconds)"}</span>
          <input
            type="number"
            min={1}
            max={604800}
            value={timeoutSecs}
            onChange={(event) => setTimeoutSecs(Math.max(1, Number(event.target.value) || 1))}
          />
        </label>
        <label className="compute-field">
          <span>{cn ? "回传产物" : "Returned artifacts"}</span>
          <input value={artifactGlobs} onChange={(event) => setArtifactGlobs(event.target.value)} />
        </label>
        <button
          type="button"
          className="compute-btn primary compute-run-all-btn"
          disabled={!runnable || !targetAvailable || busy}
          onClick={() => void submitCurrent()}
        >
          {busy ? (cn ? "提交中…" : "Submitting…") : (cn ? "在所选节点运行当前文件" : "Run current file on target")}
        </button>
        {!runnable && (
          <div className="compute-muted">
            {cn ? "打开一个 Notebook 或 Python 文件以创建持久化计算任务。" : "Open a notebook or Python file to create a durable compute job."}
          </div>
        )}
      </section>

      <section className="compute-panel compute-runtime-panel">
        <div className="compute-panel-head">
          <h3>{cn ? "计算任务" : "Compute jobs"}</h3>
          <span className="compute-count-badge">{jobs.length}</span>
        </div>
        {jobs.length === 0 ? (
          <div className="compute-muted">{cn ? "还没有计算任务。" : "No compute jobs yet."}</div>
        ) : (
          <div className="compute-job-list">
            {jobs.slice(0, 12).map((job) => (
              <button
                type="button"
                key={job.request.jobId}
                className={`compute-job${job.request.jobId === selectedJobId ? " active" : ""}`}
                onClick={() => setSelectedJobId(job.request.jobId)}
              >
                <span className={`compute-status ${job.status}`}>{statusLabel(job.status, language)}</span>
                <strong title={job.request.displayName}>{job.request.displayName}</strong>
                <em>{job.target.kind === "remote" ? `${job.target.node_name} · ` : ""}{formatDuration(job)}</em>
              </button>
            ))}
          </div>
        )}
        {selectedJob && (
          <div className="compute-detail">
            <div className="compute-detail-head">
              <code>{selectedJob.request.jobId.slice(0, 8)}</code>
              {!TERMINAL.has(selectedJob.status) && (
                <button className="compute-btn warn" type="button" disabled={busy} onClick={() => void cancelSelected()}>
                  {cn ? "取消任务" : "Cancel job"}
                </button>
              )}
            </div>
            {(stdout || stderr) ? (
              <pre className="compute-log">
                {stdout}
                {stderr && <span className="compute-stderr">{stderr}</span>}
              </pre>
            ) : (
              <div className="compute-muted">{cn ? "等待日志…" : "Waiting for logs…"}</div>
            )}
            {selectedJob.result?.error && <div className="compute-inline-error">{selectedJob.result.error}</div>}
            {selectedJob.result?.artifacts && selectedJob.result.artifacts.length > 0 && (
              <div className="compute-artifacts">
                <strong>{cn ? "产物" : "Artifacts"}</strong>
                {selectedJob.result.artifacts.map((artifact) => (
                  <span key={artifact.path} title={artifact.sha256}>
                    {artifact.path} · {Math.ceil(artifact.sizeBytes / 1024)} KB
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {error && <div className="compute-inline-error">{error}</div>}
      </section>
    </>
  );
}

function applyEvent(job: ComputeJobRecord, event: ComputeJobEvent): ComputeJobRecord {
  if (job.request.jobId !== event.jobId) return job;
  const next = { ...job, lastSequence: event.sequence, updatedAtUnixMs: event.emittedAtUnixMs };
  if (event.payload.kind === "status") {
    next.status = event.payload.status;
    if (event.payload.status === "running" && !next.startedAtUnixMs) {
      next.startedAtUnixMs = event.emittedAtUnixMs;
    }
  } else if (event.payload.kind === "completed") {
    next.status = event.payload.result.status;
    next.result = event.payload.result;
    next.startedAtUnixMs = event.payload.result.startedAtUnixMs;
    next.finishedAtUnixMs = event.payload.result.finishedAtUnixMs;
  }
  return next;
}
