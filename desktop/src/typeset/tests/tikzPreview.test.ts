// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderTikzPreview } from "../tikzPreview";
import forecastingTasks from "./fixtures/forecasting-tasks.tex?raw";

describe("TikZ graph fallback", () => {
  it("preserves a supported named-node graph", () => {
    const svg = renderTikzPreview(String.raw`\begin{tikzpicture}
      \node (a) {A};
      \node[right=of a] (b) {B};
      \draw[-Latex] (a) -- (b);
    \end{tikzpicture}`);
    expect(svg?.querySelectorAll(".cm-vis-diagram-node")).toHaveLength(2);
    expect(svg?.querySelectorAll("polyline")).toHaveLength(1);
  });

  it("requires the compiled preview for the six-panel forecasting figure", () => {
    expect(renderTikzPreview(forecastingTasks)).toBeNull();
  });

  it.each([
    String.raw`\begin{scope}[shift={(5,0)}]\node at (0,0) {Shifted};\end{scope}`,
    String.raw`\foreach \i in {0,...,4} {\node at (\i,0) {Cell};}`,
    String.raw`\node at (\x,0) {Macro coordinate};`,
    String.raw`\draw (0,0) rectangle (2,1);`,
    String.raw`\node[customstyle] at (0,0) {Styled};`,
    String.raw`\node[anchor=west] at (0,0) {Anchored};`,
    String.raw`\node[right=of missing] (a) {Unresolved};`,
    String.raw`\node[right=of b] (a) {A};\node[right=of a] (b) {B};`,
    String.raw`\draw (missing) -- (0,0);`,
  ])("rejects unhandled geometry instead of drawing a partial graph: %s", (body) => {
    expect(renderTikzPreview(`\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`)).toBeNull();
  });

  it("does not silently drop additional pictures", () => {
    const picture = String.raw`\begin{tikzpicture}\node at (0,0) {A};\end{tikzpicture}`;
    expect(renderTikzPreview(picture + "\n" + picture)).toBeNull();
  });

  it("does not mistake commented loops or escaped percent signs for layout", () => {
    const svg = renderTikzPreview(String.raw`\begin{tikzpicture}
      % \foreach \i in {0,...,4} {\node {Hidden};}
      \node at (0,0) {50\%};
    \end{tikzpicture}`);
    expect(svg?.querySelectorAll(".cm-vis-diagram-node")).toHaveLength(1);
  });
});
