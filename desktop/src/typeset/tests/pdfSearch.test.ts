import { describe, expect, it } from "vitest";
import {
  findMatchesInPage,
  pageHighlights,
  pageTextFromContent,
  searchPdf,
  type PdfSearchProgress,
} from "../pdfSearch";

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

describe("searchPdf", () => {
  function fakePdf(pages: string[][]) {
    return {
      numPages: pages.length,
      getPage: (page: number) => Promise.resolve({
        getTextContent: () => Promise.resolve(content(pages[page - 1])),
      }),
    };
  }

  it("reports progress per page so early hits appear before the scan ends", async () => {
    const progress: PdfSearchProgress[] = [];
    await searchPdf(fakePdf([["alpha", "beta"], ["gamma"], ["beta", "again"]]), "beta", (value) => progress.push(value));

    expect(progress.map((value) => value.pagesScanned)).toEqual([1, 2, 3]);
    expect(progress.map((value) => value.matches.length)).toEqual([1, 1, 2]);
    expect(progress.at(-1)).toMatchObject({ done: true, truncated: false, totalPages: 3 });
    expect(progress.at(-1)!.matches.map((match) => match.page)).toEqual([1, 3]);
  });

  it("stops when the caller aborts, so a superseded search does not compete", async () => {
    const signal = { aborted: false };
    const progress: PdfSearchProgress[] = [];
    await searchPdf(fakePdf([["x"], ["x"], ["x"]]), "x", (value) => {
      progress.push(value);
      signal.aborted = true;
    }, { signal });

    expect(progress).toHaveLength(1);
  });

  it("stops at the match limit and says so", async () => {
    const progress: PdfSearchProgress[] = [];
    await searchPdf(fakePdf([["x", "x"], ["x"]]), "x", (value) => progress.push(value), { limit: 2 });
    expect(progress.at(-1)).toMatchObject({ truncated: true, done: true });
    expect(progress.at(-1)!.matches).toHaveLength(2);
  });

  it("skips a page whose text cannot be read instead of failing the search", async () => {
    const pdf = {
      numPages: 2,
      getPage: (page: number) => (page === 1
        ? Promise.reject(new Error("broken page"))
        : Promise.resolve({ getTextContent: () => Promise.resolve(content(["found"])) })),
    };
    const progress: PdfSearchProgress[] = [];
    await searchPdf(pdf, "found", (value) => progress.push(value));
    expect(progress.at(-1)!.matches.map((match) => match.page)).toEqual([2]);
  });

  it("reuses a cached page instead of re-reading it for the next query", async () => {
    const cache = new Map();
    let reads = 0;
    const pdf = {
      numPages: 1,
      getPage: () => {
        reads += 1;
        return Promise.resolve({ getTextContent: () => Promise.resolve(content(["alpha", "beta"])) });
      },
    };
    await searchPdf(pdf, "alpha", () => {}, { cache });
    await searchPdf(pdf, "beta", () => {}, { cache });
    expect(reads).toBe(1);
  });
});

describe("pageHighlights", () => {
  it("separates the active match from the rest on the same page", () => {
    const matches = [
      { page: 1, from: 0, to: 3, itemIndices: [0], snippet: "" },
      { page: 1, from: 8, to: 11, itemIndices: [2, 3], snippet: "" },
      { page: 2, from: 0, to: 3, itemIndices: [0], snippet: "" },
    ];
    expect(pageHighlights(matches, 1, 1)).toEqual({ items: [0, 2, 3], activeItems: [2, 3] });
    // A page with no active match still highlights its other hits.
    expect(pageHighlights(matches, 2, 1)).toEqual({ items: [0], activeItems: [] });
  });
});
