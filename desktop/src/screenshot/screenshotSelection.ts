// Geometry for the region-screenshot overlay, kept free of DOM and Tauri so the
// mapping from a CSS-pixel drag onto the captured device-pixel bitmap can be
// tested directly.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Drags smaller than this are treated as a click, i.e. a cancel. */
export const MIN_SELECTION_PX = 4;

/** Rectangle between two drag points, in the same units as the points. */
export function normalizeSelection(start: Point, current: Point): Rect {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

/**
 * Map a selection expressed in the overlay's CSS pixels onto the captured
 * bitmap's device pixels. The overlay covers exactly one monitor, so the two
 * differ only by that monitor's scale factor — but the ratio is derived from
 * the measured viewport rather than `devicePixelRatio`, which lags behind a
 * window that was just moved onto a display with different scaling.
 */
export function toCaptureRect(selection: Rect, viewport: Size, capture: Size): Rect {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scaleX = capture.width / viewport.width;
  const scaleY = capture.height / viewport.height;
  const left = Math.round(selection.x * scaleX);
  const top = Math.round(selection.y * scaleY);
  const right = Math.round((selection.x + selection.width) * scaleX);
  const bottom = Math.round((selection.y + selection.height) * scaleY);
  // Clamp inside the bitmap: a drag that starts at the very edge can round a
  // pixel past it, and `drawImage` would then return transparent columns.
  const clampedLeft = Math.min(Math.max(left, 0), capture.width);
  const clampedTop = Math.min(Math.max(top, 0), capture.height);
  const clampedRight = Math.min(Math.max(right, clampedLeft), capture.width);
  const clampedBottom = Math.min(Math.max(bottom, clampedTop), capture.height);
  return {
    x: clampedLeft,
    y: clampedTop,
    width: clampedRight - clampedLeft,
    height: clampedBottom - clampedTop,
  };
}

/** A rectangle worth cropping, as opposed to a stray click. */
export function isUsableSelection(rect: Rect): boolean {
  return rect.width >= MIN_SELECTION_PX && rect.height >= MIN_SELECTION_PX;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** Sortable, filesystem-safe name: `screenshot-20260911-143005.png`. */
export function screenshotFileName(at: Date): string {
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `screenshot-${date}-${time}.png`;
}

// ---------------------------------------------------------------------------
// Window snapping
// ---------------------------------------------------------------------------

/** A snap target as the backend reports it: overlay-local *device* pixels. */
export interface WindowRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
}

/**
 * Convert the backend's device-pixel window rectangles into the overlay's CSS
 * pixels, keeping the front-to-back order the backend enumerated them in.
 */
export function windowRectsToCss(
  regions: WindowRegion[],
  viewport: Size,
  capture: Size,
): Rect[] {
  if (capture.width <= 0 || capture.height <= 0) return [];
  const scaleX = viewport.width / capture.width;
  const scaleY = viewport.height / capture.height;
  return regions.map((region) => ({
    x: region.x * scaleX,
    y: region.y * scaleY,
    width: region.width * scaleX,
    height: region.height * scaleY,
  }));
}

/** Topmost rectangle under the pointer — the window the user sees there. */
export function rectAtPoint(rects: Rect[], point: Point): Rect | null {
  return (
    rects.find(
      (rect) =>
        point.x >= rect.x &&
        point.y >= rect.y &&
        point.x < rect.x + rect.width &&
        point.y < rect.y + rect.height,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Adjusting a committed selection
// ---------------------------------------------------------------------------

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const RESIZE_HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Grab radius around a handle, in CSS pixels. */
export const HANDLE_TOLERANCE_PX = 9;

/** Centre of a handle, so the component can place the same dots it hit-tests. */
export function handleCenter(rect: Rect, handle: ResizeHandle): Point {
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  switch (handle) {
    case "nw": return { x: rect.x, y: rect.y };
    case "n": return { x: midX, y: rect.y };
    case "ne": return { x: right, y: rect.y };
    case "e": return { x: right, y: midY };
    case "se": return { x: right, y: bottom };
    case "s": return { x: midX, y: bottom };
    case "sw": return { x: rect.x, y: bottom };
    case "w": return { x: rect.x, y: midY };
  }
}

export function handleAtPoint(
  rect: Rect,
  point: Point,
  tolerance = HANDLE_TOLERANCE_PX,
): ResizeHandle | null {
  // Corners win over edges: at a corner both are within tolerance, and the
  // corner is the more useful of the two.
  for (const handle of RESIZE_HANDLES) {
    const center = handleCenter(rect, handle);
    if (Math.abs(center.x - point.x) <= tolerance && Math.abs(center.y - point.y) <= tolerance) {
      return handle;
    }
  }
  return null;
}

export const RESIZE_CURSORS: Record<ResizeHandle, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

/** Drag one handle to `point`; the rectangle stays normalized if it inverts. */
export function resizeRect(rect: Rect, handle: ResizeHandle, point: Point): Rect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.includes("w")) left = point.x;
  if (handle.includes("e")) right = point.x;
  if (handle.includes("n")) top = point.y;
  if (handle.includes("s")) bottom = point.y;
  return normalizeSelection({ x: left, y: top }, { x: right, y: bottom });
}

/** Move a rectangle, keeping it entirely inside `bounds`. */
export function translateRect(rect: Rect, dx: number, dy: number, bounds: Size): Rect {
  const x = Math.min(Math.max(rect.x + dx, 0), Math.max(bounds.width - rect.width, 0));
  const y = Math.min(Math.max(rect.y + dy, 0), Math.max(bounds.height - rect.height, 0));
  return { ...rect, x, y };
}

/** Trim a rectangle to the overlay, e.g. after a resize past the edge. */
export function clampRect(rect: Rect, bounds: Size): Rect {
  const left = Math.min(Math.max(rect.x, 0), bounds.width);
  const top = Math.min(Math.max(rect.y, 0), bounds.height);
  const right = Math.min(Math.max(rect.x + rect.width, left), bounds.width);
  const bottom = Math.min(Math.max(rect.y + rect.height, top), bounds.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Where to put the action bar: under the selection when it fits, above it when
 * it does not, and tucked inside the bottom edge when neither has room.
 */
export function toolbarPlacement(
  selection: Rect,
  viewport: Size,
  toolbar: Size,
  gap = 10,
): Point {
  const below = selection.y + selection.height + gap;
  const above = selection.y - toolbar.height - gap;
  let y: number;
  if (below + toolbar.height <= viewport.height) y = below;
  else if (above >= 0) y = above;
  else y = Math.max(viewport.height - toolbar.height - gap, gap);
  const x = Math.min(
    Math.max(selection.x + selection.width - toolbar.width, gap),
    Math.max(viewport.width - toolbar.width - gap, gap),
  );
  return { x, y };
}
