import { describe, expect, it } from "vitest";
import { buildLiteratureReport, type ReportOptions } from "../report";
import type { LiteraturePaper } from "../literatureTypes";

const labels: ReportOptions["labels"] = {
  generated: "Generated",
  itemCount: (count) => `${count} item(s)`,
  abstract: "Abstract",
  tags: "Tags",
  notes: "Notes",
  annotations: "Annotations",
  page: (page) => `p. ${page}`,
  empty: "No items selected.",
};

const paper = (over: Partial<LiteraturePaper> = {}): LiteraturePaper => ({
  id: "doi:10.1/a",
  title: "Grounded Reading at Scale",
  authors: ["Ada Lovelace"],
  year: 2024,
  venue: "Journal of Reproducible Research",
  abstract: "",
  url: "",
  source: "crossref",
  stage: "inbox",
  tags: [],
  collectionIds: [],
  searchIds: [],
  starred: false,
  unread: false,
  pdf: { status: "none" },
  ...over,
} as LiteraturePaper);

describe("literature report", () => {
  it("is a self-contained document with no script", () => {
    const html = buildLiteratureReport([{ paper: paper() }], {
      title: "Literature report",
      style: "apa7",
      generatedAt: "2026-08-30T00:00:00Z",
      labels,
    });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toContain("<script");
    // Nothing may be fetched from the network when the file is opened later.
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).toContain("Grounded Reading at Scale");
    expect(html).toContain("1 item(s)");
  });

  it("includes only the sections an item actually has", () => {
    const bare = buildLiteratureReport([{ paper: paper() }], {
      title: "R",
      style: "apa7",
      labels,
    });
    expect(bare).not.toContain("Abstract");
    expect(bare).not.toContain("Notes");

    const rich = buildLiteratureReport(
      [{
        paper: paper({
          abstract: "First paragraph.\n\nSecond paragraph.",
          tags: ["method", "baseline"],
          notes: [{
            id: "note-1",
            title: "Reading note",
            content: "Worth revisiting.",
            createdAt: "2026-08-01T00:00:00Z",
            updatedAt: "2026-08-01T00:00:00Z",
          }],
          pdfAnnotations: [{
            id: "ann-1",
            page: 7,
            quote: "the central claim",
            note: "check the derivation",
            kind: "core",
            createdAt: "2026-08-01T00:00:00Z",
          }],
        }),
      }],
      { title: "R", style: "apa7", labels },
    );
    expect(rich).toContain("Abstract");
    expect(rich).toContain("<p>First paragraph.</p><p>Second paragraph.</p>");
    expect(rich).toContain("baseline");
    expect(rich).toContain("Reading note");
    expect(rich).toContain("the central claim");
    expect(rich).toContain("p. 7");
  });

  it("escapes item content instead of rendering it", () => {
    const html = buildLiteratureReport(
      [{ paper: paper({ title: "<img src=x onerror=alert(1)>" }) }],
      { title: "R", style: "apa7", labels },
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("says so rather than producing an empty page", () => {
    const html = buildLiteratureReport([], { title: "R", style: "apa7", labels });
    expect(html).toContain("No items selected.");
    expect(html).toContain("0 item(s)");
  });
});
