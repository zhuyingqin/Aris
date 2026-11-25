// @vitest-environment jsdom

import { diagnosticCount, forceLinting } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { clearLatexProjectSymbols, setLatexProjectSymbols } from "../latexComplete";
import { latexDiagnostics, latexLint, setLatexCompileMarkers } from "../latexLint";

function diagnose(doc: string) {
  const state = EditorState.create({ doc, extensions: [latexLint({ gutter: false })] });
  return latexDiagnostics(state);
}

afterEach(() => {
  clearLatexProjectSymbols();
});

describe("latexDiagnostics", () => {
  it("flags a \\ref with no matching \\label anywhere in the project", () => {
    setLatexProjectSymbols({ labels: [{ name: "sec:other" }], citations: [], files: [] });
    const found = diagnose("\\label{sec:here}\nSee \\ref{sec:here} and \\ref{sec:other} and \\ref{sec:typo}.");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("sec:typo");
    expect(found[0].severity).toBe("warning");
  });

  it("flags a label defined twice in the same file", () => {
    const found = diagnose("\\label{fig:a}\n\\label{fig:a}\n");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("already defined");
    // The second definition is the one marked, not the first.
    expect(found[0].from).toBe("\\label{fig:a}\n".length);
  });

  it("ignores markup inside comments", () => {
    expect(diagnose("% \\ref{sec:gone} \\label{dup}\n\\label{dup}")).toEqual([]);
  });

  it("only checks citation keys once the document's bibliography is known", () => {
    expect(diagnose("\\cite{unknown2020}")).toEqual([]);
    // Library keys offered for completion do not switch the check on.
    setLatexProjectSymbols({ labels: [], citations: [{ name: "known2020" }], files: [] });
    expect(diagnose("\\cite{unknown2020}")).toEqual([]);
    setLatexProjectSymbols({ labels: [], citations: [], files: [], bibliographyKeys: ["known2020"] });
    const found = diagnose("\\cite{known2020,unknown2020} \\nocite{*}");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("unknown2020");
  });

  it("accepts keys a thebibliography defines with \\bibitem", () => {
    setLatexProjectSymbols({ labels: [], citations: [], files: [], bibliographyKeys: [] });
    const source = "See \\cite{knuth84}.\n\\begin{thebibliography}{9}\n\\bibitem{knuth84} D. Knuth.\n\\end{thebibliography}";
    expect(diagnose(source)).toEqual([]);
  });

  it("knows labels set through environment options", () => {
    setLatexProjectSymbols({ labels: [], citations: [], files: [] });
    const source = "\\begin{lstlisting}[language=Python, label=lst:loop]\nx\n\\end{lstlisting}\nSee \\ref{lst:loop}.";
    expect(diagnose(source)).toEqual([]);
  });

  it("flags a label another file of the document also defines", () => {
    setLatexProjectSymbols({ labels: [{ name: "sec:intro" }], citations: [], files: [], crossFileDuplicateLabels: new Set(["sec:intro"]) });
    const found = diagnose("\\label{sec:intro}");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("another file");
  });

  it("shows compiler markers on their line and drops them once the line is edited", () => {
    const state = EditorState.create({
      doc: "\\documentclass{article}\n\\begin{document}\n\\bad\n\\end{document}",
      extensions: [latexLint({ gutter: false })],
    });
    const marked = state.update({
      effects: setLatexCompileMarkers.of([
        { line: 3, severity: "error", message: "Undefined control sequence" },
      ]),
    }).state;
    const [diagnostic] = latexDiagnostics(marked);
    expect(diagnostic.severity).toBe("error");
    expect(marked.doc.lineAt(diagnostic.from).number).toBe(3);

    const edited = marked.update({ changes: { from: marked.doc.length, insert: "\n" } }).state;
    expect(latexDiagnostics(edited)).toEqual([]);
  });

  it("re-runs the linter in a live view when markers arrive without an edit", async () => {
    // Markers come in after a build, when nothing in the document changed.
    // @codemirror/lint only re-checks on doc/config changes unless told to.
    const view = new EditorView({
      state: EditorState.create({
        doc: "\\documentclass{article}\n\\begin{document}\n\\bad\n\\end{document}",
        extensions: [latexLint({ gutter: false })],
      }),
      parent: document.body,
    });
    try {
      forceLinting(view);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(diagnosticCount(view.state)).toBe(0);
      view.dispatch({
        effects: setLatexCompileMarkers.of([{ line: 3, severity: "error", message: "Undefined control sequence" }]),
      });
      forceLinting(view);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(diagnosticCount(view.state)).toBe(1);
    } finally {
      view.destroy();
    }
  });
});
