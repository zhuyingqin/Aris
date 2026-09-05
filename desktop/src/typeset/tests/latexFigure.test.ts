import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIGURE_DRAFT,
  figureIncludeCommand,
  figureSnippet,
  includeGraphicsAt,
  isFigureImage,
  suggestedFigureLabel,
  widthFractionFrom,
} from "../latexFigure";

describe("figureSnippet", () => {
  it("writes a float that compiles as it stands", () => {
    expect(figureSnippet({
      ...DEFAULT_FIGURE_DRAFT,
      path: "figures/wake.pdf",
      caption: "Wake-affected sector",
      label: "fig:wake",
    })).toBe([
      "\\begin{figure}[htbp]",
      "\\centering",
      "\\includegraphics[width=0.8\\linewidth]{figures/wake.pdf}",
      "\\caption{Wake-affected sector}",
      // The label follows the caption: above it, `\ref` would resolve to the
      // enclosing section instead of the figure.
      "\\label{fig:wake}",
      "\\end{figure}",
    ].join("\n"));
  });

  it("omits the parts the user left empty rather than emitting placeholders", () => {
    const bare = figureSnippet({
      ...DEFAULT_FIGURE_DRAFT,
      path: "plot.png",
      caption: "",
      label: "",
      placement: "",
      centered: false,
      widthFraction: 0,
    });
    expect(bare).toBe("\\begin{figure}\n\\includegraphics{plot.png}\n\\end{figure}");
  });

  it("sizes against \\linewidth so it still fits in a two-column layout", () => {
    expect(figureIncludeCommand({ path: "a.png", widthFraction: 0.5 }))
      .toBe("\\includegraphics[width=0.5\\linewidth]{a.png}");
    expect(figureIncludeCommand({ path: "a.png", widthFraction: 0 })).toBe("\\includegraphics{a.png}");
    // Windows-style separators would break the TeX path.
    expect(figureIncludeCommand({ path: "figures\\a.png", widthFraction: 0 }))
      .toBe("\\includegraphics{figures/a.png}");
  });
});

describe("suggestedFigureLabel", () => {
  it("derives a conventional label from the file name", () => {
    expect(suggestedFigureLabel("figures/Wake Effect v2.pdf")).toBe("fig:wake-effect-v2");
    expect(suggestedFigureLabel("a.png")).toBe("fig:a");
    expect(suggestedFigureLabel("")).toBe("");
  });
});

describe("includeGraphicsAt", () => {
  const source = "Text \\includegraphics[width=0.6\\linewidth]{figures/a.pdf} more \\includegraphics{b.png} end";

  it("finds the command the caret is inside, not merely the first one", () => {
    const second = source.indexOf("\\includegraphics{b.png}") + 5;
    expect(includeGraphicsAt(source, second)).toMatchObject({ path: "b.png", widthFraction: 0 });

    const first = source.indexOf("\\includegraphics[") + 5;
    expect(includeGraphicsAt(source, first)).toMatchObject({ path: "figures/a.pdf", widthFraction: 0.6 });
  });

  it("returns null when the caret is in ordinary prose", () => {
    expect(includeGraphicsAt(source, 2)).toBeNull();
  });
});

describe("widthFractionFrom", () => {
  it("reads the relative widths it can round-trip and ignores the rest", () => {
    expect(widthFractionFrom("[width=0.75\\linewidth]")).toBe(0.75);
    expect(widthFractionFrom("[width=.5\\textwidth]")).toBe(0.5);
    // A fixed size or a scale is left alone rather than silently converted.
    expect(widthFractionFrom("[width=3cm]")).toBe(0);
    expect(widthFractionFrom("[scale=0.4]")).toBe(0);
    expect(widthFractionFrom("")).toBe(0);
  });
});

describe("isFigureImage", () => {
  it("accepts what \\includegraphics accepts and nothing else", () => {
    expect(["a.pdf", "b.PNG", "c.jpeg", "d.eps"].every(isFigureImage)).toBe(true);
    expect(["chapter.tex", "refs.bib", "notes.md"].some(isFigureImage)).toBe(false);
  });
});
