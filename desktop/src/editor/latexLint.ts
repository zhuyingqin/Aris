import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { latexProjectSymbols, type LatexSymbol } from "./latexComplete";
import { scanLatexStructure, updateLatexStructure, type LatexCommand, type LatexStructureIndex } from "../typeset/latexStructure";

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

/** Shared transaction-aware semantic index. Ordinary prose edits map the
 * existing ranges through the ChangeSet; only TeX-structural edits rescan. */
export const latexSemanticIndex = StateField.define<LatexStructureIndex>({
  create: (state) => scanLatexStructure(state.doc.toString()),
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    const source = transaction.newDoc.toString();
    return updateLatexStructure(value, source, transaction.changes)
      ?? scanLatexStructure(source);
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

const REFERENCE_COMMANDS = new Set(["ref", "eqref", "autoref", "cref", "Cref", "pageref", "nameref", "vref"]);
const CITATION_COMMANDS = new Set(["cite", "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear", "parencite", "textcite", "autocite", "footcite"]);

function firstArgument(command: LatexCommand): string {
  return command.requiredArguments[0]?.value.trim() ?? "";
}

function referenceDiagnostics(state: EditorState): Diagnostic[] {
  const symbols = latexProjectSymbols();
  const structure = state.field(latexSemanticIndex);
  const diagnostics: Diagnostic[] = [];

  const knownLabels = new Set(symbols.labels.map((label: LatexSymbol) => label.name));
  const localLabels = new Map<string, number>();
  for (const command of structure.commandsNamed("label")) {
    const name = firstArgument(command);
    if (!name) continue;
    knownLabels.add(name);
    const seen = localLabels.get(name);
    if (seen === undefined) {
      localLabels.set(name, command.from);
      continue;
    }
    diagnostics.push({
      from: command.from,
      to: command.to,
      severity: "warning",
      source: "latex",
      message: `Label "${name}" is already defined in this file — LaTeX keeps the last one and every \\ref to it becomes ambiguous.`,
    });
  }
  // Labels the project index knows about but that were defined more than once
  // across files are reported by whichever file holds the duplicate, above.

  for (const command of structure.commands.filter((candidate) => REFERENCE_COMMANDS.has(candidate.name))) {
    for (const key of firstArgument(command).split(",")) {
      const name = key.trim();
      if (!name || knownLabels.has(name)) continue;
      diagnostics.push({
        from: command.from,
        to: command.to,
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
    for (const command of structure.commands.filter((candidate) => CITATION_COMMANDS.has(candidate.name))) {
      for (const key of firstArgument(command).split(",")) {
        const name = key.trim();
        if (!name || knownKeys.has(name)) continue;
        diagnostics.push({
          from: command.from,
          to: command.to,
          severity: "warning",
          source: "latex",
          message: `Citation key "${name}" is not in the project bibliography.`,
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
      message: `Environment "${environment.name}" has no matching \\end{${environment.name}}.`,
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
    linter((view: EditorView) => latexDiagnostics(view.state), { delay: 400 }),
    ...(options.gutter ? [lintGutter()] : []),
  ];
}
