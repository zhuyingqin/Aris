/**
 * The document-outline model: how a LaTeX project's headings are found,
 * resolved across `\\input` boundaries, nested, and numbered the way the
 * compiled PDF numbers them. Pure functions only — the panel that renders them
 * lives in `TypesetOutlinePanel.tsx`, and the workbench that loads the file
 * graph in `Typeset.tsx`.
 */

import { dirname, lineNumberForOffset, normalizePath, sameWorkspacePath, stripInlineMarkup } from "./latexText";

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
};

export type NumberedOutlineItem = OutlineItem & { number: string };

export type BeamerSlide = { line: number; endLine: number; title: string };

// Absolute LaTeX sectioning depth (\part is shallowest). The outline stores
// these raw ranks so nesting is unambiguous, then normalizes them for display
// (see `normalizeOutlineLevels`) so the shallowest heading a document actually
// uses renders flush-left regardless of class — \section is top-level in an
// article, \chapter in a report/book.
export const OUTLINE_HEADING_LEVELS: Record<string, number> = {
  part: 1,
  chapter: 2,
  section: 3,
  subsection: 4,
  subsubsection: 5,
  paragraph: 6,
  subparagraph: 7,
};

// A sectioning command at the start of a (trimmed) line, tolerating the starred
// form (\section*). Arguments are read from the full source afterwards rather
// than matched here, because a real thesis wraps long titles across lines
// (`\section[Short]{Long title\nrest}`) and a line-scoped match drops those.
export const OUTLINE_HEADING_RE = /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)/;

// LaTeX numbers a heading when its `secnumdepth` rank is within the counter of
// the same name: chapter is 0, section 1, … subparagraph 5, and \part is -1.
// Our ranks start at \part = 1, hence the offset.
export const OUTLINE_SECNUMDEPTH_OFFSET = 2;
// Class defaults: article-likes number down to \subsubsection, book/report only
// to \subsection. Rather than keep a class list that custom thesis classes
// would fall out of, a document that uses \chapter at all is treated as
// book-like — which is what those classes are.
export const OUTLINE_SECNUMDEPTH_FLAT = 3;
export const OUTLINE_SECNUMDEPTH_CHAPTERED = 2;

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
  | { kind: "matter"; line: number; matter: "appendix" | "frontmatter" | "mainmatter" | "backmatter" }
  | { kind: "include"; line: number; command: OutlineIncludeCommand; directory?: string; target: string };

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
  const nodes: OutlineScanNode[] = [];
  const lines = source.split("\n");
  let offset = 0;
  let skipUntilEnd: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const lineStart = offset;
    offset += raw.length + 1;
    const trimmed = raw.trim();
    if (skipUntilEnd) {
      if (trimmed.startsWith(`\\end{${skipUntilEnd}}`)) skipUntilEnd = null;
      continue;
    }
    if (!trimmed.startsWith("\\")) continue;
    const begun = /^\\begin\{([^{}]+)\}/.exec(trimmed);
    if (begun) {
      if (OUTLINE_SKIP_ENVIRONMENTS.has(begun[1])) skipUntilEnd = begun[1];
      continue;
    }
    const matter = OUTLINE_MATTER_RE.exec(trimmed);
    if (matter) {
      nodes.push({ kind: "matter", line: index + 1, matter: matter[1] as "appendix" | "frontmatter" | "mainmatter" | "backmatter" });
      continue;
    }
    const imported = OUTLINE_IMPORT_RE.exec(trimmed);
    if (imported) {
      nodes.push({
        kind: "include",
        line: index + 1,
        command: imported[1] as "import" | "subimport",
        directory: imported[2],
        target: imported[3],
      });
      continue;
    }
    const included = OUTLINE_INCLUDE_RE.exec(trimmed);
    if (included) {
      nodes.push({
        kind: "include",
        line: index + 1,
        command: included[1] as Exclude<OutlineIncludeCommand, "import" | "subimport">,
        target: included[2],
      });
      continue;
    }
    const heading = OUTLINE_HEADING_RE.exec(trimmed);
    if (!heading) continue;
    const commandStart = lineStart + (raw.length - raw.trimStart().length);
    const braceIndex = headingArgStart(source, commandStart + heading[0].length);
    if (braceIndex == null) continue;
    const title = cleanHeadingTitle(balancedBraceArg(source, braceIndex) ?? "");
    if (!title) continue;
    const level = OUTLINE_HEADING_LEVELS[heading[1]] ?? OUTLINE_HEADING_LEVELS.section;
    nodes.push({
      kind: "heading",
      line: index + 1,
      level,
      title,
      numbered: heading[2] !== "*",
    });
  }
  return nodes;
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
  // the root file governs the chapters it pulls in afterwards.
  matter: { numbered: boolean; appendix: boolean },
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
      });
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
    { numbered: true, appendix: false },
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

/** I, II, III … for `\part`, the only sectioning unit LaTeX numbers in Roman. */
export function romanNumeral(value: number): string {
  const table: readonly [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let remaining = Math.max(1, value);
  let text = "";
  for (const [amount, numeral] of table) {
    while (remaining >= amount) {
      text += numeral;
      remaining -= amount;
    }
  }
  return text;
}

/** A, B, … Z, AA — the appendix counter LaTeX prints for \appendix chapters. */
export function appendixLabel(value: number): string {
  let remaining = value;
  let label = "";
  while (remaining > 0) {
    const index = (remaining - 1) % 26;
    label = String.fromCharCode(65 + index) + label;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return label || "A";
}

/** Mirrors the numbers the compiled PDF prints: starred and run-in headings
 * carry none (and don't advance the counter, exactly like LaTeX), and appendix
 * chapters restart at A. Without this a thesis whose front matter is a run of
 * `\chapter*` reads "5 Introduction" where the PDF says "Chapter 1". */
export function numberedOutlineFor(outline: OutlineItem[]): NumberedOutlineItem[] {
  const counters: number[] = [];
  // A \part is numbered in its own Roman series and, unlike every other level,
  // does NOT prefix the units below it: LaTeX keeps counting chapters straight
  // through Part II, so its counter is dropped from their numbers.
  const partLevel = outline.find((item) => item.rank === OUTLINE_HEADING_LEVELS.part)?.level ?? null;
  let appendixStarted = false;
  return outline.map((item) => {
    if (!item.numbered) return { ...item, number: "" };
    if (item.appendix && !appendixStarted) {
      counters.length = 0;
      appendixStarted = true;
    }
    const levelIndex = Math.max(0, item.level - 1);
    counters[levelIndex] = (counters[levelIndex] ?? 0) + 1;
    if (item.rank === OUTLINE_HEADING_LEVELS.part) {
      // A part opens a division but resets nothing below it, so the deeper
      // counters survive: Part II is followed by Chapter 2, not Chapter 1.
      return { ...item, number: romanNumeral(counters[levelIndex]) };
    }
    counters.length = levelIndex + 1;
    const parts = counters.filter((value) => value > 0);
    const own = partLevel !== null && item.level > partLevel ? parts.slice(1) : parts;
    const number = item.appendix && own.length > 0
      ? [appendixLabel(own[0]), ...own.slice(1)].join(".")
      : own.join(".");
    return { ...item, number };
  });
}

export function activeOutlineItemForLine(outline: NumberedOutlineItem[], line: number): NumberedOutlineItem | null {
  let active: NumberedOutlineItem | null = null;
  for (const item of outline) {
    if (item.line > line) break;
    active = item;
  }
  return active;
}

export function beamerSlidesFor(source: string): BeamerSlide[] {
  const slides: BeamerSlide[] = [];
  const frameRe = /\\begin\{frame\}(?:\[[^\]]*\])?(?:\{([^{}\n]*)\})?([\s\S]*?)\\end\{frame\}/g;
  let match: RegExpExecArray | null;
  while ((match = frameRe.exec(source))) {
    const frameTitle = /\\frametitle\s*\{([^{}\n]*)\}/.exec(match[2] ?? "")?.[1];
    const fallbackTitle = /\\titlepage\b/.test(match[2] ?? "") ? "Title slide" : `Slide ${slides.length + 1}`;
    slides.push({
      line: lineNumberForOffset(source, match.index),
      endLine: lineNumberForOffset(source, match.index + match[0].length),
      title: stripInlineMarkup(match[1] || frameTitle || fallbackTitle),
    });
  }
  return slides;
}

export function activeBeamerSlideForLine(slides: BeamerSlide[], line: number): BeamerSlide | null {
  return slides.find((slide) => line >= slide.line && line <= slide.endLine)
    ?? [...slides].reverse().find((slide) => slide.line <= line)
    ?? slides[0]
    ?? null;
}
