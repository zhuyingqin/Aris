import { useEffect, useMemo, useState } from "react";

import {
  configGet,
  configSet,
  isTauri,
  memoryConnectionTest,
  memoryDeadLetters,
  memoryMigrationCancel,
  memoryMigrationExecute,
  memoryMigrationProgress,
  memoryMigrationPreview,
  memoryRestart,
  memoryStart,
  memoryStatus,
  memoryStop,
} from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import type {
  ConfigView,
  MemoryDeadLetterView,
  MemoryMigrationPreview,
  MemoryMigrationProgress,
  MemoryMigrationResult,
  MemoryStatusView,
} from "../types";
import { useStore, type Language } from "../store";
import MemoryExplorer from "./MemoryExplorer";
import MemoryRecallPreview from "./MemoryRecallPreview";

const PREVIEW_STATUS: MemoryStatusView = {
  mode: "builtin",
  defaultMode: "builtin",
  projectId: "default",
  componentVersion: "v2.0.0",
  componentCommit: "0aff21a2d9f2b8a0354aaa80a2e586aab4054562",
  status: "stopped",
  dataPath: "~/.config/SomniQ/memory/tencentdb/data",
  logPath: "~/.config/SomniQ/memory/logs/tencentdb-memory.log",
  recallStrategy: "keyword",
  outboxPending: 0,
  deadLetter: 0,
};

interface Props {
  language: Language;
  initialConfig: ConfigView;
}

export default function MemorySettings({ language, initialConfig }: Props) {
  const cn = language === "cn";
  const currentProject = useStore((state) => state.currentProject);
  const [config, setConfig] = useState(initialConfig);
  const [status, setStatus] = useState<MemoryStatusView>(() =>
    isTauri() ? { ...PREVIEW_STATUS, mode: initialConfig.memoryProviderMode } : PREVIEW_STATUS,
  );
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [connectionOk, setConnectionOk] = useState(false);
  const [migration, setMigration] = useState<MemoryMigrationPreview | null>(null);
  const [migrationResult, setMigrationResult] = useState<MemoryMigrationResult | null>(null);
  const [migrationProgress, setMigrationProgress] = useState<MemoryMigrationProgress | null>(null);
  const [deadLetters, setDeadLetters] = useState<MemoryDeadLetterView[]>([]);

  const compatibleModels = useMemo(
    () =>
      (config.verifiedExecutors ?? [])
        .filter((entry) => entry.provider === "openai" || entry.provider === "custom")
        .map((entry) => entry.model)
        .filter((model, index, models) => models.indexOf(model) === index),
    [config.verifiedExecutors],
  );
  const hasCompatibleModel = compatibleModels.length > 0
    || ((config.summarizerProvider === "openai" || config.summarizerProvider === "custom")
      && Boolean(config.summarizerModel && config.summarizerModel !== "off" && config.hasSummarizerKey))
    || ((config.executorProvider === "openai" || config.executorProvider === "custom")
      && Boolean(config.executorModel && config.hasExecutorKey));
  const activeProjectId = currentProject?.id ?? status.projectId ?? "default";
  const projectOverride = config.memoryProjectModes?.[activeProjectId];
  const effectiveMode = projectOverride ?? config.memoryProviderMode;
  const componentLabel = effectiveMode === "builtin"
    ? (cn ? "SomniQ 科研记忆" : "SomniQ Research Memory")
    : "TencentDB Memory Core";

  const run = async (label: string, operation: () => Promise<MemoryStatusView>) => {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      const next = isTauri() ? await operation() : PREVIEW_STATUS;
      setStatus(next);
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const refresh = async () => {
    if (!isTauri()) return;
    try {
      const [nextConfig, nextStatus, nextDeadLetters] = await Promise.all([
        configGet(),
        memoryStatus(),
        memoryDeadLetters().catch(() => []),
      ]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setDeadLetters(nextDeadLetters);
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const savePatch = async (patch: Parameters<typeof configSet>[0]) => {
    setBusy("save");
    setError("");
    try {
      const next = isTauri() ? await configSet(patch) : ({ ...config, ...patch } as ConfigView);
      setConfig(next);
      const hasExternalProject = Object.values(next.memoryProjectModes ?? {})
        .some((mode) => mode !== "builtin");
      if (isTauri() && next.memoryProviderMode === "builtin" && !hasExternalProject) {
        setStatus(await memoryStop());
      } else {
        const nextEffectiveMode = next.memoryProjectModes?.[activeProjectId] ?? next.memoryProviderMode;
        setStatus((current) => ({
          ...current,
          mode: nextEffectiveMode,
          defaultMode: next.memoryProviderMode,
          projectId: activeProjectId,
          projectOverride: next.memoryProjectModes?.[activeProjectId] ?? null,
          recallStrategy: next.memoryRecallStrategy,
          memoryModel: next.memoryModel,
        }));
      }
      setMessage(cn ? "记忆设置已保存。" : "Memory settings saved.");
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const saveProjectOverride = async (mode: "inherit" | "builtin" | "tencentdb") => {
    const next = { ...(config.memoryProjectModes ?? {}) };
    if (mode === "inherit") delete next[activeProjectId];
    else next[activeProjectId] = mode;
    await savePatch({ memoryProjectModes: next });
  };

  const testConnection = async () => {
    setBusy("test");
    setError("");
    setMessage("");
    try {
      const result = isTauri() ? await memoryConnectionTest() : "Preview connection is healthy";
      setConnectionOk(true);
      setMessage(result);
      if (isTauri()) setStatus(await memoryStatus());
    } catch (reason) {
      setConnectionOk(false);
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const previewMigration = async () => {
    setBusy("preview");
    setError("");
    try {
      setMigration(
        isTauri()
          ? await memoryMigrationPreview()
          : { hotMemoryEntries: 4, knowledgeFiles: 2, sessionFiles: 8, alreadyMigrated: 0 },
      );
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const executeMigration = async () => {
    setBusy("migrate");
    setError("");
    setMigrationResult(null);
    setMigrationProgress({
      running: true,
      phase: "starting",
      completedItems: 0,
      totalItems: migration
        ? (effectiveMode === "builtin"
          ? migration.sessionFiles
          : migration.hotMemoryEntries + migration.knowledgeFiles + migration.sessionFiles)
        : 0,
      lastError: null,
    });
    try {
      const result = isTauri()
        ? await memoryMigrationExecute()
        : {
            importedHotMemory: 4,
            importedKnowledgeFiles: 2,
            importedSessions: 8,
            importedMessages: 32,
            skipped: 0,
            cancelled: false,
          };
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

  return (
    <div className="sp-general-page memory-settings-page">
      <div className="sp-status-bar">
        <div className="sp-status-slot">
          <span className={`memory-health-dot memory-health-${status.status}`} />
          <span className="sp-status-model">{componentLabel} {status.componentVersion}</span>
          <span className="sp-status-url">
            {status.status}{status.port ? ` · 127.0.0.1:${status.port}` : ""}
          </span>
        </div>
        <div className="sp-status-sep" />
        <div className="sp-status-slot">
          <span className="sp-status-tag">{cn ? "模式" : "Mode"}</span>
          <span className="sp-status-model">{effectiveMode}</span>
        </div>
      </div>

      <div className="sp-update-section">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{cn ? "Provider 与提炼模型" : "Provider and extraction model"}</div>
            <div className="sp-section-sub">
              {cn
                ? "builtin 使用 SomniQ 本地科研记忆；tencentdb 使用 Memory Core 召回，并在异常时自动回退到 builtin。"
                : "Builtin uses SomniQ's local research memory; TencentDB recalls through Memory Core and automatically falls back to builtin on failure."}
            </div>
          </div>
        </div>
        <div className="memory-settings-grid">
          <label>
            <span>{cn ? "默认 Provider 模式" : "Default provider mode"}</span>
            <select
              className="sp-settings-select"
              value={config.memoryProviderMode}
              disabled={Boolean(busy)}
              onChange={(event) => void savePatch({ memoryProviderMode: event.target.value as "builtin" | "tencentdb" })}
            >
              <option value="builtin">builtin</option>
              <option value="tencentdb" disabled={!hasCompatibleModel}>tencentdb</option>
            </select>
          </label>
          <label>
            <span>{cn ? "当前项目模式" : "Current project mode"}</span>
            <select
              className="sp-settings-select"
              value={projectOverride ?? "inherit"}
              disabled={Boolean(busy)}
              onChange={(event) => void saveProjectOverride(event.target.value as "inherit" | "builtin" | "tencentdb")}
            >
              <option value="inherit">{cn ? `继承默认 (${config.memoryProviderMode})` : `Inherit default (${config.memoryProviderMode})`}</option>
              <option value="builtin">builtin</option>
              <option value="tencentdb" disabled={!hasCompatibleModel}>tencentdb</option>
            </select>
            <small>{currentProject?.name ?? activeProjectId}</small>
          </label>
          <label>
            <span>{cn ? "记忆提炼模型" : "Memory model"}</span>
            <select
              className="sp-settings-select"
              value={config.memoryModel ?? ""}
              disabled={Boolean(busy)}
              onChange={(event) => void savePatch({ memoryModel: event.target.value })}
            >
              <option value="">{cn ? "自动（summarizer / Executor）" : "Auto (summarizer / Executor)"}</option>
              {compatibleModels.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>
          <label>
            <span>{cn ? "召回策略" : "Recall strategy"}</span>
            <select
              className="sp-settings-select"
              value={config.memoryRecallStrategy}
              disabled={Boolean(busy)}
              onChange={(event) => void savePatch({ memoryRecallStrategy: event.target.value as "keyword" | "hybrid" })}
            >
              <option value="keyword">keyword / BM25</option>
              <option value="hybrid" disabled={!connectionOk}>hybrid</option>
            </select>
          </label>
        </div>
        {!hasCompatibleModel && <div className="sp-system-prompt-error">{cn ? "启用 TencentDB 前，请先在模型设置中验证一个 OpenAI-compatible Executor 或 summarizer。" : "Verify an OpenAI-compatible Executor or summarizer before enabling TencentDB."}</div>}
        <div className="sp-update-actions memory-action-row">
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy) || effectiveMode === "builtin"} onClick={() => void run("start", memoryStart)}>{cn ? "启动" : "Start"}</button>
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy) || effectiveMode === "builtin"} onClick={() => void run("stop", memoryStop)}>{cn ? "停止" : "Stop"}</button>
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy) || effectiveMode === "builtin"} onClick={() => void run("restart", memoryRestart)}>{cn ? "重启" : "Restart"}</button>
          <button className="sp-btn sp-btn-primary" type="button" disabled={Boolean(busy) || effectiveMode === "builtin"} onClick={() => void testConnection()}>{cn ? "连接测试" : "Connection test"}</button>
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void refresh()}>{cn ? "刷新" : "Refresh"}</button>
        </div>
      </div>

      <MemoryExplorer
        language={language}
        enabled
        projectId={activeProjectId}
        providerMode={effectiveMode}
        onChanged={() => void refresh()}
      />

      <MemoryRecallPreview
        language={language}
        projectId={activeProjectId}
        providerMode={effectiveMode}
      />

      {deadLetters.length > 0 && (
        <div className="sp-update-section" aria-label="memory dead letters">
          <div className="sp-section-head">
            <div className="sp-section-head-text">
              <div className="sp-section-title">
                {cn ? `需要处理的记忆任务 (${deadLetters.length})` : `Memory tasks needing attention (${deadLetters.length})`}
              </div>
              <div className="sp-section-sub">
                {cn
                  ? "这些内置记忆任务已重试多次仍未成功；原始会话不会被删除。"
                  : "These builtin memory tasks exhausted their retries; their source sessions remain intact."}
              </div>
            </div>
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
            <div className="sp-section-title">{cn ? "历史迁移" : "History migration"}</div>
            <div className="sp-section-sub">
              {effectiveMode === "builtin"
                ? (cn
                  ? "新完成的普通对话会自动提炼 R1–R3；这里用于安全回填已有历史。工作流 Session 会被排除，不修改或删除原始对话。"
                  : "Backfills R1–R3 from ordinary authoritative Sessions; Workflow Sessions are excluded and original chats remain unchanged.")
                : (cn
                  ? "从 SomniQ 权威文件和 Session 导入；不会直接修改腾讯 SQLite，也不会删除旧数据。"
                  : "Imports from authoritative SomniQ files and Sessions without editing TencentDB SQLite or deleting old data.")}
            </div>
          </div>
        </div>
        <div className="sp-update-actions memory-action-row">
          <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void previewMigration()}>{cn ? "迁移预览" : "Preview"}</button>
          <button className="sp-btn sp-btn-primary" type="button" disabled={Boolean(busy)} onClick={() => void executeMigration()}>{effectiveMode === "builtin" ? (cn ? "回填历史" : "Backfill history") : (cn ? "执行迁移" : "Run migration")}</button>
          <button className="sp-btn sp-btn-secondary" type="button" disabled={busy !== "migrate"} onClick={() => void memoryMigrationCancel()}>{cn ? "取消" : "Cancel"}</button>
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
            {effectiveMode === "builtin"
              ? <>{cn ? "待检查" : "Preview"}: {migration.sessionFiles} sessions · {migration.alreadyMigrated} {cn ? "已回填" : "already backfilled"}</>
              : <>{cn ? "待检查" : "Preview"}: {migration.hotMemoryEntries} hot memory · {migration.knowledgeFiles} notes · {migration.sessionFiles} sessions · {migration.alreadyMigrated} {cn ? "已迁移" : "already migrated"}</>}
          </div>
        )}
        {migrationResult && (
          <div className="memory-migration-summary">
            {effectiveMode === "builtin"
              ? <>{cn ? "完成" : "Completed"}: {migrationResult.importedSessions} sessions / {migrationResult.importedMessages} messages · {migrationResult.skipped} skipped{migrationResult.cancelled ? ` · ${cn ? "已取消" : "cancelled"}` : ""}</>
              : <>{cn ? "完成" : "Completed"}: {migrationResult.importedHotMemory} hot memory · {migrationResult.importedKnowledgeFiles} notes · {migrationResult.importedSessions} sessions / {migrationResult.importedMessages} messages · {migrationResult.skipped} skipped{migrationResult.cancelled ? ` · ${cn ? "已取消" : "cancelled"}` : ""}</>}
          </div>
        )}
      </div>

      {message && <div className="memory-settings-message">{message}</div>}
      {error && <div className="sp-system-prompt-error">{error}</div>}
    </div>
  );
}
