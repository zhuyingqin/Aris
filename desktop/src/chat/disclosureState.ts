import { useCallback, useState } from "react";

/**
 * Expand/collapse state that survives a row leaving the virtual window.
 *
 * Tool cards, tool groups, permission cards and the edited-files review used to
 * keep `open` in local `useState`. A virtualized row is unmounted once it passes
 * the overscan margin, so scrolling a row out and back remounted it collapsed:
 * the reader lost their expansion, and — worse for scroll stability — a row the
 * virtualizer had measured at (say) 1200px re-measured at 200px, shrinking the
 * total height and yanking everything below it upward.
 *
 * Keyed by block id, so a row remounts at exactly the height it had.
 */
const store = new Map<string, boolean>();
/** Bounded so a long-lived process cannot accumulate every block ever rendered.
 *  Insertion order gives us oldest-first eviction for free. */
const LIMIT = 4_000;

function remember(key: string, value: boolean): void {
  store.delete(key);
  store.set(key, value);
  while (store.size > LIMIT) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function readDisclosure(key: string | null | undefined): boolean | undefined {
  return key ? store.get(key) : undefined;
}

export function clearDisclosureState(): void {
  store.clear();
}

/**
 * Drop-in replacement for `useState(false)` on a disclosure toggle. Blocks
 * without an id (older transcripts) fall back to plain local state rather than
 * colliding on a shared key.
 */
export function useDisclosure(
  key: string | null | undefined,
  initial = false,
): [boolean, (next: boolean | ((previous: boolean) => boolean)) => void] {
  const [open, setOpen] = useState(() => (key ? store.get(key) ?? initial : initial));
  const set = useCallback((next: boolean | ((previous: boolean) => boolean)) => {
    setOpen((previous) => {
      const value = typeof next === "function" ? next(previous) : next;
      if (key) remember(key, value);
      return value;
    });
  }, [key]);
  return [open, set];
}
