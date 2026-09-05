import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

function escapeLatexText(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([{}$&#_%])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/\u00a0/g, "~");
}

function childElements(node: Element, tagName: string): Element[] {
  return Array.from(node.children).filter((child) => child.tagName.toLowerCase() === tagName);
}

function renderChildren(node: Node): string {
  return Array.from(node.childNodes).map(renderNode).join("");
}

function renderList(element: Element, ordered: boolean): string {
  const environment = ordered ? "enumerate" : "itemize";
  const items = childElements(element, "li").map((item) => {
    const content = Array.from(item.childNodes).map(renderNode).join("").trim();
    return `\\item ${content}`.trimEnd();
  });
  return `\n\\begin{${environment}}\n${items.join("\n")}\n\\end{${environment}}\n`;
}

function renderTable(element: Element): string {
  const rows = Array.from(element.querySelectorAll("tr"));
  const rendered = rows.map((row) => Array.from(row.children)
    .filter((cell) => /^(?:td|th)$/i.test(cell.tagName))
    .map((cell) => {
      const span = Math.max(1, Number.parseInt(cell.getAttribute("colspan") ?? "1", 10) || 1);
      const raw = renderChildren(cell).trim();
      const content = cell.tagName.toLowerCase() === "th" ? `\\textbf{${raw}}` : raw;
      return { content, span };
    }));
  const columnCount = Math.max(0, ...rendered.map((row) => row.reduce((sum, cell) => sum + cell.span, 0)));
  if (columnCount === 0) return "";
  const body = rendered.map((row) => {
    const cells = row.map((cell) => cell.span > 1
      ? `\\multicolumn{${cell.span}}{l}{${cell.content}}`
      : cell.content);
    return `${cells.join(" & ")} \\\\`;
  }).join("\n\\hline\n");
  const caption = element.querySelector(":scope > caption")?.textContent?.trim();
  const tabular = `\\begin{tabular}{|${"l|".repeat(columnCount)}}\n\\hline\n${body}\n\\hline\n\\end{tabular}`;
  if (!caption) return `\n${tabular}\n`;
  return `\n\\begin{table}[htbp]\n\\centering\n${tabular}\n\\caption{${escapeLatexText(caption)}}\n\\end{table}\n`;
}

function renderNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeLatexText(node.textContent ?? "");
  if (!(node instanceof Element)) return "";
  const tag = node.tagName.toLowerCase();
  const content = () => renderChildren(node);
  switch (tag) {
    case "br": return "\\\\\n";
    case "b":
    case "strong": return `\\textbf{${content()}}`;
    case "i":
    case "em": return `\\emph{${content()}}`;
    case "u": return `\\underline{${content()}}`;
    case "s":
    case "strike":
    case "del": return `\\sout{${content()}}`;
    case "code": return `\\texttt{${content()}}`;
    case "pre": {
      const raw = (node.textContent ?? "").replace(/\r\n?/g, "\n").trimEnd();
      return `\n\\begin{verbatim}\n${raw}\n\\end{verbatim}\n`;
    }
    case "a": {
      const href = node.getAttribute("href")?.trim();
      return href ? `\\href{${escapeLatexText(href)}}{${content()}}` : content();
    }
    case "ul": return renderList(node, false);
    case "ol": return renderList(node, true);
    case "table": return renderTable(node);
    case "blockquote": return `\n\\begin{quote}\n${content().trim()}\n\\end{quote}\n`;
    case "h1": return `\n\\section{${content().trim()}}\n`;
    case "h2": return `\n\\subsection{${content().trim()}}\n`;
    case "h3":
    case "h4":
    case "h5":
    case "h6": return `\n\\subsubsection{${content().trim()}}\n`;
    case "p":
    case "div": return `${content().trim()}\n\n`;
    case "img": return escapeLatexText(node.getAttribute("alt")?.trim() ?? "");
    case "script":
    case "style":
    case "meta": return "";
    default: return content();
  }
}

/** Converts formatted clipboard HTML to source-preserving LaTeX. */
export function htmlClipboardToLatex(html: string): string {
  if (!html.trim() || typeof DOMParser === "undefined") return "";
  const document = new DOMParser().parseFromString(html, "text/html");
  return renderChildren(document.body)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Visual-only rich paste; plain-text and file clipboard payloads fall through. */
export const latexHtmlPaste = Prec.highest(EditorView.domEventHandlers({
  paste(event, view) {
    const clipboard = event.clipboardData;
    if (!clipboard || clipboard.files.length > 0 || !clipboard.types.includes("text/html")) return false;
    const latex = htmlClipboardToLatex(clipboard.getData("text/html"));
    if (!latex) return false;
    event.preventDefault();
    const range = view.state.selection.main;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: latex },
      selection: { anchor: range.from + latex.length },
      scrollIntoView: true,
    });
    return true;
  },
}));

/**
 * Visual-only image paste. The caller persists the binary in the project and
 * returns a portable LaTeX snippet; the document is changed only after that
 * durable write succeeds.
 */
export function latexImagePaste(
  importImage: (file: File) => Promise<string | null>,
  onError?: (error: unknown) => void,
): Extension {
  return Prec.highest(EditorView.domEventHandlers({
    paste(event, view) {
      const image = Array.from(event.clipboardData?.files ?? [])
        .find((file) => file.type.startsWith("image/"));
      if (!image) return false;
      event.preventDefault();
      const initialDocument = view.state.doc.toString();
      const initialRange = view.state.selection.main;
      void importImage(image).then((latex) => {
        if (!latex) return;
        const range = view.state.doc.toString() === initialDocument
          ? initialRange
          : view.state.selection.main;
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: latex },
          selection: { anchor: range.from + latex.length },
          scrollIntoView: true,
        });
      }).catch((error) => onError?.(error));
      return true;
    },
  }));
}
