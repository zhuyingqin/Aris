import { useEffect, useState } from "react";

import {
  isTauri,
  memoryDeadLetterRetry,
  memoryDeadLetters,
  memoryExport,
  memoryMigrationCancel,
  memoryMigrationExecute,
  memoryMigrationProgress,
  memoryMigrationPreview,
  memoryStatus,
} from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import type {
  MemoryDeadLetterView,
  MemoryMigrationPreview,
  MemoryMigrationProgress,
  MemoryMigrationResult,
  MemoryStatusView,
} from "../types";
import { useStore, type Language } from "../store";
import MemoryExplorer from "./MemoryExplorer";
import MemoryRecallPreview from "./MemoryRecallPreview";

// Browser-only preview data. It is never used inside the app: this page exists
// to tell the user what is actually stored, so showing a plausible-looking
// stand-in while the real query is in flight — or after it failed — is the one
// thing it must not do.
const PREVIEW_STATUS: MemoryStatusView = {
  projectId: "default",
  componentVersion: "research-v1",
  status: "healthy",
  dataPath: "~/.config/SomniQ/memory/builtin/research-memory.sqlite3",
  outboxPending: 0,
  deadLetter: 0,
  l0Count: 2429,
  l1Count: 18,
  l2Count: 6,
  l3Count: 1,
};

interface Props {
  language: Language;
}

export default function MemorySettings({ language }: Props) {
  const cn = language === "cn";
  const currentProject = useStore((state) => state.currentProject);
  const [status, setStatus] = useState<MemoryStatusView | null>(
    isTauri() ? null : PREVIEW_STATUS,
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [migration, setMigration] = useState<MemoryMigrationPreview | null>(null);
  const [migrationResult, setMigrationResult] = useState<MemoryMigrationResult | null>(null);
  const [migrationProgress, setMigrationProgress] = useState<MemoryMigrationProgress | null>(null);
  const [deadLetters, setDeadLetters] = useState<MemoryDeadLetterView[]>([]);

  const activeProjectId = currentProject?.id ?? status?.projectId ?? "default";

  const refresh = async () => {
    if (!isTauri()) return;
    try {
      const [nextStatus, nextDeadLetters] = await Promise.all([
        memoryStatus(),
        memoryDeadLetters().catch(() => []),
      ]);
      setStatus(nextStatus);
      setDeadLetters(nextDeadLetters);
      setError("");
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A projection rebuild runs on a background thread, so the page has to poll
  // to show it finishing rather than leaving a stale "starting" badge.
  useEffect(() => {
    if (!isTauri() || status?.status !== "starting") return undefined;
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.status]);

  useEffect(() => {
    if (!isTauri() || busy !== "migrate") return undefined;
    let active = true;
    const poll = () => {
      void memoryMigrationProgress()
        .then((progress) => {
          if (active) setMigrationProgress(progress);
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [busy]);

  const retryDeadLetters = async () => {
    setBusy("dead-letters");
    setError("");
    setNotice("");
    try {
      const restored = isTauri() ? await memoryDeadLetterRetry() : deadLetters.length;
      setNotice(
        cn
          ? `已重新排队 ${restored} 条记忆任务`
          : `Requeued ${restored} memory ${restored === 1 ? "task" : "tasks"}`,
      );
      if (isTauri()) await refresh();
      else setDeadLetters([]);
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const exportMemory = async () => {
    setBusy("export");
    setError("");
    setNotice("");
    try {
      const path = isTauri()
        ? await memoryExport()
        : "~/.config/SomniQ/memory/exports/research-memory-preview.json";
      setNotice(cn ? `已导出到 ${path}` : `Exported to ${path}`);
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const previewBackfill = async () => {
    setBusy("preview");
    setError("");
    setNotice("");
    try {
      setMigration(
        isTauri()
          ? await memoryMigrationPreview()
          : { sessionFiles: 8, alreadyMigrated: 0 },
      );
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const runBackfill = async () => {
    setBusy("migrate");
    setError("");
    setNotice("");
    setMigrationResult(null);
    setMigrationProgress({
      running: true,
      phase: "starting",
      completedItems: 0,
      totalItems: migration?.sessionFiles ?? 0,
      lastError: null,
    });
    try {
      const result = isTauri()
        ? await memoryMigrationExecute()
        : { importedSessions: 8, importedMessages: 32, skipped: 0, cancelled: false };
      setMigrationResult(result);
      if (isTauri()) {
        setMigrationProgress(await memoryMigrationProgress());
        setStatus(await memoryStatus());
        setDeadLetters(await memoryDeadLetters().catch(() => []));
      }
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  // An em dash, never a plausible number: an unanswered or failed status query
  // must be visibly empty rather than quietly wrong.
  const layerCount = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : value.toLocaleString();
  const statusLabel = status
    ? status.status
    : error
      ? (cn ? "不可用" : "unavailable")
      : (cn ? "读取中" : "loading");

  return (
    <div className="sp-general-page memory-settings-page">
      <div className="sp-status-bar">
        <div className="sp-status-slot">
          <span className={`memory-health-dot memory-health-${status?.status ?? "unknown"}`} />
          <span className="sp-status-model">
            {cn ? "SomniQ 科研记忆" : "SomniQ Research Memory"} {status?.componentVersion ?? ""}
          </span>
          <span className="sp-status-url">{statusLabel}</span>
          {status?.message && <span className="sp-status-note">{status.message}</span>}
        </div>
        <div className="sp-status-sep" />
        <div className="sp-status-slot">
          <span className="sp-status-tag">R0</span>
          <span className="sp-status-model">{layerCount(status?.l0Count)}</span>
          <span className="sp-status-tag">R1</span>
          <span className="sp-status-model">{layerCount(status?.l1Count)}</span>
          <span className="sp-status-tag">R2</span>
          <span className="sp-status-model">{layerCount(status?.l2Count)}</span>
          <span className="sp-status-tag">R3</span>
          <span className="sp-status-model">{layerCount(status?.l3Count)}</span>
        </div>
        <div className="sp-status-sep" />
        <div className="sp-status-slot">
          <span className="sp-status-tag">{cn ? "待提炼" : "Pending"}</span>
          <span className="sp-status-model">{layerCount(status?.outboxPending)}</span>
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void refresh()}>
            {cn ? "刷新" : "Refresh"}
          </button>
        </div>
      </div>

      <MemoryExplorer
        language={language}
        projectId={activeProjectId}
        onChanged={() => void refresh()}
      />

      <MemoryRecallPreview language={language} projectId={activeProjectId} />

      {deadLetters.length > 0 && (
        <div className="sp-update-section" aria-label="memory dead letters">
          <div className="sp-section-head">
            <div className="sp-section-head-text">
              <div className="sp-section-title">
                {cn ? `需要处理的记忆任务 (${deadLetters.length})` : `Memory tasks needing attention (${deadLetters.length})`}
              </div>
              <div className="sp-section-sub">
                {cn
                  ? "这些记忆任务已重试多次仍未成功；原始会话不会被删除。重新排队会清零重试次数并立即再试一遍。"
                  : "These memory tasks exhausted their retries; their source sessions remain intact. Requeuing resets the attempt count and runs them again now."}
              </div>
            </div>
            <button
              className="sp-btn sp-btn-secondary"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void retryDeadLetters()}
            >
              {busy === "dead-letters"
                ? (cn ? "重新排队中…" : "Requeuing…")
                : (cn ? "重新排队" : "Requeue")}
            </button>
          </div>
          {deadLetters.map((item) => (
            <div className="memory-migration-summary" key={item.id}>
              <strong>{item.sessionId}</strong>
              {` · ${item.attempts} ${cn ? "次尝试" : "attempts"} · ${item.lastError}`}
            </div>
          ))}
        </div>
      )}

      <div className="sp-update-section">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{cn ? "回填历史" : "Backfill history"}</div>
            <div className="sp-section-sub">
              {cn
                ? "新完成的普通对话会自动提炼 R1–R3；这里用于安全回填已有历史。工作流 Session 会被排除，不修改或删除原始对话。"
                : "Backfills R1–R3 from ordinary authoritative Sessions; Workflow Sessions are excluded and original chats remain unchanged."}
            </div>
          </div>
        </div>
        <div className="sp-update-actions memory-action-row">
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void previewBackfill()}>{cn ? "预览" : "Preview"}</button>
          <button className="sp-btn sp-btn-primary" type="button" disabled={Boolean(busy)} onClick={() => void runBackfill()}>{cn ? "回填历史" : "Backfill history"}</button>
          <button className="sp-btn sp-btn-secondary" type="button" disabled={busy !== "migrate"} onClick={() => { void memoryMigrationCancel().catch(() => undefined); }}>{cn ? "取消" : "Cancel"}</button>
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void exportMemory()}>{cn ? "导出记忆" : "Export memory"}</button>
        </div>
        {migrationProgress && (migrationProgress.running || busy === "migrate") && (
          <div className="memory-migration-summary" aria-live="polite">
            <progress
              max={Math.max(1, migrationProgress.totalItems)}
              value={migrationProgress.completedItems}
            />
            <span>
              {migrationProgress.phase}: {migrationProgress.completedItems} / {migrationProgress.totalItems}
            </span>
          </div>
        )}
        {migration && (
          <div className="memory-migration-summary">
            {cn ? "待检查" : "Preview"}: {migration.sessionFiles} sessions · {migration.alreadyMigrated} {cn ? "已回填" : "already backfilled"}
          </div>
        )}
        {migrationResult && (
          <div className="memory-migration-summary">
            {cn ? "完成" : "Completed"}: {migrationResult.importedSessions} sessions / {migrationResult.importedMessages} messages · {migrationResult.skipped} skipped{migrationResult.cancelled ? ` · ${cn ? "已取消" : "cancelled"}` : ""}
          </div>
        )}
      </div>

      {notice && <div className="memory-migration-summary" aria-live="polite">{notice}</div>}
      {error && <div className="sp-system-prompt-error">{error}</div>}
    </div>
  );
}
