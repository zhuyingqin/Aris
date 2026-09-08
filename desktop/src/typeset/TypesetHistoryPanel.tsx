import { useCallback, useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  typesetRevisionCapture,
  typesetRevisionCompare,
  typesetRevisionExportZip,
  typesetRevisionList,
  typesetRevisionRestoreFile,
  typesetRevisionRestoreProject,
  type TypesetProjectRevisionSummary,
  type TypesetRevisionComparison,
} from "../api/tauri";
import { useStore } from "../store";
import { TYPESET_EDITOR_COPY } from "./i18n";

const operationLabel = (kind: string) => ({
  create: "新增",
  modify: "修改",
  delete: "删除",
  move: "移动",
}[kind.replace(/^comment-/, "")] ?? kind);

export default function TypesetHistoryPanel({
  path,
  onClose,
  onBeforeSnapshot,
  onRestored,
  reviewPending = false,
}: {
  path: string;
  onClose: () => void;
  /** Flushes the active in-memory source before the project manifest is read. */
  onBeforeSnapshot: () => Promise<boolean>;
  onRestored: () => Promise<void>;
  reviewPending?: boolean;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].workbench;
  const [entries, setEntries] = useState<TypesetProjectRevisionSummary[]>([]);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<TypesetRevisionComparison | null>(null);
  const [compareBaseId, setCompareBaseId] = useState("");
  const [compareTargetId, setCompareTargetId] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextEntries = await typesetRevisionList();
      setEntries(nextEntries);
      setCompareTargetId((current) => current || nextEntries[0]?.id || "");
      setCompareBaseId((current) => current || nextEntries[1]?.id || nextEntries[0]?.parentRevisionId || "");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createSnapshot = async () => {
    if (!label.trim()) return;
    setBusy("create");
    setError(null);
    try {
      if (!await onBeforeSnapshot()) return;
      await typesetRevisionCapture({
        label: label.trim(),
        reason: "manual-label",
        actor: "user",
        origin: "history",
      });
      setLabel("");
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const compare = async (entry: TypesetProjectRevisionSummary) => {
    if (!entry.parentRevisionId) return;
    setBusy(`compare:${entry.id}`);
    setError(null);
    try {
      setComparison(await typesetRevisionCompare(entry.parentRevisionId, entry.id));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const compareSelected = async () => {
    if (!compareBaseId || !compareTargetId || compareBaseId === compareTargetId) return;
    setBusy("compare:selected");
    setError(null);
    try {
      setComparison(await typesetRevisionCompare(compareBaseId, compareTargetId));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const restoreFile = async (entry: TypesetProjectRevisionSummary) => {
    setBusy(`file:${entry.id}`);
    setError(null);
    try {
      await typesetRevisionRestoreFile(entry.id, path);
      await onRestored();
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const restoreProject = async (entry: TypesetProjectRevisionSummary) => {
    if (!window.confirm("恢复整个项目会还原文件、删除后来新增的文件，并恢复评论。继续吗？")) return;
    setBusy(`project:${entry.id}`);
    setError(null);
    try {
      await typesetRevisionRestoreProject(entry.id);
      await onRestored();
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const exportZip = async (entry: TypesetProjectRevisionSummary) => {
    setBusy(`zip:${entry.id}`);
    setError(null);
    try {
      const destination = await saveDialog({
        defaultPath: `somniq-history-${entry.id}.zip`,
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
      });
      if (destination) await typesetRevisionExportZip(entry.id, destination);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="typeset-history-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="typeset-history-panel typeset-project-history-panel" role="dialog" aria-modal="true" aria-label={copy.historyTitle} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <strong>项目版本历史</strong>
            <span>整个项目的文件、二进制资源和评论；内容按哈希去重保存。</span>
          </div>
          <button type="button" aria-label={copy.historyClose} onClick={onClose}>×</button>
        </header>
        <div className="typeset-history-create">
          <input value={label} placeholder={copy.historyLabelPlaceholder} onChange={(event) => setLabel(event.target.value)} />
          <button type="button" disabled={!label.trim() || busy !== null || reviewPending} onClick={() => void createSnapshot()}>{copy.historyCreateSnapshot}</button>
        </div>
        <div className="typeset-history-compare-controls">
          <label>
            <span>起点</span>
            <select value={compareBaseId} onChange={(event) => setCompareBaseId(event.target.value)}>
              <option value="">选择版本</option>
              {entries.map((entry) => <option key={`base:${entry.id}`} value={entry.id}>{entry.label || entry.reason} · {new Date(entry.createdAtMs).toLocaleString()}</option>)}
            </select>
          </label>
          <span aria-hidden="true">→</span>
          <label>
            <span>终点</span>
            <select value={compareTargetId} onChange={(event) => setCompareTargetId(event.target.value)}>
              <option value="">选择版本</option>
              {entries.map((entry) => <option key={`target:${entry.id}`} value={entry.id}>{entry.label || entry.reason} · {new Date(entry.createdAtMs).toLocaleString()}</option>)}
            </select>
          </label>
          <button type="button" disabled={!compareBaseId || !compareTargetId || compareBaseId === compareTargetId || busy !== null} onClick={() => void compareSelected()}>比较两个版本</button>
        </div>
        {reviewPending && <p className="typeset-history-error">请先完成当前 ChangeSet 审阅，再创建或恢复版本。</p>}
        {error && <p className="typeset-history-error">{error}</p>}
        {comparison && (
          <section className="typeset-history-comparison" aria-label="Revision comparison">
            <header>
              <strong>与上一版本的比较</strong>
              <button type="button" onClick={() => setComparison(null)}>关闭</button>
            </header>
            {comparison.operations.length === 0 ? <p>没有文件内容差异。</p> : comparison.operations.map((operation) => (
              <div key={operation.id} className={`operation-${operation.kind}`}>
                <b>{operationLabel(operation.kind)}</b>
                <code>{operation.previousPath ? `${operation.previousPath} → ${operation.path}` : operation.path}</code>
              </div>
            ))}
          </section>
        )}
        <div className="typeset-history-list">
          {loading ? <p>{copy.historyLoading}</p> : entries.length === 0 ? <p>{copy.historyEmpty}</p> : entries.map((entry) => (
            <article key={entry.id}>
              <div className="typeset-history-entry-summary">
                <strong>{entry.label || entry.reason}</strong>
                <span>{new Date(entry.createdAtMs).toLocaleString()} · {entry.fileCount} files · {entry.operationCount} changes</span>
                <span>{entry.actor} · {entry.origin}</span>
              </div>
              <div className="typeset-history-entry-actions">
                <button type="button" disabled={!entry.parentRevisionId || busy !== null} onClick={() => void compare(entry)}>比较</button>
                <button type="button" disabled={busy !== null || reviewPending} onClick={() => void restoreFile(entry)}>恢复此文件</button>
                <button type="button" disabled={busy !== null || reviewPending} onClick={() => void restoreProject(entry)}>恢复项目</button>
                <button type="button" disabled={busy !== null} onClick={() => void exportZip(entry)}>ZIP</button>
              </div>
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}
