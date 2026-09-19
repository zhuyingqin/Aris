/**
 * Last rendered height of content that cannot know its own size until after it
 * has rendered once: images (no intrinsic size until the bytes arrive) and
 * Mermaid diagrams (rendered asynchronously, then scaled to fit the column).
 *
 * Both are inside virtualized transcript rows, so every one of those late size
 * changes is an uncompensated resize that moves the reader's viewport. Replaying
 * the previous height as a `min-height` means the row measures its final height
 * on first paint instead of growing into it.
 *
 * Heights depend on the column width, which is stable within a session but not
 * across window resizes; a stale value is only ever a starting point, since the
 * real content replaces it as soon as it renders.
 */
const heights = new Map<string, number>();
const LIMIT = 1_000;

export function rememberRenderedHeight(key: string | null | undefined, px: number): void {
  if (!key || !Number.isFinite(px) || px <= 0) return;
  const rounded = Math.round(px);
  if (heights.get(key) === rounded) return;
  heights.delete(key);
  heights.set(key, rounded);
  while (heights.size > LIMIT) {
    const oldest = heights.keys().next().value;
    if (oldest === undefined) break;
    heights.delete(oldest);
  }
}

export function readRenderedHeight(key: string | null | undefined): number | undefined {
  return key ? heights.get(key) : undefined;
}

export function clearRenderedHeights(): void {
  heights.clear();
}

/** Mermaid keys off the diagram source, not a block id: the same diagram keeps
 *  its height when it is re-rendered, re-themed, or appears in another turn. */
export function mermaidSizeKey(code: string): string {
  const trimmed = code.trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < trimmed.length; index += 1) {
    hash ^= trimmed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `mermaid:${trimmed.length}:${hash.toString(36)}`;
}
