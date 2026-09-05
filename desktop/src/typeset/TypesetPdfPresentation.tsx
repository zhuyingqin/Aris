// Fullscreen PDF presentation mode overlay, rendered into document.body via portal.
// Escapes container queries, ancestor clipping, and pane boundaries to provide a
// clean presentation canvas for Beamer slides and documents.
// Supports single page, two-page side-by-side, and multi-page grid overview layouts.
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent, type TouchEvent as ReactTouchEvent } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { isWindowFullscreen, setWindowFullscreen } from "../windowControls";
import { type Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import { clampNumber } from "./pdfGeometry";
import { PdfPage } from "./PdfPage";
import { ToolIcon } from "./ToolIcon";
import { TYPESET_EDITOR_COPY } from "./i18n";

export type PresentationLayout = "single" | "dual" | "grid";

export interface TypesetPdfPresentationProps {
  pdf: PDFDocumentProxy;
  numPages: number;
  currentPage: number;
  pageSizes: Record<number, { width: number; height: number }>;
  inverted: boolean;
  language: Language;
  onToggleInverted: () => void;
  onPageChange: (page: number) => void;
  onClose: () => void;
}

function LayoutSingleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="2" width="8" height="12" rx="1.5" />
    </svg>
  );
}

function LayoutDualIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2" width="6" height="12" rx="1" />
      <rect x="8.5" y="2" width="6" height="12" rx="1" />
    </svg>
  );
}

function LayoutGridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

async function resolvePdfDestinationPage(pdf: PDFDocumentProxy, destination: unknown): Promise<number | null> {
  let explicit = destination;
  if (typeof explicit === "string") {
    explicit = await pdf.getDestination(explicit);
  }
  if (!Array.isArray(explicit) || !explicit[0]) return null;
  const pageReference = explicit[0] as Parameters<PDFDocumentProxy["getPageIndex"]>[0];
  return (await pdf.getPageIndex(pageReference)) + 1;
}

export default function TypesetPdfPresentation({
  pdf,
  numPages,
  currentPage,
  pageSizes,
  inverted,
  language,
  onToggleInverted,
  onPageChange,
  onClose,
}: TypesetPdfPresentationProps) {
  const copy = TYPESET_EDITOR_COPY[language].pdfPreview;
  const [page, setPage] = useState(() => clampNumber(currentPage, 1, Math.max(1, numPages)));
  const pageRef = useRef(page);
  pageRef.current = page;

  const [layout, setLayout] = useState<PresentationLayout>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = window.localStorage.getItem("typeset_presentation_layout");
        if (saved === "single" || saved === "dual" || saved === "grid") {
          return saved;
        }
      } catch {
        // ignore
      }
    }
    return "single";
  });
  const lastMainLayoutRef = useRef<"single" | "dual">("single");

  const [localSizes, setLocalSizes] = useState<Record<number, { width: number; height: number }>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const [hintVisible, setHintVisible] = useState(true);
  const hudTimerRef = useRef<number | null>(null);
  const wheelSettlingRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== "undefined" ? window.innerWidth : 1920,
    height: typeof window !== "undefined" ? window.innerHeight : 1080,
  }));

  const changeLayout = useCallback((next: PresentationLayout) => {
    if (next !== "grid") {
      lastMainLayoutRef.current = next;
    }
    setLayout(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem("typeset_presentation_layout", next);
      } catch {
        // ignore
      }
    }
  }, []);

  const updatePageSize = useCallback((p: number, w: number, h: number) => {
    setLocalSizes((prev) => {
      const cur = prev[p];
      if (cur && Math.abs(cur.width - w) < 0.5 && Math.abs(cur.height - h) < 0.5) return prev;
      return { ...prev, [p]: { width: w, height: h } };
    });
  }, []);

  // Keep page in sync if parent changes currentPage externally
  useEffect(() => {
    if (currentPage !== pageRef.current) {
      const next = clampNumber(currentPage, 1, Math.max(1, numPages));
      pageRef.current = next;
      setPage(next);
    }
  }, [currentPage, numPages]);

  // Track fullscreen state and window resizing
  useEffect(() => {
    void isWindowFullscreen().then(setIsFullscreen);

    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    const onFsChange = () => {
      void isWindowFullscreen().then(setIsFullscreen);
    };

    window.addEventListener("resize", onResize);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("fullscreenchange", onFsChange);
    };
  }, []);

  // Show navigation hint briefly on entrance
  useEffect(() => {
    const timer = window.setTimeout(() => setHintVisible(false), 3200);
    return () => window.clearTimeout(timer);
  }, []);

  const goToPage = useCallback((targetPage: number) => {
    const next = clampNumber(targetPage, 1, Math.max(1, numPages));
    pageRef.current = next;
    setPage(next);
    onPageChange(next);
  }, [numPages, onPageChange]);

  const step = useCallback((direction: number) => {
    goToPage(pageRef.current + direction);
  }, [goToPage]);

  // Dual mode: pages paired as (1, 2), (3, 4), etc.
  const leftPage = page % 2 === 1 ? page : Math.max(1, page - 1);
  const rightPage = leftPage + 1 <= numPages ? leftPage + 1 : null;

  const stepDual = useCallback((direction: number) => {
    const curLeft = pageRef.current % 2 === 1 ? pageRef.current : Math.max(1, pageRef.current - 1);
    const target = curLeft + direction * 2;
    goToPage(target);
  }, [goToPage]);

  const toggleFs = useCallback(async () => {
    const current = await isWindowFullscreen();
    const next = !current;
    await setWindowFullscreen(next);
    setIsFullscreen(next);
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case "Escape":
        case "q":
        case "Q":
          event.preventDefault();
          onClose();
          return;
        case "1":
          event.preventDefault();
          changeLayout("single");
          return;
        case "2":
          event.preventDefault();
          changeLayout("dual");
          return;
        case "3":
        case "g":
        case "G":
          event.preventDefault();
          setLayout((current) => {
            const next = current === "grid" ? lastMainLayoutRef.current : "grid";
            if (next !== "grid") lastMainLayoutRef.current = next;
            return next;
          });
          return;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
        case "Backspace":
        case "h":
        case "k":
          event.preventDefault();
          if (layout === "dual") {
            stepDual(-1);
          } else {
            step(-1);
          }
          return;
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case "l":
        case "j":
          event.preventDefault();
          if (layout === "dual") {
            stepDual(1);
          } else {
            step(1);
          }
          return;
        case " ":
          event.preventDefault();
          if (layout === "dual") {
            stepDual(event.shiftKey ? -1 : 1);
          } else {
            step(event.shiftKey ? -1 : 1);
          }
          return;
        case "Home":
          event.preventDefault();
          goToPage(1);
          return;
        case "End":
          event.preventDefault();
          goToPage(numPages);
          return;
        case "f":
        case "F":
          event.preventDefault();
          void toggleFs();
          return;
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changeLayout, goToPage, layout, numPages, onClose, step, stepDual, toggleFs]);

  const handlePointerActivity = () => {
    setHudVisible(true);
    if (hudTimerRef.current !== null) {
      window.clearTimeout(hudTimerRef.current);
    }
    hudTimerRef.current = window.setTimeout(() => {
      setHudVisible(false);
    }, 2600);
  };

  const handleOverlayClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (layout === "grid") return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(".typeset-presentation-hud, .typeset-pdf-link, .typeset-presentation-grid-item")) {
      return;
    }
    if (target?.closest("button:not(.typeset-pdf-page-source-target), a, input")) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const isBack = clickX < rect.width * 0.25 || event.shiftKey;
    if (layout === "dual") {
      stepDual(isBack ? -1 : 1);
    } else {
      step(isBack ? -1 : 1);
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (layout === "grid") return;
    if (wheelSettlingRef.current || event.ctrlKey || event.deltaY === 0) return;
    wheelSettlingRef.current = true;
    if (layout === "dual") {
      stepDual(event.deltaY > 0 ? 1 : -1);
    } else {
      step(event.deltaY > 0 ? 1 : -1);
    }
    window.setTimeout(() => {
      wheelSettlingRef.current = false;
    }, 240);
  };

  const handleTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (touch) touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (layout === "grid") return;
    const start = touchStartRef.current;
    touchStartRef.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) > 40 && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (layout === "dual") {
        stepDual(deltaX < 0 ? 1 : -1);
      } else {
        step(deltaX < 0 ? 1 : -1);
      }
    }
  };

  // Single mode fit-to-screen zoom
  const singleNaturalSize = localSizes[page] ?? pageSizes[page] ?? pageSizes[1] ?? { width: 612, height: 792 };
  const singleAvailW = Math.max(100, viewport.width - 48);
  const singleAvailH = Math.max(100, viewport.height - 48);
  const singleFitZoom = Math.max(0.1, Math.min(singleAvailW / singleNaturalSize.width, singleAvailH / singleNaturalSize.height));

  // Dual mode fit-to-screen zoom
  const leftSize = localSizes[leftPage] ?? pageSizes[leftPage] ?? pageSizes[1] ?? { width: 612, height: 792 };
  const rightSize = rightPage != null ? (localSizes[rightPage] ?? pageSizes[rightPage] ?? leftSize) : leftSize;
  const dualGap = 28;
  const dualCombinedW = leftSize.width + (rightPage != null ? rightSize.width : leftSize.width) + dualGap;
  const dualMaxH = Math.max(leftSize.height, rightPage != null ? rightSize.height : leftSize.height);
  const dualAvailW = Math.max(100, viewport.width - 64);
  const dualAvailH = Math.max(100, viewport.height - 64);
  const dualFitZoom = Math.max(0.1, Math.min(dualAvailW / dualCombinedW, dualAvailH / dualMaxH));

  const prevDisabled = layout === "dual" ? leftPage <= 1 : page <= 1;
  const nextDisabled = layout === "dual" ? (rightPage != null ? rightPage >= numPages : leftPage >= numPages) : page >= numPages;

  return (
    <div
      className={`typeset-pdf-presentation-overlay${inverted ? " inverted" : ""}${!hudVisible ? " hide-cursor" : ""}`}
      onMouseMove={handlePointerActivity}
      onClick={handleOverlayClick}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      role="dialog"
      aria-label={copy.presentPdf}
      aria-modal="true"
      tabIndex={-1}
    >
      {hintVisible && (
        <div className="typeset-presentation-hint visible" role="status">
          {copy.presentationHint}
        </div>
      )}

      {layout === "single" && (
        <div className="typeset-pdf-presentation-stage single">
          <PdfPage
            key={`presentation:single:${page}`}
            pdf={pdf}
            page={page}
            zoom={singleFitZoom}
            estimatedSize={singleNaturalSize}
            onSourceTextClick={() => {}}
            onPageSize={(w, h) => updatePageSize(page, w, h)}
            onPdfLinkClick={(destination) => {
              void resolvePdfDestinationPage(pdf, destination).then((dest) => {
                if (dest != null) goToPage(dest);
              });
            }}
          />
        </div>
      )}

      {layout === "dual" && (
        <div className="typeset-pdf-presentation-stage dual">
          <div className="typeset-presentation-dual-page">
            <PdfPage
              key={`presentation:dual:${leftPage}`}
              pdf={pdf}
              page={leftPage}
              zoom={dualFitZoom}
              estimatedSize={leftSize}
              onSourceTextClick={() => {}}
              onPageSize={(w, h) => updatePageSize(leftPage, w, h)}
              onPdfLinkClick={(destination) => {
                void resolvePdfDestinationPage(pdf, destination).then((dest) => {
                  if (dest != null) goToPage(dest);
                });
              }}
            />
          </div>
          {rightPage != null ? (
            <div className="typeset-presentation-dual-page">
              <PdfPage
                key={`presentation:dual:${rightPage}`}
                pdf={pdf}
                page={rightPage}
                zoom={dualFitZoom}
                estimatedSize={rightSize}
                onSourceTextClick={() => {}}
                onPageSize={(w, h) => updatePageSize(rightPage, w, h)}
                onPdfLinkClick={(destination) => {
                  void resolvePdfDestinationPage(pdf, destination).then((dest) => {
                    if (dest != null) goToPage(dest);
                  });
                }}
              />
            </div>
          ) : (
            <div
              className="typeset-presentation-dual-placeholder"
              style={{
                width: leftSize.width * dualFitZoom,
                height: leftSize.height * dualFitZoom,
              }}
            />
          )}
        </div>
      )}

      {layout === "grid" && (
        <div className="typeset-pdf-presentation-stage grid">
          {Array.from({ length: numPages }, (_, i) => i + 1).map((pg) => {
            const pSize = localSizes[pg] ?? pageSizes[pg] ?? pageSizes[1] ?? { width: 612, height: 792 };
            const pZoom = Math.max(0.1, Math.min(220 / pSize.width, 300 / pSize.height));
            const isActive = pg === page;
            return (
              <div
                key={`presentation:grid:${pg}`}
                className={`typeset-presentation-grid-item${isActive ? " active" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`Page ${pg}`}
                onClick={(event) => {
                  event.stopPropagation();
                  goToPage(pg);
                  changeLayout(lastMainLayoutRef.current);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    goToPage(pg);
                    changeLayout(lastMainLayoutRef.current);
                  }
                }}
              >
                <div className="typeset-presentation-grid-thumb">
                  <PdfPage
                    key={`presentation:grid:thumb:${pg}`}
                    pdf={pdf}
                    page={pg}
                    zoom={pZoom}
                    estimatedSize={pSize}
                    onSourceTextClick={() => {}}
                    onPageSize={(w, h) => updatePageSize(pg, w, h)}
                  />
                </div>
                <div className="typeset-presentation-grid-badge">{pg}</div>
              </div>
            );
          })}
        </div>
      )}

      <div
        className={`typeset-presentation-hud${hudVisible ? " visible" : ""}`}
        role="toolbar"
        aria-label="Presentation controls"
        onMouseEnter={() => {
          if (hudTimerRef.current !== null) window.clearTimeout(hudTimerRef.current);
          setHudVisible(true);
        }}
      >
        <button
          type="button"
          className="typeset-presentation-btn"
          title={copy.previousPage}
          aria-label={copy.previousPage}
          disabled={prevDisabled}
          onClick={(event) => {
            event.stopPropagation();
            if (layout === "dual") {
              stepDual(-1);
            } else {
              step(-1);
            }
          }}
        >
          <ToolIcon name="previous" />
        </button>

        <div className="typeset-presentation-pages" aria-live="polite">
          <span>{layout === "dual" ? (rightPage != null ? `${leftPage} - ${rightPage}` : leftPage) : page}</span>
          <span className="typeset-presentation-slash">/</span>
          <span>{numPages}</span>
        </div>

        <button
          type="button"
          className="typeset-presentation-btn"
          title={copy.nextPage}
          aria-label={copy.nextPage}
          disabled={nextDisabled}
          onClick={(event) => {
            event.stopPropagation();
            if (layout === "dual") {
              stepDual(1);
            } else {
              step(1);
            }
          }}
        >
          <ToolIcon name="next" />
        </button>

        <div className="typeset-presentation-divider" role="presentation" />

        <div className="typeset-presentation-layout-group" role="radiogroup" aria-label={copy.pageLayout}>
          <button
            type="button"
            className={`typeset-presentation-layout-btn${layout === "single" ? " active" : ""}`}
            title={copy.presentationSingle}
            aria-label={copy.presentationSingle}
            aria-checked={layout === "single"}
            role="radio"
            onClick={(event) => {
              event.stopPropagation();
              changeLayout("single");
            }}
          >
            <LayoutSingleIcon />
          </button>
          <button
            type="button"
            className={`typeset-presentation-layout-btn${layout === "dual" ? " active" : ""}`}
            title={copy.presentationDual}
            aria-label={copy.presentationDual}
            aria-checked={layout === "dual"}
            role="radio"
            onClick={(event) => {
              event.stopPropagation();
              changeLayout("dual");
            }}
          >
            <LayoutDualIcon />
          </button>
          <button
            type="button"
            className={`typeset-presentation-layout-btn${layout === "grid" ? " active" : ""}`}
            title={copy.presentationGrid}
            aria-label={copy.presentationGrid}
            aria-checked={layout === "grid"}
            role="radio"
            onClick={(event) => {
              event.stopPropagation();
              changeLayout(layout === "grid" ? lastMainLayoutRef.current : "grid");
            }}
          >
            <LayoutGridIcon />
          </button>
        </div>

        <div className="typeset-presentation-divider" role="presentation" />

        <button
          type="button"
          className={`typeset-presentation-btn${inverted ? " active" : ""}`}
          title={inverted ? copy.restorePdfColors : copy.invertPdfColors}
          aria-label={inverted ? copy.restorePdfColors : copy.invertPdfColors}
          onClick={(event) => {
            event.stopPropagation();
            onToggleInverted();
          }}
        >
          <ToolIcon name="contrast" />
        </button>

        <button
          type="button"
          className="typeset-presentation-btn"
          title={isFullscreen ? "Exit full screen (F)" : "Full screen (F)"}
          aria-label="Toggle full screen"
          onClick={(event) => {
            event.stopPropagation();
            void toggleFs();
          }}
        >
          <SvgIcon name="fit" size={16} />
        </button>

        <button
          type="button"
          className="typeset-presentation-btn typeset-presentation-exit"
          title={copy.exitPresentation}
          aria-label={copy.exitPresentation}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <SvgIcon name="close" size={16} />
        </button>
      </div>
    </div>
  );
}
