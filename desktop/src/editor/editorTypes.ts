import type { EditorSelection, Extension, Transaction, TransactionSpec } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type EditorSurface = "code" | "typeset";

export type EditorLanguage =
  | "bash"
  | "css"
  | "ini"
  | "javascript"
  | "json"
  | "latex"
  | "matlab"
  | "python"
  | "markdown"
  | "powershell"
  | "rust"
  | "sql"
  | "text"
  | "typescript"
  | "xml"
  | "yaml";

export interface SharedEditorOptions {
  doc: string;
  language: EditorLanguage;
  surface: EditorSurface;
  readOnly?: boolean;
  /** Defaults to true; both surfaces show line numbers today. */
  lineNumbers?: boolean;
  /** Stamped onto CodeMirror's `contentDOM` so DOM-query focus (Lab's focus-by-index) keeps working. */
  dataEditor?: string;
  extensions?: Extension[];
  onUpdate?: (update: EditorUpdate) => void;
  onReady?: (handle: SharedEditorHandle | null) => void;
}

export interface EditorUpdate {
  view: EditorView;
  state: EditorState;
  docChanged: boolean;
  selectionChanged: boolean;
  transactions: readonly Transaction[];
}

export interface SharedEditorHandle {
  view: EditorView;
  getText(): string;
  getSelection(): EditorSelection;
  dispatch(spec: TransactionSpec): void;
  setDocument(
    text: string,
    options?: { addToHistory?: boolean; preserveSelection?: boolean },
  ): void;
  focus(): void;
  destroy(): void;
}
