import { RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet } from "@codemirror/view";

export interface CodeDiffLine {
  line: number;
  type: "added" | "removed";
  /**
   * For a removed entry this is the exact old source shown in an inline gap
   * widget. Entries without text retain the lightweight line-only decoration
   * used by ordinary code diff callers.
   */
  text?: string;
  /**
   * The answer already recorded for the hunk this line belongs to.
   *
   * Without it a review reads the same before and after every decision: the
   * incoming text stays on screen either way, so the only feedback for
   * rejecting a change was the pressed state of a button that scrolls away.
   */
  decision?: CodeReviewDecision;
  /** Clicking this diff line reveals its hunk's review controls. */
  interactive?: boolean;
}

export type CodeReviewDecision = "pending" | "accept" | "reject";

export interface CodeReviewHunk {
  id: string;
  /** 1-based line on the document currently shown in the editor. */
  line: number;
  /** Last line covered by the hunk. Defaults to `line`. */
  endLine?: number;
  index: number;
  decision: CodeReviewDecision;
}

export interface CodeReviewConfig {
  hunks: CodeReviewHunk[];
  /**
   * Whether each hunk gets its own accept/reject controls. Some review
   * surfaces deliberately use one file-level decision while still retaining
   * hunk positions for navigation and diff context.
   */
  showControls?: boolean;
  acceptLabel: string;
  rejectLabel: string;
  /** Shown in place of the two buttons once this hunk has an answer. */
  acceptedLabel: string;
  rejectedLabel: string;
  /** Takes an answered hunk back to undecided. */
  undoLabel: string;
  positionLabel: (current: number, total: number) => string;
  busy?: boolean;
  /** Reveal the hunk controls when a collapsed diff line is clicked. */
  onReveal?: (index: number) => void;
  onDecision: (index: number, decision: CodeReviewDecision) => void;
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
  const byLine = new Map<number, CodeDiffLine>();
  for (const entry of diffLines) {
    // A removed entry with text is a marker for source that is absent from the
    // document currently on screen. It is rendered by `DiffDeletionWidget`
    // below; putting a line background on the following line would claim that
    // unchanged source was removed. Keep the legacy line decoration for
    // marker-only callers that do not provide the deleted text.
    if (entry.type === "removed" && entry.text !== undefined) continue;
    if (entry.type === "added" || !byLine.has(entry.line)) byLine.set(entry.line, entry);
  }
  const decorations: Array<{
    from: number;
    to: number;
    order: number;
    value: Decoration;
  }> = [];
  const sortedLines = [...byLine.keys()].sort((a, b) => a - b);
  for (const lineNumber of sortedLines) {
    if (lineNumber < 1 || lineNumber > doc.lines) continue;
    const entry = byLine.get(lineNumber)!;
    const line = doc.line(lineNumber);
    const decided = entry.decision && entry.decision !== "pending"
      ? ` cm-diff-decision-${entry.decision}`
      : "";
    decorations.push({
      from: line.from,
      to: line.from,
      order: 0,
      value: Decoration.line({
        class: `cm-diff-line cm-diff-${entry.type}${decided}${entry.interactive ? " cm-diff-interactive" : ""}`,
      }),
    });
  }

  // A deleted line has no position in the candidate document. Anchor the
  // explicit red preview to the first surviving line after the gap, or to the
  // document end for a deletion at EOF. Multiple deleted lines at one boundary
  // are kept as separate rows so the reviewer can see the exact old text.
  const deletionEntries = diffLines.filter((entry) => (
    entry.type === "removed" && entry.text !== undefined
  ));
  for (const [index, entry] of deletionEntries.entries()) {
    const lineNumber = Math.max(1, entry.line);
    const from = lineNumber > doc.lines ? doc.length : doc.line(lineNumber).from;
    decorations.push({
      from,
      to: from,
      // CodeMirror's line decorations sort before point widgets at the same
      // position (`Side.Line` is more negative than `Side.InlineBefore`). Keep
      // the widgets after any line decoration while preserving source order for
      // several deletions at one boundary.
      order: 10_000 + index,
      value: Decoration.widget({
        widget: new DiffDeletionWidget(entry, deletionEntries.length),
        side: -20_000 + index,
      }),
    });
  }

  decorations.sort((left, right) => (
    left.from - right.from || left.to - right.to || left.order - right.order
  ));
  const builder = new RangeSetBuilder<Decoration>();
  for (const decoration of decorations) {
    builder.add(decoration.from, decoration.to, decoration.value);
  }
  return builder.finish();
}

class DiffDeletionWidget extends WidgetType {
  constructor(
    private readonly entry: CodeDiffLine,
    private readonly total: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof DiffDeletionWidget
      && other.entry.line === this.entry.line
      && other.entry.type === this.entry.type
      && other.entry.text === this.entry.text
      && other.entry.decision === this.entry.decision
      && other.entry.interactive === this.entry.interactive
      && other.total === this.total;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    const decided = this.entry.decision && this.entry.decision !== "pending"
      ? ` cm-diff-decision-${this.entry.decision}`
      : "";
    wrapper.className = `cm-diff-line cm-diff-removed cm-diff-deletion${decided}${this.entry.interactive ? " cm-diff-interactive" : ""}`;
    // The widget is rendered in a document gap, so CodeMirror's DOM-to-text
    // coordinate conversion can resolve the click to the line before it.
    // Keep the mapped candidate line on the marker for reliable hunk lookup.
    wrapper.dataset.diffLine = String(this.entry.line);
    wrapper.setAttribute("role", "note");
    wrapper.setAttribute("aria-label", `Removed source${this.total > 1 ? ` (${this.entry.line})` : ""}`);
    wrapper.contentEditable = "false";
    const lines = (this.entry.text ?? "").split("\n");
    for (const text of lines) {
      const row = document.createElement("span");
      row.className = "cm-diff-deletion-line";
      row.textContent = `− ${text || " "}`;
      wrapper.append(row);
    }
    return wrapper;
  }

  ignoreEvent(): boolean {
    // Let the editor-level collapsed-review handler see the mousedown so a
    // click on the old text can reveal that hunk's controls. The handler calls
    // `preventDefault` after identifying the hunk, so no caret is inserted into
    // the candidate document.
    return false;
  }
}

class DiffGutterMarker extends GutterMarker {
  constructor(
    private readonly type: CodeDiffLine["type"],
    private readonly decision: CodeReviewDecision = "pending",
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof DiffGutterMarker
      && other.type === this.type
      && other.decision === this.decision;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    // The rail is the one part of a review that stays visible while scrolling,
    // so it has to agree with the answer. A green "added" bar beside a line
    // struck out as rejected reads as two different states at once.
    marker.className = this.decision === "pending"
      ? `cm-diff-marker cm-diff-marker-${this.type}`
      : `cm-diff-marker cm-diff-marker-${this.type} cm-diff-marker-${this.decision}`;
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }
}

const MARKERS: Record<string, DiffGutterMarker> = {
  "added:pending": new DiffGutterMarker("added"),
  "added:accept": new DiffGutterMarker("added", "accept"),
  "added:reject": new DiffGutterMarker("added", "reject"),
  "removed:pending": new DiffGutterMarker("removed"),
  "removed:accept": new DiffGutterMarker("removed", "accept"),
  "removed:reject": new DiffGutterMarker("removed", "reject"),
};

const diffGutter = gutter({
  class: "cm-diff-gutter",
  markers: (view) => {
    const builder = new RangeSetBuilder<GutterMarker>();
    const lines = view.state.field(diffLinesField);
    const byLine = new Map<number, CodeDiffLine>();
    for (const entry of lines) {
      // Entries carrying the deleted text are represented by an inline widget,
      // not by a red rail beside the next surviving line.
      if (entry.type === "removed" && entry.text !== undefined) continue;
      if (entry.type === "added" || !byLine.has(entry.line)) byLine.set(entry.line, entry);
    }
    for (const lineNumber of [...byLine.keys()].sort((a, b) => a - b)) {
      if (lineNumber < 1 || lineNumber > view.state.doc.lines) continue;
      const line = view.state.doc.line(lineNumber);
      const entry = byLine.get(lineNumber)!;
      builder.add(line.from, line.from, MARKERS[`${entry.type}:${entry.decision ?? "pending"}`] ?? MARKERS["added:pending"]);
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
export function diffDecorations(
  initial: CodeDiffLine[] = [],
  options: { gutter?: boolean } = {},
): Extension {
  const fields: Extension[] = [diffLinesField.init(() => initial), diffDecorationField];
  if (options.gutter !== false) fields.push(diffGutter);
  return fields;
}

export function dispatchDiffLines(view: EditorView, lines: CodeDiffLine[]): void {
  view.dispatch({ effects: setDiffLines.of(lines) });
}

export const setReviewHunks = StateEffect.define<CodeReviewConfig | null>();

const reviewHunksField = StateField.define<CodeReviewConfig | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setReviewHunks)) return effect.value;
    }
    return value;
  },
});

class ReviewHunkWidget extends WidgetType {
  constructor(
    private readonly hunk: CodeReviewHunk,
    private readonly total: number,
    private readonly config: CodeReviewConfig,
  ) {
    super();
  }

  eq(other: ReviewHunkWidget): boolean {
    return other instanceof ReviewHunkWidget
      && other.hunk.id === this.hunk.id
      && other.hunk.index === this.hunk.index
      && other.hunk.decision === this.hunk.decision
      && other.total === this.total
      && other.config.acceptLabel === this.config.acceptLabel
      && other.config.rejectLabel === this.config.rejectLabel
      && other.config.acceptedLabel === this.config.acceptedLabel
      && other.config.rejectedLabel === this.config.rejectedLabel
      && other.config.undoLabel === this.config.undoLabel
      && other.config.busy === this.config.busy
      && other.config.onDecision === this.config.onDecision;
  }

  toDOM(): HTMLElement {
    const answered = this.hunk.decision !== "pending";
    const controls = document.createElement("span");
    // An answered hunk keeps a control only so the answer can be taken back.
    // Leaving the full accept/reject pair there made a change you had already
    // decided look exactly like one still waiting for you.
    controls.className = `cm-review-hunk-controls decision-${this.hunk.decision}${answered ? " answered" : ""}`;
    controls.contentEditable = "false";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", this.config.positionLabel(this.hunk.index + 1, this.total));

    const position = document.createElement("span");
    position.className = "cm-review-hunk-position";
    position.textContent = this.config.positionLabel(this.hunk.index + 1, this.total);
    controls.append(position);

    const makeButton = (
      label: string,
      decision: CodeReviewDecision,
    ): HTMLButtonElement => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = decision;
      button.textContent = label;
      button.contentEditable = "false";
      button.disabled = Boolean(this.config.busy);
      button.setAttribute("aria-pressed", String(this.hunk.decision === decision));
      let handledByPointer = false;
      button.addEventListener("pointerdown", (event) => {
        // Waiting for `click` is unreliable inside an editable CodeMirror line:
        // the editor may update the selection and replace this widget between
        // pointerdown and pointerup. Commit while the original control is still
        // mounted, and prevent the editor from moving the caret underneath it.
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        handledByPointer = true;
        this.config.onDecision(this.hunk.index, decision);
      });
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Native keyboard activation has no preceding pointerdown. Keep that
        // path accessible without applying a pointer decision twice.
        if (!handledByPointer && !button.disabled) {
          this.config.onDecision(this.hunk.index, decision);
        }
        handledByPointer = false;
      });
      return button;
    };

    if (answered) {
      const state = document.createElement("span");
      state.className = "cm-review-hunk-state";
      state.textContent = this.hunk.decision === "accept"
        ? this.config.acceptedLabel
        : this.config.rejectedLabel;
      controls.append(state, makeButton(this.config.undoLabel, "pending"));
    } else {
      controls.append(
        makeButton(this.config.rejectLabel, "reject"),
        makeButton(this.config.acceptLabel, "accept"),
      );
    }
    return controls;
  }

  ignoreEvent(): boolean {
    // These are real controls, not editor content. Let their native pointer and
    // click handlers run instead of letting CodeMirror turn the gesture into a
    // cursor/selection transaction.
    return true;
  }
}

function buildReviewDecorations(doc: Text, config: CodeReviewConfig | null): DecorationSet {
  if (!config || config.showControls === false || !config.hunks.length) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const hunks = [...config.hunks].sort((a, b) => a.line - b.line || a.index - b.index);
  for (const hunk of hunks) {
    const lineNumber = Math.max(1, Math.min(hunk.line, doc.lines));
    const line = doc.line(lineNumber);
    builder.add(line.from, line.from, Decoration.widget({
      widget: new ReviewHunkWidget(hunk, config.hunks.length, config),
      side: -10_000 + hunk.index,
    }));
  }
  return builder.finish();
}

const reviewDecorationField = StateField.define<DecorationSet>({
  create(state) {
    return buildReviewDecorations(state.doc, state.field(reviewHunksField));
  },
  update(decorations, tr) {
    const changed = tr.docChanged || tr.effects.some((effect) => effect.is(setReviewHunks));
    if (!changed) return decorations;
    return buildReviewDecorations(tr.state.doc, tr.state.field(reviewHunksField));
  },
  provide: (field) => EditorView.decorations.from(field),
});

const revealCollapsedReviewHunk = EditorView.domEventHandlers({
  mousedown(event, view) {
    const config = view.state.field(reviewHunksField);
    if (!config?.onReveal || config.showControls !== false) return false;
    const target = event.target instanceof Element ? event.target : null;
    const diffLine = target?.closest<HTMLElement>(".cm-diff-line");
    if (!diffLine || target?.closest(".cm-review-hunk-controls")) return false;
    // Visual mode turns a single source line into headings, formulas, and other
    // structural widgets. Their painted geometry is not always invertible by
    // `posAtCoords`, but the decorated `.cm-line` is still rooted at the real
    // source offset. Prefer that stable DOM mapping; raw coordinates remain a
    // fallback for a renderer that replaces the line node completely.
    const markerLine = Number(diffLine.dataset.diffLine);
    let line: number | null = Number.isFinite(markerLine) ? markerLine : null;
    if (line === null) {
      let position: number | null = null;
      try {
        position = view.posAtDOM(diffLine, 0);
      } catch {
        position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      }
      if (position === null) return false;
      line = view.state.doc.lineAt(position).number;
    }
    line = Math.max(1, Math.min(line, view.state.doc.lines));
    const hunk = config.hunks.find((item) => (
      line >= item.line && line <= (item.endLine ?? item.line)
    ));
    if (!hunk) return false;
    // A diff highlight used to look clickable but behaved like ordinary text.
    // Keep the click as an inspection action: reveal the explicit answers
    // without silently accepting or rejecting research content.
    event.preventDefault();
    event.stopPropagation();
    config.onReveal(hunk.index);
    return true;
  },
});

/** Inline accept/reject controls anchored to the first line of each review hunk. */
export function reviewHunkDecorations(initial: CodeReviewConfig | null = null): Extension {
  return [reviewHunksField.init(() => initial), reviewDecorationField, revealCollapsedReviewHunk];
}

export function dispatchReviewHunks(view: EditorView, config: CodeReviewConfig | null): void {
  view.dispatch({ effects: setReviewHunks.of(config) });
}
