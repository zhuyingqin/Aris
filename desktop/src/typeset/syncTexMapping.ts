/**
 * Geometry and line-mapping helpers that make PDF -> source (SyncTeX inverse
 * search) land on the right place.
 *
 * The three things this module exists to get right, measured against TeX Live
 * 2025's own `synctex` binary on a `pdflatex -synctex=1` build:
 *
 *  1. **The point.** `synctex edit -o page:x:y:file` wants big points measured
 *     from the *page* top-left, before rotation. `PageViewport` already knows
 *     how to undo its own scale/rotation, so the click goes through
 *     `convertToPdfPoint` rather than a bare `/ zoom`, and the page box
 *     converts PDF user space (bottom-left origin) to SyncTeX's top-left one.
 *
 *  2. **The text box.** A text run's clickable box has to cover the *ink*, not
 *     the em square. `textContent.styles[fontName]` reports ascent/descent as
 *     fractions of the font size (0.694 / -0.194 for Computer Modern), and
 *     `(ascent - descent) * fontSize` reproduces the height SyncTeX records for
 *     the same line to within 0.01bp — 8.847 vs `H:8.855677` on a 9.9626pt
 *     line. Sizing the box off `item.height` instead puts its top 3bp *above*
 *     the ink, inside the previous line's SyncTeX box, so a click near the top
 *     of a word resolves to the previous source line.
 *
 *  3. **The line, when the buffer moved on.** SyncTeX line numbers describe the
 *     source as it was compiled. Rather than refusing to navigate (or guessing
 *     with a full-text search) once the buffer is dirty, remap the recorded
 *     line through the edit that happened since — exact whenever the edit is
 *     localised, which is the normal case while writing.
 */

/** The `PageViewport` surface this module needs; keeps the helpers testable. */
export interface SyncTexViewportLike {
  convertToPdfPoint(x: number, y: number): number[];
}

export interface SyncTexPoint {
  x: number;
  y: number;
}

/** pdf.js reports `descent` as a negative fraction of the font size. */
export interface PdfTextStyleLike {
  ascent?: number;
  descent?: number;
}

export interface PdfTextItemLike {
  transform?: unknown;
  width?: unknown;
  height?: unknown;
  fontName?: unknown;
}

export interface PdfTextRunBox {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
}

/**
 * pdf.js' own text layer defaults, used when a font ships no metrics. They are
 * deliberately close to the Computer Modern values a LaTeX PDF actually reports.
 */
const DEFAULT_ASCENT = 0.75;
const DEFAULT_DESCENT = 0.25;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Convert a click inside a rendered page to the point SyncTeX expects: big
 * points, origin at the page's top-left corner.
 *
 * `offsetX`/`offsetY` are CSS pixels from the rendered page's top-left corner.
 * `pageBox` is `PDFPageProxy.view` (`[x0, y0, x1, y1]` in PDF user space) — a
 * page whose box does not start at the origin (a cropped PDF) would otherwise
 * shift every query by the crop offset.
 */
export function syncTexPointFromPageOffset(
  viewport: SyncTexViewportLike,
  pageBox: number[] | undefined,
  offsetX: number,
  offsetY: number,
): SyncTexPoint {
  const [pdfX, pdfY] = viewport.convertToPdfPoint(offsetX, offsetY);
  const left = finiteOr(pageBox?.[0], 0);
  const top = finiteOr(pageBox?.[3], 0);
  return { x: pdfX - left, y: top - pdfY };
}

export function multiplyPdfTransform(left: number[], right: number[]): number[] {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

/**
 * The ink box of one pdf.js text item, in CSS pixels relative to the rendered
 * page. `matrix[5]` is the run's baseline, so the box runs from one ascent
 * above it to one descent below — the same span SyncTeX records for the line.
 */
export function pdfTextRunBox(
  item: PdfTextItemLike,
  style: PdfTextStyleLike | undefined,
  viewportTransform: number[],
  zoom: number,
  textLength: number,
): PdfTextRunBox | null {
  const transform = Array.isArray(item.transform) ? (item.transform as number[]) : null;
  if (!transform || transform.length < 6) return null;
  const matrix = multiplyPdfTransform(viewportTransform, transform);
  const fontSize = Math.hypot(matrix[2], matrix[3]);
  if (!Number.isFinite(fontSize) || fontSize <= 0) return null;
  const ascent = clamp(finiteOr(style?.ascent, DEFAULT_ASCENT), 0.05, 1.5);
  // A font that declares no descent still needs a box that reaches below the
  // baseline, otherwise the bottom of every glyph is unclickable.
  const descent = clamp(Math.abs(finiteOr(style?.descent, -DEFAULT_DESCENT)), 0.02, 0.75);
  const width = Math.max(
    1,
    finiteOr(item.width, textLength * (fontSize / zoom) * 0.45) * zoom,
  );
  return {
    left: matrix[4],
    top: matrix[5] - ascent * fontSize,
    width,
    height: (ascent + descent) * fontSize,
    fontSize,
  };
}

/**
 * Where a click at `offsetX` falls inside a run, as a 0..1 fraction of its
 * width. Used to pick the clicked word out of a run that pdf.js merged across
 * several source lines.
 */
export function runTextRatio(run: { left: number; width: number }, offsetX: number): number {
  if (!(run.width > 0)) return 0;
  return clamp((offsetX - run.left) / run.width, 0, 1);
}

/** The word covering `ratio` of `text`, or "" when there is nothing wordlike. */
export function wordAtRatio(text: string, ratio: number): string {
  if (!text) return "";
  const index = clamp(Math.round(ratio * text.length), 0, Math.max(0, text.length - 1));
  const isWord = (character: string) => /[\p{L}\p{N}]/u.test(character);
  // A click between words snaps to the nearer one rather than giving up.
  let cursor = index;
  if (!isWord(text[cursor] ?? "")) {
    let back = cursor;
    while (back >= 0 && !isWord(text[back] ?? "")) back -= 1;
    let forward = cursor;
    while (forward < text.length && !isWord(text[forward] ?? "")) forward += 1;
    const backDistance = back >= 0 ? cursor - back : Number.POSITIVE_INFINITY;
    const forwardDistance = forward < text.length ? forward - cursor : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(backDistance) && !Number.isFinite(forwardDistance)) return "";
    cursor = backDistance <= forwardDistance ? back : forward;
  }
  let start = cursor;
  while (start > 0 && isWord(text[start - 1] ?? "")) start -= 1;
  let end = cursor;
  while (end < text.length - 1 && isWord(text[end + 1] ?? "")) end += 1;
  return text.slice(start, end + 1);
}

/**
 * Where `word` sits inside the run it was picked from, as a 0..1 fraction —
 * a faithful stand-in for the click position, since the word *is* what was
 * under the pointer. Used to break ties when the word repeats on the source
 * line.
 */
export function wordRatioIn(text: string, word: string): number {
  if (!text || !word) return 0;
  const at = text.toLowerCase().indexOf(word.toLowerCase());
  return at < 0 ? 0 : clamp(at / text.length, 0, 1);
}

export interface SourceColumnMatch {
  column: number;
  length: number;
}

/**
 * TeX never records a real column — every `synctex edit` result comes back as
 * `Column:-1`, so an unrefined jump parks the cursor at column 0. When a whole
 * paragraph lives on one source line that is hundreds of characters from the
 * word that was clicked, so locate the word inside the resolved line instead.
 *
 * `ratio` biases the choice when the word repeats on the line.
 */
export function refineSourceColumn(
  lineText: string,
  word: string,
  ratio = 0,
): SourceColumnMatch | null {
  if (!word || !lineText) return null;
  const haystack = lineText.toLowerCase();
  const needle = word.toLowerCase();
  const target = clamp(ratio, 0, 1) * lineText.length;
  let best: SourceColumnMatch | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    // Prefer a standalone word so "in" cannot claim the "in" inside "\begin".
    const before = haystack[at - 1] ?? " ";
    const after = haystack[at + needle.length] ?? " ";
    const standalone = !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
    const distance = Math.abs(at - target) + (standalone ? 0 : lineText.length);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { column: at, length: word.length };
    }
  }
  return best;
}

/**
 * Translate a line number recorded against `compiled` into the matching line of
 * `current`.
 *
 * Anchored on the unchanged head and tail of the file, which makes the answer
 * exact for any edit confined to one region — the case that matters, because
 * the alternative is refusing to navigate the moment the buffer is dirty. Lines
 * inside the edited region fall back to matching the recorded line's own text,
 * then to clamping into the region.
 */
export function remapCompiledLine(compiled: string, current: string, line: number): number {
  if (compiled === current) return line;
  const before = compiled.split("\n");
  const after = current.split("\n");
  if (before.length === 0 || after.length === 0) return line;
  const index = clamp(line - 1, 0, before.length - 1);

  const shared = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shared && before[prefix] === after[prefix]) prefix += 1;
  if (index < prefix) return index + 1;

  let suffix = 0;
  while (
    suffix < shared - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (index >= before.length - suffix) return index + (after.length - before.length) + 1;

  const regionStart = prefix;
  const regionEnd = Math.max(prefix, after.length - suffix);
  const recorded = before[index]?.trim() ?? "";
  if (recorded) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let at = regionStart; at < regionEnd; at += 1) {
      if (after[at].trim() !== recorded) continue;
      const distance = Math.abs(at - index);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = at;
      }
    }
    if (best >= 0) return best + 1;
  }
  return clamp(index, regionStart, Math.max(regionStart, regionEnd - 1)) + 1;
}
