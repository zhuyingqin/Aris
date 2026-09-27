import { useEffect, useState, type RefObject } from "react";

/** Inclusive run of ids between `from` and `to` in list order. An anchor that
 * has left the list collapses the range to the target alone. */
export function idsInRange(orderedIds: readonly string[], from: string, to: string): string[] {
  const end = orderedIds.indexOf(to);
  if (end < 0) return [];
  const start = orderedIds.indexOf(from);
  if (start < 0) return [to];
  return orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/** The row that should take over focus once `removed` leave the list: the
 * next survivor below `current`, otherwise the nearest one above it. */
export function nextAfterRemoval(
  orderedIds: readonly string[],
  removed: ReadonlySet<string>,
  current: string,
): string | null {
  const index = orderedIds.indexOf(current);
  for (let next = index + 1; next < orderedIds.length; next += 1) {
    if (!removed.has(orderedIds[next])) return orderedIds[next];
  }
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (!removed.has(orderedIds[previous])) return orderedIds[previous];
  }
  return null;
}

/** Keyboard shortcuts must never fire while the user is typing. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

/** Row keys may contain characters that need escaping in a selector, so the
 * rendered rows are compared directly. */
export function findLibraryRow(root: ParentNode | null | undefined, key: string): HTMLElement | null {
  if (!root) return null;
  for (const row of root.querySelectorAll<HTMLElement>("[data-row-key]")) {
    if (row.dataset.rowKey === key) return row;
  }
  return null;
}

/** Mirrors a CSS container query in script, for behaviour that depends on the
 * layout the query selects (a docked panel versus an overlay drawer). */
export function useNarrowerThan(ref: RefObject<HTMLElement>, width: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width <= width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, width]);
  return narrow;
}
