import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { isTauri, literaturePdfBytes } from "../api/tauri";
import { SvgIcon } from "../SvgIcon";
import type {
  PdfAnnotation,
  PdfAnnotationColor,
  PdfAnnotationKind,
  PdfAnnotationRect,
  PdfAnnotationStyle,
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
const STYLE_OPTIONS: { key: PdfAnnotationStyle; label: string; glyph: string }[] = [
  { key: "highlight", label: "高亮", glyph: "A" },
  { key: "underline", label: "下划线", glyph: "A" },
  { key: "strikethrough", label: "删除线", glyph: "A" },
];

/** Selection-driven AI actions. List-shaped so explain/summarize/ask can be
 * appended later without touching the popover wiring. */
interface AiAction {
  key: string;
  label: string;
  system: string;
}
const AI_ACTIONS: AiAction[] = [
  {
    key: "translate",
    label: "翻译",
    system:
      "你是严谨的学术译者。把用户提供的文本翻译成流畅、自然的中文，" +
      "保留专业术语、数学符号与引用标记（如 [1]）。只输出译文，不要任何前言或解释。",
  },
];

interface PendingAnnotation {
  page: number;
  quote: string;
  rects: PdfAnnotationRect[];
  anchorX: number;
  anchorY: number;
  anchorBottomY: number;
}

interface PdfReaderProps {
  relativePath: string;
  initialPage?: number;
  /** Change this value to request another jump even when initialPage is unchanged. */
  pageRequestKey?: string | number;
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
      style: PdfAnnotationStyle;
    },
  ) => void;
  onUpdateAnnotation: (
    annotationId: string,
    patch: Partial<Pick<PdfAnnotation, "quote" | "note" | "kind" | "color" | "style">>,
  ) => void;
  onDeleteAnnotation: (annotationId: string) => void;
  /** One-shot LLM call (reuses the literature Chat backend). */
  onRunAi: (system: string, prompt: string) => Promise<string>;
  /** Hide annotation and AI affordances when used as a read-only preview. */
  readOnly?: boolean;
  /** Report the visible page so review surfaces can attach page-level notes. */
  onPageChange?: (page: number) => void;
  /** Report the page count after the PDF is loaded. */
  onDocumentLoaded?: (pageCount: number) => void;
}

interface HighlightBox {
  annotationId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  kind: PdfAnnotation["kind"];
  color?: PdfAnnotationColor;
  style: PdfAnnotationStyle;
}

/** Screen-space anchor for a floating popover, in fixed (viewport) coordinates. */
interface HighlightAnchor {
  x: number;
  y: number;
  bottom: number;
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
      style: annotation.style ?? "highlight",
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
        style: annotation.style ?? "highlight",
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
  onHighlightActivate,
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
  onHighlightActivate: (annotationId: string, anchor: HighlightAnchor) => void;
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

        // Text layer for selection — rendered transparently over the canvas.
        // pdf.js v5 replaced the `renderTextLayer` function with a `TextLayer`
        // class; spans are positioned in %, scaled by --total-scale-factor.
        const textLayerDiv = textLayerRef.current;
        if (textLayerDiv) {
          textLayerDiv.innerHTML = "";
          textLayerDiv.style.setProperty("--total-scale-factor", String(zoom));
          const pdfjs = await import("pdfjs-dist");
          if (!disposed && "TextLayer" in pdfjs && typeof pdfjs.TextLayer === "function") {
            const textContent = await pdfPage.getTextContent();
            if (!disposed) {
              try {
                const textLayer = new pdfjs.TextLayer({
                  textContentSource: textContent,
                  container: textLayerDiv,
                  viewport,
                });
                textTaskRef.current = textLayer;
                await textLayer.render();
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

  // Shared hit-test: which highlight box (if any) sits under the pointer.
  const findBoxAt = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const box = boxes.find(
        (candidate) =>
          px >= candidate.left &&
          px <= candidate.left + candidate.width &&
          py >= candidate.top &&
          py <= candidate.top + candidate.height,
      );
      return { rect, box };
    },
    [boxes],
  );

  // Detect when the cursor hovers over a highlight rect, reported up to the parent.
  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      onHighlightHover(findBoxAt(e).box?.annotationId ?? null);
    },
    [findBoxAt, onHighlightHover],
  );

  const onMouseLeave = useCallback(() => {
    onHighlightHover(null);
  }, [onHighlightHover]);

  // Click on an existing highlight → open its floating popover, anchored on the
  // highlight's screen position. Ignored while a text selection is active so a
  // drag-to-select gesture still creates a new annotation.
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const { rect, box } = findBoxAt(e);
      if (!box) return;
      onHighlightActivate(box.annotationId, {
        x: rect.left + box.left + box.width / 2,
        y: rect.top + box.top,
        bottom: rect.top + box.top + box.height,
      });
    },
    [findBoxAt, onHighlightActivate],
  );

  return (
    <>
      <canvas ref={canvasRef} aria-label={`PDF 第 ${page} 页`} />
      {/* Transparent text layer — enables native browser text selection */}
      <div
        ref={textLayerRef}
        className="lit-pdf-text-layer"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
      />
      {/* Highlight overlays — pointer-events: none so text selection still works */}
      <div className="lit-pdf-highlight-layer" aria-hidden="true">
        {boxes.map((box, index) => (
          <span
            key={`${box.annotationId}:${index}`}
            className={`lit-pdf-highlight kind-${box.kind} color-${box.color ?? "yellow"} style-${box.style}${
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

interface AiState {
  action: AiAction;
  status: "loading" | "done" | "error";
  text: string;
}

/** Compact toolbar shown next to a text selection. */
function QuickSelectionPopup({
  pending,
  onQuickHighlight,
  onSaveNote,
  onRunAi,
  onCancel,
}: {
  pending: PendingAnnotation;
  onQuickHighlight: (color: PdfAnnotationColor, style: PdfAnnotationStyle) => void;
  onSaveNote: (
    color: PdfAnnotationColor,
    kind: PdfAnnotationKind,
    note: string,
    style: PdfAnnotationStyle,
  ) => void;
  onRunAi: (system: string, prompt: string) => Promise<string>;
  onCancel: () => void;
}) {
  const [color, setColor] = useState<PdfAnnotationColor>("yellow");
  const [kind, setKind] = useState<PdfAnnotationKind>("note");
  const [note, setNote] = useState("");
  const [style, setStyle] = useState<PdfAnnotationStyle>("highlight");
  const [showDetails, setShowDetails] = useState(false);
  const [ai, setAi] = useState<AiState | null>(null);
  const styleVerb =
    style === "underline" ? "下划线" : style === "strikethrough" ? "删除线" : "高亮";

  const runAi = useCallback(
    (action: AiAction) => {
      setAi({ action, status: "loading", text: "" });
      onRunAi(action.system, pending.quote)
        .then((text) => setAi({ action, status: "done", text: text.trim() }))
        .catch((reason) => setAi({ action, status: "error", text: String(reason) }));
    },
    [onRunAi, pending.quote],
  );

  const aiActive = ai !== null;
  const popupWidth = aiActive ? 360 : showDetails ? 320 : 300;
  const left = Math.min(window.innerWidth - popupWidth - 8, Math.max(8, pending.anchorX - popupWidth / 2));
  const placeBelow = aiActive ? true : pending.anchorY < (showDetails ? 320 : 72);
  const top = aiActive
    ? Math.max(8, Math.min(pending.anchorBottomY + 8, window.innerHeight - 438))
    : placeBelow
      ? pending.anchorBottomY + 8
      : pending.anchorY - 8;

  return (
    <div
      className={`lit-pdf-select-popup${showDetails ? " expanded" : ""}${aiActive ? " ai" : ""}`}
      style={{
        position: "fixed",
        left,
        top,
        width: popupWidth,
        transform: aiActive || placeBelow ? undefined : "translateY(-100%)",
        zIndex: 1000,
      }}
      role="toolbar"
      aria-label="选区操作"
    >
      {aiActive ? (
        <div className="lit-pdf-ai-panel">
          <div className="lit-pdf-ai-head">
            <button type="button" className="lit-pdf-ai-back" aria-label="返回标记" onClick={() => setAi(null)}>
              <SvgIcon name="chevronLeft" size={14} /> 返回
            </button>
            <span className="lit-pdf-ai-title">{ai.action.label}</span>
            <button type="button" className="lit-pdf-popup-close" aria-label="关闭" onClick={onCancel}>
              <SvgIcon name="close" size={14} />
            </button>
          </div>
          <div className="lit-pdf-ai-body">
            {ai.status === "loading" && (
              <div className="lit-pdf-ai-loading">
                <span className="lit-search-spinner" aria-hidden="true" />
                正在{ai.action.label}…
              </div>
            )}
            {ai.status === "error" && <div className="lit-pdf-ai-error">出错了：{ai.text}</div>}
            {ai.status === "done" && <div className="lit-pdf-ai-result">{ai.text}</div>}
          </div>
          <div className="lit-pdf-ai-actions">
            {ai.status === "error" && (
              <button type="button" onClick={() => runAi(ai.action)}>
                重试
              </button>
            )}
            {ai.status === "done" && (
              <>
                <button type="button" onClick={() => void navigator.clipboard?.writeText(ai.text)}>
                  复制
                </button>
                <button
                  type="button"
                  className="lit-pdf-select-popup-save"
                  onClick={() => onSaveNote("blue", "note", `【${ai.action.label}】\n${ai.text}`, "highlight")}
                >
                  保存到标注
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="lit-pdf-select-popup-row">
            <div className="lit-pdf-style-seg" role="group" aria-label="标记样式">
              {STYLE_OPTIONS.map(({ key, label, glyph }) => (
                <button
                  key={key}
                  type="button"
                  className={`lit-pdf-style-btn style-${key}${style === key ? " active" : ""}`}
                  aria-label={label}
                  aria-pressed={style === key}
                  title={label}
                  onClick={() => setStyle(key)}
                >
                  {glyph}
                </button>
              ))}
            </div>
            <div className="lit-pdf-select-popup-colors">
              {COLOR_SWATCHES.map(({ key, hex, label }) => (
                <button
                  key={key}
                  type="button"
                  className={`lit-pdf-color-swatch${color === key ? " active" : ""}`}
                  style={{ background: hex }}
                  aria-label={`用${label}${styleVerb}`}
                  aria-pressed={color === key}
                  title={`用${label}${styleVerb}`}
                  onClick={() => {
                    setColor(key);
                    if (!showDetails) onQuickHighlight(key, style);
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              className="lit-pdf-select-popup-note-toggle"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((value) => !value)}
            >
              加备注
            </button>
            <button type="button" className="lit-pdf-popup-close" aria-label="取消选区" onClick={onCancel}>
              <SvgIcon name="close" size={14} />
            </button>
          </div>
          <div className="lit-pdf-select-popup-ai-row">
            {AI_ACTIONS.map((action) => (
              <button
                key={action.key}
                type="button"
                className="lit-pdf-ai-btn"
                onClick={() => runAi(action)}
              >
                <SvgIcon name="sparkle" size={13} /> {action.label}
              </button>
            ))}
          </div>
          {showDetails && (
            <div className="lit-pdf-select-popup-details">
              <div className="lit-pdf-select-popup-quote">
                {pending.quote.length > 140 ? `${pending.quote.slice(0, 140)}…` : pending.quote}
              </div>
              <select
                className="lit-pdf-select-popup-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as PdfAnnotationKind)}
                aria-label="标注类型"
              >
                {(Object.keys(KIND_LABELS) as PdfAnnotationKind[]).map((value) => (
                  <option key={value} value={value}>
                    {KIND_LABELS[value]}
                  </option>
                ))}
              </select>
              <textarea
                className="lit-pdf-select-popup-note"
                placeholder="添加备注（可选）"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                aria-label="标注备注"
                autoFocus
              />
              <button
                type="button"
                className="lit-pdf-select-popup-save"
                onClick={() => onSaveNote(color, kind, note, style)}
              >
                保存备注
              </button>
            </div>
          )}
          <div className={`lit-pdf-select-popup-arrow${placeBelow ? " below" : ""}`} />
        </>
      )}
    </div>
  );
}

/** Floating popover shown when an existing highlight is clicked — quick edit / delete. */
function HighlightPopover({
  annotation,
  anchor,
  onEdit,
  onDelete,
  onClose,
}: {
  annotation: PdfAnnotation;
  anchor: HighlightAnchor;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const width = 240;
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, anchor.x - width / 2));
  const placeBelow = anchor.y < 140;
  const top = placeBelow ? anchor.bottom + 8 : anchor.y - 8;

  return (
    <div
      className="lit-pdf-highlight-popover"
      style={{
        position: "fixed",
        left,
        top,
        width,
        transform: placeBelow ? undefined : "translateY(-100%)",
        zIndex: 1000,
      }}
      role="dialog"
      aria-label="高亮操作"
    >
      <div className="lit-pdf-highlight-popover-head">
        <span className="lit-pdf-annotation-kind-badge">{KIND_LABELS[annotation.kind]}</span>
        <span className="lit-pdf-highlight-popover-page">第 {annotation.page} 页</span>
        <button type="button" className="lit-pdf-popup-close" aria-label="关闭" onClick={onClose}>
          <SvgIcon name="close" size={14} />
        </button>
      </div>
      <blockquote className="lit-pdf-highlight-popover-quote">
        {annotation.quote.length > 120 ? `${annotation.quote.slice(0, 120)}…` : annotation.quote}
      </blockquote>
      <p className={`lit-pdf-highlight-popover-note${annotation.note ? "" : " empty"}`}>
        {annotation.note || "无备注"}
      </p>
      <div className="lit-pdf-highlight-popover-actions">
        <button type="button" className="danger" onClick={onDelete}>
          删除
        </button>
        <button type="button" onClick={onEdit}>
          编辑
        </button>
      </div>
      <div className={`lit-pdf-select-popup-arrow${placeBelow ? " below" : ""}`} />
    </div>
  );
}

interface AnnotationEditorAnchor {
  x: number;
  y: number;
}

function AnnotationEditor({
  annotation,
  anchor,
  onUpdate,
  onDelete,
  onClose,
}: {
  annotation: PdfAnnotation;
  anchor: AnnotationEditorAnchor;
  onUpdate: (patch: Partial<Pick<PdfAnnotation, "note" | "kind" | "color" | "style">>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const width = 286;
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, anchor.x - width));
  const top = Math.max(8, Math.min(window.innerHeight - 340, anchor.y));

  return (
    <div
      className="lit-pdf-annotation-editor"
      style={{ position: "fixed", left, top, zIndex: 1000 }}
      role="dialog"
      aria-label="编辑标注"
    >
      <div className="lit-pdf-annotation-editor-head">
        <span>第 {annotation.page} 页</span>
        <button type="button" className="lit-pdf-popup-close" aria-label="关闭标注编辑器" onClick={onClose}>
          <SvgIcon name="close" size={14} />
        </button>
      </div>
      <blockquote>{annotation.quote}</blockquote>
      <div className="lit-pdf-annotation-editor-colors" aria-label="标注颜色">
        {COLOR_SWATCHES.map(({ key, hex, label }) => (
          <button
            key={key}
            type="button"
            className={`lit-pdf-color-swatch${(annotation.color ?? "yellow") === key ? " active" : ""}`}
            style={{ background: hex }}
            aria-label={`设为${label}`}
            aria-pressed={(annotation.color ?? "yellow") === key}
            onClick={() => onUpdate({ color: key })}
          />
        ))}
      </div>
      <div className="lit-pdf-style-seg" role="group" aria-label="标记样式">
        {STYLE_OPTIONS.map(({ key, label, glyph }) => (
          <button
            key={key}
            type="button"
            className={`lit-pdf-style-btn style-${key}${(annotation.style ?? "highlight") === key ? " active" : ""}`}
            aria-label={`设为${label}`}
            aria-pressed={(annotation.style ?? "highlight") === key}
            title={label}
            onClick={() => onUpdate({ style: key })}
          >
            {glyph}
          </button>
        ))}
      </div>
      <select
        value={annotation.kind}
        aria-label="标注类型"
        onChange={(event) => onUpdate({ kind: event.target.value as PdfAnnotationKind })}
      >
        {(Object.keys(KIND_LABELS) as PdfAnnotationKind[]).map((value) => (
          <option key={value} value={value}>
            {KIND_LABELS[value]}
          </option>
        ))}
      </select>
      <textarea
        defaultValue={annotation.note}
        aria-label="标注备注"
        placeholder="添加备注"
        rows={4}
        onBlur={(event) => onUpdate({ note: event.target.value })}
      />
      <div className="lit-pdf-annotation-editor-actions">
        <button type="button" className="danger" onClick={onDelete}>
          删除
        </button>
        <button type="button" onClick={onClose}>
          完成
        </button>
      </div>
    </div>
  );
}

export default function PdfReader({
  relativePath,
  initialPage = 1,
  pageRequestKey,
  annotations,
  focusedAnnotationId,
  onOpenExternal,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onRunAi,
  readOnly = false,
  onPageChange,
  onDocumentLoaded,
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
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAnnotation, setPendingAnnotation] = useState<PendingAnnotation | null>(null);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editorAnchor, setEditorAnchor] = useState<AnnotationEditorAnchor | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<{ id: string; anchor: HighlightAnchor } | null>(null);

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

  const effectiveHighlightId = focusedAnnotationId ?? hoveredAnnotationId ?? editingAnnotationId;
  const editingAnnotation = annotations.find((annotation) => annotation.id === editingAnnotationId) ?? null;
  const activeHighlightAnnotation = activeHighlight
    ? annotations.find((annotation) => annotation.id === activeHighlight.id) ?? null
    : null;
  const annotationsVisible = showAnnotations && !readOnly;

  // Clicking an existing highlight opens its quick popover — clear any other floating UI.
  const handleHighlightActivate = useCallback((annotationId: string, anchor: HighlightAnchor) => {
    setPendingAnnotation(null);
    setEditingAnnotationId(null);
    setEditorAnchor(null);
    setActiveHighlight({ id: annotationId, anchor });
  }, []);

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

  useEffect(() => {
    if (numPages > 0) onDocumentLoaded?.(numPages);
  }, [numPages, onDocumentLoaded]);

  useEffect(() => {
    if (numPages > 0) onPageChange?.(currentPage);
  }, [currentPage, numPages, onPageChange]);

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
  }, [document, initialPage, pageRequestKey, scrollToPage]);

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
    card?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [effectiveHighlightId]);

  // ── Text selection → pending annotation ──────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (readOnly) return;

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
      // Selecting any text in the PDF immediately surfaces the marking toolbar —
      // no separate "highlighter mode" to enable first.
      setPendingAnnotation({
        page,
        quote,
        rects,
        anchorX: boundingRect.left + boundingRect.width / 2,
        anchorY: boundingRect.top,
        anchorBottomY: boundingRect.bottom,
      });
    };

    container.addEventListener("mouseup", onMouseUp);
    return () => container.removeEventListener("mouseup", onMouseUp);
  }, [pendingAnnotation, readOnly]);

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

  useEffect(() => {
    if (!editingAnnotationId) return;
    const onDown = (event: MouseEvent) => {
      const editor = globalThis.document?.querySelector(".lit-pdf-annotation-editor");
      const annotationItem = (event.target as Element | null)?.closest?.(".lit-pdf-annotation-item");
      if (editor && !editor.contains(event.target as Node) && !annotationItem) {
        setEditingAnnotationId(null);
        setEditorAnchor(null);
      }
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [editingAnnotationId]);

  // ── Dismiss highlight popover on click outside ───────────────────────────────
  useEffect(() => {
    if (!activeHighlight) return;
    const onDown = (event: MouseEvent) => {
      const popover = globalThis.document?.querySelector(".lit-pdf-highlight-popover");
      if (popover && !popover.contains(event.target as Node)) {
        setActiveHighlight(null);
      }
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [activeHighlight]);

  // ── Escape closes any floating UI and clears the selection ───────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setActiveHighlight(null);
      setPendingAnnotation(null);
      setEditingAnnotationId(null);
      setEditorAnchor(null);
      window.getSelection()?.removeAllRanges();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleConfirmAnnotation = useCallback(
    (color: PdfAnnotationColor, kind: PdfAnnotationKind, note: string, style: PdfAnnotationStyle) => {
      if (!pendingAnnotation) return;
      onAddAnnotation(pendingAnnotation.page, {
        quote: pendingAnnotation.quote,
        rects: pendingAnnotation.rects,
        color,
        kind,
        note,
        style,
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
            <SvgIcon name="chevronLeft" size={15} />
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
            <SvgIcon name="chevronRight" size={15} />
          </button>
        </div>

        <div className="lit-pdf-zoom">
          <button type="button" onClick={() => adjustZoom(-ZOOM_STEP)} aria-label="缩小">
            <SvgIcon name="minus" size={15} />
          </button>
          <span className="lit-pdf-zoom-value">{Math.round(effectiveZoom * 100)}%</span>
          <button type="button" onClick={() => adjustZoom(ZOOM_STEP)} aria-label="放大">
            <SvgIcon name="plus" size={15} />
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
          {!readOnly && (
            <button
              type="button"
              className={annotationsVisible ? "active" : ""}
              onClick={() => setShowAnnotations((v) => !v)}
              title="切换标注侧栏"
            >
              标注{annotations.length > 0 ? ` · ${annotations.length}` : ""}
            </button>
          )}
          <button type="button" onClick={onOpenExternal}>
            系统阅读器
          </button>
        </div>
      </div>

      <div className={`lit-pdf-reader-body${annotationsVisible ? " with-annotations" : ""}`}>
        <div className="lit-pdf-scroll" ref={containerRef}>
          {loading && <div className="lit-pdf-state">正在加载 PDF…</div>}
          {error && <div className="lit-pdf-state error">PDF 加载失败：{error}</div>}
          {!loading && !error && document && (
            <div className="lit-pdf-tip">
              选中文字即可标记 · 点击高亮可编辑或删除
            </div>
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
                        onHighlightActivate={handleHighlightActivate}
                      />
                    )}
                  </div>
                );
              })
            : null}
        </div>

        {pendingAnnotation && (
          <QuickSelectionPopup
            pending={pendingAnnotation}
            onQuickHighlight={(color, style) => handleConfirmAnnotation(color, "note", "", style)}
            onSaveNote={handleConfirmAnnotation}
            onRunAi={onRunAi}
            onCancel={() => {
              setPendingAnnotation(null);
              window.getSelection()?.removeAllRanges();
            }}
          />
        )}

        {activeHighlight && activeHighlightAnnotation && (
          <HighlightPopover
            annotation={activeHighlightAnnotation}
            anchor={activeHighlight.anchor}
            onEdit={() => {
              setEditingAnnotationId(activeHighlight.id);
              setEditorAnchor({ x: activeHighlight.anchor.x + 143, y: activeHighlight.anchor.bottom });
              setActiveHighlight(null);
            }}
            onDelete={() => {
              onDeleteAnnotation(activeHighlight.id);
              setActiveHighlight(null);
            }}
            onClose={() => setActiveHighlight(null)}
          />
        )}

        {annotationsVisible && (
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
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setEditingAnnotationId(annotation.id);
                    setEditorAnchor({ x: rect.left, y: rect.top });
                    scrollToPage(annotation.page);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setEditingAnnotationId(annotation.id);
                    setEditorAnchor({ x: rect.left, y: rect.top });
                    scrollToPage(annotation.page);
                  }}
                >
                  <div className="lit-pdf-annotation-card-header">
                    <span className="lit-pdf-annotation-kind-badge">
                      {KIND_LABELS[annotation.kind]}
                    </span>
                    <span className="lit-pdf-annotation-page-badge">第 {annotation.page} 页</span>
                  </div>
                  <p className="lit-pdf-annotation-summary">{annotation.quote}</p>
                  {annotation.note && (
                    <p className="lit-pdf-annotation-note-preview">{annotation.note}</p>
                  )}
                </article>
              ))
            )}
          </aside>
        )}
        {editingAnnotation && editorAnchor && (
          <AnnotationEditor
            annotation={editingAnnotation}
            anchor={editorAnchor}
            onUpdate={(patch) => onUpdateAnnotation(editingAnnotation.id, patch)}
            onDelete={() => {
              onDeleteAnnotation(editingAnnotation.id);
              setEditingAnnotationId(null);
              setEditorAnchor(null);
            }}
            onClose={() => {
              setEditingAnnotationId(null);
              setEditorAnchor(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
