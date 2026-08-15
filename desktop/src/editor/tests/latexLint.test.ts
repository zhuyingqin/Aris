import { EditorState } from "@codemirror/state";
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

  it("only checks citation keys once a bibliography is indexed", () => {
    expect(diagnose("\\cite{unknown2020}")).toEqual([]);
    setLatexProjectSymbols({ labels: [], citations: [{ name: "known2020" }], files: [] });
    const found = diagnose("\\cite{known2020,unknown2020}");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("unknown2020");
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
});
