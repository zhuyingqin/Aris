import { describe, expect, it } from "vitest";
import type { TypesetComment } from "../../api/tauri";
import { commentRangeInSource } from "../TypesetCommentsPanel";

const comment = (overrides: Partial<TypesetComment> = {}): TypesetComment => ({
  id: "comment-1",
  path: "main.tex",
  from: 6,
  to: 10,
  selectedText: "beta",
  body: "Review this",
  author: "Reviewer",
  origin: "reviewer",
  resolved: false,
  createdAtMs: 1,
  updatedAtMs: 1,
  ...overrides,
});

describe("commentRangeInSource", () => {
  it("keeps an unchanged source anchor", () => {
    expect(commentRangeInSource(comment(), "alpha beta gamma")).toEqual({ from: 6, to: 10 });
  });

  it("reanchors to the nearest matching quote after surrounding edits", () => {
    expect(commentRangeInSource(comment(), "prefix alpha beta gamma")).toEqual({ from: 13, to: 17 });
  });
});
