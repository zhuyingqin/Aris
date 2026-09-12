// Annotation model and renderer for the region screenshot.
//
// Shapes are stored in the overlay's CSS pixels. The same `drawAnnotations`
// call paints the live preview (scaled by `devicePixelRatio`) and the exported
// PNG (scaled by the monitor's capture ratio) — one renderer, so what the user
// confirms is what lands in the composer.

import type { Point, Rect } from "./screenshotSelection";

export type AnnotationTool =
  | "rect"
  | "ellipse"
  | "arrow"
  | "pen"
  | "highlight"
  | "mosaic"
  | "text";

export interface AnnotationStyle {
  color: string;
  /** Stroke weight in CSS pixels; also drives arrow heads and font size. */
  width: number;
}

interface BaseAnnotation {
  id: string;
  style: AnnotationStyle;
}

export type Annotation =
  | (BaseAnnotation & { kind: "rect" | "ellipse" | "arrow" | "mosaic"; from: Point; to: Point })
  | (BaseAnnotation & { kind: "pen" | "highlight"; points: Point[] })
  | (BaseAnnotation & { kind: "text"; at: Point; text: string });

/** Palette offered by the toolbar. First entry is the default. */
export const ANNOTATION_COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#1c1c1e", "#ffffff"];

/** Stroke weights offered by the toolbar, in CSS pixels. */
export const ANNOTATION_WIDTHS = [2, 4, 7];

/** Mosaic block size in CSS pixels — coarse enough to be unreadable. */
const MOSAIC_BLOCK_PX = 9;

/** Text is sized off the stroke weight so one control drives both. */
export function fontSizeFor(width: number): number {
  return Math.round(width * 3.5 + 11);
}

export const TEXT_LINE_HEIGHT = 1.25;

export function textFont(fontSize: number): string {
  return `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
}

let measureContext: CanvasRenderingContext2D | null = null;

/**
 * Size of a text annotation, so the live input box can be laid out with the
 * exact metrics the canvas renderer will use.
 */
export function measureText(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split("\n");
  const height = Math.max(1, lines.length) * fontSize * TEXT_LINE_HEIGHT;
  if (!measureContext) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  if (!measureContext) return { width: fontSize * 6, height };
  measureContext.font = textFont(fontSize);
  const width = Math.max(...lines.map((line) => measureContext!.measureText(line).width), 0);
  return { width, height };
}

/** Tools whose gesture is a drag between two corners. */
export function isDragTool(tool: AnnotationTool): boolean {
  return tool === "rect" || tool === "ellipse" || tool === "arrow" || tool === "mosaic";
}

/** Tools whose gesture is a freehand stroke. */
export function isStrokeTool(tool: AnnotationTool): boolean {
  return tool === "pen" || tool === "highlight";
}

/** Drop shapes too small to be intentional (a click with a tool selected). */
export function isUsableAnnotation(annotation: Annotation): boolean {
  switch (annotation.kind) {
    case "rect":
    case "ellipse":
    case "arrow":
    case "mosaic":
      return (
        Math.abs(annotation.to.x - annotation.from.x) >= 3 ||
        Math.abs(annotation.to.y - annotation.from.y) >= 3
      );
    case "pen":
    case "highlight":
      return annotation.points.length >= 2;
    case "text":
      return annotation.text.trim().length > 0;
  }
}

export interface DrawOptions {
  /** The frozen monitor capture, needed by the mosaic tool. */
  capture: CanvasImageSource | null;
  /** CSS pixels → capture device pixels, for sampling `capture`. */
  captureScale: number;
}

function rectOf(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

function drawArrow(ctx: CanvasRenderingContext2D, from: Point, to: Point, style: AnnotationStyle) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return;
  const head = Math.min(style.width * 4 + 6, length);
  const angle = Math.atan2(dy, dx);
  const spread = Math.PI / 7;
  // Stop the shaft inside the head so a thick stroke cannot poke through the
  // tip of the triangle.
  const shaftEnd = {
    x: to.x - Math.cos(angle) * head * 0.8,
    y: to.y - Math.sin(angle) * head * 0.8,
  };
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(shaftEnd.x, shaftEnd.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle - spread) * head, to.y - Math.sin(angle - spread) * head);
  ctx.lineTo(to.x - Math.cos(angle + spread) * head, to.y - Math.sin(angle + spread) * head);
  ctx.closePath();
  ctx.fill();
}

function drawMosaic(
  ctx: CanvasRenderingContext2D,
  area: Rect,
  { capture, captureScale }: DrawOptions,
) {
  if (!capture || area.width < 1 || area.height < 1) return;
  const columns = Math.max(1, Math.round(area.width / MOSAIC_BLOCK_PX));
  const rows = Math.max(1, Math.round(area.height / MOSAIC_BLOCK_PX));
  const tile = document.createElement("canvas");
  tile.width = columns;
  tile.height = rows;
  const tileContext = tile.getContext("2d");
  if (!tileContext) return;
  // Downsample with smoothing (each block averages its source pixels), then
  // blow it back up with smoothing off to get hard-edged blocks.
  tileContext.drawImage(
    capture,
    area.x * captureScale,
    area.y * captureScale,
    area.width * captureScale,
    area.height * captureScale,
    0,
    0,
    columns,
    rows,
  );
  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tile, area.x, area.y, area.width, area.height);
  ctx.imageSmoothingEnabled = smoothing;
}

function drawStroke(ctx: CanvasRenderingContext2D, points: Point[]) {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  if (points.length === 1) ctx.lineTo(points[0].x + 0.01, points[0].y);
  ctx.stroke();
}

function drawOne(ctx: CanvasRenderingContext2D, annotation: Annotation, options: DrawOptions) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = annotation.style.color;
  ctx.fillStyle = annotation.style.color;
  ctx.lineWidth = annotation.style.width;

  switch (annotation.kind) {
    case "rect": {
      const area = rectOf(annotation.from, annotation.to);
      ctx.strokeRect(area.x, area.y, area.width, area.height);
      break;
    }
    case "ellipse": {
      const area = rectOf(annotation.from, annotation.to);
      ctx.beginPath();
      ctx.ellipse(
        area.x + area.width / 2,
        area.y + area.height / 2,
        area.width / 2,
        area.height / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case "arrow":
      drawArrow(ctx, annotation.from, annotation.to, annotation.style);
      break;
    case "mosaic":
      drawMosaic(ctx, rectOf(annotation.from, annotation.to), options);
      break;
    case "pen":
      drawStroke(ctx, annotation.points);
      break;
    case "highlight":
      // Multiply keeps the underlying text legible through the marker.
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = annotation.style.width * 3.5;
      drawStroke(ctx, annotation.points);
      break;
    case "text": {
      const size = fontSizeFor(annotation.style.width);
      ctx.font = textFont(size);
      ctx.textBaseline = "top";
      // A thin contrasting outline keeps red text readable on a red window.
      ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
      ctx.lineWidth = Math.max(2, size / 10);
      annotation.text.split("\n").forEach((line, index) => {
        const y = annotation.at.y + index * size * TEXT_LINE_HEIGHT;
        ctx.strokeText(line, annotation.at.x, y);
        ctx.fillText(line, annotation.at.x, y);
      });
      break;
    }
  }
  ctx.restore();
}

export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: Annotation[],
  options: DrawOptions,
): void {
  for (const annotation of annotations) drawOne(ctx, annotation, options);
}

let annotationCounter = 0;

export function nextAnnotationId(): string {
  annotationCounter += 1;
  return `annotation-${annotationCounter}`;
}

/** Start a shape for the active tool at `point`. */
export function beginAnnotation(
  tool: AnnotationTool,
  point: Point,
  style: AnnotationStyle,
): Annotation {
  const id = nextAnnotationId();
  switch (tool) {
    case "pen":
    case "highlight":
      return { id, kind: tool, points: [point], style };
    case "text":
      return { id, kind: tool, at: point, text: "", style };
    default:
      return { id, kind: tool, from: point, to: point, style };
  }
}

/** Extend the in-progress shape to `point`. */
export function extendAnnotation(annotation: Annotation, point: Point): Annotation {
  switch (annotation.kind) {
    case "pen":
    case "highlight":
      return { ...annotation, points: [...annotation.points, point] };
    case "text":
      return annotation;
    default:
      return { ...annotation, to: point };
  }
}
