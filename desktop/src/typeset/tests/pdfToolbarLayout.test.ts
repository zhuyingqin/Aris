import { describe, expect, it } from "vitest";
import { fitToolbarActions, PDF_TOOLBAR_ACTION_SLOT } from "../pdfToolbarLayout";

const SLOT = PDF_TOOLBAR_ACTION_SLOT;
const TOTAL = 7;

/** What the row actually occupies once `visible` actions are inline. */
function rowWidth(visible: number, base: number): number {
  return base + visible * SLOT + (visible < TOTAL ? SLOT : 0);
}

describe("fitToolbarActions", () => {
  it("keeps every action inline until the row is measured", () => {
    for (const available of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fitToolbarActions({ total: TOTAL, available, base: 400 })).toBe(TOTAL);
    }
  });

  it("keeps every action inline when they all fit", () => {
    expect(fitToolbarActions({ total: TOTAL, available: 900, base: 400 })).toBe(TOTAL);
    // Exactly full still counts as fitting.
    expect(fitToolbarActions({ total: TOTAL, available: 400 + TOTAL * SLOT, base: 400 })).toBe(TOTAL);
  });

  it("never hides a single action, which would save nothing", () => {
    // One hidden action and the overflow button cost the same as the action.
    for (let available = 200; available <= 900; available += 1) {
      expect(fitToolbarActions({ total: TOTAL, available, base: 400 })).not.toBe(TOTAL - 1);
    }
  });

  it("returns the largest count that fits, at every width", () => {
    const base = 400;
    for (let available = 200; available <= 900; available += 1) {
      const visible = fitToolbarActions({ total: TOTAL, available, base });
      // Below the width of the overflow button alone nothing can be made to
      // fit; everywhere else the row has to stay inside the space measured.
      if (rowWidth(0, base) > available + 1) expect(visible).toBe(0);
      else expect(rowWidth(visible, base)).toBeLessThanOrEqual(available + 1);
      if (visible < TOTAL - 1) {
        expect(rowWidth(visible + 1, base)).toBeGreaterThan(available + 1);
      }
    }
  });

  it("gives up actions as the pane narrows and takes them back as it widens", () => {
    const base = 400;
    const widths = [900, 700, 600, 520, 460, 300];
    const counts = widths.map((available) => fitToolbarActions({ total: TOTAL, available, base }));
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(counts[0]).toBe(TOTAL);
    expect(counts.at(-1)).toBe(0);
    // The same width always yields the same answer, whatever is on screen now:
    // that fixed point is what keeps the resize observer from oscillating.
    expect(widths.map((available) => fitToolbarActions({ total: TOTAL, available, base })))
      .toEqual(counts);
  });

  it("collapses everything rather than reporting a negative count", () => {
    expect(fitToolbarActions({ total: TOTAL, available: 40, base: 400 })).toBe(0);
  });

  it("falls back to showing everything when a measurement is missing", () => {
    expect(fitToolbarActions({ total: TOTAL, available: 300, base: Number.NaN })).toBe(TOTAL);
    expect(fitToolbarActions({ total: TOTAL, available: 300, base: 400, slot: 0 })).toBe(TOTAL);
    expect(fitToolbarActions({ total: 1, available: 10, base: 400 })).toBe(1);
  });
});
