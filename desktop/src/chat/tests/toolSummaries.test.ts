import { describe, expect, it } from "vitest";
import type { ChatBlock } from "../../types";
import {
  evidenceSearchSummaryFromTool,
  evidenceSourcesFromTool,
  imagePathsFromTool,
  oracleWebSummaryFromTool,
  webSearchSummaryFromTool,
} from "../toolSummaries";

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;

function tool(name: string, input: unknown, output?: unknown): ToolBlock {
  return {
    kind: "tool",
    name,
    input: typeof input === "string" ? input : JSON.stringify(input),
    ...(output === undefined
      ? {}
      : { output: typeof output === "string" ? output : JSON.stringify(output) }),
  } as ToolBlock;
}

describe("evidenceSearchSummaryFromTool", () => {
  it("ignores blocks from other tools", () => {
    expect(evidenceSearchSummaryFromTool(tool("WebSearch", {}, {}))).toBeNull();
  });

  it("reads the compact contract and tags each item's provenance", () => {
    const summary = evidenceSearchSummaryFromTool(tool("ProjectEvidenceSearch", { query: "asked" }, {
      query: "resolved",
      status: "ok",
      confirmedKnowledge: [{ statement: "A holds", evidence: [{ citation: "[smith2020 p.3]" }] }],
      pdfEvidence: [{ excerpt: "raw text", paperId: "jones2021", pageStart: 7 }],
    }));
    expect(summary).toEqual({
      query: "resolved",
      status: "ok",
      items: [
        { citation: "[smith2020 p.3]", excerpt: "A holds", sourceType: "confirmedKnowledge" },
        { citation: "[jones2021 p.7]", excerpt: "raw text", sourceType: "originalPdfText" },
      ],
    });
  });

  it("falls back to the input query when the output omits one", () => {
    const summary = evidenceSearchSummaryFromTool(
      tool("ProjectEvidenceSearch", { query: "asked" }, { status: "ok" }),
    );
    expect(summary?.query).toBe("asked");
  });

  it("drops items with no usable excerpt rather than rendering blanks", () => {
    const summary = evidenceSearchSummaryFromTool(tool("ProjectEvidenceSearch", {}, {
      confirmedKnowledge: [{ statement: "   ", evidence: [] }, { evidence: [] }],
      pdfEvidence: [{ excerpt: "" }],
    }));
    expect(summary?.items).toEqual([]);
  });

  it("still reads sessions saved under the older full-response shape", () => {
    const summary = evidenceSearchSummaryFromTool(tool("ProjectEvidenceSearch", {}, {
      knowledge: { results: [{ knowledge: { statement: "legacy point", evidence: [{ paperId: "old2019", page: 2 }] } }] },
      literature: { results: [{ chunk: { text: "legacy chunk", paperId: "old2019", pageStart: 5 } }] },
    }));
    expect(summary?.items).toEqual([
      { citation: "[old2019 p.2]", excerpt: "legacy point", sourceType: "confirmedKnowledge" },
      { citation: "[old2019 p.5]", excerpt: "legacy chunk", sourceType: "originalPdfText" },
    ]);
  });

  it("omits the page when the legacy record carries no finite page number", () => {
    const summary = evidenceSearchSummaryFromTool(tool("ProjectEvidenceSearch", {}, {
      knowledge: { results: [{ knowledge: { answer: "no page", evidence: [{ paperId: "x2020" }] } }] },
    }));
    expect(summary?.items[0]?.citation).toBe("[x2020]");
  });
});

describe("webSearchSummaryFromTool", () => {
  it("returns null while the call is still in flight", () => {
    expect(webSearchSummaryFromTool(tool("WebSearch", { query: "q" }))).toBeNull();
  });

  it("keeps only attempts that carry both a provider and coverage", () => {
    const summary = webSearchSummaryFromTool(tool("WebSearch", { query: "q" }, {
      status: "ok",
      sourceAttempts: [
        { provider: "openalex", status: "ok", coverage: { fetched: 10, unique: 8 } },
        { status: "ok", coverage: { fetched: 1, unique: 1 } },
        { provider: "scopus" },
      ],
    }));
    expect(summary?.attempts.map((a) => a.provider)).toEqual(["openalex"]);
  });
});

describe("oracleWebSummaryFromTool", () => {
  it("ignores unrelated tools", () => {
    expect(oracleWebSummaryFromTool(tool("bash", "ls"))).toBeNull();
  });
});

describe("imagePathsFromTool", () => {
  it("projects only the canonical artifact for oracle image output", () => {
    const paths = imagePathsFromTool(
      tool("ChatGptWebImage", {}, { images: [{ path: "figures/out.png" }, "figures/out.png"] }),
      null,
    );
    expect(paths).toEqual(["figures/out.png"]);
  });

  it("does not mine shell output for incidental image paths", () => {
    const paths = imagePathsFromTool(
      tool("bash", "cp a.png figures/", "copied figures/plot.png"),
      null,
    );
    expect(paths).toEqual([]);
  });

  it("still surfaces the written file when a shell change is attached", () => {
    const paths = imagePathsFromTool(
      tool("bash", "cp a.png figures/", "copied figures/plot.png"),
      { path: "figures/plot.png", diff: "" },
    );
    expect(paths).toEqual(["figures/plot.png"]);
  });

  it("reads paths out of structured non-shell output", () => {
    const paths = imagePathsFromTool(tool("write_file", {}, { path: "docs/diagram.svg" }), null);
    expect(paths).toContain("docs/diagram.svg");
  });
});

describe("evidenceSourcesFromTool", () => {
  it("returns nothing for tools that carry no evidence", () => {
    expect(evidenceSourcesFromTool(tool("bash", "ls", "a b c"))).toEqual([]);
  });
});
