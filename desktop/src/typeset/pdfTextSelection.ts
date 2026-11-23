import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

type TextPoint = { node: Text; offset: number };
type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** Pages participating in a real selection must survive preview virtualization
 * after mouseup as well, until the reader clears or replaces that selection. */
export function selectedPdfPageRange(scroll: HTMLElement): { start: number; end: number } | null {
  const selection = scroll.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const pageNumber = (node: Node | null) => {
    if (!node || !scroll.contains(node)) return null;
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    const value = Number(element?.closest<HTMLElement>(".typeset-pdf-page")?.dataset.pdfPage);
    return Number.isInteger(value) && value > 0 ? value : null;
  };
  const anchor = pageNumber(selection.anchorNode);
  const focus = pageNumber(selection.focusNode);
  return anchor && focus ? { start: Math.min(anchor, focus), end: Math.max(anchor, focus) } : null;
}

function selectionLayerAtPosition(origin: HTMLElement, x: number, y: number): HTMLElement {
  const doc = origin.ownerDocument;
  const hit = doc.elementFromPoint?.(x, y)?.closest(".typeset-pdf-page")
    ?.querySelector<HTMLElement>(".typeset-pdf-text-layer.reading");
  if (hit) return hit;
  let nearest = origin;
  let distance = Number.POSITIVE_INFINITY;
  const surface = origin.closest(".typeset-pdf-scroll") ?? doc;
  for (const layer of surface.querySelectorAll<HTMLElement>(".typeset-pdf-text-layer.reading")) {
    const bounds = layer.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    const dy = Math.max(bounds.top - y, 0, y - bounds.bottom);
    if (dy < distance) {
      nearest = layer;
      distance = dy;
    }
  }
  return nearest;
}

/** Absolute PDF items have no normal text flow. In their gaps the browser can
 * place a caret at an unrelated DOM child, so resolve the nearest item first. */
export function pdfTextPointAtPosition(layer: HTMLElement, clientX: number, clientY: number): TextPoint | null {
  const doc = layer.ownerDocument as CaretDocument;
  const hit = doc.elementFromPoint?.(clientX, clientY)?.closest<HTMLElement>(".typeset-pdf-text-run.reading");
  let nearest: HTMLElement | null = hit && layer.contains(hit) ? hit : null;
  let distance = Number.POSITIVE_INFINITY;
  for (const run of nearest ? [] : layer.querySelectorAll<HTMLElement>(".typeset-pdf-text-run.reading")) {
    const bounds = run.getBoundingClientRect();
    if (!run.firstChild || bounds.width <= 0 || bounds.height <= 0) continue;
    const dx = Math.max(bounds.left - clientX, 0, clientX - bounds.right);
    const dy = Math.max(bounds.top - clientY, 0, clientY - bounds.bottom);
    const next = dx * dx + dy * dy;
    if (next < distance) {
      nearest = run;
      distance = next;
      if (next === 0) break;
    }
  }
  const node = nearest?.firstChild;
  if (!nearest || node?.nodeType !== 3) return null;
  const text = node as Text;
  const bounds = nearest.getBoundingClientRect();
  if (clientX <= bounds.left) return { node: text, offset: 0 };
  if (clientX >= bounds.right) return { node: text, offset: text.length };

  // Ask the browser for the character boundary in the scaled span. It knows
  // actual glyph widths, unlike a character-count/width approximation.
  const y = (bounds.top + bounds.bottom) / 2;
  const caret = doc.caretPositionFromPoint?.(clientX, y);
  if (caret?.offsetNode === text) return { node: text, offset: caret.offset };
  const range = doc.caretRangeFromPoint?.(clientX, y);
  if (range?.startContainer === text) return { node: text, offset: range.startOffset };
  return { node: text, offset: Math.round(text.length * (clientX - bounds.left) / bounds.width) };
}

/** Keep the browser's real Selection (and normal copy) while giving its
 * endpoints PDF-aware hit testing. Only primary mouse gestures are handled;
 * touch selection and double-click inverse search keep their own behavior. */
export function usePdfTextSelection(layerRef: RefObject<HTMLDivElement>, onDrag: () => void) {
  const dragRef = useRef<{
    anchor: TextPoint;
    layer: HTMLElement;
    startX: number;
    startY: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  useEffect(() => {
    let frame = 0;
    const extend = () => {
      const drag = dragRef.current;
      if (!drag?.moved || !drag.anchor.node.isConnected) return;
      const doc = drag.layer.ownerDocument;
      const layer = selectionLayerAtPosition(drag.layer, drag.x, drag.y);
      const focus = pdfTextPointAtPosition(layer, drag.x, drag.y);
      if (focus) doc.getSelection()?.setBaseAndExtent(drag.anchor.node, drag.anchor.offset, focus.node, focus.offset);
    };
    const autoScroll = () => {
      frame = 0;
      const drag = dragRef.current;
      if (!drag?.moved) return;
      const doc = drag.layer.ownerDocument;
      const pane = drag.layer.closest<HTMLElement>(".typeset-pdf-scroll");
      const scroller = pane ?? doc.scrollingElement;
      if (!scroller) return;
      const bounds = pane?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
      if (drag.x >= bounds.left && drag.x <= bounds.right) {
        const edge = Math.min(32, (bounds.bottom - bounds.top) / 4);
        const velocity = drag.y < bounds.top + edge
          ? -Math.min(18, (bounds.top + edge - drag.y) * 0.6)
          : drag.y > bounds.bottom - edge ? Math.min(18, (drag.y - bounds.bottom + edge) * 0.6) : 0;
        if (velocity) {
          scroller.scrollTop += velocity;
          extend();
        }
      }
      frame = window.requestAnimationFrame(autoScroll);
    };
    const move = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 4) {
        drag.moved = true;
        onDragRef.current();
      }
      if (!drag.moved) return;
      event.preventDefault();
      extend();
      if (!frame) frame = window.requestAnimationFrame(autoScroll);
    };
    const finish = () => {
      dragRef.current = null;
      window.cancelAnimationFrame(frame);
      frame = 0;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    return () => {
      finish();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
  }, []);

  return (event: ReactMouseEvent<HTMLElement>) => {
    dragRef.current = null;
    const layer = layerRef.current;
    if (event.button !== 0 || event.detail > 1 || !layer?.contains(event.target as Node)) return;
    const focus = pdfTextPointAtPosition(layer, event.clientX, event.clientY);
    const selection = layer.ownerDocument.getSelection();
    if (!focus || !selection) return;
    const currentAnchor = selection.anchorNode;
    const anchor = event.shiftKey && currentAnchor?.nodeType === 3
      && currentAnchor.parentElement?.closest(".typeset-pdf-text-layer.reading")
      ? { node: currentAnchor as Text, offset: selection.anchorOffset } : focus;
    // Prevent native gap hit testing and native text drag-and-drop from
    // replacing the anchor or stealing a second selection gesture.
    event.preventDefault();
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    dragRef.current = { anchor, layer, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, moved: false };
  };
}
