import { useEffect, useState } from "react";

import {
  configSet,
  isTauri,
  memoryExport,
  memoryStatus,
  memoryV2ConfirmR3,
  memoryV2HistoryPreview,
  memoryV2ImportHistory,
  memoryV2BuildProgress,
  memoryV2PendingR3,
  memoryV2RescreenRejected,
  memoryV2StartBuild,
  memoryV2Status,
  memoryV2Wake,
} from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import type {
  MemoryStatusView,
  MemoryV2AtomView,
  MemoryV2BuildProgress,
  MemoryV2HistoryImportResult,
  MemoryV2HistoryPreview,
  MemoryV2StatusView,
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
  captureExpected: 12,
  captureCovered: 12,
  captureMissing: 0,
  lastCapturedAt: new Date().toISOString(),
  lastCapturedSessionId: "chat-preview",
};

const PREVIEW_V2_STATUS: MemoryV2StatusView = {
  mode: "legacy_r0_only",
  legacyReadOnly: false,
  dataPath: "~/.config/SomniQ/memory/builtin/research-memory-v2.sqlite3",
  remoteConfigured: false,
  stats: {
    pending_outbox: 0,
    deferred_outbox: 0,
    rejected_candidates: 0,
    r1_active: 0,
    r2_active: 0,
    r3_pending_confirmation: 0,
    r3_confirmed: 0,
  },
  model: "",
  availableModels: ["MiniMax-M3", "deepseek-v4-flash", "gpt-5.6-luna"],
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
  const [v2Status, setV2Status] = useState<MemoryV2StatusView | null>(
    isTauri() ? null : PREVIEW_V2_STATUS,
  );
  const [pendingR3, setPendingR3] = useState<MemoryV2AtomView[]>([]);
  const [historyPreview, setHistoryPreview] = useState<MemoryV2HistoryPreview | null>(null);
  const [rescreened, setRescreened] = useState<number | null>(null);
  const [buildModel, setBuildModel] = useState("");
  const [build, setBuild] = useState<MemoryV2BuildProgress | null>(null);
  const [historyImport, setHistoryImport] = useState<MemoryV2HistoryImportResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const activeProjectId = currentProject?.id ?? status?.projectId ?? "default";

  const refresh = async (interactive = false) => {
    if (!isTauri()) return;
    if (interactive) setBusy("refresh");
    const results = await Promise.allSettled([
      memoryStatus(),
      memoryV2Status(),
      memoryV2PendingR3(),
    ]);
    const [legacyResult, v2Result, pendingR3Result] = results;
    if (legacyResult.status === "fulfilled") setStatus(legacyResult.value);
    if (v2Result.status === "fulfilled") setV2Status(v2Result.value);
    if (pendingR3Result.status === "fulfilled") setPendingR3(pendingR3Result.value);

    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => formatUserFacingError(result.reason, language));
    setError(errors.length ? Array.from(new Set(errors)).join(" · ") : "");
    if (interactive) {
      setBusy("");
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Adopt whatever model the backend has pinned, but never clobber a choice the
  // user is in the middle of making.
  useEffect(() => {
    if (v2Status?.model && !buildModel) setBuildModel(v2Status.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2Status?.model]);

  // Screening a backlog is minutes of model calls with nothing on screen. Poll
  // the worker while it runs, and pull the counters in when it stops so the
  // library stops showing the numbers from before the build.
  useEffect(() => {
    if (!isTauri() || !build?.running) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void memoryV2BuildProgress()
        .then((progress) => {
          if (cancelled) return;
          setBuild(progress);
          if (!progress.running) void refresh();
        })
        .catch(() => {});
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build?.running]);

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

  const setV2Mode = async (mode: MemoryV2StatusView["mode"]) => {
    setBusy(`mode:${mode}`);
    setError("");
    setNotice("");
    try {
      if (isTauri()) {
        await configSet({ memoryV2Mode: mode });
        await memoryV2Wake();
        await refresh();
      } else {
        setV2Status((current) => current ? { ...current, mode } : current);
      }
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const confirmR3 = async (atomId: string) => {
    setBusy(`confirm:${atomId}`);
    setError("");
    try {
      if (isTauri()) {
        await memoryV2ConfirmR3(atomId);
        await refresh();
      } else {
        setPendingR3((current) => current.filter((item) => item.id !== atomId));
      }
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const previewHistory = async () => {
    setBusy("history-preview");
    setError("");
    setNotice("");
    try {
      const preview = isTauri()
        ? await memoryV2HistoryPreview()
        : { sourceSessions: 8, finalTurns: 24, alreadyCaptured: 0, readyToQueue: 24 };
      setHistoryPreview(preview);
      setHistoryImport(null);
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const importHistory = async () => {
    if (!historyPreview || historyPreview.readyToQueue < 1) return;
    const confirmed = window.confirm(language === "cn"
      ? `仅将 ${historyPreview.readyToQueue} 条原始 Session 最终回合加入 v2 待筛队列？后续审核可能消耗模型额度；旧 R1–R3 派生记忆不会被读取或回放。`
      : `Queue ${historyPreview.readyToQueue} raw Session final turns for v2 screening? Review may use model quota; legacy R1–R3 derived memory will not be read or replayed.`);
    if (!confirmed) return;
    setBusy("history-import");
    setError("");
    setNotice("");
    try {
      const result = isTauri()
        ? await memoryV2ImportHistory()
        : {
            sourceSessions: historyPreview.sourceSessions,
            finalTurns: historyPreview.finalTurns,
            queued: historyPreview.readyToQueue,
            alreadyCaptured: historyPreview.alreadyCaptured,
          };
      setHistoryImport(result);
      if (isTauri()) await refresh();
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  // Screening and review policy changes only reach new turns; captures already
  // refused stay refused. This replays the corrected policy over that history.
  const rescreenRejected = async () => {
    const confirmed = window.confirm(language === "cn"
      ? "重新筛查此前被拒绝的回合？当前规则仍会拒绝的回合直接跳过，不消耗额度；其余会重新走双重审查并消耗模型额度。已通过的记忆不受影响。"
      : "Re-screen previously rejected turns? Turns the current rules still reject are skipped without using quota; the rest re-run both review passes and will use model quota. Already-promoted memory is untouched.");
    if (!confirmed) return;
    setBusy("rescreen");
    setError("");
    setNotice("");
    try {
      const requeued = isTauri() ? await memoryV2RescreenRejected() : 49;
      setRescreened(requeued);
      if (isTauri()) await refresh();
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const startBuild = async () => {
    setBusy("build");
    setError("");
    setNotice("");
    try {
      if (!isTauri()) {
        setBuild({
          running: true, processed: 0, failed: 0, model: buildModel || "reviewer",
          lastError: "", lastStatement: "", startedAt: new Date().toISOString(), finishedAt: "",
        });
        return;
      }
      const started = await memoryV2StartBuild(buildModel || undefined);
      setNotice(language === "cn"
        ? `已用 ${started.model} 开始构建：重新排队 ${started.requeued} 条，队列共 ${started.pending} 条。`
        : `Building with ${started.model}: re-queued ${started.requeued}, ${started.pending} in the queue.`);
      setBuild(await memoryV2BuildProgress());
      await refresh();
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
  const modeDetails = {
    legacy_r0_only: language === "cn"
      ? ["仅 R0", "停止新捕获与注入；适用于回滚"]
      : ["R0 only", "Stops new capture and injection; use to roll back"],
    observe: language === "cn"
      ? ["观察", "运行筛选与审查，但不注入提示词"]
      : ["Observe", "Screens and reviews without prompt injection"],
    canary: language === "cn"
      ? ["灰度验证", "受控启用 v2 召回并持续观察队列"]
      : ["Canary", "Enables v2 recall for controlled validation"],
    active: language === "cn"
      ? ["正常启用", "在普通对话中使用已审核的 v2 记忆"]
      : ["Active", "Uses reviewed v2 memory in normal recall"],
  } as const;
  const modes = ["legacy_r0_only", "observe", "canary", "active"] as const;
  const v2DerivedCount = status
    ? [status.l1Count, status.l2Count, status.l3Count]
      .reduce((total: number, value) => total + (value ?? 0), 0)
    : null;
  const v2Stats = v2Status?.stats;
  const memorySummary = status
    ? language === "cn"
      ? `R0 ${layerCount(status.l0Count)} · v2 R1–R3 ${layerCount(v2DerivedCount)}`
      : `R0 ${layerCount(status.l0Count)} · V2 R1–R3 ${layerCount(v2DerivedCount)}`
    : error
      ? language === "cn" ? `记忆库：${copy.unavailable}` : `Memory library: ${copy.unavailable}`
      : language === "cn" ? "正在读取记忆库…" : "Loading memory library…";
  const v2StatusLabel = v2Status
    ? modeDetails[v2Status.mode][0]
    : error
      ? copy.unavailable
      : copy.loadingStatus;
  const v2Title = language === "cn" ? "研究记忆 v2（活动库）" : "Research memory v2 (active store)";
  const v2Subtitle = language === "cn"
    ? "R0 仍具权威性；科研记忆库中的 R1–R3 仅来自经过审核的 v2 记录。"
    : "R0 remains authoritative; the library's R1–R3 records come only from reviewed v2 memory.";

  return (
    <div className="sp-general-page memory-settings-page">
      <div className="sp-status-bar memory-status-bar" aria-label={language === "cn" ? "智能记忆状态" : "Smart memory status"}>
        <div className="sp-status-slot">
          <span className={`memory-health-dot memory-health-${v2Status ? "healthy" : "unknown"}`} />
          <span className="sp-status-model">{language === "cn" ? "智能记忆 v2" : "Smart memory v2"}</span>
          <span className="sp-status-url">{v2StatusLabel}</span>
          <span className="sp-status-note">{memorySummary}</span>
        </div>
        <div className="sp-status-sep" />
        <div className="sp-status-slot">
          <span className="sp-status-tag">R0</span><span className="sp-status-model">{layerCount(status?.l0Count)}</span>
          <span className="sp-status-tag">R1</span><span className="sp-status-model">{layerCount(status?.l1Count)}</span>
          <span className="sp-status-tag">R2</span><span className="sp-status-model">{layerCount(status?.l2Count)}</span>
          <span className="sp-status-tag">R3</span><span className="sp-status-model">{layerCount(status?.l3Count)}</span>
        </div>
        <div className="sp-status-sep" />
        <div className="sp-status-slot">
          <span className="sp-status-tag">{language === "cn" ? "队列" : "Queue"}</span>
          <span className="sp-status-model">{layerCount(v2Stats?.pending_outbox)}</span>
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void refresh(true)}>
            {busy === "refresh" ? (language === "cn" ? "刷新中…" : "Refreshing…") : copy.refresh}
          </button>
        </div>
      </div>

      <MemoryExplorer language={language} projectId={activeProjectId} />

      <MemoryRecallPreview language={language} projectId={activeProjectId} />

      <section className="sp-update-section memory-v2-section">
        <div className="sp-section-head memory-v2-heading">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{v2Title}</div>
            <div className="sp-section-sub">{v2Subtitle}</div>
            <div className="sp-section-sub memory-v2-runtime-line">
              {language === "cn" ? "模式" : "Mode"}: {v2StatusLabel}
              {" · "}
              TencentDB: {v2Status?.remoteConfigured
                ? "PostgreSQL"
                : language === "cn" ? "未配置（R2 本地词法回退）" : "not configured (local R2 lexical fallback)"}
            </div>
          </div>
          <div className="memory-mode-picker" role="radiogroup" aria-label={language === "cn" ? "v2 运行模式" : "V2 rollout mode"}>
            {modes.map((mode) => (
              <button
                className={`memory-mode-option${v2Status?.mode === mode ? " active" : ""}`}
                type="button"
                key={mode}
                disabled={Boolean(busy)}
                role="radio"
                aria-checked={v2Status?.mode === mode}
                title={modeDetails[mode][1]}
                onClick={() => void setV2Mode(mode)}
              >
                {modeDetails[mode][0]}
              </button>
            ))}
          </div>
        </div>

        <div className="memory-v2-stats" aria-label={language === "cn" ? "v2 记忆状态" : "V2 memory status"}>
          <span>{language === "cn" ? "队列" : "Queue"} <strong>{layerCount(v2Stats?.pending_outbox)}</strong></span>
          <span>{language === "cn" ? "延迟/失败" : "Deferred/failed"} <strong>{layerCount(v2Stats?.deferred_outbox)}</strong></span>
          <span>R1 <strong>{layerCount(v2Stats?.r1_active)}</strong></span>
          <span>R2 <strong>{layerCount(v2Stats?.r2_active)}</strong></span>
          <span>{language === "cn" ? "待确认 R3" : "R3 pending"} <strong>{layerCount(v2Stats?.r3_pending_confirmation)}</strong></span>
          <span>{language === "cn" ? "已确认 R3" : "Confirmed R3"} <strong>{layerCount(v2Stats?.r3_confirmed)}</strong></span>
        </div>

        {pendingR3.length > 0 && (
          <div className="memory-r3-confirmations">
            <strong>{language === "cn" ? "待用户确认的 R3" : "R3 awaiting your confirmation"}</strong>
            {pendingR3.map((atom) => (
              <div className="memory-r3-confirmation" key={atom.id}>
                <div>
                  <span>{atom.statement} · {atom.kind}</span>
                  <small title={atom.sourceEventIds.join(", ")}>{atom.sourceQuote}</small>
                </div>
                <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void confirmR3(atom.id)}>
                  {language === "cn" ? "确认并允许注入" : "Confirm for injection"}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="memory-v2-footer">
          <span>{language === "cn"
            ? "筛选、审查或 TencentDB 同步失败时，不会注入。"
            : "Screening, review, or TencentDB failures never inject memory."}</span>
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void exportMemory()}>{copy.exportMemory}</button>
        </div>
      </section>

      <section className="sp-update-section memory-history-section">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{language === "cn" ? "从历史 Session 补录记忆" : "Backfill memory from past Sessions"}</div>
            <div className="sp-section-sub">
              {language === "cn"
                ? "工具失败与恢复在每轮结束时当场写入，不花额度；其余内容仍由后台筛查抽取。此处用于回头挖掘尚未筛查过的历史对话：只扫描普通对话的最终回合，每条会消耗模型额度。"
                : "Tool failures and recoveries are written inline as each turn ends at no cost; everything else is still extracted by background screening. This section mines past conversations that were never screened: it scans final turns from ordinary chats and does use model quota."}
            </div>
          </div>
        </div>
        <div className="sp-update-actions memory-action-row memory-history-import-actions">
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void previewHistory()}>
            {busy === "history-preview" ? (language === "cn" ? "扫描中…" : "Scanning…") : language === "cn" ? "扫描历史" : "Scan history"}
          </button>
          {historyPreview && historyPreview.readyToQueue > 0 && (
            <button className="sp-btn sp-btn-primary" type="button" disabled={Boolean(busy) || v2Status?.mode === "legacy_r0_only"} onClick={() => void importHistory()}>
              {busy === "history-import" ? (language === "cn" ? "加入队列中…" : "Queueing…") : language === "cn" ? "加入 v2 队列" : "Queue for v2"}
            </button>
          )}
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy) || v2Status?.mode === "legacy_r0_only"} onClick={() => void rescreenRejected()}>
            {busy === "rescreen" ? (language === "cn" ? "重新筛查中…" : "Re-screening…") : language === "cn" ? "重新筛查被拒回合" : "Re-screen rejected"}
          </button>
        </div>

        <div className="sp-update-actions memory-action-row memory-build-actions">
          <label className="memory-build-model">
            <span>{language === "cn" ? "构建模型" : "Build model"}</span>
            <select
              className="sp-select"
              value={buildModel}
              disabled={Boolean(busy)}
              onChange={(event) => setBuildModel(event.target.value)}
            >
              <option value="">{language === "cn" ? "跟随审查模型" : "Follow reviewer model"}</option>
              {(v2Status?.availableModels ?? []).map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </label>
          <button
            className="sp-btn sp-btn-primary"
            type="button"
            disabled={Boolean(busy) || build?.running || v2Status?.mode === "legacy_r0_only"}
            onClick={() => void startBuild()}
          >
            {busy === "build"
              ? (language === "cn" ? "启动中…" : "Starting…")
              : build?.running
                ? (language === "cn" ? "补录中…" : "Backfilling…")
                : (language === "cn" ? "补录历史记忆" : "Backfill from history")}
          </button>
        </div>
        {build && (
          <div className="memory-history-import-result" aria-live="polite">
            {language === "cn"
              ? `${build.running ? "构建中" : "已停止"} · 模型 ${build.model} · 已处理 ${build.processed}${build.failed ? `，失败 ${build.failed}` : ""} · 队列剩余 ${layerCount(v2Stats?.pending_outbox)}`
              : `${build.running ? "Building" : "Stopped"} · model ${build.model} · ${build.processed} processed${build.failed ? `, ${build.failed} failed` : ""} · ${layerCount(v2Stats?.pending_outbox)} left in queue`}
            {build.lastError && (
              <div className="memory-build-last-error">
                {language === "cn" ? "最近错误：" : "Last error: "}{build.lastError}
              </div>
            )}
          </div>
        )}
        {rescreened !== null && (
          <div className="memory-history-import-result success" aria-live="polite">
            {language === "cn"
              ? `已按当前规则重新排队 ${rescreened} 个此前被拒绝的回合。`
              : `Re-queued ${rescreened} previously rejected turns under the current rules.`}
          </div>
        )}
        {historyPreview && (
          <div className="memory-history-import-result" aria-live="polite">
            {language === "cn"
              ? `扫描到 ${historyPreview.sourceSessions} 个 Session、${historyPreview.finalTurns} 个最终回合；已捕获 ${historyPreview.alreadyCaptured}，可加入 ${historyPreview.readyToQueue}。`
              : `Found ${historyPreview.sourceSessions} Sessions and ${historyPreview.finalTurns} final turns; ${historyPreview.alreadyCaptured} already captured, ${historyPreview.readyToQueue} ready to queue.`}
          </div>
        )}
        {historyImport && (
          <div className="memory-history-import-result success" aria-live="polite">
            {language === "cn"
              ? `已将 ${historyImport.queued} 个原始回合加入 v2 待筛队列；${historyImport.alreadyCaptured} 个已存在。`
              : `Queued ${historyImport.queued} raw turns for v2 screening; ${historyImport.alreadyCaptured} were already present.`}
          </div>
        )}
      </section>

      {notice && <div className="memory-migration-summary" aria-live="polite">{notice}</div>}
      {error && <div className="sp-system-prompt-error memory-status-error" role="alert">{error}</div>}
    </div>
  );
}
