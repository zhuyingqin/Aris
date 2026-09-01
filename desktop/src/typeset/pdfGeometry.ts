// PDF page geometry: text-run extraction, hit testing and colour sampling for
// the rendered PDF, plus the zoom scale shared by every preview surface.
// Split out of Typeset.tsx; `textLayerMeasureContext` needs a canvas, so this
// is browser code rather than a pure module.
import { pdfTextLayerText } from "./pdfTextMatch";
import {
  pdfTextRunBox,
  type PdfTextItemLike,
  type PdfTextStyleLike,
  type SyncTexPoint,
  type SyncTexViewportLike,
} from "./syncTexMapping";

export const TEXT_MEASURE_FONT_SIZE = 100;
export const TEXT_MEASURE_CACHE_LIMIT = 4096;
export const textMeasureCache = new Map<string, number>();
let textMeasureContext: CanvasRenderingContext2D | null | undefined;

export const PDF_ZOOM_MIN = 0.25;
export const PDF_ZOOM_MAX = 4;
export const PDF_ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 4] as const;
export const PDF_WHEEL_ZOOM_SETTLE_MS = 80;
export type PdfTextObjectGeometry = {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
};
export type PdfTextObjectChange = PdfTextObjectGeometry & {
  text: string;
  context: string;
};
export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
export type PdfPointConverter = (clientX: number, clientY: number) => SyncTexPoint | null;
export type PdfTextRun = {
  id: string;
  /** Trimmed, for matching and for picking the word under the pointer. */
  text: string;
  /** As typeset, spaces included, for what the text layer renders and copies. */
  raw: string;
  /** pdf.js `hasEOL`: this item ends a typeset line, so a copy needs a break. */
  endsLine: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  /** Horizontal squeeze that makes the stand-in text cover the glyphs. */
  scaleX: number;
  color: string;
  backgroundColor: string;
};
export type PdfLinkRun = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  destination: unknown;
};
export type PdfAnnotationLike = {
  id?: unknown;
  subtype?: unknown;
  rect?: unknown;
  dest?: unknown;
};
export type PdfAnnotationViewport = SyncTexViewportLike & {
  convertToViewportRectangle?: (rect: number[]) => number[];
};
export function isPdfRectangle(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value)
    && value.length >= 4
    && value.slice(0, 4).every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate));
}
export function pdfLinkRunsFromAnnotations(annotations: unknown, viewport: PdfAnnotationViewport): PdfLinkRun[] {
  const convertToViewportRectangle = viewport.convertToViewportRectangle;
  if (!Array.isArray(annotations) || !convertToViewportRectangle) return [];
  return annotations.flatMap((annotation, index) => {
    const link = annotation as PdfAnnotationLike;
    if (link.subtype !== "Link" || link.dest == null || !isPdfRectangle(link.rect)) return [];
    const rectangle = convertToViewportRectangle(link.rect);
    if (!Array.isArray(rectangle) || rectangle.length < 4 || !rectangle.slice(0, 4).every(Number.isFinite)) return [];
    const [x1, y1, x2, y2] = rectangle;
    return [{
      id: typeof link.id === "string" ? link.id : `link:${index}`,
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      destination: link.dest,
    }];
  });
}
export function textRunAtOffset(runs: PdfTextRun[], x: number, y: number): PdfTextRun | undefined {
  let nearest: PdfTextRun | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const run of runs) {
    const deltaX = Math.max(run.left - x, 0, x - (run.left + run.width));
    const deltaY = Math.max(run.top - y, 0, y - (run.top + Math.max(run.height, run.fontSize * 1.15)));
    const distance = Math.hypot(deltaX, deltaY);
    if (distance === 0) return run;
    if (distance < nearestDistance) {
      nearest = run;
      nearestDistance = distance;
    }
  }
  return nearest;
}
export function textRunContext(runs: PdfTextRun[], run: PdfTextRun): string {
  const index = runs.indexOf(run);
  return index < 0 ? run.text : runs.slice(Math.max(0, index - 2), index + 3).map((item) => item.text).join(" ");
}
export function textLayerMeasureContext(): CanvasRenderingContext2D | null {
  if (textMeasureContext !== undefined) return textMeasureContext;
  try {
    const context = document.createElement("canvas").getContext("2d");
    // A canvas that cannot measure — jsdom's, or a stub — simply means no
    // correction, never a broken text layer.
    if (context && typeof context.measureText === "function") {
      const family = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-sans")
        .trim();
      context.font = `${TEXT_MEASURE_FONT_SIZE}px ${family || "sans-serif"}`;
      textMeasureContext = context;
    } else {
      textMeasureContext = null;
    }
  } catch {
    textMeasureContext = null;
  }
  return textMeasureContext;
}
export function textRunScaleX(text: string, fontSize: number, targetWidth: number): number {
  if (!(targetWidth > 0) || !(fontSize > 0)) return 1;
  const context = textLayerMeasureContext();
  if (!context) return 1;
  let referenceWidth = textMeasureCache.get(text);
  if (referenceWidth === undefined) {
    try {
      referenceWidth = context.measureText(text).width;
    } catch {
      return 1;
    }
    if (textMeasureCache.size >= TEXT_MEASURE_CACHE_LIMIT) textMeasureCache.clear();
    textMeasureCache.set(text, referenceWidth);
  }
  const naturalWidth = (referenceWidth * fontSize) / TEXT_MEASURE_FONT_SIZE;
  if (!(naturalWidth > 0)) return 1;
  return clampNumber(targetWidth / naturalWidth, 0.05, 20);
}
export function textRunsFromPdfContent(
  textContent: unknown,
  viewport: { transform?: unknown } | null | undefined,
  zoom: number,
): PdfTextRun[] {
  const viewportTransform = Array.isArray(viewport?.transform) && viewport.transform.length >= 6
    ? viewport.transform as number[]
    : null;
  if (!viewportTransform) return [];
  const content = (textContent ?? {}) as { items?: unknown[]; styles?: Record<string, PdfTextStyleLike> };
  const items = Array.isArray(content.items) ? content.items : [];
  const styles = content.styles ?? {};
  return items.flatMap((item, index) => {
    const textItem = item as { str?: unknown; fontName?: unknown; hasEOL?: unknown } & PdfTextItemLike;
    const raw = pdfTextLayerText(typeof textItem.str === "string" ? textItem.str : "");
    const text = raw.trim();
    if (!text) return [];
    const style = typeof textItem.fontName === "string" ? styles[textItem.fontName] : undefined;
    const box = pdfTextRunBox(textItem, style, viewportTransform, zoom, text.length);
    if (!box) return [];
    return [{
      id: `${index}:${text}`,
      text,
      raw,
      endsLine: textItem.hasEOL === true,
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      fontSize: box.fontSize,
      scaleX: textRunScaleX(raw, box.fontSize, box.width),
      color: "#1f2937",
      backgroundColor: "#ffffff",
    }];
  });
}
export function samplePdfTextColors(
  canvas: HTMLCanvasElement,
  run: PdfTextRun,
  outputScale: number,
): Pick<PdfTextRun, "color" | "backgroundColor"> {
  const context = canvas.getContext("2d");
  if (!context) return { color: run.color, backgroundColor: run.backgroundColor };
  const x = clampNumber(Math.floor(run.left * outputScale), 0, Math.max(0, canvas.width - 1));
  const y = clampNumber(Math.floor(run.top * outputScale), 0, Math.max(0, canvas.height - 1));
  const width = clampNumber(Math.ceil(run.width * outputScale), 1, Math.max(1, canvas.width - x));
  const height = clampNumber(Math.ceil(run.height * outputScale), 1, Math.max(1, canvas.height - y));
  try {
    const pixels = context.getImageData(x, y, width, height).data;
    const bins = new Map<string, { count: number; red: number; green: number; blue: number }>();
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 100) continue;
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const key = `${red >> 4}:${green >> 4}:${blue >> 4}`;
      const bin = bins.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
      bin.count += 1;
      bin.red += red;
      bin.green += green;
      bin.blue += blue;
      bins.set(key, bin);
    }
    const ranked = Array.from(bins.values()).sort((left, right) => right.count - left.count);
    const background = ranked[0];
    if (!background) return { color: run.color, backgroundColor: run.backgroundColor };
    const backgroundRgb = [background.red / background.count, background.green / background.count, background.blue / background.count];
    const foreground = ranked.slice(1).reduce<{ bin: typeof background; score: number } | null>((best, bin) => {
      const rgb = [bin.red / bin.count, bin.green / bin.count, bin.blue / bin.count];
      const distance = Math.hypot(rgb[0] - backgroundRgb[0], rgb[1] - backgroundRgb[1], rgb[2] - backgroundRgb[2]);
      const score = distance * Math.sqrt(bin.count);
      return distance > 28 && (!best || score > best.score) ? { bin, score } : best;
    }, null)?.bin;
    const toHex = (value: number) => Math.round(value).toString(16).padStart(2, "0");
    const backgroundColor = `#${toHex(backgroundRgb[0])}${toHex(backgroundRgb[1])}${toHex(backgroundRgb[2])}`;
    if (!foreground) return { color: run.color, backgroundColor };
    return {
      color: `#${toHex(foreground.red / foreground.count)}${toHex(foreground.green / foreground.count)}${toHex(foreground.blue / foreground.count)}`,
      backgroundColor,
    };
  } catch {
    return { color: run.color, backgroundColor: run.backgroundColor };
  }
}
