import { useEffect } from "react";

const REVEALED = "is-revealed";

/**
 * Fades `[data-reveal]` elements in as they scroll into view.
 *
 * Visibility must never depend on a callback that might not fire. Two escapes
 * from a blank page:
 *   - `prefers-reduced-motion` / no IntersectionObserver → the hiding class is
 *     never added at all, so everything renders immediately;
 *   - anything already at or near the viewport is revealed synchronously, so a
 *     throttled or non-compositing tab (background, hidden pane) still paints
 *     the fold even though IntersectionObserver stays silent.
 */
export function useReveal(deps: unknown[] = []): void {
  useEffect(() => {
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduceMotion || typeof IntersectionObserver === "undefined") return;

    document.documentElement.classList.add("reveal-ready");
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]"),
    );

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add(REVEALED);
          observer.unobserve(entry.target);
        }
      },
      // Positive bottom margin so the root box extends past the fold: elements
      // start fading in before they scroll into view. A negative margin here
      // delays the reveal until the element is already on screen, which leaves
      // the viewport blank for the length of the transition on a fast scroll.
      { rootMargin: "0px 0px 15% 0px", threshold: 0 },
    );

    // Layout is available even when the tab is not painting, so this pass is
    // what guarantees the first screen is visible.
    const fold = window.innerHeight * 1.15;
    for (const node of nodes) {
      if (node.getBoundingClientRect().top < fold) {
        node.classList.add(REVEALED);
      } else {
        observer.observe(node);
      }
    }

    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
