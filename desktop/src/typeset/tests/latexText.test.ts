import { describe, expect, it } from "vitest";
import { wordCountFor } from "../latexText";

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
