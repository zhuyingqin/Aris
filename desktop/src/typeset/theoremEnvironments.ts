/**
 * What the compiled PDF prints in front of a theorem-like environment.
 *
 * `\begin{requirement}[Regime resolution (R1)]` prints
 * "Requirement 1 (Regime resolution (R1))", but `requirement` is a *user* name:
 * it only exists because the preamble said `\newtheorem{requirement}{Requirement}`.
 * The Visual editor used to know one fixed list of amsthm names, so every
 * declared environment outside it fell through to the generic "unknown
 * environment" fold — heading, number and title all disappeared from the page
 * with no way to see or edit them. This module reads the declarations instead.
 *
 * Numbers are only ever produced for environments whose declaration was
 * actually found: guessing a counter layout for an undeclared `theorem` would
 * print a number the PDF disagrees with, which is worse than printing none.
 *
 * Pure functions only: no CodeMirror, no React, no file access.
 */

export type TheoremDefinition = {
  /** Environment name as written in `\begin{…}`. */
  environment: string;
  /** Heading LaTeX prints — "Requirement", "Lemma", … */
  heading: string;
  /**
   * Counter this environment advances, which is its own name unless the
   * declaration borrowed a sibling's (`\newtheorem{lemma}[theorem]{Lemma}`).
   * `null` for the unnumbered `\newtheorem*` form.
   */
  counter: string | null;
  /** Sectioning counter the number is reset by and prefixed with, if any. */
  within: string | null;
};

/**
 * amsthm's conventional names, recognised even in a file whose preamble lives
 * elsewhere. They carry no counter: without the declaration we do not know
 * whether the document shares one counter across them, or restarts per
 * section, so they render as an unnumbered heading.
 */
export const BUILTIN_THEOREM_ENVIRONMENTS: ReadonlyMap<string, TheoremDefinition> = new Map(
  [
    "theorem",
    "lemma",
    "proposition",
    "corollary",
    "definition",
    "remark",
    "example",
    "proof",
    "assumption",
    "conjecture",
    "claim",
    "observation",
  ].map((environment) => [
    environment,
    { environment, heading: capitalize(environment), counter: null, within: null },
  ]),
);

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

type Group = { value: string; to: number };

/**
 * Read the `{…}` or `[…]` group that starts at `from` (after any whitespace),
 * counting nested delimiters and skipping escaped ones. Returns `null` when the
 * next non-space character is something else, which is how the optional groups
 * of `\newtheorem` are detected.
 */
function readGroup(source: string, from: number, open: "{" | "["): Group | null {
  let cursor = from;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  if (source[cursor] !== open) return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let scan = cursor; scan < source.length; scan += 1) {
    const char = source[scan];
    if (char === "\\") {
      scan += 1;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return { value: source.slice(cursor + 1, scan), to: scan + 1 };
    }
  }
  return null;
}

/** Split `name=Requirement, numberwithin=section` into its key/value pairs. */
function thmtoolsOptions(options: string): Map<string, string> {
  const parsed = new Map<string, string>();
  let depth = 0;
  let start = 0;
  const push = (chunk: string) => {
    const separator = chunk.indexOf("=");
    if (separator < 0) {
      const flag = chunk.trim();
      if (flag) parsed.set(flag.toLowerCase(), "");
      return;
    }
    const key = chunk.slice(0, separator).trim().toLowerCase();
    let value = chunk.slice(separator + 1).trim();
    if (value.startsWith("{") && value.endsWith("}")) value = value.slice(1, -1).trim();
    if (key) parsed.set(key, value);
  };
  for (let scan = 0; scan < options.length; scan += 1) {
    const char = options[scan];
    if (char === "\\") {
      scan += 1;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      push(options.slice(start, scan));
      start = scan + 1;
    }
  }
  push(options.slice(start));
  return parsed;
}

const DECLARATION_RE = /\\(newtheorem|declaretheorem)(\*?)/g;

/**
 * Every theorem-like environment `source` declares, in declaration order, with
 * later declarations of the same name winning the way LaTeX's would.
 *
 * Both spellings are read: amsthm's
 * `\newtheorem*?{env}[sibling]{Heading}[within]` and thmtools'
 * `\declaretheorem[name=…,sibling=…,numberwithin=…]{env,env2}`.
 *
 * `isIgnored` keeps commented-out declarations from taking effect; callers pass
 * the same comment predicate the rest of the visual layer uses.
 */
export function theoremDefinitions(
  source: string,
  isIgnored: (position: number) => boolean = () => false,
): Map<string, TheoremDefinition> {
  const definitions = new Map<string, TheoremDefinition>();
  DECLARATION_RE.lastIndex = 0;
  for (let match = DECLARATION_RE.exec(source); match; match = DECLARATION_RE.exec(source)) {
    if (isIgnored(match.index)) continue;
    const after = match.index + match[0].length;
    // `\newtheoremstyle{…}` shares the prefix but declares no environment.
    if (match[1] === "newtheorem" && !match[2] && /^[A-Za-z@]/.test(source[after] ?? "")) continue;
    const unnumbered = match[2] === "*";

    if (match[1] === "declaretheorem") {
      const options = readGroup(source, after, "[");
      const names = readGroup(source, options?.to ?? after, "{");
      if (!names) continue;
      const keys = thmtoolsOptions(options?.value ?? "");
      const numbered = keys.get("numbered");
      for (const raw of names.value.split(",")) {
        const environment = raw.trim();
        if (!environment) continue;
        const sibling = keys.get("sibling") || keys.get("parent") || "";
        definitions.set(environment, {
          environment,
          heading: (keys.get("name") || capitalize(environment)).trim(),
          counter: unnumbered || numbered === "no" ? null : sibling || environment,
          within: (keys.get("numberwithin") || keys.get("within") || "").trim() || null,
        });
      }
      DECLARATION_RE.lastIndex = names.to;
      continue;
    }

    const name = readGroup(source, after, "{");
    if (!name) continue;
    const sibling = readGroup(source, name.to, "[");
    const heading = readGroup(source, sibling?.to ?? name.to, "{");
    if (!heading) continue;
    const within = readGroup(source, heading.to, "[");
    const environment = name.value.trim();
    if (!environment) continue;
    definitions.set(environment, {
      environment,
      heading: heading.value.trim() || capitalize(environment),
      counter: unnumbered ? null : sibling?.value.trim() || environment,
      within: within?.value.trim() || null,
    });
    DECLARATION_RE.lastIndex = within?.to ?? heading.to;
  }
  return definitions;
}

/** One `\begin{env}` in the open file, in document order. */
export type TheoremOccurrence = { environment: string; from: number };

/**
 * The number the PDF prints for each occurrence, keyed by its start offset.
 *
 * `sectionNumberAt` answers "what does the `section`/`chapter` counter read at
 * this offset" — supplied by the caller because the Visual editor already
 * replays sectioning counters from the live buffer, and the two must agree.
 * Occurrences of an undeclared or `\newtheorem*` environment are simply absent
 * from the result, which is how callers know to print no number.
 */
export function assignTheoremNumbers(
  occurrences: readonly TheoremOccurrence[],
  definitions: ReadonlyMap<string, TheoremDefinition>,
  sectionNumberAt: (counter: string, from: number) => string | null,
): Map<number, string> {
  const numbers = new Map<number, string>();
  const values = new Map<string, number>();
  const prefixes = new Map<string, string>();
  for (const occurrence of occurrences) {
    const definition = definitions.get(occurrence.environment);
    if (!definition?.counter) continue;
    const counter = definition.counter;
    // A borrowed counter is reset by *its owner's* `within`, not the borrower's.
    const owner = definitions.get(counter) ?? definition;
    const prefix = owner.within ? sectionNumberAt(owner.within, occurrence.from) ?? "" : "";
    if (prefixes.get(counter) !== prefix) {
      prefixes.set(counter, prefix);
      values.set(counter, 0);
    }
    const next = (values.get(counter) ?? 0) + 1;
    values.set(counter, next);
    numbers.set(occurrence.from, prefix ? `${prefix}.${next}` : String(next));
  }
  return numbers;
}
