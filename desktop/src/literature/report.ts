import { formatBibliography, readCitationStyle, type CitationStyleId } from "./citationEngine";
import type {
  LiteratureLibraryCreator,
  LiteraturePaper,
} from "./literatureTypes";

/**
 * Zotero's Report: a printable page for a set of items, with the notes, tags
 * and highlights the researcher accumulated. It is the artifact people hand to
 * a supervisor or bring to a reading group, so it has to survive being opened
 * on a machine that has never seen this app — everything is inlined and there
 * is no script.
 */
export interface ReportItem {
  paper: LiteraturePaper;
  creators?: LiteratureLibraryCreator[];
}

export interface ReportOptions {
  title: string;
  style?: CitationStyleId;
  generatedAt?: string;
  labels: {
    generated: string;
    itemCount: (count: number) => string;
    abstract: string;
    tags: string;
    notes: string;
    annotations: string;
    page: (page: number) => string;
    empty: string;
  };
}

const escapeHtml = (value: string) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Notes may already hold light markup from an import; only paragraph breaks
 * are preserved and everything else is escaped, because a report is opened as
 * a file and must not be able to execute anything. */
const paragraphs = (value: string) =>
  String(value ?? "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");

const REPORT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 32px 28px; max-width: 820px;
  font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: #17181c; background: #fff;
}
h1 { font-size: 20px; margin: 0 0 4px; }
.meta { color: #6b7280; font-size: 12px; margin-bottom: 24px; }
article { border-top: 1px solid #e5e7eb; padding: 18px 0; page-break-inside: avoid; }
h2 { font-size: 15px; margin: 0 0 4px; }
.byline { color: #4b5563; font-size: 12.5px; margin: 0 0 8px; }
.citation { font-size: 12.5px; color: #374151; margin: 0 0 10px; }
section { margin-top: 10px; }
section > h3 {
  font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  color: #6b7280; margin: 0 0 4px; font-weight: 600;
}
section p { margin: 0 0 6px; }
.tags { display: flex; flex-wrap: wrap; gap: 5px; }
.tag { border: 1px solid #d1d5db; border-radius: 4px; padding: 1px 6px; font-size: 11.5px; }
.note { border-left: 2px solid #d1d5db; padding-left: 10px; margin-bottom: 8px; }
.note > h4 { font-size: 12.5px; margin: 0 0 3px; }
.quote { border-left: 2px solid #f0b429; padding-left: 10px; margin-bottom: 8px; }
.quote .where { color: #6b7280; font-size: 11.5px; }
.empty { color: #6b7280; }
@media print { body { padding: 0; } article { border-color: #ccc; } }
`;

/** Render the report as one self-contained HTML document. */
export function buildLiteratureReport(items: ReportItem[], options: ReportOptions): string {
  const style = options.style ?? readCitationStyle();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const body = items.length === 0
    ? `<p class="empty">${escapeHtml(options.labels.empty)}</p>`
    : items
      .map(({ paper, creators }, position) => {
        const byline = [
          paper.authors.join(", "),
          paper.year ? String(paper.year) : "",
          paper.venue,
        ].filter(Boolean).map(escapeHtml).join(" · ");
        const tags = paper.tags ?? [];
        const notes = paper.notes ?? [];
        const annotations = (paper.pdfAnnotations ?? []).filter(
          (annotation) => (annotation.quote ?? "").trim() || (annotation.note ?? "").trim(),
        );
        const sections = [
          paper.abstract?.trim()
            ? `<section><h3>${escapeHtml(options.labels.abstract)}</h3>${paragraphs(paper.abstract)}</section>`
            : "",
          tags.length > 0
            ? `<section><h3>${escapeHtml(options.labels.tags)}</h3><div class="tags">${
              tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")
            }</div></section>`
            : "",
          notes.length > 0
            ? `<section><h3>${escapeHtml(options.labels.notes)}</h3>${
              notes.map((note) => `<div class="note">${
                note.title?.trim() ? `<h4>${escapeHtml(note.title)}</h4>` : ""
              }${paragraphs(note.content)}</div>`).join("")
            }</section>`
            : "",
          annotations.length > 0
            ? `<section><h3>${escapeHtml(options.labels.annotations)}</h3>${
              annotations.map((annotation) => `<div class="quote">${
                (annotation.quote ?? "").trim() ? paragraphs(annotation.quote) : ""
              }${
                (annotation.note ?? "").trim() ? paragraphs(annotation.note) : ""
              }<div class="where">${escapeHtml(options.labels.page(annotation.page))}</div></div>`).join("")
            }</section>`
            : "",
        ].filter(Boolean).join("");
        return `<article>
  <h2>${escapeHtml(paper.title)}</h2>
  ${byline ? `<p class="byline">${byline}</p>` : ""}
  <p class="citation">${escapeHtml(formatBibliography(paper, style, position + 1, creators))}</p>
  ${sections}
</article>`;
      })
      .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<h1>${escapeHtml(options.title)}</h1>
<p class="meta">${escapeHtml(options.labels.itemCount(items.length))} · ${
    escapeHtml(options.labels.generated)
  } ${escapeHtml(generatedAt)}</p>
${body}
</body>
</html>
`;
}
