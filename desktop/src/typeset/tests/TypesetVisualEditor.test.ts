// @vitest-environment jsdom

import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { latexListEnterInsertion } from "../TypesetVisualEditor";
import { visualDecorations } from "../visualDecorations";

function visualDecorationRanges(source: string, anchor = 0) {
  const state = EditorState.create({
    doc: source,
    selection: EditorSelection.cursor(anchor),
    extensions: [visualDecorations],
  });
  const ranges: Array<{
    from: number;
    to: number;
    className?: string;
    widget?: { toDOM(): HTMLElement; ignoreEvent?(event: Event): boolean };
  }> = [];
  state.field(visualDecorations).deco.between(0, source.length, (from, to, value) => {
    ranges.push({
      from,
      to,
      className: value.spec.class,
      widget: value.spec.widget,
    });
  });
  return ranges;
}

describe("latexListEnterInsertion", () => {
  it("continues an itemize list with the existing indentation", () => {
    const source = [
      "\\begin{itemize}",
      "  \\item First point",
      "\\end{itemize}",
    ].join("\n");
    const cursor = source.indexOf(" point") + " point".length;

    expect(latexListEnterInsertion(source, cursor)).toEqual({
      insert: "\n  \\item ",
      selection: cursor + "\n  \\item ".length,
    });
  });

  it("continues an enumerate list with another source item", () => {
    const source = [
      "\\begin{enumerate}",
      "\\item First point",
      "\\end{enumerate}",
    ].join("\n");
    const cursor = source.indexOf("point") + "point".length;

    expect(latexListEnterInsertion(source, cursor)?.insert).toBe("\n\\item ");
  });

  it("continues a list when the cursor is on a wrapped continuation line of an item", () => {
    const source = [
      "\\begin{itemize}",
      "  \\item First point starts here",
      "    and continues on the next source line",
      "\\end{itemize}",
    ].join("\n");
    const cursor = source.indexOf("source line") + "source line".length;

    expect(latexListEnterInsertion(source, cursor)).toEqual({
      insert: "\n  \\item ",
      selection: cursor + "\n  \\item ".length,
    });
  });

  it("does not hijack Enter outside list items", () => {
    expect(latexListEnterInsertion("Plain text", "Plain".length)).toBeNull();
    expect(latexListEnterInsertion("\\begin{itemize}\ntext\n\\end{itemize}", 23)).toBeNull();
  });
});

describe("visualDecorations", () => {
  it("renders Beamer frames as numbered visual slide cards with editable titles", () => {
    const source = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}{Motivation}",
      "Body text.",
      "\\end{frame}",
      "\\end{document}",
    ].join("\n");
    const frameFrom = source.indexOf("\\begin{frame}");
    const titleFrom = source.indexOf("Motivation");
    const ranges = visualDecorationRanges(source);
    const frameHeader = ranges.find((range) => range.from === frameFrom && range.widget);

    expect(frameHeader?.widget?.toDOM().textContent).toContain("Slide 1");
    expect(ranges.some((range) => range.from === frameFrom && range.className === "cm-vis-frame-line")).toBe(true);
    expect(ranges.some((range) => range.from === frameFrom && range.className === "cm-vis-frame-first")).toBe(true);
    expect(ranges.some((range) => range.from === titleFrom && range.className === "cm-vis-frame-title")).toBe(true);
  });

  it("labels title slides and folds Beamer-only layout commands", () => {
    const source = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}",
      "\\titlepage",
      "\\column{0.5\\textwidth}",
      "Body text.",
      "\\end{frame}",
      "\\end{document}",
    ].join("\n");
    const frameFrom = source.indexOf("\\begin{frame}");
    const titlePageFrom = source.indexOf("\\titlepage");
    const columnFrom = source.indexOf("\\column");
    const ranges = visualDecorationRanges(source);
    const frameHeader = ranges.find((range) => range.from === frameFrom && range.widget);

    expect(frameHeader?.widget?.toDOM().textContent).toContain("Title slide");
    expect(ranges.some((range) => range.from === titlePageFrom && range.to === titlePageFrom + "\\titlepage".length)).toBe(true);
    expect(ranges.some((range) => range.from === columnFrom && range.to === columnFrom + "\\column{0.5\\textwidth}".length)).toBe(true);
  });

  it("reveals the complete display math environment while editing inside it", () => {
    const source = [
      "\\begin{document}",
      "Then",
      "\\begin{equation}",
      "\\mathbf{R}_b = \\frac{1}{Z_b}\\mathbf{X}_b\\mathbf{X}_b^H.",
      "\\label{eq:band-filter}",
      "\\end{equation}",
      "\\end{document}",
    ].join("\n");
    const anchor = source.indexOf("\\mathbf{R}_b");
    const ranges = visualDecorationRanges(source, anchor);
    const beginFrom = source.indexOf("\\begin{equation}");
    const beginTo = beginFrom + "\\begin{equation}".length;
    const endFrom = source.indexOf("\\end{equation}");
    const endTo = endFrom + "\\end{equation}".length;

    expect(ranges.some((range) => range.from === beginFrom && range.to === beginTo && !range.className)).toBe(false);
    expect(ranges.some((range) => range.from === endFrom && range.to === endTo && !range.className)).toBe(false);
    expect(ranges.some((range) => range.from === beginFrom && range.to === endTo && range.className === "cm-vis-active-math-source")).toBe(true);
  });

  it("renders citations as clickable inline citation chips", () => {
    const source = "\\begin{document}\nPrior work \\cite{jaeger2001,herbert2010} motivates this.\n\\end{document}";
    const ranges = visualDecorationRanges(source);
    const citeFrom = source.indexOf("\\cite");
    const citeTo = citeFrom + "\\cite{jaeger2001,herbert2010}".length;
    const cite = ranges.find((range) => range.from === citeFrom && range.to === citeTo);

    expect(cite?.widget).toBeTruthy();
    const dom = cite!.widget!.toDOM();
    expect(dom.textContent).toBe("[jaeger2001; herbert2010]");
    expect(dom.title).toContain("\\cite{jaeger2001,herbert2010}");
    expect(cite!.widget!.ignoreEvent?.(new MouseEvent("mousedown"))).toBe(false);
  });

  it("strips bare declarations and lays out an IEEE author block on \\maketitle", () => {
    const source = [
      "\\documentclass{IEEEtran}",
      "\\title{\\LARGE \\bf Multi-Scale State Decomposition}",
      "\\author{%",
      "\\authorblockN{Yingqin Zhu$^{1}$, Wen Yu$^{2}$}",
      "\\authorblockA{$^{1}$Departamento de Control Automatico, CINVESTAV}",
      "\\authorblockA{$^{2}$Departamento de Computacion, CINVESTAV}",
      "}",
      "\\begin{document}",
      "\\maketitle",
      "Body text.",
      "\\end{document}",
    ].join("\n");
    const makeTitleFrom = source.indexOf("\\maketitle");
    const ranges = visualDecorationRanges(source);
    const titleRange = ranges.find((range) => range.from === makeTitleFrom);

    expect(titleRange?.widget).toBeTruthy();
    const dom = titleRange!.widget!.toDOM();
    expect(dom.querySelector(".cm-vis-title-name")?.textContent).toBe("Multi-Scale State Decomposition");
    expect(dom.querySelector(".cm-vis-title-author")?.textContent).toBe(
      "Yingqin Zhu^1, Wen Yu^2\n^1Departamento de Control Automatico, CINVESTAV\n^2Departamento de Computacion, CINVESTAV",
    );
  });

  it("labels \\begin{abstract} and styles its body as an indented block", () => {
    const source = [
      "\\begin{document}",
      "\\begin{abstract}",
      "This is the abstract body.",
      "\\end{abstract}",
      "Body text.",
      "\\end{document}",
    ].join("\n");
    const beginFrom = source.indexOf("\\begin{abstract}");
    const bodyLineFrom = source.indexOf("This is the abstract body.");
    const ranges = visualDecorationRanges(source);

    const labelRange = ranges.find((range) => range.from === beginFrom && range.widget);
    expect(labelRange?.widget?.toDOM().textContent).toBe("Abstract");
    expect(labelRange?.widget?.toDOM().className).toContain("cm-vis-block-target");
    expect(
      ranges.some((range) => range.from === bodyLineFrom && range.className === "cm-vis-abstract-line"),
    ).toBe(true);
  });

  it("reveals both \\begin{abstract} and \\end{abstract} while editing inside it", () => {
    const source = [
      "\\begin{document}",
      "\\begin{abstract}",
      "This is the abstract body.",
      "\\end{abstract}",
      "Body text.",
      "\\end{document}",
    ].join("\n");
    const anchor = source.indexOf("This is the abstract body.");
    const beginFrom = source.indexOf("\\begin{abstract}");
    const beginTo = beginFrom + "\\begin{abstract}".length;
    const endFrom = source.indexOf("\\end{abstract}");
    const endTo = endFrom + "\\end{abstract}".length;
    const ranges = visualDecorationRanges(source, anchor);

    // Neither marker should be hidden/replaced — a caret anywhere in the
    // environment reveals it as one unit, matching math/list editing. Before
    // the `withinAbstract` exclusion, the generic unknown-environment fallback
    // independently re-hid `\end{abstract}` even though the caret revealed
    // `\begin{abstract}`, an inconsistent half-reveal.
    expect(ranges.some((range) => range.from === beginFrom && range.to === beginTo)).toBe(false);
    expect(ranges.some((range) => range.from === endFrom && range.to === endTo)).toBe(false);
  });

  it("collapses a TikZ figure (no \\includegraphics) into one diagram card instead of flowing raw \\node/\\draw lines", () => {
    const source = [
      "\\begin{document}",
      "\\begin{figure}[H]",
      "\\centering",
      "\\begin{tikzpicture}",
      "\\node (a) {A};",
      "\\node[right=of a] (b) {B};",
      "\\draw[-Latex] (a) -- (b);",
      "\\end{tikzpicture}",
      "\\caption{A to B.}",
      "\\end{figure}",
      "Body text.",
      "\\end{document}",
    ].join("\n");
    const envFrom = source.indexOf("\\begin{figure}");
    const envTo = source.indexOf("\\end{figure}") + "\\end{figure}".length;
    const ranges = visualDecorationRanges(source);

    const diagram = ranges.find((range) => range.from === envFrom && range.to === envTo && range.widget);
    expect(diagram?.widget).toBeTruthy();
    const dom = diagram!.widget!.toDOM();
    expect(dom.className).toContain("cm-vis-block-target");
    expect(dom.textContent).toContain("TikZ diagram");
    expect(dom.textContent).toContain("A to B.");

    // The raw TikZ commands must not appear as their own unwidgeted decoration
    // range — the whole float is one widget, not begin/end hidden with the body
    // still flowing as plain text.
    const nodeFrom = source.indexOf("\\node (a)");
    expect(ranges.some((range) => range.from === nodeFrom && !range.widget)).toBe(false);
  });

  it("reveals the raw TikZ source while the caret is inside the figure", () => {
    const source = [
      "\\begin{document}",
      "\\begin{figure}[H]",
      "\\begin{tikzpicture}",
      "\\node (a) {A};",
      "\\end{tikzpicture}",
      "\\end{figure}",
      "\\end{document}",
    ].join("\n");
    const anchor = source.indexOf("\\node (a)");
    const envFrom = source.indexOf("\\begin{figure}");
    const envTo = source.indexOf("\\end{figure}") + "\\end{figure}".length;
    const ranges = visualDecorationRanges(source, anchor);

    expect(ranges.some((range) => range.from === envFrom && range.to === envTo && range.widget)).toBe(false);
  });
});
