import { useEffect, useRef, useState } from "react";
import type { ChatFileChange, ChatTodoItem } from "../types";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import { EditedFilesSummary } from "./ChatMessage";
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

function stepIcon(status: ChatTodoItem["status"]) {
  if (status === "completed") return <SvgIcon name="check" size={12} />;
  if (status === "in_progress") return <SvgIcon name="spinner" size={12} />;
  return <SvgIcon name="circle" size={10} />;
}

function fileStatusLabel(status: ChatFileChange["status"]) {
  if (status === "added") return "新增";
  if (status === "deleted") return "删除";
  if (status === "renamed") return "重命名";
  return "修改";
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const total = todos.length;
  const auditedPaths = new Set(fileChangeSummary?.files.map((change) => change.path) ?? []);
  const fallbackFileChanges = fileChanges.filter((change) => !auditedPaths.has(change.path));
  const fileCount = (fileChangeSummary?.fileCount ?? 0) + fallbackFileChanges.length;
  const hasTodos = total > 0;
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
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (!hasTodos && fileCount === 0) return null;

  const stepLabel = current
    ? allDone
      ? `已完成 ${total} 步`
      : `第 ${stepNo} / ${total} 步`
    : "";
  const label = stepLabel
    ? `${stepLabel}${fileCount > 0 ? ` · ${fileCount} 文件` : ""}`
    : `已变更 ${fileCount} 文件`;
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
      className={`chat-workflow${open ? " open" : ""}${allDone ? " done" : ""}`}
      style={{ bottom: `${bottomOffset}px` }}
    >
      {open && (
        <div className="chat-workflow-panel">
          {hasTodos && (
            <div className="chat-workflow-section">
              <div className="chat-workflow-panel-head">流程</div>
              <div role="list">
                {todos.map((todo, i) => (
                  <div
                    key={i}
                    role="listitem"
                    className={`chat-workflow-step status-${todo.status}${i === index && !allDone ? " current" : ""}`}
                  >
                    <span className="chat-workflow-step-icon">{stepIcon(todo.status)}</span>
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
              <EditedFilesSummary summary={fileChangeSummary} />
            </div>
          )}
          {fallbackFileChanges.length > 0 && (
            <div className="chat-workflow-section chat-workflow-files">
              <div className="chat-workflow-panel-head">本次文件</div>
              {fallbackFileChanges.map((change) => (
                <div key={`${change.status}:${change.path}`} className={`chat-workflow-file status-${change.status}`}>
                  <span className="chat-workflow-file-icon"><SvgIcon name={fileStatusIcon(change.status)} size={12} /></span>
                  <span className="chat-workflow-file-status">{fileStatusLabel(change.status)}</span>
                  {onOpenFile ? (
                    <button
                      type="button"
                      className="chat-workflow-file-path"
                      title={displayLocalFilePath(change.path)}
                      onClick={() => onOpenFile(change.path)}
                    >
                      {displayLocalFilePath(change.path)}
                    </button>
                  ) : (
                    <span className="chat-workflow-file-path" title={displayLocalFilePath(change.path)}>
                      {displayLocalFilePath(change.path)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className="chat-workflow-chip"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={title}
      >
        <span className={`chat-workflow-chip-icon${active && !allDone ? " spin" : ""}`}>
          <SvgIcon name={chipIcon} size={13} />
        </span>
        <span className="chat-workflow-chip-label">{label}</span>
        <span className="chat-workflow-chip-caret"><SvgIcon name={open ? "chevronDown" : "chevronUp"} size={11} /></span>
      </button>
    </div>
  );
}
