import { describe, expect, it } from "vitest";
import {
  beginAnnotation,
  extendAnnotation,
  fontSizeFor,
  isDragTool,
  isStrokeTool,
  isUsableAnnotation,
  type Annotation,
  type AnnotationStyle,
} from "./annotations";

const style: AnnotationStyle = { color: "#ff3b30", width: 4 };

describe("beginAnnotation / extendAnnotation", () => {
  it("grows a drag tool by moving its far corner", () => {
    const started = beginAnnotation("rect", { x: 10, y: 10 }, style);
    const extended = extendAnnotation(started, { x: 50, y: 40 });
    expect(extended).toMatchObject({ kind: "rect", from: { x: 10, y: 10 }, to: { x: 50, y: 40 } });
  });

  it("grows a stroke tool by appending points", () => {
    let stroke = beginAnnotation("pen", { x: 0, y: 0 }, style);
    stroke = extendAnnotation(stroke, { x: 1, y: 1 });
    stroke = extendAnnotation(stroke, { x: 2, y: 2 });
    expect(stroke.kind === "pen" && stroke.points).toHaveLength(3);
  });

  it("leaves a text annotation untouched while the pointer moves", () => {
    const text = beginAnnotation("text", { x: 5, y: 5 }, style);
    expect(extendAnnotation(text, { x: 90, y: 90 })).toBe(text);
  });

  it("gives every annotation a distinct id", () => {
    const first = beginAnnotation("rect", { x: 0, y: 0 }, style);
    const second = beginAnnotation("rect", { x: 0, y: 0 }, style);
    expect(first.id).not.toBe(second.id);
  });
});

describe("isUsableAnnotation", () => {
  it("drops a click with a shape tool selected", () => {
    const click = beginAnnotation("ellipse", { x: 10, y: 10 }, style);
    expect(isUsableAnnotation(click)).toBe(false);
  });

  it("keeps a shape dragged along only one axis", () => {
    const line = extendAnnotation(
      beginAnnotation("arrow", { x: 10, y: 10 }, style),
      { x: 80, y: 10 },
    );
    expect(isUsableAnnotation(line)).toBe(true);
  });

  it("drops a one-point stroke and empty text", () => {
    expect(isUsableAnnotation(beginAnnotation("pen", { x: 0, y: 0 }, style))).toBe(false);
    const blank: Annotation = { id: "t", kind: "text", at: { x: 0, y: 0 }, text: "   ", style };
    expect(isUsableAnnotation(blank)).toBe(false);
  });
});

describe("tool gestures", () => {
  it("classifies each tool by the gesture that draws it", () => {
    expect(isDragTool("rect")).toBe(true);
    expect(isDragTool("mosaic")).toBe(true);
    expect(isDragTool("pen")).toBe(false);
    expect(isStrokeTool("highlight")).toBe(true);
    expect(isStrokeTool("text")).toBe(false);
  });
});

describe("fontSizeFor", () => {
  it("grows with the stroke-width control and stays readable at its minimum", () => {
    expect(fontSizeFor(2)).toBeGreaterThanOrEqual(14);
    expect(fontSizeFor(7)).toBeGreaterThan(fontSizeFor(2));
  });
});
