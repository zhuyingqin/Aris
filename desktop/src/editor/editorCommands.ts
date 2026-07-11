import type { Extension } from "@codemirror/state";
import { keymap, type KeyBinding } from "@codemirror/view";
import { defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeBracketsKeymap } from "@codemirror/autocomplete";
import { foldKeymap } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";

/**
 * The kernel's own keymap: Tab/Shift-Tab indent, bracket-close skipping, search
 * (Ctrl+F/Ctrl+H), undo/redo, and CodeMirror's standard bindings — including
 * `Enter` -> `insertNewlineAndIndent`, which auto-indents via each language's
 * indent service (replacing the old textarea editor's manual Python-only
 * "indent after `:`" regex with a real per-language implementation).
 *
 * Surface-specific bindings (Python Shift+Enter run-selection, LaTeX list
 * continuation, notebook cell navigation, …) are injected separately by the
 * caller via `SharedEditorOptions.extensions`, not merged in here.
 */
export function sharedKeymap(extra: readonly KeyBinding[] = []): Extension {
  return keymap.of([...closeBracketsKeymap, ...foldKeymap, ...searchKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap, ...extra]);
}
