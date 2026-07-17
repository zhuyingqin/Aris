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

export function shouldPreventDesktopClose(
  hasUnsavedChanges: boolean,
  confirmDiscard: () => boolean,
): boolean {
  return hasUnsavedChanges && !confirmDiscard();
}
