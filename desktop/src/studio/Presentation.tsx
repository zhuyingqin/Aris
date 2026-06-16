import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { literaturePdfBytes } from "../api/tauri";

const workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const CONTROLS_HIDE_MS = 2600;

/** Fullscreen, one-page-at-a-time presentation surface for compiled slide /
 * poster PDFs. Renders the current page fit-to-viewport on a canvas and drives
 * navigation from the keyboard (arrows / space / PageUp-Down / Home / End) or
 * the auto-hiding control bar. Independent of the annotated PdfReader so the
 * present experience stays chrome-free. */
export default function Presentation({
  relativePath,
  initialPage = 1,
  onClose,
}: {
  relativePath: string;
  initialPage?: number;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const onCloseRef = useRef(onClose);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [page, setPage] = useState(Math.max(1, initialPage));
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);

  onCloseRef.current = onClose;

  // Load the document once per file.
  useEffect(() => {
    let disposed = false;
    setError(null);
    setPageCount(0);
    void Promise.all([literaturePdfBytes(relativePath), import("pdfjs-dist")])
      .then(([bytes, pdfjs]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
        return pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      })
      .then((pdf) => {
        if (disposed) {
          void pdf.destroy();
          return;
        }
        pdfRef.current = pdf;
        setPageCount(pdf.numPages);
        setPage((current) => Math.min(Math.max(1, current), pdf.numPages));
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
      void pdfRef.current?.destroy();
      pdfRef.current = null;
    };
  }, [relativePath]);

  // Render the active page scaled to fill the viewport without cropping.
  const renderPage = useCallback(async () => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!pdf || !canvas || !container) return;
    renderTaskRef.current?.cancel();
    try {
      const pdfPage = await pdf.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const fit = Math.min(
        container.clientWidth / base.width,
        container.clientHeight / base.height,
      );
      const scale = Math.max(0.1, fit);
      const viewport = pdfPage.getViewport({ scale: scale * dpr });
      const context = canvas.getContext("2d");
      if (!context) return;
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
      const task = pdfPage.render({ canvas, canvasContext: context, viewport });
      renderTaskRef.current = task;
      await task.promise;
    } catch {
      // Render cancellations during fast paging are expected; ignore.
    }
  }, [page]);

  useEffect(() => {
    void renderPage();
  }, [renderPage, pageCount]);

  useEffect(() => {
    const onResize = () => void renderPage();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [renderPage]);

  const go = useCallback(
    (delta: number) =>
      setPage((current) => {
        const next = current + delta;
        if (next < 1) return current;
        if (pageCount && next > pageCount) return current;
        return next;
      }),
    [pageCount],
  );

  // Keyboard navigation while presenting.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
          event.preventDefault();
          go(1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
        case "Backspace":
          event.preventDefault();
          go(-1);
          break;
        case "Home":
          event.preventDefault();
          setPage(1);
          break;
        case "End":
          if (pageCount) {
            event.preventDefault();
            setPage(pageCount);
          }
          break;
        case "Escape":
          onCloseRef.current();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, pageCount]);

  // Request native fullscreen; closing fullscreen (e.g. via Esc) closes the
  // overlay. The fixed-position overlay still works if the API is unavailable.
  useEffect(() => {
    const element = containerRef.current;
    void element?.requestFullscreen?.().catch(() => undefined);
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) onCloseRef.current();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement) void document.exitFullscreen?.();
    };
  }, []);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => {
    revealControls();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [revealControls, page]);

  const atStart = page <= 1;
  const atEnd = pageCount > 0 && page >= pageCount;

  return (
    <div
      ref={containerRef}
      className="studio-presentation"
      onMouseMove={revealControls}
    >
      {error ? (
        <div className="studio-presentation-error">
          <strong>Couldn’t present this file.</strong>
          <p>{error}</p>
          <button type="button" onClick={onClose}>Exit</button>
        </div>
      ) : (
        <>
          <div
            className="studio-presentation-stage"
            onClick={() => go(1)}
            onContextMenu={(event) => {
              event.preventDefault();
              go(-1);
            }}
          >
            <canvas ref={canvasRef} />
          </div>
          <div className={`studio-presentation-bar${controlsVisible ? "" : " hidden"}`}>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                go(-1);
              }}
              disabled={atStart}
            >
              Prev
            </button>
            <span className="studio-presentation-counter">
              {pageCount ? `${page} / ${pageCount}` : "Loading…"}
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                go(1);
              }}
              disabled={atEnd}
            >
              Next
            </button>
            <button type="button" className="studio-presentation-exit" onClick={onClose}>
              Exit
            </button>
          </div>
        </>
      )}
    </div>
  );
}
