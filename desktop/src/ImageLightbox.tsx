// In-app image viewer, shared by every surface that can show a picture.
//
// Opening an image used to hand the file to the operating system's default
// image application, so each figure, screenshot or paper supplement launched a
// separate program on top of SomniQ. This lightbox keeps the image inside the
// app with the controls the LaTeX figure preview already offers (zoom, 100%,
// fit) and demotes the system viewer to an explicit action.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileOpen, fileReveal, isTauri } from "./api/tauri";
import { basename } from "./editor/workspaceFiles";
import { useStore } from "./store";
import { SvgIcon } from "./SvgIcon";
import { copyImageToClipboard } from "./imageClipboard";
import "./ImageLightbox.css";

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const ZOOM_STEP = 0.25;

const LIGHTBOX_COPY = {
  cn: {
    imageLabel: "图片",
    zoomOut: "缩小",
    zoomIn: "放大",
    actualSize: "实际大小",
    fit: "适应窗口",
    copyImage: "复制图片",
    copyingImage: "正在复制图片…",
    imageCopied: "图片已复制",
    imageCopyFailed: "图片复制失败，请重试。",
    pathCopyFailed: "路径复制失败，请重试。",
    retry: "重新加载",
    copyPath: "复制路径",
    copied: "已复制",
    reveal: "在文件管理器中显示",
    openExternal: "用系统程序打开",
    close: "关闭",
    loading: "正在读取图片…",
    failed: "无法显示这张图片。",
  },
  en: {
    imageLabel: "Image",
    zoomOut: "Zoom out",
    zoomIn: "Zoom in",
    actualSize: "Actual size",
    fit: "Fit to window",
    copyImage: "Copy image",
    copyingImage: "Copying image…",
    imageCopied: "Image copied",
    imageCopyFailed: "Could not copy image. Try again.",
    pathCopyFailed: "Could not copy path. Try again.",
    retry: "Reload image",
    copyPath: "Copy path",
    copied: "Copied",
    reveal: "Show in file manager",
    openExternal: "Open with system app",
    close: "Close",
    loading: "Loading image…",
    failed: "This image cannot be displayed.",
  },
} as const;

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

interface Props {
  /** Resolved display URL, or null while a file opened without a preview loads. */
  src: string | null;
  loadError?: boolean;
  alt?: string;
  title?: string;
  /** Local path, when there is one: it names the image and fills the header actions. */
  path?: string;
  /**
   * Overrides for callers whose files are not plain workspace paths — the
   * literature library resolves its own attachments, the way `PdfReader`
   * already takes these two actions from its host.
   */
  onOpenExternal?: () => void;
  onReveal?: () => void;
  onRetry?: () => void;
  onClose: () => void;
}

export default function ImageLightbox({
  src,
  loadError = false,
  alt,
  title,
  path,
  onOpenExternal,
  onReveal,
  onRetry,
  onClose,
}: Props) {
  const language = useStore((state) => state.language);
  const copy = LIGHTBOX_COPY[language];
  // `null` zoom means fit-to-window, which is what opening an image should do.
  const [zoom, setZoom] = useState<number | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [percent, setPercent] = useState(100);
  const [pannable, setPannable] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState<"image" | "path" | null>(null);
  const [copying, setCopying] = useState<"image" | "path" | null>(null);
  const [copyError, setCopyError] = useState<"image" | "path" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [failed, setFailed] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const zoomRef = useRef<number | null>(zoom);
  zoomRef.current = zoom;

  const label = basename(path ?? title ?? alt ?? "") || copy.imageLabel;

  const showCopied = useCallback((action: "image" | "path") => {
    if (!mountedRef.current) return;
    setCopied(action);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(null), 1500);
  }, []);

  const copyImage = useCallback(async () => {
    if (!src || loadError || failed || copying) return;
    setCopying("image");
    setCopied(null);
    setCopyError(null);
    try {
      await copyImageToClipboard(path ?? src, src);
      showCopied("image");
    } catch {
      if (mountedRef.current) setCopyError("image");
    } finally {
      if (mountedRef.current) setCopying(null);
    }
  }, [copying, failed, loadError, path, showCopied, src]);

  const copyPath = async () => {
    if (!path || copying) return;
    setCopying("path");
    setCopied(null);
    setCopyError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable");
      await navigator.clipboard.writeText(path);
      showCopied("path");
    } catch {
      if (mountedRef.current) setCopyError("path");
    } finally {
      if (mountedRef.current) setCopying(null);
    }
  };

  useEffect(() => {
    setFailed(false);
    setSize(null);
    setZoom(null);
    setCopied(null);
    setCopyError(null);
  }, [src, path]);

  /** Scale the image is drawn at right now, including while fitted. */
  const currentScale = useCallback(() => {
    if (zoomRef.current != null) return zoomRef.current;
    const image = imageRef.current;
    if (image && image.naturalWidth > 0 && image.clientWidth > 0) {
      return image.clientWidth / image.naturalWidth;
    }
    return 1;
  }, []);

  const stepZoom = useCallback((delta: number) => {
    setZoom((value) => clampZoom((value ?? currentScale()) + delta));
  }, [currentScale]);

  useEffect(() => {
    mountedRef.current = true;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();
    return () => {
      mountedRef.current = false;
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      opener?.focus?.();
    };
  }, []);

  // Capture phase: while the viewer is open its Escape takes precedence over
  // the surfaces underneath (side panel, dialogs) rather than closing both.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
        if (src && !failed && !loadError) {
          event.preventDefault();
          event.stopPropagation();
          void copyImage();
        }
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "+" || event.key === "=") stepZoom(ZOOM_STEP);
      else if (event.key === "-" || event.key === "_") stepZoom(-ZOOM_STEP);
      else if (event.key === "0") setZoom(null);
      else if (event.key === "1") setZoom(1);
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [copyImage, failed, loadError, onClose, src, stepZoom]);

  // React attaches `wheel` passively, so ctrl+wheel zoom needs a native
  // listener to stop the webview from zooming the whole page instead.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom(clampZoom(currentScale() * factor));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [currentScale]);

  // Measured after layout so the header can report the real scale while fitted,
  // and so panning only turns on once the image overflows its stage.
  useEffect(() => {
    const measure = () => {
      const stage = stageRef.current;
      if (!stage) return;
      setPannable(stage.scrollWidth > stage.clientWidth || stage.scrollHeight > stage.clientHeight);
      setPercent(Math.round(currentScale() * 100));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [currentScale, size, src, zoom]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage || event.button !== 0 || !pannable) return;
    dragRef.current = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    setDragging(true);
    stage.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const origin = dragRef.current;
    const stage = stageRef.current;
    if (!origin || !stage) return;
    stage.scrollLeft = origin.left - (event.clientX - origin.x);
    stage.scrollTop = origin.top - (event.clientY - origin.y);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    stageRef.current?.releasePointerCapture?.(event.pointerId);
  };

  const scaled = size && zoom ? { width: size.width * zoom, height: size.height * zoom } : null;
  // Without an override the header only offers the system actions for a path
  // the desktop backend can resolve on its own.
  const ownPathActions = Boolean(path) && isTauri();
  const revealAction = onReveal ?? (ownPathActions ? () => void fileReveal(path!).catch(() => undefined) : null);
  const externalAction = onOpenExternal ?? (ownPathActions ? () => void fileOpen(path!).catch(() => undefined) : null);

  return createPortal(
    <div
      className="image-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="image-lightbox-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        <header>
          <span className="image-lightbox-title" title={path ?? label}>{label}</span>
          <div className="image-lightbox-zoom">
            <button type="button" title={copy.zoomOut} aria-label={copy.zoomOut} onClick={() => stepZoom(-ZOOM_STEP)}>
              <SvgIcon name="minus" size={14} />
            </button>
            <button
              type="button"
              className="image-lightbox-level"
              title={copy.actualSize}
              onClick={() => setZoom(1)}
            >
              {`${percent}%`}
            </button>
            <button type="button" title={copy.zoomIn} aria-label={copy.zoomIn} onClick={() => stepZoom(ZOOM_STEP)}>
              <SvgIcon name="plus" size={14} />
            </button>
            <button
              type="button"
              className={`image-lightbox-fit${zoom == null ? " active" : ""}`}
              title={copy.fit}
              aria-label={copy.fit}
              aria-pressed={zoom == null}
              onClick={() => setZoom(null)}
            >
              <SvgIcon name="fit" size={14} />
            </button>
          </div>
          <div className="image-lightbox-actions">
            {size && (
              <span className="image-lightbox-dimensions">{`${size.width} × ${size.height}`}</span>
            )}
            <button
              type="button"
              title={copying === "image" ? copy.copyingImage : copied === "image" ? copy.imageCopied : copy.copyImage}
              aria-label={copy.copyImage}
              disabled={!src || loadError || failed || copying !== null}
              onClick={() => void copyImage()}
            >
              <SvgIcon name={copied === "image" ? "check" : copying === "image" ? "spinner" : "image"} size={14} />
            </button>
            {path && (
              <button
                type="button"
                title={copied === "path" ? copy.copied : copy.copyPath}
                aria-label={copy.copyPath}
                disabled={copying !== null}
                onClick={() => void copyPath()}
              >
                <SvgIcon name={copied === "path" ? "check" : "copy"} size={14} />
              </button>
            )}
            {revealAction && (
              <button type="button" title={copy.reveal} aria-label={copy.reveal} onClick={revealAction}>
                <SvgIcon name="folder" size={14} />
              </button>
            )}
            {externalAction && (
              <button
                type="button"
                title={copy.openExternal}
                aria-label={copy.openExternal}
                onClick={externalAction}
              >
                <SvgIcon name="externalLink" size={14} />
              </button>
            )}
            <button type="button" title={copy.close} aria-label={copy.close} onClick={onClose}>
              <SvgIcon name="close" size={14} />
            </button>
          </div>
        </header>
        <div
          className={`image-lightbox-stage${pannable ? " pannable" : ""}${dragging ? " dragging" : ""}`}
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {loadError || failed ? (
            <div className="image-lightbox-status" role="alert">
              <span>{copy.failed}</span>
              {(onRetry || (src && !loadError)) && (
                <button type="button" onClick={() => {
                  setFailed(false);
                  setSize(null);
                  setReloadKey((value) => value + 1);
                  onRetry?.();
                }}>{copy.retry}</button>
              )}
            </div>
          ) : !src ? (
            <span className="image-lightbox-status" role="status">{copy.loading}</span>
          ) : (
            <img
              key={reloadKey}
              ref={imageRef}
              src={src}
              data-image-path={path}
              alt={alt ?? label}
              draggable={false}
              onDoubleClick={() => setZoom((value) => value === 1 ? null : 1)}
              style={scaled
                ? { width: `${scaled.width}px`, height: `${scaled.height}px`, maxWidth: "none", maxHeight: "none" }
                : undefined}
              onLoad={(event) => setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })}
              onError={() => setFailed(true)}
            />
          )}
        </div>
        {(copyError || copied) && (
          <div className="image-lightbox-feedback" role={copyError ? "alert" : "status"}>
            {copyError === "image" ? copy.imageCopyFailed : copyError === "path" ? copy.pathCopyFailed
              : copied === "image" ? copy.imageCopied : copy.copied}
          </div>
        )}
        {path && (
          <footer className="image-lightbox-path">
            <code title={path}>{path}</code>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
