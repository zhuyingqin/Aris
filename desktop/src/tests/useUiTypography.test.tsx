// @vitest-environment jsdom

import { act, cleanup, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { useUiTypography } from "../useUiTypography";
import { UI_TYPOGRAPHY_STORAGE_KEY } from "../uiTypography";

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("screen", { availWidth: 3840, availHeight: 2160 });
  useStore.getState().setUiFontSize(14);
  useStore.getState().setUiFontMode("auto");
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("live UI typography", () => {
  it("updates automatic size after a window resize and keeps the default non-persistent", async () => {
    renderHook(useUiTypography);
    expect(localStorage.getItem(UI_TYPOGRAPHY_STORAGE_KEY)).toBeNull();
    vi.stubGlobal("innerWidth", 2560);
    vi.stubGlobal("innerHeight", 1440);
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(document.documentElement.dataset.uiFontSize).toBe("16"));
    expect(useStore.getState().uiRecommendedFontSize).toBe(16);
    vi.stubGlobal("innerWidth", 480);
    vi.stubGlobal("innerHeight", 900);
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(document.documentElement.dataset.uiFontSize).toBe("14"));
    expect(localStorage.getItem(UI_TYPOGRAPHY_STORAGE_KEY)).toBeNull();
  });

  it("keeps manual size on resize and remembers it when returning from automatic mode", async () => {
    renderHook(useUiTypography);
    act(() => useStore.getState().setUiFontSize(19));
    vi.stubGlobal("innerWidth", 3840);
    vi.stubGlobal("innerHeight", 2160);
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(useStore.getState().uiRecommendedFontSize).toBe(18));
    expect(document.documentElement.dataset.uiFontSize).toBe("19");
    expect(JSON.parse(localStorage.getItem(UI_TYPOGRAPHY_STORAGE_KEY)!)).toEqual({ mode: "manual", fontSize: 19 });
    act(() => useStore.getState().setUiFontMode("auto"));
    expect(document.documentElement.dataset.uiFontSize).toBe("18");
    act(() => useStore.getState().setUiFontMode("manual"));
    expect(document.documentElement.dataset.uiFontSize).toBe("19");
  });

  it("applies preferences changed by another workspace or companion window", () => {
    renderHook(useUiTypography);
    fireEvent(window, new StorageEvent("storage", {
      key: UI_TYPOGRAPHY_STORAGE_KEY,
      newValue: JSON.stringify({ mode: "manual", fontSize: 17 }),
    }));
    expect(useStore.getState().uiFontMode).toBe("manual");
    expect(useStore.getState().uiFontSize).toBe(17);
    expect(document.documentElement.dataset.uiFontSize).toBe("17");
  });
});
