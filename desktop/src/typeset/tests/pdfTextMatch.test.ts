import { describe, expect, it } from "vitest";
import {
  findLatexOffsetForPdfText,
  normalizePdfText,
  pdfTextCarriesEnoughSignal,
  pdfTextLayerText,
} from "../pdfTextMatch";

describe("normalizePdfText", () => {
  it("spells out the ligatures a TeX build emits", () => {
    expect(normalizePdfText("e\uFB03cient \uFB02ow")).toBe("efficient flow");
    expect(normalizePdfText("\uFB00 \uFB01 \uFB04")).toBe("ff fi ffl");
  });

  it("collapses runs of whitespace and trims", () => {
    expect(normalizePdfText("  a \n\t b  ")).toBe("a b");
  });
});

describe("pdfTextLayerText", () => {
  it("keeps the trailing space so a selection across two items stays readable", () => {
    expect(pdfTextLayerText("develops ")).toBe("develops ");
    expect(normalizePdfText("develops ")).toBe("develops");
  });
});

describe("pdfTextCarriesEnoughSignal", () => {
  it("requires four letters or digits", () => {
    expect(pdfTextCarriesEnoughSignal("abcd")).toBe(true);
    expect(pdfTextCarriesEnoughSignal("abc")).toBe(false);
  });

  it("ignores punctuation and whitespace when counting", () => {
    expect(pdfTextCarriesEnoughSignal("a.b, c-d")).toBe(true);
    expect(pdfTextCarriesEnoughSignal("(...)")).toBe(false);
    expect(pdfTextCarriesEnoughSignal("a-b")).toBe(false);
  });

  it("refuses a single CJK glyph, which is what pdf.js emits per character", () => {
    expect(pdfTextCarriesEnoughSignal("第")).toBe(false);
    expect(pdfTextCarriesEnoughSignal("第一章节")).toBe(true);
  });

  it("counts a ligature as the letters it spells out", () => {
    // "\uFB03ce" is 3 code points but reads as "ffice" — four letters.
    expect(pdfTextCarriesEnoughSignal("\uFB03ce")).toBe(true);
  });
});

describe("findLatexOffsetForPdfText", () => {
  it("returns null for text that normalises away", () => {
    expect(findLatexOffsetForPdfText("hello", "   ")).toBeNull();
  });

  it("returns null when no line can host the text", () => {
    expect(findLatexOffsetForPdfText("alpha\nbeta\n", "gamma")).toBeNull();
  });

  it("does not resolve to a blank line just because every string contains the empty one", () => {
    // Regression: the trailing "\n" makes a final empty line, and the
    // `target.includes(line)` branch used to accept it for any target of four
    // characters or more, so a lookup for absent text jumped to that offset.
    expect(findLatexOffsetForPdfText("alpha\n\n\nbeta\n", "gamma")).toBeNull();
    expect(findLatexOffsetForPdfText("\n\n\n", "missing")).toBeNull();
  });

  it("locates plain body text and reports source offsets", () => {
    const source = "\\section{Intro}\nThe method converges quickly.\n";
    const match = findLatexOffsetForPdfText(source, "converges");
    expect(match).not.toBeNull();
    expect(source.slice(match!.start, match!.end)).toBe("converges");
  });

  it("sees through a markup wrapper to the text the PDF actually shows", () => {
    const source = "intro line\nwe use \\textbf{gradient} descent\n";
    const match = findLatexOffsetForPdfText(source, "gradient");
    expect(source.slice(match!.start, match!.end)).toBe("gradient");
  });

  it("searches the raw line too, so comment text can still match", () => {
    // Documented behaviour rather than an endorsement: only `plainLine` strips
    // comments, `rawLine` does not. It matters because a body hit scores 60
    // and a raw-line hit 40, so real text always outranks a comment.
    const commentOnly = "% discarded marker here\nreal body text\n";
    expect(findLatexOffsetForPdfText(commentOnly, "discarded")).not.toBeNull();

    const both = "% shared marker here\nfiller line\nshared marker here in body\n";
    const match = findLatexOffsetForPdfText(both, "shared marker");
    expect(match!.start).toBeGreaterThan(both.indexOf("filler line"));
  });

  it("prefers the occurrence whose neighbours match the surrounding PDF text", () => {
    const source = [
      "alpha filler one",
      "the shared phrase appears",
      "beta filler two",
      "",
      "gamma marker three",
      "the shared phrase appears",
      "delta marker four",
    ].join("\n");
    const match = findLatexOffsetForPdfText(
      source,
      "shared phrase",
      "gamma marker three the shared phrase appears delta marker four",
    );
    expect(match).not.toBeNull();
    // Second occurrence starts after the first one.
    expect(match!.start).toBeGreaterThan(source.indexOf("beta filler two"));
  });

  it("ties break toward the earliest offset", () => {
    const source = "repeat token\nrepeat token\n";
    const match = findLatexOffsetForPdfText(source, "repeat token");
    expect(match!.start).toBe(0);
  });

  it("falls back to a word inside the target when the whole run is not on the line", () => {
    const source = "\\emph{convergence} of the estimator\n";
    const match = findLatexOffsetForPdfText(source, "convergence of");
    expect(match).not.toBeNull();
    expect(match!.start).toBeGreaterThanOrEqual(0);
    expect(match!.end).toBeGreaterThan(match!.start);
  });
});
