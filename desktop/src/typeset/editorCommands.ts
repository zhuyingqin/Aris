// Text commands the editor toolbar and the Typeset shell both issue against
// whichever editor is focused (CodeMirror source view or the visual editor).
import { EditorView } from "@codemirror/view";
import type { SharedEditorHandle } from "../editor/editorTypes";
import type { Language } from "../store";
import { TYPESET_EDITOR_COPY } from "./i18n";
import { scanLatexStructure } from "./latexStructure";
import type { TextSearchMatch } from "./pdfTextMatch";

function ensureEmptyLine(text: string, pos: number): { prefix: string; suffix: string } {
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  return {
    prefix: /(^|\n)[ \t]*$/.test(before) ? "" : "\n\n",
    suffix: /^[ \t]*(\n|$)/.test(after) ? "" : "\n\n",
  };
}

export type EditorMode = "code" | "visual";
export type EditorAdapter = {
  from: number;
  to: number;
  text: string;
  replace: (from: number, to: number, insert: string, selStart: number, selEnd: number) => void;
};
export function activeEditorAdapter(
  mode: EditorMode,
  editorRef: { current: SharedEditorHandle | null },
  visualViewRef: { current: EditorView | null },
  draft: string,
  onChange: (value: string) => void,
): EditorAdapter | null {
  if (mode === "code") {
    const editor = editorRef.current;
    if (!editor) return null;
    const { from, to } = editor.getSelection().main;
    return {
      from,
      to,
      text: draft,
      replace: (rFrom, rTo, insert, selStart, selEnd) => {
        onChange(draft.slice(0, rFrom) + insert + draft.slice(rTo));
        window.setTimeout(() => {
          editor.focus();
          editor.dispatch({ selection: { anchor: selStart, head: selEnd } });
        }, 0);
      },
    };
  }
  const view = visualViewRef.current;
  if (!view) return null;
  const range = view.state.selection.main;
  return {
    from: range.from,
    to: range.to,
    text: view.state.doc.toString(),
    replace: (rFrom, rTo, insert, selStart, selEnd) => {
      view.dispatch({
        changes: { from: rFrom, to: rTo, insert },
        selection: { anchor: selStart, head: selEnd },
        scrollIntoView: true,
      });
      view.focus();
    },
  };
}
export function wrapSelection(adapter: EditorAdapter, prefix: string, suffix: string, placeholder: string) {
  const hasSelection = adapter.to > adapter.from;
  const content = hasSelection ? adapter.text.slice(adapter.from, adapter.to) : placeholder;
  const selStart = adapter.from + prefix.length;
  adapter.replace(adapter.from, adapter.to, `${prefix}${content}${suffix}`, selStart, selStart + content.length);
}
export function insertSnippetAtCursor(adapter: EditorAdapter, before: string, placeholder: string, after: string) {
  const pos = adapter.from;
  const selStart = pos + before.length;
  adapter.replace(pos, pos, `${before}${placeholder}${after}`, selStart, selStart + placeholder.length);
}
export function insertLink(adapter: EditorAdapter, url = "https://example.com", placeholder = "link text") {
  const text = adapter.to > adapter.from ? adapter.text.slice(adapter.from, adapter.to) : placeholder;
  const replacement = `\\href{${url}}{${text}}`;
  const urlFrom = adapter.from + "\\href{".length;
  adapter.replace(adapter.from, adapter.to, replacement, urlFrom, urlFrom + url.length);
}
export function insertBlockAtCursor(adapter: EditorAdapter, template: string) {
  const { prefix, suffix } = ensureEmptyLine(adapter.text, adapter.from);
  const pos = adapter.from;
  adapter.replace(pos, pos, `${prefix}${template}${suffix}`, pos + prefix.length, pos + prefix.length + template.length);
}
export function applyHeadingLevel(adapter: EditorAdapter, key: string, label: string) {
  const { text } = adapter;
  const lineStart = text.lastIndexOf("\n", adapter.from - 1) + 1;
  const lineEnd = text.indexOf("\n", adapter.from) === -1 ? text.length : text.indexOf("\n", adapter.from);
  const line = text.slice(lineStart, lineEnd);
  const structure = scanLatexStructure(text);
  const heading = structure.headings.find((candidate) =>
    candidate.from <= adapter.to
      && candidate.to >= adapter.from
      && (candidate.from >= lineStart || candidate.to > lineStart),
  );

  if (heading) {
    const title = heading.title.value;
    const shortTitle = heading.shortTitle ? text.slice(heading.shortTitle.from, heading.shortTitle.to) : "";
    const replacement = key === "text"
      ? title
      : `\\${key}${heading.starred ? "*" : ""}${shortTitle}{${title}}`;
    const titleOffset = key === "text"
      ? 0
      : key.length + 2 + (heading.starred ? 1 : 0) + shortTitle.length;
    adapter.replace(
      heading.from,
      heading.to,
      replacement,
      heading.from + titleOffset,
      heading.from + titleOffset + title.length,
    );
    return;
  }
  if (key === "text") return; // already plain text

  const hasSelection = adapter.to > adapter.from;
  const content = hasSelection ? text.slice(adapter.from, adapter.to) : line.trim();
  if (content) {
    const from = hasSelection ? adapter.from : lineStart;
    const to = hasSelection ? adapter.to : lineEnd;
    const selStart = from + key.length + 2;
    adapter.replace(from, to, `\\${key}{${content}}`, selStart, selStart + content.length);
    return;
  }

  const placeholder = `New ${label.toLowerCase()}`;
  insertBlockAtCursor(adapter, `\\${key}{${placeholder}}`);
}
export function applyListWrap(adapter: EditorAdapter, environment: "itemize" | "enumerate") {
  const { text } = adapter;
  const hasSelection = adapter.to > adapter.from;
  const fromLine = text.lastIndexOf("\n", adapter.from - 1) + 1;
  const searchFrom = Math.max(adapter.to - 1, adapter.from);
  const toLineEnd = text.indexOf("\n", searchFrom) === -1 ? text.length : text.indexOf("\n", searchFrom);
  const block = text.slice(fromLine, toLineEnd);
  const lines = block.split("\n");
  const blockHasContent = lines.some((line) => line.trim().length > 0);

  if (!hasSelection && !blockHasContent) {
    const insert = `\\begin{${environment}}\n\\item \n\\end{${environment}}`;
    const itemPos = fromLine + `\\begin{${environment}}\n\\item `.length;
    adapter.replace(fromLine, toLineEnd, insert, itemPos, itemPos);
    return;
  }

  const insert = [`\\begin{${environment}}`, ...lines.map((line) => `\\item ${line.trim()}`), `\\end{${environment}}`].join("\n");
  adapter.replace(fromLine, toLineEnd, insert, fromLine, fromLine + insert.length);
}
export function textSearchMatches(source: string, query: string): TextSearchMatch[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const haystack = source.toLocaleLowerCase();
  const needle = normalizedQuery.toLocaleLowerCase();
  const matches: TextSearchMatch[] = [];
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    matches.push({ start: index, end: index + normalizedQuery.length });
    index = haystack.indexOf(needle, index + Math.max(1, needle.length));
  }
  return matches;
}
export function visualSectionLevels(language: Language): Array<{ key: string; label: string }> {
  const copy = TYPESET_EDITOR_COPY[language].sectionLevels;
  return [
    { key: "text", label: copy.text },
    { key: "part", label: copy.part },
    { key: "chapter", label: copy.chapter },
    { key: "section", label: copy.section },
    { key: "subsection", label: copy.subsection },
    { key: "subsubsection", label: copy.subsubsection },
    { key: "paragraph", label: copy.paragraph },
    { key: "subparagraph", label: copy.subparagraph },
  ];
}
