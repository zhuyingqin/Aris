import { EditorSelection, Facet, RangeSetBuilder, StateField, type EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import katex from "katex";
import { fileReadBytes } from "../api/tauri";

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
const pdfWorkerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

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
 * common custom accent-color macro; harmless to hide when absent. Includes the
 * classic short-form aliases (`\bf`, `\it`, …) alongside the LaTeX2e names —
 * both show up on hand-built titles like `{\LARGE \bf My Title}`.
 */
const DECLARATION_RE =
  /\\(Huge|huge|LARGE|Large|large|normalsize|small|footnotesize|scriptsize|tiny|bfseries|mdseries|itshape|upshape|slshape|scshape|rmfamily|sffamily|ttfamily|normalfont|selectfont|centering|raggedright|raggedleft|coloraccent|boldmath|unboldmath|noindent|par|bf|it|rm|sc|sl|em|tt)(?![a-zA-Z])/g;

const SECTION_LEVEL: Record<string, number> = {
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
};

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
    .replace(DECLARATION_RE, "")
    .replace(/\\\\/g, "\n")
    .replace(/[{}]/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
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
  constructor(private readonly label: string) {
    super();
  }
  eq(other: TheoremLabelWidget) {
    return other.label === this.label;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-vis-theorem-label ${BLOCK_TARGET_CLASS}`;
    el.textContent = this.label;
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
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
    el.title = "Click to edit in Code mode";
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", () => onJump(range.from, range.to));
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
  ignoreEvent() {
    return true;
  }
}

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function headingTitleRangeAtLine(state: EditorState, lineFrom: number): Range | null {
  const line = state.doc.lineAt(lineFrom);
  const lineText = line.text;
  const hm = /\\(section|subsection|subsubsection|paragraph)\*?\s*\{/.exec(lineText);
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

async function readFigureBytes(imagePath: string, sourcePath: string | null): Promise<{ bytes: number[]; resolvedPath: string }> {
  const base = dirname(sourcePath);
  const candidates = Array.from(new Set([joinPath(base, imagePath), imagePath]));
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const bytes = await fileReadBytes(candidate);
      if (bytes.length > 0) return { bytes, resolvedPath: candidate };
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
  const { bytes, resolvedPath } = await readFigureBytes(imagePath, sourcePath);
  const mime = mimeForImage(resolvedPath);
  el.replaceChildren();
  if (mime === "application/pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.15 });
    const canvas = document.createElement("canvas");
    canvas.className = "cm-vis-figure-pdf";
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    el.append(canvas);
    await pdf.destroy();
  } else if (mime.startsWith("image/")) {
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    const url = URL.createObjectURL(blob);
    el.dataset.objectUrl = url;
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
    const icon = document.createElement("div");
    icon.className = "cm-vis-figure-icon";
    icon.textContent = "🖼";
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
    const icon = document.createElement("div");
    icon.className = "cm-vis-figure-icon";
    icon.textContent = "🖼";
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

/**
 * Placeholder for a `figure`/`table` float whose content is a drawing (TikZ/PGF)
 * rather than an image or table — there is no in-editor renderer for arbitrary
 * TikZ, so (like Overleaf's rich text mode) it collapses to one labelled card
 * instead of flowing dozens of raw `\node`/`\draw` lines inline. The source is
 * unchanged; double-click/caret still opens it in Code view to edit the drawing.
 */
class DiagramWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly caption: string,
  ) {
    super();
  }
  eq(other: DiagramWidget) {
    return other.label === this.label && other.caption === this.caption;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-vis-figure cm-vis-diagram ${BLOCK_TARGET_CLASS}`;
    const icon = document.createElement("div");
    icon.className = "cm-vis-figure-icon";
    icon.textContent = "\u{1F4D0}"; // 📐
    const name = document.createElement("div");
    name.className = "cm-vis-figure-name";
    name.textContent = this.label;
    const hint = document.createElement("div");
    hint.className = "cm-vis-diagram-hint";
    hint.textContent = "Edit in Code view to change the drawing";
    el.append(icon, name, hint);
    if (this.caption) el.append(buildCaptionEl(this.caption));
    return el;
  }
  ignoreEvent = blockIgnoreEvent;
}

type TabularMatch = { from: number; to: number; body: string; source: string };

function findTabularMatches(text: string, from: number, to: number): TabularMatch[] {
  const matches: TabularMatch[] = [];
  const beginRe = /\\begin\{tabular\}/g;
  beginRe.lastIndex = from;
  let tm: RegExpExecArray | null;
  while ((tm = beginRe.exec(text)) && tm.index < to) {
    let cursor = tm.index + tm[0].length;
    const option = /\s*\[[^\]]*\]/y;
    option.lastIndex = cursor;
    const opt = option.exec(text);
    if (opt) cursor = option.lastIndex;
    const ws = /\s*/y;
    ws.lastIndex = cursor;
    ws.exec(text);
    cursor = ws.lastIndex;
    if (text[cursor] !== "{") continue;
    const specEnd = matchBrace(text, cursor);
    if (specEnd < 0 || specEnd > to) continue;
    const bodyFrom = specEnd;
    const endMarker = "\\end{tabular}";
    const end = text.indexOf(endMarker, bodyFrom);
    if (end < 0 || end >= to) continue;
    const matchTo = end + endMarker.length;
    matches.push({
      from: tm.index,
      to: matchTo,
      body: text.slice(bodyFrom, end),
      source: text.slice(tm.index, matchTo),
    });
    beginRe.lastIndex = matchTo;
  }
  return matches;
}

/** Split a `tabular` body into a grid, dropping booktabs/hline rules. */
function parseTabular(body: string): string[][] {
  const cleaned = body
    .replace(/\\(top|mid|bottom)rule/g, "")
    .replace(/\\addlinespace(?:\[[^\]]*\])?/g, "")
    .replace(/\\hline/g, "")
    .replace(/\\cmidrule\s*(\([^)]*\))?\s*(\[[^\]]*\])?\s*\{[^}]*\}/g, "");
  return cleaned
    .split(/\\\\/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const multicol = /\\multicolumn\s*\{\d+\}\s*\{[^}]*\}\s*\{([\s\S]*)\}/.exec(row);
      if (multicol) return [stripMarkup(multicol[1]).replace(/\\([%&_#$])/g, "$1").trim()];
      return row
        .split(/(?<!\\)&/)
        .map((cell) => stripMarkup(cell).replace(/\\([%&_#$])/g, "$1").trim());
    });
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
    const target = eventElement(event.target);
    if (!target) return false;
    const isBlockTarget = Boolean(target.closest(`.${BLOCK_TARGET_CLASS}`));
    const isHeadingTarget = Boolean(target.closest(HEADING_TARGET_SELECTOR));
    if (!isBlockTarget && !isHeadingTarget) return false;
    event.preventDefault();
    const line = view.lineBlockAtHeight(event.clientY - view.documentTop);
    const headingRange = isHeadingTarget ? headingTitleRangeAtLine(view.state, line.from) : null;
    const pos = headingRange
      ? positionInRangeAtCoords(view, headingRange.from, headingRange.to, event.clientX, event.clientY)
      : line.to;
    view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
    return true;
  },
});

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
    // eslint-disable-next-line no-console -- temporary forward-search diagnostic, see conversation
    console.debug("[typeset] Visual dblclick", { hasHandler: Boolean(handler), isBlockTarget, pos });
    if (!handler) return false;
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    handler(line.number, pos - line.from + 1);
    return false;
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
  const sourcePath = state.facet(visualSourcePath);
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
  const floatEnvRanges: Range[] = [];
  const floatRangeRe = /\\begin\{(figure\*?|table\*?)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{\1\}/g;
  floatRangeRe.lastIndex = bodyStart;
  let fr: RegExpExecArray | null;
  while ((fr = floatRangeRe.exec(text)) && fr.index < scanEnd) {
    floatEnvRanges.push({ from: fr.index, to: fr.index + fr[0].length });
  }
  const withinFloatEnv = (pos: number) => floatEnvRanges.some((r) => pos >= r.from && pos < r.to);

  // --- Beamer frames: keep source editing continuous, but make each frame read
  // as a slide card with an editable title and explicit slide number. ---
  const frameEnvRe = /(\\begin\{frame\}(?:\[[^\]]*\])?\s*(?:\{([^{}\n]*)\})?)([\s\S]*?)(\\end\{frame\})/g;
  frameEnvRe.lastIndex = bodyStart;
  let fm: RegExpExecArray | null;
  let frameNumber = 0;
  while ((fm = frameEnvRe.exec(text)) && fm.index < scanEnd) {
    frameNumber += 1;
    const frameFrom = fm.index;
    const beginTo = frameFrom + fm[1].length;
    const frameTo = frameFrom + fm[0].length;
    const endFrom = frameTo - fm[4].length;

    let linePos = frameFrom;
    let first = true;
    while (linePos <= frameTo && linePos <= state.doc.length) {
      const line = state.doc.lineAt(linePos);
      const last = line.to >= frameTo || line.to >= state.doc.length;
      marks.push({ from: line.from, to: line.from, value: frameLine });
      if (first) marks.push({ from: line.from, to: line.from, value: frameFirstLine });
      if (last) marks.push({ from: line.from, to: line.from, value: frameLastLine });
      if (last) break;
      first = false;
      linePos = line.to + 1;
    }

    const inlineTitle = fm[2]?.trim() ?? "";
    const beginTitleOpen = inlineTitle ? fm[1].lastIndexOf("{") : -1;
    if (inlineTitle && beginTitleOpen >= 0) {
      const titleFrom = frameFrom + beginTitleOpen + 1;
      const titleTo = beginTo - 1;
      if (!selectionTouches(state, frameFrom, beginTo)) {
        hide(
          frameFrom,
          titleFrom,
          Decoration.replace({ widget: new FrameKickerWidget(frameNumber) }),
        );
        hide(titleTo, beginTo);
      }
      marks.push({ from: titleFrom, to: titleTo, value: Decoration.mark({ class: "cm-vis-frame-title" }) });
    } else {
      const frameTitleRe = /\\frametitle\s*\{/.exec(fm[3]);
      let fallbackTitle = /\\titlepage\b/.test(fm[3]) ? "Title slide" : "Untitled slide";
      if (frameTitleRe) {
        const commandFrom = beginTo + frameTitleRe.index;
        const openBrace = commandFrom + frameTitleRe[0].length - 1;
        const close = matchBrace(text, openBrace);
        if (close > 0 && close <= endFrom) {
          fallbackTitle = "";
          if (!selectionTouches(state, commandFrom, close)) {
            hide(commandFrom, openBrace + 1);
            hide(close - 1, close);
          }
          marks.push({ from: openBrace + 1, to: close - 1, value: Decoration.mark({ class: "cm-vis-frame-title" }) });
        }
      }
      if (!selectionTouches(state, frameFrom, beginTo)) {
        hide(
          frameFrom,
          beginTo,
          Decoration.replace({ widget: new FrameKickerWidget(frameNumber, fallbackTitle) }),
        );
      }
    }
    if (!selectionTouches(state, endFrom, frameTo)) hide(endFrom, frameTo);
  }

  // --- Math: display environments, \[…\], and inline $…$ (KaTeX widgets) ---
  const mathRanges: Range[] = [];
  const withinMath = (pos: number) => mathRanges.some((m) => pos >= m.from && pos < m.to);
  const addMath = (from: number, to: number, latex: string, display: boolean) => {
    if (withinFloatEnv(from)) return;
    mathRanges.push({ from, to });
    // Both reveal their source on caret — display math used to stay permanently
    // rendered to avoid a page-shifting "jump", but the real bug was the CLICK
    // landing at the wrong position (see `visualBlockClick`), not the reveal
    // itself. With clicks fixed, display math can safely support in-place editing
    // like Overleaf's own visual editor does.
    if (selectionTouches(state, from, to)) {
      if (display) markMathLines(from, to);
      marks.push({ from, to, value: display ? activeMathSourceDisplay : activeMathSourceInline });
      return;
    }
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
  // Keep a match on one source line: when a paper draft has one missing `$`,
  // allowing the matcher to cross a newline turns an entire later section into
  // math and suppresses its lists/headings/inline formatting. A malformed
  // formula should remain local raw source, not break the rest of Visual mode.
  const inlineMathRe = /(?<!\\)\$(?!\$)((?:\\.|[^$\\\n])+?)\$/g;
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
      const tabularMatch = findTabularMatches(text, innerFrom, envTo)[0];
      const rows = tabularMatch ? parseTabular(tabularMatch.body) : [];
      if (tabularMatch && rows.length > 0) {
        hide(
          envFrom,
          envTo,
          Decoration.replace({ widget: new TableWidget(rows, /\\toprule/.test(tabularMatch.source), caption), block: true }),
        );
        continue;
      }
    } else {
      const graphicsMatch = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(inner);
      if (graphicsMatch) {
        hide(
          envFrom,
          envTo,
          Decoration.replace({ widget: new FigureWidget(graphicsMatch[1].trim(), caption, sourcePath), block: true }),
        );
        continue;
      }
      // No `\includegraphics` — but a TikZ/PGF drawing has no in-editor renderer
      // either, so collapse it to one card instead of flowing dozens of raw
      // `\node`/`\draw` lines inline (see DiagramWidget doc comment).
      const drawingMatch = /\\begin\{(tikzpicture|pgfpicture)\}/.exec(inner);
      if (drawingMatch) {
        hide(
          envFrom,
          envTo,
          Decoration.replace({
            widget: new DiagramWidget(drawingMatch[1] === "pgfpicture" ? "PGF diagram" : "TikZ diagram", caption),
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
  for (const tb of findTabularMatches(text, bodyStart, scanEnd)) {
    const from = tb.from;
    const to = tb.to;
    if (withinOpenFloat(from)) continue;
    if (selectionTouches(state, from, to)) continue;
    const rows = parseTabular(tb.body);
    if (rows.length === 0) continue;
    const hasHeader = /\\toprule/.test(tb.source);
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
    hide(from, to, Decoration.replace({ widget: new GraphicsWidget(gm[1].trim(), sourcePath), block: true }));
  }

  // --- Section headings (numbered) ---
  const counters = [0, 0, 0];
  const headingRe = /\\(section|subsection|subsubsection|paragraph)\*?\s*\{/g;
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
    if (!starred && level <= counters.length) {
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

  // --- Theorem-like environments: readable label + hidden wrapper source ---
  // Environment declarations are structural chrome rather than prose. Keep them
  // visual even when the caret lands on the declaration; entering the theorem
  // body still exposes ordinary source commands for direct editing.
  const theoremBeginRe = /\\begin\{([a-zA-Z*]+)\}(\s*\[([^\]]*)\])?/g;
  theoremBeginRe.lastIndex = bodyStart;
  let theoremBegin: RegExpExecArray | null;
  while ((theoremBegin = theoremBeginRe.exec(text)) && theoremBegin.index < scanEnd) {
    const environment = theoremBegin[1];
    if (!THEOREM_ENVIRONMENTS.has(environment)) continue;
    const fallback = environment.charAt(0).toUpperCase() + environment.slice(1);
    const label = stripMarkup(theoremBegin[3]?.trim() || fallback) || fallback;
    hide(
      theoremBegin.index,
      theoremBegin.index + theoremBegin[0].length,
      Decoration.replace({ widget: new TheoremLabelWidget(label) }),
    );
  }
  const theoremEndRe = /\\end\{([a-zA-Z*]+)\}/g;
  theoremEndRe.lastIndex = bodyStart;
  let theoremEnd: RegExpExecArray | null;
  while ((theoremEnd = theoremEndRe.exec(text)) && theoremEnd.index < scanEnd) {
    if (!THEOREM_ENVIRONMENTS.has(theoremEnd[1])) continue;
    hide(theoremEnd.index, theoremEnd.index + theoremEnd[0].length);
  }

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
    const command = ce[1];
    const openBrace = ce.index + ce[0].length - 1;
    chipCommand(ce.index, openBrace, (arg) => {
      const keys = arg.split(",").map((k) => k.trim()).filter(Boolean);
      const label = keys.length === 0
        ? "[cite]"
        : keys.length === 1
          ? `[${keys[0]}]`
          : keys.length === 2
            ? `[${keys.join("; ")}]`
            : `[${keys[0]}; ${keys[1]}; +${keys.length - 2}]`;
      return new ChipWidget(label, "cite", `\\${command}{${arg}} - click to edit LaTeX source`);
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
  const listRe = /\\begin\{(itemize|enumerate)\}(\s*\[[^\]]*\])?([\s\S]*?)\\end\{\1\}/g;
  listRe.lastIndex = bodyStart;
  const openListRanges: Range[] = [];
  const withinOpenList = (pos: number) => openListRanges.some((r) => pos >= r.from && pos < r.to);
  let lm: RegExpExecArray | null;
  while ((lm = listRe.exec(text)) && lm.index < scanEnd) {
    const ordered = lm[1] === "enumerate";
    const bodyFrom = lm.index + `\\begin{${lm[1]}}`.length + (lm[2]?.length ?? 0);
    const bodyTo = lm.index + lm[0].length - `\\end{${lm[1]}}`.length;
    const listTo = lm.index + lm[0].length;
    // Keep the begin/end declaration visual when the caret is on it. The list
    // body alone is the editable region; treating the declaration as part of
    // that region made a click on `\\begin{itemize}` leak raw syntax while the
    // individual item widgets remained rendered.
    const listIsEditing = state.selection.ranges.some((range) =>
      range.from < bodyTo && range.to > bodyFrom,
    );
    if (listIsEditing) {
      openListRanges.push({ from: lm.index, to: listTo });
    }
    // Hide the \begin / \end environment lines themselves.
    if (!listIsEditing) {
      hide(lm.index, bodyFrom);
      hide(bodyTo, listTo);
    }
    const listSpacingRe = /\\setlength\s*(?:\{\\itemsep\}|\\itemsep)\s*\{[^}]*\}/g;
    listSpacingRe.lastIndex = bodyFrom;
    let spacing: RegExpExecArray | null;
    while ((spacing = listSpacingRe.exec(text)) && spacing.index < bodyTo) {
      if (!listIsEditing && !selectionTouches(state, spacing.index, spacing.index + spacing[0].length)) {
        hide(spacing.index, spacing.index + spacing[0].length);
      }
    }

    const itemRe = /\\item(?![A-Za-z])(?:\s*\[([^\]]*)\])?/g;
    itemRe.lastIndex = bodyFrom;
    const items: Array<{ match: RegExpExecArray; from: number; to: number; lineFrom: number }> = [];
    let it: RegExpExecArray | null;
    while ((it = itemRe.exec(text)) && it.index < bodyTo) {
      const line = state.doc.lineAt(it.index);
      items.push({ match: it, from: it.index, to: it.index + it[0].length, lineFrom: line.from });
    }
    let n = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      n += 1;
      const itemRangeEnd = items[index + 1]?.from ?? bodyTo;
      marks.push({ from: item.lineFrom, to: item.lineFrom, value: listItemLine });
      if (!listIsEditing && !selectionTouches(state, item.from, itemRangeEnd)) {
        const customMarker = item.match[1]?.trim();
        const marker = customMarker || (ordered ? enumitemLabel(lm[2], n) || `${n}.` : "•");
        hide(item.from, item.to, Decoration.replace({ widget: new ItemMarkerWidget(marker) }));
      }
    }
  }

  // --- Standalone structural commands ---
  // \maketitle → centered title block built from the preamble metadata.
  const makeTitle = text.indexOf("\\maketitle");
  if (makeTitle >= 0 && !selectionTouches(state, makeTitle, makeTitle + "\\maketitle".length)) {
    const readArgRange = (cmd: string): { text: string; range: Range | null } => {
      const at = text.search(new RegExp(`\\\\${cmd}\\s*\\{`));
      if (at < 0) return { text: "", range: null };
      const brace = text.indexOf("{", at);
      const end = matchBrace(text, brace);
      if (end < 0) return { text: "", range: null };
      return { text: stripMarkup(text.slice(brace + 1, end - 1)), range: { from: brace + 1, to: end - 1 } };
    };
    const titleArg = readArgRange("title");
    const authorArg = readArgRange("author");
    const dateArg = readArgRange("date");
    const date = /\\today/.test(dateArg.text) ? "" : dateArg.text;
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
  const standaloneRe = /\\(tableofcontents|titlepage|newpage|clearpage|bigskip|medskip|smallskip|noindent|centering|maketitle)\b|\\(?:vspace|hspace)\*?\s*\{[^}]*\}|\\(?:thispagestyle|pagestyle)\s*\{[^}]*\}|\\end\{document\}/g;
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

  // --- Abstract environment → "Abstract" label + italic indented body ---
  // Without this it fell through to the generic "unknown environment" pass
  // below, which just hides the markers with no label — the abstract read as
  // an unstyled paragraph indistinguishable from the rest of the body.
  const abstractRe = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/g;
  abstractRe.lastIndex = bodyStart;
  const abstractBeginLen = "\\begin{abstract}".length;
  const abstractEndLen = "\\end{abstract}".length;
  const abstractRanges: Range[] = [];
  const withinAbstract = (pos: number) => abstractRanges.some((r) => pos >= r.from && pos < r.to);
  let ab: RegExpExecArray | null;
  while ((ab = abstractRe.exec(text)) && ab.index < scanEnd) {
    const innerFrom = ab.index + abstractBeginLen;
    const innerTo = ab.index + ab[0].length - abstractEndLen;
    // Tracked unconditionally (reveal or not) so the generic unknown-environment
    // fallback below — which processes every `\begin{}`/`\end{}` in the document
    // one marker at a time — knows to leave both markers alone here. Without
    // this, revealing (caret inside) still let that fallback independently
    // re-hide whichever marker the caret *wasn't* literally touching (e.g. the
    // caret sits on `\begin{abstract}`, so only that marker's own selection
    // check passes there; `\end{abstract}` has no caret on it and gets hidden
    // anyway) — an inconsistent half-reveal. Math avoids the same trap via its
    // own `withinMath` exclusion; this mirrors that.
    abstractRanges.push({ from: ab.index, to: ab.index + ab[0].length });
    // Touching *any part* of the environment reveals it whole, like math/lists.
    if (selectionTouches(state, ab.index, ab.index + ab[0].length)) {
      continue;
    }
    hide(ab.index, innerFrom, Decoration.replace({ widget: new SectionLabelWidget("Abstract") }));
    hide(innerTo, ab.index + ab[0].length);
    // `innerFrom` sits exactly at the end of the `\begin{abstract}` line (right
    // before its own newline) when the marker is alone on its line — `lineAt`
    // resolves a position at a line's `to` to that same line, so starting the
    // scan there would (mis)style the marker's own line as body. Skip past it;
    // if the marker instead has body text trailing it on the same line,
    // `innerFrom` is already mid-line and this is a no-op.
    let pos = Math.max(innerFrom, state.doc.lineAt(ab.index).to + 1);
    while (pos < innerTo) {
      const line = state.doc.lineAt(pos);
      marks.push({ from: line.from, to: line.from, value: abstractLine });
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

  // Beamer layout commands affect the compiled arrangement but carry no
  // readable content in Visual mode. Keep them in the source of truth and
  // reveal them on caret, while folding the idle visual representation.
  const beamerLayoutRe = /\\column\s*\{[^}\n]*\}|\\(?:pause|vfill|hfill)\b/g;
  beamerLayoutRe.lastIndex = bodyStart;
  let bl: RegExpExecArray | null;
  while ((bl = beamerLayoutRe.exec(text)) && bl.index < scanEnd) {
    if (withinMath(bl.index) || withinOpenFloat(bl.index)) continue;
    if (selectionTouches(state, bl.index, bl.index + bl[0].length)) continue;
    hide(bl.index, bl.index + bl[0].length);
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
    if (em[2] === "frame") continue; // Beamer frame chrome is handled above
    if (withinMath(em.index)) continue; // selected math envs must reveal complete source
    if (withinOpenFloat(em.index)) continue; // open float is fully raw
    if (withinOpenList(em.index)) continue; // open list is fully raw while editing
    if (withinAbstract(em.index)) continue; // abstract handles both its own markers above
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
