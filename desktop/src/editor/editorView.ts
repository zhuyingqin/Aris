import { EditorState, EditorSelection, Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { baseExtensions, languageCompartment, readOnlyCompartment } from "./editorState";
import { loadLanguageExtension } from "./editorLanguages";
import type { EditorLanguage, SharedEditorHandle, SharedEditorOptions } from "./editorTypes";

const languageRequestIds = new WeakMap<EditorView, number>();

declare global {
  interface Window {
    /** DEV-only, test-only: lets tests dispatch into a live editor the same way
     * Typeset's tests already do via `window.__typesetView`, without plumbing a
     * test-only prop through Lab/FileEditorPane's production component tree. */
    __somniqEditors?: Map<string, EditorView>;
  }
}

/** Longest common prefix/suffix diff so external doc updates (disk/AI writes)
 * touch only the changed range — letting CodeMirror's default selection
 * mapping keep the caret in place instead of jumping to 0 on a full replace. */
function minimalReplacement(oldText: string, newText: string): { from: number; to: number; insert: string } {
  const maxCommon = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < maxCommon && oldText.charCodeAt(start) === newText.charCodeAt(start)) start += 1;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { from: start, to: oldEnd, insert: newText.slice(start, newEnd) };
}

export function createSharedEditorView(host: HTMLElement, options: SharedEditorOptions): SharedEditorHandle {
  const extensions = [...baseExtensions(options), ...(options.extensions ?? [])];

  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: options.doc, extensions }),
  });

  reconfigureLanguage(view, options.language);

  if (import.meta.env.DEV && options.dataEditor !== undefined) {
    window.__somniqEditors ??= new Map();
    window.__somniqEditors.set(options.dataEditor, view);
  }

  const handle: SharedEditorHandle = {
    view,
    getText: () => view.state.doc.toString(),
    getSelection: () => view.state.selection,
    dispatch: (spec: TransactionSpec) => view.dispatch(spec),
    setDocument: (text, setDocOptions) => {
      const current = view.state.doc.toString();
      if (current === text) return;
      const { from, to, insert } = minimalReplacement(current, text);
      const spec: TransactionSpec = { changes: { from, to, insert } };
      if (setDocOptions?.addToHistory === false) {
        spec.annotations = Transaction.addToHistory.of(false);
      }
      if (setDocOptions?.preserveSelection === false) {
        spec.selection = EditorSelection.cursor(from + insert.length);
      }
      view.dispatch(spec);
    },
    focus: () => view.focus(),
    destroy: () => {
      if (import.meta.env.DEV && options.dataEditor !== undefined) {
        window.__somniqEditors?.delete(options.dataEditor);
      }
      view.destroy();
    },
  };

  return handle;
}

export function reconfigureReadOnly(view: EditorView, readOnly: boolean): void {
  view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)) });
}

export function reconfigureLanguage(view: EditorView, language: EditorLanguage): void {
  const requestId = (languageRequestIds.get(view) ?? 0) + 1;
  languageRequestIds.set(view, requestId);
  void loadLanguageExtension(language).then((extension) => {
    if (view.dom.isConnected && languageRequestIds.get(view) === requestId) {
      view.dispatch({ effects: languageCompartment.reconfigure(extension) });
    }
  });
}
