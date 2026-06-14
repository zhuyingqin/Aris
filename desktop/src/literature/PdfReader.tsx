import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { isTauri, literaturePdfBytes } from "../api/tauri";
import type {
  PdfAnnotation,
  PdfAnnotationColor,
  PdfAnnotationKind,
  PdfAnnotationRect,
} from "./literatureTypes";

const workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.15;
const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));

const KIND_LABELS: Record<PdfAnnotationKind, string> = {
  note: "用户标注",
  core: "核心句",
  evidence: "证据",
  "answer-support": "问答支撑",
};
const COLOR_SWATCHES: { key: PdfAnnotationColor; hex: string; label: string }[] = [
  { key: "yellow", hex: "#ffd54f", label: "黄色" },
  { key: "green", hex: "#81c784", label: "绿色" },
  { key: "blue", hex: "#4fc3f7", label: "蓝色" },
  { key: "red", hex: "#ef5350", label: "红色" },
  { key: "purple", hex: "#ba68c8", label: "紫色" },
];

interface PendingAnnotation {
  page: number;
  quote: string;
  rects: PdfAnnotationRect[];
  anchorX: number;
  anchorY: number;
}

interface PdfReaderProps {
  relativePath: string;
  initialPage?: number;
  annotations: PdfAnnotation[];
  focusedAnnotationId?: string | null;
  onOpenExternal: () => void;
  onAddAnnotation: (
    page: number,
    data: {
      quote: string;
      rects: PdfAnnotationRect[];
      color: PdfAnnotationColor;
      kind: PdfAnnotationKind;
      note: string;
    },
  ) => void;
  onUpdateAnnotation: (
    annotationId: string,
    patch: Partial<Pick<PdfAnnotation, "quote" | "note" | "kind" | "color">>,
  ) => void;
  onDeleteAnnotation: (annotationId: string) => void;
}

interface HighlightBox {
  annotationId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  kind: PdfAnnotation["kind"];
  color?: PdfAnnotationColor;
}

const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];

const normalizeAnchorText = (text: string) =>
  text.normalize("NFKC").replace(/\s+/g, " ").trim();

const highlightBoxesForPage = async (
  pdfPage: PDFPageProxy,
  zoom: number,
  annotations: PdfAnnotation[],
): Promise<HighlightBox[]> => {
  if (annotations.length === 0) return [];
  const viewport = pdfPage.getViewport({ scale: zoom });
  const content = await pdfPage.getTextContent();
  const segments: Array<{
    start: number;
    end: number;
    left: number;
    top: number;
    width: number;
    height: number;
  }> = [];
  let pageText = "";

  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const text = normalizeAnchorText(item.str);
    if (!text) continue;
    if (pageText) pageText += " ";
    const start = pageText.length;
    pageText += text;
    const [left, baseline] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const height = Math.max(8, Math.abs(item.height * zoom));
    segments.push({
      start,
      end: pageText.length,
      left,
      top: baseline - height,
      width: Math.max(3, Math.abs(item.width * zoom)),
      height,
    });
  }

  const boxes: HighlightBox[] = annotations.flatMap((annotation) =>
    (annotation.rects ?? []).map((rect) => ({
      annotationId: annotation.id,
      kind: annotation.kind,
      color: annotation.color,
      left: rect.left * viewport.width,
      top: rect.top * viewport.height,
      width: rect.width * viewport.width,
      height: rect.height * viewport.height,
    })),
  );
  for (const annotation of annotations) {
    if (annotation.rects?.length) continue;
    const quote = normalizeAnchorText(annotation.quote);
    const start = pageText.indexOf(quote);
    if (start < 0) continue;
    const end = start + quote.length;
    for (const segment of segments) {
      if (segment.end <= start || segment.start >= end) continue;
      boxes.push({
        annotationId: annotation.id,
        kind: annotation.kind,
        color: annotation.color,
        ...segment,
      });
    }
  }
  return boxes;
};

/** Per-page component: canvas + transparent text layer (for selection) + highlights overlay. */
function PdfPage({
  pdf,
  page,
  zoom,
  active,
  annotations,
  focusedAnnotationId,
  hoveredAnnotationId,
  onMeasured,
  onHighlightHover,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  zoom: number;
  active: boolean;
  annotations: PdfAnnotation[];
  focusedAnnotationId?: string | null;
  hoveredAnnotationId?: string | null;
  onMeasured: (page: number, baseHeight: number) => void;
  onHighlightHover: (annotationId: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const taskRef = useRef<RenderTask | null>(null);
  const textTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [boxes, setBoxes] = useState<HighlightBox[]>([]);

  useEffect(() => {
    if (!active) {
      taskRef.current?.cancel();
      textTaskRef.current?.cancel();
      const canvas = canvasRef.current;
      if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      if (textLayerRef.current) textLayerRef.current.innerHTML = "";
      setBoxes([]);
      return;
    }

    let disposed = false;
    taskRef.current?.cancel();
    textTaskRef.current?.cancel();

    void pdf
      .getPage(page)
      .then(async (pdfPage) => {
        if (disposed || !canvasRef.current) return;
        onMeasured(page, pdfPage.getViewport({ scale: 1 }).height);
        const viewport = pdfPage.getViewport({ scale: zoom });

        // Canvas render
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas rendering is unavailable.");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const renderTask = pdfPage.render({ canvas, canvasContext: context, viewport });
        taskRef.current = renderTask;
        await renderTask.promise;
        if (disposed) return;

        // Text layer for selection — rendered transparently over the canvas
        const textLayerDiv = textLayerRef.current;
        if (textLayerDiv) {
          textLayerDiv.innerHTML = "";
          const pdfjs = await import("pdfjs-dist");
          if (!disposed && "renderTextLayer" in pdfjs && typeof pdfjs.renderTextLayer === "function") {
            const textContent = await pdfPage.getTextContent();
            if (!disposed) {
              try {
                const textTask = pdfjs.renderTextLayer({
                  textContentSource: textContent,
                  container: textLayerDiv,
                  viewport,
                });
                textTaskRef.current = textTask;
                await textTask.promise;
              } catch {
                // Text layer failure is non-fatal — the canvas still shows the PDF.
              }
            }
          }
        }

        // Highlight boxes (positions of existing annotations)
        if (!disposed) {
          const computed = await highlightBoxesForPage(pdfPage, zoom, annotations);
          if (!disposed) setBoxes(computed);
        }
      })
      .catch((reason) => {
        if (reason?.name !== "RenderingCancelledException") {
          // Single page failure should not blank the whole reader.
        }
      });

    return () => {
      disposed = true;
      taskRef.current?.cancel();
      textTaskRef.current?.cancel();
    };
  }, [pdf, page, zoom, active, annotations, onMeasured]);

  // Detect when the cursor hovers over a highlight rect, reported up to the parent.
  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const hit = boxes.find(
        (box) =>
          px >= box.left &&
          px <= box.left + box.width &&
          py >= box.top &&
          py <= box.top + box.height,
      );
      onHighlightHover(hit?.annotationId ?? null);
    },
    [boxes, onHighlightHover],
  );

  const onMouseLeave = useCallback(() => {
    onHighlightHover(null);
  }, [onHighlightHover]);

  return (
    <>
      <canvas ref={canvasRef} aria-label={`PDF 第 ${page} 页`} />
      {/* Transparent text layer — enables native browser text selection */}
      <div
        ref={textLayerRef}
        className="lit-pdf-text-layer"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      />
      {/* Highlight overlays — pointer-events: none so text selection still works */}
      <div className="lit-pdf-highlight-layer" aria-hidden="true">
        {boxes.map((box, index) => (
          <span
            key={`${box.annotationId}:${index}`}
            className={`lit-pdf-highlight kind-${box.kind} color-${box.color ?? "yellow"}${
              focusedAnnotationId === box.annotationId || hoveredAnnotationId === box.annotationId
                ? " focused"
                : ""
            }`}
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          />
        ))}
      </div>
    </>
  );
}

/** Floating popup that appears above selected text for creating a new annotation. */
function SelectionPopup({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: PendingAnnotation;
  onConfirm: (color: PdfAnnotationColor, kind: PdfAnnotationKind, note: string) => void;
  onCancel: () => void;
}) {
  const [color, setColor] = useState<PdfAnnotationColor>("yellow");
  const [kind, setKind] = useState<PdfAnnotationKind>("note");
  const [note, setNote] = useState("");

  const left = Math.min(window.innerWidth - 272, Math.max(8, pending.anchorX - 136));
  const top = pending.anchorY - 8;

  return (
    <div
      className="lit-pdf-select-popup"
      style={{ position: "fixed", left, top, transform: "translateY(-100%)", zIndex: 1000 }}
    >
      <div className="lit-pdf-select-popup-quote">
        {pending.quote.length > 140 ? `${pending.quote.slice(0, 140)}…` : pending.quote}
      </div>
      <div className="lit-pdf-select-popup-row">
        <div className="lit-pdf-select-popup-colors">
          {COLOR_SWATCHES.map(({ key, hex, label }) => (
            <button
              key={key}
              type="button"
              className={`lit-pdf-color-swatch${color === key ? " active" : ""}`}
              style={{ background: hex }}
              aria-label={label}
              aria-pressed={color === key}
              onClick={() => setColor(key)}
            />
          ))}
        </div>
        <select
          className="lit-pdf-select-popup-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as PdfAnnotationKind)}
          aria-label="标注类型"
        >
          {(Object.keys(KIND_LABELS) as PdfAnnotationKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="lit-pdf-select-popup-note"
        placeholder="备注（可选）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        aria-label="标注备注"
      />
      <div className="lit-pdf-select-popup-actions">
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="lit-pdf-select-popup-save"
          onClick={() => onConfirm(color, kind, note)}
        >
          保存标注
        </button>
      </div>
      <div className="lit-pdf-select-popup-arrow" />
    </div>
  );
}

export default function PdfReader({
  relativePath,
  initialPage = 1,
  annotations,
  focusedAnnotationId,
  onOpenExternal,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
}: PdfReaderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef<Array<HTMLDivElement | null>>([]);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);
  const [pageBaseHeights, setPageBaseHeights] = useState<Record<number, number>>({});
  const [renderPages, setRenderPages] = useState<Set<number>>(() => new Set());
  const [currentPage, setCurrentPage] = useState(Math.max(1, initialPage));
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(1.2);
  const [fitWidth, setFitWidth] = useState(true);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAnnotation, setPendingAnnotation] = useState<PendingAnnotation | null>(null);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);

  const annotationsByPage = useMemo(() => {
    const map = new Map<number, PdfAnnotation[]>();
    for (const annotation of annotations) {
      const list = map.get(annotation.page);
      if (list) list.push(annotation);
      else map.set(annotation.page, [annotation]);
    }
    return map;
  }, [annotations]);

  const effectiveZoom = useMemo(() => {
    if (fitWidth && baseSize && containerWidth > 0) {
      return clampZoom((containerWidth - 40) / baseSize.w);
    }
    return zoomLevel;
  }, [fitWidth, baseSize, containerWidth, zoomLevel]);

  const effectiveHighlightId = focusedAnnotationId ?? hoveredAnnotationId;

  const onMeasured = useCallback((page: number, baseHeight: number) => {
    setPageBaseHeights((prev) =>
      prev[page] === baseHeight ? prev : { ...prev, [page]: baseHeight },
    );
  }, []);

  const scrollToPage = useCallback((page: number) => {
    const target = slotRefs.current[page - 1];
    const container = containerRef.current;
    if (target && container) {
      container.scrollTo({ top: target.offsetTop - 8, behavior: "smooth" });
    }
  }, []);

  // ── Load document ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let disposed = false;
    let loadedDocument: PDFDocumentProxy | null = null;
    setLoading(true);
    setError(null);
    setDocument(null);
    setNumPages(0);
    setBaseSize(null);
    setPageBaseHeights({});
    setRenderPages(new Set());
    if (!isTauri()) {
      setError("内嵌 PDF 阅读器需要桌面后端；浏览器预览不读取本地文件。");
      setLoading(false);
      return () => { disposed = true; };
    }
    if (typeof DOMMatrix === "undefined") {
      setError("当前 WebView 不支持 PDF 画布渲染。");
      setLoading(false);
      return () => { disposed = true; };
    }
    void Promise.all([literaturePdfBytes(relativePath), import("pdfjs-dist")])
      .then(([bytes, pdfjs]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
        return pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      })
      .then(async (pdf) => {
        loadedDocument = pdf;
        if (disposed) { void pdf.destroy(); return; }
        const firstPage = await pdf.getPage(1);
        const viewport = firstPage.getViewport({ scale: 1 });
        if (disposed) return;
        slotRefs.current = new Array(pdf.numPages).fill(null);
        setBaseSize({ w: viewport.width, h: viewport.height });
        setDocument(pdf);
        setNumPages(pdf.numPages);
        setCurrentPage((current) => Math.min(Math.max(1, current), pdf.numPages));
      })
      .catch((reason) => { if (!disposed) setError(String(reason)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => {
      disposed = true;
      if (loadedDocument) void loadedDocument.destroy();
    };
  }, [relativePath]);

  // ── Container width for fit-to-width ─────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(container);
    setContainerWidth(container.clientWidth);
    return () => observer.disconnect();
  }, [document]);

  // ── Lazy page rendering via IntersectionObserver ──────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!document || !container || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        setRenderPages((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.page);
            if (!page) continue;
            if (entry.isIntersecting) {
              if (!next.has(page)) { next.add(page); changed = true; }
            } else if (next.has(page)) { next.delete(page); changed = true; }
          }
          return changed ? next : prev;
        });
      },
      { root: container, rootMargin: "1200px 0px", threshold: 0.01 },
    );
    slotRefs.current.forEach((slot) => slot && observer.observe(slot));
    return () => observer.disconnect();
  }, [document, numPages]);

  // ── Derive current page from scroll position ──────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container || numPages === 0) return;
    let frame = 0;
    const handle = () => {
      frame = 0;
      const marker = container.scrollTop + container.clientHeight * 0.3;
      let page = 1;
      for (let i = 0; i < slotRefs.current.length; i += 1) {
        const slot = slotRefs.current[i];
        if (!slot) continue;
        if (slot.offsetTop <= marker) page = i + 1;
        else break;
      }
      setCurrentPage(page);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(handle); };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [numPages]);

  // ── Jump to page / focused annotation ────────────────────────────────────────
  useEffect(() => {
    if (document) scrollToPage(Math.max(1, initialPage));
  }, [document, initialPage, scrollToPage]);

  useEffect(() => {
    if (!document || !focusedAnnotationId) return;
    const target = annotations.find((a) => a.id === focusedAnnotationId);
    if (target) scrollToPage(target.page);
  }, [document, focusedAnnotationId, annotations, scrollToPage]);

  // ── Scroll focused annotation card into view in sidebar ──────────────────────
  useEffect(() => {
    if (!effectiveHighlightId || !sidebarRef.current) return;
    const card = sidebarRef.current.querySelector(
      `[data-annotation-id="${effectiveHighlightId}"]`,
    );
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [effectiveHighlightId]);

  // ── Text selection → pending annotation ──────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onMouseUp = () => {
      if (pendingAnnotation) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;

      const range = sel.getRangeAt(0);
      const ancestor = range.commonAncestorContainer;
      const pageSlot = (
        ancestor instanceof Element ? ancestor : ancestor.parentElement
      )?.closest("[data-page]") as HTMLElement | null;
      if (!pageSlot) return;

      const page = Number(pageSlot.dataset.page);
      if (!page) return;

      const quote = sel.toString().replace(/\s+/g, " ").trim();
      if (quote.length < 2) return;

      const pageRect = pageSlot.getBoundingClientRect();
      const rects: PdfAnnotationRect[] = Array.from(range.getClientRects())
        .filter((r) => r.width > 1 && r.height > 1)
        .map((r) => ({
          left: (r.left - pageRect.left) / pageRect.width,
          top: (r.top - pageRect.top) / pageRect.height,
          width: r.width / pageRect.width,
          height: r.height / pageRect.height,
        }));
      if (rects.length === 0) return;

      const boundingRect = range.getBoundingClientRect();
      setPendingAnnotation({
        page,
        quote,
        rects,
        anchorX: boundingRect.left + boundingRect.width / 2,
        anchorY: boundingRect.top,
      });
    };

    container.addEventListener("mouseup", onMouseUp);
    return () => container.removeEventListener("mouseup", onMouseUp);
  }, [pendingAnnotation]);

  // ── Dismiss selection popup on click outside ──────────────────────────────────
  useEffect(() => {
    if (!pendingAnnotation) return;
    const onDown = (e: MouseEvent) => {
      const popup = globalThis.document?.querySelector(".lit-pdf-select-popup");
      if (popup && !popup.contains(e.target as Node)) {
        setPendingAnnotation(null);
        window.getSelection()?.removeAllRanges();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [pendingAnnotation]);

  const handleConfirmAnnotation = useCallback(
    (color: PdfAnnotationColor, kind: PdfAnnotationKind, note: string) => {
      if (!pendingAnnotation) return;
      onAddAnnotation(pendingAnnotation.page, {
        quote: pendingAnnotation.quote,
        rects: pendingAnnotation.rects,
        color,
        kind,
        note,
      });
      setPendingAnnotation(null);
      window.getSelection()?.removeAllRanges();
    },
    [pendingAnnotation, onAddAnnotation],
  );

  const jumpToPage = (next: number) => {
    const clamped = Math.min(Math.max(1, next), numPages || 1);
    setCurrentPage(clamped);
    scrollToPage(clamped);
  };

  const adjustZoom = (delta: number) => {
    setFitWidth(false);
    setZoomLevel((current) => clampZoom((fitWidth ? effectiveZoom : current) + delta));
  };

  return (
    <div className="lit-pdf-reader">
      <div className="lit-pdf-toolbar">
        <div className="lit-pdf-pager">
          <button
            type="button"
            onClick={() => jumpToPage(currentPage - 1)}
            disabled={!document || currentPage <= 1}
            aria-label="上一页"
          >
            ‹
          </button>
          <label className="lit-pdf-page-input">
            <input
              type="number"
              min={1}
              max={numPages || 1}
              value={currentPage}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) jumpToPage(n);
              }}
              aria-label="PDF 页码"
            />
            <span>/ {numPages || "-"}</span>
          </label>
          <button
            type="button"
            onClick={() => jumpToPage(currentPage + 1)}
            disabled={!document || currentPage >= numPages}
            aria-label="下一页"
          >
            ›
          </button>
        </div>

        <div className="lit-pdf-zoom">
          <button type="button" onClick={() => adjustZoom(-ZOOM_STEP)} aria-label="缩小">
            −
          </button>
          <span className="lit-pdf-zoom-value">{Math.round(effectiveZoom * 100)}%</span>
          <button type="button" onClick={() => adjustZoom(ZOOM_STEP)} aria-label="放大">
            +
          </button>
          <button
            type="button"
            className={fitWidth ? "active" : ""}
            onClick={() => setFitWidth(true)}
          >
            适应宽度
          </button>
        </div>

        <div className="lit-pdf-toolbar-right">
          <button
            type="button"
            className={showAnnotations ? "active" : ""}
            onClick={() => setShowAnnotations((v) => !v)}
            title="切换标注侧栏"
          >
            标注{annotations.length > 0 ? ` · ${annotations.length}` : ""}
          </button>
          <button type="button" onClick={onOpenExternal}>
            系统阅读器
          </button>
        </div>
      </div>

      <div className="lit-pdf-reader-body">
        <div className="lit-pdf-scroll" ref={containerRef}>
          {loading && <div className="lit-pdf-state">正在加载 PDF…</div>}
          {error && <div className="lit-pdf-state error">PDF 加载失败：{error}</div>}
          {!loading && !error && document && (
            <div className="lit-pdf-tip">选中文字后可创建标注</div>
          )}
          {document && baseSize
            ? Array.from({ length: numPages }, (_, index) => {
                const page = index + 1;
                const width = baseSize.w * effectiveZoom;
                const height = (pageBaseHeights[page] ?? baseSize.h) * effectiveZoom;
                return (
                  <div
                    key={page}
                    ref={(el) => { slotRefs.current[index] = el; }}
                    data-page={page}
                    className="lit-pdf-page-slot"
                    style={{ width, height }}
                  >
                    {renderPages.has(page) && (
                      <PdfPage
                        pdf={document}
                        page={page}
                        zoom={effectiveZoom}
                        active
                        annotations={annotationsByPage.get(page) ?? EMPTY_ANNOTATIONS}
                        focusedAnnotationId={focusedAnnotationId}
                        hoveredAnnotationId={hoveredAnnotationId}
                        onMeasured={onMeasured}
                        onHighlightHover={setHoveredAnnotationId}
                      />
                    )}
                  </div>
                );
              })
            : null}
        </div>

        {pendingAnnotation && (
          <SelectionPopup
            pending={pendingAnnotation}
            onConfirm={handleConfirmAnnotation}
            onCancel={() => {
              setPendingAnnotation(null);
              window.getSelection()?.removeAllRanges();
            }}
          />
        )}

        {showAnnotations && (
          <aside
            ref={sidebarRef}
            className="lit-pdf-annotations"
            aria-label="PDF 标注列表"
          >
            <div className="lit-pdf-annotations-head">
              标注{annotations.length > 0 ? ` (${annotations.length})` : ""}
            </div>
            {annotations.length === 0 ? (
              <p className="lit-pdf-annotations-empty">选中 PDF 正文中的文字以添加标注。</p>
            ) : (
              annotations.map((annotation) => (
                <article
                  key={annotation.id}
                  data-annotation-id={annotation.id}
                  className={`lit-pdf-annotation-card kind-${annotation.kind}${
                    effectiveHighlightId === annotation.id ? " focused" : ""
                  }`}
                >
                  <div className="lit-pdf-annotation-card-header">
                    <span className="lit-pdf-annotation-kind-badge">
                      {KIND_LABELS[annotation.kind]}
                    </span>
                    <span className="lit-pdf-annotation-page-badge">第 {annotation.page} 页</span>
                    <button
                      type="button"
                      className="lit-pdf-annotation-delete"
                      aria-label="删除标注"
                      onClick={() => onDeleteAnnotation(annotation.id)}
                    >
                      ×
                    </button>
                  </div>
                  <label className="lit-pdf-annotation-field">
                    <span>原文</span>
                    <textarea
                      defaultValue={annotation.quote}
                      rows={3}
                      onBlur={(e) => onUpdateAnnotation(annotation.id, { quote: e.target.value })}
                    />
                  </label>
                  <div className="lit-pdf-annotation-options">
                    <label>
                      <span>类型</span>
                      <select
                        aria-label="标注类型"
                        value={annotation.kind}
                        onChange={(e) =>
                          onUpdateAnnotation(annotation.id, {
                            kind: e.target.value as PdfAnnotationKind,
                          })
                        }
                      >
                        {(Object.keys(KIND_LABELS) as PdfAnnotationKind[]).map((k) => (
                          <option key={k} value={k}>
                            {KIND_LABELS[k]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>颜色</span>
                      <select
                        aria-label="标注颜色"
                        value={annotation.color ?? "yellow"}
                        onChange={(e) =>
                          onUpdateAnnotation(annotation.id, {
                            color: e.target.value as PdfAnnotationColor,
                          })
                        }
                      >
                        {COLOR_SWATCHES.map(({ key, label }) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="lit-pdf-annotation-field">
                    <span>备注</span>
                    <textarea
                      defaultValue={annotation.note}
                      aria-label={`备注：${annotation.quote.slice(0, 30)}`}
                      onBlur={(e) => onUpdateAnnotation(annotation.id, { note: e.target.value })}
                    />
                  </label>
                </article>
              ))
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
