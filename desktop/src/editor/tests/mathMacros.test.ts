import { EditorState } from "@codemirror/state";
import katex from "katex";
import { describe, expect, it } from "vitest";
import { scanLatexStructure } from "../latex/latexStructure";
import { latexMathMacros, mathMacrosFor, mathMacrosFromSource, stripLatexComments } from "../latex/mathMacros";

describe("mathMacrosFromSource", () => {
  it("reads the definitions research preambles use", () => {
    const macros = mathMacrosFromSource([
      "\\documentclass{article}",
      "\\newcommand{\\R}{\\mathbb{R}}",
      "\\newcommand\\E{\\mathbb{E}}",
      "\\renewcommand{\\vec}[1]{\\boldsymbol{#1}}",
      "\\DeclareMathOperator{\\Tr}{Tr}",
      "\\DeclareMathOperator*{\\argmin}{arg\\,min}",
      "\\def\\eps{\\varepsilon}",
      "\\newcommand{\\opt}[1][x]{#1}",
      "% \\newcommand{\\gone}{G}",
      "\\begin{document}",
      "\\newcommand{\\body}{B}",
    ].join("\n"));
    expect(macros).toEqual({
      "\\R": "\\mathbb{R}",
      "\\E": "\\mathbb{E}",
      "\\vec": "\\boldsymbol{#1}",
      "\\Tr": "\\operatorname{Tr}",
      "\\argmin": "\\operatorname*{arg\\,min}",
      "\\eps": "\\varepsilon",
    });
  });

  it("lets KaTeX render a formula built from them", () => {
    // KaTeX happens to ship \R itself; \RR and \Tr are the kind it does not.
    const macros = mathMacrosFromSource("\\newcommand{\\RR}{\\mathbb{R}}\n\\DeclareMathOperator{\\Tr}{Tr}");
    expect(() => katex.renderToString("x \\in \\RR, \\Tr(A)", { throwOnError: true, macros: { ...macros } })).not.toThrow();
    expect(() => katex.renderToString("x \\in \\RR", { throwOnError: true })).toThrow();
    expect(() => katex.renderToString("\\Tr(A)", { throwOnError: true })).toThrow();
  });

  it("overlays the open file's definitions on the root document's", () => {
    const state = EditorState.create({
      doc: "\\newcommand{\\R}{\\mathbf{R}}\n\\begin{document}$\\R$\\end{document}",
      extensions: [latexMathMacros.of({ "\\R": "\\mathbb{R}", "\\N": "\\mathbb{N}" })],
    });
    expect(mathMacrosFor(state)).toEqual({ "\\R": "\\mathbf{R}", "\\N": "\\mathbb{N}" });
  });
});

describe("stripLatexComments", () => {
  it("keeps an escaped percent sign", () => {
    expect(stripLatexComments("Accuracy (95\\% CI) of models")).toBe("Accuracy (95\\% CI) of models");
    expect(stripLatexComments("71.2\\% & 3 \\\\ % note\nnext")).toBe("71.2\\% & 3 \\\\ next");
    expect(stripLatexComments("% one\n% two\nkept")).toBe("kept");
  });
});

describe("inline math pairing", () => {
  it("continues a $…$ across a single line break, as TeX does", () => {
    const source = "where $a +\nb$ and $c$ hold.";
    const structure = scanLatexStructure(source);
    expect(structure.isMath(source.indexOf("b$"))).toBe(true);
    expect(structure.isMath(source.indexOf(" and "))).toBe(false);
    expect(structure.isMath(source.indexOf("c$"))).toBe(true);
  });

  it("does not let an unclosed $ swallow structure that cannot be math", () => {
    const source = "$unfinished note\n\\begin{itemize}\n  \\item Case: $K_h$ converges.\n\\end{itemize}";
    const structure = scanLatexStructure(source);
    expect(structure.isMath(source.indexOf("\\begin{itemize}"))).toBe(false);
    expect(structure.isMath(source.indexOf("K_h"))).toBe(true);
    expect(structure.isMath(source.indexOf(" converges"))).toBe(false);
  });

  it("still ends an unclosed $ at a paragraph break", () => {
    const source = "Price $5\n\nThen $x$ here.";
    const structure = scanLatexStructure(source);
    expect(structure.isMath(source.indexOf("Then"))).toBe(false);
    expect(structure.isMath(source.indexOf("x$"))).toBe(true);
  });
});
