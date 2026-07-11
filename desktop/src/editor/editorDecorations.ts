import { RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from "@codemirror/view";

export interface CodeDiffLine {
  line: number;
  type: "added" | "removed";
  text?: string;
}

export const setDiffLines = StateEffect.define<CodeDiffLine[]>();

export const diffLinesField = StateField.define<CodeDiffLine[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiffLines)) return effect.value;
    }
    return value;
  },
});

function buildDiffDecorations(doc: Text, diffLines: CodeDiffLine[]): DecorationSet {
  if (!diffLines.length) return Decoration.none;
  // "added" wins over "removed" when a line carries both marks, matching the
  // old CodeEditor.tsx `lineClass()` precedence.
  const byLine = new Map<number, "added" | "removed">();
  for (const entry of diffLines) {
    if (entry.type === "added" || !byLine.has(entry.line)) byLine.set(entry.line, entry.type);
  }
  const builder = new RangeSetBuilder<Decoration>();
  const sortedLines = [...byLine.keys()].sort((a, b) => a - b);
  for (const lineNumber of sortedLines) {
    if (lineNumber < 1 || lineNumber > doc.lines) continue;
    const type = byLine.get(lineNumber);
    const line = doc.line(lineNumber);
    builder.add(line.from, line.from, Decoration.line({ class: `cm-diff-line cm-diff-${type}` }));
  }
  return builder.finish();
}

class DiffGutterMarker extends GutterMarker {
  constructor(private readonly type: CodeDiffLine["type"]) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof DiffGutterMarker && other.type === this.type;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = `cm-diff-marker cm-diff-marker-${this.type}`;
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }
}

const addedMarker = new DiffGutterMarker("added");
const removedMarker = new DiffGutterMarker("removed");

const diffGutter = gutter({
  class: "cm-diff-gutter",
  markers: (view) => {
    const builder = new RangeSetBuilder<GutterMarker>();
    const lines = view.state.field(diffLinesField);
    const byLine = new Map<number, CodeDiffLine["type"]>();
    for (const entry of lines) {
      if (entry.type === "added" || !byLine.has(entry.line)) byLine.set(entry.line, entry.type);
    }
    for (const lineNumber of [...byLine.keys()].sort((a, b) => a - b)) {
      if (lineNumber < 1 || lineNumber > view.state.doc.lines) continue;
      const line = view.state.doc.line(lineNumber);
      builder.add(line.from, line.from, byLine.get(lineNumber) === "added" ? addedMarker : removedMarker);
    }
    return builder.finish();
  },
});

export const diffDecorationField = StateField.define<DecorationSet>({
  create(state) {
    return buildDiffDecorations(state.doc, state.field(diffLinesField));
  },
  update(deco, tr) {
    const changed = tr.docChanged || tr.effects.some((effect) => effect.is(setDiffLines));
    if (!changed) return deco;
    return buildDiffDecorations(tr.state.doc, tr.state.field(diffLinesField));
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** `CodeDiffLine[]` -> CodeMirror line decorations (gutter/background markers). */
export function diffDecorations(initial: CodeDiffLine[] = []): Extension {
  return [diffLinesField.init(() => initial), diffDecorationField, diffGutter];
}

export function dispatchDiffLines(view: EditorView, lines: CodeDiffLine[]): void {
  view.dispatch({ effects: setDiffLines.of(lines) });
}
