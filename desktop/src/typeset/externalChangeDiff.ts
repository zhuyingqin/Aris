export type ExternalDiffLineKind = "context" | "added" | "removed";

export interface ExternalDiffLine {
  kind: ExternalDiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface ExternalDiffHunk {
  lines: ExternalDiffLine[];
  oldStart: number;
  newStart: number;
}

export interface ExternalDiffChange {
  id: string;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  lines: ExternalDiffLine[];
  beforeLines: string[];
  afterLines: string[];
}

export interface ExternalTextDiff {
  added: number;
  removed: number;
  hunks: ExternalDiffHunk[];
  changes: ExternalDiffChange[];
  /**
   * The change could not be broken into reviewable pieces. Present this as an
   * explicit "too large to review hunk by hunk" state — never as an empty diff
   * and never as a whole-file replacement.
   */
  tooLargeToChunk?: boolean;
  /** The fallback stopped before finding the exact edit script. */
  countsApproximate?: boolean;
}

function changesFromGitHunks(hunks: TextDiffResult["hunks"]): ExternalDiffChange[] {
  const changes: ExternalDiffChange[] = [];
  for (const hunk of hunks) {
    let oldCursor = Math.max(0, hunk.oldStart - 1);
    let newCursor = Math.max(0, hunk.newStart - 1);
    let current: Omit<ExternalDiffChange, "id"> | null = null;
    const flush = () => {
      if (!current) return;
      changes.push({
        ...current,
        id: `${current.oldStart}:${current.oldEnd}:${current.newStart}:${current.newEnd}:${changes.length}`,
      });
      current = null;
    };
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        flush();
        oldCursor += 1;
        newCursor += 1;
        continue;
      }
      if (!current) {
        current = {
          oldStart: oldCursor,
          oldEnd: oldCursor,
          newStart: newCursor,
          newEnd: newCursor,
          lines: [],
          beforeLines: [],
          afterLines: [],
        };
      }
      if (line.kind === "removed") {
        current.lines.push({ kind: "removed", text: line.text, oldLine: line.oldLine, newLine: null });
        current.beforeLines.push(line.text);
        oldCursor += 1;
        current.oldEnd = oldCursor;
      } else {
        current.lines.push({ kind: "added", text: line.text, oldLine: null, newLine: line.newLine });
        current.afterLines.push(line.text);
        newCursor += 1;
        current.newEnd = newCursor;
      }
    }
    flush();
  }
  return changes;
}

function gitDiffResult(result: TextDiffResult): ExternalTextDiff {
  return {
    added: result.added,
    removed: result.removed,
    tooLargeToChunk: result.tooLargeToChunk || undefined,
    hunks: result.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      lines: hunk.lines,
    })),
    changes: result.tooLargeToChunk ? [] : changesFromGitHunks(result.hunks),
  };
}

/**
 * The local fallback's search bound. Git has no such limit; this exists only so
 * the no-Git path cannot freeze the UI on a pathological rewrite.
 */
const MAX_LOCAL_EDIT_DISTANCE = 800;

export interface ExternalThreeWayProposal {
  /** Local draft with every incoming change provisionally applied. */
  content: string;
  /** What the reviewer must accept/reject relative to the local draft. */
  diff: ExternalTextDiff;
  /** Number of incoming groups that overlap a local edit. */
  conflicts: number;
  /**
   * Neither side could be chunked reliably, so no per-hunk proposal exists.
   * `content` is the untouched local draft — the incoming version has NOT been
   * applied. Callers must surface this as a decision for the user rather than
   * treating it as "nothing changed", which would drop the incoming file.
   */
  tooLargeToChunk?: boolean;
}

function changesFor(operations: DiffOperation[]): ExternalDiffChange[] {
  const changes: ExternalDiffChange[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  let current: Omit<ExternalDiffChange, "id"> | null = null;
  const flush = () => {
    if (!current) return;
    changes.push({ ...current, id: `${current.oldStart}:${current.oldEnd}:${current.newStart}:${current.newEnd}:${changes.length}` });
    current = null;
  };
  for (const operation of operations) {
    if (operation.kind === "context") {
      flush();
      oldCursor += 1;
      newCursor += 1;
      continue;
    }
    if (!current) {
      current = {
        oldStart: oldCursor,
        oldEnd: oldCursor,
        newStart: newCursor,
        newEnd: newCursor,
        lines: [],
        beforeLines: [],
        afterLines: [],
      };
    }
    if (operation.kind === "removed") {
      current.lines.push({ kind: "removed", text: operation.text, oldLine: oldCursor + 1, newLine: null });
      current.beforeLines.push(operation.text);
      oldCursor += 1;
      current.oldEnd = oldCursor;
    } else {
      current.lines.push({ kind: "added", text: operation.text, oldLine: null, newLine: newCursor + 1 });
      current.afterLines.push(operation.text);
      newCursor += 1;
      current.newEnd = newCursor;
    }
  }
  flush();
  return changes;
}

type DiffOperation = { kind: ExternalDiffLineKind; text: string };

/**
 * Myers' line diff, used only as the local fallback when Git is unavailable.
 *
 * The search is still bounded — an unbounded O(ND) walk over a thesis locks the
 * UI — but exhausting the bound is now reported rather than disguised. It used
 * to return "every old line removed, every new line added", which is
 * indistinguishable from a real rewrite: `threeWayExternalProposal` then read
 * both branches as one overlapping group and resolved it by taking the incoming
 * file whole, silently discarding local edits elsewhere in the document. A
 * caller that gets `null` must tell the user the change is too large to chunk
 * reliably and ask, instead of showing a synthetic whole-file replacement.
 */
function myersOperations(before: string[], after: string[]): DiffOperation[] | null {
  const maximumDistance = before.length + after.length;
  const trace: Array<Map<number, number>> = [];
  const frontier = new Map<number, number>([[1, 0]]);
  const distanceLimit = Math.min(maximumDistance, MAX_LOCAL_EDIT_DISTANCE);

  for (let distance = 0; distance <= distanceLimit; distance += 1) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      let oldIndex = diagonal === -distance || (diagonal !== distance && right < down)
        ? Math.max(0, down)
        : Math.max(0, right + 1);
      let newIndex = oldIndex - diagonal;
      while (
        oldIndex < before.length
        && newIndex < after.length
        && before[oldIndex] === after[newIndex]
      ) {
        oldIndex += 1;
        newIndex += 1;
      }
      frontier.set(diagonal, oldIndex);
      if (oldIndex < before.length || newIndex < after.length) continue;

      const reversed: DiffOperation[] = [];
      let x = before.length;
      let y = after.length;
      for (let step = trace.length - 1; step >= 0; step -= 1) {
        const previous = trace[step];
        const k = x - y;
        const previousDown = previous.get(k + 1) ?? Number.NEGATIVE_INFINITY;
        const previousRight = previous.get(k - 1) ?? Number.NEGATIVE_INFINITY;
        const previousK = k === -step || (k !== step && previousRight < previousDown)
          ? k + 1
          : k - 1;
        const previousX = Math.max(0, previous.get(previousK) ?? 0);
        const previousY = previousX - previousK;
        while (x > previousX && y > previousY) {
          reversed.push({ kind: "context", text: before[x - 1] });
          x -= 1;
          y -= 1;
        }
        if (step === 0) break;
        if (x === previousX) {
          reversed.push({ kind: "added", text: after[previousY] ?? "" });
        } else {
          reversed.push({ kind: "removed", text: before[previousX] ?? "" });
        }
        x = previousX;
        y = previousY;
      }
      return reversed.reverse();
    }
  }

  return null;
}

function numberedOperations(operations: DiffOperation[]): ExternalDiffLine[] {
  let oldLine = 1;
  let newLine = 1;
  return operations.map((operation) => {
    if (operation.kind === "added") {
      return { ...operation, oldLine: null, newLine: newLine++ };
    }
    if (operation.kind === "removed") {
      return { ...operation, oldLine: oldLine++, newLine: null };
    }
    return { ...operation, oldLine: oldLine++, newLine: newLine++ };
  });
}

function hunksFor(lines: ExternalDiffLine[], contextLines: number): ExternalDiffHunk[] {
  const changedIndexes = lines
    .map((line, index) => (line.kind === "context" ? -1 : index))
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) return [];

  const ranges: Array<{ from: number; to: number }> = [];
  for (const changedIndex of changedIndexes) {
    const from = Math.max(0, changedIndex - contextLines);
    const to = Math.min(lines.length, changedIndex + contextLines + 1);
    const previous = ranges.at(-1);
    if (previous && from <= previous.to) previous.to = Math.max(previous.to, to);
    else ranges.push({ from, to });
  }
  return ranges.map(({ from, to }) => {
    const hunkLines = lines.slice(from, to);
    const firstOld = hunkLines.find((line) => line.oldLine !== null)?.oldLine ?? 1;
    const firstNew = hunkLines.find((line) => line.newLine !== null)?.newLine ?? 1;
    return { lines: hunkLines, oldStart: firstOld, newStart: firstNew };
  });
}

export function externalTextDiff(before: string, after: string, contextLines = 3): ExternalTextDiff {
  const beforeLines = before === "" ? [] : before.split("\n");
  const afterLines = after === "" ? [] : after.split("\n");
  const operations = myersOperations(beforeLines, afterLines);
  if (!operations) {
    // No hunks and no changes: there is nothing here that can be honestly
    // accepted or rejected piecewise, and saying so is the point.
    // The exact edit count is deliberately not computed after the bound is
    // exhausted. Counting each side's lines is an honest upper bound and gives
    // the file-level review enough context to explain why chunking was skipped.
    return {
      added: afterLines.length,
      removed: beforeLines.length,
      hunks: [],
      changes: [],
      tooLargeToChunk: true,
      countsApproximate: true,
    };
  }
  const lines = numberedOperations(operations);
  return {
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length,
    hunks: hunksFor(lines, contextLines),
    changes: changesFor(operations),
  };
}

/**
 * Prefer Git's production diff implementation. `git diff --no-index` compares
 * loose temporary files and therefore works without a repository and cannot
 * touch the user's index or history. Browser preview and machines without Git
 * retain the bounded local implementation.
 */
export async function externalTextDiffReliable(
  before: string,
  after: string,
  pathHint: string,
  contextLines = 3,
): Promise<ExternalTextDiff> {
  if (before === after) return externalTextDiff(before, after, contextLines);
  if (!isTauri()) return externalTextDiff(before, after, contextLines);
  try {
    return gitDiffResult(await textDiffLines(before, after, pathHint, contextLines));
  } catch {
    return externalTextDiff(before, after, contextLines);
  }
}

function changeRangesOverlap(left: ExternalDiffChange, right: ExternalDiffChange): boolean {
  const leftInsertion = left.oldStart === left.oldEnd;
  const rightInsertion = right.oldStart === right.oldEnd;
  if (leftInsertion && rightInsertion) return left.oldStart === right.oldStart;
  if (leftInsertion) return left.oldStart > right.oldStart && left.oldStart < right.oldEnd;
  if (rightInsertion) return right.oldStart > left.oldStart && right.oldStart < left.oldEnd;
  return left.oldStart < right.oldEnd && right.oldStart < left.oldEnd;
}

function renderBranchSegment(
  baseLines: string[],
  changes: ExternalDiffChange[],
  from: number,
  to: number,
): string[] {
  const segment = baseLines.slice(from, to);
  for (const change of [...changes].sort((left, right) => right.oldStart - left.oldStart)) {
    segment.splice(
      change.oldStart - from,
      change.oldEnd - change.oldStart,
      ...change.afterLines,
    );
  }
  return segment;
}

function branchStartAt(basePosition: number, changes: ExternalDiffChange[]): number {
  return basePosition + changes.reduce((delta, change) => {
    // Insertions exactly at the left boundary are before the range and must be
    // preserved. A replacement starting at the boundary belongs to the range.
    if (change.oldEnd > basePosition) return delta;
    return delta + (change.newEnd - change.newStart) - (change.oldEnd - change.oldStart);
  }, 0);
}

function branchEndAt(basePosition: number, changes: ExternalDiffChange[]): number {
  return basePosition + changes.reduce((delta, change) => {
    // Insertions exactly at the right boundary are after the range and must be
    // preserved. Everything starting inside the range contributes its delta.
    if (change.oldStart >= basePosition) return delta;
    return delta + (change.newEnd - change.newStart) - (change.oldEnd - change.oldStart);
  }, 0);
}

/**
 * Build the review candidate from a real three-way merge:
 *
 *   base -> local draft
 *   base -> incoming disk version
 *
 * Non-overlapping local edits are retained automatically. Connected groups
 * that touch on both branches are represented by the incoming version in the
 * candidate, so rejecting that displayed hunk keeps the local version and
 * accepting it adopts exactly what is visible. Nothing is silently classified
 * as an "external deletion" merely because it only exists in the local draft.
 */
export function threeWayExternalProposal(
  base: string,
  local: string,
  incoming: string,
  contextLines = 3,
): ExternalThreeWayProposal {
  // Equality must win before either branch reaches the fallback's edit-distance
  // guard. A draft that already contains the incoming rewrite needs no review,
  // even when reaching that conclusion by diff would exceed the local bound.
  if (local === incoming) {
    return {
      content: local,
      diff: externalTextDiff(local, incoming, contextLines),
      conflicts: 0,
    };
  }
  const baseLines = base === "" ? [] : base.split("\n");
  const localLines = local === "" ? [] : local.split("\n");
  const localDiff = externalTextDiff(base, local, 0);
  const incomingDiff = externalTextDiff(base, incoming, 0);
  // An unchunked side has no `changes`, which would otherwise read as "this
  // branch edited nothing" and quietly resolve the merge to the other side.
  // Refuse instead: the caller has to ask.
  if (localDiff.tooLargeToChunk || incomingDiff.tooLargeToChunk) {
    return {
      content: local,
      diff: {
        added: incomingDiff.added,
        removed: incomingDiff.removed,
        hunks: [],
        changes: [],
        tooLargeToChunk: true,
      },
      conflicts: 0,
      tooLargeToChunk: true,
    };
  }
  const localChanges = localDiff.changes;
  const incomingChanges = incomingDiff.changes;
  const remainingIncoming = new Set(incomingChanges.map((_, index) => index));
  const replacements: Array<{ from: number; to: number; lines: string[]; conflict: boolean }> = [];

  while (remainingIncoming.size > 0) {
    const firstIncoming = remainingIncoming.values().next().value as number;
    const incomingIndexes = new Set<number>([firstIncoming]);
    const localIndexes = new Set<number>();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (let localIndex = 0; localIndex < localChanges.length; localIndex += 1) {
        if (localIndexes.has(localIndex)) continue;
        if ([...incomingIndexes].some((incomingIndex) => (
          changeRangesOverlap(incomingChanges[incomingIndex], localChanges[localIndex])
        ))) {
          localIndexes.add(localIndex);
          expanded = true;
        }
      }
      for (const incomingIndex of [...remainingIncoming]) {
        if (incomingIndexes.has(incomingIndex)) continue;
        if ([...localIndexes].some((localIndex) => (
          changeRangesOverlap(incomingChanges[incomingIndex], localChanges[localIndex])
        ))) {
          incomingIndexes.add(incomingIndex);
          expanded = true;
        }
      }
    }

    for (const index of incomingIndexes) remainingIncoming.delete(index);
    const branchIncoming = [...incomingIndexes].map((index) => incomingChanges[index]);
    const branchLocal = [...localIndexes].map((index) => localChanges[index]);
    const allChanges = [...branchIncoming, ...branchLocal];
    const baseFrom = Math.min(...allChanges.map((change) => change.oldStart));
    const baseTo = Math.max(...allChanges.map((change) => change.oldEnd));
    let localFrom: number;
    let localTo: number;
    if (baseFrom === baseTo && branchLocal.length > 0) {
      // The only zero-width conflict is two insertions at the same boundary.
      localFrom = Math.min(...branchLocal.map((change) => change.newStart));
      localTo = Math.max(...branchLocal.map((change) => change.newEnd));
    } else {
      localFrom = branchStartAt(baseFrom, localChanges);
      localTo = branchEndAt(baseTo, localChanges);
    }
    const incomingLines = renderBranchSegment(baseLines, branchIncoming, baseFrom, baseTo);
    const localSegment = localLines.slice(localFrom, localTo);
    replacements.push({
      from: localFrom,
      to: localTo,
      lines: incomingLines,
      conflict: branchLocal.length > 0
        && (localSegment.length !== incomingLines.length
          || localSegment.some((line, index) => line !== incomingLines[index])),
    });
  }

  const proposedLines = [...localLines];
  for (const replacement of replacements.sort((left, right) => right.from - left.from)) {
    proposedLines.splice(replacement.from, replacement.to - replacement.from, ...replacement.lines);
  }
  const content = proposedLines.join("\n");
  return {
    content,
    diff: externalTextDiff(local, content, contextLines),
    conflicts: replacements.filter((replacement) => replacement.conflict).length,
  };
}

/**
 * Git-backed three-way proposal used by the desktop review gate.
 *
 * A clean `git merge-file` result is used directly. For a genuine conflict we
 * keep the existing review contract — show the incoming side as an explicit
 * hunk that can be rejected back to local — but derive every range from Git's
 * diff rather than from the bounded fallback.
 */
export async function threeWayExternalProposalReliable(
  base: string,
  local: string,
  incoming: string,
  pathHint: string,
  contextLines = 3,
): Promise<ExternalThreeWayProposal> {
  if (local === incoming) {
    return { content: local, diff: externalTextDiff(local, incoming, contextLines), conflicts: 0 };
  }
  if (!isTauri()) return threeWayExternalProposal(base, local, incoming, contextLines);
  try {
    const [localDiff, incomingDiff, merge] = await Promise.all([
      externalTextDiffReliable(base, local, pathHint, 0),
      externalTextDiffReliable(base, incoming, pathHint, 0),
      textThreeWayMerge(base, local, incoming, pathHint),
    ]);
    if (localDiff.tooLargeToChunk || incomingDiff.tooLargeToChunk) {
      return {
        content: local,
        diff: {
          added: incomingDiff.added,
          removed: incomingDiff.removed,
          hunks: [],
          changes: [],
          tooLargeToChunk: true,
          countsApproximate: localDiff.countsApproximate || incomingDiff.countsApproximate || undefined,
        },
        conflicts: merge.conflicts,
        tooLargeToChunk: true,
      };
    }

    let content = merge.content;
    if (!merge.clean) {
      // Reuse the established incoming-candidate semantics, but feed it Git's
      // exact branch ranges so the visible choices stay marker-free.
      content = composeThreeWayCandidate(base, local, localDiff, incomingDiff).content;
    }
    const diff = await externalTextDiffReliable(local, content, pathHint, contextLines);
    if (diff.tooLargeToChunk) {
      return { content: local, diff, conflicts: merge.conflicts, tooLargeToChunk: true };
    }
    return { content, diff, conflicts: merge.conflicts };
  } catch {
    return threeWayExternalProposal(base, local, incoming, contextLines);
  }
}

function composeThreeWayCandidate(
  base: string,
  local: string,
  localDiff: ExternalTextDiff,
  incomingDiff: ExternalTextDiff,
): Pick<ExternalThreeWayProposal, "content" | "conflicts"> {
  const baseLines = base === "" ? [] : base.split("\n");
  const localLines = local === "" ? [] : local.split("\n");
  const localChanges = localDiff.changes;
  const incomingChanges = incomingDiff.changes;
  const remainingIncoming = new Set(incomingChanges.map((_, index) => index));
  const replacements: Array<{ from: number; to: number; lines: string[]; conflict: boolean }> = [];

  while (remainingIncoming.size > 0) {
    const firstIncoming = remainingIncoming.values().next().value as number;
    const incomingIndexes = new Set<number>([firstIncoming]);
    const localIndexes = new Set<number>();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (let localIndex = 0; localIndex < localChanges.length; localIndex += 1) {
        if (localIndexes.has(localIndex)) continue;
        if ([...incomingIndexes].some((incomingIndex) => (
          changeRangesOverlap(incomingChanges[incomingIndex], localChanges[localIndex])
        ))) {
          localIndexes.add(localIndex);
          expanded = true;
        }
      }
      for (const incomingIndex of [...remainingIncoming]) {
        if (incomingIndexes.has(incomingIndex)) continue;
        if ([...localIndexes].some((localIndex) => (
          changeRangesOverlap(incomingChanges[incomingIndex], localChanges[localIndex])
        ))) {
          incomingIndexes.add(incomingIndex);
          expanded = true;
        }
      }
    }

    for (const index of incomingIndexes) remainingIncoming.delete(index);
    const branchIncoming = [...incomingIndexes].map((index) => incomingChanges[index]);
    const branchLocal = [...localIndexes].map((index) => localChanges[index]);
    const allChanges = [...branchIncoming, ...branchLocal];
    const baseFrom = Math.min(...allChanges.map((change) => change.oldStart));
    const baseTo = Math.max(...allChanges.map((change) => change.oldEnd));
    const localFrom = baseFrom === baseTo && branchLocal.length > 0
      ? Math.min(...branchLocal.map((change) => change.newStart))
      : branchStartAt(baseFrom, localChanges);
    const localTo = baseFrom === baseTo && branchLocal.length > 0
      ? Math.max(...branchLocal.map((change) => change.newEnd))
      : branchEndAt(baseTo, localChanges);
    const incomingLines = renderBranchSegment(baseLines, branchIncoming, baseFrom, baseTo);
    const localSegment = localLines.slice(localFrom, localTo);
    replacements.push({
      from: localFrom,
      to: localTo,
      lines: incomingLines,
      conflict: branchLocal.length > 0
        && (localSegment.length !== incomingLines.length
          || localSegment.some((line, index) => line !== incomingLines[index])),
    });
  }

  const proposedLines = [...localLines];
  for (const replacement of replacements.sort((left, right) => right.from - left.from)) {
    proposedLines.splice(replacement.from, replacement.to - replacement.from, ...replacement.lines);
  }
  return {
    content: proposedLines.join("\n"),
    conflicts: replacements.filter((replacement) => replacement.conflict).length,
  };
}

/** Resolve a proposal without mutating either source. Pending changes are kept
 * local until the reviewer makes an explicit choice. */
export function resolveExternalChanges(
  current: string,
  incoming: string,
  decisions: readonly ("pending" | "accept" | "reject")[],
): string {
  const currentLines = current === "" ? [] : current.split("\n");
  const changes = externalTextDiff(current, incoming, 0).changes;
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    if (decisions[index] !== "accept") continue;
    const change = changes[index];
    currentLines.splice(change.oldStart, change.oldEnd - change.oldStart, ...change.afterLines);
  }
  return currentLines.join("\n");
}

/** Resolve exactly the change ranges that were shown to the reviewer. */
export function resolveExternalDiff(
  current: string,
  diff: ExternalTextDiff,
  decisions: readonly ("pending" | "accept" | "reject")[],
): string {
  const currentLines = current === "" ? [] : current.split("\n");
  for (let index = diff.changes.length - 1; index >= 0; index -= 1) {
    if (decisions[index] !== "accept") continue;
    const change = diff.changes[index];
    currentLines.splice(change.oldStart, change.oldEnd - change.oldStart, ...change.afterLines);
  }
  return currentLines.join("\n");
}
import {
  isTauri,
  textDiffLines,
  textThreeWayMerge,
  type TextDiffResult,
} from "../api/tauri";
