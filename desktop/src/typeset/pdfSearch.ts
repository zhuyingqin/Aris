/**
 * Find-in-PDF for the compiled preview.
 *
 * pdf.js hands back a page's text as a list of items — usually a word or a run
 * of words, not a line — so a phrase like "echo state network" routinely spans
 * several of them. The index therefore joins a page's items into one string and
 * remembers where each item landed in it, which lets a match be found across
 * item boundaries and still be highlighted on the exact items it covers.
 *
 * Pure functions plus one async page walk; no React, no DOM.
 */

export type PdfTextItemSpan = {
  /** Offset of this item's text inside the page string. */
  from: number;
  to: number;
  /** Index of the item in pdf.js's own `textContent.items`, which is what the
   * rendered text layer keys its boxes by. */
  itemIndex: number;
};

export type PdfPageText = {
  page: number;
  text: string;
  spans: PdfTextItemSpan[];
};

export type PdfSearchMatch = {
  page: number;
  from: number;
  to: number;
  /** The items this match covers, for the page's highlight overlay. */
  itemIndices: number[];
  /** A short excerpt with the match in context, for the results list. */
  snippet: string;
};

/** Enough to be useful, bounded so a 600-page thesis cannot lock the UI. */
export const PDF_SEARCH_MATCH_LIMIT = 500;
const SNIPPET_RADIUS = 32;

type TextContentLike = { items?: unknown[] };

/**
 * Flattens one page's `textContent` into a searchable string. Items are joined
 * with a space so two adjacent items never fuse into a word that is not there;
 * `hasEOL` items end a line for the same reason.
 */
export function pageTextFromContent(page: number, textContent: unknown): PdfPageText {
  const items = Array.isArray((textContent as TextContentLike | null)?.items)
    ? (textContent as TextContentLike).items as unknown[]
    : [];
  const spans: PdfTextItemSpan[] = [];
  let text = "";
  items.forEach((item, itemIndex) => {
    if (!item || typeof item !== "object") return;
    const value = (item as { str?: unknown }).str;
    if (typeof value !== "string" || value.length === 0) return;
    if (text.length > 0) text += " ";
    const from = text.length;
    text += value;
    spans.push({ from, to: text.length, itemIndex });
    if ((item as { hasEOL?: unknown }).hasEOL === true) text += "\n";
  });
  return { page, text, spans };
}

/** Case- and whitespace-insensitive: a PDF line break in the middle of a phrase
 * must not stop the phrase from being found. */
function normalize(value: string): string {
  return value.replace(/\s+/g, " ").toLocaleLowerCase();
}

/**
 * Matches of `query` inside one page. Offsets are into a whitespace-normalised
 * copy, then mapped back onto the original string so the highlight lands on the
 * right items.
 */
export function findMatchesInPage(pageText: PdfPageText, query: string, limit = PDF_SEARCH_MATCH_LIMIT): PdfSearchMatch[] {
  const needle = normalize(query).trim();
  if (!needle) return [];

  // Build the normalised string alongside a map back to original offsets, so a
  // run of whitespace collapsing to one space stays addressable.
  let haystack = "";
  const originalAt: number[] = [];
  let pendingSpace = false;
  for (let index = 0; index < pageText.text.length; index += 1) {
    const char = pageText.text[index];
    if (/\s/.test(char)) {
      pendingSpace = haystack.length > 0;
      continue;
    }
    if (pendingSpace) {
      haystack += " ";
      originalAt.push(index);
      pendingSpace = false;
    }
    haystack += char.toLocaleLowerCase();
    originalAt.push(index);
  }

  const matches: PdfSearchMatch[] = [];
  let cursor = 0;
  while (matches.length < limit) {
    const at = haystack.indexOf(needle, cursor);
    if (at < 0) break;
    const from = originalAt[at] ?? 0;
    const to = (originalAt[at + needle.length - 1] ?? from) + 1;
    matches.push({
      page: pageText.page,
      from,
      to,
      itemIndices: pageText.spans.filter((span) => span.from < to && span.to > from).map((span) => span.itemIndex),
      snippet: snippetAround(pageText.text, from, to),
    });
    cursor = at + Math.max(1, needle.length);
  }
  return matches;
}

function snippetAround(text: string, from: number, to: number): string {
  const start = Math.max(0, from - SNIPPET_RADIUS);
  const end = Math.min(text.length, to + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}
