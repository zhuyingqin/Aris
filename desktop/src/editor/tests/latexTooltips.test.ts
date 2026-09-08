import { describe, expect, it } from "vitest";
import { scanLatexStructure } from "../../typeset/latexStructure";
import { labelTarget, mathSpanAt, referenceAt } from "../latexTooltips";

const DOC = [
  "\\documentclass{article}",
  "\\begin{document}",
  "\\section{Echo State Networks}",
  "\\label{sec:esn}",
  "Inline $x_t + y_t$ and display",
  "\\[",
  "z_t = f(W x_{t-1})",
  "\\]",
  "\\begin{align}",
  "a &= b \\\\",
  "c &= d",
  "\\end{align}",
  "See \\ref{sec:esn} and \\ref{sec:missing}, or \\href{https://example.com/a}{this}.",
  "\\end{document}",
].join("\n");

const structure = scanLatexStructure(DOC);

describe("mathSpanAt", () => {
  it("strips the delimiters so KaTeX gets only the body", () => {
    const inline = mathSpanAt(structure, DOC.indexOf("x_t + y_t") + 2);
    expect(inline).toMatchObject({ source: "x_t + y_t", display: false });

    const display = mathSpanAt(structure, DOC.indexOf("z_t = f") + 2);
    expect(display?.source.trim()).toBe("z_t = f(W x_{t-1})");
    expect(display?.display).toBe(true);
  });

  it("treats a maths environment as display maths and takes its body", () => {
    const span = mathSpanAt(structure, DOC.indexOf("a &= b") + 2);
    expect(span?.display).toBe(true);
    expect(span?.source).toContain("a &= b");
    expect(span?.source).not.toContain("\\begin{align}");
  });

  it("returns nothing in ordinary prose", () => {
    expect(mathSpanAt(structure, DOC.indexOf("Inline"))).toBeNull();
    expect(mathSpanAt(structure, DOC.indexOf("\\section"))).toBeNull();
  });
});

describe("referenceAt", () => {
  it("recognises cross-references and links, and nothing else", () => {
    expect(referenceAt(structure, DOC.indexOf("\\ref{sec:esn}") + 3))
      .toMatchObject({ kind: "reference", target: "sec:esn" });
    expect(referenceAt(structure, DOC.indexOf("\\href") + 3))
      .toMatchObject({ kind: "link", target: "https://example.com/a" });
    expect(referenceAt(structure, DOC.indexOf("See "))).toBeNull();
  });
});

describe("labelTarget", () => {
  it("reports the heading a label sits under, so a key resolves to a place", () => {
    expect(labelTarget(structure, "sec:esn")).toEqual({ line: 4, heading: "Echo State Networks" });
  });

  it("reports nothing for a key this file does not define", () => {
    expect(labelTarget(structure, "sec:missing")).toBeNull();
  });
});
