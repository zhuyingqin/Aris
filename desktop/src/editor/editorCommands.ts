import type { Extension } from "@codemirror/state";
import { keymap, type KeyBinding } from "@codemirror/view";
import { defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeBracketsKeymap } from "@codemirror/autocomplete";
import { foldKeymap } from "@codemirror/language";
import { gotoLine, searchKeymap } from "@codemirror/search";

/** Jump to a line number. `searchKeymap` already binds it to the CodeMirror
 * default (Ctrl+Alt+G); Ctrl+L is what Overleaf and most TeX editors use, and
 * is what the Typeset toolbar advertises. */
export const gotoLineKeymap: readonly KeyBinding[] = [{ key: "Mod-l", run: gotoLine, preventDefault: true }];

export { gotoLine };

/**
 * The kernel's own keymap: Tab/Shift-Tab indent, bracket-close skipping, search
 * (Ctrl+F/Ctrl+H), go-to-line, undo/redo, and CodeMirror's standard bindings —
 * including `Enter` -> `insertNewlineAndIndent`, which auto-indents via each
 * language's indent service (replacing the old textarea editor's manual
 * Python-only "indent after `:`" regex with a real per-language implementation).
 *
 * Surface-specific bindings (Python Shift+Enter run-selection, LaTeX list
 * continuation, notebook cell navigation, …) are injected separately by the
 * caller via `SharedEditorOptions.extensions`, not merged in here.
 */
export function sharedKeymap(extra: readonly KeyBinding[] = []): Extension {
  return keymap.of([
    ...closeBracketsKeymap,
    ...foldKeymap,
    ...searchKeymap,
    ...gotoLineKeymap,
    indentWithTab,
    ...defaultKeymap,
    ...historyKeymap,
    ...extra,
  ]);
}
