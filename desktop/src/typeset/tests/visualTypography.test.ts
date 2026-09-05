// @vitest-environment jsdom

import { EditorSelection, EditorState } from "@codemirror/state";
import { beforeEach, describe, expect, it } from "vitest";
import { TYPOGRAPHIC_TEXT, visualDecorations } from "../visualDecorations";
import { useStore } from "../../store";

beforeEach(() => {
  useStore.setState({ language: "en", languagePreferenceSet: true });
});

function widgets(source: string) {
  const state = EditorState.create({
    doc: source,
    // Park the caret at the end: a selection touching a construct deliberately
    // shows its raw source instead of the rendered form.
    selection: EditorSelection.cursor(source.length),
    extensions: [visualDecorations],
  });
  const found: Array<{ from: number; to: number; className: string; text: string }> = [];
  state.field(visualDecorations).deco.between(0, source.length, (from, to, value) => {
    const dom = value.spec.widget?.toDOM?.();
    if (!dom) return;
    found.push({ from, to, className: dom.className, text: dom.textContent ?? "" });
  });
  return found;
}

describe("footnotes", () => {
  it("collapses a footnote to the marker the PDF prints, with its text on hover", () => {
    const source = "\\begin{document}\nA claim\\footnote{See \\textbf{Jaeger} 2001.} follows.\n\\end{document}";
    const footnote = widgets(source).find((widget) => widget.className.includes("cm-vis-footnote"));

    expect(footnote?.text).toBe("*");
    expect(source.slice(footnote!.from, footnote!.to)).toBe("\\footnote{See \\textbf{Jaeger} 2001.}");
  });

  it("shows the footnote's own source again when the caret is inside it", () => {
    const source = "\\begin{document}\nA claim\\footnote{Detail.} follows.\n\\end{document}";
    const state = EditorState.create({
      doc: source,
      selection: EditorSelection.cursor(source.indexOf("Detail")),
      extensions: [visualDecorations],
    });
    let hasFootnoteWidget = false;
    state.field(visualDecorations).deco.between(0, source.length, (_from, _to, value) => {
      if (value.spec.widget?.toDOM?.().className?.includes("cm-vis-footnote")) hasFootnoteWidget = true;
    });
    expect(hasFootnoteWidget).toBe(false);
  });
});

describe("typographic source", () => {
  it("renders the character TeX prints, not the recipe for it", () => {
    const source = [
      "\\begin{document}",
      "Fig.~1 shows 1990--2020 --- roughly ``three'' decades\\ldots",
      "\\end{document}",
    ].join("\n");
    const rendered = widgets(source)
      .filter((widget) => widget.className.includes("cm-vis-typographic"))
      .map((widget) => widget.text);

    expect(rendered).toEqual([
      TYPOGRAPHIC_TEXT["~"],
      TYPOGRAPHIC_TEXT["---"],
      TYPOGRAPHIC_TEXT["--"],
      TYPOGRAPHIC_TEXT["``"],
      TYPOGRAPHIC_TEXT["''"],
      TYPOGRAPHIC_TEXT["\\ldots"],
    ].sort((left, right) => rendered.indexOf(left) - rendered.indexOf(right)));
    // `---` must win over `--`: an em dash is not two en dashes.
    expect(rendered).toContain("\u2014");
    expect(rendered).toContain("\u2013");
  });

  it("leaves maths and comments alone, where the same characters mean something else", () => {
    const source = [
      "\\begin{document}",
      "% a comment with -- and ~ in it",
      "Inline $a--b$ and $x \\sim y$.",
      "\\end{document}",
    ].join("\n");
    expect(widgets(source).filter((widget) => widget.className.includes("cm-vis-typographic"))).toEqual([]);
  });

  it("does not match a longer command that merely starts with a short one", () => {
    const source = "\\begin{document}\n\\quadrature is not a space.\n\\end{document}";
    expect(widgets(source).filter((widget) => widget.className.includes("cm-vis-typographic"))).toEqual([]);
  });
});
