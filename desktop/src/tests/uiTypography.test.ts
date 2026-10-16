// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentRecommendedUiFontSize,
  normalizeUiFontSize,
  parseUiTypographyPreference,
  recommendedUiFontSize,
} from "../uiTypography";

afterEach(() => vi.unstubAllGlobals());

describe("UI font recommendations", () => {
  it.each([
    [360, 700, 14], [1366, 768, 14], [1920, 1080, 15],
    [2560, 1440, 16], [3840, 2160, 18], [3440, 600, 14],
  ])("uses readable type for a %i × %i logical viewport", (width, height, expected) => {
    expect(recommendedUiFontSize(width, height)).toBe(expected);
  });

  it("uses the available work area without multiplying the operating system's scaling", () => {
    vi.stubGlobal("innerWidth", 2560);
    vi.stubGlobal("innerHeight", 1440);
    vi.stubGlobal("screen", { availWidth: 1920, availHeight: 1080 });
    vi.stubGlobal("devicePixelRatio", 2);
    expect(currentRecommendedUiFontSize()).toBe(15);
  });

  it("falls back safely for damaged settings and bounds user-supplied sizes", () => {
    for (const raw of [null, "broken", "null", '{"mode":"manual","fontSize":"18"}']) {
      expect(parseUiTypographyPreference(raw)).toEqual({ mode: "auto", fontSize: 14 });
    }
    expect(parseUiTypographyPreference('{"mode":"manual","fontSize":100}')).toEqual({ mode: "manual", fontSize: 20 });
    expect(normalizeUiFontSize(1)).toBe(12);
    expect(normalizeUiFontSize(NaN)).toBe(14);
  });
});
