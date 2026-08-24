import { useEffect, useRef } from "react";

/**
 * Writes the pointer position onto the element as `--px` / `--py` percentages so
 * CSS can render a spotlight that follows the cursor.
 *
 * Updates are coalesced into one rAF per frame, and the whole thing is skipped
 * for reduced motion and for coarse pointers (on touch there is no cursor to
 * follow, and the listener would only cost battery).
 */
export function usePointerGlow<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (window.matchMedia?.("(pointer: coarse)").matches) return;

    let frame = 0;
    let pending: { x: number; y: number } | null = null;

    const apply = () => {
      frame = 0;
      if (!pending) return;
      node.style.setProperty("--px", `${pending.x}%`);
      node.style.setProperty("--py", `${pending.y}%`);
      pending = null;
    };

    const onMove = (event: PointerEvent) => {
      const rect = node.getBoundingClientRect();
      pending = {
        x: ((event.clientX - rect.left) / rect.width) * 100,
        y: ((event.clientY - rect.top) / rect.height) * 100,
      };
      if (!frame) frame = requestAnimationFrame(apply);
    };

    node.addEventListener("pointermove", onMove);
    return () => {
      node.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return ref;
}
