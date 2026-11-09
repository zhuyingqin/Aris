import { afterEach, describe, expect, it, vi } from "vitest";
import { isMacOS, primaryModifier } from "./platform";

afterEach(() => vi.restoreAllMocks());
describe("platform shortcuts", () => {
  it("uses Command on Mac and Control on Windows", () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    expect(isMacOS()).toBe(true);
    expect(primaryModifier({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(primaryModifier({ metaKey: false, ctrlKey: true })).toBe(false);
    platform.mockReturnValue("Win32");
    expect(primaryModifier({ metaKey: false, ctrlKey: true })).toBe(true);
  });
});
