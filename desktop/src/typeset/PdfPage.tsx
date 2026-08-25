// One rendered PDF page: canvas paint, text layer, link hot zones and the
// SyncTeX highlight overlay. Shared by the read-only preview and the visual
// (click-to-edit) surface, which is why it is its own module.
import { Fragment, memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { renderPdfPageToCanvas } from "../pdf/canvas";
import { useStore } from "../store";
import { TYPESET_EDITOR_COPY } from "./i18n";
import {
  clampNumber,
  pdfLinkRunsFromAnnotations,
  samplePdfTextColors,
  textRunAtOffset,
  textRunContext,
  textRunsFromPdfContent,
  type PdfLinkRun,
  type PdfPointConverter,
  type PdfTextObjectChange,
  type PdfTextObjectGeometry,
  type PdfTextRun,
} from "./pdfGeometry";
import {
  runTextRatio,
  syncTexPointFromPageOffset,
  wordAtRatio,
  type SyncTexViewportLike,
} from "./syncTexMapping";
import { ToolIcon } from "./ToolIcon";
import { DEFAULT_SOURCE_PATH, outputPathFor } from "./typesetPaths";

export interface PdfPageHighlight {
  left: number;
  top: number;
  width: number;
  height: number;
  nonce: number;
}
export interface PdfClickPosition {
  page: number;
  x: number;
  y: number;
  word?: string;
}
export interface PdfPageProps {
  pdf: PDFDocumentProxy;
  page: number;
  zoom: number;
  estimatedSize?: { width: number; height: number };
  onSourceTextClick: (text: string, context: string, position?: PdfClickPosition) => void;
  editable?: boolean;
  onTextObjectEdit?: (change: PdfTextObjectChange, nextText: string) => void;
  onTextObjectMove?: (change: PdfTextObjectChange) => void;
  onPageSize?: (width: number, height: number) => void;
  pageRef?: (el: HTMLDivElement | null) => void;
  onPdfLinkClick?: (destination: unknown) => void;
  /** Publishes a client-coordinate -> SyncTeX-point converter for this page, so
   *  the toolbar can ask "what source is at the top of the view?" without
   *  reaching into the page's rendering state. */
  onPointConverter?: (page: number, convert: PdfPointConverter | null) => void;
  highlight?: PdfPageHighlight | null;
}

/** Client coordinates to a SyncTeX query point, or null before the page renders. */
/** PDF.js keeps internal links (including LaTeX's \\tableofcontents links) as
 * page annotations. Render only those few hot zones rather than a DOM button
 * for every glyph in the PDF text layer. */
/**
 * How much to squeeze a run's stand-in text so it covers the same width as the
 * glyphs the canvas painted.
 *
 * The text layer sits over a canvas rendering of real PDF fonts, but the layer
 * itself is written in the UI font: the same string is a different width, so a
 * selection — which the browser draws around the *stand-in* text — lands beside
 * the glyphs rather than on them. pdf.js solves it by measuring the stand-in
 * and applying `scaleX` until the two agree; this does the same, measuring once
 * per distinct string at a reference size (advance widths scale linearly, and
 * only the ratio matters here).
 */
export const PdfPage = memo(function PdfPage({
  pdf,
  page,
  zoom,
  estimatedSize,
  onSourceTextClick,
  editable = false,
  onTextObjectEdit,
  onTextObjectMove,
  onPageSize,
  pageRef,
  onPdfLinkClick,
  onPointConverter,
  highlight,
}: PdfPageProps) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].pdfPage;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTask = useRef<RenderTask | null>(null);
  const renderedDocumentRef = useRef<{ pdf: PDFDocumentProxy; page: number } | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [textRuns, setTextRuns] = useState<PdfTextRun[]>([]);
  const textRunsRef = useRef<PdfTextRun[]>([]);
  const [linkRuns, setLinkRuns] = useState<PdfLinkRun[]>([]);
  const [objectDrafts, setObjectDrafts] = useState<Record<string, PdfTextObjectGeometry & { text: string }>>({});
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [editingObjectId, setEditingObjectId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dragRef = useRef<{
    id: string;
    startClientX: number;
    startClientY: number;
    geometry: PdfTextObjectGeometry;
    text: string;
    context: string;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  // The rendered viewport and the page's own box are what turn a click into the
  // big-point coordinate SyncTeX queries take. Held in a ref because the click
  // handlers run long after the render that produced them.
  const pageGeometryRef = useRef<{ viewport: SyncTexViewportLike; box: number[] } | null>(null);
  const pageElementRef = useRef<HTMLDivElement | null>(null);
  const pointConverterRef = useRef<PdfPointConverter>((clientX, clientY) => {
    const geometry = pageGeometryRef.current;
    const element = pageElementRef.current;
    if (!geometry || !element) return null;
    const bounds = element.getBoundingClientRect();
    return syncTexPointFromPageOffset(
      geometry.viewport,
      geometry.box,
      clientX - bounds.left,
      clientY - bounds.top,
    );
  });

  useEffect(() => {
    onPointConverter?.(page, pointConverterRef.current);
    return () => onPointConverter?.(page, null);
  }, [onPointConverter, page]);

  useEffect(() => {
    let disposed = false;
    const documentChanged = renderedDocumentRef.current?.pdf !== pdf || renderedDocumentRef.current?.page !== page;
    setError(null);
    if (documentChanged) {
      renderedDocumentRef.current = { pdf, page };
      setTextRuns([]);
      textRunsRef.current = [];
      setLinkRuns([]);
      setPageSize(null);
      setObjectDrafts({});
      setSelectedObjectId(null);
      setEditingObjectId(null);
    }
    renderTask.current?.cancel();
    renderTask.current = null;
    void pdf
      .getPage(page)
      .then((pdfPage: PDFPageProxy) => {
        if (disposed || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const render = renderPdfPageToCanvas(pdfPage, canvas, zoom);
        pageGeometryRef.current = { viewport: render.viewport, box: pdfPage.view };
        setPageSize({ width: render.cssWidth, height: render.cssHeight });
        onPageSize?.(render.cssWidth / zoom, render.cssHeight / zoom);
        renderTask.current = render.task;
        const annotationPage = pdfPage as PDFPageProxy & { getAnnotations?: () => Promise<unknown> };
        const annotationsPromise = annotationPage.getAnnotations?.() ?? Promise.resolve([]);
        return Promise.all([render.task.promise, pdfPage.getTextContent(), annotationsPromise]).then(([, textContent, annotations]) => {
          if (disposed) return;
          const runs = textRunsFromPdfContent(textContent, render.viewport, zoom);
          textRunsRef.current = runs;
          // Colour sampling is a `getImageData` per run — worth it only in
          // slide-edit mode, where the run is drawn as real text. Reading mode
          // still needs the runs themselves: they are the layer that highlights
          // a single word under the pointer and that a selection can grab.
          setTextRuns(editable
            ? runs.map((run) => ({ ...run, ...samplePdfTextColors(canvas, run, render.outputScale) }))
            : runs);
          setLinkRuns(pdfLinkRunsFromAnnotations(annotations, render.viewport));
        });
      })
      .catch((renderError) => {
        if (!disposed && renderError?.name !== "RenderingCancelledException") {
          setError(String(renderError));
        }
      });
    return () => {
      disposed = true;
      renderTask.current?.cancel();
      renderTask.current = null;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [editable, page, pdf, zoom]);

  useEffect(() => {
    if (!editable) return undefined;
    const geometryAt = (event: PointerEvent | MouseEvent, drag: NonNullable<typeof dragRef.current>) => {
      if (!pageSize) return null;
      const deltaX = (event.clientX - drag.startClientX) / zoom;
      const deltaY = (event.clientY - drag.startClientY) / zoom;
      const naturalPageWidth = pageSize.width / zoom;
      const naturalPageHeight = pageSize.height / zoom;
      return {
        ...drag.geometry,
        left: clampNumber(drag.geometry.left + deltaX, 0, Math.max(0, naturalPageWidth - drag.geometry.width)),
        top: clampNumber(drag.geometry.top + deltaY, 0, Math.max(0, naturalPageHeight - drag.geometry.height)),
        text: drag.text,
      };
    };
    const moveObject = (event: PointerEvent | MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const deltaX = (event.clientX - drag.startClientX) / zoom;
      const deltaY = (event.clientY - drag.startClientY) / zoom;
      if (Math.hypot(deltaX, deltaY) > 1.5) drag.moved = true;
      if (!drag.moved) return;
      const nextDraft = geometryAt(event, drag);
      if (nextDraft) setObjectDrafts((items) => ({ ...items, [drag.id]: nextDraft }));
    };
    const finishObjectMove = (event: PointerEvent | MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      suppressClickRef.current = drag.moved;
      if (!drag.moved) return;
      const nextDraft = geometryAt(event, drag);
      if (!nextDraft) return;
      setObjectDrafts((items) => ({ ...items, [drag.id]: nextDraft }));
      onTextObjectMove?.({ ...nextDraft, context: drag.context });
    };
    window.addEventListener("pointermove", moveObject);
    window.addEventListener("pointerup", finishObjectMove);
    window.addEventListener("pointercancel", finishObjectMove);
    window.addEventListener("mousemove", moveObject);
    window.addEventListener("mouseup", finishObjectMove);
    return () => {
      window.removeEventListener("pointermove", moveObject);
      window.removeEventListener("pointerup", finishObjectMove);
      window.removeEventListener("pointercancel", finishObjectMove);
      window.removeEventListener("mousemove", moveObject);
      window.removeEventListener("mouseup", finishObjectMove);
    };
  }, [editable, onTextObjectMove, pageSize, zoom]);

  /**
   * Ask for the source behind a point on the page. Every viewer that gets
   * inverse search right (Skim, SumatraPDF, TeXShop) treats the *whole page* as
   * the query surface, because SyncTeX resolves a coordinate rather than a
   * glyph: white space between words, a display equation, a figure and a table
   * cell all have boxes it can answer for. Gating the query behind per-run hit
   * boxes both loses those and mis-answers near a box edge.
   */
  const requestSourceForPoint = useCallback((
    event: { clientX: number; clientY: number },
    run?: PdfTextRun,
    context = "",
  ) => {
    const geometry = pageGeometryRef.current;
    const element = pageElementRef.current;
    if (!geometry || !element) return;
    const bounds = element.getBoundingClientRect();
    const offsetX = event.clientX - bounds.left;
    const offsetY = event.clientY - bounds.top;
    const point = syncTexPointFromPageOffset(geometry.viewport, geometry.box, offsetX, offsetY);
    const sourceRun = run ?? textRunAtOffset(textRunsRef.current, offsetX, offsetY);
    const sourceContext = context || (sourceRun ? textRunContext(textRunsRef.current, sourceRun) : "");
    const word = sourceRun ? wordAtRatio(sourceRun.text, runTextRatio(sourceRun, offsetX)) : undefined;
    onSourceTextClick(sourceRun?.text ?? "", sourceContext || sourceRun?.text || "", { page, x: point.x, y: point.y, word });
  }, [onSourceTextClick, page]);

  // A click that ends somewhere other than where it started was a drag — the
  // user was scrolling or selecting, not asking to navigate.
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const clickWasStationary = (event: { clientX: number; clientY: number }) => {
    const origin = pointerDownRef.current;
    pointerDownRef.current = null;
    return !origin || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) <= 4;
  };

  return (
    <div
      className="typeset-pdf-page"
      ref={(el) => {
        pageElementRef.current = el;
        pageRef?.(el);
      }}
      style={!pageSize && estimatedSize ? {
        width: `${estimatedSize.width * zoom}px`,
        height: `${estimatedSize.height * zoom}px`,
      } : undefined}
      onMouseDown={editable ? undefined : (event) => {
        pointerDownRef.current = { x: event.clientX, y: event.clientY };
      }}
      // Inverse search is a *double* click, as in Overleaf, SumatraPDF and
      // TeXstudio. A single click is left to the reader: it focuses the pane
      // (so the arrow keys page) and can start a text selection, neither of
      // which is possible if every click jumps and hands focus to the editor.
      onDoubleClick={editable ? undefined : (event) => {
        if (clickWasStationary(event)) requestSourceForPoint(event);
      }}
    >
      <canvas ref={canvasRef} aria-label={copy.pdfPageLabel(page)} />
      {!editable && pageSize && (
        <button
          type="button"
          className="typeset-pdf-page-source-target"
          aria-label={copy.jumpToSourcePageLabel(page)}
          title={copy.jumpToSourceTitle}
          onMouseDown={(event) => {
            pointerDownRef.current = { x: event.clientX, y: event.clientY };
          }}
          onClick={(event) => {
            // `detail === 0` means the click came from the keyboard (Enter or
            // Space on the focused target), which is the one case where there
            // is no double click to wait for.
            if (event.detail !== 0) return;
            event.stopPropagation();
            requestSourceForPoint(event);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (clickWasStationary(event)) requestSourceForPoint(event);
          }}
        />
      )}
      {!editable && onPdfLinkClick && linkRuns.length > 0 && (
        <div className="typeset-pdf-link-layer" aria-label={copy.pdfLinksLabel(page)}>
          {linkRuns.map((link) => (
            <button
              type="button"
              key={link.id}
              className="typeset-pdf-link"
              aria-label={copy.followPdfLink}
              title={copy.followPdfLink}
              style={{ left: `${link.left}px`, top: `${link.top}px`, width: `${link.width}px`, height: `${link.height}px` }}
              onMouseDown={(event) => {
                event.stopPropagation();
                pointerDownRef.current = null;
              }}
              onClick={(event) => {
                event.stopPropagation();
                onPdfLinkClick(link.destination);
              }}
            />
          ))}
        </div>
      )}
      {pageSize && (
        <div
          className="typeset-pdf-text-layer"
          style={{ width: `${pageSize.width}px`, height: `${pageSize.height}px` }}
          aria-label={copy.pdfTextLayerLabel(page)}
        >
          {textRuns.map((run, index) => {
            const context = textRuns.slice(Math.max(0, index - 2), index + 3).map((item) => item.text).join(" ");
            const draft = objectDrafts[run.id];
            const displayed = draft
              ? {
                  text: draft.text,
                  left: draft.left * zoom,
                  top: draft.top * zoom,
                  width: draft.width * zoom,
                  height: draft.height * zoom,
                  fontSize: draft.fontSize * zoom,
                  color: draft.color,
                }
              : run;
            const selected = editable && selectedObjectId === run.id;
            const editing = editable && editingObjectId === run.id;
            const style = {
              left: `${displayed.left}px`,
              top: `${displayed.top}px`,
              width: `${displayed.width}px`,
              height: `${Math.max(displayed.height, displayed.fontSize * 1.15)}px`,
              fontSize: `${displayed.fontSize}px`,
              color: draft || editing ? displayed.color : undefined,
              ...(draft ? { "--typeset-object-background": run.backgroundColor } : {}),
            } as CSSProperties;
            // Reading mode: a plain span, the way pdf.js builds its own text
            // layer. A <button> here would take focus on every click (so the
            // pane's arrow-key paging would never fire) and its text cannot be
            // dragged over, because `user-select: auto` is *used* as `none` on
            // a UI element. Keyboard access to inverse search lives on the
            // page-wide target instead.
            if (!editable) {
              return (
                <Fragment key={run.id}>
                <span
                  className="typeset-pdf-text-run reading"
                  // Sized by its own text, then squeezed onto the glyphs — the
                  // pdf.js text-layer geometry. Forcing the box to the run's
                  // width instead would clip or stretch the selection, which is
                  // drawn around the text, not around the box.
                  style={{
                    left: `${run.left}px`,
                    top: `${run.top}px`,
                    fontSize: `${run.fontSize}px`,
                    transform: run.scaleX === 1 ? undefined : `scaleX(${run.scaleX})`,
                  }}
                  title={copy.jumpToSourceTitle}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    // The word under the pointer rides along so the source
                    // column can be refined past the line start SyncTeX gives.
                    if (clickWasStationary(event)) requestSourceForPoint(event, run, context);
                  }}
                >
                  {run.raw}
                </span>
                {/* pdf.js does the same: a line-ending item is followed by a
                    break so a selection spanning lines copies as lines. It has
                    no visual effect — every run is absolutely positioned. */}
                {run.endsLine && <br />}
                </Fragment>
              );
            }
            const geometry = (): PdfTextObjectGeometry => ({
              left: displayed.left / zoom,
              top: displayed.top / zoom,
              width: displayed.width / zoom,
              height: displayed.height / zoom,
              fontSize: displayed.fontSize / zoom,
              color: displayed.color,
            });
            const commitEdit = () => {
              const nextText = editingText.trim();
              setEditingObjectId(null);
              if (!nextText || nextText === displayed.text) return;
              const nextDraft = { ...geometry(), text: nextText };
              setObjectDrafts((items) => ({ ...items, [run.id]: nextDraft }));
              onTextObjectEdit?.({ ...geometry(), text: displayed.text, context }, nextText);
            };
            if (editing) {
              return (
                <input
                  key={run.id}
                  className="typeset-slide-object-editor"
                  style={style}
                  value={editingText}
                  aria-label={copy.editSlideTextLabel(displayed.text)}
                  autoFocus
                  onChange={(event) => setEditingText(event.currentTarget.value)}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={commitEdit}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitEdit();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingObjectId(null);
                    }
                  }}
                />
              );
            }
            return (
              <Fragment key={run.id}>
                {draft && (
                  <span
                    className="typeset-slide-object-origin-mask"
                    aria-hidden="true"
                    style={{
                      left: `${Math.max(0, run.left - 1.5)}px`,
                      top: `${Math.max(0, run.top - 1.5)}px`,
                      width: `${run.width + 3}px`,
                      height: `${Math.max(run.height, run.fontSize * 1.15) + 3}px`,
                      backgroundColor: run.backgroundColor,
                    }}
                  />
                )}
                <button
                type="button"
                className={`typeset-pdf-text-run direct-object${selected ? " selected" : ""}${draft ? " moved" : ""}`}
                style={style}
                title={copy.dragMoveTitle}
                aria-label={copy.slideTextObjectLabel(displayed.text)}
                aria-pressed={selected}
                onPointerDown={(event) => {
                  if (!editable || event.button !== 0 || dragRef.current) return;
                  event.stopPropagation();
                  setSelectedObjectId(run.id);
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  dragRef.current = {
                    id: run.id,
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    geometry: geometry(),
                    text: displayed.text,
                    context,
                    moved: false,
                  };
                }}
                onMouseDown={(event) => {
                  if (!editable || event.button !== 0 || dragRef.current) return;
                  event.stopPropagation();
                  setSelectedObjectId(run.id);
                  dragRef.current = {
                    id: run.id,
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    geometry: geometry(),
                    text: displayed.text,
                    context,
                    moved: false,
                  };
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  setSelectedObjectId(run.id);
                }}
                onDoubleClick={(event) => {
                  if (!editable) return;
                  event.stopPropagation();
                  setSelectedObjectId(run.id);
                  setEditingText(displayed.text);
                  setEditingObjectId(run.id);
                }}
                onKeyDown={(event) => {
                  if (!editable) return;
                  if (event.key === "Enter" || event.key === "F2") {
                    event.preventDefault();
                    setEditingText(displayed.text);
                    setEditingObjectId(run.id);
                  } else if ((event.key === "Delete" || event.key === "Backspace") && selected) {
                    event.preventDefault();
                    onTextObjectEdit?.({ ...geometry(), text: displayed.text, context }, "");
                  }
                }}
                >
                  {displayed.text}
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
      {highlight && (
        <div
          key={highlight.nonce}
          className="typeset-pdf-forward-highlight"
          style={{
            left: `${highlight.left}px`,
            top: `${highlight.top}px`,
            width: `${highlight.width}px`,
            height: `${highlight.height}px`,
          }}
          aria-hidden="true"
        />
      )}
      {error && <div className="typeset-pdf-page-error">{error}</div>}
    </div>
  );
});
export function PdfFallbackPage({ error, outputPath, sourcePath }: { error: string; outputPath: string | null; sourcePath: string | null }) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].pdfFallback;
  return (
    <div className="typeset-pdf-unavailable" role="status" aria-label={copy.unavailableLabel}>
      <ToolIcon name="logs" />
      <strong>{copy.unavailableLabel}</strong>
      <span>{outputPath || outputPathFor(sourcePath || DEFAULT_SOURCE_PATH)}</span>
      <p>{copy.recompileHint}</p>
      <code>{error}</code>
    </div>
  );
}
