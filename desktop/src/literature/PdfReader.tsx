import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { fileReadBytes, isTauri, literaturePdfBytes } from "../api/tauri";
import { renderPdfPageToCanvas } from "../pdf/canvas";
import { getPdfJs, openPdfDocument } from "../pdf/runtime";
import { useStore, type Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import { LITERATURE_COPY } from "./i18n";
import type {
  PdfAnnotation,
  PdfAnnotationColor,
  PdfAnnotationKind,
  PdfAnnotationRect,
  PdfAnnotationStyle,
} from "./literatureTypes";

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.15;
const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));

const kindLabels = (copy: (typeof LITERATURE_COPY)[Language]): Record<PdfAnnotationKind, string> => ({
  note: copy.pdfReader.kindNote,
  core: copy.pdfReader.kindCore,
  evidence: copy.pdfReader.kindEvidence,
  "answer-support": copy.pdfReader.kindAnswerSupport,
});
const colorSwatches = (
  copy: (typeof LITERATURE_COPY)[Language],
): { key: PdfAnnotationColor; hex: string; label: string }[] => [
  { key: "yellow", hex: "#ffd54f", label: copy.pdfReader.colorYellow },
  { key: "green", hex: "#81c784", label: copy.pdfReader.colorGreen },
  { key: "blue", hex: "#4fc3f7", label: copy.pdfReader.colorBlue },
  { key: "red", hex: "#ef5350", label: copy.pdfReader.colorRed },
  { key: "purple", hex: "#ba68c8", label: copy.pdfReader.colorPurple },
];
const styleOptions = (
  copy: (typeof LITERATURE_COPY)[Language],
): { key: PdfAnnotationStyle; label: string; glyph: string }[] => [
  { key: "highlight", label: copy.pdfReader.styleHighlight, glyph: "A" },
  { key: "underline", label: copy.pdfReader.styleUnderline, glyph: "A" },
  { key: "strikethrough", label: copy.pdfReader.styleStrikethrough, glyph: "A" },
];

/** Selection-driven AI actions. List-shaped so explain/summarize/ask can be
 * appended later without touching the popover wiring. The translate action's
 * output language follows the UI language toggle rather than being hardcoded. */
interface AiAction {
  key: string;
  label: string;
  system: string;
}
const aiActions = (language: Language): AiAction[] => [
  {
    key: "translate",
    label: LITERATURE_COPY[language].pdfReader.translateAction,
    system: LITERATURE_COPY[language].pdfReader.translateSystem,
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
  /** Library-relative path by default; a workspace/absolute path when `sourceKind` is "path". */
  relativePath: string;
  /**
   * Where the bytes come from. "library" keeps the literature paper store as the
   * source; "path" lets any surface (Chat's side panel, review views) reuse the
   * reader for an arbitrary file on disk.
   */
  sourceKind?: "library" | "path";
  initialPage?: number;
  /** Change this value to request another jump even when initialPage is unchanged. */
  pageRequestKey?: string | number;
  annotations: PdfAnnotation[];
  focusedAnnotationId?: string | null;
  onOpenExternal: () => void;
  /** Shows a "reveal in file manager" button in the toolbar; omitted surfaces (e.g. the Literature reader) don't get one. */
  onReveal?: () => void;
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
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
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
        const canvas = canvasRef.current;
        const render = renderPdfPageToCanvas(pdfPage, canvas, zoom);
        taskRef.current = render.task;
        await render.task.promise;
        if (disposed) return;

        // Text layer for selection — rendered transparently over the canvas.
        // pdf.js v5 replaced the `renderTextLayer` function with a `TextLayer`
        // class; spans are positioned in %, scaled by --total-scale-factor.
        const textLayerDiv = textLayerRef.current;
        if (textLayerDiv) {
          textLayerDiv.innerHTML = "";
          textLayerDiv.style.setProperty("--total-scale-factor", String(zoom));
          const pdfjs = await getPdfJs();
          if (!disposed && "TextLayer" in pdfjs && typeof pdfjs.TextLayer === "function") {
            const textContent = await pdfPage.getTextContent();
            if (!disposed) {
              try {
                const textLayer = new pdfjs.TextLayer({
                  textContentSource: textContent,
                  container: textLayerDiv,
                  viewport: render.viewport,
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
      <canvas ref={canvasRef} aria-label={copy.pdfReader.pageAria(page)} />
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
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const kindLabelsForLanguage = kindLabels(copy);
  const colorSwatchesForLanguage = colorSwatches(copy);
  const styleOptionsForLanguage = styleOptions(copy);
  const aiActionsForLanguage = aiActions(language);
  const [color, setColor] = useState<PdfAnnotationColor>("yellow");
  const [kind, setKind] = useState<PdfAnnotationKind>("note");
  const [note, setNote] = useState("");
  const [style, setStyle] = useState<PdfAnnotationStyle>("highlight");
  const [showDetails, setShowDetails] = useState(false);
  const [ai, setAi] = useState<AiState | null>(null);
  const styleVerb =
    style === "underline" ? copy.pdfReader.styleUnderline
      : style === "strikethrough" ? copy.pdfReader.styleStrikethrough
        : copy.pdfReader.styleHighlight;

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
      aria-label={copy.pdfReader.selectionToolbarAria}
    >
      {aiActive ? (
        <div className="lit-pdf-ai-panel">
          <div className="lit-pdf-ai-head">
            <button type="button" className="lit-pdf-ai-back" aria-label={copy.pdfReader.back} onClick={() => setAi(null)}>
              <SvgIcon name="chevronLeft" size={14} /> {copy.pdfReader.back}
            </button>
            <span className="lit-pdf-ai-title">{ai.action.label}</span>
            <button type="button" className="lit-pdf-popup-close" aria-label={copy.pdfReader.close} onClick={onCancel}>
              <SvgIcon name="close" size={14} />
            </button>
          </div>
          <div className="lit-pdf-ai-body">
            {ai.status === "loading" && (
              <div className="lit-pdf-ai-loading">
                <span className="lit-search-spinner" aria-hidden="true" />
                {copy.pdfReader.aiLoading(ai.action.label)}
              </div>
            )}
            {ai.status === "error" && <div className="lit-pdf-ai-error">{copy.pdfReader.aiError(ai.text)}</div>}
            {ai.status === "done" && <div className="lit-pdf-ai-result">{ai.text}</div>}
          </div>
          <div className="lit-pdf-ai-actions">
            {ai.status === "error" && (
              <button type="button" onClick={() => runAi(ai.action)}>
                {copy.pdfReader.retry}
              </button>
            )}
            {ai.status === "done" && (
              <>
                <button type="button" onClick={() => void navigator.clipboard?.writeText(ai.text)}>
                  {copy.pdfReader.copy}
                </button>
                <button
                  type="button"
                  className="lit-pdf-select-popup-save"
                  onClick={() => onSaveNote("blue", "note", copy.pdfReader.aiResultNote(ai.action.label, ai.text), "highlight")}
                >
                  {copy.pdfReader.saveToAnnotation}
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="lit-pdf-select-popup-row">
            <div className="lit-pdf-style-seg" role="group" aria-label={copy.pdfReader.markStyleAria}>
              {styleOptionsForLanguage.map(({ key, label, glyph }) => (
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
              {colorSwatchesForLanguage.map(({ key, hex, label }) => (
                <button
                  key={key}
                  type="button"
                  className={`lit-pdf-color-swatch${color === key ? " active" : ""}`}
                  style={{ background: hex }}
                  aria-label={copy.pdfReader.setColorAria(label, styleVerb)}
                  aria-pressed={color === key}
                  title={copy.pdfReader.setColorAria(label, styleVerb)}
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
              {copy.pdfReader.addNoteToggle}
            </button>
            <button type="button" className="lit-pdf-popup-close" aria-label={copy.pdfReader.cancelSelectionAria} onClick={onCancel}>
              <SvgIcon name="close" size={14} />
            </button>
          </div>
          <div className="lit-pdf-select-popup-ai-row">
            {aiActionsForLanguage.map((action) => (
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
                {pending.quote.length > 140 ? copy.pdfReader.quotePreviewTruncated(pending.quote.slice(0, 140)) : pending.quote}
              </div>
              <select
                className="lit-pdf-select-popup-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as PdfAnnotationKind)}
                aria-label={copy.pdfReader.annotationKindAria}
              >
                {(Object.keys(kindLabelsForLanguage) as PdfAnnotationKind[]).map((value) => (
                  <option key={value} value={value}>
                    {kindLabelsForLanguage[value]}
                  </option>
                ))}
              </select>
              <textarea
                className="lit-pdf-select-popup-note"
                placeholder={copy.pdfReader.notePlaceholder}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                aria-label={copy.pdfReader.noteAria}
                autoFocus
              />
              <button
                type="button"
                className="lit-pdf-select-popup-save"
                onClick={() => onSaveNote(color, kind, note, style)}
              >
                {copy.pdfReader.saveNote}
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
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
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
      aria-label={copy.pdfReader.highlightActionsAria}
    >
      <div className="lit-pdf-highlight-popover-head">
        <span className="lit-pdf-annotation-kind-badge">{kindLabels(copy)[annotation.kind]}</span>
        <span className="lit-pdf-highlight-popover-page">{copy.pdfReader.pageLabel(annotation.page)}</span>
        <button type="button" className="lit-pdf-popup-close" aria-label={copy.pdfReader.close} onClick={onClose}>
          <SvgIcon name="close" size={14} />
        </button>
      </div>
      <blockquote className="lit-pdf-highlight-popover-quote">
        {annotation.quote.length > 120 ? copy.pdfReader.quotePreviewTruncated(annotation.quote.slice(0, 120)) : annotation.quote}
      </blockquote>
      <p className={`lit-pdf-highlight-popover-note${annotation.note ? "" : " empty"}`}>
        {annotation.note || copy.pdfReader.noNote}
      </p>
      <div className="lit-pdf-highlight-popover-actions">
        <button type="button" className="danger" onClick={onDelete}>
          {copy.pdfReader.delete}
        </button>
        <button type="button" onClick={onEdit}>
          {copy.pdfReader.edit}
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
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const width = 286;
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, anchor.x - width));
  const top = Math.max(8, Math.min(window.innerHeight - 340, anchor.y));

  return (
    <div
      className="lit-pdf-annotation-editor"
      style={{ position: "fixed", left, top, zIndex: 1000 }}
      role="dialog"
      aria-label={copy.pdfReader.editAnnotationAria}
    >
      <div className="lit-pdf-annotation-editor-head">
        <span>{copy.pdfReader.pageLabel(annotation.page)}</span>
        <button type="button" className="lit-pdf-popup-close" aria-label={copy.pdfReader.closeAnnotationEditorAria} onClick={onClose}>
          <SvgIcon name="close" size={14} />
        </button>
      </div>
      <blockquote>{annotation.quote}</blockquote>
      <div className="lit-pdf-annotation-editor-colors" aria-label={copy.pdfReader.annotationColorAria}>
        {colorSwatches(copy).map(({ key, hex, label }) => (
          <button
            key={key}
            type="button"
            className={`lit-pdf-color-swatch${(annotation.color ?? "yellow") === key ? " active" : ""}`}
            style={{ background: hex }}
            aria-label={copy.pdfReader.setColorPlain(label)}
            aria-pressed={(annotation.color ?? "yellow") === key}
            onClick={() => onUpdate({ color: key })}
          />
        ))}
      </div>
      <div className="lit-pdf-style-seg" role="group" aria-label={copy.pdfReader.markStyleAria}>
        {styleOptions(copy).map(({ key, label, glyph }) => (
          <button
            key={key}
            type="button"
            className={`lit-pdf-style-btn style-${key}${(annotation.style ?? "highlight") === key ? " active" : ""}`}
            aria-label={copy.pdfReader.setColorPlain(label)}
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
        aria-label={copy.pdfReader.annotationKindAria}
        onChange={(event) => onUpdate({ kind: event.target.value as PdfAnnotationKind })}
      >
        {(Object.keys(kindLabels(copy)) as PdfAnnotationKind[]).map((value) => (
          <option key={value} value={value}>
            {kindLabels(copy)[value]}
          </option>
        ))}
      </select>
      <textarea
        defaultValue={annotation.note}
        aria-label={copy.pdfReader.noteAria}
        placeholder={copy.pdfReader.addNotePlaceholder}
        rows={4}
        onBlur={(event) => onUpdate({ note: event.target.value })}
      />
      <div className="lit-pdf-annotation-editor-actions">
        <button type="button" className="danger" onClick={onDelete}>
          {copy.pdfReader.delete}
        </button>
        <button type="button" onClick={onClose}>
          {copy.pdfReader.done}
        </button>
      </div>
    </div>
  );
}

export default function PdfReader({
  relativePath,
  sourceKind = "library",
  initialPage = 1,
  pageRequestKey,
  annotations,
  focusedAnnotationId,
  onOpenExternal,
  onReveal,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onRunAi,
  readOnly = false,
  onPageChange,
  onDocumentLoaded,
}: PdfReaderProps) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
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
      setError(copy.pdfReader.desktopOnlyError);
      setLoading(false);
      return () => { disposed = true; };
    }
    if (typeof DOMMatrix === "undefined") {
      setError(copy.pdfReader.canvasUnsupportedError);
      setLoading(false);
      return () => { disposed = true; };
    }
    const bytesPromise = sourceKind === "path"
      ? fileReadBytes(relativePath)
      : literaturePdfBytes(relativePath);
    void bytesPromise
      .then((bytes) => openPdfDocument(bytes))
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
  }, [relativePath, sourceKind]);

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
            aria-label={copy.pdfReader.prevPageAria}
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
              aria-label={copy.pdfReader.pageNumberAria}
            />
            <span>/ {numPages || "-"}</span>
          </label>
          <button
            type="button"
            onClick={() => jumpToPage(currentPage + 1)}
            disabled={!document || currentPage >= numPages}
            aria-label={copy.pdfReader.nextPageAria}
          >
            <SvgIcon name="chevronRight" size={15} />
          </button>
        </div>

        <div className="lit-pdf-zoom">
          <button type="button" onClick={() => adjustZoom(-ZOOM_STEP)} aria-label={copy.pdfReader.zoomOutAria}>
            <SvgIcon name="minus" size={15} />
          </button>
          <span className="lit-pdf-zoom-value">{Math.round(effectiveZoom * 100)}%</span>
          <button type="button" onClick={() => adjustZoom(ZOOM_STEP)} aria-label={copy.pdfReader.zoomInAria}>
            <SvgIcon name="plus" size={15} />
          </button>
          <button
            type="button"
            className={fitWidth ? "active" : ""}
            onClick={() => setFitWidth(true)}
          >
            {copy.pdfReader.fitWidth}
          </button>
        </div>

        <div className="lit-pdf-toolbar-right">
          {!readOnly && (
            <button
              type="button"
              className={annotationsVisible ? "active" : ""}
              onClick={() => setShowAnnotations((v) => !v)}
              title={copy.pdfReader.toggleAnnotationsSidebarTitle}
            >
              {copy.pdfReader.annotationsLabel(annotations.length)}
            </button>
          )}
          {onReveal && (
            <button type="button" aria-label={copy.pdfReader.revealAria} title={copy.pdfReader.revealAria} onClick={onReveal}>
              <SvgIcon name="folder" size={14} />
            </button>
          )}
          <button type="button" onClick={onOpenExternal}>
            {copy.pdfReader.systemReader}
          </button>
        </div>
      </div>

      <div className={`lit-pdf-reader-body${annotationsVisible ? " with-annotations" : ""}`}>
        <div className="lit-pdf-scroll" ref={containerRef}>
          {loading && <div className="lit-pdf-state">{copy.pdfReader.loadingPdf}</div>}
          {error && <div className="lit-pdf-state error">{copy.pdfReader.pdfLoadFailed(error)}</div>}
          {!loading && !error && document && !readOnly && (
            <div className="lit-pdf-tip">
              {copy.pdfReader.readerTip}
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
            aria-label={copy.pdfReader.annotationsListAria}
          >
            <div className="lit-pdf-annotations-head">
              {copy.pdfReader.annotationsHead(annotations.length)}
            </div>
            {annotations.length === 0 ? (
              <p className="lit-pdf-annotations-empty">{copy.pdfReader.annotationsEmpty}</p>
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
                      {kindLabels(copy)[annotation.kind]}
                    </span>
                    <span className="lit-pdf-annotation-page-badge">{copy.pdfReader.pageLabel(annotation.page)}</span>
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
