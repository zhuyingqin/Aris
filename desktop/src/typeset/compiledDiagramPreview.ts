import { latexForwardSearch, type SyncTexLocation } from "../api/tauri";
import { pdfCanvasOutputScale } from "../pdf/canvas";
import { openPdfDocumentFromPath } from "../pdf/runtime";

/** The source snapshot belonging to a particular compiled PDF. */
export interface VisualCompiledDocument {
  pdfPath: string;
  revision: number;
  source: string;
}

export interface CompiledDiagramRequest {
  pdfPath: string;
  revision: number;
  sourcePath: string;
  /** SyncTeX associates the drawing's enclosing box with its closing line. */
  endLine: number;
}

/** Prefer the drawing's tight box over its containing full-width text row. */
export function compiledDiagramBox(locations: readonly SyncTexLocation[]): SyncTexLocation | null {
  const valid = locations.filter((location) =>
    Number.isInteger(location.page) && location.page > 0
      && [location.boxLeft, location.boxTop, location.boxWidth, location.boxHeight].every(Number.isFinite)
      && location.boxWidth > 8 && location.boxHeight > 8,
  );
  if (!valid.length) return null;
  const page = valid[0].page;
  const samePage = valid.filter((location) => location.page === page);
  const height = Math.max(...samePage.map((location) => location.boxHeight));
  return samePage
    .filter((location) => Math.abs(location.boxHeight - height) < 0.5)
    .sort((a, b) => a.boxWidth - b.boxWidth)[0];
}

/** Render the actual compiled drawing, including TikZ loops, styles and shifts. */
export async function renderCompiledDiagram(
  request: CompiledDiagramRequest,
  signal: AbortSignal,
): Promise<HTMLCanvasElement> {
  const result = await latexForwardSearch(request.sourcePath, request.pdfPath, request.endLine, 1);
  const box = compiledDiagramBox(result.locations);
  if (signal.aborted) throw new Error("Diagram preview cancelled");
  if (!box) throw new Error("No compiled drawing bounds");
  const pdf = await openPdfDocumentFromPath(request.pdfPath);
  try {
    if (signal.aborted) throw new Error("Diagram preview cancelled");
    const page = await pdf.getPage(box.page);
    const natural = page.getViewport({ scale: 1 });
    // A little breathing room includes strokes along the TeX box boundary.
    const left = Math.max(0, box.boxLeft - 2);
    const top = Math.max(0, box.boxTop - 2);
    const right = Math.min(natural.width, box.boxLeft + box.boxWidth + 2);
    const bottom = Math.min(natural.height, box.boxTop + box.boxHeight + 2);
    if (right <= left || bottom <= top) throw new Error("Drawing bounds outside the PDF page");
    const scale = 1.75;
    const width = (right - left) * scale;
    const height = (bottom - top) * scale;
    const outputScale = pdfCanvasOutputScale({ width, height });
    const canvas = document.createElement("canvas");
    canvas.className = "cm-vis-diagram-compiled";
    canvas.setAttribute("role", "img");
    canvas.width = Math.ceil(width * outputScale);
    canvas.height = Math.ceil(height * outputScale);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas rendering is unavailable");
    const viewport = page.getViewport({ scale, offsetX: -left * scale, offsetY: -top * scale });
    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    const cancel = () => task.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      await task.promise;
      if (signal.aborted) throw new Error("Diagram preview cancelled");
      return canvas;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  } finally {
    await pdf.destroy();
  }
}
