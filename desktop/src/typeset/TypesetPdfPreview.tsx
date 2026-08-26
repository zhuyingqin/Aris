// The read-only compiled-PDF surface: page virtualisation, zoom, search,
// outline navigation and the SyncTeX jump affordances around it.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { fileOpen, fileReadBytes, type SyncTexLocation } from "../api/tauri";
import { openPdfDocument } from "../pdf/runtime";
import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import {
  compileStatusText,
  LATEX_ENGINE_CHOICES,
  type CompileResult,
  type CompileStatus,
  type LatexEngineChoice,
} from "./compileModel";
import { TYPESET_EDITOR_COPY } from "./i18n";
import { basename } from "./latexText";
import {
  clampNumber,
  PDF_WHEEL_ZOOM_SETTLE_MS,
  PDF_ZOOM_MAX,
  PDF_ZOOM_MIN,
  PDF_ZOOM_PRESETS,
  type PdfPointConverter,
} from "./pdfGeometry";
import { PdfFallbackPage, PdfPage, type PdfClickPosition } from "./PdfPage";
import { ToolIcon } from "./ToolIcon";

export type PdfForwardTarget = { location: SyncTexLocation; nonce: number };

export interface PdfPreviewProps {
  path: string | null;
  sourcePath: string | null;
  refreshKey: number;
  status: CompileStatus;
  result: CompileResult | null;
  dirty: boolean;
  disabled: boolean;
  logOpen: boolean;
  diagnosticsCount: number;
  continueOnError: boolean;
  engine: LatexEngineChoice;
  compileOnSave: boolean;
  inverted: boolean;
  canCancel: boolean;
  onCompile: () => void;
  onCancelCompile: () => void;
  onClearCacheCompile: () => void;
  onSetContinueOnError: (value: boolean) => void;
  onSetEngine: (value: LatexEngineChoice) => void;
  onSetCompileOnSave: (value: boolean) => void;
  onToggleInverted: () => void;
  onExportPdf: () => void;
  /** Forward search from wherever the source caret is. */
  onSyncToPdf: () => void;
  onToggleLog: () => void;
  /** `position` is the PDF point that was clicked, for SyncTeX inverse search;
   * callers fall back to text matching when it is absent. */
  onSourceTextClick: (text: string, context: string, position?: PdfClickPosition) => void;
  onHide?: () => void;
  forwardTarget?: PdfForwardTarget | null;
  forwardSearchNotice?: string | null;
}
async function pdfPageForDestination(pdf: PDFDocumentProxy, destination: unknown): Promise<number | null> {
  let explicitDestination = destination;
  if (typeof explicitDestination === "string") {
    explicitDestination = await pdf.getDestination(explicitDestination);
  }
  if (!Array.isArray(explicitDestination) || !explicitDestination[0]) return null;
  const pageReference = explicitDestination[0] as Parameters<PDFDocumentProxy["getPageIndex"]>[0];
  return (await pdf.getPageIndex(pageReference)) + 1;
}
export default function TypesetPdfPreview({
  path,
  sourcePath,
  refreshKey,
  status,
  result,
  dirty,
  disabled,
  logOpen,
  diagnosticsCount,
  continueOnError,
  engine,
  compileOnSave,
  inverted,
  canCancel,
  onCompile,
  onCancelCompile,
  onClearCacheCompile,
  onSetContinueOnError,
  onSetEngine,
  onSetCompileOnSave,
  onToggleInverted,
  onExportPdf,
  onSyncToPdf,
  onToggleLog,
  onSourceTextClick,
  onHide,
  forwardTarget,
  forwardSearchNotice,
}: PdfPreviewProps) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].pdfPreview;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [zoomDraft, setZoomDraft] = useState("100");
  const [pageSizes, setPageSizes] = useState<Record<number, { width: number; height: number }>>({});
  const [renderRange, setRenderRange] = useState({ start: 1, end: 3 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compileMenuOpen, setCompileMenuOpen] = useState(false);
  const [compileMenuPosition, setCompileMenuPosition] = useState({ top: 0, right: 8 });
  const [presenting, setPresenting] = useState(false);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const [zoomMenuPosition, setZoomMenuPosition] = useState({ top: 0, right: 8 });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const compileMenuRef = useRef<HTMLDivElement | null>(null);
  const compileMenuPopoverRef = useRef<HTMLDivElement | null>(null);
  const zoomMenuRef = useRef<HTMLButtonElement | null>(null);
  const zoomMenuPopoverRef = useRef<HTMLDivElement | null>(null);
  const pageInputFocusedRef = useRef(false);
  const userZoomedRef = useRef(false);
  const currentPageRef = useRef(currentPage);
  const loadedPdfPathRef = useRef<string | null>(null);
  const lastPageByPathRef = useRef(new Map<string, number>());
  const zoomRef = useRef(zoom);
  const pendingWheelZoomRef = useRef<number | null>(null);
  const wheelZoomTimerRef = useRef<number | null>(null);
  const scrollFrameRef = useRef(0);
  const pageElementsRef = useRef(new Map<number, HTMLDivElement>());
  const pageSizesRef = useRef(pageSizes);
  const pendingRestorePageRef = useRef<number | null>(null);
  const scrollAnchorRef = useRef<{ page: number; offset: number } | null>(null);
  const pageRefCallbacksRef = useRef(new Map<number, (element: HTMLDivElement | null) => void>());
  const pageSizeCallbacksRef = useRef(new Map<number, (width: number, height: number) => void>());
  const registerPageRef = useCallback((page: number, el: HTMLDivElement | null) => {
    if (el) pageElementsRef.current.set(page, el);
    else pageElementsRef.current.delete(page);
  }, []);
  const pointConvertersRef = useRef(new Map<number, PdfPointConverter>());
  const registerPointConverter = useCallback((page: number, convert: PdfPointConverter | null) => {
    if (convert) pointConvertersRef.current.set(page, convert);
    else pointConvertersRef.current.delete(page);
  }, []);

  /**
   * "Show me the source for what I am looking at" — Overleaf's *go to PDF
   * location in code*. The query point is the top of the visible area rather
   * than the page's own top, so scrolling half-way down a page still asks about
   * the line under the reader's eyes.
   */
  const syncViewportToSource = useCallback(() => {
    const scroll = scrollRef.current;
    const element = pageElementsRef.current.get(currentPage);
    const convert = pointConvertersRef.current.get(currentPage);
    if (!scroll || !element || !convert) return;
    const pageBounds = element.getBoundingClientRect();
    const scrollBounds = scroll.getBoundingClientRect();
    const clientY = clampNumber(scrollBounds.top + 12, pageBounds.top + 2, pageBounds.bottom - 2);
    const point = convert(pageBounds.left + pageBounds.width / 2, clientY);
    if (!point) return;
    onSourceTextClick("", "", { page: currentPage, x: point.x, y: point.y });
  }, [currentPage, onSourceTextClick]);
  const captureScrollAnchor = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const initial = pageElementsRef.current.get(1);
    if (!initial) return;
    let anchor = initial;
    let anchorPage = 1;
    for (let page = 2; page <= numPages; page += 1) {
      const candidate = pageElementsRef.current.get(page);
      if (!candidate) continue;
      if (candidate.offsetTop > scroll.scrollTop) break;
      anchor = candidate;
      anchorPage = page;
    }
    scrollAnchorRef.current = { page: anchorPage, offset: scroll.scrollTop - anchor.offsetTop };
  }, [numPages]);
  const updatePageSizes = useCallback((updates: ReadonlyArray<readonly [number, { width: number; height: number }]>) => {
    const known = pageSizesRef.current;
    const changed = updates.some(([page, size]) => {
      const current = known[page];
      return !current || Math.abs(current.width - size.width) >= 0.1 || Math.abs(current.height - size.height) >= 0.1;
    });
    if (!changed) return;
    captureScrollAnchor();
    const next = { ...known };
    for (const [page, size] of updates) next[page] = size;
    pageSizesRef.current = next;
    setPageSizes(next);
  }, [captureScrollAnchor]);
  const recordPageSize = useCallback((page: number, width: number, height: number) => {
    updatePageSizes([[page, { width, height }]]);
  }, [updatePageSizes]);
  const pageRefFor = useCallback((page: number) => {
    const existing = pageRefCallbacksRef.current.get(page);
    if (existing) return existing;
    const callback = (element: HTMLDivElement | null) => registerPageRef(page, element);
    pageRefCallbacksRef.current.set(page, callback);
    return callback;
  }, [registerPageRef]);
  const pageSizeCallbackFor = useCallback((page: number) => {
    const existing = pageSizeCallbacksRef.current.get(page);
    if (existing) return existing;
    const callback = (width: number, height: number) => recordPageSize(page, width, height);
    pageSizeCallbacksRef.current.set(page, callback);
    return callback;
  }, [recordPageSize]);
  pageSizesRef.current = pageSizes;

  const pageTopFor = useCallback((page: number): number | null => {
    const direct = pageElementsRef.current.get(page);
    if (direct && Number.isFinite(direct.offsetTop)) return direct.offsetTop;
    const scroll = scrollRef.current;
    const fallback = scroll?.querySelectorAll<HTMLElement>(".typeset-pdf-page")[page - 1];
    const top = fallback?.offsetTop;
    return typeof top === "number" && Number.isFinite(top) ? top : null;
  }, []);

  const showPagesAround = useCallback((page: number) => {
    const radius = zoom >= 2 ? 0 : zoom >= 1.1 ? 1 : 2;
    setRenderRange((range) => {
      const next = {
        start: Math.max(1, page - radius),
        end: Math.min(Math.max(1, numPages), page + radius),
      };
      return range.start === next.start && range.end === next.end ? range : next;
    });
  }, [numPages, zoom]);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (!anchor) return;
    scrollAnchorRef.current = null;
    const scroll = scrollRef.current;
    const pageElement = pageElementsRef.current.get(anchor.page);
    if (!scroll || !pageElement) return;
    const target = Math.max(0, pageElement.offsetTop + anchor.offset);
    if (Math.abs(scroll.scrollTop - target) > 0.5) scroll.scrollTop = target;
  }, [pageSizes]);

  useEffect(() => {
    // A zoom change can make the existing render window unnecessarily large.
    // Do not subscribe to currentPage here: scroll updates calculate the full
    // visible range separately, and must not be overwritten with a smaller
    // current-page window after their render range commits.
    showPagesAround(currentPageRef.current);
  }, [showPagesAround]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => () => {
    if (wheelZoomTimerRef.current !== null) window.clearTimeout(wheelZoomTimerRef.current);
  }, []);

  useEffect(() => {
    if (!compileMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !compileMenuRef.current?.contains(target)
        && !compileMenuPopoverRef.current?.contains(target)
      ) {
        setCompileMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCompileMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [compileMenuOpen]);

  useEffect(() => {
    if (!zoomMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!zoomMenuRef.current?.contains(target) && !zoomMenuPopoverRef.current?.contains(target)) {
        setZoomMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [zoomMenuOpen]);

  useEffect(() => {
    let disposed = false;
    let loadedPdf: PDFDocumentProxy | null = null;
    const previousPath = loadedPdfPathRef.current;
    if (previousPath) lastPageByPathRef.current.set(previousPath, currentPageRef.current);
    const samePdfPath = previousPath === path;
    const restoredPage = path ? lastPageByPathRef.current.get(path) ?? 1 : 1;
    loadedPdfPathRef.current = path;
    // A recompile keeps the same path. Preserve its reader position and any
    // explicit zoom choice; a different PDF starts with fit-to-width again.
    if (!samePdfPath) userZoomedRef.current = false;
    setPdf(null);
    setNumPages(0);
    scrollAnchorRef.current = null;
    pageSizesRef.current = {};
    setPageSizes({});
    setRenderRange({ start: Math.max(1, restoredPage - 2), end: restoredPage + 2 });
    setCurrentPage(restoredPage);
    setPageDraft(String(restoredPage));
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
        setNumPages(document.numPages);
        const page = clampNumber(restoredPage, 1, Math.max(1, document.numPages));
        currentPageRef.current = page;
        lastPageByPathRef.current.set(path, page);
        pendingRestorePageRef.current = samePdfPath ? page : null;
        setCurrentPage(page);
        setPageDraft(String(page));
        setRenderRange({ start: Math.max(1, page - 2), end: Math.min(document.numPages, page + 2) });
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

  useEffect(() => {
    if (!pdf || numPages < 1) return;
    let disposed = false;
    const missingPages: number[] = [];
    for (let page = renderRange.start; page <= renderRange.end; page += 1) {
      if (!pageSizes[page]) missingPages.push(page);
    }
    if (missingPages.length === 0) return () => { disposed = true; };
    void Promise.all(missingPages.map(async (page) => {
      const pdfPage = await pdf.getPage(page);
      const viewport = pdfPage.getViewport({ scale: 1 });
      return [page, { width: viewport.width, height: viewport.height }] as const;
    })).then((sizes) => {
      if (disposed) return;
      updatePageSizes(sizes);
    }).catch(() => {
      // Mounted pages still report their own dimensions if metadata lookup fails.
    });
    return () => {
      disposed = true;
    };
  }, [numPages, pageSizes, pdf, renderRange.end, renderRange.start, updatePageSizes]);

  // Recompiling replaces the PDF object at the same path. Restore the reader
  // only after its new placeholder layout is mounted, rather than letting the
  // browser retain an offset from the discarded document.
  useEffect(() => {
    const page = pendingRestorePageRef.current;
    if (!pdf || numPages < 1 || page == null) return;
    let frame = window.requestAnimationFrame(() => {
      const pageElement = pageElementsRef.current.get(page);
      const scroll = scrollRef.current;
      if (!pageElement || !scroll) return;
      const top = Math.max(0, pageElement.offsetTop - 12);
      if (typeof scroll.scrollTo === "function") scroll.scrollTo({ top, behavior: "auto" });
      else scroll.scrollTop = top;
      pendingRestorePageRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [numPages, pdf]);

  useEffect(() => {
    if (!pdf || typeof window === "undefined") return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    const fitToWidth = async () => {
      const scroll = scrollRef.current;
      if (!scroll || userZoomedRef.current) return;
      try {
        const firstPage = await pdf.getPage(1);
        if (disposed || userZoomedRef.current) return;
        const baseViewport = firstPage.getViewport({ scale: 1 });
        const availableWidth = Math.max(180, scroll.clientWidth - 36);
        setZoom(clampNumber(availableWidth / baseViewport.width, 0.7, 2.2));
      } catch {
        if (!disposed && !userZoomedRef.current) setZoom(1);
      }
    };

    void fitToWidth();
    if (typeof ResizeObserver !== "undefined" && scrollRef.current) {
      resizeObserver = new ResizeObserver(() => {
        void fitToWidth();
      });
      resizeObserver.observe(scrollRef.current);
    }
    window.addEventListener("resize", fitToWidth);

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", fitToWidth);
    };
  }, [pdf]);

  const updateVisiblePages = useCallback(() => {
    const scroll = scrollRef.current;
    if (!pdf || !scroll || numPages < 1) return;
    // Track the page at the reading edge, rather than the viewport center.
    // A short landscape PDF can show two pages at once; center tracking would
    // report the following page immediately after jumping to the current one.
    const viewportAnchor = scroll.scrollTop + Math.min(48, scroll.clientHeight / 4);
    const viewportHeight = scroll.clientHeight;
    const overscan = viewportHeight * 0.75;
    const renderTop = Math.max(0, scroll.scrollTop - overscan);
    const renderBottom = scroll.scrollTop + viewportHeight + overscan;
    const pageAtOffset = (offset: number) => {
      let low = 1;
      let high = numPages;
      let match = 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const element = pageElementsRef.current.get(middle);
        if (!element) break;
        const top = element.offsetTop;
        const bottom = top + element.offsetHeight;
        match = middle;
        if (offset < top) high = middle - 1;
        else if (offset > bottom) low = middle + 1;
        else return middle;
      }
      return clampNumber(match, 1, numPages);
    };
    const nextPage = pageAtOffset(viewportAnchor);
    const visibleStart = pageAtOffset(renderTop);
    const visibleEnd = pageAtOffset(renderBottom);
    setCurrentPage((page) => page === nextPage ? page : nextPage);
    if (viewportHeight > 0 && visibleEnd > 0) {
      const radius = zoom >= 2 ? 0 : zoom >= 1.1 ? 1 : 2;
      const nextRange = {
        // The viewport can show several short/landscape pages at once. Use
        // its full measured range as the source of truth, then preload the
        // immediate neighbors so a page never remains a white placeholder
        // until the preceding page has completely scrolled away.
        start: Math.max(1, visibleStart - radius),
        end: Math.min(numPages, visibleEnd + radius),
      };
      setRenderRange((range) => (
        range.start === nextRange.start && range.end === nextRange.end ? range : nextRange
      ));
    }
  }, [numPages, pdf, zoom]);

  const scheduleVisiblePagesUpdate = useCallback(() => {
    window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      updateVisiblePages();
    });
  }, [updateVisiblePages]);

  useEffect(() => {
    if (!pdf || numPages < 1) return;
    // Recalculate after document and zoom updates. User scrolling is handled
    // by the scroll surface itself so the first scroll event is never missed
    // while React is committing a preview update.
    if ((scrollRef.current?.clientHeight ?? 0) > 0) scheduleVisiblePagesUpdate();
    return () => {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = 0;
    };
  }, [numPages, pdf, scheduleVisiblePagesUpdate]);

  useEffect(() => {
    if (!pageInputFocusedRef.current) setPageDraft(String(currentPage));
  }, [currentPage]);

  // Forward search: scroll the compiled PDF to the page/point SyncTeX
  // resolved for the last double-click in the source editor. Runs after the
  // target page has had a chance to mount/register its ref (double rAF: one
  // for this render's DOM commit, one for the page's own render effect).
  useEffect(() => {
    if (!forwardTarget) return;
    showPagesAround(forwardTarget.location.page);
    let frame1 = 0;
    let frame2 = 0;
    frame1 = window.requestAnimationFrame(() => {
      frame2 = window.requestAnimationFrame(() => {
        const pageEl = pageElementsRef.current.get(forwardTarget.location.page);
        const scroll = scrollRef.current;
        if (!pageEl || !scroll) return;
        const targetTop = pageEl.offsetTop + forwardTarget.location.pointY * zoom - scroll.clientHeight / 2;
        if (typeof scroll.scrollTo === "function") {
          scroll.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
        } else {
          scroll.scrollTop = Math.max(0, targetTop);
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(frame1);
      window.cancelAnimationFrame(frame2);
    };
  }, [forwardTarget, showPagesAround, zoom]);

  const setZoomLevel = (value: number, closeMenu = true) => {
    const nextZoom = clampNumber(value, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
    userZoomedRef.current = true;
    zoomRef.current = nextZoom;
    pendingWheelZoomRef.current = null;
    if (wheelZoomTimerRef.current !== null) {
      window.clearTimeout(wheelZoomTimerRef.current);
      wheelZoomTimerRef.current = null;
    }
    setZoom(nextZoom);
    if (closeMenu) setZoomMenuOpen(false);
  };
  const fitPdf = async (mode: "height" | "width") => {
    const scroll = scrollRef.current;
    if (!pdf || !scroll) return;
    try {
      const page = await pdf.getPage(clampNumber(currentPage, 1, Math.max(1, numPages)));
      const viewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(100, scroll.clientWidth - 32);
      const availableHeight = Math.max(100, scroll.clientHeight - 32);
      const nextZoom = mode === "width" ? availableWidth / viewport.width : availableHeight / viewport.height;
      setZoomLevel(nextZoom);
    } catch {
      setZoomMenuOpen(false);
    }
  };
  const applyZoomDraft = () => {
    const percentage = Number.parseFloat(zoomDraft.replace("%", ""));
    if (!Number.isFinite(percentage)) {
      setZoomDraft(String(Math.round(zoom * 100)));
      return;
    }
    setZoomLevel(percentage / 100);
  };
  const handlePdfWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const delta = clampNumber(-deltaY * 0.001, -0.14, 0.14);
    const currentTarget = pendingWheelZoomRef.current ?? zoomRef.current;
    pendingWheelZoomRef.current = clampNumber(currentTarget + delta, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
    if (wheelZoomTimerRef.current !== null) window.clearTimeout(wheelZoomTimerRef.current);
    wheelZoomTimerRef.current = window.setTimeout(() => {
      wheelZoomTimerRef.current = null;
      const nextZoom = pendingWheelZoomRef.current;
      pendingWheelZoomRef.current = null;
      if (nextZoom !== null) setZoomLevel(nextZoom, false);
    }, PDF_WHEEL_ZOOM_SETTLE_MS);
  };
  const scrollToPage = useCallback((page: number, behavior: ScrollBehavior = "auto") => {
    const nextPage = clampNumber(Math.round(page), 1, Math.max(1, numPages));
    // Keyboard repeats can arrive before React commits the state update below.
    // Advance the imperative page cursor immediately so every queued key press
    // builds on the last requested page instead of repeatedly targeting the
    // currently rendered one.
    currentPageRef.current = nextPage;
    showPagesAround(nextPage);
    const scroll = scrollRef.current;
    const pageTop = pageTopFor(nextPage);
    setCurrentPage(nextPage);
    setPageDraft(String(nextPage));
    if (pageTop == null || !scroll) return;
    const top = Math.max(0, pageTop - 12);
    if (typeof scroll.scrollTo === "function") scroll.scrollTo({ top, behavior });
    else scroll.scrollTop = top;
  }, [numPages, showPagesAround]);
  const followPdfLink = useCallback((destination: unknown) => {
    if (!pdf) return;
    void pdfPageForDestination(pdf, destination)
      .then((page) => {
        if (page != null) scrollToPage(page, "smooth");
      })
      .catch(() => undefined);
  }, [pdf, scrollToPage]);
  const commitPageDraft = () => {
    const requestedPage = Number.parseInt(pageDraft, 10);
    if (!Number.isFinite(requestedPage)) {
      setPageDraft(String(currentPage));
      return;
    }
    scrollToPage(requestedPage);
  };

  /**
   * Presentation mode: one page at a time, filling the window, driven by the
   * arrow keys, a click, or the wheel — Overleaf's `use-presentation-mode`,
   * which for a Beamer deck is the difference between previewing slides and
   * showing them.
   */
  useEffect(() => {
    if (!presenting) return undefined;
    const step = (direction: number) => scrollToPage(currentPageRef.current + direction);
    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case "Escape":
          setPresenting(false);
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
        case "Backspace":
          step(-1);
          break;
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
          step(1);
          break;
        case " ":
          step(event.shiftKey ? -1 : 1);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest("button, a, input")) return;
      step(event.shiftKey ? -1 : 1);
    };
    let wheelSettling = false;
    const onWheel = (event: WheelEvent) => {
      if (wheelSettling || event.ctrlKey || event.deltaY === 0) return;
      wheelSettling = true;
      step(event.deltaY > 0 ? 1 : -1);
      window.setTimeout(() => { wheelSettling = false; }, 200);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
      window.removeEventListener("wheel", onWheel);
    };
  }, [presenting, scrollToPage]);

  useEffect(() => {
    if (presenting) return;
    if (numPages < 2 || logOpen || compileMenuOpen || zoomMenuOpen) return;
    const onPageNavigationKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      const target = event.target;
      if (
        target instanceof HTMLElement
        && target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']")
      ) {
        return;
      }
      event.preventDefault();
      scrollToPage(currentPageRef.current + (event.key === "ArrowRight" ? 1 : -1), "smooth");
    };
    window.addEventListener("keydown", onPageNavigationKey);
    return () => window.removeEventListener("keydown", onPageNavigationKey);
  }, [compileMenuOpen, logOpen, numPages, presenting, scrollToPage, zoomMenuOpen]);

  const statusText = dirty ? copy.unsavedChanges : compileStatusText(status, result, language);

  return (
    <section
      className={`typeset-preview pdf${!path ? " pdf-empty" : ""}${presenting ? " presenting" : ""}`}
      aria-label={copy.pdfPreviewLabel}
      aria-keyshortcuts="ArrowLeft ArrowRight"
    >
      <div className="typeset-preview-toolbar toolbar toolbar-pdf toolbar-pdf-hybrid">
        <div className="typeset-pdf-left toolbar-pdf-left">
          <span className="typeset-pdf-panel-label">{copy.compiledPdfLabel}</span>
          <div
            ref={compileMenuRef}
            className={`typeset-compile-button-group compile-button-group${dirty ? " has-changes" : ""}`}
          >
            <button
              type="button"
              className={`typeset-recompile-btn compile-button ${status}${dirty ? " btn-striped-animated" : ""}`}
              disabled={status === "running" ? !canCancel : disabled}
              onClick={status === "running" ? onCancelCompile : onCompile}
            >
              <ToolIcon name={status === "running" ? "clear" : "compile"} />
              <span className="typeset-recompile-label">
                {status === "running" ? copy.stopCompilation : copy.recompile}
              </span>
            </button>
            <button
              type="button"
              className="typeset-compile-options compile-dropdown-toggle"
              title={copy.compileOptions}
              aria-label={copy.compileOptions}
              aria-haspopup="menu"
              aria-expanded={compileMenuOpen}
              disabled={disabled}
              onClick={(event) => {
                if (compileMenuOpen) {
                  setCompileMenuOpen(false);
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                setCompileMenuPosition({
                  top: rect.bottom + 7,
                  right: Math.max(8, window.innerWidth - rect.right),
                });
                setCompileMenuOpen(true);
              }}
            >
              <ToolIcon name="chevron" className="typeset-compile-chevron" />
            </button>
            {compileMenuOpen && typeof document !== "undefined" && createPortal(
              <div
                ref={compileMenuPopoverRef}
                className="typeset-compile-menu"
                role="menu"
                aria-label={copy.compileOptionsMenu}
                style={compileMenuPosition}
              >
                <div className="typeset-compile-menu-section" role="presentation">
                  <span>{copy.compileErrorHandling}</span>
                </div>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!continueOnError}
                  onClick={() => {
                    onSetContinueOnError(false);
                    setCompileMenuOpen(false);
                  }}
                >
                  <span>
                    <strong>{copy.stopOnFirstError}</strong>
                    <small>{copy.stopOnFirstErrorDesc}</small>
                  </span>
                  {!continueOnError && <b aria-hidden="true"><SvgIcon name="check" size={14} /></b>}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={continueOnError}
                  onClick={() => {
                    onSetContinueOnError(true);
                    setCompileMenuOpen(false);
                  }}
                >
                  <span>
                    <strong>{copy.tryDespiteErrors}</strong>
                    <small>{copy.tryDespiteErrorsDesc}</small>
                  </span>
                  {continueOnError && <b aria-hidden="true"><SvgIcon name="check" size={14} /></b>}
                </button>
                <div className="typeset-compile-menu-divider" role="presentation" />
                <div className="typeset-compile-menu-section" role="presentation">
                  <span>{copy.engineSection}</span>
                </div>
                {LATEX_ENGINE_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    role="menuitemradio"
                    aria-checked={engine === choice}
                    onClick={() => {
                      onSetEngine(choice);
                      setCompileMenuOpen(false);
                    }}
                  >
                    <span>
                      <strong>{copy.engineLabel(choice)}</strong>
                      <small>{copy.engineDescription(choice)}</small>
                    </span>
                    {engine === choice && <b aria-hidden="true"><SvgIcon name="check" size={14} /></b>}
                  </button>
                ))}
                <div className="typeset-compile-menu-divider" role="presentation" />
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={compileOnSave}
                  onClick={() => {
                    onSetCompileOnSave(!compileOnSave);
                    setCompileMenuOpen(false);
                  }}
                >
                  <span>
                    <strong>{copy.compileOnSave}</strong>
                    <small>{copy.compileOnSaveDesc}</small>
                  </span>
                  {compileOnSave && <b aria-hidden="true"><SvgIcon name="check" size={14} /></b>}
                </button>
                <div className="typeset-compile-menu-divider" role="presentation" />
                {status === "running" && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!canCancel}
                    onClick={() => {
                      setCompileMenuOpen(false);
                      onCancelCompile();
                    }}
                  >
                    <ToolIcon name="clear" />
                    <span>
                      <strong>{copy.stopCompilation}</strong>
                      <small>{copy.stopCompilationDesc}</small>
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  disabled={status === "running"}
                  onClick={() => {
                    setCompileMenuOpen(false);
                    onClearCacheCompile();
                  }}
                >
                  <ToolIcon name="clear" />
                  <span>
                    <strong>{copy.clearCacheRecompile}</strong>
                    <small>{copy.clearCacheRecompileDesc}</small>
                  </span>
                </button>
              </div>,
              document.body,
            )}
          </div>
          <button
            type="button"
            className={`typeset-log-toggle pdf-toolbar-btn log-btn${logOpen ? " active" : ""}`}
            title={copy.compileLog}
            aria-label={copy.compileLog}
            onClick={onToggleLog}
          >
            <ToolIcon name="logs" />
            {diagnosticsCount > 0 && <span>{diagnosticsCount}</span>}
          </button>
          {statusText && <span className={`typeset-pdf-status ${status}`}>{statusText}</span>}
          {result?.pdfState === "stale" && (
            <span className="typeset-pdf-status stale" role="status">{copy.showingLastVerified}</span>
          )}
          {result?.pdfState === "missing" && (
            <span className="typeset-pdf-status error" role="status">{copy.noPdfProduced}</span>
          )}
          {forwardSearchNotice && <span className="typeset-pdf-status error" role="status">{forwardSearchNotice}</span>}
        </div>
        <div className="typeset-preview-actions toolbar-pdf-right">
          <span className="typeset-preview-file" title={path ?? ""}>{path ? basename(path) : copy.preview}</span>
          <div className="typeset-pdf-page-control" aria-label={copy.pdfPageNavigationLabel}>
            <input
              type="text"
              inputMode="numeric"
              value={pageDraft}
              aria-label={copy.currentPdfPage}
              disabled={numPages < 1}
              onFocus={(event) => {
                pageInputFocusedRef.current = true;
                event.currentTarget.select();
              }}
              onChange={(event) => setPageDraft(event.currentTarget.value.replace(/[^0-9]/g, ""))}
              onBlur={() => {
                pageInputFocusedRef.current = false;
                commitPageDraft();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitPageDraft();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  setPageDraft(String(currentPage));
                  event.currentTarget.blur();
                }
              }}
            />
            <span aria-label={copy.pdfPagesLabel(numPages)}>/ {numPages || 0}</span>
          </div>
          <div className="toolbar-pdf-controls pdfjs-viewer-controls-small">
            <button
              ref={zoomMenuRef}
              type="button"
              className="typeset-zoom-label pdfjs-zoom-dropdown-button"
              title={copy.choosePdfZoom}
              aria-label={copy.pdfZoomLabel(Math.round(zoom * 100))}
              aria-haspopup="menu"
              aria-expanded={zoomMenuOpen}
              onClick={(event) => {
                if (zoomMenuOpen) {
                  setZoomMenuOpen(false);
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                setZoomDraft(String(Math.round(zoom * 100)));
                setZoomMenuPosition({
                  top: rect.bottom + 6,
                  right: Math.max(8, window.innerWidth - rect.right),
                });
                setZoomMenuOpen(true);
              }}
            >
              <span>{Math.round(zoom * 100)}%</span>
              <ToolIcon name="chevron" />
            </button>
          </div>
          {zoomMenuOpen && typeof document !== "undefined" && createPortal(
            <div
              ref={zoomMenuPopoverRef}
              className="typeset-zoom-menu"
              role="menu"
              aria-label={copy.pdfZoomMenu}
              style={zoomMenuPosition}
            >
              <form
                className="typeset-zoom-menu-input"
                onSubmit={(event) => {
                  event.preventDefault();
                  applyZoomDraft();
                }}
              >
                <input
                  value={zoomDraft}
                  inputMode="decimal"
                  aria-label={copy.pdfZoomPercentage}
                  onChange={(event) => setZoomDraft(event.currentTarget.value.replace(/[^0-9.]/g, ""))}
                />
                <span>%</span>
              </form>
              <button type="button" role="menuitem" onClick={() => void fitPdf("width")}>{copy.fitToWidth}</button>
              <button type="button" role="menuitem" onClick={() => void fitPdf("height")}>{copy.fitToHeight}</button>
              <div className="typeset-zoom-menu-divider" role="presentation" />
              {PDF_ZOOM_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  role="menuitemradio"
                  aria-checked={Math.round(zoom * 100) === Math.round(preset * 100)}
                  onClick={() => setZoomLevel(preset)}
                >
                  <span>{Math.round(preset * 100)}%</span>
                  {Math.round(zoom * 100) === Math.round(preset * 100) && <b aria-hidden="true"><SvgIcon name="check" size={14} /></b>}
                </button>
              ))}
            </div>,
            document.body,
          )}
          {/* The two SyncTeX directions as buttons, the way Overleaf shows
              them: the gestures (double-click either pane) stay, but a jump
              nobody can find is a jump nobody uses. */}
          <button
            type="button"
            className="typeset-icon-btn pdf-sync-to-pdf"
            title={copy.syncToPdf}
            aria-label={copy.syncToPdf}
            disabled={!path || !sourcePath}
            onClick={onSyncToPdf}
          >
            <ToolIcon name="syncToPdf" />
          </button>
          <button
            type="button"
            className="typeset-icon-btn pdf-sync-to-code"
            title={copy.syncToCode}
            aria-label={copy.syncToCode}
            disabled={!path}
            onClick={syncViewportToSource}
          >
            <ToolIcon name="syncToCode" />
          </button>
          <button
            type="button"
            className={`typeset-icon-btn pdf-present${presenting ? " active" : ""}`}
            title={presenting ? copy.exitPresentation : copy.presentPdf}
            aria-label={presenting ? copy.exitPresentation : copy.presentPdf}
            aria-pressed={presenting}
            disabled={!path}
            onClick={() => setPresenting((value) => !value)}
          >
            <ToolIcon name="visual" />
          </button>
          <button
            type="button"
            className={`typeset-icon-btn pdf-invert${inverted ? " active" : ""}`}
            title={inverted ? copy.restorePdfColors : copy.invertPdfColors}
            aria-label={inverted ? copy.restorePdfColors : copy.invertPdfColors}
            aria-pressed={inverted}
            disabled={!path}
            onClick={onToggleInverted}
          >
            <ToolIcon name="contrast" />
          </button>
          <button
            type="button"
            className="typeset-icon-btn pdf-export"
            title={copy.savePdfAs}
            aria-label={copy.savePdfAs}
            disabled={!path}
            onClick={onExportPdf}
          >
            <ToolIcon name="download" />
          </button>
          <button type="button" className="typeset-icon-btn pdf-open-external" title={copy.openPdfExternally} aria-label={copy.openPdfExternally} disabled={!path} onClick={() => path && void fileOpen(path)}>
            <ToolIcon name="open" />
          </button>
          {onHide && (
            <button type="button" className="typeset-icon-btn pdf-hide-preview" title={copy.hidePdfPreview} aria-label={copy.hidePdfPreview} onClick={onHide}>
              <ToolIcon name="next" />
            </button>
          )}
        </div>
      </div>
      <div
        className={`typeset-pdf-scroll${inverted ? " inverted" : ""}`}
        ref={scrollRef}
        // Clicking the PDF has to leave the keyboard *here*, or ArrowLeft /
        // ArrowRight keep editing text in the source pane instead of turning
        // the page. Not a tab stop: each page already exposes one.
        tabIndex={-1}
        onMouseDown={(event) => {
          if (event.currentTarget.contains(document.activeElement)) return;
          event.currentTarget.focus({ preventScroll: true });
        }}
        onScroll={scheduleVisiblePagesUpdate}
        onWheel={handlePdfWheel}
      >
        {!path && <div className="typeset-empty">{copy.noPdfSelected}</div>}
        {path && loading && <div className="typeset-empty">{copy.loadingPdf}</div>}
        {path && error ? (
          <PdfFallbackPage error={error} outputPath={path} sourcePath={sourcePath} />
        ) : (
          null
        )}
        {pdf && !error && Array.from({ length: numPages }, (_, index) => {
          const page = index + 1;
          const estimatedSize = pageSizes[page] ?? pageSizes[1] ?? { width: 612, height: 792 };
          if (page < renderRange.start || page > renderRange.end) {
            return (
              <div
                key={`${path}:${refreshKey}:${page}`}
                className="typeset-pdf-page typeset-pdf-page-placeholder"
                ref={pageRefFor(page)}
                style={{ width: `${estimatedSize.width * zoom}px`, height: `${estimatedSize.height * zoom}px` }}
                aria-label={copy.pdfPagePlaceholderLabel(page)}
              />
            );
          }
          const highlight = forwardTarget && forwardTarget.location.page === page
            ? {
                left: forwardTarget.location.boxLeft * zoom,
                top: forwardTarget.location.boxTop * zoom,
                width: forwardTarget.location.boxWidth * zoom,
                height: forwardTarget.location.boxHeight * zoom,
                nonce: forwardTarget.nonce,
              }
            : null;
          return (
            <PdfPage
              key={`${path}:${refreshKey}:${page}`}
              pdf={pdf}
              page={page}
              zoom={zoom}
              estimatedSize={estimatedSize}
              onSourceTextClick={onSourceTextClick}
              onPageSize={pageSizeCallbackFor(page)}
              pageRef={pageRefFor(page)}
              onPointConverter={registerPointConverter}
              onPdfLinkClick={followPdfLink}
              highlight={highlight}
            />
          );
        })}
      </div>
    </section>
  );
}
