import { describe, expect, it } from "vitest";
import { bibEntryDetail, bibliographyTargets, parseBibEntries } from "../latexBib";

describe("parseBibEntries", () => {
  it("reads keys and the fields the completion popup shows", () => {
    const entries = parseBibEntries(`
      @article{jaeger2004harnessing,
        title = {Harnessing nonlinearity: predicting chaotic systems},
        author = {Jaeger, Herbert and Haas, Harald},
        journal = {Science},
        year = {2004}
      }
      @inproceedings{vaswani2017,
        title = "Attention is all you need",
        year = 2017
      }
    `);
    expect(entries.map((entry) => entry.key)).toEqual(["jaeger2004harnessing", "vaswani2017"]);
    expect(entries[0]).toMatchObject({
      entryType: "article",
      title: "Harnessing nonlinearity: predicting chaotic systems",
      year: "2004",
    });
    // Quoted and bare values parse the same as braced ones.
    expect(entries[1].title).toBe("Attention is all you need");
    expect(entries[1].year).toBe("2017");
    expect(bibEntryDetail(entries[0])).toBe("Jaeger · 2004 · Harnessing nonlinearity: predicting chaotic systems");
  });

  it("keeps nested braces and drops TeX accents in a title", () => {
    const [entry] = parseBibEntries("@book{k1, title = {The {LaTeX} Companion by Lukoševi\\v{c}ius}}");
    expect(entry.title).toBe("The LaTeX Companion by Lukoševicius");
  });

  it("skips @string/@comment and recovers after a broken entry", () => {
    const entries = parseBibEntries(`
      @string{ieee = "IEEE Transactions"}
      @article{broken, title = {Unclosed
      @article{good, title = {Fine}, year = {2020}}
    `);
    expect(entries.map((entry) => entry.key)).toContain("good");
    expect(entries.map((entry) => entry.key)).not.toContain("ieee");
  });
});

describe("bibliographyTargets", () => {
  it("collects every declared bibliography, including comma lists", () => {
    expect(bibliographyTargets("\\bibliography{cas-refs,extra}\n\\addbibresource{other.bib}"))
      .toEqual(["cas-refs", "extra", "other.bib"]);
    // \bibliographystyle names a style, not a source.
    expect(bibliographyTargets("\\bibliographystyle{plain}")).toEqual([]);
  });
});
