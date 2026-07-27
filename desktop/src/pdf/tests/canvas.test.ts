// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";
import { PDF_CANVAS_MAX_PIXELS, pdfCanvasOutputScale, renderPdfPageToCanvas } from "../canvas";

describe("pdfCanvasOutputScale", () => {
  it("keeps a normal PDF page crisp at the display pixel ratio", () => {
    expect(pdfCanvasOutputScale({ width: 600, height: 800 }, 2)).toBe(2);
  });

  it("caps a large page before its backing store exceeds the shared budget", () => {
    const scale = pdfCanvasOutputScale({ width: 2_400, height: 3_200 }, 2);

    expect(scale).toBeLessThan(2);
    expect((2_400 * scale) * (3_200 * scale)).toBeLessThanOrEqual(PDF_CANVAS_MAX_PIXELS);
  });

  it("falls back to a stable scale for invalid display values", () => {
    expect(pdfCanvasOutputScale({ width: 600, height: 800 }, 0)).toBe(1);
    expect(pdfCanvasOutputScale({ width: 600, height: 800 }, Number.NaN)).toBe(1);
  });

  it("keeps PDF coordinates in CSS pixels while rendering a crisp backing store", () => {
    const task = { promise: Promise.resolve(), cancel: vi.fn() };
    const page = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      })),
      render: vi.fn(() => task),
    } as unknown as PDFPageProxy;
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue({} as CanvasRenderingContext2D);

    const render = renderPdfPageToCanvas(page, canvas, 1, { devicePixelRatio: 2 });

    expect(render.cssWidth).toBe(600);
    expect(render.cssHeight).toBe(800);
    expect(canvas.style.width).toBe("600px");
    expect(canvas.style.height).toBe("800px");
    expect(canvas.width).toBe(1_200);
    expect(canvas.height).toBe(1_600);
    expect(page.render).toHaveBeenCalledWith(expect.objectContaining({
      canvas,
      transform: [2, 0, 0, 2, 0, 0],
    }));
  });
});
