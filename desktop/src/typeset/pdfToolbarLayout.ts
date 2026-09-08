/**
 * How many of the compiled-PDF toolbar's trailing actions still fit inline.
 *
 * Everything the toolbar is allowed to drop is a same-sized icon button, so the
 * fit is one division rather than a per-item measurement. The one subtlety is
 * that hiding a single button to make room for the overflow button saves
 * nothing — both are one slot wide — so the answer is never `total - 1`.
 */

/** 28px icon button plus the 6px gap the actions row uses. */
export const PDF_TOOLBAR_ACTION_SLOT = 34;

/** Sub-pixel slack, so a rounded measurement cannot flip the fit back and forth. */
const FIT_TOLERANCE = 1;

export function fitToolbarActions({
  total,
  available,
  base,
  slot = PDF_TOOLBAR_ACTION_SLOT,
}: {
  total: number;
  /** Usable inline space in the toolbar row, padding already subtracted. */
  available: number;
  /** Width of everything that never collapses: both groups minus the actions. */
  base: number;
  /** Width of one collapsible action including its gap. */
  slot?: number;
}): number {
  // No measurement yet (an unmounted or hidden pane, or a DOM without layout):
  // show everything rather than collapsing a toolbar nobody has measured.
  if (!Number.isFinite(available) || available <= 0) return total;
  if (!Number.isFinite(base) || total <= 1 || slot <= 0) return total;
  if (base + total * slot <= available + FIT_TOLERANCE) return total;
  // One slot now belongs to the overflow button.
  const room = Math.floor((available + FIT_TOLERANCE - base - slot) / slot);
  return Math.max(0, Math.min(total - 2, room));
}
