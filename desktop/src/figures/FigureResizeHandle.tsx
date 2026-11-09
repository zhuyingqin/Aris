import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

type PanelSize = { width?: number; height?: number };
type Axis = "x" | "y" | "both";

/** Layout preferences stay local and are shared across figure tasks. */
export function useFigurePanelSize(name: string) {
  const key = `somniq.figure.layout.${name}`;
  const [size, setSize] = useState<PanelSize>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
      const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
      return { width: valid(saved?.width) ? saved.width : undefined, height: valid(saved?.height) ? saved.height : undefined };
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(size)); } catch { /* Resizing still works without storage. */ }
  }, [key, size]);
  return {
    size,
    style: { "--figure-panel-width": size.width === undefined ? undefined : `${size.width}px`, "--figure-panel-height": size.height === undefined ? undefined : `${size.height}px` } as CSSProperties,
    resize: (patch: PanelSize) => setSize((current) => ({ ...current, ...patch })),
    reset: () => setSize({}),
  };
}

interface Props {
  label: string; panelRef: RefObject<HTMLElement>; axis?: Axis; className?: string;
  directionX?: 1 | -1; directionY?: 1 | -1;
  minWidth?: number; minHeight?: number; reserveWidth?: number; reserveHeight?: number;
  onResize: (size: PanelSize) => void; onReset: () => void;
}

/** Pointer capture plus a shield keeps drags working across the SVG iframe. */
export default function FigureResizeHandle({ label, panelRef, axis = "x", className = "", directionX = 1, directionY = 1,
  minWidth = 220, minHeight = 160, reserveWidth = 320, reserveHeight = 12, onResize, onReset }: Props) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const resizeRef = useRef(onResize); resizeRef.current = onResize;
  useEffect(() => () => cleanupRef.current?.(), []);
  const clamp = (value: number, minimum: number, maximum: number) => Math.round(Math.max(Math.min(minimum, maximum), Math.min(value, maximum)));
  const measure = () => {
    const panel = panelRef.current;
    if (!panel?.parentElement) return null;
    const rect = panel.getBoundingClientRect(), bounds = panel.parentElement.getBoundingClientRect();
    const space = getComputedStyle(panel).position === "absolute" ? Math.min(reserveWidth, 40) : reserveWidth;
    return {
      rect,
      maxWidth: Math.max(0, (directionX === 1 ? bounds.right - rect.left : rect.right - bounds.left) - space),
      maxHeight: Math.max(0, (directionY === 1 ? bounds.bottom - rect.top : rect.bottom - bounds.top) - reserveHeight),
    };
  };
  const apply = (start: NonNullable<ReturnType<typeof measure>>, dx: number, dy: number) => {
    const patch: PanelSize = {};
    if (axis !== "y") patch.width = clamp(start.rect.width + dx * directionX, minWidth, start.maxWidth);
    if (axis !== "x") patch.height = clamp(start.rect.height + dy * directionY, minHeight, start.maxHeight);
    resizeRef.current(patch);
  };
  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const start = measure();
    if (!start) return;
    event.preventDefault(); event.stopPropagation(); cleanupRef.current?.();
    const handle = event.currentTarget, pointerId = event.pointerId, x = event.clientX, y = event.clientY;
    const body = document.body, cursor = body.style.cursor, userSelect = body.style.userSelect;
    const dragCursor = axis === "both" ? (directionX === directionY ? "nwse-resize" : "nesw-resize") : axis === "x" ? "col-resize" : "row-resize";
    const shield = document.createElement("div");
    shield.className = "figure-resize-shield"; shield.style.cursor = dragCursor;
    body.appendChild(shield); body.style.cursor = dragCursor; body.style.userSelect = "none";
    try { handle.setPointerCapture(pointerId); } catch { /* Window listeners cover WebViews without capture. */ }
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      next.preventDefault(); apply(start, next.clientX - x, next.clientY - y);
    };
    const end = (next: globalThis.PointerEvent) => { if (next.pointerId === pointerId) cleanup(); };
    const escape = (next: globalThis.KeyboardEvent) => { if (next.key === "Escape") cleanup(); };
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true); window.removeEventListener("blur", cleanup);
      document.removeEventListener("keydown", escape, true); handle.removeEventListener("lostpointercapture", cleanup);
      shield.remove(); body.style.cursor = cursor; body.style.userSelect = userSelect;
      cleanupRef.current = null;
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    };
    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", move, { capture: true, passive: false }); window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true); window.addEventListener("blur", cleanup);
    document.addEventListener("keydown", escape, true); handle.addEventListener("lostpointercapture", cleanup);
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home" || axis === "both" && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onReset(); return; }
    const step = event.shiftKey ? 64 : 24;
    const dx = axis !== "y" ? event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0 : 0;
    const dy = axis !== "x" ? event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0 : 0;
    if (!dx && !dy) return;
    const start = measure();
    if (start) { event.preventDefault(); apply(start, dx, dy); }
  };
  return <div className={`figure-resize-handle axis-${axis} ${className}`} role={axis === "both" ? "button" : "separator"}
    aria-label={label} aria-orientation={axis === "both" ? undefined : axis === "x" ? "vertical" : "horizontal"}
    tabIndex={0} onPointerDown={begin} onKeyDown={keyboard} onDoubleClick={onReset}><span aria-hidden /></div>;
}
