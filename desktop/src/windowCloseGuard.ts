/**
 * Browsers and the Tauri desktop shell expose different close lifecycles.
 * Installing both guards in Tauri makes an approved `close-requested` event
 * fall through to `beforeunload`, where it is blocked a second time.
 */
export function installBrowserUnsavedChangesGuard(
  isDesktop: boolean,
  hasUnsavedChanges: () => boolean,
): () => void {
  if (isDesktop) return () => undefined;

  const handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", handleBeforeUnload);
  return () => window.removeEventListener("beforeunload", handleBeforeUnload);
}

export interface DesktopCloseHazards {
  hasUnsavedChanges: boolean;
  /** Active, non-cancelled conversation turns owned by this desktop instance. */
  runningConversationCount: number;
  runningFigureCount?: number;
  hasUnsavedFigureChanges?: boolean;
}

export function desktopCloseConfirmationMessage(
  language: "cn" | "en",
  { hasUnsavedChanges, runningConversationCount, runningFigureCount = 0, hasUnsavedFigureChanges = false }: DesktopCloseHazards,
): string {
  const count = Math.max(0, Math.trunc(runningConversationCount));
  const figures = Math.max(0, Math.trunc(runningFigureCount));
  if (figures > 0 || hasUnsavedFigureChanges) {
    const total = count + figures;
    return language === "cn"
      ? `${total > 0 ? `当前有 ${total} 个任务仍在运行。` : ""}${hasUnsavedChanges ? "有未保存的绘图或文档修改。" : ""}关闭 SomniQ Studio 会中断正在执行的任务并丢弃未保存修改。仍要关闭吗？`
      : `${total > 0 ? `${total} task${total === 1 ? " is" : "s are"} still running. ` : ""}${hasUnsavedChanges ? "There are unsaved figure or document changes. " : ""}Closing SomniQ Studio interrupts active tasks and discards unsaved changes. Close anyway?`;
  }
  if (language === "cn") {
    if (count > 0 && hasUnsavedChanges) {
      return `当前有 ${count} 个对话仍在运行，且有未保存的 LaTeX 修改。关闭 SomniQ Studio 会中断对话并丢弃未保存修改。仍要关闭吗？`;
    }
    if (count > 0) {
      return `当前有 ${count} 个对话仍在运行。关闭 SomniQ Studio 会中断其生成和工具执行。仍要关闭吗？`;
    }
    return "有未保存的 LaTeX 修改。关闭 SomniQ Studio 会丢弃这些修改。仍要关闭吗？";
  }

  if (count > 0 && hasUnsavedChanges) {
    return `${count} conversation${count === 1 ? " is" : "s are"} still running, and there are unsaved LaTeX changes. Closing SomniQ Studio will interrupt the conversations and discard those changes. Close anyway?`;
  }
  if (count > 0) {
    return `${count} conversation${count === 1 ? " is" : "s are"} still running. Closing SomniQ Studio will interrupt its generation and tool execution. Close anyway?`;
  }
  return "Discard the unsaved LaTeX changes and close SomniQ Studio?";
}

export function shouldPreventDesktopClose(
  { hasUnsavedChanges, runningConversationCount, runningFigureCount = 0 }: DesktopCloseHazards,
  confirmClose: () => boolean,
): boolean {
  return (hasUnsavedChanges || runningConversationCount > 0 || runningFigureCount > 0) && !confirmClose();
}
