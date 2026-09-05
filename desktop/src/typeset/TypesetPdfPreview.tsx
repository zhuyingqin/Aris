// The read-only compiled-PDF surface: page virtualisation, zoom, search,
// outline navigation and the SyncTeX jump affordances around it.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { fileOpen, typesetOutputFiles, type SyncTexLocation, type TypesetOutputFile } from "../api/tauri";
import { openPdfDocumentFromPath } from "../pdf/runtime";
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
import { TypesetPopover } from "./TypesetPopover";
import {
  clampNumber,
  PDF_WHEEL_ZOOM_SETTLE_MS,
  PDF_ZOOM_MAX,
  PDF_ZOOM_MIN,
  PDF_ZOOM_PRESETS,
  type PdfPointConverter,
} from "./pdfGeometry";
import { PdfFallbackPage, PdfPage, type PdfClickPosition } from "./PdfPage";
import { fitToolbarActions } from "./pdfToolbarLayout";
import { ToolIcon } from "./ToolIcon";
import TypesetPdfPresentation from "./TypesetPdfPresentation";
import { setWindowFullscreen } from "../windowControls";

export type PdfForwardTarget = { location: SyncTexLocation; nonce: number };

/** One toolbar action, rendered either as an icon button or as a ⋯ menu row. */
type PdfToolbarAction = {
  key: string;
  /** Tooltip inline, visible text in the overflow menu. */
  label: string;
  icon: ReactNode;
  /** Kept from the pre-overflow markup: styling and tests hang off these. */
  className: string;
  disabled?: boolean;
  /** Toggles: pressed inline, ticked in the menu. */
  active?: boolean;
  /** Menu triggers, for `aria-expanded`. */
  expanded?: boolean;
  buttonRef?: MutableRefObject<HTMLButtonElement | null>;
  run: () => void;
};

/** Before the first measurement every action is inline; the fit only shrinks it. */
const ALL_ACTIONS_INLINE = Number.MAX_SAFE_INTEGER;

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
  /** Zip the project source to a path the user picks. */
  onExportProject?: () => void;
  onExportOutputFile?: (file: TypesetOutputFile) => void;
  onSyncToPdf?: () => void;
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

function readablePdfLoadError(loadError: unknown): string {
  if (loadError instanceof Error && loadError.message.trim()) return loadError.message.trim();
  if (typeof loadError === "string" && loadError.trim()) return loadError.trim();
  try {
    const serialized = JSON.stringify(loadError);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // Some native error values cannot be serialized; String() below is enough
    // to give the user an actionable fallback.
  }
  return String(loadError);
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
  onExportProject,
  onExportOutputFile,
  onToggleLog,
  onSourceTextClick,
  onHide: _onHide,
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
  // Download menu: the compiled PDF, the project source as a zip, and the
  // artifacts the run left behind — Overleaf's "other output files".
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [outputFiles, setOutputFiles] = useState<TypesetOutputFile[]>([]);
  const downloadButtonRef = useRef<HTMLButtonElement | null>(null);
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
  // Toolbar overflow: the actions that do not fit the row move into a ⋯ menu.
  const [actionFit, setActionFit] = useState(ALL_ACTIONS_INLINE);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [dismissedNoticeKeys, setDismissedNoticeKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (status === "running") {
      setDismissedNoticeKeys(new Set());
    }
  }, [status]);

  useEffect(() => {
    if (error) {
      setDismissedNoticeKeys((prev) => {
        const next = new Set(prev);
        next.delete("preview-error");
        return next;
      });
    }
  }, [error]);

  useEffect(() => {
    if (forwardSearchNotice) {
      setDismissedNoticeKeys((prev) => {
        const next = new Set(prev);
        next.delete("sync");
        return next;
      });
    }
  }, [forwardSearchNotice]);

  useEffect(() => {
    if (result) {
      setDismissedNoticeKeys((prev) => {
        const next = new Set(prev);
        next.delete("missing-pdf");
        next.delete("stale-pdf");
        next.delete("compile-error");
        return next;
      });
    }
  }, [result]);

  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarLeftRef = useRef<HTMLDivElement | null>(null);
  const toolbarStatusRef = useRef<HTMLDivElement | null>(null);
  const toolbarActionsRef = useRef<HTMLDivElement | null>(null);
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null);
  const pageInputRef = useRef<HTMLInputElement | null>(null);
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
  const programmaticPageRef = useRef<number | null>(null);
  const scrollSettleTimerRef = useRef<number | null>(null);
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

  const cancelProgrammaticScroll = useCallback(() => {
    programmaticPageRef.current = null;
    if (scrollSettleTimerRef.current !== null) {
      window.clearTimeout(scrollSettleTimerRef.current);
      scrollSettleTimerRef.current = null;
    }
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
    if (scrollSettleTimerRef.current !== null) window.clearTimeout(scrollSettleTimerRef.current);
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
    void openPdfDocumentFromPath(path)
      .then((document) => {
        loadedPdf = document;
        if (disposed) {
          void document.destroy();
          return;
        }
        if (document.numPages < 1) {
          void document.destroy();
          throw new Error("The PDF document contains no pages.");
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
        if (!disposed) setError(readablePdfLoadError(loadError));
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
    // Smooth navigation crosses every page between the current viewport and
    // its destination. Keep the explicitly requested page in the toolbar
    // during that animation instead of visibly counting through those
    // intermediate pages. Rendering still follows the real viewport below.
    const requestedPage = programmaticPageRef.current;
    if (requestedPage === null || requestedPage === nextPage) {
      if (requestedPage === nextPage) cancelProgrammaticScroll();
      currentPageRef.current = nextPage;
      setCurrentPage((page) => page === nextPage ? page : nextPage);
    }
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
  }, [cancelProgrammaticScroll, numPages, pdf, zoom]);

  const scheduleVisiblePagesUpdate = useCallback(() => {
    window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      updateVisiblePages();
    });
    if (programmaticPageRef.current === null) return;
    if (scrollSettleTimerRef.current !== null) window.clearTimeout(scrollSettleTimerRef.current);
    scrollSettleTimerRef.current = window.setTimeout(() => {
      scrollSettleTimerRef.current = null;
      programmaticPageRef.current = null;
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = 0;
        updateVisiblePages();
      });
    }, 160);
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
        cancelProgrammaticScroll();
        programmaticPageRef.current = forwardTarget.location.page;
        currentPageRef.current = forwardTarget.location.page;
        setCurrentPage(forwardTarget.location.page);
        setPageDraft(String(forwardTarget.location.page));
        const targetTop = pageEl.offsetTop + forwardTarget.location.pointY * zoom - scroll.clientHeight / 2;
        if (typeof scroll.scrollTo === "function") {
          scroll.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
        } else {
          scroll.scrollTop = Math.max(0, targetTop);
          cancelProgrammaticScroll();
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(frame1);
      window.cancelAnimationFrame(frame2);
    };
  }, [cancelProgrammaticScroll, forwardTarget, showPagesAround, zoom]);

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
    // A physical wheel gesture means the reader, not the previous toolbar or
    // keyboard request, owns the viewport from this point onward.
    cancelProgrammaticScroll();
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

  /** Human-readable size for the artifact list. */
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    cancelProgrammaticScroll();
    if (pageTop == null || !scroll) return;
    const top = Math.max(0, pageTop - 12);
    if (behavior === "smooth") programmaticPageRef.current = nextPage;
    if (typeof scroll.scrollTo === "function") scroll.scrollTo({ top, behavior });
    else {
      scroll.scrollTop = top;
      cancelProgrammaticScroll();
    }
  }, [cancelProgrammaticScroll, numPages, pageTopFor, showPagesAround]);

  useEffect(() => {
    if (!downloadOpen || !path) return;
    let active = true;
    void typesetOutputFiles(path)
      .then((files) => {
        if (active) setOutputFiles(files);
      })
      .catch(() => {
        if (active) setOutputFiles([]);
      });
    return () => {
      active = false;
    };
  }, [downloadOpen, path, refreshKey]);

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

  const handleTogglePresentation = useCallback(() => {
    setPresenting((prev) => {
      const next = !prev;
      if (next) {
        void setWindowFullscreen(true);
      } else {
        void setWindowFullscreen(false);
      }
      return next;
    });
  }, []);

  const handlePresentationClose = useCallback(() => {
    void setWindowFullscreen(false);
    setPresenting(false);
  }, []);

  const handlePresentationPageChange = useCallback((nextPage: number) => {
    scrollToPage(nextPage);
  }, [scrollToPage]);

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
  const previewStatusText = error
    ? copy.previewUnavailable(error)
    : loading
      ? copy.loadingPdf
      : null;

  // Alerts after compile or document loading pop up as a dismissible 提示条 (Notice Bar)
  const bannerNotices: { key: string; tone: "error" | "warning" | "success" | "info"; text: string; title?: string }[] = [];
  if (previewStatusText && error) {
    bannerNotices.push({
      key: "preview-error",
      tone: "error",
      text: previewStatusText,
      title: error,
    });
  }
  if (result?.pdfState === "missing") {
    bannerNotices.push({
      key: "missing-pdf",
      tone: "error",
      text: copy.noPdfProduced,
    });
  }
  if (result?.pdfState === "stale") {
    bannerNotices.push({
      key: "stale-pdf",
      tone: "warning",
      text: copy.showingLastVerified,
    });
  }
  if (forwardSearchNotice) {
    bannerNotices.push({
      key: "sync",
      tone: "warning",
      text: forwardSearchNotice,
    });
  }
  if (status === "error" && statusText) {
    bannerNotices.push({
      key: "compile-error",
      tone: "error",
      text: statusText,
    });
  }

  const activeNotice = bannerNotices.find((notice) => !dismissedNoticeKeys.has(notice.key));

  // The toolbar strip shows compact live compiler state (e.g. running, unsaved changes, or clean success duration)
  const toolbarStatuses: { key: string; tone: string; text: string; live: boolean; title?: string }[] = [];
  if (dirty) {
    toolbarStatuses.push({ key: "dirty", tone: "idle", text: copy.unsavedChanges, live: false });
  } else if (status === "running") {
    toolbarStatuses.push({ key: "running", tone: "running", text: statusText, live: true });
  } else if (status === "success" && statusText) {
    toolbarStatuses.push({ key: "compile", tone: "success", text: statusText, live: false });
  }

  // Display order, which read backwards is also the order the actions give up
  // their slot when the pane narrows.
  const toolbarActions: PdfToolbarAction[] = [
    {
      key: "present",
      label: presenting ? copy.exitPresentation : copy.presentPdf,
      icon: <ToolIcon name="presentation" />,
      className: "pdf-present",
      disabled: !path,
      active: presenting,
      run: handleTogglePresentation,
    },
    {
      key: "invert",
      label: inverted ? copy.restorePdfColors : copy.invertPdfColors,
      icon: <ToolIcon name="contrast" />,
      className: "pdf-invert",
      disabled: !path,
      active: inverted,
      run: onToggleInverted,
    },
    {
      key: "download",
      label: copy.downloadMenu,
      icon: <ToolIcon name="download" />,
      className: "pdf-export",
      disabled: !path,
      expanded: downloadOpen,
      buttonRef: downloadButtonRef,
      run: () => setDownloadOpen((open) => !open),
    },
    {
      key: "open-external",
      label: copy.openPdfExternally,
      icon: <ToolIcon name="open" />,
      className: "pdf-open-external",
      disabled: !path,
      run: () => path && void fileOpen(path),
    },
  ];

  const actionCount = toolbarActions.length;
  const inlineActions = toolbarActions.slice(0, actionFit);
  const collapsedActions = toolbarActions.slice(actionFit);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const left = toolbarLeftRef.current;
    const actions = toolbarActionsRef.current;
    if (!toolbar || !left || !actions) return;

    const measure = () => {
      const available = toolbar.clientWidth;
      let base = left.offsetWidth;
      for (const child of Array.from(actions.children)) {
        if (!(child as HTMLElement).classList.contains("typeset-pdf-action")) {
          base += (child as HTMLElement).offsetWidth;
        }
      }
      const fit = fitToolbarActions({ total: actionCount, available, base });
      setActionFit((current) => (current === fit ? current : fit));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    observer.observe(left);
    observer.observe(actions);
    return () => observer.disconnect();
  }, [actionCount, actionFit]);

  useEffect(() => {
    if (overflowOpen && collapsedActions.length === 0) setOverflowOpen(false);
  }, [collapsedActions.length, overflowOpen]);

  return (
    <section
      className={`typeset-preview pdf${!path ? " pdf-empty" : ""}${presenting ? " presenting" : ""}${activeNotice ? " has-notice" : ""}`}
      aria-label={copy.pdfPreviewLabel}
      aria-keyshortcuts="ArrowLeft ArrowRight"
    >
      <div className="typeset-preview-toolbar toolbar toolbar-pdf toolbar-pdf-hybrid" ref={toolbarRef}>
        <div className="typeset-pdf-left toolbar-pdf-left" ref={toolbarLeftRef}>
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
          {toolbarStatuses.length > 0 && (
            <div className="typeset-pdf-status-strip" ref={toolbarStatusRef}>
              {toolbarStatuses.map((item) => (
                <span
                  key={item.key}
                  className={`typeset-pdf-status ${item.tone}`}
                  role="status"
                  title={item.title}
                >
                  {item.text}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="typeset-preview-actions toolbar-pdf-right" ref={toolbarActionsRef}>
          <span className="typeset-preview-file" title={path ?? ""}>{path ? basename(path) : copy.preview}</span>
          <div className="typeset-pdf-page-control" aria-label={copy.pdfPageNavigationLabel}>
            <button
              type="button"
              className="typeset-pdf-step-btn prev-page"
              title={copy.previousPage}
              aria-label={copy.previousPage}
              disabled={numPages < 1 || currentPage <= 1}
              onClick={() => scrollToPage(currentPage - 1, "smooth")}
            >
              <ToolIcon name="previous" />
            </button>
            <input
              ref={pageInputRef}
              type="text"
              inputMode="numeric"
              value={numPages > 0 ? pageDraft : ""}
              placeholder={numPages > 0 ? undefined : "—"}
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
            <span aria-label={copy.pdfPagesLabel(numPages)}>
              {numPages > 0 ? "/ " + numPages : "— / 0"}
            </span>
            <button
              type="button"
              className="typeset-pdf-step-btn next-page"
              title={copy.nextPage}
              aria-label={copy.nextPage}
              disabled={numPages < 1 || currentPage >= numPages}
              onClick={() => scrollToPage(currentPage + 1, "smooth")}
            >
              <ToolIcon name="next" />
            </button>
          </div>
          <div className="toolbar-pdf-controls pdfjs-viewer-controls-small">
            <button
              type="button"
              className="typeset-pdf-step-btn zoom-out"
              title={copy.zoomOut}
              aria-label="Zoom out PDF preview"
              disabled={numPages < 1 || zoom <= PDF_ZOOM_MIN}
              onClick={() => setZoomLevel(zoom - 0.15)}
            >
              <ToolIcon name="minus" />
            </button>
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
            <button
              type="button"
              className="typeset-pdf-step-btn zoom-in"
              title={copy.zoomIn}
              aria-label="Zoom in PDF preview"
              disabled={numPages < 1 || zoom >= PDF_ZOOM_MAX}
              onClick={() => setZoomLevel(zoom + 0.15)}
            >
              <ToolIcon name="plus" />
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
          {inlineActions.map((action) => (
            <button
              key={action.key}
              ref={action.buttonRef}
              type="button"
              className={`typeset-icon-btn typeset-pdf-action ${action.className}${action.active ? " active" : ""}`}
              title={action.label}
              aria-label={action.label}
              aria-pressed={action.active}
              aria-expanded={action.expanded}
              disabled={action.disabled}
              onClick={action.run}
            >
              {action.icon}
            </button>
          ))}
          {collapsedActions.length > 0 && (
            <button
              ref={overflowButtonRef}
              type="button"
              className={`typeset-icon-btn typeset-pdf-action pdf-more${overflowOpen ? " active" : ""}`}
              title={copy.moreToolbarActions}
              aria-label={copy.moreToolbarActions}
              aria-expanded={overflowOpen}
              onClick={() => setOverflowOpen((open) => !open)}
            >
              <ToolIcon name="more" />
            </button>
          )}
          <TypesetPopover
            open={overflowOpen && collapsedActions.length > 0}
            anchorRef={overflowButtonRef}
            align="end"
            width={248}
            className="typeset-overflow-menu"
            label={copy.moreToolbarActionsMenu}
            onClose={() => setOverflowOpen(false)}
          >
            {collapsedActions.map((action) => (
              <button
                key={action.key}
                type="button"
                className={`typeset-overflow-item${action.active ? " active" : ""}`}
                disabled={action.disabled}
                onClick={() => {
                  setOverflowOpen(false);
                  action.run();
                }}
              >
                <span className="typeset-overflow-icon" aria-hidden="true">{action.icon}</span>
                <span>{action.label}</span>
                {action.active && <b aria-hidden="true"><SvgIcon name="check" size={14} /></b>}
              </button>
            ))}
          </TypesetPopover>
          <TypesetPopover
            open={downloadOpen}
            anchorRef={downloadButtonRef}
            align="end"
            width={264}
            className="typeset-download-menu"
            label={copy.downloadMenu}
            onClose={() => setDownloadOpen(false)}
          >
            <button
              type="button"
              onClick={() => {
                setDownloadOpen(false);
                onExportPdf();
              }}
            >
              {copy.savePdfAs}
            </button>
            <button
              type="button"
              onClick={() => {
                setDownloadOpen(false);
                if (onExportProject) onExportProject();
              }}
            >
              {copy.downloadProject}
            </button>
            <div className="typeset-download-menu-section">{copy.otherOutputFiles}</div>
            {outputFiles.length === 0 ? (
              <p className="typeset-download-menu-empty">{copy.noOutputFiles}</p>
            ) : (
              outputFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className="typeset-download-menu-file"
                  onClick={() => {
                    setDownloadOpen(false);
                    if (onExportOutputFile) onExportOutputFile(file);
                  }}
                >
                  <span>{file.name}</span>
                  <em>{formatFileSize(file.bytes)}</em>
                </button>
              ))
            )}
          </TypesetPopover>
        </div>
      </div>
      {activeNotice && (
        <aside
          className={`typeset-pdf-notice-bar ${activeNotice.tone}`}
          role="status"
          aria-live="polite"
        >
          <div className="typeset-pdf-notice-main">
            <span className={`typeset-pdf-status ${activeNotice.tone}`} title={activeNotice.title}>
              <SvgIcon
                name={activeNotice.tone === "error" ? "error" : "helpCircle"}
                size={16}
                className="typeset-pdf-notice-icon"
              />
              <span className="typeset-pdf-notice-text">{activeNotice.text}</span>
            </span>
          </div>
          <button
            type="button"
            className="typeset-pdf-notice-close-btn"
            onClick={() => {
              setDismissedNoticeKeys((prev) => new Set(prev).add(activeNotice.key));
            }}
            title={copy.dismissNotice}
            aria-label={copy.dismissNotice}
          >
            <SvgIcon name="close" size={14} />
          </button>
        </aside>
      )}
      <div
        className={`typeset-pdf-scroll${inverted ? " inverted" : ""}`}
        ref={scrollRef}
        // Clicking the PDF has to leave the keyboard *here*, or ArrowLeft /
        // ArrowRight keep editing text in the source pane instead of turning
        // the page. Not a tab stop: each page already exposes one.
        tabIndex={-1}
        onPointerDown={(event) => {
          event.stopPropagation();
          cancelProgrammaticScroll();
        }}
        onTouchStart={(event) => {
          event.stopPropagation();
          cancelProgrammaticScroll();
        }}
        onTouchMove={(event) => event.stopPropagation()}
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
      {presenting && pdf && typeof document !== "undefined" && createPortal(
        <TypesetPdfPresentation
          pdf={pdf}
          numPages={numPages}
          currentPage={currentPage}
          pageSizes={pageSizes}
          inverted={inverted}
          language={language}
          onToggleInverted={onToggleInverted}
          onPageChange={handlePresentationPageChange}
          onClose={handlePresentationClose}
        />,
        document.body,
      )}
    </section>
  );
}
