// Document-defined math macros, handed to KaTeX so formulas that use them
// render instead of showing a red "undefined control sequence".
import { Facet, type EditorState } from "@codemirror/state";

export type MathMacros = Readonly<Record<string, string>>;

/**
 * Macros from the *root* document's preamble, supplied by the host. A chapter
 * `\input` from main.tex defines none of its own, so without this every
 * `\R` or `\Tr` in it would render as an error. The open file's own
 * definitions are parsed from the live buffer and win over these.
 */
export const latexMathMacros = Facet.define<MathMacros | null, MathMacros | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

/** Drop `%` comments (through the line break) but keep an escaped `\%`. */
export function stripLatexComments(source: string): string {
  return source.replace(/(?<=(?:^|[^\\])(?:\\\\)*)%[^\n]*\n?/g, "");
}

/** The balanced `{…}` group starting at `open`, or null. */
function readGroup(source: string, open: number): { body: string; end: number } | null {
  if (source[open] !== "{") return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open + 1, index), end: index + 1 };
    }
  }
  return null;
}

function skipSpaces(source: string, index: number): number {
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

/** `{\name}` or a bare `\name` right after a defining command. */
function readMacroName(source: string, index: number): { name: string; end: number } | null {
  const at = skipSpaces(source, index);
  if (source[at] === "{") {
    const group = readGroup(source, at);
    const name = group?.body.trim();
    return group && name && /^\\(?:[A-Za-z@]+|.)$/.test(name) ? { name, end: group.end } : null;
  }
  const bare = /^\\(?:[A-Za-z@]+|.)/.exec(source.slice(at));
  return bare ? { name: bare[0], end: at + bare[0].length } : null;
}

/**
 * Parse the macro definitions KaTeX can take as-is: `\newcommand` and its
 * relatives (with `[n]` parameters — KaTeX expands `#1`…), parameterless
 * `\def`, and `\DeclareMathOperator(*)`. Definitions with an optional-argument
 * default are skipped: KaTeX's macro table cannot express them. Only the
 * preamble is read when the file has one.
 */
export function mathMacrosFromSource(source: string): Record<string, string> {
  // Cut at \begin{document} first: this runs on every Visual rebuild, and the
  // body of a long manuscript holds no definitions worth the scan.
  const begin = source.search(/\\begin\s*\{document\}/);
  const preamble = stripLatexComments(begin >= 0 ? source.slice(0, begin) : source);
  const macros: Record<string, string> = {};
  const definition = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|def)(?![A-Za-z@])(\*?)/g;
  for (let match = definition.exec(preamble); match; match = definition.exec(preamble)) {
    const [, command, star] = match;
    const named = readMacroName(preamble, match.index + match[0].length);
    if (!named) continue;
    let cursor = skipSpaces(preamble, named.end);
    if (command === "def") {
      const group = readGroup(preamble, cursor);
      if (group) macros[named.name] = group.body;
      continue;
    }
    if (command === "DeclareMathOperator") {
      const group = readGroup(preamble, cursor);
      if (group) macros[named.name] = `\\operatorname${star}{${group.body}}`;
      continue;
    }
    const parameters = /^\[\s*\d\s*\]/.exec(preamble.slice(cursor));
    if (parameters) cursor = skipSpaces(preamble, cursor + parameters[0].length);
    if (preamble[cursor] === "[") continue;
    const group = readGroup(preamble, cursor);
    if (!group) continue;
    // \providecommand never replaces an existing definition.
    if (command === "providecommand" && named.name in macros) continue;
    macros[named.name] = group.body;
  }
  return macros;
}

/** The macros a formula in this state should render with: the host's root
 * definitions overlaid by the open file's own. */
export function mathMacrosFor(state: EditorState): MathMacros {
  return { ...(state.facet(latexMathMacros) ?? {}), ...mathMacrosFromSource(state.doc.toString()) };
}

/** A stable identity for a macro table, for widget equality checks. */
export function mathMacrosKey(macros: MathMacros): string {
  return Object.keys(macros).sort().map((name) => `${name}\u0000${macros[name]}`).join("\u0001");
}
