// @vitest-environment jsdom

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it } from "vitest";
import { latexListEnterInsertion } from "../TypesetVisualEditor";
import {
  onOpenCodeRange,
  visualBlockClick,
  visualDecorations,
} from "../visualDecorations";
import { useStore } from "../../store";

beforeEach(() => {
  useStore.setState({ language: "cn", languagePreferenceSet: true });
});

function visualDecorationRanges(source: string, anchor = 0, head = anchor) {
  const state = EditorState.create({
    doc: source,
    selection: EditorSelection.range(anchor, head),
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
  it("renders chapters after page-break commands and numbers nested sections", () => {
    const source = [
      "\\documentclass{report}",
      "\\begin{document}",
      "\\newpage",
      "\\chapter{State of the art in time series forecasting}",
      "\\section{Forecasting methods}",
      "\\subsection{Classical approaches}",
      "\\end{document}",
    ].join("\n");
    const chapterFrom = source.indexOf("\\chapter");
    const sectionFrom = source.indexOf("\\section");
    const subsectionFrom = source.indexOf("\\subsection");
    const pageBreakFrom = source.indexOf("\\newpage");
    const ranges = visualDecorationRanges(source);
    const labels = ranges
      .filter((range) => range.widget)
      .map((range) => ({ from: range.from, text: range.widget!.toDOM().textContent }));

    expect(ranges.some((range) => range.from === chapterFrom && range.className === "cm-vis-heading-line cm-vis-heading-1")).toBe(true);
    expect(ranges.some((range) => range.from === sectionFrom && range.className === "cm-vis-heading-line cm-vis-heading-2")).toBe(true);
    expect(ranges.some((range) => range.from === subsectionFrom && range.className === "cm-vis-heading-line cm-vis-heading-3")).toBe(true);
    expect(labels).toEqual(expect.arrayContaining([
      { from: chapterFrom, text: "1" },
      { from: sectionFrom, text: "1.1" },
      { from: subsectionFrom, text: "1.1.1" },
    ]));
    const pageBreak = ranges.find((range) => range.from === pageBreakFrom && range.widget);
    expect(pageBreak?.to).toBe(pageBreakFrom + "\\newpage".length);
    expect(pageBreak?.widget?.toDOM().textContent).toBe("分页符");
  });

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

  it("keeps an enclosing Beamer frame decorated when frames are nested", () => {
    const source = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}{Outer}",
      "\\begin{frame}{Inner}",
      "Inner text.",
      "\\end{frame}",
      "Outer text after the inner frame.",
      "\\end{frame}",
      "\\end{document}",
    ].join("\n");
    const outerBodyFrom = source.indexOf("Outer text after");
    const ranges = visualDecorationRanges(source);

    expect(ranges.some((range) => range.from === outerBodyFrom && range.className === "cm-vis-frame-line")).toBe(true);
  });

  it("omits synthetic zero labels in report front matter", () => {
    const source = [
      "\\documentclass{report}",
      "\\begin{document}",
      "\\section{Front matter}",
      "\\chapter{Chapter one}",
      "\\section{Body}",
      "\\end{document}",
    ].join("\n");
    const frontMatterFrom = source.indexOf("\\section{Front matter}");
    const ranges = visualDecorationRanges(source);
    const labels = ranges
      .filter((range) => range.widget)
      .map((range) => ({ from: range.from, text: range.widget!.toDOM().textContent }));

    expect(labels.some((label) => label.from === frontMatterFrom && label.text === "0")).toBe(false);
    expect(labels).toEqual(expect.arrayContaining([{ from: source.indexOf("\\chapter"), text: "1" }]));
  });

  it("reads title metadata only from the preamble and preserves revised today dates", () => {
    const source = [
      "\\documentclass{article}",
      "\\title{Preamble title}",
      "\\author{Author}",
      "\\date{\\today (revised)}",
      "\\begin{document}",
      "\\maketitle",
      "Literal body text: \\title{Wrong title}",
      "\\end{document}",
    ].join("\n");
    const makeTitleFrom = source.indexOf("\\maketitle");
    const titleRange = visualDecorationRanges(source).find((range) => range.from === makeTitleFrom);
    const dom = titleRange?.widget?.toDOM();

    expect(dom?.querySelector(".cm-vis-title-name")?.textContent).toBe("Preamble title");
    expect(dom?.querySelector(".cm-vis-title-date")?.textContent).toContain("(revised)");
  });

  it("does not rebuild decorations for cursor moves that stay in visible prose", () => {
    const source = "\\begin{document}\nVisible prose here.\\n\\textbf{Bold}\\n\\end{document}";
    const prose = source.indexOf("prose");
    const state = EditorState.create({
      doc: source,
      selection: EditorSelection.cursor(prose),
      extensions: [visualDecorations],
    });
    const initial = state.field(visualDecorations);
    const proseMove = state.update({ selection: EditorSelection.cursor(prose + 1) }).state;
    const commandMove = proseMove.update({ selection: EditorSelection.cursor(source.indexOf("textbf")) }).state;

    expect(proseMove.field(visualDecorations)).toBe(initial);
    expect(commandMove.field(visualDecorations)).not.toBe(initial);
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

  it("keeps rendered blocks stable while dragging a non-empty selection", () => {
    const source = [
      "\\begin{document}",
      "\\begin{abstract}",
      "This is the abstract body.",
      "\\end{abstract}",
      "Body text.",
      "\\end{document}",
    ].join("\n");
    const selectionFrom = source.indexOf("This");
    const selectionTo = source.indexOf("body.") + "body.".length;
    const beginFrom = source.indexOf("\\begin{abstract}");
    const ranges = visualDecorationRanges(source, selectionFrom, selectionTo);
    const labelRange = ranges.find((range) => range.from === beginFrom && range.widget);

    expect(labelRange?.widget?.toDOM().textContent).toBe("Abstract");
    expect(labelRange?.widget?.toDOM().className).toContain("cm-vis-block-target");
    expect(ranges.some((range) => range.className === "cm-vis-active-abstract-source")).toBe(false);
  });

  it("does not collapse a drag selection when mouseup lands on a visual heading", () => {
    const source = [
      "\\begin{document}",
      "\\section{Selection target}",
      "Paragraph text remains selected.",
      "\\end{document}",
    ].join("\n");
    const selectionFrom = source.indexOf("Selection target");
    const selectionTo = source.indexOf("remains selected") + "remains selected".length;
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: source,
        selection: EditorSelection.range(selectionFrom, selectionTo),
        extensions: [visualDecorations, visualBlockClick],
      }),
    });

    try {
      const heading = view.dom.querySelector<HTMLElement>(".cm-vis-heading-line");
      expect(heading).not.toBeNull();
      heading!.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }));
      expect(view.state.selection.main.from).toBe(selectionFrom);
      expect(view.state.selection.main.to).toBe(selectionTo);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("only opens title source in Code mode on an explicit double-click", () => {
    const source = [
      "\\documentclass{article}",
      "\\title{Stable selection}",
      "\\begin{document}",
      "\\maketitle",
      "\\end{document}",
    ].join("\n");
    const titleFrom = source.indexOf("Stable selection");
    const titleTo = titleFrom + "Stable selection".length;
    const jumps: Array<[number, number]> = [];
    const state = EditorState.create({
      doc: source,
      extensions: [
        onOpenCodeRange.of((from, to) => jumps.push([from, to])),
        visualDecorations,
      ],
    });
    const titleWidget: { current: HTMLElement | null } = { current: null };
    state.field(visualDecorations).deco.between(0, source.length, (_from, _to, value) => {
      const dom = value.spec.widget?.toDOM();
      const title = dom?.querySelector(".cm-vis-title-name");
      if (title instanceof HTMLElement) titleWidget.current = title;
    });

    const title = titleWidget.current;
    expect(title).not.toBeNull();
    if (!title) throw new Error("title widget was not rendered");
    title.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(jumps).toEqual([]);

    title.dispatchEvent(new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
    }));
    expect(jumps).toEqual([[titleFrom, titleTo]]);
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

  it("renders a longtable as one visual table and removes its continuation controls", () => {
    const source = [
      "\\begin{document}",
      "\\begin{longtable}{p{0.2\\textwidth}p{0.7\\textwidth}}",
      "\\caption{Chapter map}\\label{tab:map}\\\\",
      "\\toprule",
      "Chapter & Evidence \\\\",
      "\\midrule",
      "\\endfirsthead",
      "\\toprule",
      "Chapter & Evidence \\\\",
      "\\midrule",
      "\\endhead",
      "\\bottomrule",
      "\\endfoot",
      "Ch.1 & \\term{State regulation} \\evidence{doi:10.1/example}{5--6} \\\\",
      "\\end{longtable}",
      "\\end{document}",
    ].join("\n");
    const envFrom = source.indexOf("\\begin{longtable}");
    const envTo = source.indexOf("\\end{longtable}") + "\\end{longtable}".length;
    const ranges = visualDecorationRanges(source);
    const table = ranges.find((range) => range.from === envFrom && range.to === envTo && range.widget);

    expect(table?.widget).toBeTruthy();
    const dom = table!.widget!.toDOM();
    expect(dom.className).toContain("cm-vis-table-wrap");
    expect(dom.textContent).toContain("Chapter");
    expect(dom.textContent).toContain("Ch.1");
    expect(dom.textContent).toContain("State regulation");
    expect(dom.textContent).toContain("doi:10.1/example");
    expect(dom.textContent).not.toContain("endfirsthead");
    expect(dom.textContent).not.toContain("evidence");
  });

  it("renders simple user-defined text macros without exposing their TeX source", () => {
    const source = [
      "\\newcommand{\\term}[1]{\\textbf{\\textcolor{navy}{#1}}}",
      "\\newcommand{\\evidence}[2]{[\\nolinkurl{#1} p.#2]}",
      "\\newcommand{\\rc}{\\textit{Reservoir Computing} (RC)}",
      "\\begin{document}",
      "\\term{State regulation} is supported by \\evidence{doi:10.1/example}{5--6} in \\rc.",
      "\\end{document}",
    ].join("\n");
    const termFrom = source.indexOf("\\term{State regulation}");
    const evidenceFrom = source.indexOf("\\evidence{doi:10.1/example}{5--6}");
    const rcFrom = source.lastIndexOf("\\rc");
    const ranges = visualDecorationRanges(source);
    const term = ranges.find((range) => range.from === termFrom && range.widget);
    const evidence = ranges.find((range) => range.from === evidenceFrom && range.widget);
    const rc = ranges.find((range) => range.from === rcFrom && range.widget);

    expect(term?.widget?.toDOM().textContent).toBe("State regulation");
    expect(evidence?.widget?.toDOM().textContent).toBe("[doi:10.1/example p.5--6]");
    expect(rc?.widget?.toDOM().textContent).toBe("Reservoir Computing (RC)");
  });

  it("does not treat a forced line break with spacing as display math", () => {
    const source = [
      "\\newcommand{\\term}[1]{\\textbf{#1}}",
      "\\begin{document}",
      "Cover line\\\\[0.3em]",
      "\\term{Visible body text}",
      "\\[x = y\\]",
      "\\end{document}",
    ].join("\n");
    const termFrom = source.indexOf("\\term{Visible body text}");
    const displayMathFrom = source.lastIndexOf("\\[x = y\\]");
    const ranges = visualDecorationRanges(source);
    const term = ranges.find((range) => range.from === termFrom)?.widget?.toDOM();
    const displayMath = ranges.find((range) => range.from === displayMathFrom)?.widget?.toDOM();

    expect(term?.textContent).toBe("Visible body text");
    expect(displayMath?.className).toContain("cm-vis-math-display");
  });
});
