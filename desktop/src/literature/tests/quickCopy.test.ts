import { describe, expect, it } from "vitest";
import { attachQuickCopyToDrag, buildQuickCopy } from "../quickCopy";
import type { LiteraturePaper } from "../literatureTypes";

const paper = (over: Partial<LiteraturePaper> = {}): LiteraturePaper => ({
  id: "doi:10.1/a",
  title: "Grounded Reading at Scale",
  authors: ["Ada Lovelace", "Charles Babbage"],
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

describe("Quick Copy", () => {
  it("numbers entries by selection order so numeric styles stay usable", () => {
    const payload = buildQuickCopy(
      [{ paper: paper() }, { paper: paper({ id: "doi:10.1/b", title: "Second" }) }],
      "bibliography",
      "ieee",
    );
    const lines = payload.text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("[1] ")).toBe(true);
    expect(lines[1].startsWith("[2] ")).toBe(true);
  });

  it("keeps in-text citations on one line", () => {
    const payload = buildQuickCopy(
      [{ paper: paper() }, { paper: paper({ id: "doi:10.1/b" }) }],
      "citation",
      "ieee",
    );
    expect(payload.text).toBe("[1] [2]");
    expect(payload.text).not.toContain("\n");
  });

  it("italicises the venue in the rich-text flavour and escapes the rest", () => {
    const payload = buildQuickCopy(
      [{ paper: paper({ title: "Reading <b>at</b> scale & beyond" }) }],
      "bibliography",
      "apa7",
    );
    expect(payload.html).toContain("<i>Journal of Reproducible Research</i>");
    expect(payload.html).toContain("&lt;b&gt;");
    expect(payload.html).not.toContain("<b>");
  });

  it("adds text flavours to a drag without disturbing the internal payload", () => {
    const data = new Map<string, string>();
    const transfer = {
      setData: (type: string, value: string) => void data.set(type, value),
    } as unknown as DataTransfer;
    data.set("application/x-somniq-paper-ids", "{\"ids\":[\"doi:10.1/a\"]}");

    attachQuickCopyToDrag(transfer, buildQuickCopy([{ paper: paper() }], "bibliography", "apa7"));
    expect(data.get("text/plain")).toContain("Grounded Reading at Scale");
    expect(data.get("text/html")).toContain("<p>");
    expect(data.get("application/x-somniq-paper-ids")).toBe("{\"ids\":[\"doi:10.1/a\"]}");
  });

  it("writes nothing for an empty selection", () => {
    const payload = buildQuickCopy([], "bibliography", "apa7");
    expect(payload.text).toBe("");
    const data = new Map<string, string>();
    attachQuickCopyToDrag(
      { setData: (type: string, value: string) => void data.set(type, value) } as unknown as DataTransfer,
      payload,
    );
    expect(data.size).toBe(0);
  });
});
