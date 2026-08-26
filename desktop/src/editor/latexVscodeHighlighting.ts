import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * VS Code-style syntax palette used by editable LaTeX source surfaces.
 *
 * Keep the actual colours in Typeset.css: CodeMirror injects these rules once,
 * while CSS custom properties continue to resolve against the current root
 * theme. That makes an already-open editor switch between Dark+ and Light+
 * without recreating its EditorState.
 */
const latexVscodeHighlightStyle = HighlightStyle.define([
  // The `stex` legacy mode emits command names as `tag`, delimiters as
  // `keyword`, and math identifiers as `variableName.special`.
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: "var(--typeset-code-keyword)" },
  { tag: [t.tagName, t.typeName, t.className, t.namespace, t.meta, t.processingInstruction], color: "var(--typeset-code-entity)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--typeset-code-string)" },
  { tag: [t.number, t.bool], color: "var(--typeset-code-number)" },
  { tag: t.atom, color: "var(--typeset-code-atom)" },
  { tag: [t.variableName, t.special(t.variableName), t.propertyName, t.attributeName], color: "var(--typeset-code-variable)" },
  { tag: [t.definitionKeyword, t.definitionOperator], color: "var(--typeset-code-definition)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--typeset-code-comment)", fontStyle: "italic" },
  { tag: [t.punctuation, t.bracket], color: "var(--typeset-code-punctuation)" },
  { tag: t.invalid, color: "var(--typeset-code-invalid)" },
]);

// This is deliberately not a fallback: it replaces the generic shared palette
// on the dedicated LaTeX Code surface.
export const latexVscodeHighlighting = syntaxHighlighting(latexVscodeHighlightStyle);
