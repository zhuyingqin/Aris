import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * LaTeX autocomplete for the Typeset (and Lab `.tex`) editors. CodeMirror ships
 * no LaTeX language pack, so the stream highlighter contributes no completion
 * data at all — everything a writer sees here comes from this file: the command
 * and environment catalogue below, labels and citation keys harvested from the
 * open document, and the project-wide index the Typeset surface publishes for
 * files it has loaded but that aren't currently on screen.
 */

export interface LatexSymbol {
  /** The key as it appears inside the braces (`sec:intro`, `jaeger2004`). */
  name: string;
  /** Right-hand hint in the popup — the source file, or a paper title. */
  detail?: string;
}

export interface LatexProjectSymbols {
  labels: LatexSymbol[];
  citations: LatexSymbol[];
  /** Project-relative paths, for `\includegraphics{}` / `\input{}` / `.bib`. */
  files: LatexSymbol[];
}

const EMPTY_SYMBOLS: LatexProjectSymbols = { labels: [], citations: [], files: [] };

let projectSymbols: LatexProjectSymbols = EMPTY_SYMBOLS;

/**
 * Publishes the symbols of the LaTeX project currently open in Typeset. This is
 * module state rather than a facet because both editor surfaces (Code and
 * Visual) build their extensions once at mount and only ever show one project
 * at a time; the alternative is threading a compartment through two component
 * trees for data that is global by nature.
 */
export function setLatexProjectSymbols(next: LatexProjectSymbols): void {
  projectSymbols = next;
}

export function clearLatexProjectSymbols(): void {
  projectSymbols = EMPTY_SYMBOLS;
}

/** Read side of the registry — also what the reference lint checks against. */
export function latexProjectSymbols(): LatexProjectSymbols {
  return projectSymbols;
}

/** `[command, snippet, detail]`. A snippet of `null` inserts the bare command. */
type CommandEntry = readonly [string, string | null, string?];

const STRUCTURE_COMMANDS: CommandEntry[] = [
  ["\\documentclass", "\\documentclass{${article}}", "class"],
  ["\\usepackage", "\\usepackage{${package}}", "preamble"],
  ["\\title", "\\title{${}}", "front matter"],
  ["\\author", "\\author{${}}", "front matter"],
  ["\\date", "\\date{${}}", "front matter"],
  ["\\maketitle", null, "front matter"],
  ["\\tableofcontents", null, "front matter"],
  ["\\part", "\\part{${}}", "sectioning"],
  ["\\chapter", "\\chapter{${}}", "sectioning"],
  ["\\section", "\\section{${}}", "sectioning"],
  ["\\subsection", "\\subsection{${}}", "sectioning"],
  ["\\subsubsection", "\\subsubsection{${}}", "sectioning"],
  ["\\paragraph", "\\paragraph{${}}", "sectioning"],
  ["\\subparagraph", "\\subparagraph{${}}", "sectioning"],
  ["\\appendix", null, "sectioning"],
  ["\\frontmatter", null, "sectioning"],
  ["\\mainmatter", null, "sectioning"],
  ["\\backmatter", null, "sectioning"],
  ["\\input", "\\input{${file}}", "include"],
  ["\\include", "\\include{${file}}", "include"],
  ["\\label", "\\label{${key}}", "cross-reference"],
  ["\\ref", "\\ref{${key}}", "cross-reference"],
  ["\\eqref", "\\eqref{${key}}", "cross-reference"],
  ["\\autoref", "\\autoref{${key}}", "cross-reference"],
  ["\\cref", "\\cref{${key}}", "cross-reference"],
  ["\\pageref", "\\pageref{${key}}", "cross-reference"],
  ["\\footnote", "\\footnote{${}}", "note"],
  ["\\cite", "\\cite{${key}}", "citation"],
  ["\\citep", "\\citep{${key}}", "citation"],
  ["\\citet", "\\citet{${key}}", "citation"],
  ["\\nocite", "\\nocite{${key}}", "citation"],
  ["\\bibliography", "\\bibliography{${file}}", "citation"],
  ["\\bibliographystyle", "\\bibliographystyle{${plain}}", "citation"],
  ["\\addbibresource", "\\addbibresource{${file.bib}}", "citation"],
  ["\\printbibliography", null, "citation"],
  ["\\newcommand", "\\newcommand{\\${name}}{${}}", "definition"],
  ["\\renewcommand", "\\renewcommand{\\${name}}{${}}", "definition"],
  ["\\newtheorem", "\\newtheorem{${env}}{${Title}}", "definition"],
  ["\\begin", "\\begin{${env}}", "environment"],
  ["\\end", "\\end{${env}}", "environment"],
  ["\\item", null, "list"],
  ["\\caption", "\\caption{${}}", "float"],
  ["\\centering", null, "float"],
  ["\\includegraphics", "\\includegraphics[width=${0.8}\\linewidth]{${file}}", "float"],
  ["\\hline", null, "table"],
  ["\\toprule", null, "table (booktabs)"],
  ["\\midrule", null, "table (booktabs)"],
  ["\\bottomrule", null, "table (booktabs)"],
  ["\\multicolumn", "\\multicolumn{${2}}{${c}}{${}}", "table"],
  ["\\multirow", "\\multirow{${2}}{${*}}{${}}", "table"],
  ["\\newpage", null, "layout"],
  ["\\clearpage", null, "layout"],
  ["\\noindent", null, "layout"],
  ["\\vspace", "\\vspace{${1em}}", "layout"],
  ["\\hspace", "\\hspace{${1em}}", "layout"],
  ["\\emph", "\\emph{${}}", "text"],
  ["\\textbf", "\\textbf{${}}", "text"],
  ["\\textit", "\\textit{${}}", "text"],
  ["\\texttt", "\\texttt{${}}", "text"],
  ["\\textsc", "\\textsc{${}}", "text"],
  ["\\underline", "\\underline{${}}", "text"],
  ["\\url", "\\url{${}}", "text"],
  ["\\href", "\\href{${url}}{${text}}", "text"],
];

const MATH_COMMANDS: CommandEntry[] = [
  ["\\frac", "\\frac{${}}{${}}", "math"],
  ["\\sqrt", "\\sqrt{${}}", "math"],
  ["\\sum", "\\sum_{${i=1}}^{${n}}", "math"],
  ["\\prod", "\\prod_{${i=1}}^{${n}}", "math"],
  ["\\int", "\\int_{${a}}^{${b}}", "math"],
  ["\\lim", "\\lim_{${n \\to \\infty}}", "math"],
  ["\\operatorname", "\\operatorname{${}}", "math"],
  ["\\text", "\\text{${}}", "math"],
  ["\\mathbb", "\\mathbb{${R}}", "math"],
  ["\\mathcal", "\\mathcal{${L}}", "math"],
  ["\\mathbf", "\\mathbf{${}}", "math"],
  ["\\mathrm", "\\mathrm{${}}", "math"],
  ["\\boldsymbol", "\\boldsymbol{${}}", "math"],
  ["\\hat", "\\hat{${}}", "math"],
  ["\\bar", "\\bar{${}}", "math"],
  ["\\tilde", "\\tilde{${}}", "math"],
  ["\\vec", "\\vec{${}}", "math"],
  ["\\dot", "\\dot{${}}", "math"],
  ["\\left", null, "math"],
  ["\\right", null, "math"],
  ["\\quad", null, "math"],
  ["\\qquad", null, "math"],
  ...([
    "infty", "partial", "nabla", "cdot", "cdots", "ldots", "times", "leq", "geq", "neq", "approx",
    "equiv", "sim", "propto", "in", "notin", "subset", "subseteq", "cup", "cap", "forall", "exists",
    "rightarrow", "leftarrow", "leftrightarrow", "Rightarrow", "Leftarrow", "Leftrightarrow", "mapsto",
    "log", "exp", "sin", "cos", "tan", "min", "max", "arg", "det", "dim", "ker", "deg",
  ].map((name) => [`\\${name}`, null, "math"] as CommandEntry)),
];

const GREEK_COMMANDS: CommandEntry[] = [
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta",
  "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "upsilon", "phi",
  "varphi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
].map((name) => [`\\${name}`, null, "greek"] as CommandEntry);

const COMMANDS: CommandEntry[] = [...STRUCTURE_COMMANDS, ...MATH_COMMANDS, ...GREEK_COMMANDS];

/** Environments offered inside `\begin{…}` / `\end{…}`, with the body an empty
 * one gets when it is expanded on its own line. */
const ENVIRONMENTS: readonly (readonly [string, string?])[] = [
  ["document"], ["abstract"], ["itemize", "\\item "], ["enumerate", "\\item "], ["description", "\\item[] "],
  ["figure"], ["figure*"], ["table"], ["table*"], ["tabular"], ["tabularx"], ["subfigure"], ["wrapfigure"],
  ["equation"], ["equation*"], ["align"], ["align*"], ["gather"], ["gather*"], ["split"], ["cases"],
  ["matrix"], ["pmatrix"], ["bmatrix"], ["vmatrix"], ["array"], ["multline"],
  ["theorem"], ["lemma"], ["proposition"], ["corollary"], ["definition"], ["remark"], ["example"], ["proof"],
  ["algorithm"], ["algorithmic"], ["verbatim"], ["lstlisting"], ["minted"], ["quote"], ["quotation"],
  ["center"], ["flushleft"], ["flushright"], ["minipage"], ["thebibliography"], ["appendices"],
  ["frame"], ["columns"], ["column"], ["block"], ["comment"],
];

const REFERENCE_COMMANDS = new Set([
  "ref", "eqref", "autoref", "cref", "Cref", "pageref", "nameref", "vref", "labelcref",
]);

const CITATION_COMMANDS = new Set([
  "cite", "citep", "citet", "citeal", "citealp", "citealt", "citeauthor", "citeyear", "citeyearpar",
  "nocite", "parencite", "textcite", "autocite", "footcite", "supercite",
]);

/** Commands whose brace argument is a file path, and the extensions each one
 * accepts — `\includegraphics` never wants a `.tex`, `\input` never an image. */
const PATH_COMMANDS: Record<string, readonly string[]> = {
  includegraphics: [".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg", ".gif", ".tif", ".tiff", ".webp"],
  includesvg: [".svg"],
  input: [".tex"],
  include: [".tex"],
  subfile: [".tex"],
  import: [".tex"],
  bibliography: [".bib"],
  addbibresource: [".bib"],
  addglobalbib: [".bib"],
  lstinputlisting: [],
  verbatiminput: [],
};

/** LaTeX resolves `\input{ch2}` and `\includegraphics{fig/a}` without the
 * extension, so the completion offers the extension-less form for the ones TeX
 * fills in itself, and the literal path otherwise. */
function pathOptions(command: string, files: LatexSymbol[]): Completion[] {
  const allowed = PATH_COMMANDS[command] ?? [];
  const dropExtension = command !== "lstinputlisting" && command !== "verbatiminput";
  const options: Completion[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (allowed.length > 0 && !allowed.includes(extension)) continue;
    const label = dropExtension && (extension === ".tex" || extension === ".bib")
      ? file.name.slice(0, -extension.length)
      : file.name;
    if (seen.has(label)) continue;
    seen.add(label);
    options.push({ label, type: "file", detail: file.detail });
  }
  return options;
}

/** True when the cursor sits after an unescaped `%` — LaTeX comment territory,
 * where suggesting commands is noise. */
function insideComment(before: string): boolean {
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== "%") continue;
    let backslashes = 0;
    for (let scan = index - 1; scan >= 0 && before[scan] === "\\"; scan -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

function commandCompletion([label, snippet, detail]: CommandEntry): Completion {
  const boost = detail === "greek" ? -1 : 0;
  return snippet
    ? snippetCompletion(snippet, { label, type: "function", detail, boost })
    : { label, type: "keyword", detail, boost };
}

const COMMAND_OPTIONS: Completion[] = COMMANDS.map(commandCompletion);

/** Expands `\begin{env}` on its own line into the full begin/body/end block,
 * the way Overleaf and every LaTeX editor do — otherwise the writer types the
 * closing `\end` by hand every single time. */
function environmentApply(name: string, body: string | undefined, closing: boolean) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const { state } = view;
    const line = state.doc.lineAt(from);
    const head = line.text.slice(0, from - line.from);
    const tail = state.doc.sliceString(to, line.to).replace(/^\}/, "");
    const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
    const blockable = closing && head.trim() === "\\begin{" && tail.trim() === "";
    if (!blockable) {
      const insert = `${name}}`;
      view.dispatch({
        changes: { from, to: to + (state.doc.sliceString(to, line.to).startsWith("}") ? 1 : 0), insert },
        selection: { anchor: from + insert.length },
      });
      return;
    }
    const inner = `${indent}  ${body ?? ""}`;
    const insert = `${name}}\n${inner}\n${indent}\\end{${name}}`;
    view.dispatch({
      changes: { from, to: line.to, insert },
      selection: { anchor: from + `${name}}\n`.length + inner.length },
    });
  };
}

function environmentResult(from: number, kind: "begin" | "end"): CompletionResult {
  return {
    from,
    options: ENVIRONMENTS.map(([name, body]) => ({
      label: name,
      type: "class",
      apply: environmentApply(name, body, kind === "begin"),
    })),
    validFor: /^[\w*]*$/,
  };
}

function symbolOptions(symbols: LatexSymbol[], type: string): Completion[] {
  return symbols.map((symbol) => ({ label: symbol.name, detail: symbol.detail, type }));
}

/** Labels defined in the document being edited, so `\ref{` works even before the
 * project index has loaded (or in the Lab, which has no index at all). */
function documentLabels(state: EditorState): LatexSymbol[] {
  const symbols: LatexSymbol[] = [];
  const seen = new Set<string>();
  const re = /\\label\s*\{([^{}]+)\}/g;
  const text = state.doc.toString();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const name = match[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    symbols.push({ name });
  }
  return symbols;
}

function documentCitations(state: EditorState): LatexSymbol[] {
  const symbols: LatexSymbol[] = [];
  const seen = new Set<string>();
  const re = /\\bibitem(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g;
  const text = state.doc.toString();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const name = match[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    symbols.push({ name });
  }
  return symbols;
}

function mergeSymbols(primary: LatexSymbol[], secondary: LatexSymbol[]): LatexSymbol[] {
  const names = new Set(primary.map((symbol) => symbol.name));
  return [...primary, ...secondary.filter((symbol) => !names.has(symbol.name))];
}

export function latexCompletionSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  if (insideComment(before)) return null;

  const environment = /\\(begin|end)\s*\{([^{}]*)$/.exec(before);
  if (environment) {
    return environmentResult(context.pos - environment[2].length, environment[1] as "begin" | "end");
  }

  // Inside a command's brace argument: only keys make sense, never commands.
  const argument = /\\([a-zA-Z]+)\*?(?:\[[^\]]*\])?\s*\{([^{}]*)$/.exec(before);
  if (argument) {
    const command = argument[1];
    // \cite{a,b| — complete the key being typed, not the whole list.
    const typed = argument[2].slice(argument[2].lastIndexOf(",") + 1);
    const from = context.pos - typed.replace(/^\s*/, "").length;
    if (REFERENCE_COMMANDS.has(command)) {
      const options = symbolOptions(mergeSymbols(documentLabels(context.state), projectSymbols.labels), "constant");
      return options.length > 0 ? { from, options, validFor: /^[^{}\s,]*$/ } : null;
    }
    if (CITATION_COMMANDS.has(command)) {
      const options = symbolOptions(mergeSymbols(documentCitations(context.state), projectSymbols.citations), "constant");
      return options.length > 0 ? { from, options, validFor: /^[^{}\s,]*$/ } : null;
    }
    if (command in PATH_COMMANDS) {
      const options = pathOptions(command, projectSymbols.files);
      return options.length > 0 ? { from, options, validFor: /^[^{}]*$/ } : null;
    }
    return null;
  }

  const command = /\\([a-zA-Z]*)$/.exec(before);
  if (!command) return null;
  // Bare `\` with nothing typed still opens the list — that is the discovery
  // path for writers who don't know the command name yet.
  return { from: context.pos - command[1].length - 1, options: COMMAND_OPTIONS, validFor: /^\\[a-zA-Z]*$/ };
}

/** Registers the source as language data so it composes with the shared
 * `autocompletion()` already configured in `editorState.ts`. */
export function latexCompletion(): Extension {
  return EditorState.languageData.of(() => [{ autocomplete: latexCompletionSource }]);
}
