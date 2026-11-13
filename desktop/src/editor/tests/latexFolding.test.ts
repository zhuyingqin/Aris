// @vitest-environment jsdom

import { foldAll, foldCode, foldable, foldedRanges, unfoldAll, unfoldCode } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { latexEnvironmentFolding } from "../latexFolding";
import { loadLanguageExtension } from "../editorLanguages";
import { createSharedEditorView, reconfigureLanguage } from "../editorView";
import type { SharedEditorHandle } from "../editorTypes";

// JSDOM has no layout engine; CodeMirror's selection layer measures ranges
// while waiting for a lazy language load. Real gutter clicks are checked in
// the browser separately.
if (!Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
}

function stateFor(source: string): EditorState {
  return EditorState.create({ doc: source, extensions: [latexEnvironmentFolding] });
}

function foldAt(state: EditorState, lineNumber: number) {
  const line = state.doc.line(lineNumber);
  return foldable(state, line.from, line.to);
}

function currentFolds(state: EditorState) {
  const ranges: { from: number; to: number }[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => { ranges.push({ from, to }); });
  return ranges;
}

const handles: SharedEditorHandle[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy();
  document.body.replaceChildren();
});

async function mount(source: string, surface: "code" | "typeset" = "code") {
  const host = document.createElement("div");
  document.body.append(host);
  const handle = createSharedEditorView(host, { doc: source, language: "latex", surface });
  handles.push(handle);
  // The factory uses the same cached lazy language extension.
  await loadLanguageExtension("latex", surface);
  await Promise.resolve();
  return handle;
}

describe("LaTeX environment folding", () => {
  it("keeps the begin and end tags and adjacent source visible", () => {
    const source = "Before \\begin{equation}\n  E=mc^2\n\\end{equation} After";
    const state = stateFor(source);
    const range = foldAt(state, 1)!;
    expect(source.slice(0, range.from) + "…" + source.slice(range.to))
      .toBe("Before \\begin{equation}…\\end{equation} After");
    expect(foldAt(state, 2)).toBeNull();
    expect(foldAt(state, 3)).toBeNull();
  });

  it("pairs nested environments of the same and different kinds independently", () => {
    const source = [
      "\\begin{itemize}", "  \\item Outer", "  \\begin{itemize}",
      "    \\begin{equation}", "      x = y", "    \\end{equation}",
      "  \\end{itemize}", "\\end{itemize}",
    ].join("\n");
    const state = stateFor(source);
    expect(foldAt(state, 1)?.to).toBe(source.lastIndexOf("\\end{itemize}"));
    expect(foldAt(state, 3)?.to).toBe(source.indexOf("\\end{itemize}"));
    expect(foldAt(state, 4)?.to).toBe(source.indexOf("\\end{equation}"));
  });

  it.each(["align*", "align\\*", "mycustomtheorem"])("folds %s environments", (name) => {
    const source = `\\begin{${name}}\n  x = y\n\\end{${name}}`;
    expect(foldAt(stateFor(source), 1)?.to).toBe(source.indexOf("\\end"));
  });

  it("offers the fold on the opening line even when TikZ options span lines", () => {
    const source = [
      "\\begin{tikzpicture}[", "  scale=2,", "  node distance=1cm", "]",
      "  \\node {Example};", "\\end{tikzpicture}",
    ].join("\n");
    const state = stateFor(source);
    const range = foldAt(state, 1)!;
    expect(range.from).toBe(state.doc.line(1).to);
    expect(range.to).toBe(source.indexOf("\\end"));
    expect(foldAt(state, 2)).toBeNull();
  });

  it("uses the outer environment when multiple begin tags share a line", () => {
    const source = "\\begin{figure}\\begin{center}\nBody\n\\end{center}\n\\end{figure}";
    const state = stateFor(source);
    expect(foldAt(state, 1)).toEqual({ from: "\\begin{figure}".length, to: source.lastIndexOf("\\end") });
  });

  it("ignores commented tags and escaped begin commands while honoring escaped percent signs", () => {
    const source = [
      "% \\begin{fake}", "% Body", "% \\end{fake}",
      "\\\\begin{fake}", "Body", "\\\\end{fake}",
      "\\verb|\\begin{fake}|", "Body", "\\verb|\\end{fake}|",
      "\\% \\begin{equation}", "% \\end{equation}", "x = y", "\\end{equation}",
    ].join("\n");
    const state = stateFor(source);
    for (let line = 1; line <= state.doc.lines; line += 1) {
      if (line !== 10) expect(foldAt(state, line)).toBeNull();
    }
    expect(foldAt(state, 10)?.to).toBe(source.lastIndexOf("\\end{equation}"));
  });

  it.each(["verbatim", "minted", "lstlisting", "comment"])(
    "folds %s itself without interpreting its example tags",
    (name) => {
      const source = [
        `\\begin{${name}}`, "\\begin{equation}", "x = y", "\\end{equation}", `\\end{${name}}`,
      ].join("\n");
      const state = stateFor(source);
      expect(foldAt(state, 1)?.to).toBe(source.lastIndexOf("\\end"));
      expect(foldAt(state, 2)).toBeNull();
    },
  );

  it.each([
    "\\begin{equation}\nx = y",
    "\\begin{equation}\nx = y\n\\end{align}",
    "\\begin{equation}x = y\\end{equation}",
    "\\end{equation}",
  ])("does not fold incomplete, unmatched or single-line environments: %s", (source) => {
    const state = stateFor(source);
    for (let line = 1; line <= state.doc.lines; line += 1) expect(foldAt(state, line)).toBeNull();
  });

  it("refreshes the pairing after edits and never reuses stale positions", () => {
    let state = stateFor("\\begin{equation}\nx = y\n\\end{equation}");
    expect(foldAt(state, 1)).not.toBeNull();
    state = state.update({ changes: { from: 0, insert: "% Heading\n" } }).state;
    expect(foldAt(state, 1)).toBeNull();
    expect(foldAt(state, 2)?.to).toBe(state.doc.toString().indexOf("\\end"));
    const closingName = state.doc.toString().lastIndexOf("equation");
    state = state.update({ changes: { from: closingName, to: closingName + 8, insert: "align" } }).state;
    expect(foldAt(state, 2)).toBeNull();
  });
});

describe("source editor folding integration", () => {
  const source = "\\begin{itemize}\n  \\item A\n  \\begin{equation}\n    x = y\n  \\end{equation}\n\\end{itemize}";

  it("supports native fold/unfold, retains nested folds and never changes the document", async () => {
    const handle = await mount(source);
    const { view } = handle;
    await vi.waitFor(() => expect(foldAt(view.state, 1)).not.toBeNull());
    const originalDoc = view.state.doc;
    const innerLine = view.state.doc.line(3).from;
    view.dispatch({ selection: { anchor: innerLine } });
    expect(foldCode(view)).toBe(true);
    expect(currentFolds(view.state)).toHaveLength(1);
    view.dispatch({ selection: { anchor: 0 } });
    expect(foldCode(view)).toBe(true);
    expect(currentFolds(view.state)).toHaveLength(2);
    expect(view.dom.querySelector(".cm-foldPlaceholder")).not.toBeNull();
    expect(unfoldCode(view)).toBe(true);
    expect(currentFolds(view.state)).toEqual([foldAt(view.state, 3)]);
    expect(unfoldAll(view)).toBe(true);
    expect(currentFolds(view.state)).toEqual([]);
    expect(view.state.doc).toBe(originalDoc);
    expect(handle.getText()).toBe(source);
  });

  it("can fold and unfold all top-level environments", async () => {
    const doc = source + "\n\\begin{quote}\nSecond block\n\\end{quote}";
    const { view } = await mount(doc);
    expect(foldAll(view)).toBe(true);
    expect(currentFolds(view.state)).toEqual([foldAt(view.state, 1), foldAt(view.state, 7)]);
    expect(unfoldAll(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("keeps folding confined to source when language extensions are cached", async () => {
    const visual = await mount(source, "typeset");
    const code = await mount(source);
    const visualAgain = await mount(source, "typeset");
    expect(foldAt(code.view.state, 1)).not.toBeNull();
    expect(foldAt(visual.view.state, 1)).toBeNull();
    expect(foldAt(visualAgain.view.state, 1)).toBeNull();
  });

  it("follows language changes on the existing editor", async () => {
    const { view } = await mount(source);
    reconfigureLanguage(view, "text");
    await vi.waitFor(() => expect(foldAt(view.state, 1)).toBeNull());
    reconfigureLanguage(view, "latex");
    await vi.waitFor(() => expect(foldAt(view.state, 1)).not.toBeNull());
    expect(view.state.doc.toString()).toBe(source);
  });
});
