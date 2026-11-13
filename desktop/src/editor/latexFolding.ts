import { foldService } from "@codemirror/language";
import type { Text } from "@codemirror/state";
import { scanLatexStructure, type LatexRange } from "../typeset/latexStructure";

// Gutter queries run once per visible line. Reuse the index for the immutable
// document so moving the selection or scrolling never rescans the source.
const documentFolds = new WeakMap<Text, ReadonlyMap<number, LatexRange>>();

function environmentFolds(doc: Text): ReadonlyMap<number, LatexRange> {
  const cached = documentFolds.get(doc);
  if (cached) return cached;

  const folds = new Map<number, LatexRange>();
  for (const environment of scanLatexStructure(doc.toString()).environments) {
    if (!environment.closed) continue;
    const line = doc.lineAt(environment.beginFrom);
    if (environment.endFrom <= line.to || folds.has(line.from)) continue;

    // Keep both delimiters visible. Options may span several lines, so the
    // fold must start on the opening line rather than after all the options.
    // The structural index orders outer environments first when starts share
    // a line; that is the one range its gutter arrow should control.
    folds.set(line.from, {
      from: Math.min(environment.beginTo, line.to),
      to: environment.endFrom,
    });
  }
  documentFolds.set(doc, folds);
  return folds;
}

/** Source-only folding; pairing respects comments, raw regions and nesting. */
export const latexEnvironmentFolding = foldService.of((state, lineStart) =>
  environmentFolds(state.doc).get(lineStart) ?? null,
);
