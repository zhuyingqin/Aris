// A crop pinned to the desktop: a borderless always-on-top window that shows
// nothing but the image, dragged around by its own surface. Snipaste's "paste
// to screen" — the point is to keep a reference visible while working in
// another window, so the pin has no chrome that could cover what it shows.
//
// The backend owns its lifetime and its pixels; this component only renders
// them and reports gestures back.

import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isTauri,
  screenshotPinClose,
  screenshotPinCopy,
  screenshotPinImage,
  screenshotPinReady,
  screenshotPinScale,
} from "../api/tauri";
import { decodeImage } from "./decodeImage";
import { isScreenshotPinPreviewMode, previewPinImage } from "./screenshotPreview";
import "./ScreenshotPin.css";

/** Must match `PIN_LABEL_PREFIX` in `src-tauri/src/screenshot.rs`. */
const SCREENSHOT_PIN_LABEL_PREFIX = "screenshot-pin-";

/** Matches `MIN_PIN_SIDE_PX` / the backend's ceiling closely enough that the
 * two agree on when a zoom step stops doing anything. */
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

/** One wheel notch. Multiplicative so zooming out undoes zooming in exactly. */
const SCALE_STEP = 1.1;

export function isScreenshotPinMode(windowLabel?: string): boolean {
  const label = windowLabel ?? (isTauri() ? getCurrentWindow().label : "");
  if (label.startsWith(SCREENSHOT_PIN_LABEL_PREFIX)) return true;
  return !isTauri() && isScreenshotPinPreviewMode();
}

export default function ScreenshotPin() {
  const [image, setImage] = useState<string | null>(null);
  // A ref rather than state: the window's size is the rendered output, so a
  // zoom step has nothing to re-render and every notch would be a wasted pass.
  const scaleRef = useRef(1);

  const close = useCallback(() => {
    void screenshotPinClose().catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const url = isTauri()
          ? await screenshotPinImage()
          : previewPinImage(window.innerWidth, window.innerHeight);
        // Decoded before the window is revealed, so it never appears empty and
        // then fills in.
        await decodeImage(url);
        if (cancelled) {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        if (url.startsWith("blob:")) objectUrl = url;
        setImage(url);
      } catch (error) {
        // A pin with no pixels is an invisible always-on-top window sitting on
        // the user's desktop; take it away rather than leave it there.
        console.error("pinned screenshot could not load its image", error);
        if (!cancelled) close();
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [close]);

  // Revealed only once the image is in the DOM, for the same reason the
  // selection overlay is: a booting WebView2 paints its own background first.
  useEffect(() => {
    if (!image || !isTauri()) return;
    void screenshotPinReady().catch(() => undefined);
  }, [image]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void screenshotPinCopy().catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const zoom = (direction: 1 | -1) => {
    const current = scaleRef.current;
    const next = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, direction > 0 ? current * SCALE_STEP : current / SCALE_STEP),
    );
    if (next === current) return;
    scaleRef.current = next;
    void screenshotPinScale(next).catch(() => undefined);
  };

  return (
    <div
      className="screenshot-pin"
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        // Dragging the window is the whole interaction model, so the surface
        // itself is the drag handle. `startDragging` hands the gesture to the
        // OS, which is also what keeps it smooth on a borderless window.
        event.preventDefault();
        if (isTauri()) void getCurrentWindow().startDragging().catch(() => undefined);
      }}
      onDoubleClick={close}
      onWheel={(event) => zoom(event.deltaY < 0 ? 1 : -1)}
      onContextMenu={(event) => {
        event.preventDefault();
        close();
      }}
    >
      {image && <img className="screenshot-pin-image" src={image} alt="" draggable={false} />}
    </div>
  );
}
