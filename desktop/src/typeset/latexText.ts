/**
 * Path and plain-text helpers shared by the Typeset surfaces and the outline
 * model. Split out of Typeset.tsx so the outline, the panels and the workbench
 * can each import what they need instead of one 8k-line module owning
 * everything.
 */

import { scanLatexStructure, type LatexStructureIndex } from "./latexStructure";

const IS_WINDOWS_RUNTIME = typeof navigator !== "undefined" && /win/i.test(navigator.userAgent);

export function basename(path: string | null | undefined): string {
  if (!path) return "";
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || path;
}

export function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function sameWorkspacePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (normalizedLeft === normalizedRight) return true;
  const absoluteWindowsPaths = /^[A-Za-z]:\//.test(normalizedLeft) && /^[A-Za-z]:\//.test(normalizedRight);
  return (IS_WINDOWS_RUNTIME || absoluteWindowsPaths)
    && normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase();
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

export function lineNumberForOffset(source: string, offset: number): number {
  const safeOffset = Math.min(Math.max(offset, 0), source.length);
  let line = 1;
  for (let index = 0; index < safeOffset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

export function stripInlineMarkup(text: string): string {
  return text
    .replace(/\$\^\{([^}]*)\}\$/g, (_, value: string) => `^${value.replace(/\*/g, "").replace(/,+/g, ",").replace(/,$/, "")}`)
    .replace(/\\(?:textbf|textit|emph|underline|texttt|textsc)\{([^}]+)\}/g, "$1")
    .replace(/\\textcolor\{[^}]+\}\{([^}]+)\}/g, "$1")
    .replace(/\\color\{[^}]+\}/g, " ")
    .replace(/\\(?:Huge|huge|LARGE|Large|large|normalsize|small|footnotesize|scriptsize|tiny|bfseries|itshape|slshape|scshape|mdseries|rmfamily|sffamily|ttfamily)\b/g, " ")
    .replace(/\\cite\{([^}]+)\}/g, "[$1]")
    .replace(/\\footnote\{([^}]+)\}/g, "[$1]")
    .replace(/\\ref\{([^}]+)\}/g, "sec. $1")
    .replace(/\\eqref\{([^}]+)\}/g, "($1)")
    .replace(/\\(?:quad|qquad|[hv]space\*?\{[^}]*\})/g, " ")
    .replace(/\\[,;:!]/g, " ")
    .replace(/\\([#$%&_{}])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .trim();
}

// Environments whose body is not prose and must not reach the word count.
const WORD_COUNT_SKIP_ENVIRONMENTS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*",
  "eqnarray", "eqnarray*", "split", "array", "matrix", "pmatrix", "bmatrix", "vmatrix",
  "verbatim", "lstlisting", "minted", "tikzpicture", "tabular", "tabularx", "comment",
]);

// Commands whose braced argument is machinery, not text: a \label or a \cite
// key would otherwise count as words.
const WORD_COUNT_DROP_ARG_COMMANDS = [
  // Headings are reported separately by texcount ("words in headers") and are
  // not part of the body figure, so their titles are dropped here too.
  "part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph",
  "title", "author", "date", "caption",
  "label", "ref", "eqref", "autoref", "cref", "Cref", "pageref", "nameref",
  "cite", "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear", "nocite",
  "parencite", "textcite", "autocite", "footcite",
  "input", "include", "includegraphics", "includesvg", "usepackage", "documentclass",
  "bibliography", "bibliographystyle", "addbibresource", "newcommand", "renewcommand",
  "setcounter", "setlength", "geometry", "hypersetup", "definecolor", "url", "verb",
].join("|");

const wordCountCache = new WeakMap<LatexStructureIndex, number>();

/**
 * An approximation of what `texcount` reports: body text only, with the
 * preamble, comments, math, and non-prose environments removed. CJK is counted
 * per character because Chinese text carries no spaces, which is how texcount
 * and Word both treat it.
 */
export function wordCountFor(source: string): number {
  const structure = scanLatexStructure(source);
  const cached = wordCountCache.get(structure);
  if (cached !== undefined) return cached;
  const marker = "\\begin{document}";
  const body = source.includes(marker) ? source.slice(source.indexOf(marker) + marker.length) : source;
  let text = body
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\\end\{document\}[\s\S]*$/, "");
  for (const environment of WORD_COUNT_SKIP_ENVIRONMENTS) {
    const escaped = environment.replace("*", "\\*");
    text = text.replace(new RegExp(`\\\\begin\\{${escaped}\\}[\\s\\S]*?\\\\end\\{${escaped}\\}`, "g"), " ");
  }
  text = text
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\$[^$\n]*\$/g, " ")
    .replace(new RegExp(`\\\\(?:${WORD_COUNT_DROP_ARG_COMMANDS})\\*?(?:\\[[^\\]]*\\])*\\s*\\{[^{}]*\\}`, "g"), " ")
    .replace(/\\begin\{[^{}]*\}(?:\[[^\]]*\])*(?:\{[^{}]*\})*/g, " ")
    .replace(/\\end\{[^{}]*\}/g, " ")
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])*/g, " ")
    .replace(/\\[^a-zA-Z]/g, " ")
    .replace(/[{}~^_&]/g, " ");

  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g)?.length ?? 0;
  const words = text
    .replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, " ")
    .split(/\s+/)
    .filter((token) => /[A-Za-z0-9\u00c0-\u024f]/.test(token))
    .length;
  const count = cjk + words;
  wordCountCache.set(structure, count);
  return count;
}
