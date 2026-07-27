import type { PDFPageProxy, PageViewport, RenderTask } from "pdfjs-dist";

/** About 32 MiB of RGBA backing storage for one mounted PDF page. */
export const PDF_CANVAS_MAX_PIXELS = 8_000_000;

export interface PdfCanvasRenderOptions {
  maxPixels?: number;
  devicePixelRatio?: number;
}

export interface PdfCanvasRender {
  cssHeight: number;
  cssWidth: number;
  outputScale: number;
  task: RenderTask;
  viewport: PageViewport;
}

/**
 * Choose a backing-store scale that is crisp on high-DPI screens while
 * capping a single mounted page's memory usage.
 */
export function pdfCanvasOutputScale(
  viewport: Pick<PageViewport, "height" | "width">,
  devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  maxPixels = PDF_CANVAS_MAX_PIXELS,
): number {
  const boundedDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const boundedMaxPixels = Number.isFinite(maxPixels) && maxPixels > 0
    ? maxPixels
    : PDF_CANVAS_MAX_PIXELS;
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  // Canvas dimensions round upward. Solve (width * scale + 1) *
  // (height * scale + 1) <= maxPixels so that the rounded dimensions also
  // stay inside the budget, rather than overshooting by a pixel at the edge.
  const area = width * height;
  const perimeter = width + height;
  const budgetScale = (
    -perimeter + Math.sqrt(perimeter * perimeter + 4 * area * (boundedMaxPixels - 1))
  ) / (2 * area);
  return Math.min(boundedDpr, Math.max(0.01, budgetScale));
}

/**
 * Begin rendering one PDF page into a Canvas. The Canvas CSS dimensions stay
 * in PDF viewport coordinates; only its backing store scales for display DPI.
 */
export function renderPdfPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
  options: PdfCanvasRenderOptions = {},
): PdfCanvasRender {
  const viewport = page.getViewport({ scale });
  const outputScale = pdfCanvasOutputScale(
    viewport,
    options.devicePixelRatio,
    options.maxPixels,
  );
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable.");

  canvas.width = Math.ceil(viewport.width * outputScale);
  canvas.height = Math.ceil(viewport.height * outputScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const transform = outputScale === 1
    ? undefined
    : [outputScale, 0, 0, outputScale, 0, 0];
  const task = page.render({ canvas, canvasContext: context, viewport, transform });

  return {
    task,
    viewport,
    outputScale,
    cssWidth: viewport.width,
    cssHeight: viewport.height,
  };
}
