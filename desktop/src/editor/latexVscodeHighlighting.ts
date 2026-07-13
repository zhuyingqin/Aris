import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** VS Code Dark+ syntax palette used by every editable LaTeX source surface. */
const latexVscodeHighlightStyle = HighlightStyle.define([
  // The `stex` legacy mode emits command names as `tag`, delimiters as
  // `keyword`, and math identifiers as `variableName.special`.
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: "#ffcc00" },
  { tag: [t.tagName, t.typeName, t.className, t.namespace, t.meta, t.processingInstruction], color: "#4ec9b0" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "#ce9178" },
  { tag: [t.number, t.bool], color: "#b5cea8" },
  { tag: t.atom, color: "#ffcc00" },
  { tag: [t.variableName, t.special(t.variableName), t.propertyName, t.attributeName], color: "#9cdcfe" },
  { tag: [t.definitionKeyword, t.definitionOperator], color: "#c586c0" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6a9955", fontStyle: "italic" },
  { tag: [t.punctuation, t.bracket], color: "#ffcc00" },
  { tag: t.invalid, color: "#f48771" },
]);

// This is deliberately not a fallback: it replaces the generic shared palette
// on LaTeX source, in both Code and the editable Visual surface.
export const latexVscodeHighlighting = syntaxHighlighting(latexVscodeHighlightStyle);
