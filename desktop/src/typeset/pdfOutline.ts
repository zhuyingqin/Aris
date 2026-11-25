import type { PDFDocumentProxy } from "pdfjs-dist";

/** One PDF bookmark, with the page it opens already resolved. */
export interface PdfOutlineEntry {
  /** Stable across recompiles while the titles above it stay the same. */
  id: string;
  title: string;
  page: number | null;
  depth: number;
  bold: boolean;
  italic: boolean;
  children: PdfOutlineEntry[];
}

interface RawOutlineItem {
  title?: unknown;
  dest?: unknown;
  bold?: unknown;
  italic?: unknown;
  items?: unknown;
}

/** Enough for a thesis; a generated PDF with more is not navigated by bookmarks. */
const MAX_OUTLINE_ENTRIES = 3000;

export async function pdfPageForDestination(pdf: PDFDocumentProxy, destination: unknown): Promise<number | null> {
  let explicitDestination = destination;
  if (typeof explicitDestination === "string") {
    explicitDestination = await pdf.getDestination(explicitDestination);
  }
  if (!Array.isArray(explicitDestination) || !explicitDestination[0]) return null;
  const pageReference = explicitDestination[0];
  if (typeof pageReference === "number") return pageReference + 1;
  return (await pdf.getPageIndex(pageReference as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1;
}

/**
 * The PDF's bookmark tree (what hyperref writes from `\section` and friends),
 * each entry carrying its page so the panel can show and follow it.
 */
export async function pdfOutlineEntries(pdf: PDFDocumentProxy): Promise<PdfOutlineEntry[]> {
  const outline = (await pdf.getOutline()) as RawOutlineItem[] | null;
  if (!Array.isArray(outline) || outline.length === 0) return [];
  let budget = MAX_OUTLINE_ENTRIES;
  const walk = async (items: RawOutlineItem[], depth: number, parentId: string): Promise<PdfOutlineEntry[]> => {
    const entries: PdfOutlineEntry[] = [];
    for (const [index, item] of items.entries()) {
      if (budget <= 0) break;
      budget -= 1;
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const id = `${parentId}/${index}:${title}`;
      const page = await pdfPageForDestination(pdf, item.dest).catch(() => null);
      const children = Array.isArray(item.items) && item.items.length > 0
        ? await walk(item.items as RawOutlineItem[], depth + 1, id)
        : [];
      entries.push({
        id,
        title: title || "—",
        page,
        depth,
        bold: item.bold === true,
        italic: item.italic === true,
        children,
      });
    }
    return entries;
  };
  return walk(outline, 0, "");
}

/** Entries in reading order, each with the ids of the entries above it. */
export function flattenOutline(entries: PdfOutlineEntry[]): { entry: PdfOutlineEntry; ancestors: string[] }[] {
  const flat: { entry: PdfOutlineEntry; ancestors: string[] }[] = [];
  const visit = (items: PdfOutlineEntry[], ancestors: string[]) => {
    for (const entry of items) {
      flat.push({ entry, ancestors });
      visit(entry.children, [...ancestors, entry.id]);
    }
  };
  visit(entries, []);
  return flat;
}

/**
 * The bookmark the reader is in: the last one, in reading order, that starts
 * on or before the current page. Its ancestors are returned too, so a
 * collapsed chapter can show that the reader is somewhere inside it.
 */
export function activeOutlinePath(entries: PdfOutlineEntry[], currentPage: number): string[] {
  let active: { entry: PdfOutlineEntry; ancestors: string[] } | null = null;
  for (const item of flattenOutline(entries)) {
    if (item.entry.page == null || item.entry.page > currentPage) continue;
    if (!active || item.entry.page >= (active.entry.page ?? 0)) active = item;
  }
  return active ? [...active.ancestors, active.entry.id] : [];
}
