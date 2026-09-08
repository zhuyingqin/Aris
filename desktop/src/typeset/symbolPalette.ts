/**
 * The symbol palette's data — the LaTeX commands Overleaf's own palette offers,
 * grouped the same way. Pure data plus one filter so the panel that renders it
 * (`TypesetSymbolPalette.tsx`) stays presentation-only.
 *
 * `command` is inserted verbatim; `preview` is what the button shows, rendered
 * through KaTeX when it is math and shown literally when it is not.
 */

export type SymbolGroupId =
  | "greek"
  | "operators"
  | "relations"
  | "arrows"
  | "delimiters"
  | "misc";

export type LatexSymbolEntry = {
  /** Inserted at the caret, e.g. `\alpha`. */
  command: string;
  /** KaTeX source for the button face; defaults to `command`. */
  preview?: string;
  /** Searchable words beyond the command itself. */
  keywords?: string;
  /** Needs surrounding `$…$` when inserted outside math. */
  math?: boolean;
};

export type SymbolGroup = { id: SymbolGroupId; symbols: readonly LatexSymbolEntry[] };

const m = (command: string, keywords?: string): LatexSymbolEntry => ({ command, keywords, math: true });

export const SYMBOL_GROUPS: readonly SymbolGroup[] = [
  {
    id: "greek",
    symbols: [
      m("\\alpha"), m("\\beta"), m("\\gamma"), m("\\delta"), m("\\epsilon"), m("\\varepsilon"),
      m("\\zeta"), m("\\eta"), m("\\theta"), m("\\vartheta"), m("\\iota"), m("\\kappa"),
      m("\\lambda"), m("\\mu"), m("\\nu"), m("\\xi"), m("\\pi"), m("\\varpi"), m("\\rho"),
      m("\\varrho"), m("\\sigma"), m("\\varsigma"), m("\\tau"), m("\\upsilon"), m("\\phi"),
      m("\\varphi"), m("\\chi"), m("\\psi"), m("\\omega"),
      m("\\Gamma"), m("\\Delta"), m("\\Theta"), m("\\Lambda"), m("\\Xi"), m("\\Pi"),
      m("\\Sigma"), m("\\Upsilon"), m("\\Phi"), m("\\Psi"), m("\\Omega"),
    ],
  },
  {
    id: "operators",
    symbols: [
      m("\\sum", "sum sigma"), m("\\prod", "product"), m("\\coprod"), m("\\int", "integral"),
      m("\\iint"), m("\\iiint"), m("\\oint", "contour"), m("\\partial", "partial derivative"),
      m("\\nabla", "grad del"), m("\\pm"), m("\\mp"), m("\\times", "multiply"), m("\\div", "divide"),
      m("\\cdot"), m("\\ast"), m("\\star"), m("\\circ"), m("\\bullet"), m("\\oplus"), m("\\ominus"),
      m("\\otimes", "tensor kronecker"), m("\\oslash"), m("\\odot"), m("\\cap", "intersection"),
      m("\\cup", "union"), m("\\sqcap"), m("\\sqcup"), m("\\vee", "or"), m("\\wedge", "and"),
      m("\\setminus"), m("\\wr"),
      { command: "\\frac{a}{b}", preview: "\\frac{a}{b}", keywords: "fraction division", math: true },
      { command: "\\sqrt{x}", preview: "\\sqrt{x}", keywords: "square root", math: true },
      { command: "\\sqrt[n]{x}", preview: "\\sqrt[n]{x}", keywords: "nth root", math: true },
      { command: "x^{2}", preview: "x^{2}", keywords: "superscript power", math: true },
      { command: "x_{i}", preview: "x_{i}", keywords: "subscript index", math: true },
    ],
  },
  {
    id: "relations",
    symbols: [
      m("\\leq", "less equal"), m("\\geq", "greater equal"), m("\\neq", "not equal"),
      m("\\equiv"), m("\\approx"), m("\\cong"), m("\\simeq"), m("\\sim"), m("\\propto"),
      m("\\ll"), m("\\gg"), m("\\subset"), m("\\supset"), m("\\subseteq"), m("\\supseteq"),
      m("\\in", "element member"), m("\\ni"), m("\\notin"), m("\\mid"), m("\\parallel"),
      m("\\perp", "perpendicular orthogonal"), m("\\models"), m("\\vdash"), m("\\prec"), m("\\succ"),
      m("\\doteq"), m("\\asymp"), m("\\bowtie"),
    ],
  },
  {
    id: "arrows",
    symbols: [
      m("\\leftarrow"), m("\\rightarrow", "to"), m("\\leftrightarrow"),
      m("\\Leftarrow"), m("\\Rightarrow", "implies"), m("\\Leftrightarrow", "iff"),
      m("\\longleftarrow"), m("\\longrightarrow"), m("\\longleftrightarrow"),
      m("\\Longrightarrow"), m("\\Longleftrightarrow"),
      m("\\uparrow"), m("\\downarrow"), m("\\updownarrow"), m("\\Uparrow"), m("\\Downarrow"),
      m("\\mapsto"), m("\\hookrightarrow"), m("\\rightharpoonup"), m("\\rightleftharpoons"),
      m("\\nearrow"), m("\\searrow"), m("\\swarrow"), m("\\nwarrow"),
    ],
  },
  {
    id: "delimiters",
    symbols: [
      { command: "\\left( \\right)", preview: "\\left(\\ \\right)", keywords: "parentheses brackets", math: true },
      { command: "\\left[ \\right]", preview: "\\left[\\ \\right]", keywords: "square brackets", math: true },
      { command: "\\left\\{ \\right\\}", preview: "\\left\\{\\ \\right\\}", keywords: "braces curly", math: true },
      { command: "\\left| \\right|", preview: "\\left|\\ \\right|", keywords: "absolute value modulus", math: true },
      { command: "\\left\\| \\right\\|", preview: "\\left\\|\\ \\right\\|", keywords: "norm", math: true },
      { command: "\\langle \\rangle", preview: "\\langle\\ \\rangle", keywords: "angle brackets inner product", math: true },
      { command: "\\lfloor \\rfloor", preview: "\\lfloor\\ \\rfloor", keywords: "floor", math: true },
      { command: "\\lceil \\rceil", preview: "\\lceil\\ \\rceil", keywords: "ceiling", math: true },
    ],
  },
  {
    id: "misc",
    symbols: [
      m("\\infty", "infinity"), m("\\forall", "for all"), m("\\exists", "there exists"),
      m("\\nexists"), m("\\neg", "not negation"), m("\\emptyset"), m("\\varnothing"),
      m("\\aleph"), m("\\hbar"), m("\\ell"), m("\\Re"), m("\\Im"), m("\\wp"),
      m("\\prime"), m("\\dagger"), m("\\ddagger"), m("\\angle"), m("\\triangle"),
      m("\\top"), m("\\bot"), m("\\ldots"), m("\\cdots"), m("\\vdots"), m("\\ddots"),
      m("\\mathbb{R}", "real numbers blackboard"), m("\\mathbb{N}", "natural numbers"),
      m("\\mathbb{Z}", "integers"), m("\\mathbb{C}", "complex numbers"), m("\\mathbb{E}", "expectation"),
      { command: "\\%", preview: "\\%", keywords: "percent escape" },
      { command: "\\&", preview: "\\&", keywords: "ampersand escape" },
      { command: "\\_", preview: "\\_", keywords: "underscore escape" },
      { command: "\\#", preview: "\\#", keywords: "hash escape" },
      { command: "\\textbackslash", preview: "\\backslash", keywords: "backslash escape" },
    ],
  },
];

/** Case-insensitive match over the command and its keywords. */
export function filterSymbols(groups: readonly SymbolGroup[], query: string): SymbolGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...groups];
  return groups
    .map((group) => ({
      ...group,
      symbols: group.symbols.filter((symbol) =>
        `${symbol.command} ${symbol.keywords ?? ""}`.toLocaleLowerCase().includes(needle)),
    }))
    .filter((group) => group.symbols.length > 0);
}

/**
 * What to insert for `symbol` at a caret that is (or is not) already inside
 * math. A `\alpha` dropped into prose compiles to an error, so it is wrapped;
 * one dropped inside `$…$` must not be.
 */
export function symbolInsertion(symbol: LatexSymbolEntry, insideMath: boolean): string {
  return symbol.math && !insideMath ? `$${symbol.command}$` : symbol.command;
}

/**
 * Where the caret should land inside a freshly inserted symbol, as offsets into
 * the inserted text. A template like `\frac{a}{b}` selects its `a` so the next
 * keystroke replaces it; `\left( \right)` puts the caret in the gap; a plain
 * `\alpha` just gets the caret after it.
 */
export function symbolSelectionRange(text: string): [number, number] {
  const braced = /\{([^{}]+)\}/.exec(text);
  if (braced && braced.index >= 0) {
    const start = braced.index + 1;
    return [start, start + braced[1].length];
  }
  const gap = /\\left(?:\\)?.\s(\s*)\\right/.exec(text);
  if (gap) {
    const start = gap.index + gap[0].indexOf(" ") + 1;
    return [start, start];
  }
  return [text.length, text.length];
}
