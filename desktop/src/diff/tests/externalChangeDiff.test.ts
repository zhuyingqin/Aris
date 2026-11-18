import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  textDiffLines: vi.fn(),
  textThreeWayMerge: vi.fn(),
}));

vi.mock("../../api/tauri", () => ({
  isTauri: () => true,
  textDiffLines: apiMocks.textDiffLines,
  textThreeWayMerge: apiMocks.textThreeWayMerge,
}));

import {
  externalTextDiff,
  externalTextDiffReliable,
  resolveExternalDiff,
  threeWayExternalProposal,
} from "../externalChangeDiff";

beforeEach(() => vi.clearAllMocks());

/** The workbench diffs once and resolves against that exact diff; these cases
 * are written in terms of the two texts, so re-derive the diff here. */
function resolveExternalChanges(
  current: string,
  incoming: string,
  decisions: readonly ("pending" | "accept" | "reject")[],
): string {
  return resolveExternalDiff(current, externalTextDiff(current, incoming, 0), decisions);
}

describe("externalTextDiff", () => {
  it("reports separated edits with bounded context and stable line numbers", () => {
    const before = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].join("\n");
    const after = ["one", "TWO", "three", "four", "five", "six", "seven", "eight", "NINE", "ten"].join("\n");
    const result = externalTextDiff(before, after, 1);

    expect(result.added).toBe(3);
    expect(result.removed).toBe(2);
    expect(result.hunks).toHaveLength(2);
    expect(result.hunks[0].lines.map((line) => [line.kind, line.text])).toEqual([
      ["context", "one"],
      ["removed", "two"],
      ["added", "TWO"],
      ["context", "three"],
    ]);
    expect(result.hunks[1].lines.some((line) => line.newLine === 10 && line.text === "ten")).toBe(true);
  });

  it("returns no hunks for identical text", () => {
    expect(externalTextDiff("same\ntext", "same\ntext")).toEqual({ added: 0, removed: 0, hunks: [], changes: [] });
  });

  it("handles empty documents", () => {
    expect(externalTextDiff("", "first\nsecond")).toMatchObject({ added: 2, removed: 0 });
    expect(externalTextDiff("first\nsecond", "")).toMatchObject({ added: 0, removed: 2 });
  });
});

describe("resolveExternalChanges", () => {
  it("accepts and rejects independent change groups", () => {
    const current = "alpha\nbeta\ngamma\ndelta";
    const incoming = "alpha\nBETA\ngamma\nDELTA";
    expect(resolveExternalChanges(current, incoming, ["accept", "reject"])).toBe("alpha\nBETA\ngamma\ndelta");
    expect(resolveExternalChanges(current, incoming, ["reject", "accept"])).toBe("alpha\nbeta\ngamma\nDELTA");
  });

  it("handles insertions and deletions", () => {
    expect(resolveExternalChanges("a\nc", "a\nb\nc", ["accept"])).toBe("a\nb\nc");
    expect(resolveExternalChanges("a\nb\nc", "a\nc", ["accept"])).toBe("a\nc");
  });
});

describe("Git-backed range projection", () => {
  it("accepts a zero-context insertion at its middle boundary", async () => {
    apiMocks.textDiffLines.mockResolvedValue({
      added: 1,
      removed: 0,
      beforeLineCount: 2,
      afterLineCount: 3,
      beforeEndsWithNewline: true,
      afterEndsWithNewline: true,
      tooLargeToChunk: false,
      hunks: [{
        oldStart: 1,
        oldLines: 0,
        newStart: 2,
        newLines: 1,
        header: "",
        lines: [{ kind: "added", text: "b", oldLine: null, newLine: 2 }],
      }],
    });
    const diff = await externalTextDiffReliable("a\nc\n", "a\nb\nc\n", "x.tex", 0);
    expect(resolveExternalDiff("a\nc\n", diff, ["accept"])).toBe("a\nb\nc\n");
  });

  it("accepts an EOF insertion without moving it before the last line", async () => {
    apiMocks.textDiffLines.mockResolvedValue({
      added: 1,
      removed: 0,
      beforeLineCount: 2,
      afterLineCount: 3,
      beforeEndsWithNewline: true,
      afterEndsWithNewline: true,
      tooLargeToChunk: false,
      hunks: [{
        oldStart: 2,
        oldLines: 0,
        newStart: 3,
        newLines: 1,
        header: "",
        lines: [{ kind: "added", text: "c", oldLine: null, newLine: 3 }],
      }],
    });
    const diff = await externalTextDiffReliable("a\nb\n", "a\nb\nc\n", "x.tex", 0);
    expect(resolveExternalDiff("a\nb\n", diff, ["accept"])).toBe("a\nb\nc\n");
  });

  it("applies an EOF-only newline change", async () => {
    apiMocks.textDiffLines.mockResolvedValue({
      added: 1,
      removed: 1,
      beforeLineCount: 1,
      afterLineCount: 1,
      beforeEndsWithNewline: false,
      afterEndsWithNewline: true,
      tooLargeToChunk: false,
      hunks: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        header: "",
        lines: [
          { kind: "removed", text: "a", oldLine: 1, newLine: null },
          { kind: "added", text: "a", oldLine: null, newLine: 1 },
        ],
      }],
    });
    const diff = await externalTextDiffReliable("a", "a\n", "x.tex", 0);
    expect(resolveExternalDiff("a", diff, ["accept"])).toBe("a\n");
    expect(resolveExternalDiff("a", diff, ["reject"])).toBe("a");
  });
});

describe("threeWayExternalProposal", () => {
  it("preserves adjacent local edits while proposing the incoming edit", () => {
    const proposal = threeWayExternalProposal(
      "alpha\nbeta\ngamma",
      "LOCAL alpha\nbeta\ngamma",
      "alpha\nINCOMING beta\ngamma",
      0,
    );
    expect(proposal.content).toBe("LOCAL alpha\nINCOMING beta\ngamma");
    expect(proposal.conflicts).toBe(0);
    expect(resolveExternalChanges(
      "LOCAL alpha\nbeta\ngamma",
      proposal.content,
      ["accept"],
    )).toBe("LOCAL alpha\nINCOMING beta\ngamma");
  });

  it("keeps the local side when an overlapping incoming group is rejected", () => {
    const local = "alpha\nLOCAL beta\ngamma";
    const proposal = threeWayExternalProposal(
      "alpha\nbeta\ngamma",
      local,
      "alpha\nINCOMING beta\ngamma",
      0,
    );
    expect(proposal.content).toBe("alpha\nINCOMING beta\ngamma");
    expect(proposal.conflicts).toBe(1);
    expect(resolveExternalChanges(local, proposal.content, ["reject"])).toBe(local);
    expect(resolveExternalChanges(local, proposal.content, ["accept"])).toBe(proposal.content);
  });

  it("merges an incoming insertion inside a locally replaced range as one explicit conflict", () => {
    const local = "LOCAL ab\ngamma";
    const proposal = threeWayExternalProposal(
      "alpha\nbeta\ngamma",
      local,
      "alpha\ninserted\nbeta\ngamma",
      0,
    );
    expect(proposal.content).toBe("alpha\ninserted\nbeta\ngamma");
    expect(proposal.conflicts).toBe(1);
    expect(resolveExternalChanges(local, proposal.content, ["reject"])).toBe(local);
  });

  it("does not ask twice when the local draft already contains the incoming edit", () => {
    const proposal = threeWayExternalProposal(
      "alpha\nbeta",
      "alpha\nBETA",
      "alpha\nBETA",
      0,
    );
    expect(proposal.content).toBe("alpha\nBETA");
    expect(proposal.diff.changes).toHaveLength(0);
    expect(proposal.conflicts).toBe(0);
  });
});

describe("a change too large to chunk", () => {
  // 900 changed lines exceeds the local fallback's search bound. The old code
  // answered with "every old line removed, every new line added" — a shape
  // indistinguishable from a real rewrite, which made the three-way merge treat
  // both branches as one overlapping group and resolve it by taking the
  // incoming file whole. Local edits elsewhere in the document were lost.
  const base = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
  const rewritten = Array.from({ length: 900 }, (_, i) => `other ${i}`).join("\n");

  it("is reported rather than disguised as a whole-file replacement", () => {
    const diff = externalTextDiff(base, rewritten);
    expect(diff.tooLargeToChunk).toBe(true);
    expect(diff.changes).toHaveLength(0);
    expect(diff.hunks).toHaveLength(0);
  });

  it("refuses to merge instead of silently dropping a side", () => {
    const local = `${base}\nMY OWN PARAGRAPH`;
    const proposal = threeWayExternalProposal(base, local, rewritten);

    expect(proposal.tooLargeToChunk).toBe(true);
    expect(proposal.conflicts).toBe(0);
    // The local draft is returned untouched — the incoming version is NOT
    // applied — so the caller has to ask rather than pick a winner.
    expect(proposal.content).toBe(local);
    expect(proposal.content).toContain("MY OWN PARAGRAPH");
  });

  it("does not review a large rewrite the local draft already contains", () => {
    const proposal = threeWayExternalProposal(base, rewritten, rewritten);

    expect(proposal.tooLargeToChunk).toBeUndefined();
    expect(proposal.diff.changes).toHaveLength(0);
    expect(proposal.content).toBe(rewritten);
  });

  it("still merges normally when both sides are chunkable", () => {
    const small = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const local = small.replace("line 3", "MINE");
    const incoming = small.replace("line 30", "THEIRS");
    const proposal = threeWayExternalProposal(small, local, incoming);

    expect(proposal.tooLargeToChunk).toBeUndefined();
    expect(proposal.content).toContain("MINE");
    expect(proposal.content).toContain("THEIRS");
  });
});
