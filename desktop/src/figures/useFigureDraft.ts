import { useEffect, useRef, useState } from "react";
import { figureSaveDraft } from "./figureApi";
import type { FigureEditingDraft } from "./types";

type Base = Pick<FigureEditingDraft, "expectedHash" | "baseIndex">;
type DraftStatus = "idle" | "pending" | "saving" | "saved" | "error";

export default function useFigureDraft(input: {
  projectId: string | null; id: string | null; blocked: boolean;
  readSvg: () => Promise<string>; onError: (error: string) => void; onSaved: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [unsaved, setUnsaved] = useState(false);
  const [status, setStatus] = useState<DraftStatus>("idle");
  const unsavedRef = useRef(false);
  const base = useRef<Base | null>(null);
  const epoch = useRef(0);
  const revisionRef = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const callbacks = useRef(input); callbacks.current = input;

  const restore = (draft: FigureEditingDraft | null = null) => {
    epoch.current++;
    base.current = draft && { expectedHash: draft.expectedHash, baseIndex: draft.baseIndex };
    unsavedRef.current = false; setUnsaved(false);
    setStatus(draft ? "saved" : "idle");
  };
  const changed = (parent: Base) => {
    base.current ??= parent;
    unsavedRef.current = true; setUnsaved(true); setStatus("pending");
    setRevision(++revisionRef.current);
  };
  // Manual save/discard waits for prior writes. A late autosave can never
  // recreate a discarded draft or clear the unsaved state of newer edits.
  const settle = async () => {
    epoch.current++;
    await inFlight.current;
  };

  useEffect(() => {
    if (!input.projectId || !input.id || input.blocked || !unsavedRef.current) return;
    const projectId = input.projectId, id = input.id;
    const owner = epoch.current, edit = revisionRef.current;
    const timer = setTimeout(() => {
      const previous = inFlight.current;
      const task = (async () => {
        await previous;
        if (owner !== epoch.current || edit !== revisionRef.current) return;
        setStatus("saving");
        try {
          const svg = await callbacks.current.readSvg();
          if (owner !== epoch.current || edit !== revisionRef.current) return;
          const parent = base.current!;
          await figureSaveDraft(projectId, id, parent.expectedHash, svg, parent.baseIndex);
          if (owner !== epoch.current || edit !== revisionRef.current) return;
          unsavedRef.current = false; setUnsaved(false); setStatus("saved");
          callbacks.current.onSaved();
        } catch (error) {
          if (owner !== epoch.current || edit !== revisionRef.current) return;
          setStatus("error"); callbacks.current.onError(String(error));
        }
      })();
      inFlight.current = task;
      void task.finally(() => { if (inFlight.current === task) inFlight.current = null; });
    }, 750);
    return () => clearTimeout(timer);
  }, [input.projectId, input.id, input.blocked, revision]);

  useEffect(() => () => { epoch.current++; }, []);
  return { unsaved, unsavedRef, status, base, changed, restore, settle };
}
