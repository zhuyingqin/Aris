import { useCallback } from "react";
import { codeBridgeOpenFile, fileOpen } from "../api/tauri";
import { workspaceFileOpenTarget } from "../editor/workspaceFiles";
import { useStore } from "../store";

export interface ChatEvidenceReference {
  paperId: string;
  page: number;
  citation: string;
  pdfPath: string;
  quotes: string[];
}

let evidenceRequestSequence = 0;

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
  const setPendingTypesetFilePath = useStore((state) => state.setPendingTypesetFilePath);
  const setPendingSidePanelFilePath = useStore((state) => state.setPendingSidePanelFilePath);
  const setError = useStore((state) => state.setError);

  return useCallback((path: string) => {
    const target = workspaceFileOpenTarget(path);
    if (target === "code") {
      // The workbench owns its own tab strip, so the file has to be requested
      // over the bridge rather than handed to the pane through the store.
      void codeBridgeOpenFile(path);
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
  }, [setError, setPendingSidePanelFilePath, setPendingTypesetFilePath, setTab]);
}

/** Route a structured paper citation into Chat's existing PDF side viewer. */
export function useOpenChatEvidence(): (evidence: ChatEvidenceReference) => void {
  const setTab = useStore((state) => state.setTab);
  const setPendingSidePanelEvidence = useStore((state) => state.setPendingSidePanelEvidence);

  return useCallback((evidence: ChatEvidenceReference) => {
    evidenceRequestSequence += 1;
    setPendingSidePanelEvidence({
      path: evidence.pdfPath,
      paperId: evidence.paperId,
      page: Math.max(1, Math.trunc(evidence.page)),
      citation: evidence.citation,
      quotes: evidence.quotes.map((quote) => quote.trim()).filter(Boolean),
      requestKey: `chat-evidence-${Date.now()}-${evidenceRequestSequence}`,
    });
    setTab("chat");
  }, [setPendingSidePanelEvidence, setTab]);
}
