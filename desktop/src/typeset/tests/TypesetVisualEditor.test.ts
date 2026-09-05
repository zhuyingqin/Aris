// @vitest-environment jsdom

import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { latexListEnterInsertion, visualThemeSpec } from "../TypesetVisualEditor";
import {
  onOpenCodeRange,
  visualBlockClick,
  visualDecorations,
  visualDecorationsExtension,
  visualNumbering,
  VISUAL_REPARSE_IDLE_MS,
  visualPointerSelecting,
  figurePathCandidates,
  uniqueFigureSearchMatch,
} from "../visualDecorations";
import { numberingPrefixFor, outlineFor } from "../outlineModel";
import { applyHeadingLevel, insertLink, type EditorAdapter } from "../editorCommands";
import { htmlClipboardToLatex } from "../latexHtmlPaste";
import { useStore } from "../../store";

beforeEach(() => {
  useStore.setState({ language: "cn", languagePreferenceSet: true });
});

describe("visual figure paths", () => {
  it("tries the source folder, project root, and standard graphics extensions", () => {
    expect(figurePathCandidates("ch2_incomplete_records", "chapters/chapter-2.tex")).toEqual([
      "chapters/ch2_incomplete_records",
      "ch2_incomplete_records",
      "chapters/ch2_incomplete_records.pdf",
      "ch2_incomplete_records.pdf",
      "chapters/ch2_incomplete_records.png",
      "ch2_incomplete_records.png",
      "chapters/ch2_incomplete_records.jpg",
      "ch2_incomplete_records.jpg",
      "chapters/ch2_incomplete_records.jpeg",
      "ch2_incomplete_records.jpeg",
      "chapters/ch2_incomplete_records.gif",
      "ch2_incomplete_records.gif",
      "chapters/ch2_incomplete_records.svg",
      "ch2_incomplete_records.svg",
      "chapters/ch2_incomplete_records.webp",
      "ch2_incomplete_records.webp",
    ]);
  });

  it("uses a project-wide figure lookup only when the file name is unambiguous", () => {
    expect(uniqueFigureSearchMatch("ch2_incomplete_records.png", [
      "figures/ch2_incomplete_records.png",
    ])).toBe("figures/ch2_incomplete_records.png");
    expect(uniqueFigureSearchMatch("plot", [
      "figures/plot.png",
      "appendix/plot.png",
    ])).toBeNull();
  });
});

describe("visual editor line metrics", () => {
  it("uses one absolute line box and a readable line-number size", () => {
    expect(visualThemeSpec[".cm-scroller"]).toMatchObject({ lineHeight: "23.275px" });
    expect(visualThemeSpec[".cm-gutters"]).toMatchObject({
      fontSize: "13px",
      lineHeight: "23.275px",
    });
    expect(visualThemeSpec[".cm-gutterElement"]).toMatchObject({
      display: "flex",
      alignItems: "center",
    });
    expect(visualThemeSpec[".cm-lineNumbers .cm-gutterElement"]).toMatchObject({
      paddingTop: "0",
    });
    expect(visualThemeSpec[".cm-lineNumbers .cm-gutterElement.cm-vis-gutter-heading-1"])
      .toMatchObject({ paddingTop: "0" });
    expect(visualThemeSpec[".cm-lineNumbers .cm-gutterElement.cm-vis-gutter-preamble"])
      .toMatchObject({ paddingTop: "15px" });
    expect(visualThemeSpec[
      "&.cm-vis-pointer-selecting .cm-activeLine, &.cm-vis-pointer-selecting .cm-activeLineGutter"
    ]).toMatchObject({ backgroundColor: "transparent" });
  });

  it("gives rich heading lines and the folded preamble their own gutter markers", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const source = [
      "\\documentclass{article}",
      "\\usepackage{amsmath}",
      "\\begin{document}",
      "\\section{Aligned heading}",
      "Body",
      "\\end{document}",
    ].join("\n");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: source,
        extensions: [lineNumbers(), visualDecorationsExtension],
      }),
    });
    try {
      const preambleNumber = parent.querySelector<HTMLElement>(".cm-vis-gutter-preamble");
      const headingNumber = parent.querySelector<HTMLElement>(".cm-vis-gutter-heading-1");
      expect(preambleNumber?.textContent).toBe("1");
      expect(headingNumber?.textContent).toBe("4");
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("contains wide visual blocks instead of enlarging the document canvas", () => {
    expect(visualThemeSpec[".cm-scroller"]).toMatchObject({
      width: "100%",
      maxWidth: "100%",
      minWidth: "0",
    });
    expect(visualThemeSpec[".cm-content"]).toMatchObject({
      flex: "1 1 0",
      maxWidth: "100%",
      minWidth: "0",
    });
    expect(visualThemeSpec[".cm-vis-page-break"]).toMatchObject({
      width: "100%",
      maxWidth: "100%",
      minWidth: "0",
    });
    expect(visualThemeSpec[".cm-vis-page-break-line"]).toMatchObject({ flex: "1 1 0" });
    expect(visualThemeSpec[".cm-vis-table-wrap"]).toMatchObject({
      maxWidth: "100%",
      overflowX: "auto",
    });
    expect(visualThemeSpec[".cm-vis-math-display"]).toMatchObject({
      maxWidth: "100%",
      overflowX: "auto",
    });
    expect(visualThemeSpec[".cm-vis-math"]).toMatchObject({
      userSelect: "text",
      WebkitUserSelect: "text",
    });
    expect(visualThemeSpec[".cm-vis-figure.cm-vis-diagram"]).toMatchObject({
      minHeight: "0",
      alignItems: "stretch",
      padding: "14px 20px",
    });
    expect(visualThemeSpec[".cm-vis-diagram-canvas"]).toMatchObject({
      overflowX: "auto",
      overflowY: "hidden",
    });
    expect(visualThemeSpec[".cm-vis-diagram-preview"]).toMatchObject({
      width: "auto",
      maxWidth: "none",
    });
    expect(visualThemeSpec[".cm-vis-diagram .cm-vis-caption"]).toMatchObject({
      textAlign: "center",
      boxShadow: "none",
    });
    expect(visualThemeSpec[".cm-line.cm-vis-structural-only-line"]).toMatchObject({
      height: "0",
      overflow: "hidden",
    });
  });
});

function visualDecorationRanges(source: string, anchor = 0, head = anchor, extensions: Extension[] = []) {
  const state = EditorState.create({
    doc: source,
    selection: EditorSelection.range(anchor, head),
    extensions: [visualDecorations, ...extensions],
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

  it("does not insert an item inside nested equations, raw environments, or comments", () => {
    const equation = "\\begin{itemize}\n\\item A\n\\begin{equation}\nx=1\n\\end{equation}\n\\end{itemize}";
    const verbatim = "\\begin{itemize}\n\\item A\n\\begin{verbatim}\nsample\n\\end{verbatim}\n\\end{itemize}";
    const comment = "\\begin{itemize}\n\\item A % explanation\n\\end{itemize}";

    expect(latexListEnterInsertion(equation, equation.indexOf("x=1") + 3)).toBeNull();
    expect(latexListEnterInsertion(verbatim, verbatim.indexOf("sample") + 3)).toBeNull();
    expect(latexListEnterInsertion(comment, comment.indexOf("explanation") + 3)).toBeNull();
  });
});

describe("visual toolbar source edits", () => {
  function captureAdapter(text: string, from: number, to = from) {
    let result: { text: string; selection: [number, number] } | null = null;
    const adapter: EditorAdapter = {
      text,
      from,
      to,
      replace: (replaceFrom, replaceTo, insert, selStart, selEnd) => {
        result = {
          text: text.slice(0, replaceFrom) + insert + text.slice(replaceTo),
          selection: [selStart, selEnd],
        };
      },
    };
    return { adapter, result: () => result };
  }

  it("replaces selected link text instead of duplicating it", () => {
    const capture = captureAdapter("Read OpenAI today", 5, 11);
    insertLink(capture.adapter);
    expect(capture.result()?.text).toBe("Read \\href{https://example.com}{OpenAI} today");
  });

  it("changes optional-title and deep sectioning commands structurally", () => {
    const source = "\\subparagraph[Short]{A \\textbf{nested} title}";
    const capture = captureAdapter(source, source.indexOf("nested"));
    applyHeadingLevel(capture.adapter, "section", "Section");
    expect(capture.result()?.text).toBe("\\section[Short]{A \\textbf{nested} title}");
  });
});

describe("formatted HTML paste", () => {
  it("converts semantic formatting, links, nested lists, and tables to LaTeX", () => {
    const latex = htmlClipboardToLatex([
      "<p><strong>Bold</strong> and <a href='https://example.com/a_b'>link</a></p>",
      "<ul><li>One<ol><li>Nested</li></ol></li></ul>",
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    ].join(""));

    expect(latex).toContain("\\textbf{Bold}");
    expect(latex).toContain("\\href{https://example.com/a\\_b}{link}");
    expect(latex).toContain("\\begin{itemize}");
    expect(latex).toContain("\\begin{enumerate}");
    expect(latex).toContain("\\begin{tabular}{|l|l|}");
    expect(latex).toContain("\\textbf{A}");
  });

  it("preserves table captions and column spans", () => {
    const latex = htmlClipboardToLatex("<table><caption>Results &amp; limits</caption><tr><th colspan='2'>Metric</th></tr><tr><td>A</td><td>B</td></tr></table>");
    expect(latex).toContain("\\begin{table}[htbp]");
    expect(latex).toContain("\\multicolumn{2}{l}{\\textbf{Metric}}");
    expect(latex).toContain("\\caption{Results \\& limits}");
  });
});

describe("visualDecorations", () => {
  it("maps prose edits incrementally and reuses that index during the idle decoration rebuild", () => {
    vi.useFakeTimers();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: "\\begin{document}\nText\n\\end{document}", extensions: [visualDecorationsExtension] }),
    });
    try {
      const initial = view.state.field(visualDecorations).structure;
      const at = view.state.doc.toString().indexOf("Text") + 4;
      view.dispatch({ changes: { from: at, insert: " one" } });
      view.dispatch({ changes: { from: at + 4, insert: " two" } });
      const mappedDecorations = view.state.field(visualDecorations);
      const mapped = mappedDecorations.structure;
      expect(mapped).not.toBe(initial);
      expect(mapped.source).toContain("Text one two");

      vi.advanceTimersByTime(VISUAL_REPARSE_IDLE_MS + 1);
      expect(view.state.field(visualDecorations)).toBe(mappedDecorations);
      expect(view.state.field(visualDecorations).structure).toBe(mapped);
    } finally {
      view.destroy();
      parent.remove();
      vi.useRealTimers();
    }
  });

  it("rebuilds decorations after idle only when an edit touches rendered content", () => {
    vi.useFakeTimers();
    const parent = document.createElement("div");
    document.body.append(parent);
    const source = "\\begin{document}\n\\section{One}\nBody\n\\end{document}";
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: source, extensions: [visualDecorationsExtension] }),
    });
    try {
      const titleEnd = source.indexOf("One") + 3;
      view.dispatch({ changes: { from: titleEnd, insert: " updated" } });
      const pending = view.state.field(visualDecorations);
      expect(pending.pendingRefresh).toBe(true);

      vi.advanceTimersByTime(VISUAL_REPARSE_IDLE_MS + 1);
      expect(view.state.field(visualDecorations)).not.toBe(pending);
      expect(view.state.field(visualDecorations).pendingRefresh).toBe(false);
    } finally {
      view.destroy();
      parent.remove();
      vi.useRealTimers();
    }
  });

  it("defers an idle decoration rebuild until a pointer selection finishes", () => {
    vi.useFakeTimers();
    const parent = document.createElement("div");
    document.body.append(parent);
    const source = "\\begin{document}\n\\section{One}\nBody\n\\end{document}";
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: source, extensions: [visualDecorationsExtension] }),
    });
    try {
      const titleEnd = source.indexOf("One") + 3;
      view.dispatch({ changes: { from: titleEnd, insert: " updated" } });
      view.dispatch({ effects: visualPointerSelecting.of(true) });
      const frozen = view.state.field(visualDecorations);
      expect(frozen.pendingRefresh).toBe(true);
      expect(frozen.pointerSelecting).toBe(true);

      vi.advanceTimersByTime(VISUAL_REPARSE_IDLE_MS + 1);
      expect(view.state.field(visualDecorations)).toBe(frozen);

      view.dispatch({ effects: visualPointerSelecting.of(false) });
      expect(view.state.field(visualDecorations)).not.toBe(frozen);
      expect(view.state.field(visualDecorations).pendingRefresh).toBe(false);
      expect(view.state.field(visualDecorations).pointerSelecting).toBe(false);
    } finally {
      view.destroy();
      parent.remove();
      vi.useRealTimers();
    }
  });

  it("ignores fake document boundaries and headings in comments or verbatim", () => {
    const source = [
      "\\begin{document}",
      "% \\section{Comment heading}",
      "% \\end{document}",
      "\\begin{verbatim}",
      "\\section{Code heading}",
      "\\end{verbatim}",
      "\\section[Short]{Real heading}",
      "\\subparagraph{Deep heading}",
      "\\end{document}",
    ].join("\n");
    const ranges = visualDecorationRanges(source);
    const real = source.indexOf("\\section[Short]");
    const deep = source.indexOf("\\subparagraph");

    expect(ranges.some((range) => range.from === real && range.className?.includes("cm-vis-heading"))).toBe(true);
    expect(ranges.some((range) => range.from === deep && range.className?.includes("cm-vis-heading"))).toBe(true);
    expect(ranges.some((range) => range.from === source.indexOf("\\section{Comment") && range.className?.includes("cm-vis-heading"))).toBe(false);
    expect(ranges.some((range) => range.from === source.indexOf("\\section{Code") && range.className?.includes("cm-vis-heading"))).toBe(false);
  });

  it("renders nested list items with the marker of their owning environment", () => {
    const source = [
      "\\begin{document}",
      "\\begin{itemize}",
      "\\item Outer",
      "\\begin{enumerate}",
      "\\item Inner",
      "\\end{enumerate}",
      "\\item Outer two",
      "\\end{itemize}",
      "\\end{document}",
    ].join("\n");
    const markers = visualDecorationRanges(source)
      .map((range) => range.widget?.toDOM())
      .filter((element) => element?.classList.contains("cm-vis-item-marker"))
      .map((element) => element?.textContent);

    expect(markers).toEqual(["•", "1.", "•"]);
  });
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

  it("folds a standalone TOC registration under its starred visual heading", () => {
    const source = [
      "\\documentclass{report}",
      "\\begin{document}",
      "\\chapter*{Agradecimientos}",
      "\\addcontentsline{toc}{chapter}{Agradecimientos}",
      "",
      "Body text.",
      "\\end{document}",
    ].join("\n");
    const commandFrom = source.indexOf("\\addcontentsline");
    const commandTo = commandFrom + "\\addcontentsline{toc}{chapter}{Agradecimientos}".length;
    const commandLineFrom = source.lastIndexOf("\n", commandFrom - 1) + 1;
    const ranges = visualDecorationRanges(source, source.length);

    expect(ranges.some((range) => range.from === commandFrom && range.to === commandTo)).toBe(true);
    expect(ranges.some((range) => (
      range.from === commandLineFrom
      && range.to === commandLineFrom
      && range.className === "cm-vis-structural-only-line"
    ))).toBe(true);
    expect(ranges.some((range) => range.className === "cm-vis-heading-line cm-vis-heading-1")).toBe(true);
  });

  // A fold that renders nothing used to leave an empty row behind: the reader
  // saw a gap they could not account for, and clicking it turned the gap back
  // into LaTeX. Every no-output fold now takes its row with it.
  function collapsedLineNumbers(source: string, anchor = 0) {
    const starts = new Set(visualDecorationRanges(source, anchor)
      .filter((range) => range.className === "cm-vis-structural-only-line")
      .map((range) => range.from));
    return source
      .split("\n")
      .map((_line, index, lines) => ({
        number: index + 1,
        from: lines.slice(0, index).reduce((total, line) => total + line.length + 1, 0),
      }))
      .filter((line) => starts.has(line.from))
      .map((line) => line.number);
  }

  it("drops the row of a marker that prints nothing, and only that row", () => {
    const source = [
      "\\documentclass{article}", // 1
      "\\begin{document}", //       2
      "\\begin{center}", //         3 — folds to nothing
      "Centered line.", //          4
      "\\end{center}", //           5 — folds to nothing
      "", //                        6 — a real paragraph break, not a fold
      "\\noindent Body text.", //   7 — the command folds, the prose stays
      "\\end{document}", //         8 — folds to nothing
    ].join("\n");

    expect(collapsedLineNumbers(source)).toEqual([3, 5, 8]);
  });

  it("drops one row for a folded option list wrapped over several lines", () => {
    // A replace decoration that swallows the line breaks renders these three
    // source lines as a single row, so exactly one line decoration collapses it.
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\begin{tcolorbox}[colback=blue!5,",
      "    boxrule=0.5pt,",
      "    arc=4pt]",
      "Boxed text.",
      "\\end{tcolorbox}",
      "\\end{document}",
    ].join("\n");

    expect(collapsedLineNumbers(source)).toEqual([3, 7, 8]);
  });

  it("keeps the row while the caret is revealing its source", () => {
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\begin{center}",
      "Centered line.",
      "\\end{center}",
      "\\end{document}",
    ].join("\n");

    expect(collapsedLineNumbers(source, source.indexOf("\\begin{center}") + 3)).toEqual([5, 6]);
  });

  it("shows a box title instead of folding the words away with its marker", () => {
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\begin{tcolorbox}[colback=blue!5, title=\\textbf{Key idea}]",
      "Boxed text.",
      "\\end{tcolorbox}",
      "\\end{document}",
    ].join("\n");
    const markerFrom = source.indexOf("\\begin{tcolorbox}");
    const label = visualDecorationRanges(source)
      .find((range) => range.from === markerFrom)
      ?.widget?.toDOM();

    expect(label?.textContent).toBe("Key idea");
    expect(label?.className).toContain("cm-vis-section-label");
    expect(collapsedLineNumbers(source)).toEqual([5, 6]);
  });

  it("paints the slide card's bottom edge on the last row that renders", () => {
    // `\end{frame}` prints nothing and is collapsed, so it cannot carry the
    // card's rounded bottom — the row above it does.
    const source = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}{Motivation}",
      "Body line.",
      "\\end{frame}",
      "\\end{document}",
    ].join("\n");
    const frameFrom = source.indexOf("\\begin{frame}");
    const bodyFrom = source.indexOf("Body line.");
    const ranges = visualDecorationRanges(source);
    const lineClassAt = (from: number) => ranges
      .filter((range) => range.from === from && range.to === from && range.className)
      .map((range) => range.className);

    expect(collapsedLineNumbers(source)).toEqual([5, 6]);
    expect(lineClassAt(frameFrom)).toContain("cm-vis-frame-first");
    expect(lineClassAt(bodyFrom)).toContain("cm-vis-frame-last");
    expect(lineClassAt(bodyFrom)).not.toContain("cm-vis-frame-first");
  });

  // The numbers in Visual mode have to be the numbers the compiled PDF prints,
  // not "however many headings this file happens to contain". The three ways a
  // file's own counters can start somewhere other than 1 are each covered here.
  // The caret is parked at the end of the document: a selection touching a
  // heading deliberately reveals its raw `\section{…}` instead of the number.
  function secnums(source: string, extensions: Extension[] = []) {
    return visualDecorationRanges(source, source.length, source.length, extensions)
      .map((range) => range.widget?.toDOM())
      .filter((element) => element?.classList.contains("cm-vis-secnum"))
      .map((element) => element?.textContent);
  }

  it("offsets heading numbers by an explicit \\setcounter", () => {
    // The dual-mode chapter file: compiled on its own it prints "Chapter 2",
    // and used to be the one place that still said "Chapter 1".
    const source = [
      "\\documentclass{book}",
      "\\begin{document}",
      "\\setcounter{chapter}{1}",
      "\\chapter{Related Work}",
      "\\section{Echo State Networks}",
      "\\subsection{Why This Thesis Selects the ESN}",
      "\\end{document}",
    ].join("\n");

    expect(secnums(source)).toEqual(["2", "2.1", "2.1.1"]);
    // The command is what makes the chapter 2, so the numbers now say what it
    // does — it no longer sits in the rendered document as raw LaTeX.
    const counterChip = visualDecorationRanges(source, source.length)
      .map((range) => range.widget?.toDOM())
      .find((element) => element?.classList.contains("cm-vis-chip-counter"));
    expect(counterChip?.textContent).toBe("chapter 计数器 → 1");
  });

  it("continues the document's numbering when the open file is an included chapter", () => {
    const root = [
      "\\documentclass{book}",
      "\\begin{document}",
      "\\chapter{Introduction}",
      "\\input{ch2}",
      "\\end{document}",
    ].join("\n");
    const chapter = "\\chapter{Foundations}\n\\section{Reservoir Computing}\nBody text.";
    const prefix = numberingPrefixFor(outlineFor(root, "main.tex", { "ch2.tex": chapter }), "ch2.tex", root);

    expect(prefix?.continued).toBe(true);
    // Numbered alone the chapter is 1; as the document's second chapter it is 2.
    expect(secnums(chapter)).toEqual(["1", "1.1"]);
    expect(secnums(chapter, [visualNumbering.of(prefix)])).toEqual(["2", "2.1"]);
  });

  it("stops numbering at the class's secnumdepth, as the PDF does", () => {
    // A book numbers down to \subsection only, so the \subsubsection below
    // carries no number in the PDF and must carry none here either.
    const source = [
      "\\documentclass{book}",
      "\\begin{document}",
      "\\chapter{Foundations}",
      "\\section{Reservoir Computing}",
      "\\subsection{Echo State Property}",
      "\\subsubsection{Spectral Radius}",
      "\\end{document}",
    ].join("\n");

    expect(secnums(source)).toEqual(["1", "1.1", "1.1.1"]);
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

  it("keeps a selected formula in raw LaTeX instead of restoring its Visual widget", () => {
    const source = [
      "\\begin{document}",
      "Let $u(t) = \\frac{x_t + y_t}{2}$ remain editable.",
      "\\[",
      "z_t = x_t + y_t",
      "\\]",
      "\\end{document}",
    ].join("\n");
    const inlineMathFrom = source.indexOf("$u(t)");
    const inlineMathTo = source.indexOf("$ remain") + 1;
    const inlineFrom = source.indexOf("u(t)");
    const inlineTo = source.indexOf("}{2}$") + 4;
    const displayMathFrom = source.indexOf("\\[");
    const displayMathTo = source.indexOf("\\]") + 2;
    const displayFrom = source.indexOf("z_t");
    const displayTo = displayFrom + "z_t = x_t".length;

    for (const [from, to, mathFrom, mathTo] of [
      [inlineFrom, inlineTo, inlineMathFrom, inlineMathTo],
      [displayFrom, displayTo, displayMathFrom, displayMathTo],
    ]) {
      const ranges = visualDecorationRanges(source, from, to);

      expect(ranges.some((range) => range.className?.includes("cm-vis-active-math-source"))).toBe(true);
      expect(ranges.some((range) => (
        range.from === mathFrom
        && range.to === mathTo
        && range.widget?.toDOM().classList.contains("cm-vis-math")
      ))).toBe(false);
    }
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

  it("reveals a selected heading's raw LaTeX after a pointer selection finishes", () => {
    const source = [
      "\\begin{document}",
      "\\section{Stable heading}",
      "Paragraph text remains selectable.",
      "\\end{document}",
    ].join("\n");
    const titleFrom = source.indexOf("Stable heading");
    const paragraphTo = source.indexOf("selectable") + "selectable".length;
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: source,
        selection: EditorSelection.cursor(source.indexOf("Paragraph")),
        extensions: [visualDecorations, visualBlockClick],
      }),
    });

    try {
      const initialDecorations = view.state.field(visualDecorations).deco;
      view.dispatch({ effects: visualPointerSelecting.of(true) });

      view.dispatch({ selection: EditorSelection.range(titleFrom, paragraphTo) });
      expect(view.state.field(visualDecorations).deco).toBe(initialDecorations);
      expect(view.dom.querySelector(".cm-vis-heading-line")?.textContent).toContain("Stable heading");

      view.dispatch({ effects: visualPointerSelecting.of(false) });
      expect(view.state.selection.main.from).toBe(titleFrom);
      expect(view.state.selection.main.to).toBe(paragraphTo);
      expect(view.dom.textContent).toContain("\\section{Stable heading}");
      expect(view.dom.querySelector(".cm-vis-secnum")).toBeNull();
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("starts one stable freeze when dragging from a generated section number", () => {
    const source = [
      "\\begin{document}",
      "\\section{Stable heading}",
      "Paragraph text.",
      "\\end{document}",
    ].join("\n");
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: source,
        extensions: [visualDecorations, visualBlockClick],
      }),
    });

    try {
      const initialDecorations = view.state.field(visualDecorations).deco;
      const sectionNumber = view.dom.querySelector<HTMLElement>(".cm-vis-secnum");
      expect(sectionNumber).not.toBeNull();
      sectionNumber!.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }));

      expect(view.state.field(visualDecorations).deco).toBe(initialDecorations);
      expect(view.state.field(visualDecorations).pointerSelecting).toBe(true);
      expect(view.dom.classList.contains("cm-vis-pointer-selecting")).toBe(true);

      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(view.state.field(visualDecorations).pointerSelecting).toBe(false);
      expect(view.dom.classList.contains("cm-vis-pointer-selecting")).toBe(false);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("keeps inline and display math mounted while a drag selection crosses them", () => {
    const source = [
      "\\begin{document}",
      "Inline $x_t + y_t$ stays stable.",
      "\\[",
      "z_t = x_t + y_t",
      "\\]",
      "Paragraph text remains selectable.",
      "\\end{document}",
    ].join("\n");
    const mathTargets: Array<[selector: string, start: number]> = [
      [".cm-vis-math:not(.cm-vis-math-display)", source.indexOf("$x_t")],
      [".cm-vis-math-display", source.indexOf("\\[")],
    ];
    for (const [selector, start] of mathTargets) {
      const parent = document.createElement("div");
      document.body.append(parent);
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc: source,
          selection: EditorSelection.cursor(source.indexOf("Paragraph")),
          extensions: [visualDecorations, visualBlockClick],
        }),
      });
      try {
        const math = view.dom.querySelector<HTMLElement>(selector);
        expect(math).not.toBeNull();
        const initialDecorations = view.state.field(visualDecorations).deco;
        math!.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }));
        view.dispatch({
          selection: EditorSelection.range(
            start,
            source.indexOf("remains selectable") + "remains selectable".length,
          ),
        });

        expect(view.state.field(visualDecorations).deco).toBe(initialDecorations);
        expect(math!.isConnected).toBe(true);
        window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        expect(view.state.selection.main.empty).toBe(false);
        expect(view.dom.querySelector(selector)).toBeNull();
      } finally {
        view.destroy();
        parent.remove();
      }
    }
  });

  it("reveals inline math source when any rendered KaTeX child is clicked", () => {
    const source = [
      "\\begin{document}",
      "Let $u(t) \\in \\mathbb{R}^m$ be the input.",
      "\\end{document}",
    ].join("\n");
    const formulaFrom = source.indexOf("$u(t)");
    const formulaTo = source.indexOf("$ be the input") + 1;
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: source,
        extensions: [visualDecorations, visualBlockClick],
      }),
    });

    try {
      const math = view.dom.querySelector<HTMLElement>(".cm-vis-math:not(.cm-vis-math-display)");
      expect(math).not.toBeNull();
      expect(math?.dataset.visualSelectFrom).toBe(String(formulaFrom));
      expect(math?.dataset.visualSelectTo).toBe(String(formulaTo));
      Object.defineProperty(math, "getBoundingClientRect", {
        value: () => ({
          left: 10,
          right: 110,
          top: 10,
          bottom: 30,
          width: 100,
          height: 20,
          x: 10,
          y: 10,
          toJSON: () => ({}),
        }),
      });
      const katexChild = math!.querySelector<HTMLElement>(".katex") ?? math!;
      katexChild.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: 60,
        clientY: 20,
      }));
      katexChild.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        clientX: 60,
        clientY: 20,
      }));

      expect(view.state.selection.main.empty).toBe(true);
      expect(view.state.selection.main.head).toBeGreaterThan(formulaFrom);
      expect(view.state.selection.main.head).toBeLessThan(formulaTo);
      expect(view.dom.textContent).toContain("$u(t) \\in \\mathbb{R}^m$");
      expect(view.dom.querySelector(".cm-vis-math")).toBeNull();
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
    expect(dom.textContent).not.toContain("TikZ diagram");
    expect(dom.textContent).toContain("A to B.");
    expect(dom.querySelector(".cm-vis-diagram-canvas > svg.cm-vis-diagram-preview")).toBeTruthy();
    expect(dom.querySelectorAll(".cm-vis-diagram-node")).toHaveLength(2);
    expect(dom.querySelectorAll("polyline")).toHaveLength(1);
    expect(dom.dataset.visualSelectFrom).toBe(String(envFrom));
    expect(dom.dataset.visualSelectTo).toBe(String(envTo));

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

  it("keeps raw table LaTeX selected after a drag starts inside a visual table", async () => {
    const source = [
      "\\begin{document}",
      "Before.",
      "\\begin{tabular}{ll}",
      "Alpha & Beta \\\\",
      "One & Two \\\\",
      "\\end{tabular}",
      "After.",
      "\\end{document}",
    ].join("\n");
    const tableFrom = source.indexOf("\\begin{tabular}");
    const tableTo = source.indexOf("\\end{tabular}") + "\\end{tabular}".length;
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: source,
        selection: EditorSelection.cursor(source.indexOf("Before")),
        extensions: [visualDecorations, visualBlockClick],
      }),
    });

    try {
      // The cells are an editable grid now, so a press on one belongs to that
      // cell. The table's own margin still selects the whole environment as a
      // single atomic range, which is what this drag path exists for.
      const cell = view.dom.querySelector<HTMLElement>(".cm-vis-table-wrap");
      expect(cell).not.toBeNull();
      cell!.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: 10,
        clientY: 10,
      }));
      cell!.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 34,
        clientY: 26,
      }));
      await Promise.resolve();

      expect(view.state.selection.main.from).toBe(tableFrom);
      expect(view.state.selection.main.to).toBe(tableTo);
      expect(view.dom.querySelector(".cm-vis-table-wrap")).toBeNull();
      expect(view.dom.textContent).toContain("\\begin{tabular}{ll}");
      expect(view.dom.textContent).toContain("\\end{tabular}");
    } finally {
      view.destroy();
      parent.remove();
    }
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

  it("renders aligned display environments through an inner KaTeX alignment", () => {
    const source = [
      "\\begin{document}",
      "\\begin{align\\*}",
      "x & = y \\\\",
      "a & = b",
      "\\end{align\\*}",
      "\\end{document}",
    ].join("\n");
    const ranges = visualDecorationRanges(source);
    const mathRange = ranges.find((range) => range.widget?.toDOM().className.includes("cm-vis-math-display"));
    const math = mathRange?.widget?.toDOM();

    expect(math).toBeTruthy();
    expect(math?.querySelector(".katex-error")).toBeNull();
    expect(math?.querySelector(".katex")).toBeTruthy();
  });

  it("renders refined cross-reference, equation, and page reference chips with target headings", () => {
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{State-of-the-Art Methods}",
      "\\label{sec:sota}",
      "\\begin{equation}",
      "\\label{eq:loss}",
      "E = mc^2",
      "\\end{equation}",
      "As shown in Section~\\ref{sec:sota}, Equation~\\eqref{eq:loss}, and page~\\pageref{sec:sota}.",
      "\\end{document}",
    ].join("\n");

    const ranges = visualDecorationRanges(source);
    const refFrom = source.indexOf("\\ref{sec:sota}");
    const eqrefFrom = source.indexOf("\\eqref{eq:loss}");
    const pagerefFrom = source.indexOf("\\pageref{sec:sota}");
    const labelFrom = source.indexOf("\\label{sec:sota}");

    const refWidget = ranges.find((r) => r.from === refFrom)?.widget?.toDOM();
    const eqrefWidget = ranges.find((r) => r.from === eqrefFrom)?.widget?.toDOM();
    const pagerefWidget = ranges.find((r) => r.from === pagerefFrom)?.widget?.toDOM();
    const labelWidget = ranges.find((r) => r.from === labelFrom)?.widget?.toDOM();

    expect(refWidget?.className).toContain("cm-vis-chip-ref");
    expect(refWidget?.textContent).toBe("sec:sota");
    expect(refWidget?.getAttribute("title")).toContain("State-of-the-Art Methods");
    expect(refWidget?.getAttribute("title")).toContain("line 4");

    expect(eqrefWidget?.className).toContain("cm-vis-chip-ref");
    expect(eqrefWidget?.textContent).toBe("(eq:loss)");

    expect(pagerefWidget?.className).toContain("cm-vis-chip-ref");
    expect(pagerefWidget?.textContent).toBe("p. sec:sota");

    expect(labelWidget?.className).toContain("cm-vis-chip-label");
    expect(labelWidget?.textContent).toBe("§ sec:sota");
    expect(labelWidget?.getAttribute("title")).toContain("\\label{sec:sota}");
  });

  it("renders citations as distinguished academic badges", () => {
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "Attention is all you need \\cite{vaswani2017attention, devlin2018bert}.",
      "\\end{document}",
    ].join("\n");

    const ranges = visualDecorationRanges(source);
    const citeFrom = source.indexOf("\\cite{vaswani2017attention, devlin2018bert}");
    const citeWidget = ranges.find((r) => r.from === citeFrom)?.widget?.toDOM();

    expect(citeWidget?.className).toContain("cm-vis-chip-cite");
    expect(citeWidget?.textContent).toBe("[vaswani2017attention; devlin2018bert]");
    expect(citeWidget?.getAttribute("title")).toContain("\\cite{vaswani2017attention, devlin2018bert}");
  });
});

