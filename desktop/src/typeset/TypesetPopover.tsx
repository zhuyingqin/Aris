/**
 * A panel anchored to a toolbar button.
 *
 * It renders through a portal into `document.body` rather than next to its
 * trigger: the toolbar row is `overflow: hidden` (it has its own overflow
 * handling for narrow windows), so an absolutely-positioned child is clipped to
 * a 0×0 box. Overleaf's toolbar dropdowns are portalled for the same reason.
 *
 * Position is recomputed on scroll and resize because the trigger lives inside
 * a resizable, scrollable workbench.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export type PopoverAlign = "start" | "end";
export type PopoverSide = "bottom" | "right" | "top" | "left";

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

export function TypesetPopover({
  open,
  anchorRef,
  side = "bottom",
  align = "end",
  width,
  maxHeight,
  className = "",
  label,
  onClose,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  side?: PopoverSide;
  /** For side="bottom" or "top": `end` pins right edge to anchor's right.
   * For side="right" or "left": `end` pins bottom edge to anchor's bottom. */
  align?: PopoverAlign;
  width: number;
  maxHeight?: number;
  className?: string;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const height = (panelRef.current && panelRef.current.offsetHeight > 0 ? panelRef.current.offsetHeight : null) ?? maxHeight ?? 480;

    let top = 0;
    let left = 0;

    if (side === "right") {
      let rawLeft = rect.right + ANCHOR_GAP;
      if (rawLeft + width > window.innerWidth - VIEWPORT_MARGIN && rect.left - ANCHOR_GAP - width >= VIEWPORT_MARGIN) {
        rawLeft = rect.left - ANCHOR_GAP - width;
      }
      left = Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, window.innerWidth - width - VIEWPORT_MARGIN));

      const rawTop = align === "end" ? rect.bottom - height : rect.top;
      top = Math.max(VIEWPORT_MARGIN, Math.min(rawTop, window.innerHeight - height - VIEWPORT_MARGIN));
    } else if (side === "left") {
      let rawLeft = rect.left - ANCHOR_GAP - width;
      if (rawLeft < VIEWPORT_MARGIN && rect.right + ANCHOR_GAP + width <= window.innerWidth - VIEWPORT_MARGIN) {
        rawLeft = rect.right + ANCHOR_GAP;
      }
      left = Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, window.innerWidth - width - VIEWPORT_MARGIN));

      const rawTop = align === "end" ? rect.bottom - height : rect.top;
      top = Math.max(VIEWPORT_MARGIN, Math.min(rawTop, window.innerHeight - height - VIEWPORT_MARGIN));
    } else if (side === "top") {
      let rawTop = rect.top - ANCHOR_GAP - height;
      if (rawTop < VIEWPORT_MARGIN && rect.bottom + ANCHOR_GAP + height <= window.innerHeight - VIEWPORT_MARGIN) {
        rawTop = rect.bottom + ANCHOR_GAP;
      }
      top = Math.max(VIEWPORT_MARGIN, Math.min(rawTop, window.innerHeight - height - VIEWPORT_MARGIN));

      const rawLeft = align === "end" ? rect.right - width : rect.left;
      left = Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, window.innerWidth - width - VIEWPORT_MARGIN));
    } else {
      // side === "bottom"
      let rawTop = rect.bottom + ANCHOR_GAP;
      if (rawTop + height > window.innerHeight - VIEWPORT_MARGIN) {
        const topAbove = rect.top - ANCHOR_GAP - height;
        if (topAbove >= VIEWPORT_MARGIN) {
          rawTop = topAbove;
        }
      }
      top = Math.max(VIEWPORT_MARGIN, Math.min(rawTop, window.innerHeight - height - VIEWPORT_MARGIN));

      const rawLeft = align === "end" ? rect.right - width : rect.left;
      left = Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, window.innerWidth - width - VIEWPORT_MARGIN));
    }

    setPosition({ top, left });
  }, [align, anchorRef, maxHeight, side, width]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
    const node = panelRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      place();
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // The trigger toggles on its own click; treating it as "outside" here
      // would close and immediately reopen the panel.
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onReflow = () => place();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onReflow);
    // Capture phase: the workbench scrolls inner panes, not the window.
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [anchorRef, onClose, open, place]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      className={`typeset-popover ${className}`.trim()}
      role="dialog"
      aria-label={label}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        width,
        maxHeight,
        // Until the first measurement lands the panel would flash at 0,0.
        visibility: position ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
