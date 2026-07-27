import { useEffect, useRef } from "react";
import type { RefObject } from "react";

function isEditableTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  return node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable;
}

/**
 * Scopes Ctrl/Cmd+A to `containerRef` instead of the whole document. Without
 * this, pressing select-all while reading the conversation (nothing
 * focusable under the cursor) falls through to the browser default of
 * selecting the entire window, sweeping in the session sidebar and other
 * chrome along with the chat text. Native select-all inside a focused
 * input/textarea (e.g. the composer) is left untouched.
 */
export function useScopedSelectAll(containerRef: RefObject<HTMLElement | null>) {
  const lastPointerInside = useRef(false);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const container = containerRef.current;
      lastPointerInside.current = Boolean(container && container.contains(event.target as Node));
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const isSelectAll = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey
        && event.key.toLowerCase() === "a";
      if (!isSelectAll || isEditableTarget(event.target)) return;

      const container = containerRef.current;
      if (!container) return;
      const focusInside = document.activeElement != null
        && document.activeElement !== document.body
        && container.contains(document.activeElement);
      if (!focusInside && !lastPointerInside.current) return;

      event.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(container);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };

    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [containerRef]);
}
