import { useCallback, useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  typesetRevisionCapture,
  typesetRevisionCompare,
  typesetRevisionBlobText,
  typesetRevisionExportZip,
  typesetRevisionList,
  typesetRevisionRestoreFile,
  typesetRevisionRestoreProject,
  type TypesetProjectRevisionSummary,
  type TypesetRevisionComparison,
  type TypesetRevisionOperation,
} from "../api/tauri";
import { externalTextDiff, type ExternalTextDiff } from "../diff/externalChangeDiff";
import { useStore } from "../store";
import { languageLocale, tr, type Language } from "../language";
import { TYPESET_EDITOR_COPY } from "./i18n";

const OPERATION_LABELS: Record<Language, Record<string, string>> = {
  cn: { create: "新增", modify: "修改", delete: "删除", move: "移动" },
  en: { create: "Added", modify: "Modified", delete: "Deleted", move: "Moved" },
  es: { create: "Añadido", modify: "Modificado", delete: "Eliminado", move: "Movido" },
};

const operationLabel = (kind: string, language: Language) =>
  OPERATION_LABELS[language][kind.replace(/^comment-/, "")] ?? kind;

const operationDiffKey = (operation: TypesetRevisionOperation) =>
  `${operation.beforeHash ?? ""}:${operation.afterHash ?? ""}`;

type OperationDiff =
  | { state: "loading" }
  | { state: "binary" }
  | { state: "error"; message: string }
  | { state: "ready"; diff: ExternalTextDiff };

/** One compared file, line by line: hunks with old/new line numbers. */
function OperationLines({ diff, language }: { diff: OperationDiff | undefined; language: Language }) {
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  if (!diff || diff.state === "loading") return <p className="typeset-history-diff-note">{t("正在读取…", "Loading…", "Cargando…")}</p>;
  if (diff.state === "error") return <p className="typeset-history-error">{diff.message}</p>;
  if (diff.state === "binary") {
    return <p className="typeset-history-diff-note">{t("二进制或过大的文件，无法逐行对比。", "Binary or very large file; no line comparison.", "Archivo binario o muy grande; sin comparación por líneas.")}</p>;
  }
  const { diff: lines } = diff;
  if (lines.tooLargeToChunk) {
    return <p className="typeset-history-diff-note">{t(
      `改动太大，无法逐行展示（约 +${lines.added} −${lines.removed} 行）。`,
      `Too many changes to show line by line (about +${lines.added} −${lines.removed} lines).`,
      `Demasiados cambios para mostrarlos por líneas (unas +${lines.added} −${lines.removed} líneas).`,
    )}</p>;
  }
  if (lines.hunks.length === 0) return <p className="typeset-history-diff-note">{t("文本内容相同。", "The text is identical.", "El texto es idéntico.")}</p>;
  return (
    <div className="typeset-history-diff" role="table" aria-label={t("逐行对比", "Line comparison", "Comparación por líneas")}>
      <p className="typeset-history-diff-summary">+{lines.added} −{lines.removed}</p>
      {lines.hunks.map((hunk, hunkIndex) => (
        <div key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`} className="typeset-history-diff-hunk" role="rowgroup">
          <div className="typeset-history-diff-hunk-head" role="row">@@ −{hunk.oldStart} +{hunk.newStart} @@</div>
          {hunk.lines.map((line, lineIndex) => (
            <div key={lineIndex} className={`typeset-history-diff-line ${line.kind}`} role="row">
              <span className="old" role="cell">{line.oldLine ?? ""}</span>
              <span className="new" role="cell">{line.newLine ?? ""}</span>
              <span className="sign" role="cell" aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
              <code role="cell">{line.text || " "}</code>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

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
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  const formatTime = (epochMs: number) => new Date(epochMs).toLocaleString(languageLocale(language));
  const [entries, setEntries] = useState<TypesetProjectRevisionSummary[]>([]);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<TypesetRevisionComparison | null>(null);
  const [compareBaseId, setCompareBaseId] = useState("");
  const [compareTargetId, setCompareTargetId] = useState("");
  /** Whether the open comparison is "previous version" or two picked versions. */
  const [comparisonOfSelected, setComparisonOfSelected] = useState(false);
  /** The file whose lines are shown, and what was read for it. */
  const [openOperation, setOpenOperation] = useState<string | null>(null);
  const [operationDiffs, setOperationDiffs] = useState<Record<string, OperationDiff>>({});

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
      setComparisonOfSelected(false);
      setOpenOperation(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  /** Show (or hide) the line-by-line changes of one compared file. */
  const toggleOperation = async (operation: TypesetRevisionOperation) => {
    if (openOperation === operation.id) {
      setOpenOperation(null);
      return;
    }
    setOpenOperation(operation.id);
    // Operation ids are per path ("modify:main.tex") and repeat across
    // comparisons; the blob hashes name the exact contents being compared.
    const key = operationDiffKey(operation);
    if (operationDiffs[key] && operationDiffs[key].state !== "error") return;
    setOperationDiffs((current) => ({ ...current, [key]: { state: "loading" } }));
    try {
      const [before, after] = await Promise.all([
        operation.beforeHash ? typesetRevisionBlobText(operation.beforeHash) : Promise.resolve(""),
        operation.afterHash ? typesetRevisionBlobText(operation.afterHash) : Promise.resolve(""),
      ]);
      const result: OperationDiff = before === null || after === null
        ? { state: "binary" }
        : { state: "ready", diff: externalTextDiff(before, after) };
      setOperationDiffs((current) => ({ ...current, [key]: result }));
    } catch (reason) {
      setOperationDiffs((current) => ({ ...current, [key]: { state: "error", message: String(reason) } }));
    }
  };

  const compareSelected = async () => {
    if (!compareBaseId || !compareTargetId || compareBaseId === compareTargetId) return;
    setBusy("compare:selected");
    setError(null);
    try {
      setComparison(await typesetRevisionCompare(compareBaseId, compareTargetId));
      setComparisonOfSelected(true);
      setOpenOperation(null);
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
    if (!window.confirm(t(
      "恢复整个项目会还原文件、删除后来新增的文件，并恢复评论。继续吗？",
      "Restoring the whole project reverts files, deletes files added since, and restores comments. Continue?",
      "Restaurar todo el proyecto revierte los archivos, elimina los archivos añadidos después y restaura los comentarios. ¿Continuar?",
    ))) return;
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
        filters: [{ name: t("ZIP 压缩包", "ZIP archive", "Archivo ZIP"), extensions: ["zip"] }],
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
            <strong>{t("项目版本历史", "Project version history", "Historial de versiones del proyecto")}</strong>
            <span>{t(
              "整个项目的文件、二进制资源和评论；内容按哈希去重保存。",
              "Files, binary assets and comments for the whole project; content is deduplicated by hash.",
              "Archivos, recursos binarios y comentarios de todo el proyecto; el contenido se guarda sin duplicados por hash.",
            )}</span>
          </div>
          <button type="button" aria-label={copy.historyClose} onClick={onClose}>×</button>
        </header>
        <div className="typeset-history-create">
          <input value={label} placeholder={copy.historyLabelPlaceholder} onChange={(event) => setLabel(event.target.value)} />
          <button type="button" disabled={!label.trim() || busy !== null || reviewPending} onClick={() => void createSnapshot()}>{copy.historyCreateSnapshot}</button>
        </div>
        <div className="typeset-history-compare-controls">
          <label>
            <span>{t("起点", "From", "Desde")}</span>
            <select value={compareBaseId} onChange={(event) => setCompareBaseId(event.target.value)}>
              <option value="">{t("选择版本", "Select a version", "Selecciona una versión")}</option>
              {entries.map((entry) => <option key={`base:${entry.id}`} value={entry.id}>{entry.label || entry.reason} · {formatTime(entry.createdAtMs)}</option>)}
            </select>
          </label>
          <span aria-hidden="true">→</span>
          <label>
            <span>{t("终点", "To", "Hasta")}</span>
            <select value={compareTargetId} onChange={(event) => setCompareTargetId(event.target.value)}>
              <option value="">{t("选择版本", "Select a version", "Selecciona una versión")}</option>
              {entries.map((entry) => <option key={`target:${entry.id}`} value={entry.id}>{entry.label || entry.reason} · {formatTime(entry.createdAtMs)}</option>)}
            </select>
          </label>
          <button type="button" disabled={!compareBaseId || !compareTargetId || compareBaseId === compareTargetId || busy !== null} onClick={() => void compareSelected()}>{t("比较两个版本", "Compare versions", "Comparar versiones")}</button>
        </div>
        {reviewPending && <p className="typeset-history-error">{t(
          "请先完成当前 ChangeSet 审阅，再创建或恢复版本。",
          "Finish reviewing the current ChangeSet before creating or restoring a version.",
          "Termina de revisar el ChangeSet actual antes de crear o restaurar una versión.",
        )}</p>}
        {error && <p className="typeset-history-error">{error}</p>}
        {comparison && (
          <section className="typeset-history-comparison" aria-label={t("版本比较", "Version comparison", "Comparación de versiones")}>
            <header>
              <strong>{comparisonOfSelected
                ? t("所选两个版本的比较", "Comparison of the selected versions", "Comparación de las versiones seleccionadas")
                : t("与上一版本的比较", "Comparison with the previous version", "Comparación con la versión anterior")}</strong>
              <button type="button" onClick={() => setComparison(null)}>{t("关闭", "Close", "Cerrar")}</button>
            </header>
            {comparison.operations.length === 0 ? <p>{t("没有文件内容差异。", "No file content differences.", "No hay diferencias en el contenido de los archivos.")}</p> : comparison.operations.map((operation) => {
              const lineDiffable = !operation.kind.startsWith("comment-") && (operation.beforeHash || operation.afterHash);
              const open = openOperation === operation.id;
              return (
                <div key={operation.id} className={`operation-${operation.kind}${open ? " open" : ""}`}>
                  {lineDiffable ? (
                    <button type="button" className="typeset-history-operation-toggle" aria-expanded={open} onClick={() => void toggleOperation(operation)}>
                      <b>{operationLabel(operation.kind, language)}</b>
                      <code>{operation.previousPath ? `${operation.previousPath} → ${operation.path}` : operation.path}</code>
                    </button>
                  ) : (
                    <>
                      <b>{operationLabel(operation.kind, language)}</b>
                      <code>{operation.previousPath ? `${operation.previousPath} → ${operation.path}` : operation.path}</code>
                    </>
                  )}
                  {open && <OperationLines diff={operationDiffs[operationDiffKey(operation)]} language={language} />}
                </div>
              );
            })}
          </section>
        )}
        <div className="typeset-history-list">
          {loading ? <p>{copy.historyLoading}</p> : entries.length === 0 ? <p>{copy.historyEmpty}</p> : entries.map((entry) => (
            <article key={entry.id}>
              <div className="typeset-history-entry-summary">
                <strong>{entry.label || entry.reason}</strong>
                <span>{formatTime(entry.createdAtMs)} · {t(
                  `${entry.fileCount} 个文件 · ${entry.operationCount} 处修改`,
                  `${entry.fileCount} ${entry.fileCount === 1 ? "file" : "files"} · ${entry.operationCount} ${entry.operationCount === 1 ? "change" : "changes"}`,
                  `${entry.fileCount} archivos · ${entry.operationCount} cambios`,
                )}</span>
                <span>{entry.actor} · {entry.origin}</span>
              </div>
              <div className="typeset-history-entry-actions">
                <button type="button" disabled={!entry.parentRevisionId || busy !== null} onClick={() => void compare(entry)}>{t("比较", "Compare", "Comparar")}</button>
                <button type="button" disabled={busy !== null || reviewPending} onClick={() => void restoreFile(entry)}>{t("恢复此文件", "Restore this file", "Restaurar este archivo")}</button>
                <button type="button" disabled={busy !== null || reviewPending} onClick={() => void restoreProject(entry)}>{t("恢复项目", "Restore project", "Restaurar proyecto")}</button>
                <button type="button" disabled={busy !== null} onClick={() => void exportZip(entry)}>ZIP</button>
              </div>
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}
