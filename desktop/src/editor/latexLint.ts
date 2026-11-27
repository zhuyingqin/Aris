import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { latexProjectSymbols, type LatexSymbol } from "./latexComplete";
import type { LatexCommand } from "./latex/latexStructure";
import { PendingLatexStructure } from "./latex/pendingStructure";
import { LATEX_LINT_COPY } from "./latex/latexCopy";
import { useStore } from "../store";

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

/**
 * Re-runs the lint pass without an edit — after the project's labels or
 * bibliography finish loading, for instance. `@codemirror/lint` otherwise
 * re-checks only when the document or its config changes.
 */
export const refreshLatexDiagnostics = StateEffect.define<null>();

const compileMarkers = StateField.define<LatexCompileMarker[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setLatexCompileMarkers)) return effect.value;
    // Editing invalidates positions, so stale compiler markers are dropped
    // rather than left pointing at text that has moved.
    return transaction.docChanged ? [] : value;
  },
});

/** Shared transaction-aware semantic index, brought up to date when the
 * linter reads it rather than on every keystroke (see `PendingLatexStructure`). */
export const latexSemanticIndex = StateField.define<PendingLatexStructure>({
  create: (state) => PendingLatexStructure.of(state.doc),
  update(value, transaction) {
    return transaction.docChanged ? value.next(transaction.changes, transaction.newDoc) : value;
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

const REFERENCE_COMMANDS = new Set([
  "ref", "eqref", "autoref", "cref", "Cref", "pageref", "nameref", "vref", "Vref", "cpageref", "labelcref", "autopageref",
]);
const CITATION_COMMANDS = new Set([
  "cite", "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear", "parencite", "textcite", "autocite", "footcite",
  "Citep", "Citet", "Citeauthor", "citeyearpar", "citenum", "Parencite", "Textcite", "Autocite", "smartcite", "supercite", "nocite",
]);

function firstArgument(command: LatexCommand): string {
  return command.requiredArguments[0]?.value.trim() ?? "";
}

/** `label=…` keys in environment options (`\begin{lstlisting}[label=lst:a]`). */
export function optionLabels(source: string): string[] {
  const labels: string[] = [];
  const options = /\\begin\s*\{[^}]+\}\s*\[([^\]]*)\]/g;
  for (let match = options.exec(source); match; match = options.exec(source)) {
    const label = /(?:^|,)\s*label\s*=\s*\{?\s*([^,}\]\s]+)/.exec(match[1]);
    if (label) labels.push(label[1]);
  }
  return labels;
}

function referenceDiagnostics(state: EditorState): Diagnostic[] {
  const symbols = latexProjectSymbols();
  const structure = state.field(latexSemanticIndex).get();
  const copy = LATEX_LINT_COPY[useStore.getState().language];
  const diagnostics: Diagnostic[] = [];

  const knownLabels = new Set(symbols.labels.map((label: LatexSymbol) => label.name));
  // `\begin{lstlisting}[label=lst:x]`, tcolorbox's `label=` and friends define
  // labels too; without them every `\ref` to a listing read as undefined.
  for (const name of optionLabels(structure.source)) knownLabels.add(name);
  const localLabels = new Map<string, number>();
  for (const command of structure.commandsNamed("label")) {
    const name = firstArgument(command);
    if (!name) continue;
    knownLabels.add(name);
    const seen = localLabels.get(name);
    if (seen === undefined) {
      localLabels.set(name, command.from);
      if (symbols.crossFileDuplicateLabels?.has(name)) {
        diagnostics.push({
          from: command.from,
          to: command.to,
          severity: "warning",
          source: "latex",
          message: copy.duplicateLabelAcrossFiles(name),
        });
      }
      continue;
    }
    diagnostics.push({
      from: command.from,
      to: command.to,
      severity: "warning",
      source: "latex",
      message: copy.duplicateLabel(name),
    });
  }

  for (const command of structure.commands.filter((candidate) => REFERENCE_COMMANDS.has(candidate.name))) {
    for (const key of firstArgument(command).split(",")) {
      const name = key.trim();
      if (!name || knownLabels.has(name)) continue;
      diagnostics.push({
        from: command.from,
        to: command.to,
        severity: "warning",
        source: "latex",
        message: copy.undefinedReference(name),
      });
    }
  }

  // Citations are checked against the document's own bibliography, and only
  // once it is known (see `bibliographyKeys`): the library's keys used to
  // count, so any non-empty library switched the check on — flagging every
  // `\cite` of a `thebibliography` document and of a `.bib` still loading.
  if (symbols.bibliographyKeys) {
    const knownKeys = new Set(symbols.bibliographyKeys);
    for (const command of structure.commandsNamed("bibitem")) {
      const key = firstArgument(command);
      if (key) knownKeys.add(key);
    }
    for (const command of structure.commands.filter((candidate) => CITATION_COMMANDS.has(candidate.name))) {
      for (const key of firstArgument(command).split(",")) {
        const name = key.trim();
        if (!name || name === "*" || knownKeys.has(name)) continue;
        diagnostics.push({
          from: command.from,
          to: command.to,
          severity: "warning",
          source: "latex",
          message: copy.unknownCitation(name),
        });
      }
    }
  }

  for (const environment of structure.environments) {
    if (environment.closed) continue;
    diagnostics.push({
      from: environment.beginFrom,
      to: environment.beginTo,
      severity: "error",
      source: "latex",
      message: copy.unclosedEnvironment(environment.name),
    });
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
    latexSemanticIndex,
    linter((view: EditorView) => latexDiagnostics(view.state), {
      delay: 400,
      // Markers arrive after a build, with no edit to trigger the linter;
      // without this they stayed invisible until the next keystroke, which
      // then cleared them.
      needsRefresh: (update) => update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setLatexCompileMarkers) || effect.is(refreshLatexDiagnostics))),
    }),
    ...(options.gutter ? [lintGutter()] : []),
  ];
}
