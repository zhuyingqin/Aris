import { EditorSelection, Facet, RangeSetBuilder, StateEffect, StateField, type EditorState, type RangeSet, type Transaction } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutterLineClass,
  lineNumberWidgetMarker,
  type DecorationSet,
} from "@codemirror/view";
import katex from "katex";
import { fileAssetUrl, fileReadBytesInfo, fileSearch } from "../api/tauri";
import { visualLatexForDisplayEnvironment } from "../math/latexMath";
import { renderPdfPageToCanvas } from "../pdf/canvas";
import { openPdfDocumentFromPath } from "../pdf/runtime";
import { createSvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import { TYPESET_EDITOR_COPY } from "./i18n";
import {
  LatexStructureIndex,
  scanLatexStructure,
  updateLatexStructure,
  type LatexArgument,
  type LatexCommand,
  type LatexHeading,
} from "./latexStructure";
import type { SectionNumberingPrefix } from "./outlineModel";
import {
  SECNUMDEPTH_CHAPTERED,
  SECNUMDEPTH_FLAT,
  SECTION_MATTER_COMMANDS,
  SECTION_RANKS,
  advanceSectionNumber,
  applySectionCounterReset,
  applySectionMatter,
  cloneSectionNumberingState,
  initialSectionNumberingState,
  sectionCounterResetFor,
  sectionDisplayLevel,
  type SectionCounterReset,
  type SectionMatter,
  type SectionNumberingRules,
} from "./sectionNumbering";
import { parseTable, type TableModel } from "./latexTable";
import { buildTableGrid, isTableGridEvent } from "./tableWidget";
import {
  reparseVisualLatex,
  visualDecorationScheduler,
} from "./visualDecorationScheduler";
import { renderTikzPreview } from "./tikzPreview";
export { VISUAL_REPARSE_IDLE_MS } from "./visualDecorationScheduler";

/**
 * Marker class for "block" widgets (display math, figures, tables) whose source
 * spans multiple lines and whose rendered form (KaTeX / an HTML table / a figure
 * card) has no reliable 1:1 mapping back to character positions. CodeMirror's
 * default click-to-position logic walks the DOM under the click and can land on
 * a wildly wrong offset inside such widgets (the "formula jumps elsewhere" bug).
 * Overleaf's own visual editor solves this the same way: these widgets opt out
 * of CM's default click handling (`ignoreEvent`) and a single app-wide `mouseup`
 * handler (`blockClickHandler` below) places the caret using only the click's
 * vertical position — `view.lineBlockAtHeight` — which is robust regardless of
 * what's rendered at that line.
 */
const BLOCK_TARGET_CLASS = "cm-vis-block-target";
const HEADING_TARGET_SELECTOR = ".cm-vis-heading-line, .cm-vis-h1, .cm-vis-h2, .cm-vis-h3, .cm-vis-h4, .cm-vis-secnum";
const VISUAL_DRAG_THRESHOLD_PX = 4;
/** @internal Exported so the pointer-selection state transition can be tested without DOM geometry. */
export const visualPointerSelecting = StateEffect.define<boolean>();
type VisualPointerStart = {
  x: number;
  y: number;
  /** Atomic visual objects have no DOM-to-source character mapping. Preserve
   * their exact source span so a drag that starts inside one can still create
   * a real CodeMirror selection (copy/delete/replace all keep working). */
  objectRange?: { from: number; to: number };
  release?: () => void;
};
const visualPointerStarts = new WeakMap<HTMLElement, VisualPointerStart>();
const visualEditorViews = new WeakMap<HTMLElement, EditorView>();
// A widget's `ignoreEvent` and the editor's delegated DOM handler can both see
// the very same bubbling `mousedown`. Starting the freeze twice tears down the
// first one in between (including a decoration rebuild), which is visible as a
// flash when a drag begins on a section number/title.
const handledVisualPointerDowns = new WeakSet<MouseEvent>();
export const visualSourcePath = Facet.define<string | null, string | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

/**
 * Injects the host's "switch to Code mode and select this source range"
 * callback (`Typeset.tsx`'s `openCodeRange`, already used for PDF-click and
 * search jumps) so widgets built from preamble metadata — `\title{}` /
 * `\author{}` have no rendered position of their own, only the `\maketitle`
 * widget does — can send a click straight to their real source location.
 */
type OpenCodeRange = ((start: number, end: number) => void) | null;
export const onOpenCodeRange = Facet.define<OpenCodeRange, OpenCodeRange>({
  combine: (values) => values[values.length - 1] ?? null,
});

/**
 * Injects the host's "forward-search this source position into the compiled
 * PDF" callback (`Typeset.tsx`'s `jumpToPdfForLine`), fired on double-click —
 * mirrors `onOpenCodeRange` above, just for the opposite direction.
 */
type ForwardSearch = ((line: number, column: number) => void) | null;
export const onForwardSearch = Facet.define<ForwardSearch, ForwardSearch>({
  combine: (values) => values[values.length - 1] ?? null,
});

/**
 * The counter state the whole document has reached where the open file is
 * `\input`, plus its class-wide numbering rules — supplied by `Typeset.tsx`
 * from the same outline walk that numbers the Outline panel.
 *
 * Without it the Visual editor counts headings from 1 over whatever file is
 * open, so a thesis chapter shows "1.2.1" next to a PDF that says "2.2.1". Only
 * the *prefix* is injected: the file's own `\setcounter`, `\appendix` and
 * headings are replayed from the live buffer below, so typing reflows the
 * numbers immediately instead of waiting for the debounced project analysis.
 */
export const visualNumbering = Facet.define<SectionNumberingPrefix | null, SectionNumberingPrefix | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

/** Shared `ignoreEvent`: let CM's own mouseup bookkeeping run, but nothing else. */
function blockIgnoreEvent(event: Event): boolean {
  if (event.type === "mousedown" && event instanceof MouseEvent) {
    const editor = eventElement(event.target)?.closest<HTMLElement>(".cm-editor");
    if (editor) {
      const view = visualEditorViews.get(editor);
      if (view) beginVisualPointerSelection(view, event);
      else {
        const current = visualPointerStarts.get(editor);
        visualPointerStarts.set(editor, { ...current, x: event.clientX, y: event.clientY });
      }
    }
  }
  return event.type !== "mouseup";
}

function beginVisualPointerSelection(view: EditorView, event: MouseEvent): void {
  if (handledVisualPointerDowns.has(event)) return;
  handledVisualPointerDowns.add(event);
  const editor = view.dom;
  visualPointerStarts.get(editor)?.release?.();
  const selectableObject = eventElement(event.target)?.closest<HTMLElement>("[data-visual-select-from][data-visual-select-to]");
  const objectFrom = Number(selectableObject?.dataset.visualSelectFrom);
  const objectTo = Number(selectableObject?.dataset.visualSelectTo);
  const objectRange = Number.isInteger(objectFrom)
    && Number.isInteger(objectTo)
    && objectFrom >= 0
    && objectTo > objectFrom
    && objectTo <= view.state.doc.length
    ? { from: objectFrom, to: objectTo }
    : undefined;
  const release = () => {
    const current = visualPointerStarts.get(editor);
    if (current?.release !== release) return;
    visualPointerStarts.delete(editor);
    window.removeEventListener("mouseup", release);
    window.removeEventListener("blur", release);
    editor.classList.remove("cm-vis-pointer-selecting");
    try {
      view.dispatch({ effects: visualPointerSelecting.of(false) });
    } catch {
      // The editor can be destroyed while the pointer is still held down.
    }
  };
  visualPointerStarts.set(editor, { x: event.clientX, y: event.clientY, objectRange, release });
  editor.classList.add("cm-vis-pointer-selecting");
  // Keep the existing decoration DOM mounted until the browser has finished
  // extending its native range. Replacing a heading or formula while the
  // pointer is down invalidates the selection anchor and makes the caret jump.
  view.dispatch({ effects: visualPointerSelecting.of(true) });
  window.addEventListener("mouseup", release);
  window.addEventListener("blur", release);
}

const visualViewRegistration = ViewPlugin.define((view) => {
  visualEditorViews.set(view.dom, view);
  return {
    destroy() {
      if (visualEditorViews.get(view.dom) === view) visualEditorViews.delete(view.dom);
      visualPointerStarts.get(view.dom)?.release?.();
      view.dom.classList.remove("cm-vis-pointer-selecting");
    },
  };
});

/**
 * Overleaf-style rich-text decorations for the Typeset visual editor.
 *
 * The document stays the raw `.tex` source; this plugin paints decorations over
 * it so headings render large and bold, emphasis renders inline, and the command
 * syntax (`\section{`, braces, …) is hidden. Hidden syntax is *revealed* whenever
 * the caret enters the command, so the source is always directly editable — the
 * source of truth is the text, never a parsed model.
 *
 * Phase 1 covers structural text: preamble folding, section headings (numbered),
 * and inline text commands (emph/textbf/textit/underline/texttt). Math, citations,
 * figures, and tables are layered on in later phases.
 */

type Range = { from: number; to: number };

/** Inline text commands that render as styled text with the markup hidden. */
const INLINE_TEXT_COMMANDS: Record<string, string> = {
  textbf: "cm-vis-bold",
  textit: "cm-vis-italic",
  emph: "cm-vis-italic",
  underline: "cm-vis-underline",
  texttt: "cm-vis-mono",
  textsc: "cm-vis-smallcaps",
  textsubscript: "cm-vis-sub",
  textsuperscript: "cm-vis-sup",
};

/**
 * Bare formatting declarations (no argument) that switch font size/series/family
 * or alignment for the rest of their group. We can't easily scope them, so in the
 * visual view they are simply hidden — they were pure formatting noise as raw text
 * (e.g. `\Huge\bfseries\coloraccent` on a hand-built title). `coloraccent` is a
 * common custom accent-color macro; harmless to hide when absent. Includes the
 * classic short-form aliases (`\bf`, `\it`, …) alongside the LaTeX2e names —
 * both show up on hand-built titles like `{\LARGE \bf My Title}`.
 */
const DECLARATION_NAMES = [
  "Huge", "huge", "LARGE", "Large", "large", "normalsize", "small", "footnotesize", "scriptsize", "tiny",
  "bfseries", "mdseries", "itshape", "upshape", "slshape", "scshape", "rmfamily", "sffamily", "ttfamily",
  "normalfont", "selectfont", "centering", "raggedright", "raggedleft", "coloraccent", "boldmath", "unboldmath",
  "noindent", "par", "bf", "it", "rm", "sc", "sl", "em", "tt",
] as const;
const DECLARATION_COMMANDS = new Set<string>(DECLARATION_NAMES);
const DECLARATION_INLINE_RE = new RegExp(`\\\\(?:${DECLARATION_NAMES.join("|")})(?![A-Za-z])`, "g");

/** Section command → the CSS class carrying its display size/weight. */
const SECTION_CLASS: Record<number, string> = {
  1: "cm-vis-h1",
  2: "cm-vis-h2",
  3: "cm-vis-h3",
  4: "cm-vis-h4",
};

/** A hidden-syntax mark: zero-width, atomic so the caret steps over it. */
const hiddenMark = Decoration.replace({});

/** Heading line decorations, keyed by level so the whole line gets block styling. */
const headingLine: Record<number, Decoration> = {
  1: Decoration.line({ class: "cm-vis-heading-line cm-vis-heading-1" }),
  2: Decoration.line({ class: "cm-vis-heading-line cm-vis-heading-2" }),
  3: Decoration.line({ class: "cm-vis-heading-line cm-vis-heading-3" }),
  4: Decoration.line({ class: "cm-vis-heading-line cm-vis-heading-4" }),
};

class VisualGutterClassMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
  eq(other: VisualGutterClassMarker) {
    return other.elementClass === this.elementClass;
  }
}

const headingGutterMarker: Record<number, VisualGutterClassMarker> = {
  1: new VisualGutterClassMarker("cm-vis-gutter-heading-1"),
  2: new VisualGutterClassMarker("cm-vis-gutter-heading-2"),
  3: new VisualGutterClassMarker("cm-vis-gutter-heading-3"),
  4: new VisualGutterClassMarker("cm-vis-gutter-heading-4"),
};

/** Dim a comment line so it reads as an annotation rather than body text. */
const commentMark = Decoration.mark({ class: "cm-vis-comment" });

/** Indent a list item line so the bullet/number hangs like a rendered list. */
const listItemLine = Decoration.line({ class: "cm-vis-list-line" });

/** Center + shrink a caption line. */
const captionLine = Decoration.line({ class: "cm-vis-caption-line" });
/** Italicized, indented body line inside `\begin{abstract}`. */
const abstractLine = Decoration.line({ class: "cm-vis-abstract-line" });
const activeMathLine = Decoration.line({ class: "cm-vis-active-math-line" });
const activeMathLineFirst = Decoration.line({ class: "cm-vis-active-math-line-first" });
const activeMathLineLast = Decoration.line({ class: "cm-vis-active-math-line-last" });
const frameLine = Decoration.line({ class: "cm-vis-frame-line" });
const frameFirstLine = Decoration.line({ class: "cm-vis-frame-first" });
const frameLastLine = Decoration.line({ class: "cm-vis-frame-last" });
/** Source that prints nothing — `\end{frame}`, `\begin{center}`, `\vspace`,
 * `\addcontentsline` — should not leave a blank visual row behind once it owns
 * the whole row. Applied by the blank-row pass in `buildDecorations`. */
const structuralOnlyLine = Decoration.line({ class: "cm-vis-structural-only-line" });
const structuralOnlyGutterMarker = new VisualGutterClassMarker("cm-vis-gutter-structural-only");
// Display math source spans one mark per visual line (CodeMirror splits a
// multi-line mark decoration at line boundaries), so it must not carry its own
// fill/radius — that renders as a stack of disconnected rounded rectangles.
// The callout band (`cm-vis-active-math-line*`, below) carries the background
// instead. Inline math is always a single short run, so it gets its own soft
// pill background — there's no multi-line seam to worry about.
const activeMathSourceDisplay = Decoration.mark({ class: "cm-vis-active-math-source" });
const activeMathSourceInline = Decoration.mark({
  class: "cm-vis-active-math-source cm-vis-active-math-source-inline",
});

/** Theorem-like environment names that receive readable Visual chrome. */
const THEOREM_ENVIRONMENTS = new Set([
  "theorem",
  "lemma",
  "proposition",
  "corollary",
  "definition",
  "remark",
  "example",
  "proof",
]);

const LIST_ENVIRONMENTS = new Set(["itemize", "enumerate"]);

/** Memoized alignment line decorations (center / flushleft / flushright). */
const alignLineCache: Record<string, Decoration> = {};
const alignLine = (cls: string): Decoration =>
  (alignLineCache[cls] ??= Decoration.line({ class: cls }));

/**
 * Replace each `\authorblockN{…}`/`\authorblockA{…}` (IEEEtran's per-line
 * name/affiliation macro) with a leading newline + its content, so each block
 * starts its own output line instead of running into the next one. Their
 * content routinely contains nested braces (`Name$^{1}$`), so this needs real
 * brace matching (`matchBrace`) rather than a `[^{}]*` regex, which stops at
 * the first inner `{` and fails to find the macro's true closing brace.
 */
function replaceAuthorBlocks(input: string): string {
  const re = /\\authorblock[NA]\s*\{/g;
  let result = "";
  let i = 0;
  for (let match = re.exec(input); match; match = re.exec(input)) {
    const openBrace = match.index + match[0].length - 1;
    const close = matchBrace(input, openBrace);
    if (close < 0) break; // unbalanced — leave the remainder as-is below
    result += input.slice(i, match.index) + "\n" + input.slice(openBrace + 1, close - 1);
    i = close;
    re.lastIndex = close;
  }
  return result + input.slice(i);
}

/**
 * Strip simple inline markup (`\emph{x}` → `x`) for chip/title display text.
 * Whitespace is normalized per-line (not globally) so the line breaks inserted
 * by `replaceAuthorBlocks` and `\\` forced breaks survive, while incidental
 * multi-space/wrap noise within a line still collapses.
 */
function stripMarkup(input: string): string {
  return replaceAuthorBlocks(input.replace(/%[^\n]*\n?/g, ""))
    .replace(/\\textsubscript\s*\{\$?\\infty\$?\}/g, "∞")
    .replace(/\\textsubscript\s*\{([^{}]*)\}/g, "$1")
    .replace(/\$\\infty\$/g, "∞")
    .replace(/\$([^$]+)\$/g, "$1")
    .replace(/\\infty/g, "∞")
    .replace(/\\(?:textbf|textit|emph|texttt|textsc|underline)\s*\{([^{}]*)\}/g, "$1")
    .replace(DECLARATION_INLINE_RE, "")
    .replace(/\\\\/g, "\n")
    .replace(/[{}]/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Numbering rules read from the open file alone. Only a fallback: whenever the
 * host knows the document graph it supplies the real ones through
 * `visualNumbering`, which is what lets an included chapter be numbered like a
 * chapter of its thesis rather than a document of its own.
 */
function localNumberingRules(headings: readonly LatexHeading[]): SectionNumberingRules {
  const hasChapters = headings.some((heading) => heading.command === "chapter");
  return {
    secnumdepth: hasChapters ? SECNUMDEPTH_CHAPTERED : SECNUMDEPTH_FLAT,
    hasParts: headings.some((heading) => heading.command === "part"),
    hasChapters,
  };
}

type NumberingEvent =
  | { at: number; kind: "heading"; heading: LatexHeading }
  | { at: number; kind: "matter"; matter: SectionMatter }
  | { at: number; kind: "counter"; reset: SectionCounterReset; command: LatexCommand };

/**
 * Headings, `\appendix`/`\mainmatter` switches and `\setcounter` assignments in
 * document order — the exact stream LaTeX's counters see. Reads the already-built
 * structure index rather than re-scanning, so it costs nothing per keystroke.
 *
 * Counter and division commands are read from the whole file, not just the body:
 * a `\setcounter{chapter}{1}` in the preamble still offsets the document, and
 * the Outline panel counts it, so skipping it here would put the two surfaces
 * back out of step. As in the outline, the command has to begin its line, which
 * keeps the sample `\setcounter` inside a `\newcommand` body out of it.
 */
function numberingEvents(
  structure: LatexStructureIndex,
  headings: readonly LatexHeading[],
  scanEnd: number,
): NumberingEvent[] {
  const events: NumberingEvent[] = headings.map((heading) => ({ at: heading.from, kind: "heading", heading }));
  for (const command of structure.commands) {
    if (command.from >= scanEnd) continue;
    if (structure.source.slice(structure.lineStartAt(command.from), command.from).trim().length > 0) continue;
    if (SECTION_MATTER_COMMANDS.has(command.name)) {
      events.push({ at: command.from, kind: "matter", matter: command.name as SectionMatter });
      continue;
    }
    const reset = sectionCounterResetFor(command);
    if (reset) events.push({ at: command.from, kind: "counter", reset, command });
  }
  // A switch and the heading it governs never share a position, so a stable
  // sort on the offset alone is enough.
  return events.sort((left, right) => left.at - right.at);
}

/** Convert a positive integer into the alphabetic counter used by enumitem. */
function alphabeticCounter(value: number, uppercase = false): string {
  let remaining = Math.max(1, Math.floor(value));
  let result = "";
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode((remaining % 26) + (uppercase ? 65 : 97)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

/** Convert a positive integer into the Roman counter used by enumitem. */
function romanCounter(value: number, uppercase = false): string {
  const numerals: Array<[number, string]> = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let remaining = Math.max(1, Math.floor(value));
  let result = "";
  for (const [amount, glyph] of numerals) {
    while (remaining >= amount) {
      result += glyph;
      remaining -= amount;
    }
  }
  return uppercase ? result : result.toLowerCase();
}

/**
 * Read an enumitem key without splitting commas inside a braced label, such as
 * `label=\\textbf{Step, \\arabic*}`. The visual editor intentionally only
 * needs the label key; layout keys (leftmargin, itemsep, ...) remain source
 * formatting and are folded separately.
 */
function enumitemOption(options: string | undefined, name: string): string | null {
  if (!options) return null;
  const source = options.trim().replace(/^\[/, "").replace(/\]$/, "");
  let depth = 0;
  let start = 0;
  const entries: string[] = [];
  for (let index = 0; index <= source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    if (index === source.length || (char === "," && depth === 0)) {
      entries.push(source.slice(start, index));
      start = index + 1;
    }
  }
  for (const entry of entries) {
    const equals = entry.indexOf("=");
    if (equals < 0 || entry.slice(0, equals).trim() !== name) continue;
    return entry.slice(equals + 1).trim() || null;
  }
  return null;
}

/** Render the common enumitem counter macros in a custom `label=...` value. */
function enumitemLabel(options: string | undefined, value: number): string | null {
  const template = enumitemOption(options, "label");
  if (!template) return null;
  const rendered = template
    .replace(/\\arabic\s*\*/g, String(value))
    .replace(/\\alph\s*\*/g, alphabeticCounter(value))
    .replace(/\\Alph\s*\*/g, alphabeticCounter(value, true))
    .replace(/\\roman\s*\*/g, romanCounter(value))
    .replace(/\\Roman\s*\*/g, romanCounter(value, true))
    .replace(/~/g, " ");
  return stripMarkup(rendered) || null;
}

/** Small chip shown in place of the folded preamble; click to jump to source. */
class PreambleWidget extends WidgetType {
  constructor(private readonly lineCount: number) {
    super();
  }
  eq(other: PreambleWidget) {
    return other.lineCount === this.lineCount;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-vis-preamble";
    const label = document.createElement("span");
    label.textContent = "Document preamble";
    const count = document.createElement("strong");
    count.textContent = `${this.lineCount} lines`;
    el.append(label, count);
    el.title = "Preamble is hidden in the visual view — edit it in Code mode";
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class PreambleLineNumberMarker extends GutterMarker {
  readonly elementClass = "cm-vis-gutter-preamble";
  constructor(private readonly number: string) {
    super();
  }
  eq(other: PreambleLineNumberMarker) {
    return other.number === this.number;
  }
  toDOM() {
    return document.createTextNode(this.number);
  }
}

const visualWidgetLineNumbers = lineNumberWidgetMarker.of((view, widget, block) => {
  if (!(widget instanceof PreambleWidget)) return null;
  return new PreambleLineNumberMarker(String(view.state.doc.lineAt(block.from).number));
});

/** Small bold label block in place of a hidden environment marker (e.g. "Abstract"). */
class SectionLabelWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }
  eq(other: SectionLabelWidget) {
    return other.label === this.label;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-vis-section-label ${BLOCK_TARGET_CLASS}`;
    el.textContent = this.label;
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

/** Small theorem/lemma label in place of a LaTeX theorem environment marker. */
class TheoremLabelWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly sourceRange: Range,
    private readonly onJump: OpenCodeRange,
  ) {
    super();
  }
  eq(other: TheoremLabelWidget) {
    return other.label === this.label
      && other.sourceRange.from === this.sourceRange.from
      && other.sourceRange.to === this.sourceRange.to;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-vis-theorem-label ${BLOCK_TARGET_CLASS}`;
    el.textContent = this.label;
    if (this.onJump) {
      el.classList.add("cm-vis-theorem-editable");
      el.title = "Double-click to edit theorem source in Code mode";
      el.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onJump?.(this.sourceRange.from, this.sourceRange.to);
      });
    }
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

/**
 * The number LaTeX prints in front of a heading, rendered before its text.
 *
 * It is generated, not source: the `.tex` says `\section{Title}`, so the number
 * opts out of selection and copy the way the compiled PDF's own number would if
 * you dragged across it. `origin` explains where the counter came from — the
 * open file alone, or the whole document — which is the difference between
 * "1.2.1" and the "2.2.1" the PDF shows for an `\input` chapter.
 */
class SectionNumberWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly level: number,
    /** True when the counter carried over from earlier files in the document. */
    private readonly continued = false,
  ) {
    super();
  }
  eq(other: SectionNumberWidget) {
    return other.label === this.label && other.level === this.level && other.continued === this.continued;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-vis-secnum cm-vis-secnum-${this.level}`;
    el.textContent = this.label;
    // Generated, not source: a screen reader already reads the heading, and a
    // drag across the title should not copy a number the .tex doesn't contain.
    el.setAttribute("aria-hidden", "true");
    const copy = TYPESET_EDITOR_COPY[useStore.getState().language].sectionNumber;
    el.title = this.continued ? copy.continued : copy.local;
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

/**
 * `\setcounter{chapter}{1}` shown as what it does rather than as raw markup.
 *
 * The command is the reason the headings below it are numbered from 2, and now
 * that the numbers themselves say so, leaving the source visible put a line of
 * unrendered LaTeX in the middle of an otherwise rendered document. Clicking it
 * still reveals the source, like every other replaced construct.
 */
class CounterWidget extends WidgetType {
  constructor(private readonly counter: string, private readonly value: number, private readonly mode: "set" | "add") {
    super();
  }
  eq(other: CounterWidget) {
    return other.counter === this.counter && other.value === this.value && other.mode === this.mode;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-vis-chip cm-vis-chip-counter";
    const copy = TYPESET_EDITOR_COPY[useStore.getState().language].sectionNumber;
    // The counter name stays as LaTeX wrote it — it is an identifier, not prose.
    el.textContent = this.mode === "add"
      ? copy.counterAdd(this.counter, this.value)
      : copy.counterSet(this.counter, this.value);
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

/**
 * `ootnote{…}` as the marker the PDF prints, with its text on hover.
 *
 * Left raw, a footnote drops a paragraph of source into the middle of a
 * sentence and makes the surrounding prose unreadable in a WYSIWYG view — which
 * is exactly what a footnote is designed not to do.
 */
class FootnoteWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  eq(other: FootnoteWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const el = document.createElement("sup");
    el.className = "cm-vis-footnote";
    el.textContent = "*";
    el.title = this.text;
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

/**
 * Typographic source that has a printed form: spacing macros, the dashes TeX
 * builds from hyphen runs, and TeX quoting. Rendering them is what makes the
 * Visual page match the PDF instead of showing the recipe for it.
 */
export const TYPOGRAPHIC_TEXT: Record<string, string> = {
  "~": "\u00a0",
  "\\,": "\u2009",
  "\\;": "\u2005",
  "\\:": "\u2004",
  "\\quad": "\u2003",
  "\\qquad": "\u2003\u2003",
  "---": "\u2014",
  "--": "\u2013",
  "``": "\u201c",
  "''": "\u201d",
  "\\ldots": "\u2026",
  "\\dots": "\u2026",
  "\\textendash": "\u2013",
  "\\textemdash": "\u2014",
};
// Longest-first so `---` wins over `--`, and `\qquad` over `\quad`. The
// trailing guard keeps `\quadrature` from matching `\quad`.
export const TYPOGRAPHIC_RE = new RegExp(
  Object.keys(TYPOGRAPHIC_TEXT)
    .sort((left, right) => right.length - left.length)
    .map((token) => `${token.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}${/[A-Za-z]$/.test(token) ? "(?![A-Za-z])" : ""}`)
    .join("|"),
  "g",
);

/** A rendered typographic character standing in for its source. */
class TypographicWidget extends WidgetType {
  constructor(private readonly rendered: string, private readonly source: string) {
    super();
  }
  eq(other: TypographicWidget) {
    return other.rendered === this.rendered && other.source === this.source;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-vis-typographic";
    el.textContent = this.rendered;
    el.title = this.source;
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

/** Compact slide index rendered before a Beamer frame title. */
class FrameKickerWidget extends WidgetType {
  constructor(private readonly number: number, private readonly fallbackTitle = "") {
    super();
  }
  eq(other: FrameKickerWidget) {
    return other.number === this.number && other.fallbackTitle === this.fallbackTitle;
  }
  toDOM() {
    const wrapper = document.createElement("span");
    wrapper.className = `cm-vis-frame-header ${BLOCK_TARGET_CLASS}`;
    const kicker = document.createElement("span");
    kicker.className = "cm-vis-frame-kicker";
    kicker.textContent = `Slide ${this.number}`;
    wrapper.append(kicker);
    if (this.fallbackTitle) {
      const title = document.createElement("strong");
      title.className = "cm-vis-frame-title";
      title.textContent = this.fallbackTitle;
      wrapper.append(title);
    }
    return wrapper;
  }
  ignoreEvent = blockIgnoreEvent;
}

/** A small pill chip — citations, cross-references, and standalone commands. */
class ChipWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly variant: string,
    private readonly title: string = "",
  ) {
    super();
  }
  eq(other: ChipWidget) {
    return other.label === this.label && other.variant === this.variant && other.title === this.title;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-vis-chip cm-vis-chip-${this.variant}`;
    el.textContent = this.label;
    if (this.title) el.title = this.title;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** Plain inline text emitted for a simple user-defined LaTeX macro. */
class CustomMacroWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  eq(other: CustomMacroWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-vis-custom-macro";
    el.textContent = this.text;
    el.title = "User-defined LaTeX macro — edit its source in Visual or Code view";
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** A forced line break rendered as an actual break. */
class BreakWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-vis-break";
    el.appendChild(document.createElement("br"));
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

/** A source page break shown as a compact divider in the visual editor. */
class PageBreakWidget extends WidgetType {
  constructor(private readonly command: "newpage" | "clearpage") {
    super();
  }
  eq(other: PageBreakWidget) {
    return other.command === this.command;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-vis-page-break ${BLOCK_TARGET_CLASS}`;
    const copy = TYPESET_EDITOR_COPY[useStore.getState().language].pageBreak;
    const pageBreakLabel = copy.label(this.command);
    el.setAttribute("aria-label", pageBreakLabel);
    el.title = pageBreakLabel;
    const before = document.createElement("span");
    const label = document.createElement("span");
    const after = document.createElement("span");
    before.className = "cm-vis-page-break-line";
    label.className = "cm-vis-page-break-label";
    after.className = "cm-vis-page-break-line";
    label.textContent = copy.short;
    el.append(before, label, after);
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

/** List bullet / number marker shown in place of `\item`. */
class ItemMarkerWidget extends WidgetType {
  constructor(private readonly marker: string) {
    super();
  }
  eq(other: ItemMarkerWidget) {
    return other.marker === this.marker;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.marker === "•"
      ? "cm-vis-item-marker cm-vis-item-marker-bullet"
      : "cm-vis-item-marker";
    el.textContent = this.marker;
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

function rangesEqual(a: Range | null, b: Range | null): boolean {
  if (a === null || b === null) return a === b;
  return a.from === b.from && a.to === b.to;
}

/**
 * Centered title block rendered in place of `\maketitle`. Unlike every other
 * `BLOCK_TARGET_CLASS` widget, this one has no source range of its own to
 * reveal: `\title{}`/`\author{}`/`\date{}` live in the preamble (folded
 * unconditionally in Visual mode, regardless of caret position), while this
 * widget sits at `\maketitle`'s position — a different part of the document.
 * So instead of the generic block-click reveal, each line jumps straight to
 * its real source range in Code mode via `onJump` (`Typeset.tsx`'s
 * `openCodeRange`, threaded in through the `onOpenCodeRange` facet).
 */
class TitleWidget extends WidgetType {
  constructor(
    private readonly title: string,
    private readonly author: string,
    private readonly date: string,
    private readonly titleRange: Range | null,
    private readonly authorRange: Range | null,
    private readonly dateRange: Range | null,
    private readonly onJump: OpenCodeRange,
  ) {
    super();
  }
  eq(other: TitleWidget) {
    return other.title === this.title
      && other.author === this.author
      && other.date === this.date
      && rangesEqual(other.titleRange, this.titleRange)
      && rangesEqual(other.authorRange, this.authorRange)
      && rangesEqual(other.dateRange, this.dateRange);
  }
  private jumpTarget(el: HTMLElement, range: Range | null) {
    if (!range || !this.onJump) return;
    const onJump = this.onJump;
    el.classList.add("cm-vis-title-editable");
    el.title = "Double-click to edit in Code mode";
    el.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onJump(range.from, range.to);
    });
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-vis-title";
    const h = document.createElement("div");
    h.className = "cm-vis-title-name";
    h.textContent = this.title || "Untitled";
    this.jumpTarget(h, this.titleRange);
    el.append(h);
    if (this.author) {
      const a = document.createElement("div");
      a.className = "cm-vis-title-author";
      a.textContent = this.author;
      this.jumpTarget(a, this.authorRange);
      el.append(a);
    }
    if (this.date) {
      const d = document.createElement("div");
      d.className = "cm-vis-title-date";
      d.textContent = this.date;
      this.jumpTarget(d, this.dateRange);
      el.append(d);
    }
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function headingTitleRangeAtLine(state: EditorState, lineFrom: number): Range | null {
  const line = state.doc.lineAt(lineFrom);
  const lineText = line.text;
  const hm = /\\(chapter|section|subsection|subsubsection|paragraph)\*?\s*\{/.exec(lineText);
  if (!hm) return null;
  const openBrace = line.from + hm.index + hm[0].length - 1;
  const close = matchBrace(state.doc.toString(), openBrace);
  if (close < 0) return null;
  return { from: openBrace + 1, to: close - 1 };
}

function distanceOutside(value: number, from: number, to: number): number {
  if (value < from) return from - value;
  if (value > to) return value - to;
  return 0;
}

function positionInRangeAtCoords(view: EditorView, from: number, to: number, clientX: number, clientY: number): number {
  let bestPos = from;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let pos = from; pos <= to; pos += 1) {
    const rect = view.coordsAtPos(pos);
    if (!rect) continue;
    const x = (rect.left + rect.right) / 2;
    const verticalMiss = distanceOutside(clientY, rect.top, rect.bottom);
    const horizontalMiss = Math.abs(clientX - x);
    const score = verticalMiss * 1000 + horizontalMiss;
    if (score < bestScore) {
      bestScore = score;
      bestPos = pos;
    }
  }
  return bestPos;
}

function dirname(path: string | null): string {
  if (!path) return "";
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : "";
}

function joinPath(base: string, child: string): string {
  if (!base) return child;
  if (/^[a-zA-Z]:[\\/]/.test(child) || child.startsWith("/") || child.startsWith("\\")) return child;
  return `${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

const FIGURE_FILE_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"] as const;

function normalizedFigurePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function figurePathName(path: string): string {
  const normalized = normalizedFigurePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function figurePathVariants(path: string): string[] {
  const normalized = normalizedFigurePath(path);
  if (!normalized) return [];
  if (/\.[^./]+$/.test(figurePathName(normalized))) return [normalized];
  return [normalized, ...FIGURE_FILE_EXTENSIONS.map((extension) => `${normalized}${extension}`)];
}

/** Candidate paths in the same order LaTex authors conventionally expect:
 * adjacent to the source first, then project-root-relative. */
export function figurePathCandidates(imagePath: string, sourcePath: string | null): string[] {
  const candidates: string[] = [];
  for (const variant of figurePathVariants(imagePath)) {
    for (const candidate of [joinPath(dirname(sourcePath), variant), variant]) {
      const normalized = normalizedFigurePath(candidate);
      if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
    }
  }
  return candidates;
}

/** A bare `\includegraphics{name}` can be resolved through `\graphicspath`.
 * The visual editor does not compile TeX, so use a unique project match only;
 * choosing between duplicate file names would be worse than showing the honest
 * placeholder. */
export function uniqueFigureSearchMatch(imagePath: string, matches: readonly string[]): string | null {
  const requestedNames = new Set(figurePathVariants(imagePath).map((path) => figurePathName(path).toLowerCase()));
  const matching = matches
    .map(normalizedFigurePath)
    .filter((path) => requestedNames.has(figurePathName(path).toLowerCase()));
  return matching.length === 1 ? matching[0] : null;
}

function mimeForImage(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

async function resolveFigurePath(imagePath: string, sourcePath: string | null): Promise<string> {
  const candidates = figurePathCandidates(imagePath, sourcePath);
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const file = await fileReadBytesInfo(candidate);
      if (file.bytes > 0) return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  // `\graphicspath{{figures/}{images/}}` is common in multi-file papers, but
  // the active chapter contains only the bare file name. Fall back to one
  // unambiguous match inside this local workspace after direct resolution has
  // failed. This avoids guessing when a project has two different `plot.png`s.
  const imageName = figurePathName(imagePath);
  if (imageName) {
    try {
      const matches = await fileSearch(`**/${imageName}`);
      const matchedPath = Array.isArray(matches) ? uniqueFigureSearchMatch(imagePath, matches) : null;
      if (matchedPath) {
        const file = await fileReadBytesInfo(matchedPath);
        if (file.bytes > 0) return matchedPath;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error(`Figure not found: ${imagePath}`);
}

/** Build the caption `<div>` shared by figure and table widgets. */
function buildCaptionEl(caption: string): HTMLDivElement {
  const cap = document.createElement("div");
  cap.className = "cm-vis-caption";
  cap.textContent = caption;
  return cap;
}

async function renderFigureInto(el: HTMLDivElement, imagePath: string, sourcePath: string | null) {
  if (!imagePath) return;
  const resolvedPath = await resolveFigurePath(imagePath, sourcePath);
  const mime = mimeForImage(resolvedPath);
  el.replaceChildren();
  if (mime === "application/pdf") {
    const pdf = await openPdfDocumentFromPath(resolvedPath);
    const page = await pdf.getPage(1);
    const canvas = document.createElement("canvas");
    canvas.className = "cm-vis-figure-pdf";
    const render = renderPdfPageToCanvas(page, canvas, 1.15);
    await render.task.promise;
    el.append(canvas);
    await pdf.destroy();
  } else if (mime.startsWith("image/")) {
    const url = await fileAssetUrl(resolvedPath, mime);
    if (url.startsWith("blob:")) el.dataset.objectUrl = url;
    const img = document.createElement("img");
    img.src = url;
    img.alt = imagePath;
    el.append(img);
  }
  const name = document.createElement("div");
  name.className = "cm-vis-figure-name";
  name.textContent = imagePath;
  el.append(name);
}

/**
 * Combined `\begin{figure}…\end{figure}` widget — image placeholder + caption
 * rendered together as ONE unit. Overleaf's real visual editor treats a whole
 * float environment as a single atomic block (see `atomic-decorations.ts`
 * `shouldDecorateFromLineEdges`/`TabularEnvironment` handling): either the whole
 * thing renders, or the whole thing is raw source when the caret is inside it —
 * never a mix of independently-hidden pieces, which is what produced the
 * "reveals one line at a time" jumble.
 */
class FigureWidget extends WidgetType {
  constructor(
    private readonly path: string,
    private readonly caption: string,
    private readonly sourcePath: string | null,
  ) {
    super();
  }
  eq(other: FigureWidget) {
    return other.path === this.path && other.caption === this.caption && other.sourcePath === this.sourcePath;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-vis-figure ${BLOCK_TARGET_CLASS}`;
    const icon = createSvgIcon("image", 28, "cm-vis-figure-icon");
    const name = document.createElement("div");
    name.className = "cm-vis-figure-name";
    name.textContent = this.path.split("/").pop() || this.path;
    el.append(icon, name);
    void renderFigureInto(el, this.path, this.sourcePath)
      .then(() => {
        if (this.caption) el.append(buildCaptionEl(this.caption));
      })
      .catch(() => {
        if (this.caption) el.append(buildCaptionEl(this.caption));
      });
    return el;
  }
  destroy(dom: HTMLElement) {
    const url = dom.dataset.objectUrl;
    if (url) URL.revokeObjectURL(url);
  }
  ignoreEvent = blockIgnoreEvent;
}

/** Standalone `\includegraphics{…}` with no enclosing `figure` environment. */
class GraphicsWidget extends WidgetType {
  constructor(
    private readonly path: string,
    private readonly sourcePath: string | null,
  ) {
    super();
  }
  eq(other: GraphicsWidget) {
    return other.path === this.path && other.sourcePath === this.sourcePath;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-vis-figure ${BLOCK_TARGET_CLASS}`;
    const icon = createSvgIcon("image", 28, "cm-vis-figure-icon");
    const name = document.createElement("div");
    name.className = "cm-vis-figure-name";
    name.textContent = this.path.split("/").pop() || this.path;
    el.append(icon, name);
    void renderFigureInto(el, this.path, this.sourcePath).catch(() => undefined);
    return el;
  }
  destroy(dom: HTMLElement) {
    const url = dom.dataset.objectUrl;
    if (url) URL.revokeObjectURL(url);
  }
  ignoreEvent = blockIgnoreEvent;
}

/**
 * Rendered `tabular` grid, optionally with its float caption attached — shown
 * in place of the whole LaTeX table (see FigureWidget doc comment above).
 */
class TableWidget extends WidgetType {
  constructor(
    private readonly rows: string[][],
    private readonly hasHeader: boolean,
    private readonly caption: string = "",
    private readonly sourceRange: Range,
    /** Lossless model of the same environment; null when it could not be
     * parsed, in which case the grid renders read-only as it always did. */
    private readonly model: TableModel | null = null,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return (
      other.hasHeader === this.hasHeader &&
      other.caption === this.caption &&
      rangesEqual(other.sourceRange, this.sourceRange) &&
      Boolean(other.model) === Boolean(this.model) &&
      JSON.stringify(other.rows) === JSON.stringify(this.rows)
    );
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = `cm-vis-table-wrap ${BLOCK_TARGET_CLASS}`;
    wrap.dataset.visualSelectFrom = String(this.sourceRange.from);
    wrap.dataset.visualSelectTo = String(this.sourceRange.to);
    wrap.setAttribute("role", "group");
    const copy = TYPESET_EDITOR_COPY[useStore.getState().language].table;
    wrap.setAttribute("aria-label", copy.tableLabel);
    wrap.append(buildTableGrid({
      view,
      model: this.model,
      rendered: this.rows,
      hasHeader: this.hasHeader,
      blockTargetClass: BLOCK_TARGET_CLASS,
      copy,
    }));
    if (this.caption) wrap.append(buildCaptionEl(this.caption));
    return wrap;
  }
  // The grid hosts its own `contenteditable` cells. Without this CodeMirror
  // would try to map their DOM mutations back into the document and corrupt it.
  ignoreMutation = () => true;
  ignoreEvent = (event: Event) => (isTableGridEvent(event) ? true : blockIgnoreEvent(event));
}

/**
 * Best-effort preview for a `figure`/`table` float whose content is a
 * graph-shaped TikZ/PGF drawing. The source is unchanged; double-click/caret
 * still opens it in Code view to edit the drawing. When the lightweight
 * previewer cannot find graph data, the card remains an honest fallback rather
 * than pretending to have compiled arbitrary TeX.
 */
class DiagramWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly caption: string,
    private readonly tikzSource: string,
    private readonly sourceRange: Range,
  ) {
    super();
  }
  eq(other: DiagramWidget) {
    return other.label === this.label
      && other.caption === this.caption
      && other.tikzSource === this.tikzSource
      && rangesEqual(other.sourceRange, this.sourceRange);
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-vis-figure cm-vis-diagram ${BLOCK_TARGET_CLASS}`;
    el.dataset.visualSelectFrom = String(this.sourceRange.from);
    el.dataset.visualSelectTo = String(this.sourceRange.to);
    const preview = renderTikzPreview(this.tikzSource);
    if (preview) {
      // Diagrams commonly need a wider natural canvas than the text column.
      // Do not squash their labels and arrows to make every diagram fit: the
      // dedicated canvas keeps the SVG at its authored preview size and offers
      // horizontal scrolling when necessary.
      const canvas = document.createElement("div");
      canvas.className = "cm-vis-diagram-canvas";
      canvas.append(preview);
      el.append(canvas);
    } else {
      const icon = createSvgIcon("diagram", 28, "cm-vis-figure-icon");
      el.append(icon);
      const name = document.createElement("div");
      name.className = "cm-vis-figure-name";
      name.textContent = this.label;
      el.append(name);
      const hint = document.createElement("div");
      hint.className = "cm-vis-diagram-hint";
      hint.textContent = "Preview unavailable; edit in Code view to change the drawing";
      el.append(hint);
    }
    if (this.caption) el.append(buildCaptionEl(this.caption));
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

type TabularMatch = {
  from: number;
  to: number;
  body: string;
  environment: "tabular" | "longtable";
  source: string;
};

type FrameMatch = {
  from: number;
  beginTo: number;
  endFrom: number;
  to: number;
  title: string | null;
  titleFrom: number | null;
  titleTo: number | null;
};

/**
 * Match Beamer frames with a depth counter. A regex with a lazy body stops at
 * the first `\\end{frame}` and therefore leaves an enclosing nested frame raw.
 */
function findFrameMatches(structure: LatexStructureIndex, from: number, to: number): FrameMatch[] {
  return structure.environments
    .filter((environment) => environment.name === "frame"
      && environment.closed
      && environment.from >= from
      && environment.from < to)
    .map((environment) => {
      const begin = structure.commands.find((command) => command.from === environment.beginFrom && command.name === "begin");
      const titleArgument = begin?.requiredArguments[1] ?? null;
      return {
        from: environment.from,
        beginTo: environment.beginTo,
        endFrom: environment.endFrom,
        to: environment.to,
        title: titleArgument?.value ?? null,
        titleFrom: titleArgument?.contentFrom ?? null,
        titleTo: titleArgument?.contentTo ?? null,
      };
    })
    .sort((left, right) => left.from - right.from || right.to - left.to);
}

function findTabularMatches(text: string, structure: LatexStructureIndex, from: number, to: number): TabularMatch[] {
  return structure.environments
    .filter((environment) => (environment.name === "tabular" || environment.name === "longtable")
      && environment.closed
      && environment.from >= from
      && environment.from < to)
    .map((environment) => {
      let bodyFrom = environment.bodyFrom;
      while (bodyFrom < environment.bodyTo && /\s/.test(text[bodyFrom])) bodyFrom += 1;
      if (text[bodyFrom] === "{") {
        const specEnd = matchBrace(text, bodyFrom);
        if (specEnd > 0 && specEnd <= environment.bodyTo) bodyFrom = specEnd;
      }
      return {
        from: environment.from,
        to: environment.to,
        body: text.slice(bodyFrom, environment.bodyTo),
        environment: environment.name as TabularMatch["environment"],
        source: text.slice(environment.from, environment.to),
      };
    });
}

/**
 * The lossless model behind an editable grid, or null when the environment is
 * one we would not be able to write back faithfully.
 *
 * `longtable` is deliberately excluded: its `\endfirsthead`/`\endfoot` sections
 * are not rows, and re-serializing one from a row list would destroy the
 * repeating-header machinery that is the whole point of the environment.
 */
function editableTableModel(text: string, match: TabularMatch | undefined): TableModel | null {
  if (!match || match.environment !== "tabular") return null;
  return parseTable(text, match.from, match.to);
}

/** Make user-defined table macros legible without changing their source. */
function stripTableCellMarkup(input: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < input.length) {
    if (input[cursor] !== "\\") {
      output += input[cursor];
      cursor += 1;
      continue;
    }
    const command = /\\([A-Za-z@]+)\s*/y;
    command.lastIndex = cursor;
    const match = command.exec(input);
    if (!match) {
      output += input[cursor];
      cursor += 1;
      continue;
    }
    const name = match[1];
    let argumentStart = command.lastIndex;
    const argumentsText: string[] = [];
    while (argumentStart < input.length) {
      const whitespace = /\s*/y;
      whitespace.lastIndex = argumentStart;
      whitespace.exec(input);
      const nextArgument = whitespace.lastIndex;
      if (input[nextArgument] !== "{") break;
      argumentStart = nextArgument;
      const argumentEnd = matchBrace(input, argumentStart);
      if (argumentEnd < 0) break;
      argumentsText.push(stripTableCellMarkup(input.slice(argumentStart + 1, argumentEnd - 1)));
      argumentStart = argumentEnd;
    }
    if (argumentsText.length === 0) {
      // Formatting-only declarations (for example `\core`) have no readable
      // text of their own in the table card.
      cursor = command.lastIndex;
      continue;
    }
    if (name === "textcolor" && argumentsText.length > 1) {
      output += argumentsText.slice(1).join(" ");
    } else if (name === "evidence" && argumentsText.length > 1) {
      output += `[${argumentsText[0]} p.${argumentsText[1]}]`;
    } else {
      output += argumentsText.join(" ");
    }
    cursor = argumentStart;
  }
  return stripMarkup(output);
}

/** Split a `tabular`/`longtable` body into a grid, dropping layout commands. */
function parseTabular(body: string): string[][] {
  const cleaned = body
    .replace(/\\(top|mid|bottom)rule/g, "")
    .replace(/\\addlinespace(?:\[[^\]]*\])?/g, "")
    .replace(/\\hline/g, "")
    .replace(/\\cmidrule\s*(\([^)]*\))?\s*(\[[^\]]*\])?\s*\{[^}]*\}/g, "")
    .replace(/\\end(?:firsthead|head|foot|lastfoot)\b/g, "");
  return cleaned
    .split(/\\\\/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const multicol = /\\multicolumn\s*\{\d+\}\s*\{[^}]*\}\s*\{([\s\S]*)\}/.exec(row);
      if (multicol) return [stripTableCellMarkup(multicol[1]).replace(/\\([%&_#$])/g, "$1").trim()];
      return row
        .split(/(?<!\\)&/)
        .map((cell) => stripTableCellMarkup(cell).replace(/\\([%&_#$])/g, "$1").trim());
    });
}

function removeTableCaption(body: string): { body: string; caption: string } {
  const captionRe = /\\caption\s*(?:\[[^\]]*\]\s*)?\{/g;
  const caption = captionRe.exec(body);
  if (!caption) return { body, caption: "" };
  const openBrace = caption.index + caption[0].length - 1;
  const captionEnd = matchBrace(body, openBrace);
  if (captionEnd < 0) return { body, caption: "" };
  let afterCaption = captionEnd;
  const labelRe = /\s*\\label\s*\{/y;
  while (afterCaption < body.length) {
    labelRe.lastIndex = afterCaption;
    const label = labelRe.exec(body);
    if (!label) break;
    const labelOpenBrace = labelRe.lastIndex - 1;
    const labelEnd = matchBrace(body, labelOpenBrace);
    if (labelEnd < 0) break;
    afterCaption = labelEnd;
  }
  const rowBreak = /\s*\\\\(?:\s*\[[^\]]*\])?/y;
  rowBreak.lastIndex = afterCaption;
  if (rowBreak.exec(body)) afterCaption = rowBreak.lastIndex;
  return {
    body: body.slice(0, caption.index) + body.slice(afterCaption),
    caption: stripTableCellMarkup(body.slice(openBrace + 1, captionEnd - 1)),
  };
}

function longtableRows(body: string): { rows: string[][]; hasHeader: boolean; caption: string } {
  const withoutCaption = removeTableCaption(body);
  const firstHead = withoutCaption.body.indexOf("\\endfirsthead");
  const endFoot = Math.max(
    withoutCaption.body.indexOf("\\endlastfoot"),
    withoutCaption.body.indexOf("\\endfoot"),
  );
  if (firstHead < 0 || endFoot < 0) {
    const rows = parseTabular(withoutCaption.body);
    return { rows, hasHeader: /\\toprule/.test(body), caption: withoutCaption.caption };
  }
  const headerRows = parseTabular(withoutCaption.body.slice(0, firstHead));
  const endFootMarker = withoutCaption.body.startsWith("\\endlastfoot", endFoot)
    ? "\\endlastfoot"
    : "\\endfoot";
  const bodyRows = parseTabular(withoutCaption.body.slice(endFoot + endFootMarker.length));
  const header = headerRows[headerRows.length - 1];
  return {
    rows: header ? [header, ...bodyRows] : bodyRows,
    hasHeader: Boolean(header),
    caption: withoutCaption.caption,
  };
}

/** KaTeX-rendered math, shown in place of the `$…$` / `\[…\]` source. */
class MathWidget extends WidgetType {
  constructor(
    private readonly latex: string,
    private readonly display: boolean,
    private readonly sourceRange: Range,
    private readonly editRange: Range,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.latex === this.latex
      && other.display === this.display
      && rangesEqual(other.sourceRange, this.sourceRange)
      && rangesEqual(other.editRange, this.editRange);
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display
      ? `cm-vis-math cm-vis-math-display ${BLOCK_TARGET_CLASS}`
      : "cm-vis-math";
    // KaTeX emits a deeply nested presentation tree with no stable mapping to
    // source characters. Keep the lossless source/edit spans on its root so a
    // click on any child can reveal the real LaTeX and a drag can select the
    // formula as one atomic object.
    el.dataset.visualSelectFrom = String(this.sourceRange.from);
    el.dataset.visualSelectTo = String(this.sourceRange.to);
    el.dataset.visualEditFrom = String(this.editRange.from);
    el.dataset.visualEditTo = String(this.editRange.to);
    try {
      katex.render(this.latex, el, {
        displayMode: this.display,
        throwOnError: false,
        output: "html",
      });
    } catch {
      el.textContent = this.latex;
    }
    return el;
  }
  // KaTeX's nested DOM has no source-character mapping. Let native selection
  // start on both inline and display math while freezing Visual decorations;
  // mouseup is handed back to the editor for stable caret placement.
  ignoreEvent = blockIgnoreEvent;
}

/**
 * Places the caret using only the click's vertical position, not the exact pixel
 * clicked — `view.lineBlockAtHeight` finds which SOURCE line renders at that
 * height and drops the caret at its end. This is what actually fixes the
 * "clicking a formula jumps the caret somewhere else" bug: computing an exact
 * character offset by walking a KaTeX/table DOM subtree is unreliable (that DOM
 * has no simple 1:1 relationship to source characters), but "which line is at
 * this height" is robust regardless of what's rendered there. Matches Overleaf's
 * own `placeSelectionInsideBlock` (source-editor/extensions/visual/selection.ts).
 */
const visualBlockClickHandlers = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = eventElement(event.target);
    if (target?.closest(".cm-review-hunk-controls")) return false;
    beginVisualPointerSelection(view, event);
    return false;
  },
  mouseup(event, view) {
    const eventTarget = eventElement(event.target);
    if (eventTarget?.closest(".cm-review-hunk-controls")) return false;
    const pointerStart = visualPointerStarts.get(view.dom);
    // The window listener normally releases the frozen decorations after this
    // handler bubbles. The microtask also covers hosts that stop propagation.
    if (pointerStart?.release) queueMicrotask(pointerStart.release);
    const target = eventTarget;
    if (!target) return false;
    const isBlockTarget = Boolean(target.closest(`.${BLOCK_TARGET_CLASS}`));
    const isHeadingTarget = Boolean(target.closest(HEADING_TARGET_SELECTOR));
    const mathTarget = target.closest<HTMLElement>(".cm-vis-math");
    if (!isBlockTarget && !isHeadingTarget && !mathTarget) return false;
    // A drag selection can end over a rendered block or heading. Treating that
    // mouseup as a click collapses the range and scrolls to the derived source
    // position, which makes Visual mode appear to jump while text is selected.
    // Track pointer movement as well as selection state so a genuine click can
    // still replace an older non-empty selection.
    const dragged = pointerStart
      ? Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > VISUAL_DRAG_THRESHOLD_PX
      : view.state.selection.ranges.some((range) => !range.empty);
    if (dragged && pointerStart?.objectRange) {
      // Replacement widgets have no character positions for CodeMirror to
      // extend through. Treat a drag that starts on one as an atomic object
      // selection, backed by its real source range rather than a DOM-only
      // browser selection. Keyboard copy/delete/replace therefore behave just
      // like selecting the corresponding source in Code mode.
      event.preventDefault();
      view.focus();
      view.dispatch({
        selection: EditorSelection.range(pointerStart.objectRange.from, pointerStart.objectRange.to),
      });
      return true;
    }
    if (dragged) return false;
    event.preventDefault();
    const line = view.lineBlockAtHeight(event.clientY - view.documentTop);
    const headingRange = isHeadingTarget ? headingTitleRangeAtLine(view.state, line.from) : null;
    const mathEditFrom = Number(mathTarget?.dataset.visualEditFrom);
    const mathEditTo = Number(mathTarget?.dataset.visualEditTo);
    const hasMathEditRange = Number.isInteger(mathEditFrom)
      && Number.isInteger(mathEditTo)
      && mathEditFrom >= 0
      && mathEditTo >= mathEditFrom
      && mathEditTo <= view.state.doc.length;
    let pos = line.to;
    if (headingRange) {
      pos = positionInRangeAtCoords(view, headingRange.from, headingRange.to, event.clientX, event.clientY);
    } else if (mathTarget && hasMathEditRange) {
      const rect = mathTarget.getBoundingClientRect();
      const ratio = rect.width > 0
        ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
        : 0;
      // This is intentionally an approximate horizontal mapping. Once the
      // raw source is revealed CodeMirror owns exact character placement; the
      // important part of this first click is landing *inside* the formula
      // rather than allowing the nested KaTeX DOM to swallow it.
      pos = Math.round(mathEditFrom + ratio * (mathEditTo - mathEditFrom));
    }
    // The target was just clicked, so it is already visible. Avoid a redundant
    // scroll request that can move the page when decorations are measured.
    view.dispatch({ selection: EditorSelection.cursor(pos) });
    return true;
  },
});

export const visualBlockClick = [visualViewRegistration, visualBlockClickHandlers];

/**
 * Double-click anywhere in the visual editor forward-searches into the
 * compiled PDF. Block widgets (display math, tables, figures) have no
 * reliable DOM→offset mapping, so this reuses `visualBlockClick`'s
 * `lineBlockAtHeight` fallback for those; everything else uses the exact
 * click position via `posAtCoords`.
 */
export const visualForwardSearchClick = EditorView.domEventHandlers({
  dblclick(event, view) {
    const handler = view.state.facet(onForwardSearch);
    const target = eventElement(event.target);
    const isBlockTarget = Boolean(target?.closest(`.${BLOCK_TARGET_CLASS}`));
    const pos = isBlockTarget
      ? view.lineBlockAtHeight(event.clientY - view.documentTop).to
      : view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (!handler) return false;
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    handler(line.number, pos - line.from + 1);
    return false;
  },
});

/** True when a collapsed caret touches [from, to] and may reveal raw syntax. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    // Only a caret reveals raw syntax for inline editing. Keeping non-empty
    // selections rendered prevents line-height changes underneath a drag.
    if (range.empty && range.from >= from && range.from <= to) return true;
  }
  return false;
}

/**
 * Find the index just past the `}` that matches the `{` at `openBrace`, honoring
 * nesting and escaped braces. Returns -1 if unbalanced (so we leave it as source).
 */
function matchBrace(text: string, openBrace: number): number {
  let depth = 0;
  for (let i = openBrace; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1; // skip escaped character (\{ \} \\)
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

type SimpleMacroDefinition = { argumentCount: number; body: string };

function simpleMacroDefinitions(
  source: string,
  preambleEnd: number,
  isIgnored: (position: number) => boolean = () => false,
): Map<string, SimpleMacroDefinition> {
  const definitions = new Map<string, SimpleMacroDefinition>();
  const preamble = source.slice(0, preambleEnd);
  const definitionRe = /\\(?:newcommand|renewcommand)\s*\{\s*\\([A-Za-z@]+)\s*\}\s*(?:\[\s*(\d+)\s*\])?\s*\{/g;
  let definition: RegExpExecArray | null;
  while ((definition = definitionRe.exec(preamble))) {
    if (isIgnored(definition.index)) continue;
    const openBrace = definition.index + definition[0].length - 1;
    const closeBrace = matchBrace(preamble, openBrace);
    if (closeBrace < 0) continue;
    definitions.set(definition[1], {
      argumentCount: Number.parseInt(definition[2] ?? "0", 10) || 0,
      body: preamble.slice(openBrace + 1, closeBrace - 1),
    });
    definitionRe.lastIndex = closeBrace;
  }
  return definitions;
}

function macroCallArguments(
  source: string,
  from: number,
  name: string,
  argumentCount: number,
): { argumentsText: string[]; to: number } | null {
  let cursor = from + name.length + 1;
  const argumentsText: string[] = [];
  for (let index = 0; index < argumentCount; index += 1) {
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] !== "{") return null;
    const closeBrace = matchBrace(source, cursor);
    if (closeBrace < 0) return null;
    argumentsText.push(source.slice(cursor + 1, closeBrace - 1));
    cursor = closeBrace;
  }
  return { argumentsText, to: cursor };
}

function simpleMacroText(definition: SimpleMacroDefinition, argumentsText: string[]): string {
  let expanded = definition.body;
  argumentsText.forEach((argument, index) => {
    expanded = expanded.split("#" + (index + 1)).join(argument);
  });
  return stripTableCellMarkup(expanded);
}

type Decorated = { from: number; to: number; value: Decoration };

type VisualDecorations = {
  deco: DecorationSet;
  atomic: DecorationSet;
  gutterClasses: RangeSet<GutterMarker>;
  revealRanges: Range[];
  pointerSelecting: boolean;
  pendingRefresh: boolean;
  structure: LatexStructureIndex;
};

function rangeInsertionIndex(ranges: Range[], from: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].from < from) low = middle + 1;
    else high = middle;
  }
  return low;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: Range[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function selectionTouchesRanges(selection: EditorState["selection"], ranges: Range[]): boolean {
  for (const selectionRange of selection.ranges) {
    if (!selectionRange.empty) continue;
    const index = rangeInsertionIndex(ranges, selectionRange.from + 1);
    const candidate = ranges[index - 1];
    if (candidate && selectionRange.from <= candidate.to) return true;
  }
  return false;
}

/** A completed drag across a heading should leave its source available to edit.
 * Other visual constructs remain rendered while selected so their layout does
 * not change beneath the pointer. */
function selectionOverlaps(selection: EditorState["selection"], from: number, to: number): boolean {
  return selection.ranges.some((range) => !range.empty && range.from < to && range.to > from);
}

function buildDecorations(
  state: EditorState,
  structure: LatexStructureIndex = scanLatexStructure(state.doc.toString()),
): VisualDecorations {
  const text = state.doc.toString();
  const sourcePath = state.facet(visualSourcePath);
  const ignoredAt = (position: number) => structure.isIgnored(position);
  const sourceWithoutComments = (from: number, to: number) => {
    let cursor = from;
    let output = "";
    for (const comment of structure.comments) {
      if (comment.to <= from) continue;
      if (comment.from >= to) break;
      output += text.slice(cursor, Math.max(cursor, comment.from));
      cursor = Math.min(to, comment.to);
    }
    return output + text.slice(cursor, to);
  };
  const marks: Decorated[] = [];
  const gutterMarks: Array<{ from: number; value: GutterMarker }> = [];
  // Only *hidden syntax* (replaced command markup, folded preamble) is atomic so
  // the caret steps over it. Styling marks (bold/italic/heading text) must NOT be
  // atomic, or the caret can never land inside a command to reveal it for editing.
  const atomicMarks: Decorated[] = [];
  // Accepted hidden intervals, kept sorted, so overlapping replace decorations are
  // never emitted — CodeMirror throws on overlapping replaces, and real documents
  // can nest constructs (e.g. `\vspace` inside a math block) that would collide.
  const hidden: Range[] = [];
  // The subset of `hidden` that renders *nothing* — no widget, no styled text.
  // Whenever such a fold covers a whole row the row is collapsed away (see the
  // "blank rows" pass at the end), so folded-to-nothing never shows up as an
  // empty line that only turns back into LaTeX once you click it.
  const blankHidden: Range[] = [];
  /** Source span of every Beamer frame, in document order. */
  const frameSpans: Range[] = [];
  // Completed table selections are source-editing regions. Once populated
  // below, no later generic pass (environment markers, declarations, row
  // breaks, escaped characters, ...) may partially fold their LaTeX again.
  // This is mutable because the preamble fold is established before table
  // environments are collected; those two regions cannot overlap.
  const preservedRawRanges: Range[] = [];
  const revealRanges: Range[] = [];
  const touchesSelection = (from: number, to: number) => {
    revealRanges.push({ from, to });
    return selectionTouches(state, from, to);
  };
  const hiddenInsertionIndex = (from: number) => rangeInsertionIndex(hidden, from);
  const overlapsHidden = (from: number, to: number) => {
    const index = hiddenInsertionIndex(from);
    return (index > 0 && hidden[index - 1].to > from)
      || (index < hidden.length && hidden[index].from < to);
  };
  const hide = (from: number, to: number, value: Decoration = hiddenMark) => {
    if (to <= from) return; // never emit a zero-width or inverted replace
    if (preservedRawRanges.some((range) => from < range.to && to > range.from)) return;
    if (overlapsHidden(from, to)) return; // first hide wins; skip the collider
    hidden.splice(hiddenInsertionIndex(from), 0, { from, to });
    if (value === hiddenMark) blankHidden.push({ from, to });
    marks.push({ from, to, value });
    atomicMarks.push({ from, to, value });
  };
  // Applies the active-math line decoration to every visual line spanned by
  // `[from, to)`, also tagging the first/last line of the run so the CSS can
  // round only the outer corners of the callout band — the block then reads
  // as one continuous panel instead of a flat-edged strip.
  const markMathLines = (from: number, to: number) => {
    let pos = from;
    let isFirst = true;
    while (pos <= to && pos <= state.doc.length) {
      const line = state.doc.lineAt(pos);
      const isLast = line.to >= to || line.to >= state.doc.length;
      marks.push({ from: line.from, to: line.from, value: activeMathLine });
      if (isFirst) marks.push({ from: line.from, to: line.from, value: activeMathLineFirst });
      if (isLast) marks.push({ from: line.from, to: line.from, value: activeMathLineLast });
      if (isLast) break;
      isFirst = false;
      pos = line.to + 1;
    }
  };

  // --- Preamble: fold everything up to and including \begin{document} ---
  const documentEnvironment = structure.environments.find((environment) => environment.name === "document");
  const beginDoc = documentEnvironment?.beginFrom ?? -1;
  let bodyStart = 0;
  if (beginDoc >= 0) {
    const afterBegin = text.indexOf("\n", documentEnvironment?.beginTo ?? beginDoc);
    bodyStart = afterBegin >= 0 ? afterBegin + 1 : text.length;
    // The preamble always folds (it is edited in Code mode). Fold through the end
    // of the `\begin{document}` line but NOT its trailing newline: a block replace
    // that ends at the next line's start absorbs that line's own decorations (a
    // heading sitting right after \begin{document} would lose its styling), so we
    // stop at the newline and let it separate the fold from the body.
    const foldEnd = afterBegin >= 0 ? afterBegin : bodyStart;
    const lineCount = state.doc.lineAt(beginDoc).number;
    hide(0, foldEnd, Decoration.replace({ widget: new PreambleWidget(lineCount), block: true }));
  }

  // --- \end{document} and trailing content: hide the closing marker ---
  const endDoc = documentEnvironment?.closed ? documentEnvironment.endFrom : -1;
  const scanEnd = endDoc >= 0 ? endDoc : text.length;
  const floatEnvironments = structure.environments.filter((environment) =>
    /^(?:figure|table)\*?$/.test(environment.name)
      && environment.closed
      && environment.from >= bodyStart
      && environment.from < scanEnd,
  );
  const floatEnvRanges: Range[] = floatEnvironments.map((environment) => ({ from: environment.from, to: environment.to }));
  const withinFloatEnv = (pos: number) => floatEnvRanges.some((r) => pos >= r.from && pos < r.to);
  // Bare tabular/longtable environments are replaced as a whole later in this
  // pass.  Do not first place inline math widgets inside them: overlapping
  // replace decorations would otherwise prevent the enclosing table card from
  // being emitted.
  const tableEnvRanges = findTabularMatches(text, structure, bodyStart, scanEnd)
    .map((table) => ({ from: table.from, to: table.to }));
  const withinTableEnv = (pos: number) => tableEnvRanges.some((r) => pos >= r.from && pos < r.to);
  preservedRawRanges.push(...tableEnvRanges.filter((range) => (
    selectionOverlaps(state.selection, range.from, range.to)
  )));
  // A table float is rendered as one widget, so selecting it must reveal the
  // complete outer environment too—not only its nested `tabular` body.
  preservedRawRanges.push(...floatEnvironments
    .filter((environment) => environment.name.startsWith("table")
      && selectionOverlaps(state.selection, environment.from, environment.to))
    .map((environment) => ({ from: environment.from, to: environment.to })));

  // --- Beamer frames: keep source editing continuous, but make each frame read
  // as a slide card with an editable title and explicit slide number. ---
  let frameNumber = 0;
  for (const fm of findFrameMatches(structure, bodyStart, scanEnd)) {
    frameNumber += 1;
    const frameFrom = fm.from;
    const beginTo = fm.beginTo;
    const frameTo = fm.to;
    const endFrom = fm.endFrom;

    let linePos = frameFrom;
    while (linePos <= frameTo && linePos <= state.doc.length) {
      const line = state.doc.lineAt(linePos);
      marks.push({ from: line.from, to: line.from, value: frameLine });
      if (line.to >= frameTo || line.to >= state.doc.length) break;
      linePos = line.to + 1;
    }
    // The card's rounded top and bottom edges are painted by the *rendered*
    // first/last rows, which are only known once the blank-row pass below has
    // decided which of them survive — `\end{frame}` prints nothing, so it is
    // normally collapsed and cannot carry the bottom edge.
    frameSpans.push({ from: state.doc.lineAt(frameFrom).from, to: frameTo });

    const inlineTitle = fm.title?.trim() ?? "";
    if (inlineTitle && fm.titleFrom != null && fm.titleTo != null) {
      const titleFrom = fm.titleFrom;
      const titleTo = fm.titleTo;
      if (!touchesSelection(frameFrom, beginTo)) {
        hide(
          frameFrom,
          titleFrom,
          Decoration.replace({ widget: new FrameKickerWidget(frameNumber) }),
        );
        hide(titleTo, beginTo);
      }
      marks.push({ from: titleFrom, to: titleTo, value: Decoration.mark({ class: "cm-vis-frame-title" }) });
    } else {
      const frameTitle = structure.commands.find((command) =>
        command.name === "frametitle" && command.from >= beginTo && command.from < endFrom,
      );
      let fallbackTitle = structure.commands.some((command) =>
        command.name === "titlepage" && command.from >= beginTo && command.from < endFrom,
      ) ? "Title slide" : "Untitled slide";
      if (frameTitle?.requiredArguments[0]) {
        const commandFrom = frameTitle.from;
        const title = frameTitle.requiredArguments[0];
        if (title.to <= endFrom) {
          fallbackTitle = "";
          if (!touchesSelection(commandFrom, frameTitle.to)) {
            hide(commandFrom, title.contentFrom);
            hide(title.contentTo, title.to);
          }
          marks.push({ from: title.contentFrom, to: title.contentTo, value: Decoration.mark({ class: "cm-vis-frame-title" }) });
        }
      }
      if (!touchesSelection(frameFrom, beginTo)) {
        hide(
          frameFrom,
          beginTo,
          Decoration.replace({ widget: new FrameKickerWidget(frameNumber, fallbackTitle) }),
        );
      }
    }
    if (!touchesSelection(endFrom, frameTo)) hide(endFrom, frameTo);
  }

  // --- Math: display environments, \[…\], and inline $…$ (KaTeX widgets) ---
  const mathRanges: Range[] = [];
  const withinMath = (pos: number) => mathRanges.some((m) => pos >= m.from && pos < m.to);
  const addMath = (
    from: number,
    to: number,
    latex: string,
    display: boolean,
    editFrom: number = Math.min(to, from + 1),
    editTo: number = Math.max(editFrom, to - 1),
  ) => {
    if (withinFloatEnv(from) || withinTableEnv(from)) return;
    mathRanges.push({ from, to });
    // Both reveal their source on caret — display math used to stay permanently
    // rendered to avoid a page-shifting "jump", but the real bug was the CLICK
    // landing at the wrong position (see `visualBlockClick`), not the reveal
    // itself. With clicks fixed, display math can safely support in-place editing
    // like Overleaf's own visual editor does.
    // A formula remains editable for the entire selection gesture. Replacing
    // its source with the KaTeX widget as soon as the caret grows into a range
    // makes a drag selection snap back to Visual mode on mouseup, losing the
    // source the user just selected. Other rich blocks can stay rendered while
    // selected because their source often changes layout; formula source is
    // deliberately compact and should behave like ordinary editable text.
    if (touchesSelection(from, to) || selectionOverlaps(state.selection, from, to)) {
      if (display) markMathLines(from, to);
      marks.push({ from, to, value: display ? activeMathSourceDisplay : activeMathSourceInline });
      return;
    }
    hide(from, to, Decoration.replace({
      widget: new MathWidget(latex.trim(), display, { from, to }, { from: editFrom, to: editTo }),
    }));
  };

  const displayMathEnvironments = new Set([
    "equation", "equation*", "align", "align*", "alignat", "alignat*",
    "gather", "gather*", "multline", "multline*", "flalign", "flalign*",
    "eqnarray", "eqnarray*", "displaymath",
  ]);
  for (const environment of structure.environmentsNamed(displayMathEnvironments)) {
    if (!environment.closed || environment.from < bodyStart || environment.from >= scanEnd) continue;
    const body = sourceWithoutComments(environment.bodyFrom, environment.bodyTo).replace(/\\label\{[^}]*\}/g, "");
    addMath(
      environment.from,
      environment.to,
      visualLatexForDisplayEnvironment(environment.name, body),
      true,
      environment.bodyFrom,
      environment.bodyTo,
    );
  }

  // Delimiter math ($…$, $$…$$, \(…\), and \[…\]) is paired by the shared
  // scanner, so escaped delimiters, comments, and malformed one-sided input do
  // not make a later paragraph disappear into a regex match.
  for (const range of structure.mathRanges) {
    if (range.from < bodyStart || range.from >= scanEnd || withinMath(range.from)) continue;
    const source = sourceWithoutComments(range.from, range.to);
    const display = source.startsWith("$$") || source.startsWith("\\[");
    const delimiterLength = source.startsWith("$$") ? 2 : source.startsWith("$") ? 1 : 2;
    addMath(
      range.from,
      range.to,
      source.slice(delimiterLength, -delimiterLength),
      display,
      range.from + delimiterLength,
      range.to - delimiterLength,
    );
  }

  // --- Floats: `figure`/`table` environments as ONE cohesive block ---
  // Overleaf's visual editor treats a whole float environment as a single unit
  // (atomic-decorations.ts: shouldDecorateFromLineEdges / TabularEnvironment) —
  // either the whole thing renders as one widget, or the whole thing is raw
  // source when the caret is anywhere inside it. Deciding hide/reveal per
  // sub-piece (begin marker, \centering, caption, end marker) independently is
  // what produced "reveals one line at a time" as the caret passed through.
  const openFloatRanges: Range[] = [];
  const withinOpenFloat = (pos: number) => openFloatRanges.some((r) => pos >= r.from && pos < r.to);
  const readCaption = (innerFrom: number, innerTo: number): string => {
    const argument = structure.commands.find((command) =>
      command.name === "caption"
        && command.from >= innerFrom
        && command.from < innerTo
        && command.requiredArguments[0],
    )?.requiredArguments[0];
    return argument ? stripMarkup(argument.value) : "";
  };

  for (const environment of floatEnvironments) {
    const envFrom = environment.from;
    const envTo = environment.to;
    if (touchesSelection(envFrom, envTo) || selectionOverlaps(state.selection, envFrom, envTo)) {
      openFloatRanges.push({ from: envFrom, to: envTo });
      continue; // caret/selection is editing this float — leave it fully raw
    }
    const inner = text.slice(environment.bodyFrom, environment.bodyTo);
    const innerFrom = environment.bodyFrom;
    const caption = readCaption(innerFrom, environment.bodyTo);
    if (environment.name.startsWith("table")) {
      const tabularMatch = findTabularMatches(text, structure, innerFrom, envTo)[0];
      const parsedTable = tabularMatch?.environment === "longtable"
        ? longtableRows(tabularMatch.body)
        : tabularMatch
          ? { rows: parseTabular(tabularMatch.body), hasHeader: /\\toprule/.test(tabularMatch.source), caption: "" }
          : null;
      const rows = parsedTable?.rows ?? [];
      if (tabularMatch && rows.length > 0) {
        hide(
          envFrom,
          envTo,
          Decoration.replace({
            widget: new TableWidget(
              rows,
              parsedTable?.hasHeader ?? false,
              caption || parsedTable?.caption,
              { from: envFrom, to: envTo },
              editableTableModel(text, tabularMatch),
            ),
            block: true,
          }),
        );
        continue;
      }
    } else {
      const graphicsArgument = structure.commands.find((command) =>
        command.name === "includegraphics"
          && command.from >= innerFrom
          && command.from < environment.bodyTo
          && command.requiredArguments[0],
      )?.requiredArguments[0];
      if (graphicsArgument) {
        hide(
          envFrom,
          envTo,
          Decoration.replace({ widget: new FigureWidget(graphicsArgument.value.trim(), caption, sourcePath), block: true }),
        );
        continue;
      }
      // No `\includegraphics` — render graph-shaped TikZ/PGF in a lightweight
      // SVG preview instead of hiding the entire drawing behind a placeholder.
      const drawingMatch = /\\begin\{(tikzpicture|pgfpicture)\}/.exec(inner);
      if (drawingMatch) {
        hide(
          envFrom,
          envTo,
          Decoration.replace({
            widget: new DiagramWidget(
              drawingMatch[1] === "pgfpicture" ? "PGF diagram" : "TikZ diagram",
              caption,
              inner,
              { from: envFrom, to: envTo },
            ),
            block: true,
          }),
        );
        continue;
      }
    }
    // Unrecognized inner content (no image / no parseable table / no drawing) —
    // fall through to the generic env-marker/declaration passes below, so at
    // least the wrapper commands hide and the raw content still flows and stays
    // readable.
  }

  // --- Tables: bare `tabular` with no enclosing `table` float ---
  for (const tb of findTabularMatches(text, structure, bodyStart, scanEnd)) {
    const from = tb.from;
    const to = tb.to;
    if (withinOpenFloat(from)) continue;
    if (touchesSelection(from, to) || selectionOverlaps(state.selection, from, to)) continue;
    const parsedTable = tb.environment === "longtable"
      ? longtableRows(tb.body)
      : { rows: parseTabular(tb.body), hasHeader: /\\toprule/.test(tb.source), caption: "" };
    const rows = parsedTable.rows;
    if (rows.length === 0) continue;
    hide(
      from,
      to,
      Decoration.replace({
        widget: new TableWidget(
          rows,
          parsedTable.hasHeader,
          parsedTable.caption,
          { from, to },
          editableTableModel(text, tb),
        ),
        block: true,
      }),
    );
  }

  // --- Figures: bare `\includegraphics{…}` with no enclosing `figure` float ---
  for (const command of structure.commandsNamed("includegraphics")) {
    if (command.from < bodyStart || command.from >= scanEnd) continue;
    const argument = command.requiredArguments[0];
    if (!argument) continue;
    const from = command.from;
    const to = command.to;
    if (withinOpenFloat(from)) continue;
    if (touchesSelection(from, to)) continue;
    hide(from, to, Decoration.replace({ widget: new GraphicsWidget(argument.value.trim(), sourcePath), block: true }));
  }

  // --- Section headings (numbered) ---
  // Numbers come from the shared engine in `sectionNumbering.ts`, seeded with
  // the document-wide prefix the host injects (`visualNumbering`), so a chapter
  // that main.tex pulls in as its second continues at "2.1" instead of
  // restarting at "1.1" — and agrees with the Outline panel by construction.
  // The file's own division switches and counter assignments are replayed here,
  // from the live buffer, in document order with the headings.
  const headings = structure.headings.filter((heading) => heading.from >= bodyStart && heading.from < scanEnd);
  const numberingPrefix = state.facet(visualNumbering);
  const rules = numberingPrefix?.rules ?? localNumberingRules(headings);
  const numbering = numberingPrefix
    ? cloneSectionNumberingState(numberingPrefix.state)
    : initialSectionNumberingState();
  const continuedNumbering = numberingPrefix?.continued ?? false;
  const headingBraces: Range[] = [];
  for (const event of numberingEvents(structure, headings, scanEnd)) {
    if (event.kind === "matter") {
      applySectionMatter(numbering, event.matter);
      continue;
    }
    if (event.kind === "counter") {
      applySectionCounterReset(numbering, event.reset);
      const { from, to } = event.command;
      // A preamble one is already inside the folded preamble block.
      if (from >= bodyStart && !touchesSelection(from, to)) {
        const counter = event.command.requiredArguments[0]?.value.trim() ?? "";
        hide(from, to, Decoration.replace({ widget: new CounterWidget(counter, event.reset.value, event.reset.mode) }));
      }
      continue;
    }
    const heading = event.heading;
    const rank = SECTION_RANKS[heading.command];
    const level = sectionDisplayLevel(rank, rules);
    const label = advanceSectionNumber(numbering, { rank, starred: heading.starred }, rules);
    headingBraces.push({ from: heading.from, to: heading.to });

    const cmdStart = heading.from;
    const cmdEnd = heading.commandTo; // command, optional short title, and opening brace
    const line = state.doc.lineAt(cmdStart);
    marks.push({ from: line.from, to: line.from, value: headingLine[level] });
    gutterMarks.push({ from: line.from, value: headingGutterMarker[level] });

    // During a drag, pointer selection keeps the current decorations mounted.
    // Once it completes, keep a selected heading as raw LaTeX so typing can
    // immediately replace or refine `\section{...}` instead of snapping back
    // to the rendered heading display.
    if (!touchesSelection(cmdStart, heading.to) && !selectionOverlaps(state.selection, cmdStart, heading.to)) {
      // Hide `\section{` and its closing `}`, keep the title text styled.
      hide(cmdStart, cmdEnd);
      if (label) {
        marks.push({
          from: cmdStart,
          to: cmdStart,
          value: Decoration.widget({ widget: new SectionNumberWidget(label, level, continuedNumbering), side: -1 }),
        });
      }
      marks.push({ from: heading.title.contentFrom, to: heading.title.contentTo, value: Decoration.mark({ class: SECTION_CLASS[level] }) });
      hide(heading.title.contentTo, heading.title.to);
    }
  }

  const withinHeading = (pos: number) => headingBraces.some((h) => pos >= h.from && pos < h.to);

  // Simple preamble macros are common in research manuscripts for semantic
  // labels, abbreviations, and evidence citations. Expand their readable text
  // in the Visual view while preserving the original source for editing.
  for (const [name, definition] of simpleMacroDefinitions(text, bodyStart, ignoredAt)) {
    for (const macro of structure.commandsNamed(name)) {
      if (macro.from < bodyStart || macro.from >= scanEnd) continue;
      if (withinMath(macro.from) || withinOpenFloat(macro.from)) {
        continue;
      }
      const call = macroCallArguments(text, macro.from, name, definition.argumentCount);
      if (!call || touchesSelection(macro.from, call.to)) continue;
      const rendered = simpleMacroText(definition, call.argumentsText);
      if (!rendered) continue;
      hide(
        macro.from,
        call.to,
        Decoration.replace({ widget: new CustomMacroWidget(rendered) }),
      );
    }
  }

  // --- Theorem-like environments: readable label + hidden wrapper source ---
  // Environment declarations are structural chrome rather than prose. Keep them
  // visual even when the caret lands on the declaration; entering the theorem
  // body still exposes ordinary source commands for direct editing.
  for (const theorem of structure.environmentsNamed(THEOREM_ENVIRONMENTS)) {
    if (theorem.from < bodyStart || theorem.from >= scanEnd) continue;
    const fallback = theorem.name.charAt(0).toUpperCase() + theorem.name.slice(1);
    const label = stripMarkup(theorem.optionalArguments[0]?.value.trim() || fallback) || fallback;
    hide(
      theorem.beginFrom,
      theorem.beginTo,
      Decoration.replace({ widget: new TheoremLabelWidget(label, theorem, state.facet(onOpenCodeRange)) }),
    );
    if (theorem.closed) hide(theorem.endFrom, theorem.endTo);
  }

  // --- Footnotes: the marker the PDF prints, text on hover ---
  for (const command of structure.commandsNamed("footnote")) {
    if (command.from < bodyStart || command.from >= scanEnd) continue;
    if (withinMath(command.from) || withinHeading(command.from)) continue;
    const argument = command.requiredArguments[0];
    if (!argument || touchesSelection(command.from, command.to)) continue;
    hide(command.from, command.to, Decoration.replace({
      widget: new FootnoteWidget(stripMarkup(argument.value).trim()),
    }));
  }

  // --- Inline text commands: \textbf{..} \emph{..} etc. ---
  for (const command of structure.commands) {
    const cls = INLINE_TEXT_COMMANDS[command.name];
    if (!cls || command.from < bodyStart || command.from >= scanEnd) continue;
    if (withinHeading(command.from) || withinMath(command.from)) continue;
    const argument = command.requiredArguments[0];
    if (!argument || touchesSelection(command.from, command.to)) continue;
    hide(command.from, argument.contentFrom);
    marks.push({ from: argument.contentFrom, to: argument.contentTo, value: Decoration.mark({ class: cls }) });
    hide(argument.contentTo, argument.to);
  }

  // --- Typographic source with a printed form (`~`, `---`, ``…'', \quad) ---
  // Comments, maths and verbatim are excluded: `--` is a decrement there, not
  // an en dash, and `~` inside maths is a spacing command of its own.
  TYPOGRAPHIC_RE.lastIndex = bodyStart;
  for (let match = TYPOGRAPHIC_RE.exec(text); match; match = TYPOGRAPHIC_RE.exec(text)) {
    const from = match.index;
    const to = from + match[0].length;
    if (from < bodyStart) continue;
    if (from >= scanEnd) break;
    if (ignoredAt(from) || withinMath(from) || withinHeading(from)) continue;
    // An escaped `\~` is a tie accent over the next character, not a space.
    if (match[0] === "~" && text[from - 1] === "\\") continue;
    if (touchesSelection(from, to) || overlapsHidden(from, to)) continue;
    hide(from, to, Decoration.replace({
      widget: new TypographicWidget(TYPOGRAPHIC_TEXT[match[0]], match[0]),
    }));
  }

  // Hyperlinks keep their readable label inline while URL/source syntax stays
  // available when the caret enters the command.
  for (const command of structure.commandsNamed("href")) {
    if (command.from < bodyStart || command.from >= scanEnd || withinMath(command.from)) continue;
    const label = command.requiredArguments[1];
    if (!label || touchesSelection(command.from, command.to)) continue;
    hide(command.from, label.contentFrom);
    marks.push({ from: label.contentFrom, to: label.contentTo, value: Decoration.mark({ class: "cm-vis-link" }) });
    hide(label.contentTo, label.to);
  }

  // Replace a whole `\cmd{arg}` span with a chip, unless the caret is inside it.
  const chipCommand = (cmdStart: number, commandTo: number, argument: LatexArgument, render: (arg: string) => ChipWidget) => {
    if (withinOpenFloat(cmdStart)) return; // open float is fully raw
    if (touchesSelection(cmdStart, commandTo)) return; // reveal for editing
    hide(cmdStart, commandTo, Decoration.replace({ widget: render(argument.value) }));
  };

  // --- Citations: \cite{a,b} \citep \citet \parencite \textcite ---
  const citeCommands = new Set(["cite", "citep", "citet", "parencite", "textcite", "autocite"]);
  for (const command of structure.commands) {
    if (!citeCommands.has(command.name) || command.from < bodyStart || command.from >= scanEnd) continue;
    if (withinHeading(command.from) || withinMath(command.from)) continue;
    const argument = command.requiredArguments[0];
    if (!argument) continue;
    chipCommand(command.from, command.to, argument, (arg) => {
      const keys = arg.split(",").map((k) => k.trim()).filter(Boolean);
      const label = keys.length === 0
        ? "[cite]"
        : keys.length === 1
          ? `[${keys[0]}]`
          : keys.length === 2
            ? `[${keys.join("; ")}]`
            : `[${keys[0]}; ${keys[1]}; +${keys.length - 2}]`;
      return new ChipWidget(label, "cite", `\\${command.name}{${arg}} - click to edit LaTeX source`);
    });
  }

  // --- Cross references: \ref \eqref \autoref \cref \pageref ---
  const referenceCommands = new Set(["ref", "eqref", "autoref", "cref", "Cref", "pageref"]);
  for (const command of structure.commands) {
    if (!referenceCommands.has(command.name) || command.from < bodyStart || command.from >= scanEnd || withinMath(command.from)) continue;
    const argument = command.requiredArguments[0];
    if (argument) chipCommand(command.from, command.to, argument, (arg) => new ChipWidget(arg.trim() || "ref", "ref"));
  }

  // --- \label{..}: dim to a small tag (not editable clutter in body text) ---
  for (const command of structure.commandsNamed("label")) {
    if (command.from < bodyStart || command.from >= scanEnd || withinMath(command.from)) continue;
    const argument = command.requiredArguments[0];
    if (argument) chipCommand(command.from, command.to, argument, (arg) => new ChipWidget(`§ ${arg.trim()}`, "label"));
  }

  // --- Lists: bullet / number markers in place of \item ---
  const openListRanges: Range[] = [];
  const withinOpenList = (pos: number) => openListRanges.some((r) => pos >= r.from && pos < r.to);
  const itemCommands = structure.commandsNamed("item");
  const listEnvironments = structure.environmentsNamed(LIST_ENVIRONMENTS)
    .filter((environment) => environment.from >= bodyStart && environment.from < scanEnd && environment.closed);
  for (const environment of listEnvironments) {
    const ordered = environment.name === "enumerate";
    const bodyFrom = environment.bodyFrom;
    const bodyTo = environment.bodyTo;
    const listTo = environment.to;
    const listOption = environment.optionalArguments[0]
      ? text.slice(environment.optionalArguments[0].from, environment.optionalArguments[0].to)
      : undefined;
    // Keep the begin/end declaration visual when the caret is on it. The list
    // body alone is the editable region; treating the declaration as part of
    // that region made a click on `\\begin{itemize}` leak raw syntax while the
    // individual item widgets remained rendered.
    const listIsEditing = state.selection.ranges.some((range) =>
      range.empty
        && range.from > bodyFrom
        && range.from < bodyTo
        && structure.environmentAt(range.from, LIST_ENVIRONMENTS) === environment,
    );
    if (listIsEditing) {
      openListRanges.push({ from: environment.from, to: listTo });
    }
    // Hide the \begin / \end environment lines themselves.
    if (!listIsEditing) {
      hide(environment.beginFrom, environment.beginTo);
      hide(environment.endFrom, environment.endTo);
    }
    const listSpacingRe = /\\setlength\s*(?:\{\\itemsep\}|\\itemsep)\s*\{[^}]*\}/g;
    listSpacingRe.lastIndex = bodyFrom;
    let spacing: RegExpExecArray | null;
    while ((spacing = listSpacingRe.exec(text)) && spacing.index < bodyTo) {
      if (ignoredAt(spacing.index)) continue;
      if (!listIsEditing && !touchesSelection(spacing.index, spacing.index + spacing[0].length)) {
        hide(spacing.index, spacing.index + spacing[0].length);
      }
    }

    const items = itemCommands
      .filter((item) => item.from >= bodyFrom
        && item.from < bodyTo
        && structure.environmentAt(item.from, LIST_ENVIRONMENTS) === environment)
      .map((item) => ({
        command: item,
        from: item.from,
        to: item.to,
        lineFrom: state.doc.lineAt(item.from).from,
      }));
    let n = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      n += 1;
      const itemRangeEnd = items[index + 1]?.from ?? bodyTo;
      marks.push({ from: item.lineFrom, to: item.lineFrom, value: listItemLine });
      if (!listIsEditing && !touchesSelection(item.from, itemRangeEnd)) {
        const customMarker = item.command.optionalArguments[0]?.value.trim();
        const marker = customMarker || (ordered ? enumitemLabel(listOption, n) || `${n}.` : "•");
        hide(item.from, item.to, Decoration.replace({ widget: new ItemMarkerWidget(marker) }));
      }
    }
  }

  // --- Standalone structural commands ---
  // \maketitle → centered title block built from the preamble metadata.
  const makeTitle = structure.commands.find((command) =>
    command.name === "maketitle" && command.from >= bodyStart && command.from < scanEnd,
  )?.from ?? -1;
  if (makeTitle >= 0 && !touchesSelection(makeTitle, makeTitle + "\\maketitle".length)) {
    const readArgRange = (cmd: string): { text: string; rawText: string; range: Range | null } => {
      // Title metadata belongs to the preamble. Searching the body can bind a
      // literal `\title{...}` in an example or a user macro invocation.
      const preambleEnd = beginDoc >= 0 ? beginDoc : text.length;
      const argument = structure.commands.find((command) =>
        command.name === cmd && command.from < preambleEnd && command.requiredArguments[0],
      )?.requiredArguments[0];
      if (!argument) return { text: "", rawText: "", range: null };
      const rawText = argument.value;
      return {
        text: stripMarkup(rawText),
        rawText,
        range: { from: argument.contentFrom, to: argument.contentTo },
      };
    };
    const titleArg = readArgRange("title");
    const authorArg = readArgRange("author");
    const dateArg = readArgRange("date");
    const date = /^\\today\s*$/.test(dateArg.rawText) ? "" : dateArg.text;
    hide(
      makeTitle,
      makeTitle + "\\maketitle".length,
      Decoration.replace({
        widget: new TitleWidget(
          titleArg.text,
          authorArg.text,
          date,
          titleArg.range,
          authorArg.range,
          date ? dateArg.range : null,
          state.facet(onOpenCodeRange),
        ),
      }),
    );
  }

  // \tableofcontents → a chip; \end{document} and structural no-ops → hidden.
  const standaloneCommands = new Set([
    "tableofcontents", "titlepage", "newpage", "clearpage", "bigskip", "medskip", "smallskip",
    "noindent", "centering", "maketitle", "vspace", "hspace", "thispagestyle", "pagestyle",
    "addcontentsline",
  ]);
  for (const command of structure.commands) {
    const isEndDoc = command.name === "end" && command.requiredArguments[0]?.value.trim() === "document";
    if (!isEndDoc && !standaloneCommands.has(command.name)) continue;
    const from = command.from;
    const to = command.to;
    if (from < bodyStart || from > scanEnd) continue;
    if (from === makeTitle) continue; // handled above
    if (withinOpenFloat(from)) continue; // open float is fully raw — see above
    // `\end{document}` always hides (it is never edited in the visual view); the
    // rest reveal on caret so the source stays reachable.
    if (!isEndDoc && touchesSelection(from, to)) continue;
    if (command.name === "tableofcontents") {
      hide(from, to, Decoration.replace({ widget: new ChipWidget("Table of contents", "toc") }));
    } else if (command.name === "newpage" || command.name === "clearpage") {
      hide(from, to, Decoration.replace({
        widget: new PageBreakWidget(command.name),
        block: true,
      }));
    } else {
      // \end{document}, \noindent, \vspace, \addcontentsline, … → invisible. A
      // command that owns its whole source line also loses that line, through
      // the blank-row pass at the end of this function.
      hide(from, to);
    }
  }

  // --- Alignment environments: center / flushleft / flushright ---
  const alignClass: Record<string, string> = {
    center: "cm-vis-center",
    flushleft: "cm-vis-flushleft",
    flushright: "cm-vis-flushright",
  };
  const alignmentEnvironments = new Set(Object.keys(alignClass));
  for (const environment of structure.environmentsNamed(alignmentEnvironments)) {
    if (!environment.closed || environment.from < bodyStart || environment.from >= scanEnd) continue;
    const innerFrom = environment.bodyFrom;
    const innerTo = environment.bodyTo;
    // Apply the alignment to every line the environment spans.
    let pos = innerFrom;
    while (pos < innerTo) {
      const line = state.doc.lineAt(pos);
      marks.push({ from: line.from, to: line.from, value: alignLine(alignClass[environment.name]) });
      pos = line.to + 1;
    }
  }

  // --- Abstract environment → "Abstract" label + italic indented body ---
  // Without this it fell through to the generic "unknown environment" pass
  // below, which just hides the markers with no label — the abstract read as
  // an unstyled paragraph indistinguishable from the rest of the body.
  const abstractEnvironments = new Set(["abstract"]);
  const abstractRanges: Range[] = [];
  const withinAbstract = (pos: number) => abstractRanges.some((r) => pos >= r.from && pos < r.to);
  for (const environment of structure.environmentsNamed(abstractEnvironments)) {
    if (!environment.closed || environment.from < bodyStart || environment.from >= scanEnd) continue;
    const innerFrom = environment.bodyFrom;
    const innerTo = environment.bodyTo;
    // Tracked unconditionally (reveal or not) so the generic unknown-environment
    // fallback below — which processes every `\begin{}`/`\end{}` in the document
    // one marker at a time — knows to leave both markers alone here. Without
    // this, revealing (caret inside) still let that fallback independently
    // re-hide whichever marker the caret *wasn't* literally touching (e.g. the
    // caret sits on `\begin{abstract}`, so only that marker's own selection
    // check passes there; `\end{abstract}` has no caret on it and gets hidden
    // anyway) — an inconsistent half-reveal. Math avoids the same trap via its
    // own `withinMath` exclusion; this mirrors that.
    abstractRanges.push({ from: environment.from, to: environment.to });
    // Touching *any part* of the environment reveals it whole, like math/lists.
    if (touchesSelection(environment.from, environment.to)) {
      continue;
    }
    hide(environment.beginFrom, environment.beginTo, Decoration.replace({ widget: new SectionLabelWidget("Abstract") }));
    hide(environment.endFrom, environment.endTo);
    // `innerFrom` sits exactly at the end of the `\begin{abstract}` line (right
    // before its own newline) when the marker is alone on its line — `lineAt`
    // resolves a position at a line's `to` to that same line, so starting the
    // scan there would (mis)style the marker's own line as body. Skip past it;
    // if the marker instead has body text trailing it on the same line,
    // `innerFrom` is already mid-line and this is a no-op.
    let pos = Math.max(innerFrom, state.doc.lineAt(environment.from).to + 1);
    while (pos < innerTo) {
      const line = state.doc.lineAt(pos);
      marks.push({ from: line.from, to: line.from, value: abstractLine });
      pos = line.to + 1;
    }
  }

  // --- Figure/table captions → styled caption text, command hidden ---
  for (const command of structure.commandsNamed("caption")) {
    if (command.from < bodyStart || command.from >= scanEnd || withinOpenFloat(command.from)) continue;
    const argument = command.requiredArguments[0];
    if (!argument || touchesSelection(command.from, command.to)) continue;
    const line = state.doc.lineAt(command.from);
    marks.push({ from: line.from, to: line.from, value: captionLine });
    hide(command.from, argument.contentFrom);
    marks.push({ from: argument.contentFrom, to: argument.contentTo, value: Decoration.mark({ class: "cm-vis-caption" }) });
    hide(argument.contentTo, argument.to);
  }

  // --- Bare formatting declarations → hidden (formatting noise as raw text) ---
  for (const command of structure.commands) {
    if (!DECLARATION_COMMANDS.has(command.name) || command.from < bodyStart || command.from >= scanEnd) continue;
    if (withinOpenFloat(command.from)) continue; // open float is fully raw
    if (touchesSelection(command.from, command.controlTo)) continue;
    hide(command.from, command.controlTo);
  }

  // Beamer layout commands affect the compiled arrangement but carry no
  // readable content in Visual mode. Keep them in the source of truth and
  // reveal them on caret, while folding the idle visual representation.
  const beamerLayoutCommands = new Set(["column", "pause", "vfill", "hfill"]);
  for (const command of structure.commands) {
    if (!beamerLayoutCommands.has(command.name) || command.from < bodyStart || command.from >= scanEnd) continue;
    if (withinMath(command.from) || withinOpenFloat(command.from)) continue;
    if (touchesSelection(command.from, command.to)) continue;
    hide(command.from, command.to);
  }

  // --- Forced line breaks `\\` / `\\[len]` → an actual break ---
  for (const command of structure.commandsNamed("\\")) {
    if (command.from < bodyStart || command.from >= scanEnd) continue;
    if (withinMath(command.from) || withinOpenFloat(command.from)) continue; // row break / open float is raw
    if (touchesSelection(command.from, command.to)) continue;
    hide(command.from, command.to, Decoration.replace({ widget: new BreakWidget() }));
  }

  // --- Escaped characters `\%` `\&` `\_` `\#` `\$` → show the literal char ---
  // Hiding just the backslash leaves the char visible; the source keeps `\%`, so
  // comment/math detection (which look for an unescaped `%`/`$`) still skip it.
  const escapedCharacterCommands = new Set(["%", "&", "_", "#", "$"]);
  for (const command of structure.commands) {
    if (!escapedCharacterCommands.has(command.name) || command.from < bodyStart || command.from >= scanEnd) continue;
    if (withinMath(command.from)) continue;
    if (touchesSelection(command.from, command.controlTo)) continue;
    hide(command.from, command.from + 1); // hide the backslash only
  }

  // --- Unknown environment markers → hidden, content flows (graceful default) ---
  // Runs last so specially-handled envs (math/list/align, already in `hidden`) win
  // via the overlap dedupe; unknown wrappers like `tcolorbox`/`tcolor` just vanish.
  for (const command of structure.commands) {
    if (command.name !== "begin" && command.name !== "end") continue;
    const environmentName = command.requiredArguments[0]?.value.trim();
    if (!environmentName || structure.isRaw(command.from)) continue;
    if (environmentName === "document") continue; // preamble fold / \end{document} handle these
    if (environmentName === "frame") continue; // Beamer frame chrome is handled above
    if (withinMath(command.from)) continue; // selected math envs must reveal complete source
    if (withinOpenFloat(command.from)) continue; // open float is fully raw
    if (withinOpenList(command.from)) continue; // open list is fully raw while editing
    if (withinAbstract(command.from)) continue; // abstract handles both its own markers above
    if (touchesSelection(command.from, command.to)) continue;
    // A `title=` key is printed prose, not chrome. `tcolorbox` and the boxes
    // modelled on it carry the box heading there, so folding the marker away
    // wholesale deleted that heading from the page and left a blank row that
    // only showed the words again once you clicked it.
    const title = command.name === "begin"
      ? stripMarkup(enumitemOption(command.optionalArguments[0]?.value, "title") ?? "")
      : "";
    if (title) {
      hide(command.from, command.to, Decoration.replace({ widget: new SectionLabelWidget(title) }));
      continue;
    }
    hide(command.from, command.to);
  }

  // --- Comment lines: dim from % to end of line ---
  for (const comment of structure.comments) {
    if (comment.from < bodyStart || comment.from >= scanEnd) continue;
    marks.push({ from: comment.from, to: comment.to, value: commentMark });
  }

  // --- Rows whose entire source folded away → no row at all ---
  // A fold either renders something or takes up no space. Anything else is an
  // empty line the reader cannot account for, which turns back into LaTeX the
  // moment they click it — the document looks like it lost content and the
  // caret keeps snagging on rows that print nothing (`\end{frame}`,
  // `\begin{center}`, a `\begin{tcolorbox}[…]` option list wrapped over three
  // lines, `\vspace`, `\addcontentsline`). Their height goes away here; the
  // source is still one arrow key away, and Code mode always shows it.
  const blankRanges = mergeRanges(blankHidden);
  const rangeAt = (ranges: Range[], position: number): boolean => {
    const candidate = ranges[rangeInsertionIndex(ranges, position + 1) - 1];
    return Boolean(candidate) && position < candidate.to;
  };
  /** True when nothing on this line survives into the rendered page. */
  const lineRendersNothing = (from: number, lineText: string): boolean => {
    for (let index = 0; index < lineText.length; index += 1) {
      const char = lineText[index];
      if (char === " " || char === "\t" || char === "\r") continue;
      if (!rangeAt(blankRanges, from + index)) return false;
    }
    return true;
  };
  // Frames are walked alongside the rows so the slide card's rounded top and
  // bottom edges land on rows that are actually drawn. The environment index
  // reports a closing `\end`, so order them by where each frame starts.
  frameSpans.sort((left, right) => left.from - right.from);
  let frameIndex = 0;
  let frameFirstRow = -1;
  let frameLastRow = -1;
  const closeFrameCard = () => {
    if (frameFirstRow < 0) return;
    marks.push({ from: frameFirstRow, to: frameFirstRow, value: frameFirstLine });
    marks.push({ from: frameLastRow, to: frameLastRow, value: frameLastLine });
    frameFirstRow = -1;
    frameLastRow = -1;
  };
  for (let number = 1; number <= state.doc.lines;) {
    const first = state.doc.line(number);
    // A replace decoration that swallows a line break merges those source lines
    // into a single rendered row, so the whole run has to be blank to drop it.
    let line = first;
    let blank = lineRendersNothing(line.from, line.text);
    let hasSource = line.text.trim().length > 0;
    while (line.number < state.doc.lines && rangeAt(hidden, line.to)) {
      line = state.doc.line(line.number + 1);
      blank = blank && lineRendersNothing(line.from, line.text);
      hasSource = hasSource || line.text.trim().length > 0;
    }
    const collapsed = blank && hasSource;
    if (collapsed) {
      marks.push({ from: first.from, to: first.from, value: structuralOnlyLine });
      gutterMarks.push({ from: first.from, value: structuralOnlyGutterMarker });
    }
    while (frameIndex < frameSpans.length && frameSpans[frameIndex].to <= first.from) {
      closeFrameCard();
      frameIndex += 1;
    }
    const frame = frameSpans[frameIndex];
    if (!collapsed && frame && first.from >= frame.from && first.from < frame.to) {
      if (frameFirstRow < 0) frameFirstRow = first.from;
      frameLastRow = first.from;
    }
    number = line.number + 1;
  }
  closeFrameCard();

  // Sort by `from`, then `startSide` so line/widget points order correctly against
  // replaces at the same position (RangeSetBuilder requires this exact ordering).
  const toSet = (list: Decorated[]) => {
    list.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
    const builder = new RangeSetBuilder<Decoration>();
    for (const mark of list) builder.add(mark.from, mark.to, mark.value);
    return builder.finish();
  };
  const gutterBuilder = new RangeSetBuilder<GutterMarker>();
  gutterMarks
    .sort((left, right) => left.from - right.from)
    .forEach((mark) => gutterBuilder.add(mark.from, mark.from, mark.value));
  return {
    deco: toSet(marks),
    atomic: toSet(atomicMarks),
    gutterClasses: gutterBuilder.finish(),
    revealRanges: mergeRanges(revealRanges),
    pointerSelecting: false,
    pendingRefresh: false,
    structure,
  };
}

function mapRangesThroughChanges(ranges: Range[], tr: Transaction): Range[] {
  return mergeRanges(ranges.map((range) => ({
    from: tr.changes.mapPos(range.from, -1),
    to: tr.changes.mapPos(range.to, 1),
  })).filter((range) => range.to > range.from));
}

/**
 * Decorations live in a StateField (not a ViewPlugin) because the folded
 * preamble is a block widget. Text changes only map the existing ranges, which
 * is cheap and keeps the DOM stable while typing. A companion view plugin
 * coalesces bursts of edits and reconciles content-sensitive widgets after a
 * short idle interval. Plain prose edits need no decoration rebuild at all.
 */
const visualDecorationField = StateField.define<VisualDecorations>({
  create(state) {
    return buildDecorations(state);
  },
  update(value, tr) {
    if (tr.effects.some((effect) => effect.is(reparseVisualLatex))) {
      // The idle parser can fire in the middle of a native drag after an
      // earlier edit. Rebuilding here replaces heading/widget DOM underneath
      // the browser selection and makes it flash or lose its anchor. Mouseup
      // performs the pending rebuild once the geometry is final.
      if (value.pointerSelecting) return value;
      return value.pendingRefresh ? buildDecorations(tr.state) : value;
    }
    if (tr.reconfigured) return buildDecorations(tr.state);
    if (tr.docChanged) {
      const source = tr.state.doc.toString();
      const mappedStructure = updateLatexStructure(value.structure, source, tr.changes);
      let touchesRenderedContent = false;
      tr.changes.iterChanges((fromA, toA) => {
        if (touchesRenderedContent) return;
        touchesRenderedContent = value.revealRanges.some((range) => (
          fromA === toA
            ? fromA >= range.from && fromA <= range.to
            : fromA < range.to && toA > range.from
        ));
      });
      return {
        ...value,
        deco: value.deco.map(tr.changes),
        atomic: value.atomic.map(tr.changes),
        gutterClasses: value.gutterClasses.map(tr.changes),
        revealRanges: mapRangesThroughChanges(value.revealRanges, tr),
        // Ordinary prose edits update the semantic index immediately without a
        // text scan. Structural edits keep the previous index until the shared
        // idle rebuild, preserving correctness around TeX delimiters.
        structure: mappedStructure ?? value.structure,
        pendingRefresh: value.pendingRefresh || !mappedStructure || touchesRenderedContent,
      };
    }
    const pointerEffect = tr.effects.find((effect) => effect.is(visualPointerSelecting));
    if (pointerEffect) {
      if (pointerEffect.value) return { ...value, pointerSelecting: true };
      // Selection geometry is now final. Rebuilding once here reveals syntax
      // for a click, or restores the rendered form for a completed drag.
      return buildDecorations(
        tr.state,
        value.structure.source === tr.state.doc.toString() ? value.structure : undefined,
      );
    }
    if (value.pointerSelecting) return value;
    // Most arrow-key moves stay in visible prose and do not affect which raw
    // syntax is folded. Rebuild only when entering or leaving a range that can
    // reveal source; this avoids a full-document decoration pass per cursor move.
    if (tr.selection && (
      selectionTouchesRanges(tr.startState.selection, value.revealRanges)
      || selectionTouchesRanges(tr.state.selection, value.revealRanges)
    )) {
      // A text edit maps the old ranges immediately and schedules a fresh
      // parse. Do not combine that new document with the previous document's
      // structural offsets if the caret moves before the idle refresh fires.
      if (value.structure.source !== tr.state.doc.toString()) return value;
      return buildDecorations(tr.state, value.structure);
    }
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.deco),
    gutterLineClass.from(field, (value) => value.gutterClasses),
    // Only hidden syntax is atomic — the caret steps over it, but can still land
    // inside styled text to reveal a command for editing.
    EditorView.atomicRanges.of((view) => view.state.field(field, false)?.atomic ?? Decoration.none),
  ],
});

export const visualDecorations = visualDecorationField;

export const visualDecorationsExtension = [visualDecorations, visualWidgetLineNumbers, visualDecorationScheduler];
