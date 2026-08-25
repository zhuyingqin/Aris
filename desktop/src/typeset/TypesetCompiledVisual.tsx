// The click-to-edit PDF surface: the same rendered pages as the preview, but
// text objects can be retyped and dragged, writing back into the LaTeX source.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { fileReadBytes } from "../api/tauri";
import { openPdfDocument } from "../pdf/runtime";
import { useStore } from "../store";
import { TYPESET_EDITOR_COPY } from "./i18n";
import type { BeamerSlide } from "./outlineModel";
import { clampNumber, type PdfTextObjectChange } from "./pdfGeometry";
import { findLatexOffsetForPdfText } from "./pdfTextMatch";
import { PdfFallbackPage, PdfPage } from "./PdfPage";
import { ToolIcon } from "./ToolIcon";
import {
  editPdfTextInLatex,
  ensureTikzPackage,
  insertVisualTextInFrame,
  lineOffsetFor,
  positionPdfTextInFrame,
} from "./visualTextEdits";

export interface CompiledVisualProps {
  path: string | null;
  refreshKey: number;
  page: number;
  slide: BeamerSlide | null;
  slides: BeamerSlide[];
  source: string;
  dirty: boolean;
  compiling: boolean;
  onChangeSource: (source: string) => void;
  onSave: () => void;
  onNavigateToLine: (line: number) => void;
  onOpenCodeAtLine: (line: number) => void;
  onOpenCodeRange: (start: number, end: number) => void;
  onSourceTextClick: (text: string, context: string) => void;
  focused: boolean;
  onToggleFocus: () => void;
}
export default function TypesetCompiledVisual({
  path,
  refreshKey,
  page,
  slide,
  slides,
  source,
  dirty,
  compiling,
  onChangeSource,
  onSave,
  onNavigateToLine,
  onOpenCodeAtLine,
  onOpenCodeRange,
  onSourceTextClick,
  focused,
  onToggleFocus,
}: CompiledVisualProps) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].compiledVisual;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [deckOpen, setDeckOpen] = useState(true);
  const [pageNaturalSize, setPageNaturalSize] = useState({ width: 364, height: 273 });
  const [sourceOpen, setSourceOpen] = useState(false);
  const [selectedSourceRange, setSelectedSourceRange] = useState<{ start: number; end: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sourceEditorRef = useRef<HTMLTextAreaElement | null>(null);

  const frameRange = useMemo(() => {
    if (!slide) return { start: 0, end: source.length };
    const start = lineOffsetFor(source, slide.line);
    const end = Math.max(start, Math.min(source.length, lineOffsetFor(source, slide.endLine + 1)));
    return { start, end };
  }, [slide, source]);
  const frameSource = source.slice(frameRange.start, frameRange.end);
  const frameLineCount = Math.max(1, frameSource.replace(/\n$/, "").split("\n").length);

  useEffect(() => {
    let disposed = false;
    let loadedPdf: PDFDocumentProxy | null = null;
    setPdf(null);
    setError(null);
    if (!path) return () => undefined;
    setLoading(true);
    void fileReadBytes(path)
      .then((bytes) => openPdfDocument(bytes))
      .then((document) => {
        loadedPdf = document;
        if (disposed) {
          void document.destroy();
          return;
        }
        setPdf(document);
      })
      .catch((loadError) => {
        if (!disposed) setError(String(loadError));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      if (loadedPdf) void loadedPdf.destroy();
    };
  }, [path, refreshKey]);

  const fitSlide = useCallback(async () => {
    if (!pdf) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    try {
      const pdfPage = await pdf.getPage(clampNumber(page, 1, pdf.numPages));
      const viewport = pdfPage.getViewport({ scale: 1 });
      const availableWidth = Math.max(280, scroll.clientWidth - 72);
      const availableHeight = Math.max(200, scroll.clientHeight - 72);
      setZoom(clampNumber(Math.min(availableWidth / viewport.width, availableHeight / viewport.height), 0.35, 2.4));
    } catch {
      setZoom(1);
    }
  }, [page, pdf]);

  useEffect(() => {
    if (!pdf || !fitMode) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    const refit = () => {
      if (!disposed) void fitSlide();
    };
    refit();
    if (typeof ResizeObserver !== "undefined" && scrollRef.current) {
      resizeObserver = new ResizeObserver(refit);
      resizeObserver.observe(scrollRef.current);
    }
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
    };
  }, [fitMode, fitSlide, pdf]);

  useEffect(() => {
    if (!sourceOpen || !selectedSourceRange) return;
    const frame = window.requestAnimationFrame(() => {
      const editor = sourceEditorRef.current;
      if (!editor) return;
      const start = clampNumber(selectedSourceRange.start - frameRange.start, 0, editor.value.length);
      const end = clampNumber(selectedSourceRange.end - frameRange.start, start, editor.value.length);
      editor.focus();
      editor.setSelectionRange(start, end);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [frameRange.start, selectedSourceRange, sourceOpen]);

  const safePage = pdf ? clampNumber(page, 1, pdf.numPages) : 1;
  const activeSlideIndex = slide ? slides.indexOf(slide) : Math.max(0, safePage - 1);

  const navigateSlide = (direction: -1 | 1) => {
    const nextIndex = clampNumber(activeSlideIndex + direction, 0, Math.max(0, slides.length - 1));
    const nextSlide = slides[nextIndex];
    if (nextSlide && nextIndex !== activeSlideIndex) onNavigateToLine(nextSlide.line);
  };

  const openSourceForText = (text: string, context: string) => {
    const localMatch = findLatexOffsetForPdfText(frameSource, text, context);
    const match = localMatch
      ? { start: localMatch.start + frameRange.start, end: localMatch.end + frameRange.start }
      : findLatexOffsetForPdfText(source, text, context);
    if (match) setSelectedSourceRange(match);
    setSourceOpen(true);
    onSourceTextClick(text, context);
  };

  const changeFrameSource = (nextFrameSource: string) => {
    setSelectedSourceRange(null);
    onChangeSource(`${source.slice(0, frameRange.start)}${nextFrameSource}${source.slice(frameRange.end)}`);
  };

  const editTextObject = (change: PdfTextObjectChange, nextText: string) => {
    // Scope to the current frame first (mirrors moveTextObject/openSourceForText)
    // so editing or deleting a slide's text object can't match and mutate the
    // same wording on a different slide earlier in the document.
    const nextFrameSource = editPdfTextInLatex(frameSource, change.text, change.context, nextText);
    if (nextFrameSource != null) {
      onChangeSource(`${source.slice(0, frameRange.start)}${nextFrameSource}${source.slice(frameRange.end)}`);
      return;
    }
    const nextSource = editPdfTextInLatex(source, change.text, change.context, nextText);
    if (nextSource == null) {
      openSourceForText(change.text, change.context);
      return;
    }
    onChangeSource(nextSource);
  };

  const moveTextObject = (change: PdfTextObjectChange) => {
    const nextFrameSource = positionPdfTextInFrame(frameSource, change.text, change.context, change);
    if (nextFrameSource == null) {
      openSourceForText(change.text, change.context);
      return;
    }
    const positioned = `${source.slice(0, frameRange.start)}${nextFrameSource}${source.slice(frameRange.end)}`;
    onChangeSource(ensureTikzPackage(positioned));
  };

  const addTextObject = () => {
    const nextFrameSource = insertVisualTextInFrame(frameSource, "New text", {
      left: pageNaturalSize.width * 0.4,
      top: pageNaturalSize.height * 0.46,
      width: 96,
      height: 20,
      fontSize: 18,
      color: "#1f2937",
    });
    if (nextFrameSource == null) return;
    const nextSource = `${source.slice(0, frameRange.start)}${nextFrameSource}${source.slice(frameRange.end)}`;
    onChangeSource(ensureTikzPackage(nextSource));
  };

  const changeZoom = (delta: number) => {
    setFitMode(false);
    setZoom((value) => clampNumber(value + delta, 0.35, 2.4));
  };

  return (
    <section className="typeset-compiled-visual typeset-visual-pane" aria-label={copy.editorLabel}>
      <div className="typeset-slide-canvas-toolbar">
        <div className="typeset-slide-canvas-identity">
          <span>{copy.slideOf(safePage, pdf ? pdf.numPages : null)}</span>
          <strong>{slide?.title || copy.compiledSlideFallback}</strong>
          <span className="typeset-slide-direct-mode">{copy.directEdit}</span>
          <em className={dirty ? "stale" : "current"} role="status">
            {dirty ? copy.draftStatus : copy.compiledPreview}
          </em>
        </div>
        <div className="typeset-slide-canvas-actions" aria-label={copy.canvasControlsLabel}>
          <button
            type="button"
            className="zoom-step"
            title={copy.zoomOut}
            aria-label={copy.zoomOutSlide}
            onClick={() => changeZoom(-0.1)}
          >
            <ToolIcon name="minus" />
          </button>
          <button
            type="button"
            className={fitMode ? "active fit" : "fit"}
            title={copy.fitToCanvas}
            aria-label={copy.fitToCanvas}
            aria-pressed={fitMode}
            onClick={() => {
              setFitMode(true);
              void fitSlide();
            }}
          >
            {copy.fit} <span>{Math.round(zoom * 100)}%</span>
          </button>
          <button
            type="button"
            className="zoom-step"
            title={copy.zoomIn}
            aria-label={copy.zoomInSlide}
            onClick={() => changeZoom(0.1)}
          >
            <ToolIcon name="plus" />
          </button>
          <span className="typeset-slide-canvas-divider" />
          <button
            type="button"
            className="add-text"
            title={copy.addTextObjectTitle}
            aria-label={copy.addTextObjectLabel}
            disabled={compiling}
            onClick={addTextObject}
          >
            <ToolIcon name="plus" />
            {copy.addText}
          </button>
          {focused && (
            <button
              type="button"
              className={deckOpen ? "active deck" : "deck"}
              title={deckOpen ? copy.hideSlideList : copy.showSlideList}
              aria-label={deckOpen ? copy.hideSlideList : copy.showSlideList}
              aria-pressed={deckOpen}
              onClick={() => setDeckOpen((open) => !open)}
            >
              <ToolIcon name="list" />
              {copy.slides}
            </button>
          )}
          <button
            type="button"
            className={focused ? "active focus" : "focus"}
            title={focused ? copy.restorePanelsTitle : copy.focusSlideTitle}
            aria-label={focused ? copy.exitSlideFocus : copy.focusSlideCanvas}
            aria-pressed={focused}
            onClick={onToggleFocus}
          >
            <ToolIcon name="visual" />
            {focused ? copy.exitFocus : copy.focus}
          </button>
          <button
            type="button"
            className={sourceOpen ? "active source" : "source"}
            aria-label={sourceOpen ? copy.closeSlideSource : copy.editSlideSourceLabel}
            aria-pressed={sourceOpen}
            onClick={() => setSourceOpen((open) => !open)}
          >
            <ToolIcon name="code" />
            {sourceOpen ? copy.closeSource : copy.editSource}
          </button>
        </div>
      </div>
      <div className={`typeset-slide-workspace${focused && deckOpen ? " deck-open" : ""}${sourceOpen ? " source-open" : ""}`}>
        {focused && deckOpen && (
          <nav className="typeset-slide-deck" aria-label={copy.slideDeckLabel}>
            <header>
              <div>
                <span>{copy.presentation}</span>
                <strong>{copy.slidesCount(slides.length)}</strong>
              </div>
              <span className={dirty ? "stale" : "current"}>{dirty ? copy.draft : copy.synced}</span>
            </header>
            <div className="typeset-slide-deck-list">
              {slides.map((item, index) => {
                const active = index === activeSlideIndex;
                return (
                  <button
                    type="button"
                    key={`${item.line}:${item.title}`}
                    className={active ? "active" : ""}
                    aria-current={active ? "page" : undefined}
                    aria-label={copy.openSlideLabel(index + 1, item.title)}
                    onClick={() => onNavigateToLine(item.line)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{item.title || copy.slideFallback(index + 1)}</strong>
                    {active && <i aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </nav>
        )}
        <div className="typeset-compiled-visual-scroll" ref={scrollRef}>
          {!path && <div className="typeset-empty">{copy.compileToOpenCanvas}</div>}
          {path && loading && <div className="typeset-empty">{copy.loadingCompiledSlide}</div>}
          {path && error && <PdfFallbackPage error={error} outputPath={path} sourcePath={null} />}
          {pdf && !error && (
            <div
              className="typeset-slide-stage"
              role="group"
              tabIndex={0}
              aria-label={copy.slideStageLabel(safePage)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  navigateSlide(-1);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  navigateSlide(1);
                }
              }}
            >
              <PdfPage
                key={`${path}:${refreshKey}:${safePage}`}
                pdf={pdf}
                page={safePage}
                zoom={zoom}
                onSourceTextClick={openSourceForText}
                editable
                onTextObjectEdit={editTextObject}
                onTextObjectMove={moveTextObject}
                onPageSize={(width, height) => setPageNaturalSize({ width, height })}
              />
              <span className="typeset-slide-click-hint">{copy.slideClickHint}</span>
            </div>
          )}
        </div>
        {sourceOpen && (
          <aside className="typeset-slide-source-drawer" aria-label={copy.currentSlideSourceLabel}>
            <header>
              <div>
                <span>{copy.currentFrame}</span>
                <strong>{slide?.title || copy.slideFallback(safePage)}</strong>
              </div>
              <button
                type="button"
                title={copy.openFullEditorTitle}
                onClick={() => selectedSourceRange
                  ? onOpenCodeRange(selectedSourceRange.start, selectedSourceRange.end)
                  : onOpenCodeAtLine(slide?.line ?? 1)}
              >
                {copy.fullEditor}
              </button>
            </header>
            <textarea
              ref={sourceEditorRef}
              value={frameSource}
              aria-label={copy.slideSourceAriaLabel}
                aria-keyshortcuts="Control+S Meta+S Escape"
              spellCheck={false}
              onChange={(event) => changeFrameSource(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSourceOpen(false);
                  return;
                }
              }}
            />
            <footer>
              <span>
                {copy.linesInfo(slide?.line ?? 1, slide?.endLine ?? 1, frameLineCount, frameSource.length)}
                <kbd>Ctrl S</kbd>
              </span>
              <button type="button" disabled={!dirty || compiling} onClick={onSave}>
                <ToolIcon name="save" />
                {compiling ? copy.compiling : dirty ? copy.saveUpdatePreview : copy.previewCurrent}
              </button>
            </footer>
          </aside>
        )}
      </div>
    </section>
  );
}
