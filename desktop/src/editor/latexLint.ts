import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { latexProjectSymbols, type LatexSymbol } from "./latexComplete";

/**
 * Two kinds of marker on a LaTeX source, both surfaced through CodeMirror's
 * lint machinery so they underline the offending text instead of hiding in a
 * log panel:
 *
 *  - what the compiler said about this file (pushed in after every build), and
 *  - what can be known without compiling at all: a `\ref` to a label nothing
 *    defines, a label defined twice, a `\cite` key the bibliography lacks.
 */

export interface LatexCompileMarker {
  line: number;
  /** 1-based; when absent the whole line is marked. */
  column?: number | null;
  severity: "error" | "warning" | "info";
  message: string;
}

/** Replaces the compile markers shown in a view (empty clears them). */
export const setLatexCompileMarkers = StateEffect.define<LatexCompileMarker[]>();

const compileMarkers = StateField.define<LatexCompileMarker[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setLatexCompileMarkers)) return effect.value;
    // Editing invalidates positions, so stale compiler markers are dropped
    // rather than left pointing at text that has moved.
    return transaction.docChanged ? [] : value;
  },
});

function markerDiagnostics(state: EditorState): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const marker of state.field(compileMarkers, false) ?? []) {
    if (marker.line < 1 || marker.line > state.doc.lines) continue;
    const line = state.doc.line(marker.line);
    const from = marker.column && marker.column > 0
      ? Math.min(line.to, line.from + marker.column - 1)
      : line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0);
    diagnostics.push({
      from,
      to: line.to > from ? line.to : from,
      severity: marker.severity,
      source: "latex",
      message: marker.message,
    });
  }
  return diagnostics;
}

const REFERENCE_RE = /\\(ref|eqref|autoref|cref|Cref|pageref|nameref|vref)\s*\{([^{}]*)\}/g;
const CITATION_RE = /\\(cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite)\*?(?:\[[^\]]*\])*\s*\{([^{}]*)\}/g;
const LABEL_RE = /\\label\s*\{([^{}]*)\}/g;

/** Offsets of every unescaped `%` comment body, so markup inside a comment is
 * not linted. */
function commentRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let lineStart = 0;
  for (const line of text.split("\n")) {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== "%") continue;
      let backslashes = 0;
      for (let scan = index - 1; scan >= 0 && line[scan] === "\\"; scan -= 1) backslashes += 1;
      if (backslashes % 2 === 0) {
        ranges.push([lineStart + index, lineStart + line.length]);
        break;
      }
    }
    lineStart += line.length + 1;
  }
  return ranges;
}

function referenceDiagnostics(state: EditorState): Diagnostic[] {
  const symbols = latexProjectSymbols();
  const text = state.doc.toString();
  const comments = commentRanges(text);
  const inComment = (offset: number) => comments.some(([from, to]) => offset >= from && offset < to);
  const diagnostics: Diagnostic[] = [];

  const knownLabels = new Set(symbols.labels.map((label: LatexSymbol) => label.name));
  const localLabels = new Map<string, number>();
  let match: RegExpExecArray | null;
  LABEL_RE.lastIndex = 0;
  while ((match = LABEL_RE.exec(text))) {
    if (inComment(match.index)) continue;
    const name = match[1].trim();
    if (!name) continue;
    knownLabels.add(name);
    const seen = localLabels.get(name);
    if (seen === undefined) {
      localLabels.set(name, match.index);
      continue;
    }
    diagnostics.push({
      from: match.index,
      to: match.index + match[0].length,
      severity: "warning",
      source: "latex",
      message: `Label "${name}" is already defined in this file — LaTeX keeps the last one and every \\ref to it becomes ambiguous.`,
    });
  }
  // Labels the project index knows about but that were defined more than once
  // across files are reported by whichever file holds the duplicate, above.

  REFERENCE_RE.lastIndex = 0;
  while ((match = REFERENCE_RE.exec(text))) {
    if (inComment(match.index)) continue;
    for (const key of match[2].split(",")) {
      const name = key.trim();
      if (!name || knownLabels.has(name)) continue;
      diagnostics.push({
        from: match.index,
        to: match.index + match[0].length,
        severity: "warning",
        source: "latex",
        message: `No \\label{${name}} anywhere in this document — the reference will typeset as "??".`,
      });
    }
  }

  // Only lint citations once the project actually has a bibliography index;
  // otherwise a project whose .bib hasn't loaded yet lights up entirely.
  if (symbols.citations.length > 0) {
    const knownKeys = new Set(symbols.citations.map((citation: LatexSymbol) => citation.name));
    CITATION_RE.lastIndex = 0;
    while ((match = CITATION_RE.exec(text))) {
      if (inComment(match.index)) continue;
      for (const key of match[2].split(",")) {
        const name = key.trim();
        if (!name || knownKeys.has(name)) continue;
        diagnostics.push({
          from: match.index,
          to: match.index + match[0].length,
          severity: "warning",
          source: "latex",
          message: `Citation key "${name}" is not in the project bibliography.`,
        });
      }
    }
  }

  return diagnostics;
}

export function latexDiagnostics(state: EditorState): Diagnostic[] {
  return [...markerDiagnostics(state), ...referenceDiagnostics(state)]
    .sort((left, right) => left.from - right.from);
}

/** `gutter` is off for the WYSIWYG surface, which has no gutter column. */
export function latexLint(options: { gutter: boolean }): Extension {
  return [
    compileMarkers,
    linter((view: EditorView) => latexDiagnostics(view.state), { delay: 400 }),
    ...(options.gutter ? [lintGutter()] : []),
  ];
}
