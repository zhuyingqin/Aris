import { useCallback } from "react";
import { fileOpen } from "../api/tauri";
import { workspaceFileOpenTarget } from "../lab/labEditorCore";
import { useStore } from "../store";

/**
 * One routing rule for every file a user clicks inside Chat — tool cards,
 * edited-file summaries, markdown links, the workflow strip and the path menu.
 *
 * Editable sources take over their workspace tab (Code for code, LaTeX for
 * `.tex`), while read-only material (PDF) opens as a reading tab in Chat's side
 * panel so the conversation stays visible. Anything SomniQ cannot render falls
 * back to the operating system.
 */
export function useOpenChatFile(): (path: string) => void {
  const setTab = useStore((state) => state.setTab);
  const setPendingLabFilePath = useStore((state) => state.setPendingLabFilePath);
  const setPendingTypesetFilePath = useStore((state) => state.setPendingTypesetFilePath);
  const setPendingSidePanelFilePath = useStore((state) => state.setPendingSidePanelFilePath);
  const setError = useStore((state) => state.setError);

  return useCallback((path: string) => {
    const target = workspaceFileOpenTarget(path);
    if (target === "code") {
      setPendingLabFilePath(path);
      setTab("lab");
      return;
    }
    if (target === "pdf") {
      setPendingSidePanelFilePath(path);
      setTab("chat");
      return;
    }
    if (target === "latex") {
      setPendingTypesetFilePath(path);
      setTab("typeset");
      return;
    }
    void fileOpen(path).catch((error) => setError(String(error)));
  }, [setError, setPendingLabFilePath, setPendingSidePanelFilePath, setPendingTypesetFilePath, setTab]);
}
