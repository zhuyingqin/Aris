// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, accentShade, normalizeAppearance, parseAppearance, useAppearance } from "../appearance";
import { applyAppearancePreset, currentAppearancePreset, exportAppearancePreset, parseAppearancePreset, persistBatch, resetAppearance, selectAccentPreset } from "../appearanceTransfer";
import { getEditorSettings, setEditorSettings, syncEditorSettings } from "../editor/editorSettings";
import { useStore } from "../store";
import { prepareWallpaper } from "../chatWallpaper";

beforeEach(() => {
  localStorage.clear(); useAppearance.getState().sync(null); syncEditorSettings(null);
  useStore.getState().setTheme("light"); useStore.getState().setUiColor("default");
});
afterEach(() => vi.restoreAllMocks());

it("rejects unsafe values and restores defaults from corrupt preferences", () => {
  expect(parseAppearance("broken")).toEqual(DEFAULT_APPEARANCE);
  const value = normalizeAppearance({ surface: "url(https://example.com)", customAccent: "url(evil)", bodySize: 999,
    wallpaper: "https://example.com/a.png", wallpaperOpacity: -10, density: "invalid", wallpaperFit: "url(evil)" });
  expect(value).toMatchObject({ surface: "default", customAccent: "", bodySize: 26, wallpaper: "none", wallpaperOpacity: 0, density: "standard", wallpaperFit: "cover" });
});

it("persists appearance before applying it, keeps the real state on a denied write, and restores it on reload", () => {
  useAppearance.getState().patch({ surface: "warm", density: "compact", customAccent: "#112233" });
  const stored = localStorage.getItem(APPEARANCE_KEY);
  expect(document.documentElement.dataset.surface).toBe("warm");
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("quota"); });
  expect(() => useAppearance.getState().patch({ surface: "cool" })).toThrow("quota");
  expect(useAppearance.getState().value.surface).toBe("warm");
  expect(localStorage.getItem(APPEARANCE_KEY)).toBe(stored);
  useAppearance.getState().sync(null); useAppearance.getState().sync(stored);
  expect(document.documentElement.dataset.customAccent).toBe("true");
  expect(document.documentElement.dataset.density).toBe("compact");
});

it("derives contrast for both theme modes even when the chosen color is black or white", () => {
  const luminance = (hex: string) => [1, 3, 5].map((p) => parseInt(hex.slice(p, p + 2), 16) / 255)
    .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  for (const input of ["#000000", "#ffffff", "#00ff00", "#ffdd00", "#7c3aed"]) for (const dark of [true, false]) {
    const fg = luminance(accentShade(input, dark)); const bg = luminance(dark ? "#232323" : "#f0f0f0");
    expect((Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05)).toBeGreaterThanOrEqual(4.5);
  }
});

it("rolls back a partially persisted multi-setting change and leaves UI state unchanged", () => {
  useAppearance.getState().patch({ customAccent: "#112233" });
  const stored = localStorage.getItem(APPEARANCE_KEY);
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key === "somniq-ui-color-v1" && value === "green") throw new Error("quota");
    original.call(this, key, value);
  });
  expect(() => selectAccentPreset("green")).toThrow("quota");
  expect(localStorage.getItem(APPEARANCE_KEY)).toBe(stored);
  expect(useAppearance.getState().value.customAccent).toBe("#112233");
  expect(useStore.getState().uiColor).toBe("default");
  expect(() => persistBatch({a: "b", "somniq-ui-color-v1": "green"})).toThrow();
  expect(localStorage.getItem("a")).toBeNull();
});

it("exports only appearance data and imports it without replacing unrelated editor behavior", () => {
  useAppearance.getState().patch({ wallpaper: "custom", wallpaperName: "private-file.jpg", customAccent: "#654321" });
  setEditorSettings({ keybindings: "vim", autoComplete: false });
  const raw = exportAppearancePreset();
  expect(raw).not.toContain("private-file"); expect(raw).not.toContain("keybindings");
  const preset = JSON.parse(raw); preset.appearance.surface = "warm"; preset.editor.fontSize = 18;
  preset.editor.keybindings = "emacs"; preset.appearance.remoteUrl = "https://example.com/track.png";
  applyAppearancePreset(parseAppearancePreset(JSON.stringify(preset)));
  expect(getEditorSettings()).toMatchObject({ keybindings: "vim", autoComplete: false, fontSize: 18 });
  expect(useAppearance.getState().value).toMatchObject({ surface: "warm", customAccent: "#654321", wallpaper: "none" });
  expect(parseAppearancePreset(raw)).not.toHaveProperty("editor.keybindings");
  expect(() => parseAppearancePreset('{"format":"foreign","version":1}')).toThrow();
  expect(() => parseAppearancePreset("x".repeat(100_001))).toThrow();
});

it("fails theme imports before any visible state changes when persistence is denied", () => {
  const preset = currentAppearancePreset(); preset.theme = "dark"; preset.appearance.surface = "cool";
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("denied"); });
  expect(() => applyAppearancePreset(preset)).toThrow("denied");
  expect(useStore.getState().theme).toBe("light");
  expect(useAppearance.getState().value.surface).toBe("default");
});

it("restores appearance defaults while preserving non-appearance editor settings", () => {
  useAppearance.getState().patch({ wallpaper: "orbit", reducedMotion: true });
  setEditorSettings({ keybindings: "vim", fontSize: 20 });
  resetAppearance();
  expect(useAppearance.getState().value).toEqual(DEFAULT_APPEARANCE);
  expect(useStore.getState().themeMode).toBe("system");
  expect(getEditorSettings()).toMatchObject({ keybindings: "vim", fontSize: 13 });
});

it("strict editor preferences keep their confirmed state on storage failure", () => {
  const current = getEditorSettings();
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("denied"); });
  expect(() => setEditorSettings({fontSize: 22}, {requirePersistence: true})).toThrow("denied");
  expect(getEditorSettings()).toBe(current);
});

it("rejects oversized or unsupported local images before decoding or storing them", async () => {
  await expect(prepareWallpaper(new File(["<svg/>"], "a.svg", {type: "image/svg+xml"}))).rejects.toThrow("PNG");
  const file = new File(["image"], "large.png", {type: "image/png"}); Object.defineProperty(file, "size", {value: 13 * 1024 * 1024});
  await expect(prepareWallpaper(file)).rejects.toThrow("12 MB");
});
