/**
 * The document-outline model: how a LaTeX project's headings are found,
 * resolved across `\\input` boundaries, nested, and numbered the way the
 * compiled PDF numbers them. Pure functions only — the panel that renders them
 * lives in `TypesetOutlinePanel.tsx`, and the workbench that loads the file
 * graph in `Typeset.tsx`.
 */

import { dirname, normalizePath, sameWorkspacePath, stripInlineMarkup } from "./latexText";
import { scanLatexStructure, type LatexEnvironment, type LatexStructureIndex } from "./latexStructure";
import {
  SECNUMDEPTH_CHAPTERED,
  SECNUMDEPTH_FLAT,
  SECNUMDEPTH_RANK_OFFSET,
  SECTION_MATTER_COMMANDS,
  SECTION_RANKS,
  advanceSectionNumber,
  applySectionCounterReset,
  cloneSectionNumberingState,
  initialSectionNumberingState,
  sectionCounterResetFor,
  type SectionCounterReset,
  type SectionMatter,
  type SectionNumberingRules,
  type SectionNumberingState,
} from "./sectionNumbering";

export { appendixLabel, romanNumeral } from "./sectionNumbering";

/** `file` is the document the heading physically lives in — the open file for
 * its own headings, an `\\input`/`\\include` target for the rest. `numbered` and
 * `appendix` carry LaTeX's own numbering rules (starred headings and run-in
 * `\\paragraph`s get no number; `\\appendix` restarts the top level at A). */
export type OutlineItem = {
  line: number;
  /** Display depth after nesting (1 = flush left). */
  level: number;
  /** Absolute sectioning rank (\\part = 1 … \\subparagraph = 7), kept because
   * numbering rules are stated in terms of the command, not the indent. */
  rank: number;
  title: string;
  file: string | null;
  numbered: boolean;
  appendix: boolean;
  /** The `\\frontmatter`/`\\mainmatter` division in effect here, kept apart from
   * `numbered` (which also folds in starred headings and `secnumdepth`) so a
   * file's numbering can be seeded without a leading `\\chapter*` switching the
   * whole file to unnumbered. */
  mainMatter?: boolean;
  /** `\\setcounter`/`\\addtocounter` calls that sit between the previous heading
   * and this one, applied before this heading steps its own counter — exactly
   * where LaTeX applies them. */
  counterResets?: SectionCounterReset[];
};

export type NumberedOutlineItem = OutlineItem & { number: string };

export type BeamerSlide = { line: number; endLine: number; title: string };
export type BeamerDocumentSlide = BeamerSlide & { file: string | null };

// Absolute LaTeX sectioning depth (\part is shallowest). The outline stores
// these raw ranks so nesting is unambiguous, then normalizes them for display
// (see `normalizeOutlineLevels`) so the shallowest heading a document actually
// uses renders flush-left regardless of class — \section is top-level in an
// article, \chapter in a report/book.
export const OUTLINE_HEADING_LEVELS: Record<string, number> = SECTION_RANKS;

// A sectioning command at the start of a (trimmed) line, tolerating the starred
// form (\section*). Arguments are read from the full source afterwards rather
// than matched here, because a real thesis wraps long titles across lines
// (`\section[Short]{Long title\nrest}`) and a line-scoped match drops those.
export const OUTLINE_HEADING_RE = /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)/;

// Numbering rules themselves live in `sectionNumbering.ts`, shared with the
// Visual editor; these aliases keep the outline's existing vocabulary.
export const OUTLINE_SECNUMDEPTH_OFFSET = SECNUMDEPTH_RANK_OFFSET;
export const OUTLINE_SECNUMDEPTH_FLAT = SECNUMDEPTH_FLAT;
export const OUTLINE_SECNUMDEPTH_CHAPTERED = SECNUMDEPTH_CHAPTERED;

// Division switches that change how the rest of the document is numbered:
// \frontmatter/\backmatter drop chapter numbers, \mainmatter restores them, and
// \appendix restarts the top level as A, B, C.
export const OUTLINE_MATTER_RE = /^\\(appendix|frontmatter|mainmatter|backmatter)\b/;

// Keep the document graph aligned with the Rust compile-root resolver. Ordinary
// TeX includes are resolved from the compile root first; import-package commands
// carry an explicit directory and resolve from the including source first.
export const OUTLINE_INCLUDE_RE = /^\\(input|include|subfile|subfileinclude)\s*\{([^{}]+)\}/;
export const OUTLINE_IMPORT_RE = /^\\(import|subimport)\s*\{([^{}]+)\}\s*\{([^{}]+)\}/;

// A `\section` inside verbatim-like or commented-out bodies is sample text, not
// a heading.
export const OUTLINE_SKIP_ENVIRONMENTS = new Set(["verbatim", "lstlisting", "minted", "comment"]);

export const INCLUDE_MAX_FILES = 512;

export type OutlineIncludeCommand = "input" | "include" | "subfile" | "subfileinclude" | "import" | "subimport";

export type OutlineScanNode =
  | { kind: "heading"; line: number; level: number; title: string; numbered: boolean }
  | { kind: "matter"; line: number; matter: SectionMatter }
  | { kind: "counter"; line: number; reset: SectionCounterReset }
  | { kind: "include"; line: number; command: OutlineIncludeCommand; directory?: string; target: string };

const outlineNodeCache = new WeakMap<LatexStructureIndex, OutlineScanNode[]>();

/** Reads the brace-balanced argument beginning at `braceIndex` (a `{`), so a
 * title with nested groups like `\section{A \textbf{B}}` isn't truncated at the
 * first `}` the way a non-greedy `{(.+?)}` capture would be. */
export function balancedBraceArg(text: string, braceIndex: number): string | null {
  if (text[braceIndex] !== "{") return null;
  let depth = 0;
  for (let index = braceIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(braceIndex + 1, index);
    }
  }
  return null;
}

/** Skips whitespace and an optional `[...]` argument starting at `index`, and
 * returns the index of the mandatory `{` that follows (null when the command
 * turns out not to take a brace argument here). */
export function headingArgStart(source: string, index: number): number | null {
  let cursor = index;
  const skipSpace = () => {
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  };
  skipSpace();
  if (source[cursor] === "[") {
    let depth = 0;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "[") depth += 1;
      else if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          break;
        }
      }
      cursor += 1;
    }
    skipSpace();
  }
  return source[cursor] === "{" ? cursor : null;
}

/** Outline titles are plain text: drop the label a heading often carries, take
 * the PDF half of \texorpdfstring, unwrap font commands, and flatten the line
 * breaks a wrapped title inherits from the source. */
export function cleanHeadingTitle(raw: string): string {
  return raw
    .replace(/\\label\s*\{[^{}]*\}/g, " ")
    .replace(/\\texorpdfstring\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:textbf|textit|textrm|textnormal|texttt|textsc|emph|mbox|underline)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Walks the source once and reports headings and include directives in
 * document order. Arguments are read from the whole source, not a single line,
 * so a title wrapped across lines survives; verbatim-like bodies are skipped so
 * their sample `\section`s don't become headings. */
export function scanOutlineNodes(source: string): OutlineScanNode[] {
  const structure = scanLatexStructure(source);
  const cached = outlineNodeCache.get(structure);
  if (cached) return cached;
  const positionedNodes: Array<OutlineScanNode & { at: number }> = [];
  const inLeadingWhitespace = (position: number) => source.slice(structure.lineStartAt(position), position).trim().length === 0;
  for (const heading of structure.headings) {
    // Preserve the outline's long-standing rule that sectioning commands must
    // begin a source line. This excludes examples nested in macro arguments
    // while still using the shared balanced parser for the real title.
    if (!inLeadingWhitespace(heading.from)) continue;
    const title = cleanHeadingTitle(heading.title.value);
    if (!title) continue;
    positionedNodes.push({
      at: heading.from,
      kind: "heading",
      line: structure.lineNumberAt(heading.from),
      level: OUTLINE_HEADING_LEVELS[heading.command] ?? OUTLINE_HEADING_LEVELS.section,
      title,
      numbered: !heading.starred,
    });
  }
  const includeCommands = new Set<OutlineIncludeCommand>(["input", "include", "subfile", "subfileinclude", "import", "subimport"]);
  for (const command of structure.commands) {
    if (!inLeadingWhitespace(command.from)) continue;
    if (SECTION_MATTER_COMMANDS.has(command.name)) {
      positionedNodes.push({
        at: command.from,
        kind: "matter",
        line: structure.lineNumberAt(command.from),
        matter: command.name as SectionMatter,
      });
      continue;
    }
    const reset = sectionCounterResetFor(command);
    if (reset) {
      positionedNodes.push({ at: command.from, kind: "counter", line: structure.lineNumberAt(command.from), reset });
      continue;
    }
    if (!includeCommands.has(command.name as OutlineIncludeCommand)) continue;
    const imported = command.name === "import" || command.name === "subimport";
    const target = command.requiredArguments[imported ? 1 : 0]?.value;
    if (!target) continue;
    positionedNodes.push({
      at: command.from,
      kind: "include",
      line: structure.lineNumberAt(command.from),
      command: command.name as OutlineIncludeCommand,
      directory: imported ? command.requiredArguments[0]?.value : undefined,
      target,
    });
  }
  const ordered = positionedNodes
    .sort((left, right) => left.at - right.at)
    .map(({ at: _at, ...node }) => node as OutlineScanNode);
  outlineNodeCache.set(structure, ordered);
  return ordered;
}

export function resolveTexPath(target: string, base: string, defaultExtension = ".tex"): string | null {
  const raw = target.trim().replace(/^["']|["']$/g, "");
  if (!raw || raw.includes("\\") || raw.includes("#")) return null;
  const withExtension = /\.[A-Za-z0-9]+$/.test(raw) ? raw : `${raw}${defaultExtension}`;
  const segments = normalizePath(base && !withExtension.startsWith("/") ? `${base}/${withExtension}` : withExtension).split("/");
  const parts: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/") || null;
}

/** Candidate paths in the same order the desktop compiler uses. Keeping the
 * root-relative and source-relative fallbacks lets the outline reflect the file
 * TeX will actually consume without breaking import-package projects. */
export function resolveIncludeCandidates(node: Extract<OutlineScanNode, { kind: "include" }>, fromPath: string, rootPath: string): string[] {
  const sourceDir = dirname(fromPath);
  const rootDir = dirname(rootPath);
  const importedTarget = node.directory ? `${node.directory.replace(/[\\/]?$/, "/")}${node.target}` : node.target;
  const bases = node.command === "import" || node.command === "subimport"
    ? [sourceDir, rootDir]
    : [rootDir, sourceDir];
  const candidates: string[] = [];
  for (const base of bases) {
    const resolved = resolveTexPath(importedTarget, base);
    if (
      resolved
      && !sameWorkspacePath(resolved, fromPath)
      && !candidates.some((candidate) => sameWorkspacePath(candidate, resolved))
    ) {
      candidates.push(resolved);
    }
  }
  return candidates;
}

export function includeCandidateGroupsFor(source: string, fromPath: string, rootPath: string): string[][] {
  const groups: string[][] = [];
  for (const node of scanOutlineNodes(source)) {
    if (node.kind !== "include") continue;
    const candidates = resolveIncludeCandidates(node, fromPath, rootPath);
    if (candidates.length > 0) groups.push(candidates);
  }
  return groups;
}

/** Every possible include target reachable from `source`, in compiler order. */
export function includeTargetsFor(source: string, fromPath: string, rootPath: string): string[] {
  return includeCandidateGroupsFor(source, fromPath, rootPath).flat();
}

export function documentSourceForPath(sources: Record<string, string>, path: string): { path: string; source: string } | null {
  const loadedPath = Object.keys(sources).find((candidate) => sameWorkspacePath(candidate, path));
  return loadedPath ? { path: loadedPath, source: sources[loadedPath] } : null;
}

/** Turns raw sectioning ranks into display depth with a parent stack, the way
 * Overleaf nests its outline: a heading is one step in from its nearest
 * shallower ancestor, so a chapter-less article starts flush-left and a
 * \paragraph under a \section doesn't indent by the three ranks between them. */
export function normalizeOutlineLevels(items: OutlineItem[]): OutlineItem[] {
  const openLevels: number[] = [];
  return items.map((item) => {
    while (openLevels.length > 0 && openLevels[openLevels.length - 1] >= item.level) openLevels.pop();
    openLevels.push(item.level);
    return { ...item, level: openLevels.length };
  });
}

/** Splices the outline of each included file in at the `\input` that pulls it
 * in, so the root file of a thesis lists the whole document instead of the
 * handful of headings that happen to live in the shell. */
export function expandOutline(
  source: string,
  path: string | null,
  rootPath: string | null,
  includes: Record<string, string>,
  ancestors: Set<string>,
  // Division state travels with the reading order, not the file: \mainmatter in
  // the root file governs the chapters it pulls in afterwards, and a
  // \setcounter left at the end of one chapter offsets the next one.
  matter: { numbered: boolean; appendix: boolean; pendingResets: SectionCounterReset[] },
): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const node of scanOutlineNodes(source)) {
    if (node.kind === "heading") {
      items.push({
        line: node.line,
        level: node.level,
        rank: node.level,
        title: node.title,
        file: path,
        numbered: node.numbered && matter.numbered,
        appendix: matter.appendix,
        mainMatter: matter.numbered,
        ...(matter.pendingResets.length > 0 ? { counterResets: matter.pendingResets } : {}),
      });
      matter.pendingResets = [];
      continue;
    }
    if (node.kind === "counter") {
      matter.pendingResets = [...matter.pendingResets, { ...node.reset, file: path }];
      continue;
    }
    if (node.kind === "matter") {
      if (node.matter === "appendix") matter.appendix = true;
      else {
        matter.numbered = node.matter === "mainmatter";
        matter.appendix = false;
      }
      continue;
    }
    if (!path || !rootPath) continue;
    const target = resolveIncludeCandidates(node, path, rootPath).find((candidate) => documentSourceForPath(includes, candidate));
    if (!target || [...ancestors].some((ancestor) => sameWorkspacePath(ancestor, target))) continue;
    const loaded = documentSourceForPath(includes, target);
    if (!loaded) continue;
    ancestors.add(target);
    items.push(...expandOutline(loaded.source, loaded.path, rootPath, includes, ancestors, matter));
    ancestors.delete(target);
  }
  return items;
}

export function outlineFor(source: string, path: string | null = null, includes: Record<string, string> = {}): OutlineItem[] {
  const sectionOutline = expandOutline(
    source,
    path,
    path,
    includes,
    new Set(path ? [path] : []),
    { numbered: true, appendix: false, pendingResets: [] },
  );
  if (sectionOutline.length > 0) return normalizeOutlineLevels(applySecNumDepth(sectionOutline, source));

  // Beamer decks often omit \section entirely. In that case an empty Outline
  // wastes a third of the project panel even though every frame has a useful
  // navigation title, so fall back to the frame list. Frames are siblings, so
  // they all sit flush-left at level 1.
  return beamerSlidesFor(source).map((slide) => ({
    line: slide.line,
    level: 1,
    title: slide.title,
    file: path,
    rank: OUTLINE_HEADING_LEVELS.section,
    numbered: false,
    appendix: false,
  }));
}

/** Drops the numbers LaTeX itself wouldn't print: nothing deeper than the
 * class's `secnumdepth`, which is why a book's `\subsubsection` and every
 * `\paragraph` are unnumbered in the PDF. An explicit `\setcounter` wins. */
export function applySecNumDepth(items: OutlineItem[], rootSource: string): OutlineItem[] {
  const explicit = /\\setcounter\s*\{secnumdepth\}\s*\{\s*(-?\d+)\s*\}/.exec(rootSource);
  const chaptered = items.some((item) => item.rank === OUTLINE_HEADING_LEVELS.chapter);
  const depth = explicit
    ? Number(explicit[1])
    : chaptered ? OUTLINE_SECNUMDEPTH_CHAPTERED : OUTLINE_SECNUMDEPTH_FLAT;
  return items.map((item) => (
    item.numbered && item.rank - OUTLINE_SECNUMDEPTH_OFFSET <= depth ? item : { ...item, numbered: false }
  ));
}

/** The document-wide facts the numbering engine needs, read once from the
 * expanded outline. `secnumdepth` is already folded into each item's `numbered`
 * flag by `applySecNumDepth`, so it is only restated here for the Visual
 * editor, which numbers a live buffer rather than these items. */
export function sectionNumberingRulesFor(outline: OutlineItem[], rootSource = ""): SectionNumberingRules {
  const explicit = /\\setcounter\s*\{secnumdepth\}\s*\{\s*(-?\d+)\s*\}/.exec(rootSource);
  const hasChapters = outline.some((item) => item.rank === OUTLINE_HEADING_LEVELS.chapter);
  return {
    secnumdepth: explicit
      ? Number(explicit[1])
      : hasChapters ? OUTLINE_SECNUMDEPTH_CHAPTERED : OUTLINE_SECNUMDEPTH_FLAT,
    hasParts: outline.some((item) => item.rank === OUTLINE_HEADING_LEVELS.part),
    hasChapters,
  };
}

/** Mirrors the numbers the compiled PDF prints: starred and run-in headings
 * carry none (and don't advance the counter, exactly like LaTeX), appendix
 * chapters restart at A, and an explicit `\setcounter{chapter}{1}` offsets
 * everything after it. Without this a thesis whose front matter is a run of
 * `\chapter*` reads "5 Introduction" where the PDF says "Chapter 1". */
export function numberedOutlineFor(outline: OutlineItem[]): NumberedOutlineItem[] {
  // `secnumdepth` already decided `item.numbered` in `applySecNumDepth`, so the
  // engine must not drop a heading a second time on a depth it can't see here.
  const rules: SectionNumberingRules = {
    ...sectionNumberingRulesFor(outline),
    secnumdepth: Number.POSITIVE_INFINITY,
  };
  const state = initialSectionNumberingState();
  return outline.map((item) => {
    for (const reset of item.counterResets ?? []) applySectionCounterReset(state, reset);
    // `numbered`/`appendix` are resolved per item by the outline walk, which
    // sees the \frontmatter and \appendix switches across file boundaries.
    state.numbered = item.numbered;
    if (item.appendix !== state.appendix) state.appendix = item.appendix;
    return { ...item, number: advanceSectionNumber(state, { rank: item.rank, starred: false }, rules) };
  });
}

/** What the Visual editor is seeded with so an `\input` chapter numbers its
 * headings the way the compiled PDF does. */
export type SectionNumberingPrefix = {
  /** Counter state the document has reached at `path`'s first heading. The
   * file's own `\setcounter` calls are deliberately *not* applied: the Visual
   * editor replays those from the live buffer, so typing one takes effect
   * immediately instead of waiting for the analysis snapshot. */
  state: SectionNumberingState;
  rules: SectionNumberingRules;
  /** True when the counters actually carry over from earlier files, i.e. the
   * open file is not where the document's numbering starts. */
  continued: boolean;
};

/**
 * Runs the document-order walk up to `path`'s first heading and hands back the
 * counter state in force there. Returns null when the file contributes no
 * heading of its own — there is nothing to offset, and the Visual editor falls
 * back to numbering the open buffer alone.
 */
export function numberingPrefixFor(
  outline: OutlineItem[],
  path: string | null,
  rootSource = "",
): SectionNumberingPrefix | null {
  const rules = sectionNumberingRulesFor(outline, rootSource);
  const engineRules: SectionNumberingRules = { ...rules, secnumdepth: Number.POSITIVE_INFINITY };
  const state = initialSectionNumberingState();
  for (const item of outline) {
    const own = path != null && item.file != null && sameWorkspacePath(item.file, path);
    for (const reset of item.counterResets ?? []) {
      // A reset written in the open file is the open file's business; one that
      // trailed the previous chapter still belongs to this prefix.
      if (own && reset.file != null && sameWorkspacePath(reset.file, path)) continue;
      applySectionCounterReset(state, reset);
    }
    if (!own) {
      state.numbered = item.numbered;
      state.appendix = item.appendix;
      advanceSectionNumber(state, { rank: item.rank, starred: false }, engineRules);
      continue;
    }
    state.numbered = item.mainMatter ?? true;
    state.appendix = item.appendix;
    return {
      state: cloneSectionNumberingState(state),
      rules,
      continued: state.counters.some((value) => value > 0) || state.appendix || !state.numbered,
    };
  }
  return null;
}

export function activeOutlineItemForLine(outline: NumberedOutlineItem[], line: number): NumberedOutlineItem | null {
  let active: NumberedOutlineItem | null = null;
  for (const item of outline) {
    if (item.line > line) break;
    active = item;
  }
  return active;
}

function beamerSlideForEnvironment(
  source: string,
  environment: LatexEnvironment,
  fallbackNumber: number,
  structure = scanLatexStructure(source),
): BeamerSlide {
  const begin = structure.commands.find((command) => command.name === "begin" && command.from === environment.beginFrom);
  const inlineTitle = begin?.requiredArguments[1]?.value;
  const frameTitle = structure.commands.find((command) =>
    command.name === "frametitle"
      && command.from >= environment.bodyFrom
      && command.from < environment.bodyTo,
  )?.requiredArguments[0]?.value;
  const titlePage = structure.commands.some((command) =>
    command.name === "titlepage"
      && command.from >= environment.bodyFrom
      && command.from < environment.bodyTo,
  );
  return {
    line: structure.lineNumberAt(environment.from),
    endLine: structure.lineNumberAt(environment.to),
    title: stripInlineMarkup(inlineTitle || frameTitle || (titlePage ? "Title slide" : `Slide ${fallbackNumber}`)),
  };
}

export function beamerSlidesFor(source: string): BeamerSlide[] {
  const structure = scanLatexStructure(source);
  return structure.environments
    .filter((environment) => environment.name === "frame" && environment.closed)
    .sort((left, right) => left.from - right.from)
    .map((environment, index) => beamerSlideForEnvironment(source, environment, index + 1, structure));
}

/** Expands frames in TeX include order so a local frame can address the page
 * of the root PDF instead of treating every included file as page one. */
export function beamerSlidesForDocument(
  rootSource: string,
  rootPath: string | null,
  sources: Record<string, string>,
): BeamerDocumentSlide[] {
  const slides: BeamerDocumentSlide[] = [];
  const expand = (source: string, path: string | null, ancestors: Set<string>) => {
    const structure = scanLatexStructure(source);
    const events: Array<
      | { at: number; kind: "frame"; environment: LatexEnvironment }
      | { at: number; kind: "include"; node: Extract<OutlineScanNode, { kind: "include" }> }
    > = [];
    for (const environment of structure.environments) {
      if (environment.name === "frame" && environment.closed) {
        events.push({ at: environment.from, kind: "frame", environment });
      }
    }
    const includeCommands = new Set(["input", "include", "subfile", "subfileinclude", "import", "subimport"]);
    for (const command of structure.commands) {
      if (!includeCommands.has(command.name)) continue;
      const imported = command.name === "import" || command.name === "subimport";
      const target = command.requiredArguments[imported ? 1 : 0]?.value;
      if (!target) continue;
      events.push({
        at: command.from,
        kind: "include",
        node: {
          kind: "include",
          line: structure.lineNumberAt(command.from),
          command: command.name as OutlineIncludeCommand,
          directory: imported ? command.requiredArguments[0]?.value : undefined,
          target,
        },
      });
    }
    events.sort((left, right) => left.at - right.at || (left.kind === "frame" ? -1 : 1));
    for (const event of events) {
      if (event.kind === "frame") {
        slides.push({ ...beamerSlideForEnvironment(source, event.environment, slides.length + 1, structure), file: path });
        continue;
      }
      if (!path || !rootPath) continue;
      const target = resolveIncludeCandidates(event.node, path, rootPath)
        .find((candidate) => documentSourceForPath(sources, candidate));
      if (!target || [...ancestors].some((ancestor) => sameWorkspacePath(ancestor, target))) continue;
      const loaded = documentSourceForPath(sources, target);
      if (!loaded) continue;
      ancestors.add(target);
      expand(loaded.source, loaded.path, ancestors);
      ancestors.delete(target);
    }
  };
  expand(rootSource, rootPath, new Set(rootPath ? [rootPath] : []));
  return slides;
}

export function activeBeamerSlideForLine(slides: BeamerSlide[], line: number): BeamerSlide | null {
  return slides.find((slide) => line >= slide.line && line <= slide.endLine)
    ?? [...slides].reverse().find((slide) => slide.line <= line)
    ?? slides[0]
    ?? null;
}
