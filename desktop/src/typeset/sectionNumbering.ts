/**
 * The one implementation of "what number does LaTeX print in front of this
 * heading".
 *
 * Two surfaces show heading numbers — the Outline panel (through
 * `outlineModel.ts`) and the Visual editor's inline heading numbers (through
 * `visualDecorations.ts`). Each used to count headings on its own, from 1, over
 * whatever file happened to be open, so an `\\input` chapter of a thesis
 * rendered "1.2.1" beside a PDF that says "2.2.1". Both now run this engine,
 * and the Visual editor is seeded with the counter state the document has
 * reached where the open file is pulled in (`numberingPrefixFor`), so neither
 * surface can drift from the other or from the compiled PDF.
 *
 * Pure functions only: no CodeMirror, no React, no file access.
 */

import type { LatexCommand } from "./latexStructure";

/** Absolute LaTeX sectioning depth — `\\part` is shallowest. Counters are
 * indexed by this rank, so `counters[SECTION_RANKS.chapter]` reads directly. */
export const SECTION_RANKS = {
  part: 1,
  chapter: 2,
  section: 3,
  subsection: 4,
  subsubsection: 5,
  paragraph: 6,
  subparagraph: 7,
} as const;

export type SectionCommand = keyof typeof SECTION_RANKS;

const SECTION_COMMANDS = new Set<string>(Object.keys(SECTION_RANKS));
const MAX_SECTION_RANK = SECTION_RANKS.subparagraph;

// LaTeX numbers a heading when its `secnumdepth` rank is within the counter of
// the same name: chapter is 0, section 1, … subparagraph 5, and \part is -1.
// Our ranks start at \part = 1, hence the offset.
export const SECNUMDEPTH_RANK_OFFSET = 2;
// Class defaults: article-likes number down to \subsubsection, book/report only
// to \subsection. Rather than keep a class list that custom thesis classes
// would fall out of, a document that uses \chapter at all is treated as
// book-like — which is what those classes are.
export const SECNUMDEPTH_FLAT = 3;
export const SECNUMDEPTH_CHAPTERED = 2;

/** Division switches that change how the rest of the document is numbered:
 * `\frontmatter`/`\backmatter` drop chapter numbers, `\mainmatter` restores
 * them, and `\appendix` restarts the top level as A, B, C. */
export const SECTION_MATTER_COMMANDS = new Set(["appendix", "frontmatter", "mainmatter", "backmatter"]);
export type SectionMatter = "appendix" | "frontmatter" | "mainmatter" | "backmatter";

/** Document-wide facts that don't change while walking the headings. */
export type SectionNumberingRules = {
  secnumdepth: number;
  /** A `\part` opens a division but does not prefix the units below it — LaTeX
   * keeps counting chapters straight through Part II — so when the document has
   * parts the printed number starts at the chapter counter instead. */
  hasParts: boolean;
  /** Drives display depth, not the number: in a chaptered document a
   * `\section` is a second-level heading even in a file that holds no
   * `\chapter` of its own. */
  hasChapters: boolean;
};

/** An explicit `\setcounter{chapter}{1}` / `\addtocounter{section}{2}`. The
 * dual-mode chapter file (`\ifdefined\THESISMAIN … \setcounter{chapter}{1}`)
 * is the reason a standalone chapter compile prints "Chapter 2", and without
 * this the editor was the only place that still said "Chapter 1". */
export type SectionCounterReset = {
  rank: number;
  value: number;
  mode: "set" | "add";
  /** Which file the command lives in, so a prefix walk can stop before
   * re-applying the open file's own resets (the Visual editor replays those
   * itself, live, from the text being typed). */
  file?: string | null;
};

export type SectionNumberingState = {
  /** Indexed by rank; index 0 is unused. */
  counters: number[];
  appendix: boolean;
  /** `\appendix` restarts the counters once, at the first heading after it. */
  appendixStarted: boolean;
  /** False between `\frontmatter`/`\backmatter` and `\mainmatter`. */
  numbered: boolean;
};

export function initialSectionNumberingState(): SectionNumberingState {
  return {
    counters: new Array<number>(MAX_SECTION_RANK + 1).fill(0),
    appendix: false,
    appendixStarted: false,
    numbered: true,
  };
}

export function cloneSectionNumberingState(state: SectionNumberingState): SectionNumberingState {
  return { ...state, counters: [...state.counters] };
}

export function applySectionMatter(state: SectionNumberingState, matter: SectionMatter): void {
  if (matter === "appendix") {
    state.appendix = true;
    return;
  }
  state.numbered = matter === "mainmatter";
  state.appendix = false;
}

/** `\setcounter` assigns; it does not reset the counters below it (LaTeX only
 * does that when the counter is stepped), so neither do we. */
export function applySectionCounterReset(state: SectionNumberingState, reset: SectionCounterReset): void {
  if (reset.rank < 1 || reset.rank > MAX_SECTION_RANK) return;
  const current = state.counters[reset.rank] ?? 0;
  state.counters[reset.rank] = reset.mode === "add" ? current + reset.value : reset.value;
}

/** Reads a `\setcounter`/`\addtocounter` call, ignoring every counter that
 * isn't a sectioning unit — `secnumdepth`, `figure`, `MaxMatrixCols` and the
 * rest have nothing to do with heading numbers. */
export function sectionCounterResetFor(command: LatexCommand): SectionCounterReset | null {
  if (command.name !== "setcounter" && command.name !== "addtocounter") return null;
  const counter = command.requiredArguments[0]?.value.trim();
  const rawValue = command.requiredArguments[1]?.value.trim();
  if (!counter || !SECTION_COMMANDS.has(counter) || !rawValue) return null;
  if (!/^-?\d+$/.test(rawValue)) return null;
  return {
    rank: SECTION_RANKS[counter as SectionCommand],
    value: Number(rawValue),
    mode: command.name === "addtocounter" ? "add" : "set",
  };
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

/** Whether LaTeX prints a number for this heading at all. Starred and
 * past-`secnumdepth` headings carry none — and, exactly like LaTeX, don't
 * advance the counter either. */
export function sectionIsNumbered(
  state: SectionNumberingState,
  heading: { rank: number; starred: boolean },
  rules: SectionNumberingRules,
): boolean {
  if (heading.starred || !state.numbered) return false;
  return heading.rank - SECNUMDEPTH_RANK_OFFSET <= rules.secnumdepth;
}

/**
 * Advances `state` past one heading and returns the number the PDF prints
 * (empty when the heading carries none). Mutates `state` so a caller can walk
 * a document in one pass.
 */
export function advanceSectionNumber(
  state: SectionNumberingState,
  heading: { rank: number; starred: boolean },
  rules: SectionNumberingRules,
): string {
  if (!sectionIsNumbered(state, heading, rules)) return "";
  if (state.appendix && !state.appendixStarted) {
    state.counters.fill(0);
    state.appendixStarted = true;
  }
  const rank = Math.max(1, Math.min(MAX_SECTION_RANK, heading.rank));
  state.counters[rank] = (state.counters[rank] ?? 0) + 1;
  if (rank === SECTION_RANKS.part) {
    // A part opens a division but resets nothing below it — LaTeX keeps
    // counting chapters straight through, so Part II is followed by Chapter 2.
    return romanNumeral(state.counters[rank]);
  }
  for (let deeper = rank + 1; deeper <= MAX_SECTION_RANK; deeper += 1) state.counters[deeper] = 0;

  const start = rules.hasParts ? SECTION_RANKS.chapter : SECTION_RANKS.part;
  const digits: number[] = [];
  for (let scan = Math.min(start, rank); scan <= rank; scan += 1) digits.push(state.counters[scan] ?? 0);
  // A document may open with unchaptered front matter, or be an article that
  // never uses the levels above \section. Those counters are still 0, and LaTeX's
  // literal "0.1" is noise in an editor, so the leading zeros are dropped.
  // Interior zeros are kept: a \subsection directly under a \chapter really does
  // print "1.0.1".
  while (digits.length > 1 && digits[0] === 0) digits.shift();
  return state.appendix
    ? [appendixLabel(digits[0]), ...digits.slice(1)].join(".")
    : digits.join(".");
}

/** Display depth (1 = flush left) for the heading styles both surfaces share:
 * `\part` and `\chapter` are the top level, and everything below shifts down a
 * step in a chaptered document. */
export function sectionDisplayLevel(rank: number, rules: Pick<SectionNumberingRules, "hasChapters">): number {
  if (rank <= SECTION_RANKS.chapter) return 1;
  return Math.min(4, rank - SECTION_RANKS.chapter + (rules.hasChapters ? 1 : 0));
}
