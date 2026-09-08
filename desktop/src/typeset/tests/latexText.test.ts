import { describe, expect, it } from "vitest";
import { escapeLatexText, wordCountFor } from "../latexText";

describe("escapeLatexText", () => {
  it("escapes every character TeX treats as markup", () => {
    expect(escapeLatexText("100% & #1 $x$ a_b {c}")).toBe(
      "100\\% \\& \\#1 \\$x\\$ a\\_b \\{c\\}",
    );
    expect(escapeLatexText("2^10 ~approx")).toBe("2\\textasciicircum{}10 \\textasciitilde{}approx");
  });

  it("does not re-escape the braces it just wrote for a backslash", () => {
    // Escaping `\` first and the brace class second walked back over the `{}`
    // of the fresh `\textbackslash{}` and emitted `\textbackslash\{\}`, which
    // typesets as a literal `\{}`.
    expect(escapeLatexText("a\\b")).toBe("a\\textbackslash{}b");
  });

  it("turns a non-breaking space into a TeX tie", () => {
    expect(escapeLatexText("Fig.\u00a01")).toBe("Fig.~1");
  });

  it("leaves ordinary spaces and text alone", () => {
    expect(escapeLatexText("a plain title")).toBe("a plain title");
  });
});

describe("wordCountFor", () => {
  it("counts body prose and ignores the preamble, comments and markup", () => {
    const source = [
      "\\documentclass{article}",
      "\\usepackage{amsmath}",
      "\\title{A preamble title that should not count}",
      "\\begin{document}",
      "% a comment that should not count",
      "One two three \\emph{four} five.",
      "\\label{sec:x} \\cite{jaeger2004} \\ref{sec:x}",
      "\\end{document}",
      "trailing junk after the document",
    ].join("\n");
    // "One two three four five." — the label/cite/ref keys are machinery.
    expect(wordCountFor(source)).toBe(5);
  });

  it("skips math and verbatim-like environments", () => {
    const source = [
      "\\begin{document}",
      "Before the equation.",
      "\\begin{equation}",
      "  E = mc^2 \\quad \\text{with more words here}",
      "\\end{equation}",
      "Inline $x + y$ math counts as nothing.",
      "\\begin{lstlisting}",
      "for i in range(10): print(i)",
      "\\end{lstlisting}",
      "After.",
      "\\end{document}",
    ].join("\n");
    // Before(1) the(2) equation(3) Inline(4) math(5) counts(6) as(7) nothing(8) After(9)
    expect(wordCountFor(source)).toBe(9);
  });

  it("counts CJK per character, the way texcount does", () => {
    expect(wordCountFor("\\begin{document}\n本文提出一种方法。\n\\end{document}")).toBe(8);
    // Mixed text adds the western words on top.
    expect(wordCountFor("\\begin{document}\n本文提出 echo state network 方法\n\\end{document}")).toBe(9);
  });

  it("falls back to the whole file for a chapter that has no \\begin{document}", () => {
    // The heading title is not part of the body figure, so only the sentence counts.
    expect(wordCountFor("\\chapter{Introduction}\nThis chapter has five words.")).toBe(5);
  });
});
