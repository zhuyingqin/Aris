import { describe, expect, it } from "vitest";
import { stablePdfRenderRange } from "../pdfGeometry";

describe("PDF render-window stability", () => {
  it("retains the pressed page while a drag-scroll expands into later pages", () => {
    expect(stablePdfRenderRange(
      { start: 1, end: 1 },
      { start: 3, end: 5 },
      true,
    )).toEqual({ start: 1, end: 5 });
  });

  it("compacts to the visible window after the pointer gesture ends", () => {
    expect(stablePdfRenderRange(
      { start: 1, end: 5 },
      { start: 3, end: 5 },
      false,
    )).toEqual({ start: 3, end: 5 });
  });
});
