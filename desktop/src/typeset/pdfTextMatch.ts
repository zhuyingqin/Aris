// PDF-text <-> LaTeX-source matching, extracted from Typeset.tsx. This is the
// text fallback SyncTeX reverse search drops to when the PDF carries no
// synctex data, and it is pure string work — no React, no DOM, no canvas — so
// the CJK / ligature / short-string edge cases can be unit tested directly.

export type TextSearchMatch = {
  start: number;
  end: number;
};

export function normalizePdfText(text: string): string {
  return spellOutPdfLigatures(text).replace(/\s+/g, " ").trim();
}

/**
 * The same normalisation without the trim, for the text layer: a PDF text item
 * usually carries the space that follows it, and dropping it makes a selection
 * spanning two items copy as `developstheliterature`.
 */
export function pdfTextLayerText(text: string): string {
  return spellOutPdfLigatures(text).replace(/\s+/g, " ");
}

function spellOutPdfLigatures(text: string): string {
  return text
    .replace(/\uFB00/g, "ff")
    .replace(/\uFB01/g, "fi")
    .replace(/\uFB02/g, "fl")
    .replace(/\uFB03/g, "ffi")
    .replace(/\uFB04/g, "ffl");
}

function normalizeSearchText(text: string): string {
  return normalizePdfText(text).toLowerCase();
}

function latexLineWithoutComment(line: string): string {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "%" && line[index - 1] !== "\\") return line.slice(0, index);
  }
  return line;
}

function searchTerms(text: string): string[] {
  const normalized = normalizeSearchText(text);
  const words = normalized.split(/[^\p{L}\p{N}\\]+/u).filter((part) => part.length >= 2);
  if (words.length > 0) return Array.from(new Set(words));
  const compact = normalized.replace(/\s+/g, "");
  if (compact.length <= 3) return compact ? [compact] : [];
  const terms: string[] = [];
  for (let index = 0; index <= compact.length - 3; index += 3) {
    terms.push(compact.slice(index, index + 3));
  }
  return Array.from(new Set(terms));
}

function latexLineToSearchableText(line: string): string {
  let text = latexLineWithoutComment(line);
  for (let index = 0; index < 4; index += 1) {
    const next = text.replace(/\\[a-zA-Z*]+(?:\[[^\]]*\])?\{([^{}]*)\}/g, "$1");
    if (next === text) break;
    text = next;
  }
  return text
    .replace(/\\[a-zA-Z*]+/g, " ")
    .replace(/\\([#$%&_{}])/g, "$1")
    .replace(/[{}$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a PDF text item says enough about itself to be located in the source
 * by text alone — the guess made when SyncTeX cannot answer for a point.
 *
 * Four letters/digits is the floor. Anything shorter is dominated by its own
 * first arbitrary occurrence in the file, and a CJK PDF hands out exactly that:
 * the CJK fonts a TeX build subsets carry a few glyphs each, so pdf.js emits one
 * text item *per character*, and searching for one character jumps somewhere
 * unrelated with full confidence.
 */
const MIN_PDF_TEXT_SEARCH_CHARS = 4;

export function pdfTextCarriesEnoughSignal(pdfText: string): boolean {
  return normalizePdfText(pdfText).replace(/[^\p{L}\p{N}]/gu, "").length >= MIN_PDF_TEXT_SEARCH_CHARS;
}

export function findLatexOffsetForPdfText(source: string, pdfText: string, contextText = ""): TextSearchMatch | null {
  const target = normalizePdfText(pdfText);
  if (!target) return null;

  const lowerTarget = target.toLowerCase();
  const lowerContext = normalizeSearchText(contextText);
  const targetInContext = lowerContext.indexOf(lowerTarget);
  const beforeTerms = searchTerms(targetInContext >= 0 ? lowerContext.slice(0, targetInContext) : contextText).filter((term) => term !== lowerTarget);
  const afterTerms = searchTerms(targetInContext >= 0 ? lowerContext.slice(targetInContext + lowerTarget.length) : "").filter((term) => term !== lowerTarget);
  const lines = source.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  let best: (TextSearchMatch & { score: number }) | undefined;
  lines.forEach((line, lineIndex) => {
    const lineStart = lineStarts[lineIndex];
    const rawLine = normalizeSearchText(line);
    const plainLine = normalizeSearchText(latexLineToSearchableText(line));
    const lineMatchesTarget =
      rawLine.includes(lowerTarget) ||
      plainLine.includes(lowerTarget) ||
      (lowerTarget.length >= 4 && (
        // `lowerTarget.includes(plainLine)` covers a PDF run that spans more
        // than one source line, but it needs a floor: every string contains
        // "", so without one *every blank line in the document* matched any
        // target and the caller jumped to an arbitrary offset instead of
        // being told the text could not be located.
        (plainLine.length >= MIN_PDF_TEXT_SEARCH_CHARS && lowerTarget.includes(plainLine))
        || plainLine.includes(lowerTarget.slice(0, Math.min(8, lowerTarget.length)))
      ));
    if (!lineMatchesTarget) return;

    const beforeWindow = normalizeSearchText(lines.slice(Math.max(0, lineIndex - 2), lineIndex + 1).map(latexLineToSearchableText).join(" "));
    const afterWindow = normalizeSearchText(lines.slice(lineIndex, lineIndex + 3).map(latexLineToSearchableText).join(" "));
    const contextScore =
      beforeTerms.reduce((score, term) => score + (beforeWindow.includes(term) ? 20 : 0), 0) +
      afterTerms.reduce((score, term) => score + (afterWindow.includes(term) ? 20 : 0), 0);
    let score = contextScore + target.length;
    if (rawLine.includes(lowerTarget)) score += 40;
    if (plainLine.includes(lowerTarget)) score += 60;

    let start = line.toLowerCase().indexOf(lowerTarget);
    let length = target.length;
    if (start < 0) {
      const word = lowerTarget.split(/\W+/).find((part) => part.length >= 3);
      if (word) {
        start = line.toLowerCase().indexOf(word);
        length = word.length;
      }
    }
    if (start < 0) start = 0;
    const candidate = { start: lineStart + start, end: lineStart + start + length, score };
    if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.start < best.start)) {
      best = candidate;
    }
  });

  if (!best) return null;
  return { start: best.start, end: best.end };
}
