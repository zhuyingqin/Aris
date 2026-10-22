import { describe, expect, it } from "vitest";
import { findMatchesInPage, pageTextFromContent } from "../pdfSearch";

function content(items: Array<string | [string, boolean]>) {
  return {
    items: items.map((item) => (Array.isArray(item)
      ? { str: item[0], hasEOL: item[1] }
      : { str: item })),
  };
}

describe("pageTextFromContent", () => {
  it("joins items with a space so two words never fuse into one", () => {
    const page = pageTextFromContent(1, content(["Echo", "State", "Network"]));
    expect(page.text).toBe("Echo State Network");
    expect(page.spans.map((span) => [span.from, span.to, span.itemIndex]))
      .toEqual([[0, 4, 0], [5, 10, 1], [11, 18, 2]]);
  });

  it("ends a line where pdf.js says the item does", () => {
    const page = pageTextFromContent(2, content([["First line", true], "second line"]));
    expect(page.text).toBe("First line\n second line");
  });

  it("survives a page with no text at all", () => {
    expect(pageTextFromContent(3, null)).toEqual({ page: 3, text: "", spans: [] });
    expect(pageTextFromContent(3, { items: [{}, { str: 5 }] })).toEqual({ page: 3, text: "", spans: [] });
  });
});

describe("findMatchesInPage", () => {
  const page = pageTextFromContent(1, content(["The", "Echo", ["State", true], "Network", "is", "an", "echo", "state", "model"]));

  it("finds a phrase that spans several text items", () => {
    const matches = findMatchesInPage(page, "echo state network");
    expect(matches).toHaveLength(1);
    // The highlight covers exactly the items the phrase runs across.
    expect(matches[0].itemIndices).toEqual([1, 2, 3]);
    expect(page.text.slice(matches[0].from, matches[0].to)).toBe("Echo State\n Network");
  });

  it("ignores case and treats a line break as a space", () => {
    expect(findMatchesInPage(page, "STATE NETWORK")).toHaveLength(1);
    expect(findMatchesInPage(page, "echo   state")).toHaveLength(2);
  });

  it("returns a snippet with the match in context", () => {
    const [match] = findMatchesInPage(page, "network");
    expect(match.snippet).toContain("Network");
  });

  it("returns nothing for an empty query rather than matching everywhere", () => {
    expect(findMatchesInPage(page, "")).toEqual([]);
    expect(findMatchesInPage(page, "   ")).toEqual([]);
  });

  it("honours the match limit", () => {
    const many = pageTextFromContent(1, content(Array.from({ length: 40 }, () => "hit")));
    expect(findMatchesInPage(many, "hit", 5)).toHaveLength(5);
  });
});
