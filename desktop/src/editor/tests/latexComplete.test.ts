// @vitest-environment jsdom
// (only the \begin expansion needs a DOM — it dispatches through a real view.)

import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearLatexProjectSymbols,
  latexCompletionSource,
  setLatexProjectSymbols,
} from "../latexComplete";

function completeAt(doc: string, options: { explicit?: boolean } = {}) {
  const pos = doc.indexOf("|");
  const text = doc.replace("|", "");
  const state = EditorState.create({ doc: text });
  return latexCompletionSource(new CompletionContext(state, pos, options.explicit ?? false));
}

function labels(result: { options: readonly Completion[] } | null): string[] {
  return (result?.options ?? []).map((option) => option.label);
}

afterEach(() => {
  clearLatexProjectSymbols();
});

describe("latexCompletionSource", () => {
  it("completes commands from the backslash, including with nothing typed yet", () => {
    const typed = completeAt("\\sec|");
    expect(labels(typed)).toContain("\\section");
    // `from` covers the backslash so accepting replaces `\sec`, not just `sec`.
    expect(typed?.from).toBe(0);

    expect(labels(completeAt("\\|"))).toContain("\\begin");
  });

  it("does not suggest anything inside a comment", () => {
    expect(completeAt("% talk about \\sec|")).toBeNull();
    // An escaped percent is ordinary text, so completion still runs after it.
    expect(labels(completeAt("95\\% of \\sec|"))).toContain("\\section");
  });

  it("suggests environments inside \\begin{} and \\end{}", () => {
    const begun = completeAt("\\begin{item|");
    expect(labels(begun)).toContain("itemize");
    expect(begun?.from).toBe("\\begin{".length);
    expect(labels(completeAt("\\end{fig|"))).toContain("figure");
    // Commands are not offered in environment position.
    expect(labels(begun)).not.toContain("\\section");
  });

  it("expands \\begin on its own line into a closed environment block", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "  \\begin{item" }) });
    const result = completeAt("  \\begin{item|");
    const option = result?.options.find((entry) => entry.label === "itemize");
    const apply = option?.apply;
    if (typeof apply !== "function") throw new Error("expected an apply function");
    apply(view, option as Completion, "  \\begin{".length, view.state.doc.length);
    expect(view.state.doc.toString()).toBe([
      "  \\begin{itemize}",
      "    \\item ",
      "  \\end{itemize}",
    ].join("\n"));
    // Caret lands after `\item `, ready to type.
    expect(view.state.selection.main.head).toBe(view.state.doc.line(2).to);
    view.destroy();
  });

  it("completes \\ref from labels in the document and the project index", () => {
    setLatexProjectSymbols({
      labels: [{ name: "sec:method", detail: "ch3.tex" }],
      citations: [],
      files: [],
    });
    const result = completeAt("\\label{sec:intro}\nSee \\ref{sec|");
    expect(labels(result)).toEqual(["sec:intro", "sec:method"]);
    expect(result?.from).toBe("\\label{sec:intro}\nSee \\ref{".length);
  });

  it("completes the citation key being typed after a comma", () => {
    setLatexProjectSymbols({
      labels: [],
      citations: [{ name: "jaeger2004", detail: "Harnessing nonlinearity" }],
      files: [],
    });
    const result = completeAt("\\citep{lukosevicius2009, jae|");
    expect(labels(result)).toEqual(["jaeger2004"]);
    // Only the key after the comma is replaced, so the first key survives.
    expect(result?.from).toBe("\\citep{lukosevicius2009, ".length);
  });

  it("completes file paths, filtered by what each command can include", () => {
    setLatexProjectSymbols({
      labels: [],
      citations: [],
      files: [
        { name: "figures/loss.png" },
        { name: "figures/arch.pdf" },
        { name: "chapters/ch2.tex" },
        { name: "refs.bib" },
      ],
    });
    // An image command never offers a .tex; \input never offers an image, and
    // drops the extension TeX fills in itself.
    expect(labels(completeAt("\\includegraphics{fig|"))).toEqual(["figures/loss.png", "figures/arch.pdf"]);
    expect(labels(completeAt("\\input{ch|"))).toEqual(["chapters/ch2"]);
    expect(labels(completeAt("\\includegraphics[width=\\linewidth]{|"))).toHaveLength(2);
    expect(labels(completeAt("\\bibliography{|"))).toEqual(["refs"]);
  });

  it("offers no keys for a command that takes neither labels nor citations", () => {
    expect(completeAt("\\textbf{bo|")).toBeNull();
  });
});
