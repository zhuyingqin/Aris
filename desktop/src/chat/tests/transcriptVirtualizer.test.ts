// @vitest-environment jsdom

import { Virtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";
import { beforeEach, describe, expect, it } from "vitest";
import {
  NEAR_BOTTOM_THRESHOLD,
  TRANSCRIPT_BOTTOM_GAP,
  TRANSCRIPT_TOP_INSET,
  compensateAboveViewportResize,
  isNearBottom,
  rowsNeedingReestimate,
} from "../ChatThread";

/**
 * The transcript's scroll stability is not our own code — it is a specific set
 * of `@tanstack/virtual-core` behaviours we opted into (`anchorTo: "end"`,
 * `paddingStart` / `paddingEnd`, and an overridden
 * `shouldAdjustScrollPositionOnItemSizeChange`). Those replaced hand-rolled
 * anchoring, so a silent change in the library's semantics would quietly bring
 * the jumping back. This drives the real `Virtualizer` against a scroll element
 * whose geometry we control, which jsdom's lack of layout otherwise prevents.
 */

const VIEWPORT = 800;
const COMPOSER_HEIGHT = 120;
const BOTTOM_INSET = COMPOSER_HEIGHT + TRANSCRIPT_BOTTOM_GAP;

interface FakeScroller {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  scrollTo: (options: { top?: number }) => void;
  getBoundingClientRect: () => { width: number; height: number };
  bindContent: (measure: () => number) => void;
}

function fakeScroller(): FakeScroller {
  const handlers = new Set<() => void>();
  // Rows are absolutely positioned inside the list, so a row that grows extends
  // the scroll container's scrollable area immediately - before React re-renders
  // the list's own height. Modelling that as a live getter matters: with a
  // deferred height the browser's clamp would swallow the bottom-anchor
  // adjustment and the test would report a bug the DOM does not have.
  let measureContent = () => 0;
  const element: FakeScroller = {
    scrollTop: 0,
    clientHeight: VIEWPORT,
    get scrollHeight() {
      return measureContent();
    },
    addEventListener: (type, fn) => {
      if (type === "scroll") handlers.add(fn);
    },
    removeEventListener: (_type, fn) => {
      handlers.delete(fn);
    },
    scrollTo: ({ top }) => {
      if (top == null) return;
      // The browser clamps, and the clamp is half of why the composer inset
      // mattered; reproducing it keeps the test honest.
      const max = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = Math.max(0, Math.min(max, top));
      for (const fn of [...handlers]) fn();
    },
    getBoundingClientRect: () => ({ width: 820, height: element.clientHeight }),
    bindContent: (measure) => {
      measureContent = measure;
    },
  };
  return element;
}

/** Sizes keyed like the real transcript: stable per row, wildly uneven. */
function rowSize(index: number): number {
  return [90, 240, 1_400, 160, 3_200, 520][index % 6];
}

function buildVirtualizer(keys: string[], element: FakeScroller) {
  const state = { keys };
  const options: VirtualizerOptions<Element, Element> = {
    count: state.keys.length,
    getScrollElement: () => element as unknown as Element,
    estimateSize: () => 180,
    overscan: 5,
    getItemKey: (index) => state.keys[index] ?? index,
    paddingStart: TRANSCRIPT_TOP_INSET,
    paddingEnd: BOTTOM_INSET,
    anchorTo: "end",
    scrollEndThreshold: NEAR_BOTTOM_THRESHOLD,
    observeElementRect: (_instance, cb) => {
      cb(element.getBoundingClientRect());
      return () => undefined;
    },
    observeElementOffset: (_instance, cb) => {
      const handler = () => cb(element.scrollTop, true);
      element.addEventListener("scroll", handler);
      return () => element.removeEventListener("scroll", handler);
    },
    scrollToFn: (offset, { adjustments = 0 }) => {
      element.scrollTo({ top: offset + adjustments });
    },
    initialRect: { width: 820, height: VIEWPORT },
    onChange: () => undefined,
  };
  const virtualizer = new Virtualizer(options);
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => (
    compensateAboveViewportResize(item, instance)
  );
  element.bindContent(() => virtualizer.getTotalSize());
  virtualizer._didMount();

  /** One React pass: render reads the virtual items, then the layout effect
   *  lets the virtualizer settle (where it restores a pending anchor). */
  const commit = () => {
    virtualizer.getVirtualItems();
    virtualizer._willUpdate();
  };
  /** Stands in for the ResizeObserver: rows report their real height. */
  const measureAll = () => {
    for (let index = 0; index < virtualizer.options.count; index += 1) {
      virtualizer.resizeItem(index, rowSize(index));
    }
    commit();
  };
  const setKeys = (next: string[]) => {
    state.keys = next;
    // `setOptions` runs during render in the React wrapper, `_willUpdate` after.
    virtualizer.setOptions({ ...options, count: next.length });
    commit();
  };

  commit();
  return { virtualizer, commit, measureAll, setKeys, options };
}

function keyRange(from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, i) => `turn-${from + i}`);
}

describe("transcript virtualizer contract", () => {
  let element: FakeScroller;

  beforeEach(() => {
    element = fakeScroller();
  });

  it("makes the virtual total height equal the scroller's own scrollHeight", () => {
    // The insets live inside the virtual coordinate space precisely so these two
    // agree: with the padding on the scroll container instead, every offset the
    // virtualizer computed was short by the padding.
    const { virtualizer, measureAll } = buildVirtualizer(keyRange(0, 30), element);
    measureAll();

    let rows = 0;
    for (let index = 0; index < 30; index += 1) rows += rowSize(index);
    expect(virtualizer.getTotalSize()).toBe(TRANSCRIPT_TOP_INSET + rows + BOTTOM_INSET);
    expect(virtualizer.getTotalSize()).toBe(element.scrollHeight);
  });

  it("holds the reader's row still when earlier history is prepended", () => {
    // This is what replaced the hand-rolled scrollTop snapshot: that one restored
    // only the *estimated* height of the new rows, and the real heights landed
    // later with nothing to compensate them.
    const { virtualizer, measureAll, setKeys, commit } = buildVirtualizer(
      keyRange(12, 42),
      element,
    );
    measureAll();

    // Park the reader partway up, on a known row.
    element.scrollTo({ top: 3_000 });
    commit();
    const anchor = virtualizer.measurementsCache.find(
      (item) => item.end > element.scrollTop,
    );
    expect(anchor).toBeDefined();
    const offsetWithinAnchor = element.scrollTop - anchor!.start;

    setKeys([...keyRange(0, 12), ...keyRange(12, 42)]);
    // The prepended rows are still unmeasured at this point, exactly as they are
    // in the real commit; their real heights arrive afterwards.
    for (let index = 0; index < 12; index += 1) {
      virtualizer.resizeItem(index, rowSize(index));
    }
    commit();

    const moved = virtualizer.measurementsCache.find((item) => item.key === anchor!.key);
    expect(moved).toBeDefined();
    expect(element.scrollTop - moved!.start).toBe(offsetWithinAnchor);
  });

  it("compensates a row that grows above the viewport while scrolling up", () => {
    // virtual-core's default additionally requires `scrollDirection !== "backward"`,
    // which is why scrolling up through a transcript used to shift content: every
    // row measured on the way up changed the total height with nothing anchoring
    // the viewport (`.chat-scroll` also sets `overflow-anchor: none`).
    const { virtualizer, measureAll, commit } = buildVirtualizer(keyRange(0, 40), element);
    measureAll();

    element.scrollTo({ top: 6_000 });
    commit();
    // Scroll up one notch so the virtualizer's direction is "backward".
    element.scrollTo({ top: 5_800 });
    commit();
    expect(virtualizer.scrollDirection).toBe("backward");

    const before = element.scrollTop;
    const above = virtualizer.measurementsCache.find((item) => item.end < before);
    expect(above).toBeDefined();
    virtualizer.resizeItem(above!.index, above!.size + 500);

    expect(element.scrollTop).toBe(before + 500);
  });

  it("keeps a reader parked at the bottom there while the newest turn grows", () => {
    const { virtualizer, measureAll, commit } = buildVirtualizer(keyRange(0, 30), element);
    measureAll();

    element.scrollTo({ top: Number.MAX_SAFE_INTEGER });
    commit();
    expect(isNearBottom(element)).toBe(true);

    const last = virtualizer.options.count - 1;
    virtualizer.resizeItem(last, rowSize(last) + 900);
    commit();

    expect(isNearBottom(element)).toBe(true);
    expect(element.scrollHeight - element.scrollTop - element.clientHeight).toBe(0);
  });

  it("keeps the reader still when a width change re-estimates the rows it cannot see", () => {
    // Opening the side panel (or dragging its divider) rewraps every message.
    // Only the mounted rows get a ResizeObserver callback for the new width; the
    // rest keep heights measured in the old layout until the reader scrolls them
    // into view, which is where the jumping came from. Re-estimating them through
    // `resizeItem` is what lets the virtualizer compensate as it goes.
    const { virtualizer, measureAll, commit } = buildVirtualizer(keyRange(0, 40), element);
    measureAll();

    element.scrollTo({ top: 6_000 });
    commit();
    const anchor = virtualizer.measurementsCache.find((item) => item.end > element.scrollTop);
    expect(anchor).toBeDefined();
    const offsetWithinAnchor = element.scrollTop - anchor!.start;

    const mounted = virtualizer.getVirtualItems().map((item) => item.index);
    const stale = rowsNeedingReestimate(virtualizer.options.count, mounted);
    expect(stale).not.toContain(anchor!.index);
    for (const index of stale) {
      virtualizer.resizeItem(index, Math.round(rowSize(index) * 1.4));
    }
    commit();

    const moved = virtualizer.measurementsCache.find((item) => item.key === anchor!.key);
    expect(moved).toBeDefined();
    expect(moved!.start).not.toBe(anchor!.start);
    expect(element.scrollTop - moved!.start).toBe(offsetWithinAnchor);
  });

  it("resolves the last row's end alignment to the true bottom", () => {
    // The landing effect relies on this: `scrollToIndex(last, { align: "end" })`
    // has to reach the real maximum scroll offset, insets included.
    const { virtualizer, measureAll, commit } = buildVirtualizer(keyRange(0, 30), element);
    measureAll();

    element.scrollTo({ top: 0 });
    commit();
    virtualizer.scrollToIndex(virtualizer.options.count - 1, { align: "end" });

    expect(element.scrollTop).toBe(element.scrollHeight - element.clientHeight);
  });
});
