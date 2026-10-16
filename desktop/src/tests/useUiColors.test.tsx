// @vitest-environment jsdom

import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { useUiColors } from "../useUiColors";
import { UI_COLOR_STORAGE_KEY } from "../uiColors";

beforeEach(() => {
  useStore.getState().setUiColor("default");
  localStorage.clear();
});
afterEach(cleanup);

describe("shared global UI color", () => {
  it("syncs a color chosen in another workspace window without writing it back", () => {
    renderHook(useUiColors);
    fireEvent(window, new StorageEvent("storage", { key: UI_COLOR_STORAGE_KEY, newValue: "green" }));
    expect(useStore.getState().uiColor).toBe("green");
    expect(document.documentElement.dataset.uiColor).toBe("green");
    expect(localStorage.getItem(UI_COLOR_STORAGE_KEY)).toBeNull();
  });

  it("restores the default palette when another window clears preferences", () => {
    useStore.getState().setUiColor("purple");
    renderHook(useUiColors);
    fireEvent(window, new StorageEvent("storage", { key: null, newValue: null }));
    expect(useStore.getState().uiColor).toBe("default");
    expect(document.documentElement.dataset.uiColor).toBe("default");
  });
});
