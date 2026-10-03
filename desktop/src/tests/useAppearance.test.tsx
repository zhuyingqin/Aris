// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, useAppearance } from "../appearance";
import { useAppearanceEffects } from "../useAppearance";
import { useStore } from "../store";
import { readWallpaperAsset } from "../chatWallpaper";

vi.mock("../chatWallpaper", () => ({readWallpaperAsset: vi.fn()}));
let dark: boolean; let onChange: () => void;
beforeEach(() => {
  dark = false; onChange = () => {};
  vi.stubGlobal("matchMedia", vi.fn(() => ({matches: dark, addEventListener: (_: string, fn: () => void) => {onChange = fn;}, removeEventListener: vi.fn()})));
  useAppearance.getState().sync(null); useStore.getState().setTheme("light"); localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reports a missing local image instead of silently showing a configured background", async () => {
  vi.mocked(readWallpaperAsset).mockResolvedValue(undefined);
  useAppearance.getState().patch({wallpaper: "custom"}); renderHook(useAppearanceEffects);
  await waitFor(() => expect(useAppearance.getState().wallpaperError).toContain("not found"));
  expect(document.documentElement.style.getPropertyValue("--chat-wallpaper")).toBe("none");
});

it("follows OS changes while keeping the persisted preference as system", () => {
  useStore.getState().setTheme("system"); renderHook(useAppearanceEffects);
  expect(useStore.getState().theme).toBe("light");
  dark = true; onChange();
  expect(useStore.getState().theme).toBe("dark");
  expect(localStorage.getItem("somniq-theme")).toBe("system");
  useStore.getState().setTheme("light"); dark = true; onChange();
  expect(useStore.getState().theme).toBe("light");
});

it("syncs other windows without writing their preferences back", () => {
  renderHook(useAppearanceEffects);
  const write = vi.spyOn(Storage.prototype, "setItem");
  fireEvent(window, new StorageEvent("storage", {key: APPEARANCE_KEY, newValue: JSON.stringify({...DEFAULT_APPEARANCE, surface: "warm", wallpaper: "grid"})}));
  expect(document.documentElement.dataset.surface).toBe("warm");
  expect(document.documentElement.style.getPropertyValue("--chat-wallpaper")).toContain("grid.svg");
  expect(write).not.toHaveBeenCalled();
  fireEvent(window, new StorageEvent("storage", {key: null, newValue: null}));
  expect(useAppearance.getState().value).toEqual(DEFAULT_APPEARANCE);
});

it("releases local image URLs on replacement and ignores late image loads", async () => {
  vi.stubGlobal("URL", {...URL, createObjectURL: vi.fn(() => "blob:wallpaper"), revokeObjectURL: vi.fn()});
  vi.mocked(readWallpaperAsset).mockResolvedValue({blob: new Blob(["img"]), name: "wallpaper.png"});
  useAppearance.getState().patch({wallpaper: "custom", wallpaperRevision: "1"});
  const view = renderHook(useAppearanceEffects);
  await waitFor(() => expect(document.documentElement.style.getPropertyValue("--chat-wallpaper")).toContain("blob:wallpaper"));
  view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:wallpaper");
  let resolve!: (asset: {blob: Blob; name: string}) => void;
  vi.mocked(readWallpaperAsset).mockReturnValue(new Promise((done) => {resolve = done;}));
  const next = renderHook(useAppearanceEffects); next.unmount();
  resolve({blob: new Blob(["img"]), name: "late.png"});
  await Promise.resolve();
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
});
