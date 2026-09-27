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

const LAYOUT_STORAGE_KEY = "somniq-literature-layout-v1";

/** Per-viewer layout choices. Stored locally only; a missing or unreadable
 * value falls back to the responsive defaults. */
export interface LibraryLayoutPrefs {
  navigationOpen?: boolean;
  /** The user hid the docked details panel (not the narrow drawer). */
  detailsHidden?: boolean;
  sidebarWidth?: number;
  workspaceWidth?: number;
  columnWidths?: { venue?: number; year?: number; tags?: number };
  sort?: string;
  sortReversed?: boolean;
}

export function readLayoutPrefs(): LibraryLayoutPrefs {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as LibraryLayoutPrefs : {};
  } catch {
    return {};
  }
}

export function writeLayoutPrefs(patch: LibraryLayoutPrefs) {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ ...readLayoutPrefs(), ...patch }));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); layout
    // then simply resets next time.
  }
}

/** A stored width, if it is a number inside the allowed range. */
export function storedWidth(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Writes `prefs` once they stop changing, so dragging a divider does not
 * write storage on every pointer move. */
export function usePersistLayout(prefs: LibraryLayoutPrefs) {
  const serialized = JSON.stringify(prefs);
  useEffect(() => {
    const timer = window.setTimeout(() => writeLayoutPrefs(JSON.parse(serialized) as LibraryLayoutPrefs), 250);
    return () => window.clearTimeout(timer);
  }, [serialized]);
}
