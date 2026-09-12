import { describe, expect, it } from "vitest";
import {
  clampRect,
  handleAtPoint,
  isUsableSelection,
  normalizeSelection,
  rectAtPoint,
  resizeRect,
  screenshotFileName,
  toCaptureRect,
  toolbarPlacement,
  translateRect,
  windowRectsToCss,
} from "./screenshotSelection";

describe("normalizeSelection", () => {
  it("orders the corners of a drag in any direction", () => {
    const downRight = normalizeSelection({ x: 10, y: 20 }, { x: 40, y: 60 });
    const upLeft = normalizeSelection({ x: 40, y: 60 }, { x: 10, y: 20 });
    expect(downRight).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect(upLeft).toEqual(downRight);
  });
});

describe("toCaptureRect", () => {
  it("is an identity on an unscaled display", () => {
    const rect = toCaptureRect(
      { x: 10, y: 20, width: 30, height: 40 },
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
    );
    expect(rect).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("scales CSS pixels onto a HiDPI capture", () => {
    // 150% display: a 1280x720 viewport in front of a 1920x1080 capture.
    const rect = toCaptureRect(
      { x: 100, y: 50, width: 200, height: 100 },
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
    );
    expect(rect).toEqual({ x: 150, y: 75, width: 300, height: 150 });
  });

  it("clamps a selection dragged past the edge of the capture", () => {
    const rect = toCaptureRect(
      { x: -20, y: -10, width: 2000, height: 2000 },
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
    );
    expect(rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("returns an empty rect when the viewport has not been measured", () => {
    const rect = toCaptureRect(
      { x: 0, y: 0, width: 10, height: 10 },
      { width: 0, height: 0 },
      { width: 1920, height: 1080 },
    );
    expect(rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("isUsableSelection", () => {
  it("rejects a click and a hairline drag", () => {
    expect(isUsableSelection({ x: 0, y: 0, width: 0, height: 0 })).toBe(false);
    expect(isUsableSelection({ x: 0, y: 0, width: 3, height: 100 })).toBe(false);
  });

  it("accepts a real rectangle", () => {
    expect(isUsableSelection({ x: 0, y: 0, width: 4, height: 4 })).toBe(true);
  });
});

describe("screenshotFileName", () => {
  it("is sortable, zero-padded and png-suffixed", () => {
    expect(screenshotFileName(new Date(2026, 8, 11, 9, 5, 3)))
      .toBe("screenshot-20260911-090503.png");
  });
});

describe("window snapping", () => {
  const regions = [
    { x: 200, y: 100, width: 600, height: 400, title: "Editor" },
    { x: 0, y: 0, width: 1920, height: 1080, title: "Desktop" },
  ];

  it("converts device-pixel window rects into overlay CSS pixels", () => {
    // 150% display: 1920x1080 of capture behind a 1280x720 viewport.
    const rects = windowRectsToCss(regions, { width: 1280, height: 720 }, { width: 1920, height: 1080 });
    expect(rects[0].x).toBeCloseTo(133.33, 2);
    expect(rects[0].y).toBeCloseTo(66.67, 2);
    expect(rects[0].width).toBeCloseTo(400, 2);
    expect(rects[0].height).toBeCloseTo(266.67, 2);
  });

  it("picks the topmost window under the pointer", () => {
    const rects = windowRectsToCss(regions, { width: 1920, height: 1080 }, { width: 1920, height: 1080 });
    // Inside the editor, which the backend listed first (front-to-back).
    expect(rectAtPoint(rects, { x: 300, y: 200 })).toEqual({ x: 200, y: 100, width: 600, height: 400 });
    // Outside it, the full-screen window behind it still matches.
    expect(rectAtPoint(rects, { x: 50, y: 50 })).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("returns nothing when no window covers the point", () => {
    expect(rectAtPoint([], { x: 10, y: 10 })).toBeNull();
  });
});

describe("adjusting a committed selection", () => {
  const selection = { x: 100, y: 100, width: 200, height: 120 };

  it("grabs corners in preference to edges", () => {
    expect(handleAtPoint(selection, { x: 100, y: 100 })).toBe("nw");
    expect(handleAtPoint(selection, { x: 300, y: 220 })).toBe("se");
    expect(handleAtPoint(selection, { x: 200, y: 100 })).toBe("n");
    expect(handleAtPoint(selection, { x: 200, y: 160 })).toBeNull();
  });

  it("keeps the rectangle normalized when a drag inverts it", () => {
    // Pull the west edge past the east one.
    expect(resizeRect(selection, "w", { x: 400, y: 0 })).toEqual({
      x: 300, y: 100, width: 100, height: 120,
    });
  });

  it("keeps a moved selection inside the overlay", () => {
    const bounds = { width: 1920, height: 1080 };
    expect(translateRect(selection, -500, 0, bounds)).toMatchObject({ x: 0, y: 100 });
    expect(translateRect(selection, 5000, 0, bounds)).toMatchObject({ x: 1720 });
  });

  it("trims a resize that ran past the edge", () => {
    expect(clampRect({ x: -50, y: -50, width: 200, height: 200 }, { width: 1920, height: 1080 }))
      .toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });
});

describe("toolbarPlacement", () => {
  const viewport = { width: 1920, height: 1080 };
  const toolbar = { width: 450, height: 40 };

  it("sits under the selection, right-aligned to it", () => {
    const at = toolbarPlacement({ x: 600, y: 300, width: 500, height: 200 }, viewport, toolbar);
    expect(at).toEqual({ x: 650, y: 510 });
  });

  it("flips above the selection when there is no room below", () => {
    const at = toolbarPlacement({ x: 600, y: 300, width: 500, height: 760 }, viewport, toolbar);
    expect(at.y).toBe(250);
  });

  it("tucks inside the bottom edge when neither side fits", () => {
    const at = toolbarPlacement({ x: 0, y: 0, width: 1920, height: 1080 }, viewport, toolbar);
    expect(at.y).toBe(1030);
    expect(at.x).toBe(1460);
  });
});
