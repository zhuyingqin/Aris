import { describe, expect, it } from "vitest";
import { isSoftwareKeyboardOpen } from "./mobileViewport";

describe("mobile conversation viewport", () => {
  it("recognizes a focused composer obscured by a software keyboard", () => {
    expect(isSoftwareKeyboardOpen({
      inputFocused: true,
      baselineHeight: 844,
      visibleBottom: 493,
    })).toBe(true);
  });

  it("ignores browser chrome and safe-area changes", () => {
    expect(isSoftwareKeyboardOpen({
      inputFocused: true,
      baselineHeight: 844,
      visibleBottom: 780,
    })).toBe(false);
  });

  it("does not report a keyboard after the composer loses focus", () => {
    expect(isSoftwareKeyboardOpen({
      inputFocused: false,
      baselineHeight: 844,
      visibleBottom: 493,
    })).toBe(false);
  });
});
