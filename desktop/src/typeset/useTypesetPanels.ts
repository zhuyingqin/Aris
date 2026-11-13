// Panel layout for the Typeset shell: the three resizable regions (project
// tree, PDF preview, outline) and the pointer/keyboard gestures that size them.
// Extracted from Typeset.tsx, where 6 pieces of state, 4 refs and ~190 lines of
// pointer bookkeeping sat inline among the compile and document logic.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { OUTLINE_PANEL_DEFAULT_H, OUTLINE_PANEL_MAX_H, OUTLINE_PANEL_MIN_H } from "./TypesetOutlinePanel";
import { clampNumber } from "./pdfGeometry";

const PROJECT_PANEL_DEFAULT_W = 204;
const CHAT_PANEL_DEFAULT_W = 360;
const PROJECT_PANEL_MIN_W = 136;
const PROJECT_PANEL_MAX_W = 720;
const PDF_PANEL_DEFAULT_W = 640;
const PDF_PANEL_MIN_W = 220;
const PDF_PANEL_MAX_W = 1040;

export type TypesetResizeAxis = "x" | "y";
export type TypesetResizePanel = "project" | "pdf";

function resizeAxisForTarget(target: HTMLElement): TypesetResizeAxis {
  const rect = target.getBoundingClientRect();
  return rect.width > rect.height ? "y" : "x";
}

function coordinateForAxis(axis: TypesetResizeAxis, event: { clientX: number; clientY: number }): number {
  return axis === "y" ? event.clientY : event.clientX;
}

function renderedPanelSize(panel: TypesetResizePanel, divider: HTMLElement): number {
  const surface = panel === "project" ? divider.previousElementSibling : divider.nextElementSibling;
  const rect = surface?.getBoundingClientRect();
  return rect ? (resizeAxisForTarget(divider) === "y" ? rect.height : rect.width) : 0;
}

export function useTypesetPanels(chatPanel = false) {
  const [projectPanelVisible, updateProjectPanelVisible] = useState(true);
  const [pdfPanelVisible, updatePdfPanelVisible] = useState(true);
  // Focus is an overlay on the user's layout, so restoring it keeps panel
  // visibility and manually resized widths exactly as they were.
  const [editorFocused, setEditorFocused] = useState(false);
  const toggleEditorFocus = useCallback(() => setEditorFocused((focused) => !focused), []);
  const setProjectPanelVisible = useCallback((visible: boolean) => {
    setEditorFocused(false);
    updateProjectPanelVisible(visible);
  }, []);
  const setPdfPanelVisible = useCallback((visible: boolean) => {
    setEditorFocused(false);
    updatePdfPanelVisible(visible);
  }, []);
  const [filePanelWidth, setFilePanelWidth] = useState(PROJECT_PANEL_DEFAULT_W);
  const [chatPanelWidth, setChatPanelWidth] = useState(CHAT_PANEL_DEFAULT_W);
  const [chatPanelResized, setChatPanelResized] = useState(false);
  const [pdfPanelResized, setPdfPanelResized] = useState(false);
  // Reading a conversation needs more room than browsing a file tree. Keep each
  // width while switching tabs, including explicit pointer and keyboard changes.
  const projectPanelWidth = chatPanel ? chatPanelWidth : filePanelWidth;
  const setProjectPanelWidth = chatPanel ? setChatPanelWidth : setFilePanelWidth;
  const [pdfPanelWidth, setPdfPanelWidth] = useState(PDF_PANEL_DEFAULT_W);
  const [outlinePanelHeight, setOutlinePanelHeight] = useState<number | null>(null);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);

  const projectPanelWidthRef = useRef(projectPanelWidth);
  const pdfPanelWidthRef = useRef(pdfPanelWidth);
  const outlinePanelHeightRef = useRef<number | null>(outlinePanelHeight);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  projectPanelWidthRef.current = projectPanelWidth;
  pdfPanelWidthRef.current = pdfPanelWidth;
  outlinePanelHeightRef.current = outlinePanelHeight;

  const beginPanelResize = useCallback((
    panel: TypesetResizePanel,
    axis: TypesetResizeAxis,
    clientX: number,
    clientY: number,
    renderedSize: number,
  ) => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    resizeCleanupRef.current?.();

    const startCoord = coordinateForAxis(axis, { clientX, clientY });
    const startSize = renderedSize > 0 ? renderedSize : panel === "project" ? projectPanelWidthRef.current : pdfPanelWidthRef.current;
    const root = document.documentElement;
    const body = document.body;
    const resizingClass = axis === "y" ? "typeset-resizing-y" : "typeset-resizing-x";
    const cursor = axis === "y" ? "row-resize" : "col-resize";
    const previousBodyCursor = body.style.cursor;
    const previousBodyUserSelect = body.style.userSelect;
    const captureOptions: AddEventListenerOptions = { capture: true };
    const pointerMoveOptions: AddEventListenerOptions = { capture: true, passive: false };
    let active = true;

    const applyMove = (moveClientX: number, moveClientY: number) => {
      const delta = coordinateForAxis(axis, { clientX: moveClientX, clientY: moveClientY }) - startCoord;
      if (panel === "project") {
        if (chatPanel) setChatPanelResized(true);
        setProjectPanelWidth(clampNumber(startSize + delta, PROJECT_PANEL_MIN_W, PROJECT_PANEL_MAX_W));
        return;
      }
      setPdfPanelResized(true);
      setPdfPanelWidth(clampNumber(startSize - delta, PDF_PANEL_MIN_W, PDF_PANEL_MAX_W));
    };

    const cleanup = () => {
      if (!active) return;
      active = false;
      window.removeEventListener("pointermove", onPointerMove, pointerMoveOptions);
      window.removeEventListener("pointerup", cleanup, captureOptions);
      window.removeEventListener("pointercancel", cleanup, captureOptions);
      window.removeEventListener("mousemove", onMouseMove, captureOptions);
      window.removeEventListener("mouseup", cleanup, captureOptions);
      window.removeEventListener("blur", cleanup);
      document.removeEventListener("keydown", onEscape, captureOptions);
      root.classList.remove(resizingClass);
      body.style.cursor = previousBodyCursor;
      body.style.userSelect = previousBodyUserSelect;
      if (resizeCleanupRef.current === cleanup) {
        resizeCleanupRef.current = null;
      }
    };

    const prevent = (event: Event) => {
      if (event.cancelable) event.preventDefault();
    };

    function onMouseMove(event: MouseEvent) {
      prevent(event);
      applyMove(event.clientX, event.clientY);
    }

    function onPointerMove(event: PointerEvent) {
      prevent(event);
      applyMove(event.clientX, event.clientY);
    }

    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        cleanup();
      }
    }

    root.classList.add(resizingClass);
    body.style.cursor = cursor;
    body.style.userSelect = "none";
    resizeCleanupRef.current = cleanup;

    window.addEventListener("pointermove", onPointerMove, pointerMoveOptions);
    window.addEventListener("pointerup", cleanup, captureOptions);
    window.addEventListener("pointercancel", cleanup, captureOptions);
    window.addEventListener("mousemove", onMouseMove, captureOptions);
    window.addEventListener("mouseup", cleanup, captureOptions);
    window.addEventListener("blur", cleanup);
    document.addEventListener("keydown", onEscape, captureOptions);
  }, [chatPanel, setProjectPanelWidth]);

  const beginPanelResizeFromPointer = useCallback((panel: TypesetResizePanel, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    beginPanelResize(panel, resizeAxisForTarget(event.currentTarget), event.clientX, event.clientY, renderedPanelSize(panel, event.currentTarget));
  }, [beginPanelResize]);

  const beginOutlineResizeFromPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (typeof document === "undefined" || typeof window === "undefined") return;
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();

    const startY = event.clientY;
    const measuredHeight = event.currentTarget.nextElementSibling?.getBoundingClientRect().height ?? 0;
    const startHeight = outlinePanelHeightRef.current ?? (measuredHeight > 0 ? measuredHeight : OUTLINE_PANEL_DEFAULT_H);
    const root = document.documentElement;
    const body = document.body;
    const previousBodyCursor = body.style.cursor;
    const previousBodyUserSelect = body.style.userSelect;
    const captureOptions: AddEventListenerOptions = { capture: true };
    const pointerMoveOptions: AddEventListenerOptions = { capture: true, passive: false };
    let active = true;

    const applyMove = (clientY: number) => {
      const delta = clientY - startY;
      setOutlinePanelHeight(clampNumber(startHeight - delta, OUTLINE_PANEL_MIN_H, OUTLINE_PANEL_MAX_H));
    };

    const cleanup = () => {
      if (!active) return;
      active = false;
      window.removeEventListener("pointermove", onPointerMove, pointerMoveOptions);
      window.removeEventListener("pointerup", cleanup, captureOptions);
      window.removeEventListener("pointercancel", cleanup, captureOptions);
      window.removeEventListener("mousemove", onMouseMove, captureOptions);
      window.removeEventListener("mouseup", cleanup, captureOptions);
      window.removeEventListener("blur", cleanup);
      document.removeEventListener("keydown", onEscape, captureOptions);
      root.classList.remove("typeset-resizing-y");
      body.style.cursor = previousBodyCursor;
      body.style.userSelect = previousBodyUserSelect;
      if (resizeCleanupRef.current === cleanup) {
        resizeCleanupRef.current = null;
      }
    };

    const prevent = (moveEvent: Event) => {
      if (moveEvent.cancelable) moveEvent.preventDefault();
    };

    function onMouseMove(moveEvent: MouseEvent) {
      prevent(moveEvent);
      applyMove(moveEvent.clientY);
    }

    function onPointerMove(moveEvent: PointerEvent) {
      prevent(moveEvent);
      applyMove(moveEvent.clientY);
    }

    function onEscape(keyEvent: KeyboardEvent) {
      if (keyEvent.key === "Escape") cleanup();
    }

    root.classList.add("typeset-resizing-y");
    body.style.cursor = "row-resize";
    body.style.userSelect = "none";
    resizeCleanupRef.current = cleanup;

    window.addEventListener("pointermove", onPointerMove, pointerMoveOptions);
    window.addEventListener("pointerup", cleanup, captureOptions);
    window.addEventListener("pointercancel", cleanup, captureOptions);
    window.addEventListener("mousemove", onMouseMove, captureOptions);
    window.addEventListener("mouseup", cleanup, captureOptions);
    window.addEventListener("blur", cleanup);
    document.addEventListener("keydown", onEscape, captureOptions);
  }, []);

  useEffect(() => () => {
    resizeCleanupRef.current?.();
  }, []);

  const handlePanelResizeKey = useCallback((panel: TypesetResizePanel, event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 16;
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const measured = event.currentTarget ? renderedPanelSize(panel, event.currentTarget) : 0;
    if (panel === "project") {
      if (chatPanel) setChatPanelResized(true);
      setProjectPanelWidth((width) => clampNumber((measured || width) + direction * step, PROJECT_PANEL_MIN_W, PROJECT_PANEL_MAX_W));
      return;
    }
    setPdfPanelResized(true);
    setPdfPanelWidth((width) => clampNumber((measured || width) - direction * step, PDF_PANEL_MIN_W, PDF_PANEL_MAX_W));
  }, [chatPanel, setProjectPanelWidth]);

  const handleOutlineResizeKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 16;
    const direction = event.key === "ArrowUp" ? 1 : -1;
    const measuredHeight = event.currentTarget.nextElementSibling?.getBoundingClientRect().height ?? 0;
    setOutlinePanelHeight((height) => clampNumber(
      (height ?? (measuredHeight > 0 ? measuredHeight : OUTLINE_PANEL_DEFAULT_H)) + direction * step,
      OUTLINE_PANEL_MIN_H,
      OUTLINE_PANEL_MAX_H,
    ));
  }, []);
  return {
    editorFocused,
    toggleEditorFocus,
    chatPanelResized,
    pdfPanelResized,
    projectPanelVisible,
    setProjectPanelVisible,
    pdfPanelVisible,
    setPdfPanelVisible,
    projectPanelWidth,
    pdfPanelWidth,
    outlinePanelHeight,
    setOutlinePanelHeight,
    outlineCollapsed,
    setOutlineCollapsed,
    beginPanelResizeFromPointer,
    beginOutlineResizeFromPointer,
    handlePanelResizeKey,
    handleOutlineResizeKey,
  };
}
