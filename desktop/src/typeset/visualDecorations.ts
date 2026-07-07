import { EditorSelection, RangeSetBuilder, StateField, type EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import katex from "katex";

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

/** Shared `ignoreEvent`: let CM's own mouseup bookkeeping run, but nothing else. */
function blockIgnoreEvent(event: Event): boolean {
  return event.type !== "mouseup";
}

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
 * common custom accent-color macro; harmless to hide when absent.
 */
const DECLARATION_RE =
  /\\(Huge|huge|LARGE|Large|large|normalsize|small|footnotesize|scriptsize|tiny|bfseries|mdseries|itshape|upshape|slshape|scshape|rmfamily|sffamily|ttfamily|normalfont|selectfont|centering|raggedright|raggedleft|coloraccent|boldmath|unboldmath|noindent|par)(?![a-zA-Z])/g;

const SECTION_LEVEL: Record<string, number> = {
  section: 1,
  subsection: 2,
  subsubsection: 3,
};

/** Section command → the CSS class carrying its display size/weight. */
const SECTION_CLASS: Record<number, string> = {
  1: "cm-vis-h1",
  2: "cm-vis-h2",
  3: "cm-vis-h3",
};

/** A hidden-syntax mark: zero-width, atomic so the caret steps over it. */
const hiddenMark = Decoration.replace({});

/** Heading line decorations, keyed by level so the whole line gets block styling. */
const headingLine: Record<number, Decoration> = {
  1: Decoration.line({ class: "cm-vis-heading-line cm-vis-heading-1" }),
  2: Decoration.line({ class: "cm-vis-heading-line cm-vis-heading-2" }),
  3: Decoration.line({ class: "cm-vis-heading-line cm-vis-heading-3" }),
};

/** Dim a comment line so it reads as an annotation rather than body text. */
const commentMark = Decoration.mark({ class: "cm-vis-comment" });

/** Indent a list item line so the bullet/number hangs like a rendered list. */
const listItemLine = Decoration.line({ class: "cm-vis-list-line" });

/** Center + shrink a caption line. */
const captionLine = Decoration.line({ class: "cm-vis-caption-line" });

/** Memoized alignment line decorations (center / flushleft / flushright). */
const alignLineCache: Record<string, Decoration> = {};
const alignLine = (cls: string): Decoration =>
  (alignLineCache[cls] ??= Decoration.line({ class: cls }));

/** Strip simple inline markup (`\emph{x}` → `x`) for chip/title display text. */
function stripMarkup(input: string): string {
  return input
    .replace(/\\(?:textbf|textit|emph|texttt|textsc|underline)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\\\/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

/** Auto section-number badge rendered before a heading's text. */
class SectionNumberWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }
  eq(other: SectionNumberWidget) {
    return other.label === this.label;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-vis-secnum";
    el.textContent = this.label;
    return el;
  }
}

/** A small pill chip — citations, cross-references, and standalone commands. */
class ChipWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly variant: string,
  ) {
    super();
  }
  eq(other: ChipWidget) {
    return other.label === this.label && other.variant === this.variant;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-vis-chip cm-vis-chip-${this.variant}`;
    el.textContent = this.label;
    return el;
  }
}

/** A forced line break (`\\` / `\\[len]`) rendered as an actual break. */
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
    el.className = "cm-vis-item-marker";
    el.textContent = this.marker;
    return el;
  }
}

/** Centered title block rendered in place of `\maketitle`. */
class TitleWidget extends WidgetType {
  constructor(
    private readonly title: string,
    private readonly author: string,
    private readonly date: string,
  ) {
    super();
  }
  eq(other: TitleWidget) {
    return other.title === this.title && other.author === this.author && other.date === this.date;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-vis-title";
    const h = document.createElement("div");
    h.className = "cm-vis-title-name";
    h.textContent = this.title || "Untitled";
    el.append(h);
    if (this.author) {
      const a = document.createElement("div");
      a.className = "cm-vis-title-author";
      a.textContent = this.author;
      el.append(a);
    }
    if (this.date) {
      const d = document.createElement("div");
      d.className = "cm-vis-title-date";
      d.textContent = this.date;
      el.append(d);
    }
    return el;
  }
}

/** Build the caption `<div>` shared by figure and table widgets. */
function buildCaptionEl(caption: string): HTMLDivElement {
  const cap = document.createElement("div");
  cap.className = "cm-vis-caption";
  cap.textContent = caption;
  return cap;
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
  ) {
    super();
  }
  eq(other: FigureWidget) {
    return other.path === this.path && other.caption === this.caption;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-vis-figure ${BLOCK_TARGET_CLASS}`;
    const icon = document.createElement("div");
    icon.className = "cm-vis-figure-icon";
    icon.textContent = "🖼";
    const name = document.createElement("div");
    name.className = "cm-vis-figure-name";
    name.textContent = this.path.split("/").pop() || this.path;
    el.append(icon, name);
    if (this.caption) el.append(buildCaptionEl(this.caption));
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

/** Standalone `\includegraphics{…}` with no enclosing `figure` environment. */
class GraphicsWidget extends WidgetType {
  constructor(private readonly path: string) {
    super();
  }
  eq(other: GraphicsWidget) {
    return other.path === this.path;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-vis-figure ${BLOCK_TARGET_CLASS}`;
    const icon = document.createElement("div");
    icon.className = "cm-vis-figure-icon";
    icon.textContent = "🖼";
    const name = document.createElement("div");
    name.className = "cm-vis-figure-name";
    name.textContent = this.path.split("/").pop() || this.path;
    el.append(icon, name);
    return el;
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
  ) {
    super();
  }
  eq(other: TableWidget) {
    return (
      other.hasHeader === this.hasHeader &&
      other.caption === this.caption &&
      JSON.stringify(other.rows) === JSON.stringify(this.rows)
    );
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = `cm-vis-table-wrap ${BLOCK_TARGET_CLASS}`;
    const table = document.createElement("table");
    table.className = "cm-vis-table";
    this.rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      const header = this.hasHeader && index === 0;
      for (const cell of row) {
        const td = document.createElement(header ? "th" : "td");
        td.textContent = cell;
        tr.append(td);
      }
      table.append(tr);
    });
    wrap.append(table);
    if (this.caption) wrap.append(buildCaptionEl(this.caption));
    return wrap;
  }
  ignoreEvent = blockIgnoreEvent;
}

/** Split a `tabular` body into a grid, dropping booktabs/hline rules. */
function parseTabular(body: string): string[][] {
  const cleaned = body
    .replace(/\\(top|mid|bottom)rule/g, "")
    .replace(/\\hline/g, "")
    .replace(/\\cmidrule\s*(\([^)]*\))?\s*(\[[^\]]*\])?\s*\{[^}]*\}/g, "");
  return cleaned
    .split(/\\\\/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) =>
      row
        .split(/(?<!\\)&/)
        .map((cell) => stripMarkup(cell).replace(/\\([%&_#$])/g, "$1").trim()),
    );
}

/** KaTeX-rendered math, shown in place of the `$…$` / `\[…\]` source. */
class MathWidget extends WidgetType {
  constructor(
    private readonly latex: string,
    private readonly display: boolean,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.latex === this.latex && other.display === this.display;
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display
      ? `cm-vis-math cm-vis-math-display ${BLOCK_TARGET_CLASS}`
      : "cm-vis-math";
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
  // Only display-mode math opts out of CM's default click handling — inline
  // math sits within normal text flow, where the default already works fine.
  ignoreEvent = (event: Event) => (this.display ? blockIgnoreEvent(event) : true);
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
export const visualBlockClick = EditorView.domEventHandlers({
  mouseup(event, view) {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(`.${BLOCK_TARGET_CLASS}`)) return false;
    event.preventDefault();
    const line = view.lineBlockAtHeight(event.clientY - view.documentTop);
    view.dispatch({ selection: EditorSelection.cursor(line.to), scrollIntoView: true });
    return true;
  },
});

/** True when a selection range touches [from, to] — used to reveal raw syntax. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
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

type Decorated = { from: number; to: number; value: Decoration };

type VisualDecorations = { deco: DecorationSet; atomic: DecorationSet };

function buildDecorations(state: EditorState): VisualDecorations {
  const text = state.doc.toString();
  const marks: Decorated[] = [];
  // Only *hidden syntax* (replaced command markup, folded preamble) is atomic so
  // the caret steps over it. Styling marks (bold/italic/heading text) must NOT be
  // atomic, or the caret can never land inside a command to reveal it for editing.
  const atomicMarks: Decorated[] = [];
  // Accepted hidden intervals, kept sorted, so overlapping replace decorations are
  // never emitted — CodeMirror throws on overlapping replaces, and real documents
  // can nest constructs (e.g. `\vspace` inside a math block) that would collide.
  const hidden: Array<{ from: number; to: number }> = [];
  const overlapsHidden = (from: number, to: number) =>
    hidden.some((h) => from < h.to && to > h.from);
  const hide = (from: number, to: number, value: Decoration = hiddenMark) => {
    if (to <= from) return; // never emit a zero-width or inverted replace
    if (overlapsHidden(from, to)) return; // first hide wins; skip the collider
    hidden.push({ from, to });
    marks.push({ from, to, value });
    atomicMarks.push({ from, to, value });
  };

  // --- Preamble: fold everything up to and including \begin{document} ---
  const beginDoc = text.search(/\\begin\{document\}/);
  let bodyStart = 0;
  if (beginDoc >= 0) {
    const afterBegin = text.indexOf("\n", beginDoc);
    bodyStart = afterBegin >= 0 ? afterBegin + 1 : text.length;
    // The preamble always folds (it is edited in Code mode). Fold through the end
    // of the `\begin{document}` line but NOT its trailing newline: a block replace
    // that ends at the next line's start absorbs that line's own decorations (a
    // heading sitting right after \begin{document} would lose its styling), so we
    // stop at the newline and let it separate the fold from the body.
    const foldEnd = afterBegin >= 0 ? afterBegin : bodyStart;
    const lineCount = state.doc.lineAt(beginDoc).number;
    hide(0, foldEnd, Decoration.replace({ widget: new PreambleWidget(lineCount) }));
  }

  // --- \end{document} and trailing content: hide the closing marker ---
  const endDoc = text.indexOf("\\end{document}");
  const scanEnd = endDoc >= 0 ? endDoc : text.length;

  // --- Math: display environments, \[…\], and inline $…$ (KaTeX widgets) ---
  const mathRanges: Range[] = [];
  const withinMath = (pos: number) => mathRanges.some((m) => pos >= m.from && pos < m.to);
  const addMath = (from: number, to: number, latex: string, display: boolean) => {
    mathRanges.push({ from, to });
    // Both reveal their source on caret — display math used to stay permanently
    // rendered to avoid a page-shifting "jump", but the real bug was the CLICK
    // landing at the wrong position (see `visualBlockClick`), not the reveal
    // itself. With clicks fixed, display math can safely support in-place editing
    // like Overleaf's own visual editor does.
    if (selectionTouches(state, from, to)) return;
    hide(from, to, Decoration.replace({ widget: new MathWidget(latex.trim(), display) }));
  };

  const displayEnvRe = /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}/g;
  let dm: RegExpExecArray | null;
  displayEnvRe.lastIndex = bodyStart;
  while ((dm = displayEnvRe.exec(text)) && dm.index < scanEnd) {
    const body = dm[2].replace(/\\label\{[^}]*\}/g, "");
    addMath(dm.index, dm.index + dm[0].length, body, true);
  }

  const bracketRe = /\\\[([\s\S]+?)\\\]/g;
  let bm: RegExpExecArray | null;
  bracketRe.lastIndex = bodyStart;
  while ((bm = bracketRe.exec(text)) && bm.index < scanEnd) {
    if (withinMath(bm.index)) continue;
    addMath(bm.index, bm.index + bm[0].length, bm[1], true);
  }

  // Inline `$…$` — single dollars only, skipping `$$` and escaped `\$`.
  const inlineMathRe = /(?<!\\)\$(?!\$)((?:\\.|[^$\\])+?)\$/g;
  let mm: RegExpExecArray | null;
  inlineMathRe.lastIndex = bodyStart;
  while ((mm = inlineMathRe.exec(text)) && mm.index < scanEnd) {
    if (withinMath(mm.index)) continue;
    addMath(mm.index, mm.index + mm[0].length, mm[1], false);
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
  const readCaption = (inner: string, innerFrom: number): string => {
    const cap = /\\caption\s*\{/.exec(inner);
    if (!cap) return "";
    const openBrace = innerFrom + cap.index + cap[0].length - 1;
    const close = matchBrace(text, openBrace);
    return close < 0 ? "" : stripMarkup(text.slice(openBrace + 1, close - 1));
  };

  const floatEnvRe = /\\begin\{(figure\*?|table\*?)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{\1\}/g;
  floatEnvRe.lastIndex = bodyStart;
  let fe: RegExpExecArray | null;
  while ((fe = floatEnvRe.exec(text)) && fe.index < scanEnd) {
    const envFrom = fe.index;
    const envTo = envFrom + fe[0].length;
    if (selectionTouches(state, envFrom, envTo)) {
      openFloatRanges.push({ from: envFrom, to: envTo });
      continue; // caret is editing this float — leave it fully raw
    }
    const inner = fe[2];
    const innerFrom = envTo - inner.length - `\\end{${fe[1]}}`.length;
    const caption = readCaption(inner, innerFrom);
    if (fe[1].startsWith("table")) {
      const tabularMatch = /\\begin\{tabular\}(?:\[[^\]]*\])?\s*\{[^}]*\}([\s\S]*?)\\end\{tabular\}/.exec(inner);
      const rows = tabularMatch ? parseTabular(tabularMatch[1]) : [];
      if (tabularMatch && rows.length > 0) {
        hide(
          envFrom,
          envTo,
          Decoration.replace({ widget: new TableWidget(rows, /\\toprule/.test(tabularMatch[0]), caption), block: true }),
        );
        continue;
      }
    } else {
      const graphicsMatch = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(inner);
      if (graphicsMatch) {
        hide(
          envFrom,
          envTo,
          Decoration.replace({ widget: new FigureWidget(graphicsMatch[1].trim(), caption), block: true }),
        );
        continue;
      }
    }
    // Unrecognized inner content (no image / no parseable table) — fall through
    // to the generic env-marker/declaration passes below, so at least the
    // wrapper commands hide and the raw content still flows and stays readable.
  }

  // --- Tables: bare `tabular` with no enclosing `table` float ---
  const tabularRe = /\\begin\{tabular\}(?:\[[^\]]*\])?\s*\{[^}]*\}([\s\S]*?)\\end\{tabular\}/g;
  tabularRe.lastIndex = bodyStart;
  let tb: RegExpExecArray | null;
  while ((tb = tabularRe.exec(text)) && tb.index < scanEnd) {
    const from = tb.index;
    const to = from + tb[0].length;
    if (withinOpenFloat(from)) continue;
    if (selectionTouches(state, from, to)) continue;
    const rows = parseTabular(tb[1]);
    if (rows.length === 0) continue;
    const hasHeader = /\\toprule/.test(tb[0]);
    hide(from, to, Decoration.replace({ widget: new TableWidget(rows, hasHeader), block: true }));
  }

  // --- Figures: bare `\includegraphics{…}` with no enclosing `figure` float ---
  const graphicsRe = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  graphicsRe.lastIndex = bodyStart;
  let gm: RegExpExecArray | null;
  while ((gm = graphicsRe.exec(text)) && gm.index < scanEnd) {
    const from = gm.index;
    const to = from + gm[0].length;
    if (withinOpenFloat(from)) continue;
    if (selectionTouches(state, from, to)) continue;
    hide(from, to, Decoration.replace({ widget: new GraphicsWidget(gm[1].trim()), block: true }));
  }

  // --- Section headings (numbered) ---
  const counters = [0, 0, 0];
  const headingRe = /\\(section|subsection|subsubsection)\*?\s*\{/g;
  const headingBraces: Range[] = [];
  let hm: RegExpExecArray | null;
  headingRe.lastIndex = bodyStart;
  while ((hm = headingRe.exec(text)) && hm.index < scanEnd) {
    const level = SECTION_LEVEL[hm[1]];
    const openBrace = hm.index + hm[0].length - 1;
    const close = matchBrace(text, openBrace);
    if (close < 0) continue;
    const starred = hm[0].includes("*");
    // Advance counters for numbering (starred sections are unnumbered).
    let label = "";
    if (!starred) {
      counters[level - 1] += 1;
      for (let deeper = level; deeper < counters.length; deeper += 1) counters[deeper] = 0;
      label = counters.slice(0, level).join(".");
    }
    headingBraces.push({ from: hm.index, to: close });

    const cmdStart = hm.index;
    const cmdEnd = openBrace + 1; // through the opening brace
    const line = state.doc.lineAt(cmdStart);
    marks.push({ from: line.from, to: line.from, value: headingLine[level] });

    if (!selectionTouches(state, cmdStart, close)) {
      // Hide `\section{` and its closing `}`, keep the title text styled.
      hide(cmdStart, cmdEnd);
      if (label) {
        marks.push({
          from: cmdStart,
          to: cmdStart,
          value: Decoration.widget({ widget: new SectionNumberWidget(label), side: -1 }),
        });
      }
      marks.push({ from: cmdEnd, to: close - 1, value: Decoration.mark({ class: SECTION_CLASS[level] }) });
      hide(close - 1, close);
    }
  }

  const withinHeading = (pos: number) => headingBraces.some((h) => pos >= h.from && pos < h.to);

  // --- Inline text commands: \textbf{..} \emph{..} etc. ---
  const inlineRe = /\\(textbf|textit|emph|underline|texttt|textsc|textsubscript|textsuperscript)\s*\{/g;
  inlineRe.lastIndex = bodyStart;
  let im: RegExpExecArray | null;
  while ((im = inlineRe.exec(text)) && im.index < scanEnd) {
    if (withinHeading(im.index) || withinMath(im.index)) continue;
    const cls = INLINE_TEXT_COMMANDS[im[1]];
    const openBrace = im.index + im[0].length - 1;
    const close = matchBrace(text, openBrace);
    if (close < 0) continue;
    if (selectionTouches(state, im.index, close)) continue; // reveal for editing
    hide(im.index, openBrace + 1);
    marks.push({ from: openBrace + 1, to: close - 1, value: Decoration.mark({ class: cls }) });
    hide(close - 1, close);
  }

  // Replace a whole `\cmd{arg}` span with a chip, unless the caret is inside it.
  const chipCommand = (cmdStart: number, openBrace: number, render: (arg: string) => ChipWidget) => {
    const close = matchBrace(text, openBrace);
    if (close < 0) return;
    if (withinOpenFloat(cmdStart)) return; // open float is fully raw
    if (selectionTouches(state, cmdStart, close)) return; // reveal for editing
    const arg = text.slice(openBrace + 1, close - 1);
    hide(cmdStart, close, Decoration.replace({ widget: render(arg) }));
  };

  // --- Citations: \cite{a,b} \citep \citet \parencite \textcite ---
  const citeRe = /\\(cite|citep|citet|parencite|textcite|autocite)\s*\{/g;
  citeRe.lastIndex = bodyStart;
  let ce: RegExpExecArray | null;
  while ((ce = citeRe.exec(text)) && ce.index < scanEnd) {
    if (withinHeading(ce.index) || withinMath(ce.index)) continue;
    const openBrace = ce.index + ce[0].length - 1;
    chipCommand(ce.index, openBrace, (arg) => {
      const keys = arg.split(",").map((k) => k.trim()).filter(Boolean);
      const label = keys.length > 1 ? `${keys[0]} +${keys.length - 1}` : keys[0] || "cite";
      return new ChipWidget(label, "cite");
    });
  }

  // --- Cross references: \ref \eqref \autoref \cref \pageref ---
  const refRe = /\\(ref|eqref|autoref|cref|Cref|pageref)\s*\{/g;
  refRe.lastIndex = bodyStart;
  let re: RegExpExecArray | null;
  while ((re = refRe.exec(text)) && re.index < scanEnd) {
    if (withinMath(re.index)) continue;
    const openBrace = re.index + re[0].length - 1;
    chipCommand(re.index, openBrace, (arg) => new ChipWidget(arg.trim() || "ref", "ref"));
  }

  // --- \label{..}: dim to a small tag (not editable clutter in body text) ---
  const labelRe = /\\label\s*\{/g;
  labelRe.lastIndex = bodyStart;
  let le: RegExpExecArray | null;
  while ((le = labelRe.exec(text)) && le.index < scanEnd) {
    if (withinMath(le.index)) continue;
    const openBrace = le.index + le[0].length - 1;
    chipCommand(le.index, openBrace, (arg) => new ChipWidget(`§ ${arg.trim()}`, "label"));
  }

  // --- Lists: bullet / number markers in place of \item ---
  const listRe = /\\begin\{(itemize|enumerate)\}([\s\S]*?)\\end\{\1\}/g;
  listRe.lastIndex = bodyStart;
  let lm: RegExpExecArray | null;
  while ((lm = listRe.exec(text)) && lm.index < scanEnd) {
    const ordered = lm[1] === "enumerate";
    const bodyFrom = lm.index + `\\begin{${lm[1]}}`.length;
    const bodyTo = lm.index + lm[0].length - `\\end{${lm[1]}}`.length;
    // Hide the \begin / \end environment lines themselves.
    hide(lm.index, bodyFrom);
    hide(bodyTo, lm.index + lm[0].length);
    const itemRe = /\\item(?:\[[^\]]*\])?/g;
    itemRe.lastIndex = bodyFrom;
    let it: RegExpExecArray | null;
    let n = 0;
    while ((it = itemRe.exec(text)) && it.index < bodyTo) {
      n += 1;
      const itemEnd = it.index + it[0].length;
      const line = state.doc.lineAt(it.index);
      marks.push({ from: line.from, to: line.from, value: listItemLine });
      if (!selectionTouches(state, it.index, itemEnd)) {
        const marker = ordered ? `${n}.` : "•";
        hide(it.index, itemEnd, Decoration.replace({ widget: new ItemMarkerWidget(marker) }));
      }
    }
  }

  // --- Standalone structural commands ---
  // \maketitle → centered title block built from the preamble metadata.
  const makeTitle = text.indexOf("\\maketitle");
  if (makeTitle >= 0 && !selectionTouches(state, makeTitle, makeTitle + "\\maketitle".length)) {
    const readArg = (cmd: string) => {
      const at = text.search(new RegExp(`\\\\${cmd}\\s*\\{`));
      if (at < 0) return "";
      const brace = text.indexOf("{", at);
      const end = matchBrace(text, brace);
      return end < 0 ? "" : stripMarkup(text.slice(brace + 1, end - 1));
    };
    const dateRaw = readArg("date");
    const date = /\\today/.test(dateRaw) ? "" : dateRaw;
    hide(
      makeTitle,
      makeTitle + "\\maketitle".length,
      Decoration.replace({ widget: new TitleWidget(readArg("title"), readArg("author"), date) }),
    );
  }

  // \tableofcontents → a chip; \end{document} and structural no-ops → hidden.
  const standaloneRe = /\\(tableofcontents|newpage|clearpage|bigskip|medskip|smallskip|noindent|centering|maketitle)\b|\\(?:vspace|hspace)\*?\s*\{[^}]*\}|\\(?:thispagestyle|pagestyle)\s*\{[^}]*\}|\\end\{document\}/g;
  standaloneRe.lastIndex = bodyStart;
  let sm: RegExpExecArray | null;
  while ((sm = standaloneRe.exec(text))) {
    const from = sm.index;
    const to = from + sm[0].length;
    if (from === makeTitle) continue; // handled above
    if (withinOpenFloat(from)) continue; // open float is fully raw — see above
    // `\end{document}` always hides (it is never edited in the visual view); the
    // rest reveal on caret so the source stays reachable.
    const isEndDoc = sm[0] === "\\end{document}";
    if (!isEndDoc && selectionTouches(state, from, to)) continue;
    if (/tableofcontents/.test(sm[0])) {
      hide(from, to, Decoration.replace({ widget: new ChipWidget("Table of contents", "toc") }));
    } else {
      hide(from, to); // \end{document}, \newpage, \noindent, \vspace, … → invisible
    }
  }

  // --- Alignment environments: center / flushleft / flushright ---
  const alignEnvRe = /\\begin\{(center|flushleft|flushright)\}([\s\S]*?)\\end\{\1\}/g;
  alignEnvRe.lastIndex = bodyStart;
  const alignClass: Record<string, string> = {
    center: "cm-vis-center",
    flushleft: "cm-vis-flushleft",
    flushright: "cm-vis-flushright",
  };
  let ae: RegExpExecArray | null;
  while ((ae = alignEnvRe.exec(text)) && ae.index < scanEnd) {
    const innerFrom = ae.index + `\\begin{${ae[1]}}`.length;
    const innerTo = ae.index + ae[0].length - `\\end{${ae[1]}}`.length;
    // Apply the alignment to every line the environment spans.
    let pos = innerFrom;
    while (pos < innerTo) {
      const line = state.doc.lineAt(pos);
      marks.push({ from: line.from, to: line.from, value: alignLine(alignClass[ae[1]]) });
      pos = line.to + 1;
    }
  }

  // --- Figure/table captions → styled caption text, command hidden ---
  const captionRe = /\\caption\s*\{/g;
  captionRe.lastIndex = bodyStart;
  let cap: RegExpExecArray | null;
  while ((cap = captionRe.exec(text)) && cap.index < scanEnd) {
    if (withinOpenFloat(cap.index)) continue; // open float is fully raw
    const openBrace = cap.index + cap[0].length - 1;
    const close = matchBrace(text, openBrace);
    if (close < 0) continue;
    if (selectionTouches(state, cap.index, close)) continue;
    const line = state.doc.lineAt(cap.index);
    marks.push({ from: line.from, to: line.from, value: captionLine });
    hide(cap.index, openBrace + 1);
    marks.push({ from: openBrace + 1, to: close - 1, value: Decoration.mark({ class: "cm-vis-caption" }) });
    hide(close - 1, close);
  }

  // --- Bare formatting declarations → hidden (formatting noise as raw text) ---
  DECLARATION_RE.lastIndex = bodyStart;
  let de: RegExpExecArray | null;
  while ((de = DECLARATION_RE.exec(text)) && de.index < scanEnd) {
    if (withinOpenFloat(de.index)) continue; // open float is fully raw
    if (selectionTouches(state, de.index, de.index + de[0].length)) continue;
    hide(de.index, de.index + de[0].length);
  }

  // --- Forced line breaks `\\` / `\\[len]` → an actual break ---
  const breakRe = /\\\\(\s*\[[^\]]*\])?/g;
  breakRe.lastIndex = bodyStart;
  let br: RegExpExecArray | null;
  while ((br = breakRe.exec(text)) && br.index < scanEnd) {
    if (withinMath(br.index) || withinOpenFloat(br.index)) continue; // row break / open float is raw
    if (selectionTouches(state, br.index, br.index + br[0].length)) continue;
    hide(br.index, br.index + br[0].length, Decoration.replace({ widget: new BreakWidget() }));
  }

  // --- Escaped characters `\%` `\&` `\_` `\#` `\$` → show the literal char ---
  // Hiding just the backslash leaves the char visible; the source keeps `\%`, so
  // comment/math detection (which look for an unescaped `%`/`$`) still skip it.
  const escapeRe = /\\[%&_#$]/g;
  escapeRe.lastIndex = bodyStart;
  let esc: RegExpExecArray | null;
  while ((esc = escapeRe.exec(text)) && esc.index < scanEnd) {
    if (withinMath(esc.index)) continue;
    if (selectionTouches(state, esc.index, esc.index + 2)) continue;
    hide(esc.index, esc.index + 1); // hide the backslash only
  }

  // --- Unknown environment markers → hidden, content flows (graceful default) ---
  // Runs last so specially-handled envs (math/list/align, already in `hidden`) win
  // via the overlap dedupe; unknown wrappers like `tcolorbox`/`tcolor` just vanish.
  const envMarkerRe = /\\(begin|end)\{([a-zA-Z*]+)\}(\s*\[[^\]]*\])?(\s*\{[^}]*\})?/g;
  envMarkerRe.lastIndex = 0;
  let em: RegExpExecArray | null;
  while ((em = envMarkerRe.exec(text))) {
    if (em[2] === "document") continue; // preamble fold / \end{document} handle these
    if (withinOpenFloat(em.index)) continue; // open float is fully raw
    if (selectionTouches(state, em.index, em.index + em[0].length)) continue;
    hide(em.index, em.index + em[0].length);
  }

  // --- Comment lines: dim from % to end of line ---
  const commentRe = /(^|[^\\])%[^\n]*/g;
  let cm: RegExpExecArray | null;
  while ((cm = commentRe.exec(text))) {
    if (cm.index < bodyStart) continue;
    const pct = cm.index + (cm[1] ? cm[1].length : 0);
    if (withinMath(pct)) continue; // `%` inside math is not a comment
    const lineEnd = cm.index + cm[0].length;
    marks.push({ from: pct, to: lineEnd, value: commentMark });
  }

  // Sort by `from`, then `startSide` so line/widget points order correctly against
  // replaces at the same position (RangeSetBuilder requires this exact ordering).
  const toSet = (list: Decorated[]) => {
    list.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
    const builder = new RangeSetBuilder<Decoration>();
    for (const mark of list) builder.add(mark.from, mark.to, mark.value);
    return builder.finish();
  };
  return { deco: toSet(marks), atomic: toSet(atomicMarks) };
}

/**
 * Decorations live in a StateField (not a ViewPlugin) because the folded
 * preamble is a *block* widget, and CodeMirror only accepts block decorations
 * from state facets. The set is rebuilt whenever the document or the selection
 * changes — selection drives the reveal-on-caret behavior.
 */
const visualDecorationField = StateField.define<VisualDecorations>({
  create(state) {
    return buildDecorations(state);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection) return buildDecorations(tr.state);
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.deco),
    // Only hidden syntax is atomic — the caret steps over it, but can still land
    // inside styled text to reveal a command for editing.
    EditorView.atomicRanges.of((view) => view.state.field(field, false)?.atomic ?? Decoration.none),
  ],
});

export const visualDecorations = visualDecorationField;
