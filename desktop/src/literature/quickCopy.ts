import {
  formatBibliography,
  formatCitation,
  readCitationStyle,
  type CitationStyleId,
} from "./citationEngine";
import type { LiteratureLibraryCreator, LiteraturePaper } from "./literatureTypes";

/**
 * Zotero's Quick Copy: one keystroke turns the selected items into a formatted
 * citation on the clipboard, and dragging them into any editor drops the same
 * text. The value is entirely in it being available *without* opening the item
 * pane, so this module stays free of React and of the store.
 */
export type QuickCopyKind = "bibliography" | "citation";

export interface QuickCopyPayload {
  /** Plain text, one entry per line for a bibliography. */
  text: string;
  /** The same content with the container title italicised, for editors that
   * accept rich text (Word, Google Docs, most note apps). */
  html: string;
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Italicise the venue where it appears verbatim in the rendered entry. The
 * styles we ship all print the container title as written, so a literal match
 * is accurate; when it does not match, the entry is simply left plain rather
 * than guessed at. */
const emphasizeVenue = (entry: string, venue: string | undefined) => {
  const trimmed = venue?.trim();
  const escaped = escapeHtml(entry);
  if (!trimmed || trimmed.length < 3) return escaped;
  const target = escapeHtml(trimmed);
  const index = escaped.indexOf(target);
  if (index < 0) return escaped;
  return (
    escaped.slice(0, index)
    + "<i>" + target + "</i>"
    + escaped.slice(index + target.length)
  );
};

export interface QuickCopyItem {
  paper: LiteraturePaper;
  creators?: LiteratureLibraryCreator[];
}

/**
 * Render the selected items. `index` matters for numeric styles (IEEE,
 * Vancouver), so entries are numbered by their position in the selection
 * rather than all being `[1]`.
 */
export function buildQuickCopy(
  items: QuickCopyItem[],
  kind: QuickCopyKind = "bibliography",
  style: CitationStyleId = readCitationStyle(),
): QuickCopyPayload {
  const entries = items.map(({ paper, creators }, position) => (
    kind === "citation"
      ? formatCitation(paper, style, position + 1, creators)
      : formatBibliography(paper, style, position + 1, creators)
  ));
  if (kind === "citation") {
    // In-text citations belong on one line: pasting three of them should read
    // as one bracketed group, not as three paragraphs.
    const text = entries.join(" ");
    return { text, html: escapeHtml(text) };
  }
  return {
    text: entries.join("\n"),
    html: entries
      .map((entry, position) => `<p>${emphasizeVenue(entry, items[position].paper.venue)}</p>`)
      .join(""),
  };
}

/** Write both flavours so a rich-text target keeps the italics and a plain
 * one still gets sensible text. Falls back to plain text wherever the richer
 * clipboard API is unavailable. */
export async function writeQuickCopy(payload: QuickCopyPayload): Promise<boolean> {
  if (!payload.text.trim()) return false;
  try {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard && typeof ClipboardItem !== "undefined" && clipboard.write) {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([payload.text], { type: "text/plain" }),
          "text/html": new Blob([payload.html], { type: "text/html" }),
        }),
      ]);
      return true;
    }
    if (clipboard?.writeText) {
      await clipboard.writeText(payload.text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = payload.text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

/** Attach the citation flavours to a drag. The internal paper-id payload is
 * set separately and must keep working, so this only adds text flavours. */
export function attachQuickCopyToDrag(
  dataTransfer: DataTransfer,
  payload: QuickCopyPayload,
): void {
  if (!payload.text.trim()) return;
  try {
    dataTransfer.setData("text/plain", payload.text);
    dataTransfer.setData("text/html", payload.html);
  } catch {
    // A drag source that refuses extra flavours still carries the paper ids.
  }
}
