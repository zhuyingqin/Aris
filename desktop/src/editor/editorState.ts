import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, lineNumbers, EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { search } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { sharedKeymap } from "./editorCommands";
import type { SharedEditorOptions } from "./editorTypes";

/** Reconfigured by `editorView.ts` when `options.readOnly` changes. */
export const readOnlyCompartment = new Compartment();
/** Reconfigured by `editorView.ts` when `options.language` changes or its lazy load resolves. */
export const languageCompartment = new Compartment();

// Reuses the same theme-aware `--code-*` custom properties the old highlight.js
// rules used (desktop/src/styles.css), so Code page tokens keep their existing
// colors in both light and dark themes with no new CSS.
const sharedHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword, t.self], color: "var(--code-keyword)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--code-entity)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--code-func)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--code-string)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--code-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: "var(--code-variable)" },
  { tag: [t.meta, t.annotation, t.processingInstruction, t.definitionOperator], color: "var(--code-meta)" },
]);

/**
 * Base extensions shared by both surfaces: history, selection/cursor drawing,
 * bracket matching + auto-close, indent-on-input, active-line highlight, the
 * shared keymap, search, and language-agnostic syntax coloring. Surface-only
 * concerns (visual theme, decorations, surface-specific keymaps) are NOT here —
 * callers add those via `SharedEditorOptions.extensions`.
 */
export function baseExtensions(options: Pick<SharedEditorOptions, "readOnly" | "dataEditor">): Extension[] {
  const extensions: Extension[] = [
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    foldGutter(),
    indentOnInput(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    syntaxHighlighting(sharedHighlightStyle, { fallback: true }),
    search({ top: true }),
    sharedKeymap(),
    readOnlyCompartment.of(EditorState.readOnly.of(Boolean(options.readOnly))),
    languageCompartment.of([]),
    lineNumbers(),
  ];
  if (options.dataEditor !== undefined) {
    extensions.push(EditorView.contentAttributes.of({ "data-editor": options.dataEditor }));
  }
  return extensions;
}
