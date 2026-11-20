const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"]';
const EDITABLE = 'input, textarea, [contenteditable="true"], .cm-editor';
const COPY_UI = 'button, input, textarea, select, script, style, [hidden], [aria-hidden="true"], .md-code-header, .md-code-gutter';

function elementAt(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

function formulaAt(node: Node): Element | null {
  const formula = elementAt(node)?.closest(".katex");
  if (!formula?.querySelector(TEX_ANNOTATION)) return null;
  return formula.closest(".katex-display") ?? formula;
}

function childrenText(node: Node): string {
  return Array.from(node.childNodes).map(plainText).join("");
}

/** Keep the block and table boundaries that textContent would concatenate. */
function plainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    // Markdown inserts whitespace between block elements; layout supplies the
    // corresponding line breaks below. Preserve literal whitespace in <pre>.
    return /^\s*\n\s*$/.test(text) ? "" : text;
  }
  if (!(node instanceof Element)) return childrenText(node);
  if (node.tagName === "BR") return "\n";
  if (node.tagName === "PRE" || node.classList.contains("md-code-content")) {
    return `${node.textContent ?? ""}\n\n`;
  }
  const text = childrenText(node);
  switch (node.tagName) {
    case "TD":
    case "TH": return `${text.replace(/\n+$/, "")}\t`;
    case "TR": return `${text.replace(/\t$/, "")}\n`;
    case "P":
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": return `${text}\n\n`;
    case "DIV": return text.endsWith("\n") ? text : `${text}\n\n`;
    case "LI":
    case "UL":
    case "OL":
    case "TABLE":
    case "BLOCKQUOTE": return text.endsWith("\n") ? text : `${text}\n`;
    default: return text;
  }
}

function copyMathAsLatex(event: ClipboardEvent, document: Document): void {
  if (event.defaultPrevented || !event.clipboardData
    || elementAt(event.target as Node | null)?.closest(EDITABLE)
    || document.activeElement?.matches("input, textarea")) return;

  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0
    || elementAt(selection.anchorNode)?.closest(EDITABLE)
    || elementAt(selection.focusNode)?.closest(EDITABLE)) return;

  const fragment = document.createDocumentFragment();
  for (let index = 0; index < selection.rangeCount; index += 1) {
    // Expanding a clone keeps the visible selection intact, including when a
    // drag begins or ends on just one glyph of a larger formula.
    const range = selection.getRangeAt(index).cloneRange();
    const start = formulaAt(range.startContainer);
    const end = formulaAt(range.endContainer);
    if (start) range.setStartBefore(start);
    if (end) range.setEndAfter(end);
    if (index > 0) fragment.append(document.createTextNode("\n\n"));
    fragment.append(range.cloneContents());
  }

  let replaced = false;
  for (const formula of fragment.querySelectorAll(".katex")) {
    const source = formula.querySelector(TEX_ANNOTATION)?.textContent;
    if (source === undefined || source === null) continue;
    const display = formula.closest(".katex-display");
    const latex = display ? `$$\n${source}\n$$` : `$${source}$`;
    const replacement = document.createElement(display ? "div" : "span");
    replacement.setAttribute("data-somniq-math", display ? "display" : "inline");
    replacement.textContent = latex;
    (display ?? formula).replaceWith(replacement);
    replaced = true;
  }
  if (!replaced) return;

  // Do not copy toolbar labels, code line numbers or hidden presentation text.
  fragment.querySelectorAll(COPY_UI).forEach((element) => element.remove());
  const text = plainText(fragment).replace(/^\n+|\n+$/g, "");
  const html = document.createElement("div");
  html.append(fragment);
  if (selection.rangeCount === 1) {
    // cloneContents omits the common ancestor. Bare <tr>/<td> fragments lose
    // their cells when an HTML paste target parses them outside a table.
    let ancestor = elementAt(selection.getRangeAt(0).commonAncestorContainer);
    if (ancestor?.closest("table")) {
      while (ancestor) {
        if (/^(TABLE|THEAD|TBODY|TFOOT|TR|TD|TH)$/.test(ancestor.tagName)) {
          const wrapper = ancestor.cloneNode(false) as Element;
          wrapper.append(...Array.from(html.childNodes));
          html.append(wrapper);
        }
        if (ancestor.tagName === "TABLE") break;
        ancestor = ancestor.parentElement;
      }
    }
  }
  event.clipboardData.setData("text/plain", text);
  event.clipboardData.setData("text/html", html.innerHTML);
  event.preventDefault();
}

/** Shared by Chat, paper reading and other rendered KaTeX surfaces. */
export function installMathClipboard(document: Document = globalThis.document): () => void {
  const onCopy = (event: ClipboardEvent) => copyMathAsLatex(event, document);
  document.addEventListener("copy", onCopy);
  return () => document.removeEventListener("copy", onCopy);
}
