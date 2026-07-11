import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { createSharedEditorView, reconfigureLanguage, reconfigureReadOnly } from "./editorView";
import type { SharedEditorHandle, SharedEditorOptions } from "./editorTypes";

interface SharedEditorProps extends SharedEditorOptions {
  /** Applied to the mounted root element so callers can hook existing container CSS. */
  className?: string;
}

/**
 * React wrapper around the CodeMirror 6 kernel. `EditorState` is the only
 * source of truth once created: user typing flows through CodeMirror's own
 * transactions (and its undo stack), while `doc` prop changes coming from
 * outside (disk reload, AI edits, undo in a *different* view of the same
 * file) are reconciled as a minimal, `addToHistory: false` external edit so
 * they don't pollute undo and don't move the caret if they land elsewhere in
 * the text. See `editorView.ts`'s `minimalReplacement`.
 */
export function SharedEditor({ className, ...options }: SharedEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<SharedEditorHandle | null>(null);
  // Keep the latest callbacks without recreating the editor on every render.
  const onUpdateRef = useRef(options.onUpdate);
  const onReadyRef = useRef(options.onReady);
  onUpdateRef.current = options.onUpdate;
  onReadyRef.current = options.onReady;
  // Extensions/initial doc/language are creation-time inputs only; `useRef`
  // keeps whatever the first render passed regardless of later re-renders.
  const initialRef = useRef(options);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = initialRef.current;
    const handle = createSharedEditorView(host, {
      ...initial,
      extensions: [
        ...(initial.extensions ?? []),
        EditorView.updateListener.of((update) => {
          onUpdateRef.current?.({
            view: update.view,
            state: update.state,
            docChanged: update.docChanged,
            selectionChanged: !update.startState.selection.eq(update.state.selection),
            transactions: update.transactions,
          });
        }),
      ],
    });
    handleRef.current = handle;
    onReadyRef.current?.(handle);
    return () => {
      onReadyRef.current?.(null);
      handle.destroy();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle || handle.getText() === options.doc) return;
    handle.setDocument(options.doc, { addToHistory: false, preserveSelection: true });
  }, [options.doc]);

  useEffect(() => {
    const view = handleRef.current?.view;
    if (view) reconfigureReadOnly(view, Boolean(options.readOnly));
  }, [options.readOnly]);

  useEffect(() => {
    const view = handleRef.current?.view;
    // The factory applies the creation-time language. This effect only handles
    // a later prop change, avoiding a duplicate lazy import/reconfigure on mount.
    if (view && options.language !== initialRef.current.language) reconfigureLanguage(view, options.language);
  }, [options.language]);

  return <div className={className} ref={hostRef} />;
}
