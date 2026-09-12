// Borderless full-monitor window that paints the frozen capture, lets the user
// pick a region (by dragging, or by clicking the window they want), annotate
// it, and only then confirm. One of these exists per monitor while a region
// screenshot is in flight; the backend owns their lifetime.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  chatImportAttachmentData,
  isTauri,
  screenshotAttach,
  screenshotCancel,
  screenshotCopy,
  screenshotOverlayContext,
  screenshotOverlayImage,
  screenshotOverlayReady,
  screenshotPin,
  type ScreenshotOverlayContext,
} from "../api/tauri";
import { useStore } from "../store";
import ScreenshotToolbar from "./ScreenshotToolbar";
import { decodeImage } from "./decodeImage";
import { isScreenshotPreviewMode, previewOverlayCapture } from "./screenshotPreview";
import {
  ANNOTATION_COLORS,
  ANNOTATION_WIDTHS,
  beginAnnotation,
  drawAnnotations,
  extendAnnotation,
  fontSizeFor,
  isUsableAnnotation,
  measureText,
  nextAnnotationId,
  TEXT_LINE_HEIGHT,
  type Annotation,
  type AnnotationTool,
} from "./annotations";
import {
  clampRect,
  handleAtPoint,
  handleCenter,
  isUsableSelection,
  normalizeSelection,
  rectAtPoint,
  RESIZE_CURSORS,
  RESIZE_HANDLES,
  resizeRect,
  screenshotFileName,
  toCaptureRect,
  toolbarPlacement,
  translateRect,
  windowRectsToCss,
  type Point,
  type Rect,
  type ResizeHandle,
} from "./screenshotSelection";
import "./ScreenshotOverlay.css";

/** Must match `OVERLAY_LABEL_PREFIX` in `src-tauri/src/screenshot.rs`. */
const SCREENSHOT_OVERLAY_LABEL_PREFIX = "screenshot-overlay-";

/** Above this the inline thumbnail costs more than it is worth; the composer
 * falls back to a generic image tile. ~1.5 MB of base64. */
const MAX_PREVIEW_CHARS = 2_000_000;

/** Measured from the rendered bar; only used to place it before first paint. */
const TOOLBAR_SIZE = { width: 452, height: 40 };

export function isScreenshotOverlayMode(windowLabel?: string): boolean {
  const label = windowLabel ?? (isTauri() ? getCurrentWindow().label : "");
  if (label.startsWith(SCREENSHOT_OVERLAY_LABEL_PREFIX)) return true;
  return !isTauri() && isScreenshotPreviewMode();
}

type Interaction =
  | { kind: "select"; origin: Point }
  | { kind: "move"; origin: Point; base: Rect }
  | { kind: "resize"; handle: ResizeHandle; base: Rect }
  | { kind: "annotate" };

interface TextDraft {
  at: Point;
  value: string;
}

function clampPoint(point: Point, bounds: Rect): Point {
  return {
    x: Math.min(Math.max(point.x, bounds.x), bounds.x + bounds.width),
    y: Math.min(Math.max(point.y, bounds.y), bounds.y + bounds.height),
  };
}

export default function ScreenshotOverlay() {
  const language = useStore((state) => state.language);
  const [context, setContext] = useState<ScreenshotOverlayContext | null>(null);
  /** Blob (or, in browser preview, data) URL of the frozen capture. */
  const [captureUrl, setCaptureUrl] = useState<string | null>(null);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [committed, setCommitted] = useState(false);
  const [hover, setHover] = useState<Rect | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [tool, setTool] = useState<AnnotationTool | null>(null);
  const [color, setColor] = useState(ANNOTATION_COLORS[0]);
  const [width, setWidth] = useState(ANNOTATION_WIDTHS[1]);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));

  const [toolbarSize, setToolbarSize] = useState(TOOLBAR_SIZE);
  const [pointerCursor, setPointerCursor] = useState("crosshair");

  const captureRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const interactionRef = useRef<Interaction | null>(null);

  // The bar's width depends on its own laid-out content, so `toolbarPlacement`
  // has to be fed a measurement rather than a guess.
  const measureToolbar = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    setToolbarSize((current) =>
      current.width === node.offsetWidth && current.height === node.offsetHeight
        ? current
        : { width: node.offsetWidth, height: node.offsetHeight },
    );
  }, []);

  const copy = language === "cn"
    ? {
        hintIdle: "拖动选择区域，或点击某个窗口直接框住它",
        hintReady: "拖动边角可调整 · 双击或回车完成 · Ctrl+T 钉住 · Esc 取消",
        saving: "正在处理…",
        failed: "截图失败：",
        tools: {
          rect: "矩形", ellipse: "椭圆", arrow: "箭头", pen: "画笔",
          highlight: "荧光笔", mosaic: "马赛克", text: "文字",
          undo: "撤销", redo: "重做", color: "颜色", width: "粗细",
          cancel: "取消", copy: "复制", pin: "钉住", attach: "发送到聊天",
        },
      }
    : {
        hintIdle: "Drag to select a region, or click a window to capture it",
        hintReady:
          "Drag the edges to adjust · Double-click or Enter to finish · Ctrl+T to pin · Esc to cancel",
        saving: "Working…",
        failed: "Screenshot failed: ",
        tools: {
          rect: "Rectangle", ellipse: "Ellipse", arrow: "Arrow", pen: "Pen",
          highlight: "Highlighter", mosaic: "Mosaic", text: "Text",
          undo: "Undo", redo: "Redo", color: "Color", width: "Stroke width",
          cancel: "Cancel", copy: "Copy", pin: "Pin", attach: "Send to chat",
        },
      };

  const cancel = useCallback(() => {
    void screenshotCancel();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        // Geometry and pixels travel separately: the JSON round-trip stays
        // small and the megabytes go over the raw-bytes IPC path.
        const [loaded, image] = isTauri()
          ? await Promise.all([screenshotOverlayContext(), screenshotOverlayImage()])
          : (() => {
              const preview = previewOverlayCapture(window.innerWidth, window.innerHeight);
              return [preview.context, preview.image] as const;
            })();
        captureRef.current = await decodeImage(image);
        if (cancelled) {
          // StrictMode's double mount tears this run down mid-flight; the blob
          // the second run allocates is the one that gets rendered.
          if (image.startsWith("blob:")) URL.revokeObjectURL(image);
          return;
        }
        if (image.startsWith("blob:")) objectUrl = image;
        setCaptureUrl(image);
        setContext(loaded);
      } catch (loadError) {
        // Without pixels there is nothing to select; do not strand a
        // borderless always-on-top window over the user's desktop.
        console.error("screenshot overlay could not load its capture", loadError);
        if (!cancelled) screenshotCancel().catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);

  // The overlay window is created hidden and only revealed once the frozen
  // capture is in the DOM; otherwise the first frames of a booting WebView2
  // flash the app's own background across the whole monitor. An effect (rather
  // than a call next to `setContext`) guarantees the background image has been
  // committed, and rAF is unusable here because Chromium does not run it while
  // the document is still hidden.
  useEffect(() => {
    if (!context || !captureUrl || !isTauri()) return;
    void screenshotOverlayReady().catch(() => undefined);
  }, [captureUrl, context]);

  useEffect(() => {
    const onResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** CSS pixels → capture device pixels. */
  const captureScale = context && viewport.width > 0 ? context.width / viewport.width : 1;

  const windowRects = useMemo(
    () => (context ? windowRectsToCss(context.windows, viewport, context) : []),
    [context, viewport],
  );

  /** The open text box as a finished annotation, or null if it is empty. */
  const textDraftAnnotation = useCallback((): Annotation | null => {
    if (!textDraft || textDraft.value.trim().length === 0) return null;
    return {
      id: nextAnnotationId(),
      kind: "text",
      at: textDraft.at,
      text: textDraft.value,
      style: { color, width },
    };
  }, [color, textDraft, width]);

  const commitTextDraft = useCallback(() => {
    const annotation = textDraftAnnotation();
    if (annotation) {
      setAnnotations((items) => [...items, annotation]);
      setRedoStack([]);
    }
    setTextDraft(null);
  }, [textDraftAnnotation]);

  // ---------------------------------------------------------------------
  // Live preview
  // ---------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const capture = captureRef.current;
    if (!canvas || !selection) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(selection.width * ratio));
    canvas.height = Math.max(1, Math.round(selection.height * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, selection.width, selection.height);
    // The preview repaints the cropped pixels rather than letting the overlay's
    // CSS background show through, so blend-mode tools (the highlighter) look
    // on screen exactly like they will in the exported PNG.
    if (capture) {
      ctx.drawImage(
        capture,
        selection.x * captureScale,
        selection.y * captureScale,
        selection.width * captureScale,
        selection.height * captureScale,
        0,
        0,
        selection.width,
        selection.height,
      );
    }
    ctx.setTransform(ratio, 0, 0, ratio, -selection.x * ratio, -selection.y * ratio);
    drawAnnotations(ctx, draft ? [...annotations, draft] : annotations, {
      capture,
      captureScale,
    });
  }, [annotations, draft, selection, captureScale]);

  // ---------------------------------------------------------------------
  // Finishing
  // ---------------------------------------------------------------------
  const renderResult = useCallback((extra: Annotation[]): HTMLCanvasElement | null => {
    const capture = captureRef.current;
    if (!context || !capture || !selection) return null;
    const rect = toCaptureRect(selection, viewport, context);
    if (!isUsableSelection(rect)) return null;
    const canvas = document.createElement("canvas");
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(capture, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    // Same transform trick as the live canvas: annotations stay in overlay CSS
    // coordinates and are scaled onto the exported bitmap here.
    ctx.setTransform(
      captureScale,
      0,
      0,
      captureScale,
      -selection.x * captureScale,
      -selection.y * captureScale,
    );
    drawAnnotations(ctx, [...annotations, ...extra], { capture, captureScale });
    return canvas;
  }, [annotations, captureScale, context, selection, viewport]);

  const finish = useCallback(async (mode: "attach" | "copy" | "pin") => {
    // A text box still open when the user hits ✓ is part of the screenshot;
    // `setAnnotations` would not reach this closure in time, so pass it along.
    const pendingText = textDraftAnnotation();
    commitTextDraft();
    const canvas = renderResult(pendingText ? [pendingText] : []);
    if (!canvas) {
      cancel();
      return;
    }
    setBusy(true);
    try {
      if (mode === "copy") {
        await screenshotCopy(canvas.toDataURL("image/png"));
        return;
      }
      if (mode === "pin") {
        // The backend places the pin at its monitor's origin plus this rect,
        // so it lands exactly over the pixels it froze.
        if (!context || !selection) throw new Error("the capture is no longer available");
        await screenshotPin(canvas.toDataURL("image/png"), toCaptureRect(selection, viewport, context));
        return;
      }
      const png = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!png) throw new Error("the crop produced no image data");
      const name = screenshotFileName(new Date());
      const imported = await chatImportAttachmentData(
        name,
        new Uint8Array(await png.arrayBuffer()),
      );
      const preview = canvas.toDataURL("image/png");
      await screenshotAttach(
        imported.path,
        imported.name,
        preview.length <= MAX_PREVIEW_CHARS ? preview : null,
      );
    } catch (attachError) {
      setBusy(false);
      setError(attachError instanceof Error ? attachError.message : String(attachError));
    }
  }, [
    cancel,
    commitTextDraft,
    context,
    renderResult,
    selection,
    textDraftAnnotation,
    viewport,
  ]);

  const undo = useCallback(() => {
    setAnnotations((items) => {
      if (items.length === 0) return items;
      const last = items[items.length - 1];
      setRedoStack((stack) => [...stack, last]);
      return items.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setRedoStack((stack) => {
      if (stack.length === 0) return stack;
      const last = stack[stack.length - 1];
      setAnnotations((items) => [...items, last]);
      return stack.slice(0, -1);
    });
  }, []);

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        // Escape backs out one layer at a time: the text box, then the tool,
        // then the whole screenshot.
        if (textDraft) setTextDraft(null);
        else if (tool) setTool(null);
        else cancel();
        return;
      }
      if (textDraft) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (selection && committed) void finish("attach");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "t") {
        event.preventDefault();
        if (selection && committed) void finish("pin");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, committed, finish, redo, selection, textDraft, tool, undo]);

  // ---------------------------------------------------------------------
  // Pointer
  // ---------------------------------------------------------------------
  const onMouseDown = (event: React.MouseEvent) => {
    if (busy || event.button !== 0) return;
    // The overlay has no default mouse behaviour worth keeping, and the one it
    // does have is harmful: the focus shift at the end of the click blurs a
    // text box opened by that same click, closing it before a key is typed.
    // The toolbar and the text box stop propagation, so they still focus.
    event.preventDefault();
    const point = { x: event.clientX, y: event.clientY };
    if (textDraft) {
      commitTextDraft();
      return;
    }
    if (committed && selection) {
      if (tool) {
        const inside =
          point.x >= selection.x &&
          point.y >= selection.y &&
          point.x <= selection.x + selection.width &&
          point.y <= selection.y + selection.height;
        // With a tool active the selection is a canvas, not a target to
        // re-drag; clicks outside it are ignored rather than surprising.
        if (!inside) return;
        if (tool === "text") {
          setTextDraft({ at: point, value: "" });
          return;
        }
        setDraft(beginAnnotation(tool, point, { color, width }));
        interactionRef.current = { kind: "annotate" };
        return;
      }
      const handle = handleAtPoint(selection, point);
      if (handle) {
        interactionRef.current = { kind: "resize", handle, base: selection };
        return;
      }
      if (
        point.x >= selection.x &&
        point.y >= selection.y &&
        point.x <= selection.x + selection.width &&
        point.y <= selection.y + selection.height
      ) {
        interactionRef.current = { kind: "move", origin: point, base: selection };
        return;
      }
    }
    interactionRef.current = { kind: "select", origin: point };
    setCommitted(false);
    setAnnotations([]);
    setRedoStack([]);
    setSelection({ x: point.x, y: point.y, width: 0, height: 0 });
  };

  const onMouseMove = (event: React.MouseEvent) => {
    const point = { x: event.clientX, y: event.clientY };
    const interaction = interactionRef.current;
    if (!interaction) {
      if (!committed) {
        setHover(rectAtPoint(windowRects, point));
        setPointerCursor("crosshair");
        return;
      }
      // Committed: the pointer's meaning depends on where it is, so say so.
      if (tool) {
        setPointerCursor("crosshair");
      } else if (selection) {
        const handle = handleAtPoint(selection, point);
        const inside =
          point.x >= selection.x &&
          point.y >= selection.y &&
          point.x <= selection.x + selection.width &&
          point.y <= selection.y + selection.height;
        setPointerCursor(handle ? RESIZE_CURSORS[handle] : inside ? "move" : "crosshair");
      }
      return;
    }
    switch (interaction.kind) {
      case "select":
        setSelection(clampRect(normalizeSelection(interaction.origin, point), viewport));
        break;
      case "move":
        setSelection(
          translateRect(
            interaction.base,
            point.x - interaction.origin.x,
            point.y - interaction.origin.y,
            viewport,
          ),
        );
        break;
      case "resize":
        setSelection(clampRect(resizeRect(interaction.base, interaction.handle, point), viewport));
        break;
      case "annotate":
        if (!selection) break;
        setDraft((current) => (current ? extendAnnotation(current, clampPoint(point, selection)) : current));
        break;
    }
  };

  const onMouseUp = (event: React.MouseEvent) => {
    const point = { x: event.clientX, y: event.clientY };
    const interaction = interactionRef.current;
    interactionRef.current = null;
    if (!interaction) return;
    if (interaction.kind === "annotate") {
      setDraft((current) => {
        if (current && isUsableAnnotation(current)) {
          setAnnotations((items) => [...items, current]);
          setRedoStack([]);
        }
        return null;
      });
      return;
    }
    if (interaction.kind === "select") {
      setSelection((current) => {
        if (current && isUsableSelection(current)) {
          setCommitted(true);
          return current;
        }
        // A click rather than a drag: adopt the window under the pointer.
        // Resolved from the release point rather than the hover state, which
        // is empty until the mouse has actually moved over the overlay.
        const window = rectAtPoint(windowRects, point);
        if (window) {
          setCommitted(true);
          return window;
        }
        setCommitted(false);
        return null;
      });
      return;
    }
    // A move or resize keeps the selection committed; only normalize it.
    setSelection((current) => (current ? clampRect(current, viewport) : current));
  };

  if (error) {
    return (
      <div
        className="screenshot-overlay is-error"
        onContextMenu={(event) => {
          event.preventDefault();
          cancel();
        }}
      >
        <p className="screenshot-overlay-message" role="alert">{copy.failed}{error}</p>
      </div>
    );
  }

  if (!context || !captureUrl) return <div className="screenshot-overlay is-loading" />;

  const highlight = committed ? selection : (selection && (selection.width > 0 || selection.height > 0) ? selection : hover);
  const toolbarAt = committed && selection
    ? toolbarPlacement(selection, viewport, toolbarSize)
    : null;

  return (
    <div
      className="screenshot-overlay"
      style={{ backgroundImage: `url(${captureUrl})`, cursor: pointerCursor }}
      onMouseDown={onMouseDown}
      onMouseEnter={() => {
        // Multi-monitor: only one overlay holds the keyboard, and the pointer
        // says which one the user means. Claiming focus here also covers the
        // native focus that `onMouseDown` suppresses with `preventDefault`.
        if (isTauri()) void getCurrentWindow().setFocus().catch(() => undefined);
      }}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onDoubleClick={() => {
        if (committed && selection) void finish("attach");
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      {/* Four bands rather than one shade with a hole: the selected pixels are
          then the untouched background, with no second copy to keep in sync. */}
      {highlight ? (
        <>
          <div className="screenshot-shade" style={{ left: 0, top: 0, width: "100%", height: highlight.y }} />
          <div className="screenshot-shade" style={{ left: 0, top: highlight.y + highlight.height, width: "100%", bottom: 0 }} />
          <div className="screenshot-shade" style={{ left: 0, top: highlight.y, width: highlight.x, height: highlight.height }} />
          <div className="screenshot-shade" style={{ left: highlight.x + highlight.width, top: highlight.y, right: 0, height: highlight.height }} />
        </>
      ) : (
        <div className="screenshot-shade" style={{ inset: 0 }} />
      )}

      {highlight && (
        <div
          className={`screenshot-frame${committed ? " is-committed" : ""}`}
          style={{ left: highlight.x, top: highlight.y, width: highlight.width, height: highlight.height }}
        >
          <span className={`screenshot-size${highlight.y < 30 ? " is-inset" : ""}`}>
            {Math.round(highlight.width * captureScale)} × {Math.round(highlight.height * captureScale)}
          </span>
        </div>
      )}

      {selection && committed && (
        <canvas
          ref={canvasRef}
          className="screenshot-canvas"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
          }}
        />
      )}

      {selection && committed && !tool && RESIZE_HANDLES.map((handle) => {
        const center = handleCenter(selection, handle);
        return (
          <span
            key={handle}
            className="screenshot-handle"
            style={{ left: center.x, top: center.y, cursor: RESIZE_CURSORS[handle] }}
          />
        );
      })}

      {textDraft && (
        <textarea
          className="screenshot-text-input"
          autoFocus
          rows={1}
          value={textDraft.value}
          // Sized with the renderer's own metrics so the box the user types in
          // sits exactly where the drawn text will.
          style={{
            left: textDraft.at.x,
            top: textDraft.at.y,
            width: measureText(textDraft.value, fontSizeFor(width)).width + fontSizeFor(width),
            height: measureText(textDraft.value, fontSizeFor(width)).height,
            color,
            fontSize: fontSizeFor(width),
            lineHeight: TEXT_LINE_HEIGHT,
          }}
          onChange={(event) => setTextDraft({ at: textDraft.at, value: event.target.value })}
          onMouseDown={(event) => event.stopPropagation()}
          onBlur={commitTextDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              commitTextDraft();
            }
          }}
        />
      )}

      {toolbarAt && (
        <div
          className="screenshot-toolbar-anchor"
          ref={measureToolbar}
          style={{ left: toolbarAt.x, top: toolbarAt.y }}
        >
          <ScreenshotToolbar
            copy={copy.tools}
            tool={tool}
            onToolChange={(next) => {
              commitTextDraft();
              setTool(next);
            }}
            color={color}
            onColorChange={setColor}
            width={width}
            onWidthChange={setWidth}
            canUndo={annotations.length > 0}
            canRedo={redoStack.length > 0}
            onUndo={undo}
            onRedo={redo}
            onCancel={cancel}
            onCopy={() => void finish("copy")}
            onPin={() => void finish("pin")}
            onAttach={() => void finish("attach")}
            busy={busy}
          />
        </div>
      )}

      {busy && <p className="screenshot-hint">{copy.saving}</p>}
      {!busy && !committed && <p className="screenshot-hint">{copy.hintIdle}</p>}
      {!busy && committed && !tool && <p className="screenshot-hint is-subtle">{copy.hintReady}</p>}
    </div>
  );
}
