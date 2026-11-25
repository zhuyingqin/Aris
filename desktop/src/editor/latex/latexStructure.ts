/**
 * A lightweight structural index for editable LaTeX.
 *
 * This is deliberately not a TeX expander. Its job is to establish the context
 * that visual editing must never guess with unrelated regular expressions:
 * comments, verbatim-like regions, commands with balanced arguments, and
 * properly nested environments. One linear scan produces an index shared by
 * decorations, editing commands, outlines, and paste/keyboard behaviour.
 */

import { canonicalMathEnvironmentName } from "../../math/latexMath";

export type LatexRange = { from: number; to: number };

export type LatexArgument = LatexRange & {
  contentFrom: number;
  contentTo: number;
  value: string;
};

export type LatexCommand = LatexRange & {
  name: string;
  controlTo: number;
  starred: boolean;
  optionalArguments: LatexArgument[];
  requiredArguments: LatexArgument[];
};

export type LatexHeading = LatexRange & {
  command: "part" | "chapter" | "section" | "subsection" | "subsubsection" | "paragraph" | "subparagraph";
  commandTo: number;
  starred: boolean;
  shortTitle: LatexArgument | null;
  title: LatexArgument;
};

export type LatexEnvironment = LatexRange & {
  name: string;
  beginFrom: number;
  beginTo: number;
  bodyFrom: number;
  bodyTo: number;
  endFrom: number;
  endTo: number;
  optionalArguments: LatexArgument[];
  closed: boolean;
};

const HEADING_COMMANDS = new Set<LatexHeading["command"]>([
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
]);

const INDEXED_ARGUMENT_COMMANDS = new Set([
  "title", "author", "date", "frametitle", "caption", "includegraphics", "href", "label",
  "cite", "citep", "citet", "parencite", "textcite", "autocite",
  "citealp", "citealt", "citeauthor", "citeyear", "footcite",
  "Citep", "Citet", "Citeauthor", "citeyearpar", "citenum", "Parencite", "Textcite", "Autocite",
  "smartcite", "supercite", "nocite", "bibitem",
  "ref", "eqref", "autoref", "cref", "Cref", "pageref", "nameref", "vref",
  "Vref", "cpageref", "labelcref", "autopageref",
  "textbf", "textit", "emph", "underline", "texttt", "textsc", "textsubscript", "textsuperscript", "footnote",
  "textsf", "textrm", "textnormal", "textup", "textmd", "textsl", "textcolor",
  "input", "include", "subfile", "subfileinclude", "import", "subimport",
  "addcontentsline",
  "vspace", "hspace", "thispagestyle", "pagestyle", "column", "setlength",
  // Sectioning counters are read by the shared numbering engine so an offset
  // chapter file numbers its headings the way the compiled PDF does.
  "setcounter", "addtocounter", "\\",
]);

/** Commands whose second brace group carries meaning, not just spacing. */
/** Display-math environments, for `isMath`. */
const MATH_ENVIRONMENT_NAMES = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "math", "displaymath",
  "alignat", "alignat*", "flalign", "flalign*", "eqnarray", "eqnarray*",
]);

const TWO_ARGUMENT_COMMANDS = new Set(["href", "import", "subimport", "setlength", "setcounter", "addtocounter", "textcolor"]);
const THREE_ARGUMENT_COMMANDS = new Set(["addcontentsline"]);

export const LATEX_RAW_ENVIRONMENTS = new Set([
  "verbatim",
  "verbatim*",
  "Verbatim",
  "lstlisting",
  "minted",
  "comment",
  "filecontents",
  "filecontents*",
]);

/**
 * One idle window is shared by the editor decoration layer and the React
 * document-analysis snapshot. Whichever consumer settles first populates the
 * structure cache; the other consumers then reuse the same immutable index.
 */
export const LATEX_ANALYSIS_IDLE_MS = 240;

const MAX_CACHED_STRUCTURES = 16;
const MAX_CACHED_SOURCE_CHARACTERS = 2_000_000;
const structureCache = new Map<string, LatexStructureIndex>();
let cachedSourceCharacters = 0;

const isLetter = (char: string | undefined) => Boolean(char && /[A-Za-z@]/.test(char));

/** Commands TeX refuses in math mode; an inline `$` "spanning" one is unclosed. */
const NON_MATH_STRUCTURE = /\\(?:begin|end|item|par|noindent|part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(?![A-Za-z@])|\\\[/;

/**
 * Whether the text between two `$` can be the inside of one inline formula.
 * Hard-wrapped sources routinely continue a `$…$` on the next line (resetting
 * at every newline paired the closing `$` with the *next* formula's opening
 * one and rendered the prose between them as math). But an unclosed `$` must
 * not swallow the paragraphs that follow it either, so a continuation stops
 * at a paragraph break, after a couple of lines, or at structure that is
 * illegal in math anyway.
 */
function inlineMathMayContinue(between: string): boolean {
  const lineBreaks = between.split("\n").length - 1;
  if (lineBreaks === 0) return true;
  return lineBreaks <= 2
    && !/\n[ \t]*\n/.test(between)
    && !NON_MATH_STRUCTURE.test(between);
}

export function isEscapedLatex(source: string, at: number): boolean {
  let slashes = 0;
  for (let index = at - 1; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/**
 * Index just past the `}` matching the `{` at `openBrace`, honoring nesting and
 * escaped braces; -1 when the group never closes (so a caller can leave the
 * region as plain source rather than guessing an end).
 *
 * `readBalancedGroup` below is the richer form used by the structure scan — it
 * also skips comments and returns the argument's span — but the decoration and
 * table editors only need the closing index.
 */
export function matchBraceEnd(text: string, openBrace: number): number {
  let depth = 0;
  for (let index = openBrace; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1; // skip the escaped character (\{ \} \\)
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function readBalancedGroup(source: string, from: number, open: string, close: string): LatexArgument | null {
  if (source[from] !== open) return null;
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === "%" && !isEscapedLatex(source, index)) {
      const newline = source.indexOf("\n", index + 1);
      if (newline < 0) return null;
      index = newline;
      continue;
    }
    if (isEscapedLatex(source, index)) continue;
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return {
          from,
          to: index + 1,
          contentFrom: from + 1,
          contentTo: index,
          value: source.slice(from + 1, index),
        };
      }
    }
  }
  return null;
}

function skipWhitespace(source: string, from: number): number {
  let cursor = from;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  return cursor;
}

function readFollowingArguments(source: string, from: number, requiredLimit = 3): {
  optional: LatexArgument[];
  required: LatexArgument[];
  to: number;
} {
  const optional: LatexArgument[] = [];
  const required: LatexArgument[] = [];
  let cursor = skipWhitespace(source, from);
  let to = from;
  while (source[cursor] === "[") {
    const argument = readBalancedGroup(source, cursor, "[", "]");
    if (!argument) break;
    optional.push(argument);
    to = argument.to;
    cursor = skipWhitespace(source, argument.to);
  }
  while (required.length < requiredLimit && source[cursor] === "{") {
    const argument = readBalancedGroup(source, cursor, "{", "}");
    if (!argument) break;
    required.push(argument);
    to = argument.to;
    cursor = skipWhitespace(source, argument.to);
  }
  return { optional, required, to };
}

function parseControlSequence(source: string, from: number): { name: string; controlTo: number; starred: boolean } | null {
  if (source[from] !== "\\") return null;
  let cursor = from + 1;
  if (cursor >= source.length) return null;
  if (isLetter(source[cursor])) {
    while (isLetter(source[cursor])) cursor += 1;
  } else {
    cursor += 1;
  }
  const name = source.slice(from + 1, cursor);
  const starred = source[cursor] === "*";
  if (starred) cursor += 1;
  return { name, controlTo: cursor, starred };
}

function mergeRanges(ranges: LatexRange[]): LatexRange[] {
  const sorted = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: LatexRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

function rangeContains(ranges: LatexRange[], position: number): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].from <= position) low = middle + 1;
    else high = middle;
  }
  const candidate = ranges[low - 1];
  return Boolean(candidate && position >= candidate.from && position < candidate.to);
}

type OpenEnvironment = {
  name: string;
  beginFrom: number;
  beginTo: number;
  bodyFrom: number;
  optionalArguments: LatexArgument[];
};

export class LatexStructureIndex {
  readonly source: string;
  readonly comments: LatexRange[];
  readonly rawRanges: LatexRange[];
  readonly ignoredRanges: LatexRange[];
  readonly commands: LatexCommand[];
  readonly headings: LatexHeading[];
  readonly environments: LatexEnvironment[];
  readonly mathRanges: LatexRange[];
  readonly bodyStart: number;
  readonly scanEnd: number;
  private commandsByName = new Map<string, LatexCommand[]>();
  private environmentsByName = new Map<string, LatexEnvironment[]>();
  private environmentRoots: LatexEnvironment[] = [];
  private environmentChildren = new Map<LatexEnvironment, LatexEnvironment[]>();
  private lineStarts: number[] | null = null;

  constructor(source: string) {
    this.source = source;
    const comments: LatexRange[] = [];
    const rawRanges: LatexRange[] = [];
    const commands: LatexCommand[] = [];
    const headings: LatexHeading[] = [];
    const environments: LatexEnvironment[] = [];
    const stack: OpenEnvironment[] = [];
    const dollarDelimiters: Array<LatexRange & { display: boolean }> = [];

    let cursor = 0;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "%" && !isEscapedLatex(source, cursor)) {
        const newline = source.indexOf("\n", cursor + 1);
        const to = newline < 0 ? source.length : newline;
        comments.push({ from: cursor, to });
        cursor = to;
        continue;
      }
      if (char !== "\\") {
        if (char === "$" && !isEscapedLatex(source, cursor)) {
          const display = source[cursor + 1] === "$";
          dollarDelimiters.push({ from: cursor, to: cursor + (display ? 2 : 1), display });
          cursor += display ? 2 : 1;
          continue;
        }
        cursor += 1;
        continue;
      }

      const control = parseControlSequence(source, cursor);
      if (!control) {
        cursor += 1;
        continue;
      }
      const command: LatexCommand = {
        from: cursor,
        to: control.controlTo,
        name: control.name,
        controlTo: control.controlTo,
        starred: control.starred,
        optionalArguments: [],
        requiredArguments: [],
      };

      // Inline verbatim is bounded by its literal delimiter and cannot cross
      // a newline. Tags, percent signs and math delimiters inside it are text.
      if (control.name === "verb") {
        const delimiter = source[control.controlTo];
        if (delimiter && !/\s/.test(delimiter)) {
          const newline = source.indexOf("\n", control.controlTo + 1);
          const lineEnd = newline < 0 ? source.length : newline;
          const close = source.indexOf(delimiter, control.controlTo + 1);
          command.to = close >= 0 && close < lineEnd ? close + 1 : lineEnd;
          commands.push(command);
          rawRanges.push({ from: cursor, to: command.to });
          cursor = command.to;
          continue;
        }
      }

      if (control.name === "begin" || control.name === "end") {
        const envArguments = readFollowingArguments(source, control.controlTo, 1);
        const nameArgument = envArguments.required[0];
        if (!nameArgument) {
          commands.push(command);
          cursor = control.controlTo;
          continue;
        }
        const name = canonicalMathEnvironmentName(nameArgument.value);
        const afterName = readFollowingArguments(source, nameArgument.to, control.name === "begin" && name === "frame" ? 1 : 0);
        command.requiredArguments = [nameArgument, ...afterName.required];
        command.optionalArguments = afterName.optional;
        command.to = afterName.to;
        commands.push(command);

        if (control.name === "begin") {
          const beginTo = afterName.to;
          if (LATEX_RAW_ENVIRONMENTS.has(name)) {
            const endMarker = `\\end{${name}}`;
            const endFrom = source.indexOf(endMarker, beginTo);
            const endTo = endFrom < 0 ? source.length : endFrom + endMarker.length;
            environments.push({
              name,
              from: cursor,
              to: endTo,
              beginFrom: cursor,
              beginTo,
              bodyFrom: beginTo,
              bodyTo: endFrom < 0 ? source.length : endFrom,
              endFrom: endFrom < 0 ? source.length : endFrom,
              endTo,
              optionalArguments: afterName.optional,
              closed: endFrom >= 0,
            });
            rawRanges.push({ from: cursor, to: endTo });
            cursor = endTo;
            continue;
          }
          stack.push({ name, beginFrom: cursor, beginTo, bodyFrom: beginTo, optionalArguments: afterName.optional });
        } else {
          let openIndex = stack.length - 1;
          while (openIndex >= 0 && stack[openIndex].name !== name) openIndex -= 1;
          if (openIndex >= 0) {
            const opened = stack[openIndex];
            stack.splice(openIndex, 1);
            environments.push({
              name,
              from: opened.beginFrom,
              to: command.to,
              beginFrom: opened.beginFrom,
              beginTo: opened.beginTo,
              bodyFrom: opened.bodyFrom,
              bodyTo: cursor,
              endFrom: cursor,
              endTo: command.to,
              optionalArguments: opened.optionalArguments,
              closed: true,
            });
          }
        }
        cursor = Math.max(control.controlTo, command.to);
        continue;
      }

      if (HEADING_COMMANDS.has(control.name as LatexHeading["command"])) {
        const args = readFollowingArguments(source, control.controlTo, 1);
        const title = args.required[0];
        if (title) {
          command.optionalArguments = args.optional;
          command.requiredArguments = [title];
          command.to = title.to;
          headings.push({
            command: control.name as LatexHeading["command"],
            from: cursor,
            to: title.to,
            commandTo: title.contentFrom,
            starred: control.starred,
            shortTitle: args.optional[0] ?? null,
            title,
          });
        }
      } else if (control.name === "item") {
        const args = readFollowingArguments(source, control.controlTo, 0);
        command.optionalArguments = args.optional;
        command.to = args.optional.at(-1)?.to ?? control.controlTo;
      } else if (INDEXED_ARGUMENT_COMMANDS.has(control.name)) {
        const args = readFollowingArguments(
          source,
          control.controlTo,
          THREE_ARGUMENT_COMMANDS.has(control.name)
            ? 3
            : TWO_ARGUMENT_COMMANDS.has(control.name) ? 2 : control.name === "\\" ? 0 : 1,
        );
        command.optionalArguments = args.optional;
        command.requiredArguments = args.required;
        command.to = args.required.at(-1)?.to ?? args.optional.at(-1)?.to ?? control.controlTo;
      }
      commands.push(command);
      cursor = control.controlTo;
    }

    for (const opened of stack) {
      environments.push({
        name: opened.name,
        from: opened.beginFrom,
        to: source.length,
        beginFrom: opened.beginFrom,
        beginTo: opened.beginTo,
        bodyFrom: opened.bodyFrom,
        bodyTo: source.length,
        endFrom: source.length,
        endTo: source.length,
        optionalArguments: opened.optionalArguments,
        closed: false,
      });
    }

    environments.sort((left, right) => left.from - right.from || right.to - left.to);
    commands.sort((left, right) => left.from - right.from);
    headings.sort((left, right) => left.from - right.from);
    this.comments = comments;
    this.rawRanges = rawRanges;
    this.ignoredRanges = mergeRanges([...comments, ...rawRanges]);
    this.commands = commands;
    this.headings = headings;
    this.environments = environments;
    this.rebuildQueryIndexes();
    const mathRanges: LatexRange[] = [];
    const dollarOpen = new Map<boolean, LatexRange>();
    for (const delimiter of dollarDelimiters) {
      const opened = dollarOpen.get(delimiter.display);
      if (!opened) {
        dollarOpen.set(delimiter.display, delimiter);
        continue;
      }
      if (!delimiter.display && !inlineMathMayContinue(source.slice(opened.to, delimiter.from))) {
        dollarOpen.set(false, delimiter);
        continue;
      }
      mathRanges.push({ from: opened.from, to: delimiter.to });
      dollarOpen.delete(delimiter.display);
    }
    for (const [openName, closeName] of [["[", "]"], ["(", ")"]] as const) {
      let opened: LatexCommand | null = null;
      for (const command of commands) {
        if (command.name === openName) opened = command;
        else if (command.name === closeName && opened) {
          mathRanges.push({ from: opened.from, to: command.to });
          opened = null;
        }
      }
    }
    this.mathRanges = mergeRanges(mathRanges);

    const document = environments.find((environment) => environment.name === "document");
    this.bodyStart = document?.bodyFrom ?? 0;
    this.scanEnd = document?.bodyTo ?? source.length;
  }

  private rebuildQueryIndexes(): void {
    this.commandsByName = new Map();
    for (const command of this.commands) {
      const named = this.commandsByName.get(command.name);
      if (named) named.push(command);
      else this.commandsByName.set(command.name, [command]);
    }
    this.environmentsByName = new Map();
    for (const environment of this.environments) {
      const named = this.environmentsByName.get(environment.name);
      if (named) named.push(environment);
      else this.environmentsByName.set(environment.name, [environment]);
    }
    // Environments emitted by the scanner are properly nested for valid TeX.
    // Materialise that hierarchy once so point lookups are O(depth log siblings)
    // rather than a full environment-array scan for every list item/cursor.
    this.environmentRoots = [];
    this.environmentChildren = new Map();
    const environmentStack: LatexEnvironment[] = [];
    for (const environment of this.environments) {
      while (environmentStack.length > 0) {
        const parent = environmentStack[environmentStack.length - 1];
        if (parent.from <= environment.from && parent.to >= environment.to) break;
        environmentStack.pop();
      }
      const parent = environmentStack[environmentStack.length - 1];
      const siblings = parent
        ? this.environmentChildren.get(parent) ?? []
        : this.environmentRoots;
      siblings.push(environment);
      if (parent && !this.environmentChildren.has(parent)) this.environmentChildren.set(parent, siblings);
      environmentStack.push(environment);
    }
  }

  static fromMappedSource(source: string, values: {
    comments: LatexRange[];
    rawRanges: LatexRange[];
    commands: LatexCommand[];
    headings: LatexHeading[];
    environments: LatexEnvironment[];
    mathRanges: LatexRange[];
  }): LatexStructureIndex {
    const structure = Object.create(LatexStructureIndex.prototype) as LatexStructureIndex;
    Object.assign(structure, {
      source,
      comments: values.comments,
      rawRanges: values.rawRanges,
      ignoredRanges: mergeRanges([...values.comments, ...values.rawRanges]),
      commands: values.commands,
      headings: values.headings,
      environments: values.environments,
      mathRanges: mergeRanges(values.mathRanges),
      bodyStart: values.environments.find((environment) => environment.name === "document")?.bodyFrom ?? 0,
      scanEnd: values.environments.find((environment) => environment.name === "document")?.bodyTo ?? source.length,
      lineStarts: null,
    });
    structure.rebuildQueryIndexes();
    return structure;
  }

  isIgnored(position: number): boolean {
    return rangeContains(this.ignoredRanges, position);
  }

  isComment(position: number): boolean {
    return rangeContains(this.comments, position);
  }

  isRaw(position: number): boolean {
    return rangeContains(this.rawRanges, position);
  }

  isMath(position: number): boolean {
    if (rangeContains(this.mathRanges, position)) return true;
    return Boolean(this.environmentAt(position, MATH_ENVIRONMENT_NAMES));
  }

  environmentsNamed(names: ReadonlySet<string>): LatexEnvironment[] {
    const matches: LatexEnvironment[] = [];
    for (const name of names) matches.push(...(this.environmentsByName.get(name) ?? []));
    return matches.sort((left, right) => left.from - right.from || right.to - left.to);
  }

  environmentAt(position: number, names?: ReadonlySet<string>): LatexEnvironment | null {
    const path: LatexEnvironment[] = [];
    let siblings = this.environmentRoots;
    while (siblings.length > 0) {
      let low = 0;
      let high = siblings.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (siblings[middle].from <= position) low = middle + 1;
        else high = middle;
      }
      const candidate = siblings[low - 1];
      if (!candidate || position < candidate.bodyFrom || position > candidate.bodyTo) break;
      path.push(candidate);
      siblings = this.environmentChildren.get(candidate) ?? [];
    }
    for (let index = path.length - 1; index >= 0; index -= 1) {
      if (!names || names.has(path[index].name)) return path[index];
    }
    return null;
  }

  commandsNamed(name: string): LatexCommand[] {
    return this.commandsByName.get(name) ?? [];
  }

  private ensureLineStarts(): number[] {
    if (!this.lineStarts) {
      this.lineStarts = [0];
      for (let newline = this.source.indexOf("\n"); newline >= 0; newline = this.source.indexOf("\n", newline + 1)) {
        this.lineStarts.push(newline + 1);
      }
    }
    return this.lineStarts;
  }

  /** One lazy line index shared by outline and Beamer derivations. */
  lineNumberAt(position: number): number {
    const lineStarts = this.ensureLineStarts();
    const safePosition = Math.max(0, Math.min(position, this.source.length));
    let low = 0;
    let high = lineStarts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= safePosition) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  }

  lineStartAt(position: number): number {
    const lineStarts = this.ensureLineStarts();
    return lineStarts[this.lineNumberAt(position) - 1] ?? 0;
  }
}

export type LatexChangeSet = {
  mapPos: (position: number, assoc?: number) => number;
  iterChanges: (visit: (
    fromA: number,
    toA: number,
    fromB: number,
    toB: number,
    inserted: { toString(): string },
  ) => void) => void;
};

function cacheLatexStructure(source: string, structure: LatexStructureIndex): LatexStructureIndex {
  const replaced = structureCache.get(source);
  if (replaced) cachedSourceCharacters -= source.length;
  structureCache.delete(source);
  structureCache.set(source, structure);
  cachedSourceCharacters += source.length;
  while (
    structureCache.size > MAX_CACHED_STRUCTURES
    || (cachedSourceCharacters > MAX_CACHED_SOURCE_CHARACTERS && structureCache.size > 1)
  ) {
    const oldest = structureCache.entries().next().value as [string, LatexStructureIndex] | undefined;
    if (!oldest) break;
    structureCache.delete(oldest[0]);
    cachedSourceCharacters -= oldest[0].length;
  }
  return structure;
}

/**
 * Maps an existing structural index through ordinary prose edits. TeX syntax
 * edits deliberately fall back to the full scanner after the shared idle
 * window; letters, spaces and line breaks in prose/arguments take this fast
 * path and never rescan the document text.
 */
/** Each index's longest control word, so the prose check can bound its search. */
const controlWordSpans = new WeakMap<LatexStructureIndex, number>();

function longestControlWord(structure: LatexStructureIndex): number {
  let span = controlWordSpans.get(structure);
  if (span === undefined) {
    span = 0;
    for (const command of structure.commands) span = Math.max(span, command.controlTo - command.from);
    controlWordSpans.set(structure, span);
  }
  return span;
}

/** One replaced range of an edit, with the text it removed and inserted. */
export type LatexEdit = { fromA: number; toA: number; removed: string; inserted: string };

/**
 * Whether edits leave the TeX structure as it was: letters, spaces and line
 * breaks in prose or arguments. `toStructure` maps a position of the edited
 * text back into `previous`'s own text, for an index that is behind by
 * prose-only edits (which move positions but cannot add or remove syntax).
 */
export function latexEditsKeepStructure(
  previous: LatexStructureIndex,
  edits: readonly LatexEdit[],
  toStructure?: (position: number, assoc: -1 | 1) => number,
): boolean {
  for (const edit of edits) {
    if (/[\\%${}\[\]*]/.test(edit.removed) || /[\\%${}\[\]*]/.test(edit.inserted)) return false;
    const fromA = toStructure ? toStructure(edit.fromA, -1) : edit.fromA;
    const toA = toStructure ? toStructure(edit.toA, 1) : edit.toA;
    // Editing a control-sequence name (including inserting a letter at its end)
    // changes how TeX tokenises all following characters. Commands are in
    // document order and a control word is short, so only the few starting
    // just before the edit can reach it — a binary search, not a scan of
    // every command per keystroke.
    const commands = previous.commands;
    const reach = longestControlWord(previous);
    let low = 0;
    let high = commands.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (commands[middle].from <= toA) low = middle + 1;
      else high = middle;
    }
    for (let index = low - 1; index >= 0 && commands[index].from >= fromA - reach; index -= 1) {
      const command = commands[index];
      if (fromA <= command.controlTo && toA >= command.from) return false;
    }
    // Inline verbatim has arbitrary literal delimiters, so edits anywhere in
    // it need a rescan; environment names determine nesting and raw/math/list
    // behaviour. Both are short lists by name.
    if (previous.commandsNamed("verb").some((command) => fromA <= command.to && toA >= command.from)) return false;
    for (const name of ["begin", "end"]) {
      if (previous.commandsNamed(name).some((command) => {
        const argument = command.requiredArguments[0];
        return Boolean(argument && fromA <= argument.contentTo && toA >= argument.contentFrom);
      })) return false;
    }
    const changesLineShape = edit.removed.includes("\n") || edit.inserted.includes("\n");
    if (changesLineShape) {
      const touchesComment = previous.comments.some((comment) => fromA <= comment.to && toA >= comment.from);
      const touchesInlineMath = previous.mathRanges.some((range) => (
        previous.source[range.from] === "$"
        && previous.source[range.from + 1] !== "$"
        && fromA <= range.to
        && toA >= range.from
      ));
      if (touchesComment || touchesInlineMath) return false;
    }
  }
  return true;
}

export function updateLatexStructure(
  previous: LatexStructureIndex,
  source: string,
  changes: LatexChangeSet,
): LatexStructureIndex | null {
  if (previous.source === source) return previous;
  const edits: LatexEdit[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    edits.push({ fromA, toA, removed: previous.source.slice(fromA, toA), inserted: inserted.toString() });
  });
  if (!latexEditsKeepStructure(previous, edits)) return null;

  const mapRange = <T extends LatexRange>(range: T): T => ({
    ...range,
    from: changes.mapPos(range.from, -1),
    to: changes.mapPos(range.to, 1),
  });
  const mapArgument = (argument: LatexArgument): LatexArgument => {
    const mapped = {
      ...mapRange(argument),
      contentFrom: changes.mapPos(argument.contentFrom, -1),
      contentTo: changes.mapPos(argument.contentTo, 1),
      value: "",
    };
    mapped.value = source.slice(mapped.contentFrom, mapped.contentTo);
    return mapped;
  };
  const mapCommand = (command: LatexCommand): LatexCommand => ({
    ...mapRange(command),
    controlTo: changes.mapPos(command.controlTo, 1),
    optionalArguments: command.optionalArguments.map(mapArgument),
    requiredArguments: command.requiredArguments.map(mapArgument),
  });
  const mapHeading = (heading: LatexHeading): LatexHeading => ({
    ...mapRange(heading),
    commandTo: changes.mapPos(heading.commandTo, 1),
    shortTitle: heading.shortTitle ? mapArgument(heading.shortTitle) : null,
    title: mapArgument(heading.title),
  });
  const mapEnvironment = (environment: LatexEnvironment): LatexEnvironment => ({
    ...mapRange(environment),
    beginFrom: changes.mapPos(environment.beginFrom, -1),
    beginTo: changes.mapPos(environment.beginTo, 1),
    bodyFrom: changes.mapPos(environment.bodyFrom, -1),
    bodyTo: changes.mapPos(environment.bodyTo, 1),
    endFrom: changes.mapPos(environment.endFrom, -1),
    endTo: changes.mapPos(environment.endTo, 1),
    optionalArguments: environment.optionalArguments.map(mapArgument),
  });
  return cacheLatexStructure(source, LatexStructureIndex.fromMappedSource(source, {
    comments: previous.comments.map(mapRange),
    rawRanges: previous.rawRanges.map(mapRange),
    commands: previous.commands.map(mapCommand),
    headings: previous.headings.map(mapHeading),
    environments: previous.environments.map(mapEnvironment),
    mathRanges: previous.mathRanges.map(mapRange),
  }));
}

export function scanLatexStructure(source: string): LatexStructureIndex {
  const cached = structureCache.get(source);
  if (cached) {
    // Refresh insertion order so the cache behaves as a bounded LRU.
    structureCache.delete(source);
    structureCache.set(source, cached);
    return cached;
  }
  return cacheLatexStructure(source, new LatexStructureIndex(source));
}

/** Test/support hook for document changes that must release every cached index. */
export function clearLatexStructureCache(): void {
  structureCache.clear();
  cachedSourceCharacters = 0;
}
