// Figure preview for the right-hand panel: an \includegraphics target opened
// from the file tree is an image, not a PDF, so it takes over the preview slot
// with image-appropriate controls.
import { useEffect, useState } from "react";
import { fileOpen, fileReadBytes } from "../api/tauri";
import { useStore } from "../store";
import { TYPESET_EDITOR_COPY } from "./i18n";
import { basename, extension } from "./latexText";
import { clampNumber, PDF_ZOOM_MAX, PDF_ZOOM_MIN } from "./pdfGeometry";
import { ToolIcon } from "./ToolIcon";

export default function TypesetImagePreview({
  path,
  refreshKey,
  onBackToPdf,
  onHide,
}: {
  path: string | null;
  refreshKey: number;
  onBackToPdf?: () => void;
  onHide: () => void;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].imagePreview;
  const [src, setSrc] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);

  useEffect(() => {
    if (!path) {
      setSrc(null);
      setSize(null);
      setError(null);
      return;
    }
    let disposed = false;
    let objectUrl: string | null = null;
    setError(null);
    setSrc(null);
    setSize(null);
    void fileReadBytes(path)
      .then((bytes) => {
        if (disposed) return;
        const blob = new Blob([new Uint8Array(bytes)], { type: imageMimeFor(path) });
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((readError) => {
        if (!disposed) setError(String(readError));
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, refreshKey]);

  // `null` zoom means fit-to-panel, which is what an unscaled figure wants.
  const scaled = size && zoom ? { width: size.width * zoom, height: size.height * zoom } : null;

  return (
    <section className="typeset-preview image" aria-label={copy.previewLabel}>
      <div className="typeset-preview-toolbar typeset-image-toolbar toolbar toolbar-pdf">
        <div className="typeset-preview-actions">
          <button type="button" className="typeset-image-zoom" title={copy.zoomOut} aria-label={copy.zoomOut} onClick={() => setZoom((value) => clampNumber((value ?? 1) - 0.25, PDF_ZOOM_MIN, PDF_ZOOM_MAX))}>
            <ToolIcon name="minus" />
          </button>
          <button type="button" className="typeset-image-zoom" title={copy.actualSize} onClick={() => setZoom(1)}>100%</button>
          <button type="button" className="typeset-image-zoom" title={copy.zoomIn} aria-label={copy.zoomIn} onClick={() => setZoom((value) => clampNumber((value ?? 1) + 0.25, PDF_ZOOM_MIN, PDF_ZOOM_MAX))}>
            <ToolIcon name="plus" />
          </button>
          <button
            type="button"
            className={`typeset-image-fit${zoom == null ? " active" : ""}`}
            title={copy.fitToWindow}
            onClick={() => setZoom(null)}
          >
            {copy.fit}
          </button>
          {size ? <span className="typeset-image-dimensions">{`${size.width} × ${size.height}`}</span> : null}
        </div>
        <div className="typeset-preview-actions toolbar-pdf-right">
          <span className="typeset-preview-file" title={path ?? ""}>{path ? basename(path) : copy.imageLabel}</span>
          {onBackToPdf ? (
            <button type="button" title={copy.backToPdf} aria-label={copy.backToPdf} onClick={onBackToPdf}>
              <ToolIcon name="previous" />
            </button>
          ) : null}
          <button type="button" title={copy.openExternally} aria-label={copy.openExternally} disabled={!path} onClick={() => path && void fileOpen(path)}>
            <ToolIcon name="open" />
          </button>
          <button type="button" title={copy.hidePreview} aria-label={copy.hidePreview} onClick={onHide}>
            <ToolIcon name="clear" />
          </button>
        </div>
      </div>
      <div className="typeset-image-scroll">
        <div className="typeset-image-stage">
          {src ? (
            <img
              src={src}
              alt={path ? basename(path) : copy.imageLabel}
              style={scaled
                ? { width: `${scaled.width}px`, height: `${scaled.height}px` }
                : { maxWidth: "100%", maxHeight: "100%" }}
              onLoad={(event) => setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })}
              onError={() => setError(copy.decodeFailed)}
            />
          ) : (
            <span className="typeset-image-status">{error ? copy.unavailable : copy.loading}</span>
          )}
        </div>
      </div>
    </section>
  );
}
function imageMimeFor(path: string): string {
  switch (extension(path)) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    case ".bmp": return "image/bmp";
    case ".tif":
    case ".tiff": return "image/tiff";
    default: return "application/octet-stream";
  }
}
