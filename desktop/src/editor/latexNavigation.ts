/**
 * What a Ctrl/⌘+click, F12 or F2 in a LaTeX source points at, and every place
 * a label is defined or used — the ground the Typeset editor's "go to
 * definition" and "rename label" stand on.
 *
 * Deliberately textual: both editors and every file of the document graph go
 * through the same few patterns, so a rename finds exactly the places a jump
 * would. Commented-out text is skipped, as TeX skips it.
 */

/** Commands whose argument is a comma-separated list of label names. */
export const LATEX_REFERENCE_COMMANDS = new Set([
  "ref", "eqref", "autoref", "cref", "Cref", "pageref", "nameref", "vref", "Vref",
  "cpageref", "Cpageref", "labelcref", "autopageref", "crefrange", "Crefrange", "subref",
]);

export const LATEX_CITATION_COMMANDS = new Set([
  "cite", "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear", "parencite", "textcite", "autocite",
  "footcite", "Citep", "Citet", "Citeauthor", "citeyearpar", "citenum", "Parencite", "Textcite", "Autocite",
  "smartcite", "supercite", "nocite", "fullcite", "footfullcite",
]);

/** Commands whose argument names another file of the project. */
export const LATEX_FILE_COMMANDS = new Set([
  "input", "include", "subfile", "subfileinclude", "includeonly", "bibliography", "addbibresource",
  "includegraphics", "includepdf", "lstinputlisting", "inputminted", "import", "subimport",
]);

export type LatexNavigationTarget =
  | { kind: "label-reference"; name: string; from: number; to: number }
  | { kind: "label-definition"; name: string; from: number; to: number }
  | { kind: "citation"; key: string; from: number; to: number }
  | { kind: "file"; command: string; target: string; from: number; to: number };

export type LabelSite = { kind: "definition" | "reference"; name: string; from: number; to: number };

/** `\name*[opt]…{arg}`, with the argument's own position. One line at a time. */
const COMMAND_WITH_ARGUMENT = /\\([A-Za-z]+)\*?\s*((?:\[[^\]\n]*\]\s*)*)\{([^{}\n]*)\}/g;
/** `\begin{env}[…label=name…]` — listings, tcolorbox and friends. */
const ENVIRONMENT_OPTIONS = /\\begin\s*\{[^}\n]+\}\s*\[([^\]\n]*)\]/g;
const OPTION_LABEL = /(?:^|,)\s*label\s*=\s*\{?\s*([^,}\]\s]+)/;
/** `\hyperref[name]{text}` links to a label from its optional argument. */
const HYPERREF = /\\hyperref\s*\[([^\]\n]*)\]/g;
/** `\import{dir/}{file}` — the second group is the file. */
const IMPORT_FILE = /\\(sub)?import\*?\s*\{([^{}\n]*)\}\s*\{([^{}\n]*)\}/g;

/** Position of the first unescaped `%` on the line, or the line length. */
function commentStart(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "%") continue;
    let backslashes = 0;
    for (let back = index - 1; back >= 0 && line[back] === "\\"; back -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return index;
  }
  return line.length;
}

/** Each comma-separated key of an argument, trimmed, with its own range. */
function argumentKeys(value: string, offset: number): { key: string; from: number; to: number }[] {
  const keys: { key: string; from: number; to: number }[] = [];
  let start = 0;
  for (const part of value.split(",")) {
    const leading = part.length - part.trimStart().length;
    const key = part.trim();
    if (key) keys.push({ key, from: offset + start + leading, to: offset + start + leading + key.length });
    start += part.length + 1;
  }
  return keys;
}

/** `span` is the whole command, for clicks on a rendered chip in Visual mode. */
type LineSite = { spanFrom: number; spanTo: number } & (
  | { kind: "label-reference" | "label-definition"; name: string; from: number; to: number }
  | { kind: "citation"; key: string; from: number; to: number }
  | { kind: "file"; command: string; target: string; from: number; to: number }
);

/** Everything navigable on one line, positions relative to the line. */
function lineSites(line: string): LineSite[] {
  const code = line.slice(0, commentStart(line));
  const sites: LineSite[] = [];
  COMMAND_WITH_ARGUMENT.lastIndex = 0;
  for (let match = COMMAND_WITH_ARGUMENT.exec(code); match; match = COMMAND_WITH_ARGUMENT.exec(code)) {
    const [whole, name, , argument] = match;
    const argumentFrom = match.index + whole.length - 1 - argument.length;
    const span = { spanFrom: match.index, spanTo: match.index + whole.length };
    if (name === "label") {
      const key = argument.trim();
      if (key) {
        const from = argumentFrom + argument.indexOf(key);
        sites.push({ ...span, kind: "label-definition", name: key, from, to: from + key.length });
      }
    } else if (LATEX_REFERENCE_COMMANDS.has(name)) {
      for (const key of argumentKeys(argument, argumentFrom)) sites.push({ ...span, kind: "label-reference", name: key.key, from: key.from, to: key.to });
    } else if (LATEX_CITATION_COMMANDS.has(name)) {
      for (const key of argumentKeys(argument, argumentFrom)) sites.push({ ...span, kind: "citation", key: key.key, from: key.from, to: key.to });
    } else if (LATEX_FILE_COMMANDS.has(name) && name !== "import" && name !== "subimport") {
      // `\bibliography{a,b}` and `\includeonly{a,b}` list several files.
      const listed = name === "bibliography" || name === "includeonly"
        ? argumentKeys(argument, argumentFrom)
        : [{ key: argument.trim(), from: argumentFrom + argument.indexOf(argument.trim()), to: argumentFrom + argument.indexOf(argument.trim()) + argument.trim().length }];
      for (const item of listed) {
        if (item.key) sites.push({ ...span, kind: "file", command: name, target: item.key, from: item.from, to: item.to });
      }
    }
  }
  IMPORT_FILE.lastIndex = 0;
  for (let match = IMPORT_FILE.exec(code); match; match = IMPORT_FILE.exec(code)) {
    const [whole, sub, directory, file] = match;
    const fileFrom = match.index + whole.length - 1 - file.length;
    const target = `${directory.trim().replace(/\/?$/, "/")}${file.trim()}`;
    sites.push({ spanFrom: match.index, spanTo: match.index + whole.length, kind: "file", command: sub ? "subimport" : "import", target, from: fileFrom, to: fileFrom + file.length });
  }
  ENVIRONMENT_OPTIONS.lastIndex = 0;
  for (let match = ENVIRONMENT_OPTIONS.exec(code); match; match = ENVIRONMENT_OPTIONS.exec(code)) {
    const options = match[1];
    const label = OPTION_LABEL.exec(options);
    if (!label) continue;
    const optionsFrom = match.index + match[0].length - 1 - options.length;
    const from = optionsFrom + label.index + label[0].length - label[1].length;
    sites.push({ spanFrom: from, spanTo: from + label[1].length, kind: "label-definition", name: label[1], from, to: from + label[1].length });
  }
  HYPERREF.lastIndex = 0;
  for (let match = HYPERREF.exec(code); match; match = HYPERREF.exec(code)) {
    const name = match[1].trim();
    if (!name) continue;
    const from = match.index + match[0].indexOf(name, match[0].indexOf("["));
    sites.push({ spanFrom: match.index, spanTo: match.index + match[0].length, kind: "label-reference", name, from, to: from + name.length });
  }
  return sites;
}

/**
 * What the position points at. `lineText` is the line holding `pos`, starting
 * at `lineFrom`; the result's range is in document positions. With `loose`, a
 * position anywhere on the command counts (a click on a Visual-mode chip,
 * which hides the braces), taking its first key.
 */
export function latexNavigationTargetAt(
  lineText: string,
  lineFrom: number,
  pos: number,
  { loose = false }: { loose?: boolean } = {},
): LatexNavigationTarget | null {
  const column = pos - lineFrom;
  const sites = lineSites(lineText);
  const site = sites.find((candidate) => column >= candidate.from && column <= candidate.to)
    ?? (loose ? sites.find((candidate) => column >= candidate.spanFrom && column <= candidate.spanTo) : undefined);
  if (!site) return null;
  const from = lineFrom + site.from;
  const to = lineFrom + site.to;
  if (site.kind === "citation") return { kind: "citation", key: site.key, from, to };
  if (site.kind === "file") return { kind: "file", command: site.command, target: site.target, from, to };
  return { kind: site.kind, name: site.name, from, to };
}

/** Every definition and use of labels in a source, optionally of one name. */
export function labelSites(source: string, name?: string): LabelSite[] {
  const sites: LabelSite[] = [];
  let lineFrom = 0;
  for (const line of source.split("\n")) {
    // A line without a backslash cannot hold a label; most prose lines don't.
    if (line.includes("\\")) {
      for (const site of lineSites(line)) {
        if (site.kind !== "label-definition" && site.kind !== "label-reference") continue;
        if (name !== undefined && site.name !== name) continue;
        sites.push({
          kind: site.kind === "label-definition" ? "definition" : "reference",
          name: site.name,
          from: lineFrom + site.from,
          to: lineFrom + site.to,
        });
      }
    }
    lineFrom += line.length + 1;
  }
  return sites;
}

/** Why a new label name cannot be used, or null when it can. */
export function invalidLabelName(name: string): "empty" | "characters" | null {
  if (!name.trim()) return "empty";
  // Braces, commas and `%` break the argument; whitespace and `\` and `#`
  // make a key TeX reads differently from what was typed.
  return /[\s{}%,\\#]/.test(name) ? "characters" : null;
}

/** The source with every definition and use of `from` renamed to `to`. */
export function renameLabelInSource(source: string, from: string, to: string): { text: string; count: number } {
  const sites = labelSites(source, from);
  if (sites.length === 0) return { text: source, count: 0 };
  let text = "";
  let cursor = 0;
  for (const site of sites) {
    text += source.slice(cursor, site.from) + to;
    cursor = site.to;
  }
  return { text: text + source.slice(cursor), count: sites.length };
}

/** Offset of `@type{key,` in a .bib source, or -1. */
export function bibEntryOffset(source: string, key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`@[A-Za-z]+\\s*[{(]\\s*${escaped}\\s*,`).exec(source);
  return match ? match.index + match[0].lastIndexOf(key) : -1;
}
