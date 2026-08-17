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
  memoryRebuildDerived,
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
import { SETTINGS_COPY } from "./i18n";
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
  const copy = SETTINGS_COPY[language].memory;
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
  // to show it finishing rather than leaving a stale "starting" badge. Nothing
  // is worth showing while the window is hidden, so the timer follows
  // visibility instead of running in the background indefinitely.
  useEffect(() => {
    if (!isTauri() || status?.status !== "starting") return undefined;
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const sync = () => {
      if (document.visibilityState === "hidden") stop();
      else if (timer === null) timer = window.setInterval(() => void refresh(), 1_500);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", sync);
    };
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
      setNotice(copy.requeuedTasks(restored));
      if (isTauri()) await refresh();
      else setDeadLetters([]);
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const rebuildDerived = async () => {
    if (!window.confirm(copy.rederiveConfirm)) return;
    setBusy("rebuild");
    setError("");
    setNotice("");
    try {
      const result = isTauri()
        ? await memoryRebuildDerived()
        : { capturesReplayed: 12, atomsRemoved: 30, atomsWritten: 24, atomsPreserved: 2 };
      setNotice(
        copy.rederiveSummary(
          result.capturesReplayed,
          result.atomsWritten,
          result.atomsPreserved,
        ),
      );
      if (isTauri()) await refresh();
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
      setNotice(copy.exportedTo(path));
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
      ? copy.unavailable
      : copy.loadingStatus;

  return (
    <div className="sp-general-page memory-settings-page">
      <div className="sp-status-bar">
        <div className="sp-status-slot">
          <span className={`memory-health-dot memory-health-${status?.status ?? "unknown"}`} />
          <span className="sp-status-model">
            {copy.researchMemoryTitle} {status?.componentVersion ?? ""}
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
          <span className="sp-status-tag">{copy.pending}</span>
          <span className="sp-status-model">{layerCount(status?.outboxPending)}</span>
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void refresh()}>
            {copy.refresh}
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
                {copy.tasksNeedingAttention(deadLetters.length)}
              </div>
              <div className="sp-section-sub">
                {copy.deadLetterSubtitle}
              </div>
            </div>
            <button
              className="sp-btn sp-btn-secondary"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void retryDeadLetters()}
            >
              {busy === "dead-letters" ? copy.requeuingEllipsis : copy.requeue}
            </button>
          </div>
          {deadLetters.map((item) => (
            <div className="memory-migration-summary" key={item.id}>
              <strong>{item.sessionId}</strong>
              {` · ${item.attempts} ${copy.attemptsLabel} · ${item.lastError}`}
            </div>
          ))}
        </div>
      )}

      <div className="sp-update-section">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{copy.rederiveTitle}</div>
            <div className="sp-section-sub">{copy.rederiveSubtitle}</div>
            {Boolean(status?.staleAtoms) && (
              <div className="sp-section-sub">
                <strong>{copy.rederiveStaleAtoms(status?.staleAtoms ?? 0)}</strong>
              </div>
            )}
          </div>
        </div>
        <div className="sp-update-actions memory-action-row">
          <button
            className="sp-btn sp-btn-secondary"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void rebuildDerived()}
          >
            {busy === "rebuild" ? copy.rederivingEllipsis : copy.rederiveButton}
          </button>
        </div>
      </div>

      <div className="sp-update-section">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{copy.backfillHistoryTitle}</div>
            <div className="sp-section-sub">
              {copy.backfillSubtitle}
            </div>
          </div>
        </div>
        <div className="sp-update-actions memory-action-row">
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void previewBackfill()}>{copy.previewButton}</button>
          <button className="sp-btn sp-btn-primary" type="button" disabled={Boolean(busy)} onClick={() => void runBackfill()}>{copy.backfillHistoryTitle}</button>
          <button className="sp-btn sp-btn-secondary" type="button" disabled={busy !== "migrate"} onClick={() => { void memoryMigrationCancel().catch(() => undefined); }}>{copy.cancel}</button>
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void exportMemory()}>{copy.exportMemory}</button>
        </div>
        {migrationProgress && (migrationProgress.running || busy === "migrate") && (
          <div className="memory-migration-summary" aria-live="polite">
            <progress
              max={Math.max(1, migrationProgress.totalItems)}
              value={migrationProgress.completedItems}
            />
            <span>
              {migrationProgress.phase}
              {/* Backfill can start without a preview, so the total is unknown
                  for the first poll — "0 / 0" would read as stalled. */}
              {migrationProgress.totalItems > 0
                ? `: ${migrationProgress.completedItems} / ${migrationProgress.totalItems}`
                : "…"}
            </span>
          </div>
        )}
        {migration && (
          <div className="memory-migration-summary">
            {copy.previewSummaryLabel}: {migration.sessionFiles} sessions · {migration.alreadyMigrated} {copy.alreadyBackfilled}
          </div>
        )}
        {migrationResult && (
          <div className="memory-migration-summary">
            {copy.completedLabel}: {migrationResult.importedSessions} sessions / {migrationResult.importedMessages} messages · {migrationResult.skipped} skipped{migrationResult.cancelled ? ` · ${copy.cancelledLabel}` : ""}
          </div>
        )}
      </div>

      {notice && <div className="memory-migration-summary" aria-live="polite">{notice}</div>}
      {error && <div className="sp-system-prompt-error">{error}</div>}
    </div>
  );
}
