// Browser-preview escape hatch for the region-screenshot overlay, matching the
// `?loginPreview=1` / typeset-preview hatches elsewhere. A plain browser has no
// backend to ask for a screen capture, so `?screenshotPreview=1` renders the
// overlay against a synthetic desktop instead. Never reached inside Tauri.

import type { ScreenshotOverlayContext } from "../api/tauri";

export const SCREENSHOT_PREVIEW_QUERY = "screenshotPreview";

/** The same hatch for a pinned crop, which has no window label to route on
 * outside Tauri: `overlay.html?screenshotPin=1`. */
export const SCREENSHOT_PIN_PREVIEW_QUERY = "screenshotPin";

function hasPreviewFlag(query: string, search?: string): boolean {
  const value = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return new URLSearchParams(value).get(query) === "1";
}

export function isScreenshotPreviewMode(search?: string): boolean {
  return hasPreviewFlag(SCREENSHOT_PREVIEW_QUERY, search);
}

export function isScreenshotPinPreviewMode(search?: string): boolean {
  return hasPreviewFlag(SCREENSHOT_PIN_PREVIEW_QUERY, search);
}

/** A stand-in crop for the pin preview: the synthetic desktop's editor window,
 * which is roughly what a real pin holds. */
export function previewPinImage(width: number, height: number): string {
  return previewOverlayCapture(width, height).image;
}

/** A stand-in desktop: two "windows" with text, so every tool has something
 * meaningful to mark up. Returns the geometry and the wallpaper separately,
 * mirroring the two calls the overlay makes against the real backend. */
export function previewOverlayCapture(
  width: number,
  height: number,
): { context: ScreenshotOverlayContext; image: string } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { context: { width, height, windows: [] }, image: "" };
  }

  const wallpaper = ctx.createLinearGradient(0, 0, width, height);
  wallpaper.addColorStop(0, "#1b2a4a");
  wallpaper.addColorStop(1, "#4a2b52");
  ctx.fillStyle = wallpaper;
  ctx.fillRect(0, 0, width, height);

  const windows = [
    { x: Math.round(width * 0.08), y: Math.round(height * 0.12), width: Math.round(width * 0.44), height: Math.round(height * 0.6), title: "Editor" },
    { x: Math.round(width * 0.46), y: Math.round(height * 0.3), width: Math.round(width * 0.46), height: Math.round(height * 0.56), title: "Terminal" },
  ];

  // Painted back-to-front; the returned list is front-to-back, as the backend
  // reports it.
  for (const region of [...windows].reverse()) {
    const isEditor = region.title === "Editor";
    ctx.fillStyle = isEditor ? "#f7f7fa" : "#101317";
    ctx.fillRect(region.x, region.y, region.width, region.height);
    ctx.fillStyle = isEditor ? "#d8d8e0" : "#1d2228";
    ctx.fillRect(region.x, region.y, region.width, 34);
    ctx.fillStyle = isEditor ? "#22252b" : "#8ce99a";
    ctx.font = "16px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(region.title, region.x + 14, region.y + 23);
    ctx.font = "15px 'Segoe UI', system-ui, sans-serif";
    for (let line = 0; line < 9; line += 1) {
      ctx.fillText(
        isEditor
          ? `const result = compute(${line}) // annotate me`
          : `$ cargo test --lib screenshot   [${line}]`,
        region.x + 18,
        region.y + 68 + line * 26,
      );
    }
  }

  return { context: { width, height, windows }, image: canvas.toDataURL("image/png") };
}
