import { useEffect, useId, useRef, useState } from "react";
import type { ChatFileChange, ChatTodoItem } from "../types";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import { useStore } from "../store";
import { EditedFilesSummary } from "./ChatMessage";
import LocalFileLabel from "./LocalFileLabel";
import type { TurnFileChangeSummary } from "./toolSummaries";
import { displayLocalFilePath } from "./localFileLinks";

interface Props {
  todos: ChatTodoItem[];
  fileChanges: ChatFileChange[];
  fileChangeSummary?: TurnFileChangeSummary | null;
  bottomOffset: number;
  /** True while the assistant is still streaming this turn. */
  active: boolean;
  onOpenFile?: (path: string) => void;
}

function stepIcon(status: ChatTodoItem["status"], index: number) {
  if (status === "completed") return <SvgIcon name="check" size={12} />;
  if (status === "in_progress") return <SvgIcon name="spinner" size={12} />;
  return index + 1;
}

function fileStatusLabel(status: ChatFileChange["status"], isChinese: boolean) {
  if (status === "added") return isChinese ? "新增" : "Added";
  if (status === "deleted") return isChinese ? "删除" : "Deleted";
  if (status === "renamed") return isChinese ? "重命名" : "Renamed";
  return isChinese ? "修改" : "Modified";
}

function fileStatusIcon(status: ChatFileChange["status"]): SvgIconName {
  if (status === "added") return "plus";
  if (status === "deleted") return "minus";
  if (status === "renamed") return "externalLink";
  return "modified";
}

// The "current" step: the one in progress, else the first not-yet-done step,
// else the last step once everything is complete.
function currentIndex(todos: ChatTodoItem[]): number {
  const running = todos.findIndex((todo) => todo.status === "in_progress");
  if (running >= 0) return running;
  const pending = todos.findIndex((todo) => todo.status !== "completed");
  if (pending >= 0) return pending;
  return todos.length - 1;
}

export default function WorkflowFlow({
  todos,
  fileChanges,
  fileChangeSummary,
  bottomOffset,
  active,
  onOpenFile,
}: Props) {
  const isChinese = useStore((state) => state.language) === "cn";
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const total = todos.length;
  const auditedPaths = new Set(fileChangeSummary?.files.map((change) => change.path) ?? []);
  const fallbackFileChanges = fileChanges.filter((change) => !auditedPaths.has(change.path));
  const fileCount = (fileChangeSummary?.fileCount ?? 0) + fallbackFileChanges.length;
  const hasTodos = total > 0;
  const completedCount = todos.filter((todo) => todo.status === "completed").length;
  const allDone = total > 0 && todos.every((todo) => todo.status === "completed");
  const index = hasTodos ? currentIndex(todos) : -1;
  const current = index >= 0 ? todos[index] : null;
  const stepNo = index + 1;

  // Collapse when clicking elsewhere, so the box never traps focus over the thread.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      chipRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!hasTodos && fileCount === 0) return null;

  const stepLabel = current
    ? allDone
      ? (isChinese ? `已完成 ${total} 步` : `${total} ${total === 1 ? "step" : "steps"} complete`)
      : (isChinese ? `第 ${stepNo} / ${total} 步` : `Step ${stepNo} / ${total}`)
    : "";
  const fileLabel = isChinese ? `${fileCount} 个文件` : `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  const label = stepLabel
    ? `${stepLabel}${fileCount > 0 ? ` · ${fileLabel}` : ""}`
    : (isChinese ? `已变更 ${fileLabel}` : `${fileLabel} changed`);
  const titlePaths = [
    ...(fileChangeSummary?.files.map((change) => change.path) ?? []),
    ...fallbackFileChanges.map((change) => change.path),
  ].map(displayLocalFilePath);
  const title = current
    ? current.status === "in_progress" ? current.activeForm : current.content
    : titlePaths.join("\n");
  const chipIcon: SvgIconName = hasTodos ? (allDone ? "check" : "spinner") : "modified";

  return (
    <div
      ref={rootRef}
      className={`chat-workflow${open ? " open" : ""}${allDone ? " done" : ""}${active ? " active" : ""}`}
      style={{ bottom: `${bottomOffset}px`, maxHeight: `calc(100% - ${bottomOffset + 16}px)` }}
    >
      {open && (
        <div id={panelId} className="chat-workflow-panel" role="region" aria-label={isChinese ? "流程与文件" : "Progress and files"}>
          {hasTodos && (
            <div className="chat-workflow-section">
              <div className="chat-workflow-panel-head">
                <span>{isChinese ? "流程" : "Progress"}</span>
                <span className="chat-workflow-panel-meta">
                  {isChinese ? `已完成 ${completedCount} / ${total} 步` : `${completedCount} / ${total} complete`}
                </span>
              </div>
              <div role="list">
                {todos.map((todo, i) => (
                  <div
                    key={i}
                    role="listitem"
                    aria-current={i === index && !allDone ? "step" : undefined}
                    className={`chat-workflow-step status-${todo.status}${i === index && !allDone ? " current" : ""}`}
                  >
                    <span className="chat-workflow-step-icon" aria-hidden="true">{stepIcon(todo.status, i)}</span>
                    <span className="chat-workflow-step-text">
                      {todo.status === "in_progress" ? todo.activeForm : todo.content}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {fileChangeSummary && (
            <div className="chat-workflow-section chat-workflow-files">
              <EditedFilesSummary summary={fileChangeSummary} compact />
            </div>
          )}
          {fallbackFileChanges.length > 0 && (
            <div className="chat-workflow-section chat-workflow-files">
              <div className="chat-workflow-panel-head">
                <span>{isChinese ? "本次文件" : "Changed files"}</span>
                <span className="chat-workflow-panel-meta">{fallbackFileChanges.length}</span>
              </div>
              {fallbackFileChanges.map((change) => (
                <div key={`${change.status}:${change.path}`} className={`chat-workflow-file status-${change.status}`}>
                  <span className="chat-workflow-file-icon" aria-hidden="true"><SvgIcon name={fileStatusIcon(change.status)} size={13} /></span>
                  {onOpenFile ? (
                    <button
                      type="button"
                      className="chat-workflow-file-path"
                      title={displayLocalFilePath(change.path)}
                      aria-label={displayLocalFilePath(change.path)}
                      onClick={() => onOpenFile(change.path)}
                    >
                      <LocalFileLabel path={change.path} />
                    </button>
                  ) : (
                    <span className="chat-workflow-file-path" title={displayLocalFilePath(change.path)}>
                      <LocalFileLabel path={change.path} />
                    </span>
                  )}
                  <span className="chat-workflow-file-status">{fileStatusLabel(change.status, isChinese)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <button
        ref={chipRef}
        type="button"
        className="chat-workflow-chip"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        title={title}
      >
        <span className={`chat-workflow-chip-icon${active && !allDone ? " spin" : ""}`}>
          <SvgIcon name={chipIcon} size={13} />
        </span>
        <span className="chat-workflow-chip-label">{stepLabel || label}</span>
        {stepLabel && fileCount > 0 && <span className="chat-workflow-chip-files">· {fileLabel}</span>}
        <span className="chat-workflow-chip-caret"><SvgIcon name={open ? "chevronDown" : "chevronUp"} size={11} /></span>
      </button>
    </div>
  );
}
